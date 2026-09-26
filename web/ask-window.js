// The ask window: identity, the fork, and the surface a model reaches.
//
// This file holds no DOM and no transport. It mints ids, keeps the open set,
// bounds a question, and writes markup; `app.js` binds it and `advisor.js`
// carries it. That split is the same one `panels.js` already has, and it is
// what lets two windows be opened, aged and compared in a test with no browser
// and no sidecar in the room.
//
// **The window forks the brief's snapshot. It never builds one.**
//
//     brief computed -> snapshot frozen -> briefing rendered from it
//                                       -> the button forks THAT snapshot
//                                       -> every follow-up answers against it
//
// A fresh snapshot at the button would mean reading a briefing about one state
// and then asking questions about another, which is the quietest way to
// mislead somebody: nothing looks wrong, the ages differ by seconds, and the
// numbers in the window are about a universe the briefing never described.
// So `openWindow` takes a snapshot and has no path that could make one.
//
// **Identity exists before there are two windows.** A singleton "the advisor
// window" is a rewrite the moment a second view gets one, and the whole point
// of the design is that two windows may hold snapshots of different ages and
// each shows its own. Ids carry a per-realm prefix for the reason `snapshot.js`
// already gives about snapshot ids: a bare counter lets two page loads both
// mint `w1`, and a reference from one then resolves in the other.
//
// **Nothing here is a finding.** The window produces no buttons that change
// anything, enters nothing into the live store, and cannot reach the brief. It
// is the one surface where speculation is allowed, which is only defensible
// while it is visibly a different surface that does nothing.

import { escapeHtml as esc } from "./map-utils.js";
import { liveTime, liveTimeText } from "./live-time.js";
import { project } from "./snapshot.js";
// The bound lives at the door, in `advisor.js`, and the form calls the same
// function so the message a pilot reads and the rule that is enforced cannot
// drift apart. Re-exported because this module is where a surface looks for it.
import { cleanQuestion, QUESTION_LIMIT } from "./advisor.js";

export { cleanQuestion, QUESTION_LIMIT };

const REALM = Math.random().toString(36).slice(2, 10);
let minted = 0;

// Bounded like every other collection here. Four is a working ceiling rather
// than a measured one: the failure it prevents is a click that opens windows
// faster than a pilot closes them, each holding a frozen snapshot that cannot
// be garbage collected while its window is open.
export const WINDOW_LIMIT = 4;

// Where a figure came from, which is the whole of how a pilot knows what they
// are reading. `measured` came off a snapshot path and code rendered it;
// `worked` was computed by `operations.js` from operands the model named;
// `read` is a relation `relations.js` checked and wrote; `view` is the one
// sentence `opinion.js` allows, which is marked and carries no number at all.
//
// The brief carries no worked figures whatsoever, so this marking exists here
// and nowhere else in the application.
export const MARKS = Object.freeze(["measured", "worked", "read", "view"]);

export function createWindows() {
  return { open: [] };
}

function fault(message) {
  return Object.freeze({ fault: String(message) });
}

export function scratchpadName(id) {
  // One file per window, named for the window. A fixed name is shared between two
  // open windows, and "cleared when the window opens" then means opening the second
  // wipes the notes the first is mid-turn on.
  return `atlas-advisor-${String(id)}.txt`;
}

// A snapshot this window may be about.
//
// `project` returns a null `snapshotId` for anything `buildSnapshot` did not
// mint, which is the brand check rather than a shape check: a hand-assembled
// object with every field in the right place still fails it. Refusing at the
// button rather than at the crossing means a window never opens onto findings
// that came from nowhere.
export function openWindow(store, snapshot, { now = Date.now() } = {}) {
  if (!store || !Array.isArray(store.open)) return fault("there is no window store to open into");
  if (store.open.length >= WINDOW_LIMIT) {
    return fault(`${WINDOW_LIMIT} windows are already open, which is as many as this holds`);
  }
  let projected;
  try {
    projected = project(snapshot);
  } catch {
    return fault("that snapshot could not be read, so there is nothing to ask about");
  }
  if (!projected || projected.snapshotId === null) {
    return fault("this brief was not minted here, so there is nothing to ask about");
  }
  minted += 1;
  const record = {
    id: `w${REALM}-${minted}`,
    // **The snapshot, held by reference and never replaced.** A later brief
    // mints a later snapshot; a window already open keeps the one it forked,
    // which is how two windows come to disagree honestly.
    snapshot,
    snapshotId: projected.snapshotId,
    openedAt: now,
    // What the window has been told, in order. Deterministic entries only -
    // nothing here is written by a model until a reply has been through
    // `advisor.js`, and what that returns is already checked.
    entries: [],
    // What the pilot has typed and not yet sent, kept on the record so that a
    // rebuild of the markup cannot take it.
    draft: "",
    // Set while a request is out, so the surface can say so without a spinner.
    asking: false,
    error: null,
  };
  store.open.push(record);
  return record;
}

export function windowOf(store, id) {
  if (!store || !Array.isArray(store.open)) return null;
  return store.open.find(record => record.id === String(id)) ?? null;
}

export function closeWindow(store, id) {
  if (!store || !Array.isArray(store.open)) return false;
  const at = store.open.findIndex(record => record.id === String(id));
  if (at < 0) return false;
  store.open.splice(at, 1);
  return true;
}

// A figure, marked where it appears rather than in a legend.
export function figure(mark, text) {
  // **Falls back to the least authoritative mark, not the most.** `measured` is the
  // most trusted label in the design - "came off a snapshot path, rendered by code"
  // - so falling back to it badges a model-influenced figure as having come off the
  // brief, which is a figure reading safer than it is. `view` claims nothing, which
  // is the right claim about a figure whose provenance this module does not
  // recognise.
  const kind = MARKS.includes(mark) ? mark : "view";
  return `<span class="ask-figure ask-${esc(kind)}" data-mark="${esc(kind)}">`
    + `<span class="ask-mark">${esc(kind)}</span>${esc(text)}</span>`;
}

// Not "this AI may make mistakes", which every product says and nobody reads.
// It names what this window is, because the boundary being visible is the
// whole reason one window is allowed to be outside the rule that governs
// every other surface.
export const WARNING = "This window works things out. Figures marked worked were computed here "
  + "from what the model asked for; figures marked measured came off the brief. Nothing here "
  + "moves a fleet, and the brief is where decisions are made.";

export function windowTemplate(record, { now = Date.now() } = {}) {
  if (!record) return "";
  const taken = Number.isFinite(record.snapshot?.takenAt) ? record.snapshot.takenAt : null;
  // **Always, and not on hover.** Two windows may hold snapshots of different
  // ages and the only way a pilot can tell is if each says so without being
  // asked. The verb travels with the span so the tick keeps saying "taken"
  // rather than reverting to "synced" a minute later.
  const age = taken === null ? "" : liveTime("age", taken, { now, embedded: true, verb: "taken" });
  const findings = Array.isArray(record.snapshot?.findings) ? record.snapshot.findings : [];

  return `<section class="ask-window" data-ask-window="${esc(record.id)}" aria-label="Ask about this brief">`
    + `<header class="ask-head">`
      + `<h2 class="ask-title">Ask about this brief</h2>`
      + `<p class="ask-age">Brief ${age || "taken at an unknown time"}</p>`
      + `<button type="button" class="ask-close" data-ask-close="${esc(record.id)}" `
        + `title="Close this window" aria-label="Close this window">&times;</button>`
    + `</header>`
    + `<p class="ask-warning">${esc(WARNING)}</p>`
    + `<div class="ask-findings">`
      + (findings.length === 0
        ? `<p class="ask-note">This brief made no findings.</p>`
        : `<ol class="ask-finding-list">${findings.map(item => (
            `<li><span class="ask-finding-id">${esc(item.id)}</span>`
            + `${figure("measured", item.title)}`
            + (item.detail ? `<span class="ask-detail">${esc(item.detail)}</span>` : "")
            + `</li>`
          )).join("")}</ol>`)
    + `</div>`
    + `<div class="ask-log">${record.entries.map(entry => entryTemplate(entry, now)).join("")}</div>`
    + (record.error ? `<p class="ask-error">${esc(record.error)}</p>` : "")
    // `method="dialog"` is the static floor. Inertness otherwise depends entirely on
    // `app.js` binding `onsubmit`, and if anything threw before that loop, clicking
    // Ask performs a real GET submit - which in a build whose frontend is compiled
    // in reloads the application, destroying the brief, every open window and every
    // snapshot they forked.
    + `<form class="ask-form" method="dialog" data-ask-form="${esc(record.id)}">`
      + `<label class="ask-label" for="ask-q-${esc(record.id)}">Your question</label>`
      + `<textarea id="ask-q-${esc(record.id)}" class="ask-input" rows="2" `
        + `${record.asking ? "disabled" : ""}>${esc(record.draft ?? "")}</textarea>`
      + `<button type="submit" class="ask-send" ${record.asking ? "disabled" : ""}>`
        + `${record.asking ? "Asking" : "Ask"}</button>`
    + `</form>`
    + `</section>`;
}

// How many turns a window keeps. A window a pilot leaves open for an evening
// would otherwise grow without limit, holding every figure of every turn.
export const TURN_LIMIT = 20;

// One row of a measured population.
//
// Three shapes exist and `renderKind` says which, so nothing here sniffs for a
// missing field. All three carry a system; a member and a sample carry a value,
// a leg carries its position in the route. The **name comes off the row**,
// which is a name `operations.js` resolved out of the snapshot's own record -
// this side never looks one up.
function rowTemplate(kind, row, now) {
  if (!row) return "";
  const where = row.systemName ? esc(row.systemName) : esc(`system ${row.systemId}`);
  // A leg carries its position in the route; a sample carries **when it was
  // taken**, without which a delta is two identical system names and two bare
  // numbers in an order a pilot cannot determine.
  //
  // Through `live-time.js`, because nothing else in this project formats a time -
  // and because "2026-09-24 14:00" tells a pilot under fire less than "measured 3h
  // ago", which also keeps moving.
  const lead = kind === "leg" ? `${esc(row.leg)}. `
    : kind === "sample" && Number.isFinite(row.at)
      ? `${liveTime("age", row.at, { now, embedded: true, verb: "measured" })} ` : "";
  const value = row.value === undefined || row.value === null ? "" : esc(row.value);
  return `<li><span class="ask-row-where">${lead}${where}</span>`
    + (value === "" ? "" : `<span class="ask-row-value">${value}</span>`)
    + `</li>`;
}

// What the route did that the pilot had asked it not to.
//
// `routeCaveats` counts systems the pilot put on the avoid list that the route
// entered anyway, and gates and bridges they had marked that it had to use.
// These are **pilot-safety facts, not footnotes**: a route rendered as
// "11 jumps" through a system somebody personally typed into the avoid box,
// with nothing on screen saying so, is the failure the avoid list exists to
// prevent, arriving through the one surface that is allowed to speculate.
// **Seven of these are counts and three are lists.** The three lists are the three
// that name something, and they matter most: which systems the pilot avoids that
// the route entered, which marked gates it used, and which wormholes it depends on.
// A filter written for numbers drops all three in silence.
const CAVEAT_COUNTS = Object.freeze({
  avoidSuspended: "standing avoid entries switched off, so this route ignored them",
  belowHighSecurity: "jumps out of high sec",
  hotJumps: "jumps through systems with recent kills",
  // An Ansiblex has to be online *and* fuelled, and no API reports either - so
  // a leg that uses one is a leg that might not be there when you arrive.
  bridgeJumps: "jumps riding an Ansiblex that has to be online and fuelled",
  wormholeJumps: "jumps through a hole that has to still be open",
  lapsedLinks: "connections that had already died when this was planned",
  unknownLinks: "connections of a kind this build cannot fly",
});

function names(rows, of) {
  return rows.slice(0, 8).map(of).filter(Boolean).map((text) => esc(text)).join(", ");
}

function caveatTemplate(caveats, now) {
  if (!caveats || typeof caveats !== "object") return "";
  const said = [];

  // Named first, because a pilot who typed a system into the avoid box and is
  // being routed through it anyway needs that before any number.
  const avoided = Array.isArray(caveats.avoidedAnyway) ? caveats.avoidedAnyway : [];
  if (avoided.length > 0) {
    said.push(`<li><strong>Enters ${esc(avoided.length)} system${avoided.length === 1 ? "" : "s"} you avoid:</strong> `
      + `${names(avoided, (row) => row.systemName ?? `system ${row.systemId}`)}</li>`);
  }

  const edges = Array.isArray(caveats.edgesUsedAnyway) ? caveats.edgesUsedAnyway : [];
  if (edges.length > 0) {
    said.push(`<li><strong>Uses ${esc(edges.length)} gate${edges.length === 1 ? "" : "s"} or bridge${edges.length === 1 ? "" : "s"} you marked:</strong> `
      + `${names(edges, (row) => (row.fromName && row.toName ? `${row.fromName} to ${row.toName}` : null))}</li>`);
  }

  // A wormhole says how long it had left **when the brief was taken**, which is
  // not how long it has left now - and "open when I asked" is not "open when
  // you arrive". The instant is absolute so the tick keeps it honest.
  const holes = Array.isArray(caveats.wormholes) ? caveats.wormholes : [];
  for (const leg of holes) {
    const where = leg.fromName && leg.toName ? `${leg.fromName} to ${leg.toName}` : `leg ${leg.leg}`;
    // The **absolute** instant, so the tick recomputes it. `now + msRemaining` is a
    // delta re-anchored to whatever `now` was handed in, which makes the difference
    // `describeRemaining` takes constant and the text never move.
    const left = Number.isFinite(leg.expiresAt)
      ? liveTime("remaining", leg.expiresAt, { now, embedded: true })
      : "with no expiry recorded";
    said.push(`<li>${leg.endOfLife === true ? "<strong>End of life:</strong> " : ""}`
      + `wormhole ${esc(where)}, ${left}</li>`);
  }

  for (const key of Object.keys(CAVEAT_COUNTS)) {
    const held = caveats[key];
    if (!Number.isFinite(held) || held <= 0) continue;
    said.push(`<li>${esc(held)} ${esc(CAVEAT_COUNTS[key])}</li>`);
  }

  if (said.length === 0) return "";
  return `<ul class="ask-caveats">${said.join("")}</ul>`;
}

// One figure, with **the population it measured shown underneath it**.
//
// That rendering is not presentation. It is how a pilot checks arithmetic
// against figures that are not the model's, and it is the reason an operation
// returns `rendered` at all - so a window that showed the result and dropped
// the population would keep the number and throw away the only thing that makes
// the number checkable. `population` and `renderedAll` say whether the check
// available is the whole set or only the top of it, and `capped` says the
// measurement itself was over what survived truncation.
function figureTemplate(result, now) {
  if (!result) return "";
  const operands = result.operands && typeof result.operands === "object" ? result.operands : {};
  // **Every operand, not a pick list.** A pick list renders `jumps_between` as
  // "jumps_between = 11" with no endpoints, no character and no route mode - the
  // single largest determinant of the number, since Jita to Amarr is 11 jumps
  // shortest and 34 high-sec-only. A `delta` loses the gap it actually measured and
  // a `compare` the findings it compared. All of them are ids, numbers or vocabulary
  // members this side minted or validated.
  const over = Object.entries(operands)
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .map(([key, value]) => `${esc(key)} ${esc(Array.isArray(value) ? value.join(", ") : value)}`)
    .join(" \u00b7 ");
  const rows = Array.isArray(result.rendered) ? result.rendered : [];
  const shown = result.renderedAll === false
    ? `${rows.length} of ${esc(result.population)} shown`
    : `${esc(result.population)} measured`;
  return `<div class="ask-result">`
    + `<p>${figure("worked", `${result.op} = ${result.result}`)}</p>`
    + (over ? `<p class="ask-operands">${over}</p>` : "")
    + `<p class="ask-population">${shown}`
      + (result.capped ? ", over a set that was truncated before it was measured" : "")
    + `</p>`
    + caveatTemplate(result.caveats, now)
    + (rows.length === 0 ? "" : `<ol class="ask-rows">${
        rows.map(row => rowTemplate(result.renderKind, row, now)).join("")
      }</ol>`)
    + `</div>`;
}

// One turn, rendered. Every part of it has already been through the code that
// checks it: the figures through `operations.js`, the sentence through
// `relations.js`, the closing view through `opinion.js`. Nothing here decides
// whether something may be shown - it decides how it looks once it may.
function entryTemplate(entry, now) {
  if (!entry) return "";
  if (entry.kind === "question") {
    return `<p class="ask-asked">${esc(entry.text)}</p>`;
  }
  const figures = Array.isArray(entry.figures) ? entry.figures : [];
  return `<div class="ask-answer">`
    + figures.map(result => figureTemplate(result, now)).join("")
    // **`.text`, not the record.** `relations.read` returns
    // `{relation, snapshotId, findings, text}` and `opine` returns
    // `{kind, snapshotId, text}`, so handing either to `esc` renders
    // `[object Object]` - silently, with the figures beside it correct. These are
    // the only two sentences in the chain.
    + (entry.read?.text ? `<p class="ask-read">${figure("read", entry.read.text)}</p>` : "")
    + (entry.opinion?.text ? `<p class="ask-view">${figure("view", entry.opinion.text)}</p>` : "")
    // Said, rather than left as silence. A refused view and no view offered look
    // identical otherwise, and one of them is a model tripping a bound every time
    // with nobody finding out.
    + (entry.opinionRefused
      ? `<p class="ask-refused">The advisor offered a closing view and it was refused: ${esc(entry.opinionRefused)}</p>`
      : "")
    + `</div>`;
}
