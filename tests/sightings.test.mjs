// The live store, which is a log of dated sightings and never current state.
//
// These tests are mostly about the difference between those two things, because
// the whole design is one decision - gone is closed, not deleted - and every
// feature that matters downstream is a consequence of it. If a sync can quietly
// overwrite, the history the store exists for stops existing and nothing fails
// until somebody asks a question it can no longer answer.

import { suite } from "./helpers.mjs";
import {
  openForSource,
  changesBetween, close, createSightings, fromJSON, historyOf, observe,
  openObservations, syncAll, toJSON,
} from "../web/sightings.js";

const T = n => Date.parse("2026-09-01T00:00:00Z") + n * 3_600_000;

export default function run() {
  const t = suite("sightings");

  // --- one thing, over time -----------------------------------------------------
  const store = createSightings();
  observe(store, { kind: "sov", key: 30000142, value: { alliance: 1 }, source: "public", now: T(0) });
  t.equal(openForSource(store, "sov", 30000142, "public").value.alliance, 1, "a sighting is open once recorded");
  t.equal(store.observations.length, 1, "and is one observation");

  // Seen again, unchanged: extend rather than append. A second record would
  // only say "still true", and an hourly sync would then store the entire map
  // every hour to record nothing.
  observe(store, { kind: "sov", key: 30000142, value: { alliance: 1 }, source: "public", now: T(1) });
  t.equal(store.observations.length, 1, "seeing the same value again does not append a row");
  t.equal(openForSource(store, "sov", 30000142, "public").lastConfirmed, T(1), "it moves last_confirmed");
  t.equal(openForSource(store, "sov", 30000142, "public").firstSeen, T(0), "and leaves first_seen alone");

  // Changed: close the old window, open a new one.
  observe(store, { kind: "sov", key: 30000142, value: { alliance: 2 }, source: "public", now: T(2) });
  t.equal(store.observations.length, 2, "a changed value appends");
  t.equal(openForSource(store, "sov", 30000142, "public").value.alliance, 2, "the new value is open");
  const history = historyOf(store, "sov", 30000142);
  t.equal(history.length, 2, "and both are kept");
  t.equal(history[0].closedAt, T(2), "the old window is closed at the moment of the change");
  t.equal(history[0].value.alliance, 1, "with its value intact - the history is the point");

  // Closing is not deleting.
  // Told whose window, the way `syncAll` always has been.
  close(store, "sov", 30000142, "public", T(3));
  t.equal(openForSource(store, "sov", 30000142, "public"), null, "a closed thing is not open");
  t.equal(historyOf(store, "sov", 30000142).length, 2, "but nothing was removed");
  t.equal(historyOf(store, "sov", 30000142)[1].closedAt, T(3), "the window simply has an end");
  t.equal(close(store, "sov", 30000142, "public", T(4)), null, "closing twice is a no-op rather than an error");

  // A window cannot end before the last time it was seen.
  const odd = createSightings();
  observe(odd, { kind: "x", key: "a", value: 1, now: T(5) });
  close(odd, "x", "a", "unknown", T(2));
  t.check(historyOf(odd, "x", "a")[0].closedAt >= T(5),
    "a window closed with a stale clock still ends no earlier than its last confirmation");

  // --- asking about the past -------------------------------------------------------
  t.equal(openForSource(store, "sov", 30000142, "public", T(1)).value.alliance, 1, "the store can be asked what was true earlier");
  t.equal(openForSource(store, "sov", 30000142, "public", T(2)).value.alliance, 2, "and at the moment of a change");
  t.equal(openForSource(store, "sov", 30000142, "public", T(3)), null, "and after it closed");

  // --- a whole-endpoint sync ---------------------------------------------------------
  // The sovereignty shape: the endpoint returns everything every time, so
  // absence is information and has to close a window. An "upsert what came
  // back" would miss exactly that.
  const sov = createSightings();
  const first = syncAll(sov, "sov", [
    { key: 1, value: { alliance: "A" } },
    { key: 2, value: { alliance: "B" } },
    { key: 3, value: { alliance: "C" } },
  ], { source: "public", now: T(0) });
  t.equal(first.opened.length, 3, "a first sync opens everything");
  t.equal(first.changed.length, 0, "changes nothing");
  t.equal(first.closed.length, 0, "and closes nothing");

  const second = syncAll(sov, "sov", [
    { key: 1, value: { alliance: "A" } },
    { key: 2, value: { alliance: "Z" } },
  ], { source: "public", now: T(1) });
  t.equal(second.opened.length, 0, "a second sync opens nothing new");
  t.equal(second.changed.length, 1, "reports the one system that changed hands");
  t.equal(second.changed[0].to.alliance, "Z", "naming who holds it now");
  t.equal(second.changed[0].from.alliance, "B", "and who held it before");
  t.equal(second.closed.length, 1, "and closes the one that stopped being returned");
  t.equal(second.closed[0].key, "3", "naming it");
  t.equal(openForSource(sov, "sov", 3, "public"), null, "which is no longer open");
  t.equal(historyOf(sov, "sov", 3).length, 1, "but is still on the record");

  // The unchanged majority must not grow the store. This is the property that
  // makes an hourly whole-map sync affordable at all.
  const before = sov.observations.length;
  syncAll(sov, "sov", [{ key: 1, value: { alliance: "A" } }, { key: 2, value: { alliance: "Z" } }],
    { source: "public", now: T(2) });
  t.equal(sov.observations.length, before, "a sync where nothing changed adds no rows");
  t.equal(openForSource(sov, "sov", 1, "public").lastConfirmed, T(2), "though everything present is re-confirmed");

  // Something returning after an absence opens a fresh window rather than
  // reviving the old one - it was genuinely gone in between.
  //
  // All three are passed, not just the returning one. A whole-endpoint sync
  // treats absence as information, so listing only key 3 here would correctly
  // close the other two - which is what the first version of this test did,
  // then asserted further down that key 1 was still open. The store was right
  // and the test was wrong.
  syncAll(sov, "sov", [
    { key: 1, value: { alliance: "A" } },
    { key: 2, value: { alliance: "Z" } },
    { key: 3, value: { alliance: "C" } },
  ], { source: "public", now: T(3) });
  t.equal(historyOf(sov, "sov", 3).length, 2, "a thing that comes back opens a new window");
  t.equal(historyOf(sov, "sov", 3)[0].closedAt, T(1), "the gap is preserved");

  // --- the diff view --------------------------------------------------------------------
  const changes = changesBetween(sov, "sov", T(0), T(3));
  t.check(changes.length >= 3, `${changes.length} events between two moments`);
  t.check(changes.every((event, i) => i === 0 || event.at >= changes[i - 1].at), "in order");
  t.check(changes.some(event => event.event === "closed"), "including things that went away");
  t.check(changes.some(event => event.event === "opened"), "and things that appeared");
  t.equal(changesBetween(sov, "sov", T(10), T(20)).length, 0, "a quiet window has no events");

  // --- provenance --------------------------------------------------------------------------
  // A source is whatever saw it, and sovereignty has no character behind it.
  const mixed = createSightings();
  observe(mixed, { kind: "bridge", key: "a-b", value: 1, source: "character:Pilot", now: T(0) });
  observe(mixed, { kind: "sov", key: 1, value: 2, source: "public:sovereignty", now: T(0) });
  t.equal(openForSource(mixed, "bridge", "a-b", "character:Pilot").source, "character:Pilot", "a character source is kept");
  t.equal(openForSource(mixed, "sov", 1, "public:sovereignty").source, "public:sovereignty", "and a public one, which has no character");
  t.equal(observe(createSightings(), { kind: "x", key: 1 }).source, "unknown",
    "an unattributed sighting says so rather than claiming a source");

  // --- one source cannot close another's sightings -------------------------------
  // A sync speaks for what its own source can see and for nothing else. One
  // pilot's structure pull says nothing about what another pilot can still
  // reach, and closing their sightings would write a retreat that never
  // happened into the permanent history.
  const twoPilots = createSightings();
  observe(twoPilots, { kind: "bridge", key: "alice-link", value: 1, source: "character:Alice", now: T(0) });
  observe(twoPilots, { kind: "bridge", key: "bob-link", value: 1, source: "character:Bob", now: T(0) });
  const aliceSync = syncAll(twoPilots, "bridge", [{ key: "alice-link", value: 1 }],
    { source: "character:Alice", now: T(1) });
  t.equal(aliceSync.closed.length, 0, "Alice syncing only her own bridge closes nothing of Bob's");
  t.check(openForSource(twoPilots, "bridge", "bob-link", "character:Bob") !== null, "and Bob's bridge is still open");

  // But a source does still close its own.
  observe(twoPilots, { kind: "bridge", key: "alice-gone", value: 1, source: "character:Alice", now: T(1) });
  const aliceAgain = syncAll(twoPilots, "bridge", [{ key: "alice-link", value: 1 }],
    { source: "character:Alice", now: T(2) });
  t.equal(aliceAgain.closed.length, 1, "while one Alice saw before and no longer does is closed");
  t.equal(aliceAgain.closed[0].key, "alice-gone", "hers, and only hers");

  // --- kinds do not collide -------------------------------------------------------------------
  const kinds = createSightings();
  observe(kinds, { kind: "sov", key: 7, value: "sovereign", now: T(0) });
  observe(kinds, { kind: "citadel", key: 7, value: "structure", now: T(0) });
  t.equal(openForSource(kinds, "sov", 7, "unknown").value, "sovereign", "the same key under two kinds stays separate");
  t.equal(openForSource(kinds, "citadel", 7, "unknown").value, "structure", "on both sides");
  t.equal(openObservations(kinds, "sov").length, 1, "and each kind can be listed alone");
  t.equal(openObservations(kinds).length, 2, "or all together");

  // --- persistence ---------------------------------------------------------------------------
  const reloaded = fromJSON(JSON.parse(JSON.stringify(toJSON(sov))));
  t.equal(reloaded.observations.length, sov.observations.length, "a saved store reloads whole");
  t.equal(openForSource(reloaded, "sov", 1, "public").value.alliance, "A", "with its open values");
  t.equal(historyOf(reloaded, "sov", 3).length, 2, "and its history, which is the part worth keeping");
  t.equal(fromJSON(null).observations.length, 0, "a missing file is an empty store");
  t.equal(fromJSON({ observations: [{ kind: "x" }] }).observations.length, 0,
    "and a row with no timestamp is dropped rather than loaded with an invented one");

  // --- the index and the scan must answer the same question ---------------------
  // A read that walks the whole log backwards on every call is O(n) per lookup with one
  // lookup per key per sync: a full sovereignty sync against a year of history measures
  // 25.7 seconds, during which the interface is simply gone. So the open case is
  // answered from an index, and the scan stays for a historical `at`, where the answer
  // genuinely depends on when you ask. The two must never disagree about the present, or
  // the index is a second source of truth.
  const perf = createSightings();
  let when = Date.parse("2026-01-01T00:00:00Z");
  for (let round = 0; round < 4; round += 1) {
    for (let key = 0; key < 200; key += 1) {
      // A third of them stop being reported, so the log carries closed windows
      // as well as open ones - a closed entry is the case an index gets wrong.
      if (key % 3 === round % 3) continue;
      observe(perf, { kind: "bench", key, value: { held: round }, source: "p", now: when });
    }
    syncAll(perf, "bench", [...Array(200).keys()]
      .filter(key => key % 3 !== round % 3)
      .map(key => ({ key, value: { held: round } })), { source: "p", now: when });
    when += 86_400_000;
  }
  let agreed = 0;
  let open = 0;
  let closedSeen = 0;
  for (let key = 0; key < 200; key += 1) {
    const indexed = openForSource(perf, "bench", key, "p");
    const scanned = openForSource(perf, "bench", key, "p", when + 1);
    if (indexed === scanned) agreed += 1;
    if (indexed) open += 1; else closedSeen += 1;
  }
  t.equal(agreed, 200, "the index and the scan return the identical entry for every key");
  t.check(open > 0, `with some keys open (${open})`);
  t.check(closedSeen > 0, `and some closed, which is the case an index gets wrong (${closedSeen})`);

  // A store restored from a save has no index, and must build one rather than
  // answering from a stale Map or throwing.
  const restored = fromJSON(JSON.parse(JSON.stringify(toJSON(perf))));
  let restoredAgreed = 0;
  for (let key = 0; key < 200; key += 1) {
    const here = openForSource(restored, "bench", key, "p");
    const there = openForSource(perf, "bench", key, "p");
    if ((here?.key ?? null) === (there?.key ?? null)
      && (here?.value?.held ?? null) === (there?.value?.held ?? null)) restoredAgreed += 1;
  }
  t.equal(restoredAgreed, 200, "and a store restored from a save answers the same as the one it came from");

  // The index is derived, never authoritative, and it has to prove that rather
  // than be trusted. A caller appending to the log directly - an older build, a
  // migration, a future feature - would otherwise be answered from a Map that
  // no longer describes it. Written as a test because the guard survived a
  // mutation that removed it: nothing in the codebase appends that way today,
  // so without this the check could not fail and was decoration.
  const appended = createSightings();
  observe(appended, { kind: "raw", key: "a", value: { v: 1 }, source: "p", now: 1000 });
  t.equal(openForSource(appended, "raw", "a", "p")?.value.v, 1, "an ordinary observation is found");
  appended.observations.push({
    id: "raw:a", kind: "raw", key: "a", value: { v: 2 }, source: "p",
    firstSeen: 2000, lastConfirmed: 2000, closedAt: null,
  });
  t.equal(openForSource(appended, "raw", "a", "p")?.value.v, 2,
    "and a log appended to behind the index's back is still read correctly");
  appended.observations.push({
    id: "raw:b", kind: "raw", key: "b", value: { v: 3 }, source: "p",
    firstSeen: 3000, lastConfirmed: 3000, closedAt: null,
  });
  t.equal(openForSource(appended, "raw", "b", "p")?.value.v, 3, "including a key the index had never seen");

  // --- two sources watching the same thing --------------------------------------
  // There is one source per kind today, so none of this is reachable yet - which
  // is exactly why it was wrong and nothing noticed. syncAll's closing half
  // refuses to close another source's sighting and says in a comment that this
  // is "what makes the multi-token layer safe to build on top". The opening half
  // did the opposite three lines above: `observe` asked `openAt`, which answers
  // across every source, and then wrote on whatever came back.
  //
  // Two pilots reporting the same bridge therefore produced one record belonging
  // to whichever spoke last, and a disagreement between them closed the first
  // pilot's window - a retreat that never happened, written into a log whose
  // whole purpose is that closures are permanent.
  const shared = createSightings();
  const ALICE = "token:alice";
  const BOB = "token:bob";
  const BRIDGE = "30000142-30000144";

  observe(shared, { kind: "bridge", key: BRIDGE, value: { up: true }, source: ALICE, now: 1000 });
  observe(shared, { kind: "bridge", key: BRIDGE, value: { up: true }, source: BOB, now: 2000 });

  const alice = openForSource(shared, "bridge", BRIDGE, ALICE);
  const bob = openForSource(shared, "bridge", BRIDGE, BOB);
  t.check(alice && bob, "both sources have their own open observation of the same bridge");
  t.check(alice !== bob, "and they are separate records, not one shared between them");
  t.equal(alice.firstSeen, 1000, "each keeps the moment its own source first saw it");
  t.equal(bob.firstSeen, 2000, "rather than inheriting the other's");
  t.equal(alice.closedAt, null, "and the second sighting did not close the first");

  // A disagreement is two views, not a change.
  observe(shared, { kind: "bridge", key: BRIDGE, value: { up: false }, source: BOB, now: 3000 });
  t.equal(openForSource(shared, "bridge", BRIDGE, ALICE).value.up, true,
    "one source reporting the bridge down does not alter what the other reported");
  t.equal(openForSource(shared, "bridge", BRIDGE, ALICE).closedAt, null,
    "nor close their window, which would record a retreat that never happened");
  t.equal(openForSource(shared, "bridge", BRIDGE, BOB).value.up, false, "while their own view is updated");

  // Both must survive a listing. Keying the list by thing alone dropped one of
  // them from every panel, count and route without closing it.
  const both = openObservations(shared, "bridge");
  t.equal(both.length, 2, "listing open observations returns both sources");
  t.equal(new Set(both.map(e => e.source)).size, 2, "and they are distinguishable by source");
  t.equal(openObservations(shared, "bridge", { source: ALICE }).length, 1,
    "and a listing can be narrowed to one source, which is what routing must use");
  t.equal(openObservations(shared, "bridge", { source: ALICE })[0].source, ALICE, "the right one");

  // A sync speaks only for its own source, on the way in as well as out.
  syncAll(shared, "bridge", [], { source: BOB, now: 4000 });
  t.equal(openForSource(shared, "bridge", BRIDGE, BOB), null, "a sync closes what its own source stopped reporting");
  t.check(openForSource(shared, "bridge", BRIDGE, ALICE), "and leaves the other source's sighting open");
  t.equal(openObservations(shared, "bridge").length, 1, "so one of the two remains");

  // A sync classifies against its own source's prior state, not against what
  // some other source happens to have open. A pilot seeing this bridge for the
  // first time has *opened* an observation, even though somebody else has been
  // watching it for hours - and read as "no change", their first sighting would
  // never be recorded as theirs at all.
  //
  // Its own store, and the other source's record has to be the newest *open*
  // entry in the log for this to discriminate: an unfiltered lookup walks
  // backwards and stops at the first matching id, so a closed entry sitting
  // later in the log masks the difference and the case proves nothing.
  const firstSight = createSightings();
  observe(firstSight, { kind: "bridge", key: BRIDGE, value: { up: true }, source: ALICE, now: 1000 });
  t.equal(openForSource(firstSight, "bridge", BRIDGE, ALICE)?.source, ALICE,
    "the other source's open record is the newest entry, so an unfiltered lookup would find it");

  const CARL = "token:carl";
  const carlFirst = syncAll(firstSight, "bridge", [{ key: BRIDGE, value: { up: true } }],
    { source: CARL, now: 2000 });
  t.equal(carlFirst.opened.length, 1,
    "a source seeing a watched object for the first time has opened one, whatever anyone else can see");
  t.equal(carlFirst.changed.length, 0, "and changed nothing, because it had nothing before");
  t.equal(openForSource(firstSight, "bridge", BRIDGE, CARL).firstSeen, 2000,
    "stamped when this source first saw it, not when the object was first seen by anyone");
  t.equal(openForSource(firstSight, "bridge", BRIDGE, ALICE).firstSeen, 1000,
    "and the other source keeps its own first sighting");

  // And a genuine change for that source is a change, not an open.
  const carlAgain = syncAll(firstSight, "bridge", [{ key: BRIDGE, value: { up: false } }],
    { source: CARL, now: 3000 });
  t.equal(carlAgain.opened.length, 0, "the same source reporting again has opened nothing");
  t.equal(carlAgain.changed.length, 1, "and its own disagreement is a change");

  // And it survives a save, or a reload merges them back together.
  const sourcesRoundTrip = fromJSON(JSON.parse(JSON.stringify(toJSON(shared))));
  t.check(openForSource(sourcesRoundTrip, "bridge", BRIDGE, ALICE), "a restored store keeps the surviving source's view");
  t.equal(openForSource(sourcesRoundTrip, "bridge", BRIDGE, BOB), null, "and the closed one stays closed");

  // --- the edges of a validity window ---------------------------------------------
  //
  // A window is [firstSeen, closedAt): open at the instant it was first seen,
  // and already closed at the instant it was closed. Both ends were written
  // that way and neither was asserted, so a mutation at either boundary went
  // unnoticed - on the lookup that answers "what did we believe at this time",
  // which is the question the whole dated-sighting law exists to make
  // answerable.
  const edge = createSightings();
  const born = 1_000_000;
  const died = 2_000_000;
  syncAll(edge, "sovereignty", [{ key: 30000142, value: { alliance_id: 1 } }],
    { source: "public:sovereignty-map", now: born });
  syncAll(edge, "sovereignty", [], { source: "public:sovereignty-map", now: died });

  const at = when => openForSource(edge, "sovereignty", 30000142, "public:sovereignty-map", when);
  t.check(!at(born - 1), "before it was first seen, nothing was open");
  t.check(at(born), "at the instant it was first seen, it was open");
  t.check(at(died - 1), "and it stays open right up to the moment it closes");
  t.check(!at(died), "at the instant it closed, it was no longer open");
  t.check(!at(died + 1), "and it stays closed afterwards");

  // --- the edges of a change window ------------------------------------------------
  //
  // `changesBetween` answers "what happened between these two instants", and
  // both of its comparisons survived a mutation sweep. The window is
  // (from, to] - a change exactly at `from` belongs to the previous window and
  // one exactly at `to` belongs to this one - which is the only way consecutive
  // windows tile without double-counting or dropping an event. Neither edge was
  // asserted, so either could have been flipped and every caller would have
  // quietly lost or repeated a change at a boundary.
  const windowed = createSightings();
  const t0 = 1_000_000;
  syncAll(windowed, "sovereignty", [{ key: 1, value: { a: 1 } }], { source: "p", now: t0 });
  syncAll(windowed, "sovereignty", [], { source: "p", now: t0 + 1000 });

  const between = (from, to) => changesBetween(windowed, "sovereignty", from, to).map(c => c.event);
  t.equal(between(t0 - 1, t0).join(), "opened", "a change exactly at the end of a window is in it");
  t.equal(between(t0, t0 + 999).join(), "", "and exactly at the start belongs to the window before");
  t.equal(between(t0, t0 + 1000).join(), "closed", "so consecutive windows tile without repeating it");
  t.equal(between(t0 - 1, t0 + 1000).sort().join(), "closed,opened",
    "and a window spanning both sees both");

  return t.results;
}
