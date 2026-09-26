// The ask window, checked for the four things it promises.
//
// It is the first surface a model reaches, and the first place a pilot is
// invited to read something that was not computed deterministically. So what
// is asserted here is not "it renders" - it is the set of properties that make
// one loose window safe to have at all:
//
//   1. It forks the brief's snapshot and cannot build one.
//   2. Two windows hold different snapshots and each says which.
//   3. It produces nothing that acts.
//   4. The question is bounded before anything else sees it.
//
// None of it needs a browser, a sidecar or a model, which is the point of
// keeping identity and the surface in a module that holds no DOM.

import { readArchive, suite } from "./helpers.mjs";
import { buildSnapshot, project, reference } from "../web/snapshot.js";
import { consider } from "../web/advisor.js";
import { CONTRACT_VERSION } from "../web/contract.js";
import { loadedInput } from "./advisor-fixtures.mjs";
import {

  cleanQuestion, closeWindow, createWindows, figure, MARKS, openWindow, QUESTION_LIMIT,
  scratchpadName, WARNING, windowOf, windowTemplate, WINDOW_LIMIT,
} from "../web/ask-window.js";
// Every system name in New Eden. `opine` needs it to recognise a name written in
// lower case, and refuses every opinion without it - which is its documented
// default rather than a narrower bound.
const ALL_NAMES = Object.values(readArchive().systems).map((system) => system.name);

export default function run() {
  const t = suite("ask window");

  const EARLY = 1_000_000;
  const LATE = 5_000_000;
  const first = buildSnapshot(loadedInput(EARLY));
  const second = buildSnapshot(loadedInput(LATE));

  // --- identity, before there are two windows -------------------------------
  {
    const store = createWindows();
    const a = openWindow(store, first, { now: EARLY });
    const b = openWindow(store, first, { now: EARLY });
    t.check(!a.fault && !b.fault, "two windows open on the same brief");
    t.check(a.id !== b.id, "and they are not the same window");
    t.check(/^w[a-z0-9]{8}-\d+$/.test(a.id),
      `a window id carries a per-realm prefix (${a.id})`);
    // The same argument snapshot ids already make: a bare counter lets two page
    // loads both mint w1, and a reference from one then resolves in the other.
    t.check(a.id.split("-")[0] === b.id.split("-")[0], "both from this realm");
    t.equal(windowOf(store, a.id), a, "a window is found by its id");
    t.equal(windowOf(store, "w-nope"), null, "and an id nobody minted finds nothing");
  }

  // --- the fork: it takes a snapshot and cannot make one ---------------------
  {
    const store = createWindows();
    // Every field in the right place, and not minted here. `project` returns a
    // null snapshotId for anything `buildSnapshot` did not brand, which is a
    // provenance check rather than a shape check - so a convincing forgery
    // fails it exactly as an empty object does.
    const forged = Object.freeze({
      id: "s-forged-1", takenAt: EARLY, findings: [], sets: {}, truncated: {},
      sources: [], characters: [], routing: {}, names: {}, preset: null, depth: 1,
    });
    t.check(Boolean(openWindow(store, forged, { now: EARLY }).fault),
      "a snapshot this build did not mint cannot have a window opened on it");
    t.check(Boolean(openWindow(store, null, { now: EARLY }).fault),
      "and neither can nothing at all");
    t.equal(store.open.length, 0, "so neither one joined the open set");
  }

  // --- two windows, snapshots of different ages, each showing its own --------
  //
  // This is step 6's "Done when", and it is the reason the snapshot is minted
  // on the brief path rather than at the button. A window opened before a
  // refresh keeps the brief it was opened about; one opened after gets the new
  // one. Both are correct and they disagree, which is the honest outcome.
  {
    const store = createWindows();
    const older = openWindow(store, first, { now: EARLY });
    const newer = openWindow(store, second, { now: LATE });
    t.check(older.snapshotId !== newer.snapshotId, "the two windows are about different briefs");
    t.equal(older.snapshot, first, "the first window still holds the snapshot it forked");
    t.equal(newer.snapshot, second, "and the second holds its own");

    const olderHtml = windowTemplate(older, { now: LATE });
    const newerHtml = windowTemplate(newer, { now: LATE });
    t.check(/data-live-at="1000000"/.test(olderHtml),
      "the older window's header is pinned to the older brief");
    t.check(/data-live-at="5000000"/.test(newerHtml),
      "and the newer window's to the newer one");
    t.check(olderHtml.includes("1h ago"), "so the older one reads as an hour old");
    t.check(newerHtml.includes("just now"), "and the newer one as current");
    // The tick recomputes from the span's own attributes, so a verb the span
    // does not carry reverts to "synced" a minute later. A snapshot is taken.
    t.check(/data-live-verb="taken"/.test(olderHtml),
      "and the verb travels with the span, so the tick keeps saying taken");
  }

  // --- the window is bounded ------------------------------------------------
  {
    const store = createWindows();
    for (let n = 0; n < WINDOW_LIMIT; n += 1) openWindow(store, first, { now: EARLY });
    t.equal(store.open.length, WINDOW_LIMIT, `${WINDOW_LIMIT} windows open`);
    t.check(Boolean(openWindow(store, first, { now: EARLY }).fault), "and the next is refused");
    const id = store.open[0].id;
    t.check(closeWindow(store, id), "a window closes");
    t.equal(store.open.length, WINDOW_LIMIT - 1, "and leaves the open set");
    t.check(!closeWindow(store, id), "closing it twice does nothing the second time");
    t.check(!closeWindow(store, "w-nope"), "and closing one nobody opened does nothing");
  }

  // --- one scratchpad per window --------------------------------------------
  //
  // It was specified as one fixed name in the temp directory. With two windows
  // open that is one file shared, and "cleared when the window opens" then
  // means opening the second wipes the notes the first is mid-turn on.
  {
    const store = createWindows();
    const a = openWindow(store, first, { now: EARLY });
    const b = openWindow(store, first, { now: EARLY });
    t.check(scratchpadName(a.id) !== scratchpadName(b.id),
      "two windows do not share a scratchpad");
    t.check(scratchpadName(a.id).includes(a.id), "and a scratchpad is named for its window");
  }

  // --- the question, bounded before anything else sees it -------------------
  {
    t.check(Boolean(cleanQuestion("").fault), "an empty question is refused");
    t.check(Boolean(cleanQuestion("   ").fault), "and so is whitespace");
    t.check(Boolean(cleanQuestion(null).fault), "and so is nothing at all");
    t.check(Boolean(cleanQuestion(42).fault), "and so is a number");

    // Refused, not truncated. A truncated question is a different question, and
    // it would come back answered as if it were the one that was typed.
    const long = "x".repeat(QUESTION_LIMIT + 1);
    const refused = cleanQuestion(long);
    t.check(Boolean(refused.fault), "an over-long question is refused");
    t.check(!("question" in refused), "and not quietly shortened to fit");

    // Code points, not UTF-16 units. Counted in units this is 800 and would be
    // refused, while saying the limit is 500.
    const emoji = cleanQuestion("A".repeat(0) + "\u{1F44D}".repeat(QUESTION_LIMIT - 1));
    t.check(!emoji.fault, "a question of astral characters is measured in code points");

    // Removed rather than replaced: everywhere else in this chain these become
    // U+FFFD because the string is being rendered. Here it is being *sent*, and
    // a question full of replacement characters is not the question asked.
    // Built from char codes, never written as escapes. An escape that collapses between
    // an editor and the file puts a real control byte in the literal, which changes what
    // the test sends while the code under test accepts both spellings.
    // `audit-regressions` scans for exactly that.
    const ch = code => String.fromCharCode(code);
    const dirty = cleanQuestion(`where${ch(0)}is${ch(0x202e)}the   camp ${ch(0x2028)}now`);
    t.equal(dirty.question, "where is the camp now", "control and format characters are removed");
    t.check(!dirty.question.includes(ch(0xfffd)),
      "and not replaced with a marker");
  }

  // --- it produces nothing that acts ----------------------------------------
  //
  // A rule about the markup, so a reviewer can check it without reading the
  // logic. The window is allowed to be loose precisely because nothing in it
  // can move a fleet, and that stops being true the first time something here
  // renders a control the rest of the application listens to.
  {
    const store = createWindows();
    const record = openWindow(store, first, { now: EARLY });
    const html = windowTemplate(record, { now: EARLY });
    const buttons = html.match(/<button/g) ?? [];
    t.equal(buttons.length, 2, "the window has exactly two controls: close, and ask");
    for (const acting of ["data-tactical-system", "data-region", "data-route", "data-system",
      "data-ask-open", "href="]) {
      t.check(!html.includes(acting), `the window renders no ${acting}`);
    }
    t.check(html.includes(WARNING), "the warning is on the window");
    t.check(!/may (make mistakes|be wrong)|can make mistakes/i.test(WARNING),
      "and it names this window rather than reciting boilerplate");
    t.check(/worked/.test(WARNING) && /measured/.test(WARNING),
      "it says what the two markings mean, which is the thing a pilot has to know");
  }

  // --- a figure is marked where it appears ----------------------------------
  {
    for (const mark of MARKS) {
      const html = figure(mark, "7 jumps");
      t.check(html.includes(`data-mark="${mark}"`), `a ${mark} figure carries its mark`);
      t.check(html.includes(mark), `and says "${mark}" beside the number, not in a legend`);
    }
    // An unknown mark is not a third category invented at the call site, and
    // the direction of the fallback is the whole point. It fell back to
    // `measured` - the *most* authoritative mark in the design - so a caller
    // that mistyped one, or added a register and forgot this list, had a
    // model-influenced figure badged as having come off the brief. A thing
    // reading safer than it is, is the one direction that gets somebody killed.
    t.check(figure("authoritative", "7").includes('data-mark="view"'),
      "a mark outside the set falls back to the one that claims nothing");
    t.check(!figure("authoritative", "7").includes('data-mark="measured"'),
      "and never to the one that claims the brief computed it");
    t.check(figure("measured", "<script>x</script>").includes("&lt;script&gt;"),
      "and the text is escaped, because a finding's title is still a string");
  }

  // --- a whole turn, rendered -----------------------------------------------
  //
  // The real path with the transport taken out: a reply envelope goes through
  // `consider`, the outcome becomes an entry exactly as `advisorTurn` builds
  // one, and the window renders it.
  //
  // This exists because of a defect it would have caught immediately.
  // `evaluateAll` returns `{snapshotId, results}` and `consider` renames it to
  // `figures` on the way out; the window was reading the inner name. Every turn
  // rendered an empty answer for a reply that had measured correctly - nothing
  // threw, nothing failed, and the brief was simply blank. Two modules agreeing
  // about a field name is not something either one can check alone.
  {
    const store = createWindows();
    const record = openWindow(store, first, { now: EARLY });
    const projection = project(first);
    const asked = {
      v: CONTRACT_VERSION,
      id: "c-test-1",
      ok: true,
      payload: {
        snapshotId: projection.snapshotId,
        operations: [{ op: "max", set: reference(projection, "set:chokes"), field: "routes" }],
      },
    };
    const outcome = consider(first, asked, { id: "c-test-1", systemNames: ALL_NAMES });
    t.check(!outcome.fault, `the reply is accepted (${outcome.fault ?? "no fault"})`);
    t.check(Array.isArray(outcome.figures) && outcome.figures.length === 1,
      "and carries one measured figure");

    record.entries.push({
      kind: "answer",
      figures: outcome.figures,
      read: outcome.read ?? null,
      opinion: outcome.opinion ?? null,
      opinionRefused: outcome.opinionRefused ?? null,
    });
    const html = windowTemplate(record, { now: EARLY });

    const measured = outcome.figures[0];
    t.check(html.includes(String(measured.result)), "the window renders the figure's result");
    t.check(html.includes("max"), "and says which operation produced it");
    t.check(html.includes('data-mark="worked"'), "marked worked, because code computed it from named operands");

    // The population is the safety property, not decoration: it is how a pilot
    // checks the arithmetic against figures that are not the model's. A window
    // that rendered the result and dropped these would keep the number and
    // throw away the only thing that makes the number checkable.
    t.check(html.includes("ask-rows"), "the population it measured is rendered under it");
    for (const row of measured.rendered) {
      t.check(html.includes(row.systemName), `and names ${row.systemName}, which it measured`);
    }
    t.check(html.includes(`${measured.population} measured`),
      "with the true count beside it");

    // Still nothing that acts, with a turn in it.
    t.equal((html.match(/<button/g) ?? []).length, 2,
      "and a rendered answer adds no controls");
  }

  // --- the relation and the view are sentences, not objects -----------------
  //
  // All three of a round of hostile audits found this independently, which is
  // the strongest signal any of them gave. `relations.read` returns
  // `{relation, snapshotId, findings, text}` and `opine` returns
  // `{kind, snapshotId, text}`; the window handed each whole to the escaper and
  // rendered the string `[object Object]`. Nothing threw, nothing faulted, and
  // the figures beside them rendered correctly - so a turn looked like it had
  // worked while the only two sentences in the entire chain, the things
  // `relations.js` and `opinion.js` exist to produce, were replaced by a
  // JavaScript artefact.
  //
  // The earlier turn test could not see it: it pushed `read: null`.
  {
    const store = createWindows();
    const record = openWindow(store, first, { now: EARLY });
    record.entries.push({
      kind: "answer",
      figures: [],
      read: { relation: "same_region", snapshotId: "s1-1", findings: [], text: "Tama and Nourvukaiken are in the same region." },
      opinion: { kind: "view", snapshotId: "s1-1", text: "The southern approach looks like the quieter one." },
      opinionRefused: null,
    });
    const html = windowTemplate(record, { now: EARLY });
    t.check(html.includes("are in the same region"), "the relation's own sentence is rendered");
    t.check(html.includes("looks like the quieter one"), "and so is the closing view");
    t.check(!html.includes("[object Object]"), "and neither is rendered as an object");
    t.check(html.includes('data-mark="read"') && html.includes('data-mark="view"'),
      "each marked as what it is");
  }

  // --- a route's caveats are not footnotes ----------------------------------
  //
  // `routeCaveats` counts systems the pilot put on the avoid list that the
  // route entered anyway, and gates they had marked that it had to use. A
  // route rendered as a jump count with none of that on screen is the failure
  // the avoid list exists to prevent, arriving through the one surface that is
  // allowed to speculate.
  {
    const store = createWindows();
    const record = openWindow(store, first, { now: EARLY });
    record.entries.push({
      kind: "answer",
      figures: [{
        op: "jumps_between",
        result: 11,
        operands: { from: "finding:0", to: "finding:1", character: "char:1", mode: "shortest" },
        rendered: [],
        population: 0,
        renderKind: "leg",
        renderedAll: true,
        capped: false,
        // **The real shape.** Three of these are lists and six are counts, and
        // the lists are the ones that name something. The first version of this
        // fixture used numbers throughout, which is what the renderer had
        // assumed - so the test agreed with the bug instead of catching it.
        caveats: {
          avoidedAnyway: [
            { systemId: 30002813, systemName: "Tama" },
            { systemId: 30002809, systemName: "Sujarento" },
          ],
          edgesUsedAnyway: [
            { via: "bridge", fromId: 1, toId: 2, fromName: "Jita", toName: "Perimeter" },
          ],
          wormholes: [
            // `expiresAt`, the absolute instant, is what the rendering reads -
            // `msRemaining` is measured at evaluation and never moves again, so
            // a window open for an hour went on quoting the same minutes for a
            // hole that had collapsed.
            {
              leg: 3, fromId: 5, toId: 6, fromName: "Thera", toName: "Turnur",
              msRemaining: 90 * 60 * 1000, expiresAt: EARLY + 90 * 60 * 1000, endOfLife: false,
            },
          ],
          belowHighSecurity: 4,
          hotJumps: 0,
        },
      }],
      read: null, opinion: null, opinionRefused: null,
    });
    const html = windowTemplate(record, { now: EARLY });
    t.check(/Enters 2 systems you avoid/.test(html),
      "systems the pilot avoids that the route entered anyway are said");
    t.check(html.includes("Tama") && html.includes("Sujarento"),
      "and named, which is the whole value of that caveat");
    t.check(/Uses 1 gate or bridge you marked/.test(html), "gates and bridges they had marked are said");
    t.check(html.includes("Jita to Perimeter"), "and named too");
    t.check(html.includes("Thera to Turnur"), "a wormhole the route depends on is named");
    t.check(/1h|90m/.test(html),
      `and how long it has left (${(html.match(/wormhole[^<]*/) ?? [""])[0]})`);
    // Rendered through `live-time.js` as a span, so the tick keeps counting it
    // down rather than freezing the figure at the moment the answer arrived.
    t.check(/data-live-kind="remaining"/.test(html),
      "as a span the clock keeps honest, not as text");
    t.check(/4 jumps out of high sec/.test(html), "and the counts are still counted");

    // **The one hop a pilot reads.** The suspension count crosses the freeze,
    // the thaw and `routeCaveats` with a test at each - and the label that
    // renders it had none, so deleting or mistyping the key would show a route
    // that ignored a standing avoid order as an ordinary one, with a green
    // suite. The whole change is justified by "so the panel can protest".
    {
      const store2 = createWindows();
      const held = openWindow(store2, first, { now: EARLY });
      held.entries.push({
        kind: "answer",
        figures: [{
          op: "jumps_between", result: 9, operands: { mode: "shortest" },
          rendered: [], population: 0, renderKind: "leg", renderedAll: true, capped: false,
          caveats: { avoidSuspended: 2 },
        }],
        read: null, opinion: null, opinionRefused: null,
      });
      const said = windowTemplate(held, { now: EARLY });
      t.check(/2 standing avoid entries switched off/.test(said),
        "a suspended standing order is said, not left silent");

      held.entries[0].figures[0].caveats = { avoidSuspended: 0 };
      t.check(!/standing avoid entries switched off/.test(windowTemplate(held, { now: EARLY })),
        "and a captured count of none renders nothing");
      held.entries[0].figures[0].caveats = { avoidSuspended: null };
      t.check(!/standing avoid entries switched off/.test(windowTemplate(held, { now: EARLY })),
        "and so does a record that captured nothing");
    }
    t.check(!/0 jumps through/.test(html), "a caveat of zero is not rendered as a finding");
    // The mode is the single largest determinant of the number - Jita to Amarr
    // is 11 jumps shortest and 34 high-sec-only - and it was being dropped.
    t.check(html.includes("mode shortest"), "the route mode is on screen with the figure");
    t.check(html.includes("character char:1"), "and whose access it was planned against");
  }

  // --- a refused view is said, not left as silence ---------------------------
  //
  // `opine` over-refuses by design. A model systematically tripping one bound
  // would show no closing sentence forever, indistinguishable from a terse
  // model, with nothing anywhere recording that it happened.
  {
    const store = createWindows();
    const record = openWindow(store, first, { now: EARLY });
    record.entries.push({
      kind: "answer", figures: [], read: null, opinion: null,
      opinionRefused: "that sentence counts something",
    });
    const html = windowTemplate(record, { now: EARLY });
    t.check(html.includes("was refused"), "the window says a view was offered and refused");
    t.check(html.includes("that sentence counts something"), "and why");
  }

  // --- an empty brief still opens a window ----------------------------------
  {
    const bare = buildSnapshot({ now: EARLY, brief: { items: [] } });
    const store = createWindows();
    const record = openWindow(store, bare, { now: EARLY });
    t.check(!record.fault, "a brief with no findings can still be asked about");
    const html = windowTemplate(record, { now: EARLY });
    t.check(html.includes("no findings"), "and the window says so rather than rendering nothing");
  }

  return t.results;
}
