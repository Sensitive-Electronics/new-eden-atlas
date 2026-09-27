// Camera arithmetic for the map: what zooming and panning do to the view, and
// what transform a screen-locked marker needs.
//
// None of this touches the DOM. app.js reads the element rectangle, calls these
// to work out the new numbers, and writes the attributes - so the arithmetic
// can be tested at any viewport shape and zoom without a browser, which is the
// only way this project can test it at all.
//
// The view is {x, y, k}: a translation in viewBox units and a scale. It is
// treated as immutable here; every function returns a new one.

import { orthogonalPath, viewportTransform } from "./map-utils.js";

// The universe map is squarer than a region, so the two views have their own
// viewBoxes rather than one shape wasting most of the canvas on the other.
export const VIEW_BOXES = { universe: [900, 760], region: [1200, 760] };

export function viewBoxFor(mode) {
  return VIEW_BOXES[mode] ?? VIEW_BOXES.region;
}

export function viewBoxAttribute(box) {
  return `0 0 ${box[0]} ${box[1]}`;
}

export const IDENTITY_VIEW = { x: 0, y: 0, k: 1 };

// Zoom limits are expressed in EFFECTIVE scale - camera zoom multiplied by the
// scale the SVG applies fitting its viewBox into the element - so the same
// limit means the same thing on a phone and a wide monitor. `unit` is the
// camera zoom at which effective scale is 1.
export const MIN_EFFECTIVE_SCALE = 0.15;
export const MAX_EFFECTIVE_SCALE = 8;

// Zooming about a point: that point must not move. Everything else scales
// around it, which is what makes wheel zoom feel anchored to the cursor.
export function zoomedView(view, factor, centreX, centreY, unit = 1) {
  const previous = view.k;
  const next = Math.max(MIN_EFFECTIVE_SCALE * unit, Math.min(MAX_EFFECTIVE_SCALE * unit, previous * factor));
  if (!(previous > 0) || !Number.isFinite(next)) return { ...view };
  return {
    x: centreX - (centreX - view.x) * next / previous,
    y: centreY - (centreY - view.y) * next / previous,
    k: next,
  };
}

export function pannedView(view, deltaX, deltaY) {
  return { x: view.x + deltaX, y: view.y + deltaY, k: view.k };
}

export function viewTransform(view) {
  return `translate(${view.x} ${view.y}) scale(${view.k})`;
}

// A marker pinned to a world position but held at its authored screen size.
// The inverse scale cancels both the camera zoom and the container scale, so
// zooming spreads systems apart without growing their labels.
export function markerTransform(x, y, inverse, offsetX = 0, offsetY = 0) {
  return `translate(${x} ${y}) scale(${inverse}) translate(${offsetX} ${offsetY})`;
}

// The attributes that let a pinned element be found and recomputed later,
// without the renderer having to keep a parallel list of them.
export function pinAttributes(x, y, offsetX = 0, offsetY = 0) {
  return {
    "data-fixed-map": "1",
    "data-fixed-x": x,
    "data-fixed-y": y,
    "data-fixed-offset-x": offsetX,
    "data-fixed-offset-y": offsetY,
  };
}

export function readPin(element) {
  return {
    x: Number(element.getAttribute("data-fixed-x")),
    y: Number(element.getAttribute("data-fixed-y")),
    offsetX: Number(element.getAttribute("data-fixed-offset-x")),
    offsetY: Number(element.getAttribute("data-fixed-offset-y")),
  };
}

// A world position in screen pixels, measured from the element's top-left.
// Used to decide what is on screen and what would collide with what.
export function worldToScreen(point, view, rect, box) {
  const { scale, offsetX, offsetY } = viewportTransform(rect, box);
  return {
    x: (point.x * view.k + view.x) * scale + offsetX,
    y: (point.y * view.k + view.y) * scale + offsetY,
  };
}

// --- lanes ------------------------------------------------------------------
//
// A link's lane offset is a readability device, not a fact about the universe: it
// exists so two links sharing a corridor keep separate lines on screen. It
// therefore belongs in screen pixels, like the capsules and the labels, and not in
// world units.
//
// A capsule is pinned to 32 screen pixels whatever the camera does, so its
// half-height is `16 * inverse` world units. A lane offset held flat in world
// units is correct at exactly one zoom level and detaches the link from the node
// at every other. Scaling the offset by the same inverse the markers use makes the
// separation constant on screen, and the margin constant with it, at every zoom.
export function lanePath(from, to, offset, inverse) {
  return orthogonalPath(from, to, offset * (Number.isFinite(inverse) ? inverse : 1));
}

// As with pinAttributes: enough on the element to recompute it later, so the
// renderer does not have to keep a parallel list of what it drew.
export function laneAttributes(from, to, offset) {
  return {
    "data-lane": offset,
    "data-lane-x1": from.x, "data-lane-y1": from.y,
    "data-lane-x2": to.x, "data-lane-y2": to.y,
  };
}

export function readLane(element) {
  return {
    from: { x: Number(element.getAttribute("data-lane-x1")), y: Number(element.getAttribute("data-lane-y1")) },
    to: { x: Number(element.getAttribute("data-lane-x2")), y: Number(element.getAttribute("data-lane-y2")) },
    offset: Number(element.getAttribute("data-lane")),
  };
}

// What a drawn world-unit offset measures on screen, and the margin it leaves
// against a capsule pinned to `nodeHeight` screen pixels. Positive is attached.
//
// A world unit is `1 / inverse` screen pixels, so the margin is the capsule's
// half-height less what the offset actually draws. Asserted in the suite, because
// otherwise it can only be checked by eye against a screenshot.
export function laneMargin(worldOffset, inverse, nodeHeight) {
  return nodeHeight / 2 - Math.abs(worldOffset) / inverse;
}
