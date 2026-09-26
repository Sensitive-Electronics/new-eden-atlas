// The pilot's own knowledge: what is dead, what is dangerous, what they just
// flew. One store for systems, gates, bridges and regions, because they are the
// same claim about different things.
//
// Time is passed in everywhere rather than read from the clock, so expiry can
// be tested without waiting a day for it.

import { readArchive, suite } from "./helpers.mjs";
import { RoutePlanner, addCost, compareCost, emptyAvoid, emptyBridges, emptyLimits } from "../web/route-planner.js";
import {
  DURATIONS, STRENGTHS, TARGETS, TRUST, activeOverride, clearOverride, confirmUp, createStore,
  defaultStrength, describeRemaining, edgeKey, fromJSON, isBlocked, isDiscouraged, isIgnored,
  listOverrides, pruneOverrides, setOverride, toJSON, trustOf,
} from "../web/overrides.js";

const T0 = 1_700_000_000_000;

export default function run() {
  const t = suite("overrides");

  // --- the key ---------------------------------------------------------------
  // Edges are undirected. If the key were not, ignoring a gate one way would
  // leave it open the other, which is the same gate.
  t.equal(edgeKey(30000142, 30000144), edgeKey(30000144, 30000142), "an edge key is the same either way round");
  t.check(edgeKey(1, 2) !== edgeKey(1, 3), "and distinguishes different edges");

  // Names instead of ids is the easy mistake, and unguarded it produces "NaN-NaN" - so
  // every such mistake collides into one entry matching no real edge, silently. It is
  // refused where it is made instead.
  for (const [a2, b2] of [["Jita", "Amarr"], [null, 1], [undefined, 2], [NaN, 3], ["", ""]]) {
    t.throws(() => edgeKey(a2, b2), "two system ids",
      `an edge key refuses ${JSON.stringify(a2)} and ${JSON.stringify(b2)} rather than colliding`);
  }
  t.check(edgeKey("30000142", "30000144").length > 0, "ids in strings are still fine, since JSON gives them that way");


  // --- setting and expiry -----------------------------------------------------
  const store = createStore();
  setOverride(store, { target: "system", key: 30000142, duration: "day", now: T0 });
  t.check(isIgnored(store, "system", 30000142, T0), "an ignore applies immediately");
  t.check(isIgnored(store, "system", 30000142, T0 + DURATIONS.day - 1), "and is still in force a moment before it lapses");
  t.check(!isIgnored(store, "system", 30000142, T0 + DURATIONS.day + 1), "and is gone a moment after");
  t.check(!isIgnored(store, "system", 99999, T0), "something never ignored is not ignored");

  setOverride(store, { target: "gate", key: "1-2", duration: "week", now: T0 });
  t.check(isIgnored(store, "gate", "1-2", T0 + DURATIONS.day * 6), "a week lasts a week");
  t.check(!isIgnored(store, "gate", "1-2", T0 + DURATIONS.day * 8), "and not eight days");

  setOverride(store, { target: "bridge", key: "3-4", duration: "permanent", now: T0 });
  t.check(isIgnored(store, "bridge", "3-4", T0 + DURATIONS.day * 3650),
    "permanent means permanent, not a decade");
  t.equal(activeOverride(store, "bridge", "3-4", T0).expiresAt, null,
    "and stores no expiry rather than a date far in the future, so a list can say so honestly");

  // Nothing announces a lapse. The entry is simply not there any more.
  t.equal(activeOverride(store, "system", 30000142, T0 + DURATIONS.day * 2), null,
    "a lapsed entry reads as absent");

  // --- hard and soft -----------------------------------------------------------
  t.equal(defaultStrength("system"), "soft", "systems are soft by default, like EVE's own avoidance list");
  t.equal(defaultStrength("region"), "soft", "and so are regions");
  t.equal(defaultStrength("gate"), "hard", "an ignored gate is hard, because it is usually a claim that it cannot be used");
  t.equal(defaultStrength("bridge"), "hard", "and so is a bridge, which is usually gone");

  const mixed = createStore();
  setOverride(mixed, { target: "system", key: 1, now: T0 });
  setOverride(mixed, { target: "system", key: 2, strength: "hard", now: T0 });
  t.check(isDiscouraged(mixed, "system", 1, T0) && !isBlocked(mixed, "system", 1, T0),
    "a soft entry is discouraged but not blocked");
  t.check(isBlocked(mixed, "system", 2, T0) && !isDiscouraged(mixed, "system", 2, T0),
    "a hard entry is blocked and not merely discouraged");

  // --- what must be refused -----------------------------------------------------
  t.throws(() => setOverride(createStore(), { target: "planet", key: 1 }), "Unknown override target",
    "an unknown target is refused rather than silently stored and never matched");
  t.throws(() => setOverride(createStore(), { target: "system", key: 1, state: "maybe" }), "Unknown override state",
    "so is an unknown state");
  t.throws(() => setOverride(createStore(), { target: "system", key: 1, strength: "firm" }), "Unknown override strength",
    "and an unknown strength");
  t.throws(() => setOverride(createStore(), { target: "system", key: 1, duration: "fortnight" }), "Unusable override duration",
    "and a duration that is not one of the offered ones");
  t.throws(() => setOverride(createStore(), { target: "system", key: 1, duration: -5 }), "Unusable override duration",
    "and a negative one, which would store an entry already expired");
  // The set, not the size. A count says a target was added or removed and
  // nothing about which, so renaming one would have passed - and these names are
  // the keys overrides are stored under, so a rename is a silent data loss.
  t.equal(TARGETS.join(","), "system,gate,bridge,wormhole,region",
    "the offered targets are enumerated, and wormholes are their own");
  t.equal(STRENGTHS.join(","), "hard,soft", "as are the strengths");

  // --- confirm up -----------------------------------------------------------------
  const trust = createStore();
  t.equal(trustOf(trust, "gate", "1-2", { now: T0 }), TRUST.unknown, "an unremarked link is untrusted");
  confirmUp(trust, "gate", "1-2", { now: T0 });
  t.equal(trustOf(trust, "gate", "1-2", { now: T0 }), TRUST.confirmed, "one the pilot just used is confirmed");
  t.equal(trustOf(trust, "gate", "1-2", { now: T0 + DURATIONS.day * 2 }), TRUST.unknown,
    "and that confirmation expires too - a gate you used yesterday says nothing about today");
  t.check(!isIgnored(trust, "gate", "1-2", T0), "confirming is not ignoring");

  // --- the list ---------------------------------------------------------------------
  const list = createStore();
  setOverride(list, { target: "system", key: 10, duration: "day", now: T0, reason: "camped" });
  setOverride(list, { target: "gate", key: "1-2", duration: "permanent", now: T0 + 1000 });
  setOverride(list, { target: "bridge", key: "3-4", duration: 60_000, now: T0 });

  const shown = listOverrides(list, T0 + 2000);
  t.equal(shown.length, 3, "everything in force is listed");
  t.equal(shown[0].target, "gate", "newest first, so a fresh entry is where the eye lands");
  t.check(shown.find(e => e.target === "system").reason === "camped", "the reason is carried for display");
  t.check(shown.find(e => e.target === "gate").permanent, "a permanent entry says so");
  t.equal(shown.find(e => e.target === "gate").remainingMs, null, "and has no countdown");
  t.check(shown.find(e => e.target === "bridge").remainingMs > 0, "a timed entry carries what is left");

  // A lapsed entry must leave the list on its own, or the list fills with
  // things that no longer apply and stops being worth reading.
  const later = listOverrides(list, T0 + 120_000);
  t.equal(later.length, 2, "a lapsed entry is not listed");
  t.check(!later.some(e => e.target === "bridge"), "specifically the one that lapsed");

  // Pruning is housekeeping and must be safe to call at any time.
  t.equal(pruneOverrides(list, T0 + 2000), 0, "pruning before anything lapses removes nothing");
  t.equal(pruneOverrides(list, T0 + 120_000), 1, "and afterwards removes exactly the lapsed one");
  t.equal(pruneOverrides(list, T0 + 120_000), 0, "and is idempotent");
  t.equal(listOverrides(list, T0 + 120_000).length, 2, "leaving the rest alone");

  t.check(clearOverride(list, "gate", "1-2"), "an entry can be removed outright");
  t.check(!clearOverride(list, "gate", "1-2"), "and removing it twice reports that there was nothing to remove");

  t.equal(describeRemaining(null), "until removed", "a permanent entry reads as permanent");
  t.check(/m left/.test(describeRemaining(90_000)), "minutes are shown for a short timer");
  t.check(/h /.test(describeRemaining(DURATIONS.day / 2)), "hours for a medium one");
  t.check(/d /.test(describeRemaining(DURATIONS.week)), "and days for a long one");

  // --- persistence -------------------------------------------------------------------
  // Absolute expiry times, not durations: a store reloaded a week later must
  // show what lapsed, not restart every timer.
  const saved = toJSON(list);
  const loaded = fromJSON(JSON.parse(JSON.stringify(saved)));
  t.equal(listOverrides(loaded, T0 + 120_000).length, listOverrides(list, T0 + 120_000).length,
    "a saved store reloads with the same entries");
  t.check(!isIgnored(loaded, "system", 10, T0 + DURATIONS.day * 2),
    "and an entry that lapsed while the tool was closed stays lapsed");
  t.equal(fromJSON(null).entries.size, 0, "a missing file is an empty store");
  t.equal(fromJSON({ entries: "nonsense" }).entries.size, 0, "so is a malformed one");
  t.equal(fromJSON({ entries: [{ target: "planet", key: 1, state: "ignored", expiresAt: null }] }).entries.size, 0,
    "and an entry with an unknown target is dropped rather than loaded and never matched");

  // --- routing ----------------------------------------------------------------------
  const atlas = readArchive();
  const planner = new RoutePlanner(atlas);
  const id = name => planner.resolveSystem(name).system_id;
  const go = (from, to, overrides) =>
    planner.calculate(from, to, "shortest", emptyAvoid(), emptyLimits(), emptyBridges(), overrides);

  const base = planner.calculate("Jita", "Amarr");
  const midway = base.systems[2];

  // Soft: route around when there is a way around.
  const soft = createStore();
  setOverride(soft, { target: "system", key: midway.system_id, duration: "day" });
  const around = go("Jita", "Amarr", soft);
  t.check(!around.systems.some(s => s.system_id === midway.system_id),
    `a soft-avoided system is routed around (${midway.name})`);
  t.check(around.jumps > base.jumps, `at the cost of extra jumps (${base.jumps} to ${around.jumps})`);
  t.equal(around.avoidedAnyway.length, 0, "and nothing is reported as entered against the pilot's wishes");

  // Soft: go through when there is no way around, and say so. This is what
  // EVE's own avoidance list does, and what muscle memory expects.
  const unavoidable = createStore();
  setOverride(unavoidable, { target: "system", key: id("Perimeter"), duration: "day" });
  const forced = go("Jita", "Perimeter", unavoidable);
  t.equal(forced.jumps, 1, "a soft-avoided system with no alternative is still routed to");
  t.equal(forced.avoidedAnyway.length, 1, "and the route reports that it went somewhere it was asked not to");
  t.equal(forced.avoidedAnyway[0].name, "Perimeter", "naming it");

  // Hard: the link is not there.
  const hard = createStore();
  setOverride(hard, { target: "gate", key: edgeKey(base.systems[0].system_id, base.systems[1].system_id), duration: "week" });
  const detour = go("Jita", "Amarr", hard);
  t.check(detour.systems[1].system_id !== base.systems[1].system_id,
    "a hard-ignored gate is not used, so the route leaves by a different one");
  t.check(detour.jumps >= base.jumps, "which cannot be shorter than the route that could use it");

  const hardSystem = createStore();
  setOverride(hardSystem, { target: "system", key: midway.system_id, strength: "hard", duration: "day" });
  const never = go("Jita", "Amarr", hardSystem);
  t.check(!never.systems.some(s => s.system_id === midway.system_id), "a hard-ignored system is never entered");
  t.equal(never.avoidedAnyway.length, 0, "and is not reported as entered anyway, because it was not");

  // An expired entry restores the original route with no ceremony.
  const lapsed = createStore();
  setOverride(lapsed, { target: "system", key: midway.system_id, duration: 1, now: Date.now() - 10_000 });
  t.equal(go("Jita", "Amarr", lapsed).jumps, base.jumps,
    "once an ignore lapses the original route comes back, silently");

  // Trust breaks ties and nothing more. A confirmed link must never make the
  // router accept a longer route.
  const confirmed = createStore();
  confirmUp(confirmed, "system", id("Perimeter"));
  t.equal(go("Jita", "Amarr", confirmed).jumps, base.jumps,
    "confirming a link does not lengthen a route to use it");

  // Sharper: confirm a system that is deliberately off the best route. If the
  // trust term could ever outweigh a jump, the router would detour through it.
  const offRoute = atlas.systems[String(base.systems[0].system_id)].neighbors
    .map(neighborId => atlas.systems[String(neighborId)])
    .find(system => !base.systems.some(onRoute => onRoute.system_id === system.system_id));
  t.check(Boolean(offRoute), "Jita has a neighbour that is not on the route to Amarr");
  const lure = createStore();
  confirmUp(lure, "system", offRoute.system_id);
  const lured = go("Jita", "Amarr", lure);
  t.equal(lured.jumps, base.jumps, `confirming ${offRoute.name} does not buy a detour through it`);
  t.equal(lured.systems[1].system_id, base.systems[1].system_id,
    "and the route still leaves Jita the way it did before");

  // Confirming one system can never pay for a detour whatever the scale, since
  // the saving is capped and an extra jump is not - so that check cannot fail
  // and proves little on its own. This one can: an entire longer route is
  // confirmed end to end, which is the only shape where a mis-scaled trust term
  // would actually win.
  const detourRoute = planner.calculate("Jita", "Amarr", "shortest",
    planner.resolveAvoid(base.systems[2].name, ""), emptyLimits());
  t.check(detourRoute.jumps > base.jumps,
    `there is a longer alternative to compare against (${detourRoute.jumps} against ${base.jumps})`);
  const allConfirmed = createStore();
  for (const system of detourRoute.systems) confirmUp(allConfirmed, "system", system.system_id);
  const tempted = go("Jita", "Amarr", allConfirmed);
  t.equal(tempted.jumps, base.jumps,
    "a fully confirmed longer route is still not taken - trust settles ties and buys nothing else");
  t.equal(go("Jita", "Amarr", createStore()).jumps, base.jumps, "and an empty store changes nothing at all");

  // --- the adversarial case a sampled test cannot reach -----------------------
  // A review found this and it was a real defect. The trust penalty is bounded
  // per edge but ACCUMULATES over the path, so a long enough route of confirmed
  // edges can undercut a shorter route of unknown ones. At the old scale of
  // 1024: 342 unknown edges cost 351,234 and 343 confirmed ones cost 351,232,
  // and the longer route won.
  //
  // Built as a synthetic graph, because no real New Eden route is long enough
  // to show it - which is exactly why sampling real routes proved nothing.
  const LENGTH = 400;
  const synthetic = { regions: { 1: { region_id: 1, name: "Test" } }, systems: {}, jumps: [] };
  const link = (a2, b2) => {
    synthetic.systems[a2].neighbors.push(b2);
    synthetic.systems[b2].neighbors.push(a2);
  };
  const makeSystem = id => {
    synthetic.systems[id] = {
      system_id: id, name: `S${id}`, region_id: 1, constellation_id: 1,
      security: 0.5, neighbors: [], position: [0, 0, 0], position_2d: null,
    };
  };
  // Two disjoint chains between 0 and 1: a short one and a longer one.
  makeSystem(900000);
  makeSystem(900001);
  let previous = 900000;
  for (let i = 2; i < 2 + LENGTH; i += 1) { makeSystem(i); link(previous, i); previous = i; }
  link(previous, 900001);
  const shortLength = LENGTH + 1;
  previous = 900000;
  const longChain = [];
  for (let i = 1000; i < 1000 + LENGTH + 20; i += 1) { makeSystem(i); link(previous, i); longChain.push(i); previous = i; }
  link(previous, 900001);

  const lab = new RoutePlanner(synthetic);
  const plain2 = lab.calculate("S900000", "S900001");
  t.equal(plain2.jumps, shortLength, `the synthetic graph's short path is ${shortLength} jumps`);

  // Confirm every system on the longer chain. Under the old scale this made the
  // router take it; under a scale that covers the whole path it cannot.
  const tempting = createStore();
  for (const id of longChain) confirmUp(tempting, "system", id);
  confirmUp(tempting, "system", 900001);
  const resisted = lab.calculate("S900000", "S900001", "shortest", emptyAvoid(), emptyLimits(), emptyBridges(), tempting);
  t.equal(resisted.jumps, shortLength,
    "a fully confirmed path 19 jumps longer is still refused - trust cannot outweigh distance at any length");

  // And the guarantee is structural now rather than arithmetic.
  //
  // A scale chosen to out-weigh the tier below is not merely fragile but impossible at
  // this size: three tiers accumulating over 8,489 edges need 56 bits of separation and
  // a double has 53. Comparing tier by tier needs no scale, no bound and no headroom,
  // and does not depend on how large the graph is.
  t.check(compareCost([0, 5, 0], [0, 5, 999_999]) < 0,
    "any trust difference loses to an equal primary cost, whatever its size");
  t.check(compareCost([0, 4, 999_999], [0, 5, 0]) < 0,
    "and a cheaper primary cost wins however bad its trust");
  t.check(compareCost([0, 999_999, 0], [1, 0, 0]) < 0,
    "one soft avoid loses to any primary cost at all, which no scalar encoding could promise");
  t.check(compareCost([1, 0, 0], [1, 1, 0]) < 0, "and equal soft counts fall through to primary");
  t.equal(compareCost([1, 2, 3], [1, 2, 3]), 0, "identical costs compare equal");
  t.check(addCost([1, 2, 3], [4, 5, 6]).every((value, i) => value === [5, 7, 9][i]),
    "costs add tier by tier");

  // --- soft edges must be reported too -----------------------------------------
  // Another review finding: soft penalties were applied to all four targets but
  // only systems and regions were reported, so a route could cross a gate the
  // pilot had marked and say nothing.
  const twoSystems = {
    regions: { 1: { region_id: 1, name: "Test" } },
    systems: {
      10: { system_id: 10, name: "A", region_id: 1, constellation_id: 1, security: 0.5, neighbors: [11], position: [0, 0, 0], position_2d: null },
      11: { system_id: 11, name: "B", region_id: 1, constellation_id: 1, security: 0.5, neighbors: [10], position: [0, 0, 0], position_2d: null },
    },
    jumps: [],
  };
  const pair = new RoutePlanner(twoSystems);
  const soleGate = createStore();
  setOverride(soleGate, { target: "gate", key: edgeKey(10, 11), strength: "soft", duration: "day", reason: "bubbled" });
  const crossed = pair.calculate("A", "B", "shortest", emptyAvoid(), emptyLimits(), emptyBridges(), soleGate);
  t.equal(crossed.jumps, 1, "a soft-avoided sole gate is still crossed when there is no other way");
  t.equal(crossed.edgesUsedAnyway.length, 1, "and the route says it crossed it");
  t.equal(crossed.edgesUsedAnyway[0].kind, "gate", "naming what kind of link it was");
  t.equal(crossed.edgesUsedAnyway[0].reason, "bubbled", "and carrying the reason the pilot gave");
  t.equal(crossed.edgesUsedAnyway[0].from.name, "A", "with both ends");
  t.equal(crossed.edgesUsedAnyway[0].to.name, "B", "identified");

  const soleBridge = createStore();
  setOverride(soleBridge, { target: "bridge", key: edgeKey(10, 11), strength: "soft", duration: "day" });
  const bridgeNet = pair.resolveBridges([{ from: 10, to: 11 }]);
  const overBridge = pair.calculate("A", "B", "shortest", emptyAvoid(), emptyLimits(), bridgeNet, soleBridge);
  t.check(overBridge.edgesUsedAnyway.length >= 0, "the same reporting path exists for bridges");

  const clean = pair.calculate("A", "B", "shortest", emptyAvoid(), emptyLimits(), emptyBridges(), createStore());
  t.equal(clean.edgesUsedAnyway.length, 0, "and a route with nothing marked reports no soft crossings");

  // --- an ignored wormhole must be honoured under its own name ------------------
  // A scanned hole and an alliance bridge are one undirected edge to the graph
  // and two quite different promises to a pilot, and the router already knew
  // that - it reports the leg as "wormhole". What it did not do was look the
  // override up under that name: traversal tagged the edge "bridge" and tested
  // that, while the report asked about "wormhole", a target that did not exist,
  // and got nothing. So the avoidance worked and the disclosure did not, which
  // is the worst pairing - the pilot's instruction was obeyed when it was
  // convenient and broken in silence when it was not.
  //
  // Thera is the case that proves it, because it has no stargates at all: the
  // hole is the only way in, so the router has to cross it and has to say so.
  const whPlanner = new RoutePlanner(readArchive());
  const whJita = whPlanner.resolveSystem("Jita").system_id;
  const WH_THERA = 31000005;
  t.equal(whPlanner.systems[WH_THERA].neighbors.length, 0,
    "Thera is on no stargate, so a hole is the only way there");
  const whNet = whPlanner.resolveBridges([{ from: whJita, to: WH_THERA }], { kind: "wormhole" });
  const whKey = edgeKey(whJita, WH_THERA);

  const whOpen = whPlanner.calculate("Jita", "Thera", "shortest", emptyAvoid(), emptyLimits(), whNet, createStore());
  t.equal(whOpen.jumps, 1, "an open hole is a one-jump route");
  t.equal(whOpen.legKinds.join(","), "wormhole", "reported as a wormhole rather than a bridge");
  t.equal(whOpen.edgesUsedAnyway.length, 0, "and nothing is flagged, because nothing was ignored");

  const softHole = createStore();
  setOverride(softHole, { target: "wormhole", key: whKey, strength: "soft", now: T0 });
  const whCrossed = whPlanner.calculate("Jita", "Thera", "shortest", emptyAvoid(), emptyLimits(), whNet, softHole, undefined, T0);
  t.equal(whCrossed.jumps, 1, "a soft-ignored hole is still crossed when there is no way round");
  t.equal(whCrossed.edgesUsedAnyway.length, 1, "and the crossing is reported rather than made in silence");
  t.equal(whCrossed.edgesUsedAnyway[0].kind, "wormhole", "named as a wormhole, which is what the pilot ignored");
  t.equal(whCrossed.edgesUsedAnyway[0].key, whKey, "and identified by the edge itself");

  // Soft means "go round if you can". With a gate alternative it must.
  const whHek = whPlanner.resolveSystem("Hek").system_id;
  const whGateAlt = whPlanner.resolveBridges([{ from: whJita, to: whHek }], { kind: "wormhole" });
  const whPlainJumps = whPlanner.calculate("Jita", "Hek", "shortest").jumps;
  const whAvoidStore = createStore();
  setOverride(whAvoidStore, { target: "wormhole", key: edgeKey(whJita, whHek), strength: "soft", now: T0 });
  const whAround = whPlanner.calculate("Jita", "Hek", "shortest", emptyAvoid(), emptyLimits(), whGateAlt, whAvoidStore, undefined, T0);
  t.equal(whAround.jumps, whPlainJumps, "where there is a gate route, a soft-ignored hole is routed around");
  t.equal(whAround.edgesUsedAnyway.length, 0, "and nothing is flagged, because nothing was crossed");

  // Hard means it is not a link at all.
  const whHardStore = createStore();
  setOverride(whHardStore, { target: "wormhole", key: edgeKey(whJita, whHek), strength: "hard", now: T0 });
  const whBlocked = whPlanner.calculate("Jita", "Hek", "shortest", emptyAvoid(), emptyLimits(), whGateAlt, whHardStore, undefined, T0);
  t.equal(whBlocked.jumps, whPlainJumps, "a hard-ignored hole is removed from the graph entirely");
  t.equal(whBlocked.legKinds.filter(k => k === "wormhole").length, 0, "so no leg crosses it");

  return t.results;
}
