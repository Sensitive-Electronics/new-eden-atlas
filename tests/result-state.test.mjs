import { readArchive, readShips, suite } from "./helpers.mjs";
import { JumpPlanner } from "../web/jump-planner.js";
import { RoutePlanner } from "../web/route-planner.js";
import { JUMP_FIELDS, RANGE_FIELDS, ROUTE_FIELDS, inputsKey, isStale, keyFor } from "../web/result-state.js";

export default function run(app) {
  const t = suite("result state");
  const { state } = app;
  const ui = id => document.getElementById(id);
  const set = o => { for (const [k, v] of Object.entries(o)) ui(k).value = v; };

  // --- the key itself -----------------------------------------------------
  t.equal(inputsKey({ a: "1", b: "2" }), inputsKey({ b: "2", a: "1" }),
    "the key does not depend on the order the fields are listed in");
  t.check(inputsKey({ a: "1", b: "2" }) !== inputsKey({ a: "2", b: "1" }),
    "but it does depend on which field holds which value");
  t.equal(inputsKey({ ship: " Jita " }), inputsKey({ ship: "jita" }),
    "case and surrounding space do not make a result stale");
  t.check(inputsKey({ ship: "Ark" }) !== inputsKey({ ship: "Avatar" }),
    "a different ship does");

  // Built rather than typed: writing the separators as literals in this file
  // risks them being flattened in transit, which would compare two identical
  // strings and assert nothing.
  const UNIT = String.fromCharCode(31);
  const RECORD = String.fromCharCode(30);
  t.check(inputsKey({ a: "x", b: "" }) !== inputsKey({ [`a${UNIT}x${RECORD}b`]: "" }),
    "a field name cannot be forged out of separators in a value");
  t.check(inputsKey({ a: `x${UNIT}b${UNIT}` }) !== inputsKey({ a: "x", b: "" }),
    "and a value carrying separators is not the same as two fields");

  t.check(inputsKey({ highSec: true }) !== inputsKey({ highSec: false }),
    "booleans are distinguished");
  t.check(inputsKey({ x: null }) !== inputsKey({ x: "" }),
    "and an absent value is not the same as an empty one");
  t.equal(inputsKey(null), "", "a missing snapshot is an empty key rather than a throw");

  t.check(!isStale(null, "anything"),
    "a result with no recorded key predates the mechanism and is left alone");
  t.check(!isStale("same", "same"), "an unchanged key is not stale");
  t.check(isStale("before", "after"), "a changed one is");

  // Range does not depend on destination, fuel conservation or the fuel
  // module. If it did, changing them would throw away a still-valid result.
  const base = { from: "Jita", to: "Amarr", ship: "Ark", calibration: "5", conservation: "5", hullSkill: "5", fuelModule: "", highSec: false };
  t.equal(keyFor(RANGE_FIELDS, base), keyFor(RANGE_FIELDS, { ...base, to: "Dodixie", conservation: "1", fuelModule: "99" }),
    "a range survives changes to destination, conservation and fuel module");
  t.check(keyFor(RANGE_FIELDS, base) !== keyFor(RANGE_FIELDS, { ...base, ship: "Avatar" }),
    "but not a change of hull");
  t.check(keyFor(RANGE_FIELDS, base) !== keyFor(RANGE_FIELDS, { ...base, calibration: "1" }),
    "nor of Jump Drive Calibration, which moves the boundary");
  t.check(keyFor(JUMP_FIELDS, base) !== keyFor(JUMP_FIELDS, { ...base, conservation: "1" }),
    "a jump plan, which reports fuel, does depend on conservation");
  const routeBase = { from: "Jita", to: "Amarr", mode: "shortest", avoidSystems: "", avoidRegions: "", minSec: "", maxSec: "" };
  t.check(keyFor(ROUTE_FIELDS, routeBase) !== keyFor(ROUTE_FIELDS, { ...routeBase, avoidSystems: "Tama" }),
    "and a route depends on what it was told to avoid");

  // --- the two reproductions from the review ------------------------------
  const atlas = readArchive();
  state.atlas = atlas;
  state.routePlanner = new RoutePlanner(atlas);
  state.jumpPlanner = new JumpPlanner(atlas, readShips());
  state.mode = "universe";
  state.nodes = [];
  state.positions = null;

  // 1. "calculate Jita to Perimeter, then enter not-a-real-system in Systems
  //    to avoid and calculate again". Validation reported the error and left
  //    the previous route highlighted and its one-jump result on screen.
  set({ routeFrom: "Jita", routeTo: "Perimeter", routeMode: "shortest", avoidSystems: "", avoidRegions: "", routeMinSec: "", routeMaxSec: "" });
  app.calculateRoute();
  t.check(state.route !== null, "a valid route is calculated");
  t.equal(state.route && state.route.jumps, 1, "Jita to Perimeter is one jump");
  t.check(state.routeInputs !== null && state.routeInputs !== undefined,
    "and records the inputs that produced it");

  set({ avoidSystems: "not-a-real-system" });
  app.calculateRoute();
  t.check(ui("routeError").textContent.length > 0, "an unresolvable avoid entry reports an error");
  t.equal(state.route, null, "and the previous route is gone, not left looking current");
  t.equal(state.routeIndex, null, "with its map overlay index dropped too");
  t.equal(state.routeInputs, null, "and its recorded inputs cleared");

  // 2. "show Panther range from Jita ... then select Avatar". The summary
  //    changed to 6.00 ly while the inspector and overlay kept Panther's
  //    8.00 ly result and its 62 reachable systems.
  set({ avoidSystems: "", jumpFrom: "Jita", jumpShip: "Panther", jumpCalibration: "5", jumpHullSkill: "5" });
  ui("jumpHighSec").checked = false;
  app.toggleRangeRings();
  t.check(state.range !== null, "a jump range is produced");
  t.equal(state.range && state.range.ship.name, "Panther", "for the hull named in the form");
  const pantherReach = state.range ? state.range.systemIds.size : 0;

  set({ jumpShip: "Avatar" });
  t.check(app.invalidateStaleResults(), "changing hull invalidates something");
  t.equal(state.range, null, "the previous hull's range is cleared rather than left on the map");
  t.equal(state.rangeInputs, null, "along with its recorded inputs");

  // And the replacement really is a different answer, so this was never a
  // distinction without a difference.
  app.toggleRangeRings();
  t.check(state.range !== null && state.range.ship.name === "Avatar",
    "the new hull's range can then be shown");
  t.check(state.range && state.range.systemIds.size !== pantherReach,
    `and reaches a different number of systems (${state.range ? state.range.systemIds.size : "none"} against the Panther's ${pantherReach})`);
  app.clearRangeRings();

  // A result must survive a change that cannot affect it, or the mechanism is
  // just clearing things at random.
  set({ jumpFrom: "Jita", jumpShip: "Panther", jumpCalibration: "5", jumpHullSkill: "5" });
  app.toggleRangeRings();
  t.check(state.range !== null, "a range is shown again");
  set({ jumpTo: "Amarr", jumpConservation: "1" });
  t.check(!app.invalidateStaleResults(), "changing destination and conservation invalidates nothing");
  t.check(state.range !== null, "so the range stays up");
  app.clearRangeRings();

  // A failed request must not leave a previous answer drawn. The control is a
  // toggle, so the range is dismissed first: asking for one while another is
  // displayed is a request to hide it, not to recompute.
  set({ jumpFrom: "Jita", jumpShip: "Panther" });
  app.toggleRangeRings();
  t.check(state.range !== null, "a range is shown");
  app.clearRangeRings();
  set({ jumpShip: "no-such-hull" });
  app.toggleRangeRings();
  t.check(ui("jumpError").textContent.length > 0, "an unknown hull reports an error");
  t.equal(state.range, null, "and draws no range at all");

  // The wiring, not just the function. Everything above calls
  // invalidateStaleResults directly, which would keep passing if the change
  // handlers that call it were removed, so the real events are dispatched here.
  app.bindJump();
  set({ jumpFrom: "Jita", jumpShip: "Panther", jumpCalibration: "5", jumpHullSkill: "5" });
  app.toggleRangeRings();
  t.check(state.range !== null, "a range is displayed");
  set({ jumpShip: "Avatar" });
  document.getElementById("jumpShip").dispatch("change");
  t.equal(state.range, null, "and a change event on the hull selector clears it, without anyone calling in by hand");

  // bindRoutePlanner restores saved settings, so the fields are set after it.
  app.bindRoutePlanner();
  set({ routeFrom: "Jita", routeTo: "Perimeter", routeMode: "shortest", avoidSystems: "", avoidRegions: "", routeMinSec: "", routeMaxSec: "" });
  app.calculateRoute();
  t.check(state.route !== null, "a route is displayed");
  set({ routeMode: "safer" });
  document.getElementById("routeMode").dispatch("change");
  t.equal(state.route, null, "and changing the routing mode clears it too");

  set({ routeMode: "shortest" });
  app.calculateRoute();
  t.check(state.route !== null, "a route is displayed again");
  set({ avoidSystems: "Tama" });
  document.getElementById("avoidSystems").dispatch("change");
  t.equal(state.route, null, "editing the avoid list clears it, since it may no longer be the route that list allows");

  app.calculateRoute();
  t.check(state.route !== null, "and again");
  set({ routeMinSec: "0.5" });
  document.getElementById("routeMinSec").dispatch("change");
  t.equal(state.route, null, "as does tightening a security limit");

  set({ routeMinSec: "" });
  app.calculateRoute();
  t.check(state.route !== null, "once more");
  set({ routeTo: "Amarr" });
  document.getElementById("routeTo").dispatch("change");
  t.equal(state.route, null, "and retyping the destination clears a route to somewhere else");

  // The jump origin does the same to a displayed range: a range drawn around
  // Jita means nothing once the form says it starts somewhere else.
  set({ jumpFrom: "Jita", jumpShip: "Panther" });
  app.toggleRangeRings();
  t.check(state.range !== null, "a range is drawn around the origin in the form");
  set({ jumpFrom: "Amarr" });
  document.getElementById("jumpFrom").dispatch("change");
  t.equal(state.range, null, "and changing that origin clears it");

  state.route = null;
  state.routeIndex = null;
  state.routeInputs = null;
  state.range = null;
  state.rangeInputs = null;
  state.jump = null;
  state.jumpIndex = null;
  ui("routeError").textContent = "";
  ui("jumpError").textContent = "";
  return t.results;
}
