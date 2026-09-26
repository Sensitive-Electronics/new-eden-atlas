// How the viewer asks for the archive.
//
// This module had no test of its own, and it is the one place where a mistake
// is invisible from inside the application: every request succeeds, the data
// parses, nothing throws, and the map is simply built from a file that is not
// the one on disk.
//
// That is what had happened. A hand-written constant was appended to each
// archive URL as `?v=` to break the browser cache when the data changed, and it
// was never bumped once after the initial commit - while the archive changed
// repeatedly, most recently losing 2.8 MB and going from schema 4 to schema 5.
// A returning browser served its cached copy, the viewer read the old schema
// version, and tells the pilot to rebuild an archive they have already
// rebuilt. The string made staleness look handled and pointed the diagnosis
// the wrong way.

import fs from "node:fs";
import path from "node:path";
import { readArchive, suite, ROOT } from "./helpers.mjs";
import { loadAtlas, loadRegionData, loadShips } from "../web/data-service.js";

export default function run() {
  const t = suite("data service");

  return (async () => {
    const calls = [];
    const realFetch = globalThis.fetch;
    const serve = (body, { ok = true, status = 200 } = {}) => async (url, options) => {
      calls.push({ url: String(url), options });
      return { ok, status, json: async () => body };
    };

    try {
      // --- the archive must be revalidated, never served from a stale cache ------
      globalThis.fetch = serve({ ships: [] });
      await loadShips();
      t.equal(calls.length, 1, "loading ships makes one request");
      t.equal(calls[0].options?.cache, "no-cache",
        "asking the browser to revalidate rather than trust its cache");
      t.check(!/[?]v=/.test(calls[0].url),
        `and no hand-written version string, which nobody remembers to bump (${calls[0].url})`);

      calls.length = 0;
      globalThis.fetch = serve([]);
      await loadAtlas();
      t.equal(calls.length, 2, "the atlas is the index and the archive together");
      t.check(calls.every(call => call.options?.cache === "no-cache"),
        "both revalidated, since either going stale misreads the other");

      // --- a failed request is an error, not an empty archive -------------------
      calls.length = 0;
      globalThis.fetch = serve(null, { ok: false, status: 404 });
      let failed = null;
      try {
        await loadShips();
      } catch (error) {
        failed = error;
      }
      t.check(failed, "a non-ok response throws rather than returning nothing");
      t.check(/404/.test(failed?.message ?? ""), "naming the status, so the cause is in the message");

      // --- region filenames have to match what the build writes -----------------
      // The build and the verifier both derive this name from the region's own
      // name. If this disagrees with them, the request 404s for exactly the
      // regions whose names contain a space - twenty-three of the hundred and
      // fourteen - and only for those, which is the shape of bug that reaches
      // a release because the region somebody tests with happens to be Delve.
      const atlas = readArchive();
      const names = Object.values(atlas.regions).map(region => region.name);
      const spaced = names.filter(name => name.includes(" "));
      t.check(spaced.length > 20, `regions with a space in the name exist (${spaced.length})`);

      let missing = [];
      for (const name of names) {
        calls.length = 0;
        globalThis.fetch = serve({ region: { name } });
        await loadRegionData(name);
        const requested = calls[0].url.split("/").pop();
        const onDisk = path.join(ROOT, "data", "regions", requested);
        if (!fs.existsSync(onDisk)) missing.push(`${name} -> ${requested}`);
      }
      t.equal(missing.length, 0,
        `every region resolves to a file the build actually wrote (${missing.slice(0, 3).join("; ")})`);

      // --- a region is fetched once ---------------------------------------------
      calls.length = 0;
      globalThis.fetch = serve({ region: { name: "Cached" } });
      const first = await loadRegionData("cache-probe");
      const second = await loadRegionData("cache-probe");
      t.equal(calls.length, 1, "a region already loaded is not requested again");
      t.equal(first, second, "and the same object comes back, so callers can compare by identity");
    } finally {
      globalThis.fetch = realFetch;
    }

    // --- and no hand-written cache-buster anywhere in the page --------------------
  //
  // A hand-written one serves a stale copy and sends the pilot to rebuild an archive
  // they have already rebuilt, because nothing bumps it. On the script tag it is worse:
  // a new index.html carrying a new panel loads alongside a cached app.js with no code
  // to show it, so every static check passes and the feature is invisible.
  //
  // A constant query string does not break a cache. It pins one: the URL never
  // changes, so the file can never invalidate.
  // The stamp is derived from the assets rather than declared, so it cannot go
  // stale. `scripts/stamp_assets.py` recomputes it and `--check` fails when it
  // is wrong; the assets suite asserts the value itself.
  const page = fs.readFileSync(path.join(ROOT, "web", "index.html"), "utf8");
  const stamps = [...page.matchAll(/(?:src|href)="[^"]*\?v=([^"]*)"/g)].map(m => m[1]);
  t.check(stamps.length > 0, "the page stamps its assets");
  t.equal(new Set(stamps).size, 1,
    "with one stamp shared by all of them, so they cannot invalidate separately");
  t.check(/^[a-f0-9]{12}$/.test(stamps[0] ?? ""),
    `and it is a digest rather than a hand-written date (${stamps[0]})`);

  return t.results;
  })();
}
