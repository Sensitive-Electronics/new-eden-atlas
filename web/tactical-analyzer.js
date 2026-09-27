// Offline tactical graph analysis: what is within N jumps of a system, how many
// ways in there are, and which systems the network cannot route around.
//
// Everything here is arithmetic over the archive - no API and no authentication -
// and everything it produces is a structural fact about stargates. Traffic, camps,
// bubbles and cynos are none of its business, which is why every brief carries a
// caveat saying so.

import { securityClass } from "./map-utils.js";

const DEFAULT_BLOCKS = {
  security: true,
  approaches: true,
  chokes: true,
  borders: true,
};

export const TACTICAL_PRESETS = {
  hunt: {
    label: "Hunt",
    depth: 4,
    blocks: { security: true, approaches: true, chokes: true, borders: true },
  },
  escape: {
    label: "Escape",
    depth: 5,
    blocks: { security: true, approaches: true, chokes: true, borders: true },
  },
  recon: {
    label: "Recon",
    depth: 3,
    blocks: { security: true, approaches: true, chokes: true, borders: true },
  },
};

const LEGACY_PRESETS = {
  fc: "hunt",
  roam: "hunt",
  logistics: "escape",
};

const plural = (value, word) => {
  const irregular = { "regional boundary": "regional boundaries" };
  return `${value} ${value === 1 ? word : irregular[word] ?? `${word}s`}`;
};

// The choke list is truncated, which means `chokes.length` is not the number of
// chokepoints in range - it is `min(CHOKE_LIMIT, actual)`. Anything that counts
// this set has to say so, or it reports a cap as a finding. Named rather than
// spelled at the slice so `snapshot.js` can carry the same number instead of a
// second copy of it.
export const CHOKE_LIMIT = 20;

// How many rows each brief carries.
//
// **The summary above the rows has to count the rows.** "8 inbound gates assigned
// for first-pass coverage" over five SCOUT items is three gates nobody is watching,
// stated as covered, and 80 systems have more than five gates. Named here because a
// count and a slice written three lines apart will disagree.
const BRIEF_ROWS = { escape: 3, recon: 5, hunt: 3 };

export function buildOperationalBrief(report, requestedMode = "hunt") {
  const mode = Object.hasOwn(TACTICAL_PRESETS, requestedMode) ? requestedMode : "hunt";
  // The approach list is every way in over standard gates, and it reads as
  // though it were every way in. It is not: an Ansiblex bridge or a cyno puts
  // hostiles in a system that appears nowhere on it. Naming that is the
  // difference between a list that is incomplete and a list that lies.
  const staticCaveat = "Standard gates only. Hostiles can arrive by Ansiblex bridge or cyno "
    + "from systems that are not on this list at all. Confirm traffic, camps, bubbles and "
    + "cynos with live scouts before committing.";

  if (mode === "escape") {
    const ranked = [...report.approaches]
      .map(vector => ({
        ...vector,
        score: vector.reachableSystems
          + vector.frontierSystems * 2
          + vector.regions.length * 6
          - vector.globalChokes * 12
          - vector.bridgeLinks * 8,
      }))
      .sort((a, b) => b.score - a.score
        || a.globalChokes - b.globalChokes
        || b.reachableSystems - a.reachableSystems
        || a.system.name.localeCompare(b.system.name));
    const labels = ["Primary exit", "Fallback exit", "Contingency"];
    return {
      mode,
      label: "Escape brief",
      summary: ranked.length > BRIEF_ROWS.escape
        ? `${BRIEF_ROWS.escape} of ${plural(ranked.length, "exit vector")} ranked by reach and structural risk`
        : `${plural(ranked.length, "exit vector")} ranked by reach and structural risk`,
      caveat: staticCaveat,
      items: ranked.slice(0, BRIEF_ROWS.escape).map((vector, index) => ({
        system: vector.system,
        tag: index === 0 ? "PRIMARY" : index === 1 ? "FALLBACK" : "CONTINGENCY",
        title: `${labels[index]} via ${vector.system.name}`,
        detail: `${plural(vector.reachableSystems, "system")} reachable across ${plural(vector.regions.length, "region")}; ${vector.globalChokes ? plural(vector.globalChokes, "network choke") : "no network chokes"} detected in branch.`,
      })),
    };
  }

  if (mode === "recon") {
    const ranked = [...report.approaches]
      .sort((a, b) => (b.regions.length * 8 + b.borderSystems * 4 + b.reachableSystems)
        - (a.regions.length * 8 + a.borderSystems * 4 + a.reachableSystems)
        || b.regions.length - a.regions.length
        || b.reachableSystems - a.reachableSystems
        || a.system.name.localeCompare(b.system.name));
    return {
      mode,
      label: "Recon brief",
      // The uncovered count is spelled out rather than left to subtraction: this
      // is the one brief whose rows are a *coverage* claim, and a gate with no
      // scout on it is the thing a pilot needs to see.
      summary: ranked.length > BRIEF_ROWS.recon
        ? `${BRIEF_ROWS.recon} of ${plural(ranked.length, "inbound gate")} assigned for first-pass `
          + `coverage; ${ranked.length - BRIEF_ROWS.recon} left uncovered`
        : `${plural(ranked.length, "inbound gate")} assigned for first-pass coverage`,
      caveat: staticCaveat,
      items: ranked.slice(0, BRIEF_ROWS.recon).map((vector, index) => ({
        system: vector.system,
        tag: `SCOUT ${index + 1}`,
        title: `Observe ${vector.system.name}`,
        detail: `Covers a branch of ${plural(vector.reachableSystems, "system")} in ${plural(vector.regions.length, "region")}; ${plural(vector.borderSystems, "regional boundary")} and ${plural(vector.globalChokes, "network choke")} inside the scan radius.`,
      })),
    };
  }

  // **Both sets, or the ranking is over a pool that cannot contain the winner.**
  // `report.chokes` holds local articulation points only, so a network cut vertex
  // that does not also cut this radius is not a candidate - while this sort puts
  // `global` first, which is sorting for something the pool cannot supply.
  const pooled = new Map();
  for (const entry of [...(report.networkChokes ?? []), ...report.chokes]) {
    if (!pooled.has(entry.system.system_id)) pooled.set(entry.system.system_id, entry);
  }
  const rankedChokes = [...pooled.values()]
    .sort((a, b) => Number(b.global) - Number(a.global)
      || b.betweenness - a.betweenness
      || a.jumps - b.jumps
      || a.system.name.localeCompare(b.system.name));
  const fallback = report.approaches.map((vector, index) => ({
    system: vector.system,
    jumps: 1,
    degree: vector.system.metrics?.degree ?? vector.system.neighbors.length,
    global: false,
    betweenness: vector.system.metrics?.betweenness ?? 0,
    fallback: true,
    index,
  }));
  const candidates = (rankedChokes.length ? rankedChokes : fallback).slice(0, BRIEF_ROWS.hunt);
  const labels = ["Primary catch", "Secondary catch", "Reserve position"];
  return {
    mode,
    label: "Hunt brief",
    // **Two different things, and only one of them is a ranking.** With no
    // chokepoint in the radius at all, `fallback` is the focus system's own gates in
    // the order they are listed, sorted by nothing. A pilot told a position is the
    // best of several acts differently from one told it is simply the way out.
    summary: rankedChokes.length
      ? `${plural(candidates.length, "interception point")} ranked by network control`
      : `${plural(candidates.length, "position")} on gates out of the focus - no chokepoint in this radius to rank`,
    caveat: staticCaveat,
    items: candidates.map((entry, index) => ({
      system: entry.system,
      tag: index === 0 ? "PRIMARY" : index === 1 ? "SECONDARY" : "RESERVE",
      title: `${labels[index]} at ${entry.system.name}`,
      detail: entry.fallback
        ? `Direct gate from focus; nothing inside this radius is harder for the network to route around.`
        : `${entry.global ? "Network" : "Local"} chokepoint ${plural(entry.jumps, "jump")} from focus with ${plural(entry.degree, "gate")}.`,
    })),
  };
}

export class TacticalAnalyzer {
  constructor(atlas) {
    this.atlas = atlas;
    this.systems = atlas.systems;
    this.byName = new Map(
      Object.values(this.systems).map(system => [system.name.toLowerCase(), system]),
    );
    // Bridge links, computed once at build time and carried in the archive.
    this.bridgeKeys = new Set(
      (atlas.jumps ?? [])
        .filter(jump => jump.bridge)
        .map(jump => `${Math.min(jump.from_system_id, jump.to_system_id)}-${Math.max(jump.from_system_id, jump.to_system_id)}`),
    );
  }

  resolveSystem(value) {
    const query = String(value ?? "").trim().toLowerCase();
    if (!query) return null;
    if (this.byName.has(query)) return this.byName.get(query);
    const matches = [];
    for (const [name, system] of this.byName) {
      if (name.startsWith(query)) matches.push(system);
      if (matches.length > 1) break;
    }
    return matches.length === 1 ? matches[0] : null;
  }

  analyze(systemValue, requestedDepth) {
    const focal = this.resolveSystem(systemValue);
    if (!focal) throw new Error(`System not found or ambiguous: ${systemValue || "(empty)"}`);
    const depth = Math.max(1, Math.min(10, Number(requestedDepth) || 3));
    const distances = this.breadthFirst(focal.system_id, depth);
    const localSystems = [...distances.keys()].map(id => this.systems[id]);
    const localIds = new Set(distances.keys());

    const security = { high: 0, low: 0, null: 0 };
    const regionNames = new Set();
    for (const system of localSystems) {
      security[securityClass(system.security)] += 1;
      regionNames.add(this.atlas.regions[system.region_id].name);
    }

    const borderSystems = localSystems
      .filter(system => system.neighbors.some(neighborId => this.systems[neighborId]?.region_id !== system.region_id))
      .sort((a, b) => distances.get(a.system_id) - distances.get(b.system_id) || a.name.localeCompare(b.name));

    const approaches = focal.neighbors
      .map(neighborId => this.describeApproach(focal.system_id, neighborId, depth))
      .sort((a, b) => b.reachableSystems - a.reachableSystems || a.system.name.localeCompare(b.system.name));

    // A local articulation point is a chokepoint for traffic inside this
    // radius. Whether it is also one for the network at large is a different
    // question, answered by the precomputed metrics, and the two are reported
    // separately rather than conflated. Ranking is by betweenness, so the
    // candidates that carry the most shortest paths come first.
    const ranked = this.articulationPoints(localIds)
      .map(id => this.systems[id])
      // The depth clause states the intended bound rather than changing a result: a
      // local articulation point is one whose removal splits the analysed subgraph,
      // and an outermost system only hangs off it, so removing it splits nothing.
      // Verified over 165 analyses across New Eden, none of which produced one at
      // the outer depth. Kept rather than relying on that argument holding for every
      // future traversal - and noted, because removing it changes no result that a
      // test could catch.
      .filter(system => system.system_id !== focal.system_id && distances.get(system.system_id) < depth)
      .map(system => ({
        system,
        jumps: distances.get(system.system_id),
        degree: system.metrics?.degree ?? system.neighbors.length,
        betweenness: system.metrics?.betweenness ?? 0,
        global: Boolean(system.metrics?.articulation),
      }))
      .sort((a, b) => b.betweenness - a.betweenness || a.jumps - b.jumps || a.system.name.localeCompare(b.system.name));
    // Whether anything was actually lost, which the length alone cannot say:
    // exactly twenty and more-than-twenty look identical from outside, so without
    // this a reader has to assume the worst and refuse every measurement over the
    // set.
    //
    // It is rare - 3 analyses in 690, sampled across New Eden at depths 3, 4 and 5 -
    // and worth carrying anyway, because the failure it removes is a *correct answer
    // being refused*, which is what teaches somebody the vocabulary is unreliable.
    const chokesTruncated = ranked.length > CHOKE_LIMIT;
    const chokes = ranked.slice(0, CHOKE_LIMIT);

    // **Network cut vertices in the radius, which the list above cannot hold.**
    //
    // `ranked` is built from *local* articulation points - systems whose loss cuts
    // this radius - each then labelled with whether it also cuts the network. A
    // system can be the second without being the first. The frontier is the clearest
    // case: the candidates above require `jumps < depth`, because local articulation
    // at the frontier is an artefact of where the search stopped rather than a fact
    // about the map.
    //
    // A system that genuinely cuts New Eden in two and sits at the edge of the
    // radius, or inside it without cutting it, is not an artefact - it comes from the
    // precomputed metrics over the whole graph. Measured over 3,951 analyses, 3 would
    // otherwise print "No system in this radius is one the network cannot route
    // around" with a real cut vertex standing in the radius.
    //
    // Carried as its own set rather than folded into `chokes`, which keeps that
    // list's invariants - no frontier, sorted by routes, the sort field `snapshot.js`
    // declares for it.
    const networkRanked = localSystems
      .filter(system => system.system_id !== focal.system_id && system.metrics?.articulation)
      .map(system => ({
        system,
        jumps: distances.get(system.system_id),
        degree: system.metrics?.degree ?? system.neighbors.length,
        betweenness: system.metrics?.betweenness ?? 0,
        global: true,
      }))
      .sort((a, b) => b.betweenness - a.betweenness || a.jumps - b.jumps
        || a.system.name.localeCompare(b.system.name));
    const networkChokesTruncated = networkRanked.length > CHOKE_LIMIT;
    const networkChokes = networkRanked.slice(0, CHOKE_LIMIT);

    // Sole links inside the radius: single stargate connections whose loss severs
    // the network. Not called bridges anywhere a pilot can read, because "bridge"
    // means Ansiblex to every EVE player and this archive contains no structures.
    const soleLinksInRange = [];
    for (const system of localSystems) {
      for (const neighborId of system.neighbors) {
        if (neighborId <= system.system_id || !localIds.has(neighborId)) continue;
        const neighbor = this.systems[neighborId];
        if (!neighbor) continue;
        if (this.bridgeKeys.has(`${system.system_id}-${neighborId}`)) {
          soleLinksInRange.push({
            from: system,
            to: neighbor,
            jumps: Math.min(distances.get(system.system_id), distances.get(neighborId)),
          });
        }
      }
    }
    soleLinksInRange.sort((a, b) => a.jumps - b.jumps || a.from.name.localeCompare(b.from.name));

    return {
      focal,
      depth,
      distances,
      systems: localSystems,
      systemCount: localSystems.length,
      frontierCount: localSystems.filter(system => distances.get(system.system_id) === depth).length,
      security,
      regionNames: [...regionNames].sort(),
      borderSystems,
      approaches,
      chokes,
      chokesTruncated,
      networkChokes,
      networkChokesTruncated,
      soleLinksInRange,
      generatedAt: new Date().toISOString(),
    };
  }

  breadthFirst(originId, maxDepth, blockedId = null) {
    const distances = new Map([[originId, 0]]);
    const queue = [originId];
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const currentId = queue[cursor];
      const distance = distances.get(currentId);
      if (distance >= maxDepth) continue;
      for (const neighborId of this.systems[currentId].neighbors) {
        if (neighborId === blockedId || distances.has(neighborId) || !this.systems[neighborId]) continue;
        distances.set(neighborId, distance + 1);
        queue.push(neighborId);
      }
    }
    return distances;
  }

  describeApproach(focalId, neighborId, depth) {
    const distances = this.breadthFirst(neighborId, depth - 1, focalId);
    const systems = [...distances.keys()].map(id => this.systems[id]);
    const ids = new Set(distances.keys());
    const regions = new Set(systems.map(system => this.atlas.regions[system.region_id].name));
    const security = { high: 0, low: 0, null: 0 };
    for (const system of systems) security[securityClass(system.security)] += 1;
    const borderSystems = systems.filter(system =>
      system.neighbors.some(id => this.systems[id]?.region_id !== system.region_id)).length;
    const globalChokes = systems.filter(system => system.metrics?.articulation).length;
    let bridgeLinks = 0;
    for (const system of systems) {
      for (const adjacentId of system.neighbors) {
        if (adjacentId <= system.system_id || !ids.has(adjacentId)) continue;
        if (this.bridgeKeys.has(`${system.system_id}-${adjacentId}`)) bridgeLinks += 1;
      }
    }
    return {
      system: this.systems[neighborId],
      reachableSystems: systems.length,
      frontierSystems: systems.filter(system => distances.get(system.system_id) === depth - 1).length,
      regions: [...regions].sort(),
      security,
      borderSystems,
      globalChokes,
      bridgeLinks,
    };
  }

  articulationPoints(localIds) {
    const discovery = new Map();
    const low = new Map();
    const parent = new Map();
    const points = new Set();
    let time = 0;

    const visit = id => {
      discovery.set(id, ++time);
      low.set(id, discovery.get(id));
      let children = 0;
      for (const neighborId of this.systems[id].neighbors) {
        if (!localIds.has(neighborId)) continue;
        if (!discovery.has(neighborId)) {
          children += 1;
          parent.set(neighborId, id);
          visit(neighborId);
          low.set(id, Math.min(low.get(id), low.get(neighborId)));
          if (!parent.has(id) && children > 1) points.add(id);
          if (parent.has(id) && low.get(neighborId) >= discovery.get(id)) points.add(id);
        } else if (neighborId !== parent.get(id)) {
          low.set(id, Math.min(low.get(id), discovery.get(neighborId)));
        }
      }
    };

    for (const id of localIds) if (!discovery.has(id)) visit(id);
    return [...points];
  }
}

export function normalizeTacticalConfig(value = {}) {
  // Own properties only. A truthiness test against a plain object also finds
  // inherited names, so a preset of "constructor" or "toString" is accepted, leaves
  // `base.depth` undefined, and persists `depth: NaN` into local storage. The
  // default parameter covers undefined but not null, hence the guard.
  const source = value && typeof value === "object" ? value : {};
  const requestedPreset = LEGACY_PRESETS[source.preset] ?? source.preset;
  const preset = Object.hasOwn(TACTICAL_PRESETS, requestedPreset) ? requestedPreset : "hunt";
  const base = TACTICAL_PRESETS[preset];
  const depth = Math.max(1, Math.min(10, Number(source.depth) || base.depth));
  const blocks = source.blocks && typeof source.blocks === "object" && !Array.isArray(source.blocks)
    ? source.blocks
    : {};
  return {
    version: 1,
    preset,
    depth: Number.isFinite(depth) ? depth : base.depth,
    // Only the known block names, so a string or stray key cannot splat index
    // properties into the stored configuration.
    blocks: Object.fromEntries(Object.keys(DEFAULT_BLOCKS).map(name => [
      name,
      Object.hasOwn(blocks, name) ? Boolean(blocks[name]) : Boolean({ ...DEFAULT_BLOCKS, ...base.blocks }[name]),
    ])),
  };
}
