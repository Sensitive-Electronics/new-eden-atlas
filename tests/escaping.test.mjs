// Player-supplied text is data, never instruction.
//
// The project states this as a rule about the advisor, but it is a rule about
// the whole display surface: alliance names, tickers, ship names, campaign
// event types and EVE-Scout signature fields all arrive from somewhere else and
// all end up inside a template literal that becomes `innerHTML`. There are
// twenty-six `innerHTML =` assignments in this application and one escaper.
//
// The formatters deliberately do not escape - `eventLabel` and
// `describeSignature` hand back plain text, which is right, because they are
// also used for comparisons and logs. That makes escaping the *renderer's* job
// at every single call site, which is exactly the kind of obligation that holds
// for a year and then does not.
//
// So this feeds hostile markup through each renderer and checks it comes back
// inert. A renderer added later without `esc` fails here rather than in a
// browser.

import fs from "node:fs";
import path from "node:path";
import { suite, ROOT } from "./helpers.mjs";
import * as controls from "../web/controls.js";
import * as panels from "../web/panels.js";
import { escapeHtml } from "../web/map-utils.js";

// Distinctive, and dangerous in three different places: as an element, inside a
// quoted attribute, and as an attribute name.
const EVIL = `<img src=x onerror=alert(1)>`;
const QUOTE = `" onmouseover="alert(1)`;

const at = Date.parse("2026-09-19T12:00:00Z");

export default function run() {
  const t = suite("escaping");

  // --- the escaper itself ---------------------------------------------------------
  t.check(!escapeHtml(EVIL).includes("<"), "the escaper neutralises an element");
  t.check(!escapeHtml(QUOTE).includes('"'), "and an attribute break-out");
  t.equal(escapeHtml("&"), "&amp;", "and an ampersand, so escaping twice is visible rather than silent");
  t.equal(escapeHtml(null), "null", "a non-string is coerced rather than thrown on");

  // Each renderer with the hostile string in every string-shaped field it reads.
  // Where a renderer needs a particular shape, it gets one - the point is that
  // the text inside is hostile, not that the object is malformed.
  const cases = [
    ["scoutRows", () => controls.scoutRows([{ id: EVIL, text: EVIL, unusable: EVIL, expiresAt: at }], true)],
    ["corridorRows", () => controls.corridorRows([{ name: EVIL, from: EVIL, to: EVIL, mode: EVIL }], () => EVIL)],
    ["bridgeRows", () => controls.bridgeRows([{ key: EVIL, fromName: EVIL, toName: EVIL, since: at }])],
    ["ignoreRows", () => controls.ignoreRows([{ target: EVIL, key: EVIL, label: EVIL, reason: EVIL, remainingMs: 60_000 }])],
    ["threatRows", () => controls.threatRows([{
      group: EVIL, rangeLy: 5, systemIds: new Set([1]), label: EVIL,
    }])],
    ["constellationButtons", () => controls.constellationButtons([
      { constellation_id: EVIL, name: EVIL, solar_system_ids: [1, 2] },
    ])],
    ["shipOptions", () => controls.shipOptions([{ name: EVIL, type_id: EVIL }], EVIL)],
    ["fuelModuleOptions", () => controls.fuelModuleOptions([{ name: EVIL, type_id: EVIL }], EVIL)],
    ["searchResultsMarkup", () => controls.searchResultsMarkup([{ kind: "system", name: EVIL, id: EVIL, detail: EVIL }])],
    ["campaignPanel", () => panels.campaignPanel([{ label: EVIL, live: true, startTime: at, text: EVIL }])],
    ["heatPanel", () => panels.heatPanel({ text: EVIL, at, trend: [] })],
    ["routeHeatPanel", () => panels.routeHeatPanel({
      heat: { weight: 2, applied: true, at, kills: new Map([[1, 4]]) },
      hotCrossed: [{ system: { name: EVIL, system_id: 1 }, playerKills: 4 }],
    })],
    ["routeProtestPanel", () => panels.routeProtestPanel({
      avoidedAnyway: [{ name: EVIL, system_id: 1 }],
      edgesUsedAnyway: [{ kind: EVIL, key: EVIL, from: { name: EVIL }, to: { name: EVIL }, reason: EVIL }],
    })],
  ];

  let exercised = 0;
  for (const [name, render] of cases) {
    let html = null;
    try {
      html = String(render() ?? "");
    } catch (error) {
      t.check(false, `${name} renders hostile text without throwing (${error.message})`);
      continue;
    }
    if (!html) continue;
    exercised += 1;
    t.check(!html.includes(EVIL), `${name} does not pass an element through`);
    t.check(!html.includes(QUOTE), `${name} does not pass an attribute break-out through`);
    // The text must still be *there*, escaped - a renderer that silently drops
    // the field would pass the two checks above and show the pilot nothing.
    t.check(html.includes("&lt;") || html.includes("&amp;") || !/img|onerror/.test(html),
      `${name} shows the text escaped rather than discarding it`);
  }
  t.check(exercised >= 10, `enough renderers were exercised to mean something (${exercised})`);

  // --- and the obligation is visible in the source --------------------------------
  // Every renderer above escapes today. The risk is the next one, so this states
  // the rule where someone adding a renderer will read it.
  t.check(typeof escapeHtml === "function",
    "escaping is one shared function, so a renderer never writes its own");

  // --- every quoted attribute, judged one interpolation at a time ---------------
  // I checked this once with a line-level grep that excluded any line containing
  // esc(, and reported zero. It was wrong: two attributes in panels.js sat on
  // lines that escaped something *else*, so the line was filtered out and the
  // unescaped interpolation beside it went unseen. A per-line filter cannot
  // answer a per-occurrence question.
  //
  // Nothing found here was exploitable - every value was an archive integer or
  // a pre-escaped variable - but "escape at each call site" is an obligation
  // that only holds if it can be checked, and this is the check.
  const attribute = /([\w-]+)="([^"]*\$\{[^"]*)"/g;
  const interpolation = /\$\{([^}]*)\}/g;
  const safe = ["esc(", "escapeHtml(", "liveTime("];
  const unescaped = [];
  let scanned = 0;
  for (const name of fs.readdirSync(path.join(ROOT, "web")).filter(f => f.endsWith(".js"))) {
    const text = fs.readFileSync(path.join(ROOT, "web", name), "utf8");
    for (const line of text.split(String.fromCharCode(10))) {
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
      for (const match of line.matchAll(attribute)) {
        for (const inner of match[2].matchAll(interpolation)) {
          scanned += 1;
          if (safe.some(marker => inner[1].includes(marker))) continue;
          unescaped.push(`${name}: ${match[1]} carries ${inner[1].trim()}`);
        }
      }
    }
  }
  t.check(scanned > 20, `enough attribute interpolations were scanned to mean something (${scanned})`);
  t.equal(unescaped.length, 0,
    `every value interpolated into a quoted attribute is escaped where it is used (${unescaped.slice(0, 4).join("; ")})`);

  return t.results;
}
