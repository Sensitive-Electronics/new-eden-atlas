// The closed set of operations, and the **second crossing**.
//
// A model names an operation and its operands; this evaluates it and renders
// the operands beside the result, because a pilot checks the arithmetic by eye
// against figures that are not the model's.
//
// Everything `snapshot.js` hardened guards `project()`, and a result goes
// straight past it - so the same rules apply here: ids, numbers, and names out
// of the minted snapshot's resolved record, never `member.system.name`.
//
// Nothing here mutates; the sets are deep-frozen, so every ordering copies.

import {
  archiveName, CATALOGUE, FINDING_FIELDS, OPERATIONS, figure, inVocabulary,
  project, referenceFault, servableOperations,
} from "./snapshot.js";
import { formatSecurity, securityClass } from "./map-utils.js";
import { thawRouting } from "./routing-inputs.js";
import { edgeKey } from "./overrides.js";
import { lookup, safe } from "./contract.js";

const SET = "set:";
const FINDING = "finding:";
const CHARACTER = "character:";

// How a leg is travelled. `gate` is the default the planner falls back to.
const LEG_KINDS = Object.freeze(["gate", "bridge", "wormhole"]);

// CCP's own threshold. A wormhole with under four hours left is shown as
// "reaching the end of its natural lifetime" in the client, and EVE University
// advises against traversing one without another way home.
//
// **Alive now is not alive when you get there.** Dropping a link at its expiry
// answers the question at the instant the route is computed, and a pilot flies
// it afterwards - a hole twenty jumps away with eight minutes left is open at
// query time and gone long before they reach it. The time-varying graph
// literature calls this departure-time against arrival-time validity, and it
// is the one thing a binary is-it-open check cannot express.
//
// This does not invent a travel-time model to resolve it. Jump duration
// depends on the hull, align time, gate congestion and whether anyone is
// shooting, and a figure assembled out of assumptions is exactly what this
// project refuses to put in front of a pilot. So the remaining life is
// reported per wormhole leg and the judgement stays with the person flying.
//
// The expiry itself is the *earliest* the hole can close - CCP states there is
// variance past it - so dropping a link at that instant errs in the safe
// direction, which is the direction this whole record errs in.
const END_OF_LIFE_MS = 4 * 60 * 60 * 1000;

// Unbounded, a `max` over 520 systems renders all 520 members - 44KB against a
// half-kilobyte projection - which undoes the catalogue's discipline through the door
// this module opens.
//
// Past this limit the check a pilot is offered degrades from "do these addends add
// up" to "is this the population I expected". `renderedAll` says which.
const RENDER_LIMIT = 20;

// How many operations one reply may ask for. A brief a pilot reads under fire
// is a handful of figures; a hundred is a model filling the screen, and each
// one is a planner call or a pass over a set.
const OPERATION_LIMIT = 12;

function setNameOf(ref) {
  return typeof ref === "string" && ref.startsWith(SET) ? ref.slice(SET.length) : null;
}

// A member's value, or `undefined` - never a zero standing in for an absence. A sum
// over a field half the members do not have is a lie that computes cleanly.
function valueOf(accessor, member) {
  let raw;
  try {
    raw = accessor(member);
  } catch {
    return undefined;
  }
  return Number.isFinite(raw) ? raw : undefined;
}

// Every name in this module comes from `archiveName`, which reads the minted
// snapshot's own record and then the resolver that snapshot was minted with.
//
// **One name path, not two.** A resolver taken off a per-call argument is not tied to
// the snapshot, so a caller can mint against one archive and render route legs from
// another - or from a hostile one, which names every middle leg of a route with a
// sentence. A name is vouched for by the same brand as the rest of the projection, or
// it is not a name.
const nameOf = archiveName;

// Ids, numbers and a vouched-for name. Nothing else, ever - a set member is a
// full SDE record and a live row is whatever a layer returned.
function renderMember(snapshot, entry, member, value, field) {
  const systems = entry.systemsOf(member);
  const first = systems.length > 0 ? systems[0] : null;
  const id = first && Number.isFinite(first.system_id) ? first.system_id : null;
  const row = {
    systemId: id,
    systemName: nameOf(snapshot, id),
    value,
    ...classOf(field, value),
  };
  // A list, because a bridge has two ends and an incursion has a constellation. An
  // `otherId`/`otherName` pair fits the bridge and silently renders two of an
  // incursion's three systems.
  if (systems.length > 1) {
    row.systems = systems
      .filter((system) => Number.isFinite(system.system_id))
      .map((system) => ({ id: system.system_id, name: nameOf(snapshot, system.system_id) }));
  }
  return row;
}

// `String(x)` runs a caller's `toString`, which can throw - escaping `evaluate` as an
// exception instead of the documented fault - and can be two million characters long.
// Neither belongs in a message a boundary produces.
//
// Imported rather than declared, because this is a boundary a model's own strings
// cross and a copy that bounds length without flattening is not this function. See
// the note on `safe` in `contract.js`.

// The band beside the number: EVE's scale is threshold-defined, so 0.5 and 0.4
// differ by one tenth and by the whole of CONCORD. The number is already the
// displayed decimal, from the catalogue's accessor.
//
// Classifying the *displayed* value is safe and not by luck - both band edges
// sit exactly on rounding edges, and `tests/security-boundary.test.mjs` asserts
// it over all 8,490 systems.
function classOf(field, value) {
  if (field !== "security" || !Number.isFinite(value)) return {};
  return { securityClass: securityClass(value) };
}

function fault(message) {
  return { fault: String(message) };
}

// Deep, not one level. `Object.freeze(operands)` and `Object.freeze(row)` each
// left an array inside writable: `compare`'s `operands.findings` took a push,
// and a member row's `systems` list took a rewritten name - so anything between
// the evaluator and the wire could edit a record that looks code-computed.
// `snapshot.js` deep-freezes for exactly this reason.
function frozen(value, seen = new WeakSet()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  Object.freeze(value);
  for (const key of Object.keys(value)) frozen(value[key], seen);
  return value;
}

// How far back a delta looks, in source cadences. Twenty-four hourly samples
// is a day for the layer this was built for, and it is the *brief's* number
// rather than the model's - a model choosing between "the last hour" and "the
// last day" is choosing which answer it gets.
const DELTA_SAMPLES = 24;

// Matched on the clock, within one cadence either side. Never by index: an
// hour nobody measured is not in the list, so counting back N entries reaches
// a different time for every system and says nothing about which.
function nearest(samples, target, tolerance) {
  let best = null;
  let bestGap = Infinity;
  for (const sample of samples) {
    const gap = Math.abs(sample.at - target);
    if (gap <= tolerance && gap < bestGap) {
      best = sample;
      bestGap = gap;
    }
  }
  return best;
}

// A row inside one sample, for one system - read through **the layer's own
// catalogue entry**, which is the single definition of what a field means.
//
// Indexing a field list positionally against `[id, ...values]` tuples gives one layer
// two row shapes - objects for its latest rows, tuples for its series - so a caller
// holding one `Map<id, {...}>` for each has to convert one way for the catalogue and
// the other for the delta, with nothing saying which.
function valueIn(entry, sample, systemId, field) {
  const declared = lookup(entry.fields, field);
  if (declared === undefined) return figure(undefined);
  const row = (sample.rows || []).find((each) => {
    const systems = entry.systemsOf(each);
    return systems.length > 0 && systems[0].system_id === systemId;
  });
  // Absent is a measured zero here, and only here: a sample exists only for an
  // hour that was measured, so a system missing from one is a system nothing
  // happened in. That reasoning does not hold for a layer that failed, which
  // is why the state is checked before any of this.
  if (!row) return figure(0);
  return figure(valueOf(declared.get, row));
}

// One finding, resolved to the system it names.
function oneFinding(snapshot, projection, ref) {
  const bad = referenceFault(projection, ref);
  if (bad) return fault(bad);
  if (typeof ref.ref !== "string" || !ref.ref.startsWith(FINDING)) {
    return fault(`${safe(ref && ref.ref)} is not a finding`);
  }
  const finding = (snapshot.findings || []).find((each) => each.id === ref.ref);
  const id = finding && finding.system ? finding.system.system_id : null;
  if (!Number.isFinite(id)) return fault(`${safe(ref.ref)} has no system`);
  return { ref: ref.ref, systemId: id };
}

// A route is an ordered path of legs, not a measured set - so it renders as
// one. `renderMember` shows a member and a value; neither is what a route is.
// Operands beside the result is the safety property rather than presentation,
// so a route rendered as a bare number is the half a pilot cannot check.
// Head and tail, never a prefix.
//
// `slice(0, RENDER_LIMIT)` is right for a *set* - `max` sorts first, so the bounded
// rendering is the top of the list. A route is ordered and its last element is the
// answer: Jita to Amarr high-sec-only is 34 jumps, and a prefix renders 20 legs
// ending somewhere in the middle with the destination absent entirely, which reads as
// a complete path to the wrong place.
//
// `leg` is the absolute index, so the gap between the head and the tail is
// visible in the list itself rather than only in `renderedAll`.
function renderedLegs(count) {
  if (count <= RENDER_LIMIT) return Array.from({ length: count }, (_, i) => i);
  const head = Math.ceil(RENDER_LIMIT / 2);
  const tail = RENDER_LIMIT - head;
  return [
    ...Array.from({ length: head }, (_, i) => i),
    ...Array.from({ length: tail }, (_, i) => count - tail + i),
  ];
}

function renderRoute(snapshot, route) {
  const kinds = Array.isArray(route.legKinds) ? route.legKinds : [];
  return renderedLegs(route.systems.length).map((index) => {
    const system = route.systems[index];
    const id = system && Number.isFinite(system.system_id) ? system.system_id : null;
    return {
      leg: index,
      systemId: id,
      // The archive's answer for that id, never `system.name` off the record
      // the planner handed back - the same rule every other rendering obeys.
      // The snapshot's record first, then the caller's resolver, because the
      // middle of a route is systems no brief ever named.
      systemName: nameOf(snapshot, id),
      // How this leg is travelled, from a closed set. A route must not call a
      // collapsing wormhole a bridge: one is a structure an alliance anchored,
      // the other has hours to live and a mass limit.
      //
      // A vocabulary rather than a type check. The value arrives from the planner by
      // way of `bridges.kinds`, which `pairs()` carries by reference with no check, so
      // `typeof kinds[i] === "string"` renders whatever string is there - a sentence
      // as a `via`. The app writes only "bridge" and "wormhole", which is a
      // coincidence at two call sites rather than a guard.
      via: index === 0 ? null : inVocabulary(LEG_KINDS, kinds[index - 1]),
    };
  });
}

// What the route cost, in the planner's own terms.
//
// `calculate` returns twenty-one fields, and the ones that matter most here are the
// ones saying **the route did not do what the pilot asked**: `avoidedAnyway` (systems
// they marked that the route enters regardless), `edgesUsedAnyway` (a marked gate or
// bridge it had to use), `belowHighSecurity`, `hotCrossed`, and the bridge and
// wormhole counts that make a jump count conditional.
//
// `route-planner.js` states the contract in the code - "Never empty silently" - and
// `panels.js` honours it with a protest panel. Returning a clean number tells a pilot
// who marked a system "28 jumps" with no trace of it, and reports a 23-jump route
// that dipped through thirteen systems outside high security in silence.
//
// Ids, numbers and resolved names, so it crosses under the same rule as everything
// else.
// The wormhole legs a route actually uses, with how long each has left.
//
// Not every wormhole in the network - the ones on this path. A route that uses
// none of them says so with an empty list, which is different from a route
// that uses three with twenty minutes between them.
function wormholeLegs(snapshot, route, expiry, at) {
  const kinds = Array.isArray(route.legKinds) ? route.legKinds : [];
  const legs = [];
  for (let index = 0; index < kinds.length; index += 1) {
    if (inVocabulary(LEG_KINDS, kinds[index]) !== "wormhole") continue;
    const from = route.systems[index];
    const to = route.systems[index + 1];
    const fromId = from && Number.isFinite(from.system_id) ? from.system_id : null;
    const toId = to && Number.isFinite(to.system_id) ? to.system_id : null;
    // The project's one edge key. Writing the `lo-hi` ordering out by hand is how
    // there comes to be a second copy of it.
    let expires;
    try {
      expires = expiry instanceof Map ? expiry.get(edgeKey(fromId, toId)) : undefined;
    } catch {
      expires = undefined;
    }
    const remaining = Number.isFinite(expires) && Number.isFinite(at) ? expires - at : null;
    legs.push({
      leg: index + 1,
      fromId,
      fromName: nameOf(snapshot, fromId),
      toId,
      toName: nameOf(snapshot, toId),
      // Null where the network carried no expiry. Unknown is not "plenty".
      msRemaining: remaining,
      // **The instant, so a rendering can keep counting down.** `msRemaining`
      // is measured against the clock this operation ran at and never moves
      // again; a window left open for an hour went on saying "27 minutes
      // remaining" for a hole that had collapsed thirty-three minutes earlier.
      // "Open when I asked is not open when you arrive" is this field's whole
      // reason for existing, and the rendering could not honour it.
      expiresAt: Number.isFinite(expires) ? expires : null,
      // Null rather than false when nothing is known, for the same reason.
      endOfLife: remaining === null ? null : remaining < END_OF_LIFE_MS,
    });
    if (legs.length >= RENDER_LIMIT) break;
  }
  return legs;
}

function routeCaveats(snapshot, route, lapsed, unknown, expiry, at, suspended) {
  const systems = (held) => (Array.isArray(held) ? held : [])
    .map((system) => (system && Number.isFinite(system.system_id) ? system.system_id : null))
    .filter((id) => id !== null)
    .slice(0, RENDER_LIMIT)
    .map((id) => ({ systemId: id, systemName: nameOf(snapshot, id) }));
  const edges = (Array.isArray(route.edgesUsedAnyway) ? route.edgesUsedAnyway : [])
    .slice(0, RENDER_LIMIT)
    .map((edge) => ({
      // The pilot's own `reason` stays behind: it is text they typed, and the
      // rule is that the model receives ids and code renders every name.
      via: inVocabulary(LEG_KINDS, edge && edge.kind),
      fromId: edge && edge.from && Number.isFinite(edge.from.system_id) ? edge.from.system_id : null,
      toId: edge && edge.to && Number.isFinite(edge.to.system_id) ? edge.to.system_id : null,
    }))
    .map((edge) => ({
      ...edge,
      fromName: nameOf(snapshot, edge.fromId),
      toName: nameOf(snapshot, edge.toId),
    }));
  const count = (held) => (Array.isArray(held) ? held.length : 0);
  return {
    // What the pilot is holding back rather than what they have dropped. A
    // suspended list routes exactly like an empty one and means the opposite,
    // and this is the only field that can tell a reader which they are looking
    // at.
    //
    // **Zero is carried as zero.** A record that captured a suspension count of none
    // says none; one that captured nothing says nothing. Collapsing them breaks the
    // three-states rule at the render, under code that froze it correctly.
    avoidSuspended: Number.isFinite(suspended) ? suspended : null,
    // Systems the pilot asked to avoid that the route entered anyway.
    avoidedAnyway: systems(route.avoidedAnyway),
    // Gates and bridges they had marked that it had to use.
    edgesUsedAnyway: edges,
    // Where a route left high security, which is the whole question for a
    // hauler and is invisible in a jump count.
    belowHighSecurity: count(route.belowHighSecurity),
    // Systems with recent kills it crossed regardless.
    hotJumps: count(route.hotCrossed),
    // Legs that are conditional on something no API reports: a bridge being
    // online and fuelled, a wormhole still being open.
    bridgeJumps: Number.isFinite(route.bridgeJumps) ? route.bridgeJumps : 0,
    wormholeJumps: Number.isFinite(route.wormholeJumps) ? route.wormholeJumps : 0,
    // Links the snapshot held that have since lapsed and were not offered to
    // the planner. Said rather than silently dropped: a route that is longer
    // because three wormholes died is a different fact from a route that was
    // always that long.
    lapsedLinks: Number.isFinite(lapsed) ? lapsed : 0,
    // Links refused for carrying a kind the planner does not have. Separate
    // from a lapse: one is a thing that ended, the other is a record this
    // build cannot read, and a pilot reads those differently.
    unknownLinks: Number.isFinite(unknown) ? unknown : 0,
    // Which wormhole legs the route uses and how long each has left, because
    // "open when I asked" is not "open when you arrive".
    wormholes: wormholeLegs(snapshot, route, expiry, at),
  };
}

// Exactly one character, named. `referenceFault` refuses a character this
// snapshot does not carry, and an FC snapshot carries exactly one entry - so
// there is no signature here in which a union is expressible.
function character(snapshot, projection, request) {
  const ref = request.character;
  const bad = referenceFault(projection, ref);
  if (bad) return fault(bad);
  if (typeof ref.ref !== "string" || !ref.ref.startsWith(CHARACTER)) {
    return fault(`${safe(ref && ref.ref)} is not a character`);
  }
  // `referenceFault` has already held the ref to `/^character:[0-9]+$/`, so
  // there is one spelling per character. The ref is rebuilt from the id rather
  // than echoed, because what the operation used was the id.
  const id = Number(ref.ref.slice(CHARACTER.length));
  return { id, ref: `${CHARACTER}${id}` };
}

// Endpoints are findings, so a system the brief never surfaced cannot be one.
// The same rule that closed the bare-system-id hole, applied where it matters.
function routeEnds(snapshot, projection, request) {
  const seen = [];
  for (const [label, ref] of [["from", request.from], ["to", request.to]]) {
    const bad = referenceFault(projection, ref);
    if (bad) return fault(`${label}: ${bad}`);
    if (typeof ref.ref !== "string" || !ref.ref.startsWith(FINDING)) {
      return fault(`${label} is not a finding`);
    }
    const finding = (snapshot.findings || []).find((each) => each.id === ref.ref);
    const id = finding && finding.system ? finding.system.system_id : null;
    if (!Number.isFinite(id)) return fault(`${label} has no system`);
    const name = nameOf(snapshot, id);
    if (name === null) {
      return fault(`${label} has no name the archive vouched for, so it cannot be routed to`);
    }
    seen.push({ ref: ref.ref, systemId: id, name });
  }
  if (seen[0].ref === seen[1].ref) return fault("a route runs between two different findings");
  return { from: seen[0], to: seen[1] };
}

// Every operation over a set resolves the same way, so the resolution lives
// once. A difference between two operations should be arithmetic, not
// validation.
function resolveSet(snapshot, projection, request) {
  const operand = request.set;
  const bad = referenceFault(projection, operand);
  if (bad) return fault(bad);

  const name = setNameOf(operand.ref);
  const entry = name === null ? undefined : lookup(CATALOGUE, name);
  if (entry === undefined) return fault(`${safe(operand.ref)} is not a set`);

  const declared = lookup(entry.fields, request.field);
  if (declared === undefined) {
    const offered = Object.keys(entry.fields);
    return fault(offered.length === 0
      ? `set:${name} has no measurable fields; its size is the answer it offers`
      : `set:${name} has no field ${safe(request.field)}; it has ${offered.join(", ")}`);
  }
  const accessor = declared.get;

  // `max` over the sorted field is the one measurement truncation cannot
  // damage. `min` over it returns the *cutoff*: Jita at depth 4 has 31
  // chokepoints, 20 survive, and it reported 34060.262 for a true 5226. Over
  // any other field the survivors are a biased sample.
  // `Object.hasOwn`, not a bare index: a set nobody computed has no own key,
  // and `Object.prototype.kills` was enough to publish and total a whole
  // fabricated live layer.
  const members = snapshot.sets && Object.hasOwn(snapshot.sets, name) ? snapshot.sets[name] : null;
  if (!Array.isArray(members)) return fault(`set:${name} was not computed in this snapshot`);
  // Truncated, as the analyzer reported it - not inferred from the length. A
  // set holding exactly its limit lost nothing, and was refused as though it
  // had. Silence falls back to the old inference, so this is never worse.
  const said = snapshot.truncated && Object.hasOwn(snapshot.truncated, name)
    ? snapshot.truncated[name]
    : null;
  const capped = entry.cap !== null
    && (said === null ? members.length >= entry.cap : said === true);
  if (capped && !(request.op === "max" && request.field === entry.sortedBy)) {
    return fault(
      `set:${name} keeps only its top ${entry.cap} by ${entry.sortedBy}, `
      + `so the only measurement truncation cannot damage is max over ${entry.sortedBy}`,
    );
  }

  if (members.length === 0) return fault(`set:${name} is empty, so there is nothing to measure`);

  const measured = [];
  for (const member of members) {
    const value = valueOf(accessor, member);
    // One absent value refuses the whole operation. A sum over the members
    // that happened to have the field is a number with no stated population,
    // which is the shape of every statistic that lies.
    if (value === undefined) {
      // "No usable value" rather than "no field": a member carrying Infinity
      // or NaN has the field and still cannot be measured, and a message that
      // says the field is missing sends a reader looking in the wrong place.
      return fault(`a member of set:${name} has no usable ${safe(request.field)}, so the set cannot be measured on it`);
    }
    measured.push({ member, value });
  }

  return { name, entry, measured, capped };
}

function rendered(snapshot, entry, measured, field) {
  return measured.slice(0, RENDER_LIMIT).map(
    (row) => renderMember(snapshot, entry, row.member, row.value, field),
  );
}

function summed(measured) {
  let total = 0;
  for (const row of measured) total += row.value;
  return total;
}

// Copied before ordering: the sets are deep-frozen and an in-place sort throws.
function ranked(measured, descending) {
  return [...measured].sort((a, b) => (descending ? b.value - a.value : a.value - b.value));
}

const KINDS = Object.freeze({
  sum(snapshot, projection, request) {
    const found = resolveSet(snapshot, projection, request);
    if (found.fault) return found;
    // The guard the `additive` declaration was kept for. Through `lookup`
    // like every other table read here, because this is the file where
    // `OPS["constructor"]` was once truthy.
    const declared = lookup(found.entry.fields, request.field);
    if (!declared || !declared.additive) {
      return fault(`set:${found.name} cannot be totalled on ${safe(request.field)}: ${declared.why}`);
    }
    return {
      result: summed(found.measured),
      rendered: rendered(snapshot, found.entry, found.measured, request.field),
      population: found.measured.length,
      capped: found.capped,
      operands: { set: `set:${found.name}`, field: request.field },
    };
  },

  max(snapshot, projection, request) {
    const found = resolveSet(snapshot, projection, request);
    if (found.fault) return found;
    const order = ranked(found.measured, true);
    return {
      result: order[0].value,
      // Ranked before truncating, so a bounded rendering of a max is the top
      // of the list rather than an arbitrary slice of it.
      rendered: rendered(snapshot, found.entry, order, request.field),
      population: order.length,
      capped: found.capped,
      operands: { set: `set:${found.name}`, field: request.field },
    };
  },

  min(snapshot, projection, request) {
    const found = resolveSet(snapshot, projection, request);
    if (found.fault) return found;
    const order = ranked(found.measured, false);
    return {
      result: order[0].value,
      rendered: rendered(snapshot, found.entry, order, request.field),
      population: order.length,
      capped: found.capped,
      operands: { set: `set:${found.name}`, field: request.field },
    };
  },

  // --- change over time, matched on the clock ---------------------------------
  //
  // Everything awkward here comes from one fact: **the samples are not evenly
  // spaced**, because an hour nobody synced is not in the list. So the older
  // endpoint is found by matching the clock within one republish window, and
  // nothing in range is a refusal rather than whatever happens to be oldest.
  //
  // The window is the source's own cadence times the brief's count, off the
  // snapshot - a model picking "the last day" over "the last hour" is picking
  // which answer it gets.
  delta(snapshot, projection, request) {
    const where = oneFinding(snapshot, projection, request.finding);
    if (where.fault) return where;

    const source = (snapshot.sources || []).find((entry) => entry.name === request.source);
    if (!source) return fault(`this snapshot carries no ${safe(request.source)}`);
    if (source.state !== "synced") {
      return fault(`${safe(request.source)} is ${source.state}, so there is no change to measure`);
    }
    if (!Array.isArray(source.series) || source.series.length < 2) {
      return fault(`${safe(request.source)} holds no series to compare against`);
    }
    if (!Number.isFinite(source.resolutionMs)) {
      return fault(`${safe(request.source)} has no measured cadence, so no sample can be matched to a time`);
    }
    // The layer's own entry. A source with no measurable fields has nothing a
    // delta can be taken of, and says so rather than reading a row blindly.
    const entry = lookup(CATALOGUE, source.name);
    if (entry === undefined || Object.keys(entry.fields).length === 0) {
      return fault(`${safe(request.source)} declares no field a change can be measured on`);
    }

    const newest = source.series[source.series.length - 1];
    const target = newest.at - (source.resolutionMs * DELTA_SAMPLES);
    const older = nearest(source.series, target, source.resolutionMs);
    if (older === null) {
      return fault("there is no sample near that far back, and the oldest stored one is a different question");
    }

    const now = valueIn(entry, newest, where.systemId, request.field);
    const then = valueIn(entry, older, where.systemId, request.field);
    // A system absent from a stored sample is a measured zero: only hours that
    // were actually measured are ever appended, so absence inside one is the
    // endpoint reporting nothing rather than nobody asking.
    if (!now.known || !then.known) {
      return fault("one of the two samples has no usable reading, so the change is unknown");
    }

    return {
      result: now.value - then.value,
      rendered: [
        { at: older.at, systemId: where.systemId, systemName: nameOf(snapshot, where.systemId), value: then.value },
        { at: newest.at, systemId: where.systemId, systemName: nameOf(snapshot, where.systemId), value: now.value },
      ],
      population: 2,
      capped: false,
      renderKind: "sample",
      operands: {
        finding: where.ref, source: request.source, field: request.field,
        // The gap actually measured, which is rarely the gap asked for. A
        // sentence that says "the last day" over an eighteen-hour gap is
        // wrong, and this is the number that stops it.
        acrossMs: newest.at - older.at,
      },
    };
  },

  // --- the one that can strand somebody --------------------------------------
  //
  // Calls **the calculator the button calls**, with the snapshot's own frozen
  // inputs and its own clock - `calculate` defaults `now` to `Date.now()`, so
  // calling it bare would leave the freeze as a comment above code ignoring it.
  //
  // One character, named explicitly, with no default and no "the active one":
  // a union-routed plan sends a pilot through bridges they cannot use.
  jumps_between(snapshot, projection, request, tools) {
    const ends = routeEnds(snapshot, projection, request);
    if (ends.fault) return ends;
    const who = character(snapshot, projection, request);
    if (who.fault) return who;
    if (!tools || !tools.planner) return fault("no route planner was supplied");

    // A character the snapshot carries but has no routing inputs for cannot
    // be routed. Falling through to empty inputs produced a route with no
    // avoid list, no limits and no bridges - an unrestricted path straight
    // through everything that pilot said to keep away from, reported as
    // theirs.
    const held = snapshot.routing && Object.hasOwn(snapshot.routing, who.id)
      ? snapshot.routing[who.id]
      : null;
    if (held === null) {
      return fault(`this snapshot carries no routing inputs for ${who.ref}, so no route is theirs`);
    }
    // The present, not the snapshot's instant. Overrides and heat are read
    // against `takenAt` below, because a lapsed override only makes a route
    // more cautious; an expiring link read against `takenAt` is a route
    // through a wormhole that has since collapsed. A caller may pin the clock;
    // nothing else may.
    const at = tools && Number.isFinite(tools.now) ? tools.now : Date.now();
    const inputs = thawRouting(held, at);
    // A record that was never fully captured is refused, not routed. An empty
    // `avoid` that nobody filled in is an unrestricted path through everything
    // the pilot said to keep away from, reported as theirs.
    if (!inputs.complete) {
      return fault(`the routing inputs for ${who.ref} were not fully captured, and an uncaptured avoid list is not an empty one`);
    }
    // The record carries whose it is, and `plainRouting` stamps it from the key it
    // files it under - so a record reached through `snapshot.routing[id]` always names
    // that id and an equality check here could never fire.
    //
    // The stamp stays because it is what makes a frozen record self-describing, and it
    // is what a future caller building the map some other way has to get right. The
    // check does not.
    // The pilot's mode, off the snapshot. A model choosing between `shortest`
    // and `high-sec-only` is choosing the answer - 11 jumps against 34 for the
    // same pair - which is choosing a population through a parameter.
    if (inputs.mode === null) {
      return fault("this snapshot did not capture a route mode, and guessing one answers a different question");
    }
    let route;
    try {
      // `calculate` resolves **names**, not ids - it takes what a pilot typed
      // into the route box. So the endpoints go through the snapshot's own
      // resolved record, which is the archive's answer for that id and the
      // only name this module is allowed to use. A system the resolver cannot
      // vouch for cannot be routed to, which is the same refusal a read makes.
      route = tools.planner.calculate(
        ends.from.name, ends.to.name, inputs.mode,
        inputs.avoid, inputs.limits, inputs.bridges, inputs.overrides, inputs.heat,
        // The snapshot's own instant, never the wall clock. Overrides carry
        // expiries, so a route computed at `Date.now()` under a frozen brief
        // is the mismatch in miniature.
        snapshot.takenAt,
      );
    } catch (error) {
      return fault(`the route could not be computed: ${safe(error && error.message)}`);
    }
    // `systems` is the path and `jumps` is its length - the planner's own
    // fields, read rather than assumed. A guess at `route.path` produced a
    // clean "there is no route" for every pair in New Eden.
    if (!route || !Array.isArray(route.systems) || route.systems.length === 0) {
      return fault("there is no route between those two under this character's access");
    }
    // The planner resolves **names**, and it falls back to a prefix match. The
    // findings named ids. Nothing checked that what came back is a route
    // between the two systems the operands claim, and `operands` asserts it.
    // System names are unique across all 8,490 archive systems today, so this
    // is a missing assertion rather than a live defect - which is exactly when
    // it is cheap to add.
    const first = route.systems[0];
    const last = route.systems[route.systems.length - 1];
    if (!first || first.system_id !== ends.from.systemId
      || !last || last.system_id !== ends.to.systemId) {
      return fault("the planner returned a route between two other systems, so it is not the one that was asked for");
    }
    if (!Number.isFinite(route.jumps)) {
      // No fallback to `route.systems.length - 1`: `route-planner.js` defines `jumps`
      // as exactly that subtraction, so it would be the same arithmetic under a
      // different name. A planner that stops reporting a count is a planner this has
      // not been checked against.
      return fault("the planner returned a route with no jump count");
    }
    return {
      result: route.jumps,
      rendered: renderRoute(snapshot, route),
      population: route.systems.length,
      capped: false,
      renderKind: "leg",
      // What the route cost the pilot's own instructions. Beside the result
      // rather than inside `operands`, because these are not what was named -
      // they are what came back.
      caveats: routeCaveats(
        snapshot, route, inputs.lapsedLinks, inputs.unknownLinks,
        inputs.bridges.expiry, at, inputs.avoidSuspended,
      ),
      operands: {
        from: ends.from.ref, to: ends.to.ref, character: who.ref,
        // The single largest determinant of the number - 11 jumps against 34 for one
        // pair - so without it two records answering two different questions are
        // identical.
        mode: inputs.mode,
      },
    };
  },

  // Two findings on one field. The plan's rule that a relation may not prefer
  // a side applies here too: **the order comes from the numbers, never from
  // which argument was first**, so the rendering is sorted and the caller
  // cannot rank by choosing an argument position.
  compare(snapshot, projection, request) {
    const refs = request.findings;
    if (!Array.isArray(refs) || refs.length !== 2) {
      return fault("compare takes exactly two findings");
    }
    // Comparing a thing with itself computes cleanly and means nothing: zero,
    // with the same row rendered twice, which reads like a finding.
    if (refs[0] && refs[1] && refs[0].ref === refs[1].ref) {
      return fault("compare takes two different findings");
    }
    const declaredFinding = lookup(FINDING_FIELDS, request.field);
    const accessor = declaredFinding ? declaredFinding.get : undefined;
    if (accessor === undefined) {
      return fault(`a finding has no field ${safe(request.field)}; it has ${Object.keys(FINDING_FIELDS).join(", ")}`);
    }

    const rows = [];
    for (const ref of refs) {
      const bad = referenceFault(projection, ref);
      if (bad) return fault(bad);
      if (typeof ref.ref !== "string" || !ref.ref.startsWith(FINDING)) {
        return fault(`${safe(ref.ref)} is not a finding`);
      }
      const finding = (snapshot.findings || []).find((each) => each.id === ref.ref);
      if (!finding) return fault(`${ref.ref} is not in this snapshot`);
      const value = valueOf(accessor, finding);
      if (value === undefined) return fault(`${ref.ref} has no ${safe(request.field)}`);
      const id = finding.system && Number.isFinite(finding.system.system_id) ? finding.system.system_id : null;
      rows.push({ systemId: id, systemName: nameOf(snapshot, id), value, ...classOf(request.field, value) });
    }

    // `Array.prototype.sort` is stable, so on equal values the order was the
    // order the arguments arrived in - and `rendered[0]` is the slot a read
    // template fills as the preferred side. The model could therefore rank by
    // choosing which finding to name first, which is the exact thing the
    // comment above forbids. The system id is an arbitrary tiebreak and that
    // is the point: it is not the caller.
    const order = [...rows].sort((a, b) => (b.value - a.value) || (a.systemId - b.systemId));
    return {
      // The difference, not a winner. A winner is a ranking and the rendering
      // already carries the order.
      result: order[0].value - order[1].value,
      rendered: order,
      population: order.length,
      capped: false,
      operands: { findings: refs.map((ref) => ref.ref), field: request.field },
    };
  },
});

// Every operation in one reply, over **one** snapshot, all or nothing.
//
// If any operation in a reply fails, nothing from that reply is shown, the relation
// included. A caller looping `evaluate` op by op cannot enforce that: each call
// validates against whichever snapshot it was handed, so a reply mixing two snapshots
// is accepted one operation at a time, and a caller that forgets to stop on the first
// fault shows the rest.
//
// So it is a signature. One snapshot in, one `snapshotId` out, and a fault
// instead of a list the moment anything refuses. The fault says which operation
// failed, because "something in this brief did not compute" sends a reader
// through all of them.
//
// A reply with no operations is not a failure - a model may have nothing to
// measure and still have a relation worth stating.
export function evaluateAll(snapshot, requests, tools) {
  if (!Array.isArray(requests)) return fault("operations are a list, even when there is one");
  if (requests.length > OPERATION_LIMIT) {
    return fault(`a reply carries at most ${OPERATION_LIMIT} operations, and that one carries ${requests.length}`);
  }
  const results = [];
  let snapshotId = null;
  for (const [index, request] of requests.entries()) {
    const outcome = evaluate(snapshot, request, tools);
    if (outcome.fault) return fault(`operation ${index + 1} of ${requests.length}: ${outcome.fault}`);
    // Every one is against the snapshot this was called with, so they cannot
    // disagree - asserted rather than assumed, because the whole point of the
    // single-snapshot signature is that this can never be two values.
    // One snapshot in, so `evaluate` stamps the same id on every result and
    // there is no second value for this to disagree with. Recorded rather than
    // checked: a branch that cannot fire reads as a live guard and is not one.
    snapshotId = outcome.snapshotId;
    results.push(outcome);
  }
  // **Sorted, because the order a reply asks in is a ranking.**
  //
  // `relations.js` denies the model slot order outright - "the findings are
  // sorted into the order the panel rendered them, because slot order is a
  // ranking" - and `compare` breaks value ties on system id precisely so a
  // model cannot rank by choosing which finding to name first. Then the list
  // containing them came back in whatever order it was asked in, and a
  // renderer lays a list out top to bottom. The same defect `compare` was
  // patched for, one level up.
  //
  // By operation, then by what was named. "The model chose what to measure"
  // survives this; "the model chose what you read first" does not.
  const ordered = [...results].sort((a, b) => (
    OPERATIONS.indexOf(a.op) - OPERATIONS.indexOf(b.op)
    || JSON.stringify(a.operands).localeCompare(JSON.stringify(b.operands))
  ));
  return Object.freeze({
    snapshotId: snapshotId ?? project(snapshot).snapshotId,
    results: Object.freeze(ordered),
  });
}

export function evaluate(snapshot, request, tools) {
  if (!snapshot || typeof snapshot !== "object") return fault("no snapshot");
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    return fault("a request is one operation, not several");
  }

  let outcome;
  try {
    // Inside the guard. `project` was called before it, so a snapshot carrying
    // `findings: [null]` threw a TypeError straight out of a function whose
    // documented contract is that it returns faults - from a message loop where
    // an exception unwinds through the transport.
    //
    // A projection of an unminted object has no identity, and `referenceFault`
    // refuses an anonymous projection outright, so this is where "operands must
    // name things in *this* snapshot" becomes true rather than intended.
    const projection = project(snapshot);
    if (projection.snapshotId === null) {
      return fault("this snapshot was not minted here, so nothing in it can be named");
    }
    const kind = lookup(KINDS, request.op);
    if (kind === undefined) {
      // The set **this snapshot offers**, which is what the model was given.
      // Listing all six corrected a model with a vocabulary contradicting the
      // one in its own prompt.
      return fault(`unknown operation: ${safe(request.op)}; the set is ${servableOperations(snapshot).join(", ")}`);
    }
    outcome = kind(snapshot, projection, request, tools);
    if (outcome && !outcome.fault) outcome.snapshotId = projection.snapshotId;
  } catch (error) {
    // The module already catches rather than propagates inside `valueOf`, and
    // step 5 calls this from a message loop where an exception unwinds through
    // the transport. A boundary returns faults.
    return fault(`${safe(request.op)} could not be evaluated: ${safe(error && error.message)}`);
  }
  if (outcome.fault) return outcome;

  // A sum that overflows is `Infinity`, and `JSON.stringify(Infinity)` is
  // `null` - so an overflowed total crossed the wire indistinguishable from no
  // value at all. Every operand was finite and the result was not, which is
  // the one case the per-member check cannot catch.
  if (!Number.isFinite(outcome.result)) {
    // Not every operation has a field - `jumps_between` has two endpoints and a
    // character - and naming `undefined` as the field sends a reader looking
    // for one.
    return fault(typeof request.field === "string"
      ? `${safe(request.op)} over ${safe(request.field)} does not fit in a number`
      : `${safe(request.op)} produced a result that does not fit in a number`);
  }

  return frozen({
    op: request.op,
    snapshotId: outcome.snapshotId,
    result: outcome.result,
    // What was named, echoed back so a reply reads without the request - only
    // what this operation used, and only after it validated it. Echoing the
    // request verbatim let a `max` carry an arbitrary `findings` string
    // through as a label, attached to a correct, code-computed number.
    operands: outcome.operands,
    // The population, shown. This is the safety property rather than
    // presentation: it is how a pilot checks arithmetic against figures that
    // are not the model's.
    rendered: outcome.rendered,
    // How many members the result is over, and whether all of them are shown.
    // Past the render limit a pilot can no longer check the arithmetic by eye,
    // only the population, and saying which check is available is what makes a
    // bounded rendering different from a quietly partial one.
    population: outcome.population,
    // Which shape `rendered` holds. Three exist - a measured set member, a
    // route leg, a delta sample - and nothing said which, so step 7's renderer
    // and any wire schema would have had to sniff for `leg` being undefined.
    // One line now; a schema change on both ends once a transport exists.
    renderKind: outcome.renderKind || "member",
    renderedAll: outcome.rendered.length === outcome.population,
    // A truncated set's measurement is over what survived truncation. Saying
    // so is the difference between a figure and a misleading one.
    capped: outcome.capped,
    // Only a route has these. Absent rather than empty on everything else, so
    // "this operation has no caveats" and "this operation cannot have any" stay
    // different facts - the same distinction the source states are about.
    ...(outcome.caveats ? { caveats: outcome.caveats } : {}),
  });
}
