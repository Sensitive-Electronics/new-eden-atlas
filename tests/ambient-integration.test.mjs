// Ambient state, as wired into the application.
//
// Two public endpoints behind one button, because they answer the same
// question - is this space safe to cross tonight - and neither earns a control
// of its own. Which makes the interesting cases the ones where they disagree
// about whether they worked.
//
// A partial sync is worth more than none: one endpoint being down is no reason
// to throw away the other's answer. But a partial sync must not look like a
// whole one, and the age on screen has to be the age of the stalest thing
// showing rather than the freshest, or the overlay quietly overstates itself.

import { readArchive, readRegion, suite } from "./helpers.mjs";
import { RoutePlanner } from "../web/route-planner.js";
import { ambientPanel } from "../web/panels.js";
import { contestedFrontlines, incursionSystems } from "../web/ambient.js";

const LIVE_KEY = "new-eden-atlas-live-v1";
const headers = map => ({ get: name => map[name.toLowerCase()] ?? null });

export default function run(app) {
  const t = suite("ambient wiring");
  const { state, ui } = app;
  const atlas = readArchive();
  state.atlas = atlas;
  state.routePlanner = new RoutePlanner(atlas);

  const forge = readRegion("The Forge");
  const systems = Object.values(forge.systems);
  const infestedIds = systems.slice(0, 3).map(s => s.system_id);
  const frontId = systems[5].system_id;

  const incursion = (over = {}) => ({
    constellation_id: systems[0].constellation_id,
    faction_id: 500019,
    has_boss: true,
    infested_solar_systems: infestedIds,
    influence: 1,
    staging_solar_system_id: infestedIds[0],
    state: "established",
    ...over,
  });
  const frontline = (over = {}) => ({
    contested: "contested",
    occupier_faction_id: 500003,
    owner_faction_id: 500002,
    solar_system_id: frontId,
    victory_points: 37500,
    victory_points_threshold: 75000,
    ...over,
  });

  // One fake for both calls, dispatching on the path, so a test can fail one
  // endpoint and leave the other working - which is the case that matters.
  const serve = ({ incursions = [incursion()], frontlines = [frontline()], ages = {} } = {}) => async url => {
    const which = String(url).includes("incursions") ? "incursions" : "frontlines";
    const body = which === "incursions" ? incursions : frontlines;
    if (body === "offline") throw new TypeError("Failed to fetch");
    const at = ages[which] ?? Date.now();
    return {
      ok: true,
      status: 200,
      headers: headers({
        expires: new Date(at + 300_000).toUTCString(),
        etag: `W/"${which}"`,
        "last-modified": new Date(at).toUTCString(),
      }),
      json: async () => body,
    };
  };

  return (async () => {
    localStorage.removeItem(LIVE_KEY);
    app.restoreLive();

    // --- before any sync --------------------------------------------------------
    t.check(!app.ambientKnown(), "a fresh install has never synced ambient state");
    t.check(/never synced/.test(ui.ambientAge.textContent), "and says so");
    t.check(!/0 incursions/.test(ui.ambientAge.textContent),
      "rather than reporting no incursions, which would be a finding");
    t.equal(app.ambientOf(infestedIds[0]), null, "and tells the inspector nothing");
    t.equal(ambientPanel(null), "", "which draws no section at all");

    // --- a sync ------------------------------------------------------------------
    await app.syncAmbient({ fetchImpl: serve() });
    t.check(app.ambientKnown(), "after a sync, ambient state is known");
    t.equal(ui.ambientError.textContent, "", "with no error");
    t.equal(incursionSystems(state.live).size, 3, "the infested systems are recorded");
    t.equal(contestedFrontlines(state.live).length, 1, "and the contested one");
    t.check(/1 incursion · 1 contested/.test(ui.ambientAge.textContent),
      "the bar counts incursions by constellation, not by infested system");
    t.check(/synced/.test(ui.ambientAge.textContent), "and how long ago");

    const infested = app.ambientOf(infestedIds[0]);
    t.check(/Sansha/.test(infested.incursionText), "a system in an incursion names the faction");
    t.check(/staging/.test(infested.incursionText), "and says it is the staging system");
    t.check(/Incursion/.test(ambientPanel(infested)), "which the inspector shows");
    const front = app.ambientOf(frontId);
    t.check(/Amarr Empire/.test(front.frontlineText), "a contested system names who holds it");
    t.check(/Minmatar/.test(front.frontlineText), "and whose it is");
    t.check(/50%/.test(front.frontlineText), "and how far the grind has got");
    // **Synced and quiet is not the same as never asked**, and this assertion used
    // to require that they look identical. It read "a system with nothing
    // happening draws no section, rather than an empty one" - which is the right
    // rule for the *unsynced* case and the wrong one here, and it is the half of
    // the panel's own comment that got applied to both halves. That comment
    // justifies absence "when nothing has been synced", on the grounds that a
    // quiet section is a claim "an unsynced tool has no business making". A synced
    // one does have business making it: `sovereigntyPanel` says "No alliance holds
    // this system" with its age one section further down, and `campaignsFor`'s own
    // comment calls the distinction "the whole point" for a timer.
    //
    // So what is asserted is the distinction rather than either shape, because the
    // shapes are a judgement and the distinction is the requirement.
    const quiet = ambientPanel(app.ambientOf(systems[7].system_id));
    t.check(quiet !== "", "a synced system with nothing happening still draws a section");
    t.check(/No incursion/.test(quiet), "which says there is no incursion");
    t.check(/frontline/.test(quiet), "and no frontline, rather than leaving one of them open");
    t.check(/data-live-at/.test(quiet), "with the age of the sync that found nothing");
    t.check(quiet !== ambientPanel(null),
      "and it is not what an unsynced tool draws, which is the whole point");
    t.equal(ambientPanel(null), "", "that one still draws nothing at all");

    // --- one endpoint down --------------------------------------------------------
    // The other's answer is still worth having, and the failure is named rather
    // than hidden behind the success.
    await app.syncAmbient({ fetchImpl: serve({ incursions: "offline" }) });
    t.check(/Incursions did not sync/.test(ui.ambientError.textContent),
      "a half-failed sync says which half failed");
    t.equal(incursionSystems(state.live).size, 3, "the failed half keeps what it had");
    t.equal(contestedFrontlines(state.live).length, 1, "and the other half is current");
    t.check(app.ambientKnown(), "and the layer is still known");

    // The age shown is the older of the two, because an overlay is only as
    // current as its oldest part.
    const old = Date.now() - 45 * 60_000;
    await app.syncAmbient({ fetchImpl: serve({ ages: { incursions: old } }) });
    t.check(state.ambientMeta.dataAt <= old + 1000,
      "the reported age is the stalest part, not the freshest");
    t.check(/4[0-9]m ago/.test(ui.ambientAge.textContent), "which is what the bar shows");

    // And the half that did not sync at all still counts towards the age. Its
    // data is on screen, it is as old as it ever was, and an age computed over
    // only the half that succeeded would read "just now" while the other half
    // was an hour stale.
    await app.syncAmbient({ fetchImpl: serve({ incursions: "offline" }) });
    t.check(state.ambientMeta.dataAt <= old + 1000,
      "a retained half keeps its own age in the reckoning");
    t.check(/4[0-9]m ago/.test(ui.ambientAge.textContent),
      "so a fresh half cannot make a stale overlay look current");
    t.check(/Incursions did not sync/.test(ui.ambientError.textContent),
      "with the failure still named");

    // --- both down ------------------------------------------------------------------
    await app.syncAmbient({ fetchImpl: async () => { throw new TypeError("Failed to fetch"); } });
    t.check(/offline/i.test(ui.ambientError.textContent), "a wholly failed sync reports offline");
    t.check(/last synced/i.test(ui.ambientError.textContent), "and says what is on screen is older");
    t.equal(incursionSystems(state.live).size, 3, "keeping everything that was known");
    t.check(app.ambientKnown(), "and not resetting to never-synced");

    // --- it survives a reload ----------------------------------------------------------
    await app.syncAmbient({ fetchImpl: serve() });
    app.restoreLive();
    t.check(app.ambientKnown(), "a reload remembers that a sync happened");
    t.equal(incursionSystems(state.live).size, 3, "with the incursion");
    t.equal(contestedFrontlines(state.live).length, 1, "and the frontline");
    t.check(!/never synced/.test(ui.ambientAge.textContent), "and does not claim to be a fresh install");

    // Sightings without metadata: a truncated save. Drawing an overlay while
    // the bar reads "never synced" would be the interface contradicting itself.
    const saved = JSON.parse(localStorage.getItem(LIVE_KEY));
    localStorage.setItem(LIVE_KEY, JSON.stringify({ ...saved, ambient: null }));
    app.restoreLive();
    t.check(incursionSystems(state.live).size > 0, "the store still holds the sightings");
    t.check(!app.ambientKnown(), "but nothing is known about when");
    t.equal(app.ambientOf(infestedIds[0]), null, "so the inspector is told nothing");
    localStorage.setItem(LIVE_KEY, JSON.stringify(saved));
    app.restoreLive();

    // --- the map ---------------------------------------------------------------------
    state.region = forge;
    state.mode = "region";
    app.setLayoutMode("atlas");
    app.renderRegion();
    const nodeFor = id => state.nodes.find(node => node.record.system_id === id);
    t.check(nodeFor(infestedIds[0]).el.classList.contains("infested"), "an infested system is marked");
    t.check(nodeFor(frontId).el.classList.contains("contested"), "and a contested one");
    t.check(!nodeFor(frontId).el.classList.contains("infested"),
      "and the two markings are not the same marking");
    t.check(!nodeFor(systems[7].system_id).el.classList.contains("infested"),
      "while a quiet system carries neither");

    // An uncontested faction-warfare system is a fact about the map, not about
    // tonight, and must not be marked as if it were being fought over.
    await app.syncAmbient({ fetchImpl: serve({ frontlines: [frontline({ contested: "uncontested" })] }) });
    app.renderRegion();
    t.check(!nodeFor(frontId).el.classList.contains("contested"),
      "an uncontested frontline system stops being marked");
    t.check(state.live.observations.some(o => o.kind === "faction-warfare"),
      "though it is still recorded, because it is still a frontline");

    // --- leave the harness as it was found ---------------------------------------------
    localStorage.removeItem(LIVE_KEY);
    app.restoreLive();
    ui.ambientError.textContent = "";
    state.region = null;
    state.mode = "universe";
    return t.results;
  })();
}
