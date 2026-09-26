// End-to-end render checks. The other modules exercise pieces; this one drives
// the real entry points the browser calls, which is where a mistake in wiring
// rather than in logic would hide.

import { readArchive, readRegion, suite } from "./helpers.mjs";
import { RoutePlanner } from "../web/route-planner.js";
import { TacticalAnalyzer } from "../web/tactical-analyzer.js";

export default function run(app) {
  const t = suite("render");
  const atlas = readArchive();
  const { state } = app;
  const ui = id => document.getElementById(id);
  const viewport = ui("viewport");
  const index = Object.values(atlas.regions)
    .filter(r => r.systems.length)
    .map(r => ({ name: r.name, system_count: r.system_count, region_id: r.region_id }));

  state.atlas = atlas;
  state.index = index;
  state.routePlanner = new RoutePlanner(atlas);
  state.tacticalAnalyzer = new TacticalAnalyzer(atlas);
  state.route = null;
  state.routeIndex = null;
  state.avoid = null;
  state.limits = null;
  for (const id of ["avoidSystems", "avoidRegions", "routeMinSec", "routeMaxSec"]) ui(id).value = "";

  // --- universe -----------------------------------------------------------
  let threw = null;
  try { app.renderUniverse(); } catch (error) { threw = error.stack ?? error.message; }
  t.check(threw === null, `renderUniverse does not throw${threw ? ` (${threw.split("\n")[0]})` : ""}`);

  const regionNodes = viewport.querySelectorAll(".region-node");
  t.equal(regionNodes.length, 68, "68 region nodes are drawn");
  t.check(state.nodes.length === 68, "and state tracks the same 68");
  t.check(state.nodes.every(n => n.record.systems.some(id => atlas.systems[id]?.neighbors.length)),
    "every drawn region has at least one stargate");

  const texts = viewport.querySelectorAll("text");
  t.check(texts.length >= 40 && texts.length <= 68, `${texts.length} region labels drawn, between the culled floor and one per region`);
  t.check(viewport.querySelectorAll(".edge").length > 0, "region boundary edges are drawn");
  // Pair the number with its own label. "68" also occurs inside "5,268", so a
  // bare substring test passed even when the count was wrong.
  const metricPairs = [...ui("metrics").innerHTML.matchAll(/<strong>([^<]*)<\/strong><span>([^<]*)<\/span>/g)]
    .map(m => [m[2].trim(), m[1].trim()]);
  const metricFor = label => (metricPairs.find(pair => pair[0] === label) ?? [])[1];
  t.equal(metricFor("regions mapped"), String(regionNodes.length),
    "the header's region count is the number of region nodes actually drawn");
  t.equal(metricFor("stargate links"), atlas.jumps.length.toLocaleString(), "and its link count matches the archive");
  t.check(ui("eyebrow").textContent.includes("STARGATE"), "the eyebrow says what the view is");
  // Read the legend the app actually built, not an id lookup: legend()
  // creates its element and appends it to the stage.
  const legendHtml = () => globalThis.__mapStage.querySelectorAll(".legend").at(-1)?.innerHTML ?? "";
  t.check(legendHtml().length > 0, "a legend is drawn at all");
  t.check(!legendHtml().includes("W-space"), "the universe legend drops the W-space key");
  for (const key of ["Empire", "Null", "Special"]) {
    t.check(legendHtml().includes(key), `the universe legend keeps its ${key} key`);
  }

  // Repeat renders must not accumulate.
  app.renderUniverse();
  app.renderUniverse();
  t.equal(viewport.querySelectorAll(".region-node").length, 68, "re-rendering does not accumulate nodes");

  // --- region -------------------------------------------------------------
  state.region = readRegion("The Forge");
  threw = null;
  try { app.renderRegion(); } catch (error) { threw = error.stack ?? error.message; }
  t.check(threw === null, `renderRegion does not throw${threw ? ` (${threw.split("\n")[0]})` : ""}`);

  const systemNodes = viewport.querySelectorAll(".system-node");
  t.equal(systemNodes.length, Object.keys(state.region.systems).length, "one node per system in the region");
  t.check(viewport.querySelectorAll(".edge").length > 0, "internal gate links are drawn");
  t.equal(viewport.querySelectorAll(".gate-edge-halo").length, viewport.querySelectorAll(".edge").length,
    "every regional gate link receives a dark crossing casing");
  t.check(viewport.querySelectorAll(".edge").every(edge => edge.classList.contains("gate-edge")),
    "every regional gate link receives a bright channel style");
  t.check(viewport.querySelectorAll(".edge").every(edge => edge.getAttribute("data-edge-channel") !== null),
    "every regional gate link records its deterministic color channel");
  t.check(ui("constellations").innerHTML.includes("All constellations"), "the constellation filter is populated");
  t.check(ui("title").textContent === "The Forge", "the title names the region");

  // The unmeasured DOM shim has a root scale of one. Real container-scale
  // compensation and decluttering are covered separately and checked in-browser.
  const pinnedNode = systemNodes[0];
  t.check(pinnedNode.getAttribute("transform").includes("scale(1)"),
    "a system marker starts at its authored size");
  app.zoom(2);
  t.check(viewport.getAttribute("transform").includes("scale(2)"), "the map field zooms to 2x");
  t.check(pinnedNode.getAttribute("transform").includes("scale(0.5)"),
    "while the system marker counter-scales to stay the same screen size");
  app.zoom(.25);
  t.check(viewport.getAttribute("transform").includes("scale(0.5)"), "the map field can zoom below baseline");
  t.check(pinnedNode.getAttribute("transform").includes("scale(2)"),
    "markers also keep their screen size below baseline; density controls label visibility");
  app.resetView();

  // A wormhole region has no gates but must still open as a regional map.
  state.region = readRegion("A-R00001");
  threw = null;
  try { app.renderRegion(); } catch (error) { threw = error.stack ?? error.message; }
  t.check(threw === null, `a gateless region still renders${threw ? ` (${threw.split("\n")[0]})` : ""}`);
  t.check(viewport.querySelectorAll(".system-node").length > 0, "and draws its systems");

  // --- switching back and forth ------------------------------------------
  state.region = readRegion("The Forge");
  app.renderRegion();
  app.renderUniverse();
  t.equal(viewport.querySelectorAll(".system-node").length, 0, "leaving the region view clears its system nodes");
  t.equal(viewport.querySelectorAll(".region-node").length, 68, "and restores the region nodes");
  app.renderRegion();
  t.equal(viewport.querySelectorAll(".region-node").length, 0, "and back again the other way");

  // --- with a route active ------------------------------------------------
  const route = state.routePlanner.calculate("Jita", "Amarr", "shortest");
  state.route = route;
  state.routeIndex = app.buildRouteIndex(route);

  app.renderUniverse();
  t.check(viewport.querySelectorAll(".route-line").length > 0, "the route is drawn on the universe view");
  t.check(state.nodes.some(n => n.el.classList.contains("on-route")), "and its regions are marked");

  state.region = readRegion("The Forge");
  app.renderRegion();
  t.check(viewport.querySelectorAll(".route-line").length > 0, "the route is drawn on the regional view");
  t.check(viewport.querySelectorAll(".route-badge").length > 0, "with travel-order badges");
  app.zoom(2);
  t.check(viewport.querySelectorAll(".route-badge-group").every(badge => badge.getAttribute("transform").includes("scale(0.5)")),
    "and route badges remain screen-sized while the route spreads out");
  app.resetView();

  // --- regression: the Region tab calls renderRegion directly --------------
  // state.mode was set only inside loadRegion, so visiting the universe view
  // and returning via the tab left a regional map on screen with the mode
  // still reading "universe": the overlay drew the wrong branch and the
  // legend showed the wrong keys.
  app.renderUniverse();
  t.equal(state.mode, "universe", "the universe view sets its own mode");
  app.renderRegion();
  t.equal(state.mode, "region", "and so does the regional view, without help from its caller");
  t.check(viewport.querySelectorAll(".route-line").length > 0,
    "so a route still draws after arriving through the Region tab");
  t.check(viewport.querySelectorAll(".route-badge").length > 0, "badges included");

  // --- the inspector ------------------------------------------------------
  const jita = Object.values(state.region.systems).find(s => s.name === "Jita");
  threw = null;
  try { app.selectSystem(jita.system_id); } catch (error) { threw = error.stack ?? error.message; }
  t.check(threw === null, `selecting a system does not throw${threw ? ` (${threw.split("\n")[0]})` : ""}`);
  const panel = ui("inspectorContent").innerHTML;
  t.check(panel.includes("Jita"), "the inspector names the system");
  t.check(panel.includes("Where this sits"), "and shows where it sits in the network");
  // The labels a pilot reads, not the terms the archive computes. "Graph
  // position" and "Betweenness" were both here and both are graph theory; the
  // note under them had to spend its first sentence defining a word instead of
  // saying what to do about the number.
  t.check(panel.includes("Routes through here"), "including how many routes are forced through it");
  t.check(!/Betweenness/i.test(panel), "and no term of art a pilot would have to translate");
  t.check(panel.includes("Add to avoid list"), "and offers to exclude it");

  return t.results;
}
