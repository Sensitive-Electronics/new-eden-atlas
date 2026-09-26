import fs from "node:fs";
import path from "node:path";
import {
  SYSTEM_NODE_HEIGHT, assignCrossingChannels, assignLaneOffsets, fanHalfSpan,
  isHorizontalRun, orthogonalSegments, segmentsIntersect, slotOffset,
} from "../web/edge-routing.js";
import { orthogonalPath, project, relaxSystems } from "../web/map-utils.js";
import { readArchive, readRegion, suite, ROOT } from "./helpers.mjs";

const edge = (from, to) => ({ from_system_id: from, to_system_id: to });

export default function run() {
  const t = suite("edge routing");

  const horizontal = orthogonalSegments({ x: 0, y: 0 }, { x: 10, y: 0 });
  const vertical = orthogonalSegments({ x: 5, y: -5 }, { x: 5, y: 5 });
  t.equal(horizontal.length, 3, "an orthogonal gate path exposes its three segments");
  t.check(horizontal.some(a => vertical.some(b => segmentsIntersect(a, b))),
    "perpendicular gate paths detect a visual crossing");

  const crossing = [edge(1, 2), edge(3, 4)];
  const crossingPoints = new Map([
    [crossing[0], [{ x: 0, y: 0 }, { x: 10, y: 0 }]],
    [crossing[1], [{ x: 5, y: -5 }, { x: 5, y: 5 }]],
  ]);
  const colored = assignCrossingChannels(crossing, item => crossingPoints.get(item));
  t.equal(colored.crossingPairs, 1, "unrelated crossing links form one color conflict");
  t.check(colored.channels.get(crossing[0]) !== colored.channels.get(crossing[1]),
    "unrelated crossing links receive different channels");

  const connected = [edge(1, 2), edge(2, 3)];
  const connectedPoints = new Map([
    [connected[0], [{ x: 0, y: 0 }, { x: 10, y: 0 }]],
    [connected[1], [{ x: 5, y: -5 }, { x: 5, y: 5 }]],
  ]);
  const joined = assignCrossingChannels(connected, item => connectedPoints.get(item));
  t.equal(joined.crossingPairs, 0, "links sharing a system are a junction, not a crossing conflict");

  const atlas = readArchive();
  let maximumChannels = 0;
  let crossingPairs = 0;
  // Counted rather than asserted away: with eight readable colours the densest
  // region cannot separate every crossing, so the figure is measured and
  // bounded instead of being claimed to be zero.
  let sharedColourPairs = 0;
  let reportedCompromises = 0;
  const compromisedRegions = [];
  for (const regionRecord of Object.values(atlas.regions)) {
    const region = readRegion(regionRecord.name);
    const systems = Object.values(region.systems);
    if (!systems.length || !region.jumps.length) continue;
    const positions = relaxSystems(systems, project(systems, system =>
      [system.position[0], -system.position[2]], 1200, 760, 45));
    const analysis = assignCrossingChannels(region.jumps, jump => [
      positions.get(region.systems[jump.from_system_id]),
      positions.get(region.systems[jump.to_system_id]),
    ]);
    maximumChannels = Math.max(maximumChannels, analysis.channelCount);
    crossingPairs += analysis.crossingPairs;
    reportedCompromises += analysis.compromises;

    let shared = 0;
    analysis.conflicts.forEach((entries, index) => {
      for (const other of entries) {
        if (other <= index) continue;
        if (analysis.channels.get(region.jumps[index]) === analysis.channels.get(region.jumps[other])) shared += 1;
      }
    });
    sharedColourPairs += shared;
    if (shared) compromisedRegions.push(`${regionRecord.name}: ${shared}`);
  }
  t.check(crossingPairs > 0, `${crossingPairs} unrelated crossing pairs exist in the real regional layouts`);

  // Every channel must exist in the stylesheet. Wrapping the number instead
  // would hand two crossing lines the same colour with nothing to show for it.
  t.check(maximumChannels <= 8, `every channel is inside the eight-colour palette (highest ${maximumChannels})`);
  const css = fs.readFileSync(path.join(ROOT, "web", "map-edges.css"), "utf8");
  for (let channel = 0; channel < maximumChannels; channel += 1) {
    t.check(css.includes(`.gate-edge-${channel}`), `the stylesheet defines channel ${channel}`);
  }

  // Colour separation is the reinforcement; the casing is the guarantee. Eight
  // readable colours cannot separate every crossing in the densest region, so
  // the claim is bounded and measured rather than absolute.
  t.check(reportedCompromises > 0 === sharedColourPairs > 0,
    "the allocator's own compromise count agrees with the colours it actually assigned");
  t.check(sharedColourPairs <= 40,
    `at most a handful of crossings anywhere share a colour (${sharedColourPairs} of ${crossingPairs})`);
  t.check(compromisedRegions.length <= 1,
    `and they are confined to a single dense region (${compromisedRegions.join("; ") || "none"})`);
  t.check(sharedColourPairs / crossingPairs < 0.02,
    `under two percent of all crossings share a colour (${(100 * sharedColourPairs / crossingPairs).toFixed(2)}%)`);

  // --- lanes -------------------------------------------------------------------
  //
  // Colour separates two lines that cross. It cannot separate two that overlap,
  // because the one underneath is covered pixel for pixel and there is nothing
  // left to colour. That is most of the problem rather than a corner of it: on
  // the shipped layouts, 98% of covered line is the legs attached to the nodes,
  // where several links leave a system along the same axis and stack exactly.
  t.equal(slotOffset(0, 5), 0, "the first link in a lane does not move at all");
  t.equal(slotOffset(1, 5), 5, "the second opens to one side");
  t.equal(slotOffset(2, 5), -5, "the third to the other, so the mesh stays on its grid");
  t.equal(slotOffset(3, 5), 10, "and they spiral outward evenly");
  t.equal(slotOffset(4, 5), -10, "in both directions");

  const lane = [edge(1, 2), edge(3, 4), edge(5, 6)];
  const lanePoints = new Map([
    // Two links along the same horizontal line, overlapping.
    [lane[0], [{ x: 0, y: 0 }, { x: 100, y: 0 }]],
    [lane[1], [{ x: 50, y: 0 }, { x: 150, y: 0 }]],
    // And one further along it that touches neither.
    [lane[2], [{ x: 400, y: 0 }, { x: 500, y: 0 }]],
  ]);
  const assigned = assignLaneOffsets(lane, e => lanePoints.get(e), { spacing: 5 });
  t.equal(assigned.pairs, 1, "one overlapping pair is found");
  t.check(assigned.offsets.get(lane[0]) !== assigned.offsets.get(lane[1]),
    "and the two are moved apart");
  t.equal(assigned.offsets.get(lane[2]), 0,
    "while a link that overlaps nothing is left exactly where the layout put it");
  t.equal(assigned.crowded, 0, "with no lane running out of room");

  // More links in one lane than there are slots. They cannot all be separated,
  // so the extras take the centre rather than wandering ever further from the
  // layout - and the count is returned so that it can be seen rather than
  // discovered by looking at a crowded map.
  const crowd = Array.from({ length: 9 }, (_, i) => edge(i * 2, i * 2 + 1));
  const crowdPoints = new Map(crowd.map(e => [e, [{ x: 0, y: 0 }, { x: 100, y: 0 }]]));
  const packed = assignLaneOffsets(crowd, e => crowdPoints.get(e), { spacing: 5, maxSlots: 6 });
  t.equal(packed.crowded, 3, "nine links in a six-slot lane leave three without a slot");
  t.check([...packed.offsets.values()].filter(offset => offset === 0).length === 4,
    "which sit on the centre line with the first, rather than drifting off the layout");
  t.equal(new Set(packed.offsets.values()).size, 6, "and the six slots are all used");

  // The rendering path, not a reimplementation of it. Measuring the geometry
  // with a local copy of the shift left the real one untested, and a mutation
  // that dropped the offset from orthogonalPath entirely went unnoticed.
  const straight = orthogonalPath({ x: 0, y: 0 }, { x: 100, y: 0 });
  const nudged = orthogonalPath({ x: 0, y: 0 }, { x: 100, y: 0 }, 5);
  t.check(straight !== nudged, "an offset changes the path that is drawn");
  t.check(/M0,5/.test(nudged), "a horizontal link is shifted perpendicular, in y");
  t.check(/M0,0/.test(straight), "and an unoffset one is not shifted at all");
  const upright = orthogonalPath({ x: 0, y: 0 }, { x: 0, y: 100 }, 5);
  t.check(/M5,0/.test(upright), "a vertical link is shifted in x instead");
  t.equal(orthogonalPath({ x: 0, y: 0 }, { x: 100, y: 0 }, 0), straight,
    "and a zero offset is exactly the unoffset path");

  const clear = assignLaneOffsets([edge(1, 2)], () => [{ x: 0, y: 0 }, { x: 10, y: 0 }]);
  t.equal(clear.pairs, 0, "a lone link has no conflicts");
  t.equal(clear.offsets.get(clear.offsets.keys().next().value), 0, "and is not moved");

  // The measurement that matters, on the real layouts. This is a ratchet: the
  // numbers are what the shipped geometry produces today, and they may only
  // improve.
  const shift = (segment, offset, isHorizontal) => isHorizontal
    ? { from: { x: segment.from.x, y: segment.from.y + offset }, to: { x: segment.to.x, y: segment.to.y + offset } }
    : { from: { x: segment.from.x + offset, y: segment.from.y }, to: { x: segment.to.x + offset, y: segment.to.y } };
  const isHoriz = seg => Math.abs(seg.from.y - seg.to.y) <= 1e-7;
  const coveredPixels = segments => {
    let total = 0;
    for (let i = 0; i < segments.length; i += 1) {
      for (let k = i + 1; k < segments.length; k += 1) {
        const [a, b] = [segments[i], segments[k]];
        if (isHoriz(a) !== isHoriz(b)) continue;
        const sameLine = isHoriz(a) ? Math.abs(a.from.y - b.from.y) <= 0.5 : Math.abs(a.from.x - b.from.x) <= 0.5;
        if (!sameLine) continue;
        const [a1, a2] = isHoriz(a) ? [a.from.x, a.to.x] : [a.from.y, a.to.y];
        const [b1, b2] = isHoriz(b) ? [b.from.x, b.to.x] : [b.from.y, b.to.y];
        const over = Math.min(Math.max(a1, a2), Math.max(b1, b2)) - Math.max(Math.min(a1, a2), Math.min(b1, b2));
        if (over > 1) total += over;
      }
    }
    return total;
  };

  for (const [name, ceiling] of [["Domain", 0.05], ["The Forge", 0.12], ["Heimatar", 0.10]]) {
    const region = readRegion(name);
    const members = Object.values(region.systems);
    const xs = members.map(system => system.position_2d?.[0] ?? system.position[0]);
    const ys = members.map(system => system.position_2d?.[1] ?? -system.position[2]);
    const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const at = new Map();
    members.forEach((system, index) => at.set(system.system_id, {
      x: 60 + 1080 * ((xs[index] - minX) / (maxX - minX || 1)),
      y: 60 + 640 * ((ys[index] - minY) / (maxY - minY || 1)),
    }));
    const links = region.jumps.filter(jump => at.has(jump.from_system_id) && at.has(jump.to_system_id));
    const pair = jump => [at.get(jump.from_system_id), at.get(jump.to_system_id)];

    const before = [];
    const after = [];
    const lanes = assignLaneOffsets(links, pair);
    for (const jump of links) {
      const [from, to] = pair(jump);
      const horizontalPath = Math.abs(from.x - to.x) >= Math.abs(from.y - to.y);
      const offset = lanes.offsets.get(jump) ?? 0;
      for (const segment of orthogonalSegments(from, to)) {
        if (Math.abs(segment.from.x - segment.to.x) + Math.abs(segment.from.y - segment.to.y) <= 0.5) continue;
        before.push(segment);
        after.push(shift(segment, offset, horizontalPath));
      }
    }
    const was = coveredPixels(before);
    const now = coveredPixels(after);
    t.check(was > 500, `${name} really does cover ${was.toFixed(0)}px of line before lanes are assigned`);
    t.check(now <= was * ceiling,
      `${name} recovers it: ${was.toFixed(0)}px covered becomes ${now.toFixed(0)}px (ceiling ${(ceiling * 100).toFixed(0)}%)`);
    t.equal(lanes.crowded, 0, `${name} never runs out of lanes`);
  }

  // --- the fan has to fit inside the node it connects to -------------------------
  // A lane offset moves a link's endpoints, not just its elbow, so an offset of
  // half the capsule height or more leaves the line finishing outside the node.
  // The fan reached 15px against a 16px half-height - one pixel of margin - and
  // nothing connected the two numbers, so the obvious response to "links still
  // overlap" (widen the fan) silently detaches every offset line on the map.
  t.equal(SYSTEM_NODE_HEIGHT, 32, "the system capsule is 32px tall");
  t.check(fanHalfSpan(6, 5) < SYSTEM_NODE_HEIGHT / 2,
    `the shipped fan fits inside it (${fanHalfSpan(6, 5)}px against ${SYSTEM_NODE_HEIGHT / 2}px)`);
  t.equal(fanHalfSpan(8, 4), SYSTEM_NODE_HEIGHT / 2,
    "while the first widening anyone would reach for lands exactly on the boundary");
  t.check(fanHalfSpan(6, 6) > SYSTEM_NODE_HEIGHT / 2, "and a wider spacing passes it");
  t.equal(fanHalfSpan(1, 5), 0, "a single lane never moves anything");

  // --- the placement is checked against what it draws -----------------------------
  // The conflict graph was built once on the un-offset geometry and the result
  // was never looked at. Offsets translate whole paths, so separating two links
  // can slide one onto a third that was in conflict with neither. Across the 67
  // drawn regions that made 114 overlaps in places the layout had right.
  const line = (x1, y1, x2, y2) => ({ from: { x: x1, y: y1 }, to: { x: x2, y: y2 } });
  const pairOf = e => [e.from, e.to];

  // Three horizontal runs: two on the same line, one 5px below. Separating the
  // first two by +/-5px pushes one of them exactly onto the third.
  const trap = [
    { from: { x: 0, y: 100 }, to: { x: 200, y: 100 } },
    { from: { x: 0, y: 100 }, to: { x: 200, y: 100 } },
    { from: { x: 0, y: 105 }, to: { x: 200, y: 105 } },
  ];
  const placed = assignLaneOffsets(trap, pairOf, { spacing: 5, maxSlots: 6 });
  const seen = trap.map(e => placed.offsets.get(e));
  t.equal(new Set(seen.map((off, i) => (trap[i].from.y + off))).size, 3,
    `three runs end up on three distinct lines (${seen.join(", ")})`);
  t.equal(placed.residual, 0, "and the result reports nothing still drawn over itself");
  t.check(placed.passes > 1, `which took more than the single pass that missed it (${placed.passes})`);

  // An edge in no conflict at all must still never move.
  const alone = [line(0, 0, 100, 0), line(0, 500, 100, 500)];
  const quiet = assignLaneOffsets(alone, pairOf);
  t.equal(quiet.offsets.get(alone[0]), 0, "an unconflicted link stays where the layout put it");
  t.equal(quiet.offsets.get(alone[1]), 0, "both of them");
  t.equal(quiet.residual, 0, "with nothing left over");
  t.equal(quiet.passes, 1, "and it settles in one pass, because there was nothing to learn");

  // --- the orientation branches of segmentsIntersect ----------------------------
  // It takes three paths depending on whether the two segments are
  // perpendicular, both horizontal, or both vertical. A mutation sweep inverted
  // the test that chooses between them and the whole suite stayed green: the
  // crossing colours are computed from real region layouts, where enough pairs
  // cross by either reading that the channel counts come out similar and no
  // assertion looks at an individual pair.
  //
  // Each case below is one shape, with the answer worked out by hand.
  const seg = (x1, y1, x2, y2) => ({ from: { x: x1, y: y1 }, to: { x: x2, y: y2 } });
  const shapes = [
    ["a horizontal and a vertical that cross", seg(0, 10, 20, 10), seg(10, 0, 10, 20), true],
    ["the same pair moved apart", seg(0, 10, 20, 10), seg(50, 0, 50, 20), false],
    ["a T-junction, touching at one end", seg(0, 10, 20, 10), seg(10, 10, 10, 20), true],
    ["a vertical that stops short", seg(0, 10, 20, 10), seg(10, 12, 10, 20), false],
    ["two horizontals on the same line, overlapping", seg(0, 10, 20, 10), seg(10, 10, 30, 10), true],
    ["two horizontals on the same line, apart", seg(0, 10, 5, 10), seg(10, 10, 30, 10), false],
    ["two horizontals on different lines", seg(0, 10, 20, 10), seg(0, 12, 20, 12), false],
    ["two verticals on the same line, overlapping", seg(5, 0, 5, 20), seg(5, 10, 5, 30), true],
    ["two verticals on the same line, apart", seg(5, 0, 5, 5), seg(5, 10, 5, 30), false],
    ["two verticals on different lines", seg(5, 0, 5, 20), seg(7, 0, 7, 20), false],
    ["touching end to end along one line", seg(0, 10, 10, 10), seg(10, 10, 20, 10), true],
  ];
  for (const [name, a, b, expected] of shapes) {
    t.equal(segmentsIntersect(a, b), expected, name);
    // The relation is symmetric; the branch that picks an orientation must not
    // depend on which segment was handed in first.
    t.equal(segmentsIntersect(b, a), expected, `${name}, with the arguments swapped`);
  }

  // --- three places decide "is this run horizontal", and they must agree --------
  // isHorizontalRun says so in its own comment: orthogonalPath decides the same
  // way, and if the two disagree the offset is computed against a shape that is
  // never drawn. orthogonalSegments makes the same choice a third time, for the
  // conflict graph.
  //
  // The tie - where the run is exactly as wide as it is tall - is where the
  // three could diverge, and it is the one case real coordinates never produce,
  // so nothing exercised it. A sweep confirmed as much: changing the comparison
  // in one of them left the suite green.
  const runs = [
    ["wider than tall", { x: 0, y: 0 }, { x: 20, y: 5 }],
    ["taller than wide", { x: 0, y: 0 }, { x: 5, y: 20 }],
    ["exactly square", { x: 0, y: 0 }, { x: 10, y: 10 }],
    ["square, negative", { x: 10, y: 10 }, { x: 0, y: 0 }],
    ["square, mixed signs", { x: 0, y: 10 }, { x: 10, y: 0 }],
    ["degenerate", { x: 5, y: 5 }, { x: 5, y: 5 }],
  ];
  for (const [name, from, to] of runs) {
    const saysHorizontal = isHorizontalRun(from, to);
    // orthogonalSegments: the first leg of a horizontal run is horizontal.
    const firstLeg = orthogonalSegments(from, to)[0];
    const legIsHorizontal = Math.abs(firstLeg.from.y - firstLeg.to.y) <= 1e-9;
    // orthogonalPath: a horizontal run takes its offset on y, a vertical on x.
    const shifted = orthogonalPath(from, to, 7);
    const plain = orthogonalPath(from, to, 0);
    const movedY = shifted !== plain && shifted.startsWith(`M${from.x},`);
    t.equal(legIsHorizontal, saysHorizontal,
      `${name}: orthogonalSegments and isHorizontalRun choose the same axis`);
    if (from.x !== to.x || from.y !== to.y) {
      t.equal(movedY, saysHorizontal,
        `${name}: orthogonalPath offsets along the axis the other two chose`);
    }
  }

  return t.results;
}
