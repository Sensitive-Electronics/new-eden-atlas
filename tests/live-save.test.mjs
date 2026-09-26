// Reading a saved live store, and drawing it, are different failures.
//
// They were one function and one `try`, whose comment said a throw was "a
// rendering fault, not damage to the store". That was true of the drawing half.
// The reading half ran first, and `activityFromJSON` throws on a saved
// `activitySeries` whose `history` is not iterable - so the assignment that
// loads the avoidance list, one line below, was never reached.
//
// `state.overrides` stayed `null`, `liveWriteRefused` had been cleared two
// lines earlier so the write gate was open, and `overridesToJSON(null)` returns
// `{version:1,entries:[]}` - byte-identical to an empty store. The next
// `persistLive()` wrote that over the pilot's real avoid list. Permanently, on
// startup, with `persistError` empty and the only message on screen saying
// something "could not be displayed".
//
// This file holds the distinction: a throw while **reading** is damage and
// refuses writes for the session; a throw while **drawing** changes nothing
// about the store and saving continues.

import { suite } from "./helpers.mjs";

const LIVE_KEY = "new-eden-atlas-live-v1";

// A save carrying a real avoid list and one malformed field. The avoid entry is
// the thing under test: it has to still be there afterwards, and it has to
// still be on disk.
function savedStore({ breakActivity }) {
  return {
    schema: 1,
    sightings: { version: 1, observations: [] },
    overrides: {
      version: 1,
      entries: [{
        target: "system", key: "30000142", state: "ignored",
        reason: "camped", firstSeen: 1000, expiresAt: null,
      }],
    },
    // `history` is required to be iterable. A number is what a truncated or
    // half-written save produces, and it is the shape that throws.
    activitySeries: breakActivity ? { history: 5 } : null,
  };
}

export default function run(app) {
  const t = suite("live save");
  const { state, ui } = app;

  const saved = {
    live: state.live, overrides: state.overrides, activity: state.activity,
    persistFailed: state.persistFailed,
  };
  const read = () => { try { return localStorage.getItem(LIVE_KEY); } catch { return null; } };
  const write = (value) => { try { localStorage.setItem(LIVE_KEY, JSON.stringify(value)); } catch { /* nothing to assert */ } };

  try {
    // --- reading is where the damage is ---------------------------------------
    {
      const good = savedStore({ breakActivity: false });
      const parsed = app.readLiveSave(good);
      t.equal(parsed.overrides.entries.size, 1, "a good save reads its avoid list");
      t.check(Boolean(parsed.live), "and its sightings");
      t.equal(parsed.activity === null || typeof parsed.activity === "object", true, "and its series");
    }

    // The malformed one throws, and throws before anything is assigned.
    {
      // **Every field it touches.** "Reading does not touch state" is the property;
      // checking one field proves a fraction of it, and a mutation assigning
      // `state.activity` on the way through passes that weaker form.
      const FIELDS = ["live", "activity", "overrides", "sovMeta", "ambientMeta",
        "activityMeta", "campaignMeta", "scoutMeta"];
      const before = Object.fromEntries(FIELDS.map((name) => [name, state[name]]));
      t.throws(() => app.readLiveSave(savedStore({ breakActivity: true })), "",
        "a save whose series cannot be read throws rather than returning half of one");
      const moved = FIELDS.filter((name) => state[name] !== before[name]);
      t.equal(moved.length, 0,
        `and assigns nothing on the way out${moved.length ? `: ${moved.join(", ")} moved` : ""}`);
    }

    // --- the whole path, through the real restore -----------------------------
    //
    // The avoid list must survive, and - the part that made this permanent -
    // the save on disk must not be replaced by an empty one.
    {
      write(savedStore({ breakActivity: true }));
      const bytes = read();
      state.persistFailed = false;
      if (ui.persistError) ui.persistError.textContent = "";

      app.restoreLive();

      t.check(!app.liveSyncAllowed || true, "restore completed without throwing");
      t.equal(read(), bytes, "the unreadable save is left byte-identical on disk");

      // The gate is the thing that keeps it that way. `persistLive` is the only
      // writer of this key, and a refused load must close it for the session.
      app.persistLive();
      t.equal(read(), bytes, "and a later write does not replace it either");

      t.check(Boolean(ui.persistError?.textContent),
        `the pilot is told it was left alone (${(ui.persistError?.textContent ?? "").slice(0, 60)})`);
      t.check(/could not be read/.test(ui.persistError?.textContent ?? ""),
        "in the vocabulary this file uses for damage, not for a panel that failed to draw");
    }

    // --- a good save still loads, and still saves -----------------------------
    {
      write(savedStore({ breakActivity: false }));
      app.restoreLive();
      t.equal(state.overrides?.entries?.size ?? 0, 1, "a good save loads its avoid list into state");
      const grown = read();
      app.persistLive();
      t.check(read() !== null, "and writing is allowed again");
      t.check(grown !== null, "the store was on disk to begin with");
    }
  } finally {
    try { localStorage.removeItem(LIVE_KEY); } catch { /* nothing to restore */ }
    state.live = saved.live;
    state.overrides = saved.overrides;
    state.activity = saved.activity;
    state.persistFailed = saved.persistFailed;
    if (ui.persistError) ui.persistError.textContent = "";
    if (ui.liveError) ui.liveError.textContent = "";
  }

  return t.results;
}
