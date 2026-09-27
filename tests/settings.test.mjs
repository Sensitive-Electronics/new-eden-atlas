// Saved settings, and what happens when storage will not cooperate.
//
// The four panels each had their own copy of "parse this key, and if that
// throws, remove it". Three had the same bug: the removal sat inside the catch,
// so where storage is unavailable - private mode, blocked site data, some
// embedded webviews - getItem threw, the catch ran, removeItem threw again, and
// that second throw escaped. Restoring settings happens during startup, so it
// would have taken the whole map down rather than losing a remembered origin.

import { suite } from "./helpers.mjs";
import { STORAGE_KEYS, readJson, readJsonState, readText, writeJson, writeText } from "../web/settings.js";
import { DEFAULT_ROUTE_MODE, ROUTE_MODES } from "../web/route-planner.js";

// A store that fails the way a real blocked one does: every method throws.
const blocked = {
  getItem() { throw new DOMExceptionLike("SecurityError"); },
  setItem() { throw new DOMExceptionLike("SecurityError"); },
  removeItem() { throw new DOMExceptionLike("SecurityError"); },
};
function DOMExceptionLike(name) {
  const error = new Error(name);
  error.name = name;
  return error;
}

// And one that reads but refuses to write, which is what a full quota looks
// like: the old value is still there and the new one cannot be stored.
const readOnly = value => ({
  getItem: () => value,
  setItem() { throw new Error("QuotaExceededError"); },
  removeItem() { throw new Error("QuotaExceededError"); },
});

function fake(initial = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: key => (key in data ? data[key] : null),
    setItem: (key, value) => { data[key] = String(value); },
    removeItem: key => { delete data[key]; },
  };
}

export default function run() {
  const t = suite("settings");

  // --- the ordinary path --------------------------------------------------
  const store = fake();
  t.check(writeJson(store, "k", { a: 1, b: "two" }), "writing an object reports success");
  t.equal(JSON.stringify(readJson(store, "k")), JSON.stringify({ a: 1, b: "two" }), "and it reads back");
  t.equal(readJson(store, "absent"), null, "a key that was never written reads as null");
  t.check(writeText(store, "mode", "ccp"), "text writes too");
  t.equal(readText(store, "mode"), "ccp", "and reads back");

  // --- corrupt entries ----------------------------------------------------
  const corrupt = fake({ bad: "{not json" });
  t.equal(readJson(corrupt, "bad"), null, "a corrupt entry reads as null rather than throwing");

  // Not *deleted* here. The argument for deleting is that a corrupt entry "cannot fail
  // on every load forever", and it does not survive reading: the read already returns
  // null every time, so nothing fails repeatedly whether the bytes stay or go. What
  // deleting buys is the destruction of the only copy.
  //
  // For a preference that is a shrug. For the live store it was the whole
  // history: a value half-written by a crashed tab was removed on read, the
  // caller saw null, treated it as a first run, and wrote an empty store over
  // the gap. The pilot got a clean start and no error anywhere - the exact
  // failure the desktop tier's three-outcome load was built to prevent, running
  // unopposed in the zero-install tier the degradation law is written for.
  t.equal(corrupt.getItem("bad"), "{not json",
    "and the bytes are left alone, because they may be the only copy of something");

  // Which is why a caller that cares can tell the two apart. Two of these three
  // hand back nothing, and that is exactly why collapsing them is so easy.
  t.equal(readJsonState(fake(), "never-written").state, "absent",
    "nothing stored is absence, and an empty default is right");
  t.equal(readJsonState(corrupt, "bad").state, "unreadable",
    "something stored that will not parse is damage, not absence");
  t.equal(readJsonState(fake({ ok: JSON.stringify({ a: 1 }) }), "ok").state, "read",
    "and a value that parses is simply read");
  t.equal(readJsonState(fake({ n: "4" }), "n").state, "unreadable",
    "valid JSON that is not an object is damage too, since every caller here wants an object");
  t.equal(readJsonState(corrupt, "bad").value, null, "damage yields no value to use");
  t.equal(corrupt.getItem("bad"), "{not json", "and still does not delete it");

  // JSON.parse("4") is a number and JSON.parse("null") is null. Callers here
  // all expect an object, and a number would have them read properties off it
  // and silently get undefined for every field.
  for (const [raw, what] of [["4", "a number"], ["null", "a JSON null"], ['"text"', "a string"], ["[1,2]", "an array"]]) {
    const odd = fake({ v: raw });
    const value = readJson(odd, "v");
    if (what === "an array") {
      t.check(Array.isArray(value), "an array is an object and is returned as one");
    } else {
      t.equal(value, null, `${what} is not an object and reads as null`);
    }
  }

  // --- storage that throws -------------------------------------------------
  // The case that takes startup down if anything here throws.
  let threw = null;
  try {
    readJson(blocked, STORAGE_KEYS.route);
    readText(blocked, STORAGE_KEYS.layout);
    writeJson(blocked, STORAGE_KEYS.jump, { a: 1 });
    writeText(blocked, STORAGE_KEYS.layout, "ccp");
  } catch (error) {
    threw = error;
  }
  t.equal(threw, null, "nothing throws when every storage method throws");
  t.equal(readJson(blocked, "k"), null, "an unreadable store reads as null");
  t.check(!writeJson(blocked, "k", {}), "and an unwritable one reports failure rather than pretending");
  t.check(!writeText(blocked, "k", "v"), "for text as well");

  // A store that reads but cannot write or clear: the corrupt-entry path must
  // not throw when its attempt to clear fails. This is the exact shape of the
  // original bug, with the failure moved into removeItem.
  let secondThrow = null;
  try {
    t.equal(readJson(readOnly("{not json"), "k"), null, "a corrupt entry in an unclearable store still reads as null");
  } catch (error) {
    secondThrow = error;
  }
  t.equal(secondThrow, null, "and failing to clear it does not escape");

  // --- the allow-list ------------------------------------------------------
  // A value edited by hand in devtools must not put the viewer into a state it
  // has no code for.
  const tampered = fake({ [STORAGE_KEYS.layout]: "klingon" });
  t.equal(readText(tampered, STORAGE_KEYS.layout, ["atlas", "ccp"]), null,
    "a value outside the allowed set reads as null");
  t.equal(readText(fake({ m: "ccp" }), "m", ["atlas", "ccp"]), "ccp", "and one inside it reads back");
  t.equal(readText(fake({ m: "anything" }), "m"), "anything", "with no list given, any value is returned");

  // --- the control and the route must agree about the mode -------------------
  //
  // Found by driving the application as a pilot would rather than probing a
  // boundary: a simulated session set a mode this build does not have, and the
  // route came back computed under a different one with nothing said.
  //
  // `calculate()` falls back to "shortest" for any mode it does not recognise,
  // which is a reasonable thing for it to do. What was not reasonable is that
  // the restored preference was never checked, so the control could say
  // "fastest" while the route was shortest and routeError was empty. Every
  // other restored preference - heat here, layout through readText's allow-list
  // - was already validated. This was the one that was not.
  //
  // The realistic route in is not a hand edit. It is renaming or removing a
  // mode in a later version, at which point every stored copy of the old name
  // becomes a silent mismatch.
  t.equal(readText(fake({ m: "fastest" }), "m", ROUTE_MODES), null,
    "a mode this build does not have does not survive a restore");
  for (const mode of ROUTE_MODES) {
    t.equal(readText(fake({ m: mode }), "m", ROUTE_MODES), mode, `while "${mode}" does`);
  }
  // And the fallback is one constant rather than two agreeing by luck. The
  // planner substitutes it for any mode it does not recognise; the panel writes
  // it into the control for the same input. When each picked its own, a stored
  // mode from a build with different names left them disagreeing in silence.
  t.check(ROUTE_MODES.includes(DEFAULT_ROUTE_MODE),
    `the fallback mode is one the planner actually has (${DEFAULT_ROUTE_MODE})`);

  // --- the keys ------------------------------------------------------------
  const keys = Object.values(STORAGE_KEYS);
  t.equal(new Set(keys).size, keys.length, "no two settings share a storage key");
  t.check(keys.every(key => /^new-eden-atlas-[a-z]+-v\d+$/.test(key)),
    "every key is namespaced and versioned, so a shape change can be a new key");

  return t.results;
}
