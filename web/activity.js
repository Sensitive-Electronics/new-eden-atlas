// Activity: where people are dying, and where they are travelling.
//
// `/universe/system_kills/` and `/universe/system_jumps/`, both public, both
// republished hourly. Read live on 2026-09-18: 2,605 systems reporting kills, 4,812
// reporting jumps, and 354 with a player kill in them.
//
// This is the data heat-weighted routing weighs.
//
// --- why this is not a sighting log -------------------------------------------
//
// The store law says everything observed is a dated sighting, closed with a
// date when it goes away, because the disappearance is the intelligence. That
// law is about objects with a lifetime - a structure, a bridge, a sovereignty
// holding. It exists so that "gone" is recorded rather than erased.
//
// A kill count has no lifetime. It is a measurement over a fixed window that is
// republished every hour, and it never disappears - there is only next hour's
// number. Forced into the log it would close and reopen 2,605 windows an hour,
// 62,000 a day, to record something a list of hourly samples records exactly
// and far more cheaply. Nothing would ever be "closed with a date" in the sense
// the law means, because nothing ever ends.
//
// So this is a bounded time series, deliberately, and it lives beside the
// sighting log rather than inside it. The law is not weakened: it still governs
// every observed object. This is not one.
//
// --- what is kept, and why ------------------------------------------------------
//
// Measured on the live endpoints: one full sample of kills and jumps is about
// 96 KB, so a day of them is 2.3 MB - too much to sit in local storage beside
// everything else. A day of player-kill numbers alone is 108 KB.
//
// That split is also the right one on the merits, not only on size. Jump counts
// and NPC kills are gauges you read now: is this pipe busy, is anyone ratting
// here. Player kills are the one worth a trend - "this gate has been killing
// people all day" is a different warning from "someone died here once".
//
// So: the latest sample in full, and a capped history of player kills.

import { fetchEsi } from "./esi.js";
import { arrivedEmpty } from "./sightings.js";

export const KILLS_PATH = "/universe/system_kills/";
export const JUMPS_PATH = "/universe/system_jumps/";
// A day. Long enough to see a camp that has been up all evening, short enough
// that the whole series stays about 108 KB.
export const HISTORY_LIMIT = 24;

export function createActivity() {
  return { latest: null, history: [] };
}

// Player kills are ship kills plus pod kills, summed and nothing else. No
// weighting: a weight would be a judgement invented here and then displayed as
// though it were measured.
//
// Pods are reported separately for anyone who wants to read the difference, and
// only that. A pod is not evidence that somebody meant it - Drifters, Sleepers and
// Triglavians pod in their own content, the last of them in high security - so a pod
// count is a pod count and nothing here draws a conclusion from it.
//
// NPC kills are never added in. They are ratting, which says people are present
// and says nothing at all about whether it is safe to pass through.
export function playerKills(entry) {
  return (entry?.shipKills ?? 0) + (entry?.podKills ?? 0);
}

// A count that is there, or null. Never a zero standing in for an absence.
//
// `Number(null)`, `Number("")` and `Number(undefined) || 0` are all 0, and 0 here is
// not "no reading" - it is the measured claim that nobody died, which is the one
// direction of error that gets a pilot killed. A negative count is not a count
// either.
function count(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

// Returns what was understood as well as what was stored.
//
// These endpoints list only the systems with activity in them, so an empty map is a
// legitimate answer meaning a quiet hour - which is what makes schema drift
// invisible. An upstream rename of `system_id` fails every row's id check, the map
// comes back empty, and a quiet hour is recorded for a response nobody could read.
// Worse here than elsewhere, because the series is what the routing weight and the
// "N of the last M hours" count are built from.
function normaliseKills(rows) {
  const kills = new Map();
  let recognised = 0;
  for (const row of rows ?? []) {
    const id = Number(row?.system_id);
    if (!Number.isInteger(id)) continue;
    const ship = count(row.ship_kills);
    const pod = count(row.pod_kills);
    const npc = count(row.npc_kills);
    // A row with an id and no readable count at all is a row we did not
    // understand, not a system where nothing happened.
    if (ship === null && pod === null && npc === null) continue;
    recognised += 1;
    const ships = ship ?? 0;
    const pods = pod ?? 0;
    const npcs = npc ?? 0;
    // Understood, and genuinely zero. Not stored, because a zero that is not
    // stored reads the same as a zero that is - but it counts as recognised.
    if (!ships && !pods && !npcs) continue;
    kills.set(id, { shipKills: ships, podKills: pods, npcKills: npcs });
  }
  return { kills, recognised };
}

function normaliseJumps(rows) {
  const jumps = new Map();
  let recognised = 0;
  for (const row of rows ?? []) {
    const id = Number(row?.system_id);
    if (!Number.isInteger(id)) continue;
    const ships = count(row.ship_jumps);
    if (ships === null) continue;
    recognised += 1;
    if (!ships) continue;
    jumps.set(id, ships);
  }
  return { jumps, recognised };
}

// Fold a reading into the store.
//
// Samples are identified by when the data was produced, not when it was
// fetched. ESI republishes these hourly and serves the same body for the rest
// of the hour, so two syncs ten minutes apart carry identical numbers - and
// appending both would put the same hour into the series twice and make a flat
// hour look like a rising one. Same timestamp, same sample: replaced, not
// appended.
// `killsMeasured` and `jumpsMeasured` are not bookkeeping. These endpoints report
// only the systems with activity in them, so an absent system is a measured zero -
// which is what makes a *failed* half dangerous: an empty map substituted for the
// answer is a universe in which nobody died anywhere, indistinguishable from one
// that was asked and found quiet.
//
// Both halves are fetched independently and either can fail on its own, so one flag
// is not enough. A 304 is measured - unchanged, and the carried-forward map is still
// the last real reading - and a 503 is not, and does not become one by being stored
// next to a jumps count that succeeded.
export function recordSample(store, {
  kills = null, jumps = null, at = Date.now(), killsMeasured = kills !== null, jumpsMeasured = jumps !== null,
}) {
  const sample = {
    at,
    kills: kills ?? store.latest?.kills ?? new Map(),
    jumps: jumps ?? store.latest?.jumps ?? new Map(),
    killsMeasured,
    jumpsMeasured,
    // Each half keeps the instant it was actually measured. Carrying the last good
    // kill numbers forward is right - they are real intelligence, and this project
    // keeps what it last confirmed - but the sample is stamped from whichever half
    // answered, so without this the old numbers are restamped with a fresh time and
    // six-hour-old counts read as this hour's.
    killsAt: killsMeasured ? at : (store.latest?.killsAt ?? null),
    jumpsAt: jumpsMeasured ? at : (store.latest?.jumpsAt ?? null),
  };
  store.latest = sample;

  // An hour with no kill measurement in it is not an hour. Appending one would
  // copy the previous hour's numbers forward under a new timestamp, so a single
  // reading of twelve kills becomes "two consecutive hours with kills" - which
  // is what the hour-count in the heat panel reads out, and what the routing
  // weight is built from.
  if (!killsMeasured) return sample;

  const summary = {
    at,
    // Only the systems anybody died in. The rest is zeroes, and a zero that is
    // not stored reads the same as a zero that is.
    kills: new Map([...sample.kills]
      .filter(([, value]) => playerKills(value) > 0)
      .map(([id, value]) => [id, { shipKills: value.shipKills, podKills: value.podKills }])),
  };

  const existing = store.history.findIndex(entry => entry.at === at);
  if (existing >= 0) store.history[existing] = summary;
  else store.history.push(summary);

  store.history.sort((a, b) => a.at - b.at);
  if (store.history.length > HISTORY_LIMIT) {
    store.history.splice(0, store.history.length - HISTORY_LIMIT);
  }
  return sample;
}

// Both endpoints, independently. One being down is no reason to discard the
// other, and the caller is told which half is which so it can say so.
export async function syncActivity(store, { fetchImpl = null, cached = null, now = Date.now() } = {}) {
  const [killsResult, jumpsResult] = await Promise.all([
    fetchEsi(KILLS_PATH, { cached: cached?.kills ?? null, fetchImpl, now }),
    fetchEsi(JUMPS_PATH, { cached: cached?.jumps ?? null, fetchImpl, now }),
  ]);

  const usable = result => {
    if (!result.ok) return { ok: false, reason: result.reason ?? "unknown" };
    // A 304 is a success carrying nothing new; the caller keeps what it had.
    if (result.notModified && !result.data) return { ok: true, unchanged: true, rows: null };
    // A 200 that is not a list is a failed sync, not an empty universe. Read as
    // empty it would record an hour in which nobody died anywhere, and that
    // false all-clear would sit in the series for a day.
    if (!Array.isArray(result.data)) return { ok: false, reason: "malformed" };
    // **And an empty list is the same failure, one shape along.** Neither endpoint
    // has a quiet answer: kills was measured at 2,605 reporting systems, and NPC
    // ratting alone guarantees thousands every hour.
    //
    // It matters more than it looks, because `killsMeasured` stays true across it, so
    // `killsKnown()` is true, so `buildHeat()` returns `applied: true` with an empty
    // kill map and re-weights the route. An unmeasured hour weighing every system at
    // zero is not "no weighting" but "weighted as though it were safe".
    if (arrivedEmpty(result.data)) return { ok: false, reason: "malformed" };
    return { ok: true, rows: result.data };
  };

  const killsState = usable(killsResult);
  const jumpsState = usable(jumpsResult);
  if (!killsState.ok && !jumpsState.ok) {
    return { ok: false, kills: killsResult, jumps: jumpsResult, killsState, jumpsState, sample: null };
  }

  // The sample is stamped with the older of the two, so a series built from a
  // fresh half and a stale half is filed under the hour it actually describes.
  const stamps = [
    killsState.ok ? killsResult.dataAt ?? killsResult.fetchedAt : null,
    jumpsState.ok ? jumpsResult.dataAt ?? jumpsResult.fetchedAt : null,
  ].filter(Number.isFinite);
  const at = stamps.length ? Math.min(...stamps) : now;

  // Measured means "this half answered". A 304 inherits the standing of the
  // reading it is confirming, because that is what it confirms.
  const stillMeasured = (state, previous) => (state.ok
    ? (state.rows ? true : Boolean(previous))
    : false);
  let killsMeasured = stillMeasured(killsState, store.latest?.killsMeasured);
  let jumpsMeasured = stillMeasured(jumpsState, store.latest?.jumpsMeasured);

  // Rows in, nothing understood: schema drift, not a quiet universe. The half
  // is failed rather than recorded, so it neither writes an hour into the
  // series nor counts as measured.
  const killsRead = killsState.ok && killsState.rows ? normaliseKills(killsState.rows) : null;
  const jumpsRead = jumpsState.ok && jumpsState.rows ? normaliseJumps(jumpsState.rows) : null;
  const drifted = (read, rows) => Boolean(read && rows?.length && read.recognised === 0);

  if (drifted(killsRead, killsState.rows)) {
    killsState.ok = false;
    killsState.reason = "malformed";
    killsMeasured = false;
  }
  if (drifted(jumpsRead, jumpsState.rows)) {
    jumpsState.ok = false;
    jumpsState.reason = "malformed";
    jumpsMeasured = false;
  }
  if (!killsState.ok && !jumpsState.ok) {
    return { ok: false, kills: killsResult, jumps: jumpsResult, killsState, jumpsState, sample: null };
  }

  const sample = recordSample(store, {
    kills: killsState.ok && killsRead ? killsRead.kills : null,
    jumps: jumpsState.ok && jumpsRead ? jumpsRead.jumps : null,
    at,
    killsMeasured,
    jumpsMeasured,
  });

  return {
    ok: true,
    kills: killsResult,
    jumps: jumpsResult,
    killsState,
    jumpsState,
    sample,
    // Said out loud, because the caller's only other signal is `ok`, and a
    // half-failed sync that reports ok is how the all-clear got on screen.
    partial: !killsMeasured || !jumpsMeasured,
  };
}

// --- reading it ------------------------------------------------------------------

export function heatOf(store, systemId) {
  const latest = store?.latest;
  if (!latest) return null;
  const id = Number(systemId);
  const kills = latest.kills.get(id) ?? null;
  const jumps = latest.jumps.get(id) ?? 0;
  // **Two different absences, and only one of them is a zero.** A system in neither
  // list is quiet rather than unknown, because these endpoints report every system
  // with any activity - but that holds only for a half that answered.
  //
  // If the kills half has never answered there is no reading and the counts are
  // null: "nobody died" would be an invention. If it answered before and failed this
  // time, the last numbers stand as the last confirmed state, carrying their own
  // instant so nothing downstream presents them as current.
  const fresh = latest.killsMeasured !== false;
  const killsAt = latest.killsAt ?? (fresh ? latest.at : null);
  const known = fresh || killsAt !== null;
  return {
    systemId: id,
    shipKills: known ? kills?.shipKills ?? 0 : null,
    podKills: known ? kills?.podKills ?? 0 : null,
    npcKills: known ? kills?.npcKills ?? 0 : null,
    killsMeasured: known,
    killsFresh: fresh,
    killsAt,
    jumps,
    jumpsMeasured: latest.jumpsMeasured !== false,
    jumpsAt: latest.jumpsAt ?? latest.at,
    at: latest.at,
  };
}

export function playerKillsIn(store, systemId) {
  return playerKills(heatOf(store, systemId));
}

// The systems worth looking at, most player kills first. NPC kills are excluded
// on purpose: a ratting system at 3,000 NPC kills would otherwise top a list
// that is meant to answer "where are people dying".
export function hottest(store, limit = 12) {
  const latest = store?.latest;
  if (!latest) return [];
  return [...latest.kills]
    .map(([systemId, value]) => ({ systemId, ...value, playerKills: playerKills(value) }))
    .filter(entry => entry.playerKills > 0)
    .sort((a, b) => b.playerKills - a.playerKills || a.systemId - b.systemId)
    .slice(0, limit);
}

export function busiest(store, limit = 12) {
  const latest = store?.latest;
  if (!latest) return [];
  return [...latest.jumps]
    .map(([systemId, jumps]) => ({ systemId, jumps }))
    .sort((a, b) => b.jumps - a.jumps || a.systemId - b.systemId)
    .slice(0, limit);
}

// What this system's player kills have done over the samples held. Every sample
// contributes a point, including the ones where nothing happened - a gap read
// as "no data" would turn a quiet hour into a missing hour and flatten the very
// shape the series exists to show.
export function trendOf(store, systemId) {
  const id = Number(systemId);
  return (store?.history ?? []).map(sample => ({
    at: sample.at,
    playerKills: playerKills(sample.kills.get(id)),
  }));
}

export function sampleCount(store) {
  return store?.history?.length ?? 0;
}

export function describeHeat(entry) {
  if (!entry) return null;
  const parts = [];
  if (entry.killsMeasured === false) {
    // Never measured at all. Not a zero, and not something to phrase as one.
    parts.push("kills not measured");
    parts.push(`${entry.jumps.toLocaleString()} jump${entry.jumps === 1 ? "" : "s"}`);
    return `${parts.join(" · ")} in the reported hour`;
  }
  const kills = playerKills(entry);
  // Measured before, but not in this sync. The numbers stand - they are the
  // last confirmed reading - but they are not this hour's, and the sentence
  // must not let them pass as it.
  if (entry.killsFresh === false) parts.push("kills last measured earlier");
  if (kills) {
    parts.push(`${kills} player kill${kills === 1 ? "" : "s"}`
      + (entry.podKills ? ` (${entry.podKills} pod${entry.podKills === 1 ? "" : "s"})` : ""));
  } else {
    parts.push("no player kills");
  }
  if (entry.npcKills) parts.push(`${entry.npcKills.toLocaleString()} NPC`);
  parts.push(`${entry.jumps.toLocaleString()} jump${entry.jumps === 1 ? "" : "s"}`);
  // "in the reported hour", not "in the last hour". The numbers are as old as
  // the sample they came from, which can be six hours back when the endpoint has
  // been unreachable, and the panel shows that age beside this sentence.
  return `${parts.join(" · ")} in the reported hour`;
}

// --- persistence --------------------------------------------------------------------
// Maps do not survive JSON, and the series is the one part of the live store
// big enough for its shape on disk to matter. Arrays of pairs, numbers only.

export function toJSON(store) {
  const pack = sample => sample && ({
    at: sample.at,
    kills: [...sample.kills].map(([id, v]) => [id, v.shipKills, v.podKills, v.npcKills ?? 0]),
    jumps: sample.jumps ? [...sample.jumps] : [],
    // Carried across the save, or a reload would launder "not measured" back
    // into "measured zero" - the same false all-clear, arrived at by closing
    // the tab. Only written when false, so an ordinary save does not grow.
    ...(sample.killsMeasured === false ? { killsMeasured: false } : {}),
    ...(sample.jumpsMeasured === false ? { jumpsMeasured: false } : {}),
    // And the instant each half was actually measured, which the flags above are
    // useless without. A carried reading that survives a reload with its numbers and
    // without its age makes `heatOf` report `shipKills: null` for a real reading,
    // while `killsKnown()` tests `killsAt !== null` and `undefined` passes it - so
    // the status bar prints the carried count with no age while the inspector calls
    // it unmeasured.
    //
    // Written only when present, for the same reason as the flags.
    ...(Number.isFinite(sample.killsAt) ? { killsAt: sample.killsAt } : {}),
    ...(Number.isFinite(sample.jumpsAt) ? { jumpsAt: sample.jumpsAt } : {}),
  });
  return {
    version: 1,
    latest: pack(store?.latest) ?? null,
    history: (store?.history ?? []).map(sample => ({
      at: sample.at,
      kills: [...sample.kills].map(([id, v]) => [id, v.shipKills, v.podKills]),
    })),
  };
}

export function fromJSON(data) {
  const store = createActivity();
  const unpackKills = rows => new Map((rows ?? [])
    .filter(row => Array.isArray(row) && Number.isFinite(row[0]))
    .map(([id, ship, pod, npc]) => [Number(id), {
      shipKills: Number(ship) || 0,
      podKills: Number(pod) || 0,
      npcKills: Number(npc) || 0,
    }]));

  if (data?.latest && Number.isFinite(data.latest.at)) {
    store.latest = {
      at: data.latest.at,
      killsMeasured: data.latest.killsMeasured !== false,
      jumpsMeasured: data.latest.jumpsMeasured !== false,
      kills: unpackKills(data.latest.kills),
      jumps: new Map((data.latest.jumps ?? [])
        .filter(row => Array.isArray(row) && Number.isFinite(row[0]))
        .map(([id, count]) => [Number(id), Number(count) || 0])),
      // `null`, never `undefined`, when a save predates these being written.
      // `killsKnown()` asks `killsAt !== null` and `undefined` passes that test, so a
      // store restored without an age would report a reading it cannot date. Null
      // fails it, which is the safe direction: nothing measured, nothing claimed.
      killsAt: Number.isFinite(data.latest.killsAt) ? data.latest.killsAt : null,
      jumpsAt: Number.isFinite(data.latest.jumpsAt) ? data.latest.jumpsAt : null,
    };
  }

  for (const sample of data?.history ?? []) {
    if (!Number.isFinite(sample?.at)) continue;
    store.history.push({ at: sample.at, kills: unpackKills(sample.kills) });
  }
  store.history.sort((a, b) => a.at - b.at);
  if (store.history.length > HISTORY_LIMIT) {
    store.history.splice(0, store.history.length - HISTORY_LIMIT);
  }
  return store;
}
