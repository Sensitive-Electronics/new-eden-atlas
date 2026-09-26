// N-jump tactical analysis, checked against the topology rather than itself.
//
// One of the project's primary modules, and one the panel and render suites only touch
// incidentally - they exercise the markup around the answer rather than the answer.
//
// A mutation sweep makes the gap concrete: seven separate operator changes in this file
// leave the rest of the suite green, including both of the boundaries the
// tool is named for. `distance >= maxDepth` relaxed to `>` returns systems one
// jump further out than asked for and labels them as within range; the
// ambiguity guard `matches.length > 1` relaxed to `>= 1` resolves a prefix that
// matches three systems to whichever came first. The code is right in both
// cases. Nothing was checking that it stayed right.
//
// Every count here is recomputed from the adjacency in this file rather than
// recorded from a previous run, so these assertions cannot drift with the code
// they check.

import { readArchive, suite } from "./helpers.mjs";
import { TacticalAnalyzer } from "../web/tactical-analyzer.js";

export default function run() {
  const t = suite("tactical analyzer");
  const atlas = readArchive();
  const analyzer = new TacticalAnalyzer(atlas);

  // An independent breadth-first walk. Deliberately not the module's own, so a
  // change to its traversal shows up as a disagreement rather than as two
  // copies of the same mistake.
  const reachable = (startName, limit) => {
    const start = Object.values(atlas.systems).find(s => s.name === startName).system_id;
    const distance = new Map([[start, 0]]);
    const queue = [start];
    for (let i = 0; i < queue.length; i += 1) {
      const current = queue[i];
      const here = distance.get(current);
      if (here >= limit) continue;
      for (const neighbour of atlas.systems[String(current)].neighbors) {
        if (distance.has(neighbour) || !atlas.systems[String(neighbour)]) continue;
        distance.set(neighbour, here + 1);
        queue.push(neighbour);
      }
    }
    return distance;
  };

  // --- the depth boundary, which is the whole claim -------------------------------
  for (const depth of [1, 2, 3, 4]) {
    const report = analyzer.analyze("Jita", depth);
    const expected = reachable("Jita", depth);
    t.equal(report.systemCount, expected.size,
      `${depth} jumps from Jita reaches ${expected.size} systems`);
    t.equal(report.depth, depth, `and the report says which depth it answered (${depth})`);
    const hops = [...report.distances.values()];
    t.equal(Math.max(...hops), depth, `nothing further than ${depth} jumps is included`);
    t.check(!hops.some(h => h > depth), `and specifically no system at ${depth + 1}`);
  }

  // Asking for one more jump must actually reach further, or the parameter is
  // decorative and the assertions above would hold for any depth at all.
  const three = analyzer.analyze("Jita", 3);
  const four = analyzer.analyze("Jita", 4);
  t.check(four.systemCount > three.systemCount,
    `a deeper request reaches more systems (${three.systemCount} then ${four.systemCount})`);
  const atFour = [...four.distances.values()].filter(h => h === 4).length;
  t.check(atFour > 0, `and the extra ring is populated (${atFour} systems at exactly 4 jumps)`);

  // --- resolving a name -----------------------------------------------------------
  // The refusal matters more than the match. Analysis of the wrong system is
  // worse than no analysis, because it is delivered with the same confidence.
  const names = Object.values(atlas.systems).map(s => s.name.toLowerCase());
  const startingWith = prefix => names.filter(n => n.startsWith(prefix)).length;

  t.equal(analyzer.resolveSystem("Jita")?.name, "Jita", "an exact name resolves");
  t.equal(analyzer.resolveSystem("  jita  ")?.name, "Jita", "with surrounding space and any case");
  t.equal(startingWith("jit"), 1, "the prefix 'jit' is unique in New Eden");
  t.equal(analyzer.resolveSystem("Jit")?.name, "Jita", "so a unique prefix resolves");
  t.check(startingWith("tam") > 1, `the prefix 'tam' is not unique (${startingWith("tam")} systems)`);
  t.equal(analyzer.resolveSystem("Tam"), null,
    "an ambiguous prefix resolves to nothing rather than to whichever came first");
  t.equal(analyzer.resolveSystem("ZZZZZ"), null, "and an unknown name to nothing");
  t.equal(analyzer.resolveSystem(""), null, "an empty query is not a search");
  t.equal(analyzer.resolveSystem(null), null, "nor is nothing at all");

  t.throws(() => analyzer.analyze("Tam", 3), "ambiguous",
    "and analysis refuses an ambiguous name rather than analysing an arbitrary system");
  t.throws(() => analyzer.analyze("ZZZZZ", 3), "not found", "as it does an unknown one");

  // --- the findings agree with the archive ----------------------------------------
  const inRange = new Set(three.distances.keys());
  t.equal(three.security.high + three.security.low + three.security.null, three.systemCount,
    "every system in range is counted in exactly one security class");
  const recountedHigh = [...inRange].filter(id => atlas.systems[String(id)].security >= 0.45).length;
  t.equal(three.security.high, recountedHigh, "and the high-security count matches the archive");

  // The frontier is the outer ring of the walk - the systems at exactly the
  // depth asked for - and not "systems with a way out of the envelope". Those
  // are different sets and the difference is not small: at three jumps from
  // Jita the outer ring holds 36 systems, of which only 26 have a neighbour
  // that the walk never reached. The other ten sit at the edge of the analysis
  // with every neighbour already inside it.
  //
  // Both readings are defensible and the code is consistent about which it
  // means - the approach vectors apply the same rule to their own shorter walk.
  // It is recorded here because "N on frontier" reads like a count of ways in,
  // and it is a count of outermost systems.
  const outerRing = [...three.distances].filter(([, hops]) => hops === 3).map(([id]) => id);
  t.equal(three.frontierCount, outerRing.length,
    `the frontier is the outer ring of the walk (${outerRing.length} at exactly 3 jumps)`);
  const withAWayOut = outerRing.filter(id =>
    atlas.systems[String(id)].neighbors.some(n => !inRange.has(n) && atlas.systems[String(n)]));
  t.check(withAWayOut.length <= outerRing.length,
    `of which ${withAWayOut.length} actually lead somewhere the walk did not reach`);
  t.check(three.frontierCount < three.systemCount,
    "and the frontier is a subset, not the whole envelope");

  // Chokepoints must be inside the range, must not be the focal system, and
  // must be articulation points of it.
  t.check(three.chokes.length > 0, `chokepoints are found (${three.chokes.length})`);
  t.check(three.chokes.every(c => inRange.has(c.system.system_id)),
    "every chokepoint is inside the range it was computed for");
  t.check(three.chokes.every(c => c.system.system_id !== three.focal.system_id),
    "and none of them is the system being analysed, which is not a choke for itself");
  t.check(three.chokes.every(c => Number.isInteger(c.jumps) && c.jumps >= 0),
    "each carries how far away it is");
  // No chokepoint comes from the outer ring - but not because the filter that
  // says so does any work. It cannot: a *local* articulation point is one whose
  // removal splits the analysed subgraph, and an outermost system only hangs off
  // that subgraph, so removing it splits nothing. Checked across 165 analyses
  // spread over New Eden: not one produced a local articulation point at the
  // outer depth.
  //
  // Worth stating because the global `metrics.articulation` flag tells a
  // different story - nine systems exactly three jumps from Jita carry it - and
  // reading that as evidence the bound is load-bearing is the mistake this
  // comment exists to stop. Global articulation is about all of New Eden;
  // chokes here are about the neighbourhood being analysed.
  const localChokes = analyzer.articulationPoints(inRange);
  t.check(localChokes.length > 0, `the local subgraph has articulation points (${localChokes.length})`);
  t.check(localChokes.every(id => three.distances.get(id) < 3),
    "none of which lies on the outer ring, by the structure of the problem rather than by a filter");
  t.check(three.chokes.every(c => c.jumps < 3), "so no chokepoint is reported from the outer ring");

  // Every region named must actually be represented by a system in range.
  const regionsInRange = new Set([...inRange].map(id => atlas.regions[String(atlas.systems[String(id)].region_id)].name));
  t.equal([...three.regionNames].sort().join(","), [...regionsInRange].sort().join(","),
    "the regions named are exactly those with a system in range");

  // --- a system with no gates at all ----------------------------------------------
  // Thera has none, so every count is zero and nothing may throw on the way.
  const thera = analyzer.analyze("Thera", 3);
  t.equal(thera.systemCount, 1, "a system on no stargate reaches only itself");
  t.equal(thera.frontierCount, 0, "has no frontier");
  t.equal(thera.chokes.length, 0, "and no chokepoints, rather than throwing");

  return t.results;
}
