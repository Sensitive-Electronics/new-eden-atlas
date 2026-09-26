// What the pilot knows that no API does.
//
// A bridge can be out of fuel, unanchored, or lost with the alliance that owned
// it. A gate can be bubbled. A system can be camped. None of that is in the SDE
// and most of it is in no API at all, so the person flying is the only source -
// and the tool has to let them say so without making them explain which of
// those things happened.
//
// So: one mechanism, three targets, one verb. Ignore a system, a gate or a
// bridge, for a day, a week, or until you say otherwise. It is the same idea as
// EVE's own autopilot avoidance list, with an expiry, and the avoid list feeds
// into it rather than sitting beside it as a second thing to maintain.
//
// Two rules that matter more than they look:
//
// **Ignoring is not deleting.** An ignored edge stays on the map, drawn dead.
// A link that silently disappears becomes a mystery detour three weeks later,
// when nobody remembers marking it and the route just looks wrong.
//
// **A lapsed ignore restores silently.** No notification, no confirmation. The
// point of the timer is that the pilot does not have to come back and tidy up;
// asking them to acknowledge the tidying would defeat it.
//
// Deliberately NOT modelled: per-character ignores. An Ansiblex ACL is
// alliance-only since the September 2026 update, so in practice one pilot's
// bridges are every pilot's bridges in that alliance. A character in a second
// alliance, or a corp that leaves one, would want its own list - and that is a
// real edge case that is being skipped on purpose, because the cost is a
// per-character store and a character switcher in every one of these calls, and
// the benefit is an account shape most pilots do not have.

export const DURATIONS = {
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  permanent: null,
};

// "wormhole" is its own target rather than being folded into "bridge".
//
// To the graph a scanned hole and an alliance bridge are the same thing: one
// undirected edge. To a pilot they are entirely different promises. **The target
// name is what an override is looked up under**, so it has to be the name the
// router reports the leg as, or an ignored link is crossed in silence when there
// is no way around it.
export const TARGETS = ["system", "gate", "bridge", "wormhole", "region"];

// EVE's own avoidance list is soft: the autopilot routes around an avoided
// system when it can, and through it when there is no alternative. That is what
// muscle memory expects, so it is the default here too.
//
// Hard is for things that are not merely unwanted but impossible or fatal - an
// unanchored bridge, a gate you will die on. A hard entry is never traversed
// and a route through it simply does not exist.
//
// Edges are hard by default and systems are soft, because the two are different
// claims: an ignored bridge is usually gone, while an avoided system is usually
// just somewhere you would rather not be.
export const STRENGTHS = ["hard", "soft"];

export function defaultStrength(target) {
  return target === "system" || target === "region" ? "soft" : "hard";
}

// How much a route should trust a link, used only to break ties between routes
// of equal length. Higher is better.
//
// **Only what `trustOf` can return.** A tier nothing produces is a claim about how
// the router weighs a link, and a reader cannot tell an aspiration from a rule by
// reading the table. A tier belongs beside the code that can return it.
export const TRUST = {
  confirmed: 3,  // the pilot says they just used it
  unknown: 0,    // never confirmed either way
};

// Edges are undirected, so the key must be too, or ignoring a gate in one
// direction leaves it open in the other.
export function edgeKey(a, b) {
  const left = Number(a);
  const right = Number(b);
  // Anything non-numeric collapses to "NaN-NaN", so every such mistake collides
  // into one entry matching no real edge - silently. Passing names instead of ids
  // is the easy way to do it. Finite is not enough either: `Number(null)` and
  // `Number("")` are both 0, and no system id is zero or negative.
  if (!Number.isInteger(left) || !Number.isInteger(right) || left <= 0 || right <= 0) {
    throw new Error(`An edge key needs two system ids, not ${JSON.stringify(a)} and ${JSON.stringify(b)}.`);
  }
  return left < right ? `${left}-${right}` : `${right}-${left}`;
}

export function createStore() {
  return { entries: new Map() };
}

function entryKey(target, key) {
  return `${target}:${key}`;
}

// `duration` is a name from DURATIONS, or a number of milliseconds. "permanent"
// stores no expiry at all rather than one far in the future, so a list can show
// "until removed" honestly instead of a date decades away.
export function setOverride(store, { target, key, state = "ignored", duration = "day", now = Date.now(), strength = null, reason = "", source = "manual" }) {
  if (!TARGETS.includes(target)) throw new Error(`Unknown override target: ${target}`);
  if (state !== "ignored" && state !== "confirmed") throw new Error(`Unknown override state: ${state}`);

  const span = typeof duration === "number" ? duration : DURATIONS[duration];
  if (span !== null && !(span > 0)) throw new Error(`Unusable override duration: ${duration}`);

  const chosen = strength === null ? defaultStrength(target) : strength;
  if (!STRENGTHS.includes(chosen)) throw new Error(`Unknown override strength: ${strength}`);

  store.entries.set(entryKey(target, key), {
    target,
    key: String(key),
    state,
    strength: chosen,
    // Optional, and free text on purpose: "bubbled", "camp", "fuel out". The
    // tool does not need to understand why, only that the pilot said so.
    reason: String(reason ?? ""),
    source,
    setAt: now,
    expiresAt: span === null ? null : now + span,
  });
  return store;
}

export function clearOverride(store, target, key) {
  return store.entries.delete(entryKey(target, key));
}

function isLive(entry, now) {
  return entry.expiresAt === null || entry.expiresAt > now;
}

// A lapsed entry is simply absent. Nothing announces the restoration, which is
// the whole point of giving it an expiry.
export function activeOverride(store, target, key, now = Date.now()) {
  const entry = store?.entries?.get(entryKey(target, key));
  if (!entry) return null;
  return isLive(entry, now) ? entry : null;
}

export function isIgnored(store, target, key, now = Date.now()) {
  return activeOverride(store, target, key, now)?.state === "ignored";
}

// Never traversable.
export function isBlocked(store, target, key, now = Date.now()) {
  const entry = activeOverride(store, target, key, now);
  return entry?.state === "ignored" && entry.strength === "hard";
}

// Traversable, but only when there is no other way - and the route has to say
// it did.
export function isDiscouraged(store, target, key, now = Date.now()) {
  const entry = activeOverride(store, target, key, now);
  return entry?.state === "ignored" && entry.strength === "soft";
}

// The inverse of ignoring: the pilot just flew it, so it is known good. Used
// for tie-breaking, never to override an avoid list - confirming a gate does
// not mean you want to be routed through a system you asked to avoid.
export function confirmUp(store, target, key, { duration = "day", now = Date.now() } = {}) {
  return setOverride(store, { target, key, state: "confirmed", duration, now });
}

export function trustOf(store, target, key, { now = Date.now(), fallback = TRUST.unknown } = {}) {
  const entry = activeOverride(store, target, key, now);
  if (!entry) return fallback;
  if (entry.state === "confirmed") return TRUST.confirmed;
  return TRUST.unknown;
}

// Everything still in force, newest first, with what a list needs to show.
// Lapsed entries are not returned, so the list cannot fill with things that
// stopped applying.
export function listOverrides(store, now = Date.now()) {
  return [...(store?.entries?.values() ?? [])]
    .filter(entry => isLive(entry, now))
    .map(entry => ({
      ...entry,
      permanent: entry.expiresAt === null,
      strength: entry.strength ?? defaultStrength(entry.target),
      remainingMs: entry.expiresAt === null ? null : entry.expiresAt - now,
    }))
    .sort((a, b) => b.setAt - a.setAt);
}

// Housekeeping, safe to call whenever. Returns how many lapsed entries went, so
// a caller can tell whether anything changed without diffing the list.
export function pruneOverrides(store, now = Date.now()) {
  let removed = 0;
  for (const [key, entry] of [...(store?.entries ?? [])]) {
    if (!isLive(entry, now)) {
      store.entries.delete(key);
      removed += 1;
    }
  }
  return removed;
}

export function describeRemaining(remainingMs) {
  if (remainingMs === null) return "until removed";
  if (remainingMs <= 0) return "expired";
  const minutes = Math.ceil(remainingMs / 60000);
  if (minutes < 60) return `${minutes}m left`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m left`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h left`;
}

// --- serialisation -----------------------------------------------------------
// Stored with absolute expiry times rather than durations, so a store reloaded
// a week later shows what actually lapsed rather than restarting every timer.

export function toJSON(store) {
  return { version: 1, entries: [...(store?.entries?.values() ?? [])] };
}

export function fromJSON(data) {
  const store = createStore();
  const entries = Array.isArray(data?.entries) ? data.entries : [];
  for (const entry of entries) {
    if (!entry || !TARGETS.includes(entry.target) || entry.key === undefined) continue;
    if (entry.state !== "ignored" && entry.state !== "confirmed") continue;
    const expiresAt = entry.expiresAt === null || Number.isFinite(entry.expiresAt) ? entry.expiresAt : undefined;
    if (expiresAt === undefined) continue;
    store.entries.set(entryKey(entry.target, entry.key), {
      target: entry.target,
      key: String(entry.key),
      state: entry.state,
      strength: STRENGTHS.includes(entry.strength) ? entry.strength : defaultStrength(entry.target),
      reason: String(entry.reason ?? ""),
      source: entry.source ?? "manual",
      setAt: Number.isFinite(entry.setAt) ? entry.setAt : 0,
      expiresAt,
    });
  }
  return store;
}
