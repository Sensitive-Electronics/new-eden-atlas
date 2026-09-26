// Capital range rings.
//
// The highlighting is the feature and is computed from real three-dimensional
// distance. The ring itself is a flat guide drawn on a flat map; it is not
// treated as authoritative and nothing depends on its precision.

import { readArchive, readRegion, readShips, suite } from "./helpers.mjs";
import { JumpPlanner, METERS_PER_LIGHT_YEAR } from "../web/jump-planner.js";
import { projectionOf } from "../web/map-utils.js";
import { VIEW_BOXES } from "../web/camera.js";
import { SYSTEM_NODE_HEIGHT } from "../web/edge-routing.js";

export default function run(app) {
  const t = suite("range rings");
  const atlas = readArchive();
  const planner = new JumpPlanner(atlas, readShips());
  const [BOX_W, BOX_H] = VIEW_BOXES.universe;

  const regions = Object.values(atlas.regions)
    .filter(r => r.systems.length && r.position.some(Boolean) && r.systems.some(id => atlas.systems[id]?.neighbors.length));
  const projection = projectionOf(regions, r => [r.position[0], -r.position[2]], BOX_W, BOX_H, 40);
  t.check(Number.isFinite(projection.scale * METERS_PER_LIGHT_YEAR) && projection.scale > 0,
    "the universe projection yields a usable pixels-per-light-year scale");

  // --- what gets highlighted ---------------------------------------------
  const jita = planner.resolveSystem("Jita");
  const ark = planner.resolveShip("Ark");
  const range = planner.rangeFor(ark, 5);
  const set = planner.rangeSet(jita.system_id, range, { allowHighSec: true });

  t.check(set.systemIds.size > 0, `${set.systemIds.size} systems lie within ${range} ly of Jita`);
  t.equal(set.systemIds.size, set.entries.length, "the set and the entry list agree");
  t.check(set.entries.every(e => e.distanceLy <= range + 1e-9),
    "every highlighted system is genuinely within range, by real distance");
  // The origin is the one system within range that is deliberately absent:
  // you do not jump to where you already are.
  t.check(planner.jumpable.every(s => s.system_id === jita.system_id
    || set.systemIds.has(s.system_id) === (!planner.isRestrictedArrival(s)
      && planner.distanceLy(jita.system_id, s.system_id) <= range)),
    "and nothing else in range is left out");
  t.check(!set.systemIds.has(jita.system_id), "the origin is not offered as its own destination");
  t.check([...set.regionIds].every(id => set.entries.some(e => e.system.region_id === id)),
    "every marked region holds at least one in-range system");
  t.check(set.entries.every((e, i) => i === 0 || set.entries[i - 1].distanceLy <= e.distanceLy),
    "entries are ordered nearest first");
  t.check(planner.rangeSet(jita.system_id, range, { allowHighSec: false }).systemIds.size < set.systemIds.size,
    "excluding high security reduces the set");
  t.check(planner.rangeSet(jita.system_id, 3).systemIds.size < set.systemIds.size,
    "a shorter range reaches fewer systems");

  // --- the interface ------------------------------------------------------
  if (app) {
    const ui = id => document.getElementById(id);
    const { state } = app;
    const viewport = ui("viewport");

    state.atlas = atlas;
    state.index = regions.map(r => ({ name: r.name, system_count: r.system_count, region_id: r.region_id }));
    state.jumpPlanner = planner;
    state.route = null;
    state.routeIndex = null;
    state.range = null;
    app.renderUniverse();

    ui("jumpShip").value = "Ark";
    ui("jumpFrom").value = "Jita";
    ui("jumpCalibration").value = "5";
    ui("jumpHighSec").checked = false;
    app.toggleRangeRings();

    t.equal(ui("jumpError").textContent, "", "showing the range reports no error");
    t.check(state.range !== null, "the range is held in state");
    t.equal(viewport.querySelectorAll(".range-ring").length, 1, "a ring is drawn");

    // The radius itself, which nothing checked: a ring drawn ten times too
    // large passed every previous assertion because they only counted elements.
    const ring = viewport.querySelector(".range-ring");
    const drawn = Number(ring.getAttribute("r"));
    const expected = state.range.rangeLy * projection.scale * METERS_PER_LIGHT_YEAR;
    t.check(Math.abs(drawn - expected) < 0.5,
      `the ring radius is ${drawn.toFixed(1)}px, the ${state.range.rangeLy} ly range at this projection (${expected.toFixed(1)}px)`);
    t.check(drawn > 0 && Number.isFinite(drawn), "and is a real positive radius");

    // Its centre is the origin SYSTEM, not the centre of the origin's region.
    const centre = projection.toScreen([jita.position[0], -jita.position[2]]);
    t.check(Math.abs(Number(ring.getAttribute("cx")) - centre.x) < 0.5
      && Math.abs(Number(ring.getAttribute("cy")) - centre.y) < 0.5,
      "and it is centred on the origin system itself");

    const marked = state.nodes.filter(n => n.el.classList.contains("in-range"));
    t.check(marked.length > 0, `${marked.length} regions are marked`);
    t.check(marked.every(n => state.range.regionIds.has(n.record.region_id)),
      "every marked region is one the computed set contains");
    t.check([...state.range.regionIds].every(id => marked.some(n => n.record.region_id === id)),
      "and every region in the set is marked");

    const legendHtml = () => globalThis.__mapStage.querySelectorAll(".legend").at(-1)?.innerHTML ?? "";
    t.check(legendHtml().includes("Jump range"), "the legend gains a key");
    const brief = ui("inspectorContent").innerHTML;
    t.check(brief.includes("Systems in reach"), "the brief reports what is in reach");
    t.check(brief.includes("Regions in reach"), "and which regions");

    app.renderUniverse();
    t.equal(viewport.querySelectorAll(".range-ring").length, 1, "re-rendering keeps exactly one ring");

    // The regional map is a relaxed schematic, so it carries no distance
    // scale: systems are marked there, but no ring is drawn.
    state.region = readRegion("The Forge");
    app.renderRegion();
    t.equal(viewport.querySelectorAll(".range-ring").length, 0, "no ring on the schematic regional map");
    t.check(viewport.querySelectorAll(".range-node").length > 0, "but systems in reach are marked there");

    // --- the outline is sized from the capsule it surrounds ---------------------
    // The capsule is SYSTEM_NODE_HEIGHT tall and this outline sits around it
    // with even padding. Both were written out as finished numbers - the
    // outline as 40, in a creation site and a resize site that had to agree
    // with each other and with the capsule - and all three were right only
    // because the capsule happens to be 32. Change the capsule and the node
    // moves while its outline stays put.
    //
    // Asserted against the rendered rectangle rather than by reading the
    // source: a grep for the literal missed one of the two spellings the first
    // time, and a count of references passed while a site was reverted.
    const outline = viewport.querySelector(".range-node");
    t.check(outline, "a range outline is drawn");
    const drawnHeight = Number(outline.getAttribute("height"));
    t.equal(drawnHeight, SYSTEM_NODE_HEIGHT + 8,
      `the outline is the capsule plus its padding (${drawnHeight} against ${SYSTEM_NODE_HEIGHT} + 8)`);
    t.equal(Number(outline.getAttribute("y")), -drawnHeight / 2, "and is centred on the node");
    t.equal(Number(outline.getAttribute("rx")), drawnHeight / 2, "with fully rounded ends, like the capsule");
    t.check(Number(outline.getAttribute("width")) > drawnHeight,
      "and is wider than it is tall, being a capsule rather than a circle");
    t.check(Object.values(state.region.systems)
      .filter(s => state.range.systemIds.has(s.system_id)).length === viewport.querySelectorAll(".range-node").length,
      "one mark per in-range system in the region, no more");

    app.renderUniverse();
    app.clearRangeRings();
    t.check(state.range === null, "clearing drops the range");
    t.equal(viewport.querySelectorAll(".range-ring").length, 0, "and removes the ring");
    t.check(state.nodes.every(n => !n.el.classList.contains("in-range")), "and unmarks every region");
    t.check(!legendHtml().includes("Jump range"), "and takes the legend key with it");

    ui("jumpFrom").value = "Notasystem";
    app.toggleRangeRings();
    t.check(ui("jumpError").textContent.includes("Origin system not found"), "an unresolvable origin is refused");
    t.check(state.range === null, "and nothing is drawn");
  }

  return t.results;
}
