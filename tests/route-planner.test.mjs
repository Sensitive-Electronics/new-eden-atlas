import { readArchive, suite } from "./helpers.mjs";
import { RoutePlanner, emptyAvoid, emptyLimits, displayedSecurity, ROUTE_MODES } from "../web/route-planner.js";
import { HIGH_SECURITY, securityClass } from "../web/map-utils.js";

export default function run() {
  const t = suite("route planner");
  const atlas = readArchive();
  const planner = new RoutePlanner(atlas);

  // --- baseline -----------------------------------------------------------
  const base = planner.calculate("Jita", "Amarr", "shortest");
  t.equal(base.jumps, 11, "unconstrained Jita to Amarr is 11 jumps");
  t.check(base.systems[0].name === "Jita" && base.systems.at(-1).name === "Amarr", "endpoints are as asked");
  t.check(ROUTE_MODES.every(mode => planner.calculate("Jita", "Rens", mode).jumps > 0), "every declared mode routes");
  t.equal(planner.calculate("Jita", "Jita").jumps, 0, "a system to itself is zero jumps");

  const isGateLink = route => route.systems.every((system, i) =>
    i === 0 || atlas.systems[route.systems[i - 1].system_id].neighbors.includes(system.system_id));
  t.check(isGateLink(base), "every hop is a real stargate link");

  // --- avoid lists --------------------------------------------------------
  t.throws(() => planner.resolveAvoid("Notarealsystem", ""), "no single system", "unknown system rejected");
  t.throws(() => planner.resolveAvoid("", "Notarealregion"), "no single region", "unknown region rejected");
  t.throws(() => planner.resolveAvoid("J", ""), "no single system", "an ambiguous prefix is rejected, not guessed");
  t.equal(planner.resolveAvoid("Jita, jita, JITA", "").systemIds.size, 1, "repeats collapse");
  t.equal(planner.resolveAvoid(" Jita ,, ;Amarr ", "").systemNames.length, 2, "blank entries and spacing tolerated");

  // Avoid a system drawn from the baseline path, so a detour is truly forced.
  const midpoint = base.systems[Math.floor(base.systems.length / 2)];
  const detour = planner.calculate("Jita", "Amarr", "shortest", planner.resolveAvoid(midpoint.name, ""));
  t.check(!detour.systems.some(s => s.system_id === midpoint.system_id), `${midpoint.name} is absent from the detour`);
  t.check(detour.jumps > base.jumps, `the detour is longer (${base.jumps} to ${detour.jumps})`);
  t.check(isGateLink(detour), "every detour hop is a real stargate link");

  const crossed = base.regions.filter(n =>
    n !== atlas.regions[base.origin.region_id].name && n !== atlas.regions[base.destination.region_id].name);
  const target = crossed[0];
  const viaRegion = planner.calculate("Jita", "Amarr", "shortest", planner.resolveAvoid("", target));
  t.check(!viaRegion.regions.includes(target), `an avoided region (${target}) is absent from the path`);

  t.throws(() => planner.calculate("Jita", "Amarr", "shortest", planner.resolveAvoid("Jita", "")),
    "Origin Jita is on the avoid list", "an avoided origin is refused, not exempted");
  t.throws(() => planner.calculate("Jita", "Amarr", "shortest", planner.resolveAvoid("", "The Forge")),
    "which is on the avoid list", "an origin inside an avoided region is refused");

  const fence = atlas.systems[planner.resolveSystem("Jita").system_id].neighbors
    .map(id => atlas.systems[id].name).join(",");
  t.throws(() => planner.calculate("Jita", "Amarr", "shortest", planner.resolveAvoid(fence, "")),
    "under the 7 listed entries", "a fenced origin blames the avoid list");

  // --- security limits ----------------------------------------------------
  t.equal(planner.resolveLimits("", "").min, null, "blank is unbounded");
  t.equal(planner.resolveLimits("0.47", "").min, 0.5, "an entered value rounds to the displayed scale");
  t.throws(() => planner.resolveLimits("high", ""), "is not a number", "non-numeric rejected");
  t.throws(() => planner.resolveLimits("1.5", ""), "between -1.0 and 1.0", "out of range rejected");
  t.throws(() => planner.resolveLimits("0.8", "0.2"), "is above maximum", "an inverted range is rejected");

  const safe = planner.calculate("Jita", "Amarr", "shortest", emptyAvoid(), planner.resolveLimits("0.5", ""));
  t.check(safe.systems.every(s => displayedSecurity(s.security) >= 0.5), "a 0.5 minimum keeps every system at 0.5 or better");
  t.check(safe.systems.every(s => securityClass(s.security) === "high"), "minimum 0.5 and high security select the same systems");
  t.check(safe.security.low === 0 && safe.security.null === 0, "the summary agrees");
  t.check(safe.systems.some(s => s.security >= 0.45 && s.security < 0.5),
    "and the corrected boundary is exercised: the path uses systems displaying 0.5 on a lower raw value");

  const deep = planner.calculate("1DQ1-A", "6VDT-H", "shortest", emptyAvoid(), planner.resolveLimits("", "0.0"));
  t.check(deep.systems.every(s => displayedSecurity(s.security) <= 0), "a 0.0 maximum stays in null security");

  t.throws(() => planner.calculate("Jita", "Amarr", "shortest", emptyAvoid(), planner.resolveLimits("", "0.4")),
    "Origin Jita shows security 0.9, above the maximum of 0.4", "an out-of-range origin names its value and the bound");
  t.throws(() => planner.calculate("Jita", "1DQ1-A", "shortest", emptyAvoid(), planner.resolveLimits("0.5", "")),
    "Destination 1DQ1-A shows security", "an out-of-range destination is named");

  // A real high-security island, found by search rather than assumed, so the
  // disconnection message is exercised with both endpoints inside the limit.
  const reach = new Set([planner.resolveSystem("Jita").system_id]);
  const queue = [...reach];
  while (queue.length) {
    for (const n of atlas.systems[queue.shift()].neighbors) {
      if (reach.has(n) || !atlas.systems[n] || displayedSecurity(atlas.systems[n].security) < 0.5) continue;
      reach.add(n);
      queue.push(n);
    }
  }
  const island = Object.values(atlas.systems).find(s => displayedSecurity(s.security) >= 0.5 && !reach.has(s.system_id));
  t.check(Boolean(island), "New Eden contains high-security islands");
  t.check(planner.calculate("Jita", island.name, "shortest").jumps > 0, `${island.name} is reachable unconstrained`);
  t.throws(() => planner.calculate("Jita", island.name, "shortest", emptyAvoid(), planner.resolveLimits("0.5", "")),
    "under a security minimum 0.5", "disconnection by limits alone blames the limits");
  t.throws(() => planner.calculate("Jita", "Amarr", "shortest", planner.resolveAvoid("Ikuchi", ""), planner.resolveLimits("0.9", "")),
    "the 1 listed entry and a security minimum 0.9", "both causes are named when both apply");

  // --- regression ---------------------------------------------------------
  t.equal(planner.calculate("Jita", "Amarr", "shortest", emptyAvoid(), emptyLimits()).jumps, base.jumps,
    "explicit empty constraints match the defaults");
  t.check(base.avoid !== undefined && base.limits !== undefined, "a described route carries its constraints");


  // --- high security only where possible --------------------------------------
  // Distinct from "safer", which is a preference and will still take a low-sec
  // shortcut when it saves enough. This one crosses ten thousand high-sec jumps
  // before it takes one low-sec jump.
  //
  // Jita to Amarr is the case that shows the difference: the short route goes
  // through Ahbazon at 0.4, and "safer" takes it anyway.
  const shortest = planner.calculate("Jita", "Amarr", "shortest");
  const safer = planner.calculate("Jita", "Amarr", "safer");
  const highSecOnly = planner.calculate("Jita", "Amarr", "high-sec-only");

  t.check(shortest.belowHighSecurity.length > 0, "the short Jita-Amarr route leaves high security");
  t.check(safer.belowHighSecurity.length > 0, "and so does the safer one, which is only a preference");
  t.equal(highSecOnly.belowHighSecurity.length, 0, "while high-security-only stays inside it entirely");
  t.check(highSecOnly.jumps > safer.jumps,
    `at a real cost (${safer.jumps} jumps to ${highSecOnly.jumps})`);
  t.check(highSecOnly.systems.every(system => system.security >= HIGH_SECURITY),
    "every system on it is at or above the high-security boundary");

  // The boundary is 0.45, not 0.5, because that is where the client's rounding
  // puts it. A system at 0.45 displays as 0.5 and is high-sec.
  t.check(highSecOnly.systems.every(system => displayedSecurity(system.security) >= 0.5),
    "and displays as 0.5 or above, which is what a pilot reads");

  // The mode is a restriction, so where no high-security route exists the
  // answer is that there is none.
  //
  // As a weight - a low-sec jump costing 10,000 high-sec jumps - the router takes one
  // anyway when the alternative is long enough, which makes the name a promise it does
  // not keep: a hauler who asked for high security is routed through low security and
  // has to read a warning to find out. "Safer" is the preference; this is the
  // restriction.
  t.throws(() => planner.calculate("Jita", "1DQ1-A", "high-sec-only"),
    "outside high security", "a destination outside high security is refused, not approximated");
  t.throws(() => planner.calculate("Jita", "1DQ1-A", "high-sec-only"),
    "safer", "and the refusal names the mode that will answer");
  t.throws(() => planner.calculate("1DQ1-A", "Jita", "high-sec-only"),
    "1DQ1-A is outside", "an origin outside it is refused too, and named");

  // A destination that IS high security but has no high-security approach is
  // the genuinely interesting case, and a different one: both endpoints pass
  // the check above and the graph is what fails. 110 of New Eden's 1,246
  // high-security systems are islands of this kind, reachable from Jita only
  // by leaving high security - Derelik's pocket behind Chidah among them.
  t.throws(() => planner.calculate("Jita", "Sooma", "high-sec-only"),
    "No high-security route", "a high-security island is refused as unreachable, not approximated");
  t.throws(() => planner.calculate("Jita", "Sooma", "high-sec-only"),
    "safer route is", "and the refusal says what the safer route would cost, so the answer is actionable");
  t.check(planner.calculate("Jita", "Sooma", "safer").jumps > 0,
    "which that mode does answer");

  // The hard security minimum is still its own thing and still refuses.
  t.throws(() => planner.calculate("Jita", "1DQ1-A", "shortest", emptyAvoid(), planner.resolveLimits("0.5", "")),
    "Destination", "a hard minimum still refuses a destination it cannot satisfy");

  t.check(ROUTE_MODES.includes("high-sec-only"), "the mode is offered");

  // A mode that is not offered becomes the shortest route rather than being carried
  // through. This is reachable: a select set to a value it has no option for ends up
  // empty, which is what a saved setting from an older version does, and an empty string
  // carried through renders as a heading reading "undefined".
  for (const junk of ["legacy-mode", "", null, undefined, 42]) {
    const fallback = planner.calculate("Jita", "Perimeter", junk);
    t.equal(fallback.mode, "shortest", `an unusable mode (${JSON.stringify(junk)}) becomes the shortest route`);
  }
  t.equal(planner.calculate("Jita", "Perimeter", "shortest").mode, "shortest",
    "and a real mode is kept");
  t.equal(planner.calculate("Jita", "Amarr", "high-sec-only").mode, "high-sec-only",
    "including the new one");

  t.equal(planner.calculate("Jita", "Perimeter", "high-sec-only").jumps, 1,
    "and a route already inside high security is unaffected");

  // --- which shortest route, not just how short ----------------------------------
  //
  // Almost every pair of systems has several routes of equal length, and the
  // suite only ever checked the length. Mutation testing found the guard that
  // decides between them - `compareCost(...) >= 0` in the relaxation, which
  // skips a neighbour that is merely equal rather than better - and relaxing it
  // to `> 0` changed **151 of 300** sampled routes while changing not one jump
  // count. Half of all journeys rerouted, every test still green.
  //
  // That matters to a pilot rather than to an algorithm: a route that changes
  // between two runs of the same query is one they cannot learn, write down or
  // trust, and a build that quietly reroutes them through different space has
  // told them nothing about it.
  //
  // Pinned exactly, so a change to tie-breaking has to be a decision. If this
  // fails because the rule was deliberately improved, the fix is to update the
  // sequence and say so.
  // These two pairs are chosen because they *discriminate*. The first pins I
  // wrote - Jita to Amarr, Rens to Dodixie - happen to resolve identically
  // under the mutation, so they asserted the property without being able to
  // catch it losing. Picked by diffing 110 hub-to-hub routes against the
  // mutated planner and taking pairs that actually moved.
  t.equal(
    planner.calculate("Rens", "Hek", "shortest").systems.map(s => s.name).join(" "),
    "Rens Frarn Gyng Onga Pator Eystur Hek",
    "Rens to Hek goes through Pator, and goes through Pator every time");
  t.equal(
    planner.calculate("Jita", "Dodixie", "shortest").systems.map(s => s.name).join(" "),
    "Jita Ikuchi Tunttaras Nourvukaiken Tama Sujarento Onatoh Tannolen Tierijev Chantrousse Ourapheh Botane Dodixie",
    "and Jita to Dodixie leaves by Ikuchi rather than Niyabainen");

  // Determinism is the weaker half of the same property, and worth its own
  // check: a freshly built planner must agree with this one, so nothing depends
  // on insertion order or on state left behind by an earlier query.
  const fresh = new RoutePlanner(atlas);
  for (const [from, to] of [["Jita", "Amarr"], ["Rens", "Dodixie"], ["Amarr", "Jita"]]) {
    t.equal(
      fresh.calculate(from, to, "shortest").systems.map(s => s.system_id).join(">"),
      planner.calculate(from, to, "shortest").systems.map(s => s.system_id).join(">"),
      `${from} to ${to} is the same route from a planner that has answered nothing else`);
  }

  return t.results;
}
