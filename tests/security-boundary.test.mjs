// EVE rounds security for display. Every consumer of a security value must
// therefore agree with the number a pilot can see on the node, or the map
// contradicts its own labels. 119 systems sit in [0.45, 0.50) and were once
// drawn as low security while displaying 0.5.

import fs from "node:fs";
import path from "node:path";
import { readArchive, readShips, suite, ROOT } from "./helpers.mjs";
import { JumpPlanner } from "../web/jump-planner.js";
import {
  HIGH_SECURITY, ELEVATED_SECURITY, securityClass, securityColor, securityName, formatSecurity,
} from "../web/map-utils.js";

export default function run() {
  const t = suite("security boundary");
  const systems = Object.values(readArchive().systems);

  const mismatched = systems.filter(s => {
    const shown = Number(formatSecurity(s.security));
    const expected = shown >= 0.5 ? "high" : shown > 0 ? "low" : "null";
    return securityClass(s.security) !== expected;
  });
  t.equal(mismatched.length, 0, `all ${systems.length} systems classify as their own label reads`);

  const miscoloured = systems.filter(s => {
    const colour = securityColor(s.security);
    return (securityClass(s.security) === "high") !== (colour === "#62d8c8" || colour === "#6aaee8");
  });
  t.equal(miscoloured.length, 0, "no system is coloured against its own class");

  const brightMismatch = systems.filter(s =>
    (Number(formatSecurity(s.security)) >= 0.8) !== (securityColor(s.security) === "#62d8c8"));
  t.equal(brightMismatch.length, 0, "the brighter high-security shade follows the displayed value");

  // Pinned so a future edit cannot quietly restore the old boundary.
  t.equal(HIGH_SECURITY, 0.45, "HIGH_SECURITY is EVE's boundary, not the raw 0.5");
  t.equal(ELEVATED_SECURITY, 0.75, "ELEVATED_SECURITY pinned at 0.75");
  t.equal(securityName(0.46), "High security", "0.46 reads as High security");
  t.equal(securityName(0.44), "Low security", "0.44 reads as Low security");
  t.equal(formatSecurity(0.02), "0.1", "a positive value below 0.05 still displays as 0.1");
  t.equal(securityName(0.02), "Low security", "and is still low, never null");
  t.equal(securityName(0), "Null security", "zero is null");
  t.equal(securityName(-0.3), "Null security", "negative is null");

  const band = systems.filter(s => s.security >= 0.45 && s.security < 0.5);
  t.equal(band.length, 119, "119 systems display 0.5 on a raw value below it");
  t.check(band.every(s => securityClass(s.security) === "high"), "and every one of them is high security");

  const counts = { high: 0, low: 0, null: 0 };
  for (const s of systems) counts[securityClass(s.security)] += 1;
  t.equal(counts.high, 1247, "high-security count");
  t.equal(counts.low, 687, "low-security count");
  t.equal(counts.null, 6556, "null-security count");

  // --- the boundaries themselves, not the systems that happen to sit near them ---
  // Every assertion above reads real systems, and no system in New Eden has a
  // security of exactly 0.45 or exactly 0.0 - the nearest are 0.450192 and
  // 0.448944. So the boundary values are never actually evaluated, and a
  // mutation sweep confirmed it: relaxing `security >= HIGH_SECURITY` to `>`,
  // and `security > 0` to `>=`, both left the whole suite green.
  //
  // These are rules rather than facts about the current archive. CCP has
  // reworked system security before - that is why HIGH_SECURITY is 0.45 and not
  // the 0.5 the client once displayed - so a system landing exactly on the line
  // is a change to the data, not to the code, and nothing would have caught the
  // classification flipping underneath it.
  t.equal(securityClass(HIGH_SECURITY), "high",
    "a system exactly on the high-security boundary is high security, not low");
  t.equal(securityClass(HIGH_SECURITY - Number.EPSILON), "low", "and a hair below it is low");
  t.equal(securityClass(0.449999), "low", "as is anything under the line");
  t.equal(securityClass(0), "null", "exactly zero is null security, not low");
  t.equal(securityClass(-0), "null", "including negative zero, which JavaScript keeps distinct");
  t.equal(securityClass(Number.MIN_VALUE), "low", "while the smallest value above zero is low");
  t.equal(securityClass(-1), "null", "and the deepest null security is null");
  t.equal(securityClass(1), "high", "as the safest system is high");

  // The colour bands take the same two boundaries plus their own, and must
  // agree with the class at every one of them.
  t.equal(securityColor(ELEVATED_SECURITY), "#62d8c8", "the elevated shade starts exactly at its boundary");
  t.equal(securityColor(ELEVATED_SECURITY - Number.EPSILON), "#6aaee8", "and a hair below is the plain high shade");
  t.equal(securityColor(HIGH_SECURITY), "#6aaee8", "high security exactly on the line takes a high-security colour");
  t.equal(securityColor(HIGH_SECURITY - Number.EPSILON), "#e5a45f", "and below it takes the low-security colour");
  t.equal(securityColor(0), "#db6a6a", "zero takes the null colour, matching its class");
  for (const value of [1, ELEVATED_SECURITY, HIGH_SECURITY, 0.2, 0, -0.5, -1]) {
    const isHigh = securityClass(value) === "high";
    const looksHigh = securityColor(value) === "#62d8c8" || securityColor(value) === "#6aaee8";
    t.equal(looksHigh, isHigh, `colour and class agree at ${value}`);
  }
  t.equal(securityName(HIGH_SECURITY), "High security", "and the name follows the class at the boundary");
  t.equal(securityName(0), "Null security", "as it does at zero");

  // --- one definition, not one per module ---------------------------------------
  // The jump planner carried its own `0.45` and imported nothing. The router and
  // the map both take HIGH_SECURITY from map-utils, so a change would have moved
  // two of the three - and the one left behind decides where a capital may
  // arrive, because a cynosural field cannot be lit in high security.
  //
  // Scanned rather than asserted about one file, so a fourth copy appearing
  // anywhere fails here.
  const sources = fs.readdirSync(path.join(ROOT, "web")).filter(name => name.endsWith(".js"));
  const literals = [];
  const boundaryLiteral = /(^|[^0-9.])0\.45([^0-9]|$)/;
  for (const name of sources) {
    const text = fs.readFileSync(path.join(ROOT, "web", name), "utf8");
    for (const line of text.split("\n")) {
      // Comments explain the number; code must not restate it.
      if (/^\s*(\/\/|\*)/.test(line)) continue;
      if (boundaryLiteral.test(line)) literals.push(`${name}: ${line.trim().slice(0, 70)}`);
    }
  }
  t.equal(literals.length, 1,
    `the boundary is written once in code, in its own definition (found ${literals.length}: ${literals.join(" | ")})`);
  t.check(/map-utils/.test(literals[0] ?? ""),
    "and that one place is map-utils, where the reasoning for it lives");

  // The planner must agree with the classifier at the boundary itself, which is
  // the value no real system holds and therefore the one nothing exercised.
  const planner = new JumpPlanner(readArchive(), readShips());
  t.equal(planner.isHighSecurity({ security: HIGH_SECURITY }), true,
    "the jump planner treats a system exactly on the line as high security");
  t.equal(planner.isHighSecurity({ security: HIGH_SECURITY - Number.EPSILON }), false,
    "and a hair below it as not");
  for (const value of [1, 0.5, HIGH_SECURITY, 0.449, 0, -1]) {
    t.equal(planner.isHighSecurity({ security: value }), securityClass(value) === "high",
      `the planner and the classifier agree at ${value}`);
  }

  return t.results;
}
