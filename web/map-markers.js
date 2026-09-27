// Which system labels are drawn, and where the camera sits after a resize.

import { viewportTransform } from "./map-utils.js";

export function markerScale(rect, box, zoom) {
  const scale = viewportTransform(rect, box).scale * zoom;
  return Number.isFinite(scale) && scale > 0 ? 1 / scale : 1;
}

function overlaps(a, b, gap = 0) {
  return a.left < b.right + gap && a.right > b.left - gap
    && a.top < b.bottom + gap && a.bottom > b.top - gap;
}

// Declutter in screen pixels without moving the underlying graph. Retained
// labels need slightly less clearance, so small wheel movements do not flicker.
export function chooseMarkerLabels(markers, width, height, previous = new Set()) {
  const visible = markers.filter(m => m.x >= -m.width && m.x <= width + m.width
    && m.y >= -32 && m.y <= height + 32);
  const ordered = [...visible].sort((a, b) => b.priority - a.priority || a.id - b.id);
  const placed = [];
  const shown = new Set();
  for (const marker of ordered) {
    const gap = previous.has(marker.id) ? 2 : 5;
    const padding = marker.padding ?? 0;
    const rect = {
      left: marker.x - marker.width / 2 - padding,
      right: marker.x + marker.width / 2 + padding,
      top: marker.y - 16 - padding,
      bottom: marker.y + 16 + padding,
    };
    // A capsule clipped by the viewport edge looks broken, so it is dropped -
    // except for the selected system, which the pilot has just asked to see and
    // which no priority below could otherwise save.
    const clipped = rect.left < 2 || rect.right > width - 2 || rect.top < 2 || rect.bottom > height - 2;
    if (clipped && !marker.selected) continue;
    if (placed.some(other => overlaps(rect, other, gap))) continue;
    // Do not cover another system's location with an unrelated capsule.
    // The selected system is allowed to expand so its identity stays visible.
    if (!marker.selected && visible.some(other => other.id !== marker.id && overlaps(rect, {
      left: other.x - (other.dotRadius ?? 4), right: other.x + (other.dotRadius ?? 4),
      top: other.y - (other.dotRadius ?? 4), bottom: other.y + (other.dotRadius ?? 4),
    }, gap))) continue;
    placed.push(rect);
    shown.add(marker.id);
  }
  return shown;
}

export function resizedCamera(view, oldRect, newRect, box) {
  const oldMapping = viewportTransform(oldRect, box);
  const newMapping = viewportTransform(newRect, box);
  if (!oldMapping.usable || !newMapping.usable) return { ...view };
  const k = view.k * oldMapping.scale / newMapping.scale;
  return {
    k,
    x: box[0] / 2 - (box[0] / 2 - view.x) * k / view.k,
    y: box[1] / 2 - (box[1] / 2 - view.y) * k / view.k,
  };
}
