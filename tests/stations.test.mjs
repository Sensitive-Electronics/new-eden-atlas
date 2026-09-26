// The docking layer.
//
// Entirely static: 5,210 NPC stations across 1,754 systems, straight out of the
// Static Data Export with no API and no authentication. "Where can I safe up
// along this route" is a routing question and the answer was already sitting in
// the archive.
//
// The one thing these tests exist to protect is the asymmetry. A count above
// zero means an NPC station is there. A count of zero means no NPC station -
// it does NOT mean docking is impossible, because player structures are not in
// the export and cannot be enumerated without access. A layer that quietly
// turns "no NPC station" into "nowhere to dock" will strand somebody.

import { readArchive, readRegion, suite } from "./helpers.mjs";
import { RoutePlanner } from "../web/route-planner.js";
import { HIGH_SECURITY } from "../web/map-utils.js";

export default function run() {
  const t = suite("stations");
  const atlas = readArchive();
  const systems = Object.values(atlas.systems);

  // --- the data ---------------------------------------------------------------
  const withStations = systems.filter(system => system.npc_stations > 0);
  const total = systems.reduce((sum, system) => sum + system.npc_stations, 0);
  t.equal(withStations.length, 1754, "1,754 systems carry at least one NPC station");
  t.equal(total, 5210, "and there are 5,210 of them in total");
  t.check(systems.every(system => Number.isInteger(system.npc_stations) && system.npc_stations >= 0),
    "every system carries a whole, non-negative count");
  t.equal(systems.filter(system => system.npc_stations === 0).length, 6736,
    "6,736 systems have none - which is a statement about NPC stations, not about docking");

  // The provenance block has to carry the caveat, because the number alone
  // invites exactly the wrong reading.
  const meta = atlas.meta.npc_stations;
  t.check(Boolean(meta), "the archive documents where the count came from");
  t.check(/npcStations\.jsonl/.test(meta.source), "naming the file");
  t.check(/not that docking is impossible/i.test(meta.meaning),
    "and stating plainly that zero does not mean nowhere to dock");
  t.check(/player structures/i.test(meta.meaning), "because player structures are not in the export");

  // Distribution sanity: high security should be the best served, and null the
  // worst, or the count has been attached to the wrong systems.
  const byClass = { high: 0, low: 0, null: 0 };
  for (const system of withStations) {
    byClass[system.security >= HIGH_SECURITY ? "high" : system.security > 0 ? "low" : "null"] += 1;
  }
  t.check(byClass.high > byClass.low && byClass.low > byClass.null,
    `stations thin out as security falls (${byClass.high} high, ${byClass.low} low, ${byClass.null} null)`);

  // Known ground truth, so a shifted join would show.
  const jita = systems.find(system => system.name === "Jita");
  t.equal(jita.npc_stations, 18, "Jita has eighteen NPC stations");
  // Zarzakh does have one, station 60015187, which is worth pinning because the
  // first version of this test assumed it had none and was wrong - the kind of
  // assumption that would otherwise have been written into the interface.
  const zarzakh = systems.find(system => system.name === "Zarzakh");
  t.equal(zarzakh.npc_stations, 1, "and Zarzakh, unexpectedly, has exactly one");
  t.equal(systems.find(system => system.name === "LZ-6SU").npc_stations, 0,
    "while a plain null-security system has none");

  // --- it reaches the region files too ------------------------------------------
  const forge = Object.values(readRegion("The Forge").systems);
  t.check(forge.every(system => Number.isInteger(system.npc_stations)),
    "region files carry the count as well, so a regional view need not load the whole archive");
  t.equal(forge.find(system => system.name === "Jita").npc_stations, jita.npc_stations,
    "and agree with the master archive");

  // --- routing -------------------------------------------------------------------
  const planner = new RoutePlanner(atlas);
  const route = planner.calculate("Jita", "1DQ1-A", "shortest");
  t.check(route.withStation.length > 0, "a long route lists the systems with an NPC station");
  t.check(route.withStation.length < route.systems.length, "and it is not all of them");
  t.check(route.withStation.every(system => system.npc_stations > 0),
    "every system listed really has one");
  t.check(route.systems.filter(system => system.npc_stations > 0).length === route.withStation.length,
    "and none with one is left out");

  const local = planner.calculate("Jita", "Perimeter", "shortest");
  t.equal(local.withStation.length, local.systems.length,
    "a short high-security hop has a station at every step");

  // The gap is the tactical fact: how far you can be from anywhere to dock.
  let run = 0;
  let longest = 0;
  for (const system of route.systems) {
    run = system.npc_stations > 0 ? 0 : run + 1;
    longest = Math.max(longest, run);
  }
  t.check(longest > 5, `the Jita to 1DQ1-A route has a run of ${longest} systems with no NPC station`);

  return t.results;
}
