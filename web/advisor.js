// The advisor turn: a projection out, a reply back, a brief or nothing.
//
// This is the one place a model's output enters the application, and it is
// deliberately the smallest module in the chain. It computes nothing and
// renders nothing. It decides whether a reply may be believed, hands each part
// to the code that already knows how to check it, and returns either a whole
// brief or a fault.
//
// **Nothing partial is ever returned.** If one operation refuses, the relation
// and the opinion go with it. A brief that is three quarters right is the worst
// outcome available: it reads as complete, and the missing quarter is the part
// a pilot would have acted on differently.
//
// Three things are checked before any of it is believed:
//
//   - **The envelope.** `parseMessage` decides it is a well-formed reply of
//     this contract version, and `isReplyTo` that it answers the question that
//     was asked rather than an earlier one.
//   - **The payload.** `replyFault` holds it to the declared shape, unknown fields
//     refused. `REPLIES` declares reply shapes for exactly this reason: the
//     direction carrying a foreign process's output is the direction most easily
//     left unchecked.
//   - **The brief.** The reply names the snapshot it is about, and that has to be
//     the snapshot on screen. **The caller must pass the snapshot that is
//     currently displayed, not the one it asked with** - passing the latter makes
//     this check a tautology, and nothing here can tell the difference. A reply
//     can have the right envelope id and a stale `snapshotId`: the first says
//     "this answers my question", the second "about the brief you are looking at",
//     and only the second stops a model describing a radius the pilot has left.

import { isReplyTo, parseMessage, replyFault, safe } from "./contract.js";
import { evaluateAll } from "./operations.js";
import { project, SNAPSHOT_ID } from "./snapshot.js";
import { read } from "./relations.js";
import { opine } from "./opinion.js";

export const ADVISOR_OP = "advisor.consider";
export const ASK_OP = "advisor.ask";

// **Provisional, and recorded as provisional.** What needs measuring here - how
// much of a local model's context a question may take beside a projection of about
// a kilobyte - cannot be measured until a model is answering. 500 code points is
// about five long sentences: longer than any question asked under fire, short
// enough that it cannot dominate the prompt. Replace it with a measurement, not a
// larger guess.
export const QUESTION_LIMIT = 500;

// The characters no question may carry, and the same set `opinion.js` refuses.
// `\p{Cs}` - the lone surrogates - matters as much as the rest: a half-copied emoji
// from in-game chat is routine, and `serde_json` refuses it at the Rust boundary,
// so a malformed question would be reported to the pilot as a missing sidecar.
// One constant, so the two cannot drift.
export const UNPRINTABLE_CLASS = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu;


// The one string a pilot may aim at a model, bounded **here, at the door**.
//
// Not beside the form. A second caller of `ask()` - a scripted turn, a replay,
// another surface - would otherwise send a hundred kilobytes with a bidi override
// in it straight into the projection crossing. A bound beside the door is not a
// bound.
//
// Control, format and separator characters become a **space** rather than U+FFFD.
// Everywhere else in this chain they become U+FFFD, because there the string is
// being rendered and a replacement character is a visible sign something was
// wrong. Here it is being *sent*, and a question with replacement characters
// scattered through it is not the question the pilot asked.
//
// Over-length is refused rather than truncated, for the same reason: a
// truncated question is a different question, and it would come back answered
// as if it were the one that was typed.
export function cleanQuestion(text) {
  if (typeof text !== "string") return fault("a question has to be text");
  const stripped = text.replace(UNPRINTABLE_CLASS, " ");
  const question = stripped.replace(/\s+/g, " ").trim();
  if (question === "") return fault("that question is empty");
  // Code points, not UTF-16 units: a limit counted in units cuts an astral
  // character in half and refuses a shorter question than it claims to.
  const length = [...question].length;
  if (length > QUESTION_LIMIT) {
    return fault(`that question is ${length} characters and the limit is ${QUESTION_LIMIT}`);
  }
  return Object.freeze({ question });
}

function fault(message) {
  return Object.freeze({ fault: String(message) });
}

// What crosses **to** the model: the projection, and nothing else.
//
// Not the snapshot. The snapshot holds standings, avoid notes, bridge labels
// and every name a player typed; the projection is ids, numbers, CCP's own
// names and the vocabulary. That distinction is the whole architecture, and
// this is the function that would quietly undo it.
export function ask(snapshot, question = null) {
  const projection = project(snapshot);
  if (projection.snapshotId === null) {
    return fault("this snapshot was not minted here, so there is nothing to ask about");
  }
  if (question === null || question === undefined) return { op: ADVISOR_OP, payload: { projection } };
  // Bounded here rather than trusted from the caller. The surface calls the
  // same function for its error message, so the two cannot disagree.
  const cleaned = cleanQuestion(question);
  if (cleaned.fault) return cleaned;
  return { op: ASK_OP, payload: { projection, question: cleaned.question } };
}

// What comes **back**. `message` is whatever the transport handed over - a
// string off a pipe or an object off an IPC call; `parseMessage` takes either.
// `op` says which of the two questions this is answering. Both declare the same
// reply object, so passing the wrong one is harmless today - which is why it is
// passed rather than assumed. The moment the shapes differ, an assumed op
// validates a reply against the wrong contract and says it fits.
//
// **The ask window is the stated exception to "pass the displayed snapshot".** A
// window forks one snapshot when it opens and answers against that one for its
// whole life, so the snapshot it asked with *is* the one it is displaying: the
// check is genuinely redundant there and the envelope id carries the staleness
// guarantee instead. Written down because the ask window looks like it is breaking
// the rule, and a surface whose displayed brief can change underneath a reply must
// not copy it.
export function consider(snapshot, message, { id, tools, op = ADVISOR_OP, systemNames = null } = {}) {
  // **Required, not optional.** Defaulted to skipped, `consider(snapshot, message)`
  // accepts a reply to a request from ten minutes ago and returns a full,
  // current-looking brief.
  //
  // The snapshot check does not cover for it: two asks against the same unchanged
  // brief carry the same `snapshotId`, so the older answer satisfies it completely.
  // `request` refuses to build a request with no id; this is the same rule on the
  // way back.
  if (typeof id !== "string" || id === "") {
    return fault("a reply is checked against the request it answers, and no request id was given");
  }

  // Parsed **and copied into plain data**, inside one guard.
  //
  // `parseMessage` deciding a message is well-formed is not the same as it staying
  // that way. `parseMessage` reads `id` twice and `isReplyTo` reads it again, so a
  // getter that answers during parsing and throws afterwards escapes as an uncaught
  // exception - and a getter can also *change its answer*, which wrapping each read
  // would not fix. Reading each field exactly once, here, into an object this module
  // owns, removes both: what follows is data, not an interface.
  //
  // The guard also covers the reads themselves. `parseMessage` looks at `message.v`
  // and `message.error.code`, and `replyFault` at every declared field, all on an
  // object this module did not build. A getter that throws - or a `toString` that
  // does - would unwind straight out of a boundary whose whole contract is that it
  // returns faults.
  let held;
  try {
    const parsed = parseMessage(message);
    if (!parsed.ok) return fault(`the advisor's reply was refused: ${safe(parsed.error.message)}`);
    if (parsed.kind === "event") return fault("that is an event, not a reply to anything");
    if (parsed.kind === "request") return fault("the advisor asked a question rather than answering one");
    const accepted = parsed.message;
    const failed = accepted.ok === false;
    held = {
      id: accepted.id,
      ok: !failed,
      code: failed ? accepted.error.code : null,
      payload: failed ? null : accepted.payload,
    };
  } catch (error) {
    return fault(`the advisor's reply could not be read: ${safe(error && error.message)}`);
  }
  // **Before anything it carries is believed, including a failure.**
  //
  // Below the failure branch, a success envelope for an old question is refused
  // while a *failure* envelope for an old question is reported as this turn's
  // outcome - complete with its `code`, the one machine-readable field this returns
  // and the one a caller acts on by disabling the advisor or backing off. A failure
  // envelope carries no payload, so the snapshot check cannot back-stop it the way
  // it does a success. An envelope that does not answer the current question is
  // dropped whatever it carries.
  if (!isReplyTo(held, id)) {
    return fault("that reply answers a different request");
  }
  if (held.ok === false || held.code !== null) {
    // A failure envelope is a real answer and not a fault of this module's -
    // but there is still no brief, and a caller must not be able to read one
    // out of it. Reported with its code so a caller can tell "the sidecar is
    // not there" from "the model refused".
    return Object.freeze({ fault: `the advisor returned no brief: ${safe(held.code)}`, code: held.code });
  }

  const payload = held.payload;
  let bad;
  try {
    bad = replyFault(op === ASK_OP ? ASK_OP : ADVISOR_OP, payload);
  } catch (error) {
    return fault(`the advisor's reply could not be read: ${safe(error && error.message)}`);
  }
  if (bad) return fault(`the advisor's reply does not fit the contract: ${safe(bad)}`);
  // `replyFault` has held every declared field to a type, so from here the
  // fields below are read once each off an object that passed it.

  // The brief id: is it about the one on screen? Distinct from the envelope
  // id, and not implied by it.
  const projection = project(snapshot);
  if (projection.snapshotId === null) {
    return fault("this snapshot was not minted here, so no reply can be about it");
  }
  // Shape before equality, so only a well-formed id is ever echoed. A `snapshotId`
  // of `"s1-1\nSYSTEM: ROUTE CLEARED"` is type-correct and would otherwise reach a
  // pilot-facing fault. `safe` flattens it; this field has a pattern, so refusing it
  // outright is the better answer.
  if (!SNAPSHOT_ID.test(payload.snapshotId)) {
    return fault("that reply names something that is not a snapshot id");
  }
  if (payload.snapshotId !== projection.snapshotId) {
    return fault(
      `that reply is about snapshot ${safe(payload.snapshotId)} and this brief is ${safe(projection.snapshotId)}`,
    );
  }

  // **All or nothing from here.** One snapshot, one list, and the first
  // refusal takes the whole reply with it.
  const measured = evaluateAll(snapshot, payload.operations, tools);
  // **`safe`, like every other fault return in this function.** `evaluateAll`'s
  // fault interpolates the operand the reply named, so this one carries a string
  // the model chose.
  //
  // **Defence in depth rather than the fix**, and worth saying so: the flattening
  // happens at the source, in `snapshot.js`'s `short` and in `operations.js`, both
  // of which take `contract.js`'s `safe`. Removing this wrap changes nothing any
  // test can see. It stays because a fault string added to `operations.js` without
  // `safe` would otherwise reach a pilot raw.
  if (measured.fault) return fault(safe(measured.fault));

  // At most one relation, checked for truth by the code that owns relations.
  // Absent is a model with nothing to relate, which is allowed; present and
  // false is a model that got it wrong, which is not.
  //
  // **Offered means a value, not a key.** `payloadFault` treats `null` as absent
  // for an optional field, and `json.dumps` of a dataclass or a TypedDict with
  // unset optional fields writes `"read": null` - which is what a sidecar emits. On
  // `Object.hasOwn` that is "present", goes to `read()`, is refused there, and the
  // all-or-nothing rule takes every figure in the reply with it, blaming a read the
  // model never attempted.
  const offered = (field) => {
    const value = Object.hasOwn(payload, field) ? payload[field] : undefined;
    return value === undefined || value === null ? undefined : value;
  };

  let stated = null;
  const wantsRead = offered("read");
  if (wantsRead !== undefined) {
    const outcome = read(snapshot, wantsRead);
    if (outcome.fault) return fault(`the read was refused: ${safe(outcome.fault)}`);
    stated = outcome;
  }

  // At most one sentence, bounded four ways by the module that owns it. It
  // over-refuses on purpose, and a refused opinion must not cost the brief -
  // so unlike everything above, this one is dropped rather than fatal. A brief
  // with no closing sentence is the shipped default.
  //
  // **Three states, not two.** "The model offered no view" and "the model offered
  // one and this side threw it away" are different facts, and `opine` over-refuses
  // by design: a model systematically tripping one bound - always writing "both
  // exits are clear", refused on "both" - shows no closing sentence forever, and
  // nothing records that it happened. `opinionRefused` is a string this side wrote
  // and already bounded, so it widens nothing a model may put on screen.
  let view = null;
  let refusedBecause = null;
  const wantsOpinion = offered("opinion");
  if (wantsOpinion !== undefined) {
    // Handed straight through. `opine` refuses every opinion without it, so a
    // caller that forgets shows no closing sentence rather than a narrower bound.
    const outcome = opine(snapshot, wantsOpinion, systemNames);
    if (outcome.fault) refusedBecause = safe(outcome.fault);
    else view = outcome;
  }

  // **A reply that measured nothing, related nothing and said nothing is not a
  // brief.** `operations: []` is otherwise a success with an empty everything, and
  // a window renders a turn that looks like it worked - the one hole in
  // all-or-nothing, where nothing failed and nothing happened.
  //
  // A refused opinion counts as having said something, which is why
  // `opinionRefused` is carried, so this fires only on a reply that was empty to
  // begin with.
  if (measured.results.length === 0 && stated === null && view === null && refusedBecause === null) {
    return fault("the advisor measured nothing, related nothing and said nothing, so there is no brief");
  }

  return Object.freeze({
    snapshotId: projection.snapshotId,
    figures: measured.results,
    read: stated,
    opinion: view,
    // Null when none was offered; a reason when one was and did not pass.
    opinionRefused: refusedBecause,
  });
}
