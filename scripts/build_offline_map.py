from __future__ import annotations

import collections
import json
import math
import sqlite3
import zipfile
from collections import defaultdict
from pathlib import Path

# The same guard the verifier carries. Without it these imports work only
# because `python scripts/build_offline_map.py` puts scripts/ on sys.path[0];
# any other invocation - runpy, a wrapper, an editor's runner, importing the
# build from a test - fails with ModuleNotFoundError before doing anything.
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import graph_metrics
import jump_ships


ROOT = Path(__file__).resolve().parents[1]
ZIP_PATH = ROOT / "source" / "eve-sde-latest-jsonl.zip"
DATA_DIR = ROOT / "data"
WEB_DIR = ROOT / "web"
DB_PATH = DATA_DIR / "eve_map.sqlite"


def read_jsonl_from_zip(zf: zipfile.ZipFile, name: str):
    with zf.open(name) as raw:
        for line in raw:
            if line.strip():
                yield json.loads(line)


def en(value):
    if isinstance(value, dict):
        return value.get("en") or next(iter(value.values()), "")
    return value


def pos_tuple(record):
    pos = record.get("position") or {}
    return (
        float(pos.get("x", 0.0)),
        float(pos.get("y", 0.0)),
        float(pos.get("z", 0.0)),
    )


# The official in-game schematic layout. CCP publishes it per system in
# mapSolarSystems.jsonl and nowhere else: mapRegions.jsonl and
# mapConstellations.jsonl carry no position2D, so anything at those levels here
# is derived from member systems and labelled as such.
#
# Stored exactly as published. The display convention is screenY = -y, and that
# negation belongs to the renderer, not to the archive - the same treatment the
# physical position already gets. Baking a display decision into stored data is
# how a coordinate ends up meaning two different things in two places.
#
# Returns None rather than a zero pair when the field is absent. 3,005 of the
# 8,490 systems have no official layout at all (J-space and the Abyssal
# proving grounds), and (0, 0) would place every one of them on top of each
# other at the origin of a real coordinate space.
def pos2d_tuple(record):
    pos = record.get("position2D")
    if not isinstance(pos, dict):
        return None
    try:
        return (float(pos["x"]), float(pos["y"]))
    except (KeyError, TypeError, ValueError):
        return None


# Regions and constellations get a schematic location derived from the member
# systems that have one: the centre of their extent, plus the extent itself, so
# an overview can place and size them without inventing an upstream field.
def derive_layout(member_positions):
    points = [p for p in member_positions if p is not None]
    if not points:
        return None, None
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    bounds = (min(xs), min(ys), max(xs), max(ys))
    return ((bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2), bounds


def ly(a, b):
    # SDE coordinates are meters. One light-year is about 9.4607e15 m.
    return math.dist(a, b) / 9_460_730_472_580_800


def main():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    WEB_DIR.mkdir(parents=True, exist_ok=True)

    with zipfile.ZipFile(ZIP_PATH) as zf:
        regions = {
            int(r["_key"]): {
                "region_id": int(r["_key"]),
                "name": en(r.get("name")),
                "constellation_ids": [int(x) for x in r.get("constellationIDs", [])],
                "position": pos_tuple(r),
            }
            for r in read_jsonl_from_zip(zf, "mapRegions.jsonl")
        }

        constellations = {
            int(c["_key"]): {
                "constellation_id": int(c["_key"]),
                "region_id": int(c["regionID"]),
                "name": en(c.get("name")),
                "solar_system_ids": [int(x) for x in c.get("solarSystemIDs", [])],
                "position": pos_tuple(c),
            }
            for c in read_jsonl_from_zip(zf, "mapConstellations.jsonl")
        }

        # NPC stations, counted per system. This is the docking layer, and it
        # is entirely static: 5,210 stations across 1,754 systems, straight from
        # the archive with no API and no authentication.
        #
        # It says where an NPC station IS. It cannot say where docking is
        # impossible, because player structures are not in the SDE and cannot be
        # enumerated without access - so "no NPC station" means exactly that and
        # never "nowhere to dock". Anything displaying this has to keep that
        # distinction or it will strand somebody.
        npc_stations = collections.Counter()
        for station in read_jsonl_from_zip(zf, "npcStations.jsonl"):
            npc_stations[int(station["solarSystemID"])] += 1

        # Factions, by id. Static, tiny, and needed by every live layer that
        # names one: faction sovereignty, faction-warfare frontlines and
        # incursions all return a faction_id and nothing else. Without this the
        # interface either shows a bare number or carries a hand-written table
        # of names, and a hand-written table is data pretending to be code - it
        # goes stale silently and nothing recomputes it.
        #
        # militia_corporation_id marks a faction that fields a militia. Six do,
        # not the four empires: the two pirate factions gained one with the
        # insurgency mechanics. Which is the argument for reading it from the
        # archive - a hand-written list would have said four.
        factions = {}
        for f in read_jsonl_from_zip(zf, "factions.jsonl"):
            fid = int(f["_key"])
            militia = f.get("militiaCorporationID")
            factions[fid] = {
                "faction_id": fid,
                "name": en(f.get("name")),
                "militia_corporation_id": int(militia) if militia else None,
                "home_system_id": int(f["solarSystemID"]) if f.get("solarSystemID") else None,
            }

        systems = {}
        for s in read_jsonl_from_zip(zf, "mapSolarSystems.jsonl"):
            sid = int(s["_key"])
            systems[sid] = {
                "system_id": sid,
                "name": en(s.get("name")),
                "region_id": int(s["regionID"]),
                "constellation_id": int(s["constellationID"]),
                "security": float(s.get("securityStatus", s.get("security", 0.0))),
                "position": pos_tuple(s),
                "position_2d": pos2d_tuple(s),
                "npc_stations": npc_stations.get(sid, 0),
                "neighbors": [],
            }

        gates = {}
        for g in read_jsonl_from_zip(zf, "mapStargates.jsonl"):
            gid = int(g["_key"])
            destination = g.get("destination", {})
            gates[gid] = {
                "stargate_id": gid,
                "system_id": int(g["solarSystemID"]),
                "destination_stargate_id": int(destination["stargateID"]),
                "destination_system_id": int(destination["solarSystemID"]),
                "position": pos_tuple(g),
            }

        jump_data = jump_ships.extract(zf)
        # Checked here, before anything is written.
        #
        # Run at the end, after every file in data/ has been committed to disk, a
        # failed assertion has already replaced a known-good archive with a corrupt one
        # and only then reports it. The archive is the thing you can always fall back
        # on.
        hulls_with_fuel_bonus = sum(1 for ship in jump_data["ships"] if ship.get("hull_fuel_bonus"))
        assert hulls_with_fuel_bonus == jump_ships.EXPECTED_HULL_FUEL_BONUSES, (
            f"expected {jump_ships.EXPECTED_HULL_FUEL_BONUSES} hulls carrying a jump-fuel trait bonus, found "
            f"{hulls_with_fuel_bonus}. CCP may have reworded the trait; check HULL_FUEL_BONUS in jump_ships.py "
            "before trusting any fuel figure."
        )
        assert jump_data["fuel_modules"], "no jump fuel modules were extracted"
        # 18: the range-bonus patterns match nothing in the current SDE, which
        # makes every check downstream of them unreachable. Pinned at its real
        # value so gaining one is a deliberate re-pin rather than a silent hit.
        hulls_with_range_bonus = sum(1 for ship in jump_data["ships"] if ship.get("hull_range_bonus"))
        assert hulls_with_range_bonus == jump_ships.EXPECTED_HULL_RANGE_BONUSES, (
            f"{hulls_with_range_bonus} hulls carry a jump-range trait bonus, expected "
            f"{jump_ships.EXPECTED_HULL_RANGE_BONUSES}. If CCP has introduced one, re-pin "
            "EXPECTED_HULL_RANGE_BONUSES deliberately - until now nothing has matched these patterns, "
            "so the code reading them has never run."
        )

    edges = {}
    for gate in gates.values():
        a = gate["system_id"]
        b = gate["destination_system_id"]
        if a not in systems or b not in systems:
            continue
        key = tuple(sorted((a, b)))
        edges[key] = {
            "from_system_id": key[0],
            "to_system_id": key[1],
            "from_region_id": systems[key[0]]["region_id"],
            "to_region_id": systems[key[1]]["region_id"],
            "distance_ly": round(ly(systems[key[0]]["position"], systems[key[1]]["position"]), 3),
        }

    for edge in edges.values():
        systems[edge["from_system_id"]]["neighbors"].append(edge["to_system_id"])
        systems[edge["to_system_id"]]["neighbors"].append(edge["from_system_id"])

    for s in systems.values():
        s["neighbors"] = sorted(set(s["neighbors"]), key=lambda sid: systems[sid]["name"])

    graph = graph_metrics.compute(systems)
    for sid, system in systems.items():
        system["metrics"] = graph["metrics"][sid]
    for key, edge in edges.items():
        edge["bridge"] = key in graph["bridges"]

    region_systems = defaultdict(list)
    region_edges = defaultdict(list)
    for system in systems.values():
        region_systems[system["region_id"]].append(system["system_id"])
    for edge in edges.values():
        if edge["from_region_id"] == edge["to_region_id"]:
            region_edges[edge["from_region_id"]].append(edge)

    for constellation in constellations.values():
        constellation["position_2d"], constellation["bounds_2d"] = derive_layout(
            [systems[sid]["position_2d"] for sid in constellation["solar_system_ids"] if sid in systems]
        )

    region_summaries = []
    for region in regions.values():
        rid = region["region_id"]
        system_ids = sorted(region_systems[rid], key=lambda sid: systems[sid]["name"])
        region["systems"] = system_ids
        region["constellations"] = sorted(
            [cid for cid, c in constellations.items() if c["region_id"] == rid],
            key=lambda cid: constellations[cid]["name"],
        )
        region["system_count"] = len(system_ids)
        region["position_2d"], region["bounds_2d"] = derive_layout(
            [systems[sid]["position_2d"] for sid in system_ids]
        )
        region_summaries.append(
            {
                "region_id": rid,
                "name": region["name"],
                "system_count": len(system_ids),
                "constellation_count": len(region["constellations"]),
            }
        )

    systems_with_layout = sum(1 for s in systems.values() if s["position_2d"] is not None)
    all_data = {
        "meta": {
            # Bumped by hand when the shape of this export changes, so a viewer
            # served from cache can tell that it is older than the data it just
            # loaded and say so, instead of failing somewhere confusing. It is
            # deliberately not a timestamp: the build is byte-reproducible and a
            # clock would destroy that.
            "schema_version": 5,
            "source": "CCP EVE Online Static Data Export JSONL",
            "source_file": str(ZIP_PATH.name),
            "note": "Offline topology bundle generated locally. No DOTLAN page data is included.",
            "factions": {
                "source": "factions.jsonl",
                "meaning": (
                    "Every faction in the export, by id. Present so that live layers returning a "
                    "faction_id - sovereignty, faction warfare, incursions - can name it from the "
                    "archive rather than from a table written by hand."
                ),
            },
            "npc_stations": {
                "source": "npcStations.jsonl, counted per solar system",
                "meaning": (
                    "How many NPC stations the system contains. Zero means no NPC station, "
                    "NOT that docking is impossible: player structures are not in the Static "
                    "Data Export and cannot be enumerated without access."
                ),
            },
            "layout_2d": {
                "schema_version": 1,
                "source": "mapSolarSystems.jsonl position2D, the layout the game client itself uses",
                "display_convention": "screenX = x, screenY = -y. The negation is the renderer's; values here are as published.",
                "purpose": "Display only. Light-year distance, jump range and capital routing use the physical position and are unaffected by this field.",
                "systems_with_layout": systems_with_layout,
                "systems_without_layout": len(systems) - systems_with_layout,
                "fallback": (
                    # Three groups, not two. The third was omitted here for a long time;
                    # that history belongs in this comment rather than in a sentence
                    # shipped for an agent to read as fact.
                    "position_2d is null where CCP publishes no layout: J-space, the Abyssal "
                    "proving grounds, and CCP's VR-* and GPMR-01 test regions. "
                    "A renderer must fall back to the derived schematic for those, "
                    "and must not read null as the origin."
                ),
                "derived_levels": (
                    "Regions and constellations carry position_2d and bounds_2d derived from the "
                    "member systems that have coordinates - the centre and extent of that set. "
                    "The SDE publishes no position2D at either level; these are this project's."
                ),
            },
        },
        "regions": regions,
        "constellations": constellations,
        "factions": factions,
        "systems": systems,
        # No stargates block, and no per-system stargate id list.
        #
        # The gate records below are read from the SDE and are what `edges` and
        # every system's `neighbors` are derived from - they are the source of
        # the topology. They were also *shipped*: 13,978 records carrying gate
        # positions, 2.5 MB, a third of eve_map_all.json, which the browser
        # parses on every cold start.
        #
        # Nothing read them. Not the router, which walks `neighbors`; not the
        # jump planner, whose "on the stargate network" test is
        # `neighbors.length > 0`; not the map, the tactical analyser or the
        # wormhole layer. Verified by removing both fields from the real archive
        # and running the whole suite: 2,328 assertions, none of them noticed.
        #
        # Dropping them takes the archive from 7.69 MB to 4.85 MB (-36.9%), and
        # 1.34 MB to 769 KB gzipped. If gate positions are ever wanted - the one
        # plausible use is attributing a killmail to a specific gate rather than
        # to a system - `gates` is still built here and restoring it is this one
        # line plus a rebuild.
        "jumps": list(edges.values()),
        "graph": {
            "component_sizes": graph["component_sizes"],
            "largest_component": graph["largest_component"],
            "articulation_points": sum(1 for m in graph["metrics"].values() if m["articulation"]),
            "bridges": len(graph["bridges"]),
        },
    }

    # Written fresh, not merged into whatever was here before. A region that
    # CCP removes, or a file left by an older build, otherwise survives every
    # rebuild: the archive reproduces file-for-file but not directory-for-
    # directory, and the verifier reports "115 region files, expected 114"
    # naming the count rather than the file.
    for stale_dir in (DATA_DIR / "regions", DATA_DIR / "ai"):
        if stale_dir.exists():
            for stale in stale_dir.iterdir():
                if stale.is_file():
                    stale.unlink()

    write_text(DATA_DIR / "eve_map_all.json", json.dumps(all_data, separators=(",", ":")))
    write_text(DATA_DIR / "regions.json", json.dumps(sorted(region_summaries, key=lambda r: r["name"]), indent=2))
    write_text(DATA_DIR / "ships.json", json.dumps(jump_data, indent=2))
    write_ai_exports(regions, constellations, systems, edges)

    by_region_dir = DATA_DIR / "regions"
    by_region_dir.mkdir(exist_ok=True)
    for region in regions.values():
        rid = region["region_id"]
        payload = {
            "region": region,
            "constellations": {cid: constellations[cid] for cid in region["constellations"]},
            "systems": {sid: systems[sid] for sid in region["systems"]},
            "jumps": region_edges[rid],
        }
        safe_name = region["name"].replace(" ", "_").replace("/", "_")
        write_text(by_region_dir / f"{safe_name}.json", json.dumps(payload, indent=2))

    if DB_PATH.exists():
        DB_PATH.unlink()
    con = sqlite3.connect(DB_PATH)
    cur = con.cursor()
    cur.executescript(
        """
        create table regions(region_id integer primary key, name text, system_count integer, constellation_count integer);
        create table constellations(constellation_id integer primary key, region_id integer, name text);
        create table factions(faction_id integer primary key, name text, militia_corporation_id integer, home_system_id integer);
        create table systems(system_id integer primary key, region_id integer, constellation_id integer, name text, security real, x real, y real, z real,
                            x2d real, y2d real, npc_stations integer,
                            degree integer, betweenness real, articulation integer, component integer, component_size integer);
        create table jumps(from_system_id integer, to_system_id integer, from_region_id integer, to_region_id integer, distance_ly real, bridge integer, primary key(from_system_id, to_system_id));
        create index systems_region_idx on systems(region_id);
        create index systems_betweenness_idx on systems(betweenness desc);
        create index systems_articulation_idx on systems(articulation);
        create index jumps_from_idx on jumps(from_system_id);
        create index jumps_to_idx on jumps(to_system_id);
        create index jumps_bridge_idx on jumps(bridge);
        """
    )
    cur.executemany(
        "insert into regions values(?,?,?,?)",
        [(r["region_id"], r["name"], r["system_count"], len(r["constellations"])) for r in regions.values()],
    )
    cur.executemany(
        "insert into constellations values(?,?,?)",
        [(c["constellation_id"], c["region_id"], c["name"]) for c in constellations.values()],
    )
    cur.executemany(
        "insert into factions values(?,?,?,?)",
        [(f["faction_id"], f["name"], f["militia_corporation_id"], f["home_system_id"]) for f in factions.values()],
    )
    cur.executemany(
        "insert into systems values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [
            (
                s["system_id"], s["region_id"], s["constellation_id"], s["name"], s["security"], *s["position"],
                *(s["position_2d"] if s["position_2d"] is not None else (None, None)),
                s["npc_stations"],
                s["metrics"]["degree"], s["metrics"]["betweenness"], int(s["metrics"]["articulation"]),
                s["metrics"]["component"], s["metrics"]["component_size"],
            )
            for s in systems.values()
        ],
    )
    cur.executemany(
        "insert into jumps values(?,?,?,?,?,?)",
        [(e["from_system_id"], e["to_system_id"], e["from_region_id"], e["to_region_id"], e["distance_ly"], int(e["bridge"])) for e in edges.values()],
    )
    con.commit()
    con.close()

    print(f"regions={len(regions)} constellations={len(constellations)} systems={len(systems)} jumps={len(edges)}")
    print(
        f"jump-capable hulls={len(jump_data['ships'])} skills={list(jump_data['skills'])} "
        f"hull-fuel-bonus hulls={hulls_with_fuel_bonus} fuel modules={len(jump_data['fuel_modules'])}"
    )
    print(
        f"graph: components={graph['component_sizes'][:4]} "
        f"articulation_points={sum(1 for m in graph['metrics'].values() if m['articulation'])} "
        f"bridges={len(graph['bridges'])}"
    )
    print(f"wrote {DATA_DIR}")
    print(f"preserved custom viewer at {WEB_DIR / 'index.html'}")


def write_text(path: Path, content: str) -> None:
    # Always LF. See the Line Endings note in the project document.
    with path.open("w", encoding="utf-8", newline="\n") as f:
        f.write(content)


def write_jsonl(path: Path, rows):
    with path.open("w", encoding="utf-8", newline="\n") as f:
        for row in rows:
            f.write(json.dumps(row, separators=(",", ":")) + "\n")


def write_csv(path: Path, headers, rows):
    import csv

    # Python renders booleans as True/False, which no other CSV reader coerces.
    def csv_value(value):
        if isinstance(value, bool):
            return 1 if value else 0
        return value

    with path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=headers, extrasaction="ignore", lineterminator="\n")
        writer.writeheader()
        for row in rows:
            writer.writerow({key: csv_value(value) for key, value in row.items()})


def write_ai_exports(regions, constellations, systems, edges):
    # Derived here rather than written down. Both documents below quoted a
    # hand-typed "3,005", while the same figure is computed from `systems` a few
    # hundred lines up - the "data pretending to be code" failure this build's
    # own comments warn about, committed in the build's own shipped output. A
    # future SDE moves the real count and the agent documentation goes quietly
    # wrong.
    without_layout = sum(1 for s in systems.values() if s["position_2d"] is None)

    # **The breakdown of those systems, derived rather than described.**
    #
    # This sentence said "J-space and the Abyssal grounds", which is two of the
    # three groups: 201 systems sit in CCP's `VR-*` and `GPMR-01` test regions and
    # were named by neither half. Somebody worked that out and corrected
    # `README_AI.md` by hand - and `data/ai/` is deleted at the start of every
    # build, so the next rebuild would have thrown the correction away and written
    # the incomplete sentence back. `SCHEMA.json` still carried it, because that one
    # *is* what a rebuild writes.
    #
    # Counted from the regions rather than written down, which is the same rule the
    # note a few lines down already states about `without_layout` itself: a
    # hand-written number in generated documentation is data pretending to be code,
    # committed in the build's own output.
    layout_groups = {"anoikis": 0, "abyssal": 0, "test": 0}
    for system in systems.values():
        if system["position_2d"] is not None:
            continue
        region_name = regions[system["region_id"]]["name"]
        if region_name.startswith(("VR-", "GPMR")):
            layout_groups["test"] += 1
        elif region_name.startswith("ADR"):
            layout_groups["abyssal"] += 1
        else:
            layout_groups["anoikis"] += 1
    assert sum(layout_groups.values()) == without_layout, (
        f"the layout breakdown totals {sum(layout_groups.values())}, not {without_layout}"
    )
    layout_split = (
        f"{layout_groups['anoikis']:,} in J-space, {layout_groups['abyssal']:,} in the "
        f"Abyssal proving grounds, and {layout_groups['test']:,} in CCP's VR-* and GPMR-01 "
        "test regions, none of which carry a stargate"
    )
    ai_dir = DATA_DIR / "ai"
    ai_dir.mkdir(exist_ok=True)

    region_rows = []
    for r in sorted(regions.values(), key=lambda x: x["name"]):
        region_rows.append(
            {
                "region_id": r["region_id"],
                "name": r["name"],
                "system_count": r["system_count"],
                "constellation_count": len(r["constellations"]),
            }
        )

    system_rows = []
    for s in sorted(systems.values(), key=lambda x: x["name"]):
        system_rows.append(
            {
                "system_id": s["system_id"],
                "name": s["name"],
                "region_id": s["region_id"],
                "region_name": regions[s["region_id"]]["name"],
                "constellation_id": s["constellation_id"],
                "constellation_name": constellations[s["constellation_id"]]["name"],
                "security": round(s["security"], 4),
                "x": s["position"][0],
                "y": s["position"][1],
                "z": s["position"][2],
                "x2d": s["position_2d"][0] if s["position_2d"] else None,
                "y2d": s["position_2d"][1] if s["position_2d"] else None,
                "npc_stations": s["npc_stations"],
                "neighbor_ids": s["neighbors"],
                "neighbor_names": [systems[n]["name"] for n in s["neighbors"]],
                "degree": s["metrics"]["degree"],
                "betweenness": s["metrics"]["betweenness"],
                "articulation": s["metrics"]["articulation"],
                "component": s["metrics"]["component"],
                "component_size": s["metrics"]["component_size"],
            }
        )

    jump_rows = []
    for e in sorted(edges.values(), key=lambda x: (systems[x["from_system_id"]]["name"], systems[x["to_system_id"]]["name"])):
        a = systems[e["from_system_id"]]
        b = systems[e["to_system_id"]]
        jump_rows.append(
            {
                "from_system_id": e["from_system_id"],
                "from_system_name": a["name"],
                "from_region_id": a["region_id"],
                "from_region_name": regions[a["region_id"]]["name"],
                "to_system_id": e["to_system_id"],
                "to_system_name": b["name"],
                "to_region_id": b["region_id"],
                "to_region_name": regions[b["region_id"]]["name"],
                "distance_ly": e["distance_ly"],
                "cross_region": a["region_id"] != b["region_id"],
                "bridge": e["bridge"],
            }
        )

    constellation_rows = []
    for c in sorted(constellations.values(), key=lambda x: x["name"]):
        constellation_rows.append(
            {
                "constellation_id": c["constellation_id"],
                "name": c["name"],
                "region_id": c["region_id"],
                "region_name": regions[c["region_id"]]["name"],
                "system_count": len(c["solar_system_ids"]),
                "system_ids": c["solar_system_ids"],
            }
        )

    write_jsonl(ai_dir / "regions.jsonl", region_rows)
    write_jsonl(ai_dir / "constellations.jsonl", constellation_rows)
    write_jsonl(ai_dir / "systems.jsonl", system_rows)
    write_jsonl(ai_dir / "jumps.jsonl", jump_rows)

    write_csv(ai_dir / "regions.csv", ["region_id", "name", "system_count", "constellation_count"], region_rows)
    write_csv(
        ai_dir / "systems.csv",
        [
            "system_id", "name", "region_id", "region_name", "constellation_id", "constellation_name",
            "security", "x", "y", "z", "x2d", "y2d", "npc_stations",
            "degree", "betweenness", "articulation", "component", "component_size",
        ],
        system_rows,
    )
    write_csv(
        ai_dir / "jumps.csv",
        [
            "from_system_id",
            "from_system_name",
            "from_region_id",
            "from_region_name",
            "to_system_id",
            "to_system_name",
            "to_region_id",
            "to_region_name",
            "distance_ly",
            "cross_region",
            "bridge",
        ],
        jump_rows,
    )

    cross_region = [j for j in jump_rows if j["cross_region"]]
    write_jsonl(ai_dir / "cross_region_jumps.jsonl", cross_region)

    # Ranked structural products, so an agent does not have to recompute them.
    chokepoints = sorted(
        (r for r in system_rows if r["degree"] >= 1 and (r["articulation"] or r["degree"] <= 2)),
        key=lambda r: (-r["betweenness"], r["name"]),
    )
    write_jsonl(ai_dir / "chokepoints.jsonl", chokepoints)
    write_jsonl(ai_dir / "bridges.jsonl", [j for j in jump_rows if j["bridge"]])

    schema = {
        "purpose": "AI-friendly EVE universe topology exports generated from CCP SDE. Use these files instead of scraping DOTLAN.",
        "files": {
            "regions.jsonl/csv": "One region per row: region_id, name, system_count, constellation_count.",
            "constellations.jsonl": "One constellation per row with region linkage and system_ids.",
            "systems.jsonl": "One solar system per row with region/constellation names, security, coordinates, neighbor_ids, neighbor_names, and graph metrics. x/y/z are physical; x2d/y2d are CCP's official schematic layout, null where none is published.",
            "systems.csv": "Flat system table without neighbor arrays; best for spreadsheets and SQL imports.",
            "jumps.jsonl/csv": "Undirected stargate links, one row per system pair, each flagged as a bridge or not.",
            "cross_region_jumps.jsonl": "Subset of jumps that cross region boundaries; useful for pipe/choke analysis.",
            "chokepoints.jsonl": "Systems that are articulation points or have at most two gates, ranked by betweenness.",
            "bridges.jsonl": "Stargate links whose removal would disconnect the systems they join.",
            "../eve_map.sqlite": "SQLite copy with regions, constellations, systems, jumps tables, including graph metrics.",
        },
        "notes": [
            "Coordinates x/y/z are SDE physical universe coordinates in meters, and are what distance_ly and every jump-range calculation use.",
            "npc_stations is how many NPC stations the system contains. Zero means no NPC station, not that docking is impossible: player structures are not in the export and cannot be enumerated without access.",
            # Interpolated, not written down. The same function computes
            # systems_without_layout a few lines up, and this sentence is
            # shipped documentation that agents are told to read first - a
            # hand-written number here is the "data pretending to be code"
            # failure this build's own comments warn against, committed in the
            # build's own output.
            f"x2d/y2d are CCP's official two-dimensional map layout from position2D, for display only. They are null for the {without_layout:,} systems with no published layout - {layout_split}. Every system reachable by gate has one. Null is not the origin. Draw with screenY = -y2d.",
            "distance_ly is straight-line system-center distance, not route length.",
            "Jumps are stargate topology only; wormholes, ansiblexes, filaments, cynos, and live sovereignty are not included.",
            "Region JSON files live in data/regions/<Region_Name>.json for targeted loading.",
            "degree is the number of stargate links.",
            "articulation is true when removing the system would disconnect systems that could otherwise still reach each other.",
            "bridge is true for a link whose removal would do the same.",
            "betweenness is the share of all shortest paths between all other system pairs that passes through the system, by Brandes' algorithm, halved for the undirected double count. It is a structural measure over the whole stargate graph, not a traffic measure.",
            "component groups systems that can reach each other by stargate. Pochven is a separate component with no external links, so no route crosses it.",
            "Systems with no stargates report zero for every metric and a component of -1.",
        ],
    }
    write_text(ai_dir / "SCHEMA.json", json.dumps(schema, indent=2))

    readme = f"""# AI Use Notes

This folder is for local agents and scripts. It contains compact topology exports generated from the official CCP EVE Static Data Export.

Use this when you need:

- region/system lookup
- stargate adjacency
- route graph input
- region-boundary pipes
- local offline analysis without DOTLAN scraping

Recommended files:

- `systems.jsonl`: best general-purpose system lookup. Includes names, IDs, security, coordinates, and neighbor names.
  Two coordinate systems: `x`/`y`/`z` are physical, in meters, and are what every distance and jump-range figure uses.
  `x2d`/`y2d` are CCP's official map layout, for display only, and are null for the {without_layout:,} systems with no published
  layout - {layout_split}. Every system reachable by gate has one. Null means no layout, not the origin. Draw with `screenY = -y2d`.
- `jumps.jsonl`: best for graph/pathfinding. One undirected stargate edge per row.
- `cross_region_jumps.jsonl`: best for choke/pipe analysis.
- `chokepoints.jsonl`: articulation points and low-degree systems, ranked by betweenness.
- `bridges.jsonl`: stargate links whose loss would split the network.
- `regions.jsonl`: best for enumerating regions.
- `../eve_map.sqlite`: best for SQL queries.

Example SQLite queries:

```sql
-- Find all systems in a region
select name, security from systems
where region_id = (select region_id from regions where name = 'Catch')
order by name;

-- Find cross-region jumps touching Catch
select fs.name as from_system, fr.name as from_region, ts.name as to_system, tr.name as to_region
from jumps j
join systems fs on fs.system_id = j.from_system_id
join systems ts on ts.system_id = j.to_system_id
join regions fr on fr.region_id = fs.region_id
join regions tr on tr.region_id = ts.region_id
where fr.name = 'Catch' or tr.name = 'Catch'
order by from_region, from_system;
```

Important: this is static topology. It does not include live sovereignty, kills, jumps, player structures, ansiblexes, or current control.
"""
    write_text(ai_dir / "README_AI.md", readme)


if __name__ == "__main__":
    main()
