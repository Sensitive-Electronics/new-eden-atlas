// Which surfaces a model may reach, asserted from the markup.
//
// This is a rule about *surfaces* rather than about content, and that is the
// whole point of it: there is no judgement call at the boundary, and a reviewer
// checks it by looking at the DOM rather than by reading a sentence and
// deciding whether it was too strong. Every panel, every row on the map and
// every block of the brief is written by deterministic code. `#brief-read` is
// the one deliberate exception, and it ships off.
//
// It ships off because the argument that protects the ask window does not reach
// here. In a window a pilot opened in order to speculate, a wrong read is a
// wrong sentence. Printed under the findings it is not a sentence - it is the
// order, and being printed there is the authority.
//
// What is asserted, in the order it matters:
//
//   - **The brief is complete without it.** That is the shipped state, and it
//     is also every state where the sidecar is absent, the reply was refused,
//     or the answer arrived about a brief that is no longer on screen.
//   - **Off means nothing is sent**, not that an answer is discarded. A model
//     that was asked is a model that ran.
//   - **The read is additive and isolated.** With one on screen, deleting that
//     node leaves markup byte-identical to the same brief built with the
//     setting off. Nothing else moved, gained a class or changed a word.
//   - **The node holds what `relations.js` wrote**, to the character.
//   - **No digit in it that a name did not bring.** Word-level, like the
//     opinion check, because null-sec names carry digits - "1DQ1-A" is a name
//     and not a number - and a substring test would pass everything.

import { readArchive, ROOT, suite } from "./helpers.mjs";
import { buildOperationalBrief, TacticalAnalyzer } from "../web/tactical-analyzer.js";
import { reply } from "../web/contract.js";
import { read, RELATION_IDS } from "../web/relations.js";
import { project, reference } from "../web/snapshot.js";
import { STORAGE_KEYS } from "../web/settings.js";
import fs from "node:fs";
import path from "node:path";

const WORD = /[^\s]+/g;
const HAS_DIGIT = /\p{N}/u;

function shownNames(snapshot) {
  return Object.values(snapshot.names || {})
    .filter((name) => typeof name === "string" && name.length > 0)
    .sort((a, b) => b.length - a.length);
}

// Digits no shown name accounts for. Whole words, never substrings.
function unexplainedDigits(text, names) {
  const left = [];
  for (const word of String(text).match(WORD) || []) {
    const bare = word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    if (bare === "") continue;
    if (names.some((name) => bare === name || bare.startsWith(name))) continue;
    if (HAS_DIGIT.test(bare)) left.push(bare);
  }
  return left;
}

// The relation the snapshot in front of us actually satisfies, asked of
// `relations.js` rather than hard-coded: a topology change in the archive would
// otherwise fail this file for a reason that has nothing to do with surfaces.
//
// `count` is how many of the brief's findings the read names, and it defaults
// to all of them because that is the only shape this surface accepts.
function trueReadFor(snapshot, count = Infinity) {
  const shown = project(snapshot);
  const chosen = snapshot.findings.slice(0, Math.min(count, snapshot.findings.length));
  const refs = chosen.map((finding) => reference(shown, finding.id));
  for (const relation of RELATION_IDS) {
    const attempt = read(snapshot, { relation, findings: refs });
    if (!attempt.fault) return { shown, request: { relation, findings: refs }, text: attempt.text };
  }
  return { shown, request: null, text: null };
}

// Every element anywhere that holds a given sentence, whatever its id and
// whatever container it hangs from. `ui.content` is not the whole page, and a
// test that only counts inside it proves the read is *present* while proving
// nothing about it being present *only there* - which is half of what this file
// is for. Three mutations that appended the sentence to the map, to the live
// bar and to `document.body` all passed a `ui.content`-scoped count.
function holdersOf(text, ui) {
  const roots = [ui.content, ui.map, ui.liveBar, ui.askLayer, ui.rail, document.body,
    globalThis.__mapStage].filter(Boolean);
  const seen = new Set();
  const held = [];
  for (const root of roots) {
    for (const node of [root, ...root.querySelectorAll("p,div,span,button,text,section,aside,strong,small")]) {
      if (seen.has(node)) continue;
      seen.add(node);
      const own = (node._nodes ?? []).filter((n) => typeof n === "string").join("");
      if (own.includes(text)) held.push(node);
    }
  }
  return held;
}

export default async function run(app) {
  const t = suite("surfaces");
  const { state, ui } = app;
  const atlas = readArchive();
  state.atlas = atlas;
  state.tacticalAnalyzer = new TacticalAnalyzer(atlas);

  const report = state.tacticalAnalyzer.analyze("Tama", 4);
  const config = { preset: "escape", depth: 4, blocks: { security: true, approaches: true, chokes: true, borders: true } };

  // **Defining `window` at all is the intrusive part**, not defining
  // `__TAURI__` on it. The shim leaves `window` undefined on purpose, and
  // `web/` reads five things off it behind `typeof window === "undefined"`
  // guards - so a bare `{ __TAURI__ }` satisfies every guard and then throws on
  // the first `matchMedia`, an error about this fixture reported against the
  // code under test. The stand-in answers all five.
  const savedWindow = globalThis.window;
  const calls = [];
  const useCore = (advisor) => {
    globalThis.window = {
      __TAURI__: { core: { invoke: async (name, args) => {
        calls.push({ name, args });
        // **The two hops call `invoke` differently and this fixture has to
        // match each.** `sendCore` sends `envelope.payload` and wraps the bare
        // return value on the way back, so a status answer is just `true`;
        // `sendAdvisor` sends `{ envelope }` and returns the whole envelope,
        // because both of step 5's staleness checks need it. Answering the
        // status hop with an envelope reads `args.envelope.id` off `undefined`,
        // `callCore` turns the throw into a rejection, and `advisorUp` goes
        // quietly false - so the brief stops asking and every later assertion
        // fails somewhere else entirely.
        if (name === "advisor_status") return true;
        return advisor(args.envelope);
      } } },
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
      addEventListener() {}, removeEventListener() {},
      setInterval: () => 0, clearInterval() {},
      confirm: () => false, innerWidth: 1280,
    };
  };
  // **Built when the request arrives, never before it.** The brief takes its
  // one turn from inside `showTacticalBrief`, so there is no moment between the
  // snapshot existing and the question being asked in which a fixture could
  // prepare an answer about it. A reply computed in advance answers about the
  // previous brief - which is the exact staleness this feature guards against,
  // arriving through the test.
  const answerTruthfully = (envelope) => {
    const snapshot = state.briefSnapshot;
    const { shown, request } = trueReadFor(snapshot);
    return reply(envelope.id, { snapshotId: shown.snapshotId, operations: [], read: request });
  };
  const sends = () => calls.filter((call) => call.name === "advisor_request").length;
  // Every read of `nodes()[0]` below is optional-chained on purpose. Six of the
  // nine mutations run against this file made the node absent, and a bare
  // `nodes()[0].textContent` turned each of them into "threw before reporting"
  // with a TypeError - a run that fails, correctly, and says nothing about
  // which bound broke. A test that only fails is half a test.
  const nodes = () => ui.content.querySelectorAll("#brief-read");
  // **Both halves, because the feature needs both.** `readOn` requires the
  // store *and* the checkbox in front of the pilot, so a helper that wrote only
  // the store would be testing a state a pilot cannot reach - and would have
  // hidden the bound it exists to honour.
  const clearSetting = () => {
    try { localStorage.removeItem(STORAGE_KEYS.read); } catch { /* absent is the default */ }
    if (ui.panelRead) ui.panelRead.checked = false;
  };
  const setSetting = (on) => {
    try { localStorage.setItem(STORAGE_KEYS.read, JSON.stringify({ on })); } catch { /* nothing to assert */ }
    if (ui.panelRead) ui.panelRead.checked = Boolean(on);
  };

  try {
    // --- the shipped state ----------------------------------------------------
    clearSetting();
    app.clearPanelRead();
    t.equal(app.readOn(), false, "with nothing stored, the panel read is off");
    setSetting(false);
    t.equal(app.readOn(), false, "and stored off, it is off");
    try {
      localStorage.setItem(STORAGE_KEYS.read, "{not json");
      t.equal(app.readOn(), false, "an unreadable setting is off too, rather than a default that speaks");
      localStorage.setItem(STORAGE_KEYS.read, JSON.stringify({ on: 1 }));
      t.equal(app.readOn(), false, "and so is a truthy value that is not true");
      localStorage.setItem(STORAGE_KEYS.read, JSON.stringify({ on: "true" }));
      t.equal(app.readOn(), false, "the string \"true\" included");

      // **Inherited is not stored.** `JSON.parse` leaves the prototype chain in
      // place, so a polluted `Object.prototype.on` and a stored `{}` switched
      // this on - the bug class `snapshot.js` makes its records null-prototype
      // to avoid. No route to it exists in this build; one `Object.hasOwn`
      // means there never can be.
      localStorage.setItem(STORAGE_KEYS.read, "{}");
      Object.prototype.on = true;
      try {
        t.equal(app.storedReadOn(), false, "a value inherited from the prototype does not switch it on");
      } finally {
        delete Object.prototype.on;
      }
    } catch { /* a storage that refuses is the same answer */ }
    clearSetting();

    // **The switch wins over the store, in the direction of silence.**
    // `writeJson` returns false rather than throwing, so a storage failure left
    // `{on:true}` stored with the box unticked - and `readOn`, the authority,
    // kept answering on. Measured before the fix as: checkbox false, readOn()
    // true, sentence still under the findings, every later brief still
    // spending a turn.
    try {
      localStorage.setItem(STORAGE_KEYS.read, JSON.stringify({ on: true }));
      ui.panelRead.checked = true;
      t.equal(app.readOn(), true, "stored on and ticked is on");
      ui.panelRead.checked = false;
      t.equal(app.storedReadOn(), true, "a write that failed leaves the store saying on");
      t.equal(app.readOn(), false, "and the unticked box still turns it off");
    } catch { /* a storage that refuses is the same answer */ }
    clearSetting();

    state.advisorUp = false;
    app.showTacticalBrief(report, config);
    t.equal(nodes().length, 0, "the shipped brief carries no read");
    t.check(ui.content.querySelectorAll(".command-priority").length > 0,
      "and it is complete: the command priorities are there");
    t.check(Boolean(ui.content.querySelector(".command-caveat")), "the caveat is there");
    t.check(ui.content.querySelectorAll(".tactical-vector").length > 0, "and the optional blocks are there");

    // --- off means nothing is sent --------------------------------------------
    useCore(answerTruthfully);
    state.advisorUp = true;
    calls.length = 0;
    app.showTacticalBrief(report, config);
    await state.panelReadPending;
    t.equal(sends(), 0, "with the setting off, no advisor request is sent for a brief at all");
    t.equal(nodes().length, 0, "and no node appears");

    // **The comparand is taken here, not above.** The first brief was rendered
    // with the advisor down, so it carries no "Ask about this brief" opener -
    // comparing against it would report the opener as a difference the read
    // caused. This baseline is the same brief under the same conditions with
    // the one setting flipped, which is the only comparison that isolates it.
    const shipped = ui.content.textContent;

    // --- on, and the relation is true ------------------------------------------
    setSetting(true);
    t.equal(app.readOn(), true, "stored on, it is on");
    app.clearPanelRead();
    calls.length = 0;
    app.showTacticalBrief(report, config);
    const snapshot = state.briefSnapshot;
    t.check(Boolean(snapshot) && Array.isArray(snapshot.findings) && snapshot.findings.length >= 2,
      `the brief minted a snapshot with findings (${snapshot?.findings?.length ?? 0})`);
    const { text: expected, request } = trueReadFor(snapshot);
    t.check(Boolean(request), "at least one relation holds over the first two findings");

    const turn = await state.panelReadPending;
    t.check(Boolean(turn), "the brief took its one turn and the answer was accepted");
    t.equal(sends(), 1, "exactly one advisor request was sent");
    t.equal(nodes().length, 1, "exactly one read node is on screen");
    t.equal(nodes()[0]?.textContent, expected, "holding exactly what relations.js wrote, to the character");

    // **The one element, asserted as one.** Counted across every root the page
    // has rather than inside `ui.content`, because "the read appears here" and
    // "the read appears only here" are different claims and only the second is
    // the surface rule.
    const holders = holdersOf(expected, ui);
    t.equal(holders.length, 1, `exactly one element anywhere holds that sentence (${holders.length})`);
    t.equal(holders[0]?.getAttribute("id"), "brief-read", "and it is the one element allowed to");

    // And it is under the findings, which is the whole reason this surface is
    // bounded harder than the window. A sentence in the corner of a panel is a
    // note; the same sentence under the command priorities is the order.
    t.equal(nodes()[0]?.parentNode?.className, "command-section",
      "sitting inside the command section, under the priorities");

    // **A projection crossed, never the snapshot.** Asserted on this path as
    // well as in the advisor tests, because a panel is where reaching for the
    // snapshot would be most convenient.
    const sent = calls.find((call) => call.name === "advisor_request");
    t.check(Object.hasOwn(sent.args.envelope.payload, "projection"), "the request carried a projection");
    t.check(!Object.hasOwn(sent.args.envelope.payload, "snapshot"), "and never the snapshot");

    // --- a read about only some of the findings is refused -----------------------
    //
    // True of a subset is not false, but printed under the findings it is an
    // edit. On a Tama hunt brief - Tunttaras 0.9, Kedama 0.3, Isanamo 0.6 - a
    // model naming the first and third renders "Tunttaras and Isanamo are in
    // the same region." and drops the only low-security catch point from a
    // sentence sitting under the catch points. The rows show no security, so
    // there is nothing on screen to notice the omission with.
    {
      const before = nodes()[0]?.textContent;
      app.clearPanelRead();
      app.showTacticalBrief(report, config);
      // Awaited before the fixture is swapped. Without this the brief's own
      // turn is still in flight with the covering answer attached, and it
      // lands *after* the partial one is refused - so the assertion below
      // reads a full read and blames the refusal for not happening.
      await state.panelReadPending;
      const partialSnapshot = state.briefSnapshot;
      t.check(partialSnapshot.findings.length > 2,
        `this brief lists more than two systems, so a subset is available (${partialSnapshot.findings.length})`);
      const partial = trueReadFor(partialSnapshot, 2);
      t.check(Boolean(partial.request), "and a relation does hold over just two of them");
      t.check(partial.text !== before || partialSnapshot.findings.length === 2,
        "which is a different sentence from the one covering them all");

      calls.length = 0;
      useCore((envelope) => reply(envelope.id, {
        snapshotId: project(state.briefSnapshot).snapshotId,
        operations: [],
        read: trueReadFor(state.briefSnapshot, 2).request,
      }));
      app.clearPanelRead();
      await app.requestPanelRead();
      t.equal(sends(), 1, "the turn was taken");
      t.equal(nodes().length, 0, "and a read naming only some of the findings is refused");
      t.equal(state.panelRead.text, null, "with nothing kept, so no later render can print it");

      // Put the covering read back for the assertions below.
      useCore(answerTruthfully);
      app.clearPanelRead();
      app.showTacticalBrief(report, config);
      await state.panelReadPending;
      t.equal(nodes().length, 1, "while the read covering every finding is accepted");
    }

    // --- additive and isolated -------------------------------------------------
    //
    // Take it out and what is left is the deterministic brief, word for word.
    //
    // **Words, and only words.** `textContent` cannot see a class or an attribute, so a
    // mutation adding either to the caveat passes this untouched. The structural half of
    // the claim is carried by `holdersOf` above and by the placement assertion, not by
    // this one.
    // **Read off the live tree, not off `innerHTML`.** The shim's `innerHTML`
    // getter returns the string that was last assigned, so a node appended
    // afterwards is invisible to it - and the first version of this check
    // compared two identical strings and passed while proving nothing. What
    // the tree holds is what `textContent` walks.
    const withRead = ui.content.textContent;
    t.check(withRead !== shipped, "the read really is on screen, so the comparison below does work");
    t.check(withRead.includes(expected), "and it is the read that is in there");
    // The mark goes with it. It is a second node by design - generated content
    // is not in the DOM, so a copied brief would lose a `::before` label - and
    // the two are one block as far as "what the read added" is concerned.
    t.check(withRead.includes("Advisor read"),
      "the block says whose sentence it is, in text a copy would carry");
    ui.content.querySelector("#brief-read-mark")?.remove();
    nodes()[0]?.remove();
    t.equal(ui.content.textContent, shipped,
      "and removing the block leaves the brief exactly as it reads with the read off");

    // --- the node is text, asserted where the rule lives -------------------------
    //
    // A DOM assertion cannot carry this. The only sentence this fixture can
    // produce has no `<` and no `&`, so `innerHTML = text` and `textContent =
    // text` are indistinguishable through the tree - a mutation swapping them
    // passed every assertion in this file. `audit-regressions.test.mjs` already
    // scans sources for rules the DOM cannot express; this is one of them.
    {
      const source = fs.readFileSync(path.join(ROOT, "web", "app.js"), "utf8");
      const start = source.indexOf("function renderPanelRead(");
      t.check(start > 0, "renderPanelRead was found in the source");
      const body = source.slice(start, source.indexOf("\nfunction ", start + 1));
      t.check(/node\.textContent\s*=/.test(body), "it writes the read with textContent");
      t.check(!/\binnerHTML\b/.test(body), "and never with innerHTML, which no DOM check here could tell apart");
    }

    // --- no digit a name did not bring -----------------------------------------
    const names = shownNames(snapshot);
    const stray = unexplainedDigits(expected, names);
    t.equal(stray.length, 0,
      `no digit in the read that a name did not bring${stray.length ? `: ${stray.join(", ")}` : ""}`);
    // **Over every sentence this archive can actually produce**, not just the
    // one this brief happened to get. The Tama neighbourhood has no name with a
    // digit in it, so the assertion above was true of a broken checker as well
    // as a working one. Null-sec names are where the digits are.
    {
      let checked = 0;
      let withDigits = 0;
      for (const origin of ["1DQ1-A", "EC-P8R", "319-3D", "Jita", "Hek"]) {
        let far;
        try { far = state.tacticalAnalyzer.analyze(origin, 3); } catch { continue; }
        for (const preset of ["hunt", "escape", "recon"]) {
          const brief = buildOperationalBrief(far, preset);
          const snap = app.mintBriefSnapshot(far, brief);
          if (!snap || !Array.isArray(snap.findings) || snap.findings.length < 2) continue;
          const { text } = trueReadFor(snap);
          if (!text) continue;
          checked += 1;
          const theirs = shownNames(snap);
          if (theirs.some((name) => HAS_DIGIT.test(name))) withDigits += 1;
          const left = unexplainedDigits(text, theirs);
          t.equal(left.length, 0, `${origin}/${preset}: no digit the names did not bring${left.length ? `: ${left.join(", ")}` : ""}`);
        }
      }
      t.check(checked >= 5, `enough real sentences were checked to mean something (${checked})`);
      t.check(withDigits > 0,
        `and some of them named systems with digits in the name (${withDigits}), which is the case the check exists for`);
    }

    // The check is word-level rather than a substring scan, and that is worth
    // proving directly.
    t.equal(unexplainedDigits("1DQ1-A and 319-3D are low security.", ["1DQ1-A", "319-3D"]).length, 0,
      "a name with digits in it is not a number");
    t.equal(unexplainedDigits("1DQ1-A is 11 jumps out.", ["1DQ1-A"]).join(","), "11",
      "and a digit beside that name still is one");

    // --- no spinner -------------------------------------------------------------
    //
    // Asserted while a turn is genuinely in flight, because the forbidden state
    // - the setting on, a request sent, no answer yet - is the only one in
    // which a placeholder could exist, and every other block in this file
    // skips straight past it. A mutation that appended an empty `#brief-read`
    // whenever a turn was outstanding passed the whole file without it.
    {
      app.clearPanelRead();
      let release;
      const held = new Promise((resolve) => { release = resolve; });
      useCore(async (envelope) => {
        await held;
        return answerTruthfully(envelope);
      });
      app.showTacticalBrief(report, config);
      const inFlight = state.panelReadPending;
      await Promise.resolve();
      t.equal(nodes().length, 0, "while a turn is in flight there is no node at all");
      t.equal(ui.content.querySelectorAll("#brief-read-mark").length, 0, "and no label waiting for one");
      t.check(!/Advisor read/.test(ui.content.textContent), "nothing on screen says a read is coming");
      release();
      await inFlight;
      t.equal(nodes().length, 1, "and the node appears only once there is a sentence for it");

      // The guard itself, driven directly. `forSnapshot` is only ever written
      // beside a text, so this state cannot arise from the turn above - which
      // is exactly why dropping `!held.text` from the guard changed no
      // assertion anywhere. Constructing it is the only way to say the guard
      // is load-bearing rather than decorative.
      state.panelRead = { key: state.panelRead.key, forSnapshot: state.briefSnapshot.id, text: null };
      app.renderPanelRead();
      t.equal(nodes().length, 0, "and a read bound to this render with no sentence draws nothing");
      t.equal(ui.content.querySelectorAll("#brief-read-mark").length, 0, "not even the label");

      app.clearPanelRead();
      useCore(answerTruthfully);
      app.showTacticalBrief(report, config);
      await state.panelReadPending;
    }

    // --- one turn per brief ----------------------------------------------------
    //
    // The budget is claimed before the request goes out, so a re-render cannot
    // spend a second. The brief re-renders on a toggle and on an inspector
    // refresh, and a model asked repeatedly until it says something will
    // eventually say something.
    calls.length = 0;
    await app.requestPanelRead();
    await app.requestPanelRead();
    t.equal(sends(), 0, "asking again about the same brief sends nothing");

    // --- an answer about a brief that is no longer on screen --------------------
    app.clearPanelRead();
    app.showTacticalBrief(report, config);
    const current = state.briefSnapshot;
    t.check(current.id !== snapshot.id, "a rebuilt brief mints a different snapshot");
    await state.panelReadPending;
    t.equal(nodes().length, 1, "which gets its own read");

    app.clearPanelRead();
    calls.length = 0;
    useCore((envelope) => {
      const answer = answerTruthfully(envelope);
      // Correct, and about the brief that was on screen when it was asked -
      // with the brief swapped underneath before it lands.
      state.briefSnapshot = { ...current, id: `${current.id}x` };
      return answer;
    });
    await app.requestPanelRead();
    t.equal(sends(), 1, "the turn was taken");
    t.equal(nodes().length, 0,
      "and a read that arrives about a superseded brief is dropped rather than printed");

    // **Refused, not merely invisible**, and only the state can say which.
    //
    // Deleting the staleness check from `requestPanelRead` left every
    // assertion above green: the answer was *accepted into state* and the node
    // was absent only because `renderPanelRead`'s separate guard happened to
    // hold at that instant, with `state.briefSnapshot` pointed elsewhere. The
    // next line of this test pointed it back - at which moment the stale read
    // was live and printable, and any redraw would have shown it.
    t.equal(state.panelRead.forSnapshot, null, "nothing was bound to a render");
    t.equal(state.panelRead.text, null, "and nothing was kept, so no later redraw can print it");
    state.briefSnapshot = current;

    // --- the switch, driven through the real listener ---------------------------
    //
    // Through `dispatch("change")` rather than by calling the two functions the handler
    // calls, because what this covers lives *in the handler*: rendering on the way off
    // and only asking on the way on leaves off-then-on with a bare panel and the
    // sentence still in `state`. A test calling `renderPanelRead` and
    // `requestPanelRead` itself passes over that, which is the shape of a test that
    // guards a helper and not a call
    // site.
    app.bindPanelRead();
    app.clearPanelRead();
    useCore(answerTruthfully);
    setSetting(true);
    ui.panelRead.checked = true;
    await app.requestPanelRead();
    t.equal(nodes().length, 1, "a read is on screen again");

    calls.length = 0;
    ui.panelRead.checked = false;
    ui.panelRead.dispatch("change");
    t.equal(nodes().length, 0,
      "unticking removes it immediately, without rebuilding the brief");
    t.equal(app.readOn(), false, "and the setting is written through, not only the checkbox");

    ui.panelRead.checked = true;
    ui.panelRead.dispatch("change");
    t.equal(nodes().length, 1, "ticking it again puts back the read this brief already had");
    t.equal(nodes()[0]?.textContent, expected, "the same sentence, not a new one");
    t.equal(sends(), 0,
      "and buys no second turn - a toggle is not a way to ask the model again");

    // --- the read dies with the brief -------------------------------------------
    //
    // `display()` is where a brief stops being on screen - selecting a system
    // or showing a route overwrites `ui.content` - and it already clears
    // `state.briefSnapshot` there for exactly this reason. The read is a
    // sentence about one set of findings and goes in the same breath, or it
    // outlives the findings it describes.
    t.check(Boolean(state.panelRead.text), "the read is held in state while its brief is up");
    const heldKey = state.panelRead.key;
    app.showRegion(state.atlas.regions[Object.keys(state.atlas.regions)[0]]);
    t.equal(state.briefSnapshot, null, "rendering another panel clears the brief snapshot");
    t.equal(state.panelRead.forSnapshot, null, "and unbinds the read from any render");
    t.equal(nodes().length, 0, "so nothing is left on screen");

    // **Unbound, not forgotten**, and the distinction is the budget. The read
    // is kept against the findings it answers, so rebuilding the same brief
    // shows the same sentence and asks nothing - which is what stops a pilot
    // pressing Build brief until the model says something they like.
    t.equal(state.panelRead.key, heldKey, "while the answer is kept against the findings it describes");
    calls.length = 0;
    app.showTacticalBrief(report, config);
    await state.panelReadPending;
    t.equal(sends(), 0, "so rebuilding the identical brief buys no second turn");
    t.equal(nodes().length, 1, "and shows the sentence it already had");
    t.equal(nodes()[0]?.textContent, expected, "the same one, not a re-roll");
    // --- a refused brief takes the previous one with it --------------------------
    //
    // Every other result panel clears what is drawn before it says why it
    // refused; this one set `state.tactical = null`, wrote the error, and left
    // `ui.content` untouched. So typing a system that does not resolve left the
    // previous brief fully on screen: the input said one thing, the panel said
    // another, `state.tactical` said nothing at all, and the "Ask about this
    // brief" opener was still live and still holding the *old* snapshot - on the
    // one surface that feeds the advisor.
    {
      setSetting(false);
      app.clearPanelRead();
      state.tacticalAnalyzer = new TacticalAnalyzer(atlas);
      ui.tacticalSystem.value = "Tama";
      app.runTacticalBrief();
      t.check(/Tama/.test(ui.content.textContent), "a brief is on screen");
      t.check(Boolean(state.tactical) && Boolean(state.briefSnapshot),
        "with its report and its snapshot");

      ui.tacticalSystem.value = "Qqqqqqqq";
      app.runTacticalBrief();
      t.check(Boolean(ui.tacticalError.textContent), "an unresolvable system is refused with a reason");
      t.equal(state.tactical, null, "and nothing is computed");
      t.check(!/3-jump radius/.test(ui.content.textContent),
        "the previous brief is gone rather than left contradicting the input");
      t.equal(state.briefSnapshot, null, "its snapshot is gone with it");
      t.equal(ui.content.querySelectorAll("[data-ask-open]").length, 0,
        "and so is the opener that would have forked it");

      // And the mirror: a refused brief must not wipe a panel that is not a
      // brief. The clearing exists so a refusal cannot contradict the input; a
      // clearing that takes anything on screen is the same defect pointed the
      // other way.
      const route = state.routePlanner?.calculate("Tama", "Nourvukaiken", "shortest");
      if (route?.systems?.length) {
        app.showRoute(route);
        const drawn = ui.content.innerHTML;
        ui.tacticalSystem.value = "Qqqqqqqq";
        app.runTacticalBrief();
        t.check(Boolean(ui.tacticalError.textContent), "the brief is still refused with a reason");
        t.equal(ui.content.innerHTML, drawn,
          "and the route panel a pilot left open is untouched by it");
      }
    }
  } finally {
    if (savedWindow === undefined) delete globalThis.window;
    else globalThis.window = savedWindow;
    // The checkbox and its listener are this file's alone today, and that is
    // exactly why they are put back: the shim's `addEventListener` appends and
    // never replaces, so a `change` handler left bound here fires for whatever
    // touches `ui.panelRead` next - and it writes localStorage.
    if (ui.panelRead) {
      ui.panelRead.checked = false;
      if (ui.panelRead._listeners) delete ui.panelRead._listeners.change;
    }
    if (ui.tacticalError) ui.tacticalError.textContent = "";
    clearSetting();
    app.clearPanelRead();
    state.advisorUp = false;
    state.briefSnapshot = null;
    state.panelReadPending = null;
  }

  return t.results;
}
