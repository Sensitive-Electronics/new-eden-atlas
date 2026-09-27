// Break the code on purpose and see which assertions notice.
//
//     node scripts/mutate.mjs           # a default sweep, ~160 mutations
//     node scripts/mutate.mjs 40        # a shorter one
//     node scripts/mutate.mjs 60 app.js,contract.js
//                                       # only those files
//
// The filter matters more than it looks. A sweep spread evenly over every module
// spends most of its budget re-confirming code that an earlier sweep already
// cleared and nothing has touched since, while the newest work - where the
// assertions are youngest and least probed - gets a handful of mutations.
// Naming the files that changed is how a sweep stays about them.
//
// Why this exists. A green suite says the code passes its tests; it does not say the
// tests would fail if the code were wrong. An assertion can be unable to fail, and the
// shapes it takes here are worth knowing:
//
//   - A guard checked on a fixture that never reaches it - "no leg arrives in Pochven
//     or Zarzakh", on a route where no restricted system was ever in range.
//   - A boundary tested only through real data, where no datum sits on the boundary.
//     No system in New Eden has a security of exactly 0.45, so relaxing that
//     comparison changes nothing a suite over real systems can see.
//   - A clause shadowed by an earlier one. The neighbour test that refuses the 618
//     gateless K-space systems is never reached if the only refusal tested is a
//     wormhole system, which the wormhole check rejects first.
//
// None of those is visible by reading. All of them show up as a changed operator and a
// suite that stays green.
//
// A surviving mutation is not necessarily a bug. It says the suite cannot tell
// the difference between this code and a changed version of it, which is where
// a real bug would be able to hide. Some survivors are equivalent mutants -
// `< depth` against `<= depth` on a set that can never contain the boundary
// case - and those are worth recording as such rather than papering over with a
// test that asserts nothing. The list is a reading list, not a defect list.
//
// It works on a private copy of the tree, so it can run while the working tree
// is being edited and cannot leave a mutation behind if it is interrupted.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BUDGET = Number(process.argv[2] ?? 160);
const ONLY = (process.argv[3] ?? "").split(",").map(name => name.trim()).filter(Boolean);

// Textual, and chosen to change behaviour without usually breaking the parse.
// A mutation that fails to parse tells you nothing: every test fails, and the
// suite has not distinguished anything.
const OPERATORS = [
  [/ >= /g, " > "], [/ <= /g, " < "],
  [/ > /g, " >= "], [/ < /g, " <= "],
  [/ === /g, " !== "], [/ !== /g, " === "],
  [/ && /g, " || "], [/ \|\| /g, " && "],
  [/\breturn true\b/g, "return false"], [/\breturn false\b/g, "return true"],
  [/\?\? /g, "|| "], [/\+ 1\b/g, "+ 2"], [/- 1\b/g, "- 2"],
  [/Math\.max\(/g, "Math.min("], [/Math\.min\(/g, "Math.max("],
  [/\.length === 0/g, ".length !== 0"],
];

const snapshot = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-mutate-"));
for (const dir of ["web", "tests", "data", "scripts"]) {
  fs.cpSync(path.join(ROOT, dir), path.join(snapshot, dir), { recursive: true });
}

const SOURCES = fs.readdirSync(path.join(snapshot, "web"))
  .filter(name => name.endsWith(".js"))
  .filter(name => !ONLY.length || ONLY.some(wanted => name === wanted || name.includes(wanted)))
  .map(name => path.join("web", name));

if (!SOURCES.length) {
  console.error(`no web/ sources match ${ONLY.join(", ")}`);
  process.exit(1);
}
if (ONLY.length) console.log(`sweeping only: ${SOURCES.join(", ")}
`);

const read = file => fs.readFileSync(path.join(snapshot, file), "utf8");
const write = (file, text) => fs.writeFileSync(path.join(snapshot, file), text);

function suitePasses() {
  try {
    const out = execFileSync("node", ["tests/run.mjs"], { cwd: snapshot, encoding: "utf8", timeout: 240000 });
    return /, 0 failed/.test(out);
  } catch {
    // A crash is a caught mutation: the suite noticed, however loudly.
    return false;
  }
}

const originals = new Map(SOURCES.map(file => [file, read(file)]));
const survivors = [];
let applied = 0;
let killed = 0;

// Several sites per operator and file, spread through the file, because one
// sample of a module with ninety comparisons says almost nothing about the
// other eighty-nine.
outer:
for (const fraction of [0.12, 0.3, 0.5, 0.7, 0.88]) {
  for (const [pattern, replacement] of OPERATORS) {
    for (const file of SOURCES) {
      const source = originals.get(file);
      const matches = [...source.matchAll(pattern)];
      if (!matches.length) continue;
      const target = matches[Math.min(matches.length - 1, Math.floor(matches.length * fraction))];
      const mutated = source.slice(0, target.index)
        + replacement
        + source.slice(target.index + target[0].length);
      if (mutated === source) continue;

      write(file, mutated);
      const survived = suitePasses();
      write(file, source);

      applied += 1;
      if (survived) {
        const line = source.slice(0, target.index).split("\n").length;
        survivors.push({
          file,
          line,
          from: target[0].trim(),
          to: replacement.trim(),
          text: source.split("\n")[line - 1].trim().slice(0, 110),
        });
      } else {
        killed += 1;
      }
      if (applied % 10 === 0) {
        process.stdout.write(`  ...${applied} applied, ${killed} killed, ${survivors.length} survived\n`);
      }
      if (applied >= BUDGET) break outer;
    }
  }
}

fs.rmSync(snapshot, { recursive: true, force: true });

console.log(`\n=== ${applied} mutations: ${killed} killed, ${survivors.length} survived ===\n`);
const byFile = new Map();
for (const survivor of survivors) {
  byFile.set(survivor.file, [...(byFile.get(survivor.file) ?? []), survivor]);
}
for (const [file, list] of [...byFile].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`${file}  (${list.length})`);
  for (const s of list) console.log(`   :${s.line}  "${s.from}" -> "${s.to}"   ${s.text}`);
}
if (!survivors.length) console.log("Every mutation was caught.");
