// Offline verification for the web interface.
//
//   node tests/run.mjs
//
// No installed dependency, no network, no browser. The DOM shim in this folder is only
// as good as what web/app.js actually uses; real layout, paint and CSS are out of its
// reach and still need checking by eye.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// From the timers module, not the global: installDom() replaces
// globalThis.setTimeout with a synchronous stub, which made the settle loop
// below resolve instantly and yield no real time for pending work to finish.
import { setTimeout as sleep } from "node:timers/promises";
import { installDom } from "./dom-shim.mjs";

// A rejection thrown after a module returned would otherwise vanish, taking
// its assertion failure with it and leaving the run green.
const lateFailures = [];
process.on("unhandledRejection", reason => {
  lateFailures.push(`unhandled rejection: ${reason?.stack ?? reason}`);
});
process.on("uncaughtException", error => {
  lateFailures.push(`uncaught exception: ${error?.stack ?? error}`);
});

// Those two handlers also suppress Node's own reporting, which is fine once
// the run reaches its tally and prints them - and silent when it never does. A
// syntax error in web/app.js rejects the top-level await below, the handler
// catches it, the script stops before printing anything, and the process exits
// 0 with no output at all: the greenest possible run of nothing. So the exit
// is guarded rather than the tally trusted.
let tallied = false;
process.on("exit", () => {
  if (tallied) return;
  console.log("The run stopped before reporting. Nothing was verified.");
  for (const failure of lateFailures) console.log(`  - ${failure}`);
  process.exitCode = 1;
});

// Must precede the import of app.js, which reads the document as it loads.
// The suite needs no network, and that has to be enforced rather than trusted.
// An ESI client test that omitted its injected fetch fell through to Node's
// global one and made a real request - green, and quietly dependent on CCP
// being up. Any call now fails loudly and names the URL.
const networkCalls = [];
globalThis.fetch = async (resource) => {
  const target = String(resource?.url ?? resource);
  networkCalls.push(target);
  throw new Error(`the test suite must not use the network, but something requested ${target}`);
};

installDom();
const app = await import("../web/app.js");

// Discovered, not listed. A hand-maintained list silently skips any new file.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULES = fs.readdirSync(HERE)
  .filter(name => name.endsWith(".test.mjs"))
  .map(name => name.replace(/\.test\.mjs$/, ""))
  .sort();

const width = 22;
let totalPassed = 0;
let totalFailed = 0;
let erroredModules = 0;
const allFailures = [];
const reported = [];

for (const name of MODULES) {
  let results;
  try {
    const module = await import(`./${name}.test.mjs`);
    results = await module.default(app);
    // A module that returns the suite wrapper instead of its results took the
    // whole run down silently: the property reads below sit outside this try,
    // the uncaughtException handler above swallowed the throw, top-level await
    // stopped, and the process exited 0 with four suites unreported and no
    // tally printed. A green exit for an unfinished run is the worst failure
    // this harness can have, so the shape is checked where it can be caught.
    if (!results || typeof results.passed !== "number" || !Array.isArray(results.failures)) {
      throw new Error("returned no results object -- a module must end with `return t.results`, not `return t`");
    }
  } catch (error) {
    totalFailed += 1;
    erroredModules += 1;
    allFailures.push(`${name}: threw before reporting -- ${error.stack ?? error.message}`);
    console.log(`${name.padEnd(width)} ERROR`);
    continue;
  }

  reported.push(results);
  const status = results.failures.length ? `${results.failures.length} FAILED` : "ok";
  console.log(`${results.title.padEnd(width)} ${String(results.passed).padStart(3)} passed  ${status}`);
}

// Let anything pending settle before judging the run. A failure parked behind
// real async work lands in its module's results object after that module has
// already returned, so the tally has to happen here rather than there.
for (let i = 0; i < 5; i += 1) {
  await sleep(10);
  await new Promise(resolve => setImmediate(resolve));
}

for (const results of reported) {
  totalPassed += results.passed;
  totalFailed += results.failed;
  for (const failure of results.failures) allFailures.push(`${results.title}: ${failure}`);
}

if (networkCalls.length) {
  totalFailed += 1;
  allFailures.push(`the suite attempted ${networkCalls.length} network call(s): ${networkCalls[0]}`);
}

for (const failure of lateFailures) {
  totalFailed += 1;
  allFailures.push(failure);
}

// Belt and braces for the same failure: every discovered module must have
// reported one way or the other, or the tally is over a subset of the suite
// and a green run means less than it appears to.
if (reported.length + erroredModules < MODULES.length) {
  totalFailed += 1;
  allFailures.push(`only ${reported.length + erroredModules} of ${MODULES.length} modules were accounted for`);
}

if (allFailures.length) {
  console.log("\nFailures:");
  for (const failure of allFailures) console.log(`  - ${failure}`);
}

console.log(`\n${totalPassed} passed, ${totalFailed} failed`);
tallied = true;
// exitCode rather than exit(), so nothing still queued is cut off.
process.exitCode = totalFailed ? 1 : 0;
