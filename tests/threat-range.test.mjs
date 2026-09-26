// "Standing here, what can drop on me."
//
// Pure arithmetic off the archive, so it can be checked exactly. What these
// tests mostly guard is the direction of every assumption: a threat model that
// draws a smaller envelope than reality is worse than no model, so max skills,
// live staging and no jammers are all assumed, and each of those is asserted
// rather than left to the comment that explains it.

import { readArchive, readShips, suite } from "./helpers.mjs";
import { JumpPlanner, skillMultiplier } from "../web/jump-planner.js";
import { HIGH_SECURITY } from "../web/map-utils.js";
import { describeThreat, threatClasses, threatEnvelope, threatsTo } from "../web/threat-range.js";

export default function run() {
  const t = suite("threat range");
  const atlas = readArchive();
  const shipData = readShips();
  const planner = new JumpPlanner(atlas, shipData);
  const id = name => planner.resolveSystem(name).system_id;

  // --- the classes ------------------------------------------------------------
  const classes = threatClasses(shipData);
  t.check(classes.length >= 8, `${classes.length} jump-capable hull classes are derived from the archive`);
  t.check(classes.every(entry => entry.rangeLy > 0), "each has a range");
  // **Combat hulls first, and only then by reach.** This asserted reach alone,
  // and passed while the overlay headlined a mining ship: the two longest
  // reaches in New Eden belong to a Rorqual and a jump freighter at 5 ly base,
  // against a titan's 3, so every threat list opened with a hauler and closed
  // with the titan, tenth of ten.
  const logistics = classes.filter(entry => entry.combat === false).map(entry => entry.group);
  t.equal(logistics.length, 2, "two of the jump-capable groups cannot shoot back");
  t.check(logistics.includes("Capital Industrial Ship") && logistics.includes("Jump Freighter"),
    `and they are the two that carry rather than kill (${logistics.join(", ")})`);
  // Named groups go stale silently if the SDE renames one - the set would match
  // nothing, every class would read as combat, and the ordering would quietly
  // revert to what it was. The two assertions above are what catches that, so
  // they are checked against the data rather than against the constant.
  t.check(classes.some(entry => entry.representative === "Rorqual"),
    "the group names are the ones the ship data actually uses");

  const firstLogistics = classes.findIndex(entry => entry.combat === false);
  t.check(classes.slice(firstLogistics).every(entry => entry.combat === false),
    "every combat hull is listed before the first hauler");
  t.check(classes.slice(0, firstLogistics)
      .every((entry, index) => index === 0 || entry.rangeLy <= classes[index - 1].rangeLy),
    "and within the combat hulls it is still longest reach first - the class you find out about last");
  t.check(classes[0].group === "Black Ops" || classes[0].rangeLy <= 8.01,
    `the list now opens with a hull that shoots back (${classes[0].group})`);

  // Ranges are the SDE's, doubled by Jump Drive Calibration V. Written out so a
  // change in either the data or the skill maths shows here rather than only in
  // a drawn overlay.
  const byGroup = new Map(classes.map(entry => [entry.group, entry]));
  const doubling = skillMultiplier(shipData.skills["Jump Drive Calibration"].range_bonus_per_level, 5);
  t.equal(doubling, 2, "Jump Drive Calibration V doubles jump range");
  t.equal(byGroup.get("Black Ops").rangeLy, 8, "black ops reach 8 ly at max skill");
  t.equal(byGroup.get("Lancer Dreadnought").rangeLy, 8, "and so do lancer dreadnoughts");
  t.equal(byGroup.get("Dreadnought").rangeLy, 7, "dreadnoughts reach 7");
  t.equal(byGroup.get("Titan").rangeLy, 6, "and titans 6, which is shorter than people expect");
  t.check(byGroup.get("Titan").rangeLy < byGroup.get("Black Ops").rangeLy,
    "a black ops out-reaches a titan, which is exactly why the classes are not merged");

  // Max skills is the pessimistic assumption and must be the default.
  const timid = threatClasses(shipData, { calibration: 1 });
  t.check(timid.find(entry => entry.group === "Titan").rangeLy < byGroup.get("Titan").rangeLy,
    "a lower skill level draws a smaller envelope");
  t.equal(threatClasses(shipData)[0].rangeLy, threatClasses(shipData, { calibration: 5 })[0].rangeLy,
    "so the default is level five, not something kinder");

  // Every group in the archive happens to have one range today, so "first in
  // the group" and "longest in the group" pick the same hull and the choice
  // cannot be tested against real data. A group that stops being uniform is
  // exactly when it matters, so one is built.
  const mixed = threatClasses({
    ships: [
      { name: "Short", group: "Mixed", base_range_ly: 3 },
      { name: "Long", group: "Mixed", base_range_ly: 6 },
    ],
    skills: shipData.skills,
  });
  t.equal(mixed[0].representative, "Long", "a group with differing ranges is represented by its longest hull");
  t.equal(mixed[0].rangeLy, 12, "so the envelope covers the worst case rather than the first one listed");
  t.check(!mixed[0].uniform, "and the group is flagged as not uniform");
  t.check(byGroup.get("Titan").uniform, "while the real groups are uniform today");

  t.equal(threatClasses(null).length, 0, "missing ship data yields no classes rather than throwing");
  t.equal(threatClasses({ ships: [] }).length, 0, "and neither does an empty list");

  // --- the envelope -------------------------------------------------------------
  const staging = [id("1DQ1-A"), id("T5ZI-S")];
  const envelopes = threatEnvelope(planner, staging, classes);
  t.equal(envelopes.length, classes.length, "one envelope per class");

  const titan = envelopes.find(entry => entry.group === "Titan");
  const blops = envelopes.find(entry => entry.group === "Black Ops");
  t.check(blops.systemIds.size > titan.systemIds.size,
    `the longer-reaching class covers more (${blops.systemIds.size} against ${titan.systemIds.size})`);
  t.check([...titan.systemIds].every(system => blops.systemIds.has(system)),
    "and covers everything the shorter one does, since the staging is the same");

  // Capitals cannot jump into high security, so no capital envelope may contain
  // any. This is a rule rather than an assumption.
  //
  // Staged from Amamake rather than Delve, and that matters: from 1DQ1-A there
  // is no high-security system within 8 ly at all, so the assertion held
  // whatever the rule did. The first version of this test was staged there and
  // passed happily with high security allowed. From Amamake the flag changes
  // the answer from 103 systems to 398.
  const nearHighSec = threatEnvelope(planner, [id("Amamake")], classes);
  for (const envelope of nearHighSec) {
    const highSec = [...envelope.systemIds].filter(sid => atlas.systems[String(sid)].security >= HIGH_SECURITY);
    t.equal(highSec.length, 0, `${envelope.group}: no high-security system is inside the envelope`);
  }
  // The exclusion is doing real work here, measured against the planner's own
  // permissive range set rather than against an option on this function. There
  // is no such option any more: it was wired to a checkbox whose stated reason
  // was that "black ops bridging changes it", and it does not - a covert
  // cynosural field is barred from high security exactly as an ordinary one is,
  // so nothing a jump drive can do puts a high-security system in reach. With
  // the box ticked, a titan staged in Tama covered 133 systems of which 81 were
  // high security, while `planner.plan` refused every one of them by name.
  const widest = classes[0];
  const permissive = planner.rangeSet(id("Amamake"), widest.rangeLy, { allowHighSec: true });
  t.check(permissive.systemIds.size > nearHighSec[0].systemIds.size,
    "and the exclusion is doing real work here - high security would widen the envelope if allowed");
  // Asserted as a property of the result, not of the signature. The first
  // version of this checked `threatEnvelope.length === 3`, which is dead:
  // `Function.length` stops counting at the first parameter with a default, so
  // it reads 3 whether the options argument is there or not, and putting the
  // option back was the one mutation of nine that nothing caught.
  const forced = threatEnvelope(planner, [id("Amamake")], classes, { allowHighSec: true });
  t.equal(forced[0].systemIds.size, nearHighSec[0].systemIds.size,
    "and an argument asking for high security cannot widen an envelope, whatever it is called");
  t.equal([...forced[0].systemIds].filter(sid => atlas.systems[String(sid)].security >= HIGH_SECURITY).length, 0,
    "because nothing reads it");

  for (const envelope of envelopes) {
    const highSec = [...envelope.systemIds].filter(sid => atlas.systems[String(sid)].security >= HIGH_SECURITY);
    t.equal(highSec.length, 0, `${envelope.group}: the Delve envelope contains no high security either`);
  }

  // Every system in an envelope is genuinely within range of the source it names.
  for (const envelope of [titan, blops]) {
    const wrong = [...envelope.reachable.values()].filter(hit => hit.distanceLy > envelope.rangeLy + 1e-9);
    t.equal(wrong.length, 0, `${envelope.group}: nothing in the envelope is beyond its range`);
    const mismatched = [...envelope.reachable.values()]
      .filter(hit => !hit.isStaging && !staging.includes(hit.fromId));
    t.equal(mismatched.length, 0, `${envelope.group}: every entry names one of the staging systems as its source`);
  }

  // The staging systems are in their own envelopes. rangeSet excludes its own
  // origin, which is right for a jump planner and wrong here: reporting
  // "nothing reaches this" for the system they stage from would be the worst
  // answer this overlay could give.
  for (const envelope of envelopes) {
    for (const originId of staging) {
      t.check(envelope.systemIds.has(originId), `${envelope.group}: the staging system is inside its own envelope`);
      t.equal(envelope.reachable.get(originId).distanceLy, 0, "at zero distance");
      t.check(envelope.reachable.get(originId).isStaging, "and marked as staging rather than as a reachable target");
    }
  }

  // With two staging systems, a target names the nearer one.
  const shared = [...blops.reachable.values()].find(hit => !hit.isStaging);
  const alternatives = staging.map(originId => {
    const set = planner.rangeSet(originId, blops.rangeLy, { allowHighSec: false });
    return set.entries.find(entry => entry.system.system_id === shared.system.system_id)?.distanceLy ?? Infinity;
  });
  t.check(Math.abs(shared.distanceLy - Math.min(...alternatives)) < 1e-9,
    "a system reachable from both staging systems records the nearer one");

  // --- the inverse ----------------------------------------------------------------
  const nearby = threatsTo(envelopes, id("319-3D"));
  t.check(nearby.length > 0, "a system next to the staging is threatened");
  t.check(nearby.every(entry => entry.distanceLy <= entry.rangeLy + 1e-9), "by classes that can actually reach it");
  const firstHauler = nearby.findIndex(entry => entry.combat === false);
  const combatOnly = firstHauler === -1 ? nearby : nearby.slice(0, firstHauler);
  t.check(firstHauler === -1 || nearby.slice(firstHauler).every(entry => entry.combat === false),
    "listed combat hulls first, then the haulers");
  t.check(combatOnly.every((entry, index) => index === 0 || entry.rangeLy <= combatOnly[index - 1].rangeLy),
    "and longest reach first inside each");
  t.check(nearby[0].combat !== false,
    `so the first thing an FC reads can kill them (${nearby[0].group})`);
  t.check(nearby.every(entry => Boolean(entry.fromSystem?.name)), "each naming where it would come from");

  t.equal(threatsTo(envelopes, id("Jita")).length, 0, "high security is threatened by nothing here");
  t.check(/No jump-capable hull reaches/.test(describeThreat([])), "and says so plainly");

  const atStaging = threatsTo(envelopes, id("1DQ1-A"));
  t.check(atStaging.length > 0, "the staging system reports threats");
  t.check(/staging system/i.test(describeThreat(atStaging)),
    "and is described as the staging rather than as somewhere something has to reach");

  t.check(/reaches this system/.test(describeThreat(nearby)), "a threatened system is described as reached");
  t.check(/ly\)/.test(describeThreat(nearby)), "with the distance and the range it fits inside");

  // --- degenerate input --------------------------------------------------------------
  t.equal(threatEnvelope(planner, [], classes)[0].systemIds.size, 0, "no staging means no envelope");
  t.equal(threatEnvelope(planner, null, classes)[0].systemIds.size, 0, "and neither does missing staging");
  t.equal(threatEnvelope(planner, [999999999], classes)[0].systemIds.size, 0,
    "a staging system that does not exist is dropped rather than throwing");
  const duplicated = threatEnvelope(planner, [staging[0], staging[0]], classes);
  t.equal(duplicated.find(entry => entry.group === "Titan").staging.length, 1,
    "the same staging system listed twice is counted once");

  return t.results;
}
