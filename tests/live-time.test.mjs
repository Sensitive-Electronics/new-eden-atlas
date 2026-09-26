// The one formatter for every clock-driven string.
//
// This module had no test of its own, which is worth stating plainly given what
// it is for: the project's standing rule is that live data is *always* shown
// with its age, and this is the only thing that renders an age.
//
// Its failure mode is silence. `liveTimeText` matches the kind against three
// literals and falls through to `""`; `liveTime` then returns `""` rather than a
// span, so a mistyped kind produces no element at all. Nothing throws, nothing
// logs, and the age simply is not on screen - the exact outcome the rule
// exists to prevent, reached by a typo.
//
// `LIVE_TIME_KINDS` was exported and read by nothing: not by the formatter it
// describes, not by a caller, not by a test. A list of the valid values that
// nothing validates against is a comment with a `export const` in front of it.
// These assertions are what make it load-bearing.

import fs from "node:fs";
import path from "node:path";
import { suite, ROOT } from "./helpers.mjs";
import { LIVE_TIME_KINDS, liveTime, liveTimeText, refreshLiveTimes, sentence } from "../web/live-time.js";

const T0 = Date.parse("2026-09-19T12:00:00Z");

export default function run() {
  const t = suite("live time");

  // --- every declared kind actually renders --------------------------------------
  t.equal(LIVE_TIME_KINDS.join(","), "age,countdown,remaining", "the kinds are enumerated");
  for (const kind of LIVE_TIME_KINDS) {
    const text = liveTimeText(kind, T0 + 60_000, { now: T0 });
    t.check(text.length > 0, `"${kind}" renders something (${JSON.stringify(text)})`);
    t.check(/<span/.test(liveTime(kind, T0 + 60_000, { now: T0 })), `and "${kind}" produces a span`);
  }

  // --- and nothing else does ------------------------------------------------------
  for (const wrong of ["aged", "Age", "AGE", "since", "", null, undefined]) {
    t.equal(liveTime(wrong, T0, { now: T0 }), "",
      `${JSON.stringify(wrong) ?? "undefined"} is not a kind and renders no span`);
  }

  // --- every call site in the application uses a kind that exists ----------------
  // The check the exported list was there for. A mistyped kind is invisible at
  // runtime, so it has to be caught by reading the source.
  const sources = fs.readdirSync(path.join(ROOT, "web"))
    .filter(name => name.endsWith(".js") && name !== "live-time.js");
  const used = new Map();
  for (const name of sources) {
    const text = fs.readFileSync(path.join(ROOT, "web", name), "utf8");
    for (const match of text.matchAll(/liveTime(?:Text)?\(\s*"([^"]*)"/g)) {
      used.set(match[1], [...(used.get(match[1]) ?? []), name]);
    }
  }
  t.check(used.size > 0, `the application calls the formatter (${[...used.keys()].join(", ")})`);
  for (const [kind, files] of used) {
    t.check(LIVE_TIME_KINDS.includes(kind),
      `every call site uses a declared kind - "${kind}" in ${[...new Set(files)].join(", ")}`);
  }

  // --- an instant that is not one renders nothing rather than "NaN" ---------------
  for (const bad of [null, undefined, NaN, "soon", Infinity]) {
    t.equal(liveTimeText("age", bad, { now: T0 }), "",
      `${JSON.stringify(bad) ?? "undefined"} is not an instant`);
  }
  // Seconds instead of milliseconds would read as 1970 rather than as an error,
  // which is the one wrong value that renders happily.
  t.check(/ago/.test(liveTimeText("age", Math.floor(T0 / 1000), { now: T0 })),
    "a seconds-based timestamp still renders, so the convention is worth stating: instants are milliseconds");

  // --- capitalisation belongs here, not to the caller -----------------------------
  // "a template that capitalised its own copy is how 'Synced synced just now'
  // happened" - and it happened again later, as "Measured synced 6h ago",
  // because a caller prefixed a word onto a phrase that already had one.
  const embedded = liveTimeText("age", T0 - 60_000, { now: T0, embedded: true });
  const standalone = liveTimeText("age", T0 - 60_000, { now: T0 });
  t.equal(standalone, sentence(embedded), "a standalone reading is the embedded one, capitalised");
  t.check(/^[a-z]/.test(embedded), "the embedded form starts lower case, to sit mid-line");
  t.check(/^[A-Z]/.test(standalone), "and the standalone form starts a sentence");
  t.equal(sentence(sentence(embedded)), sentence(embedded), "capitalising twice changes nothing");

  return t.results;
}
