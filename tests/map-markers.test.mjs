import fs from "node:fs";
import path from "node:path";
import { suite, ROOT } from "./helpers.mjs";
import { markerScale, chooseMarkerLabels, resizedCamera } from "../web/map-markers.js";
import { viewportTransform } from "../web/map-utils.js";

export default function run(app) {
  const t = suite("screen markers");
  const box = [1200, 760];
  for (const [width, height] of [[1440, 800], [872, 706], [670, 601], [390, 655]]) {
    const rect = {left: 0, top: 0, width, height};
    for (const zoom of [.5, 1, 2, 5]) {
      const inverse = markerScale(rect, box, zoom);
      const root = viewportTransform(rect, box).scale;
      t.check(Math.abs(root * zoom * inverse * 68 - 68) < 1e-9,
        `68px capsule at ${width}x${height}, zoom ${zoom}`);
      t.check(Math.abs(root * zoom * inverse * 12 - 12) < 1e-9,
        `12px name at ${width}x${height}, zoom ${zoom}`);
    }
  }
  t.equal(markerScale(null, box, 2), .5, "unmeasured DOM remains finite");
  t.equal(markerScale(null, box, 0), 1, "invalid zoom cannot create infinity");

  const nodes = [
    {id: 1, x: 100, y: 100, width: 68, priority: 0},
    {id: 2, x: 150, y: 100, width: 68, priority: 1},
    {id: 3, x: 240, y: 200, width: 90, priority: 0},
  ];
  const compact = chooseMarkerLabels(nodes, 400, 300);
  t.check(compact.has(2) && !compact.has(1), "higher-priority label wins a collision");
  const spread = chooseMarkerLabels(nodes.map(n => ({...n, x: n.x * 2, y: n.y * 2})), 800, 600);
  t.equal(spread.size, 3, "spreading positions reveals all labels without resizing them");
  t.check(chooseMarkerLabels(nodes.map(n => ({...n, selected: n.id === 1, priority: n.id === 1 ? 100 : n.priority})), 400, 300).has(1),
    "selection wins priority");
  t.equal(chooseMarkerLabels([{...nodes[0], x: -100}], 400, 300).size, 0, "offscreen label is culled");
  t.equal(chooseMarkerLabels([{...nodes[0], x: 10}], 400, 300).size, 0, "clipped labels collapse to dots");
  const touching = [{...nodes[0]}, {...nodes[1], x: 171, priority: 0}];
  t.equal(chooseMarkerLabels(touching, 400, 300).size, 1, "new label needs five pixels clearance");
  t.equal(chooseMarkerLabels(touching, 400, 300, new Set([1, 2])).size, 2, "retained labels use a small hysteresis margin");
  const outlined = [{...nodes[0], padding: 4}, {...nodes[1], x: 175, padding: 4, priority: 0}];
  t.equal(chooseMarkerLabels(outlined, 400, 300).size, 1, "ownership outlines participate in capsule collisions");
  const ringNeighbour = [{...nodes[0], priority: 10}, {...nodes[1], x: 146, dotRadius: 9}];
  t.check(!chooseMarkerLabels(ringNeighbour, 400, 300).has(1), "a capsule does not hide a neighbouring ownership ring");

  const oldRect = {width: 872, height: 706};
  const newRect = {width: 390, height: 655};
  const view = {x: -300, y: -200, k: 2};
  const next = resizedCamera(view, oldRect, newRect, box);
  t.check(Math.abs(next.k * viewportTransform(newRect, box).scale - view.k * viewportTransform(oldRect, box).scale) < 1e-9,
    "resize preserves effective screen scale");
  for (const [axis, size] of [["x", box[0]], ["y", box[1]]]) {
    t.check(Math.abs((size / 2 - next[axis]) / next.k - (size / 2 - view[axis]) / view.k) < 1e-9,
      `resize preserves world-space focus on ${axis}`);
  }

  // Exercise the actual app wiring with a measured map, not only helper math.
  const map = app.ui.map;
  const original = map.getBoundingClientRect;
  map.getBoundingClientRect = () => ({left: 0, top: 0, width: 390, height: 655});
  app.state.mode = "region";
  app.state.box = box;
  app.state.nodes = [];
  app.state.positions = null;
  const marker = document.createElementNS("http://www.w3.org/2000/svg", "g");
  for (const [key, value] of Object.entries({"data-fixed-map": 1, "data-fixed-x": 100, "data-fixed-y": 100})) marker.setAttribute(key, value);
  app.ui.viewport.replaceChildren(marker);
  app.state.view = {x: 0, y: 0, k: 2};
  app.applyView();
  const scale = Number(marker.getAttribute("transform").match(/scale\(([^)]+)\)/)[1]);
  t.check(Math.abs(scale * 2 * .325 * 68 - 68) < 1e-8, "app applies root-SVG compensation at mobile width");
  map.getBoundingClientRect = original;
  app.resetView();

  // Selecting a system near the viewport edge must not hide its name. The edge
  // rule drops capsules that would be clipped, and it ran before priority could
  // matter, so the one system the pilot had just asked to see was the one that
  // vanished.
  const edgeMarker = { id: 1, x: 30, y: 400, width: 68, priority: 1000000, selected: true };
  const middle = { id: 2, x: 600, y: 400, width: 68, priority: 1, selected: false };
  t.check(chooseMarkerLabels([edgeMarker, middle], 1200, 760, new Set()).has(1),
    "a selected system keeps its capsule even where the edge would clip it");
  t.check(!chooseMarkerLabels([{ ...edgeMarker, selected: false, priority: 1000000 }, middle], 1200, 760, new Set()).has(1),
    "while an unselected one at the same place is still dropped, however high its priority");
  t.check(chooseMarkerLabels([{ ...edgeMarker, x: 40 }, middle], 1200, 760, new Set()).has(1),
    "and one clear of the edge is kept either way");


  return t.results;
}
