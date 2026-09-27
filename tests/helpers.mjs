import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function readArchive() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "data", "eve_map_all.json"), "utf8"));
}

export function readShips() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "data", "ships.json"), "utf8"));
}

export function readRegion(name) {
  const file = `${name.replaceAll(" ", "_").replaceAll("/", "_")}.json`;
  return JSON.parse(fs.readFileSync(path.join(ROOT, "data", "regions", file), "utf8"));
}

// A failure records what was expected as well as what happened, so a red run
// is diagnosable without re-running under a debugger.
export function suite(title) {
  const results = { title, passed: 0, failed: 0, failures: [] };

  const record = (ok, label, detail) => {
    if (ok) {
      results.passed += 1;
    } else {
      // Both must move together: the runner totals `failed`, and a count that
      // never rose would let a red run report green.
      results.failed += 1;
      results.failures.push(detail ? `${label} -- ${detail}` : label);
    }
    return ok;
  };

  return {
    results,
    check: (ok, label) => record(Boolean(ok), label),
    equal: (actual, expected, label) =>
      record(actual === expected, label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`),
    throws: (fn, fragment, label) => {
      try {
        fn();
        return record(false, label, "did not throw");
      } catch (error) {
        return record(error.message.includes(fragment), label,
          `expected a message containing "${fragment}", got "${error.message}"`);
      }
    },
    rejects: async (fn, fragment, label) => {
      try {
        await fn();
        return record(false, label, "did not reject");
      } catch (error) {
        return record(error.message.includes(fragment), label,
          `expected "${fragment}", got "${error.message}"`);
      }
    },
  };
}
