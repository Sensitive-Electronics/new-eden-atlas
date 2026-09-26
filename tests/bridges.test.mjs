// Ansiblex routing.
//
// Since the September 2026 update the access list is alliance-only, so there is
// exactly one network that can affect a route - the pilot's own - and hostile
// bridges cannot be enumerated at all. That makes the routing half tractable
// and the threat half permanently incomplete, and these tests are about the
// first of those.
//
// The properties that matter: a bridge is one jump and shortens a route by the
// gates it skips; it is an ordinary edge as far as avoid lists and security
// limits are concerned, because arriving somewhere by bridge does not make it
// somewhere you were willing to go; and a route has to say which of its legs
// were bridges, since a bridge may be offline or out of fuel and no API reports
// either.

import { readArchive, suite } from "./helpers.mjs";
import { RoutePlanner, emptyAvoid, emptyBridges, emptyLimits } from "../web/route-planner.js";

export default function run() {
  const t = suite("bridges");
  const atlas = readArchive();
  const planner = new RoutePlanner(atlas);
  const route = (from, to, mode = "shortest", avoid = emptyAvoid(), limits = emptyLimits(), bridges = emptyBridges()) =>
    planner.calculate(from, to, mode, avoid, limits, bridges);

  // --- resolving a network --------------------------------------------------
  const network = planner.resolveBridges([
    { from: "1DQ1-A", to: "T5ZI-S" },
    { from: "T5ZI-S", to: "319-3D" },
    { from: "319-3D", to: "Amamake" },
  ]);
  t.equal(network.count, 3, "three bridges resolve");
  t.equal(network.names.length, 3, "each is named for display");

  // Both ends of an Ansiblex are anchored, so the link works either way.
  const oneWay = planner.resolveBridges([{ from: "Amamake", to: "1DQ1-A" }]);
  const amamake = planner.resolveSystem("Amamake").system_id;
  const delve = planner.resolveSystem("1DQ1-A").system_id;
  t.check(oneWay.links.get(amamake)?.includes(delve), "a bridge is traversable from the end it was written at");
  t.check(oneWay.links.get(delve)?.includes(amamake), "and from the other end, which is the same structure pair");

  // Ids and names both, because a person editing a file writes names and an
  // ESI pull returns ids.
  const byId = planner.resolveBridges([{ from: delve, to: amamake }]);
  t.equal(byId.count, 1, "a bridge given as numeric ids resolves");
  const byStringId = planner.resolveBridges([{ from: String(delve), to: String(amamake) }]);
  t.equal(byStringId.count, 1, "and as ids in strings, which is what JSON round-trips sometimes give");
  const asPair = planner.resolveBridges([["1DQ1-A", "Amamake"]]);
  t.equal(asPair.count, 1, "and as a plain pair");

  // --- what must be refused --------------------------------------------------
  t.equal(planner.resolveBridges([{ from: "Nowhere-At-All", to: "Jita" }]).count, 0,
    "a bridge from a system that does not exist is dropped, not routed through");
  t.equal(planner.resolveBridges([{ from: "Jita", to: "Jita" }]).count, 0,
    "and a bridge to itself, which would be a zero-cost self edge");
  const twice = planner.resolveBridges([
    { from: "1DQ1-A", to: "Amamake" },
    { from: "Amamake", to: "1DQ1-A" },
  ]);
  t.equal(twice.count, 1, "the same pair written twice, either way round, is one bridge");
  t.equal(twice.names.length, 1, "and is listed once");
  // The count is derived from a set and would stay at one even if the link map
  // had been written twice, so the map itself is checked.
  t.equal(twice.links.get(delve).length, 1, "with one link out of each end, not two");
  t.equal(twice.links.get(amamake).length, 1, "on both sides");
  t.equal(planner.resolveBridges(null).count, 0, "a missing list is an empty network rather than a throw");
  t.equal(planner.resolveBridges("not a list").count, 0, "so is a malformed one");
  t.equal(planner.resolveBridges([{}, null, undefined]).count, 0, "and entries with no ends at all");

  // Silent dropping is right for a file someone is editing, but a caller that
  // wants to know can ask.
  t.throws(() => planner.resolveBridges([{ from: "Nowhere-At-All", to: "Jita" }], { strict: true }),
    "not a known system", "strict mode names the end that could not be resolved");
  t.throws(() => planner.resolveBridges([{ from: "Jita", to: "Jita" }], { strict: true }),
    "bridged to itself", "and reports a self-bridge plainly");

  // --- routing ----------------------------------------------------------------
  const plain = route("1DQ1-A", "Jita");
  const bridged = route("1DQ1-A", "Jita", "shortest", emptyAvoid(), emptyLimits(), network);
  t.check(bridged.jumps < plain.jumps,
    `bridges shorten the route (${plain.jumps} jumps to ${bridged.jumps})`);
  t.check(bridged.bridgeJumps > 0, `and ${bridged.bridgeJumps} of the legs are bridges`);
  t.equal(bridged.legKinds.length, bridged.jumps, "there is one leg kind per jump");
  t.check(bridged.legKinds.every(kind => kind === "gate" || kind === "bridge"),
    "and every leg is one or the other");
  t.equal(bridged.bridgeJumps, bridged.legKinds.filter(k => k === "bridge").length,
    "the bridge count matches the legs it counts");
  t.equal(bridged.bridgesAvailable, 3, "the route records how many bridges it had to work with");

  // Consecutive systems must really be connected, by a gate or by a bridge.
  // Without this the route is just a list that happens to end in the right place.
  const connected = bridged.systems.slice(1).every((system, index) => {
    const previous = bridged.systems[index];
    const byGate = previous.neighbors.includes(system.system_id);
    const byBridge = (network.links.get(previous.system_id) ?? []).includes(system.system_id);
    return bridged.legKinds[index] === "bridge" ? byBridge : byGate;
  });
  t.check(connected, "every leg is a real link of the kind it claims to be");

  // A network that goes nowhere useful must not change the answer.
  const useless = planner.resolveBridges([{ from: "Hek", to: "Rens" }]);
  t.equal(route("1DQ1-A", "Jita", "shortest", emptyAvoid(), emptyLimits(), useless).jumps, plain.jumps,
    "bridges that do not help leave the route as it was");
  t.equal(route("1DQ1-A", "Jita", "shortest", emptyAvoid(), emptyLimits(), emptyBridges()).jumps, plain.jumps,
    "and an empty network is the same as no network at all");

  // --- constraints still apply across a bridge --------------------------------
  // This is the one that would be easy to get wrong: a bridge is a shortcut,
  // and a shortcut that ignores the avoid list is worse than no shortcut.
  const avoided = route("1DQ1-A", "Jita", "shortest", planner.resolveAvoid("Amamake", ""), emptyLimits(), network);
  t.check(!avoided.systems.some(system => system.name === "Amamake"),
    "a system on the avoid list is not entered by bridge");
  t.check(avoided.jumps > bridged.jumps,
    `so the route is longer again (${avoided.jumps} against ${bridged.jumps})`);

  const highSecOnly = route("Jita", "Amarr", "shortest", emptyAvoid(), planner.resolveLimits("0.5", ""), network);
  t.check(highSecOnly.systems.every(system => system.security >= 0.45),
    "a security minimum holds across a bridged search too");

  // Origin and destination checks must still fire with bridges supplied.
  t.throws(() => route("Amamake", "Jita", "shortest", planner.resolveAvoid("Amamake", ""), emptyLimits(), network),
    "Origin", "an origin on the avoid list is still refused");

  // --- the unreachable message -------------------------------------------------
  // Claiming "no stargate route" when bridges were searched too understates
  // what was tested.
  // Both endpoints must pass the limits, or the endpoint check fires first and
  // the search - the thing under test - never runs. Jita and Amarr both clear a
  // 0.9 minimum; nothing between them does.
  let message = "";
  try {
    route("Jita", "Amarr", "shortest", emptyAvoid(), planner.resolveLimits("0.9", ""), network);
  } catch (error) {
    message = error.message;
  }
  t.check(message.length > 0, "an impossible route still throws");
  t.check(/bridge/.test(message), "and the message says bridges were considered as well as gates");
  let plainMessage = "";
  try {
    route("Jita", "Amarr", "shortest", emptyAvoid(), planner.resolveLimits("0.9", ""));
  } catch (error) {
    plainMessage = error.message;
  }
  t.check(!/bridge/.test(plainMessage), "while with no bridges supplied it does not claim they were");

  // --- same system --------------------------------------------------------------
  const nowhere = route("Jita", "Jita", "shortest", emptyAvoid(), emptyLimits(), network);
  t.equal(nowhere.jumps, 0, "a route to where you already are is no jumps");
  t.equal(nowhere.legKinds.length, 0, "and has no legs");
  t.equal(nowhere.bridgeJumps, 0, "and uses no bridges");

  return t.results;
}
