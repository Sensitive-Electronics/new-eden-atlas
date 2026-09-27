// "Standing here, what can drop on me."
//
// Given systems a hostile force stages from, this paints how far each class of
// jump-capable hull reaches. It is the question every FC asks before committing
// to a fight, and it is pure arithmetic off the archive - jump ranges from the
// SDE, distances from the physical coordinates, no API and no authentication.
//
// Three things it assumes, all deliberately pessimistic, because a threat model
// that flatters you is worse than none:
//
// **Maximum skills.** Hostile skill levels are unknown, so every range is
// computed at Jump Drive Calibration V. Assuming less would draw a smaller
// envelope than the one you are actually standing in.
//
// **Every staging system is live.** This says what a hull based there could
// reach, not what anyone is currently flying.
//
// **No cyno jammers.** A jammer would shrink the envelope, and no third-party
// tool can detect one: nothing CCP publishes exposes jammer state. So this is an
// upper bound, which is the right direction for a threat, and it must never be
// presented as a boundary.
//
// It also inherits the one hard rule that is not an assumption: capitals cannot
// jump into high security, so high-security systems are not in any capital
// envelope. That comes from the jump planner's own range logic rather than
// being restated here.

import { skillMultiplier } from "./jump-planner.js";

// Two of the ten jump-capable groups cannot shoot back, and they hold the longest
// reach in New Eden - 5 ly base against a titan's 3. So an overlay called "what
// can drop on me", sorted by reach alone, puts a Rorqual first and the titan last.
//
// The groups are named rather than inferred because the SDE carries no combat
// flag: `data/ships.json` holds `group`, range, fuel and the fatigue reduction,
// and nothing separating a hauler from a hull that kills you. A closed set of two,
// checked by the suite against the groups the data actually has, is honest about
// being a judgement; a heuristic over hull names would not be.
const LOGISTICS_GROUPS = new Set(["Capital Industrial Ship", "Jump Freighter"]);

// Ranges are uniform within a hull group in the SDE, so one representative per
// group is enough - and taking them from the data rather than writing them down
// means an SDE change moves them.
export function threatClasses(shipData, { calibration = 5 } = {}) {
  const groups = new Map();
  for (const ship of shipData?.ships ?? []) {
    if (!(ship.base_range_ly > 0)) continue;
    if (!groups.has(ship.group)) groups.set(ship.group, []);
    groups.get(ship.group).push(ship);
  }

  const bonus = shipData?.skills?.["Jump Drive Calibration"]?.range_bonus_per_level ?? null;
  const multiplier = skillMultiplier(bonus, calibration);

  return [...groups]
    .map(([group, ships]) => {
      // If a group ever stops being uniform, take the longest reach in it: the
      // envelope has to cover the worst hull, not the average one.
      const longest = ships.reduce((worst, ship) => (ship.base_range_ly > worst.base_range_ly ? ship : worst));
      return {
        group,
        representative: longest.name,
        baseLy: longest.base_range_ly,
        rangeLy: longest.base_range_ly * multiplier,
        uniform: new Set(ships.map(ship => ship.base_range_ly)).size === 1,
        combat: !LOGISTICS_GROUPS.has(group),
      };
    })
    // Combat hulls first, and only then by reach. Reach is the right order within
    // the combat hulls - the longest is the class you find out about last - and
    // the wrong first key across all ten, because the two longest reaches in the
    // game belong to a mining ship and a freighter.
    .sort((a, b) => Number(b.combat) - Number(a.combat)
      || b.rangeLy - a.rangeLy
      || a.group.localeCompare(b.group));
}

// Everything each class can reach from any of the given staging systems.
//
// Returned per class rather than merged, because "a black ops can reach you"
// and "a titan can reach you" are different problems and merging them loses the
// only thing that makes the answer actionable.
// **There is no high-security option and there cannot be one.** A capital cannot
// jump into high security, so an envelope including it would paint systems as
// threatened that no cyno can be lit in. Covert cynosural fields are barred there
// too, so black ops bridging is not an exception either.
export function threatEnvelope(planner, stagingIds, classes) {
  const staging = [...new Set((stagingIds ?? []).map(Number).filter(id => planner.systems[id]))];
  return classes.map(threat => {
    const reachable = new Map();
    // The staging systems themselves, first and at zero distance. rangeSet
    // excludes its own origin, which is right for a jump planner - you do not
    // jump to where you already are - and wrong here: the system they stage
    // from is the most threatened system on the map, and reporting "nothing
    // reaches this" for it would be the overlay's worst possible answer.
    for (const originId of staging) {
      reachable.set(originId, {
        system: planner.systems[originId],
        distanceLy: 0,
        fromId: originId,
        fromSystem: planner.systems[originId],
        isStaging: true,
      });
    }
    for (const originId of staging) {
      const set = planner.rangeSet(originId, threat.rangeLy, { allowHighSec: false });
      for (const entry of set.entries) {
        const existing = reachable.get(entry.system.system_id);
        // Keep the nearest source: if two staging systems both reach you, the
        // closer one is the one that matters. This also protects the staging
        // entries seeded above, which sit at distance zero and cannot be beaten
        // - no explicit guard is needed and an unreachable one would only look
        // like it was doing something.
        if (!existing || entry.distanceLy < existing.distanceLy) {
          reachable.set(entry.system.system_id, {
            system: entry.system,
            distanceLy: entry.distanceLy,
            fromId: originId,
            fromSystem: planner.systems[originId],
            isStaging: false,
          });
        }
      }
    }
    return { ...threat, staging, reachable, systemIds: new Set(reachable.keys()) };
  });
}

// The inverse, and the one an FC actually asks: standing in this system, what
// reaches me, and from where.
//
// Combat hulls first and then longest reach first, which is the order
// `threatClasses` builds.
export function threatsTo(envelopes, systemId) {
  const id = Number(systemId);
  return envelopes
    .filter(envelope => envelope.reachable.has(id))
    .map(envelope => {
      const hit = envelope.reachable.get(id);
      return {
        group: envelope.group,
        representative: envelope.representative,
        combat: envelope.combat !== false,
        rangeLy: envelope.rangeLy,
        distanceLy: hit.distanceLy,
        fromId: hit.fromId,
        fromSystem: hit.fromSystem,
        isStaging: Boolean(hit.isStaging),
      };
    })
    .sort((a, b) => Number(b.combat) - Number(a.combat) || b.rangeLy - a.rangeLy);
}

// A one-line summary for a panel. Says what is missing as well as what is
// known, because the interesting case is the FC who reads "nothing reaches you"
// and needs to know that a jammer they cannot see is not what produced it.
export function describeThreat(threats) {
  if (!threats.length) return "No jump-capable hull reaches this system from the listed staging.";
  if (threats[0].isStaging) return "This is a staging system. Nothing has to reach it.";
  // The heaviest thing that can kill you, which is what the sort puts first.
  // Where only haulers reach, that is what this says rather than calling a
  // Rorqual a threat.
  const worst = threats[0];
  const others = threats.length - 1;
  const what = worst.combat === false ? `${worst.group} (not a combat hull)` : worst.group;
  return `${what} reaches this system (${worst.distanceLy.toFixed(2)} of ${worst.rangeLy.toFixed(2)} ly)`
    + (others > 0 ? `, and ${others} other ${others === 1 ? "class" : "classes"} do too.` : ".");
}
