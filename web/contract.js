// The message contract: core to webview, core to sidecar.
//
// One envelope for both hops, so the core can forward a message without
// translating it. The core-to-webview hop is Tauri IPC and the core-to-sidecar
// hop is line-delimited JSON over stdin and stdout; both carry JSON objects, so
// the difference is transport and nothing else.
//
// Everything here is a pure function of its arguments. It runs in the browser
// build, where there is no core at all, and its rules are assertions rather
// than intentions - which is the only form a rule survives in.

export const CONTRACT_VERSION = 1;

// **The one function that flattens a string this module did not write**, exported so
// there is only one.
//
// A fault is read by a pilot, and a fault carrying a model's or a far end's own
// string is a free-text slot on a pilot's surface. Control characters are collapsed
// because a right-to-left override reverses the rendering of everything after it -
// so the sentence this module wrote reads backwards after the part the model wrote -
// and a newline turns one line into two that look like separate statements.
//
// `String()` also runs a caller's `toString`, which can throw, so the conversion is
// guarded rather than trusted.
//
// The boundaries that matter most are the ones a *model-supplied* string crosses:
// `referenceFault` in `snapshot.js` interpolates `operand.ref` and
// `operand.snapshot` into a refusal, and that refusal reaches the ask window as
// `record.error`. A copy that bounds length and flattens nothing is not this
// function, which is why there is one of it and it lives in the module that imports
// nothing.
export function safe(value) {
  let text;
  try {
    text = String(value);
  } catch {
    return "<unprintable>";
  }
  const flattened = text.replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu, "\ufffd");
  // **Code points, not UTF-16 units.** Slicing units splits a surrogate pair and
  // emits a lone surrogate, which is not encodable as UTF-8 - a transport either
  // throws on it or replaces it, so what a pilot reads is not what was checked.
  const points = [...flattened];
  return points.length > 60 ? `${points.slice(0, 60).join("")}...` : flattened;
}

// **Frozen has to mean frozen, at every level.**
//
// `Object.freeze` is one level deep, so a frozen table of plain literals is a sealed
// table of *mutable rows*. One assignment anywhere in the webview -
// `OPS["advisor.ask"].payload["snapshot?"] = "object"` - and `parseMessage` accepts
// a snapshot crossing a process boundary, which is the one shape the whole design
// forbids.
//
// Cycle-safe, because a table that grows a self-reference should not turn a guard
// into a stack overflow.
function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return value;
  seen.add(value);
  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && "value" in descriptor) deepFreeze(descriptor.value, seen);
  }
  return Object.freeze(value);
}

// A closed set, so a caller branches on a code rather than on message text. Message
// text is for a person; a code is for the program.
//
// The three that look similar are the three that matter most, and conflating them
// breaks a law rather than a feature:
//
//   `absent`        we asked, and there is genuinely nothing there.
//   `scope-absent`  we are not permitted to know, so we do not.
//   `no-token`      there is no character to ask as.
//
// Only the first is an answer. The other two are the absence of one, and an absent
// fact is reported absent rather than approximated: one code for all three would
// make "nothing is there" indistinguishable from "we could not look".
export const ERRORS = deepFreeze([
  "malformed",
  "version-mismatch",
  "unknown-op",
  "refused",
  "absent",
  "no-token",
  "scope-absent",
  "upstream-refused",
  "offline",
  "sidecar-absent",
  // The browser build has no core at all, and a build that routes an op
  // nowhere is the same absence one step in. "refused" would read as the far
  // end declining, which is a different fact and the kind this list exists to
  // keep apart.
  "core-absent",
]);

// What may be asked, and of whom. An op that is not here cannot be sent and
// cannot be served; both ends check against the same list.
export const OPS = deepFreeze({
  // --- persistence, and deliberately nothing more ---------------------------
  // The sighting store stays in JavaScript with its assertions. The core
  // replaces local storage, which has a hard quota of a few megabytes - about
  // twenty-five thousand observations - and that quota is the only reason the
  // history-clearing flow had to exist. What crosses this boundary is the
  // serialised store, not questions about it: there is no `sightings.query`,
  // because answering one would mean a second implementation of logic that is
  // already tested.
  "sightings.load": { to: "core", payload: {} },
  "sightings.save": { to: "core", payload: { store: "object" } },

  // --- tokens, which the webview never receives ------------------------------
  // The core holds the refresh token *and* the access token, and calls ESI
  // itself. The webview asks for data and is given data.
  // No payload, and that is the design rather than a simplification. `token_begin`
  // takes no arguments and requests the core's own `FIRST_SLICE_SCOPES`.
  //
  // The core choosing is the safer half. A page that can name the scopes it wants is
  // a page that can ask a pilot to consent to `esi-skills` while looking like it is
  // asking for a map - and this one renders player-supplied killmail and alliance
  // text. The webview asks to sign a character in; what that character is allowed to
  // do is not its decision.
  //
  // Per-feature scopes are the intent, and CCP's guidance. When that lands the
  // payload becomes a feature name and the core maps it to scopes.
  "token.begin": { to: "core", payload: {} },
  "token.characters": { to: "core", payload: {} },
  "token.forget": { to: "core", payload: { characterId: "number" } },
  "esi.get": { to: "core", payload: { route: "string", characterId: "number", "params?": "object" } },

  // --- a character's portrait ------------------------------------------------
  // A non-secret picture, cached to disk by the core. Here because this table is
  // held against the application's registered commands rather than kept beside it -
  // a vocabulary nothing checks is a vocabulary that describes a different build.
  "portrait.get": { to: "core", payload: { characterId: "number" } },

  // --- the advisor, which the core forwards without reading ------------------
  //
  // **A projection, never a snapshot.** The snapshot holds standings, avoid notes,
  // bridge labels and every name a player typed. No op carries one across a process
  // boundary, and this declaration is where that is enforced rather than intended.
  "advisor.consider": { to: "advisor", payload: { projection: "object" } },

  // **Two ops rather than one with an optional `question?`.**
  //
  // The reply shape is identical for both, so one op with an optional field is the
  // tempting move. Take the second op instead: with two, a question on the brief
  // path is an *unknown field*, which `payloadFault` refuses on sight. With one it
  // is a valid payload that a bug filled in, and the brief - the authoritative
  // surface, with no worked figures in it at all - would carry a pilot's prose to a
  // model with nothing saying so.
  //
  // That is the difference between making a thing unsayable and remembering not to
  // say it, for the price of one table entry.
  //
  // The question is the only free text that ever crosses this boundary. It is the
  // pilot's own, bounded at the door before it reaches here, and nothing on the
  // return path echoes it.
  "advisor.ask": { to: "advisor", payload: { projection: "object", question: "string" } },

  // --- is there an advisor at all -------------------------------------------
  //
  // To the **core**, not the advisor: asking the advisor whether the advisor is
  // running is a question that cannot be answered when the answer is no.
  //
  // Narrow on purpose. `shell_status` already reports `sidecar_running` and is
  // deliberately unreached from the page; reaching it would also hand the
  // webview `sidecar_pid` and the supervisor's note, and the webview has no
  // business with either. This answers one boolean.
  "advisor.available": { to: "core", payload: {} },
});

// A table read by a name that came from outside.
//
// `OPS["constructor"]` is truthy on any ordinary object, because every object
// inherits from `Object.prototype` - so a plain member access lets an unknown-op
// guard skip and hands `payloadFault` a function to validate against. For a table
// of operations or relations it means a model naming a member the vocabulary does
// not contain and getting a function back.
//
// `Object.hasOwn` rather than a blocklist, because a blocklist is a list somebody
// has to keep complete. Exported, since this module imports nothing and is therefore
// where a shared primitive can live; `safe()` is here for the same reason.
export function lookup(table, name) {
  return typeof name === "string" && Object.hasOwn(table, name) ? table[name] : undefined;
}

export function opNames() {
  return Object.keys(OPS);
}

// --- the envelope --------------------------------------------------------------

export function request(op, payload = {}, { id } = {}) {
  const spec = lookup(OPS, op);
  if (!spec) throw new Error(`unknown op: ${op}`);
  if (id === undefined || id === null || id === "") throw new Error("a request needs an id");
  // Validated here, not only at the far end. A sender that can build
  // `characterId: [1, 2]` and only discover at the receiver that it is malformed can
  // say the thing the contract calls unsayable - the same shape as validating a form
  // on the server and calling the field impossible.
  const fault = payloadFault(spec.payload, payload);
  if (fault) throw new Error(`${op}: ${fault}`);
  return { v: CONTRACT_VERSION, id: String(id), op, payload };
}

export function reply(id, payload = {}) {
  return { v: CONTRACT_VERSION, id: String(id), ok: true, payload };
}

export function failure(id, code, message = "") {
  if (!ERRORS.includes(code)) throw new Error(`unknown error code: ${code}`);
  return { v: CONTRACT_VERSION, id: String(id), ok: false, error: { code, message: String(message) } };
}

export function event(name, payload = {}, { stream = null } = {}) {
  return { v: CONTRACT_VERSION, event: String(name), stream: stream === null ? null : String(stream), payload };
}

// Refused whole, never read in part.
//
// The same rule the live store already follows for a save it cannot read: a
// message of another version is left alone rather than half-interpreted,
// because a partially understood message is worse than an unread one. It looks
// like it worked.
export function parseMessage(input) {
  let message = input;
  if (typeof input === "string") {
    try {
      message = JSON.parse(input);
    } catch (error) {
      return { ok: false, error: { code: "malformed", message: String(error.message ?? error) } };
    }
  }
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return { ok: false, error: { code: "malformed", message: "not an object" } };
  }
  if (message.v !== CONTRACT_VERSION) {
    return {
      ok: false,
      error: {
        code: "version-mismatch",
        message: `message is version ${safe(message.v)} and this build speaks version ${CONTRACT_VERSION}`,
      },
    };
  }
  if (typeof message.event === "string") return { ok: true, kind: "event", message };
  if (typeof message.id !== "string" || message.id === "") {
    return { ok: false, error: { code: "malformed", message: "no id" } };
  }
  if (typeof message.op === "string") {
    const spec = lookup(OPS, message.op);
    if (!spec) {
      return { ok: false, error: { code: "unknown-op", message: message.op } };
    }
    const fault = payloadFault(spec.payload, message.payload);
    if (fault) return { ok: false, error: { code: "malformed", message: fault } };
    return { ok: true, kind: "request", message };
  }
  if (message.ok === true) return { ok: true, kind: "reply", message };
  if (message.ok === false) {
    const code = message.error?.code;
    if (!ERRORS.includes(code)) {
      return { ok: false, error: { code: "malformed", message: `unknown error code: ${safe(code)}` } };
    }
    return { ok: true, kind: "failure", message };
  }
  return { ok: false, error: { code: "malformed", message: "neither a request, a reply nor an event" } };
}

function payloadFault(shape, payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "payload is not an object";
  for (const [declared, kind] of Object.entries(shape)) {
    // Optional is spelled on the field, not on the type: `"read?": "object"`. Both
    // spellings would work, which is one convention too many in a table whose whole
    // job is to be read exactly.
    const optional = declared.endsWith("?");
    const field = optional ? declared.slice(0, -1) : declared;
    const want = kind;
    const value = Object.hasOwn(payload, field) ? payload[field] : undefined;
    if (value === undefined || value === null) {
      if (optional) continue;
      return `payload is missing ${field}`;
    }
    const got = Array.isArray(value) ? "array" : typeof value;
    // The law's own case, named before the general type check reaches it. A list of
    // characters is what "a route is planned against one character's access, never
    // the union" forbids, and it is the shape a caller reaches for when they want
    // the union. "payload.characterId is array, expected number" is correct and
    // describes a typo rather than the rule being broken.
    if (field === "characterId" && Array.isArray(value)) {
      return "payload.characterId must be a single character, not several";
    }
    if (got !== want) return `payload.${field} is ${got}, expected ${want}`;
    // The routing law, encoded where it cannot be forgotten: a route is planned
    // against one character's access, never the union of several. An op that
    // takes a characterId takes exactly one, so a union request is not a thing
    // this contract can express.
    if (field === "characterId" && !Number.isInteger(value)) {
      return "payload.characterId must be a single character";
    }
  }
  // Anything it did not declare is refused rather than ignored: a message carrying
  // a field this build does not understand is a message it cannot claim to have
  // read.
  //
  // `Reflect.ownKeys`, not `Object.keys`. The declared-field read above uses
  // `Object.hasOwn`, and the two disagree about a non-enumerable own property and
  // about a Proxy with an `ownKeys` trap, so an extra field could be hidden from the
  // refusal while still being readable. JSON produces neither shape; the IPC-object
  // path this contract also serves does.
  for (const field of Reflect.ownKeys(payload)) {
    if (typeof field === "symbol") return "payload has a field that is not a name";
    if (!Object.hasOwn(shape, field) && !Object.hasOwn(shape, `${field}?`)) {
      return `payload has no ${safe(field)}; it takes ${Object.keys(shape).join(", ") || "nothing"}`;
    }
  }
  return null;
}

// What a reply may carry, per op. `REPLIES` mirrors `OPS` because the direction
// carrying a foreign process's output is the direction most easily left unchecked.
//
// `?` marks a field that may be absent. Absent is not null: a reply that omits
// `read` is a model that chose not to relate two findings, which is a different fact
// from one that tried and produced nothing.
//
// **One object, two keys.** A brief and a question are asked differently and
// answered identically, and two copies of one shape drift - the one that drifts
// being whichever has fewer tests.
const ADVISOR_REPLY = deepFreeze({
  snapshotId: "string",
  operations: "array",
  "read?": "object",
  "opinion?": "string",
});

export const REPLIES = deepFreeze({
  "sightings.load": { "store?": "object" },
  "sightings.save": { bytes: "number" },
  "token.begin": { character: "object" },
  "token.characters": { characters: "array" },
  "token.forget": {},
  "portrait.get": { "dataUrl?": "string" },
  "esi.get": { "body?": "object" },

  // --- the advisor ------------------------------------------------------------
  //
  // **This is where a model's output enters the application.** Four fields and no
  // others: which brief it is about, the operations it wants computed, at most one
  // relation it wants stated, and at most one sentence of its own.
  //
  // No results. The model names what to measure and *this side* measures it - a
  // figure that arrived over the wire is a figure nobody computed. No prose beyond
  // `opinion`, which `opinion.js` bounds four ways. No ids of its own.
  "advisor.consider": ADVISOR_REPLY,
  "advisor.ask": ADVISOR_REPLY,

  // One boolean and nothing else. Not the pid, not the supervisor's note.
  "advisor.available": { running: "boolean" },
});

// A reply, checked the way a suggestion is. Unknown fields refused.
export function replyFault(op, payload) {
  const shape = lookup(REPLIES, op);
  if (!shape) return `no reply is declared for ${typeof op === "string" ? op : "that"}`;
  return payloadFault(shape, payload);
}

// A reply that arrives after the question stopped mattering is dropped rather than
// applied: a late answer overwriting a newer state is how a panel ends up describing
// a route that is no longer on screen.
export function isReplyTo(message, id) {
  return Boolean(message) && message.id === String(id);
}

// The ops the advisor answers, as opposed to the ops the core answers. They share
// one pipe, which is legal because the envelope carries `op`, and that does not
// weaken the rule that no two *core* ops may share a typed command.
export const ADVISOR_OPS = deepFreeze(
  Object.keys(OPS).filter((op) => OPS[op].to === "advisor"),
);

// --- suggestions ---------------------------------------------------------------
//
// The advisor returns language and structured suggestions, and deterministic
// code executes those only on a pilot's click. So a suggestion is a closed shape
// naming an id, never a name: resolving a name is itself an action, and a name
// is player-supplied text. `reason` is carried for display and is never read as
// an instruction.
export const SUGGESTIONS = deepFreeze({
  "avoid-system": { systemId: "number" },
  "avoid-region": { regionId: "number" },
  "clear-avoid": { target: "string", key: "string" },
  "route-to": { systemId: "number" },
  "open-system": { systemId: "number" },
  "set-mode": { mode: "string" },
  "sync-layer": { layer: "string" },
});

export function suggestionFault(suggestion) {
  if (!suggestion || typeof suggestion !== "object" || Array.isArray(suggestion)) return "not an object";
  const shape = lookup(SUGGESTIONS, suggestion.action);
  if (!shape) return `unknown action: ${suggestion.action}`;
  for (const [field, want] of Object.entries(shape)) {
    const value = suggestion[field];
    const got = Array.isArray(value) ? "array" : typeof value;
    if (got !== want) return `${suggestion.action}.${field} is ${got}, expected ${want}`;
  }
  // Anything else it invented is refused rather than ignored. A suggestion
  // carrying a field this build does not understand is a suggestion this build
  // cannot claim to have executed faithfully.
  const allowed = new Set([...Object.keys(shape), "action", "reason"]);
  for (const field of Object.keys(suggestion)) {
    if (!allowed.has(field)) return `${suggestion.action} carries an unknown field: ${field}`;
  }
  return null;
}
