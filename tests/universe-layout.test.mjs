// The universe view is a stargate map, and its problem was label collision.
// What gets measured here is that the right regions are drawn, that the region
// dots never move, and that no two labels that are drawn overlap.

import { readArchive, suite } from "./helpers.mjs";
import { project, labelBox, labelAnchors, relaxLabels, selectLabels } from "../web/map-utils.js";

import { VIEW_BOXES } from "../web/camera.js";

// Pinned here rather than taken from the app. Importing the value meant the
// test laid out in whatever box the app had, so changing the app's box to the
// wrong one changed nothing observable.
const BOX_W = 900;
const BOX_H = 760;
const BOUNDS = { left: 8, right: BOX_W - 8, top: 16, bottom: BOX_H - 16 };
const RELAX = { tether: 0.002, damping: 0.6, passes: 900 };

function layout(regions, atlas) {
  const positions = project(regions, r => [r.position[0], -r.position[2]], BOX_W, BOX_H, 40);
  const radiusOf = r => Math.max(4, Math.min(10, 3.5 + Math.sqrt(r.system_count) / 2));
  const sideOf = r => positions.get(r).x > BOX_W * 0.55 ? "left" : "right";
  const boxOf = r => labelBox(r, sideOf(r));
  const home = labelAnchors(regions, positions, sideOf, radiusOf);
  const labels = new Map(regions.map(r => [r, { ...home.get(r) }]));
  return { positions, radiusOf, sideOf, boxOf, home, labels };
}

function overlaps(records, labels, boxOf, only = null) {
  const list = only ? records.filter(r => only.has(r)) : records;
  let count = 0;
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const a = labels.get(list[i]);
      const b = labels.get(list[j]);
      const ba = boxOf(list[i]);
      const bb = boxOf(list[j]);
      const x = Math.min(a.x + ba.right, b.x + bb.right) - Math.max(a.x + ba.left, b.x + bb.left);
      const y = Math.min(a.y + ba.bottom, b.y + bb.bottom) - Math.max(a.y + ba.top, b.y + bb.top);
      if (x > 0 && y > 0) count += 1;
    }
  }
  return count;
}

export default function run() {
  const t = suite("universe layout");
  const atlas = readArchive();
  const drawable = Object.values(atlas.regions).filter(r => r.systems.length && r.position.some(Boolean));
  const hasGates = r => r.systems.some(id => atlas.systems[id]?.neighbors.length);
  const known = drawable.filter(hasGates);

  t.equal(known.length, 68, "68 regions carry at least one stargate");
  t.equal(drawable.length - known.length, 46, "46 have none and belong on no stargate map");
  // The excluded regions are the interesting claim: that nothing with a gate
  // was dropped. (Asserting the filtered set satisfies its own filter is true
  // by construction and touches no product code.)
  const excluded = drawable.filter(r => !hasGates(r));
  t.check(excluded.every(r => r.systems.every(id => !atlas.systems[id]?.neighbors.length)),
    `none of the ${excluded.length} excluded regions has a single stargate`);
  t.equal(VIEW_BOXES.universe.join("x"), `${BOX_W}x${BOX_H}`,
    "the application lays the universe out in the box this test pins");

  // Including gateless regions squeezes known space into a corner. This is the
  // measurement that justified excluding them.
  const withAll = layout(drawable, atlas);
  const withKnown = layout(known, atlas);
  const crowded = overlaps(drawable, withAll.labels, withAll.boxOf);
  const clear = overlaps(known, withKnown.labels, withKnown.boxOf);
  t.check(crowded > clear * 10,
    `projecting all ${drawable.length} regions overlaps ${crowded} label pairs against ${clear} for known space alone`);

  const nodesBefore = new Map(known.map(r => [r, { ...withKnown.positions.get(r) }]));
  relaxLabels(known, withKnown.labels, withKnown.boxOf, {
    ...RELAX,
    anchors: withKnown.home,
    obstacles: known.map(r => ({ ...withKnown.positions.get(r), r: withKnown.radiusOf(r) })),
    bounds: BOUNDS,
  });
  const labelled = selectLabels(known, withKnown.labels, withKnown.boxOf, r => r.system_count);

  // The guarantee that matters: nothing drawn overlaps anything else drawn.
  t.equal(overlaps(known, withKnown.labels, withKnown.boxOf, labelled), 0,
    `none of the ${labelled.size} drawn labels overlap each other`);
  t.check(labelled.size >= 40, `${labelled.size} of ${known.length} regions keep their label`);

  // Geography is untouched: only labels were laid out.
  const moved = known.filter(r => {
    const a = nodesBefore.get(r);
    const b = withKnown.positions.get(r);
    return Math.abs(a.x - b.x) > 1e-9 || Math.abs(a.y - b.y) > 1e-9;
  });
  t.equal(moved.length, 0, "not one region dot moves");

  let offCanvas = 0;
  for (const region of known) {
    const p = withKnown.labels.get(region);
    const box = withKnown.boxOf(region);
    if (p.x + box.left < BOUNDS.left - 0.5 || p.x + box.right > BOUNDS.right + 0.5) offCanvas += 1;
    if (p.y + box.top < BOUNDS.top - 0.5 || p.y + box.bottom > BOUNDS.bottom + 0.5) offCanvas += 1;
  }
  t.equal(offCanvas, 0, "every label box stays inside the canvas");

  let maxLeader = 0;
  let total = 0;
  for (const region of known) {
    const home = withKnown.home.get(region);
    const label = withKnown.labels.get(region);
    const distance = Math.hypot(label.x - home.x, label.y - home.y);
    maxLeader = Math.max(maxLeader, distance);
    total += distance;
  }
  t.check(total / known.length < 20, `a label sits ${(total / known.length).toFixed(1)}px from its node on average`);
  t.check(maxLeader < 90, `the furthest-displaced label is ${maxLeader.toFixed(1)}px from its node`);

  // Determinism: the same archive must always draw the same map.
  const second = layout(known, atlas);
  relaxLabels(known, second.labels, second.boxOf, {
    ...RELAX,
    anchors: second.home,
    obstacles: known.map(r => ({ ...second.positions.get(r), r: second.radiusOf(r) })),
    bounds: BOUNDS,
  });
  const secondLabelled = selectLabels(known, second.labels, second.boxOf, r => r.system_count);
  t.check(known.every(r => {
    const a = withKnown.labels.get(r);
    const b = second.labels.get(r);
    return Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9;
  }), "label positions are deterministic");
  t.equal(secondLabelled.size, labelled.size, "and so is the set that keeps its label");

  // Culling must favour the larger region, never drop one and keep a smaller
  // one it collides with.
  // Compare each dropped label against the labels it actually COLLIDES with,
  // not against the whole set: `some` over everything was satisfied by one
  // large unrelated region and could only fail if the biggest region lost.
  const dropped = known.filter(r => !labelled.has(r));
  const collidesWith = record => [...labelled].filter(other => {
    const a = withKnown.labels.get(record);
    const b = withKnown.labels.get(other);
    const ba = withKnown.boxOf(record);
    const bb = withKnown.boxOf(other);
    return Math.min(a.x + ba.right, b.x + bb.right) > Math.max(a.x + ba.left, b.x + bb.left)
      && Math.min(a.y + ba.bottom, b.y + bb.bottom) > Math.max(a.y + ba.top, b.y + bb.top);
  });
  const unjustified = dropped.filter(d => {
    const rivals = collidesWith(d);
    return rivals.length > 0 && rivals.every(k => k.system_count < d.system_count);
  });
  t.equal(unjustified.length, 0,
    `every dropped label lost to a region at least as large as itself${unjustified.length ? ` (${unjustified[0].name})` : ""}`);
  t.check(dropped.every(d => collidesWith(d).length > 0),
    "and every dropped label genuinely collided with something that was kept");

  // Regions on the right label inwards, so no name runs off the edge.
  const rightSide = known.filter(r => withKnown.positions.get(r).x > BOX_W * 0.55);
  t.check(rightSide.length > 0 && rightSide.every(r => withKnown.boxOf(r).right <= 2.001),
    `${rightSide.length} regions on the right label inwards`);

  return t.results;
}
