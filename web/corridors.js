// Named operational corridors: saved route definitions a fleet or corporation
// can keep, recall and share.
//
// A corridor stores the DEFINITION of a route, never a computed path. The
// stargate graph is regenerated from the SDE, and a stored path would silently
// become a claim about a topology that no longer exists. Recalling a corridor
// re-runs the solver against the current archive, so a corridor is always
// either correct or visibly broken, never quietly stale.

export const CORRIDOR_KEY = "new-eden-atlas-corridors-v1";
export const CORRIDOR_LIMIT = 200;
export const NAME_LIMIT = 60;

const FIELD_DEFAULTS = {
  from: "",
  to: "",
  mode: "shortest",
  avoidSystems: "",
  avoidRegions: "",
  minSecurity: "",
  maxSecurity: "",
};

// Only a string is a string. Coercing an object to "[object Object]", or an array
// to its single element, accepts a record the caller never wrote, and a coerced
// value can pass a membership test the original would have failed.
function text(value) {
  if (typeof value === "string") return value.trim();
  if (value === undefined || value === null) return "";
  if (typeof value === "number" || typeof value === "boolean") return String(value).trim();
  return null;
}

const FIELD_LIMIT = 400;

export function corridorKey(name) {
  // NFC so two visually identical names key identically, and toLowerCase
  // rather than toLocaleLowerCase so the host locale cannot merge distinct
  // names or split equal ones.
  return String(name ?? "").normalize("NFC").trim().toLowerCase();
}

// Throws rather than repairing. A corridor that silently loses its avoid list
// or its destination is worse than one that refuses to save.
export function normalizeCorridor(value, modes = ["shortest"]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Not a corridor record.");
  }

  const name = text(value.name);
  if (name === null) throw new Error("A corridor name must be text.");
  if (!name) throw new Error("A corridor must have a name.");
  if (name.length > NAME_LIMIT) throw new Error(`Corridor name "${name.slice(0, 20)}..." is longer than ${NAME_LIMIT} characters.`);

  const record = { name };
  for (const [field, fallback] of Object.entries(FIELD_DEFAULTS)) {
    if (value[field] === undefined) {
      record[field] = fallback;
      continue;
    }
    const converted = text(value[field]);
    if (converted === null) throw new Error(`Corridor "${name}" has a non-text ${field}.`);
    if (converted.length > FIELD_LIMIT) {
      throw new Error(`Corridor "${name}" has a ${field} longer than ${FIELD_LIMIT} characters.`);
    }
    record[field] = converted;
  }

  if (!record.from) throw new Error(`Corridor "${name}" has no origin.`);
  if (!record.to) throw new Error(`Corridor "${name}" has no destination.`);
  if (!modes.includes(record.mode)) {
    throw new Error(`Corridor "${name}" uses an unknown routing mode "${record.mode}".`);
  }

  // Held to the same limit as every other field. Nothing reads it as a date, so a
  // bad one is cosmetic - but "every field is bounded" is a rule only if it has no
  // exceptions, and this one arrives from an imported file.
  const saved = text(value.saved);
  record.saved = saved && saved.length <= FIELD_LIMIT ? saved : new Date().toISOString();
  return record;
}

export function readCorridors(storage, modes) {
  let raw = null;
  try {
    raw = storage.getItem(CORRIDOR_KEY);
  } catch {
    return [];
  }
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Stored records are our own, so a single bad entry is dropped rather than
    // taking the whole list down with it.
    return parsed.flatMap(entry => {
      try {
        return [normalizeCorridor(entry, modes)];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

export function writeCorridors(storage, list) {
  try {
    storage.setItem(CORRIDOR_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

export function upsertCorridor(list, corridor) {
  const key = corridorKey(corridor.name);
  const next = list.filter(entry => corridorKey(entry.name) !== key);
  if (next.length >= CORRIDOR_LIMIT) {
    throw new Error(`Corridor list is full at ${CORRIDOR_LIMIT} entries. Remove one first.`);
  }
  next.push(corridor);
  return sortCorridors(next);
}

export function removeCorridor(list, name) {
  const key = corridorKey(name);
  return list.filter(entry => corridorKey(entry.name) !== key);
}

export function findCorridor(list, name) {
  const key = corridorKey(name);
  return list.find(entry => corridorKey(entry.name) === key) ?? null;
}

export function sortCorridors(list) {
  return [...list].sort((a, b) => a.name.localeCompare(b.name));
}

// An imported file comes from outside, so every entry must be valid or the
// whole import is refused. A partial import would leave the pilot believing
// they hold a corridor set they do not have.
export function parseCorridorFile(content, modes) {
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`Corridor file is not valid JSON: ${error.message}`);
  }

  const entries = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.corridors) ? parsed.corridors : null;
  if (!entries) throw new Error("Corridor file must contain an array of corridors.");
  if (!entries.length) throw new Error("Corridor file contains no corridors.");

  const seen = new Set();
  return entries.map((entry, index) => {
    let record;
    try {
      record = normalizeCorridor(entry, modes);
    } catch (error) {
      throw new Error(`Corridor file, entry ${index + 1} of ${entries.length}: ${error.message}`);
    }
    const key = corridorKey(record.name);
    if (seen.has(key)) throw new Error(`Corridor file names "${record.name}" more than once.`);
    seen.add(key);
    return record;
  });
}

export function mergeCorridors(list, incoming) {
  let added = 0;
  let updated = 0;
  let next = list;
  for (const corridor of incoming) {
    if (findCorridor(next, corridor.name)) updated += 1;
    else added += 1;
    next = upsertCorridor(next, corridor);
  }
  return { list: next, added, updated };
}

export function corridorFile(list) {
  return JSON.stringify({ format: CORRIDOR_KEY, exported: new Date().toISOString(), corridors: list }, null, 2);
}
