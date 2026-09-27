import { readArchive, readRegion, readShips, suite } from "./helpers.mjs";
import { JumpPlanner } from "../web/jump-planner.js";
import { RoutePlanner, displayedSecurity } from "../web/route-planner.js";
import { project, relaxSystems, securityClass } from "../web/map-utils.js";

export default function run(app) {
  const t = suite("map overlay");
  const atlas = readArchive();
  const forge = readRegion("The Forge");
  const planner = new RoutePlanner(atlas);
  const { state } = app;
  const ui = id => document.getElementById(id);
  const viewport = ui("viewport");
  const set = o => { for (const [k, v] of Object.entries(o)) ui(k).value = v; };
  const count = sel => viewport.querySelectorAll(sel).length;
  const marked = cls => state.nodes.filter(n => n.el.classList.contains(cls)).length;

  function mountRegion(name) {
    const data = readRegion(name);
    const systems = Object.values(data.systems);
    viewport.replaceChildren();
    state.mode = "region";
    state.region = data;
    state.positions = relaxSystems(systems, project(systems, s => [s.position[0], -s.position[2]], 1120, 700, 80));
    state.nodes = systems.map(s => {
      const el = document.createElementNS(null, "g");
      el.className = "system-node";
      viewport.appendChild(el);
      return { el, record: s };
    });
    return data;
  }
  function mountUniverse() {
    const regions = Object.values(atlas.regions).filter(r => r.systems.length && r.position.some(Boolean));
    viewport.replaceChildren();
    state.mode = "universe";
    state.positions = project(regions, r => [r.position[0], -r.position[2]]);
    state.nodes = regions.map(r => {
      const el = document.createElementNS(null, "g");
      el.className = "region-node";
      viewport.appendChild(el);
      return { el, record: r };
    });
  }

  state.atlas = atlas;
  state.routePlanner = planner;
  state.jump = null;
  state.jumpIndex = null;
  state.avoid = null;
  state.limits = null;
  const route = planner.calculate("Jita", "Amarr", "shortest");
  state.route = route;
  state.routeIndex = app.buildRouteIndex(route);

  // --- route drawing ------------------------------------------------------
  mountRegion("The Forge");
  app.renderOverlay();
  let hops = 0;
  for (let i = 1; i < route.systems.length; i += 1) {
    if (forge.systems[route.systems[i - 1].system_id] && forge.systems[route.systems[i].system_id]) hops += 1;
  }
  const inForge = route.systems.filter(s => forge.systems[s.system_id]);
  t.equal(count(".route-line"), hops, "one segment per in-region hop");
  t.equal(count(".route-halo"), hops, "each segment has its halo");
  t.equal(count(".route-badge"), inForge.length, "one badge per route system in view");
  t.equal(marked("on-route"), inForge.length, "and the nodes are marked");
  t.equal(marked("excluded"), 0, "nothing is excluded without constraints");

  // Derived from the route's own system sequence, NOT from buildRouteIndex.
  // Taking the expected value from the index meant a badge that always read
  // "00" still passed, because both sides came from the same broken source.
  const labels = viewport.querySelectorAll(".route-badge-text").map(n => Number(n.textContent)).sort((a, b) => a - b);
  const expectedSteps = route.systems
    .map((system, position) => ({ system, position }))
    .filter(entry => forge.systems[entry.system.system_id])
    .map(entry => entry.position)
    .sort((a, b) => a - b);
  t.equal(JSON.stringify(labels), JSON.stringify(expectedSteps),
    "badge labels are the systems' positions in the route itself");
  t.check(new Set(labels).size === labels.length, "and no two badges carry the same number");

  // Endpoint marking, which nothing tested: swapping origin and destination
  // in buildRouteIndex previously changed nothing observable.
  const endpoints = state.nodes.filter(n => n.el.classList.contains("route-endpoint")).map(n => n.record.name);
  t.equal(endpoints.join(","), "Jita", "the origin is marked as an endpoint, and only the origin is in this region");

  // Which end is which, not merely that both are endpoints. Marking uses one
  // class for both, so swapping them in buildRouteIndex changed nothing
  // observable until this pinned the two apart.
  t.equal(state.routeIndex.originId, route.systems[0].system_id, "the index's origin is the route's first system");
  t.equal(state.routeIndex.destinationId, route.systems.at(-1).system_id, "and its destination is the last");
  t.equal(state.routeIndex.order.get(state.routeIndex.originId), 0, "the origin carries step 0");
  t.equal(state.routeIndex.order.get(state.routeIndex.destinationId), route.systems.length - 1,
    "and the destination carries the final step");

  const kids = viewport.children;
  t.check(kids.indexOf(viewport.querySelector(".route-lines")) < kids.findIndex(k => k.classList.contains("system-node")),
    "segments are drawn beneath the nodes");
  t.equal(kids.indexOf(viewport.querySelector(".route-marks")), kids.length - 1, "badges are drawn above everything");

  app.renderOverlay();
  app.renderOverlay();
  t.equal(count(".route-line"), hops, "re-rendering does not duplicate segments");
  t.equal(viewport.querySelectorAll(".route-layer").length, 2, "nor layers");

  mountRegion("Delve");
  app.renderOverlay();
  t.check(count(".route-line") === 0 && marked("on-route") === 0, "a region the route never enters draws nothing");

  mountUniverse();
  app.renderOverlay();
  t.equal(count(".route-line"), state.routeIndex.regionOrder.length - 1, "the universe view links the regions crossed");
  t.equal(marked("on-route"), state.routeIndex.regionIds.size, "and marks each one");
  t.equal(count(".route-badge"), 0, "without step badges at that level");

  // --- capital chain drawing ---------------------------------------------
  const capital = new JumpPlanner(atlas, readShips());
  const jump = capital.plan("Jita", "1DQ1-A", { shipValue: "Panther" });
  state.route = null;
  state.routeIndex = null;
  state.jump = jump;
  state.jumpIndex = app.buildRouteIndex(jump);
  mountUniverse();
  app.renderOverlay();
  t.equal(viewport.querySelector(".jump-overlay.route-lines")?.querySelectorAll(".route-line").length,
    state.jumpIndex.regionOrder.length - 1,
    "the universe map draws every capital region transition");
  t.equal(marked("on-jump"), state.jumpIndex.regionIds.size, "and marks every region in the jump chain");
  t.check(count(".jump-overlay") === 2, "capital lines and marks carry a distinct jump overlay class");
  app.legend("universe");
  t.check(globalThis.__mapStage.querySelectorAll(".legend").at(-1)?.innerHTML.includes("Jump plan"),
    "the legend identifies a capital plan separately from a stargate route");

  state.jump = null;
  state.jumpIndex = null;
  state.route = route;
  state.routeIndex = app.buildRouteIndex(route);

  // --- inconsistent state -------------------------------------------------
  // renderOverlay once guarded on routeIndex but dereferenced state.route.
  mountRegion("The Forge");
  for (const [label, setup] of [
    ["an index without a route", () => { state.routeIndex = app.buildRouteIndex(route); state.route = null; }],
    ["a route without an index", () => { state.route = route; state.routeIndex = null; }],
    ["no positions", () => { state.route = route; state.routeIndex = app.buildRouteIndex(route); state.positions = null; }],
    ["neither", () => { state.route = null; state.routeIndex = null; }],
  ]) {
    mountRegion("The Forge");
    setup();
    let threw = null;
    try { app.renderOverlay(); } catch (error) { threw = error.message; }
    t.check(threw === null, `${label} does not throw${threw ? ` (${threw})` : ""}`);
    t.equal(viewport.querySelectorAll(".route-layer").length, 0, `${label} draws no route layers`);
  }

  // --- exclusion marks ----------------------------------------------------
  mountRegion("The Forge");
  state.route = route;
  state.routeIndex = app.buildRouteIndex(route);
  set({ avoidSystems: "Ikuchi, Ansila", avoidRegions: "", routeMinSec: "", routeMaxSec: "" });
  app.refreshAvoid();
  t.equal(marked("excluded"), 2, "an avoid list greys exactly its entries");

  set({ avoidSystems: "", routeMinSec: "0.5" });
  app.refreshAvoid();
  const blocked = state.nodes.filter(n => displayedSecurity(n.record.security) < 0.5).length;
  t.equal(marked("excluded"), blocked, "a security limit greys every system below it");
  t.check(state.nodes.every(n =>
    n.el.classList.contains("excluded") === planner.isBlocked(n.record.system_id, state.avoid, state.limits)),
    "every mark agrees with the router's own traversal predicate");

  const band = state.nodes.filter(n => n.record.security >= 0.45 && n.record.security < 0.5);
  t.check(band.length > 0 && band.every(n => !n.el.classList.contains("excluded")),
    `the ${band.length} systems displaying 0.5 on a lower raw value are admitted by a 0.5 minimum`);
  t.check(band.every(n => securityClass(n.record.security) === "high"), "and classify as high security");

  set({ avoidSystems: "Jita" });
  app.refreshAvoid();
  t.equal(marked("excluded"), blocked + 1, "avoid entries and limits combine without double counting");

  set({ avoidSystems: "", avoidRegions: "", routeMinSec: "notanumber", routeMaxSec: "" });
  app.refreshAvoid();
  t.check(state.limits === null, "an unresolvable limit resolves to nothing");
  t.equal(marked("excluded"), 0, "and greys nothing rather than greying the wrong thing");
  t.check(ui("limitsSummary").innerHTML.includes(">!<"), "the summary carries a warning marker");

  set({ routeMinSec: "0.5" });
  app.refreshAvoid();
  t.equal(marked("excluded"), blocked, "marks return once the limit resolves again");

  // --- clearing -----------------------------------------------------------
  app.clearRoute();
  t.check(state.route === null && count(".route-layer") === 0, "clearing removes the route");
  t.check(state.limits && state.limits.min === 0.5, "but keeps the limits");
  t.check(marked("excluded") === blocked, "and keeps the exclusion marks");

  mountUniverse();
  set({ avoidRegions: "Delve", routeMinSec: "0.5" });
  app.refreshAvoid();
  t.equal(marked("excluded"), 1, "a security limit never greys a whole region, only an avoided one does");

  // --- legend -------------------------------------------------------------
  // The legend is the only thing telling a pilot what the grey dashes and
  // the magenta line mean, so it must track the overlay exactly.
  const legendHtml = () => globalThis.__mapStage.querySelectorAll(".legend").at(-1)?.innerHTML ?? "";
  set({ avoidSystems: "", avoidRegions: "", routeMinSec: "", routeMaxSec: "" });
  app.clearRoute();
  app.refreshAvoid();
  t.check(!legendHtml().includes("Excluded"), "no Excluded entry without constraints");
  t.check(!legendHtml().includes("Route"), "no Route entry without a route");

  set({ avoidRegions: "Delve" });
  app.refreshAvoid();
  t.check(legendHtml().includes("Excluded"), "an avoid entry adds the Excluded key");
  set({ avoidRegions: "", routeMinSec: "0.5" });
  app.refreshAvoid();
  t.check(legendHtml().includes("Excluded"), "a security limit alone also adds it");

  state.route = route;
  state.routeIndex = app.buildRouteIndex(route);
  app.refreshAvoid();
  t.check(legendHtml().includes("Route") && legendHtml().includes("Excluded"), "both keys show together");
  t.equal(globalThis.__mapStage.querySelectorAll(".legend").length, 1, "legends replace rather than stack");

  set({ routeMinSec: "" });
  app.refreshAvoid();
  t.check(!legendHtml().includes("Excluded"), "the Excluded key goes when the last constraint does");
  t.check(legendHtml().includes("Route"), "while the Route key survives");

  return t.results;
}
