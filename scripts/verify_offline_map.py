from __future__ import annotations

import hashlib
import functools
import json
import math
import shutil
import random
import re
import sqlite3
import sys
import tempfile
import zipfile
from collections import Counter, deque
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import graph_metrics
import jump_ships


ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
ATLAS_PATH = DATA_DIR / "eve_map_all.json"
SHIPS_PATH = DATA_DIR / "ships.json"
AI_DIR = DATA_DIR / "ai"
REGION_DIR = DATA_DIR / "regions"
DB_PATH = DATA_DIR / "eve_map.sqlite"
ZIP_PATH = ROOT / "source" / "eve-sde-latest-jsonl.zip"

# Pinned facts. A verifier that only checks a value is inside its own declared
# range cannot see the value being halved, negated or zeroed, which is exactly
# the corruption most likely to matter. These pin the shape of the archive.
EXPECTED_SECURITY_CLASSES = {"high": 1247, "low": 687, "null": 6556}
EXPECTED_GATED_SYSTEMS = 5268

# Pinned for the reason EXPECTED_GATED_SYSTEMS is pinned. An archive can be wrong and
# *coherent*: delete 481 stargate links, rebuild every derived file around them, and
# every check comparing this archive to its own other representations passes, because
# they all agree with each other and agreement is not correctness. The comparison
# against the SDE below is the real answer; these figures name the drift in one line
# before it gets there, and still say something if the zip beside them is replaced.
EXPECTED_SYSTEMS = 8490
EXPECTED_REGIONS = 114
EXPECTED_CONSTELLATIONS = 1184
EXPECTED_STARGATES = 13978
EXPECTED_JUMP_EDGES = 6989
# Every system CCP publishes a schematic layout for, which is exactly K-space.
EXPECTED_SYSTEMS_WITH_LAYOUT_2D = 5485
# The docking layer, straight from npcStations.jsonl.
EXPECTED_NPC_STATIONS = 5210
# Factions, from factions.jsonl. Six carry a militia corporation, not the four
# empires: the two pirate factions have one as well, from the insurgency
# mechanics. That is the reason to read this from the archive rather than write
# a list down - the list would have said four, and been wrong since 2023.
EXPECTED_FACTIONS = 27
EXPECTED_MILITIA_FACTIONS = 6
EXPECTED_SYSTEMS_WITH_STATIONS = 1754
LAYOUT_2D_SCHEMA_VERSION = 1
ARCHIVE_SCHEMA_VERSION = 5
# The content digest of data/eve_map.sqlite, pinned rather than merely printed.
# Independently reproduced from a clean build before being written down here.
EXPECTED_DB_DIGEST = "4c1d216f4e3dd66976afda03d2829cacf7e95cec566b7a6310a28a297bb57cff"
# Imported from jump_ships rather than restated. Two independent definitions of
# the same expectation drift apart silently, and both of them assert.
EXPECTED_HULL_FUEL_BONUSES = jump_ships.EXPECTED_HULL_FUEL_BONUSES
EXPECTED_FUEL_TYPES = 4
EXPECTED_FUEL_MODULES = 3
HIGH_SECURITY = 0.45

# Jump fatigue, which is a game rule and appears nowhere in the SDE. Pinned here
# because nothing else can check it: a wrong cap produces a plausible number.
FATIGUE_MODEL = {
    "floorMinutes": 10,
    "cooldownDivisor": 10,
    "capMinutes": 300,
    "cooldownCapMinutes": 30,
    "decayMinutesPerMinute": 1,
}

# Dogma attributes carrying the jump figures, so the exported hulls can be
# checked against the SDE rather than against themselves.
JUMP_RANGE_ATTRIBUTE = 867
JUMP_FUEL_ATTRIBUTE = 868
JUMP_CAPACITOR_ATTRIBUTE = 898


def read_jsonl(archive: zipfile.ZipFile, name: str):
    """One line at a time, so a 99 MB zip is never held in memory twice."""
    with archive.open(name) as handle:
        for line in handle:
            if line.strip():
                yield json.loads(line)


# **A check that is not called must fail the run.**
#
# The 481 deleted stargate links got through because `check.ps1` did not call
# this file. One level down, nothing here noticed `main` not calling one of its
# own checks either: replacing the SDE comparison with a literal summary string
# left every assertion in place, unreached, and the verifier printed success.
# That is the same fault as the incident that motivated the comparison, so it is
# refused the same way - by name, against a list, rather than by reading `main`
# carefully.
PERFORMED: set[str] = set()

# The five checks that read CCP's export, named rather than discovered.
#
# A clone carries `data/` and not `source/`, so these have nothing to compare against.
# Without the export the run is **explicitly short** - `--without-sde` names the
# omission, the summary prints it, and the registry assertion at the end of `main`
# expects exactly the remaining four. Skipping one silently is the failure this file's
# two registries exist to prevent.
NEEDS_SDE = frozenset({
    "verify_against_sde",
    "verify_ships",
    "verify_layout_2d",
    "verify_npc_stations",
    "verify_factions",
})

# Where to get it, said once. The builder reads the same path.
SDE_SOURCE = "https://developers.eveonline.com/static-data"

EXPECTED_CHECKS = frozenset({
    "verify_against_sde",
    "verify_archive_values",
    "verify_graph_metrics",
    "verify_ships",
    "verify_derived_exports",
    "verify_hierarchy",
    "verify_layout_2d",
    "verify_npc_stations",
    "verify_factions",
})


def records(function):
    """Mark a check as having actually run, for the assertion at the end of main."""
    @functools.wraps(function)
    def wrapper(*args, **kwargs):
        result = function(*args, **kwargs)
        PERFORMED.add(function.__name__)
        return result
    return wrapper


def security_class(value):
    if value >= HIGH_SECURITY:
        return "high"
    return "low" if value > 0 else "null"


def connected_pieces(adjacency, skip_node=None, skip_edge=None):
    """Independently re-derive connected components from the adjacency the
    export actually carries, so a metric is never checked against the same
    computation that produced it."""
    seen = set()
    if skip_node is not None:
        seen.add(skip_node)
    pieces = []
    for start in adjacency:
        if start in seen:
            continue
        size = 0
        members = set()
        stack = [start]
        seen.add(start)
        while stack:
            node = stack.pop()
            size += 1
            members.add(node)
            for neighbor in adjacency[node]:
                if neighbor in seen or neighbor not in adjacency:
                    continue
                if skip_edge is not None and tuple(sorted((node, neighbor))) == skip_edge:
                    continue
                seen.add(neighbor)
                stack.append(neighbor)
        pieces.append((size, members))
    return pieces


def reachable(adjacency, start, goal, skip_node=None, skip_edge=None):
    if start == goal:
        return True
    seen = {start}
    if skip_node is not None:
        seen.add(skip_node)
    queue = deque([start])
    while queue:
        node = queue.popleft()
        for neighbor in adjacency.get(node, ()):
            if neighbor in seen:
                continue
            if skip_edge is not None and tuple(sorted((node, neighbor))) == skip_edge:
                continue
            if neighbor == goal:
                return True
            seen.add(neighbor)
            queue.append(neighbor)
    return False


@records
def verify_archive_values(systems, jumps) -> None:
    """Check the values themselves, not merely that they are in range.

    Asserting -1 <= security <= 1 passes just as happily when every security
    has been negated or halved. These checks pin what the archive actually is.
    """
    classes = Counter(security_class(float(s["security"])) for s in systems.values())
    assert dict(classes) == EXPECTED_SECURITY_CLASSES, (
        f"security composition is {dict(classes)}, expected {EXPECTED_SECURITY_CLASSES}. "
        "Either the archive changed or security values have been altered."
    )

    gated = sum(1 for s in systems.values() if s["neighbors"])
    assert gated == EXPECTED_GATED_SYSTEMS, f"{gated} systems carry a stargate, expected {EXPECTED_GATED_SYSTEMS}"

    # Coordinates and the distances derived from them.
    placed = sum(1 for s in systems.values() if any(s["position"]))
    assert placed == len(systems), f"{len(systems) - placed} systems sit at the origin"

    worst = 0.0
    for jump in jumps:
        a = systems[str(jump["from_system_id"])]["position"]
        b = systems[str(jump["to_system_id"])]["position"]
        expected = math.dist(a, b) / 9_460_730_472_580_800
        worst = max(worst, abs(expected - float(jump["distance_ly"])))
    # distance_ly is stored rounded to three decimals, so the largest honest
    # disagreement is half of the last place: 0.0005. A tolerance of 0.002 was
    # four times looser than the data's own precision, and would accept every
    # distance in the archive being wrong by 0.0015 ly.
    assert worst <= 0.0005 + 1e-9, f"distance_ly disagrees with the coordinates by up to {worst:.6f} ly"

    # Names, which nothing else would notice losing.
    blank = [sid for sid, s in systems.items() if not str(s["name"]).strip()]
    assert not blank, f"{len(blank)} systems have no name"
    assert systems["30000142"]["name"] == "Jita", "system 30000142 should be Jita"

    return None


@records
def verify_hierarchy(systems, constellations, regions) -> str:
    """Every system must sit in a constellation that sits in its own region.

    That sentence was a comment above `return None` for a long time: written,
    never implemented, and nothing downstream would have noticed. A system whose
    constellation belongs to another region routes and draws perfectly normally
    and is filed under the wrong region in every list that groups by region.
    """
    for system in systems.values():
        constellation = constellations.get(str(system["constellation_id"]))
        assert constellation is not None, (
            f"system {system['name']} names constellation {system['constellation_id']}, which does not exist"
        )
        assert constellation["region_id"] == system["region_id"], (
            f"system {system['name']} claims region {system['region_id']} but its constellation "
            f"{constellation['name']} belongs to region {constellation['region_id']}"
        )
    for constellation in constellations.values():
        assert str(constellation["region_id"]) in regions, (
            f"constellation {constellation['name']} names region {constellation['region_id']}, which does not exist"
        )
    return f"{len(systems)} systems sit in a constellation inside their own region"


@records
def verify_ships() -> str:
    """The capital calculator's data was previously verified by nothing at all.

    A doubled fuel figure, a lost hull bonus or an empty file would all have
    passed silently while the verifier printed success.
    """
    assert SHIPS_PATH.exists(), "data/ships.json is missing"
    data = json.loads(SHIPS_PATH.read_text(encoding="utf-8"))

    ships = data.get("ships") or []
    assert len(ships) >= 50, f"only {len(ships)} jump-capable hulls were exported"
    for ship in ships:
        assert ship["base_range_ly"] > 0, f"{ship['name']} has no jump range"
        assert ship["base_fuel_per_ly"] > 0, f"{ship['name']} has no fuel rate"
        assert ship["fuel_type_id"], f"{ship['name']} has no fuel type"

    skills = data.get("skills") or {}
    assert skills["Jump Drive Calibration"]["range_bonus_per_level"] == 20, (
        "the jump range bonus per level is not 20%; every range figure depends on it"
    )
    assert skills["Jump Fuel Conservation"]["fuel_bonus_per_level"] == -10, (
        "the fuel bonus per level is not -10%; every fuel figure depends on it"
    )

    # The bonus whose absence once doubled every jump freighter figure.
    with_bonus = [s for s in ships if s.get("hull_fuel_bonus")]
    assert len(with_bonus) == EXPECTED_HULL_FUEL_BONUSES, (
        f"{len(with_bonus)} hulls carry a jump-fuel trait bonus, expected {EXPECTED_HULL_FUEL_BONUSES}. "
        "A reworded trait would silently double their fuel."
    )
    for ship in with_bonus:
        assert ship["hull_fuel_bonus"]["percent_per_level"] < 0, f"{ship['name']} fuel bonus is not a reduction"

    # Any range bonus must carry its direction; a penalty stored as a bonus
    # would inflate range.
    for ship in ships:
        bonus = ship.get("hull_range_bonus")
        if bonus and "reduction" in str(bonus.get("trait", "")).lower():
            assert bonus["percent_per_level"] < 0, f"{ship['name']} stores a range reduction as a bonus"

    fuel_types = data.get("fuel_types") or {}
    assert len(fuel_types) == EXPECTED_FUEL_TYPES, (
        f"{len(fuel_types)} fuel types, expected {EXPECTED_FUEL_TYPES} racial isotopes"
    )
    assert len(data.get("fuel_modules") or []) == EXPECTED_FUEL_MODULES, "fuel modules are missing"
    assert all(m["fuel_bonus_percent"] < 0 for m in data["fuel_modules"]), "a fuel module does not reduce fuel"

    # Every exported hull's jump figures, re-read from the SDE.
    #
    # What stood here checked that each value was truthy and positive - a range
    # of 0.001 ly and a fuel cost of 1 would have passed, and every capital
    # figure in the planner would have been fiction with nothing to catch it.
    # The station and faction layers are already re-derived from source this
    # way; the ships were not, and they are the ones a pilot plans a move on.
    with zipfile.ZipFile(ZIP_PATH) as archive:
        with archive.open("typeDogma.jsonl") as handle:
            dogma = {}
            for line in handle:
                if not line.strip():
                    continue
                record = json.loads(line)
                wanted = {
                    attribute.get("attributeID"): attribute.get("value")
                    for attribute in record.get("dogmaAttributes") or []
                    if attribute.get("attributeID") in
                    (JUMP_RANGE_ATTRIBUTE, JUMP_FUEL_ATTRIBUTE, JUMP_CAPACITOR_ATTRIBUTE)
                }
                if wanted:
                    dogma[int(record["_key"])] = wanted

    for ship in ships:
        source = dogma.get(int(ship["type_id"]))
        assert source is not None, f"{ship['name']} carries no jump attributes in the SDE"
        for label, attribute, field in (
            ("range", JUMP_RANGE_ATTRIBUTE, "base_range_ly"),
            ("fuel per ly", JUMP_FUEL_ATTRIBUTE, "base_fuel_per_ly"),
            ("capacitor per ly", JUMP_CAPACITOR_ATTRIBUTE, "capacitor_per_ly"),
        ):
            expected = source.get(attribute)
            if expected is None:
                continue
            assert abs(float(ship[field]) - float(expected)) < 1e-9, (
                f"{ship['name']} {label} is {ship[field]}, the SDE says {expected}"
            )

    model = data.get("fatigue_model") or {}
    assert "not present in the Static Data Export" in str(model.get("source", "")), (
        "the fatigue model must declare that it does not come from the archive"
    )
    # The five numbers, not just the provenance string.
    #
    # These are game rules and appear nowhere in the SDE, so nothing else in
    # this file can catch them changing - and a jump planner with the wrong
    # fatigue cap gives confidently wrong answers rather than obviously wrong
    # ones. Checking only that the model admits it is not from the archive left
    # every figure it contains unverified.
    for name, expected in FATIGUE_MODEL.items():
        assert model.get(name) == expected, (
            f"fatigue model {name} is {model.get(name)!r}, expected {expected!r}. "
            "These are game rules, not SDE data - change them deliberately."
        )

    known = {s["name"]: s for s in ships}
    assert known["Ark"]["base_fuel_per_ly"] == 8800, "the Ark's base fuel rate changed"
    assert known["Archon"]["base_range_ly"] == 3.5, "the carrier base range changed"
    assert known["Ark"]["fatigue_multiplier"] == 0.1, "the jump freighter fatigue multiplier changed"
    assert known["Redeemer"]["fatigue_multiplier"] == 0.25, "the black ops fatigue multiplier changed"

    return f"{len(ships)} hulls, {len(fuel_types)} fuel types, {len(data['fuel_modules'])} modules"


@records
def verify_derived_exports(systems, jumps, regions, constellations) -> str:
    """The AI exports are the documented agent interface and were unchecked."""
    def read_jsonl(name):
        path = AI_DIR / name
        assert path.exists(), f"data/ai/{name} is missing"
        return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]

    ai_systems = read_jsonl("systems.jsonl")
    assert len(ai_systems) == len(systems), f"systems.jsonl holds {len(ai_systems)} rows, the archive holds {len(systems)}"
    # Every row, and every field of it. This loop read `ai_systems[:500]` and
    # compared two fields, so 7,990 rows went unchecked and even the 500 that
    # were checked could have had their names, regions, neighbours and
    # coordinates rewritten without a failure. These files are the documented
    # agent interface: an agent reading a corrupted one has no second source.
    for row in ai_systems:
        source = systems.get(str(row["system_id"]))
        assert source is not None, f"systems.jsonl row {row['system_id']} is not in the archive"
        metrics = source["metrics"]
        assert row["name"] == source["name"], f"{row['system_id']} name disagrees with the archive"
        assert row["region_id"] == source["region_id"], f"{row['name']} region disagrees with the archive"
        assert row["constellation_id"] == source["constellation_id"], f"{row['name']} constellation disagrees"
        assert row["region_name"] == regions[str(source["region_id"])]["name"], f"{row['name']} region name disagrees"
        assert row["constellation_name"] == constellations[str(source["constellation_id"])]["name"], (
            f"{row['name']} constellation name disagrees"
        )
        # The AI exports round security to four decimals, so the largest honest
        # disagreement is exactly half of the last place. Two of the 8,490
        # systems sit on it (S-KU8B, -0.03065 exported as -0.0307), which the
        # old strict `< 5e-5` would have rejected - it never fired only because
        # it ran on the first 500 rows. What matters is not the size of the
        # shift but whether it carries a system across a security class, which
        # is the next assertion and the one with consequences.
        assert abs(row["security"] - source["security"]) <= 5e-5 + 1e-9, (
            f"{row['name']} security disagrees with the archive by more than four-decimal rounding"
        )
        assert security_class(row["security"]) == security_class(source["security"]), (
            f"{row['name']} rounds across a security class boundary in the AI export"
        )
        for axis, index in (("x", 0), ("y", 1), ("z", 2)):
            assert row[axis] == source["position"][index], f"{row['name']} {axis} disagrees with the archive"
        layout = source.get("position_2d")
        assert row["x2d"] == (layout[0] if layout else None), f"{row['name']} x2d disagrees with the archive"
        assert row["y2d"] == (layout[1] if layout else None), f"{row['name']} y2d disagrees with the archive"
        assert row["npc_stations"] == source["npc_stations"], f"{row['name']} station count disagrees"
        assert row["degree"] == metrics["degree"], f"{row['name']} degree disagrees with the archive"
        assert abs(row["betweenness"] - metrics["betweenness"]) < 5e-4, f"{row['name']} betweenness disagrees"
        assert bool(row["articulation"]) == bool(metrics["articulation"]), f"{row['name']} articulation disagrees"
        assert row["component"] == metrics["component"], f"{row['name']} component disagrees"
        assert row["component_size"] == metrics["component_size"], f"{row['name']} component size disagrees"
        assert sorted(row["neighbor_ids"]) == sorted(source["neighbors"]), f"{row['name']} neighbours disagree"
        assert sorted(row["neighbor_names"]) == sorted(
            systems[str(n)]["name"] for n in source["neighbors"]
        ), f"{row['name']} neighbour names disagree"
    assert {str(row["system_id"]) for row in ai_systems} == set(systems), (
        "systems.jsonl and the archive do not cover the same systems"
    )

    # The files nothing opened at all. Each is a published surface, and every one
    # could have been emptied or rewritten without a failure.
    jump_rows = read_jsonl("jumps.jsonl")
    assert len(jump_rows) == len(jumps), f"jumps.jsonl holds {len(jump_rows)} rows, the archive holds {len(jumps)}"
    archive_edges = {(j["from_system_id"], j["to_system_id"]): j for j in jumps}
    for row in jump_rows:
        key = (row["from_system_id"], row["to_system_id"])
        source = archive_edges.get(key)
        assert source is not None, f"jumps.jsonl carries an edge the archive does not: {key}"
        assert abs(row["distance_ly"] - source["distance_ly"]) < 1e-9, f"jumps.jsonl distance disagrees for {key}"
        assert bool(row["bridge"]) == bool(source.get("bridge")), f"jumps.jsonl bridge flag disagrees for {key}"
        assert row["from_system_name"] == systems[str(key[0])]["name"], f"jumps.jsonl name disagrees for {key}"
        assert row["to_system_name"] == systems[str(key[1])]["name"], f"jumps.jsonl name disagrees for {key}"
        assert row["from_region_id"] == systems[str(key[0])]["region_id"], f"jumps.jsonl region disagrees for {key}"
        assert row["to_region_id"] == systems[str(key[1])]["region_id"], f"jumps.jsonl region disagrees for {key}"
        assert bool(row["cross_region"]) == (row["from_region_id"] != row["to_region_id"]), (
            f"jumps.jsonl cross_region flag disagrees with its own region ids for {key}"
        )

    cross_rows = read_jsonl("cross_region_jumps.jsonl")
    expected_cross = [
        j for j in jumps
        if systems[str(j["from_system_id"])]["region_id"] != systems[str(j["to_system_id"])]["region_id"]
    ]
    assert len(cross_rows) == len(expected_cross), (
        f"cross_region_jumps.jsonl holds {len(cross_rows)} rows, the archive has {len(expected_cross)} boundary edges"
    )
    assert all(row["cross_region"] for row in cross_rows), "a cross-region row is not marked cross-region"

    ai_regions = read_jsonl("regions.jsonl")
    assert len(ai_regions) == len(regions), f"regions.jsonl holds {len(ai_regions)} rows, the archive holds {len(regions)}"
    for row in ai_regions:
        source = regions[str(row["region_id"])]
        assert row["name"] == source["name"], f"regions.jsonl name disagrees for {row['region_id']}"
        assert row["system_count"] == source["system_count"], f"regions.jsonl system count disagrees for {row['name']}"

    ai_constellations = read_jsonl("constellations.jsonl")
    assert len(ai_constellations) == len(constellations), (
        f"constellations.jsonl holds {len(ai_constellations)} rows, the archive holds {len(constellations)}"
    )
    members_by_constellation = {}
    for sid, system in systems.items():
        members_by_constellation.setdefault(system["constellation_id"], []).append(int(sid))
    for row in ai_constellations:
        source = constellations[str(row["constellation_id"])]
        assert row["name"] == source["name"], f"constellations.jsonl name disagrees for {row['constellation_id']}"
        assert row["region_id"] == source["region_id"], f"constellations.jsonl region disagrees for {row['name']}"
        assert sorted(row["system_ids"]) == sorted(members_by_constellation.get(row["constellation_id"], [])), (
            f"constellations.jsonl membership disagrees for {row['name']}"
        )

    # The CSVs carry the same rows and exist for anything that cannot parse JSONL. A
    # row count is not a deep check, and an emptied file is the failure that actually
    # happens.
    for name, expected_rows in (
        ("systems.csv", len(systems)), ("jumps.csv", len(jumps)), ("regions.csv", len(regions))
    ):
        path = AI_DIR / name
        assert path.exists(), f"data/ai/{name} is missing"
        lines = [line for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
        assert len(lines) == expected_rows + 1, (
            f"{name} holds {len(lines) - 1} rows, expected {expected_rows} plus a header"
        )

    # SCHEMA.json is what agents are told to read first, and it was never parsed.
    schema_text = (AI_DIR / "SCHEMA.json").read_text(encoding="utf-8")
    schema = json.loads(schema_text)
    assert schema, "SCHEMA.json is empty"
    # The schema names some files in a combined form - "regions.jsonl/csv"
    # describes both regions.jsonl and regions.csv - so the keys are expanded
    # before comparing. README_AI.md is prose rather than a data file and is
    # checked on its own below.
    described = set()
    for key in schema.get("files", {}):
        head, _, tail = str(key).partition("/")
        described.add(head)
        if tail:
            stem = head.rsplit(".", 1)[0]
            described.add(f"{stem}.{tail}")
    on_disk = {
        path.name for path in AI_DIR.iterdir()
        if path.is_file() and path.name not in ("SCHEMA.json", "README_AI.md")
    }
    undescribed = sorted(on_disk - described)
    assert not undescribed, (
        f"SCHEMA.json does not describe {undescribed}, and it is the file agents are told to read first"
    )
    orphaned = sorted(name for name in described if "/" not in name and not name.startswith("..")
                      and not (AI_DIR / name).exists())
    assert not orphaned, f"SCHEMA.json describes {orphaned}, which are not in data/ai"
    readme = (AI_DIR / "README_AI.md").read_text(encoding="utf-8")
    assert len(readme.strip()) > 200, "README_AI.md is the documented entry point and is empty or truncated"

    # **The layout breakdown, checked against the archive rather than against 200
    # characters.**
    #
    # These two documents described the systems with no published layout as
    # "J-space and the Abyssal grounds", which is two of three groups: 201 sit in
    # CCP's VR-* and GPMR-01 test regions and were named by neither half. Somebody
    # worked that out and corrected `README_AI.md` by hand - and the builder deletes
    # `data/ai/` before writing, so the next rebuild would have thrown the
    # correction away and written the incomplete sentence back. `SCHEMA.json` still
    # carried it, because that one *is* what a rebuild writes.
    #
    # The builder derives the three figures now, so this checks the arithmetic
    # rather than the wording: whatever the sentence says, the parts have to add up
    # to the systems the archive actually has no layout for. A "longer than 200
    # characters" assertion could not see any of this.
    without_layout = sum(1 for system in systems.values() if system.get("position_2d") is None)
    for name, text in (("README_AI.md", readme), ("SCHEMA.json", schema_text)):
        stated = [int(value.replace(",", "")) for value in
                  re.findall(r"([0-9][0-9,]*) in (?:J-space|the Abyssal|CCP's)", text)]
        assert len(stated) == 3, (
            f"{name} names {len(stated)} of the three groups of systems with no published layout; "
            "the builder derives all three and this document is generated from it"
        )
        assert sum(stated) == without_layout, (
            f"{name} says {sum(stated)} systems have no published layout, split {stated}, "
            f"and the archive has {without_layout}"
        )
        assert "GPMR" in text and "VR-" in text, (
            f"{name} does not name the test regions, which are 201 of the {without_layout}"
        )

    chokepoints = read_jsonl("chokepoints.jsonl")
    assert chokepoints, "chokepoints.jsonl is empty"
    gateless = [r for r in chokepoints if r["degree"] < 1]
    assert not gateless, (
        f"{len(gateless)} chokepoint rows have no stargate at all, e.g. {gateless[0]['name']}. "
        "A system no route can reach is not a chokepoint."
    )
    assert all(r["articulation"] or r["degree"] <= 2 for r in chokepoints), "a chokepoint row meets neither criterion"

    bridges = read_jsonl("bridges.jsonl")
    stored = sum(1 for j in json.loads(ATLAS_PATH.read_text(encoding="utf-8"))["jumps"] if j.get("bridge"))
    assert len(bridges) == stored, f"bridges.jsonl holds {len(bridges)} rows, the archive marks {stored}"

    # The per-region files, which were verified by counting them. 114 files was
    # the whole check, so every one could have been emptied, renamed or filled
    # with wrong security values and the verifier would have passed. These are
    # what the region view loads.
    region_files = list(REGION_DIR.glob("*.json"))
    assert len(region_files) == len(regions), f"{len(region_files)} region files, expected {len(regions)}"
    expected_names = {
        str(region["name"]).replace(" ", "_").replace("/", "_") + ".json": str(rid)
        for rid, region in regions.items()
    }
    actual_names = {path.name for path in region_files}
    assert actual_names == set(expected_names), (
        "region file names do not match the archive's regions: "
        f"unexpected {sorted(actual_names - set(expected_names))}, "
        f"missing {sorted(set(expected_names) - actual_names)}"
    )
    members_by_region = {}
    for sid, system in systems.items():
        members_by_region.setdefault(str(system["region_id"]), set()).add(sid)
    for path in region_files:
        region_id = expected_names[path.name]
        payload = json.loads(path.read_text(encoding="utf-8"))
        assert str(payload["region"]["region_id"]) == region_id, f"{path.name} carries the wrong region id"
        members = members_by_region.get(region_id, set())
        assert set(payload["systems"]) == members, f"{path.name} does not hold its region's systems"
        for sid, system in payload["systems"].items():
            source = systems[sid]
            assert system["name"] == source["name"], f"{path.name}: {sid} name disagrees with the archive"
            assert system["security"] == source["security"], f"{path.name}: {source['name']} security disagrees"
            assert system["neighbors"] == source["neighbors"], f"{path.name}: {source['name']} neighbours disagree"
            assert system["metrics"] == source["metrics"], f"{path.name}: {source['name']} metrics disagree"
            assert system["position"] == source["position"], f"{path.name}: {source['name']} position disagrees"
        intra = {
            (j["from_system_id"], j["to_system_id"]) for j in jumps
            if str(j["from_system_id"]) in members and str(j["to_system_id"]) in members
        }
        assert {(j["from_system_id"], j["to_system_id"]) for j in payload["jumps"]} == intra, (
            f"{path.name} does not hold its region's internal stargate links"
        )

    # data/regions.json is fetched by web/data-service.js on every load, and was
    # not verified anywhere at all.
    summary = json.loads((DATA_DIR / "regions.json").read_text(encoding="utf-8"))
    assert len(summary) == len(regions), f"data/regions.json lists {len(summary)} regions, expected {len(regions)}"
    for entry in summary:
        source = regions[str(entry["region_id"])]
        assert entry["name"] == source["name"], f"data/regions.json name disagrees for {entry['region_id']}"
        assert entry["system_count"] == source["system_count"], (
            f"data/regions.json system count disagrees for {entry['name']}"
        )
        assert entry["constellation_count"] == len(source["constellation_ids"]), (
            f"data/regions.json constellation count disagrees for {entry['name']}"
        )

    return f"{len(ai_systems)} system rows, {len(chokepoints)} chokepoints, {len(bridges)} bridges, {len(region_files)} region files"


@records
def verify_graph_metrics(systems, jumps) -> str:
    """Check the stored graph metrics against the topology itself."""
    adjacency = {
        int(sid): [int(n) for n in system["neighbors"]]
        for sid, system in systems.items()
        if system["neighbors"]
    }

    for sid, system in systems.items():
        metrics = system.get("metrics")
        assert metrics is not None, f"{sid} has no metrics block"
        for field in ("degree", "betweenness", "articulation", "component", "component_size"):
            assert field in metrics, f"{sid} metrics lack {field}"

        assert metrics["degree"] == len(system["neighbors"]), (
            f"{sid} degree {metrics['degree']} does not match {len(system['neighbors'])} neighbors"
        )
        assert metrics["betweenness"] >= 0, f"{sid} has negative betweenness"

        if not system["neighbors"]:
            assert metrics["component"] == -1, f"{sid} has no gates but claims a component"
            assert metrics["betweenness"] == 0, f"{sid} has no gates but non-zero betweenness"
        else:
            # A system with a single gate lies on no shortest path between two
            # other systems, so its betweenness must be exactly zero.
            if metrics["degree"] == 1:
                assert metrics["betweenness"] == 0, f"{sid} is a leaf with betweenness {metrics['betweenness']}"

    # Components, re-derived.
    pieces = connected_pieces(adjacency)
    sizes_by_member = {}
    for size, members in pieces:
        for member in members:
            sizes_by_member[member] = size
    for sid in adjacency:
        stored = systems[str(sid)]["metrics"]["component_size"]
        assert stored == sizes_by_member[sid], (
            f"{sid} claims component size {stored}, independent traversal finds {sizes_by_member[sid]}"
        )
    grouped = {}
    for sid in adjacency:
        grouped.setdefault(systems[str(sid)]["metrics"]["component"], set()).add(sid)
    for _, members in pieces:
        assert members in grouped.values(), "stored component grouping does not match an independent traversal"

    # Recompute every metric from the stored adjacency and compare. Sampling
    # 3% of flags meant a handful of wrong ones passed unnoticed; this catches
    # a single altered flag anywhere in the archive.
    recomputed = graph_metrics.compute({int(sid): s for sid, s in systems.items()})
    for sid, stored_system in systems.items():
        fresh = recomputed["metrics"][int(sid)]
        stored_metrics = stored_system["metrics"]
        for field in ("degree", "articulation", "component_size"):
            assert stored_metrics[field] == fresh[field], (
                f"{stored_system['name']} {field} is {stored_metrics[field]}, recomputation gives {fresh[field]}"
            )
        assert abs(stored_metrics["betweenness"] - fresh["betweenness"]) < 0.01, (
            f"{stored_system['name']} betweenness is {stored_metrics['betweenness']}, "
            f"recomputation gives {fresh['betweenness']}"
        )

    stored_bridges = {tuple(sorted((int(j["from_system_id"]), int(j["to_system_id"])))) for j in jumps if j.get("bridge")}
    assert stored_bridges == recomputed["bridges"], (
        f"the archive marks {len(stored_bridges)} bridges, recomputation finds {len(recomputed['bridges'])}; "
        f"{len(stored_bridges ^ recomputed['bridges'])} differ"
    )

    # The recomputation above uses the same implementation that produced the
    # data, so it catches corruption but not a wrong algorithm. The removal
    # checks below are independent of it and catch the algorithm being wrong.
    rng = random.Random(20260917)
    bridges = [tuple(sorted((int(j["from_system_id"]), int(j["to_system_id"])))) for j in jumps if j.get("bridge")]
    non_bridges = [tuple(sorted((int(j["from_system_id"]), int(j["to_system_id"])))) for j in jumps if not j.get("bridge")]
    assert bridges, "no bridges were recorded"

    for edge in rng.sample(bridges, min(40, len(bridges))):
        assert not reachable(adjacency, edge[0], edge[1], skip_edge=edge), (
            f"{edge} is marked a bridge but its endpoints remain connected without it"
        )
    for edge in rng.sample(non_bridges, min(40, len(non_bridges))):
        assert reachable(adjacency, edge[0], edge[1], skip_edge=edge), (
            f"{edge} is not marked a bridge but removing it disconnects its endpoints"
        )

    articulation = [sid for sid in adjacency if systems[str(sid)]["metrics"]["articulation"]]
    ordinary = [
        sid for sid in adjacency
        if not systems[str(sid)]["metrics"]["articulation"] and systems[str(sid)]["metrics"]["degree"] >= 2
    ]
    assert articulation, "no articulation points were recorded"

    def splits(node):
        neighbors = [n for n in adjacency[node] if n in adjacency]
        first = neighbors[0]
        return any(not reachable(adjacency, first, other, skip_node=node) for other in neighbors[1:])

    for node in rng.sample(articulation, min(30, len(articulation))):
        assert splits(node), f"{node} is marked an articulation point but removing it splits nothing"
    for node in rng.sample(ordinary, min(30, len(ordinary))):
        assert not splits(node), f"{node} is not marked an articulation point but removing it splits its neighbours"

    return (
        f"{len(articulation)} articulation points, {len(bridges)} bridges, {len(pieces)} components, "
        "all recomputed"
    )


VALUE_SEPARATOR = b"\x1f"
RECORD_SEPARATOR = b"\x1e"


def canonical_value(value: object) -> bytes:
    """Render one stored value without asking SQLite to render it.

    This is the whole point of the function. A digest built on
    sqlite3.Connection.iterdump() looks like Python and builds its INSERT statements
    with SQLite's own quote() (CPython's sqlite3/dump.py). SQLite's
    float-to-text routine differs between library versions: for one real
    coordinate in this database, 3.50.4 writes -8.8510792599980576e+16 where
    Python writes -8.851079259998058e+16. With 8,489 of the dump's 16,789 lines
    carrying scientific-notation floats, a digest over that text is a function of
    the linked library and cannot compare two machines - which is its one job.

    float.hex() is the exact binary value: no rounding and no shortest-roundtrip
    heuristic, so it is identical everywhere. The type tag keeps a value of one
    type from colliding with the rendering of another.
    """
    if value is None:
        return b"N"
    if isinstance(value, int):
        return b"I" + str(value).encode("utf-8")
    if isinstance(value, float):
        return b"F" + float.hex(value).encode("ascii")
    if isinstance(value, bytes):
        return b"B" + value.hex().encode("ascii")
    return b"S" + str(value).encode("utf-8")


def database_content_digest(db_path: Path) -> str:
    """Return a digest of the database's logical content.

    The file bytes are NOT comparable across machines. SQLite stamps the writing
    library's version into the header at offset 96 and page layout follows it, so
    3.45.1 and 3.50.4 write the same rows into files differing in ~91,000 bytes.
    No pragma or VACUUM suppresses the stamp, so byte-equality across library
    versions is not achievable and must never be used to decide two copies agree.

    This digest is independent of all three things that vary: the library version
    (nothing is rendered by SQLite - see canonical_value), the page layout
    (content only), and storage order (every read is ORDER BY the full column
    list).
    """
    connection = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        digest = hashlib.sha256()
        schema = connection.execute(
            'SELECT "type", "name", "sql" FROM "sqlite_master" '
            'WHERE "sql" IS NOT NULL ORDER BY "type", "name"'
        )
        for row_type, name, sql in schema:
            digest.update(
                b"SCHEMA" + VALUE_SEPARATOR + row_type.encode("utf-8")
                + VALUE_SEPARATOR + name.encode("utf-8")
                + VALUE_SEPARATOR + sql.encode("utf-8") + RECORD_SEPARATOR
            )
        tables = [
            row[0]
            for row in connection.execute(
                'SELECT "name" FROM "sqlite_master" WHERE "type" = \'table\' '
                'AND "name" NOT LIKE \'sqlite_%\' ORDER BY "name"'
            )
        ]
        for table in tables:
            columns = [row[1] for row in connection.execute(f'PRAGMA table_info("{table}")')]
            ordering = ",".join(f'"{column}"' for column in columns)
            digest.update(b"TABLE" + VALUE_SEPARATOR + table.encode("utf-8") + RECORD_SEPARATOR)
            for row in connection.execute(f'SELECT {ordering} FROM "{table}" ORDER BY {ordering}'):
                for value in row:
                    digest.update(canonical_value(value) + VALUE_SEPARATOR)
                digest.update(RECORD_SEPARATOR)
        return digest.hexdigest()
    finally:
        connection.close()


def assert_digest_is_not_vacuous(db_path: Path, observed: str) -> None:
    """Prove the digest reads the data, by perturbing one value of 16,777.

    A digest that cannot fail is the same trap as a test that cannot fail, and
    "it hashes something" is not evidence that it hashes this. Runs on a scratch
    copy and costs about a tenth of a second.
    """
    with tempfile.TemporaryDirectory() as scratch:
        probe = Path(scratch) / "digest_probe.sqlite"
        shutil.copyfile(db_path, probe)
        connection = sqlite3.connect(probe)
        try:
            target = connection.execute(
                'SELECT "system_id" FROM "systems" ORDER BY "system_id" LIMIT 1'
            ).fetchone()[0]
            connection.execute(
                'UPDATE "systems" SET "security" = "security" + 1e-7 WHERE "system_id" = ?',
                (target,),
            )
            connection.commit()
        finally:
            connection.close()
        perturbed = database_content_digest(probe)
    assert perturbed != observed, (
        "the content digest did not change when one stored value did, "
        "so it is not reading the database"
    )


def sde_name(value):
    """The SDE's localised-name shape, read the way the builder reads it.

    Deliberately a second implementation of `build_offline_map.en`. Importing the
    builder's would make a builder bug invisible, which is the entire class of
    fault this function exists to catch.
    """
    if isinstance(value, dict):
        return value.get("en") or next(iter(value.values()), "")
    return value


# The pinned scale of New Eden, checked on both sides of the comparison.
#
# **What a pin can and cannot do.** A pin only speaks when the data changes, and the
# data is right - so hollowing one of these assertions is invisible, which is why
# `assert_scale_is_not_vacuous` proves the assertion reads its argument. What no run
# over a correct archive can check is whether the *figure* is the right one; that is
# what a pin is, and re-pinning is meant to be the moment somebody stops and looks.
# The comparison against the SDE is what protects the archive. These name the drift in
# one line first.
SCALE = {
    "systems": EXPECTED_SYSTEMS,
    "regions": EXPECTED_REGIONS,
    "constellations": EXPECTED_CONSTELLATIONS,
    "stargates": EXPECTED_STARGATES,
    "stargate links": EXPECTED_JUMP_EDGES,
}


# Which sides were actually held to the pins. Same argument as `PERFORMED` one
# level down: removing the archive-side call was silent, because a pin over
# correct data says nothing either way and nothing recorded that it had been
# asked. A check nobody calls is indistinguishable from a check that passed.
SCALED: set[str] = set()

REQUIRED_SCALE_SIDES = frozenset({"the SDE", "the archive"})


def check_scale(counted: dict, where: str) -> None:
    """Hold whatever was counted against the pins, naming which side was counted."""
    SCALED.add(where)
    for what, expected in SCALE.items():
        if what not in counted:
            continue
        assert counted[what] == expected, (
            f"{where} carries {counted[what]} {what}, expected {expected}. "
            f"If this follows an intended SDE update, re-pin it deliberately."
        )


def assert_scale_is_not_vacuous() -> int:
    """Prove each pin reads its argument, by handing it one fewer of everything."""
    for what, expected in SCALE.items():
        try:
            check_scale({what: expected - 1}, "a probe")
        except AssertionError:
            continue
        raise AssertionError(
            f"the scale check accepted a wrong {what} count, so that pin reads nothing"
        )
    return len(SCALE)


def read_sde_topology() -> dict:
    """The universe as the SDE states it: systems, links, regions, constellations.

    Read once. The comparison below is handed the result rather than reading it
    itself, so the vacuity probes can run against the same truth without opening
    a 99 MB zip five more times.
    """
    published = {}
    edges = set()
    stargates = 0
    regions = {}
    constellations = {}
    with zipfile.ZipFile(ZIP_PATH) as archive:
        for record in read_jsonl(archive, "mapSolarSystems.jsonl"):
            position = record.get("position") or {}
            published[int(record["_key"])] = {
                "name": sde_name(record.get("name")),
                "region_id": int(record["regionID"]),
                "constellation_id": int(record["constellationID"]),
                "security": float(record.get("securityStatus", record.get("security", 0.0))),
                "position": (
                    float(position.get("x", 0.0)),
                    float(position.get("y", 0.0)),
                    float(position.get("z", 0.0)),
                ),
            }
        for record in read_jsonl(archive, "mapStargates.jsonl"):
            stargates += 1
            here = int(record["solarSystemID"])
            there = int(record["destination"]["solarSystemID"])
            assert here != there, f"stargate {record['_key']} joins {here} to itself"
            edges.add(tuple(sorted((here, there))))
        for record in read_jsonl(archive, "mapRegions.jsonl"):
            regions[int(record["_key"])] = sde_name(record.get("name"))
        for record in read_jsonl(archive, "mapConstellations.jsonl"):
            constellations[int(record["_key"])] = (
                sde_name(record.get("name")),
                int(record["regionID"]),
            )

    # The counts first, so a wholesale loss is named as one rather than as
    # thousands of individual differences - and so that a *replaced* zip is
    # named here rather than turning every comparison below into a difference.
    check_scale({
        "systems": len(published),
        "regions": len(regions),
        "constellations": len(constellations),
        "stargates": stargates,
        "stargate links": len(edges),
    }, "the SDE")

    adjacency = {}
    for here, there in edges:
        adjacency.setdefault(here, set()).add(there)
        adjacency.setdefault(there, set()).add(here)

    return {
        "systems": published,
        "edges": edges,
        "stargates": stargates,
        "adjacency": adjacency,
        "regions": regions,
        "constellations": constellations,
    }


def compare_to_sde(truth, systems, jumps, regions, constellations) -> None:
    """The archive against the SDE, field by field. Raises on the first family that differs.

    Reported bounded, with a count and a handful of examples: 481 lines of output
    is not a fault report, and the count is the part that says what happened.
    """
    published = truth["systems"]
    exported = {int(key) for key in systems}
    missing = sorted(set(published) - exported)
    invented = sorted(exported - set(published))
    assert not missing, f"{len(missing)} systems are in the SDE and not in the archive: {missing[:5]}"
    assert not invented, f"{len(invented)} systems are in the archive and not in the SDE: {invented[:5]}"

    differences = []
    for system_id, expected in published.items():
        stored = systems[str(system_id)]
        for field in ("name", "region_id", "constellation_id", "security"):
            if type(expected[field])(stored[field]) != expected[field]:
                differences.append(
                    f"{system_id} {field}: archive {stored[field]!r}, SDE {expected[field]!r}"
                )
        if tuple(float(value) for value in stored["position"]) != expected["position"]:
            differences.append(
                f"{system_id} position: archive {tuple(stored['position'])}, SDE {expected['position']}"
            )
    assert not differences, (
        f"{len(differences)} system fields differ from the SDE: " + "; ".join(differences[:5])
    )

    stored_edges = {
        tuple(sorted((int(jump["from_system_id"]), int(jump["to_system_id"])))) for jump in jumps
    }
    dropped = sorted(truth["edges"] - stored_edges)
    added = sorted(stored_edges - truth["edges"])
    assert not dropped, (
        f"{len(dropped)} stargate links are in the SDE and not in the archive: {dropped[:5]}"
    )
    assert not added, (
        f"{len(added)} stargate links are in the archive and not in the SDE: {added[:5]}"
    )

    # Adjacency as well as the edge list, because a pilot routes on `neighbors`
    # and the two are written by different lines of the builder.
    wrong = []
    for system_id, expected in truth["adjacency"].items():
        stored = {int(value) for value in systems[str(system_id)]["neighbors"]}
        if stored != expected:
            wrong.append(f"{system_id}: archive {sorted(stored)}, SDE {sorted(expected)}")
    for system_id in set(published) - set(truth["adjacency"]):
        stored = systems[str(system_id)]["neighbors"]
        if stored:
            wrong.append(f"{system_id}: archive has {len(stored)} neighbours, the SDE gives it none")
    assert not wrong, (
        f"{len(wrong)} systems' neighbour lists differ from the SDE: " + "; ".join(wrong[:5])
    )

    for region_id, name in truth["regions"].items():
        stored = regions.get(str(region_id))
        assert stored is not None, f"region {region_id} is in the SDE and not in the archive"
        assert stored["name"] == name, f"region {region_id} is {stored['name']!r}, the SDE says {name!r}"
    assert len(regions) == len(truth["regions"]), "the archive holds a region the SDE does not"

    for constellation_id, (name, region_id) in truth["constellations"].items():
        stored = constellations.get(str(constellation_id))
        assert stored is not None, f"constellation {constellation_id} is in the SDE and not in the archive"
        assert stored["name"] == name, (
            f"constellation {constellation_id} is {stored['name']!r}, the SDE says {name!r}"
        )
        assert int(stored["region_id"]) == region_id, (
            f"constellation {name} sits in region {stored['region_id']}, the SDE says {region_id}"
        )
    assert len(constellations) == len(truth["constellations"]), (
        "the archive holds a constellation the SDE does not"
    )


def assert_sde_comparison_is_not_vacuous(truth, systems, jumps, regions, constellations) -> int:
    """Prove the comparison reads what it claims to, one probe per family of claim.

    `assert_digest_is_not_vacuous` makes this argument about the digest, and it
    applies here with more force: this comparison is the only thing in the file
    that can tell a correct archive from a coherent wrong one, and a comparison
    that cannot fail is the same trap as a test that cannot fail. Five probes,
    because a single one leaves four families able to be quietly hollow - which
    is how `EXPECTED_DB_DIGEST` spent its first life being computed, proved
    sensitive, and compared against nothing.

    Each probe is a shallow copy with one value replaced. Costs no zip read and
    about a tenth of a second.
    """
    victim = next(iter(sorted(truth["systems"])))
    # A system the victim is genuinely not joined to, so an invented link is one
    # the SDE cannot contain. Found rather than written down: a hard-coded pair
    # would become a real link the day CCP builds a gate between them, and the
    # probe would then pass by agreeing with the archive.
    stranger = next(
        other for other in sorted(truth["systems"])
        if other != victim and other not in truth["adjacency"].get(victim, set())
    )
    probes = [
        (
            "a changed field",
            {**systems, str(victim): {**systems[str(victim)], "security": -99.0}},
            jumps, regions, constellations,
        ),
        (
            "a missing system",
            {key: value for key, value in systems.items() if key != str(victim)},
            jumps, regions, constellations,
        ),
        (
            "an invented system",
            {**systems, "39999999": {**systems[str(victim)], "system_id": 39999999, "neighbors": []}},
            jumps, regions, constellations,
        ),
        (
            "a changed position",
            {**systems, str(victim): {**systems[str(victim)], "position": [0.0, 0.0, 0.0]}},
            jumps, regions, constellations,
        ),
        (
            "a missing stargate link",
            systems, jumps[:-1], regions, constellations,
        ),
        (
            "an invented stargate link",
            systems,
            jumps + [{"from_system_id": victim, "to_system_id": stranger}],
            regions, constellations,
        ),
        (
            "an edited neighbour list",
            {**systems, str(victim): {**systems[str(victim)], "neighbors": []}},
            jumps, regions, constellations,
        ),
        (
            "a renamed region",
            systems, jumps,
            {
                **regions,
                next(iter(regions)): {**regions[next(iter(regions))], "name": "Not A Region"},
            },
            constellations,
        ),
    ]
    for label, probe_systems, probe_jumps, probe_regions, probe_constellations in probes:
        try:
            compare_to_sde(truth, probe_systems, probe_jumps, probe_regions, probe_constellations)
        except AssertionError:
            continue
        except Exception as error:                                      # noqa: BLE001
            # Reporting and crashing are not the same outcome. A `KeyError`
            # deeper in the comparison means an earlier clause stopped guarding
            # the one below it, which a bare `except` would have called success.
            raise AssertionError(
                f"the SDE comparison crashed rather than reported on an archive with {label}: "
                f"{type(error).__name__}: {error}"
            ) from error
        raise AssertionError(
            f"the SDE comparison accepted an archive with {label}, so that part of it reads nothing"
        )
    return len(probes)


@records
def verify_against_sde(systems, jumps, regions, constellations) -> str:
    """Every system and every stargate link, re-derived from the SDE and compared.

    **Everything else in this file checks the archive against itself.** JSON
    against SQLite, SQLite against the jsonl exports, neighbours against jumps,
    region counts against system counts - all of it thorough, and all of it blind
    to the same thing: an archive that is wrong and *coherent*. An audit deleted
    481 stargate links and rebuilt every derived file around them; every
    cross-check here passed, because they all agreed. Agreement is not
    correctness, and the only thing in this repository that knows what New Eden
    actually looks like is the zip.

    `EXPECTED_DB_DIGEST` is the closest thing that stood here before, and it is
    not a substitute: it fires on any change at all, so an intended SDE update
    and a bad rebuild look identical to it, and the instruction in that case is
    to re-pin. A re-pin after a bad rebuild blesses the corruption permanently.
    This is the one check whose answer does not depend on somebody deciding which
    kind of change they are looking at.

    Re-derived here rather than imported from the builder, which is also why
    `sde_name` is a second implementation of `build_offline_map.en`: a check that
    calls the code it is checking cannot fail.

    The 2D layout, the station counts and the factions are already compared
    against the zip in their own functions. This covers what was left - every
    system's identity, linkage, security and physical position, the adjacency
    itself, and the region and constellation names those systems are filed under.
    """
    truth = read_sde_topology()
    compare_to_sde(truth, systems, jumps, regions, constellations)
    probes = assert_sde_comparison_is_not_vacuous(truth, systems, jumps, regions, constellations)
    return (
        f"{len(truth['systems'])} systems, {len(truth['edges'])} stargate links from "
        f"{truth['stargates']} stargates, {len(truth['regions'])} regions and "
        f"{len(truth['constellations'])} constellations, every field re-derived from the SDE "
        f"and compared; {probes} probes prove the comparison is not vacuous"
    )



@records
def verify_npc_stations(systems) -> str:
    """Re-count the stations from the archive rather than trusting the export.

    Same rule as the 2D layout: the zip is the authority, and a derived count is
    only worth what its re-derivation says.
    """
    counted = Counter()
    with zipfile.ZipFile(ZIP_PATH) as archive:
        with archive.open("npcStations.jsonl") as handle:
            for line in handle:
                if not line.strip():
                    continue
                counted[int(json.loads(line)["solarSystemID"])] += 1

    total = sum(counted.values())
    assert total == EXPECTED_NPC_STATIONS, f"{total} NPC stations, expected {EXPECTED_NPC_STATIONS}"
    assert len(counted) == EXPECTED_SYSTEMS_WITH_STATIONS, (
        f"{len(counted)} systems carry a station, expected {EXPECTED_SYSTEMS_WITH_STATIONS}"
    )

    for key, system in systems.items():
        stored = system.get("npc_stations")
        assert isinstance(stored, int) and stored >= 0, f"{key} has a malformed npc_stations"
        assert stored == counted.get(int(key), 0), (
            f"system {key} records {stored} stations, the archive has {counted.get(int(key), 0)}"
        )
    return f"{total} NPC stations across {len(counted)} systems, recounted from the archive"


@records
def verify_factions(factions) -> str:
    """Re-read the factions from the zip. Same rule as the docking layer."""
    source = {}
    with zipfile.ZipFile(ZIP_PATH) as archive:
        with archive.open("factions.jsonl") as handle:
            for line in handle:
                if not line.strip():
                    continue
                row = json.loads(line)
                source[int(row["_key"])] = row

    assert len(factions) == EXPECTED_FACTIONS, f"{len(factions)} factions, expected {EXPECTED_FACTIONS}"
    assert len(source) == len(factions), (
        f"the archive holds {len(source)} factions, the export wrote {len(factions)}"
    )

    militia = 0
    for key, faction in factions.items():
        row = source.get(int(key))
        assert row is not None, f"faction {key} is not in the archive"
        name = row.get("name")
        expected_name = name.get("en") if isinstance(name, dict) else name
        assert faction["name"] == expected_name, (
            f"faction {key} is named {faction['name']!r}, the archive says {expected_name!r}"
        )
        stored = faction["militia_corporation_id"]
        actual = row.get("militiaCorporationID")
        assert stored == (int(actual) if actual else None), (
            f"faction {key} records militia {stored!r}, the archive says {actual!r}"
        )
        if stored:
            militia += 1

    assert militia == EXPECTED_MILITIA_FACTIONS, (
        f"{militia} factions carry a militia corporation, expected {EXPECTED_MILITIA_FACTIONS}"
    )
    return f"{len(factions)} factions, {militia} with a militia corporation, re-read from the archive"


@records
def verify_layout_2d(systems, regions, constellations, meta) -> str:
    """Check the official 2D layout against the archive it was read from.

    Two things matter here and they pull in opposite directions. The layout has
    to be exactly what CCP published, so it is re-read from the zip rather than
    trusted from the export. And it has to have changed nothing else: it is a
    display field, and every jump calculation in this project depends on the
    physical position staying exactly where it was.
    """
    layout = meta.get("layout_2d") or {}
    assert layout.get("schema_version") == LAYOUT_2D_SCHEMA_VERSION, (
        f"layout_2d schema version is {layout.get('schema_version')!r}, "
        f"expected {LAYOUT_2D_SCHEMA_VERSION}"
    )
    for field in ("source", "display_convention", "purpose", "fallback", "derived_levels"):
        assert layout.get(field), f"layout_2d is missing its {field} provenance"

    published = {}
    with zipfile.ZipFile(ZIP_PATH) as archive:
        with archive.open("mapSolarSystems.jsonl") as handle:
            for line in handle:
                if not line.strip():
                    continue
                record = json.loads(line)
                position = record.get("position2D")
                if isinstance(position, dict):
                    published[int(record["_key"])] = (float(position["x"]), float(position["y"]))

    assert len(published) == EXPECTED_SYSTEMS_WITH_LAYOUT_2D, (
        f"the archive publishes {len(published)} schematic positions, "
        f"expected {EXPECTED_SYSTEMS_WITH_LAYOUT_2D}"
    )

    exported = {}
    for key, system in systems.items():
        position = system.get("position_2d")
        if position is None:
            continue
        assert len(position) == 2, f"system {key} has a malformed position_2d"
        exported[int(key)] = (float(position[0]), float(position[1]))

    assert set(exported) == set(published), (
        f"{len(set(published) - set(exported))} published positions are missing from the export and "
        f"{len(set(exported) - set(published))} were invented"
    )
    for system_id, position in published.items():
        assert exported[system_id] == position, (
            f"system {system_id} exports {exported[system_id]} but the archive publishes {position}"
        )

    without = len(systems) - len(exported)
    assert layout.get("systems_with_layout") == len(exported), "layout_2d miscounts what it carries"
    assert layout.get("systems_without_layout") == without, "layout_2d miscounts what it lacks"

    # A null must stay a null. Writing (0, 0) for the 3,005 systems with no
    # published layout would stack every one of them on the origin of a real
    # coordinate space, which is a worse lie than admitting there is no answer.
    origin = [key for key, system in systems.items()
              if system.get("position_2d") is not None and tuple(system["position_2d"]) == (0.0, 0.0)]
    assert not origin, f"{len(origin)} systems were placed at the schematic origin instead of left null"

    # Derived levels must be the centre and extent of the members that have a
    # layout - not an invented upstream field, and not silently the whole set.
    derived = 0
    for group, member_key in ((constellations, "solar_system_ids"), (regions, "systems")):
        for entry in group.values():
            points = [tuple(systems[str(sid)]["position_2d"])
                      for sid in entry[member_key]
                      if str(sid) in systems and systems[str(sid)].get("position_2d") is not None]
            if not points:
                assert entry.get("position_2d") is None and entry.get("bounds_2d") is None, (
                    f"{entry.get('name')} has no member with a layout but carries one anyway"
                )
                continue
            xs = [p[0] for p in points]
            ys = [p[1] for p in points]
            bounds = (min(xs), min(ys), max(xs), max(ys))
            assert tuple(entry["bounds_2d"]) == bounds, f"{entry.get('name')} bounds_2d is not its members' extent"
            centre = ((bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2)
            assert tuple(entry["position_2d"]) == centre, f"{entry.get('name')} position_2d is not the centre of that extent"
            derived += 1

    return (
        f"{len(exported)} official positions matched to the archive, {without} left null, "
        f"{derived} derived region and constellation frames recomputed"
    )


def main() -> None:
    # Absent, and either named or refused.
    #
    # The archive is verified against the export because everything else here compares
    # the archive to its own other representations, which is thorough and blind to an
    # archive that is wrong and coherent. So an absent export is not a detail to shrug
    # at: it is most of the assurance, and the run says so out loud.
    without_sde = "--without-sde" in sys.argv[1:]
    if not ZIP_PATH.exists():
        if not without_sde:
            print(f"{ZIP_PATH} is not here, so the archive cannot be checked against CCP's export.")
            print(f"Fetch the JSONL Static Data Export from {SDE_SOURCE} and put it at that path,")
            print("or pass --without-sde to run only the four checks that do not need it.")
            raise SystemExit(1)
    elif without_sde:
        print(f"--without-sde was passed and {ZIP_PATH.name} is here; checking against it anyway.")
        without_sde = False

    atlas = json.loads(ATLAS_PATH.read_text(encoding="utf-8"))
    regions = atlas["regions"]
    constellations = atlas["constellations"]
    systems = atlas["systems"]
    jumps = atlas["jumps"]

    assert regions, "No regions were exported"
    assert constellations, "No constellations were exported"
    assert systems, "No systems were exported"
    assert jumps, "No stargate links were exported"

    edge_keys: set[tuple[int, int]] = set()
    for jump in jumps:
        source_id = int(jump["from_system_id"])
        destination_id = int(jump["to_system_id"])
        key = tuple(sorted((source_id, destination_id)))
        assert source_id != destination_id, f"Self-referencing jump: {source_id}"
        assert key not in edge_keys, f"Duplicate jump: {key}"
        assert str(source_id) in systems, f"Missing jump source: {source_id}"
        assert str(destination_id) in systems, f"Missing jump destination: {destination_id}"
        edge_keys.add(key)

    for system_id, system in systems.items():
        region_id = str(system["region_id"])
        constellation_id = str(system["constellation_id"])
        security = float(system["security"])
        assert region_id in regions, f"{system_id} references missing region {region_id}"
        assert constellation_id in constellations, f"{system_id} references missing constellation {constellation_id}"
        assert -1.0 <= security <= 1.0, f"{system_id} has invalid security {security}"

        for neighbor_id in system["neighbors"]:
            neighbor = systems.get(str(neighbor_id))
            assert neighbor is not None, f"{system_id} references missing neighbor {neighbor_id}"
            assert int(system_id) in neighbor["neighbors"], f"Asymmetric link: {system_id} -> {neighbor_id}"
            assert tuple(sorted((int(system_id), int(neighbor_id)))) in edge_keys, f"Neighbor lacks jump edge: {system_id} -> {neighbor_id}"

    # First, because everything after it compares the archive against itself.
    # A wrong archive that is coherent should be named as wrong rather than
    # surfacing as agreement.
    # The archive against the pins, before anything reads the export.
    #
    # It needs nothing from the zip, so it runs on a clone that has none - which is the
    # point: a rebuild that is wrong and self-consistent is named here in one line,
    # and this is the only check in a short run that can name it.
    check_scale({
        "systems": len(systems),
        "regions": len(regions),
        "constellations": len(constellations),
        "stargate links": len(jumps),
    }, "the archive")
    pins = assert_scale_is_not_vacuous()

    sde_summary = (
        "not checked - CCP's export is not in this clone"
        if without_sde
        else verify_against_sde(systems, jumps, regions, constellations)
    )
    verify_archive_values(systems, jumps)
    graph_summary = verify_graph_metrics(systems, jumps)
    ships_summary = "not checked" if without_sde else verify_ships()
    exports_summary = verify_derived_exports(systems, jumps, regions, constellations)
    hierarchy_summary = verify_hierarchy(systems, constellations, regions)
    layout_summary = ("not checked" if without_sde
                      else verify_layout_2d(systems, regions, constellations, atlas.get("meta", {})))
    station_summary = "not checked" if without_sde else verify_npc_stations(systems)
    faction_summary = "not checked" if without_sde else verify_factions(atlas["factions"])
    declared = atlas.get("meta", {}).get("schema_version")
    assert declared == ARCHIVE_SCHEMA_VERSION, (
        f"archive declares schema version {declared!r}, expected {ARCHIVE_SCHEMA_VERSION}"
    )

    listed_systems = sum(region["system_count"] for region in regions.values())
    assert listed_systems == len(systems), f"Region counts total {listed_systems}, expected {len(systems)}"

    connection = sqlite3.connect(DB_PATH)
    try:
        db_counts = {
            "regions": connection.execute("select count(*) from regions").fetchone()[0],
            "constellations": connection.execute("select count(*) from constellations").fetchone()[0],
            "systems": connection.execute("select count(*) from systems").fetchone()[0],
            "jumps": connection.execute("select count(*) from jumps").fetchone()[0],
            "factions": connection.execute("select count(*) from factions").fetchone()[0],
        }
        jita_security = connection.execute("select security from systems where name = 'Jita'").fetchone()
        db_metrics = connection.execute(
            "select system_id, degree, betweenness, articulation from systems order by betweenness desc limit 25"
        ).fetchall()
        db_bridges = connection.execute("select count(*) from jumps where bridge = 1").fetchone()[0]

        # Every column of every row, against the archive.
        #
        # What stood here was five row counts, Jita's security, and the top 25
        # systems by betweenness. A hostile sweep of thirty-four single-point
        # corruptions of data/ got thirty-one past this file, and most of them
        # were here: every security value outside Jita could be set to zero,
        # every coordinate zeroed, every system moved into one region, every
        # distance set to 99, Amarr renamed, and the verifier printed success.
        # Row counts survive almost every corruption that matters, because
        # almost nothing that goes wrong changes how many rows there are.
        db_systems = connection.execute(
            "select system_id, region_id, constellation_id, name, security, x, y, z, x2d, y2d,"
            " npc_stations, degree, betweenness, articulation, component, component_size from systems"
        ).fetchall()
        db_jumps = connection.execute(
            "select from_system_id, to_system_id, from_region_id, to_region_id, distance_ly, bridge from jumps"
        ).fetchall()
        db_regions = connection.execute(
            "select region_id, name, system_count, constellation_count from regions"
        ).fetchall()
        db_constellations = connection.execute(
            "select constellation_id, region_id, name from constellations"
        ).fetchall()
        db_factions = connection.execute(
            "select faction_id, name, militia_corporation_id, home_system_id from factions"
        ).fetchall()
    finally:
        connection.close()

    expected_counts = {
        "regions": len(regions),
        "constellations": len(constellations),
        "systems": len(systems),
        "jumps": len(jumps),
        "factions": len(atlas["factions"]),
    }
    assert db_counts == expected_counts, f"SQLite counts differ: {db_counts} != {expected_counts}"
    assert jita_security and jita_security[0] > 0.9, "Security-status extraction is incorrect"

    for system_id, degree, betweenness, articulation in db_metrics:
        metrics = systems[str(system_id)]["metrics"]
        assert metrics["degree"] == degree, f"SQLite degree differs for {system_id}"
        assert abs(metrics["betweenness"] - betweenness) < 1e-6, f"SQLite betweenness differs for {system_id}"
        assert metrics["articulation"] == bool(articulation), f"SQLite articulation differs for {system_id}"
    stored_bridges = sum(1 for j in jumps if j.get("bridge"))
    assert db_bridges == stored_bridges, f"SQLite records {db_bridges} bridges, JSON records {stored_bridges}"

    seen_db_systems = set()
    for (system_id, region_id, constellation_id, name, security, x, y, z, x2d, y2d,
         npc_stations, degree, betweenness, articulation, component, component_size) in db_systems:
        source = systems.get(str(system_id))
        assert source is not None, f"SQLite holds system {system_id}, which the archive does not"
        seen_db_systems.add(str(system_id))
        metrics = source["metrics"]
        layout = source.get("position_2d")
        assert name == source["name"], f"SQLite name differs for {system_id}"
        assert region_id == source["region_id"], f"SQLite region differs for {name}"
        assert constellation_id == source["constellation_id"], f"SQLite constellation differs for {name}"
        assert abs(security - source["security"]) < 1e-9, f"SQLite security differs for {name}"
        assert (x, y, z) == tuple(source["position"]), f"SQLite position differs for {name}"
        assert x2d == (layout[0] if layout else None), f"SQLite x2d differs for {name}"
        assert y2d == (layout[1] if layout else None), f"SQLite y2d differs for {name}"
        assert npc_stations == source["npc_stations"], f"SQLite station count differs for {name}"
        assert degree == metrics["degree"], f"SQLite degree differs for {name}"
        assert abs(betweenness - metrics["betweenness"]) < 1e-6, f"SQLite betweenness differs for {name}"
        assert bool(articulation) == bool(metrics["articulation"]), f"SQLite articulation differs for {name}"
        assert component == metrics["component"], f"SQLite component differs for {name}"
        assert component_size == metrics["component_size"], f"SQLite component size differs for {name}"
    assert seen_db_systems == set(systems), "SQLite and the archive do not hold the same systems"

    archive_edges = {(j["from_system_id"], j["to_system_id"]): j for j in jumps}
    seen_db_edges = set()
    for from_id, to_id, from_region, to_region, distance_ly, bridge in db_jumps:
        source = archive_edges.get((from_id, to_id))
        assert source is not None, f"SQLite holds stargate link {from_id}->{to_id}, which the archive does not"
        seen_db_edges.add((from_id, to_id))
        assert from_region == systems[str(from_id)]["region_id"], f"SQLite from_region differs for {from_id}->{to_id}"
        assert to_region == systems[str(to_id)]["region_id"], f"SQLite to_region differs for {from_id}->{to_id}"
        assert abs(distance_ly - source["distance_ly"]) < 1e-9, f"SQLite distance differs for {from_id}->{to_id}"
        assert bool(bridge) == bool(source.get("bridge")), f"SQLite bridge flag differs for {from_id}->{to_id}"
    assert seen_db_edges == set(archive_edges), "SQLite and the archive do not hold the same stargate links"

    for region_id, name, system_count, constellation_count in db_regions:
        source = regions.get(str(region_id))
        assert source is not None, f"SQLite holds region {region_id}, which the archive does not"
        assert name == source["name"], f"SQLite region name differs for {region_id}"
        assert system_count == source["system_count"], f"SQLite system count differs for {name}"
        assert constellation_count == len(source["constellation_ids"]), (
            f"SQLite constellation count differs for {name}"
        )

    for constellation_id, region_id, name in db_constellations:
        source = constellations.get(str(constellation_id))
        assert source is not None, f"SQLite holds constellation {constellation_id}, which the archive does not"
        assert name == source["name"], f"SQLite constellation name differs for {constellation_id}"
        assert region_id == source["region_id"], f"SQLite constellation region differs for {name}"

    archive_factions = {str(key): value for key, value in atlas["factions"].items()}
    for faction_id, name, militia, home in db_factions:
        source = archive_factions.get(str(faction_id))
        assert source is not None, f"SQLite holds faction {faction_id}, which the archive does not"
        assert name == source["name"], f"SQLite faction name differs for {faction_id}"
        assert militia == source.get("militia_corporation_id"), f"SQLite militia differs for {name}"
        assert home == source.get("home_system_id"), f"SQLite home system differs for {name}"

    print(
        "verified "
        f"{len(regions)} regions, {len(constellations)} constellations, "
        f"{len(systems)} systems, and {len(jumps)} stargate links"
    )
    print(f"verified against the SDE: {sde_summary}")
    print(f"pinned scale: {', '.join(sorted(SCALED))}; {pins} probes prove the pins are not vacuous")
    print(f"verified graph metrics: {graph_summary}")
    print(f"verified ship data: {ships_summary}")
    print(f"verified derived exports: {exports_summary}")
    print(f"verified hierarchy: {hierarchy_summary}")
    print(f"verified 2D layout: {layout_summary}")
    print(f"verified docking layer: {station_summary}")
    print(f"verified factions: {faction_summary}")
    content_digest = database_content_digest(DB_PATH)
    assert_digest_is_not_vacuous(DB_PATH, content_digest)
    # Pinned, not merely printed. The digest was computed, proved sensitive, and
    # then compared against nothing at all, so it could not fail a run - a
    # thorough-looking check that was decoration. Re-pin this deliberately when
    # the SDE changes, which is the moment it is supposed to make you stop.
    assert content_digest == EXPECTED_DB_DIGEST, (
        f"database content digest is {content_digest}, expected {EXPECTED_DB_DIGEST}. "
        "If this follows an intended SDE update, re-pin EXPECTED_DB_DIGEST deliberately."
    )
    print(f"database content digest: {content_digest}")

    # Last, so it is the final word on the run: every check this file defines was
    # reached. Not a style rule - a check nobody calls is indistinguishable from a
    # check that passed, and that is precisely how 481 missing stargate links got
    # through the gate.
    # Superset rather than equality: the vacuity probe legitimately adds its own
    # label, and pinning that would make the probe's name part of the contract.
    sides = {"the archive"} if without_sde else REQUIRED_SCALE_SIDES
    assert sides <= SCALED, (
        "these sides were never held to the pinned scale: "
        f"{sorted(sides - SCALED)}"
    )
    expected = EXPECTED_CHECKS - NEEDS_SDE if without_sde else EXPECTED_CHECKS
    assert PERFORMED == expected, (
        "these checks were defined and never reached: "
        f"{sorted(expected - PERFORMED)}; and these ran unlisted: "
        f"{sorted(PERFORMED - expected)}"
    )
    if without_sde:
        print(
            f"{len(expected)} of {len(EXPECTED_CHECKS)} checks were reached; "
            f"{len(NEEDS_SDE)} need CCP's export and did not run: {', '.join(sorted(NEEDS_SDE))}"
        )
    else:
        print(f"all {len(EXPECTED_CHECKS)} checks were reached")


if __name__ == "__main__":
    main()
