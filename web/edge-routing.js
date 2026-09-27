// Cartographic treatment for orthogonal gate links on regional maps.
//
// Two links that cross on the drawing are not necessarily connected in the
// universe graph. This module builds a conflict graph for unrelated crossing
// paths and colors that graph so the crossing remains visually unambiguous.

const EPSILON = 1e-7;

export function orthogonalSegments(from, to) {
  const horizontal = Math.abs(from.x - to.x) >= Math.abs(from.y - to.y);
  const points = horizontal
    ? [from, { x: (from.x + to.x) / 2, y: from.y }, { x: (from.x + to.x) / 2, y: to.y }, to]
    : [from, { x: from.x, y: (from.y + to.y) / 2 }, { x: to.x, y: (from.y + to.y) / 2 }, to];
  return points.slice(1).map((point, index) => ({ from: points[index], to: point }));
}

function between(value, a, b) {
  return value >= Math.min(a, b) - EPSILON && value <= Math.max(a, b) + EPSILON;
}

function overlaps(a1, a2, b1, b2) {
  return Math.max(Math.min(a1, a2), Math.min(b1, b2))
    <= Math.min(Math.max(a1, a2), Math.max(b1, b2)) + EPSILON;
}

export function segmentsIntersect(a, b) {
  const aHorizontal = Math.abs(a.from.y - a.to.y) <= EPSILON;
  const bHorizontal = Math.abs(b.from.y - b.to.y) <= EPSILON;
  if (aHorizontal !== bHorizontal) {
    const horizontal = aHorizontal ? a : b;
    const vertical = aHorizontal ? b : a;
    return between(vertical.from.x, horizontal.from.x, horizontal.to.x)
      && between(horizontal.from.y, vertical.from.y, vertical.to.y);
  }
  if (aHorizontal) {
    return Math.abs(a.from.y - b.from.y) <= EPSILON
      && overlaps(a.from.x, a.to.x, b.from.x, b.to.x);
  }
  return Math.abs(a.from.x - b.from.x) <= EPSILON
    && overlaps(a.from.y, a.to.y, b.from.y, b.to.y);
}

function sharesEndpoint(a, b) {
  return a.from_system_id === b.from_system_id
    || a.from_system_id === b.to_system_id
    || a.to_system_id === b.from_system_id
    || a.to_system_id === b.to_system_id;
}

// The palette is deliberately small. Eight muted colours are about as many as stay
// distinguishable on a dark map, and 66 of the 67 drawn regions need seven or fewer;
// Domain alone wants eleven, at 260 gates and 2,112 crossing pairs.
//
// **Never by wrapping the channel number**, which gives two crossing lines the same
// colour silently. The allocator is told the palette size, reuses the
// least-conflicting colour when it runs out, and reports how often it had to. The
// dark casing still separates those crossings.
export function assignCrossingChannels(edges, pointPair, options = {}) {
  const { paletteSize = 8 } = options;
  const paths = edges.map(edge => {
    const [from, to] = pointPair(edge);
    return orthogonalSegments(from, to);
  });
  const conflicts = edges.map(() => new Set());

  for (let left = 0; left < edges.length; left += 1) {
    for (let right = left + 1; right < edges.length; right += 1) {
      if (sharesEndpoint(edges[left], edges[right])) continue;
      if (!paths[left].some(a => paths[right].some(b => segmentsIntersect(a, b)))) continue;
      conflicts[left].add(right);
      conflicts[right].add(left);
    }
  }

  // Most-conflicted first, ties by index, so the result is deterministic.
  const order = edges.map((_, index) => index)
    .sort((a, b) => conflicts[b].size - conflicts[a].size || a - b);
  const channelByIndex = new Array(edges.length).fill(0);
  const assigned = new Set();
  let compromises = 0;

  for (const index of order) {
    const taken = [...conflicts[index]].filter(other => assigned.has(other));
    const blocked = new Set(taken.map(other => channelByIndex[other]));

    let channel = 0;
    while (channel < paletteSize && blocked.has(channel)) channel += 1;

    if (channel >= paletteSize) {
      // Out of colours. Reuse whichever is worn by the fewest of this edge's
      // crossings, so a repeat is as far from confusing as it can be, and
      // count it rather than hiding it behind a modulo.
      const usage = new Array(paletteSize).fill(0);
      for (const other of taken) usage[channelByIndex[other] % paletteSize] += 1;
      channel = usage.indexOf(Math.min(...usage));
      compromises += usage[channel];
    }

    channelByIndex[index] = channel;
    assigned.add(index);
  }

  let highest = 0;
  for (const channel of channelByIndex) if (channel > highest) highest = channel;

  return {
    channels: new Map(edges.map((edge, index) => [edge, channelByIndex[index]])),
    conflicts,
    crossingPairs: conflicts.reduce((sum, entries) => sum + entries.size, 0) / 2,
    channelCount: channelByIndex.length ? highest + 1 : 0,
    paletteSize,
    // Crossing pairs that ended up sharing a colour. Zero in every region but
    // Domain; those are separated by the casing alone.
    compromises,
  };
}

// --- lane offsets ---------------------------------------------------------------
//
// Colour tells two crossing lines apart. It cannot tell two *overlapping* lines
// apart, because the one underneath is not there to be coloured: it is covered,
// pixel for pixel, and the map shows one link where there are two.
//
// Measured on the shipped layouts, this is most of the problem rather than a
// corner of it. Domain draws 170 pairs of collinear overlapping segments
// covering 4,529px of line, and 98% of that is the legs attached to the nodes -
// several links leaving a system along the same axis and stacking exactly. The
// middle legs, which an earlier version might have nudged, account for 19px.
//
// So the whole path is offset rather than any one leg of it. A rigid shift keeps the
// path orthogonal and connected by construction, and moves the endpoints a few
// pixels into the node's own capsule, which is at least 68px wide and 32px tall, so
// the link still reads as touching the system it belongs to. That height is the
// constraint the fan is sized against - see `SYSTEM_NODE_HEIGHT` below.

const LANE_TOLERANCE = 0.5;

function pathSegments(edge, pointPair) {
  const [from, to] = pointPair(edge);
  if (!from || !to) return [];
  return orthogonalSegments(from, to).filter(segment =>
    Math.abs(segment.from.x - segment.to.x) + Math.abs(segment.from.y - segment.to.y) > LANE_TOLERANCE);
}

function collinearOverlap(a, b) {
  const aHorizontal = Math.abs(a.from.y - a.to.y) <= LANE_TOLERANCE;
  const bHorizontal = Math.abs(b.from.y - b.to.y) <= LANE_TOLERANCE;
  if (aHorizontal !== bHorizontal) return false;
  const axis = aHorizontal
    ? Math.abs(a.from.y - b.from.y)
    : Math.abs(a.from.x - b.from.x);
  if (axis > LANE_TOLERANCE) return false;
  const [a1, a2] = aHorizontal ? [a.from.x, a.to.x] : [a.from.y, a.to.y];
  const [b1, b2] = bHorizontal ? [b.from.x, b.to.x] : [b.from.y, b.to.y];
  return Math.min(Math.max(a1, a2), Math.max(b1, b2))
    - Math.max(Math.min(a1, a2), Math.min(b1, b2)) > LANE_TOLERANCE;
}

// Slots spiral outward from the centre line - 0, +1, -1, +2, -2 - so the first
// link in a lane stays where the layout put it and the rest open out evenly
// around it. Shifting them all one way would drag the whole mesh off its grid.
export function slotOffset(slot, spacing) {
  if (slot === 0) return 0;
  const step = Math.ceil(slot / 2);
  return (slot % 2 === 1 ? step : -step) * spacing;
}

// The system node is a capsule 32px tall, so its centre line is 16px from the
// edge. A lane offset moves a link's *endpoints* as well as its elbow, so the
// fan has to stay inside that: an offset of 16px or more would leave the line
// finishing outside the node it connects to, visibly detached from it.
//
// **The fan and the node are one constraint, not two numbers.** The default fan
// reaches 15px, one pixel of margin; the next step up - 8 slots at 4px - reaches
// exactly 16px and detaches every offset line on the map. Widening the fan is the
// obvious thing to try when links still overlap, so the constraint is written down
// here, the node is drawn from this constant, and the test asserts the relationship
// rather than the pair of numbers that happens to satisfy it.
//
// Widening does not help anyway, measured across all 67 drawn regions: 6 slots at
// 5px leaves 548 overlapping pairs, 8 at 4px leaves 587, 10 at 3px leaves 600.
// Spreading links over more lanes moves which ones collide, not how many.
export const SYSTEM_NODE_HEIGHT = 32;

export function fanHalfSpan(maxSlots, spacing) {
  return slotOffset(maxSlots - 1, spacing);
}

// Which way a link runs, and therefore which axis its lane offset moves it
// along. orthogonalPath decides the same way, and the two must agree or the
// offsets are computed against a shape that is never drawn.
export function isHorizontalRun(from, to) {
  return Math.abs(from.x - to.x) >= Math.abs(from.y - to.y);
}

// Where a segment ends up once its lane offset is applied.
//
// orthogonalPath adds the offset to y on a horizontal run and to x on a
// vertical one - to both endpoints and the elbow - so the whole path
// translates. Exported because the placement below has to reason about the
// drawn geometry rather than the geometry it started from.
export function shiftSegment(segment, offset, horizontal) {
  if (!offset) return segment;
  return horizontal
    ? { from: { x: segment.from.x, y: segment.from.y + offset }, to: { x: segment.to.x, y: segment.to.y + offset } }
    : { from: { x: segment.from.x + offset, y: segment.from.y }, to: { x: segment.to.x + offset, y: segment.to.y } };
}

// Which edges have to move apart, and by how much.
//
// Two edges conflict when any segment of one covers any segment of the other.
// That is a graph-colouring problem like the crossing channels, and greedy
// colouring by descending conflict count gives each edge the lowest free slot -
// so an edge in no conflict never moves at all, and the map stays where the
// layout put it everywhere the problem does not exist.
//
// **The colouring is then checked against what it actually drew.** An offset
// translates a whole path, so moving two overlapping links apart can slide one of
// them onto a third that was in conflict with neither. A single pass over the
// un-offset geometry resolves 5,173 of 5,661 overlapping pairs across the 67 drawn
// regions and creates 114 new ones, and those 114 are the worst kind of artefact:
// they are in places the layout had right until this function touched them.
//
// So the placement is re-checked against the drawn geometry, any pair pushed
// together is added to the conflict graph, and the colouring runs again. The best
// pass wins, which is what makes it safe - the result can never be worse than the
// single pass.
export function assignLaneOffsets(edges, pointPair, options = {}) {
  const { spacing = 5, maxSlots = 6, maxPasses = 4 } = options;
  const segments = edges.map(edge => pathSegments(edge, pointPair));
  const horizontal = edges.map(edge => {
    const [from, to] = pointPair(edge);
    return from && to ? isHorizontalRun(from, to) : true;
  });

  const conflicts = edges.map(() => new Set());
  const link = (i, k) => {
    if (conflicts[i].has(k)) return false;
    conflicts[i].add(k);
    conflicts[k].add(i);
    return true;
  };

  let pairs = 0;
  for (let i = 0; i < edges.length; i += 1) {
    for (let k = i + 1; k < edges.length; k += 1) {
      if (!segments[i].some(a => segments[k].some(b => collinearOverlap(a, b)))) continue;
      link(i, k);
      pairs += 1;
    }
  }

  const colour = () => {
    const order = edges.map((_, index) => index)
      .sort((a, b) => conflicts[b].size - conflicts[a].size || a - b);
    const slots = new Map();
    let crowded = 0;
    for (const index of order) {
      // No special case for an edge with no conflicts: `taken` is empty for it
      // and the search below lands on slot 0, which is the same answer. A branch
      // that cannot change the result is a branch that cannot be tested.
      const taken = new Set([...conflicts[index]].map(other => slots.get(other)).filter(s => s !== undefined));
      let slot = 0;
      while (slot < maxSlots && taken.has(slot)) slot += 1;
      // Out of slots: take the centre rather than wandering ever further from
      // the layout. Two links overlap again, which is what the crossing colours
      // and the dark casing are for - and the count is returned so it can be
      // seen rather than discovered.
      if (slot >= maxSlots) {
        slot = 0;
        crowded += 1;
      }
      slots.set(index, slot);
    }
    return { slots, crowded };
  };

  // What this placement actually draws on top of itself.
  const residualOf = slots => {
    const placed = segments.map((segs, i) => {
      const offset = slotOffset(slots.get(i) ?? 0, spacing);
      return offset ? segs.map(seg => shiftSegment(seg, offset, horizontal[i])) : segs;
    });
    const left = [];
    for (let i = 0; i < edges.length; i += 1) {
      for (let k = i + 1; k < edges.length; k += 1) {
        if (placed[i].some(a => placed[k].some(b => collinearOverlap(a, b)))) left.push([i, k]);
      }
    }
    return left;
  };

  let best = null;
  let passes = 0;
  for (let pass = 0; pass < Math.max(1, maxPasses); pass += 1) {
    passes = pass + 1;
    const { slots, crowded } = colour();
    const residual = residualOf(slots);
    // Strictly better only, so a later pass can never make the map worse than
    // an earlier one - which is what lets this run without a safety net.
    if (!best || residual.length < best.residual) best = { slots, crowded, residual: residual.length, passes };
    if (!residual.length) break;
    // Teach the graph what it just learned, and stop when it learns nothing.
    let learned = 0;
    for (const [i, k] of residual) if (link(i, k)) learned += 1;
    if (!learned) break;
  }

  const offsets = new Map();
  edges.forEach((edge, index) => offsets.set(edge, slotOffset(best.slots.get(index) ?? 0, spacing)));
  return {
    offsets,
    pairs,
    crowded: best.crowded,
    slots: best.slots,
    // What is still drawn over itself after the best pass, and how many passes
    // it took. Reported rather than left to be discovered on the map.
    residual: best.residual,
    passes,
  };
}
