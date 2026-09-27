// What a failed sync leaves on a layer's meta.
//
// `sourceState` in `snapshot.js` has asked `meta.failed === true` since it was
// written, and for as long as it did nothing set it: every layer's failure
// path rendered an error string and returned, so a layer that had just 503'd
// reported synced with an honest age and an invisible failure.
//
// These tests exist because the producers were unreachable. `markSyncFailed`
// and `clearSyncFailure` were closed over inside `app.js`, exercised only by a
// sync that fails, which nothing drove - so the mark could have been wrong in
// either direction and the suite would have stayed green. They live in
// `esi.js` now, where a test can call them.

import { suite } from "./helpers.mjs";
import { markSyncFailed, clearSyncFailure } from "../web/esi.js";
import { sourceState, buildSnapshot, project } from "../web/snapshot.js";

export default function run() {
  const t = suite("sync mark");

  // --- marking ---------------------------------------------------------------
  const fresh = markSyncFailed(null, undefined, 500);
  t.equal(fresh.failed, true, "a layer with no meta at all can still be marked");
  t.equal(fresh.failedAt, 500, "with the instant it failed");
  t.equal(fresh.failedReason, "unknown", "and a reason, even when none was given");
  t.check(!("dataAt" in fresh), "and no invented age, because nothing was ever measured");

  const known = { etag: "W/\"x\"", expiresAt: 900, dataAt: 100, fetchedAt: 200 };
  const marked = markSyncFailed(known, "http", 500);
  t.equal(marked.dataAt, 100, "an existing age survives the mark");
  t.equal(marked.etag, "W/\"x\"", "and the etag");
  t.equal(marked.expiresAt, 900, "and the expiry");
  t.equal(marked.fetchedAt, 200, "and when it was last fetched");
  t.equal(marked.failedReason, "http", "with the reason the sync gave");
  t.check(known.failed === undefined, "and the meta it was given is not mutated");

  // "The last reading is an hour old and the last attempt failed" is two
  // facts. Dropping the age would turn a stale-but-real reading into no
  // reading at all, which is the other half of the same error.
  t.check(Number.isFinite(marked.dataAt) && marked.failed === true,
    "both facts are carried at once, because both matter");

  // --- clearing --------------------------------------------------------------
  const cleared = clearSyncFailure(marked);
  t.check(!("failed" in cleared), "a recovery removes the mark");
  t.check(!("failedAt" in cleared), "and when it happened");
  t.check(!("failedReason" in cleared), "and why");
  t.equal(cleared.dataAt, 100, "while keeping everything that was measured");
  t.equal(cleared.etag, "W/\"x\"", "including the etag");
  t.equal(Object.keys(clearSyncFailure(null)).length, 0, "and nothing to clear is an empty meta");
  t.equal(Object.keys(clearSyncFailure(undefined)).length, 0, "as is no meta at all");
  t.check(marked.failed === true, "clearing does not mutate what it was given");

  // --- what the consumer makes of it ----------------------------------------
  t.equal(sourceState(marked, 5), "absent",
    "a marked layer is absent however many rows it is holding");
  t.equal(sourceState(cleared, 5), "synced", "and synced again once it recovers");
  t.equal(sourceState(cleared, 0), "empty", "or empty, if that is what it found");

  // The age still crosses. A failed layer is not an unknown one - it is a
  // layer whose last real reading has an age, and whose last attempt failed.
  const carried = project(buildSnapshot({
    now: 1_000_000,
    live: [{
      name: "sovereignty", resolutionMs: 3_600_000, count: 1, rows: [{ systemId: 1 }],
      meta: markSyncFailed({ dataAt: 900_000, fetchedAt: 900_000 }, "http", 1_000_000),
    }],
  }));
  t.equal(carried.sources[0].state, "absent", "the projection reports it absent");
  t.equal(carried.sources[0].ageMs, 100_000, "and still carries the age of the last real reading");

  // --- the reason does not cross --------------------------------------------
  //
  // It is a diagnostic for a pilot, not a fact about the map, and it is a
  // string this module did not author - `outcome.result.reason` comes from
  // whatever the fetch reported.
  const wire = JSON.stringify(carried);
  t.check(!wire.includes("failedReason"), "the reason is not a field the projection copies");
  t.check(!wire.includes("http"), "nor its value");
  t.check(!wire.includes("failedAt"), "nor when it happened");

  // --- a mark survives a save ------------------------------------------------
  //
  // The failure paths persist now. Without that the stored meta kept its
  // `dataAt` and lost `failed`, so the next launch read a layer that had not
  // been refreshed since as synced - the mark lasting exactly until the tab
  // closed.
  const roundTripped = JSON.parse(JSON.stringify(marked));
  t.equal(roundTripped.failed, true, "the mark is plain data and survives a save");
  t.equal(roundTripped.failedReason, "http", "with its reason");
  t.equal(sourceState(roundTripped, 5), "absent", "and still reads absent after a reload");

  return t.results;
}
