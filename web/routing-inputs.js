// The routing inputs a snapshot carries, and how they become what the planner
// takes.
//
// Four of `calculate`'s five inputs are Set- or Map-backed, and a snapshot
// cannot hold one: a frozen Map still takes `.set()`, so the freeze would be a
// comment. The snapshot carries arrays of pairs and this turns them back at the
// call.
//
// **That conversion is the one place a second router can hide.** A rehydrator
// that drops an avoided system does not throw and does not look wrong - it
// produces a shorter route, through the gate the pilot said to avoid, with
// every leg correct. So it is not judged by reading: the test builds the
// planner's inputs both ways from one source and matches the routes leg for
// leg.
//
// Both directions live in one file so a field added to one and forgotten in the
// other cannot drift. Unknown keys are **refused**, never dropped - filtering
// hands the planner an empty `avoid`, with no sign anything was ignored.
const ROUTING_KEYS = Object.freeze(["avoid", "limits", "bridges", "overrides", "heat", "mode"]);

// **Sized from the archive, not chosen.**
//
// New Eden has 8,490 systems and 114 regions - the numbers `snapshot.js`
// already cites for its name check - so a list longer than that is not a list
// of systems, whatever it is. Every routing input is keyed by a system, a
// region or an edge between two systems, so two numbers cover all of them; the
// pair lists get the system scale because a pilot-recorded bridge network with
// more links than New Eden has systems is past the point of being a typo.
//
// One shared number would be wrong in both directions: sized for an avoid list it
// would silently remove heat weighting from every route, and sized for heat it
// would bound nothing.
const SYSTEM_SCALE = 8_490;
const REGION_SCALE = 114;

// **Over the bound is `complete: false`, never a throw.**
//
// `freezeRouting` is called from inside `buildSnapshot`, which the brief path wraps
// in a catch - so throwing here does not refuse a routing input, it removes the
// whole brief's snapshot and with it the ask window, which looks identical to having
// no advisor at all. The house pattern degrades the field instead, and the record
// already carries the right sentence: an uncaptured avoid list is not an empty one.
// The brief still opens, every other operation still runs, and only the route
// refuses.
//
// The list is also cut, because the record has to stay a bounded object; it is never
// read, since `complete: false` refuses the operation first.
//
// A counter per call rather than a module-level flag: `plainRouting` freezes one
// record per character in a loop, and a shared flag would carry one pilot's
// over-long list into the next pilot's record.
function capper() {
  let over = false;
  const cap = (held, limit) => {
    if (held.length <= limit) return held;
    over = true;
    return held.slice(0, limit);
  };
  cap.over = () => over;
  return cap;
}

import { LINK_KINDS, ROUTE_MODES } from "./route-planner.js";
import { edgeKey } from "./overrides.js";

// Every sub-record the planner reads, present as a real object.
//
// Defaulting an absent one to `{}` makes "this pilot avoids nothing" and "nobody
// captured what this pilot avoids" the same frozen value, and the second routes
// straight through the gate they asked to keep away from. `app.js` holds all four
// as null until they are read, and resets `avoid` and `limits` to null whenever the
// avoid box fails to resolve, with the pilot's entries still on screen.
//
// Recorded rather than thrown, because `buildSnapshot` must not throw on the button
// path. The operation refuses instead.
const present = (value) => value !== null && value !== undefined
  && typeof value === "object" && !Array.isArray(value);

export function freezeRouting(live, characterId) {
  const capped = capper();
  const source = live && typeof live === "object" ? live : {};
  for (const key of Object.keys(source)) {
    if (!ROUTING_KEYS.includes(key)) {
      throw new TypeError(`routing has no ${key}; it takes ${ROUTING_KEYS.join(", ")}`);
    }
  }
  const avoid = source.avoid && typeof source.avoid === "object" ? source.avoid : {};
  const bridges = source.bridges && typeof source.bridges === "object" ? source.bridges : {};
  const overrides = source.overrides && typeof source.overrides === "object" ? source.overrides : {};
  const heat = source.heat && typeof source.heat === "object" ? source.heat : {};
  const limits = source.limits && typeof source.limits === "object" ? source.limits : {};

  return {
    avoidSystemIds: capped(idList(avoid.systemIds), SYSTEM_SCALE),
    avoidRegionIds: capped(idList(avoid.regionIds), REGION_SCALE),
    // Names are carried because `calculate` reads them - they are what a pilot
    // typed into the avoid box, and they are player text. They stay on the
    // snapshot and the projection never sees them, the same as every other
    // routing input.
    avoidSystemNames: capped(stringList(avoid.systemNames), SYSTEM_SCALE),
    avoidRegionNames: capped(stringList(avoid.regionNames), REGION_SCALE),

    // **Suspended is not empty.**
    //
    // A pilot may switch the avoidance list off without clearing it. The button then
    // routes with an empty avoid list *and* records what it is holding back, outside
    // `calculate`, so the panel can protest: presenting a route that breaks a
    // standing order as an ordinary one is the failure to avoid.
    //
    // Without this count the frozen record looks like a pilot who avoids nothing -
    // `complete` is true, because an empty avoid object is still a present one - so
    // an operation would report a jump count through a system under a standing order
    // while the route box beside it showed the protest.
    //
    // Null, not zero: "nobody captured this" and "nothing is suspended" are
    // different facts, and this record keeps that distinction everywhere else.
    avoidSuspended: numberOrNull(avoid.suspended),

    limits: { min: numberOrNull(limits.min), max: numberOrNull(limits.max) },

    bridgeLinks: capped(pairs(bridges.links), SYSTEM_SCALE),
    bridgeKinds: capped(pairs(bridges.kinds), SYSTEM_SCALE),
    // When each edge stops existing, for the edges that do. Without it a
    // frozen network cannot express that a wormhole lapsed, and `thawRouting`
    // has nothing to drop.
    bridgeExpiry: capped(pairs(bridges.expiry), SYSTEM_SCALE),
    bridgeCount: numberOrNull(bridges.count),
    // Keyed, so an expired edge loses its label with its link. An unkeyed list
    // leaves a name under a count of zero.
    bridgeNamed: capped(pairs(bridges.named), SYSTEM_SCALE),
    bridgeSource: typeof bridges.source === "string" ? bridges.source : null,
    bridgeSyncedAt: numberOrNull(bridges.syncedAt),

    overrideEntries: capped(pairs(overrides.entries), SYSTEM_SCALE),

    heatKills: capped(pairs(heat.kills), SYSTEM_SCALE),
    heatWeight: Number.isFinite(heat.weight) ? heat.weight : 0,
    heatAt: numberOrNull(heat.at),
    heatApplied: heat.applied === true,

    // **The mode is the pilot's**, and null rather than a default. Jita to Amarr is
    // 11 jumps `shortest` and 34 `high-sec-only`, so guessing answers a question
    // about a journey they were not planning.
    mode: typeof source.mode === "string" && ROUTE_MODES.includes(source.mode) ? source.mode : null,

    // Whether every input the planner reads was captured - **and** whether it is
    // believable. An avoid list longer than New Eden has systems was not captured
    // from a pilot's inputs, and routing on the part of it that fit is the shorter,
    // plausible, wrong route this file's header names.
    //
    // It does not require `avoid.suspended`: `emptyAvoid()` carries the truthful
    // default, so the field is there unless an avoid object is built from nothing,
    // and an absent one crosses as `null` rather than as zero.
    complete: !capped.over() && present(source.avoid) && present(source.limits) && present(source.bridges)
      && present(source.overrides) && present(source.heat),

    // Whose record this is. Unbound, a caller keying the map wrongly routes one
    // pilot on another's bridges and standings with no detectable symptom - the
    // stranding the routing rule is about, reached without anyone building a
    // union.
    characterId: Number.isInteger(characterId) && characterId > 0 ? characterId : null,
  };
}

// The inverse, and the only thing that builds a planner argument.
//
// **`now` is required once anything in the record expires**, and it is the
// present rather than the snapshot's instant. A snapshot freezes what was
// observed; it cannot freeze the future, and a wormhole's expiry is a claim
// about the future. Reading it against `takenAt` would route a pilot through a
// hole that was alive when the brief was taken and is gone now - which is the
// "never a historical record" rule, arrived at by holding a clock still.
//
// The asymmetry with overrides is deliberate and is about which way each one
// fails. An override that lapsed since the freeze is still honoured, so the
// route is more cautious than it needs to be. A wormhole that lapsed since the
// freeze is a route through nothing.
//
// With no clock, every expiring link is dropped. That is the fail-closed
// direction: a link this cannot verify is a link it does not offer.
export function thawRouting(frozen, now) {
  const held = frozen && typeof frozen === "object" ? frozen : {};
  const expiry = new Map(pairs(held.bridgeExpiry));
  const at = Number.isFinite(now) ? now : null;
  const lapsed = new Set();
  for (const [key, when] of expiry) {
    if (at === null || !Number.isFinite(when) || when <= at) lapsed.add(key);
  }
  const alive = (key) => !lapsed.has(key);
  // **A link whose kind is not one the planner knows is not offered.**
  //
  // The kind is the override target the edge is checked against, so a value
  // outside the vocabulary looks up an override that cannot exist and the edge
  // is crossed as though nothing had been said about it - a pilot's *hard*
  // "this bridge is gone" silently ignored.
  //
  // Dropped rather than defaulted to `"bridge"`. If the kind is unreadable
  // there is no knowing which it was, and the override the pilot set may have
  // been on either target; a link that cannot be checked is a link that is not
  // offered, which is the same rule an unreadable expiry follows.
  const known = new Set(pairs(held.bridgeKinds)
    .filter(([, kind]) => typeof kind === "string" && LINK_KINDS.includes(kind))
    .map(([key]) => key));
  const offered = (key) => known.has(key) && alive(key);
  // Both ends of a dropped edge, or the graph keeps a one-way link to a system
  // the route can enter and not leave.
  const linksWithout = (entries) => entries
    .map(([from, tos]) => [from, (Array.isArray(tos) ? tos : []).filter((to) => {
      const key = keyOf(from, to);
      return key !== null && offered(key);
    })])
    .filter(([, tos]) => tos.length > 0);
  const keptLinks = linksWithout(pairs(held.bridgeLinks));
  const keptKinds = pairs(held.bridgeKinds).filter(([key]) => offered(key));
  const keptNamed = pairs(held.bridgeNamed)
    .filter(([key, label]) => offered(key) && typeof label === "string");
  return {
    // How many links were dropped because they had lapsed, so an operation can
    // say so rather than quietly returning a longer route. Counted over the
    // links that were offerable at all, or a link refused for its kind would
    // also be reported as having expired.
    lapsedLinks: [...lapsed].filter((key) => known.has(key)).length,
    // And how many were refused for carrying a kind the planner does not have.
    unknownLinks: pairs(held.bridgeKinds).length - known.size,
    // Carried through rather than rebuilt: it is not a planner input, it is a
    // fact about the inputs that `routeCaveats` has to be able to state.
    avoidSuspended: numberOrNull(held.avoidSuspended),
    avoid: {
      systemIds: new Set(idList(held.avoidSystemIds)),
      regionIds: new Set(idList(held.avoidRegionIds)),
      systemNames: stringList(held.avoidSystemNames),
      regionNames: stringList(held.avoidRegionNames),
    },
    limits: {
      min: numberOrNull(held.limits && held.limits.min),
      max: numberOrNull(held.limits && held.limits.max),
    },
    bridges: {
      links: new Map(keptLinks),
      kinds: new Map(keptKinds),
      expiry: new Map([...expiry].filter(([key]) => offered(key))),
      // The count is what survived, not what was frozen. A count that still
      // includes dead links is a "bridges available" figure that is wrong.
      count: keptKinds.length,
      named: new Map(keptNamed),
      names: keptNamed.map(([, label]) => label),
      source: typeof held.bridgeSource === "string" ? held.bridgeSource : null,
      syncedAt: numberOrNull(held.bridgeSyncedAt),
    },
    overrides: { entries: new Map(pairs(held.overrideEntries)) },
    heat: {
      kills: new Map(pairs(held.heatKills)),
      weight: Number.isFinite(held.heatWeight) ? held.heatWeight : 0,
      at: numberOrNull(held.heatAt),
      applied: held.heatApplied === true,
    },
    mode: typeof held.mode === "string" && ROUTE_MODES.includes(held.mode) ? held.mode : null,
    complete: held.complete === true,
    characterId: Number.isInteger(held.characterId) && held.characterId > 0 ? held.characterId : null,
  };
}

// A Map or an array of pairs becomes an array of pairs. **Values are carried
// by reference**: the detachment is `owned()` in `buildSnapshot`, which clones
// and deep-freezes the whole record. `freezeRouting` alone is not one.
function pairs(value) {
  const entries = value instanceof Map ? [...value] : (Array.isArray(value) ? value : []);
  return entries
    .filter((entry) => Array.isArray(entry) && entry.length === 2)
    .map(([key, held]) => [key, held]);
}

// The project's one edge key, not a second copy of it.
//
// A local reimplementation returning `"NaN-NaN"` for a malformed pair puts it in no
// expiry map, so it reads as *alive* - the fail-open direction, on the one question
// this function exists to answer. `edgeKey` throws instead, and a link whose key
// cannot be built is a link that cannot be checked, so it is dropped.
function keyOf(a, b) {
  try {
    return edgeKey(a, b);
  } catch {
    return null;
  }
}

// A positive test, the same one `snapshot.js` uses for a system id.
// `Number(null)`, `Number("")` and `Number(false)` are all 0, and 0 is finite -
// so a list filtered on `Number.isFinite(Number(x))` quietly gains an id 0.
function idList(value) {
  const held = value instanceof Set ? [...value] : (Array.isArray(value) ? value : []);
  return held
    .map((id) => (typeof id === "number" ? id : (typeof id === "string" && /^[0-9]+$/.test(id) ? Number(id) : NaN)))
    .filter((id) => Number.isInteger(id) && id > 0);
}

function stringList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

function numberOrNull(value) {
  return Number.isFinite(value) ? value : null;
}
