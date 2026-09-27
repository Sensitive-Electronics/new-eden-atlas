// Ambient state: incursions and faction-warfare frontlines.
//
// Neither changes who owns space the way sovereignty does. Both change whether
// space is safe to cross, which is the only question this map exists to answer,
// and both are public - `/incursions/` and `/fw/systems/` need no token at all.
//
// Read live on 2026-09-18: incursions returns per-constellation records carrying
// the infested systems, and `/fw/systems/` returns one row per warzone system,
// about 160 of them.
//
// A third ambient layer - Triglavian and EDENCOM system status - is **not built,
// because it cannot be.** All 182 ESI paths were searched and there is no endpoint
// for it. Pochven is in the archive as a region, because it is geography now; the
// Fortress and Minor Victory states from the invasion are in neither the export nor
// the API. That is an absence, and it is reported as one rather than approximated.
//
// Stored as sightings, so the layer answers "this system has been contested for
// three days" and not merely "it is contested", and so an incursion that ends
// is closed with a date rather than vanishing.

import { fetchEsi } from "./esi.js";
import { arrivedEmpty, confirmAll, openObservations, positiveId, recognisedNothing, syncAll } from "./sightings.js";

export const INCURSION_KIND = "incursion";
export const FW_KIND = "faction-warfare";
export const INCURSION_SOURCE = "public:incursions";
export const FW_SOURCE = "public:fw-systems";
export const INCURSION_PATH = "/incursions/";
export const FW_PATH = "/fw/systems/";

// Influence and victory points are measurements, not identities, and the store
// law does not fit them unchanged: it records a new window whenever a value
// differs, so a raw influence reading would append a row every few minutes for
// the whole life of an incursion and bury the events worth keeping.
//
// So they are bucketed before they are stored. Five percent is coarse enough to
// cap an incursion's whole history at twenty rows and fine enough to keep the
// thing a fleet commander actually reads out of it - that it was at full
// strength yesterday and is nearly ground out now. The live reading is still
// returned to the caller; it is only the *stored* value that is bucketed, and
// the two are never confused.
export const INFLUENCE_BUCKET = 0.05;

// A reading that is there, in range, or null.
//
// **The test is positive rather than a list of things to exclude.** `Number(" ")`,
// `Number(false)` and `Number([])` are all 0 - an influence of nought, "completely
// ground out", the strongest possible claim made from no information - and
// `Number(true)` is 1, a fully contested system conjured from a boolean.
//
// So: a number, or a string that is one, within the range these readings occupy.
// Every caller here is a fraction - influence, victory-point progress, campaign
// score - and a value outside 0..1 is a misread, not a measurement.
function reading(value, { min = 0, max = 1 } = {}) {
  const number = typeof value === "number" ? value
    : typeof value === "string" && value.trim() !== "" ? Number(value)
      : null;
  if (number === null || !Number.isFinite(number)) return null;
  return number >= min && number <= max ? number : null;
}

export function bucket(value, size = INFLUENCE_BUCKET) {
  const number = reading(value);
  if (number === null) return null;
  // Rounded back to a clean decimal. Math.round(0.97 / 0.05) * 0.05 is
  // 0.9500000000000001 in binary floating point, and a bucket that carries
  // drift is not a bucket - two readings that belong in the same one have to
  // produce the same stored value or the log churns anyway.
  return Number((Math.round(number / size) * size).toFixed(6));
}

function failed(result, detail) {
  return { ok: false, result: { ...result, ok: false, reason: "malformed", detail }, changes: null };
}

// --- incursions ---------------------------------------------------------------
//
// Keyed by constellation, because that is what an incursion is. The infested
// systems are part of the record rather than the key: an incursion does not
// move between systems, and splitting it per system would turn one event into
// ten and lose the fact that they are the same incursion.
export async function syncIncursions(store, { fetchImpl = null, cached = null, now = Date.now() } = {}) {
  const result = await fetchEsi(INCURSION_PATH, { cached, fetchImpl, now });
  if (!result.ok) return { ok: false, result, changes: null };
  if (result.notModified && !result.data) {
    // Unchanged means confirmed, not ignored. See confirmAll in sightings.js.
    const confirmed = confirmAll(store, INCURSION_KIND, { source: INCURSION_SOURCE, now });
    return { ok: true, result, changes: null, unchanged: true, confirmed };
  }

  // An empty list is a real answer here, unlike sovereignty: there are often no
  // incursions at all. A non-list is not, and closing every incursion because a
  // captive portal returned an HTML page would write a false all-clear into the
  // permanent record - which is the direction of error that gets people killed.
  if (!Array.isArray(result.data)) return failed(result, "Incursions were not a list.");

  const seen = result.data
    .filter(row => row && positiveId(row.constellation_id) !== null)
    .map(row => ({
      key: positiveId(row.constellation_id),
      value: {
        faction_id: row.faction_id ?? null,
        state: typeof row.state === "string" ? row.state : "unknown",
        staging_solar_system_id: row.staging_solar_system_id ?? null,
        has_boss: Boolean(row.has_boss),
        influence: bucket(row.influence),
        // `Array.isArray`, not `?? []`. A row whose infested list arrives as a
        // string, an object or a number reaches `.map` and throws a TypeError out
        // of `syncIncursions` - past the caller's ok check, out of the `Promise.all`
        // in `syncLive`, and the whole live sync dies silently. One malformed row
        // costs that row, not every layer on screen.
        systems: [...new Set(
          (Array.isArray(row.infested_solar_systems) ? row.infested_solar_systems : [])
            .map(Number)
            .filter(Number.isFinite),
        )].sort((a, b) => a - b),
      },
    }));

  // A list of rows none of which parsed is schema drift, not an empty world.
  if (recognisedNothing(result.data, seen.length)) {
    return failed(result, "Incursions arrived in a shape this build does not recognise.");
  }

  const changes = syncAll(store, INCURSION_KIND, seen, { source: INCURSION_SOURCE, now });
  const quiet = !changes.opened.length && !changes.changed.length && !changes.closed.length;
  return { ok: true, result, changes, unchanged: quiet };
}

// Every infested system, with the incursion it belongs to. Built once per
// render rather than scanned per system: there are rarely more than a handful
// of incursions, but there are 8,490 systems asking.
export function incursionSystems(store) {
  const infested = new Map();
  // Named, like every read of this log. One public endpoint writes this kind, and
  // an unfiltered read lets a row carrying any other source label overwrite an
  // entry keyed by system.
  for (const entry of openObservations(store, INCURSION_KIND, { source: INCURSION_SOURCE })) {
    const value = entry.value ?? {};
    for (const systemId of value.systems ?? []) {
      infested.set(Number(systemId), {
        constellation_id: Number(entry.key),
        faction_id: value.faction_id ?? null,
        state: value.state ?? "unknown",
        influence: value.influence,
        hasBoss: Boolean(value.has_boss),
        isStaging: Number(systemId) === Number(value.staging_solar_system_id),
        since: entry.firstSeen,
        lastConfirmed: entry.lastConfirmed,
      });
    }
  }
  return infested;
}

export function incursionIn(store, systemId) {
  return incursionSystems(store).get(Number(systemId)) ?? null;
}

export async function syncFactionWarfare(store, { fetchImpl = null, cached = null, now = Date.now() } = {}) {
  const result = await fetchEsi(FW_PATH, { cached, fetchImpl, now });
  if (!result.ok) return { ok: false, result, changes: null };
  if (result.notModified && !result.data) {
    // Unchanged means confirmed, not ignored. See confirmAll in sightings.js.
    const confirmed = confirmAll(store, FW_KIND, { source: FW_SOURCE, now });
    return { ok: true, result, changes: null, unchanged: true, confirmed };
  }
  if (!Array.isArray(result.data)) return failed(result, "Faction warfare systems were not a list.");
  // **`/fw/systems/` has no empty answer.** It returns one row per warzone system
  // whether contested or not - about 160 - so `[]` with a 200 is a broken response,
  // and believing it closes every frontline and dates the sweep. "This system has
  // been contested for three days" is why this layer is a sighting log at all.
  //
  // The guard in `syncIncursions` reasons correctly that incursions may legitimately
  // be empty. That reasoning does not reach here, and the two are in one file.
  if (arrivedEmpty(result.data)) {
    return failed(result, "Faction warfare systems arrived empty, which this endpoint never is.");
  }

  const seen = result.data
    .filter(row => row && positiveId(row.solar_system_id) !== null)
    .map(row => {
      const threshold = Number(row.victory_points_threshold);
      const points = Number(row.victory_points);
      return {
        key: positiveId(row.solar_system_id),
        value: {
          owner_faction_id: row.owner_faction_id ?? null,
          occupier_faction_id: row.occupier_faction_id ?? null,
          contested: typeof row.contested === "string" ? row.contested : "unknown",
          // A fraction rather than a raw count, because thresholds differ
          // between systems and "43,000 points" means nothing without one.
          progress: threshold > 0 && Number.isFinite(points) ? bucket(points / threshold) : null,
        },
      };
    });

  // A list of rows none of which parsed is schema drift, not an empty world.
  if (recognisedNothing(result.data, seen.length)) {
    return failed(result, "Faction warfare systems arrived in a shape this build does not recognise.");
  }

  const changes = syncAll(store, FW_KIND, seen, { source: FW_SOURCE, now });
  const quiet = !changes.opened.length && !changes.changed.length && !changes.closed.length;
  return { ok: true, result, changes, unchanged: quiet };
}

export function frontlineSystems(store) {
  const front = new Map();
  for (const entry of openObservations(store, FW_KIND, { source: FW_SOURCE })) {
    front.set(Number(entry.key), {
      ...entry.value,
      since: entry.firstSeen,
      lastConfirmed: entry.lastConfirmed,
      // Occupied by someone other than the owner: the system has changed hands
      // and not been taken back. A different fact from being fought over now.
      occupied: Boolean(entry.value?.occupier_faction_id
        && entry.value.owner_faction_id
        && entry.value.occupier_faction_id !== entry.value.owner_faction_id),
    });
  }
  return front;
}

// Only what is actually being fought over. A faction-warfare system sitting
// uncontested is a fact about the map; one being ground down is a fact about
// tonight.
export function contestedFrontlines(store) {
  return [...frontlineSystems(store)]
    .filter(([, value]) => value.contested !== "uncontested" && value.contested !== "unknown")
    .map(([systemId, value]) => ({ systemId, ...value }))
    .sort((a, b) => (b.progress ?? 0) - (a.progress ?? 0) || a.systemId - b.systemId);
}

// --- naming and description -------------------------------------------------------
//
// Faction names come from the archive, which carries all 27 from the export.
// Nothing here writes one down: a hand-kept table is data pretending to be
// code, and it goes stale without anything recomputing it.
export function factionName(atlas, factionId) {
  if (factionId === null || factionId === undefined) return null;
  return atlas?.factions?.[String(factionId)]?.name ?? `Faction ${factionId}`;
}

export function describeIncursion(entry, atlas = null) {
  if (!entry) return null;
  const faction = factionName(atlas, entry.faction_id);
  const strength = entry.influence === null || entry.influence === undefined
    ? "influence unknown"
    : `${Math.round(entry.influence * 100)}% influence`;
  const where = entry.isStaging ? "staging system" : "infested";
  return `${faction ?? "Incursion"} · ${entry.state} · ${where} · ${strength}`;
}

export function describeFrontline(entry, atlas = null) {
  if (!entry) return null;
  const owner = factionName(atlas, entry.owner_faction_id);
  const occupier = factionName(atlas, entry.occupier_faction_id);
  const held = entry.occupied ? `${occupier} holds ${owner ? `${owner}'s` : "this"} system` : `${owner ?? "Unclaimed"}`;
  if (entry.contested === "uncontested") return `${held} · uncontested`;
  const progress = entry.progress === null || entry.progress === undefined
    ? ""
    : ` · ${Math.round(entry.progress * 100)}% to threshold`;
  return `${held} · ${entry.contested}${progress}`;
}
