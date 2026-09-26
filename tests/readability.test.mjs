// A line-length ratchet for the authored sources.
//
// The point of phase 2 was that app.js had become unreadable: state, rendering,
// persistence, validation and templates on lines of up to 4,064 characters,
// where a wrong number or a missing state reset is invisible. Several real
// defects hid there.
//
// This does not enforce a style. Most modules here were written normally and
// reformatting them to match a tool would churn good code for nothing. It
// enforces the one property that actually made the code unreadable, and it
// ratchets: each file carries a budget of over-long lines, and the budget may
// only ever go down. Removing an entry is the goal; raising one needs a reason
// good enough to write next to it.

import fs from "node:fs";
import path from "node:path";
import { suite, ROOT } from "./helpers.mjs";

// Nothing authored should ever be a single enormous line again. app.js was
// 4,064 characters at its worst and styles.css was 10,468.
const NEVER_EXCEED = 600;

// Lines longer than this are hard to read. The budgets are what each file
// carries today, not a target.
const LONG = 200;
const BUDGETS = {
  // Remaining: the edge-styling loop, the two pointer handlers, the keyboard
  // handler, the label relaxation in the universe view, two schema-mismatch
  // template strings and the jump plan call. Each is a candidate for extraction.
  //
  // Seven went by splitting statements that a newline cannot change the meaning of
  // - an import list, four objects built from form fields, a shared listener over
  // an array of inputs, and an `if`-`for` written on one line. The project's own
  // `format_js.py` is the wrong tool for the rest: it inserts newlines only at
  // parenthesis depth zero, so a long *expression* comes out exactly as it went in
  // - measured, sixteen over 200 before and after - and it collapses blank lines,
  // which would churn the two and a half thousand lines here that read fine.
  "app.js": 9,
  // Two long report-building expressions in the analyzer.
  "tactical-analyzer.js": 2,
  // Three inline SVG path definitions, which are data rather than code.
  "index.html": 3,
};

export default function run() {
  const t = suite("readability");
  const files = fs.readdirSync(path.join(ROOT, "web"))
    .filter(name => /\.(js|css|html)$/.test(name))
    .sort();
  t.check(files.length >= 17, `${files.length} authored sources checked`);

  const offenders = [];
  const overBudget = [];
  const shrunk = [];

  for (const name of files) {
    const lines = fs.readFileSync(path.join(ROOT, "web", name), "utf8").split("\n");
    const longest = lines.reduce((worst, line) => Math.max(worst, line.length), 0);
    if (longest > NEVER_EXCEED) offenders.push(`${name} (${longest})`);

    const count = lines.filter(line => line.length > LONG).length;
    const budget = BUDGETS[name] ?? 0;
    if (count > budget) overBudget.push(`${name}: ${count} lines over ${LONG}, budget ${budget}`);
    if (count < budget) shrunk.push(`${name}: ${count} now, budget still ${budget}`);
  }

  t.equal(offenders.join(", "), "",
    `no authored source has a line over ${NEVER_EXCEED} characters`);
  t.equal(overBudget.join("; "), "",
    "no file exceeds its budget of over-long lines");

  // The ratchet only works if it tightens. A file that improved and left its
  // budget behind is reported, because a stale budget silently allows the
  // regression it was meant to prevent.
  t.equal(shrunk.join("; "), "",
    "and no budget is looser than the file it guards - lower it when the file improves");

  // --- a statement hidden on a closing-brace line -------------------------------
  //
  // `}for(const node of state.nodes){` was the hardest shape in app.js to read: the
  // eye takes the `}` as the end of the thought and stops, so the statement after it
  // is invisible. Twenty-five of them, all in the one file, and each one a place a
  // reader could miss an entire loop.
  //
  // Not a line-length rule - most of them were short lines. And written with no
  // escape in it: the first version used a word boundary, which arrived here through
  // tooling as five literal backspace characters and was caught by this repository's
  // own control-character scan.
  const CONTINUES = ["else", "catch", "finally", "while", "from", "as", "in", "of", "instanceof"];
  const hidden = [];
  for (const name of files.filter(file => file.endsWith(".js"))) {
    const source = fs.readFileSync(path.join(ROOT, "web", name), "utf8");
    source.split(String.fromCharCode(10)).forEach((line, index) => {
      const body = line.trim();
      if (!body.startsWith("}") || body.startsWith("//")) return;
      const rest = body.slice(1).trim();
      if (rest === "") return;
      // Punctuation and operators continue the same statement: `} = value`,
      // `}.method()`, `});`, `}]`.
      if (!/^[A-Za-z_$]/.test(rest)) return;
      // A keyword that continues one too: an import clause, an `else`, a `for...of`.
      if (CONTINUES.includes(/^[A-Za-z]+/.exec(rest)[0])) return;
      // A closing brace inside a template literal is not a block.
      const upTo = line.slice(0, line.indexOf("}"));
      if ((upTo.match(/`/g) ?? []).length % 2 === 1) return;
      hidden.push(`${name}:${index + 1}`);
    });
  }
  t.equal(hidden.length, 0,
    `no statement begins on a closing-brace line (${hidden.slice(0, 4).join(", ") || "none"})`);

  // The budgets must name real files, or an entry quietly protects nothing.
  const unknown = Object.keys(BUDGETS).filter(name => !files.includes(name));
  t.equal(unknown.join(", "), "", "every budget entry names a file that exists");

  // --- every class the markup uses has a rule somewhere -------------------------
  // A class name invented at the markup and never styled produces no error, no
  // warning and no visible fault beyond the element being laid out wrongly -
  // which is only noticeable if somebody opens that panel and knows what it was
  // meant to look like. The Live history shelf shipped with a `corridor-actions`
  // row that existed nowhere, so its buttons had no row styling at all, and the
  // suite was perfectly green.
  const markup = fs.readFileSync(path.join(ROOT, "web", "index.html"), "utf8");
  const styles = fs.readdirSync(path.join(ROOT, "web"))
    .filter(name => name.endsWith(".css"))
    .map(name => fs.readFileSync(path.join(ROOT, "web", name), "utf8"))
    .join(String.fromCharCode(10));
  const classes = new Set();
  for (const match of markup.matchAll(/class="([^"]+)"/g)) {
    for (const name of match[1].split(/\s+/)) if (name) classes.add(name);
  }
  t.check(classes.size > 40, `enough classes were scanned to mean something (${classes.size})`);
  // **`String.raw`, because this pattern is built from a string.**
  //
  // It was written in an untagged template literal - `` `\.${name}(?![\w-])` `` - and
  // JavaScript resolves those escapes before `RegExp` ever sees them. The pattern was
  // really `.corridor-drop(?![w-])`: a literal dot became "any character", and `\w`
  // became the single letter `w`. Measured, it matched a bare word with no dot at all,
  // and it matched `.corridor-dropzone` when asked about `corridor-drop` - both of
  // which make this check *pass* when it should fail.
  //
  // That matters more here than almost anywhere: this check exists because an unstyled
  // row is invisible to every other check in the suite. A guard for an invisible fault
  // that is itself hollow leaves the fault invisible and adds a green tick on top.
  const styleRule = (name) => new RegExp(
    String.raw`\.` + name.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`) + String.raw`(?![\w-])`,
  );

  // The pattern, against cases whose answers are known. Reading a regex is how the
  // broken one survived; this is the part that would have caught it.
  for (const [css, wanted, why] of [
    [".corridor-drop { color: red }", true, "a rule for exactly that class"],
    [".a .corridor-drop { }", true, "and one nested in a descendant selector"],
    [".corridor-drop.bridge-save { }", true, "and one combined with another class"],
    ["corridor-drop { }", false, "a selector with no dot is not a class rule"],
    ["/* corridor-drop is styled below */", false, "and neither is a mention in a comment"],
    [".corridor-dropzone { }", false, "nor a longer class that merely begins the same"],
    [".corridor-drop-inner { }", false, "nor one that continues with a hyphen"],
  ]) {
    t.equal(styleRule("corridor-drop").test(css), wanted,
      `${why} (${css.slice(0, 34)})`);
  }

  const unstyled = [...classes].filter(name => !styleRule(name).test(styles));
  t.equal(unstyled.length, 0,
    `every class in the markup has a rule in some stylesheet (${unstyled.map(c => "." + c).join(", ")})`);

  return t.results;
}
