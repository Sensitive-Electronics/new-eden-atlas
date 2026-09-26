// A route across a wormhole is only good while that wormhole is still reported.
//
// EVE-Scout stops listing a hole far more often than a hole runs to its stated
// expiry - it collapses, or somebody scans it out. The sighting is correctly
// closed when that happens, and the sync correctly reports success. What did not
// happen was the route being recalculated: the panel kept reading "Mixed route -
// 1 jump - wormhole" for Jita to Amarr, where the real answer is eleven gate
// jumps, and it never self-corrected.
//
// Neither safety net could catch it. `ROUTE_FIELDS` carries the scout *toggle*
// and the hull, not the signature set, so `invalidateStaleResults` sees an
// unchanged key. And the guard in `tickLiveTimes` compared `state.scoutNet.count`
// around its own call to `refreshScout` - which `syncScoutLayer` has already
// called, so `before === after` every time and the comparison could never fire.
//
// It is the routing law on the pilot-facing surface: a history-routed plan sends a pilot
// through structures that are no longer there.
//
// The recalculation lives in `refreshScout`, where the set changes, because four callers
// reach it and a check in any one of them is a check the other three skip.

import { readArchive, suite } from "./helpers.mjs";
import { RoutePlanner } from "../web/route-planner.js";

// **Relative to the real clock, not to a date written down.**
//
// This was pinned to `2026-09-25T12:00:00Z` with the hole expiring sixteen hours
// later, and it passed on the day it was written and failed the next morning:
// `refreshScout` filters open signatures against `Date.now()`, so once the wall
// clock passed the fixture's expiry the hole was never routable and the whole
// file went red for a reason that had nothing to do with the code.
//
// A test that passes today and fails tomorrow is worse than one that fails now -
// it fails in somebody else's session, on a change that did not cause it. The
// only safe fixture for a layer that reads the present is one expressed relative
// to the present.
const NOW = Date.now();
const hours = (n) => new Date(NOW + n * 3_600_000).toISOString();

// One hole, joining two systems that are a long way apart by gate.
const hole = (from, to) => ({
  id: "sig-1",
  out_system_id: from,
  in_system_id: to,
  out_signature: "ABC-123",
  in_signature: "XYZ-789",
  signature_type: "wormhole",
  max_ship_size: "capital",
  expires_at: hours(16),
  created_at: hours(-2),
});

const respond = (rows) => async () => ({
  ok: true,
  status: 200,
  headers: { get: (name) => ({ etag: 'W/"scout"', "cache-control": "max-age=300" }[String(name).toLowerCase()] ?? null) },
  json: async () => rows,
});

export default async function run(app) {
  const t = suite("scout routing");
  const { state, ui } = app;
  const atlas = readArchive();
  const planner = new RoutePlanner(atlas);
  const id = (name) => planner.resolveSystem(name).system_id;

  const saved = {
    atlas: state.atlas, routePlanner: state.routePlanner, live: state.live,
    scoutMeta: state.scoutMeta, scoutNet: state.scoutNet, route: state.route,
    enabled: ui.scoutEnabled?.checked, hull: ui.scoutHull?.value,
    from: ui.routeFrom?.value, to: ui.routeTo?.value, mode: ui.routeMode?.value,
  };

  try {
    state.atlas = atlas;
    state.routePlanner = planner;
    app.clearRouteResult();

    if (ui.scoutEnabled) ui.scoutEnabled.checked = true;
    if (ui.scoutHull) ui.scoutHull.value = "frigate";
    ui.routeFrom.value = "Jita";
    ui.routeTo.value = "Amarr";
    ui.routeMode.value = "shortest";

    // --- a hole is reported, and the route uses it ---------------------------
    const opened = await app.syncScoutLayer({ fetchImpl: respond([hole(id("Jita"), id("Amarr"))]) });
    t.check(opened.ok, "the hole is synced");
    app.calculateRoute();
    t.check(Boolean(state.route), "a route is planned");
    const across = state.route?.jumps ?? null;
    t.equal(state.route?.wormholeJumps ?? 0, 1, "and it crosses the hole");
    t.equal(across, 1, `one jump instead of eleven (${across})`);

    // --- EVE-Scout stops reporting it ----------------------------------------
    //
    // A successful sync that no longer lists the signature. The observation is
    // closed, which is right; the question is what happens to the route.
    const closed = await app.syncScoutLayer({ fetchImpl: respond([]) });
    t.check(closed.ok, "a sync that no longer lists it is still a successful sync");

    t.check(!state.route || state.route.wormholeJumps === 0,
      "the route no longer claims a wormhole leg");
    t.check(!state.route || state.route.jumps > across,
      `and is the real gate distance instead (${state.route?.jumps ?? "cleared"} against ${across})`);

    // The panel and the map have to agree with it. A route object that was
    // recalculated while the drawn overlay still shows the old one is the same
    // defect wearing a different coat.
    t.equal(state.route?.legKinds?.filter((kind) => kind === "wormhole").length ?? 0, 0,
      "with no wormhole leg left in the sequence the panel renders");

    // --- the set changing without its size changing --------------------------
    //
    // A count cannot see this, and a count is what the old guard used. One hole
    // dies as another opens: same number of signatures, completely different
    // routing.
    await app.syncScoutLayer({ fetchImpl: respond([hole(id("Jita"), id("Amarr"))]) });
    app.calculateRoute();
    t.equal(state.route?.wormholeJumps ?? 0, 1, "a hole is back and the route uses it again");

    const elsewhere = { ...hole(id("Rens"), id("Dodixie")), id: "sig-2" };
    const swapped = await app.syncScoutLayer({ fetchImpl: respond([elsewhere]) });
    t.check(swapped.ok, "one hole replaced by another is a successful sync");
    t.equal(state.route?.wormholeJumps ?? 0, 0,
      "and the route drops the leg even though the number of holes did not change");

    // --- what the panel says when an answer is refused -------------------------
    //
    // Three outcomes, not two. A refused answer is not a missing one: with the
    // bounds in place the service can reply perfectly well and this build still
    // decline to hold what it sent - an over-long response, or two signatures
    // sharing an id. "EVE-Scout did not answer" sends a pilot to check their
    // network for a fault that is on this side, and the store is untouched
    // either way, so the sentence is the only thing that tells them apart.
    const messages = {};
    for (const [label, rows] of [
      ["offline", null],
      ["refused", [hole(id("Jita"), id("Amarr")), hole(id("Jita"), id("Amarr"))]],
    ]) {
      const fetchImpl = rows === null
        ? async () => { throw new TypeError("Failed to fetch"); }
        : respond(rows);
      const outcome = await app.syncScoutLayer({ fetchImpl });
      t.check(!outcome.ok, `a ${label} sync fails`);
      messages[label] = ui.scoutError.textContent;
    }

    t.check(/unreachable/.test(messages.offline),
      `an unreachable service reads as unreachable (${messages.offline})`);
    t.check(!/did not answer/.test(messages.refused),
      `a refused answer does not read as no answer (${messages.refused})`);
    t.check(/will not hold/.test(messages.refused),
      "it says this build would not hold what arrived, which is where the fault is");
    t.check(/last scanned/.test(messages.refused),
      "and still says what is on screen instead, because the store was left alone");
  } finally {
    state.atlas = saved.atlas;
    state.routePlanner = saved.routePlanner;
    state.live = saved.live;
    state.scoutMeta = saved.scoutMeta;
    state.scoutNet = saved.scoutNet;
    state.route = saved.route;
    state.scoutFingerprint = null;
    if (ui.scoutEnabled) ui.scoutEnabled.checked = saved.enabled ?? false;
    if (ui.scoutHull) ui.scoutHull.value = saved.hull ?? "";
    if (ui.routeFrom) ui.routeFrom.value = saved.from ?? "";
    if (ui.routeTo) ui.routeTo.value = saved.to ?? "";
    if (ui.routeMode) ui.routeMode.value = saved.mode ?? "shortest";
  }

  return t.results;
}
