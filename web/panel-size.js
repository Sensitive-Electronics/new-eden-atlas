// How wide the region rail may be, which depends on the window.
//
// The shell is a three-column grid: the rail, the map, and the inspector. Only
// the rail is draggable, and the other two are what the limits are made of.
//
// The map's column is `minmax(420px, 1fr)`, which is a floor and not a request:
// once the fixed columns leave it less than 420px the grid overflows rather than
// shrinking, and the map slides under the inspector. So the rail's maximum is not
// a number - it is whatever is left after the map keeps its floor and the
// inspector keeps its width, and it changes every time the window does.
//
// A stored width is therefore never trusted on its own. It is clamped on every
// load and on every window resize: a width that was reasonable on a wide monitor
// is not reasonable when the same profile opens on a laptop.
//
// Kept apart from the dragging so the limits can be checked without a pointer, a
// window or a layout.

export const RAIL_DEFAULT = 280;

// Below this the region index is a column of truncated names, which is not a
// narrower rail so much as a useless one. A pilot who wants the space back has
// the collapse control for that.
export const RAIL_MIN = 180;

// An upper bound as well as a lower one. Nothing breaks without it - the clamp
// below would stop it - but a rail that can eat the window is a drag people
// perform once by accident and then have to undo.
export const RAIL_MAX = 560;

// The map's own floor, from `.shell`'s `minmax(420px, 1fr)`.
//
// Duplicated from the stylesheet because the clamp has to know it in numbers,
// and a duplicate that drifts is worse than either copy. `panel-size.test.mjs`
// reads styles.css and fails if the two stop agreeing, so the pair is a guarantee
// rather than a note asking the next person to change both.
export const MAP_MIN = 420;

// The inspector's fixed column. Below the wide breakpoint it stops being a
// column at all and becomes an overlay, so it costs nothing and is not
// subtracted.
export const INSPECTOR_WIDTH = 300;
export const INSPECTOR_IS_COLUMN_ABOVE = 1200;

// What the inspector actually takes out of the row at this window width.
export function inspectorCost(viewportWidth) {
  return Number(viewportWidth) > INSPECTOR_IS_COLUMN_ABOVE ? INSPECTOR_WIDTH : 0;
}

// The widest the rail may be right now, which is never more than what is left.
//
// Returns at least RAIL_MIN even when the window is too narrow for everything
// to fit. At that point something has to overflow and the honest choice is the
// map, which scrolls and pans, rather than the rail, which would become a strip
// of clipped words. A window that small is already in the responsive layout's
// territory.
export function railCeiling(viewportWidth) {
  const width = Number(viewportWidth);
  if (!Number.isFinite(width) || width <= 0) return RAIL_MAX;
  const left = width - MAP_MIN - inspectorCost(width);
  return Math.max(RAIL_MIN, Math.min(RAIL_MAX, left));
}

// The one function the rest of the application uses.
//
// Anything unreadable becomes the default rather than an error: this is a
// cosmetic preference read from browser storage, and a corrupt one must not be
// the reason a map does not draw.
export function clampRailWidth(requested, viewportWidth) {
  const ceiling = railCeiling(viewportWidth);
  // `typeof`, not `Number()`. `Number(null)` and `Number([])` are both 0, which
  // is finite, so coercing first turns an unreadable preference into a rail at its
  // minimum width - a plausible answer nobody would question. Unreadable has to
  // mean unreadable.
  const wanted = typeof requested === "number" ? requested : NaN;
  if (!Number.isFinite(wanted)) return Math.min(RAIL_DEFAULT, ceiling);
  return Math.max(RAIL_MIN, Math.min(ceiling, Math.round(wanted)));
}
