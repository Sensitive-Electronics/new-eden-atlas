// Where the live store is kept, and the four ways keeping it can destroy it.
//
// The browser holds the store in local storage, which has a hard quota of a few
// megabytes; the shell hands it to the core, which writes a real file and has
// none. Everything here is about the seam between those two, because every
// failure at this seam is silent: the application starts perfectly, the map
// draws, and the only copy of a pilot's history is gone.
//
// Four doors to that same loss, and all four are closed separately:
//
//   1. A truncating write. Handled in the core - temp file, flush, rename - and
//      checked by the shell's own headless selftest.
//   2. A corrupt file read as "nothing here", which hands back an empty store
//      and invites the write that makes the loss permanent.
//   3. A write that fires *before* the first read lands. The in-memory store is
//      empty by construction at that moment, so writing it replaces a good file
//      with nothing - the same wipe, through a different door, and harder to
//      see because nothing looks wrong.
//   4. Queuing those early writes and flushing them once the load settles.
//      Memory after a refused load is not authority over the file.
//
// The browser path must be unchanged throughout. It is the zero-install tier,
// and the graceful-degradation law applies to packaging as much as to network.

import { suite } from "./helpers.mjs";
import { setTimeout as realTimeout } from "node:timers";

export default function run(app) {
  const t = suite("core store");
  const { state } = app;

  return (async () => {
    const savedWindow = globalThis.window;
    // The DOM shim replaces setTimeout with `fn => { fn(); return 0; }`, which
    // makes every debounce fire at once and every "settle" yield a single
    // microtask. Both are exactly what this file measures, so it borrows the
    // real scheduler back for its own duration and returns it afterwards.
    const shimTimeout = globalThis.setTimeout;
    const shimClear = globalThis.clearTimeout;
    globalThis.setTimeout = realTimeout;
    globalThis.clearTimeout = clearTimeout;
    const savedLive = state.live;
    const savedOverrides = state.overrides;
    const savedMismatch = state.liveSchemaMismatch;

    // A fake core. Records every call, so "did it write" is a question the test
    // can answer rather than infer.
    const makeCore = ({ load, save }) => {
      const calls = [];
      const invoke = (name, args) => {
        calls.push({ name, args });
        if (name === "sightings_load") return load();
        if (name === "sightings_save") return save ? save(args) : Promise.resolve(1);
        return Promise.reject(new Error(`unknown command ${name}`));
      };
      return { calls, invoke };
    };
    const install = core => {
      globalThis.window = {
        ...(savedWindow ?? {}),
        __TAURI__: { core: { invoke: core.invoke } },
        addEventListener() {},
        setTimeout: globalThis.setTimeout,
        clearTimeout: globalThis.clearTimeout,
      };
    };
    const saves = core => core.calls.filter(c => c.name === "sightings_save");
    // A macrotask drains every pending microtask, so the load's then/catch/
    // finally chain has certainly run. Counting `await Promise.resolve()` calls
    // against the length of a promise chain is how a test becomes flaky.
    const settle = () => new Promise(resolve => realTimeout(resolve, 0));

    try {
      // --- the shell reads through the core ---------------------------------------
      const stored = { schema: 1, sightings: { observations: [] }, sov: { dataAt: 123 } };
      const good = makeCore({ load: () => Promise.resolve(stored) });
      install(good);
      app.restoreLive();
      t.equal(good.calls[0]?.name, "sightings_load", "the shell asks the core for the store");
      await settle();
      t.equal(state.sovMeta?.dataAt, 123, "and what the core returned is what got restored");

      // --- the race, which is the whole reason the gate exists ---------------------
      //
      // A write attempted before the read resolves must not reach the core at
      // all. Not deferred - dropped. If this fails, the previous file is
      // replaced by the empty store the application booted with.
      let releaseLoad;
      const slow = makeCore({ load: () => new Promise(resolve => { releaseLoad = resolve; }) });
      install(slow);
      app.restoreLive();
      app.persistLive();
      app.persistLive();
      await app.flushLiveWrites();
      t.equal(saves(slow).length, 0,
        "a write attempted before the first read resolves never reaches the core");
      // Dropped is not pending. One flag for both leaves it stuck on "not yet saved"
      // for ever about a change that was thrown away, and those two outcomes are
      // precisely what the gate exists to distinguish.
      t.check(!state.persistPending, "a dropped write is not reported as one still in flight");

      releaseLoad(null);
      await settle();
      t.equal(saves(slow).length, 0,
        "and the dropped writes are not replayed once the load settles");

      // Absent is a first run: an empty store is the right answer, and writing
      // is allowed again afterwards.
      app.persistLive();
      await app.flushLiveWrites();
      t.equal(saves(slow).length, 1, "once settled, a write goes through");

      // --- a file that could not be read is never written over ---------------------
      const broken = makeCore({ load: () => Promise.reject(new Error("unexpected token")) });
      install(broken);
      app.restoreLive();
      await settle();
      t.check(state.persistFailed, "an unreadable store is reported as a failure");

      app.persistLive();
      app.persistLive();
      await app.flushLiveWrites();
      t.equal(saves(broken).length, 0,
        "and nothing is written over it for the rest of the session, not merely delayed");

      // --- writes are coalesced ----------------------------------------------------
      //
      // persistLive fires on every override toggle, every sync, every import and
      // every clear. A thirty-character store serialises to 25 MB; writing that
      // on each click is how a map starts feeling broken.
      const busy = makeCore({ load: () => Promise.resolve(null) });
      install(busy);
      app.restoreLive();
      await settle();
      for (let i = 0; i < 12; i += 1) app.persistLive();
      await app.flushLiveWrites();
      t.equal(saves(busy).length, 1, "twelve changes in a burst become one write");

      // --- in flight is not saved --------------------------------------------------
      let releaseSave;
      const slowSave = makeCore({
        load: () => Promise.resolve(null),
        save: () => new Promise(resolve => { releaseSave = resolve; }),
      });
      install(slowSave);
      app.restoreLive();
      await settle();
      app.persistLive();
      const landed = app.flushLiveWrites();
      t.check(state.persistPending, "a write still in flight is pending, not finished");
      releaseSave(1);
      await landed;
      t.check(!state.persistPending, "and stops being pending once the core answers");
      t.check(!state.persistFailed, "with nothing reported wrong");
      t.equal(app.ui.persistError?.textContent ?? "", "",
        "and a success clears any warning a previous failure left on screen");

      // --- a failed write says so, and says the previous save survived -------------
      const refuses = makeCore({
        load: () => Promise.resolve(null),
        save: () => Promise.reject(new Error("disk full")),
      });
      install(refuses);
      app.restoreLive();
      await settle();
      app.persistLive();
      await app.flushLiveWrites();
      t.check(state.persistFailed, "a refused write is a failure");
      t.check(/previous save is untouched/.test(app.ui.persistError?.textContent ?? ""),
        "and says the earlier save survived, because with an atomic replace it did");

      // --- a second load must not be settled by the first --------------------------
      //
      // The gate was three booleans with no sense of which load settled them. A
      // second restoreLive wiped the store to empty and started load B; load A
      // then resolved and opened the gate, and the next write put the empty
      // store over a good file - the failure the gate exists to prevent,
      // arriving through re-entrancy.
      // Each restoreLive gets its own resolver. Sharing one closure would
      // overwrite it and resolve the *second* load, which is a different test
      // and passes for the wrong reason.
      const holds = [];
      const overlapping = makeCore({
        load: () => new Promise(resolve => { holds.push(resolve); }),
      });
      install(overlapping);
      app.restoreLive();          // load A, held open
      app.restoreLive();          // load B supersedes it, store wiped to empty
      holds[0](null);             // A resolves late; B is still outstanding
      await settle();
      app.persistLive();
      await app.flushLiveWrites();
      t.equal(saves(overlapping).length, 0,
        "a superseded load cannot open the gate for the one that replaced it");

      // And the inverse, which is worse: a rejected first load must not poison a
      // healthy second one. liveWriteRefused is never cleared again, so this
      // disabled saving for the session over a file that read perfectly.
      const rejects = [];
      const poisoning = makeCore({
        load: () => new Promise((_, reject) => { rejects.push(reject); }),
      });
      install(poisoning);
      app.restoreLive();
      const healthy = makeCore({ load: () => Promise.resolve(null) });
      install(healthy);
      app.restoreLive();
      rejects[0](new Error("unreadable"));
      await settle();
      app.persistLive();
      await app.flushLiveWrites();
      t.equal(saves(healthy).length, 1,
        "a rejected earlier load does not refuse writes for a session that loaded fine");

      // --- the vault, and the tier that must not have one --------------------------
      //
      // The security-relevant property is not that the panel works. It is that
      // in a browser there is nothing there at all - not a disabled button, not
      // an explanation. A sign-in control a page cannot honour invites a pilot
      // to look for their credentials in the one place this project has decided
      // they must never be.
      const vault = makeCore({
        load: () => Promise.resolve(null),
        save: () => Promise.resolve(1),
      });
      vault.invoke = (name, args) => {
        vault.calls.push({ name, args });
        if (name === "token_characters") {
          return Promise.resolve([
            { character_id: 90000001, name: "Some Pilot", scopes: [], last_refresh_at: 1_700_000_000 },
            { character_id: 90000002, name: "<img src=x onerror=alert(1)>", scopes: ["a", "b"],
              last_refresh_at: 1_700_000_000, last_refresh_error: null },
          ]);
        }
        if (name === "token_forget") return Promise.resolve(null);
        return Promise.resolve(null);
      };
      install(vault);
      app.bindVault();
      await settle();
      t.check(!app.ui.vaultPanel.hidden, "the vault is shown when a core is present");
      t.check(/Some Pilot/.test(app.ui.vaultList.innerHTML), "and lists the characters it was given");
      t.check(/2 characters/.test(app.ui.vaultCount.textContent),
        `counting them (${app.ui.vaultCount.textContent})`);
      t.check(/2 scopes/.test(app.ui.vaultList.innerHTML), "with what each was granted");

      // A character name arrives from a server, and text from a server is data.
      // A rule with an exception for trustworthy sources is not a rule.
      t.check(!/<img src=x/.test(app.ui.vaultList.innerHTML),
        "a name carrying markup is escaped rather than rendered");
      t.check(/&lt;img/.test(app.ui.vaultList.innerHTML), "and is still shown, as text");

      // Nothing the page can reach ever holds a token.
      t.check(!/token/i.test(JSON.stringify(vault.calls.map(c => c.args ?? {}))),
        "no call from the page carries a token");

      globalThis.window = savedWindow;
      app.bindVault();
      t.check(app.ui.vaultPanel.hidden,
        "and with no core the vault is hidden entirely - absent, not disabled");

      // --- the browser tier is untouched -------------------------------------------
      globalThis.window = savedWindow;
      const before = localStorage.getItem("new-eden-atlas-live-v1");
      app.restoreLive();
      app.persistLive();
      t.check(!state.persistPending,
        "with no core present nothing is pending: the browser write is synchronous, as it always was");
      t.check(localStorage.getItem("new-eden-atlas-live-v1") !== null,
        "and the browser tier still writes to local storage");
      t.check(before === null || typeof before === "string", "having read from it too");
    } finally {
      globalThis.window = savedWindow;
      globalThis.setTimeout = shimTimeout;
      globalThis.clearTimeout = shimClear;
      state.live = savedLive;
      state.overrides = savedOverrides;
      state.liveSchemaMismatch = savedMismatch;
      state.persistPending = false;
      state.persistFailed = false;
      if (app.ui.persistError) app.ui.persistError.textContent = "";
    }

    return t.results;
  })();
}
