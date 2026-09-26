// What the inspector's buttons actually do.
//
// panels.js is tested as pure functions: given a plan, what markup comes out.
// That deliberately stops at the markup. The other half - inserting it and
// attaching handlers that navigate somewhere - is what every extraction commit
// rewrote today, and nothing checked it. A button that renders perfectly and
// carries the wrong region name takes you to the wrong place, and the panel
// tests cannot see that because the region name is supplied by the caller.
//
// Clicks that only touch application state are performed for real. Clicks that
// load a region are not: loadRegion fetches, which this harness has no answer
// for, so those are checked by asserting the attributes the handler reads. A
// wrong attribute is the failure mode that matters; a handler that is attached
// and reads the right values will navigate correctly.

import { readArchive, readRegion, readShips, suite } from "./helpers.mjs";
import { JumpPlanner } from "../web/jump-planner.js";
import { RoutePlanner } from "../web/route-planner.js";
import { TacticalAnalyzer } from "../web/tactical-analyzer.js";
import { routePanel, routeProtestPanel, systemPanel } from "../web/panels.js";

export default function run(app) {
  const t = suite("panel wiring");
  const { state, ui } = app;
  const atlas = readArchive();
  state.atlas = atlas;

  const buttons = selector => ui.content.querySelectorAll(selector);
  const regionNameOf = id => atlas.regions[id].name;

  // --- capital jump plan ----------------------------------------------------
  const jumpPlanner = new JumpPlanner(atlas, readShips());
  state.jumpPlanner = jumpPlanner;
  const plan = jumpPlanner.plan("Jita", "1DQ1-A", { shipValue: "Ark" });
  app.showJump(plan);

  const legs = buttons("[data-jump-system]");
  t.equal(legs.length, plan.legs.length, "every jump leg gets a button");
  t.check(legs.every(b => typeof b.onclick === "function"), "each one is wired");
  t.check(legs.every((b, i) => Number(b.getAttribute("data-jump-system")) === plan.legs[i].to.system_id),
    "each carries the system it arrives at, in order");
  t.check(legs.every((b, i) => b.getAttribute("data-jump-region") === regionNameOf(plan.legs[i].to.region_id)),
    "and the region that system is actually in");

  // A same-system plan has no legs, so it must not render a button to nowhere.
  app.showJump(jumpPlanner.plan("1DQ1-A", "1DQ1-A", { shipValue: "Panther" }));
  t.equal(buttons("[data-jump-system]").length, 0, "a plan with no legs offers nothing to click");

  // --- stargate route -------------------------------------------------------
  const routePlanner = new RoutePlanner(atlas);
  state.routePlanner = routePlanner;
  const route = routePlanner.calculate("Jita", "Amarr", "shortest");
  app.showRoute(route);

  // A route carrying a mode the labels do not know must not render a heading
  // reading "undefined".
  app.showRoute({ ...route, mode: "mode-from-an-older-version" });
  t.check(!/>undefined</.test(ui.content.innerHTML),
    "an unknown route mode does not put the word undefined in the panel");
  t.check(/Shortest route/.test(ui.content.innerHTML), "it falls back to a real label");
  app.showRoute(route);

  const steps = buttons("[data-route-system]");
  t.equal(steps.length, route.systems.length, "every system on the route is a step");
  t.check(steps.every(b => typeof b.onclick === "function"), "each step is wired");
  t.check(steps.every((b, i) => Number(b.getAttribute("data-route-system")) === route.systems[i].system_id),
    "carrying its own system id");
  t.check(steps.every((b, i) => b.getAttribute("data-route-region") === regionNameOf(route.systems[i].region_id)),
    "and the right region to open");

  // --- jump range -----------------------------------------------------------
  const origin = atlas.systems["30000142"];
  const range = {
    ...jumpPlanner.rangeSet(origin.system_id, 8, { allowHighSec: false }),
    origin,
    ship: jumpPlanner.resolveShip("Panther"),
    rangeLy: 8,
  };
  app.showRange(range);
  const nearest = buttons("[data-range-system]");
  t.check(nearest.length > 0, `${nearest.length} nearest systems are listed`);
  t.check(nearest.length <= 12, "capped at twelve, so the panel stays a panel");
  t.check(nearest.every(b => typeof b.onclick === "function"), "each is wired");
  t.check(nearest.every((b, i) => Number(b.getAttribute("data-range-system")) === range.entries[i].system.system_id),
    "in the order the entries were ranked");
  t.check(nearest.every((b, i) => b.getAttribute("data-range-region") === regionNameOf(range.entries[i].system.region_id)),
    "each with its own region");
  app.clearRangeRings();

  // --- solar system ---------------------------------------------------------
  const forge = readRegion("The Forge");
  state.region = forge;
  const jita = Object.values(forge.systems).find(s => s.name === "Jita");
  state.selected = null;
  app.showSystem(jita);

  const neighbors = buttons("[data-system]");
  t.equal(neighbors.length, jita.neighbors.length, "every stargate neighbour is listed");
  t.check(neighbors.every((b, i) => Number(b.getAttribute("data-system")) === jita.neighbors[i]),
    "each carrying the neighbour's id");
  t.check(neighbors.every((b, i) => b.getAttribute("data-region-name") === regionNameOf(atlas.systems[jita.neighbors[i]].region_id)),
    "and the region it lives in, which is not always this one");

  // This click is safe to perform: a neighbour inside the region selects
  // rather than loading, so nothing fetches.
  const inRegion = neighbors.find(b => forge.systems[+b.getAttribute("data-system")]);
  t.check(Boolean(inRegion), "at least one neighbour is inside the region");
  inRegion.onclick();
  t.equal(state.selected, Number(inRegion.getAttribute("data-system")),
    "clicking a neighbour inside the region selects it");

  // A route that crosses a wormhole or a bridge is not a stargate route, and
  // the heading should not claim it is. A pilot reading "Stargate route" over a
  // leg that expires in four hours has been told something false by omission.
  const mixedLegs = { origin: { name: "A" }, destination: { name: "B" }, jumps: 2,
    security: { high: 2, low: 0, null: 0 }, regions: ["The Forge"], mode: "shortest",
    systems: [{ system_id: 1, name: "A", security: 0.9, region_id: 1 },
              { system_id: 2, name: "B", security: 0.9, region_id: 1 }] };
  t.check(/Stargate route/.test(routePanel({ ...mixedLegs, legKinds: ["gate"] }, () => "The Forge")),
    "a route over stargates says so");
  t.check(/Mixed route/.test(routePanel({ ...mixedLegs, legKinds: ["wormhole"], wormholeJumps: 1 }, () => "The Forge")),
    "a route with a wormhole leg does not call itself a stargate route");
  t.check(/Mixed route/.test(routePanel({ ...mixedLegs, legKinds: ["bridge"], bridgeJumps: 1 }, () => "The Forge")),
    "and nor does one over a bridge");
  t.check(/route-leg-kind/.test(routePanel({ ...mixedLegs, legKinds: ["wormhole"], wormholeJumps: 1 }, () => "The Forge")),
    "with the step itself labelled, so the pilot sees which jump it is");

  // Perishable before permanent. These sections arrived one at a time, each
  // appended below the last, until a timer starting in ten minutes sat beneath
  // a stargate list that has not changed since 2003.
  const ordered = systemPanel(jita, {
    constellationName: "Kimotoro", regionName: "The Forge", neighbors: [],
    regionNameFor: () => "The Forge", securityColour: () => "#fff", securityName: () => "High",
    campaigns: [{ live: true, text: "Infrastructure hub · started 10m ago" }],
    heat: { text: "3 player kills in the last hour", trend: [], age: "just now" },
    ambient: { incursionText: "Sansha's Nation", frontlineText: null, age: "just now" },
    threats: [{ group: "Titan", rangeLy: 6, distanceLy: 3, fromSystem: { name: "Amamake" }, fromId: 1, isStaging: false }],
    sovereignty: { holding: null, age: "just now" },
  });
  const at = heading => ordered.indexOf(heading);
  t.check(at("Sovereignty timers") > -1 && at("Gates from here") > -1,
    "a fully synced system panel carries both live and static sections");
  for (const live of ["Sovereignty timers", "Activity", "Incursions and FW", "Threat reach"]) {
    t.check(at(live) < at("Gates from here"),
      `${live} is above the stargate list, because it goes stale and the stargates do not`);
  }
  t.check(at("Gates from here") < at("Archive identifiers"),
    "and the permanent facts sit at the bottom");

  // Every live section is absent until its layer is synced, so an unsynced
  // install still opens on the familiar static panel rather than a column of
  // empty headings.
  const bare = systemPanel(jita, {
    constellationName: "Kimotoro", regionName: "The Forge", neighbors: [],
    regionNameFor: () => "The Forge", securityColour: () => "#fff", securityName: () => "High",
  });
  for (const live of ["Sovereignty timers", "Activity", "Incursions and FW", "Threat reach", "Sovereignty"]) {
    t.check(!bare.includes(live), `${live} is absent entirely before anything is synced`);
  }
  t.check(bare.includes("Gates from here"), "while the static panel is there as it always was");

  // And the avoid-list button, which only edits a form field.
  app.showSystem(jita);
  const avoidField = document.getElementById("avoidSystems");
  avoidField.value = "";
  const avoidButton = ui.content.querySelector("[data-avoid-add]");
  t.check(Boolean(avoidButton), "the system panel offers an add-to-avoid-list control");
  avoidButton.onclick ? avoidButton.onclick() : avoidButton.dispatch("click");
  t.check(avoidField.value.includes("Jita"), "and using it adds that system to the avoid list");
  t.check(!/,\s*,|^,|,$/.test(avoidField.value), "without leaving a stray separator");
  avoidField.value = "";

  // --- regional file --------------------------------------------------------
  state.mode = "universe";
  app.showRegion(forge.region);
  const adjacent = buttons("[data-region]");
  t.check(adjacent.length > 0, `${adjacent.length} adjacent regions are listed`);
  t.check(adjacent.every(b => atlas.regions[b.getAttribute("data-region")] !== undefined),
    "every one is a region that exists in the archive");
  t.check(Boolean(ui.content.querySelector("[data-open]")),
    "and from the universe view the panel offers to open the regional map");

  state.mode = "region";
  app.showRegion(forge.region);
  t.check(!ui.content.querySelector("[data-open]"),
    "while from inside that region it does not offer to open the map you are already on");

  // --- tactical brief -------------------------------------------------------
  state.tacticalAnalyzer = new TacticalAnalyzer(atlas);
  const report = state.tacticalAnalyzer.analyze("Tama", 4);
  const config = { preset: "escape", depth: 4, blocks: { security: true, approaches: true, chokes: true, borders: true } };
  app.showTacticalBrief(report, config);

  const tactical = buttons("[data-tactical-system]");
  t.check(tactical.length > 0, `${tactical.length} tactical systems are clickable`);
  t.check(tactical.every(b => typeof b.onclick === "function"), "each is wired");
  t.check(tactical.every(b => atlas.systems[b.getAttribute("data-tactical-system")] !== undefined),
    "each names a system that exists");
  t.check(tactical.every(b => {
    const system = atlas.systems[b.getAttribute("data-tactical-system")];
    return b.getAttribute("data-tactical-region") === regionNameOf(system.region_id);
  }), "and the region that system is really in");

  // Switching every block off must leave the command priorities, which are the
  // point of the brief, and remove the rest.
  app.showTacticalBrief(report, { ...config, blocks: { security: false, approaches: false, chokes: false, borders: false } });
  t.check(ui.content.querySelectorAll(".command-priority").length > 0,
    "with every optional block off, the command priorities remain");
  t.check(ui.content.querySelectorAll(".tactical-vector").length === 0,
    "and the optional vectors are gone");

  // --- the brief mints the snapshot, and the button forks that one ----------
  //
  // The lineage the design specifies is: brief computed, snapshot frozen,
  // briefing rendered from it, the button forks *that* snapshot. Nothing in
  // this application called `buildSnapshot` at all before step 6, so this is
  // the first place the order can be got wrong - and getting it wrong is
  // invisible. A window built on a fresh snapshot looks identical and answers
  // about a universe the briefing beside it never described.
  app.showTacticalBrief(report, config);
  const firstSnapshot = state.briefSnapshot;
  t.check(Boolean(firstSnapshot), "rendering a brief mints a snapshot of it");
  t.check(typeof firstSnapshot.id === "string" && firstSnapshot.id !== "",
    "and the snapshot carries an id");
  t.equal(firstSnapshot.depth, report.depth, "minted from this report, not a fresh analysis");

  // No advisor, no opener - absent rather than disabled, before anything else
  // about the window is true. This is the first thing checked because it is the
  // one that governs whether the rest is reachable at all.
  state.advisorUp = false;
  app.renderAskOpener();
  t.equal(ui.content.querySelectorAll("[data-ask-open]").length, 0,
    "with no advisor there is no opener, not a greyed-out one");

  state.advisorUp = true;
  app.renderAskOpener();
  const opener = ui.content.querySelectorAll("[data-ask-open]");
  t.equal(opener.length, 1, "the brief offers exactly one way to ask about itself");
  app.renderAskOpener();
  t.equal(ui.content.querySelectorAll("[data-ask-open]").length, 1,
    "and rendering it twice leaves one, not two");

  const opened = app.openAsk();
  t.check(!opened.fault, "the opener forks a window");
  t.equal(opened.snapshot, firstSnapshot, "and the window holds the brief's own snapshot");
  t.equal(state.askWindows.open.length, 1, "one window is open");

  // The refresh a pilot does while a window is open. The new brief mints a new
  // snapshot; the window already open keeps the one it forked. Two windows may
  // then disagree, which is correct and is why each carries its own age.
  app.showTacticalBrief(report, config);
  t.check(state.briefSnapshot !== firstSnapshot, "re-rendering the brief mints a new snapshot");
  t.equal(state.askWindows.open[0].snapshot, firstSnapshot,
    "and the open window still holds the older one rather than being re-pointed");

  const second = app.openAsk();
  t.check(second.snapshot === state.briefSnapshot && second.snapshot !== firstSnapshot,
    "a window opened after the refresh forks the newer snapshot");
  t.check(state.askWindows.open[0].snapshotId !== state.askWindows.open[1].snapshotId,
    "so two open windows are about different briefs, honestly");

  // Nothing in the window acts. This is a rule about the markup so that a
  // reviewer can check it without reading the logic.
  const layer = ui.askLayer;
  t.check(Boolean(layer) && !layer.hidden, "the window layer is showing");
  t.equal(layer.querySelectorAll("[data-tactical-system]").length, 0,
    "and nothing in it is a control the rest of the application listens to");

  // The window's age must keep moving. It is outside `ui.content` on purpose -
  // a floating panel anchored inside a scrolling container drifts away from the
  // thing it is about - and that put it outside every root the clock tick
  // walked, so the header was correct exactly once and then froze. "Its own age
  // in its header, always" is how a pilot tells two windows apart.
  {
    const head = () => ui.askLayer.querySelectorAll("[data-live-at]");
    t.check(head().length > 0, "the window header carries a clock-driven span");
    const taken = Number(head()[0].getAttribute("data-live-at"));
    app.tickLiveTimes(taken + 3 * 60 * 60 * 1000);
    const texts = [...head()].map(span => span.textContent);
    t.check(texts.some(text => /3h ago/.test(text)),
      `three hours later the window says so (${texts.join(" | ")})`);
    t.check(texts.every(text => !/synced/.test(text)),
      "and still says taken rather than synced, because the verb travels with the span");
  }

  // The opener belongs to the brief, and every panel is drawn by overwriting the same
  // element. Selecting a system after taking a brief wipes the opener while
  // `state.briefSnapshot` stays set unless something clears it - and the next call to
  // `renderAskOpener`, which the availability check makes when it resolves, then appends
  // "Ask about this brief" to a *system* panel, offering to fork a snapshot of a
  // briefing that is no longer on screen.
  app.showSystem(jita);
  t.equal(ui.content.querySelectorAll("[data-ask-open]").length, 0,
    "showing another panel takes the opener with it");
  app.renderAskOpener();
  t.equal(ui.content.querySelectorAll("[data-ask-open]").length, 0,
    "and it does not come back on a panel that is not the brief");
  t.equal(state.briefSnapshot, null, "because the brief's snapshot went with the brief");
  t.equal(state.askWindows.open.length, 2,
    "while windows already open are untouched - they hold their own snapshots");

  app.closeAsk(state.askWindows.open[0].id);
  app.closeAsk(state.askWindows.open[0].id);
  t.equal(state.askWindows.open.length, 0, "both windows close");
  t.check(ui.askLayer.hidden, "and the layer goes away with the last one");

  // With no snapshot there is no opener - absent, not disabled. A control a
  // build cannot honour invites a pilot to look for the thing that is not
  // there, which is the rule `bindVault` already follows.
  state.briefSnapshot = null;
  app.renderAskOpener();
  t.equal(ui.content.querySelectorAll("[data-ask-open]").length, 0,
    "with nothing to ask about, the opener is absent rather than greyed out");
  state.advisorUp = false;

  state.region = null;
  state.selected = null;
  state.mode = "universe";
  state.tacticalAnalyzer = null;
  state.briefSnapshot = null;
  ui.content.innerHTML = "";
  ui.content.hidden = true;
  // --- an entry used anyway must say what kind of thing it was ------------------
  // The panel exists so a pilot knows which standing order the router broke.
  // It labelled bridges and nothing else, which was complete until wormholes
  // became their own override target - after that a soft-ignored hole crossed
  // anyway rendered as a bare pair of names, indistinguishable from a gate.
  // There is no gate between Jita and Thera, so the entry was not merely
  // unlabelled, it was misleading.
  const usedEdge = kind => routeProtestPanel({
    avoidedAnyway: [],
    edgesUsedAnyway: [{ kind, key: "1-2", from: { name: "Jita" }, to: { name: "Thera" }, reason: "" }],
  });
  t.check(/\(bridge\)/.test(usedEdge("bridge")), "a bridge used anyway is named as a bridge");
  t.check(/\(wormhole\)/.test(usedEdge("wormhole")), "and a wormhole as a wormhole");
  t.check(!/\(/.test(usedEdge("gate").replace(/<[^>]*>/g, "")),
    "while a gate needs no qualifier, being the ordinary case");
  t.check(/Jita/.test(usedEdge("wormhole")) && /Thera/.test(usedEdge("wormhole")),
    "and both ends are still named");
  // A kind this file has never heard of still gets labelled, rather than
  // silently reading as a gate.
  t.check(/\(filament\)/.test(usedEdge("filament")),
    "a kind added later is labelled without this renderer being edited again");

  return t.results;
}
