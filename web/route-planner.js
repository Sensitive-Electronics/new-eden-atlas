import { HIGH_SECURITY, formatSecurity, securityClass } from "./map-utils.js";
import { TRUST, activeOverride, createStore, edgeKey, isBlocked, isDiscouraged, trustOf } from "./overrides.js";

function normalizeName(value) {
  // String() so a number or null yields a clean "not found" rather than a
  // TypeError, and toLowerCase() rather than toLocaleLowerCase() because the
  // latter is host-locale dependent: under a Turkish locale "Itamo" lowercases
  // to a dotless i and 530 system names become untypeable.
  return String(value ?? "").trim().toLowerCase();
}

function splitList(value) {
  return String(value || "").split(/[,;\n]/).map(entry => entry.trim()).filter(Boolean);
}

export function emptyAvoid() {
  // `suspended` is how many standing entries are being held back while the
  // list is switched off. Zero here rather than absent, because an empty avoid
  // list genuinely has nothing suspended - and every other avoid object in the
  // application is built from this one, so the field is true by construction
  // instead of by somebody remembering. A frozen record that carries it can
  // tell a pilot their route ignored a standing order; one that does not,
  // cannot, and says nothing at all.
  return { systemIds: new Set(), regionIds: new Set(), systemNames: [], regionNames: [], suspended: 0 };
}

export const ROUTE_MODES = ["shortest", "safer", "high-sec-only", "less-secure"];

// Offline stargate routing.
//
// Breadth-first over the archive's adjacency, plus the pilot's own additions: an
// alliance's Ansiblex bridges, scanned wormholes, an avoidance list, security limits
// and a kill-count weighting. No network and no authentication.
//
// The cost model is three tiers compared in order rather than one number, which is
// the part to read first: `addCost` and `cheaper` below say why.

// What a link that is not a stargate can be. Closed, and load-bearing rather
// than descriptive: the kind is the **override target** this edge is checked
// against, so a value outside this set looks up an override that cannot exist
// and the edge is traversed as though nothing had been said about it.
//
// A misspelt kind is therefore not a cosmetic error: a bridge a pilot has
// hard-ignored, tagged `"brdige"`, is crossed in one jump where the correctly tagged
// one refuses and routes 11 jumps by gate. A typo defeats a standing order.
export const LINK_KINDS = Object.freeze(["bridge", "wormhole"]);

// What an unrecognised mode becomes. Exported because two places have to agree about
// it: this planner, which substitutes silently, and the panel that restores a stored
// preference. Each choosing its own answer leaves a stored mode from an older build
// showing one thing on the control while the route is computed as another.
export const DEFAULT_ROUTE_MODE = "shortest";

// Route cost is three tiers, compared one after another rather than added into
// a single number.
//
//   [ soft avoids, primary cost, trust deficit ]
//
// Fewer soft-avoided edges always wins. Between routes that avoid the same
// number, the cheaper primary cost wins - jumps, weighted by mode, plus heat.
// Trust settles what is still tied. A hard entry is not costed at all; it is
// simply not traversable.
//
// **Why this is not one number.** Scaling each tier to out-weigh the one below is not
// merely fragile here, it is arithmetically impossible. The tiers accumulate over a
// path of up to `SYSTEM_COUNT - 1` = 8,489 edges, so each has to dominate the whole
// accumulated total of the next rather than its per-edge maximum:
//
//   trust     3 per edge, 25,467 over a path           15 bits
//   primary   up to HIGH_SEC_DETOUR per edge, 84.9M    27 bits
//   soft      must exceed that, over 8,489 edges       14 bits
//                                                      ------
//                                                      56 bits
//
// A double carries 53, so no choice of constants fits - and the shortfall lands where
// the arithmetic says it will. With `HIGH_SEC_DETOUR` and `SOFT_PENALTY` both 10,000,
// one soft avoid buys one low-sec jump: Jita to Amarr in high-sec-only is 34 jumps
// entirely in high security, and soft-avoiding Uedama turns it into 11 jumps through
// low security. A hauler doing the most ordinary thing there is - high-sec mode,
// Uedama on the avoid list - routed through low-sec.
//
// Comparing tier by tier removes the arithmetic and the whole class of bug with it.
// There is no scale to get wrong, no accumulation to bound, no overflow to reason
// about, and the ordering does not depend on how big the graph is.
const MAX_TRUST_PENALTY_PER_EDGE = 3;

// "High security only" is a restriction, not a preference.
//
// As a weight it is a promise the name does not keep: a low-sec jump costing 10,000
// high-sec jumps is still a jump the router will take when the alternative is long
// enough, so a hauler who asked for high security can be routed through low security
// and has to notice the warning to find out.
//
// So the mode restricts the graph instead. Systems below the boundary are not
// traversable at all, which makes "high security only" true by construction and makes
// "no route" a real answer rather than an expensive detour. The soft version of the
// same idea is a separate mode, "safer".
//
// `HIGH_SECURITY` is 0.45, not 0.5, because that is where the client's rounding puts
// the boundary: 0.45 displays as 0.5 and is high-sec.
function outsideHighSec(system) {
  return system.security < HIGH_SECURITY;
}

// Zero, and a value nothing can beat. Both are read-only in practice; addCost
// always builds a new tuple.
const ZERO_COST = [0, 0, 0];
const INFINITE_COST = [Infinity, Infinity, Infinity];

export function addCost(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

// Negative when a is cheaper. Left to right, so a difference in an earlier tier
// settles it whatever the later ones say - which is the guarantee that used to
// be an arithmetic claim and is now a structural one.
export function compareCost(a, b) {
  // Ordered by comparison rather than subtraction. Subtracting is the obvious
  // way to write this and it returns NaN for two equal infinities, which a heap
  // reads as "not less, not greater" and silently orders wrongly. The sentinel
  // for an unreached system IS infinite, so that pairing is one refactor away
  // from being reachable rather than safely hypothetical.
  // The tuple's own length, not a literal 3. A hard-coded bound silently
  // ignores any tier added after it - and this cost model has already been
  // rebuilt once, from a scalar that could not work, so a fourth tier is a
  // plausible future rather than a hypothetical one. Getting it wrong would not
  // throw; it would quietly stop honouring whatever the new tier expressed.
  const tiers = Math.max(a.length, b.length);
  for (let tier = 0; tier < tiers; tier += 1) {
    const left = a[tier] ?? 0;
    const right = b[tier] ?? 0;
    if (left < right) return -1;
    if (left > right) return 1;
  }
  return 0;
}

// --- heat ------------------------------------------------------------------
//
// Player kills in the last hour, expressed as jumps of detour the pilot would
// accept to go round. Heat sits in the primary tier rather than a tier of its
// own, deliberately: it trades against distance, because that is exactly what a
// pilot is doing when they route around a camp.
//
// Each doubling of kills adds one more step of detour. A system with one kill
// is not the same as a system with thirty, and the difference between thirty
// and thirty-one is nothing - which a linear term would get wrong in both
// directions.
//
// The weights are the pilot's choice and nothing here decides for them. They
// are jumps, and they are shown as jumps.
export const HEAT_LEVELS = { off: 0, cautious: 2, paranoid: 5 };
// A ceiling, so the worst system on the map is still a number a pilot can hold
// in their head rather than an effective wall. Not an arithmetic requirement -
// the tiers no longer need one.
export const MAX_HEAT_PENALTY = 64;

export function emptyHeat() {
  // `unweighed` carries *why* there is no weighting, because there are three
  // reasons and the panel could tell none of them apart: the pilot turned it off,
  // activity has never synced, or activity synced and only the kills half failed.
  // The third is the one that matters - `killsKnown` exists precisely to separate
  // it, and a panel saying "no activity data has been synced" beside a live bar
  // showing a fresh sync contradicts the tool itself.
  return { kills: new Map(), weight: 0, at: null, applied: false, unweighed: null };
}

// Heat must not be able to outrank the mode's own security preference.
//
// The penalty is denominated in jumps and added to the *mode-weighted* edge cost,
// where under "safer" a low-security jump costs 7 and a null-security one 26. So an
// unbounded penalty of 20 on a high-security system is cheaper than one low-security
// jump, and the router sends the pilot through low security to avoid it: measured over
// 393 high-security routes with a realistic gank corridor seeded on them, 269 came
// back *less* secure.
//
// That is the worst possible reading of the two settings, because a pilot who turns
// kill-avoidance up and asks for the safer route is doing both for the same reason.
// Being careful twice must not produce the least safe route.
//
// The ceiling is derived from the mode rather than written down, and only in the
// direction that can do harm. Given what the mode charges for each security band
// ordered safest first, the gaps that matter are the ones where dropping a band
// costs *more* - those are the ones heat could pay for. The ceiling is one less
// than the smallest of them, so heat can still reorder systems within a band and
// can never buy a jump out of one.
//
// Direction is the whole of it. Under "less-secure" the low-security jump is
// already the cheaper one, so heat has nothing to buy and keeps its full range;
// heat pushing that pilot back toward high security is not a surprise, it is
// just a safer route than they asked for. Under "shortest" nothing is charged
// for security at all, there is no gap to protect, and heat is unrestricted.
export function heatCeiling(costsSafestFirst) {
  let smallest = Infinity;
  for (let i = 1; i < costsSafestFirst.length; i += 1) {
    const premium = costsSafestFirst[i] - costsSafestFirst[i - 1];
    if (premium > 0) smallest = Math.min(smallest, premium);
  }
  if (!Number.isFinite(smallest)) return MAX_HEAT_PENALTY;
  return Math.max(0, Math.min(MAX_HEAT_PENALTY, Math.ceil(smallest) - 1));
}

export function heatPenalty(kills, weight) {
  if (!(weight > 0) || !(kills > 0)) return 0;
  return Math.min(MAX_HEAT_PENALTY, Math.ceil(weight * Math.log2(1 + kills)));
}

// An Ansiblex network, as this project can ever know one.
//
// Since the September 2026 update the access list is alliance-only: a pilot may
// traverse their own alliance's bridges and nobody else's. So there is exactly
// one network that matters to routing - yours - and no standings or per-bridge
// permission modelling is needed. Hostile bridges cannot be enumerated at all,
// which is why they appear in no route and in no threat picture.
//
// A bridge is a pair of systems. Both ends are anchored, and the link works in
// both directions, so it enters the graph as an undirected edge.
export function emptyBridges() {
  // `kinds` records what each edge actually is. Both an alliance bridge and a
  // wormhole are one undirected jump, so the graph treats them identically -
  // but a route must not call a collapsing wormhole a bridge. One is a
  // structure your alliance anchored; the other has hours to live and a mass
  // limit, and a pilot reads those differently.
  // `expiry` records when an edge stops existing, for the edges that do.
  //
  // An Ansiblex is there until somebody unanchors it; a wormhole has hours to live,
  // and `eve-scout.js` knows how many. Discarding that is fine for a button which
  // rebuilds the network on every click and wrong for anything that keeps one - a
  // network three hours old routes through a hole that collapsed two hours ago and
  // says "1 jump".
  //
  // Absent for an edge that does not expire. Absent is not "expired at 0".
  //
  // `named` is the keyed form of `names`. A bare array pushed in step with `kinds`
  // lets a dropped edge filter the count and the kinds and not the label, leaving a
  // name under a count of zero: zipping two collections by insertion order is a
  // positional coupling, so the label carries its key.
  return {
    links: new Map(), count: 0, names: [], named: new Map(), kinds: new Map(),
    expiry: new Map(), source: null, syncedAt: null,
  };
}

// Two networks as one. Alliance bridges and scanned wormholes are separate
// sources with separate lifetimes, and the router wants the union.
export function mergeBridges(...networks) {
  const merged = emptyBridges();
  const seen = new Set();
  // Edges that at least one network says are permanent.
  const permanent = new Set();
  for (const network of networks) {
    if (!network?.links) continue;
    for (const [from, tos] of network.links) {
      if (!merged.links.has(from)) merged.links.set(from, []);
      const into = merged.links.get(from);
      for (const to of tos) if (!into.includes(to)) into.push(to);
    }
    for (const [key, kind] of network.kinds ?? []) {
      if (!merged.kinds.has(key)) merged.kinds.set(key, kind);
      seen.add(key);
    }
    // The **earliest** expiry wins where two networks describe one edge. Two
    // reports of one hole disagreeing about when it dies is not a reason to
    // believe the longer one, and two different holes on the same endpoints
    // cannot be told apart from the endpoints - so the conservative reading is
    // the right one for both.
    for (const [key, at] of network.expiry ?? []) {
      if (!merged.expiry.has(key) || at < merged.expiry.get(key)) merged.expiry.set(key, at);
    }
    // But an edge carrying a link that does **not** expire is an edge that does not
    // expire. The graph keys an edge by its endpoints, so an Ansiblex and a wormhole
    // between the same two systems are one edge: applying the wormhole's expiry to the
    // pair means the hole's death takes the permanent bridge with it, turning a valid
    // one-jump route into eleven jumps by gate.
    for (const [key] of network.kinds ?? []) {
      if (!(network.expiry instanceof Map) || !network.expiry.has(key)) permanent.add(key);
    }
    for (const [key, label] of network.named ?? []) if (!merged.named.has(key)) merged.named.set(key, label);
    for (const name of network.names) if (!merged.names.includes(name)) merged.names.push(name);
  }
  // A permanent parallel link outlives every expiring one on the same edge,
  // and names it: an edge you can always take is a bridge whatever else shares
  // its endpoints.
  for (const key of permanent) {
    merged.expiry.delete(key);
    if (merged.kinds.get(key) === "wormhole") merged.kinds.set(key, "bridge");
  }
  merged.count = seen.size;
  return merged;
}

export function emptyLimits() {
  return { min: null, max: null };
}

// Limits are compared against the security a system displays, not its raw value,
// because the displayed number is what the pilot typed and what the map shows. So
// "minimum 0.5" and "high security only" name exactly the same set of systems.
export function displayedSecurity(security) {
  return Number(formatSecurity(security));
}

export class RoutePlanner {
  constructor(atlas) {
    this.atlas = atlas;
    this.systems = atlas.systems;
    this.byName = new Map();
    this.byRegionName = new Map();

    for (const system of Object.values(this.systems)) {
      this.byName.set(normalizeName(system.name), system);
    }
    for (const region of Object.values(atlas.regions)) {
      this.byRegionName.set(normalizeName(region.name), region);
    }

    // Precomputed once: the traversal predicate consults this per edge.
    this.displayed = new Map();
    for (const system of Object.values(this.systems)) {
      this.displayed.set(system.system_id, displayedSecurity(system.security));
    }
  }

  resolveLimits(minValue = "", maxValue = "") {
    // Limits are compared against displayed security, which has one decimal,
    // so a typed value must be moved onto that scale. Rounding to NEAREST
    // silently relaxed the constraint: a typed minimum of 0.44 became 0.4 and
    // admitted systems at 0.35. Each bound is therefore rounded in the
    // direction that never admits something the pilot excluded.
    const parse = (value, label, round) => {
      // Only text or a number is a security bound. An array stringifies to its
      // contents, so [0.5] would otherwise pass the numeric test below.
      if (value !== null && value !== undefined
        && typeof value !== "string" && typeof value !== "number") {
        throw new Error(`Security limits: ${label} is not a number.`);
      }
      const text = String(value ?? "").trim();
      if (!text) return null;
      if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(text)) {
        throw new Error(`Security limits: "${text}" is not a number.`);
      }
      const number = Number(text);
      if (!Number.isFinite(number)) throw new Error(`Security limits: "${text}" is not a number.`);
      if (number < -1 || number > 1) throw new Error(`Security limits: ${label} must be between -1.0 and 1.0.`);
      const scaled = round(number * 10) / 10;
      return Object.is(scaled, -0) ? 0 : scaled;
    };
    const min = parse(minValue, "the minimum", Math.ceil);
    const max = parse(maxValue, "the maximum", Math.floor);
    if (min !== null && max !== null && min > max) {
      throw new Error(`Security limits: minimum ${min.toFixed(1)} is above maximum ${max.toFixed(1)}.`);
    }
    return { min, max };
  }

  resolveFrom(index, value) {
    const query = normalizeName(value);
    if (!query) return null;
    if (index.has(query)) return index.get(query);

    const prefixMatches = [];
    for (const [name, record] of index) {
      if (name.startsWith(query)) prefixMatches.push(record);
      if (prefixMatches.length > 1) break;
    }
    return prefixMatches.length === 1 ? prefixMatches[0] : null;
  }

  resolveRegion(value) {
    return this.resolveFrom(this.byRegionName, value);
  }

  // An avoid list that quietly drops what it cannot resolve is worse than no
  // avoid list, because the route still looks like it honoured the request.
  // Every entry must resolve or the whole calculation refuses to run.
  resolveAvoid(systemsValue = "", regionsValue = "") {
    const avoid = emptyAvoid();

    for (const entry of splitList(systemsValue)) {
      const system = this.resolveSystem(entry);
      if (!system) throw new Error(`Avoid list: no single system matches "${entry}".`);
      if (!avoid.systemIds.has(system.system_id)) {
        avoid.systemIds.add(system.system_id);
        avoid.systemNames.push(system.name);
      }
    }
    for (const entry of splitList(regionsValue)) {
      const region = this.resolveRegion(entry);
      if (!region) throw new Error(`Avoid list: no single region matches "${entry}".`);
      if (!avoid.regionIds.has(region.region_id)) {
        avoid.regionIds.add(region.region_id);
        avoid.regionNames.push(region.name);
      }
    }
    return avoid;
  }

  isBlocked(systemId, avoid, limits) {
    const system = this.systems[systemId];
    if (!system) return true;
    if (avoid.systemIds.has(systemId) || avoid.regionIds.has(system.region_id)) return true;
    if (limits.min === null && limits.max === null) return false;
    const shown = this.displayed.get(systemId);
    return (limits.min !== null && shown < limits.min) || (limits.max !== null && shown > limits.max);
  }

  // Only ever called for endpoints and messages, so it may build a string.
  blockReason(systemId, avoid, limits) {
    const system = this.systems[systemId];
    if (!system) return "is not in the archive";
    if (avoid.systemIds.has(systemId)) return "is on the avoid list";
    if (avoid.regionIds.has(system.region_id)) return `is in ${this.atlas.regions[system.region_id].name}, which is on the avoid list`;
    const shown = this.displayed.get(systemId);
    if (limits.min !== null && shown < limits.min) return `shows security ${shown.toFixed(1)}, below the minimum of ${limits.min.toFixed(1)}`;
    if (limits.max !== null && shown > limits.max) return `shows security ${shown.toFixed(1)}, above the maximum of ${limits.max.toFixed(1)}`;
    return null;
  }

  resolveSystem(value) {
    return this.resolveFrom(this.byName, value);
  }

  // Turn a supplied list into an adjacency map, rejecting what cannot be used
  // rather than routing through something that does not exist.
  //
  // Entries may name systems or give ids, because the two likely producers
  // differ: a person editing a file writes names, and an ESI pull has ids.
  resolveBridges(entries, { strict = false, kind = "bridge" } = {}) {
    const bridges = emptyBridges();
    if (!Array.isArray(entries)) return bridges;

    const seen = new Set();
    for (const [index, entry] of entries.entries()) {
      const where = `bridge ${index + 1}`;
      const from = this.resolveBridgeEnd(entry?.from ?? entry?.[0]);
      const to = this.resolveBridgeEnd(entry?.to ?? entry?.[1]);
      if (!from || !to) {
        if (strict) throw new Error(`${where}: ${!from ? "origin" : "destination"} is not a known system.`);
        continue;
      }
      // A bridge to itself is not a link, and would otherwise sit in the graph
      // as a zero-cost self edge.
      if (from.system_id === to.system_id) {
        if (strict) throw new Error(`${where}: ${from.name} is bridged to itself.`);
        continue;
      }
      const key = from.system_id < to.system_id
        ? `${from.system_id}-${to.system_id}`
        : `${to.system_id}-${from.system_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      bridges.kinds.set(key, kind);
      // Carried when the caller knows it. `eve-scout.js` does; a pilot typing
      // an Ansiblex into the bridge box does not, and an Ansiblex does not
      // expire on a clock anyway.
      //
      // A **positive** test, not `Number.isFinite(Number(x))`. `Number(null)`,
      // `Number("")` and `Number(false)` are all 0, and 0 is finite - so three
      // spellings of "I do not know when this expires" recorded an expiry of
      // 1970 and killed the link at every clock, while `undefined` meant it
      // never expires. Two answers to one question, opposite ways round. This
      // module's own `idList` carries the same warning about system ids.
      const expiresAt = entry?.expiresAt;
      if (typeof expiresAt === "number" && Number.isFinite(expiresAt)) {
        bridges.expiry.set(key, expiresAt);
      }

      for (const [a, b] of [[from, to], [to, from]]) {
        if (!bridges.links.has(a.system_id)) bridges.links.set(a.system_id, []);
        bridges.links.get(a.system_id).push(b.system_id);
      }
      const label = `${from.name} - ${to.name}`;
      bridges.named.set(key, label);
      bridges.names.push(label);
    }
    bridges.count = seen.size;
    return bridges;
  }

  resolveBridgeEnd(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === "number" || /^\d+$/.test(String(value).trim())) {
      return this.systems[Number(String(value).trim())] ?? null;
    }
    return this.resolveSystem(value);
  }

  // `now` is passed in, not read from the clock.
  //
  // Every override carries an expiry, and the routing law is that a route uses only
  // what is currently confirmed - so when "now" is decides which instructions apply.
  // `overrides.js` takes time as an argument everywhere for the same reason, so expiry
  // can be tested without waiting a day for it, and expiry during routing is where it
  // matters most.
  calculate(fromValue, toValue, requestedMode = "shortest", avoid = emptyAvoid(), limits = emptyLimits(), bridges = emptyBridges(), overrides = createStore(), heat = emptyHeat(), now = Date.now()) {
    // A mode that is not one of the offered ones becomes the shortest route
    // rather than being carried through. A saved setting from an older version
    // is the way this happens: a select set to a value it has no option for
    // ends up empty, and the empty string reached the panel and rendered as the
    // heading "undefined".
    const mode = ROUTE_MODES.includes(requestedMode) ? requestedMode : DEFAULT_ROUTE_MODE;
    const origin = this.resolveSystem(fromValue);
    const destination = this.resolveSystem(toValue);

    if (!origin) throw new Error(`Origin system not found or ambiguous: ${fromValue || "(empty)"}`);
    if (!destination) throw new Error(`Destination system not found or ambiguous: ${toValue || "(empty)"}`);

    // Refuse a contradictory request rather than silently exempting an endpoint,
    // and say which constraint did the excluding.
    const originBlocked = this.blockReason(origin.system_id, avoid, limits);
    if (originBlocked) throw new Error(`Origin ${origin.name} ${originBlocked}.`);
    const destinationBlocked = this.blockReason(destination.system_id, avoid, limits);
    if (destinationBlocked) throw new Error(`Destination ${destination.name} ${destinationBlocked}.`);

    // A route from a system to itself is zero jumps. It crosses nothing, so no
    // security restriction can be violated by it, and refusing one would answer a
    // question that was not asked.
    if (origin.system_id === destination.system_id) {
      return this.describe([origin.system_id], mode, avoid, limits, [], bridges, [], [], heat, []);
    }

    // Said plainly and at once. Under a restriction rather than a weight, an
    // endpoint outside high security makes the request impossible however the
    // graph is searched, and the pilot is better told which end and what to ask
    // for instead than handed a bare "no route".
    if (mode === "high-sec-only") {
      const outside = [origin, destination].filter(outsideHighSec);
      if (outside.length) {
        const which = outside.length === 2 ? "Both ends are" : `${outside[0].name} is`;
        throw new Error(`${which} outside high security, so no high-security route can exist. `
          + `Use "safer" to get the least dangerous route instead.`);
      }
    }

    // What this mode actually charges, sampled from edgeCost itself so the
    // ceiling follows the weights rather than a copy of them. Safest band first.
    const ceiling = heatCeiling([1, 0.5, 0.2, -0.5]
      .map(security => this.edgeCost({ security }, mode)));

    const frontier = new MinHeap(compareCost);
    const distance = new Map([[origin.system_id, ZERO_COST]]);
    const previous = new Map();
    // How each system was reached, so the route can say which legs are bridges.
    const arrivedBy = new Map();
    frontier.push(origin.system_id, ZERO_COST);

    while (frontier.size) {
      const current = frontier.pop();
      if (current.id === destination.system_id) break;
      if (compareCost(current.priority, distance.get(current.id) ?? INFINITE_COST) !== 0) continue;

      // Gates first, then the alliance's bridges. A bridge is one jump like a
      // gate; the saving is in the gates it skips, not in costing less. Both
      // kinds are subject to the same avoid list and security limits, because
      // arriving somewhere by bridge does not make it somewhere you wanted to
      // go.
      const gateNeighbors = this.systems[current.id].neighbors;
      const bridgeNeighbors = bridges.links.get(current.id) ?? [];
      for (const [neighborId, kind] of [
        ...gateNeighbors.map(id => [id, "gate"]),
        ...bridgeNeighbors.map(id => [id, "bridge"]),
      ]) {
        const neighbor = this.systems[neighborId];
        if (!neighbor) continue;
        // The restriction, applied where it cannot be traded away.
        if (mode === "high-sec-only" && outsideHighSec(neighbor)) continue;
        if (this.isBlocked(neighborId, avoid, limits)) continue;
        // Hard entries are not links at all: an unanchored bridge or a gate
        // the pilot has written off. Whichever kind of edge this is, and
        // whatever sits at the far end of it.
        const link = edgeKey(current.id, neighborId);
        // What this leg is for reporting, which is finer than what it is for
        // traversal: a wormhole and a bridge are the same kind of edge to the
        // graph and different kinds of promise to a pilot.
        const legKind = kind === "bridge" ? (bridges.kinds.get(link) ?? "bridge") : kind;
        // `legKind`, not `kind`, and the same name the report uses. Checking one name
        // here and another there is how an ignored wormhole is crossed without being
        // named.
        if (isBlocked(overrides, legKind, link, now)) continue;
        if (isBlocked(overrides, "system", neighborId, now)) continue;
        if (isBlocked(overrides, "region", neighbor.region_id, now)) continue;

        const discouraged = isDiscouraged(overrides, legKind, link, now)
          || isDiscouraged(overrides, "system", neighborId, now)
          || isDiscouraged(overrides, "region", neighbor.region_id, now);
        const trust = Math.max(
          trustOf(overrides, legKind, link, { now }),
          trustOf(overrides, "system", neighborId, { now }),
        );
        const nextDistance = addCost(current.priority, [
          discouraged ? 1 : 0,
          this.edgeCost(neighbor, mode)
            + Math.min(ceiling, heatPenalty(heat.kills.get(neighborId) ?? 0, heat.weight)),
          TRUST.confirmed - trust,
        ]);
        if (compareCost(nextDistance, distance.get(neighborId) ?? INFINITE_COST) >= 0) continue;
        distance.set(neighborId, nextDistance);
        previous.set(neighborId, current.id);
        arrivedBy.set(neighborId, legKind);
        frontier.push(neighborId, nextDistance);
      }
    }

    if (!previous.has(destination.system_id)) {
      const listed = avoid.systemIds.size + avoid.regionIds.size;
      const bounds = [];
      if (limits.min !== null) bounds.push(`minimum ${limits.min.toFixed(1)}`);
      if (limits.max !== null) bounds.push(`maximum ${limits.max.toFixed(1)}`);
      const causes = [];
      if (listed) causes.push(`the ${listed} listed ${listed === 1 ? "entry" : "entries"}`);
      if (bounds.length) causes.push(`a security ${bounds.join(" and ")}`);
      // Say whether bridges were in play, or the message claims a stronger
      // negative than was actually tested.
      const network = bridges.count
        ? `no route connects ${origin.name} to ${destination.name}, over stargates or your ${bridges.count} bridge${bridges.count === 1 ? "" : "s"},`
        : `No standard stargate route connects ${origin.name} to ${destination.name}`;
      const opener = bridges.count ? network.charAt(0).toUpperCase() + network.slice(1) : network;
      if (mode === "high-sec-only") {
        // Worth the second search: "no high-security route" and "nowhere near
        // one" are different situations, and the pilot can act on the first.
        let alternative = null;
        try {
          alternative = this.calculate(fromValue, toValue, "safer", avoid, limits, bridges, overrides, heat, now);
        } catch { alternative = null; }
        const detail = alternative
          ? ` The safer route is ${alternative.jumps} jumps with ${alternative.belowHighSecurity.length} outside high security.`
          : "";
        throw new Error(`No high-security route connects ${origin.name} to ${destination.name}`
          + `${causes.length ? ` under ${causes.join(" and ")}` : ""}.${detail}`);
      }
      throw new Error(causes.length
        ? `${opener} under ${causes.join(" and ")}.`
        : `${opener}.`);
    }

    const systemIds = [destination.system_id];
    while (systemIds[0] !== origin.system_id) systemIds.unshift(previous.get(systemIds[0]));
    const legKinds = systemIds.slice(1).map(id => arrivedBy.get(id) ?? "gate");
    // A soft entry that had to be used is the one thing this mechanism must
    // never do quietly: the pilot asked to avoid it and the route went through
    // anyway, so the result carries the list and the caller warns.
    const enteredAnyway = systemIds
      .map(id => this.systems[id])
      .filter((system, index) => index > 0 && (
        isDiscouraged(overrides, "system", system.system_id, now)
        || isDiscouraged(overrides, "region", system.region_id, now)
      ));
    // Edges as well as systems. A soft-avoided gate or bridge the route had to use is
    // exactly as much of a surprise as a soft-avoided system, and reporting only the
    // systems lets a route cross a gate the pilot marked and say nothing at all.
    const edgesUsedAnyway = legKinds
      .map((kind, index) => {
        const from = systemIds[index];
        const to = systemIds[index + 1];
        const key = edgeKey(from, to);
        if (!isDiscouraged(overrides, kind, key, now)) return null;
        return {
          kind,
          key,
          from: this.systems[from],
          to: this.systems[to],
          reason: activeOverride(overrides, kind, key, now)?.reason ?? "",
        };
      })
      .filter(Boolean);
    // Hot systems the route crosses anyway, for the same reason soft avoids are
    // reported: the pilot asked to be routed around kills and there was no way
    // round, and a route that says nothing looks like a route that found none.
    const hotCrossed = systemIds
      .map(id => ({ system: this.systems[id], playerKills: heat.kills.get(id) ?? 0 }))
      .filter((entry, index) => index > 0 && entry.playerKills > 0)
      .sort((a, b) => b.playerKills - a.playerKills);
    const described = this.describe(systemIds, mode, avoid, limits, legKinds, bridges, enteredAnyway,
      edgesUsedAnyway, heat, hotCrossed);
    described.heatTradedSecurity = this.heatSecurityCost(described,
      { fromValue, toValue, requestedMode, avoid, limits, bridges, overrides, heat, now });
    return described;
  }

  // Heat and the security preference are weights in the same tier, and they
  // trade. That is not an accident - "safer" is documented and tested as a
  // preference that will take a low-security shortcut when the shortcut is
  // short enough, so a kill count denominated in jumps must be able to argue
  // with it. What must not happen is that it argues *silently*.
  //
  // A pilot who sets "safer" reads a security word, sets kill-avoidance for the
  // same reason, and has no way to know the two are priced in one currency. So
  // when weighting moved the route below high security, the route says so, and
  // says it as a measured difference against the same route unweighted rather
  // than as an inference. Nothing here estimates: if the comparison cannot be
  // made, the field is null and the panel says nothing.
  heatSecurityCost(route, { fromValue, toValue, requestedMode, avoid, limits, bridges, overrides, heat, now = Date.now() }) {
    if (!heat?.applied) return null;
    // **Every mode that did not ask for low security**, not just "safer".
    //
    // This was gated on "safer" alone, on the reasoning that the trade is only
    // a contradiction when the pilot has set a security word. But the default
    // mode is "shortest", and under it the weighting moves the route out of
    // high security at no cost in jumps and with nothing said: Hatakani to
    // Hykkota with a camp weighted is 10 jumps either way, and the weighted one
    // crosses Vecamia and Ahbazon at 0.4 while the plain one crosses nothing
    // below high security. A pilot who sets kill-avoidance in order to be safer
    // is handed a route through low security for it, and the panel stayed quiet
    // because `requestedMode` was "shortest".
    //
    // "less-secure" is the one mode that stays excluded, because there the dip
    // is the request rather than a trade. "high-sec-only" restricts where it
    // cannot be traded away, so `dips` is always zero and the next line returns
    // for it regardless.
    if (requestedMode === "less-secure") return null;
    const dips = route.belowHighSecurity?.length ?? 0;
    if (!dips) return null;
    // The same request with the weighting switched off. Deterministic, and the
    // only way to attribute the dip to heat rather than to the map.
    const unweighted = this.calculate(fromValue, toValue, requestedMode, avoid, limits, bridges,
      overrides, emptyHeat(), now);
    if (!unweighted?.systems?.length) return null;
    const without = unweighted.belowHighSecurity.length;
    if (dips <= without) return null;
    return { extra: dips - without, withHeat: dips, without, unweightedJumps: unweighted.jumps };
  }

  edgeCost(system, mode) {
    if (mode === "safer") {
      if (system.security <= 0) return 26;
      if (system.security < HIGH_SECURITY) return 7;
    }
    if (mode === "less-secure") {
      if (system.security >= HIGH_SECURITY) return 5;
      if (system.security > 0) return 1.5;
    }
    return 1;
  }

  describe(systemIds, mode, avoid = emptyAvoid(), limits = emptyLimits(), legKinds = [], bridges = emptyBridges(), avoidedAnyway = [], edgesUsedAnyway = [], heat = emptyHeat(), hotCrossed = []) {
    const systems = systemIds.map(id => this.systems[id]);
    const security = { high: 0, low: 0, null: 0 };
    const regions = [];

    for (const system of systems) {
      security[securityClass(system.security)] += 1;
      const regionName = this.atlas.regions[system.region_id].name;
      if (regions.at(-1) !== regionName) regions.push(regionName);
    }

    return {
      mode,
      avoid,
      limits,
      jumps: Math.max(0, systems.length - 1),
      // One entry per jump: "gate" or "bridge". A route that uses a bridge is
      // conditional on that bridge being online and fuelled, which no API
      // reports, so anything displaying this must say so rather than present
      // the route as certain.
      legKinds,
      bridgeJumps: legKinds.filter(kind => kind === "bridge").length,
      // Counted apart, because they expire and a bridge does not.
      wormholeJumps: legKinds.filter(kind => kind === "wormhole").length,
      bridgesAvailable: bridges.count,
      // Systems the pilot asked to avoid that the route enters regardless,
      // because there was no other way. Never empty silently.
      avoidedAnyway,
      // And the same for gates and bridges they marked soft.
      edgesUsedAnyway,
      // Whether kills were weighed at all, and at what strength. A route found
      // with no activity data must not look like one that found no kills, so
      // `applied` is false when nothing has been synced and the interface says
      // so rather than implying an all-clear.
      heat: {
        weight: heat.weight,
        applied: Boolean(heat.applied && heat.weight > 0),
        at: heat.at ?? null,
        // Carried through, or the panel is back to guessing which of three
        // states it is in from a single false boolean.
        unweighed: heat.unweighed ?? null,
      },
      // Systems with kills in them that the route enters regardless.
      hotCrossed,
      hotJumps: hotCrossed.length,
      // **The origin, separately.** `hotCrossed` starts at index 1 on purpose -
      // there is nothing to route *around* in the system you are already in -
      // but that made the panel's "no system on this route had a player kill" an
      // all-clear to a pilot sitting in a system with forty-two of them, with
      // that system rendered as step 00 two sections below.
      //
      // Carried rather than recomputed in the panel, because `route.heat` is the
      // weighting's own summary (`weight`, `applied`, `at`) and deliberately does
      // not include the kill map - so the panel had no way to ask.
      originKills: systemIds.length ? (heat.kills.get(systemIds[0]) ?? 0) : 0,
      origin: systems[0],
      destination: systems.at(-1),
      systems,
      security,
      regions,
      // Every system on the route below the high-security boundary.
      //
      // **Not a fallback warning.** `high-sec-only` is a hard exclusion: it refuses to
      // route rather than dipping, so under that mode this list is provably always
      // empty - measured empty across 91 routes. It is meaningful under every other
      // mode, where it says how much of the route is exposed, and cheap enough to
      // always compute.
      belowHighSecurity: systems.filter(system => system.security < HIGH_SECURITY),
      // Where there is an NPC station to dock at along the way. Zero is not
      // "nowhere to dock" - player structures are invisible to this archive -
      // so this is a list of places that definitely have one, never a claim
      // about the places that do not.
      withStation: systems.filter(system => (system.npc_stations ?? 0) > 0),
    };
  }
}

class MinHeap {
  // The comparator is the whole point: priorities here are cost tuples, not
  // numbers, and a heap that compared them with < would compare arrays as
  // strings and silently order them wrongly.
  constructor(compare = (a, b) => a - b) {
    this.items = [];
    this.compare = compare;
  }

  get size() {
    return this.items.length;
  }

  push(id, priority) {
    this.items.push({ id, priority });
    let index = this.items.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.compare(this.items[parent].priority, priority) <= 0) break;
      [this.items[parent], this.items[index]] = [this.items[index], this.items[parent]];
      index = parent;
    }
  }

  pop() {
    const first = this.items[0];
    const last = this.items.pop();
    if (this.items.length && last) {
      this.items[0] = last;
      let index = 0;
      while (true) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        if (left < this.items.length && this.compare(this.items[left].priority, this.items[smallest].priority) < 0) smallest = left;
        if (right < this.items.length && this.compare(this.items[right].priority, this.items[smallest].priority) < 0) smallest = right;
        if (smallest === index) break;
        [this.items[index], this.items[smallest]] = [this.items[smallest], this.items[index]];
        index = smallest;
      }
    }
    return first;
  }
}
