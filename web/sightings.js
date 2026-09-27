// The live store: a log of dated sightings.
//
// Nothing in here is current state. Every fact is an observation with a source,
// a first_seen, a last_confirmed and a window that closes with a date when a
// sync stops returning it. Gone is closed, never deleted, because the
// disappearance is usually the interesting part - a bridge that vanishes means
// a retreat or a fuel crisis, and a system that changes hands is the whole
// point of watching sovereignty.
//
// One shape for everything observed: bridges, citadels, cyno beacons,
// sovereignty holders, kill clusters, named entities from killmails. A source
// is whatever saw it - a character token, or a public endpoint, since
// sovereignty has no character behind it.
//
// Deliberately absent: any notion of "the current value" that is stored rather than
// derived. `openForSource` derives it from the log. Stored, it would drift from the
// log the moment anything went wrong, and the log is the record.
//
// **Every read names its source**, and there is no reader that does not. A reader
// that cannot say whose window it wants is asking a different question: "is the most
// recently *written* row open" rather than "is this source's window open", and the
// two diverge the moment two sources hold one key.

export function createSightings() {
  // `latest` is a lookup from id to the most recent observation with that id,
  // open or closed. It is derived from `observations` and never authoritative:
  // anything that cannot prove it is current rebuilds it.
  return { observations: [], latestBySource: new Map() };
}

function entryKey(kind, key) {
  return `${kind}:${key}`;
}

// Rebuild the id lookup from the observations themselves.
//
// Called when the store did not come from `createSightings` - a restored save, or a
// plain object written by an older build - so the index can never disagree with the
// log it is derived from.
//
// **One slot per thing *and source*, and no slot per thing alone.** A slot per id
// holds whichever row came last in the log, which is not the same as the row a given
// source has open. It also survives a close: `closeObservation` mutates `closedAt` in
// place and the length does not change, so a by-reference index stays valid while
// pointing at a row another source just closed.
function indexOf(store) {
  if (store.latestBySource instanceof Map && store.indexedCount === store.observations.length) {
    return store.latestBySource;
  }
  const bySource = new Map();
  for (const entry of store.observations) {
    bySource.set(sourceSlot(entry.id, entry.source), entry);
  }
  store.latestBySource = bySource;
  store.indexedCount = store.observations.length;
  return bySource;
}

// A source's own timeline for one thing. The separator is a NUL so it cannot
// occur in a kind, a key or a source name and forge a different slot.
function sourceSlot(id, source) {
  return `${id}\u0000${source ?? "unknown"}`;
}

// What THIS source currently has open for this thing.
//
// A read across every source, written back to whatever it returned, lets one source's
// observation extend or close another's window: two pilots reporting the same bridge
// produce one record attributed to whichever spoke last, and a disagreement between
// them closes the first pilot's sighting - recording a retreat that never happened.
//
// That is what `syncAll`'s closing half refuses to do, and it is what makes the
// multi-token layer safe to build on.
export function openForSource(store, kind, key, source, at = Infinity) {
  const id = entryKey(kind, key);
  if (at === Infinity) {
    indexOf(store);
    const entry = store.latestBySource.get(sourceSlot(id, source));
    if (!entry) return null;
    return entry.closedAt === null ? entry : null;
  }
  for (let i = store.observations.length - 1; i >= 0; i -= 1) {
    const entry = store.observations[i];
    // Normalised on both sides, because `sourceSlot` normalises: a row restored with
    // no source slots as "unknown" on the indexed path, and an un-normalised scan
    // matches nothing. Two halves of one lookup disagreeing is the shape of every
    // defect this store has had.
    if (entry.id !== id || (entry.source ?? "unknown") !== (source ?? "unknown")) continue;
    if (entry.firstSeen > at) continue;
    if (entry.closedAt !== null && entry.closedAt <= at) return null;
    return entry;
  }
  return null;
}


// Record that something was seen with this value.
//
// Same value as the open observation: extend it, because nothing changed and a
// second record would only say "still true". Different value: close the old
// window and open a new one, which is the supersede half of the rule.
export function observe(store, { kind, key, value = null, source = "unknown", now = Date.now() }) {
  const existing = openForSource(store, kind, key, source);
  const same = existing && sameValue(existing.value, value);
  if (same) {
    existing.lastConfirmed = Math.max(existing.lastConfirmed, now);
    return existing;
  }
  if (existing) closeObservation(existing, now);

  const id = entryKey(kind, key);
  const entry = {
    id,
    kind,
    key: String(key),
    value,
    source,
    firstSeen: now,
    lastConfirmed: now,
    closedAt: null,
  };
  // The map is taken *before* the push, while the count still agrees with the log.
  // Afterwards, `indexOf` sees a length one ahead of its own count, decides the index
  // is stale and rebuilds it from scratch on every insert - which makes the write
  // quadratic and building a year of history take 99 seconds instead of one.
  const bySource = indexOf(store);
  store.observations.push(entry);
  bySource.set(sourceSlot(id, source), entry);
  store.indexedCount = store.observations.length;
  return entry;
}

function closeObservation(entry, now) {
  // Closed at the moment we noticed, never before the last time it was
  // confirmed - a window that ended before it was last seen is nonsense.
  entry.closedAt = Math.max(now, entry.lastConfirmed);
}

// Close one source's window, named. Closing whatever an id-only index points at means
// that with two sources holding a key the Remove button either does nothing - the row
// it finds was already closed by the other source's sync - or closes a window
// belonging to somebody else. It is the rule `syncAll` obeys, on the one path a pilot
// presses by hand.
export function close(store, kind, key, source, now = Date.now()) {
  const existing = openForSource(store, kind, key, source);
  if (!existing) return null;
  closeObservation(existing, now);
  return existing;
}

function sameValue(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  const keysA = Object.keys(a).sort();
  const keysB = Object.keys(b).sort();
  if (keysA.length !== keysB.length) return false;
  return keysA.every((name, index) => keysB[index] === name && sameValue(a[name], b[name]));
}

// Did the payload arrive, and parse to nothing?
//
// `Array.isArray` is not enough. It catches the response that is not a list at all -
// JSON null, `{}`, a captive portal's HTML - and says nothing about a list of rows
// none of which we understood. Under schema drift (`alliance_id` becoming
// `allianceId`, an ISO timestamp becoming an epoch number) every row fails its
// per-layer filter, the mapped list comes back empty, and an empty list is a
// legitimate answer meaning "nothing is held", "nothing is contested", "no
// incursions". `syncAll` then closes every open observation for that source, writes
// the sweep into the permanent log, and the caller returns ok.
//
// Worse than a crash: a crash leaves yesterday's intelligence intact, and this writes
// a false all-clear into the one record meant to outlive the session, closed with a
// date that will never be right again.
//
// So: a payload with rows in it that yields no recognised rows is a failed sync. An
// empty payload is still an empty answer, because that is what it says.
export function recognisedNothing(payload, recognised) {
  return Array.isArray(payload) && payload.length > 0 && recognised === 0;
}

// The id a row is filed under, or null if it does not have one.
//
// **`Number.isFinite(Number(x))` is not this test.** `Number(null)`, `Number("")`,
// `Number(false)` and `Number([])` are all `0`, which is finite - so a row whose key
// field was nulled by a proxy or renamed by schema drift "parses", counts as
// recognised, and collapses onto the single key `0`. `recognisedNothing` cannot save
// it, because from its point of view every row was understood.
//
// Measured: faction warfare with `solar_system_id: null` on every row reports
// `ok: true` and takes three open frontlines down to one. Validating no key at all is
// worse - `String(undefined)` gathers every sovereignty holding in New Eden under one
// key, closes the rest, and dates the sweep.
//
// An EVE id is a positive integer. Nothing else is one.
export function positiveId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// Whether a payload that has no legitimate empty answer arrived empty.
//
// `recognisedNothing` deliberately lets `[]` through: for incursions, campaigns
// and scout an empty list is a real reading, and refusing it would be the
// opposite mistake - a quiet universe reported as a broken one.
//
// **Whole-map endpoints are not that kind of endpoint.** `/sovereignty/map/`
// returns thousands of rows every time; `/universe/system_kills/` was measured
// at 2,605 reporting systems and NPC ratting alone guarantees thousands hourly;
// `/fw/systems/` returns one row per warzone system, contested or not, measured
// at 160. None of them has an empty answer, so `[]` from any of them is a CDN
// edge, a captive portal or a datasource hiccup - and believing it closes every
// window the layer holds, with a date that will never be right again.
//
// The rule rather than the instance, and the three callers name themselves so a
// fourth cannot inherit it by being nearby.
export function arrivedEmpty(payload) {
  return Array.isArray(payload) && payload.length === 0;
}

// A whole-endpoint sync: everything present is observed, and anything that was
// open and is no longer present is closed.
//
// This is the shape sovereignty wants - the endpoint returns the entire map
// every hour - and the closing half is what a naive "upsert what came back"
// would miss. Returns what actually changed, so a caller can tell whether the
// sync was worth anything.
export const HISTORY_FORMAT = "new-eden-atlas-history-v1";

// The history as a file, so clearing it is recoverable rather than only
// deliberate.
//
// Deterministic and complete: the records themselves, not a summary of them. A
// summary would be a judgement about what mattered, and the whole reason this
// log exists is that nobody knows in advance which closure turns out to be the
// interesting one.
//
// Carries no source-identifying material beyond the source label the store
// already keeps - the same one syncAll writes - because a shared history must
// not say which character saw what.
export function historyFile(store, { before = Infinity, now = Date.now() } = {}) {
  const records = store.observations.filter(
    entry => entry.closedAt !== null && entry.closedAt < before,
  );
  return JSON.stringify({
    format: HISTORY_FORMAT,
    exported: new Date(now).toISOString(),
    count: records.length,
    observations: records,
  }, null, 2);
}

// Read one back. Refuses the whole file rather than importing part of it, for
// the reason the corridor importer gives: a partial import leaves the pilot
// believing they hold a history they do not have.
export function parseHistoryFile(content) {
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`History file is not valid JSON: ${error.message}`);
  }
  if (!parsed || typeof parsed !== "object") throw new Error("History file is not a history export.");
  if (parsed.format !== HISTORY_FORMAT) {
    throw new Error(`History file is ${parsed.format ?? "of no stated format"}, expected ${HISTORY_FORMAT}.`);
  }
  if (!Array.isArray(parsed.observations)) throw new Error("History file carries no observations.");

  return parsed.observations.map((row, index) => {
    const where = `History file, record ${index + 1} of ${parsed.observations.length}`;
    if (!row || typeof row !== "object") throw new Error(`${where}: not a record.`);
    if (typeof row.kind !== "string" || !row.kind) throw new Error(`${where}: no kind.`);
    if (row.key === undefined || row.key === null) throw new Error(`${where}: no key.`);
    if (!Number.isFinite(row.firstSeen)) throw new Error(`${where}: no first sighting.`);
    // Only closed windows are ever exported, and only closed windows may come
    // back. An import that could reopen a window would let a file assert that
    // something is held now, which is a claim about the present from a record
    // of the past.
    if (!Number.isFinite(row.closedAt)) throw new Error(`${where}: is not a closed record.`);
    // A window that ends before it begins is not a record. `observe` cannot make one
    // - it closes at `now` and opens at `now` - so no legitimate export carries one,
    // and refusing it here is deliberate: the overlap rule catches an inverted window
    // only when it happens to straddle something still open. A *zero-width* window is
    // valid and stays valid, because that is what a millisecond clock produces when a
    // value changes twice in one tick.
    if (row.closedAt < row.firstSeen) throw new Error(`${where}: closed before it was first seen.`);
    return {
      id: entryKey(row.kind, row.key),
      kind: row.kind,
      key: String(row.key),
      value: row.value ?? null,
      source: typeof row.source === "string" ? row.source : "unknown",
      firstSeen: row.firstSeen,
      lastConfirmed: Number.isFinite(row.lastConfirmed) ? row.lastConfirmed : row.firstSeen,
      closedAt: row.closedAt,
    };
  });
}

// **Two windows for one thing, from one source, may not overlap in time.**
//
// Every reader of this log assumes it. `openForSource` walks backwards and returns
// `null` the moment it meets a closed window covering the instant asked about.
// `openObservations` keeps a slot filled only while no closed entry displaces it, and
// is *more* careful, clearing a slot only when it holds that same entry object. One
// overlap is enough to make them disagree with each other.
//
// Touching is not overlapping. A window closing at the exact instant the next
// opens is the ordinary supersede `observe` performs, and refusing that would
// refuse every normal history.
function windowsOverlap(a, b) {
  const aEnd = a.closedAt === null ? Infinity : a.closedAt;
  const bEnd = b.closedAt === null ? Infinity : b.closedAt;
  return a.firstSeen < bEnd && b.firstSeen < aEnd;
}

// Put them back, without duplicating what is already there.
//
// A closed window is identified by what it is, when it opened and when it closed, so
// re-importing the same file twice adds nothing the second time. Nothing is ever
// overwritten: a record already in the log wins, because it came from an observation
// rather than from a file.
//
// **"Already there" is per source**, like every other identity in this file, and one
// helper decides it for both checks rather than two expressions agreeing by hand. An
// identity that leaves `source` out while the overlap check beside it is keyed on the
// source makes the two halves disagree about what a record *is*, and drops an
// identical closed window from a second observer as a duplicate - so corroboration,
// the one thing a shared export is for, is the one outcome the merge cannot record.
//
// **And a record that would overlap a window already here is refused**, which is that
// same rule applied to time rather than to identity. `parseHistoryFile` refuses a
// record that is not closed, because an import may state history and may never make a
// claim about the present - and a *closed* record makes that claim anyway by landing
// on top of an open one. A window open since January, with an imported closed window
// from March to April laid over it, leaves `openObservations` naming the holder while
// the sourced read answers **null**: two readers of one store contradicting each
// other, "held since" jumping forward a hundred days, and the next sync reporting an
// `opened` event for a change that never happened.
//
// The original window is then orphaned permanently - invisible to `openForSource`, so
// no sync can close it, and `pruneSightings` refuses to remove an open row at any age.
//
// Refused per record rather than refusing the file, because the conflicting record is
// the one the pilot has their own direct observation of, and losing ninety-nine good
// records to one conflict is the worse trade. `conflicted` is counted apart from
// `skipped` for the reason this store keeps three source states: "you already have
// this" and "this disagrees with something you are still watching" are different
// facts, and the second is the one worth a pilot's attention.
export function mergeHistory(store, incoming) {
  const windowId = (entry) =>
    `${sourceSlot(entry.id, entry.source)}\u0000${entry.firstSeen}\u0000${entry.closedAt}`;
  const seen = new Set(store.observations.map(windowId));
  // Windows already held, per thing and per source. Built once rather than scanned
  // per record, or a year of history against a full export is quadratic.
  const held = new Map();
  for (const entry of store.observations) {
    const slot = sourceSlot(entry.id, entry.source);
    const list = held.get(slot);
    if (list) list.push(entry);
    else held.set(slot, [entry]);
  }
  let added = 0;
  let conflicted = 0;
  for (const record of incoming) {
    const signature = windowId(record);
    if (seen.has(signature)) continue;
    const slot = sourceSlot(record.id, record.source);
    const list = held.get(slot);
    // Checked against what this import has already added too, so a file cannot
    // contradict itself either.
    if (list && list.some(entry => windowsOverlap(entry, record))) {
      conflicted += 1;
      continue;
    }
    seen.add(signature);
    store.observations.push(record);
    if (list) list.push(record);
    else held.set(slot, [record]);
    added += 1;
  }
  if (added) {
    // **Among records starting at the same instant, an open one sorts last.** That is
    // the order `observe` produces - it closes the old window and pushes the new open
    // one after it - and `openForSource`'s backwards scan depends on it, answering
    // with the first record it meets whose `firstSeen` is at or before the moment
    // asked about.
    //
    // A sort by `firstSeen` alone is stable, so an imported record keeps its pushed
    // position *after* an open one starting at the same instant. Harmless for a real
    // window, since one overlapping an open window is refused above - but a
    // **zero-width** window overlaps nothing and so cannot be refused, and `observe`
    // produces one whenever a value changes twice inside a single millisecond.
    // Imported, it displaces the open record in the rebuilt index, and the sourced
    // read answers null while `openObservations` still names the holder: the
    // contradiction the overlap rule exists to prevent, reached by a record too short
    // for it to see.
    store.observations.sort(
      (a, b) => a.firstSeen - b.firstSeen
        || (a.closedAt === null ? 1 : 0) - (b.closedAt === null ? 1 : 0),
    );
    store.latestBySource = null;
    store.indexedCount = -1;
  }
  return {
    added,
    skipped: incoming.length - added - conflicted,
    conflicted,
    total: store.observations.length,
  };
}

// What a prune would remove, without removing it.
//
// The store law says gone is closed and never deleted, and it means never
// deleted *by a sync*: a disappearance is intelligence and no automatic process
// may quietly drop it. A pilot deciding to clear their own history is a
// different act, and it is the only thing that may remove a closed window.
//
// So this counts first, so the confirmation can say precisely what will go.
// Open observations are never removable at any age: an open window is current
// state, not history, and losing one would not lose a record of the past - it
// would lose the answer to "who holds this now".
export function prunableSightings(store, { before = Infinity } = {}) {
  let removable = 0;
  let open = 0;
  let oldest = null;
  let newest = null;
  const kinds = new Map();
  for (const entry of store.observations) {
    if (entry.closedAt === null) {
      open += 1;
      continue;
    }
    if (!(entry.closedAt < before)) continue;
    removable += 1;
    if (oldest === null || entry.closedAt < oldest) oldest = entry.closedAt;
    if (newest === null || entry.closedAt > newest) newest = entry.closedAt;
    kinds.set(entry.kind, (kinds.get(entry.kind) ?? 0) + 1);
  }
  return { removable, open, oldest, newest, kinds, total: store.observations.length };
}

// Remove closed windows older than `before`. Returns what actually went.
//
// The index is dropped rather than patched: removing entries changes which one
// is last for an id, and rebuilding from the log is both simpler and the only
// version that cannot disagree with it.
export function pruneSightings(store, { before = Infinity } = {}) {
  const summary = prunableSightings(store, { before });
  if (!summary.removable) return { ...summary, removed: 0, kept: store.observations.length };
  store.observations = store.observations.filter(
    entry => entry.closedAt === null || !(entry.closedAt < before),
  );
  store.latestBySource = null;
  store.indexedCount = -1;
  return { ...summary, removed: summary.removable, kept: store.observations.length };
}

// Everything this source still has open is confirmed as of now, and nothing is
// appended.
//
// A 304 means the endpoint's answer has not changed since we last asked, which
// is a confirmation of every open observation in it - that is the entire point
// of asking conditionally. Five callers said so in a comment and then returned
// without touching the store, so `last_confirmed` stopped advancing the moment
// an etag started matching. ESI answers /sovereignty/map/ with a 304 for most
// syncs, so a holding confirmed hourly for a month still recorded the first
// sync as the last time anyone saw it, and the closing date of the window after
// it would be wrong by however long the streak ran.
//
// That window is the intelligence. "Who held this, and until when" is the
// question the sighting log exists to answer, and it was being answered with
// the date we stopped noticing rather than the date it stopped being true.
export function confirmAll(store, kind, { source = "unknown", now = Date.now() } = {}) {
  let confirmed = 0;
  for (const entry of store.observations) {
    if (entry.kind !== kind || entry.closedAt !== null) continue;
    // Only what this source opened. A public endpoint's 304 says nothing about
    // what a character token saw, and confirming another source's record on the
    // strength of it would be inventing an observation.
    if (entry.source !== source) continue;
    if (entry.lastConfirmed < now) {
      entry.lastConfirmed = now;
      confirmed += 1;
    }
  }
  return { confirmed, at: now, source };
}

export function syncAll(store, kind, seen, { source = "unknown", now = Date.now() } = {}) {
  const present = new Map();
  for (const item of seen) present.set(String(item.key), item.value ?? null);

  const opened = [];
  const changed = [];
  const closed = [];

  for (const [key, value] of present) {
    const existing = openForSource(store, kind, key, source);
    const before = existing ? existing.value : undefined;
    observe(store, { kind, key, value, source, now });
    if (!existing) opened.push({ key, value });
    else if (!sameValue(before, value)) changed.push({ key, from: before, to: value });
  }

  // Only what THIS source opened may be closed by this sync. A sync speaks for
  // what its own source can see and for nothing else: one pilot's structure
  // pull says nothing about what another pilot can still reach, and closing
  // their sightings would record a retreat that never happened.
  //
  // Sovereignty has a single public source, so this changes nothing there - but
  // it is what makes the multi-token layer safe to build on top.
  for (const entry of openObservations(store, kind, { source })) {
    if (present.has(entry.key)) continue;
    closeObservation(entry, now);
    closed.push({ key: entry.key, value: entry.value });
  }

  return { opened, changed, closed, at: now, source };
}

// Everything open, optionally for one source only.
//
// Keyed by thing *and* source. Keying by thing alone silently dropped one of
// two sources watching the same object - whichever appeared earlier in the log
// vanished from every list, every count and every route, without being closed
// and without anything saying so.
export function openObservations(store, kind = null, { source = null } = {}) {
  const open = new Map();
  for (const entry of store.observations) {
    if (kind !== null && entry.kind !== kind) continue;
    if (source !== null && entry.source !== source) continue;
    const slot = sourceSlot(entry.id, entry.source);
    if (entry.closedAt !== null) {
      if (open.get(slot) === entry) open.delete(slot);
      continue;
    }
    open.set(slot, entry);
  }
  return [...open.values()];
}

// Everything ever recorded about one thing, oldest first. This is the history
// the law exists to preserve.
export function historyOf(store, kind, key) {
  const id = entryKey(kind, key);
  return store.observations.filter(entry => entry.id === id);
}

// What changed between two moments. The diff view, and the thing a snapshot
// store could never answer.
export function changesBetween(store, kind, from, to) {
  const changes = [];
  for (const entry of store.observations) {
    if (kind !== null && entry.kind !== kind) continue;
    if (entry.firstSeen > from && entry.firstSeen <= to) {
      changes.push({ key: entry.key, at: entry.firstSeen, event: "opened", value: entry.value, source: entry.source });
    }
    if (entry.closedAt !== null && entry.closedAt > from && entry.closedAt <= to) {
      changes.push({ key: entry.key, at: entry.closedAt, event: "closed", value: entry.value, source: entry.source });
    }
  }
  return changes.sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
}

// --- persistence ---------------------------------------------------------------
// Absolute timestamps throughout, so a store reloaded next week shows what
// actually happened rather than restarting every window.

export function toJSON(store) {
  return { version: 1, observations: store?.observations ?? [] };
}

export function fromJSON(data) {
  const store = createSightings();
  const rows = Array.isArray(data?.observations) ? data.observations : [];
  for (const row of rows) {
    if (!row || typeof row.kind !== "string" || row.key === undefined) continue;
    if (!Number.isFinite(row.firstSeen)) continue;
    // Pushed directly, so the index is rebuilt on first use rather than
    // maintained here - a load is one pass either way.
    store.latestBySource = null;
    store.indexedCount = -1;
    store.observations.push({
      id: entryKey(row.kind, row.key),
      kind: row.kind,
      key: String(row.key),
      value: row.value ?? null,
      source: typeof row.source === "string" ? row.source : "unknown",
      firstSeen: row.firstSeen,
      lastConfirmed: Number.isFinite(row.lastConfirmed) ? row.lastConfirmed : row.firstSeen,
      closedAt: Number.isFinite(row.closedAt) ? row.closedAt : null,
    });
  }
  return store;
}
