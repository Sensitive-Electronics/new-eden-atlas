// What the page loads, and whether the two halves can drift apart.
//
// The viewer and the archive are cached independently. A browser holding an old
// app.js will load a freshly rebuilt archive without complaint, and the result
// is not a clean failure - it is a map that mostly works with one field missing,
// which is far harder to diagnose than an error.
//
// Two guards. The archive declares a schema version and the viewer checks it.
// And every local asset carries the same cache stamp, because the previous
// arrangement had app.js on a stamp from the day before and five stylesheets on
// no stamp at all, which nothing could see.

import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { readArchive, suite, ROOT } from "./helpers.mjs";

const page = () => fs.readFileSync(path.join(ROOT, "web", "index.html"), "utf8");

export default function run(app) {
  const t = suite("assets");
  const html = page();
  const { state, ui } = app;

  // --- the schema handshake -----------------------------------------------
  const atlas = readArchive();
  t.equal(typeof atlas.meta.schema_version, "number", "the archive declares a schema version");
  t.equal(atlas.meta.schema_version, app.ARCHIVE_SCHEMA,
    "and the viewer is written against exactly that version");

  // It must not be a timestamp. The build is byte-reproducible and two builds
  // of the same input have to agree; a clock in the output would end that.
  t.check(Number.isInteger(atlas.meta.schema_version) && atlas.meta.schema_version < 1000,
    "the version is a small integer, not a date or a clock reading");

  t.check(app.checkArchiveSchema(atlas), "a matching archive passes the check");

  // A viewer newer than its data means the archive needs rebuilding.
  const old = { ...atlas, meta: { ...atlas.meta, schema_version: app.ARCHIVE_SCHEMA - 1 } };
  t.check(!app.checkArchiveSchema(old), "an older archive fails it");
  t.check(/Rebuild the archive/.test(ui.title.textContent), "and is told to rebuild");
  t.check(/build_offline_map/.test(ui.content.innerHTML), "with the command to run");

  // A viewer older than its data is the dangerous one: the page is a cached
  // copy and reloading is what fixes it.
  const ahead = { ...atlas, meta: { ...atlas.meta, schema_version: app.ARCHIVE_SCHEMA + 1 } };
  t.check(!app.checkArchiveSchema(ahead), "a newer archive fails it too");
  t.check(/Reload/.test(ui.title.textContent), "and this time the page is told to reload");
  t.check(/cached copy/.test(ui.content.innerHTML), "because the viewer is the stale half");

  // Absent entirely - an archive built before the field existed.
  t.check(!app.checkArchiveSchema({ meta: {} }), "an archive with no version at all fails");
  t.check(!app.checkArchiveSchema({}), "as does one with no meta block");
  t.check(!app.checkArchiveSchema(null), "and a null archive does not throw");

  // Checking the version is worth nothing if startup does not call it, and
  // init() cannot run here - it fetches. So the call is asserted in the source,
  // the way this suite already checks other things it cannot execute. Located
  // by string search rather than a pattern, because app.js is minified onto
  // very long lines and a regex over that is its own hazard.
  const appSource = fs.readFileSync(path.join(ROOT, "web", "app.js"), "utf8");
  const initStart = appSource.indexOf("async function init(){");
  t.check(initStart >= 0, "init() is locatable in the source");
  const initEnd = appSource.indexOf("if(typeof window", initStart);
  const body = initStart >= 0 ? appSource.slice(initStart, initEnd > initStart ? initEnd : undefined) : "";
  const checkAt = body.indexOf("if(!checkArchiveSchema(atlas))return");
  const plannerAt = body.indexOf("new RoutePlanner(atlas)");
  t.check(checkAt >= 0,
    "startup checks the archive's schema version and stops rather than carrying on with data it does not understand");
  t.check(plannerAt >= 0, "and startup does build a route planner from the archive");
  t.check(checkAt >= 0 && plannerAt >= 0 && checkAt < plannerAt,
    "with the check happening first");
  // --- cache stamps --------------------------------------------------------
  const referenced = [...html.matchAll(/(?:href|src)="([\w.-]+\.(?:css|js))(\?v=([^"]*))?"/g)]
    .map(match => ({ file: match[1], stamp: match[3] }));
  t.check(referenced.length >= 7, `${referenced.length} local assets are referenced by the page`);

  const unstamped = referenced.filter(entry => !entry.stamp).map(entry => entry.file);
  t.equal(unstamped.join(", "), "", "every local asset carries a cache stamp");

  // And the stamp matches the assets it stamps.
  //
  // Consistency was never the problem: all seven already shared one value. The
  // problem was that the value was written by hand on the project's first day
  // and never changed, and a constant query string does not break a cache - it
  // pins one. The URL never varies, so the file can never invalidate.
  //
  // What that costs: a new index.html carrying a new panel served beside a cached
  // app.js with no code to show it. Markup present, element hidden, every static check
  // passing, feature invisible.
  //
  // So the stamp is derived. Change any asset without restamping and this fails, which
  // is the only arrangement that survives somebody being in a hurry.
  //
  // **Every module, not only the linked ones.** The page links one script; the
  // other thirty-odd are reached by `import "./ask-window.js"` with no query
  // string, so a digest over the links alone left them outside it entirely - an
  // edit to `snapshot.js` or `operations.js` changed nothing here and this check
  // passed. Step 6 made that dangerous by adding a module `app.js` imports by
  // name: a cached copy from before `TURN_LIMIT` existed is a module-link error
  // and a blank application, which is this file's own founding bug arriving one
  // import further in.
  const stamped = [...html.matchAll(/(?:src|href)="([A-Za-z0-9_.-]+\.(?:js|css))\?v=([a-f0-9]+)"/g)];
  const digest = createHash("sha256");
  // **A coverage cross-check, because re-implementing the digest is a mirror.**
  //
  // This file recomputed the stamp the same way `stamp_assets.py` does, with the
  // same blind spots, so the two agreed about a set that was wrong: a file in a
  // subdirectory of `web/` was outside `iterdir()`, a `.mjs` was outside the
  // suffix list, and any other served file - a `.json`, an `.svg`, a webfont - was
  // outside both. Two implementations of one mistake is not a cross-check.
  //
  // So what is asserted here is the **set of files covered**, walked
  // independently: everything under `web/` except the page that carries the stamp.
  // The page is excluded because the stamp is written into it.
  {
    const web = path.join(ROOT, "web");
    const walk = (dir, prefix = "") => fs.readdirSync(dir, { withFileTypes: true })
      .flatMap((entry) => (entry.isDirectory()
        ? walk(path.join(dir, entry.name), `${prefix}${entry.name}/`)
        : [`${prefix}${entry.name}`]));
    const everything = walk(web).filter((name) => name !== "index.html").sort();
    const stamper = fs.readFileSync(path.join(ROOT, "scripts", "stamp_assets.py"), "utf8");

    // The stamper walks recursively and excludes only the page. Read from its
    // source, so a narrowing edit fails here rather than going unnoticed until a
    // cached module produces a blank window.
    t.check(/rglob\("\*"\)/.test(stamper),
      "the stamper walks web/ recursively rather than one level");
    t.check(/path\.name != "index\.html"/.test(stamper),
      "and excludes only the page that carries the stamp");
    t.check(!/suffix in \(/.test(stamper),
      "with no extension list to leave a served file outside the digest");
    t.check(everything.length >= 39,
      `so all ${everything.length} files under web/ are covered, not only the .js and .css`);
    t.check(everything.every((name) => !name.startsWith("/")),
      "and the keys are relative paths, so two files of one name cannot collide");
  }

  for (const name of fs.readdirSync(path.join(ROOT, "web")).filter(n => /\.(js|css)$/.test(n)).sort()) {
    digest.update(name);
    const asset = path.join(ROOT, "web", name);
    digest.update(fs.existsSync(asset) ? fs.readFileSync(asset) : Buffer.from("<missing>"));
  }
  t.equal(stamped[0]?.[2], digest.digest("hex").slice(0, 12),
    "the cache stamp is a digest of the assets, so it cannot be stale - run scripts/stamp_assets.py");

  const stamps = [...new Set(referenced.map(entry => entry.stamp))];
  t.equal(stamps.length, 1, `all of them carry the same one (${stamps.join(", ")})`);

  // Every referenced file must exist, or the stamp is decorating a 404.
  const missing = referenced.filter(entry => !fs.existsSync(path.join(ROOT, "web", entry.file)));
  t.equal(missing.map(entry => entry.file).join(", "), "", "and each one exists on disk");

  // --- offline ------------------------------------------------------------
  // The premise is that the map works with no network. A font or a CDN script
  // would break that silently, on a machine that has one - which is every
  // machine it is developed on.
  //
  // The rule is not "no https string exists anywhere". Live layers are meant to
  // reach ESI; that is the point of them, and they are optional by design. The
  // rule is that nothing needed to RENDER the page comes from the network, and
  // that the modules which do reach out are a known, short list rather than
  // whatever has accumulated.
  // The only files allowed to name a remote host. Everything else must render
  // from the archive, which is the whole offline-first claim.
  //
  // eve-scout.js is the one third-party service this project reaches, and it is
  // held to a stricter version of the same rule than ESI is: optional, off by
  // default, and incapable of changing anything if it never answers.
  const LIVE_DATA_MODULES = new Set(["esi.js", "eve-scout.js"]);

  const sources = ["index.html", ...fs.readdirSync(path.join(ROOT, "web"))]
    .filter(name => /\.(html|css|js)$/.test(name));
  const external = [];
  const reachesOut = [];
  for (const name of new Set(sources)) {
    const text = fs.readFileSync(path.join(ROOT, "web", name), "utf8");
    const hits = [...text.matchAll(/["'(](https?:)?\/\/[^"')\s]+/g)]
      // The SVG namespace is a URL that is never fetched.
      .filter(match => !/w3\.org/.test(match[0]));
    if (!hits.length) continue;
    if (LIVE_DATA_MODULES.has(name)) reachesOut.push(name);
    else external.push(`${name}: ${hits[0][0].slice(0, 60)}`);
  }
  t.equal(external.join("; "), "", "nothing needed to render the page comes from the network");
  t.check(reachesOut.length === LIVE_DATA_MODULES.size,
    `every module allowed to reach out actually does (${reachesOut.join(", ")})`);
  // An allowlist nobody prunes stops being one.
  t.check([...LIVE_DATA_MODULES].every(name => sources.includes(name)),
    "and every name on the allowlist is still a file that exists");
  t.equal(reachesOut.sort().join(", "), [...LIVE_DATA_MODULES].sort().join(", "),
    "and the modules that do reach the network are exactly the declared live-data ones");

  // A live-data module must not be loaded by the page itself, or the optional
  // layer becomes part of startup.
  t.check(!/esi\.js/.test(html), "no live-data module is referenced by index.html");

  state.atlas = atlas;
  ui.content.innerHTML = "";
  ui.content.hidden = true;
  ui.title.textContent = "";
  ui.eyebrow.textContent = "";
  // --- every class the code emits is a class the stylesheets define ---------
  //
  // The bug this exists for: the Characters rows emitted `corridor-name`,
  // `corridor-detail` and `open-region`, and the stylesheet defines none of
  // them. In a `1fr 26px` grid the detail text was laid into the button column
  // and the button wrapped below it - wrong from the first render, and it
  // looked merely sparse rather than broken, which is why looking at it did not
  // catch it. `corridor-stale` was found the same way afterwards: emitted for a
  // failed refresh, never styled, so a warning read as another line of detail.
  //
  // Nothing else in the suite compares the two halves. A class name is a string
  // in one file that has to match a string in another, with no compiler between
  // them.
  {
    const emitted = new Map();
    const files = fs.readdirSync(path.join(ROOT, "web"))
      .filter(name => name.endsWith(".js") || name.endsWith(".html"));
    for (const name of files) {
      const text = fs.readFileSync(path.join(ROOT, "web", name), "utf8");
      // Only static class lists. An interpolated one is not a literal and
      // cannot be checked from here.
      for (const match of text.matchAll(/class="([^"${}]+)"/g)) {
        for (const cls of match[1].split(/\s+/).filter(Boolean)) {
          if (!emitted.has(cls)) emitted.set(cls, name);
        }
      }
    }
    const defined = new Set();
    for (const name of fs.readdirSync(path.join(ROOT, "web")).filter(n => n.endsWith(".css"))) {
      const text = fs.readFileSync(path.join(ROOT, "web", name), "utf8");
      for (const match of text.matchAll(/\.([A-Za-z][\w-]*)/g)) defined.add(match[1]);
    }
    const orphans = [...emitted].filter(([cls]) => !defined.has(cls));
    t.equal(orphans.length, 0,
      `every emitted class is styled${orphans.length ? ` (${orphans.map(([c, f]) => `${c} in ${f}`).join(", ")})` : ""}`);
    t.check(emitted.size > 80, `and there are enough of them to be checking something (${emitted.size})`);
  }

  return t.results;
}
