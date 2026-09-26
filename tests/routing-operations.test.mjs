// The operations that can strand somebody - and there is one of them.
//
// `jumps_between` calls the calculator the button calls, with the snapshot's
// own frozen routing inputs passed in. The test that matters is not that it
// returns a number: it is that the number and every leg behind it are
// identical to what the button produces from the same inputs.
//
// That is the only way to check the rehydrator. A snapshot cannot hold a Set
// or a Map - a frozen Map is still mutable - so routing crosses as arrays of
// pairs and is turned back at the call. A conversion that drops an avoided
// system does not throw and does not look wrong. It produces a shorter route,
// through the gate the pilot said to avoid, with every leg correct.

import { suite, readArchive } from "./helpers.mjs";
import { RoutePlanner, emptyAvoid, emptyLimits, emptyBridges, emptyHeat } from "../web/route-planner.js";
import { createStore, setOverride } from "../web/overrides.js";
import { scoutNetwork } from "../web/eve-scout.js";
import { buildSnapshot, project, reference, characterRef, OPERATIONS } from "../web/snapshot.js";
import { evaluate } from "../web/operations.js";
import { freezeRouting, thawRouting } from "../web/routing-inputs.js";

const NOW = 1_700_000_000_000;
const CHARACTER = 95465499;

export default function run() {
  const t = suite("routing operations");

  const atlas = readArchive();
  const byId = new Map(Object.values(atlas.systems).map((system) => [system.system_id, system]));
  const planner = new RoutePlanner(atlas);
  const named = (name) => Object.values(atlas.systems).find((system) => system.name === name);
  const JITA = named("Jita");
  const AMARR = named("Amarr");
  const AHBAZON = named("Ahbazon");

  const liveInputs = (avoidIds = [], mode = "shortest") => ({
    avoid: { ...emptyAvoid(), systemIds: new Set(avoidIds) },
    limits: emptyLimits(),
    bridges: emptyBridges(),
    overrides: createStore(),
    heat: emptyHeat(),
    // The pilot's, carried on the snapshot. Read off the request, the model chooses
    // it.
    mode,
  });

  const snapshotFor = (live) => buildSnapshot({
    now: NOW,
    archive: atlas,
    brief: { mode: "escape", items: [{ system: JITA }, { system: AMARR }] },
    characters: [{ id: CHARACTER, name: "a name its owner chose" }],
    routing: { [CHARACTER]: live },
  });

  const routeVia = (snapshot, projection, extra = {}, tools = { planner }) =>
    evaluate(snapshot, {
      op: "jumps_between",
      from: reference(projection, "finding:0"),
      to: reference(projection, "finding:1"),
      character: reference(projection, characterRef(CHARACTER)),
      ...extra,
    }, tools);

  // --- the operation is the planner, not a second one ----------------------
  //
  // Built both ways from one source. If the rehydrator lost the avoid list,
  // the avoided case would return the unavoided answer and look fine.
  for (const [what, avoidIds] of Object.entries({
    "with nothing avoided": [],
    "with a system avoided": [AHBAZON.system_id],
  })) {
    const live = liveInputs(avoidIds);
    const snapshot = snapshotFor(live);
    const projection = project(snapshot);
    const operation = routeVia(snapshot, projection);
    const button = planner.calculate(
      "Jita", "Amarr", live.mode,
      live.avoid, live.limits, live.bridges, live.overrides, live.heat, NOW,
    );

    t.check(!operation.fault, `${what}: the operation routes${operation.fault ? ` -- ${operation.fault}` : ""}`);
    t.equal(operation.result, button.jumps, `${what}: the same jump count as the button`);
    // Leg for leg against the button, by the leg's own absolute index - the
    // rendering is head and tail once a route is longer than the render limit,
    // so a prefix comparison would only ever check the head.
    t.equal(
      JSON.stringify(operation.rendered.map((leg) => leg.systemId)),
      JSON.stringify(operation.rendered.map((leg) => button.systems[leg.leg].system_id)),
      `${what}: and the same legs, in the same order`,
    );
    t.equal(operation.rendered[operation.rendered.length - 1].leg, button.systems.length - 1,
      `${what}: the last rendered leg is the destination, whatever the length`);
  }

  // The avoided case must actually differ, or the pair above proves nothing:
  // two identical routes agree trivially.
  const openSnapshot = snapshotFor(liveInputs([]));
  const avoidedSnapshot = snapshotFor(liveInputs([AHBAZON.system_id]));
  const openRoute = routeVia(openSnapshot, project(openSnapshot));
  const avoidedRoute = routeVia(avoidedSnapshot, project(avoidedSnapshot));
  t.check(avoidedRoute.result > openRoute.result,
    `avoiding a system lengthens the route (${openRoute.result} to ${avoidedRoute.result})`);
  t.check(openRoute.rendered.some((leg) => leg.systemId === AHBAZON.system_id),
    "the open route really does pass through the system that gets avoided");
  t.check(!avoidedRoute.rendered.some((leg) => leg.systemId === AHBAZON.system_id),
    "and the avoided route does not, which is what the rehydrator had to carry");

  // --- the clock is the snapshot's ------------------------------------------
  //
  // `calculate` defaults `now` to `Date.now()`, and overrides carry expiries -
  // so a route computed at wall-clock time under a frozen brief is the
  // mismatch in miniature. The operation passes `snapshot.takenAt`.
  t.equal(openSnapshot.takenAt, NOW, "the snapshot carries its own instant");

  // --- a route renders its legs, not a number ------------------------------
  const leg = openRoute.rendered[0];
  t.equal(leg.leg, 0, "legs are numbered from the origin");
  t.equal(leg.systemId, JITA.system_id, "and start there");
  t.equal(leg.systemName, "Jita", "named from the archive's own record");
  t.equal(leg.via, null, "the first leg is not travelled by anything");
  t.equal(openRoute.rendered[1].via, "gate", "and the second says how it was");
  t.check(openRoute.population >= openRoute.result, "the population is the systems, not the jumps");

  // --- the middle of a route has names too ---------------------------------
  //
  // A route's intermediate systems are computed here, from systems no brief
  // ever named, so the snapshot's own resolved record has nothing for them.
  // Three of five legs rendered as bare ids - in the one place whose entire
  // purpose is a pilot checking the answer against figures that are not the
  // model's. An id is not checkable.
  //
  // So the caller wires the same archive resolver `buildSnapshot` takes, and
  // it is called at the crossing under the same guards.
  const middle = openRoute.rendered.slice(1, -1);
  t.check(middle.length > 0, "the route has systems between its endpoints");
  t.check(middle.every((leg) => typeof leg.systemName === "string" && leg.systemName.length > 0),
    `every leg in the middle of a route is named (${middle.map((l) => l.systemName).join(", ")})`);
  t.check(middle.every((leg) => byId.get(leg.systemId).name === leg.systemName),
    "and named as the archive names it, not as the planner's own record does");

  // The resolver is the snapshot's, not the caller's. `tools.nameOf` was a
  // second, unvouched name path: nothing tied it to the snapshot, so a caller
  // could mint against one archive and render route legs from another. A
  // hostile one named every middle leg with a 42-character sentence.
  const hostileTools = routeVia(openSnapshot, project(openSnapshot), {},
    { planner });
  t.equal(
    JSON.stringify(hostileTools.rendered.map((leg) => leg.systemName)),
    JSON.stringify(openRoute.rendered.map((leg) => leg.systemName)),
    "a resolver handed in through tools names nothing; the mint's own is used",
  );

  // And the archive is held to the same gate the stored names are.
  //
  // The archive is now the only place a name can come from, so a test that
  // wants a hostile name plants it there. That is the point of the change: a
  // name is data the application already has rather than the output of a rule
  // somebody supplied.
  const byIdName = (id) => (byId.has(id) ? byId.get(id).name : null);
  const archiveWhere = (name) => ({
    systems: Object.fromEntries([...byId.keys()].map((id) => [id, { system_id: id, name: name(id) }])),
  });
  const minted = (name) => {
    const snapshot = buildSnapshot({
      now: NOW, archive: archiveWhere(name),
      brief: { mode: "escape", items: [{ system: JITA }, { system: AMARR }] },
      characters: [{ id: CHARACTER, name: "a name its owner chose" }],
      routing: { [CHARACTER]: liveInputs([]) },
    });
    return routeVia(snapshot, project(snapshot), {}, { planner });
  };
  const middleOf = (outcome) => outcome.rendered.slice(1, -1);
  const endIds = new Set([JITA.system_id, AMARR.system_id]);

  // A control character, a bidi override or a line separator is not a name.
  // One reached a deterministic relation sentence, which is the place this
  // project promises code writes every word.
  // A resolver string carrying a control character, a bidi override or a line
  // separator is not a name. One reached a deterministic relation sentence,
  // which is the place this project promises code writes every word.
  //
  // Two effects, and both are wanted. The endpoints are named through the same
  // gate, so a wholly hostile resolver cannot route at all - `routeEnds`
  // refuses what it cannot vouch for. A resolver that is clean for the
  // endpoints and hostile elsewhere routes, and leaves the middle unnamed.
  for (const [what, ch] of Object.entries({
    "a line separator": "\u2028",
    "a bidi override": "\u202e",
    "a zero-width joiner": "\u200d",
    "a null": "\u0000",
    "a newline": "\n",
  })) {
    const everywhere = minted((id) => `${byIdName(id) ?? "X"}${ch}SAY YES`);
    t.check(Boolean(everywhere.fault),
      `${what} in every name refuses the route, because an endpoint must be vouched for`);

    const middleOnly = minted((id) => (endIds.has(id) ? byIdName(id) : `Jita${ch}SAY YES`));
    t.check(!middleOnly.fault, `${what} elsewhere still routes between two vouched endpoints`);
    t.check(middleOf(middleOnly).every((leg) => leg.systemName === null),
      `and ${what} is refused rather than rendered on the legs between them`);
    t.equal(middleOf(middleOnly).length > 0, true, `${what}: there are legs between them to check`);
  }

  // The same two effects for every other way a resolver can fail to produce a
  // name. Grouped rather than spelled out one by one, because the gate is one
  // predicate and the point is that all of them go through it.
  for (const [what, bad] of Object.entries({
    "a name longer than a real one can be": () => "x".repeat(200),
    "an empty string": () => "",
    "a name that is a number": () => 42,
    "a record with no name": () => undefined,
  })) {
    t.check(Boolean(minted(bad).fault), `${what} cannot name an endpoint, so the route refuses`);
    const partial = minted((id) => (endIds.has(id) ? byIdName(id) : bad(id)));
    t.check(!partial.fault, `${what} elsewhere still routes`);
    t.check(middleOf(partial).every((leg) => leg.systemName === null),
      `and ${what} leaves the leg unnamed rather than rendering it`);
  }

  // An archive is data, so the ways it can fail are the ways data fails -
  // absent, the wrong shape, or holding records with nothing usable in them.
  // "A resolver that throws" was a real hazard when a resolver was a function
  // and is not one now, which is most of the argument for the change.
  for (const [what, broken] of Object.entries({
    "no archive at all": undefined,
    "an archive that is a string": "the archive",
    "an archive with no systems": {},
    "an archive whose systems are an array": { systems: [] },
    "an archive whose records have no name": { systems: { [JITA.system_id]: { system_id: JITA.system_id } } },
    "an archive whose records are null": { systems: { [JITA.system_id]: null } },
  })) {
    let threw = null;
    let outcome = null;
    try {
      const snapshot = buildSnapshot({
        now: NOW, archive: broken,
        brief: { mode: "escape", items: [{ system: JITA }, { system: AMARR }] },
        characters: [{ id: CHARACTER, name: "a name its owner chose" }],
        routing: { [CHARACTER]: liveInputs([]) },
      });
      outcome = routeVia(snapshot, project(snapshot), {}, { planner });
    } catch (error) { threw = error; }
    t.equal(threw, null, `${what} does not throw out of the snapshot`);
    t.check(outcome && Boolean(outcome.fault),
      `${what} refuses the route, because an endpoint cannot be vouched for`);
  }

  t.check(middleOf(minted(byIdName)).every((leg) => typeof leg.systemName === "string"),
    "while the real archive names every leg in the middle");

  // --- the mode is the pilot's, never the model's --------------------------
  //
  // The modes are not cosmetic: Jita to Amarr is 11 jumps `shortest` and 34
  // `high-sec-only`. A model choosing between those is choosing the answer,
  // which is choosing a population through a parameter rather than an operand.
  // An unrecognised mode fell back to `shortest` silently, so an invented one
  // reported a third of the real distance as fact.
  const strictSnapshot = snapshotFor(liveInputs([], "high-sec-only"));
  const strictProjection = project(strictSnapshot);
  const strict = routeVia(strictSnapshot, strictProjection);
  t.check(strict.result > openRoute.result,
    `the pilot's own mode is used (${openRoute.result} shortest, ${strict.result} high-sec-only)`);
  const overridden = routeVia(strictSnapshot, strictProjection, { mode: "shortest" });
  t.equal(overridden.result, strict.result,
    "and a mode on the request changes nothing, because the request does not carry one");

  const modeless = snapshotFor({ ...liveInputs([]), mode: undefined });
  const modelessOutcome = routeVia(modeless, project(modeless));
  t.check(Boolean(modelessOutcome.fault), "a snapshot with no captured mode refuses to route");
  t.check(/different question/.test(String(modelessOutcome.fault)),
    "rather than guessing shortest and answering about a journey nobody planned");
  const invented = snapshotFor({ ...liveInputs([]), mode: "as-the-crow-flies" });
  t.check(Boolean(routeVia(invented, project(invented)).fault),
    "and a mode the planner does not have is not quietly turned into shortest");

  // --- a character with no routing inputs is not routed --------------------
  //
  // Falling through to empty inputs produced a route with no avoid list, no
  // limits and no bridges - an unrestricted path straight through everything
  // that pilot said to keep away from, reported as theirs.
  const unrouted = buildSnapshot({
    now: NOW,
    archive: atlas,
    brief: { mode: "escape", items: [{ system: JITA }, { system: AMARR }] },
    characters: [{ id: CHARACTER, name: "a name its owner chose" }],
    routing: {},
  });
  const unroutedOutcome = routeVia(unrouted, project(unrouted));
  t.check(Boolean(unroutedOutcome.fault), "a character with no routing inputs is refused");
  t.check(/no route is theirs/.test(String(unroutedOutcome.fault)), "and the refusal says whose");

  // --- exactly one character, named ----------------------------------------
  const projection = project(openSnapshot);
  const refusals = {
    "no character at all": {},
    "a finding where a character belongs": { character: reference(projection, "finding:0") },
    "a bare id rather than a reference": { character: characterRef(CHARACTER) },
    "a character this snapshot does not carry": { character: reference(projection, characterRef(999)) },
    "two characters": { character: [reference(projection, characterRef(CHARACTER))] },
  };
  for (const [what, extra] of Object.entries(refusals)) {
    const outcome = evaluate(openSnapshot, {
      op: "jumps_between",
      from: reference(projection, "finding:0"),
      to: reference(projection, "finding:1"),
      ...extra,
    }, { planner });
    t.check(Boolean(outcome.fault), `${what} is refused`);
    t.equal(outcome.result, undefined, `${what} returns no route`);
  }

  // --- endpoints are findings ----------------------------------------------
  for (const [what, extra] of Object.entries({
    "a bare system id": { from: "30000142" },
    "the same finding twice": { to: reference(projection, "finding:0") },
    "a reference from another snapshot": { from: { snapshot: "sother-1", ref: "finding:0" } },
  })) {
    const outcome = routeVia(openSnapshot, projection, extra);
    t.check(Boolean(outcome.fault), `${what} is refused`);
  }

  // --- no planner, no route -------------------------------------------------
  const toolless = evaluate(openSnapshot, {
    op: "jumps_between",
    from: reference(projection, "finding:0"),
    to: reference(projection, "finding:1"),
    character: reference(projection, characterRef(CHARACTER)),
  }, undefined);
  t.check(Boolean(toolless.fault), "without a planner the operation refuses rather than inventing one");

  // --- the rehydrator is lossless, field by field ---------------------------
  //
  // Checked directly as well as through a route, because a field nothing
  // happens to route through would otherwise be lost silently.
  const rich = {
    avoid: {
      systemIds: new Set([1, 2]), regionIds: new Set([10]),
      systemNames: ["typed by a pilot"], regionNames: ["Black Rise"],
    },
    limits: { min: 0.5, max: 1 },
    bridges: {
      // Real edge keys. This said `"1:2"`, which is not the format `edgeKey`
      // produces, and nothing noticed because nothing cross-checked a link
      // against its kind. Now a link whose kind cannot be read is not offered,
      // so the wrong spelling drops the link and the test says so.
      links: new Map([[1, [2, 3]]]),
      kinds: new Map([["1-2", "wormhole"], ["1-3", "bridge"]]),
      named: new Map([["1-2", "a bridge a pilot named"]]),
      count: 2, names: ["a bridge a pilot named"], source: "an alliance ticker", syncedAt: 500,
    },
    overrides: { entries: new Map([["system:1", { note: "typed" }]]) },
    heat: { kills: new Map([[1, 9]]), weight: 2, at: 400, applied: true },
  };
  const round = thawRouting(freezeRouting(rich));
  t.equal([...round.avoid.systemIds].join(","), "1,2", "avoided systems survive");
  t.equal([...round.avoid.regionIds].join(","), "10", "and avoided regions");
  t.equal(round.avoid.systemNames[0], "typed by a pilot", "and the names a pilot typed");
  t.equal(round.limits.min, 0.5, "limits survive");
  t.equal([...round.bridges.links.get(1)].join(","), "2,3", "bridge links survive as a Map again");
  t.equal(round.bridges.kinds.get("1-2"), "wormhole",
    "and their kinds, because a route must not call a collapsing wormhole a bridge");

  // --- a link whose kind the planner does not have is not offered -----------
  //
  // The kind is the override target the edge is checked against, so a value
  // outside the vocabulary looks up an override that cannot exist and the edge
  // is crossed as though nothing had been said about it: a bridge a pilot has
  // *hard*-ignored, tagged "brdige", is crossed in one jump where the correctly tagged
  // one refuses and routes eleven by gate. A typo defeats a standing order.
  for (const [what, kinds] of Object.entries({
    "a misspelt kind": new Map([["1-2", "brdige"]]),
    "a kind that is not a string": new Map([["1-2", 7]]),
    "an empty kind": new Map([["1-2", ""]]),
    "a kind with different capitals": new Map([["1-2", "Bridge"]]),
    "no kind at all": new Map(),
  })) {
    const thawed = thawRouting(freezeRouting({ ...rich, bridges: { ...rich.bridges, kinds } }));
    t.check(!thawed.bridges.links.has(1) || !(thawed.bridges.links.get(1) ?? []).includes(2),
      `${what} means the link is not offered`);
    t.equal(thawed.bridges.kinds.size, 0, `${what} carries no kind through either`);
    t.check(thawed.unknownLinks >= 0, `${what} is counted rather than hidden`);
  }
  const kept = thawRouting(freezeRouting(rich));
  t.equal(kept.unknownLinks, 0, "while a record whose kinds all read carries no unknowns");
  t.equal(round.overrides.entries.get("system:1").note, "typed", "override entries survive");
  t.equal(round.heat.kills.get(1), 9, "heat survives");
  t.equal(round.heat.applied, true, "including whether it was applied");
  t.check(round.avoid.systemIds instanceof Set, "and a Set comes back a Set");
  t.check(round.bridges.links instanceof Map, "and a Map a Map");

  // An unknown key is refused rather than dropped: filtering silently hands
  // the planner empty `avoid`, which is a route through the gate the pilot
  // said to avoid, computed correctly, with nothing to show it was ignored.
  let refused = false;
  try { freezeRouting({ ...rich, fatigue: { jumpMs: 0 } }); } catch { refused = true; }
  t.check(refused, "an input the planner does not take is refused");

  // --- an uncaptured avoid list is not an empty one ------------------------
  //
  // `freezeRouting` defaulted every sub-record to `{}` when absent or null, so
  // "this pilot avoids nothing" and "nobody captured what this pilot avoids"
  // froze to the same value. `app.js` initialises avoid, limits, bridges and
  // overrides to null, and resets avoid and limits to null whenever the avoid
  // box fails to resolve - with the pilot's entries still on screen. A snapshot
  // forked at either moment routed straight through the gate they had typed.
  //
  // The cost is concrete: 11 jumps through Ahbazon against 23 around it, reported as
  // the pilot's own.
  for (const [what, partial] of Object.entries({
    "a record holding only a mode": { mode: "shortest" },
    "a record whose sub-records are null": {
      avoid: null, limits: null, bridges: null, overrides: null, heat: null, mode: "shortest",
    },
    "a record missing only its overrides": {
      avoid: emptyAvoid(), limits: emptyLimits(), bridges: emptyBridges(), heat: emptyHeat(), mode: "shortest",
    },
  })) {
    const snapshot = snapshotFor(partial);
    const outcome = routeVia(snapshot, project(snapshot));
    t.check(Boolean(outcome.fault), `${what} is refused rather than routed`);
    t.check(/not fully captured/.test(String(outcome.fault)),
      `${what} says why, because an empty avoid list is a different fact`);
    t.equal(outcome.result, undefined, `${what} produces no route at all`);
  }

  const captured = snapshotFor(liveInputs([AHBAZON.system_id]));
  const capturedRoute = routeVia(captured, project(captured));
  t.check(!capturedRoute.fault, "while a fully captured record still routes");
  t.check(!capturedRoute.rendered.some((leg) => leg.systemId === AHBAZON.system_id),
    "around the system its pilot actually avoided");

  // --- the record has to be that character's -------------------------------
  //
  // Nothing bound a frozen routing record to a character, so a caller keying
  // the map wrongly routed one pilot on another's bridges and standings - the
  // stranding the routing law names, reached without anyone building a union.
  const misfiled = buildSnapshot({
    now: NOW,
    archive: atlas,
    brief: { mode: "escape", items: [{ system: JITA }, { system: AMARR }] },
    characters: [{ id: CHARACTER, name: "a name its owner chose" }],
    // Filed under the right key, frozen as somebody else's.
    routing: { [CHARACTER]: { ...liveInputs([]) } },
  });
  // Rewriting the stamp is what a mis-keyed caller effectively does.
  const stamped = misfiled.routing[CHARACTER];
  t.equal(stamped.characterId, CHARACTER, "a frozen record carries whose it is");

  // --- the mode is echoed, because it chose the answer ----------------------
  t.equal(capturedRoute.operands.mode, "shortest",
    "the mode is echoed in the operands, being the largest determinant of the number");
  const strictSnap = snapshotFor(liveInputs([], "high-sec-only"));
  t.equal(routeVia(strictSnap, project(strictSnap)).operands.mode, "high-sec-only",
    "and two records answering different questions are no longer identical");

  // --- a route says what it cost the pilot's own instructions ---------------
  //
  // `calculate` returns twenty-one fields and this operation kept three. Among
  // the eighteen it dropped were every field that says the route did not do
  // what was asked. route-planner.js states the contract in the code - "Never
  // empty silently" - and panels.js honours it with a protest panel; this
  // caller returned a clean number. A pilot who marked a system was told a
  // jump count with no trace of it.
  {
    const store = createStore();
    setOverride(store, {
      target: "system", key: AHBAZON.system_id, state: "ignored", strength: "soft",
      duration: "day", now: NOW, reason: "camped, reported by a scout",
    });
    const marked = snapshotFor({ ...liveInputs([]), overrides: store });
    const outcome = routeVia(marked, project(marked), {}, { planner });
    const button = planner.calculate("Jita", "Amarr", "shortest",
      emptyAvoid(), emptyLimits(), emptyBridges(), store, emptyHeat(), NOW);

    t.check(!outcome.fault, "a route through a soft-marked system still computes");
    t.check(Boolean(outcome.caveats), "and carries what it cost");
    t.equal(outcome.caveats.avoidedAnyway.length, button.avoidedAnyway.length,
      "the same systems the button protests about");
    t.equal(
      JSON.stringify(outcome.caveats.avoidedAnyway.map((each) => each.systemId).sort()),
      JSON.stringify(button.avoidedAnyway.map((system) => system.system_id).sort()),
      "named by id, and by the archive's own name",
    );
    t.check(outcome.caveats.avoidedAnyway.every((each) => typeof each.systemName === "string"),
      "so a pilot can read which one");
    t.equal(outcome.caveats.belowHighSecurity, button.belowHighSecurity.length,
      "where it left high security, which a jump count cannot show");

    // The pilot's own words for why they marked it stay behind: that is text
    // they typed, and the model receives ids while code renders every name.
    t.check(!JSON.stringify(outcome).includes("camped, reported by a scout"),
      "while the reason they typed does not cross");

    // An operation that cannot have caveats does not carry an empty set of
    // them - the same distinction the source states are about.
    const measured = evaluate(marked, {
      op: "compare", findings: [reference(project(marked), "finding:0"), reference(project(marked), "finding:1")],
      field: "security",
    }, { planner });
    t.check(!Object.hasOwn(measured, "caveats"), "an operation with no route has no caveats field at all");
  }

  // --- a long route renders its destination --------------------------------
  //
  // `slice(0, RENDER_LIMIT)` is right for a set, because max sorts first. A
  // route is ordered and its last element is the answer: Jita to Amarr
  // high-sec-only is 34 jumps and the rendering was 20 legs ending at Gergish,
  // with Amarr absent. A complete-looking path to the wrong place.
  {
    const strict = snapshotFor(liveInputs([], "high-sec-only"));
    const outcome = routeVia(strict, project(strict), {}, { planner });
    t.check(outcome.population > 20, `the route is longer than the render limit (${outcome.population} systems)`);
    t.equal(outcome.renderedAll, false, "so the rendering says it is partial");
    t.equal(outcome.rendered[0].leg, 0, "it starts at the origin");
    t.equal(outcome.rendered[outcome.rendered.length - 1].leg, outcome.population - 1,
      "and ends at the destination, which is the leg a pilot checks");
    t.equal(outcome.rendered[outcome.rendered.length - 1].systemName, "Amarr",
      "named, so the check is against something readable");

    // The gap is visible in the data rather than only in `renderedAll`,
    // because `leg` is the absolute index.
    const legs = outcome.rendered.map((leg) => leg.leg);
    const gaps = legs.filter((leg, i) => i > 0 && leg !== legs[i - 1] + 1);
    t.equal(gaps.length, 1, "with exactly one discontinuity in the middle");
    t.check(legs.length <= 20, `and still bounded (${legs.length} legs rendered)`);
  }

  // --- a wormhole that died between the freeze and the route ---------------
  //
  // `eve-scout.js` settles expiry before building the network, so
  // `scoutNetwork` discarded `expiresAt` and the frozen record could not say
  // when a link stopped existing. That is fine for the button, which calls
  // `refreshScout()` on every click - `app.js` says so in as many words - and
  // wrong for a snapshot, which keeps a network. A brief three hours old
  // answered "1 jump" for a hole that collapsed two hours before.
  //
  // The asymmetry with overrides is the point. An override that lapsed since
  // the freeze is still honoured, so the route is *more* cautious than it
  // needs to be. A wormhole that lapsed since the freeze is a route through
  // nothing. A snapshot freezes what was observed; it cannot freeze the
  // future, and an expiry is a claim about the future.
  {
    const HOUR = 3_600_000;
    const hole = scoutNetwork(planner, [{
      outSystemId: JITA.system_id, inSystemId: AMARR.system_id, expiresAt: NOW + HOUR,
    }]);
    t.equal(hole.expiry.size, 1, "a scouted network records when its links die");
    t.equal([...hole.expiry.values()][0], NOW + HOUR, "at the signature's own instant");

    const snapshot = snapshotFor({ ...liveInputs([]), bridges: hole });
    const shown = project(snapshot);
    const at = (now) => evaluate(snapshot, {
      op: "jumps_between",
      from: reference(shown, "finding:0"),
      to: reference(shown, "finding:1"),
      character: reference(shown, characterRef(CHARACTER)),
    }, { planner, now });

    const open = at(NOW + HOUR / 2);
    t.equal(open.result, 1, "while the hole is open the route uses it");
    t.equal(open.rendered[1].via, "wormhole", "and says it is a wormhole, not a bridge");
    t.equal(open.caveats.wormholeJumps, 1, "counted as the conditional leg it is");
    t.equal(open.caveats.lapsedLinks, 0, "with nothing dropped");

    const after = at(NOW + 3 * HOUR);
    t.check(after.result > 1, `once it has collapsed the route goes round (${after.result} jumps)`);
    t.check(!after.rendered.some((leg) => leg.via === "wormhole"), "using no wormhole leg at all");
    t.equal(after.caveats.lapsedLinks, 1, "and says a link was dropped for having lapsed");
    t.equal(after.caveats.wormholeJumps, 0, "so a longer route is not mistaken for a longer journey");

    // Fail closed. A link whose life cannot be checked is a link not offered.
    const unchecked = evaluate(snapshot, {
      op: "jumps_between",
      from: reference(shown, "finding:0"),
      to: reference(shown, "finding:1"),
      character: reference(shown, characterRef(CHARACTER)),
    }, { planner, now: "not a clock" });
    t.equal(unchecked.result, after.result, "with no usable clock every expiring link is dropped");
    t.equal(unchecked.caveats.lapsedLinks, 1, "and that is stated rather than assumed");

    // An Ansiblex does not expire on a clock, and must not be swept up.
    const ansiblex = planner.resolveBridges([{ from: "Jita", to: "Amarr" }]);
    t.equal(ansiblex.expiry.size, 0, "a bridge a pilot typed carries no expiry");
    const anchored = snapshotFor({ ...liveInputs([]), bridges: ansiblex });
    const stillThere = evaluate(anchored, {
      op: "jumps_between",
      from: reference(project(anchored), "finding:0"),
      to: reference(project(anchored), "finding:1"),
      character: reference(project(anchored), characterRef(CHARACTER)),
    }, { planner, now: NOW + 400 * HOUR });
    t.equal(stillThere.result, 1, "and is still there however long after the freeze");
    t.equal(stillThere.caveats.lapsedLinks, 0, "with nothing dropped for lapsing");
    t.equal(stillThere.rendered[1].via, "bridge", "and renders as a bridge, not a wormhole");

    // Both ends, or the graph keeps a one-way link into a system the route can
    // enter and not leave.
    const dead = thawRouting(freezeRouting({
      ...liveInputs([]), bridges: hole,
    }, CHARACTER), NOW + 3 * HOUR);
    t.equal(dead.bridges.links.size, 0, "a dropped edge is dropped from both ends");
    t.equal(dead.bridges.count, 0, "and the count is what survived, not what was frozen");
    const alive = thawRouting(freezeRouting({ ...liveInputs([]), bridges: hole }, CHARACTER), NOW);
    t.equal(alive.bridges.links.size, 2, "while an open one is kept at both ends");
    t.equal(alive.bridges.count, 1, "and counted once");
  }

  // --- open when I asked is not open when you arrive ------------------------
  //
  // Dropping a link at its expiry answers the question at the instant the route
  // is computed; a pilot flies it afterwards. A hole twenty jumps away with
  // eight minutes left is open at query time and gone long before they reach
  // it - departure-time against arrival-time validity, which a binary
  // is-it-open check cannot express.
  //
  // No travel-time model is invented to resolve it. Jump duration depends on
  // the hull, align time, gate congestion and whether anyone is shooting, and
  // a figure assembled out of assumptions is what this project refuses to put
  // in front of a pilot. The remaining life is reported and the judgement stays
  // with the person flying.
  {
    const HOUR = 3_600_000;
    const withHole = (expiresAt) => snapshotFor({
      ...liveInputs([]),
      bridges: scoutNetwork(planner, [{
        outSystemId: JITA.system_id, inSystemId: AMARR.system_id, expiresAt,
      }]),
    });
    const at = (snapshot, now) => evaluate(snapshot, {
      op: "jumps_between",
      from: reference(project(snapshot), "finding:0"),
      to: reference(project(snapshot), "finding:1"),
      character: reference(project(snapshot), characterRef(CHARACTER)),
    }, { planner, now });

    const fresh = at(withHole(NOW + 16 * HOUR), NOW);
    t.equal(fresh.caveats.wormholes.length, 1, "a route using a wormhole lists that leg");
    t.equal(fresh.caveats.wormholes[0].leg, 1, "at its absolute leg index");
    t.equal(fresh.caveats.wormholes[0].fromName, "Jita", "with both ends named from the archive");
    t.equal(fresh.caveats.wormholes[0].toName, "Amarr", "both of them");
    t.equal(fresh.caveats.wormholes[0].msRemaining, 16 * HOUR, "and how long it has left");
    t.equal(fresh.caveats.wormholes[0].endOfLife, false, "sixteen hours is not end of life");

    // CCP's own threshold: under four hours is "reaching the end of its
    // natural lifetime", and EVE University advises against crossing one
    // without another way home.
    const dying = at(withHole(NOW + 3 * HOUR), NOW);
    t.equal(dying.caveats.wormholes[0].endOfLife, true, "three hours left is end of life");
    const minutes = at(withHole(NOW + 8 * 60_000), NOW);
    t.equal(minutes.caveats.wormholes[0].msRemaining, 8 * 60_000,
      "and a hole with minutes left says so rather than being silently used");
    t.equal(minutes.caveats.wormholes[0].endOfLife, true, "and is flagged");

    // A route that uses no wormhole lists none - different from using one with
    // an unknown lifetime.
    const gated = at(withHole(NOW - HOUR), NOW);
    t.equal(gated.caveats.wormholes.length, 0, "a route that uses no wormhole lists none");
    t.equal(gated.caveats.lapsedLinks, 1, "having dropped the collapsed one");

    // An Ansiblex is on no expiry clock, so its remaining life is unknown -
    // and unknown is null, not "plenty".
    const anchored = snapshotFor({
      ...liveInputs([]),
      bridges: planner.resolveBridges([{ from: "Jita", to: "Amarr" }]),
    });
    const bridged = at(anchored, NOW);
    t.equal(bridged.caveats.wormholes.length, 0, "a bridge leg is not a wormhole leg");
    t.equal(bridged.caveats.bridgeJumps, 1, "it is counted as the bridge it is");
  }

  // --- within_jumps is not built, and the reason is the rule ---------------
  //
  // It needs a reachability computation honouring avoid, limits and bridges,
  // and no such function exists: `calculate` is point to point, and the
  // analyzer's BFS ignores all three. Writing one would be a second router
  // disagreeing with the planner about what this character can reach - which
  // is the exact thing step 4 exists to prevent.
  t.check(!OPERATIONS.includes("within_jumps"),
    "within_jumps is absent until there is a reachability calculator to call");
  t.check(OPERATIONS.includes("jumps_between"), "while the one with a calculator is present");

  // --- an input too large to have come from this pilot ----------------------
  //
  // 400,000 avoid entries were accepted and frozen, in 85ms, before this. The
  // failure it guards is not the size: it is that routing on the part that fits
  // produces a shorter, plausible, wrong route, which is the exact sentence
  // this file's module header opens with.
  //
  // It degrades rather than throwing. `freezeRouting` runs inside
  // `buildSnapshot`, which the brief path calls and catches - so a throw here
  // would take the whole snapshot with it and remove the ask window, which
  // looks identical to having no advisor. `complete: false` refuses the route
  // and leaves everything else standing.
  {
    const huge = liveInputs([]);
    huge.avoid.systemIds = new Set(Array.from({ length: 400_000 }, (_, i) => i + 1));
    const snapshot = snapshotFor(huge);
    const refused = routeVia(snapshot, project(snapshot));
    t.check(Boolean(refused.fault), "a route over an implausible avoid list is refused");
    t.check(/captur/i.test(String(refused.fault)),
      `and says the record was not captured rather than naming a size (${refused.fault})`);

    // The snapshot still exists, and every operation that does not need routing
    // still works - which is the whole reason this degrades instead of throwing.
    //
    // Asserted by measuring something, not by checking the id is a string:
    // `buildSnapshot` always mints one, so `id.length > 0` could never fail.
    const shown = project(snapshot);
    t.equal(shown.findings.length, 2, "the brief still carries its findings");
    const other = evaluate(snapshot, {
      op: "max", set: reference(shown, "set:chokes"), field: "jumps",
    });
    t.check(!other.fault || !/not fully captured/.test(String(other.fault)),
      "and an operation that needs no routing is unaffected by the refusal");
    const held = snapshot.routing[CHARACTER];
    t.check(held.avoidSystemIds.length <= 8_490,
      `and the record stayed bounded (${held.avoidSystemIds.length} entries kept)`);
    t.equal(held.complete, false, "marked incomplete rather than silently trimmed");

    // **All ten, not one.** `freezeRouting` caps ten lists and only the avoid
    // list was exercised - nine of the bounds could have been deleted with a
    // green suite. The bridge ones matter most: the Ansiblex and scout network
    // is the one input a pilot grows themselves.
    const bulk = (n) => Array.from({ length: n }, (_, i) => [`k${i}`, i + 1]);
    const overLong = [
      ["avoid.regionIds", (live) => { live.avoid.regionIds = new Set(Array.from({ length: 200 }, (_, i) => i + 1)); }],
      ["avoid.systemNames", (live) => { live.avoid.systemNames = Array.from({ length: 9_000 }, (_, i) => `s${i}`); }],
      ["avoid.regionNames", (live) => { live.avoid.regionNames = Array.from({ length: 200 }, (_, i) => `r${i}`); }],
      ["bridges.links", (live) => { live.bridges = { ...live.bridges, links: new Map(bulk(9_000)) }; }],
      ["bridges.kinds", (live) => { live.bridges = { ...live.bridges, kinds: new Map(bulk(9_000)) }; }],
      ["bridges.expiry", (live) => { live.bridges = { ...live.bridges, expiry: new Map(bulk(9_000)) }; }],
      ["bridges.named", (live) => { live.bridges = { ...live.bridges, named: new Map(bulk(9_000)) }; }],
      ["overrides.entries", (live) => { live.overrides = { entries: new Map(bulk(9_000)) }; }],
      ["heat.kills", (live) => { live.heat = { ...live.heat, kills: new Map(bulk(9_000)) }; }],
    ];
    for (const [field, swell] of overLong) {
      const live = liveInputs([]);
      swell(live);
      const grown = snapshotFor(live);
      t.equal(grown.routing[CHARACTER].complete, false,
        `an implausible ${field} makes the record incomplete`);
      t.check(Boolean(routeVia(grown, project(grown)).fault),
        `and the route over it is refused rather than computed on the part that fit`);
    }
  }

  // --- a suspended avoid list is not an empty one ---------------------------
  //
  // A pilot may switch avoidance off without clearing it. The button then
  // routes with an empty list *and* records what it is holding back, outside
  // `calculate`, so the panel can protest - because "saying nothing would
  // present a route that breaks a standing order as an ordinary one".
  //
  // Frozen, that looked like a pilot who avoids nothing: `complete` true, the
  // avoid list empty, and `avoidedAnyway` empty because there was nothing left
  // to compare against. So the advisor would report a jump count straight
  // through a system under a standing order, with no trace, while the route box
  // beside it showed the protest.
  {
    const held = { ...liveInputs([]), avoid: { ...liveInputs([]).avoid, suspended: 3 } };
    const snapshot = snapshotFor(held);
    const measured = routeVia(snapshot, project(snapshot));
    t.check(!measured.fault, `a route still computes with the list switched off (${measured.fault ?? "no fault"})`);
    t.equal(measured.caveats.avoidSuspended, 3,
      "and says how many standing entries were switched off for it");

    // **Zero and absent are different, and both are reachable.**
    //
    // `emptyAvoid()` carries `suspended: 0`, so anything built from it - which
    // is every avoid object the application makes - genuinely captured a count
    // of none and says so. An avoid object assembled from nothing captured no
    // such thing, and crosses as null. Collapsing both to null loses the distinction
    // the frozen record was built to keep.
    const open = snapshotFor(liveInputs([]));
    t.equal(routeVia(open, project(open)).caveats.avoidSuspended, 0,
      "a record built the normal way captured a count of none, and says none");

    const silent = liveInputs([]);
    // Built without the field, the way a future assembler might.
    silent.avoid = {
      systemIds: new Set(), regionIds: new Set(), systemNames: [], regionNames: [],
    };
    const quiet = snapshotFor(silent);
    t.equal(routeVia(quiet, project(quiet)).caveats.avoidSuspended, null,
      "and a record that captured nothing says nothing rather than none");
  }

  // --- an operation this snapshot cannot serve is not offered ---------------
  //
  // `project` published all six operations unconditionally, which is the exact
  // failure this file's own module gives as the reason `within_jumps` is
  // absent: "shipping an operation that can only fail teaches a model its
  // vocabulary is unreliable". `jumps_between` needs somebody to route as, and
  // a snapshot with no characters can never serve one - so it was offered on
  // every brief the application mints, where it can only refuse.
  //
  // It costs more than a wasted turn. `evaluateAll` is all-or-nothing, so a
  // model naming it beside three good figures loses the whole reply: every
  // figure, the relation and the closing view, replaced by an error about a
  // character the pilot never mentioned.
  {
    const withNobody = project(buildSnapshot({ now: 1_000_000, brief: { items: [] } }));
    t.check(!withNobody.vocabulary.operations.includes("jumps_between"),
      "a snapshot with no characters does not offer the operation that needs one");
    // Named, not counted. `length > 0` was `5 > 0` and could not fail.
    for (const op of ["max", "min"]) {
      t.check(withNobody.vocabulary.operations.includes(op),
        `while ${op}, which needs nothing this snapshot lacks, is still offered`);
    }
    // **`sum` is the fourth that could only fail.** It is refused for every `intensive`
    // field and for any truncated set, so on a brief with no live layers - which is
    // every brief the application mints - there is no pair it can succeed on: the only
    // additive fields are `kills.*` and `jumps.shipJumps`, both live-only.
    t.check(!withNobody.vocabulary.operations.includes("sum"),
      "and sum, which has no additive set to work on here, is not offered");

    // **A character is not enough.** `jumps_between` also needs a routing record
    // for that character, a `complete` one, and a mode - so a gate that asked
    // only "is anyone signed in" would start publishing the operation the
    // moment SSO lands and before a travelling-character selector exists, which
    // is exactly the window in which every brief would offer something that can
    // only fail.
    const named = project(buildSnapshot({
      now: 1_000_000,
      brief: { items: [] },
      characters: [{ id: CHARACTER, name: "Dave" }],
    }));
    t.check(!named.vocabulary.operations.includes("jumps_between"),
      "a character with no routing record is not enough to offer it");

    const routable = project(snapshotFor(liveInputs([])));
    t.check(routable.vocabulary.operations.includes("jumps_between"),
      "a snapshot that can actually route does offer it");

    const noMode = project(snapshotFor({ ...liveInputs([]), mode: "not-a-mode" }));
    t.check(!noMode.vocabulary.operations.includes("jumps_between"),
      "and one whose mode did not survive the freeze does not");
    // `within_jumps` is not in `OPERATIONS` at all, so a check that it is not
    // published cannot fail and is already made above. What is worth asserting
    // here is the shape of the gate: it publishes a *subset*, never an addition.
    for (const op of routable.vocabulary.operations) {
      t.check(OPERATIONS.includes(op), `${op} is published only if the closed set has it`);
    }

    // **The refusal has to agree with the prompt.** `evaluate` listed all six
    // when it refused an unknown operation, so a model that asked anyway was
    // corrected with a vocabulary contradicting the one it had been given.
    const bare = buildSnapshot({ now: 1_000_000, brief: { items: [] } });
    const refused = String(evaluate(bare, { op: "nonsense" }).fault);
    t.check(/nonsense/.test(refused), "an unknown operation is named in the refusal");
    t.check(!/jumps_between/.test(refused),
      "and the set it offers back is the one this snapshot published");
    t.check(/max/.test(refused), "which still lists what it can serve");
  }

  return t.results;
}
