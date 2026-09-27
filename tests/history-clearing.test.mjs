// Clearing the pilot's own live history.
//
// This is the only thing in the application that removes a closed window, and
// it exists because of a measurement rather than a feature request: the
// sighting log grows without bound and lives in local storage, which has a hard
// quota of a few megabytes. At roughly 200 bytes an observation that is around
// twenty-five thousand of them, after which nothing is ever saved again.
//
// The store law says *gone is closed, never deleted, because the disappearance
// is itself the intelligence*. That rule is about what a **sync** may do: no
// automatic process may quietly drop a record. A pilot deciding to clear their
// own history is a different act, and the law is kept by making it deliberate
// rather than by making it impossible.
//
// Two properties hold whatever else changes here:
//
//   1. An open sighting is never removed at any age. An open window is current
//      state, not history - losing one does not lose a record of the past, it
//      loses the answer to "who holds this now".
//   2. Nothing is removed until a confirmation has said what will go. A count
//      alone is not informed consent.

import { suite } from "./helpers.mjs";
import {
  HISTORY_FORMAT, close, createSightings, historyFile, historyOf, mergeHistory, observe, openObservations,
  openForSource, parseHistoryFile, prunableSightings, pruneSightings, syncAll,
} from "../web/sightings.js";
import { heldSystems, holderOf } from "../web/sovereignty.js";

const DAY = 86_400_000;

export default function run(app) {
  const t = suite("history clearing");
  const { state, ui } = app;

  // A store with a known shape: two systems changing hands daily for 45 days,
  // so most records are closed and two windows are still open.
  const build = () => {
    const store = createSightings();
    let now = Date.now() - 45 * DAY;
    for (let day = 0; day < 45; day += 1) {
      now += DAY;
      syncAll(store, "sovereignty", [
        { key: 30000142, value: { alliance_id: 99000000 + day } },
        { key: 30000144, value: { alliance_id: 5 } },
      ], { source: "public:sovereignty-map", now });
    }
    return store;
  };

  // --- the core, without any interface ------------------------------------------
  const store = build();
  const open = openObservations(store).length;
  t.equal(open, 2, "two windows are open");
  const monthAgo = Date.now() - 30 * DAY;

  const look = prunableSightings(store, { before: monthAgo });
  t.check(look.removable > 0, `something is old enough to remove (${look.removable})`);
  t.equal(look.open, open, "and counting does not touch what is open");
  t.equal(look.total, store.observations.length, "the count is taken against the whole log");
  t.check(look.oldest <= look.newest, "with the span of what would go");
  t.check(look.kinds.get("sovereignty") > 0, "and what kinds it holds");

  const before = store.observations.length;
  const done = pruneSightings(store, { before: monthAgo });
  t.equal(done.removed, look.removable, "the prune removes exactly what the count promised");
  t.equal(store.observations.length, before - done.removed, "and nothing else");
  t.equal(openObservations(store).length, open, "every open window survives");
  t.equal(openForSource(store, "sovereignty", 30000142, "public:sovereignty-map")?.value.alliance_id, 99000044,
    "so the current holder is still the current holder");

  // The index is derived from the log and must be rebuilt, not patched: removing
  // entries changes which one is last for an id.
  t.check(!store.observations.some(entry => entry.closedAt !== null && entry.closedAt < monthAgo),
    "no closed record older than the cutoff remains");

  // Everything closed, and the open windows still stand.
  const all = pruneSightings(store, { before: Infinity });
  t.check(all.removed > 0, `clearing everything closed removes the rest (${all.removed})`);
  t.equal(openObservations(store).length, open, "and still leaves the open ones");
  t.equal(store.observations.length, open, "so only current state remains");
  t.equal(pruneSightings(store, { before: Infinity }).removed, 0, "a second pass removes nothing");

  // --- the confirmation ----------------------------------------------------------
  const savedLive = state.live;
  try {
    state.live = build();
    app.bindHistory();
    t.check(/\d/.test(ui.historySummary.textContent), `the shelf counts what is held (${ui.historySummary.textContent})`);
    t.check(/open/.test(ui.historyCount.textContent) && /closed/.test(ui.historyCount.textContent),
      `and separates open from closed (${ui.historyCount.textContent})`);

    const held = state.live.observations.length;
    ui.historyAge.value = "30";

    // First click arms and explains. It must not remove anything.
    ui.clearHistory.onclick();
    t.equal(state.live.observations.length, held, "the first click removes nothing");
    const note = ui.historyNote.textContent;
    t.check(/permanently remove \d/.test(note), `it says how many will go (${note.slice(0, 60)})`);
    t.check(/month/.test(note), "and which records those are");
    t.check(/cannot be undone/.test(note), "and that it cannot be undone");
    t.check(/open sightings? (is|are) kept/.test(note), "and what is kept");
    t.check(/nothing currently held is affected/.test(note), "saying plainly that current state survives");
    t.check(/sovereignty/.test(note), "naming the kinds of record involved");
    t.check(/Remove \d/.test(ui.clearHistory.textContent), `the button becomes the action (${ui.clearHistory.textContent})`);
    t.check(!ui.cancelClearHistory.hidden, "and a way out appears beside it");

    // Cancelling leaves the store alone and puts the button back.
    ui.cancelClearHistory.onclick();
    t.equal(state.live.observations.length, held, "cancelling removes nothing");
    t.equal(ui.clearHistory.textContent, "Clear history", "and the button returns to asking");
    t.check(ui.cancelClearHistory.hidden, "with the way out put away");

    // Changing what would go retracts a confirmation that described something else.
    ui.clearHistory.onclick();
    t.check(/Remove \d/.test(ui.clearHistory.textContent), "armed again");
    ui.historyAge.dispatch("change");
    t.equal(ui.clearHistory.textContent, "Clear history",
      "changing the age disarms, because the sentence described a different set");
    t.equal(state.live.observations.length, held, "and still nothing has been removed");

    // Second click, with the confirmation standing, does it.
    ui.clearHistory.onclick();
    const promised = Number((/Remove ([\d,]+)/.exec(ui.clearHistory.textContent) ?? [])[1]?.replace(/,/g, ""));
    ui.clearHistory.onclick();
    t.check(state.live.observations.length < held, "the second click removes");
    t.equal(state.live.observations.length, held - promised, "exactly the number the button offered");
    t.check(/Removed \d/.test(ui.historyNote.textContent), `and reports what went (${ui.historyNote.textContent})`);
    t.equal(ui.clearHistory.textContent, "Clear history", "with the button back to asking");

    // Nothing to remove is said, rather than offering a button that does nothing.
    state.live = createSightings();
    syncAll(state.live, "sovereignty", [{ key: 1, value: { a: 1 } }], { source: "p", now: Date.now() });
    app.renderHistoryCount();
    ui.historyAge.value = "30";
    ui.clearHistory.onclick();
    t.check(/Nothing to remove/.test(ui.historyNote.textContent),
      `a log with only open sightings offers nothing (${ui.historyNote.textContent.slice(0, 70)})`);
    t.check(/open sighting is current state/.test(ui.historyNote.textContent),
      "and explains why an open sighting is not history");
    t.equal(ui.clearHistory.textContent, "Clear history", "so the button never arms");

    // Nothing *old enough* is a different fact from nothing closed, and the
    // shelf said the wrong one: with 138 closed records in the log and none of
    // them a month old, it reported that every sighting was still open. That is
    // a false statement about the store, made by inferring the general case
    // from the filtered one.
    state.live = createSightings();
    const recent = Date.now() - 2 * DAY;
    syncAll(state.live, "sovereignty", [{ key: 1, value: { a: 1 } }, { key: 2, value: { a: 1 } }],
      { source: "p", now: recent });
    syncAll(state.live, "sovereignty", [{ key: 1, value: { a: 2 } }], { source: "p", now: Date.now() });
    app.renderHistoryCount();
    ui.historyAge.value = "30";
    ui.clearHistory.onclick();
    const filtered = ui.historyNote.textContent;
    t.check(/Nothing to remove at that age/.test(filtered),
      `an age that matches nothing says so (${filtered.slice(0, 60)})`);
    t.check(/closed record/.test(filtered), "and reports the closed records it is still holding");
    t.check(!/All \d+ sightings are still open/.test(filtered),
      "rather than claiming every sighting is open when some are closed");
    t.equal(ui.clearHistory.textContent, "Clear history", "and still never arms");

    // The same store with no age filter does have something to remove, which is
    // what makes the message above a statement about the filter and not the log.
    ui.historyAge.value = "all";
    ui.clearHistory.onclick();
    t.check(/Remove \d/.test(ui.clearHistory.textContent),
      "while 'every closed record' finds them");
    app.disarmHistory();
  } finally {
    state.live = savedLive;
    app.disarmHistory();
    app.renderHistoryCount();
  }

  // --- taking a copy out, and putting it back -----------------------------------
  // Clearing is deliberate; this is what makes it recoverable. Only closed
  // windows are ever exported or imported, so a file can never assert that
  // something is held now - that would be a claim about the present made from a
  // record of the past.
  const carrier = build();
  const cutoff = Date.now() - 30 * DAY;
  const file = historyFile(carrier, { before: cutoff });
  const parsed = JSON.parse(file);
  t.equal(parsed.format, HISTORY_FORMAT, "the export names its format");
  t.check(parsed.count > 0, `and carries records (${parsed.count})`);
  t.check(parsed.observations.every(row => Number.isFinite(row.closedAt)),
    "every exported record is a closed one");

  const beforeClear = carrier.observations.length;
  const cleared = pruneSightings(carrier, { before: cutoff });
  t.equal(carrier.observations.length, beforeClear - cleared.removed, "clearing removes them");

  const restored = mergeHistory(carrier, parseHistoryFile(file));
  t.equal(restored.added, cleared.removed, "and importing the file brings back exactly what went");
  t.equal(carrier.observations.length, beforeClear, "leaving the log as it was");
  t.equal(openObservations(carrier).length, 2, "with the open windows untouched throughout");

  const twice = mergeHistory(carrier, parseHistoryFile(file));
  t.equal(twice.added, 0, "importing the same file again adds nothing");
  t.equal(twice.skipped, restored.added, "and says everything was already held");

  // --- an import may not make a claim about the present -----------------------
  //
  // `parseHistoryFile` refuses a record that is not closed, and says why: "an
  // import that could reopen a window would let a file assert that something is
  // held now, which is a claim about the present from a record of the past."
  //
  // A *closed* record could make that claim anyway, by landing on top of an open
  // one. Two windows for one thing and one source then overlap, and the three
  // readers of this log disagree - because each resolves the overlap
  // differently. `openObservations` clears a slot only when it holds that same
  // entry object, so it keeps the open one. `openAt` and `openForSource` walk
  // backwards and return `null` the instant they meet a closed window covering
  // the moment asked about.
  //
  // Measured before this was refused: Delve open since January under alliance 1;
  // a fleetmate's export whose machine saw it change hands in March. After the
  // import, `openObservations` named alliance 1 and `openAt` - which `holderOf`
  // reads - answered null. "Held since" jumped a hundred days, the next sync
  // reported an `opened` event for a change that never happened, and the
  // original window was orphaned for good: invisible to `openAt`, so no sync
  // could close it, and `pruneSightings` refuses an open row at any age.
  {
    const JAN = Date.parse("2026-01-01T00:00:00Z");
    const MAR = Date.parse("2026-03-01T00:00:00Z");
    const APR = Date.parse("2026-04-11T00:00:00Z");
    const SRC = "esi:/sovereignty/map/";
    const mine = createSightings();
    observe(mine, { kind: "sovereignty", key: 30002510, value: { alliance_id: 1 }, source: SRC, now: JAN });

    const theirs = [{
      id: "sovereignty:30002510", kind: "sovereignty", key: "30002510",
      value: { alliance_id: 2 }, source: SRC,
      firstSeen: MAR, lastConfirmed: APR, closedAt: APR,
    }];

    const clash = mergeHistory(mine, theirs);
    t.equal(clash.conflicted, 1, "a record overlapping an open window is refused");
    t.equal(clash.added, 0, "and not added");
    t.equal(clash.skipped, 0, "and is not reported as one already held - a different fact");

    // The property that matters: the readers agree.
    const stillOpen = openObservations(mine, "sovereignty");
    t.equal(stillOpen.length, 1, "the pilot's own open window survives");
    t.equal(openForSource(mine, "sovereignty", 30002510, SRC)?.value?.alliance_id ?? null, 1,
      "and openAt still answers with it, so holderOf and heldSystems cannot disagree");
    t.equal(historyOf(mine, "sovereignty", 30002510).length, 1, "nothing was filed on top of it");

    // Genuine history from *before* the open window is not a conflict and must
    // still import - the whole purpose of sharing a file.
    const older = mergeHistory(mine, [{
      id: "sovereignty:30002510", kind: "sovereignty", key: "30002510",
      value: { alliance_id: 3 }, source: SRC,
      firstSeen: Date.parse("2025-11-01T00:00:00Z"),
      lastConfirmed: Date.parse("2025-12-01T00:00:00Z"),
      closedAt: Date.parse("2025-12-01T00:00:00Z"),
    }]);
    t.equal(older.added, 1, "a closed window entirely before the open one imports");
    t.equal(older.conflicted, 0, "and is not a conflict");
    t.equal(openForSource(mine, "sovereignty", 30002510, SRC)?.value?.alliance_id ?? null, 1,
      "with the present still answered by the pilot's own observation");
    t.equal(historyOf(mine, "sovereignty", 30002510).length, 2, "and the log now carries both");

    // Touching is not overlapping. A window closing at the instant the next
    // opens is the ordinary supersede `observe` performs, and refusing it would
    // refuse every normal history.
    const abuts = mergeHistory(mine, [{
      id: "sovereignty:30002510", kind: "sovereignty", key: "30002510",
      value: { alliance_id: 4 }, source: SRC,
      firstSeen: Date.parse("2025-12-01T00:00:00Z"), lastConfirmed: JAN, closedAt: JAN,
    }]);
    t.equal(abuts.added, 1, "a window closing exactly as the open one begins is not a conflict");
    t.equal(abuts.conflicted, 0, "so an ordinary supersede round-trips");

    // A file cannot contradict itself either: the second of two overlapping
    // records in one import is refused against the first.
    const fresh = createSightings();
    const twoWays = mergeHistory(fresh, [
      { id: "sovereignty:1", kind: "sovereignty", key: "1", value: { alliance_id: 1 },
        source: SRC, firstSeen: JAN, lastConfirmed: MAR, closedAt: MAR },
      { id: "sovereignty:1", kind: "sovereignty", key: "1", value: { alliance_id: 2 },
        source: SRC, firstSeen: Date.parse("2026-02-01T00:00:00Z"), lastConfirmed: APR, closedAt: APR },
    ]);
    t.equal(twoWays.added, 1, "one of two overlapping records in one file is taken");
    t.equal(twoWays.conflicted, 1, "and the other is refused against it");

    // **A second observer confirming the same window is corroboration, not a
    // duplicate.** The duplicate identity was built from id, `firstSeen` and
    // `closedAt` and left `source` out, while the overlap check three lines below
    // it is keyed on source - so the two halves of one function disagreed about
    // what a record is. An identical closed window arriving from observer-b was
    // counted as already held and dropped, which is the one outcome the merge
    // could not record: two sources agreeing.
    //
    // It contradicts the law the store is built on - "a sync speaks for what its
    // own source can see and for nothing else" - and it is reachable through the
    // import button, in the format whose own comment says it exists to be shared.
    {
      const SEEN_BY_A = "observer-a";
      const SEEN_BY_B = "observer-b";
      const held = createSightings();
      observe(held, { kind: "bridge", key: "g-1", value: { to: 30000142 }, source: SEEN_BY_A, now: JAN });
      syncAll(held, "bridge", [], { source: SEEN_BY_A, now: MAR });
      t.equal(historyOf(held, "bridge", "g-1").length, 1, "observer-a's window is closed and kept");

      const sameWindow = (source) => ([{
        id: "bridge:g-1", kind: "bridge", key: "g-1", value: { to: 30000142 },
        source, firstSeen: JAN, lastConfirmed: MAR, closedAt: MAR,
      }]);

      const corroborated = mergeHistory(held, sameWindow(SEEN_BY_B));
      t.equal(corroborated.added, 1, "the same window from a second observer is added");
      t.equal(corroborated.skipped, 0, "not counted as one already held");
      t.equal(corroborated.conflicted, 0, "and not as a conflict - they agree");
      const records = historyOf(held, "bridge", "g-1");
      t.equal(records.length, 2, "so the log carries both observations");
      t.equal([...new Set(records.map((entry) => entry.source))].sort().join(","),
        `${SEEN_BY_A},${SEEN_BY_B}`, "one per source, which is what makes it corroboration");

      // Each source's own timeline still answers for itself, which is the property
      // the per-source keying exists for.
      t.equal(openForSource(held, "bridge", "g-1", SEEN_BY_A, JAN + 1)?.source ?? null, SEEN_BY_A,
        "observer-a's window answers for observer-a");
      t.equal(openForSource(held, "bridge", "g-1", SEEN_BY_B, JAN + 1)?.source ?? null, SEEN_BY_B,
        "and observer-b's for observer-b");

      // **And deduplication still works**, which is the reason the identity exists
      // at all: the same observer's own file, imported twice, adds nothing.
      const again = mergeHistory(held, sameWindow(SEEN_BY_B));
      t.equal(again.added, 0, "re-importing observer-b's file adds nothing");
      t.equal(again.skipped, 1, "it is reported as already held");
      t.equal(historyOf(held, "bridge", "g-1").length, 2, "and the log does not grow");

      // Overlap is still refused *within* a source, unchanged: a second observer
      // is a second timeline, not permission to contradict one.
      const clash = mergeHistory(held, [{
        id: "bridge:g-1", kind: "bridge", key: "g-1", value: { to: 30002187 },
        source: SEEN_BY_B, firstSeen: JAN + DAY, lastConfirmed: MAR, closedAt: MAR - DAY,
      }]);
      t.equal(clash.added, 0, "a window overlapping observer-b's own is refused");
      t.equal(clash.conflicted, 1, "as a conflict rather than as a duplicate");
    }

    // **The readers have to agree while the local window is still open.**
    //
    // The block above closes the local window before importing and then asks
    // `openForSource`, which is the one arrangement that cannot see this. Making a
    // second source legal opened a second door to the contradiction the overlap rule
    // exists to stop: two sources are two slots, so overlap cannot refuse them, and
    // an unsourced reader then picked whichever row came last in the log.
    //
    // `openAt` was that reader. It answered "is the most recently *written* row
    // open", which is a different question the moment two sources hold one key - so
    // a later closed row from anyone else made it answer null while
    // `openObservations` still listed the open one. `holderOf` read it, so the map
    // ring and the system panel went blank while the sovereignty bar, which reads
    // `openObservations`, still said held. It is gone; every reader names its source.
    {
      const MINE = "public:sovereignty-map";
      const THEIRS = "unknown";
      const store = createSightings();
      observe(store, { kind: "sovereignty", key: 30000142, value: { alliance_id: 1 }, source: MINE, now: JAN });

      // A later window, closed, from a different source. Legal - it is their
      // timeline - and it must not touch the answer about ours.
      const landed = mergeHistory(store, [{
        id: "sovereignty:30000142", kind: "sovereignty", key: "30000142",
        value: { alliance_id: 2 }, source: THEIRS,
        firstSeen: MAR, lastConfirmed: APR, closedAt: APR,
      }]);
      t.equal(landed.added, 1, "a later closed window from another source is added");
      t.equal(landed.conflicted, 0, "and is not a conflict, because it is not our timeline");

      const openHere = openObservations(store, "sovereignty")
        .filter((entry) => entry.key === "30000142");
      t.equal(openHere.length, 1, "our window is still the only open one");
      t.equal(openHere[0].source, MINE, "and it is ours");
      t.equal(openForSource(store, "sovereignty", 30000142, MINE)?.value?.alliance_id ?? null, 1,
        "the sourced read still answers with it, which is what holderOf asks");
      t.equal(openForSource(store, "sovereignty", 30000142, THEIRS), null,
        "while their timeline is correctly closed");

      // The property, stated as the two readers agreeing rather than as either
      // answer: this is what went wrong, and it went wrong by them differing.
      t.equal(holderOf(store, 30000142)?.alliance_id ?? null, 1,
        "holderOf and openObservations agree about who holds it");
      t.equal(heldSystems(store).size, 1, "and the bar counts the same one system");
      t.check(heldSystems(store).has(30000142), "the same system, not merely the same count");

      // **A second source with a window still open**, which is the case a closed
      // one cannot test: unfiltered, `heldSystems` collapses both into one entry per
      // system by writing the later over the earlier, and `holderOf` picks whichever
      // row came last in the log. Both then report somebody else's claim.
      observe(store, { kind: "sovereignty", key: 30000142, value: { alliance_id: 9 }, source: "someone-else", now: MAR });
      // And a system only they claim, which an unfiltered read would add outright.
      observe(store, { kind: "sovereignty", key: 30002187, value: { alliance_id: 9 }, source: "someone-else", now: MAR });
      t.equal(openObservations(store, "sovereignty").length, 3,
        "the log now holds three open windows across two sources");

      t.equal(holderOf(store, 30000142)?.alliance_id ?? null, 1,
        "holderOf still answers with the public map's holder, not the later claim");
      t.equal(heldSystems(store).get(30000142)?.alliance_id ?? null, 1,
        "and the bar reads the same alliance rather than whichever row came last");
      t.equal(heldSystems(store).size, 1,
        "with a system only another source claims left out entirely");
      t.equal(holderOf(store, 30002187), null, "and not reported as held");
    }

    // **The two halves of one lookup agree about an absent source.** The indexed
    // path normalises through `sourceSlot`, which reads a missing source as
    // "unknown"; the backwards scan compared strictly, so asking with no source
    // found the row at `Infinity` and not at any earlier instant. Reachable through
    // the Remove button the moment its row carries no source attribute.
    {
      const store = createSightings();
      observe(store, { kind: "bridge", key: "g-3", value: { from: 1, to: 2 }, now: JAN });
      t.equal(openForSource(store, "bridge", "g-3", "unknown")?.key ?? null, "g-3",
        "an unattributed row is found under the source it was stored as");
      t.equal(openForSource(store, "bridge", "g-3", undefined)?.key ?? null, "g-3",
        "and found when the caller names no source at all");
      // The historical path, which is the one that disagreed.
      t.equal(openForSource(store, "bridge", "g-3", undefined, JAN + DAY)?.key ?? null, "g-3",
        "including at an earlier instant, where the scan runs instead of the index");
      t.equal(openForSource(store, "bridge", "g-3", "unknown", JAN + DAY)?.key ?? null, "g-3",
        "which agrees with the spelled-out source");
    }

    // **Remove closes the row it was told about.** `close` took no source, so it
    // closed whatever the id-only index pointed at: with a second observer's row
    // present the button either did nothing - the row it found was already closed by
    // the other source's sync - or closed a window belonging to somebody else.
    {
      const ALICE = "character:Alice";
      const BOB = "character:Bob";
      const store = createSightings();
      observe(store, { kind: "bridge", key: "g-2", value: { from: 1, to: 2 }, source: ALICE, now: JAN });
      observe(store, { kind: "bridge", key: "g-2", value: { from: 1, to: 2 }, source: BOB, now: MAR });
      syncAll(store, "bridge", [], { source: BOB, now: APR });
      t.equal(openObservations(store, "bridge").length, 1, "Bob's sync closes only Bob's row");

      const removed = close(store, "bridge", "g-2", ALICE, APR + DAY);
      t.check(removed !== null, "Remove finds Alice's row when told it is hers");
      t.equal(removed.source, ALICE, "and closes hers, not the one already closed");
      t.equal(openForSource(store, "bridge", "g-2", ALICE), null, "so hers is closed");
      t.equal(openObservations(store, "bridge").length, 0, "and nothing is left open");
      t.equal(historyOf(store, "bridge", "g-2").length, 2, "with both observations kept as history");
    }

    // **A window too short to overlap anything could still displace an open
    // one.** `observe` produces a zero-width window whenever two values arrive
    // inside one millisecond: it closes the old at `now` and opens the new at
    // `now`, leaving a record whose `closedAt` equals its `firstSeen`. It covers
    // no instant, so the overlap rule above cannot see it, and `historyFile`
    // exports it like any other closed record.
    //
    // In the live store it is harmless - `observe` pushes it *before* the open
    // record and `openAt` scans backwards. Imported, a stable sort by `firstSeen`
    // alone left it *after* an open record starting at the same instant, and then
    // `openAt` answered null while `openObservations` still named the holder.
    // Measured before the fix; the same contradiction as the overlap case,
    // reached by a record it cannot refuse.
    const tick = Date.parse("2026-05-01T00:00:00Z");
    const twice = createSightings();
    observe(twice, { kind: "sovereignty", key: 30000142, value: { alliance_id: 7 }, source: SRC, now: tick });
    observe(twice, { kind: "sovereignty", key: 30000142, value: { alliance_id: 8 }, source: SRC, now: tick });
    t.equal(twice.observations.filter(e => e.closedAt === e.firstSeen).length, 1,
      "the store itself produces a zero-width window on a one-tick change");

    const exported = parseHistoryFile(historyFile(twice, { before: Infinity }));
    t.equal(exported.length, 1, "and exports it, so a legitimate file carries one");

    const receiver = createSightings();
    observe(receiver, { kind: "sovereignty", key: 30000142, value: { alliance_id: 8 }, source: SRC, now: tick });
    const degenerate = mergeHistory(receiver, exported);
    t.equal(degenerate.added, 1, "it imports rather than being refused, so nothing legitimate is lost");
    t.equal(openObservations(receiver, "sovereignty").length, 1, "the open window survives the import");
    t.equal(openForSource(receiver, "sovereignty", 30000142, SRC)?.value?.alliance_id ?? null, 8,
      "and openAt still answers with it, so holderOf and heldSystems cannot disagree");

    // A window that ends before it begins is not a record at all, and is now
    // refused deliberately rather than by accident.
    let inverted = null;
    try {
      parseHistoryFile(JSON.stringify({
        format: HISTORY_FORMAT,
        observations: [{ kind: "sovereignty", key: "1", source: SRC, firstSeen: APR, closedAt: MAR }],
      }));
    } catch (error) { inverted = error.message; }
    t.check(inverted !== null && /closed before/.test(inverted),
      `a window closing before it opens is refused (${inverted ?? "accepted"})`);

    // And a zero-width one is still accepted at the parser, because the store
    // makes them and refusing the file would lose a whole history over one tick.
    t.equal(parseHistoryFile(JSON.stringify({
      format: HISTORY_FORMAT,
      observations: [{ kind: "sovereignty", key: "1", source: SRC, firstSeen: MAR, closedAt: MAR }],
    })).length, 1, "while a zero-width one is not, because observe makes them");
  }

  // **No (thing, source) ever holds two overlapping windows**, whatever route the
  // log arrived by. This is the invariant all three readers rest on, asserted
  // over the store this file has been building rather than over a fixture.
  {
    const windows = new Map();
    for (const entry of carrier.observations) {
      const slot = `${entry.id}::${entry.source ?? "unknown"}`;
      if (!windows.has(slot)) windows.set(slot, []);
      windows.get(slot).push(entry);
    }
    const clashes = [];
    for (const [slot, list] of windows) {
      for (let i = 0; i < list.length; i += 1) {
        for (let j = i + 1; j < list.length; j += 1) {
          const a = list[i];
          const b = list[j];
          const aEnd = a.closedAt === null ? Infinity : a.closedAt;
          const bEnd = b.closedAt === null ? Infinity : b.closedAt;
          if (a.firstSeen < bEnd && b.firstSeen < aEnd) clashes.push(slot);
        }
      }
    }
    // The bar is pairs actually compared, not slots: a slot with one window
    // proves nothing, and `carrier` is deliberately a small fixture. What makes
    // this worth asserting is that it has been through the whole round trip -
    // synced, closed, exported, pruned, re-imported twice - so the pairs it does
    // hold are the ones the merge path produced.
    let pairs = 0;
    for (const list of windows.values()) pairs += (list.length * (list.length - 1)) / 2;
    t.check(pairs > 0, `windows were actually compared (${pairs} pairs across ${windows.size} slots)`);
    t.equal(clashes.length, 0,
      `no thing holds two overlapping windows from one source${clashes.length ? `: ${clashes[0]}` : ""}`);
  }

  // A falsy value is a value. `row.value ?? null` survived being weakened to
  // `||`, which turns 0, false and "" into null on the way in - so a record
  // saying "zero kills seen" or "not contested" would come back from an export
  // as "we do not know". Every test until now exported objects, which are never
  // falsy.
  const falsy = createSightings();
  const at = Date.now() - 5 * DAY;
  syncAll(falsy, "activity", [
    { key: "zero", value: 0 },
    { key: "no", value: false },
    { key: "blank", value: "" },
  ], { source: "p", now: at });
  syncAll(falsy, "activity", [], { source: "p", now: at + DAY });
  const carried = parseHistoryFile(historyFile(falsy, { before: Infinity }));
  const valueOf = key => carried.find(row => row.key === key)?.value;
  t.equal(valueOf("zero"), 0, "a value of zero survives an export and import as zero");
  t.equal(valueOf("no"), false, "and false as false");
  t.equal(valueOf("blank"), "", "and an empty string as an empty string");

  // A file that is not one, refused whole rather than in part.
  t.throws(() => parseHistoryFile("{"), "not valid JSON", "a broken file is refused");
  t.throws(() => parseHistoryFile('{"format":"something-else","observations":[]}'), "expected",
    "as is a file of another format");
  t.throws(() => parseHistoryFile(JSON.stringify({ format: HISTORY_FORMAT })), "no observations",
    "and one carrying nothing");
  t.throws(() => parseHistoryFile(JSON.stringify({
    format: HISTORY_FORMAT,
    observations: [{ kind: "sov", key: 1, firstSeen: 1, closedAt: null }],
  })), "not a closed record",
    "an open window in a file is refused, so an import cannot assert something is held now");

  // --- the cutoff itself ----------------------------------------------------------
  const now = Date.UTC(2026, 8, 19);
  t.equal(app.historyCutoff("all", now), Infinity, "'every closed record' has no cutoff");
  t.equal(app.historyCutoff("1", now), now - DAY, "a day is a day");
  t.equal(app.historyCutoff("30", now), now - 30 * DAY, "and a month is thirty of them");
  t.equal(app.historyCutoff("0", now), null, "zero is not an age");
  t.equal(app.historyCutoff("-5", now), null, "nor is a negative one");
  t.equal(app.historyCutoff("nonsense", now), null, "nor anything that is not a number");

  // --- a clear removes exactly what the confirmation counted ------------------
  //
  // The note names a number - "This will permanently remove 44 records" - and
  // that number is what a pilot agrees to. `historyArmed` held only the cutoff,
  // so with age "All" the cutoff is `Infinity` and a sync landing between the
  // arming click and the confirming click had its newly-closed windows swept up
  // too: never counted, never described, never in the kind breakdown, and never
  // in the export the note tells you to take first. Measured at 44 promised, 45
  // removed.
  //
  // Aged cutoffs were already safe - `before` is an absolute instant fixed at
  // arming, so anything closed after it falls outside - which is why "All" is
  // the option that mattered and the one a pilot reaching for "clear
  // everything" picks.
  if (app) {
    const { state, ui } = app;
    const saved = { live: state.live, age: ui.historyAge?.value };
    try {
      const store = createSightings();
      const long = Date.now() - 40 * DAY;
      // Four closed records, and one that stays open.
      syncAll(store, "sovereignty", [{ key: "a", value: 1 }, { key: "b", value: 1 },
        { key: "c", value: 1 }, { key: "d", value: 1 }], { source: "s", now: long });
      syncAll(store, "sovereignty", [], { source: "s", now: long + DAY });
      observe(store, { kind: "sovereignty", key: "open", value: 1, source: "s", now: long });
      state.live = store;
      ui.historyAge.value = "all";

      const closedBefore = prunableSightings(store, { before: Infinity }).removable;
      t.equal(closedBefore, 4, "four closed records to begin with");

      app.clearHistory();                       // first press arms
      t.check(/permanently remove 4 /.test(ui.historyNote.textContent),
        `the confirmation names four (${ui.historyNote.textContent.slice(0, 48)})`);

      // A sync lands while the confirmation is on screen, closing a fifth.
      //
      // `open` is listed in both, because `syncAll` is a whole-endpoint sync:
      // anything open and *not* present is closed. Omitting it closed the very
      // sighting this block exists to prove survives - which is the fixture
      // making the point for the code rather than testing it.
      syncAll(store, "sovereignty", [{ key: "e", value: 1 }, { key: "open", value: 1 }],
        { source: "s", now: Date.now() - 60_000 });
      syncAll(store, "sovereignty", [{ key: "open", value: 1 }], { source: "s", now: Date.now() });
      t.equal(prunableSightings(store, { before: Infinity }).removable, 5,
        "and now there are five");

      app.clearHistory();                       // second press: must not remove five
      t.equal(prunableSightings(store, { before: Infinity }).removable, 5,
        "the second press removes nothing, because the store is not what was counted");
      t.check(/changed while that was on screen/.test(ui.historyNote.textContent),
        `and says so (${ui.historyNote.textContent.slice(0, 64)})`);
      t.check(/permanently remove 5 /.test(ui.historyNote.textContent),
        "re-armed on the new figure, so the intent is not discarded");

      // Confirming the re-armed figure does the work.
      app.clearHistory();
      t.equal(prunableSightings(store, { before: Infinity }).removable, 0,
        "and confirming the figure it now shows removes them");
      t.equal(openObservations(store, "sovereignty").length, 1,
        "with the open sighting kept, at any age");

      // And the other direction of "the store is not what was counted": the log
      // shrinks instead of growing. A live-store restore replaces `state.live`
      // wholesale, so this is reachable between the two clicks.
      //
      // It matters because `armHistory` returns *early* when there is nothing to
      // remove, without setting `historyArmed` - so re-arming has to clear it
      // first, or a stale cutoff and a stale count survive the re-arm and the
      // next click prunes against them.
      syncAll(store, "sovereignty", [{ key: "x", value: 1 }, { key: "open", value: 1 }],
        { source: "s", now: long });
      syncAll(store, "sovereignty", [{ key: "open", value: 1 }], { source: "s", now: long + DAY });
      t.equal(prunableSightings(store, { before: Infinity }).removable, 1, "one closed record again");
      app.clearHistory();
      t.check(/permanently remove 1 /.test(ui.historyNote.textContent), "armed on one");

      state.live = createSightings();            // a restore lands
      app.clearHistory();
      t.check(/changed while that was on screen/.test(ui.historyNote.textContent),
        "a log that shrank is also not what was counted");
      t.equal(app.historyCutoffArmed(), null,
        "and the arm is cleared rather than left holding a cutoff for a store that is gone");
    } finally {
      state.live = saved.live;
      if (ui.historyAge && saved.age !== undefined) ui.historyAge.value = saved.age;
      app.disarmHistory();
      if (ui.historyNote) ui.historyNote.textContent = "";
    }
  }

  return t.results;
}
