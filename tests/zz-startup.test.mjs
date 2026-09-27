// What startup says when it cannot finish.
//
// Named to sort last. It is the only test that calls init(), which re-binds
// every control in the application, and a half-initialised app is not a fair
// harness for anything that runs after it. It restores a working one before it
// returns, but running last as well costs nothing and removes the question.
//
// The failure it guards: one catch covered fetching the archive and everything
// done with it afterwards, and reported all of it as "Archive unavailable /
// Open the atlas through its local web server". Right words for a missing file,
// wrong words for anything else - a fault in renderUniverse, or a throw while
// building the tactical index, sends the pilot to check a web server that was
// working perfectly.

import { readArchive, readShips, suite } from "./helpers.mjs";

export default function run(app) {
  const t = suite("startup");
  const ui = id => document.getElementById(id);
  const atlas = readArchive();
  const ships = readShips();
  const index = Object.values(atlas.regions)
    .map(region => ({ region_id: region.region_id, name: region.name, system_count: region.system_count }));

  const serveWorking = async url => ({
    ok: true,
    status: 200,
    json: async () => {
      const path = String(url);
      if (path.includes("ships.json")) return ships;
      if (path.includes("eve_map_all.json")) return atlas;
      if (path.includes("regions.json")) return index;
      return {};
    },
  });

  return (async () => {
    const realFetch = globalThis.fetch;
    const realError = console.error;
    console.error = () => {};
    try {
      // 1. The archive cannot be fetched at all.
      globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
      await app.init();
      t.check(/Archive unavailable/.test(ui("title").textContent),
        "an unreachable archive is reported as an unreachable archive");
      t.check(/local web server/.test(ui("emptyInspector").innerHTML),
        "and points at the server, which is the thing to fix");
      t.equal(ui("loading").style.display, "none", "with the spinner cleared");

      // 2. It reads, passes the schema check, then throws while drawing.
      globalThis.fetch = async url => {
        const response = await serveWorking(url);
        if (!String(url).includes("eve_map_all.json")) return response;
        return { ...response, json: async () => ({ ...atlas, regions: null }) };
      };
      await app.init();
      t.check(!/Archive unavailable/.test(ui("title").textContent),
        "a failure after the archive loaded is not reported as a missing archive");
      t.check(/could not be drawn/.test(ui("title").textContent), "it is reported as what it is");
      t.check(/fault in the viewer/.test(ui("emptyInspector").innerHTML),
        "naming where to look, instead of sending the pilot to the server");
      t.equal(ui("loading").style.display, "none", "and the spinner is still cleared");

      // 3. And a good start still works, which also leaves the app usable.
      globalThis.fetch = serveWorking;
      await app.init();
      t.check(app.state.atlas, "a working start loads the archive");
      t.check(app.state.routePlanner, "and builds a router");
      t.check(!/could not be drawn|Archive unavailable/.test(ui("title").textContent),
        "with no failure reported");

      // --- and running it again attaches nothing twice ---------------------------
      // Twenty-five of the binds use addEventListener, which appends. In the
      // browser init runs once and this could not arise; it is exported so a
      // reload path or a test can call it again, and an export is a promise
      // that doing so is safe.
      //
      // Measured as a difference, not an absolute. Other suites in this shared
      // harness bind these same controls directly, so the count when this runs
      // is whatever they left behind. What must hold is that another init adds
      // none of its own.
      const listeners = element => Object.values(element?._listeners ?? {})
        .reduce((total, list) => total + list.length, 0);
      const watched = ["routeMode", "avoidSystems", "routeMinSec", "scoutHull"];
      const before = watched.map(id => listeners(ui(id)));
      t.check(before.some(n => n > 0), `the controls carry handlers to begin with (${before.join(", ")})`);
      await app.init();
      const after = watched.map(id => listeners(ui(id)));
      t.equal(after.join(","), before.join(","),
        `another init attaches nothing twice (${before.join(",")} then ${after.join(",")})`);
      await app.init();
      t.equal(watched.map(id => listeners(ui(id))).join(","), before.join(","),
        "nor a third time");
    } finally {
      globalThis.fetch = realFetch;
      console.error = realError;
    }

    return t.results;
  })();
}
