// CCP's official two-dimensional layout, as imported and as drawn.
//
// The whole point of this layout is that it is CCP's and not ours. So these
// tests check that nothing here improves it: no relaxation, no nudging apart,
// no substituting a plausible number where CCP publishes none. The moment this
// layout is adjusted to look better it stops being the thing it was imported
// for, and the project already has a schematic of its own for that.

import fs from "node:fs";
import path from "node:path";
import { readArchive, readRegion, suite, ROOT } from "./helpers.mjs";
import { LAYOUT_MODES, hasOfficialLayout, regionLayout } from "../web/map-utils.js";
import { JumpPlanner } from "../web/jump-planner.js";

export default function run(app) {
  const t = suite("layout 2d");
  const atlas = readArchive();
  const systems = Object.values(atlas.systems);

  // --- the import ---------------------------------------------------------
  const withLayout = systems.filter(s => Array.isArray(s.position_2d));
  const without = systems.filter(s => s.position_2d === null);
  t.equal(withLayout.length, 5485, "5,485 systems carry CCP's schematic layout");
  t.equal(without.length, 3005, "and 3,005 carry none");
  t.equal(withLayout.length + without.length, systems.length, "every system is one or the other, never undefined");

  // Which systems have it is not arbitrary: it is exactly K-space.
  const kSpace = id => id >= 30000000 && id <= 30999999;
  t.check(withLayout.every(s => kSpace(s.system_id)),
    "every system with a layout is in K-space");
  t.check(without.every(s => !kSpace(s.system_id)),
    "and every system without one is outside it - J-space and the Abyssal grounds");

  // A published value, checked against the figure recorded in the project
  // document when the field was first examined.
  const tanoo = atlas.systems["30000001"];
  t.equal(tanoo.position_2d[0], 6.985182150795389e16, "a known system's published x is carried exactly");
  t.equal(tanoo.position_2d[1], -7.190628684642312e16, "and its published y");

  // Null must stay null. Writing the origin would stack 3,005 systems on one
  // point of a real coordinate space, which is worse than an honest absence.
  t.check(!withLayout.some(s => s.position_2d[0] === 0 && s.position_2d[1] === 0),
    "no system was placed at the schematic origin in place of a missing value");

  // --- provenance ---------------------------------------------------------
  const layoutMeta = atlas.meta.layout_2d;
  t.equal(layoutMeta.schema_version, 1, "the layout declares a schema version");
  t.check(/position2D/.test(layoutMeta.source), "and names the field it came from");
  t.check(/screenY = -y/.test(layoutMeta.display_convention), "and states the display convention");
  t.check(/[Dd]isplay only/.test(layoutMeta.purpose), "and that it is display only");
  t.check(/null/i.test(layoutMeta.fallback), "and documents the fallback");
  t.equal(layoutMeta.systems_with_layout, withLayout.length, "its counts match what it carries");
  t.equal(layoutMeta.systems_without_layout, without.length, "on both sides");

  // --- derived levels -----------------------------------------------------
  // CCP publishes nothing at region or constellation level, so these are ours
  // and must be honestly derived from members, not invented.
  const domainRegion = Object.values(atlas.regions).find(r => r.name === "Domain");
  const members = domainRegion.systems.map(id => atlas.systems[String(id)].position_2d).filter(Boolean);
  const xs = members.map(p => p[0]);
  const ys = members.map(p => p[1]);
  const bounds = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  t.equal(JSON.stringify(domainRegion.bounds_2d), JSON.stringify(bounds),
    "a region's bounds_2d is the extent of its member systems");
  t.equal(JSON.stringify(domainRegion.position_2d),
    JSON.stringify([(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2]),
    "and its position_2d is the centre of that extent");

  const jspaceRegion = Object.values(atlas.regions).find(r => r.name === "A-R00001");
  t.equal(jspaceRegion.position_2d, null, "a region whose systems have no layout carries none either");
  t.equal(jspaceRegion.bounds_2d, null, "rather than an extent of nothing");

  // --- the layout as drawn ------------------------------------------------
  t.equal(JSON.stringify(LAYOUT_MODES), JSON.stringify(["atlas", "ccp"]), "two layout modes are offered");

  const domain = Object.values(readRegion("Domain").systems);
  t.check(hasOfficialLayout(domain), "Domain has a complete official layout");
  t.check(!hasOfficialLayout(Object.values(readRegion("A-R00001").systems)), "a wormhole region does not");
  t.check(!hasOfficialLayout([]), "and neither does an empty region");

  // Every real region is all-or-nothing today - K-space has a full layout and
  // J-space none - so a partial one has to be constructed to test at all. It is
  // worth testing: "complete" must mean every system, or a region with one
  // missing coordinate would draw in CCP's layout with a hole in it.
  const partial = [domain[0], { ...domain[1], position_2d: null }, domain[2]];
  t.check(!hasOfficialLayout(partial), "a region missing even one system's layout is not complete");
  const partialLayout = regionLayout(partial, "ccp", 1200, 760);
  t.equal(partialLayout.mode, "atlas", "and it falls back rather than drawing a hole");
  t.check(partialLayout.fellBack, "reporting the fallback");

  const ccp = regionLayout(domain, "ccp", 1200, 760);
  t.equal(ccp.mode, "ccp", "Domain draws in CCP's layout when asked");
  t.check(!ccp.fellBack, "without falling back");

  // The official layout must be an exact affine image of what CCP published:
  // one uniform scale, one translation, and a vertical flip. Any relaxation,
  // jitter or per-system nudge breaks this, which is the point of checking it.
  const pairs = domain.slice(0, 40);
  const ratios = [];
  for (let i = 0; i < pairs.length; i += 1) {
    for (let j = i + 1; j < pairs.length; j += 1) {
      const a = pairs[i];
      const b = pairs[j];
      const source = Math.hypot(a.position_2d[0] - b.position_2d[0], a.position_2d[1] - b.position_2d[1]);
      const pa = ccp.positions.get(a);
      const pb = ccp.positions.get(b);
      const drawn = Math.hypot(pa.x - pb.x, pa.y - pb.y);
      if (source > 0) ratios.push(drawn / source);
    }
  }
  const spread = Math.max(...ratios) / Math.min(...ratios) - 1;
  t.check(ratios.length > 300, `${ratios.length} system pairs compared`);
  t.check(spread < 1e-9, `every pair keeps one scale (spread ${spread.toExponential(1)}), so nothing was relaxed or nudged`);

  // The vertical flip is applied, and applied once.
  const north = domain.reduce((best, s) => (s.position_2d[1] > best.position_2d[1] ? s : best));
  const south = domain.reduce((best, s) => (s.position_2d[1] < best.position_2d[1] ? s : best));
  t.check(ccp.positions.get(north).y < ccp.positions.get(south).y,
    "the system furthest north in CCP's coordinates is drawn above the one furthest south");

  // Falling back must be visible to the caller, not silent.
  const wormhole = regionLayout(Object.values(readRegion("A-R00001").systems), "ccp", 1200, 760);
  t.equal(wormhole.mode, "atlas", "a region with no official layout falls back to the Atlas schematic");
  t.check(wormhole.fellBack, "and reports that it did");
  t.equal(wormhole.requested, "ccp", "while remembering what was asked for");

  const asked = regionLayout(domain, "atlas", 1200, 760);
  t.equal(asked.mode, "atlas", "the Atlas schematic is still available for regions that have both");
  t.check(!asked.fellBack, "and choosing it is not a fallback");
  // --- why CCP's map can be the default ------------------------------------------
  //
  // It is the default because of a property of the data rather than a
  // preference: every system you can fly to through a stargate sits in a region
  // CCP publishes a layout for. Measured across the whole archive - 5,268 gated
  // systems, none of them missing one - so the fallback never fires anywhere a
  // pilot can actually travel by gate.
  //
  // The regions without a layout are wormhole space, the abyssal proving
  // grounds, and CCP's `VR-*` test regions, which between them have no stargates
  // at all. Thera is in that set: it is reached by a hole, and the schematic is
  // the only thing that can draw it.
  //
  // Asserted rather than remembered, because a rebuild from a later SDE could
  // quietly lose a region's layout, and the symptom - one region silently
  // drawing in the other mode - is exactly the kind nobody reports.
  const gated = Object.values(atlas.systems).filter(system => system.neighbors.length > 0);
  const unlaid = gated.filter(system => !Array.isArray(system.position_2d));
  t.check(gated.length > 5000, `the archive has ${gated.length} systems reachable by stargate`);
  t.equal(unlaid.length, 0,
    "and every one of them is in a region CCP publishes a layout for, so the default never falls back");

  const gateless = Object.values(atlas.systems).filter(system => system.neighbors.length === 0);
  t.check(gateless.some(system => !Array.isArray(system.position_2d)),
    "while some gateless space has no layout at all, which is what the schematic is for");

  const unknown = regionLayout(domain, "nonsense", 1200, 760);
  t.equal(unknown.mode, "ccp", "an unknown mode is CCP's own map rather than a throw");
  t.equal(unknown.requested, "ccp",
    "and is normalised, so nothing downstream ever sees a mode name that is not one of the two");
  t.check(!unknown.fellBack, "an unknown mode is a default, not a fallback from something real");

  // --- nothing physical moved ---------------------------------------------
  // This is the property that matters most: the layout is for display, and
  // every jump calculation must be exactly what it was before the import.
  const planner = new JumpPlanner(atlas, JSON.parse(fs.readFileSync(path.join(ROOT, "data", "ships.json"), "utf8")));
  const plan = planner.plan("Jita", "1DQ1-A", { shipValue: "Ark" });
  t.equal(plan.totalFuel, 117325, "the Ark run still reports the fuel it did before the import");
  t.check(systems.every(s => Array.isArray(s.position) && s.position.length === 3),
    "every system still carries its three physical coordinates");
  t.check(systems.every(s => s.position_2d === null || s.position_2d.length === 2),
    "and a schematic position is two coordinates or none");


  // --- the control, through the app ---------------------------------------
  const { state } = app;
  const ui = id => document.getElementById(id);
  state.atlas = atlas;
  state.region = readRegion("Domain");
  state.selected = null;
  app.bindLayout();
  t.equal(state.layoutMode, "ccp", "CCP's own map is the default");

  app.setLayoutMode("ccp");
  t.equal(state.layoutMode, "ccp", "the CCP layout can be chosen");
  app.renderRegion();
  t.equal(state.layout.mode, "ccp", "and Domain then draws in it");
  t.check(ui("layoutCcp").getAttribute("aria-pressed") === "true", "the control shows which layout is drawn");
  t.check(ui("layoutAtlas").getAttribute("aria-pressed") === "false", "and which is not");
  t.check(/as published/.test(ui("layoutNote").textContent), "and says whose map it is");
  t.check(!ui("layoutBar").hidden, "the control is offered on a regional view");

  // The positions the map actually uses must be CCP's, not a relaxed copy.
  const rendered = Object.values(state.region.systems).slice(0, 30);
  const renderedRatios = [];
  for (let i = 0; i < rendered.length; i += 1) {
    for (let j = i + 1; j < rendered.length; j += 1) {
      const source = Math.hypot(rendered[i].position_2d[0] - rendered[j].position_2d[0],
        rendered[i].position_2d[1] - rendered[j].position_2d[1]);
      const pi = state.positions.get(rendered[i]);
      const pj = state.positions.get(rendered[j]);
      if (source > 0) renderedRatios.push(Math.hypot(pi.x - pj.x, pi.y - pj.y) / source);
    }
  }
  t.check(Math.max(...renderedRatios) / Math.min(...renderedRatios) - 1 < 1e-9,
    "the rendered positions are CCP's published ones under one uniform scale");

  // A region with no published layout must fall back, say so, and not offer
  // a choice it cannot honour.
  state.region = readRegion("A-R00001");
  app.renderRegion();
  t.equal(state.layout.mode, "atlas", "a wormhole region falls back to the Atlas schematic");
  t.check(state.layout.fellBack, "and records that it did");
  t.check(/publishes no layout/.test(ui("layoutNote").textContent), "the control explains why");
  t.check(ui("layoutCcp").disabled, "and the CCP option is not offered where there is none");

  app.setLayoutMode("atlas");
  state.region = readRegion("Domain");
  app.renderRegion();
  t.equal(state.layout.mode, "atlas", "switching back returns to the Atlas schematic");
  t.check(ui("layoutNote").textContent === "", "which needs no explanation");
  t.check(!ui("layoutCcp").disabled, "and the CCP option is offered again");

  app.renderUniverse();
  t.check(ui("layoutBar").hidden, "the control is hidden on the universe view, which has no regional layout");

  state.region = null;
  state.layout = null;
  state.selected = null;

  return t.results;
}
