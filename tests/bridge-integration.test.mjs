// Bridges and the avoidance list, as wired into the application.
//
// The routing arithmetic is covered elsewhere; this is about the join. Three
// properties carry the weight.
//
// A bridge the pilot records has to reach the router. It is recorded as a
// sighting, so removing one closes a window rather than erasing a record - the
// disappearance of a bridge is intelligence about a retreat or a fuel crisis
// and has to survive the removal - and what routes is only ever the open set.
//
// Avoidance has two sources that must not disagree. Standing orders live in
// the override store, outlive any one route and expire on their own; the typed
// avoid fields belong to the route and travel with a saved corridor. Both must
// reach the router and both must appear in one list, because the failure this
// list exists to prevent is avoiding something in one place and being routed
// through it from the other.
//
// And a change to either has to reach a route already on screen. A stale route
// drawn over a network the pilot has just corrected is worse than no route: it
// looks current.

import { readArchive, readRegion, suite } from "./helpers.mjs";
import {
  createSightings, historyOf, observe, openForSource, openObservations, syncAll,
} from "../web/sightings.js";
import { ROUTE_FIELDS, isStale, keyFor } from "../web/result-state.js";
import { STORAGE_KEYS, readJson } from "../web/settings.js";
import { RoutePlanner } from "../web/route-planner.js";
import { clearOverride, confirmUp, isBlocked, isDiscouraged, setOverride } from "../web/overrides.js";

const LIVE_KEY = "new-eden-atlas-live-v1";

export default function run(app) {
  const t = suite("bridge wiring");
  const { state, ui } = app;
  const atlas = readArchive();
  state.atlas = atlas;
  state.routePlanner = new RoutePlanner(atlas);

  const idOf = name => state.routePlanner.resolveSystem(name).system_id;
  const route = (from, to) => {
    ui.routeFrom.value = from;
    ui.routeTo.value = to;
    ui.routeMode.value = "shortest";
    app.calculateRoute();
    return state.route;
  };
  const names = () => (state.route?.systems ?? []).map(s => s.name);

  localStorage.removeItem(LIVE_KEY);
  ui.avoidSystems.value = "";
  ui.avoidRegions.value = "";
  ui.routeMinSec.value = "";
  ui.routeMaxSec.value = "";
  app.restoreLive();
  app.refreshAvoid();

  // --- nothing recorded ------------------------------------------------------
  t.equal(app.bridgeEntries().length, 0, "a fresh install has no bridges");
  t.check(/No bridges recorded/.test(ui.bridgeList.innerHTML), "and says so rather than showing an empty box");
  t.check(/Nothing is being avoided/.test(ui.ignoreList.innerHTML), "and nothing is being avoided");
  t.equal(route("Jita", "Amarr").jumps, 11, "the gate route is the gate route");

  // --- recording one ---------------------------------------------------------
  // A typo must be refused where it is typed. Recorded and silently ignored, it
  // would sit in the list looking like a bridge that simply never helps.
  app.addBridge("Nowhere-At-All", "Amarr");
  t.check(/not a known system/.test(ui.bridgeError.textContent), "an unknown origin is refused with a reason");
  t.equal(app.bridgeEntries().length, 0, "and nothing is recorded");
  app.addBridge("Jita", "Jita");
  t.check(/bridged to itself/.test(ui.bridgeError.textContent), "a bridge to itself is refused");
  t.equal(app.bridgeEntries().length, 0, "and is not recorded either");

  app.addBridge("Jita", "Amarr");
  t.equal(ui.bridgeError.textContent, "", "a real pair is accepted");
  t.equal(app.bridgeEntries().length, 1, "and recorded");
  t.equal(state.bridges.count, 1, "the router is handed the network");
  t.equal(ui.bridgeFrom.value, "", "the entry fields clear, ready for the next one");
  t.check(/Jita/.test(ui.bridgeList.innerHTML) && /Amarr/.test(ui.bridgeList.innerHTML),
    "and both ends are listed");

  // The route on screen was found without the bridge, so it is now stale rather
  // than wrong - and stale is the dangerous kind, because it still looks
  // current. It recalculates.
  t.equal(state.route.jumps, 1, "a route already on screen picks the bridge up");
  t.equal(state.route.bridgeJumps, 1, "and reports that the leg was a bridge, not a gate");

  const both = names();
  t.check(both[0] === "Jita" && both[1] === "Amarr", "one jump, end to end");

  // --- removing one ----------------------------------------------------------
  const key = app.bridgeEntries()[0].key;
  app.dropBridge(key);
  t.equal(app.bridgeEntries().length, 0, "a dropped bridge stops routing");
  t.equal(state.route.jumps, 11, "and the route on screen falls back to gates");
  const history = historyOf(state.live, "bridge", key);
  t.equal(history.length, 1, "but the record survives the removal");
  t.check(Number.isFinite(history[0]?.closedAt), "closed with a date rather than deleted");
  t.check(history[0]?.closedAt >= history[0]?.firstSeen, "and the window cannot end before it began");

  // Recorded again, it is a new window rather than a revived one: a bridge that
  // came back is a different fact from one that never went away.
  app.addBridge("Jita", "Amarr");
  t.equal(historyOf(state.live, "bridge", key).length, 2, "re-recording opens a second window");
  t.equal(openObservations(state.live, "bridge").length, 1, "with only the current one open");

  // The same physical bridge typed from the other end reaches the same record.
  // The key is undirected, so if the stored value were not it would differ,
  // and the store would correctly read that as the bridge having changed -
  // writing a retreat into the record over a bridge that never moved.
  app.addBridge("Amarr", "Jita");
  t.equal(app.bridgeEntries().length, 1, "the same bridge typed the other way round is the same bridge");
  t.equal(historyOf(state.live, "bridge", key).length, 2,
    "and does not close a window and open another over a bridge that never moved");

  // Ids as well as names, because the router accepts both and a pilot pasting
  // from an API or a spreadsheet has ids. Resolving by name only here refused a
  // bridge the validation had just accepted, with a TypeError's message.
  app.addBridge(String(idOf("Jita")), String(idOf("Perimeter")));
  t.equal(ui.bridgeError.textContent, "", "a bridge given as system ids is accepted");
  t.equal(app.bridgeEntries().length, 2, "and recorded");
  t.check(app.bridgeEntries().some(bridge => bridge.fromName === "Jita" && bridge.toName === "Perimeter"),
    "with both ends resolved to names for the list");
  const byId = app.bridgeEntries().find(bridge => bridge.toName === "Perimeter");
  if (byId) app.dropBridge(byId.key);

  // --- it survives a reload ---------------------------------------------------
  app.restoreLive();
  t.equal(app.bridgeEntries().length, 1, "a reload remembers the bridge");
  t.equal(state.bridges.count, 1, "and hands it straight back to the router");
  t.equal(route("Jita", "Amarr").jumps, 1, "so the shortcut is there before any network call");

  // --- standing orders reach the router ----------------------------------------
  app.dropBridge(key);
  route("Jita", "Amarr");
  t.check(names().includes("Ikuchi"), "the gate route runs through Ikuchi");

  app.ignoreSystem(idOf("Ikuchi"));
  t.check(isDiscouraged(state.overrides, "system", idOf("Ikuchi")),
    "a system avoided from the map is soft by default, as EVE's own list is");
  t.check(!names().includes("Ikuchi"), "and the route on screen goes around it");
  t.equal(state.route.jumps, 12, "one jump longer, which is what going around costs");
  t.equal(state.route.avoidedAnyway.length, 0, "with nothing entered under protest");

  // Soft means prefer around, not refuse - the muscle memory EVE builds. Sooma
  // has exactly one neighbour, so there is no way in but through it.
  app.ignoreSystem(idOf("Chidah"));
  route("Jita", "Sooma");
  t.check(names().includes("Chidah"), "a soft entry is still entered when it is the only way through");
  t.check(state.route.avoidedAnyway.some(entry => entry.name === "Chidah"),
    "and the route says which avoided system it had to use");
  t.check(/Used anyway/.test(ui.content.innerHTML),
    "the panel says so out loud, rather than presenting a broken standing order as an ordinary route");
  t.check(/Chidah/.test(ui.content.innerHTML), "naming what it had to use");

  // Hard means never. A hard entry on the only way in leaves no route at all,
  // which is the honest answer rather than a route through it.
  setOverride(state.overrides, { target: "system", key: idOf("Chidah"), strength: "hard" });
  t.check(isBlocked(state.overrides, "system", idOf("Chidah")), "a hard entry blocks rather than costs");
  app.calculateRoute();
  t.check(ui.routeError.textContent.length > 0, "so a destination behind it reports no route");

  // --- one list, whatever put it there -------------------------------------------
  app.renderAvoidList();
  let listed = app.avoidListEntries();
  t.equal(listed.length, 2, "both standing orders are listed");
  t.check(listed.every(entry => entry.scope === "standing"), "as standing orders");
  t.check(listed.some(entry => entry.label === "Ikuchi"), "named, rather than shown as an id");
  t.check(/never routed/.test(ui.ignoreList.innerHTML), "with the hard entry marked as never routed");
  t.check(/routed around/.test(ui.ignoreList.innerHTML), "and the soft one as routed around");

  // A confirmed entry is the inverse of an avoided one - the pilot saying they
  // just flew it and it was fine. Listing it as "routed around" would report
  // the opposite of what they said, and the panel would offer to stop avoiding
  // something nobody avoided.
  confirmUp(state.overrides, "system", idOf("Perimeter"));
  t.check(!app.avoidListEntries().some(entry => entry.label === "Perimeter"),
    "a confirmed system is not listed as avoided");
  t.equal(app.standingAvoidance(idOf("Perimeter")), null,
    "and the system panel does not offer to stop avoiding it");
  t.equal(app.avoidListEntries().length, 2, "so the count still reflects what is actually avoided");
  clearOverride(state.overrides, "system", idOf("Perimeter"));

  ui.avoidSystems.value = "Ahbazon";
  ui.avoidRegions.value = "Sinq Laison";
  app.refreshAvoid();
  listed = app.avoidListEntries();
  t.equal(listed.length, 4, "the route's own avoid fields appear in the same list");
  t.check(listed.filter(entry => entry.scope === "route").length === 2,
    "marked as belonging to this route rather than standing");
  t.check(/this route only/.test(ui.ignoreList.innerHTML),
    "so a typed entry cannot be mistaken for one that outlives the route");

  // Clearing from the list has to reach the router, or the list is decoration.
  const restore = ui.ignoreList.querySelectorAll("[data-restore]");
  t.equal(restore.length, 2, "each standing order offers to be restored");
  const unavoid = ui.ignoreList.querySelectorAll("[data-unavoid]");
  t.equal(unavoid.length, 2, "and each typed one to be removed");

  const ahbazon = unavoid.find(button => button.dataset.unavoid.endsWith("Ahbazon"));
  t.check(Boolean(ahbazon), "the typed system is one of them");
  ahbazon?.click();
  t.equal(ui.avoidSystems.value, "", "removing a typed entry empties the field it came from");
  t.equal(app.avoidListEntries().filter(entry => entry.scope === "route").length, 1,
    "and it leaves the list");

  route("Jita", "Amarr");
  t.check(!names().includes("Ikuchi"), "the standing order is still in force");
  const lift = ui.ignoreList.querySelectorAll("[data-restore]")
    .find(button => button.dataset.restore === `system|${idOf("Ikuchi")}`);
  t.check(Boolean(lift), "the standing order on Ikuchi is one of the restorable entries");
  lift?.click();
  t.check(names().includes("Ikuchi"), "and lifting it puts the system back in the route immediately");
  t.equal(state.route.jumps, 11, "which is the shortest route again");

  // --- the map marks what is avoided rather than hiding it -------------------------
  // The rule most easily lost: a system that vanished could not be un-avoided
  // from the map, or reasoned about at all.
  state.region = readRegion("The Forge");
  state.mode = "region";
  app.setLayoutMode("atlas");
  app.renderRegion();
  const nodeFor = name => state.nodes.find(node => node.record.name === name);
  t.check(Boolean(nodeFor("Ikuchi")), "an avoided system is still drawn");

  app.ignoreSystem(idOf("Ikuchi"));
  app.renderOverlay();
  t.check(nodeFor("Ikuchi").el.classList.contains("avoided"), "and marked as avoided");
  t.check(!nodeFor("Ikuchi").el.classList.contains("excluded"),
    "but not as excluded, which would overstate a soft entry as impassable");
  t.check(!nodeFor("Perimeter").el.classList.contains("avoided"), "while its neighbours are untouched");

  setOverride(state.overrides, { target: "system", key: idOf("Ikuchi"), strength: "hard" });
  app.renderOverlay();
  t.check(nodeFor("Ikuchi").el.classList.contains("excluded"), "a hard entry is marked as excluded");
  t.check(!nodeFor("Ikuchi").el.classList.contains("avoided"),
    "and not both at once, which would say two different things about one system");

  // A system the route's own limits already exclude keeps that marking. It is
  // the stronger statement, and carrying both would draw one system in two
  // conflicting styles.
  setOverride(state.overrides, { target: "system", key: idOf("Ikuchi") });
  ui.avoidSystems.value = "Ikuchi";
  app.refreshAvoid();
  app.renderOverlay();
  t.check(nodeFor("Ikuchi").el.classList.contains("excluded"), "a typed avoid excludes the system");
  t.check(!nodeFor("Ikuchi").el.classList.contains("avoided"),
    "and a standing order on the same system does not mark it twice");
  ui.avoidSystems.value = "";
  app.refreshAvoid();

  clearOverride(state.overrides, "system", idOf("Ikuchi"));
  app.renderOverlay();
  t.check(!nodeFor("Ikuchi").el.classList.contains("avoided")
    && !nodeFor("Ikuchi").el.classList.contains("excluded"),
    "and lifting the entry clears the marking");
  // --- and the map can set one -------------------------------------------------
  // Managing avoidance only from a panel would mean typing a name for something
  // already under the cursor.
  const ikuchi = state.region.systems[idOf("Ikuchi")];
  app.showSystem(ikuchi);
  let standing = ui.content.querySelector("[data-avoid-standing]");
  t.check(Boolean(standing), "the system panel offers a standing avoidance control");
  t.equal(standing?.dataset.avoidStanding, "day", "which offers to avoid, since nothing is avoided yet");
  t.check(/Avoid for a day/.test(ui.content.innerHTML), "and says for how long");
  if (standing?.onclick) standing.onclick({ currentTarget: standing }); else standing?.dispatch("click");

  t.check(isDiscouraged(state.overrides, "system", idOf("Ikuchi")),
    "using it sets a standing order, not a field on this route");
  t.equal(ui.avoidSystems.value, "", "the route's own avoid field is left alone");
  standing = ui.content.querySelector("[data-avoid-standing]");
  t.equal(standing?.dataset.avoidStanding, "clear",
    "and the panel now offers to stop, rather than offering to avoid something already avoided");
  t.check(/Stop avoiding/.test(ui.content.innerHTML) && /left/.test(ui.content.innerHTML),
    "showing how long is left");
  t.check(app.avoidListEntries().some(entry => entry.label === "Ikuchi" && entry.scope === "standing"),
    "and it appears in the one list, set from the map rather than typed");

  if (standing?.onclick) standing.onclick({ currentTarget: standing }); else standing?.dispatch("click");
  t.equal(app.standingAvoidance(idOf("Ikuchi")), null, "stopping clears it");
  t.equal(ui.content.querySelector("[data-avoid-standing]")?.dataset.avoidStanding, "day",
    "and the panel offers to avoid again");

  // --- one switch over the whole list -------------------------------------------
  // Suspended, not cleared. A toggle that emptied the list would cost the pilot
  // every timer and reason they had entered, and turning it back on would
  // restore nothing.
  app.ignoreSystem(idOf("Ikuchi"));
  ui.avoidSystems.value = "Ahbazon";
  app.refreshAvoid();
  route("Jita", "Amarr");
  t.check(!names().includes("Ikuchi"), "with avoidance on, the standing order bites");
  t.check(!names().includes("Ahbazon"), "and so does the typed field");

  const before = app.avoidListEntries().length;
  app.setAvoidance(false);
  t.check(!app.avoidanceApplied(), "the switch turns avoidance off");
  t.equal(app.avoidListEntries().length, before, "the entries are kept, not cleared");
  t.check(/off/.test(ui.ignoreSummary.innerHTML),
    "and the closed panel says so, since a suspended list looks exactly like an empty one");
  t.check(/Avoidance is off/.test(ui.ignoreList.innerHTML), "as does the panel itself");

  route("Jita", "Amarr");
  t.check(names().includes("Ikuchi"), "the standing order stops applying");
  t.check(names().includes("Ahbazon"), "and so does the typed field - it is one list and one switch");
  t.equal(state.route.jumps, 11, "which is the shortest route again");
  app.renderOverlay();
  t.check(!nodeFor("Ikuchi").el.classList.contains("avoided"),
    "the map stops marking what is no longer being applied");

  // Off means off. A name that does not resolve must not be able to refuse a
  // route while the list it sits in is suspended.
  ui.avoidSystems.value = "Nowhere-At-All";
  app.refreshAvoid();
  route("Jita", "Amarr");
  t.equal(ui.routeError.textContent, "", "an unresolvable name in a suspended list does not refuse the route");
  t.equal(state.route?.jumps ?? null, 11, "and the route is found");
  ui.avoidSystems.value = "Ahbazon";

  app.setAvoidance(true);
  t.check(app.avoidanceApplied(), "turning it back on restores the list");
  t.equal(app.avoidListEntries().length, before, "with the same entries");
  t.check(app.avoidListEntries().some(entry => entry.label === "Ikuchi" && entry.expiresAt > Date.now()),
    "still carrying their timers rather than restarting them");
  route("Jita", "Amarr");
  t.check(!names().includes("Ikuchi"), "and biting again");

  // The switch is part of what a route depends on, or a result found with
  // avoidance off would sit on screen looking like one found with it on.
  const withOn = keyFor(ROUTE_FIELDS, app.routeValues());
  app.setAvoidance(false);
  t.check(isStale(withOn, keyFor(ROUTE_FIELDS, app.routeValues())),
    "toggling makes an existing result stale");

  // Persistence, including the save that predates the switch.
  app.saveRouteSettings();
  t.equal(readJson(localStorage, STORAGE_KEYS.route).avoidOn, false, "the setting is saved");
  app.restoreRouteSettings();
  t.check(!app.avoidanceApplied(), "and restored");
  const stored = readJson(localStorage, STORAGE_KEYS.route);
  delete stored.avoidOn;
  localStorage.setItem(STORAGE_KEYS.route, JSON.stringify(stored));
  app.restoreRouteSettings();
  t.check(app.avoidanceApplied(),
    "a save written before the switch existed reads as on, rather than silently suspending a list");

  ui.avoidSystems.value = "";
  app.setAvoidance(true);
  app.refreshAvoid();
  clearOverride(state.overrides, "system", idOf("Ikuchi"));
  state.region = null;
  state.mode = "universe";

  // --- the live store, and only the live store ------------------------------------
  const saved = JSON.parse(localStorage.getItem(LIVE_KEY));
  t.check(saved.overrides !== undefined, "avoidance is persisted");
  t.check(saved.sightings !== undefined, "alongside the sightings");
  t.equal(localStorage.getItem("new-eden-atlas-archive"), null,
    "and nothing about either was written to the archive's key");
  app.restoreLive();
  t.check(isBlocked(state.overrides, "system", idOf("Chidah")),
    "a hard standing order survives a reload with its strength intact");

  // --- leave the harness as it was found ---------------------------------------------
  localStorage.removeItem(LIVE_KEY);
  localStorage.removeItem(STORAGE_KEYS.route);
  ui.avoidSystems.value = "";
  ui.avoidRegions.value = "";
  ui.routeError.textContent = "";
  app.restoreLive();
  app.setAvoidance(true);
  app.refreshAvoid();
  app.clearRouteResult();
  // --- the router may never be handed the union by accident ---------------------
  //
  // `bridgeEntries()` defaults to every source because the panel wants that,
  // which makes the dangerous value the default one: hand it `undefined` and it
  // returns the union, indistinguishable from asking for the union on purpose.
  //
  // Nothing can reach that today, because `routingSource()` returns a constant.
  // But it is also the one function a travelling-character selector replaces,
  // and a selector with nobody chosen yet yields `undefined` - at which point
  // the router plans against every character's bridges and produces a route
  // that looks entirely ordinary while sending a pilot through structures they
  // cannot use.
  //
  // So this manufactures that temptation rather than warning about it in a
  // comment. If someone later wires a selector straight into bridgeEntries,
  // this is what fails.
  {
    const now = Date.now();
    const saved = state.live;
    try {
      state.live = createSightings();
      syncAll(state.live, "bridge", [{ key: "a-b", value: { from: 30000142, to: 30000144 } }],
        { source: "char:alice", now });
      syncAll(state.live, "bridge", [{ key: "c-d", value: { from: 30000180, to: 30000181 } }],
        { source: "char:bob", now });

      t.equal(app.bridgeEntries().length, 2,
        "the panel sees every character's bridges, which is what it is for");
      t.equal(app.bridgeEntries("char:alice").length, 1, "and one source sees one");

      t.equal(app.routableBridges("char:alice").length, 1,
        "the router gets exactly the travelling character's own");
      t.equal(app.routableBridges(undefined).length, 0,
        "and no character at all means no bridges, never everyone's");
      t.equal(app.routableBridges(null).length, 0, "the same for null");
      t.equal(app.routableBridges("").length, 0, "and for an empty source");
      t.equal(app.routableBridges(["char:alice", "char:bob"]).length, 0,
        "a list of characters is refused rather than merged, because a union is not a character");

      // The direction of the failure matters as much as the fact of it. Losing
      // bridges makes a route longer; gaining somebody else's strands a pilot.
      t.check(app.routableBridges(undefined).length < app.bridgeEntries().length,
        "so the unsafe direction is the one that cannot happen");

      // --- and the seam a selector will actually plug into ----------------------
      //
      // The check above proves the helper. It does not prove the router calls
      // it, and reverting the call site to the unguarded form leaves the suite
      // green - because routingSource returns a constant today. The guard that
      // is load-bearing is therefore routingSource's own, and this is it:
      // whatever a future selector puts in state.travelCharacter, nothing but a
      // usable single source comes out.
      const savedCharacter = state.travelCharacter;
      try {
        for (const chosen of [undefined, null, "", 0, false, ["char:alice", "char:bob"], {}]) {
          state.travelCharacter = chosen;
          app.refreshBridges();
          const routable = state.bridges ? app.bridgeEntries(app.routingSource()) : [];
          t.check(typeof app.routingSource() === "string" && app.routingSource() !== "",
            `travelCharacter ${JSON.stringify(chosen) ?? "undefined"} still yields one usable source`);
          t.check(routable.length < 2,
            "and never the union of two characters' bridges");
        }
        state.travelCharacter = "char:alice";
        t.equal(app.routingSource(), "char:alice", "while a chosen character is used as given");
      } finally {
        state.travelCharacter = savedCharacter;
        app.refreshBridges();
      }
    } finally {
      state.live = saved;
    }
  }

  // --- the Remove button closes the row it is looking at -----------------------
  //
  // `close` took no source and used an id-only index, so with two observers holding
  // one key the button either did nothing - the row it found was already closed by
  // the other source's sync - or closed a window belonging to somebody else. Both
  // are silent: the list redraws and the bridge is still there, or somebody else's
  // sighting has been ended on their behalf.
  //
  // Driven through the markup and the bind, not through `dropBridge`. Calling the
  // function directly passes the key and nothing else, and a manual bridge's source
  // *is* the default - so a row that had lost its `data-drop-source` still closed
  // the right window and the assertion saw nothing. This row belongs to a scout.
  {
    const SCOUT = "character:Scout";
    const saved = state.live;
    try {
      state.live = createSightings();
      const key = `${idOf("Jita")}-${idOf("Amarr")}`;
      observe(state.live, {
        kind: "bridge", key,
        value: { from: idOf("Jita"), to: idOf("Amarr"), fromName: "Jita", toName: "Amarr" },
        source: SCOUT,
      });
      app.refreshBridges();

      const button = ui.bridgeList.querySelector("[data-drop-bridge]");
      t.check(Boolean(button), "the scout's bridge draws a Remove button");
      t.equal(button?.dataset?.dropBridge ?? null, key, "carrying which bridge it removes");
      t.equal(button?.dataset?.dropSource ?? null, SCOUT, "and whose observation it is");

      button.onclick();
      t.equal(openForSource(state.live, "bridge", key, SCOUT), null,
        "clicking it closes the scout's window");
      t.equal(openObservations(state.live, "bridge").length, 0, "leaving nothing open");
      t.equal(historyOf(state.live, "bridge", key).length, 1,
        "and the observation kept as history rather than deleted");
    } finally {
      state.live = saved;
      app.refreshBridges();
    }
  }

  return t.results;
}
