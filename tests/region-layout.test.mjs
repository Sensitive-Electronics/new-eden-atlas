// Regional node placement. The original pass pushed on both axes at once and
// clamped only at the end, so Domain finished with 158 overlapping node pairs,
// the worst of them a full 32px: two ovals exactly on top of each other, one
// name completely hidden behind another.

import { readArchive, readRegion, suite } from "./helpers.mjs";
import { project, relaxSystems } from "../web/map-utils.js";
import { VIEW_BOXES } from "../web/camera.js";

const [BOX_W, BOX_H] = VIEW_BOXES.region;
const BOUNDS = { left: 40, right: 1160, top: 40, bottom: 720 };

// Matches the oval drawn in renderRegion.
const boxOf = system => ({ w: Math.max(68, system.name.length * 7 + 20), h: 32 });

function layout(name) {
  const systems = Object.values(readRegion(name).systems);
  const positions = relaxSystems(systems, project(systems, s => [s.position[0], -s.position[2]], BOX_W, BOX_H, 45));
  return { systems, positions };
}

function overlaps(systems, positions) {
  let pairs = 0;
  let worst = 0;
  for (let i = 0; i < systems.length; i += 1) {
    for (let j = i + 1; j < systems.length; j += 1) {
      const a = positions.get(systems[i]);
      const b = positions.get(systems[j]);
      const ba = boxOf(systems[i]);
      const bb = boxOf(systems[j]);
      const x = (ba.w + bb.w) / 2 - Math.abs(a.x - b.x);
      const y = (ba.h + bb.h) / 2 - Math.abs(a.y - b.y);
      if (x > 0 && y > 0) { pairs += 1; worst = Math.max(worst, Math.min(x, y)); }
    }
  }
  return { pairs, worst };
}

export default function run() {
  const t = suite("region layout");

  // The densest regions in New Eden, which is where placement fails first.
  const DENSE = ["Domain", "Metropolis", "Delve", "Sinq Laison", "Heimatar", "The Forge", "Genesis", "Providence"];
  let total = 0;
  let worstAnywhere = 0;

  for (const name of DENSE) {
    const { systems, positions } = layout(name);
    const { pairs, worst } = overlaps(systems, positions);
    total += pairs;
    worstAnywhere = Math.max(worstAnywhere, worst);

    // The drawn OVAL must stay on the canvas, not merely its centre point. The
    // previous form subtracted half the width from both sides, cancelling it,
    // so a 90px oval centred on the left bound rendered at x = -5 and passed.
    const escaped = systems.filter(s => {
      const p = positions.get(s);
      const box = boxOf(s);
      return p.x - box.w / 2 < -0.5
        || p.x + box.w / 2 > BOX_W + 0.5
        || p.y - box.h / 2 < -0.5
        || p.y + box.h / 2 > BOX_H + 0.5;
    });
    t.equal(escaped.length, 0,
      `${name}: every node OVAL stays inside the viewBox${escaped.length ? ` (${escaped[0].name})` : ""}`);
  }

  // --- what is always drawn, and what is not -------------------------------------
  //
  // Label boxes are allowed to overlap, and `total` above is reported rather
  // than bounded. A label is not always drawn: `chooseMarkerLabels` picks them
  // at render time and suppresses the ones that collide, per zoom level, with
  // the selected and on-route nodes given priority. Separating label boxes in
  // the layout meant moving every node to solve a problem a later solver
  // already solves - and paying for it in the only thing the schematic is for.
  //
  // The dot cannot be suppressed, so the dot is what this guarantees.
  for (const name of DENSE) {
    const { systems, positions } = layout(name);
    let closest = Infinity;
    for (let i = 0; i < systems.length; i += 1) {
      for (let j = i + 1; j < systems.length; j += 1) {
        const a = positions.get(systems[i]);
        const b = positions.get(systems[j]);
        closest = Math.min(closest, Math.hypot(a.x - b.x, a.y - b.y));
      }
    }
    // Slightly under the clearance is fine and is the solver converging onto
    // it; a sovereignty ring is 9px, so two of them need 18px to stay distinct.
    t.check(closest >= 18,
      `${name}: no two dots are closer than ${closest.toFixed(1)}px, so none is hidden behind another`);
  }
  t.check(total > 0,
    `${total} label boxes overlap across the densest regions, which chooseMarkerLabels resolves at render`);

  // --- the property the relaxation exists to preserve -----------------------------
  //
  // The schematic's whole claim over CCP's published map is that it is drawn
  // from real coordinates, so a gate that looks long *is* long. Separating
  // label boxes dragged that correlation from 0.85 to 0.33, and Domain to
  // -0.05: a tidy diagram of nothing, with less to say about distance than the
  // schematic it was supposed to complement.
  //
  // Asserted, because the failure is invisible. Every node is in a plausible
  // place, the map looks better than the honest one, and nothing on screen says
  // the distances stopped meaning anything.
  const LIGHT_YEAR = 9.4607e15;
  const fidelity = name => {
    const region = readRegion(name);
    const systems = Object.values(region.systems);
    const { positions } = layout(name);
    const byId = new Map(systems.map(s => [String(s.system_id), s]));
    const drawn = [];
    for (const jump of region.jumps) {
      const a = byId.get(String(jump.from_system_id));
      const b = byId.get(String(jump.to_system_id));
      if (!a || !b) continue;
      const pa = positions.get(systems[systems.indexOf(a)]);
      const pb = positions.get(systems[systems.indexOf(b)]);
      if (!pa || !pb) continue;
      drawn.push([
        Math.hypot(...a.position.map((value, axis) => value - b.position[axis])) / LIGHT_YEAR,
        Math.hypot(pa.x - pb.x, pa.y - pb.y),
      ]);
    }
    const n = drawn.length;
    if (n < 3) return 1;
    const meanReal = drawn.reduce((s, p) => s + p[0], 0) / n;
    const meanDrawn = drawn.reduce((s, p) => s + p[1], 0) / n;
    const covariance = drawn.reduce((s, p) => s + (p[0] - meanReal) * (p[1] - meanDrawn), 0);
    const spreadReal = Math.sqrt(drawn.reduce((s, p) => s + (p[0] - meanReal) ** 2, 0));
    const spreadDrawn = Math.sqrt(drawn.reduce((s, p) => s + (p[1] - meanDrawn) ** 2, 0));
    return spreadReal && spreadDrawn ? covariance / (spreadReal * spreadDrawn) : 1;
  };

  const scores = DENSE.map(name => [name, fidelity(name)]);
  for (const [name, r] of scores) {
    t.check(r > 0.55,
      `${name}: drawn gate lengths still track real distance (r = ${r.toFixed(2)})`);
  }
  const mean = scores.reduce((s, [, r]) => s + r, 0) / scores.length;
  t.check(mean > 0.75,
    `across the densest regions the schematic keeps r = ${mean.toFixed(2)}, against 0.33 when label boxes were separated`);

  // Determinism: the same region must always draw the same way.
  const first = layout("Domain");
  const second = layout("Domain");
  t.check(first.systems.every((s, i) => {
    const a = first.positions.get(s);
    const b = second.positions.get(second.systems[i]);
    return Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9;
  }), "placement is deterministic");

  // A region must lay out fast enough that opening one feels immediate.
  const started = Date.now();
  layout("Domain");
  const elapsed = Date.now() - started;
  t.check(elapsed < 600, `the densest region lays out in ${elapsed}ms`);

  // A region with a single system must not divide by zero or loop forever.
  // Thera's coordinates are near 1e19, where adding or subtracting one is
  // below floating-point precision and previously produced NaN positions.
  const tiny = layout("G-R00031");
  const tinyPosition = tiny.positions.get(tiny.systems[0]);
  t.equal(tiny.systems.length, 1, "G-R00031 holds one system");
  t.check(Number.isFinite(tinyPosition.x) && Number.isFinite(tinyPosition.y), "Thera gets a finite position");
  t.check(Math.abs(tinyPosition.x - BOX_W / 2) < 1e-9 && Math.abs(tinyPosition.y - BOX_H / 2) < 1e-9,
    "Thera is centered in its regional view");

  // --- a record with no position must not stop the map being drawn --------------
  // clamp() inside relaxSystems guards this case and relaxLabels guards it, but
  // the pair loop between them did not, so it read `.x` off undefined and threw
  // - during a region render, which is where a throw takes the whole map down.
  // regionLayout projects every record it relaxes, so this is not reachable
  // through it; relaxSystems is exported, and the guard two loops down shows
  // the case was already considered once.
  const sparse = [{ name: "Alpha" }, { name: "Beta" }, { name: "Gamma" }];
  const sparsePositions = new Map([[sparse[0], { x: 100, y: 100 }], [sparse[2], { x: 104, y: 101 }]]);
  let relaxed = null;
  try {
    relaxed = relaxSystems(sparse, sparsePositions, { passes: 40 });
  } catch (error) {
    t.check(false, `relaxing with a missing position throws: ${error.message}`);
  }
  t.check(relaxed, "a record with no position is skipped rather than throwing");
  t.equal(relaxed?.size, 2, "and the records that had one keep theirs");
  const a = relaxed.get(sparse[0]);
  const c = relaxed.get(sparse[2]);
  const gap = Math.hypot(a.x - c.x, a.y - c.y);
  t.check(gap > 18,
    `while the two that started 4px apart are separated to ${gap.toFixed(1)}px, enough to tell the dots apart`);

  // --- every region is all-or-nothing for the published layout -------------------
  // hasOfficialLayout requires *every* system to carry one, which would be a
  // coarse rule if any region were partly covered: one missing system would
  // discard a published layout for the other ninety-nine. Checked against the
  // archive rather than assumed.
  const coverage = new Map();
  for (const system of Object.values(readArchive().systems)) {
    const seen = coverage.get(system.region_id) ?? { total: 0, withLayout: 0 };
    seen.total += 1;
    if (Array.isArray(system.position_2d)) seen.withLayout += 1;
    coverage.set(system.region_id, seen);
  }
  const partial = [...coverage.values()].filter(r => r.withLayout > 0 && r.withLayout < r.total);
  t.equal(partial.length, 0,
    "no region is partly covered by CCP's layout, so the all-or-nothing rule never discards one");
  const fully = [...coverage.values()].filter(r => r.withLayout === r.total).length;
  const none = [...coverage.values()].filter(r => r.withLayout === 0).length;
  t.check(fully > 0 && none > 0,
    `and both cases exist, so the rule is exercised either way (${fully} covered, ${none} not)`);

  return t.results;
}
