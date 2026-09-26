// Sovereignty, as wired into the application.
//
// The layer itself is tested elsewhere. This is about the join: that a sync
// reaches the store, that the store survives a reload, that the age shown is
// the data's and not the check's, and above all that "never synced" and
// "nobody holds anything" are different states on screen.
//
// That last one is the whole risk of a live layer in an offline-first tool. An
// unsynced store answers null for every system, exactly as a fully unclaimed
// universe would, and an interface that cannot tell them apart renders a first
// run as a confident finding that New Eden has no sovereignty in it.

import { readArchive, readRegion, suite } from "./helpers.mjs";
import { heldSystems, holderOf } from "../web/sovereignty.js";
import { createSightings, openObservations } from "../web/sightings.js";
import { sovereigntyPanel } from "../web/panels.js";

const headers = map => ({ get: name => map[name.toLowerCase()] ?? null });

export default function run(app) {
  const t = suite("sov integration");
  const { state, ui } = app;
  const atlas = readArchive();
  state.atlas = atlas;

  const forge = readRegion("The Forge");
  const systems = Object.values(forge.systems);
  const held = systems.slice(0, 3).map(system => ({
    system_id: system.system_id,
    alliance_id: 4242,
    corporation_id: 77,
  }));

  const reply = (rows, extra = {}) => async () => ({
    ok: true,
    status: 200,
    headers: headers({ expires: new Date(Date.now() + 3_600_000).toUTCString(), etag: 'W/"s"', ...extra }),
    json: async () => rows,
  });

  return (async () => {
    // --- before any sync ------------------------------------------------------
    localStorage.removeItem("new-eden-atlas-live-v1");
    app.restoreLive();
    t.check(!app.sovereigntyKnown(), "a fresh install has never synced");
    t.equal(app.sovHolderOf(systems[0].system_id), null, "and knows no holder");
    t.check(/never synced/.test(ui.sovAge.textContent), "the status says so in as many words");
    t.check(!/0 systems held/.test(ui.sovAge.textContent),
      "and does not report zero holdings, which would be a finding rather than an absence");

    // The panel must stay silent rather than announce an empty universe.
    t.equal(sovereigntyPanel(null), "", "the system panel shows no sovereignty section at all");
    t.check(/No alliance holds this system/.test(sovereigntyPanel({ holding: null, age: "synced just now" })),
      "while a synced store that genuinely found no holder says that instead");

    // --- a sync ----------------------------------------------------------------
    const before = Date.now();
    await app.syncSov({ fetchImpl: reply(held) });
    t.check(app.sovereigntyKnown(), "after a sync, sovereignty is known");
    t.equal(app.sovHolderOf(systems[0].system_id)?.alliance_id, 4242, "and holders resolve");
    t.equal(app.sovHolderOf(systems[5].system_id), null, "with unheld systems reported as unheld");
    t.check(/3 held/.test(ui.sovAge.textContent), "the status counts what is held");
    t.check(/synced/.test(ui.sovAge.textContent), "and how long ago");
    t.equal(ui.sovError.textContent, "", "with no error");

    // --- the shelf that counts the store has to follow the store ----------------
    //
    // It was refreshed on load, on import and after a clear - three call sites
    // someone remembered - and not after a sync. A shelf left open through a
    // sync went on showing the previous figures while the clear confirmation,
    // which counts at the moment it is armed, counted the new ones: two numbers
    // for one store, a few lines apart, with nothing on screen saying which was
    // stale. It is refreshed in persistLive now, which every sync passes
    // through and so will the next layer anyone adds.
    const stale = ui.historyCount.textContent;
    await app.syncSov({ fetchImpl: reply(held.slice(0, 1)) });
    t.check(ui.historyCount.textContent !== stale,
      `a sync that closes a window moves the shelf count (${stale} -> ${ui.historyCount.textContent})`);
    t.check(/closed/.test(ui.historyCount.textContent), "and it still reports open against closed");
    // Put the holdings back: what follows is about the map, not the shelf.
    await app.syncSov({ fetchImpl: reply(held) });

    // --- an open panel has to follow the data it is describing --------------------
    //
    // refreshOpenInspector is what keeps a system panel current as sovereignty,
    // kills and campaigns arrive - it is called from nine places, and nothing
    // asserted that it does anything. Mutation testing flipped its guard so it
    // returned early for *every* selected system, and the whole suite stayed
    // green: a pilot would have sat watching a panel that had quietly stopped
    // updating, which is worse than a panel that visibly failed.
    // **Opened the way a pilot opens it.** Setting `state.selected` and wiping
    // `ui.content` by hand manufactures exactly the state the rule is about:
    // `state.selected` outlives every panel, so reading it alone makes a sync redraw a
    // *system* inspector over whatever is actually on screen. The panel is opened
    // through `showSystem`, so the refresh is asserted against a real open panel.
    state.region = forge;
    app.selectSystem(systems[0].system_id);
    ui.content.innerHTML = "";
    app.refreshOpenInspector();
    t.check(ui.content.innerHTML.includes(systems[0].name),
      `an open panel is redrawn for the selected system (${systems[0].name})`);

    // And the other direction, which is the one that costs something. A route on screen
    // must survive a sync: `state.selected` is still set, so a pilot mid-route-plan
    // pressing Sync has their route analysis replaced by a panel about a system they
    // clicked minutes earlier, while the route stays drawn on the map.
    {
      const route = state.routePlanner?.calculate(systems[0].name, systems[1].name, "shortest");
      if (route?.systems?.length) {
        app.showRoute(route);
        const shown = ui.content.innerHTML;
        t.check(!shown.includes("Gate network"), "a route panel is what is on screen");
        app.refreshOpenInspector();
        t.equal(ui.content.innerHTML, shown,
          "and a sync leaves it alone rather than redrawing the selected system over it");
        t.check(state.selected !== null && state.selected !== undefined,
          "with the selection still set, which is what made this reachable");
      }
    }

    // And does nothing when nothing is open, which is the case the guard is for.
    state.selected = null;
    ui.content.innerHTML = "untouched";
    app.refreshOpenInspector();
    t.equal(ui.content.innerHTML, "untouched",
      "while nothing selected leaves the panel alone rather than drawing an empty one");
    state.selected = null;

    // --- it survives a reload -----------------------------------------------------
    const heldBefore = heldSystems(state.live).size;
    app.restoreLive();
    t.check(app.sovereigntyKnown(), "a reload remembers that a sync happened");
    t.equal(heldSystems(state.live).size, heldBefore, "and the holdings with it");
    t.equal(app.sovHolderOf(systems[0].system_id)?.alliance_id, 4242, "so the map draws without waiting for the network");
    t.check(!/never synced/.test(ui.sovAge.textContent), "and does not claim to be a fresh install");

    // Sightings present but no record of when they were taken: a truncated or
    // hand-edited save. Drawing holders while the status reads "never synced"
    // would be the interface contradicting itself, so nothing is drawn.
    const saved = JSON.parse(localStorage.getItem("new-eden-atlas-live-v1"));
    localStorage.setItem("new-eden-atlas-live-v1", JSON.stringify({ ...saved, sov: null }));
    app.restoreLive();
    t.check(openObservations(state.live, "sovereignty").length > 0,
      "the store still holds sightings");
    t.check(!app.sovereigntyKnown(), "but without metadata nothing is known about when");
    t.equal(app.sovHolderOf(systems[0].system_id), null,
      "so no holder is reported, rather than holders with no age");
    localStorage.setItem("new-eden-atlas-live-v1", JSON.stringify(saved));
    app.restoreLive();

    // --- a failed sync keeps what was known -------------------------------------------
    await app.syncSov({ fetchImpl: async () => { throw new TypeError("Failed to fetch"); } });
    t.equal(heldSystems(state.live).size, heldBefore, "an offline sync changes nothing");
    t.equal(app.sovHolderOf(systems[0].system_id)?.alliance_id, 4242, "what was known is still known");
    t.check(/offline/i.test(ui.sovError.textContent), "and the failure is reported");
    t.check(/last synced/i.test(ui.sovError.textContent), "saying that what is shown is the previous sync");
    t.check(app.sovereigntyKnown(), "a failure does not reset the layer to never-synced");

    // And the stored etag and expiry survive. A failed sync that overwrote them
    // would cost nothing visible and quietly stop every later request being
    // conditional - so the layer would refetch the whole map each time instead
    // of taking a free 304, and spend error budget doing it.
    t.equal(state.sovMeta.etag, 'W/"s"', "the etag from the last good sync is kept");
    t.check(Number.isFinite(state.sovMeta.expiresAt), "along with when the server said to ask again");

    // A malformed success is the dangerous one: it must not empty the map.
    await app.syncSov({ fetchImpl: reply(null) });
    t.equal(heldSystems(state.live).size, heldBefore, "a 200 carrying null leaves every holding alone");
    t.check(ui.sovError.textContent.length > 0, "and is reported as a failure");

    // --- the map draws it ------------------------------------------------------------
    state.region = forge;
    state.mode = "region";
    app.setLayoutMode("atlas");
    app.renderRegion();
    const rings = ui.viewport.querySelectorAll(".sov-ring");
    t.equal(rings.length, 3, "one ring per held system on the regional map");
    t.check(rings.every(ring => ring.getAttribute("data-sov") === "4242"), "each carrying its holder");
    t.check(rings.every(ring => /^hsl\(/.test(ring.getAttribute("stroke"))), "drawn in that alliance's colour");
    const outlines = ui.viewport.querySelectorAll(".sov-outline");
    t.equal(outlines.length, rings.length, "labelled systems have an ownership outline as well as a compact ring");
    t.check(outlines.every(outline => Number(outline.getAttribute("height")) === 38),
      "ownership outlines extend beyond the 32px capsule rather than hiding beneath it");
    t.check(outlines.every(outline => outline.getAttribute("fill") === "none"),
      "outlines cannot cover labels or security colours");
    t.check(outlines.every(outline => outline.getAttribute("data-sov") === "4242"),
      "both marker representations identify the same holder");

    let tick;
    let schedules = 0;
    app.bindSovereignty({ schedule: (callback, delay) => {
      tick = callback;
      schedules += 1;
      t.equal(delay, 30_000, "age refresh is a local 30-second timer");
      return 1;
    } });
    app.bindSovereignty({ schedule: () => { schedules += 1; return 2; } });
    t.equal(schedules, 1, "rebinding does not create duplicate age timers");
    app.showSystem(systems[0]);
    const savedMeta = state.sovMeta;
    state.sovMeta = {...savedMeta, dataAt: Date.now() - 5 * 60_000, expiresAt: Date.now() - 1000};
    tick();
    t.check(/5m ago/.test(ui.sovAge.textContent), "elapsed age updates without another sync");
    t.check(ui.sovAge.classList.contains("stale"), "expiry updates the stale indication without a request");
    // The span carries the instant it describes, because the data's timestamp
    // does not move - only now does. So the panel is redrawn for the new
    // timestamp, and the tick then ages it from there.
    app.showSystem(systems[0]);
    tick();
    const ageSpan = ui.content.querySelector("[data-live-at]");
    t.check(Boolean(ageSpan), "the inspector's age is a span the tick can find by selector");
    t.check(/5m ago/.test(ageSpan?.textContent ?? ""),
      "an open inspector advances with the status bar");
    // Template and tick call the same function on the same instant, so they
    // cannot disagree. They did: describeAge returns a phrase rather than a
    // sentence, because it also has to read mid-line in the live bar, and a
    // tick writing the bare phrase un-capitalised the sentence half a minute
    // after the inspector opened.
    t.check(/^Synced/.test(ageSpan?.textContent ?? ""),
      "and keeps its capital, being the start of a sentence");
    t.equal(app.liveTimeText("age", Date.now() - 5 * 60_000), "Synced 5m ago",
      "which is the one function both paths call");
    state.sovMeta = savedMeta;

    // Security colour must survive: sovereignty adds a fact rather than
    // replacing the one the map already carried.
    const dots = ui.viewport.querySelectorAll(".system-dot");
    t.equal(dots.length, systems.length, "every system still has its security dot");
    t.check(dots.some(dot => dot.getAttribute("fill") !== dots[0].getAttribute("fill")),
      "still coloured by security, which sovereignty did not take over");

    // And with nothing known, nothing is drawn.
    localStorage.removeItem("new-eden-atlas-live-v1");
    app.restoreLive();
    app.renderRegion();
    t.equal(ui.viewport.querySelectorAll(".sov-ring").length, 0,
      "an unsynced store draws no sovereignty rather than drawing it as unheld");

    state.region = null;
    state.mode = "universe";
    ui.sovError.textContent = "";
    return t.results;
  })();
}
