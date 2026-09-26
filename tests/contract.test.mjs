// The message contract, and the four laws it is supposed to make structural.
//
// This file exists because the project keeps learning the same thing: a rule
// that lives in a document is a rule someone will break by accident. The pid
// check in the shell refuses a mis-packaged sidecar instead of trusting a note
// that says "use --onedir". These are the same idea applied to messages.
//
// Four laws, and what each one becomes here:
//
//   "Routing uses one character's access, never the union."
//       -> an op that takes a characterId takes exactly one, so a union
//          request is not something this contract can express.
//
//   "An absent fact is reported absent."
//       -> `absent`, `scope-absent` and `no-token` are three different codes,
//          because an empty array for all three makes "nothing is there"
//          indistinguishable from "we were not allowed to look".
//
//   "No numbers from a model."
//       -> the narrator returns a template and deterministic code fills it. A
//          model cannot emit a wrong statistic because it cannot emit one.
//
//   "The advisor acts only through user-confirmed suggestions."
//       -> suggestions are a closed vocabulary of ids. A name is player text,
//          and resolving one is itself an action.

import fs from "node:fs";
import path from "node:path";
import { suite, ROOT } from "./helpers.mjs";
import * as contract from "../web/contract.js";
import {
  CONTRACT_VERSION, ERRORS, OPS, event, failure, isReplyTo,
  ADVISOR_OPS, opNames, parseMessage, reply, request, suggestionFault,
} from "../web/contract.js";

export default function run(app) {
  const t = suite("contract");

  // --- the envelope --------------------------------------------------------------
  const asked = request("sightings.save", { store: { observations: [] } }, { id: "7" });
  t.equal(asked.v, CONTRACT_VERSION, "a request carries the version it speaks");
  t.equal(asked.id, "7", "and the id it expects back");
  t.equal(parseMessage(asked).kind, "request", "and parses as a request");
  t.equal(parseMessage(JSON.stringify(asked)).kind, "request", "over the wire as well as in memory");

  // All three clauses of the id guard, not just the missing one. A mutation
  // sweep weakened `id === null || id === ""` to `&&` and nothing noticed,
  // because every test either supplied a real id or supplied none at all.
  for (const [id, what] of [[undefined, "missing"], [null, "null"], ["", "an empty string"]]) {
    t.throws(() => request("sightings.save", { store: {} }, { id }), "needs an id",
      `an id that is ${what} is refused at the point of writing`);
  }
  t.throws(() => request("nonsense.op", {}, { id: "1" }), "unknown op",
    "as is an op that does not exist");
  t.throws(() => failure("1", "made-up-code"), "unknown error code",
    "and a failure carrying a code nothing can branch on");

  // Refused whole, never read in part. The same rule the live store follows for
  // a save it cannot read: half-interpreting a message is worse than not
  // reading it, because it looks like it worked.
  const foreign = { ...asked, v: CONTRACT_VERSION + 1 };
  const refused = parseMessage(foreign);
  t.equal(refused.ok, false, "a message of another version is refused");
  t.equal(refused.error.code, "version-mismatch", "by version, not by content");
  t.check(/version/.test(refused.error.message), `saying which versions disagree (${refused.error.message})`);
  t.equal(parseMessage("{").error.code, "malformed", "a broken message is refused");
  t.equal(parseMessage([]).error.code, "malformed", "as is a list");
  t.equal(parseMessage({ v: CONTRACT_VERSION, id: "1" }).error.code, "malformed",
    "and one that is neither a request, a reply nor an event");
  t.equal(parseMessage({ v: CONTRACT_VERSION, id: "1", op: "no.such.op", payload: {} }).error.code,
    "unknown-op", "an unknown op is named as such rather than as malformed");

  // Every name on Object.prototype, because a table is only closed if the
  // lookup is. `OPS["constructor"]` is truthy on any ordinary object, so the
  // unknown-op guard skipped and payloadFault reached `Object.entries(undefined)`
  // and threw - in the one function whose contract is "refused whole, never read
  // in part", from a single line of JSON on a pipe.
  //
  // The original check used "no.such.op", which is not inherited from anything,
  // so it passed while the hole was open. A closed vocabulary tested only with
  // names nobody inherits is not tested at all.
  for (const inherited of ["constructor", "toString", "valueOf", "__proto__", "hasOwnProperty",
    "isPrototypeOf", "propertyIsEnumerable", "toLocaleString"]) {
    let outcome = null;
    try {
      outcome = parseMessage(JSON.stringify({ v: CONTRACT_VERSION, id: "1", op: inherited, payload: {} }));
    } catch (error) {
      outcome = { threw: String(error) };
    }
    t.equal(outcome.error?.code, "unknown-op",
      `op "${inherited}" is refused rather than inherited${outcome.threw ? ` (${outcome.threw})` : ""}`);
  }

  t.equal(parseMessage(reply("7", { bytes: 4 })).kind, "reply", "a reply parses");
  t.equal(parseMessage(failure("7", "offline", "no network")).kind, "failure", "so does a failure");
  t.equal(parseMessage(event("advisor.token", { token: "hi" }, { stream: "s1" })).kind, "event",
    "and an event, which carries no id to answer");

  // A late answer must not overwrite a newer state.
  t.check(isReplyTo(reply("7", {}), "7"), "a reply is matched to its question");
  t.check(!isReplyTo(reply("6", {}), "7"), "and one for an older question is not");
  t.check(isReplyTo(reply("7", {}), 7), "with the id compared as written, not as typed");

  // --- one character, never the union ----------------------------------------------
  //
  // A union-routed plan sends a pilot through bridges they cannot use. The rule
  // is kept by making the request unsayable rather than by checking for it
  // later: every op that names a character names exactly one.
  const single = parseMessage(request("esi.get", { route: "assets", characterId: 90000001 }, { id: "1" }));
  t.equal(single.kind, "request", "a route asked for one character is a request");

  // Refused at the point of writing, not only at the far end. A union proven unsayable
  // against the parser alone is a union `request()` builds happily and the receiver
  // calls malformed - the shape of validating a form on the server and calling the
  // field impossible.
  t.throws(() => request("esi.get", { route: "assets", characterId: [1, 2] }, { id: "1" }),
    "characterId", "a sender cannot even build a request naming two characters");
  t.throws(() => request("esi.get", { route: "assets" }, { id: "1" }),
    "missing characterId", "nor one naming none");
  t.throws(() => request("sightings.save", {}, { id: "1" }), "missing store",
    "and a save with nothing to save is refused before it is sent");

  const union = parseMessage({
    v: CONTRACT_VERSION, id: "1", op: "esi.get",
    payload: { route: "assets", characterId: [90000001, 90000002] },
  });
  t.equal(union.ok, false, "asking as several characters at once is refused");
  // The message names the rule rather than the type. "characterId is array" is
  // accurate and describes a typo; a list of characters is not a typo, it is
  // the union this law exists to forbid, and the error should say which of the
  // two happened.
  t.check(/single character/.test(union.error.message),
    `naming the law it broke, not just the type (${union.error.message})`);

  const fractional = parseMessage({
    v: CONTRACT_VERSION, id: "1", op: "esi.get",
    payload: { route: "assets", characterId: 1.5 },
  });
  t.equal(fractional.ok, false, "and so is anything that is not a single character");
  t.check(/single character/.test(fractional.error.message), "in those words");

  const missing = parseMessage({
    v: CONTRACT_VERSION, id: "1", op: "esi.get", payload: { route: "assets" },
  });
  t.equal(missing.ok, false, "an authenticated request with no character at all is refused");

  const optional = parseMessage(request("esi.get",
    { route: "assets", characterId: 1, params: { page: 2 } }, { id: "1" }));
  t.equal(optional.kind, "request", "while an optional field may be supplied");

  // --- three kinds of nothing ------------------------------------------------------
  for (const code of ["absent", "scope-absent", "no-token"]) {
    t.check(ERRORS.includes(code), `${code} is a code a caller can branch on`);
  }
  t.check(new Set(ERRORS).size === ERRORS.length, "the error codes are distinct");

  // --- what the webview may ask -----------------------------------------------------
  //
  // The core holds the refresh token and the access token and calls ESI itself.
  // There is no op that hands a token to the webview, and that absence is the
  // security property - so it is asserted rather than left to be noticed.
  t.check(!opNames().some(op => /token\.(access|refresh|get)$/.test(op)),
    `no op hands a token to the webview (${opNames().join(", ")})`);
  t.check(opNames().includes("esi.get"), "the webview asks for data instead");
  t.check(!opNames().some(op => op.startsWith("sightings.query")),
    "and no op asks the core a question the tested JavaScript already answers");
  t.equal(OPS["advisor.consider"].to, "advisor",
    "the advisor is addressed as its own process, not as the core");
  t.check(Object.values(OPS).every(spec => ["core", "advisor"].includes(spec.to)),
    "and every op names where it goes");

  // **No op hands the advisor a snapshot.** The snapshot holds standings,
  // avoid notes and every name a player typed; the projection is what a model
  // may receive. `advisor.narrate` declared `snapshot: "object"` and survived
  // the deletion of the design it belonged to by a day - dark, so unsendable,
  // and still a specification for whoever wired the transport next.
  //
  // Asserted over the whole table rather than over the one op, because the
  // failure is somebody adding a second one.
  for (const [op, spec] of Object.entries(OPS)) {
    t.check(!Object.hasOwn(spec.payload, "snapshot"),
      `${op} does not carry a snapshot across a process boundary`);
  }
  t.check(Object.hasOwn(OPS["advisor.consider"].payload, "projection"),
    "the advisor is handed a projection, which is the only thing a model receives");

  // --- the narrator is gone, and so is the law it enforced here --------------
  //
  // This block tested `narrationFaults` / `renderNarration`: a model returned
  // prose with `{{path}}` slots and code refused any digit the snapshot had not
  // carried. The tests were good and the design is gone - a read is a templated
  // relation now, the model picks an id from a closed set and code writes every
  // word, so there is no prose to police.
  //
  // "No numbers from a model" did not weaken. It moved, and got stricter: the
  // model cannot compose a sentence at all, let alone a number in one. What
  // guards it now is `web/snapshot.js` (nothing crosses but ids, numbers and
  // vouched names) and `web/operations.js` (every figure computed by code from
  // operands the model named).
  t.check(!("narrationFaults" in contract) && !("renderNarration" in contract)
    && !("resolvePath" in contract) && !("narrationResultFaults" in contract),
    "the narration path is gone from the contract, not merely unused");
  // --- suggestions are a closed vocabulary of ids -----------------------------------
  t.equal(suggestionFault({ action: "avoid-system", systemId: 30002718 }), null,
    "a known action with the right shape is accepted");
  t.equal(suggestionFault({ action: "avoid-system", systemId: 30002718, reason: "camped" }), null,
    "and may carry a reason, which is displayed and never obeyed");
  t.check(suggestionFault({ action: "delete-history" }).includes("unknown action"),
    "an action this build does not have is refused, not ignored");
  for (const inherited of ["constructor", "toString", "valueOf", "__proto__", "hasOwnProperty"]) {
    t.check((suggestionFault({ action: inherited }) ?? "").includes("unknown action"),
      `and so is "${inherited}", which the vocabulary inherits rather than declares`);
  }
  t.check(suggestionFault({ action: "avoid-system", systemId: "Ahbazon" }).includes("expected number"),
    "a name where an id belongs is refused, because resolving a name is itself an act");
  t.check(suggestionFault({ action: "avoid-system", systemId: 1, url: "http://x" })
    .includes("unknown field"), "and a field it invented is refused rather than dropped");
  t.check(suggestionFault(null).includes("not an object"), "as is a suggestion that is not one");

  // --- every declared op goes somewhere, and nothing goes anywhere undeclared -
  //
  // The partition, asserted rather than described. `character_portrait` was
  // written, shipped and caching files to disk while this table described a
  // complete vocabulary that did not contain it - and the comment saying the
  // two should agree is exactly what failed to keep them agreeing.
  //
  // Both directions matter. An op declared and routed nowhere is a caller's
  // silent failure; an op routed without being declared is a second vocabulary,
  // which is the thing this whole file exists to prevent.
  {
    // **Three buckets, not two.** An op is routed to a typed core command,
    // carried to the advisor over the one pipe, or dark - exactly one of the
    // three. The third was added at step 6 rather than weakening the rule
    // below, which is right about the transport it was written for and does
    // not generalise to a pipe that carries its own op name.
    const { CORE_COMMANDS, ADVISOR_COMMANDS, DARK_OPS } = app;
    const declared = new Set(opNames());
    const routed = new Set(Object.keys(CORE_COMMANDS));
    const carried = new Set(Object.keys(ADVISOR_COMMANDS));
    const dark = new Set(DARK_OPS);

    const buckets = op => [routed.has(op), carried.has(op), dark.has(op)].filter(Boolean).length;
    for (const op of declared) {
      t.equal(buckets(op), 1,
        `${op} is declared, so it is routed, carried to the advisor, or dark - exactly one`);
    }
    for (const op of routed) {
      t.check(declared.has(op), `${op} is routed to a command, so it is declared here`);
    }
    for (const op of carried) {
      t.check(declared.has(op), `${op} is carried to the advisor, so it is declared here`);
    }
    // The app's third bucket and the contract's own `to: "advisor"` must be the
    // same set. Two places deciding which ops go down the pipe is how one op
    // ends up declared for the advisor and quietly sent to the core.
    t.equal([...carried].sort().join(","), [...ADVISOR_OPS].sort().join(","),
      "the ops carried to the advisor are exactly the ops declared for it");
    for (const op of dark) {
      t.check(declared.has(op), `${op} is listed as dark, so it is declared here`);
    }
    t.equal(routed.size + carried.size + dark.size, declared.size,
      "every declared op is accounted for exactly once");
    // Command names are the Rust side's, deliberately unrenamed, so they must
    // at least be distinct - two ops mapping to one command would send a
    // payload to the wrong place.
    t.equal(new Set(Object.values(CORE_COMMANDS)).size, routed.size,
      "no two core ops route to the same typed command");
    // And the advisor's two **do** share one, which is not the same rule being
    // bent. A typed command carries no op name and is told apart only by which
    // command was called; the advisor pipe carries the whole envelope, and
    // telling `advisor.ask` from `advisor.consider` is exactly what the `op`
    // field in it is for.
    t.equal(new Set(Object.values(ADVISOR_COMMANDS)).size, 1,
      "the advisor ops share one pipe, because the envelope tells them apart");
    for (const op of carried) {
      t.check(!routed.has(op), `${op} does not also have a typed command of its own`);
    }
  }

  // --- the seam's command names are the core's command names ---------------
  //
  // `CORE_COMMANDS` maps a declared op to a Rust command by writing its name as
  // a string. Nothing checked that the string names a command that exists: a
  // typo there passes the partition check above, passes every JS test, and
  // fails only at runtime - as a rejected promise that the portrait path
  // deliberately swallows, so the first symptom would be a feature quietly not
  // working.
  //
  // Both directions again. A command registered and never reached from the seam
  // is surface with no caller, which `main.rs` names as a rule it keeps; if one
  // is deliberate it is listed here, so adding surface is a decision rather
  // than an accident.
  {
    const strip = text => text
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n").filter(line => !line.trim().startsWith("//")).join("\n");

    const appjs = strip(fs.readFileSync(path.join(ROOT, "web", "app.js"), "utf8"));
    const seam = new Set(
      [/CORE_COMMANDS = Object\.freeze\(\{[\s\S]*?\}\)/, /ADVISOR_COMMANDS = Object\.freeze\(\{[\s\S]*?\}\)/]
        .flatMap(pattern => [...((appjs.match(pattern) ?? [""])[0]).matchAll(/:\s*"([a-z_]+)"/g)])
        .map(m => m[1]),
    );

    const mainrs = strip(fs.readFileSync(path.join(ROOT, "src-tauri", "src", "main.rs"), "utf8"));
    const handler = (mainrs.match(/generate_handler!\[([\s\S]*?)\]/) ?? [null, ""])[1];
    const registered = new Set(handler.split(",").map(x => x.trim()).filter(Boolean));

    // Registered on purpose and not reached from the page. Each one is a
    // decision; an empty list would be better still.
    const DELIBERATELY_UNREACHED = new Set(["shell_status"]);

    t.check(seam.size > 0, `the seam maps some commands (${seam.size})`);
    t.check(registered.size > 0, `and the core registers some (${registered.size})`);

    for (const name of seam) {
      t.check(registered.has(name),
        `the seam's "${name}" is a command the core actually registers`);
    }
    for (const name of registered) {
      t.check(seam.has(name) || DELIBERATELY_UNREACHED.has(name),
        `the core's "${name}" is reachable from the seam, or listed as deliberately not`);
    }
  }

  // --- every routed op declares what its reply carries ----------------------
  //
  // `CORE_REPLY_FIELD` maps a routed op to the field of the reply payload its
  // value belongs in, and `null` means "this command returns nothing".
  // A *missing* row must not read as the same thing, or routing a new op without
  // adding one hands every caller `undefined`: green suite, no error, the data simply
  // not there. It is the drift the `DARK_OPS` partition test prevents, one table
  // over.
  {
    const source = fs.readFileSync(path.join(ROOT, "web", "app.js"), "utf8");
    const listed = (name) => {
      const block = source.split(`const ${name} = Object.freeze({`)[1];
      return new Set([...block.split("});")[0].matchAll(/"([a-z.]+)":/g)].map((m) => m[1]));
    };
    const routed = listed("CORE_COMMANDS");
    const declared = listed("CORE_REPLY_FIELD");
    const missing = [...routed].filter((op) => !declared.has(op)).sort();
    const extra = [...declared].filter((op) => !routed.has(op)).sort();
    t.check(routed.size >= 6, `the routing table was read (${routed.size} ops)`);
    t.equal(missing.length, 0,
      `every routed op declares its reply field${missing.length ? ` (missing ${missing.join(", ")})` : ""}`);
    t.equal(extra.length, 0,
      `and none is declared that is not routed${extra.length ? ` (${extra.join(", ")})` : ""}`);
  }

  // --- the sidecar speaks the same contract ---------------------------------
  //
  // The advisor is a different language on the far end of a pipe, so nothing a
  // compiler or a bundler can do will notice the two versions drifting apart.
  // The sidecar declares its own rather than echoing the request's - a peer
  // that agrees with whatever it is told cannot disagree, which is what a
  // version is for - and that makes this the only place the two numbers meet.
  {
    const sidecar = fs.readFileSync(path.join(ROOT, "sidecar", "atlas_sidecar.py"), "utf8");
    const declared = (sidecar.match(/^CONTRACT_VERSION = (\d+)$/m) ?? [])[1];
    t.check(declared !== undefined, "the sidecar declares a contract version");
    t.equal(Number(declared), CONTRACT_VERSION, "and it is the one this side speaks");

    // And it answers the ops this side carries to it. A sidecar that does not
    // recognise `advisor.ask` replies in its own shape, which `parseMessage`
    // refuses - correctly, and with a message about unreadable JSON rather
    // than about an op nobody implemented.
    const answered = (sidecar.match(/^ADVISOR_OPS = \(([^)]*)\)/m) ?? [])[1] ?? "";
    for (const op of ADVISOR_OPS) {
      t.check(answered.includes(`"${op}"`), `the sidecar answers ${op}`);
    }

    // It must not hand the question back. A failure envelope carries a code and
    // a sentence this side wrote; an echo would put a pilot's prose on the one
    // return path nothing else checks.
    t.check(/never echoed/i.test(sidecar), "and says, where it builds a refusal, that it echoes nothing");
  }


  return t.results;
}
