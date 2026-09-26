// Answers that stayed on screen after the question changed.
//
// These were found by asking, of every panel, "what happens if the thing this
// describes moves while it is being looked at". They are one failure wearing
// several faces: something is computed, drawn, and then never asked again, so
// the interface keeps asserting a fact that has stopped being true.
//
// That is worse here than in most applications. A stale number on a dashboard
// is an annoyance; a route drawn through a system the pilot has just excluded
// is the tool confidently saying the opposite of what it knows, and it says it
// with no age against it, because nothing knew the value had aged at all.
//
// The suite shares one DOM and one module instance, so this file puts back
// every field and every piece of state it touches.

import { readArchive, suite } from "./helpers.mjs";
import { RoutePlanner } from "../web/route-planner.js";
import { clearOverride, setOverride } from "../web/overrides.js";

export default function run(app) {
  const t = suite("stale results");
  const { state } = app;
  const ui = id => document.getElementById(id);

  const saved = {
    atlas: state.atlas,
    routePlanner: state.routePlanner,
    route: state.route,
    threat: state.threat,
    from: ui("routeFrom").value,
    to: ui("routeTo").value,
    mode: ui("routeMode").value,
    heat: ui("routeHeat")?.value ?? "",
    avoidSystems: ui("avoidSystems").value,
    avoidRegions: ui("avoidRegions").value,
    minSec: ui("routeMinSec").value,
    maxSec: ui("routeMaxSec").value,
    staging: ui("threatStaging")?.value ?? "",
  };

  return (async () => {
    try {
      const atlas = readArchive();
      state.atlas = atlas;
      state.routePlanner = new RoutePlanner(atlas);
      ui("avoidSystems").value = "";
      ui("avoidRegions").value = "";
      ui("routeMinSec").value = "";
      ui("routeMaxSec").value = "";
      if (ui("routeHeat")) ui("routeHeat").value = "off";
      ui("routeFrom").value = "Jita";
      ui("routeTo").value = "Amarr";
      ui("routeMode").value = "shortest";
      app.refreshAvoid();
      app.calculateRoute();

      const before = state.route;
      t.check(before?.systems?.length > 2,
        `a route is drawn (${before?.jumps ?? "none"} jumps)`);
      if (!before) return t.results;

      // --- naming a system to avoid must move the route off it ------------------
      const onRoute = before.systems[Math.floor(before.systems.length / 2)];
      // The name, which is what the field holds and what the only real caller
      // passes. An id put there resolves to nothing and fails the whole route.
      app.addAvoidSystem(onRoute.name);
      t.check(state.route !== before,
        "naming a system to avoid recalculates rather than leaving the old line drawn");
      t.check(!state.route.systems.some(s => s.system_id === onRoute.system_id),
        `and the route no longer crosses ${onRoute.name}, which was marked forbidden and routed through at once`);

      ui("avoidSystems").value = "";
      app.refreshAvoid();
      app.calculateRoute();

      // --- swapping the ends must not leave the old route drawn ------------------
      const outbound = state.route;
      const from = ui("routeFrom").value;
      const to = ui("routeTo").value;
      const swap = ui("swapRoute");
      t.check(typeof swap?.onclick === "function", "the swap control is bound");
      swap.onclick();
      t.equal(ui("routeFrom").value, to, "the fields swap");
      t.equal(ui("routeTo").value, from, "both of them");
      t.check(state.route !== outbound,
        "and the result is recomputed rather than left standing under swapped endpoints");
      t.equal(state.route.origin.name, to, "so the drawn route starts where the field now says");
      t.equal(state.route.destination.name, from, "and ends where the other one does");

      // --- a suspended avoidance list is still a standing order -----------------
      // routeProtestPanel exists because "saying nothing would present a route
      // that breaks a standing order as an ordinary one". Switching the list
      // off produced exactly that: the route crossed an avoided system, no
      // section appeared, and the only trace was a toggle label elsewhere on
      // screen. A pilot reading the panel had no way to know the list was not
      // being applied.
      ui("routeFrom").value = "Jita";
      ui("routeTo").value = "Amarr";
      app.calculateRoute();
      const crossed = state.route.systems[5].name;
      ui("avoidSystems").value = crossed;
      app.refreshAvoid();
      app.calculateRoute();
      t.check(!state.route.systems.some(s => s.name === crossed),
        `with the list on, the route avoids ${crossed}`);
      t.equal(state.route.avoidanceSuspended, 0, "and reports nothing suspended");

      app.setAvoidance(false);
      t.check(state.route.systems.some(s => s.name === crossed),
        "with the list off, the route crosses it again");
      t.equal(state.route.avoidanceSuspended, 1, "and the route records that one entry was not applied");
      const offPanel = ui("inspectorContent").innerHTML.replace(/<[^>]*>/g, " ");
      t.check(/Avoidance is off/.test(offPanel),
        "which the panel says, rather than presenting an ordinary-looking route");
      t.check(/not being applied/.test(offPanel), "naming what it means for this route");

      app.setAvoidance(true);
      const onPanel = ui("inspectorContent").innerHTML.replace(/<[^>]*>/g, " ");
      t.check(!/Avoidance is off/.test(onPanel), "and the note goes away when the list is back on");
      ui("avoidSystems").value = "";
      app.refreshAvoid();
      app.setAvoidance(false);
      t.equal(state.route.avoidanceSuspended, 0,
        "an empty list suspends nothing even when switched off");

      // --- and the other list, which was not counted at all ----------------------
      //
      // Two things feed the avoidance list: names typed under Route limits, and
      // the persistent entries a pilot adds from a system's own panel with
      // "Avoid for a day". Only the typed ones were counted, so a pilot who had
      // never typed anything got precisely the case above - a route crossing a
      // system they had asked to avoid, with nothing on the panel saying so.
      // Found in a browser, not here, because every test of this reached for
      // the text field.
      const avoided = state.route.systems[5];
      setOverride(state.overrides, { target: "system", key: avoided.system_id, strength: "hard" });
      app.setAvoidance(true);
      app.calculateRoute();
      t.check(!state.route.systems.some(s => s.system_id === avoided.system_id),
        `a persistent entry moves the route off ${avoided.name}`);
      t.equal(state.route.avoidanceSuspended, 0, "and suspends nothing while the list is on");

      app.setAvoidance(false);
      t.check(state.route.systems.some(s => s.system_id === avoided.system_id),
        "switching the list off crosses it again");
      t.equal(state.route.avoidanceSuspended, 1,
        "and the panel counts the persistent entry, not only the typed ones");
      t.check(/Avoidance is off/.test(ui("inspectorContent").innerHTML.replace(/<[^>]*>/g, " ")),
        "so the section appears for a pilot who never typed anything");

      // Both sources naming the same place is one place the route may cross.
      // Counting it twice would overstate what has been suspended.
      ui("avoidSystems").value = avoided.name;
      app.refreshAvoid();
      app.calculateRoute();
      t.equal(state.route.avoidanceSuspended, 1,
        "a system both typed and set to avoid counts once, not twice");

      // A typed name that resolves to nothing is still an entry the pilot wrote
      // and the route is not applying, and cannot collide with an id.
      ui("avoidSystems").value = `${avoided.name}, Nowhere-At-All`;
      app.refreshAvoid();
      app.calculateRoute();
      t.equal(state.route.avoidanceSuspended, 2,
        "while a name that resolves to nothing still counts as suspended");

      // Trust is the opposite of avoidance and must not inflate the count.
      setOverride(state.overrides, { target: "system", key: 30000142, state: "confirmed" });
      app.calculateRoute();
      t.equal(state.route.avoidanceSuspended, 2, "a confirmed entry is not an avoided one");
      clearOverride(state.overrides, "system", 30000142);

      clearOverride(state.overrides, "system", avoided.system_id);
      ui("avoidSystems").value = "";
      app.refreshAvoid();
      app.calculateRoute();
      t.equal(state.route.avoidanceSuspended, 0, "and clearing both sources empties the count");
      app.setAvoidance(true);

      // --- a refused threat request must not leave the old envelope marked -------
      if (ui("threatStaging")) {
        ui("threatStaging").value = "Jita";
        app.runThreat();
        t.check(state.threat, "a staging system that resolves produces a threat envelope");
        ui("threatStaging").value = "Jitaa";
        app.runThreat();
        t.equal(state.threat, null,
          "a name matching nothing clears the envelope rather than leaving the last one on the map");
        t.check(/no single system matches/.test(ui("threatError").textContent),
          "and says why, so the empty map is an answer rather than a blank");
      }

      return t.results;
    } finally {
      ui("routeFrom").value = saved.from;
      ui("routeTo").value = saved.to;
      ui("routeMode").value = saved.mode;
      if (ui("routeHeat")) ui("routeHeat").value = saved.heat;
      ui("avoidSystems").value = saved.avoidSystems;
      ui("avoidRegions").value = saved.avoidRegions;
      ui("routeMinSec").value = saved.minSec;
      ui("routeMaxSec").value = saved.maxSec;
      if (ui("threatStaging")) ui("threatStaging").value = saved.staging;
      app.refreshAvoid();
      app.clearThreat();
      app.clearRoute();
      state.atlas = saved.atlas;
      state.routePlanner = saved.routePlanner;
      state.route = saved.route;
      state.threat = saved.threat;
    }
  })();
}
