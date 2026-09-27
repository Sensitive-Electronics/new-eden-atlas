// The mapping between pointer positions and map coordinates.
//
// The map SVG has a viewBox and no `preserveAspectRatio`, so it scales uniformly and
// centres, leaving a letterbox on one axis. Dividing the horizontal offset by the
// element's width and the vertical offset by its height is two scales where there is
// one, with no letterbox term at all.

import { suite } from "./helpers.mjs";
import { screenDeltaToView, screenToView, viewportTransform } from "../web/map-utils.js";
import {
  IDENTITY_VIEW, MAX_EFFECTIVE_SCALE, MIN_EFFECTIVE_SCALE, laneAttributes, laneMargin,
  lanePath, markerTransform, pannedView, pinAttributes, readLane, viewBoxAttribute,
  viewBoxFor, viewTransform, worldToScreen, zoomedView
} from "../web/camera.js";
import { SYSTEM_NODE_HEIGHT } from "../web/edge-routing.js";
import { markerScale } from "../web/map-markers.js";

const rect = (width, height, left = 0, top = 0) => ({ width, height, left, top });
const near = (a, b, tolerance = 1e-9) => Math.abs(a - b) <= tolerance;

export default function run() {
  const t = suite("camera");
  const REGION = [1200, 760];

  // The geometry the review actually measured: an 872x706 surface showing a
  // 1200x760 viewBox. The element is relatively taller than the viewBox, so
  // the scale is set by width and the letterbox is vertical.
  const measured = rect(872, 706);
  const fit = viewportTransform(measured, REGION);
  t.check(near(fit.scale, 872 / 1200), "the scale is the smaller of the two ratios, here the width");
  t.check(near(fit.offsetX, 0), "no horizontal letterbox when width is the binding axis");
  t.check(fit.offsetY > 0, `and a vertical one of ${fit.offsetY.toFixed(1)}px`);
  t.check(near(fit.offsetY, (706 - 760 * (872 / 1200)) / 2), "split evenly top and bottom");

  // The reported symptom: a 100px vertical drag moved the map about 78px.
  const oldWay = 100 * 760 / 706;
  const fixed = screenDeltaToView(measured, REGION, 0, 100);
  t.check(near(oldWay, 107.65, 0.01), "the old mapping turned 100px into 107.65 map units");
  t.check(near(fixed.y, 100 / fit.scale), "the correct mapping divides by the single scale");
  t.check(near(fixed.y, 137.61, 0.01), "which is 137.61 map units");
  t.check(!near(fixed.y, oldWay, 1), "so the two disagree by more than a pixel, as reported");

  // Drag must track the pointer exactly: moving the pointer N screen pixels
  // must move the map N screen pixels, whatever the viewport shape.
  for (const [w, h, label] of [[1440, 900, "wide desktop"], [1102, 706, "normal"], [900, 800, "tablet"], [390, 844, "phone portrait"], [1200, 760, "exactly the viewBox"]]) {
    const r = rect(w, h);
    const { scale } = viewportTransform(r, REGION);
    const moved = screenDeltaToView(r, REGION, 37, -91);
    t.check(near(moved.x * scale, 37) && near(moved.y * scale, -91),
      `${label}: a drag maps back to the same screen pixels it came from`);
    t.check(near(moved.x / 37, moved.y / -91),
      `${label}: and both axes use one scale, so a diagonal drag stays diagonal`);
  }

  // Zoom must anchor: the point under the cursor is the point that stays put,
  // so the mapping has to round-trip.
  for (const [w, h, label] of [[1440, 900, "wide desktop"], [900, 800, "tablet"], [390, 844, "phone portrait"]]) {
    const r = rect(w, h, 53, 17);
    for (const [cx, cy] of [[53, 17], [53 + w / 2, 17 + h / 2], [53 + w, 17 + h], [53 + w * 0.13, 17 + h * 0.77]]) {
      const view = screenToView(r, REGION, cx, cy);
      const { scale, offsetX, offsetY } = viewportTransform(r, REGION);
      const backX = view.x * scale + offsetX + r.left;
      const backY = view.y * scale + offsetY + r.top;
      t.check(near(backX, cx, 1e-6) && near(backY, cy, 1e-6),
        `${label}: (${Math.round(cx)}, ${Math.round(cy)}) maps to map coordinates and back to itself`);
    }
  }

  // The centre of the element is the centre of the viewBox, on every shape.
  for (const [w, h, label] of [[1440, 900, "wide"], [390, 844, "portrait"], [1200, 760, "exact"]]) {
    const centre = screenToView(rect(w, h), REGION, w / 2, h / 2);
    t.check(near(centre.x, REGION[0] / 2, 1e-9) && near(centre.y, REGION[1] / 2, 1e-9),
      `${label}: the middle of the surface is the middle of the map`);
  }

  // The element's offset on the page must be subtracted, or every coordinate
  // is wrong by the position of the map within the layout.
  const shifted = screenToView(rect(1000, 700, 340, 120), REGION, 340, 120);
  const unshifted = screenToView(rect(1000, 700, 0, 0), REGION, 0, 0);
  t.check(near(shifted.x, unshifted.x) && near(shifted.y, unshifted.y),
    "the element's own position on the page is subtracted");

  // The universe view uses a different viewBox, and must behave the same.
  const UNIVERSE = [900, 760];
  const uni = viewportTransform(rect(900, 760), UNIVERSE);
  t.check(near(uni.scale, 1) && near(uni.offsetX, 0) && near(uni.offsetY, 0),
    "a surface matching the universe viewBox needs no scale and no letterbox");
  const uniCentre = screenToView(rect(1440, 600), UNIVERSE, 720, 300);
  t.check(near(uniCentre.x, 450) && near(uniCentre.y, 380),
    "and the universe map centres the same way at a different aspect ratio");

  // A hidden or unmeasured element must not put Infinity or NaN into the
  // camera, which would leave the map permanently blank.
  for (const bad of [rect(0, 0), rect(100, 0), rect(0, 100), rect(NaN, NaN), null, undefined]) {
    const transform = viewportTransform(bad, REGION);
    const point = screenToView(bad, REGION, 10, 10);
    t.check(Number.isFinite(transform.scale) && transform.scale > 0,
      `an unmeasurable rectangle yields a finite positive scale, not ${transform.scale}`);
    t.check(Number.isFinite(point.x) && Number.isFinite(point.y),
      "and a finite point rather than Infinity or NaN");
    t.check(transform.usable === false, "and reports itself unusable");
  }
  t.check(viewportTransform(rect(100, 100), [0, 0]).usable === false,
    "an empty viewBox is unusable too");


  // --- camera arithmetic --------------------------------------------------
  // These were inside app.js, reachable only by driving the DOM. As functions
  // of a view object they can be asked the questions that actually matter.

  t.equal(JSON.stringify(viewBoxFor("universe")), JSON.stringify([900, 760]),
    "the universe has its own viewBox, which is squarer than a region's");
  t.equal(JSON.stringify(viewBoxFor("region")), JSON.stringify([1200, 760]), "and a region has its own");
  t.equal(JSON.stringify(viewBoxFor("nonsense")), JSON.stringify([1200, 760]),
    "an unknown mode falls back to the region box rather than undefined");
  t.equal(viewBoxAttribute([900, 760]), "0 0 900 760", "the attribute is the box");
  t.equal(viewTransform({ x: 3, y: -4, k: 2 }), "translate(3 -4) scale(2)", "and the view is a transform");

  // Zoom anchoring is the whole point: the point under the cursor must not
  // move. Checked as a property at several factors and anchors rather than
  // against remembered numbers.
  for (const [cx, cy] of [[0, 0], [600, 380], [1200, 760], [137, 641]]) {
    for (const factor of [1.12, 0.89, 2, 0.5]) {
      const before = { x: 45, y: -30, k: 1.7 };
      const after = zoomedView(before, factor, cx, cy, 1);
      // The anchor is a position in viewport space, not a world point. The
      // world point currently sitting there must still sit there afterwards.
      const world = { x: (cx - before.x) / before.k, y: (cy - before.y) / before.k };
      t.check(near(world.x * after.k + after.x, cx, 1e-9)
        && near(world.y * after.k + after.y, cy, 1e-9),
        `zooming by ${factor} about (${cx}, ${cy}) leaves whatever was there in place`);
    }
  }

  // Limits are on effective scale, so they mean the same thing at any size.
  for (const unit of [0.25, 1, 4]) {
    const wayIn = zoomedView({ x: 0, y: 0, k: unit }, 1000, 0, 0, unit);
    const wayOut = zoomedView({ x: 0, y: 0, k: unit }, 0.0001, 0, 0, unit);
    t.check(near(wayIn.k, MAX_EFFECTIVE_SCALE * unit, 1e-9),
      `unit ${unit}: zooming in stops at ${MAX_EFFECTIVE_SCALE} effective`);
    t.check(near(wayOut.k, MIN_EFFECTIVE_SCALE * unit, 1e-9),
      `unit ${unit}: and out at ${MIN_EFFECTIVE_SCALE}`);
  }

  // A zero or non-finite scale would put the map beyond recovery, so the
  // camera refuses rather than propagating it.
  t.equal(zoomedView({ x: 1, y: 2, k: 0 }, 2, 0, 0, 1).k, 0, "a zero zoom is returned untouched, not divided by");
  t.check(Number.isFinite(zoomedView({ x: 1, y: 2, k: 1 }, Infinity, 0, 0, 1).k),
    "and an infinite factor cannot produce an infinite scale");

  const panned = pannedView({ x: 10, y: 20, k: 3 }, -4, 7);
  t.equal(JSON.stringify(panned), JSON.stringify({ x: 6, y: 27, k: 3 }), "panning moves and never rescales");

  t.equal(markerTransform(5, 6, 0.5), "translate(5 6) scale(0.5) translate(0 0)",
    "a pinned marker translates, counter-scales, then applies its offset");
  t.equal(markerTransform(5, 6, 0.5, -34, -15), "translate(5 6) scale(0.5) translate(-34 -15)",
    "in that order, so the offset is in screen units rather than world units");

  const pin = pinAttributes(11, 22, -3, -4);
  t.equal(pin["data-fixed-x"], 11, "a pin records where it belongs");
  t.equal(pin["data-fixed-offset-y"], -4, "including its offset");
  t.equal(pin["data-fixed-map"], "1", "and marks itself findable");

  // worldToScreen must agree with screenToView, or markers are decluttered
  // against positions the pointer does not share.
  for (const [w, h] of [[1440, 900], [900, 800], [390, 844]]) {
    const r = rect(w, h, 61, 23);
    const view = { x: 12, y: -9, k: 1.4 };
    for (const point of [{ x: 0, y: 0 }, { x: 600, y: 380 }, { x: 1199, y: 759 }]) {
      const screen = worldToScreen(point, view, r, REGION);
      // Undo the camera, then the client offset, and it should be the point.
      const back = screenToView(r, REGION, screen.x + r.left, screen.y + r.top);
      t.check(near((back.x - view.x) / view.k, point.x, 1e-6) && near((back.y - view.y) / view.k, point.y, 1e-6),
        `${w}x${h}: a world point maps to screen and back to itself`);
    }
  }

  t.equal(JSON.stringify(IDENTITY_VIEW), JSON.stringify({ x: 0, y: 0, k: 1 }), "the reset view is the identity");

  // --- a link has to land on the node at every zoom -------------------------------
  //
  // The suite already asserted that the widest lane offset, 15, fits inside a
  // 32px capsule. It compared two numbers in different units and was therefore
  // true at exactly one zoom level.
  //
  // A capsule is pinned: it is 32 *screen* pixels whatever the camera does, so
  // in world units its half-height is 16 * inverse. The offset was a flat 15
  // world units. Attachment held only while inverse >= 15/16, and a browser
  // review measured the consequence: at inverse 0.5846 the link ended 9.7
  // screen pixels short of the node it was drawn to meet.
  //
  // Two screenshot rounds were spent on this - one inconclusive, one wrong -
  // because it cannot be seen without measuring. So it is measured here.
  t.equal(laneMargin(15, 1, SYSTEM_NODE_HEIGHT), 1,
    "at unit scale the widest offset leaves the one pixel of margin it always claimed");
  t.check(near(laneMargin(15, 0.5845934272, SYSTEM_NODE_HEIGHT), -9.6587, 1e-3),
    `a world-unit offset detaches once zoomed in (${laneMargin(15, 0.5845934272, SYSTEM_NODE_HEIGHT).toFixed(2)}px past the outline)`);

  // The fix: the offset is scaled by the same inverse the markers use, so the
  // separation is a screen-pixel quantity like everything else about a marker.
  const zooms = [0.05, 0.25, 0.5845934272, 0.9, 1, 1.5, 4, 20];
  for (const inverse of zooms) {
    t.equal(laneMargin(15 * inverse, inverse, SYSTEM_NODE_HEIGHT), 1,
      `scaling with the camera holds that margin at inverse ${inverse}`);
  }

  // And the drawn path agrees, which is the part that actually reaches a screen.
  for (const inverse of zooms) {
    for (const offset of [-15, -5, 0, 5, 15]) {
      const from = { x: 100, y: 200 }, to = { x: 400, y: 260 };
      const d = lanePath(from, to, offset, inverse);
      const start = d.match(/^M([-\d.]+),([-\d.]+)/).slice(1).map(Number);
      const screen = Math.abs(start[1] - from.y) / inverse;
      t.check(screen <= SYSTEM_NODE_HEIGHT / 2 - 1 + 1e-9,
        `a drawn endpoint stays inside the capsule (offset ${offset}, inverse ${inverse}: ${screen.toFixed(2)} of ${SYSTEM_NODE_HEIGHT / 2}px)`);
    }
  }

  // The zoom sweep the review was asked to repeat by hand: overview, middle and
  // hard in, through the real camera rather than through chosen numbers.
  for (const k of [MIN_EFFECTIVE_SCALE, 0.5, 1, 2, 5, MAX_EFFECTIVE_SCALE]) {
    const inverse = markerScale(rect(1280, 720), [1200, 760], k);
    t.equal(laneMargin(15 * inverse, inverse, SYSTEM_NODE_HEIGHT), 1,
      `and through the camera itself at zoom ${k}`);
  }

  // And across viewport *sizes*, not only zoom levels. The inverse is a
  // function of the element rectangle as well as the camera, so a resize
  // changes it with the zoom untouched - which is why the redraw is keyed on
  // the inverse rather than on `view.k`. A phone-width window and a wide
  // desktop one are as different here as a zoom of 8.
  for (const [w, h] of [[390, 720], [768, 1024], [1280, 720], [1920, 1080], [3440, 1440]]) {
    const inverse = markerScale(rect(w, h), [1200, 760], 1);
    // `near` rather than `equal`: scaling by the inverse and dividing by it
    // again does not round-trip exactly in binary floating point at every
    // scale - 390 wide lands on 1.0000000000000018. That is arithmetic noise
    // a thousand times smaller than a pixel, not a margin that moved.
    t.check(near(laneMargin(15 * inverse, inverse, SYSTEM_NODE_HEIGHT), 1, 1e-9),
      `the margin holds at ${w}x${h} (inverse ${inverse.toFixed(3)})`);
  }
  // The premise of that redraw: a resize really does move the inverse, so a
  // cache keyed on zoom alone would serve a stale path.
  t.check(markerScale(rect(390, 720), [1200, 760], 1) !== markerScale(rect(1280, 720), [1200, 760], 1),
    "a resize changes the inverse with the zoom untouched, which is why the redraw is keyed on it");

  // Enough is carried on the element to redraw it, because a transform cannot
  // do this job: the offset must scale with the camera and the endpoints must
  // not, and one transform cannot do both.
  const held = laneAttributes({ x: 10, y: 20 }, { x: 30, y: 40 }, -15);
  const element = { getAttribute: name => String(held[name]) };
  const read = readLane(element);
  t.equal(read.offset, -15, "the lane offset survives the round trip");
  t.equal(`${read.from.x},${read.from.y},${read.to.x},${read.to.y}`, "10,20,30,40",
    "along with the endpoints it was drawn between");
  t.equal(lanePath(read.from, read.to, read.offset, 0.3), lanePath({ x: 10, y: 20 }, { x: 30, y: 40 }, -15, 0.3),
    "so a redraw at a new zoom produces what a first draw would have");

  return t.results;
}
