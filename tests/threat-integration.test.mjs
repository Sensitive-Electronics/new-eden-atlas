// Threat reach, as wired into the application.
//
// "Standing here, what can drop on me." The arithmetic is tested elsewhere;
// this is about the join, and about the three ways an overlay like this can lie
// to a fleet commander.
//
// It can be too small. A staging system silently dropped because its name did
// not resolve shrinks the envelope, and a fleet reads safety that is not there.
// So an unrecognised name refuses the whole request rather than quietly
// computing a smaller answer.
//
// It can be indistinguishable from not knowing. An empty threat section and an
// absent one mean different things - "nothing reaches this system" against "no
// staging has been set" - and the same distinction sovereignty draws.
//
// And it can be read as a boundary. It is an upper bound built on maximum
// skills, every staging system live, and no cyno jammers, because jammers
// cannot be detected by any third-party tool. Every surface that shows it says
// so, and this checks that they do.

import { readArchive, readRegion, readShips, suite } from "./helpers.mjs";
import { JumpPlanner } from "../web/jump-planner.js";
import { RoutePlanner } from "../web/route-planner.js";
import { STORAGE_KEYS, readJson } from "../web/settings.js";
import { threatPanel } from "../web/panels.js";

export default function run(app) {
  const t = suite("threat wiring");
  const { state, ui } = app;
  const atlas = readArchive();
  state.atlas = atlas;
  state.routePlanner = new RoutePlanner(atlas);
  state.jumpPlanner = new JumpPlanner(atlas, readShips());
  const idOf = name => state.routePlanner.resolveSystem(name).system_id;

  localStorage.removeItem(STORAGE_KEYS.threat);
  ui.threatStaging.value = "";
  app.clearThreat();

  // --- before any staging is set ---------------------------------------------
  t.equal(state.threat, null, "a fresh session has no envelope");
  t.check(/No staging systems set/.test(ui.threatClasses.innerHTML),
    "and the panel asks for one rather than showing an empty list");
  t.equal(threatPanel(null), "",
    "the system inspector shows no threat section at all, rather than an empty one");
  t.check(/No jump-capable hull reaches/.test(threatPanel([])),
    "which is a different statement from a computed answer of nothing");

  // --- a name that does not resolve ---------------------------------------------
  ui.threatStaging.value = "Amamake, Nowhere-At-All";
  app.runThreat();
  t.check(/Nowhere-At-All/.test(ui.threatError.textContent), "an unrecognised staging system is named");
  t.equal(state.threat, null,
    "and nothing is computed - a dropped staging system would shrink the envelope silently");

  // --- a real staging set -----------------------------------------------------------
  ui.threatStaging.value = "Amamake";
  app.runThreat();
  t.equal(ui.threatError.textContent, "", "a real system is accepted");
  t.equal(state.threat.envelopes.length, 10, "one envelope per jump-capable hull class");
  // The last two envelopes are the haulers, which out-range every combat hull and so
  // head the list if reach is the first key. Reach orders the rest.
  const fighting = state.threat.envelopes.filter(envelope => envelope.combat !== false);
  t.equal(fighting.length, 8, "eight of the ten classes can shoot back");
  t.check(state.threat.envelopes.slice(0, 8).every(envelope => envelope.combat !== false),
    "and they are the eight the panel lists first");
  t.check(fighting[0].rangeLy >= fighting.at(-1).rangeLy,
    "longest reach first among them, which is the class you find out about last");
  t.equal(state.threat.systemIds.size, 153, "and the union is what anything can reach");
  t.check(fighting[0].systemIds.size > fighting.at(-1).systemIds.size,
    "a longer-ranged class reaches more systems, so the classes are not merged");

  t.check(/Titan/.test(ui.threatClasses.innerHTML), "each class is listed");
  t.check(/ly/.test(ui.threatClasses.innerHTML), "with its reach");
  t.check(/systems/.test(ui.threatClasses.innerHTML), "and how much it covers");
  // The rail carries the same label the inspector does. Both lists show all ten
  // classes, so marking the haulers in one and not the other would leave a
  // pilot reading "Capital Industrial Ship \u00b7 10.00 ly" in the sidebar with
  // nothing saying what it is.
  t.check(/not a combat hull/.test(ui.threatClasses.innerHTML),
    "and the two hauler classes are named as such here too");
  t.check((ui.threatClasses.innerHTML.match(/not a combat hull/g) || []).length === 2,
    "exactly the two of them, not every row");

  // --- what it tells one system --------------------------------------------------
  const staging = threatPanel(app.threatsToSystem(idOf("Amamake")));
  t.check(/one of the staging systems/.test(staging),
    "a staging system says so, rather than reporting what reaches it");
  const reached = threatPanel(app.threatsToSystem(idOf("Auga")));
  t.check(/Amamake/.test(reached), "a system in reach names where the threat comes from");
  t.check(/Capital Industrial Ship/.test(reached), "and which class");
  const clear = threatPanel(app.threatsToSystem(idOf("1DQ1-A")));
  t.check(/No jump-capable hull reaches/.test(clear), "a system out of reach says so");
  t.check(/cyno jammers/.test(clear),
    "and says a jammer it cannot see is not what produced that answer");
  t.check(/cyno jammers/.test(reached), "the same caveat rides with a positive answer");

  // **High security is not in a capital envelope, and there is no longer a
  // control that says otherwise.** The toggle that was here was justified in
  // this very comment by black ops bridging, which does not change it: a covert
  // cynosural field is barred from high security exactly as an ordinary one is.
  // Ticked, it put 81 high-security systems inside a titan staged in Tama -
  // systems the jump planner refuses by name - on a panel that calls itself an
  // upper bound.
  t.equal(app.threatsToSystem(idOf("Rens")).length, 0, "high-security space is not in reach");
  t.equal(ui.threatHighSec, undefined, "and no control offers to put it there");
  t.check([...state.threat.systemIds].every(id => state.atlas.systems[String(id)].security < 0.45),
    "nothing high-security is marked, whatever was stored from a previous version");

  // A hauler is not headlined as a threat. Sorted by reach alone, the first class an FC
  // reads from Amamake is "Capital Industrial Ship": a Rorqual reaches 10 ly at maximum
  // skills and a titan reaches 6.
  const ordered = app.threatsToSystem(idOf("Siseide"));
  t.check(ordered.length > 0, "Siseide is inside the Amamake envelope");
  t.check(ordered[0].combat !== false,
    `and the first class named there can shoot back (${ordered[0].group})`);
  t.check(/not a combat hull/.test(threatPanel(ordered)),
    "while the haulers that do reach it are labelled as such");

  // --- the envelope does not outlive the staging list it was drawn from -------
  //
  // **This was the only result in the application with no staleness binding at
  // all.** `result-state.js` declared `JUMP_FIELDS`, `RANGE_FIELDS` and
  // `ROUTE_FIELDS` and nothing for threat; `invalidateStaleResults` never
  // touched `state.threat`; and `bindThreat` bound a click on Run and Enter in
  // the field, with no `change` listener anywhere.
  //
  // So retyping the staging list and tabbing away - or touching any other
  // control, which is what fires the invalidation for every other panel - left
  // the previous envelope marked on the map and answered in every system
  // inspector. No badge, no error, and nothing to tell it from a current one.
  // On the panel whose own module says "a threat envelope that is too small is
  // the one kind of wrong that gets people killed".
  {
    ui.threatStaging.value = "Amamake";
    app.runThreat();
    const drawn = state.threat?.systemIds?.size ?? 0;
    t.check(drawn > 0, `an envelope is drawn from Amamake (${drawn} systems)`);
    const reached = [...state.threat.systemIds][0];
    t.check(app.threatsToSystem(reached)?.length > 0, "and a system in it reports what reaches it");

    // The pilot retypes the staging list and does not press Run.
    ui.threatStaging.value = "Jita";
    t.check(app.invalidateStaleResults(), "changing the staging list makes the drawn envelope stale");
    t.equal(state.threat, null, "so it is cleared rather than left standing");
    t.equal(app.threatsToSystem(reached), null,
      "and the inspector stops answering for an origin that has been replaced");

    // Typing it back and running again is a fresh, current answer.
    ui.threatStaging.value = "Amamake";
    app.runThreat();
    t.equal(state.threat?.systemIds?.size ?? 0, drawn, "running it again gives the same envelope");
    t.check(!app.invalidateStaleResults(), "which is not stale, because it matches what is typed");
  }

  // --- the map ---------------------------------------------------------------------
  state.region = readRegion("Heimatar");
  state.mode = "region";
  app.setLayoutMode("atlas");
  app.renderRegion();
  const nodeFor = name => state.nodes.find(node => node.record.name === name);
  t.check(nodeFor("Auga").el.classList.contains("threatened"), "a system in reach is marked on the map");
  t.check(nodeFor("Amamake").el.classList.contains("threatened"), "and so is the staging system itself");
  t.check(!nodeFor("Rens").el.classList.contains("threatened"),
    "while high security, which nothing can jump into, is not");

  // A system can be on your route and inside a hostile envelope at once, and
  // that combination is the most important thing the map can say. Either
  // marking hiding the other would lose it.
  ui.routeFrom.value = "Amamake";
  ui.routeTo.value = "Auga";
  ui.routeMode.value = "shortest";
  app.calculateRoute();
  t.check(nodeFor("Auga").el.classList.contains("on-route"), "a routed system carries its route marking");
  t.check(nodeFor("Auga").el.classList.contains("threatened"), "and its threat marking at the same time");

  // --- clearing --------------------------------------------------------------------
  app.clearThreat();
  t.equal(state.threat, null, "clearing drops the envelope");
  app.renderOverlay();
  t.check(!nodeFor("Auga").el.classList.contains("threatened"), "and the map with it");
  t.check(/No staging systems set/.test(ui.threatClasses.innerHTML), "and the panel returns to asking");

  // --- what is remembered, and what is not ---------------------------------------------
  ui.threatStaging.value = "Amamake";
  app.runThreat();
  t.equal(readJson(localStorage, STORAGE_KEYS.threat)?.staging, "Amamake", "the staging list is saved");
  ui.threatStaging.value = "";
  app.restoreThreatSettings();
  t.equal(ui.threatStaging.value, "Amamake", "and restored");
  app.clearThreat();
  app.restoreThreatSettings();
  t.equal(state.threat, null,
    "but the envelope is not recomputed on restore - a pilot returning sees the map, not an overlay they did not ask for");

  // --- leave the harness as it was found -----------------------------------------------
  localStorage.removeItem(STORAGE_KEYS.threat);
  ui.threatStaging.value = "";
  app.clearThreat();
  app.clearRouteResult();
  state.region = null;
  state.mode = "universe";
  // --- every refusal clears what is drawn ---------------------------------------
  // `runThreat` has three paths that decline to produce an envelope, and each has to
  // clear the map first. One that does not leaves the previous envelope marked while
  // the message says the figures are unavailable - the input saying one thing and the
  // markings saying another. It costs more here than on a route panel, because this
  // overlay's whole job is saying what can reach you.
  const savedPlanner = state.jumpPlanner;
  ui.threatStaging.value = "Jita";
  app.runThreat();
  t.check(state.threat, "an envelope is drawn to begin with");

  // Ship data that carries no jump-capable hull.
  state.jumpPlanner = new JumpPlanner(atlas, { ships: [], skills: {}, fuel_types: {} });
  app.runThreat();
  t.equal(state.threat, null, "no jump-capable hulls clears the envelope rather than leaving it marked");
  t.check(/No jump-capable hulls/.test(ui.threatError.textContent), "and says why");

  // The planner itself missing, with an envelope already on the map.
  state.jumpPlanner = savedPlanner;
  app.runThreat();
  t.check(state.threat, "an envelope is drawn again");
  state.jumpPlanner = null;
  app.runThreat();
  t.equal(state.threat, null, "losing the planner clears it too");
  t.check(/Ship data is unavailable/.test(ui.threatError.textContent), "with its own reason");

  state.jumpPlanner = savedPlanner;
  ui.threatStaging.value = "";
  app.runThreat();

  return t.results;
}
