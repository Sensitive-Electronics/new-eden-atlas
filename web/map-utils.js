// The map's shared arithmetic: security bands and their colours, the projection
// from SDE coordinates to the viewBox, the relaxation passes that make a region
// readable, and the screen-to-map mapping the pointer handlers need.
//
// Everything here is a pure function of its arguments except `svg()`, so the
// geometry can be tested at any viewport shape without a browser.

const SVG_NS = "http://www.w3.org/2000/svg";

export function svg(tag, attributes = {}, text = "") {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes)) {
    node.setAttribute(key, value);
  }
  if (text) node.textContent = text;
  return node;
}

// How a path count compares with every other system's.
//
// **A figure with no scale is not information.** Measured over the shipped archive,
// the median gated system carries 16,946 shortest paths, the 90th percentile 208,319
// and the highest 5,061,831 - three orders of magnitude, so a pilot reading one
// number in isolation has no way to place it.
//
// Worse than unhelpful, because the intuition it invites is wrong. Jita is 162,369,
// which is only the top 13%: high-sec is densely connected, so there is usually a way
// round. Amarr is 1,335,035, the top 0.4%. Ahbazon, which every pilot already knows is
// a pipe, is the top 3.4%. The measure is right; reading it without a scale is not.
//
// Computed once per archive and cached against it, the same way `snapshot.js`
// caches its name index: the work is a sort of about five thousand numbers and
// the archive does not change while the page is open.
const SCALES = new WeakMap();

export function graphScale(atlas) {
  if (!atlas || typeof atlas !== "object") return null;
  const held = SCALES.get(atlas);
  if (held !== undefined) return held;
  let scale = null;
  try {
    const gated = Object.values(atlas.systems ?? {})
      .filter(system => system && Array.isArray(system.neighbors) && system.neighbors.length > 0);
    // **Per component, because a path count only means anything inside one.**
    //
    // New Eden is four disconnected networks: 5,228 systems, Pochven's 27, and two
    // pockets of 7 and 6. Otela is the busiest system in Pochven - every route across
    // Pochven crosses it - and ranked against the main cluster it falls into the
    // bottom quarter. Forty systems scale wrongly if the components are pooled.
    const components = new Map();
    for (const system of gated) {
      const value = system.metrics?.betweenness;
      if (!Number.isFinite(value)) continue;
      const id = system.metrics?.component;
      if (!components.has(id)) components.set(id, []);
      components.get(id).push(value);
    }
    for (const list of components.values()) list.sort((a, b) => a - b);
    const paths = [...components.values()].flat().sort((a, b) => a - b);
    if (paths.length > 0) {
      scale = Object.freeze({
        paths,
        components,
        // What share of gated systems are chokepoints. Nearly a quarter of them
        // are, which is the thing a pilot most needs to know before reading a
        // "Yes" as remarkable.
        chokeShare: gated.filter(system => system.metrics?.articulation).length / gated.length,
      });
    }
  } catch {
    // An archive this cannot read has no scale, and a panel without one renders
    // the figure alone rather than refusing to draw.
    scale = null;
  }
  SCALES.set(atlas, scale);
  return scale;
}

// How many of its own network this system is busier than. **One direction, and
// the bottom is expressible.**
//
// "Top N%" runs in two opposite directions on one panel - `top 1%` is Zarzakh and
// `top 100%` is a one-gate dead end, which is a fifth of the map reading `0 · top
// 100%`. A share of what a system is *above* only increases with the figure beside
// it, so there is no second reading to get wrong.
//
// Null rather than zero when there is no scale: a share of nothing is not a
// reading. Zero is a real answer and means it is busier than none of them.
export function pathRank(scale, value, component) {
  if (!scale || !Number.isFinite(value)) return null;
  const paths = scale.components?.get(component) ?? scale.paths;
  if (!Array.isArray(paths) || paths.length === 0) return null;
  let low = 0;
  let high = paths.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (paths[mid] < value) low = mid + 1;
    else high = mid;
  }
  return low / paths.length;
}

// A component too small to rank in is one where a percentage is noise: "busier
// than 80%" of five systems is four systems, and a pilot reads a percentage as
// though it were drawn from the map.
export const RANKABLE = 12;

export function escapeHtml(value) {
  return String(value).replace(
    /[&<>'"]/g,
    character => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "'": "&#39;",
      '"': "&quot;",
    })[character],
  );
}

// EVE rounds security status to one decimal place for display, so the
// boundary that matters is the one a displayed value implies, not the raw
// threshold. A system at 0.46 displays as 0.5 and is high security with
// CONCORD response; classifying it by its raw value contradicts its own label.
// 119 systems sit in [0.45, 0.50), and by their raw value they would be drawn as low
// security while their own node reads 0.5.
export const HIGH_SECURITY = 0.45;

// Purely cartographic: the brighter of the two high-security shades. Set by
// the same rule, so a node displaying 0.8 is drawn as 0.8.
export const ELEVATED_SECURITY = 0.75;

export function securityClass(security) {
  if (security >= HIGH_SECURITY) return "high";
  if (security > 0) return "low";
  return "null";
}

export function securityColor(security) {
  if (security >= ELEVATED_SECURITY) return "#62d8c8";
  if (security >= HIGH_SECURITY) return "#6aaee8";
  if (security > 0) return "#e5a45f";
  return "#db6a6a";
}

export function securityName(security) {
  return { high: "High security", low: "Low security", null: "Null security" }[securityClass(security)];
}

export function formatSecurity(security) {
  if (security > 0 && security < 0.05) return "0.1";
  const shown = security.toFixed(1);
  // toFixed keeps the sign of a negative number that rounds to zero, giving
  // "-0.0". EVE displays 0.0, and more seriously Number("-0.0") is -0, which
  // is NOT less than 0, so a security minimum silently admitted 559 systems.
  return shown === "-0.0" ? "0.0" : shown;
}

// The projection is a single uniform scale plus an offset, which means a
// distance on screen maps back to a real distance. Exposing the transform,
// rather than only the resulting points, is what lets a capital range ring be
// drawn at a size that means something.
export function projectionOf(records, getPosition, width = 1120, height = 700, padding = 65) {
  const points = records.map(getPosition);
  // Reduced rather than spread: Math.min(...array) throws RangeError once the
  // array is large enough to exhaust the argument limit.
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    if (point[0] < minX) minX = point[0];
    if (point[0] > maxX) maxX = point[0];
    if (point[1] < minY) minY = point[1];
    if (point[1] > maxY) maxY = point[1];
  }
  if (!points.length) { minX = maxX = minY = maxY = 0; }

  const spanX = maxX - minX;
  const spanY = maxY - minY;
  // Adding or subtracting one does not change coordinates near 1e18, which
  // made a single-system region divide by zero and render at NaN. Give a
  // collapsed axis a nominal span for scale selection, then center it
  // explicitly instead of trying to perturb the source coordinates.
  const scaleSpanX = spanX || 2;
  const scaleSpanY = spanY || 2;

  const scale = Math.min(
    (width - padding * 2) / scaleSpanX,
    (height - padding * 2) / scaleSpanY,
  );
  const offsetX = (width - spanX * scale) / 2;
  const offsetY = (height - spanY * scale) / 2;

  return {
    scale,
    toScreen: point => ({
      x: spanX ? offsetX + (point[0] - minX) * scale : width / 2,
      y: spanY ? offsetY + (point[1] - minY) * scale : height / 2,
    }),
  };
}

export function project(records, getPosition, width = 1120, height = 700, padding = 65) {
  const projection = projectionOf(records, getPosition, width, height, padding);
  return new Map(records.map(record => [record, projection.toScreen(getPosition(record))]));
}

// Regional system nodes, separated far enough to be told apart and no further.
//
// **The dot is what is separated, not the label box.** A label box is roughly
// 90x39px, so separating those moves almost every node and moves it a long way -
// which destroys the one thing the schematic is for. Measured as the correlation
// between a drawn gate length and the real distance in light-years, across the eight
// densest regions:
//
//                      dot collisions    correlation with real distance
//   label boxes                     0    0.33   (Domain -0.05)
//   dots at 22px                    0    0.84   (worst region 0.77)
//
// A label is not always drawn: `chooseMarkerLabels` chooses markers at render time
// and suppresses the ones that collide, per zoom level, with the selected and
// on-route nodes given priority. So a label-box overlap is the input to a solver that
// already runs. What cannot be suppressed is the **dot**, which is 4px, or 9px when
// it carries a sovereignty ring - so the clearance is 22px, radial, because a circle
// has no axes to choose between.
//
// It is paid for in names visible without zooming, 56% falling to 9% in the densest
// regions, and that is the right way round because the cost is recoverable: dots are
// pinned to a fixed screen size, so zooming separates them and names return to 55% at
// 2x and all of them by 4x. Structure relaxed away does not come back at any zoom.
//
// The largest regions stay dense and no amount of pushing fixes that. 189 nodes in
// Domain is a statement about the space rather than a tuning failure.
export const DOT_CLEARANCE = 22;

export function relaxSystems(records, positions, options = {}) {
  const {
    passes = 400,
    clearance = DOT_CLEARANCE,
    dampingStart = 0.9,
    dampingEnd = 0.2,
    bounds = { left: 40, right: 1160, top: 40, bottom: 720 },
  } = options;
  // The label width is needed by the clamp alone: a node whose name is drawn must
  // still draw it inside the viewBox.
  const requiredX = records.map(record => Math.max(72, record.name.length * 7 + 22));

  // Clamp the drawn OVAL, not its centre. Clamping the centre lets a wide node render
  // past the edge - a 90px oval centred on the left bound starts at x = -5, outside
  // the viewBox entirely.
  const HALF_HEIGHT = 16;
  const clamp = () => {
    for (let index = 0; index < records.length; index += 1) {
      const position = positions.get(records[index]);
      if (!position) continue;
      const half = requiredX[index] / 2;
      const left = Math.min(bounds.left + half, (bounds.left + bounds.right) / 2);
      const right = Math.max(bounds.right - half, left);
      position.x = Math.max(left, Math.min(right, position.x));
      position.y = Math.max(bounds.top + HALF_HEIGHT, Math.min(bounds.bottom - HALF_HEIGHT, position.y));
    }
  };

  for (let pass = 0; pass < passes; pass += 1) {
    // Annealed: shove hard early to break out of the initial pile-up, then
    // settle gently. Fixed damping gets stuck in a local arrangement and more
    // passes do not reliably help; annealing cut total overlapping pairs
    // across the six densest regions from 115 to 65.
    const damping = dampingStart + (dampingEnd - dampingStart) * (pass / Math.max(1, passes - 1));
    let moved = false;

    for (let first = 0; first < records.length; first += 1) {
      for (let second = first + 1; second < records.length; second += 1) {
        const a = positions.get(records[first]);
        const b = positions.get(records[second]);
        // A record with no position is skipped, as it is in clamp() below and
        // in relaxLabels. Without this the pair loop reads `.x` off undefined
        // and throws, and this runs inside a region render - so the map stops
        // being drawn, which is the one thing the degradation rule forbids.
        // Not reachable through regionLayout, which projects every record it
        // relaxes; reachable by any other caller of an exported function.
        if (!a || !b) continue;
        let deltaX = b.x - a.x;
        let deltaY = b.y - a.y;
        let distance = Math.hypot(deltaX, deltaY);

        // Written as `!(d < clearance)` rather than `d >= clearance` so a NaN
        // distance skips rather than proceeding: `NaN >= 22` is false, which
        // would let one bad coordinate infect its neighbours through the push
        // below. The axis-separated version guarded the same hazard the same
        // way, and losing the guard while changing the shape of the test is
        // exactly how it would come back.
        if (!(distance < clearance)) continue;

        // Exactly coincident, which the SDE does produce. Any direction will
        // do, but it must be the *same* direction every time: a region has to
        // draw identically on every render, and a random or time-dependent
        // nudge would make the map shift under a pilot who simply changed tab.
        if (!(distance > 1e-9)) {
          deltaX = first % 2 ? 1 : -1;
          deltaY = second % 2 ? 1 : -1;
          distance = Math.hypot(deltaX, deltaY);
        }

        const push = ((clearance - distance) / 2) * damping;
        const unitX = deltaX / distance;
        const unitY = deltaY / distance;
        a.x -= unitX * push;
        a.y -= unitY * push;
        b.x += unitX * push;
        b.y += unitY * push;
        moved = true;
      }
    }

    clamp();
    if (!moved) break;
  }

  return positions;
}

// Universe-level labels are the atlas's worst readability problem: SDE
// coordinates cluster whole regions on top of each other, and a label that
// cannot be read is a label that is not there.
//
// Node positions are NOT touched. Moving a region to make room for its own
// name would be redrawing New Eden, and the map's whole value is that the
// arrangement is real. Only the labels move, tethered to their node and joined
// to it by a leader line when they have travelled far enough to need one.

export function labelBox(record, side, characterWidth = 6.4) {
  const width = record.name.length * characterWidth + 6;
  return side === "left"
    ? { left: -width, right: 2, top: -8, bottom: 8 }
    : { left: -2, right: width, top: -8, bottom: 8 };
}

export function labelAnchors(records, positions, sideOf, radiusOf, gap = 5) {
  return new Map(records.map(record => {
    const point = positions.get(record);
    const offset = radiusOf(record) + gap;
    return [record, {
      x: point.x + (sideOf(record) === "left" ? -offset : offset),
      y: point.y + 4,
    }];
  }));
}

export function relaxLabels(records, labels, boxOf, options = {}) {
  const {
    passes = 600,
    damping = 0.55,
    bounds = null,
    anchors = null,
    tether = 0.05,
    obstacles = null,
    obstaclePadding = 3,
  } = options;

  for (let pass = 0; pass < passes; pass += 1) {
    let moved = false;

    for (let i = 0; i < records.length; i += 1) {
      for (let j = i + 1; j < records.length; j += 1) {
        const a = labels.get(records[i]);
        const b = labels.get(records[j]);
        if (!a || !b) continue;
        const boxA = boxOf(records[i]);
        const boxB = boxOf(records[j]);

        const overlapX = Math.min(a.x + boxA.right, b.x + boxB.right) - Math.max(a.x + boxA.left, b.x + boxB.left);
        if (overlapX <= 0) continue;
        const overlapY = Math.min(a.y + boxA.bottom, b.y + boxB.bottom) - Math.max(a.y + boxA.top, b.y + boxB.top);
        if (overlapY <= 0) continue;

        // Resolve along whichever axis needs the least movement. Vertical is
        // usually cheaper and disturbs the east-west reading less.
        if (overlapY <= overlapX) {
          const push = (overlapY / 2 + 0.25) * damping;
          const direction = a.y <= b.y ? -1 : 1;
          a.y += push * direction;
          b.y -= push * direction;
        } else {
          const push = (overlapX / 2 + 0.25) * damping;
          const direction = a.x <= b.x ? -1 : 1;
          a.x += push * direction;
          b.x -= push * direction;
        }
        moved = true;
      }
    }

    // Keep labels off the region dots, including dots that are not their own.
    if (obstacles) {
      for (const record of records) {
        const label = labels.get(record);
        const box = boxOf(record);
        if (!label) continue;
        for (const dot of obstacles) {
          const nearestX = Math.max(label.x + box.left, Math.min(dot.x, label.x + box.right));
          const nearestY = Math.max(label.y + box.top, Math.min(dot.y, label.y + box.bottom));
          const dx = nearestX - dot.x;
          const dy = nearestY - dot.y;
          const reach = dot.r + obstaclePadding;
          const distance = Math.hypot(dx, dy);
          if (distance >= reach) continue;
          const push = (reach - distance) * damping;
          if (Math.abs(dy) >= Math.abs(dx)) label.y += (dy >= 0 ? 1 : -1) * push;
          else label.x += (dx >= 0 ? 1 : -1) * push;
          moved = true;
        }
      }
    }

    // A gentle pull home, so a label that had room to move does not wander
    // further from its node than it needed to.
    if (anchors) {
      for (const record of records) {
        const label = labels.get(record);
        const home = anchors.get(record);
        if (!label || !home) continue;
        label.x += (home.x - label.x) * tether;
        label.y += (home.y - label.y) * tether;
      }
    }

    if (!moved) break;
  }

  if (bounds) {
    for (const record of records) {
      const label = labels.get(record);
      if (!label) continue;
      const box = boxOf(record);
      label.x = Math.max(bounds.left - box.left, Math.min(bounds.right - box.right, label.x));
      label.y = Math.max(bounds.top - box.top, Math.min(bounds.bottom - box.bottom, label.y));
    }
  }
  return labels;
}

// Even after relaxation, the densest parts of New Eden hold more region names
// than will fit side by side: measured on the real archive, pairwise
// separation bottoms out around 470 overlapping pairs however far labels are
// allowed to travel. Letting them pile up serves nobody, so the densest are
// dropped in priority order, largest region first. A dropped label is still
// reachable: hovering the node names it.
export function selectLabels(records, labels, boxOf, priorityOf) {
  const ordered = [...records].sort((a, b) => priorityOf(b) - priorityOf(a) || a.name.localeCompare(b.name));
  const placed = [];
  const shown = new Set();

  for (const record of ordered) {
    const point = labels.get(record);
    if (!point) continue;
    const box = boxOf(record);
    const rect = {
      left: point.x + box.left,
      right: point.x + box.right,
      top: point.y + box.top,
      bottom: point.y + box.bottom,
    };
    const collides = placed.some(other =>
      rect.left < other.right && rect.right > other.left && rect.top < other.bottom && rect.bottom > other.top);
    if (collides) continue;
    placed.push(rect);
    shown.add(record);
  }
  return shown;
}

// `offset` shifts the whole path sideways, perpendicular to its dominant axis,
// so links that would otherwise be drawn on top of each other run side by side.
// The shift is rigid - every point moves together - so the path stays
// orthogonal and connected, and the endpoints move a few pixels into the node's
// own capsule rather than away from it.
export function orthogonalPath(from, to, offset = 0) {
  const isHorizontal = Math.abs(from.x - to.x) >= Math.abs(from.y - to.y);
  if (isHorizontal) {
    const middleX = (from.x + to.x) / 2;
    const y1 = from.y + offset;
    const y2 = to.y + offset;
    return `M${from.x},${y1} H${middleX} V${y2} H${to.x}`;
  }
  const middleY = (from.y + to.y) / 2;
  const x1 = from.x + offset;
  const x2 = to.x + offset;
  return `M${x1},${from.y} V${middleY} H${x2} V${to.y}`;
}


// --- screen to map geometry -------------------------------------------------
//
// The map SVG declares a viewBox and no `preserveAspectRatio`, so it uses the default
// "xMidYMid meet": one uniform scale for both axes, with the leftover space split
// evenly as a letterbox.
//
// Dividing a pointer offset by the element's own width and height is two different
// scales, neither accounting for the letterbox, and is right only where the element's
// aspect ratio equals the viewBox's. Otherwise zoom walks away from the point under
// the cursor and a drag does not keep up with the pointer: on an 872x706 surface with
// a 1200x760 viewBox, a 100 pixel vertical drag moves the map about 78 pixels.
//
// Kept here as pure functions of a rectangle so the mapping can be tested at
// any viewport shape without a browser.

export function viewportTransform(rect, box) {
  const [boxWidth, boxHeight] = box;
  const width = Number(rect?.width) || 0;
  const height = Number(rect?.height) || 0;
  // A hidden or unmeasured element has no meaningful mapping. Returning a
  // scale of 1 keeps the arithmetic finite; dividing by zero would put
  // Infinity into the camera and leave the map permanently blank.
  if (!(width > 0) || !(height > 0) || !(boxWidth > 0) || !(boxHeight > 0)) {
    return { scale: 1, offsetX: 0, offsetY: 0, usable: false };
  }
  const scale = Math.min(width / boxWidth, height / boxHeight);
  return {
    scale,
    offsetX: (width - boxWidth * scale) / 2,
    offsetY: (height - boxHeight * scale) / 2,
    usable: true,
  };
}

// A client point, in viewBox units.
export function screenToView(rect, box, clientX, clientY) {
  const { scale, offsetX, offsetY } = viewportTransform(rect, box);
  return {
    x: (clientX - (rect?.left ?? 0) - offsetX) / scale,
    y: (clientY - (rect?.top ?? 0) - offsetY) / scale,
  };
}

// A movement, in viewBox units. Uniform, because the scale is.
export function screenDeltaToView(rect, box, deltaX, deltaY) {
  const { scale } = viewportTransform(rect, box);
  return { x: deltaX / scale, y: deltaY / scale };
}


// --- regional layout modes --------------------------------------------------
//
// Two layouts, and the difference between them matters more than it looks.
//
// "atlas" is this project's own schematic: the physical coordinates projected
// to two dimensions and then relaxed so every oval can be read at once. It is
// readable by construction and it is not what the game shows.
//
// "ccp" is CCP's published layout, the one the client itself draws, taken from
// position2D and used exactly as published. It is NOT relaxed - relaxing it
// would make it a third layout that resembles neither - so ovals overlap
// wherever the real map is crowded, and the marker decluttering handles that
// by showing dots instead of capsules. Moving a system to make room would be
// the one thing this layout exists to avoid.
//
// The vertical flip is applied here and only here. Stored coordinates are as
// published; screenY = -y is the renderer's business.
export const LAYOUT_MODES = ["atlas", "ccp"];

export function hasOfficialLayout(systems) {
  return systems.length > 0 && systems.every(system => Array.isArray(system.position_2d));
}

// Returns the positions plus what was actually used, which is not always what
// was asked for: CCP publishes no layout for J-space or the Abyssal proving
// grounds, so those regions fall back and say so rather than rendering a hole.
export function regionLayout(systems, mode, width, height, options = {}) {
  const { padding = 45, relax = relaxSystems, projectWith = project } = options;
  const wanted = LAYOUT_MODES.includes(mode) ? mode : "ccp";
  const official = wanted === "ccp" && hasOfficialLayout(systems);
  if (official) {
    return {
      positions: projectWith(systems, s => [s.position_2d[0], -s.position_2d[1]], width, height, padding),
      mode: "ccp",
      requested: wanted,
      fellBack: false,
    };
  }
  return {
    positions: relax(systems, projectWith(systems, s => [s.position[0], -s.position[2]], width, height, padding)),
    mode: "atlas",
    requested: wanted,
    fellBack: wanted === "ccp",
  };
}
