import { readArchive, readRegion, suite } from "./helpers.mjs";
import { store, downloads } from "./dom-shim.mjs";
import * as C from "../web/corridors.js";
import { ROUTE_MODES, RoutePlanner } from "../web/route-planner.js";
import { project, relaxSystems } from "../web/map-utils.js";

const GOOD = {
  name: "Jita supply run", from: "Jita", to: "Amarr", mode: "safer",
  avoidSystems: "Niarja", avoidRegions: "", minSecurity: "0.5", maxSecurity: "",
};

export default async function run(app) {
  const t = suite("corridors");
  const M = ROUTE_MODES;

  // --- module -------------------------------------------------------------
  const n = C.normalizeCorridor(GOOD, M);
  t.check(n.name === GOOD.name && n.minSecurity === "0.5", "a complete record round-trips");
  t.check(!Number.isNaN(Date.parse(n.saved)), "a save timestamp is stamped");
  t.equal(C.normalizeCorridor({ name: "x", from: "a", to: "b" }, M).mode, "shortest", "mode defaults to shortest");
  t.equal(C.normalizeCorridor({ name: " padded ", from: " Jita ", to: "Amarr" }, M).name, "padded", "values are trimmed");
  t.equal(C.normalizeCorridor({ ...GOOD, junk: "x" }, M).junk, undefined, "unknown fields are dropped");
  t.throws(() => C.normalizeCorridor(null, M), "Not a corridor record", "null rejected");
  t.throws(() => C.normalizeCorridor({ from: "a", to: "b" }, M), "must have a name", "a nameless record is rejected");
  t.throws(() => C.normalizeCorridor({ name: "x", to: "b" }, M), "has no origin", "missing origin rejected");
  t.throws(() => C.normalizeCorridor({ name: "x", from: "a" }, M), "has no destination", "missing destination rejected");
  t.throws(() => C.normalizeCorridor({ name: "x", from: "a", to: "b", mode: "warp" }, M), "unknown routing mode", "unknown mode rejected");

  let list = C.upsertCorridor([], C.normalizeCorridor(GOOD, M));
  list = C.upsertCorridor(list, C.normalizeCorridor({ name: "Delve deployment", from: "Jita", to: "1DQ1-A" }, M));
  t.equal(list[0].name, "Delve deployment", "the list is sorted by name");
  list = C.upsertCorridor(list, C.normalizeCorridor({ ...GOOD, to: "Rens" }, M));
  t.equal(list.length, 2, "saving an existing name updates in place");
  t.equal(C.findCorridor(list, "jita supply run").to, "Rens", "lookup is case-insensitive");
  t.equal(C.removeCorridor(list, "JITA SUPPLY RUN").length, 1, "removal is case-insensitive");

  const fake = new Map();
  const storage = { getItem: k => fake.get(k) ?? null, setItem: (k, v) => fake.set(k, v), removeItem: k => fake.delete(k) };
  C.writeCorridors(storage, list);
  t.equal(C.readCorridors(storage, M).length, 2, "round-trips through storage");
  storage.setItem(C.CORRIDOR_KEY, "{not json");
  t.equal(C.readCorridors(storage, M).length, 0, "corrupt storage reads as empty rather than throwing");
  storage.setItem(C.CORRIDOR_KEY, JSON.stringify([GOOD, { name: "broken" }]));
  t.equal(C.readCorridors(storage, M).length, 1, "one bad stored entry is dropped without losing the rest");
  const hostile = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  t.check(C.readCorridors(hostile, M).length === 0 && C.writeCorridors(hostile, list) === false,
    "a storage that throws is survivable in both directions");

  t.equal(C.parseCorridorFile(C.corridorFile(list), M).length, 2, "an exported file re-imports");
  t.equal(C.parseCorridorFile(JSON.stringify(list), M).length, 2, "a bare array also imports");
  t.throws(() => C.parseCorridorFile("nope", M), "not valid JSON", "malformed JSON rejected");
  t.throws(() => C.parseCorridorFile("[]", M), "contains no corridors", "an empty file is rejected");
  t.throws(() => C.parseCorridorFile(JSON.stringify([GOOD, { name: "bad" }]), M),
    "entry 2 of 2: Corridor \"bad\" has no origin", "a bad entry names its position and its reason");
  t.throws(() => C.parseCorridorFile(JSON.stringify([GOOD, GOOD]), M), "more than once", "duplicate names rejected");

  const merged = C.mergeCorridors(list, C.parseCorridorFile(
    JSON.stringify([{ name: "Jita supply run", from: "Jita", to: "Hek" }, { name: "New", from: "a", to: "b" }]), M));
  t.check(merged.added === 1 && merged.updated === 1, "a merge reports what it added and updated");
  t.equal(C.findCorridor(merged.list, "Jita supply run").to, "Hek", "the imported version wins");

  let big = [];
  for (let i = 0; i < C.CORRIDOR_LIMIT; i += 1) big = C.upsertCorridor(big, C.normalizeCorridor({ name: `c${i}`, from: "a", to: "b" }, M));
  t.equal(C.upsertCorridor(big, C.normalizeCorridor({ name: "c5", from: "a", to: "z" }, M)).length, C.CORRIDOR_LIMIT,
    "updating at capacity is allowed");
  t.throws(() => C.upsertCorridor(big, C.normalizeCorridor({ name: "more", from: "a", to: "b" }, M)), "is full",
    "adding past capacity is refused");

  // --- interface ----------------------------------------------------------
  const atlas = readArchive();
  const forge = readRegion("The Forge");
  const { state } = app;
  const ui = id => document.getElementById(id);
  const set = o => { for (const [k, v] of Object.entries(o)) ui(k).value = v; };
  const systems = Object.values(forge.systems);

  store.clear();
  state.atlas = atlas;
  state.routePlanner = new RoutePlanner(atlas);
  state.corridors = [];
  state.mode = "region";
  state.region = forge;
  state.positions = relaxSystems(systems, project(systems, s => [s.position[0], -s.position[2]], 1120, 700, 80));
  state.nodes = systems.map(s => {
    const el = document.createElementNS(null, "g");
    el.className = "system-node";
    return { el, record: s };
  });
  app.renderCorridors();

  set({ routeFrom: "Jita", routeTo: "Amarr", routeMode: "safer", avoidSystems: "Niarja", avoidRegions: "", routeMinSec: "0.5", routeMaxSec: "", corridorName: "Jita supply run" });
  app.saveCorridor();
  t.equal(ui("corridorError").textContent, "", "saving a valid corridor reports no error");
  t.equal(state.corridors.length, 1, "the corridor is stored");
  t.equal(ui("corridorName").value, "", "the name field clears after saving");
  t.check(JSON.parse(store.get(C.CORRIDOR_KEY)).length === 1, "and it reaches storage");

  set({ corridorName: "" });
  app.saveCorridor();
  t.check(ui("corridorError").textContent.includes("Give the corridor a name"), "a nameless save is refused");
  set({ corridorName: "Bad", routeFrom: "Notarealsystem" });
  app.saveCorridor();
  t.check(ui("corridorError").textContent.includes("does not match a single system"), "an unresolvable origin is refused");
  set({ routeFrom: "Jita", avoidSystems: "Notarealsystem" });
  app.saveCorridor();
  t.check(ui("corridorError").textContent.includes("Avoid list"), "an unresolvable avoid entry is refused");
  set({ avoidSystems: "Niarja", routeMinSec: "notanumber" });
  app.saveCorridor();
  t.check(ui("corridorError").textContent.includes("is not a number"), "an invalid limit is refused");
  t.equal(state.corridors.length, 1, "none of those stored a partial corridor");

  set({ routeMinSec: "0.5", corridorName: "Delve deployment", routeTo: "1DQ1-A", routeMode: "shortest", avoidSystems: "" });
  app.saveCorridor();
  t.equal(state.corridors.length, 2, "a second corridor saves");
  t.equal(ui("corridorList").querySelectorAll("[data-corridor]").length, 2, "both render as rows");
  t.check(ui("corridorList").innerHTML.includes("Jita → Amarr"), "the detail line shows the endpoints");
  t.check(ui("corridorList").innerHTML.includes("1 avoided"), "the detail line counts avoided entries");

  set({ routeFrom: "", routeTo: "", avoidSystems: "", avoidRegions: "", routeMinSec: "", routeMaxSec: "", routeMode: "shortest" });
  ui("limitsPanel").open = false;
  state.route = null;
  app.loadCorridor("Jita supply run");
  t.check(ui("routeFrom").value === "Jita" && ui("routeTo").value === "Amarr", "loading restores the endpoints");
  t.equal(ui("routeMode").value, "safer", "and the mode");
  t.check(ui("avoidSystems").value === "Niarja" && ui("routeMinSec").value === "0.5", "and the constraints");
  t.check(ui("limitsPanel").open === true, "and opens the limits panel so they are visible");
  t.check(state.route && state.route.jumps > 0, "and re-runs the solver");
  t.check(!state.route.systems.some(s => s.name === "Niarja"), "the recalculated route honours the avoid list");
  t.check(state.route.systems.every(s => s.security >= 0.45), "and the security limit");

  t.equal(Object.keys(state.corridors[0]).sort().join(","),
    "avoidRegions,avoidSystems,from,maxSecurity,minSecurity,mode,name,saved,to",
    "a corridor stores the definition and nothing computed");

  set({ corridorName: "Impossible", routeFrom: "Jita", routeTo: "1DQ1-A", routeMinSec: "0.5", avoidSystems: "", routeMode: "shortest" });
  app.saveCorridor();
  app.loadCorridor("Impossible");
  t.check(ui("routeError").textContent.includes("1DQ1-A"), "a corridor that cannot route today says so on load");
  t.equal(state.corridors.length, 3, "and survives the failure");

  app.dropCorridor("Impossible");
  t.equal(state.corridors.length, 2, "removal works");
  t.equal(JSON.parse(store.get(C.CORRIDOR_KEY)).length, 2, "and persists");

  downloads.length = 0;
  app.exportCorridors();
  t.equal(downloads.length, 1, "export produces a file");
  const exported = downloads.at(-1);
  t.equal(JSON.parse(exported).corridors.length, 2, "holding both corridors");
  state.corridors = [];
  await app.importCorridors({ target: { files: [{ text: async () => exported }], value: "" } });
  t.equal(state.corridors.length, 2, "and it re-imports");
  t.check(ui("corridorError").textContent.includes("Imported 2 new"), "the import reports what it did");
  await app.importCorridors({ target: { files: [{ text: async () => '[{"name":"junk"}]' }], value: "" } });
  t.check(ui("corridorError").textContent.includes("entry 1 of 1"), "a bad import names the entry");
  t.equal(state.corridors.length, 2, "and changes nothing");

  state.corridors = [];
  app.bindCorridors();
  t.equal(state.corridors.length, 2, "corridors reload from storage at bind time");

  // Leave the route fields as they were found. This suite loads corridors, and
  // a corridor sets a security floor; left behind it silently constrained a
  // later suite's routes, which spent a while looking like a bug in the layer
  // being tested rather than in this one.
  set({ routeFrom: "", routeTo: "", avoidSystems: "", avoidRegions: "", routeMinSec: "", routeMaxSec: "", corridorName: "" });
  app.refreshAvoid();
  app.clearRouteResult();

  return t.results;
}
