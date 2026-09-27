// The live layers behind one control.
//
// Three layers on three cache windows - sovereignty hourly, ambient in
// minutes, activity hourly - reached by one button. Separate buttons asked the
// pilot to know which endpoint carries which fact, which is this tool's problem
// and not theirs, and left three ways to be looking at two-thirds of a current
// map without noticing.
//
// So the button is shared and the ages are not. A single merged age would be
// either the optimistic one or a lie, and each layer keeps its own slot saying
// how old its own half is.

import { readArchive, readRegion, suite } from "./helpers.mjs";
import { RoutePlanner } from "../web/route-planner.js";
import { campaignPanel, heatPanel } from "../web/panels.js";
import { playerKillsIn, sampleCount } from "../web/activity.js";
import { STORAGE_KEYS, readJson } from "../web/settings.js";
import { isDue } from "../web/esi.js";

const LIVE_KEY = "new-eden-atlas-live-v1";
const headers = map => ({ get: name => map[name.toLowerCase()] ?? null });

export default function run(app) {
  const t = suite("live bar");
  const { state, ui } = app;
  const atlas = readArchive();
  state.atlas = atlas;
  state.routePlanner = new RoutePlanner(atlas);

  const forge = readRegion("The Forge");
  const systems = Object.values(forge.systems);
  const hotId = systems[0].system_id;
  const quietId = systems[9].system_id;

  // One fake for five endpoints. `down` names the layers that should fail, so a
  // test can take one out and watch the others land.
  const serve = ({ down = [], at = Date.now(), kills = null, campaigns = null, scout = null } = {}) => async url => {
    const path = String(url);
    const layer = path.includes("sovereignty/campaigns") ? "campaigns"
      : path.includes("sovereignty") ? "sov"
      : path.includes("incursions") ? "incursions"
      : path.includes("fw/systems") ? "fw"
      : path.includes("system_kills") ? "kills"
      : path.includes("eve-scout") ? "scout"
      : "jumps";
    if (down.includes(layer) || down.includes("all")) throw new TypeError("Failed to fetch");
    const body = {
      sov: [{ system_id: systems[0].system_id, alliance_id: 4242, corporation_id: 7 }],
      incursions: [],
      fw: [],
      kills: kills ?? [{ system_id: hotId, ship_kills: 11, pod_kills: 4, npc_kills: 0 }],
      jumps: [{ system_id: hotId, ship_jumps: 640 }],
      scout: scout ?? [{
        id: "s1", signature_type: "wormhole", wh_type: "J377", max_ship_size: "large",
        expires_at: new Date(at + 6 * 3_600_000).toISOString(),
        created_by_name: "A Scout", created_by_id: 42,
        out_system_id: 30002086, out_system_name: "Turnur",
        in_system_id: hotId, in_system_name: systems[0].name, in_system_class: "hs",
      }],
      campaigns: campaigns ?? [{
        campaign_id: 991, constellation_id: systems[0].constellation_id,
        solar_system_id: hotId, defender_id: 4242, structure_id: 7,
        event_type: "ihub_defense", attackers_score: 0.4, defender_score: 0.6,
        start_time: new Date(Date.now() - 600_000).toISOString(),
      }],
    }[layer];
    return {
      ok: true,
      status: 200,
      headers: headers({
        "last-modified": new Date(at).toUTCString(),
        expires: new Date(at + 3_600_000).toUTCString(),
        etag: `W/"${layer}"`,
      }),
      json: async () => body,
    };
  };

  return (async () => {
    localStorage.removeItem(LIVE_KEY);
    app.restoreLive();

    // --- before anything is synced -----------------------------------------------
    t.check(!app.activityKnown(), "a fresh install has never synced activity");
    t.check(/activity: never synced/.test(ui.activityAge.textContent), "and says so in its own slot");
    t.check(/sov: never synced/.test(ui.sovAge.textContent), "as does sovereignty");
    t.check(/ambient: never synced/.test(ui.ambientAge.textContent), "and ambient");
    t.equal(app.heatIn(quietId), null, "and the inspector is told nothing about kills");
    t.equal(heatPanel(null), "", "so it draws no activity section");

    // The dangerous confusion this layer can cause: a tool that has never asked
    // reporting no kills reads exactly like a system where nobody died.
    t.check(!/no player kills/.test(ui.activityAge.textContent),
      "an unsynced layer does not report quiet, which would be a finding");

    // --- one button, three layers ---------------------------------------------------
    await app.syncLive({ fetchImpl: serve() });
    t.check(app.sovereigntyKnown(), "one Sync reaches sovereignty");
    t.check(app.ambientKnown(), "and ambient");
    t.check(app.activityKnown(), "and activity");
    t.equal(ui.liveError.textContent, "", "with nothing to report");

    t.equal(playerKillsIn(state.activity, hotId), 15, "kills land in the series");
    t.check(/15 player kills/.test(app.heatIn(hotId)?.text ?? ""),
      "and are described as ships plus pods, not ships alone");
    t.check(/4 pods/.test(app.heatIn(hotId)?.text ?? ""), "with pods called out, since being podded means somebody meant it");
    t.check(/640 jumps/.test(app.heatIn(hotId)?.text ?? ""), "alongside the traffic");
    t.check(new RegExp(systems[0].name).test(ui.activityAge.textContent),
      "and the worst system is named in the bar");

    // A measured zero. After a sync, a system in neither list is quiet - which
    // is a finding, and a different statement from the one above.
    const quiet = app.heatIn(quietId);
    t.check(quiet !== null, "a quiet system now has a reading");
    t.equal(quiet?.playerKills ?? null, 0, "of zero");
    t.check(/no player kills/.test(quiet?.text ?? ""), "which says so plainly");
    t.check(/Activity/.test(heatPanel(quiet)), "and the inspector shows the section");
    // Age, on the panel and not only on the bar. This was the one live section
    // that was handed an instant and printed none, so a six-hour-old count read
    // as a statement about right now.
    t.check(/synced/i.test(heatPanel(quiet)), "with the age of the reading on it");
    t.check(!/Last hour<\/span>/.test(heatPanel(quiet)),
      "and no heading claiming the reading describes the hour just past");

    // --- the kills endpoint down on its own -----------------------------------------
    // The dangerous half. Jumps answering while kills 503s leaves the bar reading
    // "quiet" and the panel reading "no player kills", both of which are measurements,
    // over an endpoint that never replied.
    await app.syncLive({ fetchImpl: serve({ down: ["kills"] }) });
    // The previous kill numbers are kept - they are the last confirmed reading,
    // and discarding real intelligence because one sync failed would be the
    // opposite mistake - but nothing may present them as this hour's.
    t.check(/carried/.test(ui.activityAge.textContent),
      "with kills down the bar marks the counts as carried rather than measured");
    t.check(/Kill counts did not sync/.test(ui.liveError.textContent),
      "and names the half that failed rather than saying the rest is current and stopping");
    const carriedPanel = heatPanel(app.heatIn(hotId));
    t.check(/last measured earlier/.test(carriedPanel),
      "the inspector says the kill figures are not from this sync");
    t.check(/15 player kills/.test(carriedPanel), "while still showing what was last confirmed");
    t.check(/synced/i.test(carriedPanel), "with the age of that measurement on it");

    // --- each layer keeps its own age ------------------------------------------------
    t.check(/sov:/.test(ui.sovAge.textContent) && /ambient:/.test(ui.ambientAge.textContent)
      && /activity:/.test(ui.activityAge.textContent),
      "every slot says which layer it is talking about");
    t.check(/synced/.test(ui.activityAge.textContent), "and how old its own half is");

    // --- one layer down ---------------------------------------------------------------
    await app.syncLive({ fetchImpl: serve({ down: ["kills", "jumps"] }) });
    t.check(/Activity did not sync/.test(ui.liveError.textContent), "a layer that fails is named");
    t.check(app.sovereigntyKnown() && app.ambientKnown(), "while the others stay current");
    t.equal(playerKillsIn(state.activity, hotId), 15, "and the failed layer keeps what it had");

    // --- everything down ----------------------------------------------------------------
    localStorage.removeItem(LIVE_KEY);
    app.restoreLive();
    await app.syncLive({ fetchImpl: serve({ down: ["all"] }) });
    t.check(/No live layer could be reached/.test(ui.liveError.textContent),
      "with nothing known and nothing reachable, the bar says so once");
    t.check(/map and routing are unaffected/.test(ui.liveError.textContent),
      "and says what still works, because this tool is offline-first and that is the point");

    // --- the series survives a reload -----------------------------------------------------
    const hour = 3_600_000;
    const t0 = Date.now() - 3 * hour;
    await app.syncLive({ fetchImpl: serve({ at: t0 }) });
    await app.syncLive({ fetchImpl: serve({ at: t0 + hour, kills: [{ system_id: hotId, ship_kills: 2, pod_kills: 0, npc_kills: 0 }] }) });
    t.equal(sampleCount(state.activity), 2, "two hours, two samples");

    app.restoreLive();
    t.check(app.activityKnown(), "a reload remembers that activity was synced");
    t.equal(sampleCount(state.activity), 2, "with the whole series");
    t.equal(playerKillsIn(state.activity, hotId), 2, "and the latest reading");
    t.equal(app.heatIn(hotId)?.jumps ?? null, 640, "including traffic, which only the latest sample carries");
    t.equal(app.heatIn(hotId)?.trend?.length ?? null, 2, "so a trend survives the reload too");

    // Series present but no record of when: a truncated save. Drawing kills
    // while the bar reads "never synced" would be the interface contradicting
    // itself, the same line sovereignty draws.
    const saved = JSON.parse(localStorage.getItem(LIVE_KEY));
    localStorage.setItem(LIVE_KEY, JSON.stringify({ ...saved, activity: null }));
    app.restoreLive();
    t.check(sampleCount(state.activity) > 0, "the series is still there");
    t.check(!app.activityKnown(), "but nothing is known about when");
    t.equal(app.heatIn(hotId), null, "so the inspector is told nothing");

    // --- routing reads the kill numbers ----------------------------------------------------
    localStorage.removeItem(LIVE_KEY);
    app.restoreLive();
    ui.routeHeat.value = "cautious";

    // Asked for, but nothing synced. The route must be the unweighted one and
    // must not claim to have weighed anything - the same line every live layer
    // here draws between a measured answer and an unasked question.
    t.check(!app.buildHeat().applied, "with nothing synced, kills are not weighed");
    t.equal(app.buildHeat().weight, 2, "though the setting is still carried, so the panel can say so");

    // Stated, not inherited. These fields are shared across the whole suite and
    // a limit left set by an earlier one quietly constrained this route.
    ui.routeFrom.value = "Jita";
    ui.routeTo.value = "Amarr";
    ui.routeMode.value = "shortest";
    ui.avoidSystems.value = "";
    ui.avoidRegions.value = "";
    ui.routeMinSec.value = "";
    ui.routeMaxSec.value = "";
    app.refreshAvoid();
    app.calculateRoute();
    const unweighted = state.route.jumps;
    t.equal(unweighted, 11, "the unweighted Jita-Amarr route is the plain one");
    t.check(!state.route.heat.applied, "and the route says it did not weigh them");
    t.check(/no activity data/i.test(ui.content.innerHTML),
      "which the panel states rather than showing an empty kill list");

    // Now with data. The system is on the route and hot enough that cautious
    // will not pay for the detour, so it is crossed and reported.
    const onRoute = state.route.systems[3];
    await app.syncLive({ fetchImpl: serve({ kills: [{ system_id: onRoute.system_id, ship_kills: 30, pod_kills: 10, npc_kills: 0 }] }) });
    app.calculateRoute();
    t.check(app.buildHeat().applied, "with activity synced, kills are weighed");
    t.check(state.route.heat.applied, "and the route says so");
    t.equal(state.route.heat.weight, 2, "at the strength asked for");
    t.equal(app.buildHeat().kills.get(onRoute.system_id), 40,
      "counting ships and pods together, which is what player kills means");
    t.check(state.route.hotCrossed.some(entry => entry.system.system_id === onRoute.system_id),
      "the route reports the hot system it crossed");
    // "the reported hour", not "the last hour" - the counts are as old as the
    // sample they came from, and this row sits beside the age that says so.
    t.check(/40 in the reported hour/.test(ui.content.innerHTML), "with the count, in the panel");
    t.check(!/in the last hour/.test(ui.content.innerHTML),
      "and nothing in the panel still claims the reading describes the hour just past");

    // Turned up, the same numbers buy the detour.
    ui.routeHeat.value = "paranoid";
    app.calculateRoute();
    t.check(!state.route.systems.some(s => s.system_id === onRoute.system_id),
      "at paranoid the route goes around it");
    t.check(state.route.jumps > unweighted, "which costs jumps");

    // And the setting is part of what a route depends on, or a route found at
    // one strength would sit on screen looking like one found at another.
    ui.routeHeat.value = "off";
    app.calculateRoute();
    t.equal(state.route.jumps, unweighted, "turned off, the route is the unweighted one again");
    app.saveRouteSettings();
    t.equal(readJson(localStorage, STORAGE_KEYS.route).heat, "off", "the setting is saved");
    ui.routeHeat.value = "paranoid";
    app.restoreRouteSettings();
    t.equal(ui.routeHeat.value, "off", "and restored");

    // --- sovereignty timers --------------------------------------------------------------
    localStorage.removeItem(LIVE_KEY);
    app.restoreLive();
    t.check(!app.campaignsKnown(), "a fresh install has never synced timers");
    t.check(/timers: never synced/.test(ui.campaignAge.textContent), "and says so in its own slot");
    t.equal(app.campaignsFor(hotId), null, "and tells the inspector nothing");
    t.equal(campaignPanel(null), "", "so it draws no timer section");

    await app.syncLive({ fetchImpl: serve() });
    t.check(app.campaignsKnown(), "the one Sync reaches timers too");
    t.check(/1 live/.test(ui.campaignAge.textContent),
      "a campaign whose time has come is counted as live");
    t.check(/0 in 24h/.test(ui.campaignAge.textContent),
      "and not also counted as upcoming, which is a different problem");

    const here = app.campaignsFor(hotId);
    t.equal(here.length, 1, "the system under attack reports its timer");
    t.check(here[0].live, "marked as happening rather than scheduled");
    t.check(/Infrastructure hub/.test(here[0].text), "naming what is being fought over");
    t.check(/Under attack/.test(campaignPanel(here)), "which the inspector separates from scheduled ones");
    t.equal(app.campaignsFor(quietId).length, 0, "while a quiet system reports none");

    // Scheduled rather than live, which must read differently.
    await app.syncLive({ fetchImpl: serve({ campaigns: [{
      campaign_id: 992, constellation_id: systems[0].constellation_id,
      solar_system_id: hotId, defender_id: 4242, structure_id: 8,
      event_type: "tcu_defense", attackers_score: 0.5, defender_score: 0.5,
      start_time: new Date(Date.now() + 3 * 3_600_000).toISOString(),
    }] }) });
    t.check(/0 live/.test(ui.campaignAge.textContent), "a timer three hours out is not live");
    t.check(/1 in 24h/.test(ui.campaignAge.textContent), "it is upcoming");
    t.check(!app.campaignsFor(hotId)[0]?.live, "and the inspector says scheduled");
    t.check(/Scheduled/.test(campaignPanel(app.campaignsFor(hotId))), "in as many words");
    t.check(!/attackers/.test(app.campaignsFor(hotId)[0].text),
      "without a score, which before the fight is a starting position rather than progress");

    // The map tells them apart too.
    state.region = forge;
    state.mode = "region";
    app.setLayoutMode("atlas");
    app.renderRegion();
    const node = state.nodes.find(n => n.record.system_id === hotId);
    t.check(node.el.classList.contains("timer-soon"), "a scheduled timer is marked on the map");
    t.check(!node.el.classList.contains("timer-live"), "and not as one already running");
    await app.syncLive({ fetchImpl: serve() });
    app.renderRegion();
    const live = state.nodes.find(n => n.record.system_id === hotId);
    t.check(live.el.classList.contains("timer-live"), "while a running one is marked as running");
    state.region = null;
    state.mode = "universe";

    // --- one tick, every clock-driven surface -----------------------------------------------
    //
    // One layer on the timer ages while the others sit frozen at whatever they last
    // said: four slots side by side, one counting and three stopped.
    localStorage.removeItem(LIVE_KEY);
    app.restoreLive();
    const anHourAgo = Date.now() - 62 * 60_000;
    await app.syncLive({ fetchImpl: serve({ at: anHourAgo }) });
    app.renderLiveAges();
    for (const [layer, slot] of [["sov", ui.sovAge], ["ambient", ui.ambientAge],
                                 ["activity", ui.activityAge], ["timers", ui.campaignAge]]) {
      t.check(/1h ago/.test(slot.textContent),
        `${layer} ages on the shared tick (${slot.textContent})`);
    }

    // The template and the tick call the same function on the same instant, so
    // they cannot disagree about wording or casing.
    t.equal(app.liveTimeText("age", anHourAgo), "Synced 1h ago", "ages read one way");
    // The wording is decided in one place; the caller only says where the text
    // sits. Mid-line it keeps its lower case, starting a sentence it does not.
    const soon = Date.now() + 90 * 60_000;
    t.check(/^in /.test(app.liveTimeText("countdown", soon, { embedded: true })),
      "a countdown mid-line reads as time remaining");
    t.check(/^In /.test(app.liveTimeText("countdown", soon)),
      "and takes a capital where it starts a sentence");
    t.check(/left$/.test(app.liveTimeText("remaining", soon, { embedded: true })),
      "an expiry reads as what is left of it");
    t.equal(app.liveTimeText("age", anHourAgo, { embedded: true }), "synced 1h ago",
      "and an age embedded in a bar keeps the lower case it is written in");
    t.equal(app.liveTimeText("age", Number.NaN), "", "an unknown instant renders nothing at all");
    t.equal(app.liveTimeText("nonsense", Date.now()), "", "as does a kind nobody handles");

    // Found by selector, so a span added later is refreshed without anyone
    // remembering to wire it up - and an unmounted one simply stops being found.
    state.region = forge;
    state.mode = "region";
    app.renderRegion();
    app.showSystem(systems[0]);
    const carriers = ui.content.querySelectorAll("[data-live-at]");
    t.check(carriers.length > 0, "an open inspector carries its instants in the DOM");
    t.check(carriers.every(span => Number.isFinite(Number(span.dataset.liveAt))),
      "each as a millisecond instant, not a seconds one");
    app.tickLiveTimes();
    t.check(carriers.every(span => span.textContent.length > 0), "and every one refreshes");
    state.region = null;
    state.mode = "universe";

    // --- what the template renders is what the tick renders ----------------------------------
    //
    // Asserted over every time-driven span at once rather than one per element,
    // so a span added later is covered the day it appears. This is the whole
    // drift class in one property: at the same instant, a fresh render and a
    // tick must produce identical text. They did not, and the gap was a capital
    // letter that went missing thirty seconds after the panel opened.
    state.region = forge;
    state.mode = "region";
    app.renderRegion();
    await app.syncLive({ fetchImpl: serve({ campaigns: [{
      campaign_id: 993, constellation_id: systems[0].constellation_id,
      solar_system_id: hotId, defender_id: 4242, structure_id: 9,
      event_type: "tcu_defense", attackers_score: 0.5, defender_score: 0.5,
      start_time: new Date(Date.now() + 2 * 3_600_000).toISOString(),
    }] }) });
    app.ignoreSystem(hotId, { duration: "week" });
    app.showSystem(systems[0]);

    const spans = ui.content.querySelectorAll("[data-live-at]");
    t.check(spans.length >= 3, `the inspector carries several time-driven spans (${spans.length})`);
    const kinds = new Set(spans.map(span => span.dataset.liveKind));
    t.check(kinds.has("age") && kinds.has("countdown") && kinds.has("remaining"),
      `all three kinds are exercised (${[...kinds].join(", ")})`);

    const rendered = spans.map(span => span.textContent);
    const frozen = Date.now();
    app.tickLiveTimes(frozen);
    t.check(ui.content.querySelectorAll("[data-live-at]").every((span, i) => span.textContent === rendered[i]),
      "a tick at the same instant changes nothing a template wrote");

    // And an hour later everything has moved, in its own direction.
    app.tickLiveTimes(frozen + 3_600_000);
    const later = ui.content.querySelectorAll("[data-live-at]").map(span => span.textContent);
    t.check(later.some((text, i) => text !== rendered[i]), "an hour later they have all moved");
    t.check(later.every(text => text.length > 0), "and none of them emptied");

    app.renderAvoidList();
    const listed = ui.ignoreList.querySelectorAll("[data-live-at]");
    t.check(listed.length > 0, "the avoidance list carries its countdown too");
    t.check(listed.every(span => /left$/.test(span.textContent)),
      "reading as what is left of it, from the same transform");

    state.region = null;
    state.mode = "universe";

    // --- Thera and Turnur, off unless asked for --------------------------------------------
    localStorage.removeItem(LIVE_KEY);
    app.restoreLive();
    ui.scoutEnabled.checked = false;
    ui.scoutHull.value = "medium";

    // Off means not fetched at all. A third-party service should not be called
    // by a tool the pilot has not opted into.
    let asked = false;
    await app.syncLive({ fetchImpl: async url => {
      if (String(url).includes("eve-scout")) asked = true;
      return serve()(url);
    } });
    t.check(!asked, "with the layer off, EVE-Scout is not contacted at all");
    t.check(!app.scoutKnown(), "and nothing is known about holes");
    t.check(ui.scoutBar.hidden, "its slot stays out of the bar");
    t.equal(app.routingNetwork()?.count ?? 0, 0, "and no wormhole reaches the router");

    ui.scoutEnabled.checked = true;
    await app.syncLive({ fetchImpl: serve() });
    t.check(app.scoutKnown(), "asked for, it syncs");
    t.check(!ui.scoutBar.hidden, "and takes its slot in the bar");
    t.check(/1 usable/.test(ui.scoutAge.textContent), `the bar counts what this hull can use (${ui.scoutAge.textContent})`);

    // The scout's name must not have survived the boundary into storage.
    const stored = localStorage.getItem(LIVE_KEY);
    t.check(!stored.includes("A Scout"), "and no scout's name reached local storage");
    t.check(!stored.includes("created_by"), "nor any field that would carry one");

    // The hull gates the edge. A large hole is no use to a capital.
    t.equal(app.scoutSignatures().length, 1, "a battleship-rated hole suits a cruiser");
    ui.scoutHull.value = "capital";
    app.refreshScout();
    t.equal(app.scoutSignatures().length, 0, "and not a capital");
    t.check(/too small/.test(ui.scoutList.innerHTML),
      "which the list says, rather than dropping the connection from view");

    // Asking for the active ship without a character resolves to nothing, and
    // nothing means no edges - never a guess.
    ui.scoutHull.value = "active";
    app.refreshScout();
    t.equal(app.scoutSignatures().length, 0,
      "the active ship needs a character, so it gates everything through rather than guessing one");
    ui.scoutHull.value = "medium";
    app.refreshScout();

    // --- a hole that has expired must leave the route ---------------------------
    // The store law says a route uses only what is currently confirmed, and a
    // wormhole is the one routing edge that stops existing on a timer rather
    // than because somebody closed it. A plan still showing a lapsed hole sends
    // a pilot somewhere with no way back.
    //
    // Time is not wound forward here. `routingNetwork()` re-resolves the scout
    // layer at the real clock every time a route is calculated - deliberately,
    // so expiry is enforced per route rather than per tick - which means a test
    // that moves a fake clock forward has its work undone by the next
    // calculation. The way this actually happens is that a later sync carries a
    // hole whose expiry has passed, so that is what this does.
    t.check((state.scoutNet?.count ?? 0) > 0,
      `a usable hole is in the routing network (${state.scoutNet?.count ?? 0})`);

    const openHole = app.scoutSignatures()[0];
    t.check(openHole, "the hole is readable from the live store");
    const holeEnds = [openHole.outSystemId, openHole.inSystemId]
      .map(id => atlas.systems[String(id)]?.name)
      .filter(Boolean);
    t.equal(holeEnds.length, 2, `both ends of the hole resolve (${holeEnds.join(" - ")})`);

    ui.routeFrom.value = holeEnds[0];
    ui.routeTo.value = holeEnds[1];
    ui.routeMode.value = "shortest";
    app.calculateRoute();
    const viaHole = state.route;
    t.check(viaHole?.wormholeJumps > 0,
      `the route between its ends crosses the hole (${viaHole?.jumps} jumps, ${viaHole?.wormholeJumps} by hole)`);

    // The same signature, now lapsed, which is what EVE-Scout serves while a
    // hole is dying: still listed, expiry in the past.
    const lapsed = [{
      id: "s1", signature_type: "wormhole", wh_type: "J377", max_ship_size: "large",
      expires_at: new Date(Date.now() - 60_000).toISOString(),
      out_system_id: openHole.outSystemId, in_system_id: openHole.inSystemId,
      out_system_name: holeEnds[0], in_system_name: holeEnds[1], in_system_class: "hs",
    }];
    await app.syncLive({ fetchImpl: serve({ scout: lapsed }) });

    t.equal(state.scoutNet?.count ?? 0, 0, "a hole whose expiry has passed leaves the routing network");
    t.equal(app.scoutSignatures().length, 0, "and is offered to nothing");
    app.calculateRoute();
    t.check(!state.route?.wormholeJumps,
      "so a route recalculated after it lapsed crosses no hole");
    t.check(state.route && state.route.jumps > viaHole.jumps,
      `and takes the long way round instead (${viaHole.jumps} by hole, ${state.route?.jumps} by gate)`);

    // Put the shelf back as the rest of this file expects to find it: a live
    // hole, the route cleared, and the fields as they were.
    await app.syncLive({ fetchImpl: serve() });
    t.check((state.scoutNet?.count ?? 0) > 0, "and a fresh sync restores the open hole");
    app.clearRoute();
    ui.routeFrom.value = "";
    ui.routeTo.value = "";


    // --- and it routes ------------------------------------------------------------------
    const net = app.routingNetwork();
    t.equal(net.count, 1, "the usable hole is one edge in the routing network");
    t.equal(net.kinds.get([...net.kinds.keys()][0]), "wormhole",
      "tagged as a wormhole, not a bridge - one expires and the other does not");

    ui.routeFrom.value = "Turnur";
    ui.routeTo.value = systems[0].name;
    ui.routeMode.value = "shortest";
    ui.avoidSystems.value = "";
    ui.routeMinSec.value = "";
    ui.routeMaxSec.value = "";
    app.refreshAvoid();
    app.calculateRoute();
    t.equal(state.route.jumps, 1, "and it shortens the route to one jump");
    t.equal(state.route.wormholeJumps, 1, "reported as a wormhole leg");
    t.equal(state.route.bridgeJumps, 0, "and not counted as a bridge");
    t.check(/route-leg-kind[^>]*>wormhole/.test(ui.content.innerHTML), "the pilot sees the wormhole leg label");

    const shelfBefore = ui.scoutList.textContent;
    const realNow = Date.now;
    try {
      const later = realNow() + 120_000;
      Date.now = () => later;
      app.tickLiveTimes(later);
      t.check(ui.scoutList.textContent !== shelfBefore, "the shared tick advances the wormhole shelf countdown");
      Date.now = () => later + 48 * 3_600_000;
      t.equal(app.routingNetwork()?.count ?? 0, 0, "routing drops expired holes without needing a sync or tick");
      app.tickLiveTimes(Date.now());
      app.calculateRoute();
      t.equal(state.route.wormholeJumps, 0, "a recalculated route cannot use an expired wormhole");
    } finally {
      Date.now = realNow;
      app.refreshScout();
    }

    ui.scoutEnabled.checked = false;
    app.refreshScout();
    app.calculateRoute();
    t.check(state.route.jumps > 1, "turned off, the route goes the long way again");
    t.equal(state.route.wormholeJumps, 0, "with no wormhole legs");

    ui.scoutEnabled.checked = false;
    app.refreshScout();

    // --- a layer with no stated expiry must still go stale ----------------------
    // esi.js falls back to a conservative hour when a response states no
    // Expires, "short enough that a missing header does not freeze a layer
    // forever". The activity layer walked around it: taking Math.min of the two
    // halves produced Infinity when neither stated one, Infinity is truthy, so
    // nextPollAt returned it rather than falling back - and isDue was false
    // for the rest of the session. The layer could never read as stale again.
    const noExpiry = (url, options) => {
      const inner = serve()(url, options);
      return inner.then(response => ({
        ...response,
        headers: { get: name => (/expires|cache-control/i.test(name) ? null : response.headers.get(name)) },
      }));
    };
    await app.syncLive({ fetchImpl: noExpiry });
    t.check(app.activityKnown(), "a response with no Expires still syncs");
    t.check(Number.isFinite(state.activityMeta.expiresAt) || state.activityMeta.expiresAt === null,
      `the recorded expiry is a number or nothing, never Infinity (${state.activityMeta.expiresAt})`);
    t.check(isDue({ ...state.activityMeta, fetchedAt: Date.now() - 2 * 3_600_000 }),
      "so two hours later the layer is due again rather than frozen");

    await app.syncLive({ fetchImpl: serve() });

    // --- a save this build cannot read must be left alone -----------------------
    // Every reader in the live store degrades rather than throwing, which is
    // right - the map keeps drawing. But a store whose shape has moved on comes
    // back as zero observations, and the next save then writes that empty store
    // over the one it could not read. The closed windows are the whole point of
    // this log ("gone is closed, never deleted, because the disappearance is
    // itself the intelligence"), and a version bump would have deleted all of
    // them at once, on startup, without a word.
    //
    // The schema field was written and never read, which is the one arrangement
    // that makes it dangerous rather than merely unused.
    await app.syncLive({ fetchImpl: serve() });
    const goodSave = localStorage.getItem(LIVE_KEY);
    t.check(goodSave && goodSave.length > 100, "a normal session writes a live store");

    const fromTheFuture = JSON.stringify({ ...JSON.parse(goodSave), schema: 99 });
    localStorage.setItem(LIVE_KEY, fromTheFuture);
    app.restoreLive();
    t.check(!app.sovereigntyKnown(), "a save from another schema is not read as this one");
    app.persistLive();
    t.equal(localStorage.getItem(LIVE_KEY), fromTheFuture,
      "and is left exactly as it was rather than overwritten with the empty fallback");
    t.check(/version 99/.test(ui.persistError.textContent),
      `saying which version it found (${ui.persistError.textContent.slice(0, 60)})`);
    t.check(state.persistFailed, "and reporting that nothing is being saved");

    // A save with no schema at all predates the field and is this shape.
    const legacy = JSON.parse(goodSave);
    delete legacy.schema;
    localStorage.setItem(LIVE_KEY, JSON.stringify(legacy));
    app.restoreLive();
    t.check(app.sovereigntyKnown(), "a save written before the field existed is still read");

    localStorage.setItem(LIVE_KEY, goodSave);
    app.restoreLive();
    ui.persistError.textContent = "";

    // --- a save that does not happen must not be silent -------------------------------------
    // Local storage refuses when it is full, or in a mode that forbids it. A
    // sync would otherwise look like it worked, the tool would behave correctly
    // all session, and the next launch would say "never synced" with nothing to
    // explain why.
    const realSetItem = localStorage.setItem.bind(localStorage);
    localStorage.setItem = () => { throw new Error("QuotaExceededError"); };
    ui.liveError.textContent = "";
    await app.syncLive({ fetchImpl: serve() });
    t.check(state.persistFailed, "a refused save is noticed");
    // Its own slot, not the shared one. Sharing meant a layer failure could
    // overwrite it - telling the pilot "the rest is current" while nothing at
    // all was being written to disk - and that a recovered save left the
    // warning on screen because nothing ever cleared it. Two independent facts
    // need two places to say themselves.
    t.check(/could not be saved/i.test(ui.persistError.textContent), "and said out loud");
    // And why, not only that. The sighting log only grows - closures are kept,
    // because a disappearance is itself the intelligence - while local storage
    // has a hard quota of a few megabytes. At roughly 200 bytes an observation
    // that is around twenty-five thousand of them, after which nothing is saved
    // again. The generic message sends the pilot to look at their disk; the
    // cause is a history that has outgrown where it is kept.
    t.check(/observations/.test(ui.persistError.textContent),
      `naming how much history is being held (${ui.persistError.textContent.slice(-70)})`);
    t.check(/MB/.test(ui.persistError.textContent), "and how large that makes the save");
    t.check(/lost when this page closes/i.test(ui.persistError.textContent),
      "naming the consequence, since everything still works until then");
    t.check(app.activityKnown(), "while the session keeps the data it fetched");

    // A layer failing at the same time must not be able to erase it.
    await app.syncLive({ fetchImpl: serve({ down: ["kills"] }) });
    t.check(/could not be saved/i.test(ui.persistError.textContent),
      "a layer failure in the same sync does not overwrite the storage warning");

    localStorage.setItem = realSetItem;
    await app.syncLive({ fetchImpl: serve() });
    t.check(!state.persistFailed, "and a save that works clears the warning");
    t.equal(ui.persistError.textContent, "", "from the screen as well as from the state");

    // --- activity synced, and only the kills half failed -------------------------
    //
    // `killsKnown()` is false in two states, and the route panel reported both as
    // "no activity data has been synced" - which contradicts the live bar directly
    // above it, because jumps answered and the bar says so. `app.js` spells out
    // this distinction as the reason `killsKnown` exists separately from
    // `activityKnown`, and then the sentence collapsed it again.
    //
    // Driven end to end on purpose. `buildHeat` decides the reason, `calculate`
    // has to carry it, and the panel has to say it; asserting the panel alone with
    // a hand-built heat object left both hops between them free to break, which
    // mutation proved twice.
    localStorage.removeItem(LIVE_KEY);
    app.restoreLive();
    ui.routeHeat.value = "cautious";
    ui.routeFrom.value = "Jita";
    ui.routeTo.value = "Amarr";
    ui.routeMode.value = "shortest";
    ui.avoidSystems.value = "";
    ui.avoidRegions.value = "";
    ui.routeMinSec.value = "";
    ui.routeMaxSec.value = "";
    app.refreshAvoid();
    await app.syncLive({ fetchImpl: serve({ down: ["kills"] }) });
    t.check(app.activityKnown(), "jumps answered, so activity is known");
    t.equal(app.buildHeat().applied, false, "but kills are not weighed");
    t.equal(app.buildHeat().unweighed, "kills-absent",
      "and buildHeat names which half is missing rather than reporting nothing synced");
    app.calculateRoute();
    t.equal(state.route.heat.unweighed, "kills-absent",
      "the calculator carries that reason out to the panel");
    t.check(/kills half did not answer/.test(ui.content.innerHTML),
      "which the panel states");
    t.check(!/no activity data has been synced/.test(ui.content.innerHTML),
      "instead of contradicting the live bar sitting above it");

    // And the other state still reads as itself: nothing synced at all.
    localStorage.removeItem(LIVE_KEY);
    app.restoreLive();
    app.calculateRoute();
    t.equal(app.buildHeat().unweighed, "never-synced", "with nothing synced, that is the reason given");
    t.check(/no activity data has been synced/.test(ui.content.innerHTML),
      "and the panel says so, which is true here and was not true above");

    // --- leave the harness as it was found -------------------------------------------------
    localStorage.removeItem(LIVE_KEY);
    app.restoreLive();
    ui.liveError.textContent = "";
    ui.persistError.textContent = "";
    ui.routeHeat.value = "off";
    app.clearRouteResult();
    state.region = null;
    state.mode = "universe";
    return t.results;
  })();
}
