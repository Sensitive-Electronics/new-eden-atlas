// The Characters panel, and the two things about it that are not cosmetic.
//
// A portrait is decoration. The row is not. Everything here exists because a
// decoration that fails must cost nothing: no missing name, no missing Forget
// button, no error where a picture would be. The happy path - a portrait that
// downloads and appears - is deliberately not tested, because it is the one
// outcome that cannot hurt anybody.
//
// The other half of "forget" lives in the shell's own checks, where the
// credential store and the portrait cache actually are. This file covers what
// the page is responsible for: rendering a row that stands on its own, and
// asking the core for a picture without making the row wait for one.

import { suite } from "./helpers.mjs";

const ROW = (over = {}) => ({
  character_id: 92485149,
  name: "Scarecrow Paul",
  scopes: ["publicData"],
  added_at: 1789962385,
  last_refresh_at: 1789962385,
  last_refresh_error: null,
  ...over,
});

export default function run(app) {
  const t = suite("vault");
  const { ui, renderVault } = app;

  // --- a row does not depend on its picture -------------------------------
  //
  // Nothing in this file lets a portrait load: there is no core to answer, so
  // `fillPortraits` returns immediately and every `img` keeps its empty src.
  // That is the offline case, the no-such-character case and the CDN-is-down
  // case all at once, and the row has to be complete in all of them.
  renderVault([ROW()]);
  const html = ui.vaultList.innerHTML;

  t.check(html.includes("Scarecrow Paul"), "the character's name is rendered with no portrait available");
  t.check(html.includes("data-forget=\"92485149\""), "and the Forget button, so a character is never unremovable");
  t.check(html.includes("1 scope"), "and what it can do");

  // The sentence a pilot reads, not the pieces it is built from.
  //
  // Every assertion here checked a fragment, and the row rendered
  // "1 scope - added synced 20m ago": `describeAge` supplies its own verb and
  // the caller prefixed another. This file's own comment records the previous
  // occurrence as "Synced synced just now". Fragments cannot see it; only
  // reading the finished line can.
  t.check(!/added synced|synced added|never never/.test(html),
    "the age reads as one phrase rather than two verbs stacked");
  t.check(/added \d+[mhd] ago|added just now/.test(html),
    `the row says when the character was added (${(html.match(/·[^<]*/) ?? [""])[0].trim()})`);
  t.check(!/synced/.test(html),
    "and never says synced, because nothing has ever refreshed this token");
  t.check(!html.includes("undefined") && !html.includes("NaN"),
    "no placeholder leaks into the row when a field is missing");

  // The frame is present and reserved even while empty, so the list does not
  // jump under the cursor when pictures arrive after it.
  t.check(html.includes("vault-portrait"), "a portrait frame is in the row from the first render");
  t.check(html.includes('width="64"') && html.includes('height="64"'),
    "with its size fixed, so an arriving picture cannot reflow the list");

  // --- the row survives a character the core describes badly ---------------
  renderVault([ROW({ name: undefined, scopes: [], last_refresh_at: 0 })]);
  const sparse = ui.vaultList.innerHTML;
  t.check(sparse.includes("Unnamed"), "a character with no name still has a row");
  t.check(sparse.includes("no scopes"), "and says it has no scopes rather than showing nothing");
  t.check(!sparse.includes("1970"), "a zero timestamp is never rendered as 1970");
  t.check(sparse.includes("unknown time"), "it says the time is unknown instead of inventing one");

  // --- escaping, because a name is text from a server ----------------------
  //
  // CCP supply these rather than players, and they are escaped anyway: a rule
  // with an exception for trustworthy sources is not a rule.
  renderVault([ROW({ name: '<img src=x onerror=alert(1)>' })]);
  const hostile = ui.vaultList.innerHTML;
  t.check(!hostile.includes("<img src=x"), "a name is escaped rather than parsed as markup");
  t.check(hostile.includes("&lt;img"), "and survives as text");

  // --- forgetting a character is never one click ---------------------------
  //
  // It deletes a credential from the operating system and cannot be undone from
  // inside the application, so the guard matters more than the feature.
  //
  // The case that motivates most of this. Written `if (ask && !ask(...))`, a missing
  // `window.confirm` makes the whole condition false and the removal goes ahead
  // unasked - and a guard that opens when its own mechanism is absent is not a guard.
  // The mechanism is a webview feature rather than anything this code controls.
  {
    const savedWindow = globalThis.window;
    const calls = [];
    // A core that records what it was asked to do, so "did it delete?" is a
    // fact rather than an inference. It hangs off `window`, because that is
    // where `coreStore()` looks for it.
    const core = { core: { invoke: (name, args) => { calls.push([name, args]); return Promise.resolve(null); } } };

    const withConfirm = answer => {
      globalThis.window = {
        ...(savedWindow ?? {}),
        __TAURI__: core,
        confirm: message => { calls.push(["confirm", message]); return answer; },
      };
    };

    withConfirm(true);
    renderVault([ROW()]);
    const button = ui.vaultList.querySelector("[data-forget]");
    t.check(!!button, "the row has a Forget button to press");

    // Declined.
    calls.length = 0;
    withConfirm(false);
    button.onclick();
    t.equal(calls.filter(c => c[0] === "token_forget").length, 0,
      "saying no to the confirmation removes nothing");
    t.equal(calls.filter(c => c[0] === "confirm").length, 1, "and it did ask");

    // What the question says. A count alone is not informed consent and neither
    // is "this character" - it has to name who, and what goes with them.
    const asked = String(calls.find(c => c[0] === "confirm")?.[1] ?? "");
    t.check(asked.includes("Scarecrow Paul"), "the question names the character being removed");
    t.check(/credential store/i.test(asked), "and says the credential is deleted from this computer");
    t.check(/portrait/i.test(asked), "and that the cached portrait goes too");
    t.check(/undo|back/i.test(asked), "and that it cannot be undone from here");

    // Accepted.
    calls.length = 0;
    withConfirm(true);
    button.onclick();
    const forgot = calls.find(c => c[0] === "token_forget");
    t.check(!!forgot, "saying yes removes the character");
    t.equal(forgot?.[1]?.characterId, 92485149, "and removes the one whose button was pressed");

    // No way to ask. This must refuse, not proceed.
    calls.length = 0;
    globalThis.window = { ...(savedWindow ?? {}), __TAURI__: core };
    delete globalThis.window.confirm;
    button.onclick();
    t.equal(calls.filter(c => c[0] === "token_forget").length, 0,
      "with no way to confirm, nothing is removed - the guard fails closed");
    t.check(/not removed/i.test(ui.vaultError.textContent),
      "and the panel says why, rather than leaving a button that seems dead");

    globalThis.window = savedWindow;
    ui.vaultError.textContent = "";
  }

  // --- an empty vault is an empty vault ------------------------------------
  renderVault([]);
  t.check(ui.vaultCount.textContent.includes("No characters"), "no characters reads as no characters");
  t.equal(ui.vaultList.innerHTML, "", "and leaves no stale rows behind");

  // --- the contract is on the live path, not beside it ---------------------
  //
  // `contract.js` declared the vocabulary while the application invoked Tauri
  // commands directly, so there were two of them. `payloadFault` - which
  // encodes the routing law that an op taking a characterId takes exactly one -
  // ran only in `contract.test.mjs`. A union request was called "unsayable"
  // while every caller in the application could say one and only find out at
  // the far end.
  //
  // These drive `callCore`, which is the door the application uses.
  {
    const savedWindow = globalThis.window;
    const sent = [];
    const core = { core: { invoke: (name, args) => { sent.push([name, args]); return Promise.resolve(null); } } };
    globalThis.window = { ...(savedWindow ?? {}), __TAURI__: core };

    const { callCore } = app;
    const settled = async promise => {
      try { return { ok: true, value: await promise }; }
      catch (error) { return { ok: false, error: String(error) }; }
    };

    return (async () => {
      // Let anything the earlier blocks left in flight land first. The
      // confirmation test presses a button whose promise chain ends in
      // `refreshVault`, and that resolves on a later microtask - against
      // whichever core is installed by then, which would be this one.
      // Drained until it stops moving, rather than by counting ticks.
      //
      // This awaited two microtasks, which coupled it to how many `.then` hops
      // the call path happened to have - and it broke the moment `callCore`
      // grew one, letting an earlier block's `refreshVault` land in the middle
      // of this one and record a `token_characters` nobody here asked for. A
      // test that counts someone else's ticks is a test that fails for a
      // reason that has nothing to do with what it is checking.
      // Unconditionally, not until-quiet: an until-quiet loop breaks on its
      // first turn, because nothing has landed *yet*. The chain being waited
      // for starts in an earlier block and arrives several turns later.
      for (let turn = 0; turn < 8; turn += 1) {
        await new Promise((resolve) => { setTimeout(resolve, 0); });
      }
      sent.length = 0;

      // THE ONE THAT MATTERS. Two characters in one request, refused before it
      // is sent, in the application rather than in a unit test.
      const union = await settled(callCore("token.forget", { characterId: [1, 2] }));
      t.check(!union.ok, "a request for two characters at once is refused on the live path");
      t.check(/single character/i.test(union.error ?? ""), "and refused by the routing law, naming it");
      t.equal(sent.length, 0, "and nothing reached the core");

      // The same door, other shapes.
      t.check(!(await settled(callCore("token.forget", {}))).ok,
        "a request missing its characterId is refused");
      t.check(!(await settled(callCore("token.forget", { characterId: "1586929189" }))).ok,
        "and a characterId that is a string rather than a number");
      t.check(!(await settled(callCore("token.forget", { characterId: 1.5 }))).ok,
        "and one that is not a whole character");
      t.equal(sent.length, 0, "none of which reached the core either");

      // An op nobody declared cannot be sent at all.
      const unknown = await settled(callCore("token.obliterate", { characterId: 1 }));
      t.check(!unknown.ok, "an op that is not in the contract cannot be sent");
      t.check(/unknown op/i.test(unknown.error ?? ""), "and says so");

      // Declared and dark. A refusal, never a stub that reads as an answer:
      // `null` would be indistinguishable from "there is nothing there", about
      // a request that was never made.
      for (const dark of ["esi.get"]) {
        const outcome = await settled(callCore(dark, { route: "/characters/1/", characterId: 1 }));
        t.check(!outcome.ok, `${dark} is specified but refused rather than answered`);
        t.check(/not implemented/i.test(outcome.error ?? ""), `${dark} says it is not implemented`);
      }
      t.equal(sent.length, 0, "and no dark op reached the core");

      // `advisor.consider` left the dark list at step 6. It is not routed to a
      // typed command either - it is carried to the advisor - so this door
      // refuses it and says which door it wanted, rather than reporting it as
      // an op that goes nowhere. The two failures look identical to a caller
      // and take very different amounts of time to diagnose.
      for (const carried of ["advisor.consider", "advisor.ask"]) {
        const payload = carried === "advisor.ask"
          ? { projection: {}, question: "where" }
          : { projection: {} };
        const outcome = await settled(callCore(carried, payload));
        t.check(!outcome.ok, `${carried} is refused by the core door`);
        t.check(/sendAdvisor/.test(outcome.error ?? ""), `${carried} names the door it wanted`);
      }
      t.equal(sent.length, 0, "and neither reached the core");

      // --- a bridge that throws before it returns a promise -------------------
      //
      // `invoke` is foreign code. It throwing synchronously was the one escape
      // left from a function that promises an envelope, and the rejection
      // handler read `error?.message` directly - so a hostile getter defeated
      // the very handler that exists to describe hostile input.
      {
        const savedCore = globalThis.window.__TAURI__;
        for (const [what, invoke] of Object.entries({
          "a bridge that throws synchronously": () => { throw new Error("the bridge exploded"); },
          "a bridge that returns nothing": () => undefined,
          "a bridge that rejects with a hostile error": () => Promise.reject({
            get message() { throw new Error("the message getter exploded"); },
          }),
          "a bridge that rejects with a hostile toString": () => Promise.reject({
            toString() { throw new Error("toString exploded"); },
          }),
        })) {
          globalThis.window.__TAURI__ = { core: { invoke } };
          let threw = null;
          let envelope = null;
          try { envelope = await app.sendCore("token.characters"); }
          catch (error) { threw = error; }
          t.equal(threw, null, `${what} does not escape sendCore`);
          t.check(envelope && typeof envelope === "object" && typeof envelope.id === "string",
            `${what} still resolves an envelope`);
          t.check(typeof app.reason({ get message() { throw new Error("x"); } }) === "string",
            "and the renderer itself cannot throw");
        }
        globalThis.window.__TAURI__ = savedCore;
      }

      // --- sendCore has one outcome shape ------------------------------------
      //
      // One exit rejecting while the rest resolve an envelope means
      // `sendCore(op, x).then(env => ...)` gets an unhandled rejection for a dark
      // op. A protocol with two outcome shapes is two protocols.
      {
        const savedCore = globalThis.window.__TAURI__;
        for (const [what, op, payload, code] of [
          // `advisor.consider` left the dark list at step 6 and is carried to the
          // advisor rather than routed to a core command, so this door refuses
          // it as a caller's mistake - `malformed` - and not as an absent
          // transport. `core-absent` is a fact a caller may branch on and must
          // not also mean "you called the wrong function".
          ["an op carried to the advisor", "advisor.consider", { projection: {} }, "malformed"],
          ["a dark op", "esi.get", { route: "/x/", characterId: 1 }, "core-absent"],
          ["a payload that does not fit", "token.forget", { characterId: [1, 2] }, "malformed"],
        ]) {
          const envelope = await app.sendCore(op, payload);
          t.check(envelope && envelope.ok === false, `${what} resolves a failure envelope`);
          t.equal(envelope.error.code, code, `${what} carries the code ${code}`);
          t.check(typeof envelope.id === "string" && envelope.id.length > 0,
            `${what} still carries an id, so a caller can match it`);
        }

        globalThis.window.__TAURI__ = undefined;
        const noCore = await app.sendCore("token.characters");
        t.check(noCore && noCore.ok === false, "a build with no core resolves rather than rejecting");
        t.equal(noCore.error.code, "core-absent", "saying the core is the thing that is absent");
        globalThis.window.__TAURI__ = savedCore;
      }

      // --- what the core returns has to fit what the seam declares ----------
      //
      // Nothing else asserts it, and a mismatch is silent on both sides.
      //
      // `payloadOf` wraps whatever a typed command returns into the single
      // field `CORE_REPLY_FIELD` declares for that op. `advisor_status` was
      // written to return a struct, which serialised to `{"running":true}` and
      // arrived as `{"running":{"running":true}}` - refused by `replyFault`,
      // thrown by `callCore`, swallowed by `refreshAdvisorAvailability` into
      // "no advisor". The opener could therefore never appear in a desktop
      // build: the entire ask window was unreachable, silently, with every one
      // of four and a half thousand assertions passing.
      //
      // Nothing caught it because the contract tests check that a routed op
      // *declares* a reply field, and the Rust tests check the Rust - and the
      // defect lived exactly in between, in the shape one hands the other.
      {
        const savedCore = globalThis.window.__TAURI__;

        // The shape Rust returns now: the bare value the seam wraps.
        globalThis.window.__TAURI__ = { core: { invoke: () => Promise.resolve(true) } };
        const bare = await settled(callCore("advisor.available"));
        t.check(bare.ok, "a bare boolean from the core reads as an answer");
        t.equal(bare.value, true, "and arrives as the boolean itself");

        globalThis.window.__TAURI__ = { core: { invoke: () => Promise.resolve(false) } };
        t.equal((await settled(callCore("advisor.available"))).value, false,
          "and false arrives as false rather than as absent");

        // The reply record rather than the value. This must not read as an answer.
        globalThis.window.__TAURI__ = { core: { invoke: () => Promise.resolve({ running: true }) } };
        const wrapped = await settled(callCore("advisor.available"));
        t.check(!wrapped.ok, "a command that returns the reply record instead of the value is refused");
        t.check(/expected boolean/.test(wrapped.error ?? ""), "and says what it expected");

        globalThis.window.__TAURI__ = savedCore;
      }

      // --- the core's envelope is read, not merely stamped -------------------
      {
        const savedCore = globalThis.window.__TAURI__;
        globalThis.window.__TAURI__ = { core: { invoke: () => Promise.resolve([]) } };
        const good = await settled(callCore("token.characters"));
        t.check(good.ok, "a well-formed answer still reads");
        globalThis.window.__TAURI__ = savedCore;
      }

      // --- a request id two windows cannot both mint -------------------------
      //
      // `snapshot.js` already carries this lesson about its own ids: "the
      // counter alone let two windows both mint `s1`, and a reference from one
      // resolved in the other". Harmless while Tauri correlates each `invoke`
      // by its own promise; not harmless once the advisor hop routes replies by
      // envelope id over one pipe, which is what step 6 does with two windows.
      //
      // Read off the envelope rather than off what reached Rust, because only
      // the payload crosses a typed command - the id is the protocol's.
      {
        const savedCore = globalThis.window.__TAURI__;
        globalThis.window.__TAURI__ = { core: { invoke: () => Promise.resolve(null) } };
        const ids = [];
        for (let i = 0; i < 3; i += 1) {
          const envelope = await app.sendCore("token.forget", { characterId: 90000000 + i });
          ids.push(envelope.id);
        }
        globalThis.window.__TAURI__ = savedCore;
        t.check(ids.every((id) => /^c[a-z0-9]{1,16}-[0-9]+$/.test(id)),
          `every request id carries a realm prefix (${ids.join(", ")})`);
        t.check(!ids.some((id) => /^[0-9]+$/.test(id)), "and none is a bare counter");
        t.equal(new Set(ids).size, 3, "and they do not repeat within one window");
        t.equal(new Set(ids.map((id) => id.split("-")[0])).size, 1,
          "while sharing one realm, because they come from one module instance");
      }

      // --- a pilot reads the core's own words, not a wrapper's ---------------
      //
      // All six Rust commands return `Result<_, String>`, so `invoke` rejects
      // with a bare string. `callCore` wraps a failure envelope in an `Error`
      // to keep its rejection contract, and `String(error)` on an `Error`
      // prepends "Error: " - so the message the vault surface calls
      // "actionable by the pilot" grew a prefix that is not, and the
      // 120-character truncations lost seven characters of a filesystem path.
      {
        const savedCore = globalThis.window.__TAURI__;
        globalThis.window.__TAURI__ = {
          core: { invoke: () => Promise.reject("/store.json: permission denied") },
        };
        const denied = await settled(callCore("token.characters"));
        t.check(!denied.ok, "a rejected command is a failure");
        t.check(/permission denied/.test(denied.error ?? ""), "carrying what Rust said");
        t.equal(app.reason(new Error("/store.json: permission denied")),
          "/store.json: permission denied",
          "and the sentence a pilot reads has no wrapper in front of it");
        t.equal(app.reason("a bare string"), "a bare string", "a bare rejection reads as itself");
        t.equal(app.reason(null), "", "and nothing reads as nothing");
        globalThis.window.__TAURI__ = savedCore;
      }

      // --- the core's answer is held to its declared shape too ---------------
      //
      // `REPLIES` exists because the reply was the one direction nothing
      // checked. It was wired into the advisor path first and left the six
      // commands unwatched, which is the claim half-kept. The core is our own
      // Rust, so this is not about a hostile answer - it is about a return type
      // changing on one side of a boundary with nothing saying so.
      {
        const savedCore = globalThis.window.__TAURI__;
        globalThis.window.__TAURI__ = {
          core: { invoke: (name) => Promise.resolve(name === "token_characters" ? "not a list" : 7) },
        };
        const wrong = await settled(callCore("token.characters"));
        t.check(!wrong.ok, "a core answering with the wrong shape is refused");
        t.check(/does not understand/.test(wrong.error ?? ""),
          `and says the build could not read it (${wrong.error})`);
        globalThis.window.__TAURI__ = savedCore;
      }

      // A good request goes through, under the Rust command's own name.
      const good = await settled(callCore("token.forget", { characterId: 1586929189 }));
      t.check(good.ok, "a well-formed request is sent");
      t.equal(sent.length, 1, "exactly once");
      t.equal(sent[0][0], "token_forget", "under the Rust command's own name, which is unchanged");
      t.equal(sent[0][1]?.characterId, 1586929189, "carrying the payload");
      t.check(sent[0][1]?.v === undefined && sent[0][1]?.id === undefined,
        "and not the envelope, because invoke correlates its own replies");

      // The browser tier asks for nothing, and must be told so rather than left
      // waiting on a promise that never settles.
      globalThis.window = { ...(savedWindow ?? {}) };
      const noCore = await settled(callCore("token.characters"));
      t.check(!noCore.ok, "with no core there is nothing to ask");
      t.check(/no core/i.test(noCore.error ?? ""), "and it says so rather than hanging");

      globalThis.window = savedWindow;
      return t.results;
    })();
  }
}
