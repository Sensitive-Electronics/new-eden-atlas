// Reading and writing the viewer's saved settings.
//
// **Nothing here throws.** Browser storage is unavailable in private mode, with
// blocked site data and in some embedded webviews, and every read of it happens
// during startup. Storage is a convenience: losing a remembered route origin is a
// small annoyance, and failing to draw New Eden because of it is not a trade
// worth making.
export function readJson(storage, key) {
  let raw = null;
  try {
    raw = storage.getItem(key);
  } catch {
    return null;
  }
  if (raw === null || raw === undefined) return null;
  try {
    const value = JSON.parse(raw);
    // JSON.parse("null") is null and JSON.parse("4") is a number; callers here
    // all expect an object, and returning a number would have them read
    // properties off it and get undefined for every field.
    return value && typeof value === "object" ? value : null;
  } catch {
    // **Damage, not absence - and the bytes stay.** Nothing is removed here. A
    // value corrupted by a crashed tab or a half-written save is still the only
    // copy: deleting it on read hands the caller `null`, which reads as a first
    // run, and the next write lands on nothing at all.
    //
    // `readJsonState` below lets a caller that cares tell "there was nothing"
    // from "there was something I could not read". `readJson` keeps this shape
    // for the callers that only want a preference back.
    return null;
  }
}

// The same read, with the outcome named rather than collapsed.
//
//   "absent"      no value stored; a first run, and an empty default is right
//   "unreadable"  a value is stored and could not be parsed; it is still there,
//                 and writing over it would destroy the only copy
//   "read"        parsed, with the value
//
// Two of those mean "you get nothing back", which is why collapsing them is so
// easy and so expensive.
//
// An array takes the `"read"` branch, not `"unreadable"` - `typeof [] ===
// "object"` and `[]` is truthy. Harmless for every caller here, each of which
// reads a named field off the value and gets `undefined`.
export function readJsonState(storage, key) {
  let raw = null;
  try {
    raw = storage.getItem(key);
  } catch {
    return { state: "absent", value: null };
  }
  if (raw === null || raw === undefined) return { state: "absent", value: null };
  try {
    const value = JSON.parse(raw);
    if (value && typeof value === "object") return { state: "read", value };
    // Valid JSON that is not an object - `4`, `"x"`, `[]`. The callers here all
    // expect an object, and a number would have them read properties off it and
    // get undefined for every field. That is damage too, not absence.
    return { state: "unreadable", value: null };
  } catch {
    return { state: "unreadable", value: null };
  }
}

export function writeJson(storage, key, value) {
  try {
    storage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function readText(storage, key, allowed = null) {
  let raw = null;
  try {
    raw = storage.getItem(key);
  } catch {
    return null;
  }
  if (raw === null || raw === undefined) return null;
  // An allow-list, where one is given, so a value edited by hand in devtools
  // cannot put the viewer into a state it has no code for.
  if (allowed && !allowed.includes(raw)) return null;
  return raw;
}

export function writeText(storage, key, value) {
  try {
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export const STORAGE_KEYS = {
  route: "new-eden-atlas-route-v1",
  threat: "new-eden-atlas-threat-v1",
  jump: "new-eden-atlas-jump-v1",
  layout: "new-eden-atlas-layout-v1",
  tactical: "new-eden-atlas-tactical-v1",
  // **The panel read is not part of the tactical preset, and must not become
  // one.** That preset is exported and imported - `exportTactical` writes a file
  // a pilot shares - so folding this in would let one pilot's file switch on a
  // model-written sentence under another pilot's findings. It is the rule a
  // shared corridor obeys about the recipient's avoid list: a share may carry a
  // report shape, never a decision about what may speak.
  read: "new-eden-atlas-read-v1",
  panels: "new-eden-atlas-panels-v1",
  // The contact route sent in `X-User-Agent`, empty unless somebody deploying this
  // sets one. Kept here rather than in `esi.js` so the one list of storage keys
  // stays the one list; read at startup and handed to `setContactRoute`.
  //
  // Deliberately not a field in the interface: a pilot has no reason to nominate a
  // contact for an application, and whoever publishes a build is not sitting in
  // front of the map when they decide it.
  contact: "new-eden-atlas-contact-v1",
};
