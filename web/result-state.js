// Whether a displayed result still belongs to the inputs on screen.
//
// A result is shown only while it matches the inputs that produced it. When they
// diverge the result is cleared rather than annotated: a "stale" badge is a claim
// about what the pilot can see, and this module is verified without a browser.
//
// A pure comparison over a snapshot of named inputs. It knows nothing about
// routes, ships or the DOM, so every panel can use the one implementation.

// Values arrive from form fields, so they are mostly strings, with a checkbox or
// two. Strings are normalised, so retyping a system in different case or with a
// stray space does not discard a result. Everything else keeps its type.
function canonical(value) {
  if (typeof value === "string") return value.trim().toLowerCase();
  if (typeof value === "number") return Number.isFinite(value) ? value : "NaN";
  return value === undefined ? null : value;
}

// A stable key for a set of named inputs, sorted by name so a caller cannot
// change the answer by listing the same fields in a different order.
//
// Encoded as JSON pairs rather than joined with delimiters. A value may contain
// any character - the avoid-systems box is free text - and a delimiter inside a
// value would forge a field boundary, making two different input sets compare
// equal. JSON escapes control characters, keeps each name and value in its own
// position, and distinguishes null from the empty string and true from the text
// "true" without a type tag.
export function inputsKey(values) {
  if (!values || typeof values !== "object") return "";
  return JSON.stringify(
    Object.keys(values)
      .sort()
      .map(name => [name, canonical(values[name])]),
  );
}

// A result with no recorded key predates this mechanism or was restored from
// storage, and is not treated as stale: clearing something the pilot never saw
// change would be its own defect.
export function isStale(recordedKey, currentKey) {
  if (recordedKey === null || recordedKey === undefined) return false;
  return recordedKey !== currentKey;
}

// The named input sets, kept here so the panels and the tests agree on which
// fields a result depends on. Range omits destination, fuel conservation and the
// fuel module: none of them moves a range boundary. Threat takes one field,
// because the staging list is what the panel takes.
export const JUMP_FIELDS = ["from", "to", "ship", "calibration", "conservation", "hullSkill", "fuelModule", "highSec"];
export const RANGE_FIELDS = ["from", "ship", "calibration", "hullSkill", "highSec"];
export const ROUTE_FIELDS = ["from", "to", "mode", "avoidSystems", "avoidRegions", "minSec", "maxSec", "avoidOn", "heat", "scout", "scoutHull"];
export const THREAT_FIELDS = ["staging"];

export function keyFor(fields, values) {
  const picked = {};
  for (const field of fields) picked[field] = values[field];
  return inputsKey(picked);
}
