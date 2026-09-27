// Properties that no other file in this suite asserts, and that a green run would
// otherwise say nothing about. Each block names the rule it holds rather than the code
// it happens to exercise, so the reason survives a rewrite of what it tests.

import fs from "node:fs";
import path from "node:path";
import { readArchive, readShips, suite, ROOT } from "./helpers.mjs";
import { escapeHtml, formatSecurity, projectionOf, relaxLabels, relaxSystems, labelBox } from "../web/map-utils.js";
import { RoutePlanner, displayedSecurity, ROUTE_MODES } from "../web/route-planner.js";
import { JumpPlanner } from "../web/jump-planner.js";
import { normalizeTacticalConfig } from "../web/tactical-analyzer.js";
import * as C from "../web/corridors.js";
import { APPLICATION, PUBLISHER, VERSION, userAgent } from "../web/esi.js";

// Built from code points so the source cannot be flattened by an editor or a
// patch tool into two identical literals, which would make the test vacuous.
const KELVIN_SIGN = String.fromCharCode(0x212A) + "elvin";   // U+212A, lowercases to "k"
const CAFE_COMPOSED = "Caf" + String.fromCharCode(0x00E9);   // é
const CAFE_DECOMPOSED = "Cafe" + String.fromCharCode(0x0301); // e + combining acute

const NEWLINE = String.fromCharCode(10);
const QUOTE = String.fromCharCode(34);

export default function run() {
  const t = suite("audit regressions");
  const atlas = readArchive();
  const router = new RoutePlanner(atlas);
  const jumper = new JumpPlanner(atlas, readShips());
  const noAvoid = { systemIds: new Set(), regionIds: new Set() };

  // --- collapsed string continuations in the Rust core ---------------------
  //
  // A defect class rather than a defect: a string literal split across lines
  // with a trailing backslash, where the backslash was eaten by tooling
  // somewhere between an editor and the file. The continuation vanishes and the
  // indentation stays, so the literal becomes a sentence with twenty spaces in
  // the middle of it - and that sentence is what a pilot reads when a sign-in
  // fails.
  //
  // It happened four times in one day. `cargo build` cannot see it, `clippy`
  // has no opinion on it, and the shell's own checks pass because the message
  // is never compared to anything. This is the only thing that looks.
  //
  // Comment lines are skipped: they legitimately align prose in columns.
  {
    const rustFiles = ["main.rs", "sso.rs"];
    const offenders = [];
    for (const name of rustFiles) {
      const file = path.join(ROOT, "src-tauri", "src", name);
      const lines = fs.readFileSync(file, "utf8").split(NEWLINE);
      lines.forEach((line, index) => {
        const body = line.replace(/^ +/, "");
        if (body.startsWith("//")) return;
        // Six or more spaces with real characters either side, inside a line
        // that carries a string literal at all.
        if (!body.includes(QUOTE)) return;
        if (/[^ ] {6,}[^ ]/.test(body)) {
          offenders.push(`${name}:${index + 1}`);
        }
      });
    }
    t.equal(offenders.length, 0,
      `no Rust string literal carries a collapsed line continuation (${offenders.join(", ") || "none"})`);

    // **And the split form itself, which is the landmine rather than the
    // wreckage.** The scan above finds a continuation that has already been
    // eaten. It cannot see one that is still intact, and nine were: six literals
    // across these two files, two of them wire formats - the authorize URL and
    // the HTTP status line. Both compile either way. A collapsed authorize URL
    // carries a newline and nine spaces into `&code_challenge=` and fails at
    // CCP, where nothing in this repository can watch.
    //
    // So the rule is checked rather than written down: put the literal on one long line,
    // or `concat!` the pieces. A line may not end with a lone backslash at all.
    //
    // The backslash is assembled rather than written, for the reason this whole
    // block exists: an escape that travels through tooling is an escape that can
    // arrive as something else, and a scanner looking for the wrong character
    // reports a clean file.
    const BACKSLASH = String.fromCharCode(92);
    const split = [];
    for (const name of rustFiles) {
      const file = path.join(ROOT, "src-tauri", "src", name);
      const lines = fs.readFileSync(file, "utf8").split(NEWLINE);
      lines.forEach((line, index) => {
        const body = line.replace(/^ +/, "");
        if (body.startsWith("//")) return;
        const trimmed = line.replace(/[ \t]+$/, "");
        if (!trimmed.endsWith(BACKSLASH)) return;
        // An escaped backslash at the end of a line is a literal backslash, not
        // a continuation.
        if (trimmed.endsWith(BACKSLASH + BACKSLASH)) return;
        split.push(`${name}:${index + 1}`);
      });
    }
    t.equal(split.length, 0,
      `no Rust line ends with a string continuation (${split.join(", ") || "none"})`);

    // The authorize URL, asserted on its own. It is the one literal here whose
    // corruption is invisible to every other check: the selftest built a URL,
    // asserted the parts it cared about, and passed with a newline sitting in
    // the middle of the query string.
    const sso = fs.readFileSync(path.join(ROOT, "src-tauri", "src", "sso.rs"), "utf8");
    const authorize = sso.slice(sso.indexOf(`${QUOTE}{AUTHORIZE_URL}`));
    const literal = authorize.slice(1, authorize.indexOf(`${QUOTE},`));
    t.check(literal.length > 80, `the authorize URL literal was found (${literal.length} chars)`);
    t.check(!/\s/.test(literal),
      "and carries no whitespace at all, so a collapsed continuation cannot hide in it");
    t.check(literal.includes("&code_challenge={}") && literal.includes("&state={}"),
      "with the PKCE challenge and the state still joined to the query string");
  }

  // --- one application, not two ------------------------------------------
  // The two tiers spelled the same application differently: the core sent
  // `NewEdenAtlas/1.0 (+desktop shell)` and the page sent the author's inbox, so
  // CCP saw two identities for one tool and one of them named a person. They are
  // asserted against each other here because nothing else can see both - the
  // Rust constant is a literal in a file no JavaScript imports, and the release
  // check reads neither.
  {
    const sso = fs.readFileSync(path.join(ROOT, "src-tauri", "src", "sso.rs"), "utf8");
    const declaration = "pub const USER_AGENT: &str = ";
    const from = sso.indexOf(declaration);
    t.check(from !== -1, "the core's user agent is declared where it can be read");
    const core = sso.slice(from + declaration.length + 1, sso.indexOf(`${QUOTE};`, from));
    t.check(core.startsWith(`${APPLICATION}/${VERSION}`),
      `the core names the same application and version as the page (${core})`);
    t.check(core.includes(PUBLISHER), "and the same publisher, who is who CCP would contact");
    t.check(userAgent().startsWith(`${APPLICATION}/${VERSION}`),
      `and the page's own agent still does too (${userAgent()})`);

    // Neither tier carries an address by default, and the core cannot carry one
    // at all: a page able to rewrite the agent the token exchange sends could
    // present itself to CCP as any application it liked.
    t.check(!core.includes("@"), `the core's agent names no inbox (${core})`);
    t.check(!userAgent().includes("@"), "and neither does the page's, unset");
  }

  // --- CCP's prescribed notice -------------------------------------------
  // Section 7.1 of the Developer License Agreement gives the wording of a notice
  // rather than the sentiment of one, and this tree paraphrased it: "EVE Online and
  // the EVE logo are registered trademarks of CCP hf" is the same claim in different
  // words, and different words are the one thing a prescribed text does not allow.
  //
  // `scripts/release_check.py` owns this too, and this is not a duplicate of it: the
  // release check is not on the ordinary gate, so deleting the notice would pass every
  // check anybody runs while working until somebody tried to ship. A licence clause is
  // a poor thing to discover at the end. The two agree because both read `LICENSE`.
  {
    const licence = fs.readFileSync(path.join(ROOT, "LICENSE"), "utf8");
    const prescribed = licence.split(NEWLINE)
      .map((line) => line.trim())
      .find((line) => line.includes("CCP hf") && line.includes("All rights reserved"));
    t.check(prescribed !== undefined, "LICENSE carries CCP's prescribed notice");
    t.check((prescribed ?? "").includes("trademarks or registered trademarks"),
      "and it is the prescribed wording rather than a paraphrase of it");
    // Only worth asking once the quotation was found: `includes` of a sentinel is a
    // question about the sentinel, and it would fail for the wrong reason.
    for (const [label, file] of [["the window", path.join(ROOT, "web", "index.html")],
                                 ["the README", path.join(ROOT, "README.md")]]) {
      t.check(prescribed !== undefined && fs.readFileSync(file, "utf8").includes(prescribed),
        `${label} carries it verbatim, character for character`);
    }
    // Ours, which the clause does not ask for. Section 2.7 forbids holding yourself
    // out as CCP; it does not require saying that you are not, and somebody who
    // installed a binary should not have to work it out.
    t.check(/not affiliated/i.test(fs.readFileSync(path.join(ROOT, "web", "index.html"), "utf8")),
      "and the window says in its own words that it is unofficial");
  }

  // --- escapeHtml, the app's only XSS defence ----------------------------
  // Replacing it with the identity function left the whole suite green.
  t.equal(escapeHtml('<img src=x onerror=alert(1)>'), "&lt;img src=x onerror=alert(1)&gt;", "angle brackets are escaped");
  t.equal(escapeHtml('"'), "&quot;", "double quotes are escaped, which attribute context depends on");
  t.equal(escapeHtml("'"), "&#39;", "and single quotes");
  t.equal(escapeHtml("&"), "&amp;", "and ampersands, so an escape cannot be smuggled through");
  t.equal(escapeHtml('a&<>"\'b'), "a&amp;&lt;&gt;&quot;&#39;b", "all five together, in order");
  t.equal(escapeHtml(null), "null", "a non-string is stringified rather than throwing");
  t.check(!escapeHtml('<script>').includes("<"), "no raw angle bracket survives");

  // --- negative zero security --------------------------------------------
  // formatSecurity returned "-0.0" for anything in (-0.05, 0), and
  // Number("-0.0") is -0, which is NOT less than 0, so a security minimum
  // admitted 559 nullsec systems.
  const band = Object.values(atlas.systems).filter(s => s.security > -0.05 && s.security < 0);
  t.check(band.length > 0, `${band.length} systems sit in (-0.05, 0), the band that produced -0`);
  t.check(band.every(s => formatSecurity(s.security) === "0.0"), "none displays as -0.0; EVE shows 0.0");
  t.check(band.every(s => !Object.is(displayedSecurity(s.security), -0)),
    "and none yields negative zero, which compares false against every lower bound");
  const floor = router.resolveLimits("0.1", "");
  t.check(band.every(s => router.isBlocked(s.system_id, noAvoid, floor)),
    "a minimum of 0.1 blocks every system in that band");

  // --- limits must never silently relax -----------------------------------
  t.equal(router.resolveLimits("0.44", "").min, 0.5, "a minimum rounds up, never admitting more than asked");
  t.equal(router.resolveLimits("0.04", "").min, 0.1, "0.04 becomes 0.1 rather than 0");
  t.equal(router.resolveLimits("", "0.44").max, 0.4, "a maximum rounds down, for the same reason");
  t.equal(router.resolveLimits("", "-0.04").max, -0.1,
    "a negative maximum also rounds down, excluding more rather than less");
  t.check(!Object.is(router.resolveLimits("", "-0.04").max, -0), "and is never negative zero");
  t.equal(router.resolveLimits("0.5", "").min, 0.5, "a value already on the scale is untouched");
  t.throws(() => router.resolveLimits("0x1", ""), "is not a number", "hexadecimal is not a security value");
  t.throws(() => router.resolveLimits("1e1", ""), "is not a number", "nor is exponent notation");
  t.throws(() => router.resolveLimits([0.5], ""), "is not a number", "nor is an array");

  // --- resolvers must not throw TypeError ---------------------------------
  for (const bad of [null, undefined, 30000142, true, {}]) {
    let threw = null;
    try { router.resolveSystem(bad); } catch (error) { threw = error; }
    t.check(threw === null, `resolveSystem(${String(bad)}) returns rather than throwing`);
  }
  t.throws(() => router.calculate(undefined, "Jita"), "Origin system not found", "a missing origin gives a clean error");
  t.throws(() => router.calculate(30000142, "Jita"), "Origin system not found", "and so does a numeric one");

  // --- the jump search must not deny routes that exist --------------------
  const long = jumper.plan("Q-VTWJ", "G-Q5JU", { shipValue: "Avatar" });
  t.check(long.jumps > 25, `a titan crossing New Eden is found at ${long.jumps} jumps, past the old cap of 25`);
  t.check(long.legs.every(leg => leg.distanceLy <= long.rangeLy + 1e-9), "and every leg is still within range");
  t.throws(() => jumper.plan("Q-VTWJ", "G-Q5JU", { shipValue: "Avatar", maxJumps: 5 }),
    "stopped at that limit", "an imposed limit says it stopped, rather than denying the route exists");

  // --- tactical config must not inherit -----------------------------------
  for (const preset of ["constructor", "toString", "valueOf", "__proto__", "hasOwnProperty"]) {
    const config = normalizeTacticalConfig({ preset });
    t.check(Number.isFinite(config.depth) && config.preset === "hunt",
      `preset "${preset}" falls back cleanly instead of yielding NaN depth`);
  }
  t.equal(normalizeTacticalConfig({ preset: "fc" }).preset, "hunt", "the former FC preset migrates to Hunt");
  t.equal(normalizeTacticalConfig({ preset: "logistics" }).preset, "escape", "the former Logistics preset migrates to Escape");
  t.check(Number.isFinite(normalizeTacticalConfig(null).depth), "a null config does not throw");
  const splatted = normalizeTacticalConfig({ blocks: "abc" });
  t.equal(Object.keys(splatted.blocks).sort().join(","), "approaches,borders,chokes,security",
    "a string blocks value cannot splat index keys into stored configuration");
  t.check(Object.values(splatted.blocks).every(v => typeof v === "boolean"), "and every block stays boolean");

  // --- corridors must not coerce -----------------------------------------
  t.throws(() => C.normalizeCorridor({ name: "n", from: "a", to: "b", mode: ["shortest"] }, ROUTE_MODES),
    "non-text mode", "an array mode is refused rather than stringified past the whitelist");
  t.throws(() => C.normalizeCorridor({ name: {}, from: "a", to: "b" }, ROUTE_MODES),
    "must be text", "an object name is refused rather than becoming [object Object]");
  t.throws(() => C.normalizeCorridor({ name: "n", from: { a: 1 }, to: "b" }, ROUTE_MODES),
    "non-text from", "and so is an object origin");
  t.throws(() => C.normalizeCorridor({ name: "n", from: "x".repeat(500), to: "b" }, ROUTE_MODES),
    "longer than", "an oversized field is refused rather than silently filling storage");
  t.equal(C.normalizeCorridor({ name: "n", from: 30000142, to: "b" }, ROUTE_MODES).from, "30000142",
    "a plain number is still accepted, since it stringifies unambiguously");

  // U+212A KELVIN SIGN lowercases to "k", so saving "Kelvin" silently replaced
  // a distinct corridor. NFC also unifies composed and decomposed forms.
  t.check(KELVIN_SIGN !== "Kelvin", "the two names really are different strings");
  t.equal(C.corridorKey(KELVIN_SIGN), C.corridorKey("Kelvin"),
    "but they key identically, so one cannot silently shadow the other");
  t.check(CAFE_COMPOSED !== CAFE_DECOMPOSED, "composed and decomposed forms really are different strings");
  t.equal(C.corridorKey(CAFE_COMPOSED), C.corridorKey(CAFE_DECOMPOSED),
    "and they key identically, so the list cannot hold two visually identical entries");

  // --- layout helpers must contain bad input ------------------------------
  const records = [{ name: "A" }, { name: "B" }];
  const partial = new Map([[records[0], { x: 10, y: 10 }]]);
  let threw = null;
  try {
    relaxLabels(records, partial, r => labelBox(r, "right"), {
      obstacles: [{ x: 0, y: 0, r: 5 }],
      anchors: new Map([[records[0], { x: 10, y: 10 }], [records[1], { x: 20, y: 20 }]]),
      passes: 5,
    });
  } catch (error) { threw = error; }
  t.check(threw === null, `relaxLabels survives a record with no label${threw ? ` (${threw.message})` : ""}`);

  const nanRecords = [{ name: "A" }, { name: "B" }];
  const nanPositions = new Map([[nanRecords[0], { x: NaN, y: 0 }], [nanRecords[1], { x: 0, y: 0 }]]);
  relaxSystems(nanRecords, nanPositions, { passes: 5 });
  t.check(Number.isFinite(nanPositions.get(nanRecords[1]).x),
    "a NaN coordinate stays contained instead of spreading to its neighbour");

  const many = Array.from({ length: 200000 }, (_, i) => ({ i }));
  threw = null;
  try { projectionOf(many, r => [r.i, r.i]); } catch (error) { threw = error; }
  t.check(threw === null, `projectionOf handles 200,000 records${threw ? ` (${threw.message})` : ""}`);

  // --- app.js and index.html must not drift apart -------------------------
  // A harness that fabricates an element for any id asked for lets ids be renamed in
  // `index.html` with the whole suite green while the real page throws on its first
  // render.
  const html = fs.readFileSync(path.join(ROOT, "web", "index.html"), "utf8");
  const pageIds = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]));
  const appSource = fs.readFileSync(path.join(ROOT, "web", "app.js"), "utf8");
  const wanted = [...appSource.matchAll(/\$\(["']([^"']+)["']\)/g)].map(m => m[1]);

  t.check(wanted.length > 30, `app.js reaches for ${wanted.length} elements by id`);
  const missing = [...new Set(wanted)].filter(id => !pageIds.has(id));
  t.equal(missing.join(","), "",
    `every id app.js fetches exists in index.html${missing.length ? ` (missing: ${missing.join(", ")})` : ""}`);

  const duplicates = [...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1])
    .filter((id, index, all) => all.indexOf(id) !== index);
  t.equal(duplicates.join(","), "", `no id appears twice in index.html${duplicates.length ? ` (${duplicates.join(", ")})` : ""}`);

  // Every control the page ships should be reachable from the script, or it is
  // decoration a pilot can click to no effect.
  const interactive = [...html.matchAll(/<(?:button|select|input)\b[^>]*\sid="([^"]+)"/g)].map(m => m[1]);
  const unreferenced = interactive.filter(id =>
    !appSource.includes(`"${id}"`) && !appSource.includes(`'${id}'`));
  t.equal(unreferenced.join(","), "",
    `every button, select and input is referenced by app.js${unreferenced.length ? ` (${unreferenced.join(", ")})` : ""}`);

  // --- locale independence ------------------------------------------------
  // toLocaleLowerCase under a Turkish locale maps "I" to a dotless i, making
  // 530 system names untypeable. Checked by reading the source, because the
  // host locale here cannot reproduce it.
  t.check(router.resolveSystem("ITAMO")?.name === "Itamo", "an uppercase name resolves");
  t.check(router.resolveSystem("itamo")?.name === "Itamo", "and a lowercase one resolves to the same system");
  // Strip comments first: these modules explain in prose why they avoid
  // this call, and a bare substring search would match the explanation.
  const stripComments = source => source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n").map(line => line.replace(/\/\/.*$/, "")).join("\n");
  const modules = ["route-planner.js", "jump-planner.js", "tactical-analyzer.js", "corridors.js", "app.js"];
  const offenders = modules.filter(name =>
    /\.toLocaleLowerCase\s*\(/.test(stripComments(fs.readFileSync(path.join(ROOT, "web", name), "utf8"))));
  t.equal(offenders.join(","), "",
    `no module calls a locale-dependent lowercase${offenders.length ? ` (${offenders.join(", ")})` : ""}`);


  // --- mangled characters -------------------------------------------------
  // Text has been corrupted in transit through this project's tooling three
  // times: a backslash in the living document became "{B}", a sentinel written
  // as an escape became real NUL bytes in a module, and route.css carried a
  // C1 control character where a minus sign belonged - rendering as nothing,
  // directly opposite a "+" that worked.
  //
  // None of that is visible when reading the file. A scan is, so this is it.
  const sourceFiles = [
    ...fs.readdirSync(path.join(ROOT, "web")).map(name => ["web", name]),
    ...fs.readdirSync(path.join(ROOT, "tests")).map(name => ["tests", name]),
  ].filter(([, name]) => /\.(js|mjs|css|html)$/.test(name));
  t.check(sourceFiles.length > 20, `${sourceFiles.length} source files scanned for mangled characters`);

  const controlChars = [];
  for (const [dir, name] of sourceFiles) {
    const text = fs.readFileSync(path.join(ROOT, dir, name), "utf8");
    for (let i = 0; i < text.length; i += 1) {
      const code = text.charCodeAt(i);
      // Tab, newline and carriage return are the only ones that belong.
      if (code === 9 || code === 10 || code === 13) continue;
      if (code < 32 || (code >= 0x7f && code <= 0x9f)) {
        const line = text.slice(0, i).split("\n").length;
        controlChars.push(`${dir}/${name}:${line} U+${code.toString(16).padStart(4, "0")}`);
      }
    }
  }
  t.equal(controlChars.join(", "), "", "no source file carries a control character");

  // U+FFFD is what a decoder leaves behind when bytes did not survive.
  const REPLACEMENT = String.fromCharCode(0xfffd);
  const damaged = sourceFiles
    .filter(([dir, name]) => fs.readFileSync(path.join(ROOT, dir, name), "utf8").includes(REPLACEMENT))
    .map(([dir, name]) => `${dir}/${name}`);
  t.equal(damaged.join(", "), "", "and none carries a Unicode replacement character");

  // Debug output left in a test module.
  //
  // A leftover `console.error` printing a JSON blob on every run goes unread, because
  // the runner's own output scrolls past and a green tally is what gets looked at. A
  // suite that prints noise is a suite whose output stops being read, which is how the
  // next real warning gets missed.
  const noisy = [];
  for (const name of fs.readdirSync(path.join(ROOT, "tests")).filter(f => f.endsWith(".test.mjs"))) {
    const text = fs.readFileSync(path.join(ROOT, "tests", name), "utf8");
    for (const [index, line] of text.split("\n").entries()) {
      if (/^\s*(?:\/\/|\*)/.test(line)) continue;
      if (/console\.(log|error|warn|debug|dir|table)\s*\(/.test(line)) noisy.push(`${name}:${index + 1}`);
    }
  }
  t.equal(noisy.join(", "), "", "no test module prints to the console; the runner does the reporting");


  // --- no source file carries a raw line separator -------------------------
  //
  // U+2028 and U+2029 **terminate a line in JavaScript**, so one inside a `//`
  // comment ends the comment there and turns the rest of the sentence into
  // code. The escape collapses somewhere between an editor and the file, which is the
  // same class as the trailing-backslash hazard the scan above covers and just as
  // invisible: the source looks right and the parser disagrees.
  //
  // Nothing in the archive contains one, so this is free to assert.
  {
    const SEPARATORS = new Set([0x2028, 0x2029]);
    const offenders = [];
    // The documents too. A literal separator is invisible in markdown rather
    // than fatal, which is worse in one way: it survives review and then gets
    // pasted into a source file by whoever copies the paragraph.
    for (const dir of ["web", "tests", "scripts", "."]) {
      for (const name of fs.readdirSync(path.join(ROOT, dir))) {
        if (!/\.(mjs|js|py|md)$/.test(name)) continue;
        const text = fs.readFileSync(path.join(ROOT, dir, name), "utf8");
        for (let i = 0; i < text.length; i += 1) {
          if (SEPARATORS.has(text.codePointAt(i))) {
            offenders.push(`${dir}/${name} at offset ${i}`);
            break;
          }
        }
      }
    }
    t.equal(offenders.length, 0,
      `no source file carries a raw line separator${offenders.length ? ` (${offenders.join(", ")})` : ""}`);
  }

  // --- checks that were narrower than they read --------------------------------
  //
  // Three of them, and the shape is one: a check whose description promised more
  // than its code did, in a file whose whole job is being trusted.
  {
    // **The capability stopped counting.** `capabilities/default.json` said "the
    // seven commands registered in main.rs"; `generate_handler!` lists nine. The
    // count had already been found stale by four once, was fixed by hand, and went
    // stale again by two - because a description cited as authority for what the
    // window may reach was maintained by a person. `tests/contract.test.mjs` holds
    // the handler list against CORE_COMMANDS and ADVISOR_COMMANDS, which is the
    // real inventory; a sentence repeating it can only drift from it.
    const capability = fs.readFileSync(
      path.join(ROOT, "src-tauri", "capabilities", "default.json"), "utf8");
    const parsed = JSON.parse(capability);
    const description = String(parsed.description ?? "");
    t.check(description.length > 0, "the capability carries a description");
    const counted = description.match(/\b(two|three|four|five|six|seven|eight|nine|ten|\d+) commands\b/);
    t.equal(counted, null,
      `and states no command count of its own${counted ? ` (${counted[0]})` : ""}`);
    t.check(/registered in main\.rs/.test(description),
      "while still naming where the inventory lives");

    // **The icon check read one filename.** `icon.png` is the same placeholder,
    // bundled alongside `icon.ico` by `tauri.conf.json`, and was checked by
    // nothing. The directory is read now, so an icon added for a Linux target
    // cannot land outside the check.
    const release = fs.readFileSync(path.join(ROOT, "scripts", "release_check.py"), "utf8");
    const iconCheck = release.slice(release.indexOf("def check_placeholder_icon"),
      release.indexOf("def check_absolute_author_paths"));
    t.check(/iterdir\(\)/.test(iconCheck),
      "the icon check reads the icons directory rather than one filename");
    t.check(!/"icon\.ico"/.test(iconCheck),
      "and names no single icon file");

    // **The blocker list's own patterns.** `check_own_patterns` was added after
    // `MACHINE_PATH` had been blind to backslashes for its whole life - and then
    // exercised only `MACHINE_PATH`. The email pattern was written out twice
    // inline; the author-path and dev-leftover patterns were guarded by nothing.
    const ownPatterns = release.slice(release.indexOf("def check_own_patterns"),
      release.indexOf("def main("));
    for (const name of ["MACHINE_PATH", "EMAIL", "AUTHOR_PATH", "DEV_LEFTOVER"]) {
      t.check(ownPatterns.includes(name),
        `${name} is exercised against its own samples every run`);
      // One definition each: a pattern compiled twice can be fixed once.
      const definitions = (release.match(new RegExp(`^${name} = re\\.compile`, "gm")) ?? []).length;
      t.equal(definitions, 1, `and ${name} is defined exactly once`);
    }
    t.check(!/re\.compile\(r"\[A-Za-z0-9\._%\+-\]\+@/.test(release.replace(/^EMAIL = .*$/m, "")),
      "with no second inline copy of the email pattern left behind");

    // And the separator class is built rather than written, because that escape has
    // been eaten twice in this file - the second time turning the class into plain
    // `/`, which stopped every backslash path matching and was caught only by
    // `check_own_patterns` on the next run.
    t.check(/re\.escape\(chr\(92\)\)/.test(release),
      "the path separator is assembled from a code point rather than written as an escape");

    // **The staging coverage check read `web/*.js`.** Five kinds of reference were
    // outside a check whose stated job is refusing to stage a viewer that fetches
    // something it does not cover: `index.html`, a stylesheet's `url()`, anything in
    // a subdirectory, a `.mjs`, and a literal path rather than an interpolated one.
    // `web/` is flat and all-`.js` today, which is exactly why it was invisible.
    const staging = fs.readFileSync(path.join(ROOT, "scripts", "stage_shell.py"), "utf8");
    t.check(/web\.rglob\("\*"\)/.test(staging),
      "the staging coverage check reads every file under web/, recursively");
    t.check(!/glob\("\*\.js"\)/.test(staging),
      "and not only the flat .js files");
    t.check(/\(\?:\\.\\.\/\)\+data\//.test(staging),
      "and sees a literal ../data path as well as an interpolated one");

    // **A same-size rewrite in the same whole second is not evidence of no change.**
    // `int()` truncates the mtime, and `index.html` is exactly that file on every
    // run: the asset stamp it carries is fixed-length hex, so re-stamping changes
    // twelve characters and not one byte of length. The binary would carry a page
    // with the previous stamp - the "unstaged frontend fails the selftest rather
    // than the suite" failure this script exists to prevent.
    t.check(/read_bytes\(\) == destination\.read_bytes\(\)/.test(staging),
      "and the ambiguous case is settled by reading the bytes rather than assumed");
    t.check(!/int\(current\.st_mtime\) <= int\(existing\.st_mtime\)/.test(staging),
      "so no file is skipped on a mtime comparison that truncates to the second");
  }

  // --- every read of the sighting log names its source -------------------------
  //
  // The log holds one window per thing *and source*. A read that does not name one
  // either collapses two sources into one entry, by writing the later over the
  // earlier, or returns both and counts a thing twice. `heldSystems` was fixed for
  // exactly that and five siblings were not - including `factionSystems`, three
  // lines below it, over a kind the same endpoint writes.
  //
  // Reachable through the import button, which may carry any kind with a source
  // label this build never writes. Scanned rather than argued, because the next one
  // will be added by someone who has not read this comment.
  {
    const offenders = [];
    for (const name of fs.readdirSync(path.join(ROOT, "web")).filter(f => f.endsWith(".js"))) {
      const text = fs.readFileSync(path.join(ROOT, "web", name), "utf8");
      const lines = text.split(NEWLINE);
      lines.forEach((line, index) => {
        if (line.trim().startsWith("//")) return;
        // The definition itself, and the one call that forwards a caller's source.
        if (/export function openObservations/.test(line)) return;
        const call = /openObservations\(([^)]*)\)/.exec(line);
        if (!call) return;
        if (/source/.test(call[1])) return;
        offenders.push(`${name}:${index + 1}`);
      });
    }
    t.equal(offenders.length, 0,
      `every openObservations call names a source (${offenders.join(", ") || "none"})`);
  }

  // --- a sync started from a handler has somewhere for a throw to go ------------
  //
  // Every layer sync uses `try/finally` for its busy flag and none of them catch, so
  // a throw from a renderer or a parse rejects the promise. From a click handler
  // nothing awaits it: the rejection went nowhere, no error slot was filled, and the
  // map simply did not update. `inBackground` is the one place that catches.
  //
  // **No escape sequence in this check.** A pattern built inside a template literal
  // has its escapes resolved by JavaScript before the RegExp sees them, so a word
  // boundary becomes a backspace character and the pattern matches nothing - passing
  // with the defect in front of it. The file on disk holds no control character, so
  // the control-character scan calls it clean: the character is created at runtime.
  {
    const app = fs.readFileSync(path.join(ROOT, "web", "app.js"), "utf8");
    const SYNCS = ["syncLive", "syncSov", "syncAmbient", "syncActivityLayer",
      "syncCampaignLayer", "syncScoutLayer"];
    const HANDLERS = ["onclick", "onchange", "oninput", "addEventListener"];
    // What would make an occurrence part of a longer name, or a property access.
    const WORDISH = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_$.";
    // The predicate, named so it can be exercised against lines whose answers are
    // known. Its first version was checked only by planting a defect in app.js, and
    // that version's word boundary had silently become a backspace character - a
    // table like the one below would have said so without touching app.js at all.
    const unguarded = (line) => {
      const body = line.trim();
      if (body.startsWith("//") || body.includes("async function")) return null;
      if (!HANDLERS.some(handler => body.includes(handler))) return null;
      if (body.includes("inBackground") || body.includes("await")
        || body.includes(".catch(")) return null;
      for (const name of SYNCS) {
        let at = body.indexOf(name);
        while (at >= 0) {
          const before = at === 0 ? " " : body[at - 1];
          const after = body[at + name.length] ?? " ";
          if (!WORDISH.includes(before) && !WORDISH.slice(0, -1).includes(after)) return name;
          at = body.indexOf(name, at + 1);
        }
      }
      return null;
    };

    for (const [line, wanted, why] of [
      ["ui.sovSync.onclick = syncSov;", "syncSov", "an async function assigned straight to a handler"],
      ["ui.ambientSync.onclick = () => syncAmbient();", "syncAmbient", "and one called in an arrow"],
      ['ui.x.addEventListener("click", () => syncLive());', "syncLive", "and through addEventListener"],
      ["ui.sovSync.onclick = () => inBackground(syncSov, \"x\");", null, "one that goes through inBackground"],
      ["ui.x.onclick = async () => { await syncSov(); };", null, "one that awaits it"],
      ["ui.x.onclick = () => syncSov().catch(report);", null, "one that catches"],
      ["// ui.sovSync.onclick = syncSov;", null, "a commented-out line"],
      ["async function syncSov({ fetchImpl = null } = {}) {", null, "the declaration itself"],
      ["ui.x.onclick = () => state.syncSov();", null, "a property access of the same name"],
      ["ui.x.onclick = () => syncSovereignty(store);", null, "a longer name that begins the same"],
      ["const held = syncSov;", null, "a line that is not a handler at all"],
    ]) {
      t.equal(unguarded(line), wanted, `${why} (${line.slice(0, 44)})`);
    }

    const loose = [];
    app.split(NEWLINE).forEach((line, index) => {
      const name = unguarded(line);
      if (name) loose.push(`app.js:${index + 1} ${name}`);
    });
    t.equal(loose.length, 0,
      `every sync started from a handler goes through inBackground (${loose.join(", ") || "none"})`);
  }

  // --- a regex built from a string, carrying a lone backslash --------------------
  //
  // In an untagged template literal - and in an ordinary quoted string - the
  // *language* resolves the escape before `RegExp` is handed the pattern. So
  // `\w` becomes the letter `w`, `\d` becomes `d`, `\.` becomes "any character", and
  // `\b` becomes U+0008. The pattern then matches a different language, and it does
  // so silently: the file on disk holds no control character, so the scan above
  // cannot see it.
  //
  // The direction it fails in is the dangerous one. A guard asking whether every class
  // in the markup has a rule, written ``\.${name}(?![\w-])``, is really
  // `.name(?![w-])`: it matches a bare word with no dot, and matches a longer class that
  // merely begins the same. Both make that check *pass* when it should fail.
  //
  // Two spellings are correct: `String.raw`, or a doubled backslash.
  {
    const BACKSLASH = String.fromCharCode(92);
    // The escapes that change meaning when the language eats one of them.
    const MEANINGFUL = "wWdDsSbBnrtfv.?*+()[]{}|^$/-";
    const offenders = [];
    const roots = ["web", "tests", "scripts"];
    for (const root of roots) {
      const dir = path.join(ROOT, root);
      for (const name of fs.readdirSync(dir)) {
        if (!/[.](js|mjs)$/.test(name)) continue;
        const text = fs.readFileSync(path.join(dir, name), "utf8");
        text.split(NEWLINE).forEach((line, index) => {
          const body = line.trim();
          if (body.startsWith("//") || body.startsWith("*")) return;
          const at = body.indexOf("new RegExp(");
          if (at < 0) return;
          // `String.raw` hands the raw text straight through.
          if (body.includes("String.raw")) return;
          const argument = body.slice(at + "new RegExp(".length);
          for (let i = 0; i < argument.length; i += 1) {
            if (argument[i] !== BACKSLASH) continue;
            // A doubled backslash is the other correct spelling; skip the pair.
            if (argument[i + 1] === BACKSLASH) { i += 1; continue; }
            if (MEANINGFUL.includes(argument[i + 1])) {
              offenders.push(`${root}/${name}:${index + 1} ${BACKSLASH}${argument[i + 1]}`);
              break;
            }
          }
        });
      }
    }
    t.equal(offenders.length, 0,
      `every RegExp built from a string uses String.raw or a doubled backslash `
      + `(${offenders.join(", ") || "none"})`);
  }

  // --- nothing on the map is lit by an SVG filter ---------------------------------
  //
  // A filter has a region and the region is a rectangle, so a filter used to light a
  // node paints a box around that node and its label, sized from the bounding box and
  // therefore different for every label. Selection is expressed in paint instead: a
  // white stroke, and a label lifted to white.
  //
  // Asserted as a property rather than by the filter's name, so a replacement under a
  // different name cannot pass it.
  {
    const markup = fs.readFileSync(path.join(ROOT, "web", "index.html"), "utf8");
    const styles = fs.readdirSync(path.join(ROOT, "web"))
      .filter(name => name.endsWith(".css"))
      .map(name => [name, fs.readFileSync(path.join(ROOT, "web", name), "utf8")]);
    const allStyles = styles.map(([, text]) => text).join("\n");

    const filtered = styles.flatMap(([name, text]) =>
      [...text.matchAll(/([^{}]+)\{[^{}]*[^-\w]filter\s*:\s*url\(/g)]
        .map(match => `${name}: ${match[1].trim().split("\n").pop()}`));
    t.equal(filtered.join("; "), "",
      "no map node is lit by an SVG filter, whose region is always a rectangle");

    t.check(!/<filter\b/.test(markup),
      "and the markup defines no filter for one to reference");

    // The cue that replaced it, so removing the box cannot quietly remove the feedback.
    // Compared as strings: a regex built from a selector needs that selector escaped.
    const rules = allStyles.split("}")
      .map(chunk => ({ selectors: chunk.slice(0, chunk.indexOf("{")), body: chunk.slice(chunk.indexOf("{") + 1) }))
      .filter(rule => rule.selectors && rule.body);
    for (const [selector, property] of [
      [".system-node.selected rect", "stroke"],
      [".system-node.selected .system-name", "fill"],
      [".region-node.selected circle", "stroke"],
      [".region-node.selected text", "fill"],
    ]) {
      const shown = rules.some(rule =>
        rule.selectors.split(",").some(one => one.trim() === selector)
        && rule.body.split(";").some(declaration => declaration.trim().startsWith(property + ":")));
      t.check(shown, `selection still shows: ${selector} sets ${property}`);
    }

    // An SVG node with a tabindex takes a focus outline from the host engine unless one
    // is supplied, and engines disagree about its colour. Supplying one keeps the same
    // control looking the same in a browser and in the desktop webview.
    const focusRule = rules.find(rule => rule.selectors.split(",").some(one => one.trim() === ".region-node:focus"));
    t.check(focusRule?.body.includes("outline:2px solid #f7fafc"),
      "region focus has an explicit light outline rather than a host-engine default");

    // Anything stroked inside the zooming viewport pins its stroke to screen pixels, or
    // the stroke scales with the camera. Asserted for these three rather than in
    // general: pinning is a fact about selector resolution, and a check that compares
    // rule text instead reports elements that a base rule already pins.
    const pins = (selector) => rules.some(rule =>
      rule.selectors.split(",").some(one => one.trim() === selector)
      && rule.body.includes("non-scaling-stroke"));
    for (const selector of [".region-node text", ".region-node circle", ".system-node rect"]) {
      t.check(pins(selector), `${selector} holds its stroke at screen width under zoom`);
    }
  }

  return t.results;
}
