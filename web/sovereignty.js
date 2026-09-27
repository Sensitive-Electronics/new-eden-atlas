// Sovereignty: who holds what, and where one alliance's space ends.
//
// The cheapest live layer there is. `/sovereignty/map` is public, needs no
// authentication, returns all 8,490 systems in one call and caches for an hour.
// It is also the thing people reflexively open DOTLAN for, and "where does this
// alliance's space end and that one's begin" is the border-recon question this
// project exists to answer.
//
// Stored as sightings rather than as a snapshot, per the store law, and that is
// not a formality here - it is what makes the layer worth having. The endpoint
// returns the whole map every hour and almost nothing moves, so a snapshot
// store would rewrite 8,490 rows hourly to record nothing, while a sighting log
// adds rows only for what actually changed hands. The log is also the feature:
// who took what, when, and how a border moved over a month.
//
// Only alliance-held systems are observed. Faction space does not change and
// belongs in the archive, not in a log of things that might; and a system
// dropping out of the response is a system that lost sovereignty, which the
// sync closes with a date.

import { fetchEsi } from "./esi.js";
import { confirmAll, openForSource, openObservations, positiveId, recognisedNothing, syncAll } from "./sightings.js";

export const SOV_KIND = "sovereignty";
// Faction-held space, kept as its own kind. It is not alliance sovereignty and
// must never be mixed in with it, but it has to be observed rather than
// ignored: without it a null-security system bordering empire or NPC null
// looks identical to one bordering genuinely unclaimed space, and those are
// different tactical facts. It also does change - Pochven happened.
export const FACTION_KIND = "sovereignty-faction";
export const SOV_SOURCE = "public:sovereignty-map";
export const SOV_PATH = "/sovereignty/map/";

// Pull the map and fold it into the store. Returns what changed, so a caller
// can say "nothing moved" rather than implying it looked and found nothing.
//
// Never throws: a failed sync leaves the store exactly as it was, and the last
// sighting keeps its own age.
export async function syncSovereignty(store, { fetchImpl = null, cached = null, now = Date.now() } = {}) {
  const result = await fetchEsi(SOV_PATH, { cached, fetchImpl, now });
  if (!result.ok) return { ok: false, result, changes: null };

  // A 304 means the map is unchanged, so there is nothing to fold in - but
  // everything open is still confirmed as of now, which is what keeps
  // last_confirmed honest without appending anything.
  if (result.notModified && !result.data) {
    // Unchanged means confirmed, not ignored. See confirmAll in sightings.js.
    const confirmed = confirmAll(store, SOV_KIND, { source: SOV_SOURCE, now });
    return { ok: true, result, changes: null, unchanged: true, confirmed };
  }

  // A 200 carrying something that is not a list of systems is a failed sync,
  // not an empty map. JSON null and {} both arrive as HTTP 200 from a proxy or
  // a captive portal, and treating either as "nothing is held" would close
  // every sovereignty holding in New Eden and write that sweep into the
  // permanent history.
  if (!Array.isArray(result.data)) {
    return {
      ok: false,
      result: { ...result, ok: false, reason: "malformed", detail: "Sovereignty map was not a list." },
      changes: null,
    };
  }

  // **An empty list is not an empty universe, for a whole-map endpoint.**
  //
  // The guard above catches `null` and `{}`. It does not catch `[]`, because `[]`
  // *is* a list - and `recognisedNothing` below cannot catch it either, since it
  // requires `payload.length > 0` by design: for incursions, campaigns and scout an
  // empty list is a real answer, and refusing it would be the opposite mistake.
  //
  // `/sovereignty/map/` is not that kind of endpoint. It returns the entire map
  // every time, thousands of rows, and has no legitimate empty answer. A CDN edge,
  // a captive portal or a datasource hiccup serving `[]` with a 200 would otherwise
  // reach `syncAll` with nothing held, closing every sovereignty window in New Eden
  // and writing that sweep into the permanent log, dated. The next good sync
  // reopens them all with a fresh `firstSeen`, so "who holds this, and since when"
  // would be destroyed for the whole cluster, and nothing a pilot can do undoes
  // it.
  if (result.data.length === 0) {
    return {
      ok: false,
      result: { ...result, ok: false, reason: "malformed", detail: "Sovereignty map arrived empty, which this endpoint never is." },
      changes: null,
    };
  }

  // **A row is recognised when its key parses, not when its value does.** A key
  // that arrives as `undefined` - which is all an upstream rename of `system_id`
  // takes - gathers every row under one slot and closes every other holding in New
  // Eden, dated. `recognisedNothing` cannot fire on it, because from its point of
  // view every row was understood.
  //
  // This is the layer with the most to lose: "who held this, and since when" has no
  // second source.
  const held = result.data
    .filter(row => row && row.alliance_id && positiveId(row.system_id) !== null)
    .map(row => ({
      key: positiveId(row.system_id),
      value: {
        alliance_id: row.alliance_id,
        corporation_id: row.corporation_id ?? null,
      },
    }));

  // Faction space, separately, so a frontier can be told from a border with
  // empire or NPC null.
  const faction = result.data
    .filter(row => row && !row.alliance_id && row.faction_id && positiveId(row.system_id) !== null)
    .map(row => ({ key: positiveId(row.system_id), value: { faction_id: row.faction_id } }));

  // A list of rows none of which parsed is schema drift, not an empty world.
  if (recognisedNothing(result.data, held.length + faction.length)) {
    return {
      ok: false,
      result: { ...result, ok: false, reason: "malformed", detail: "Sovereignty arrived in a shape this build does not recognise." },
      changes: null,
    };
  }

  const changes = syncAll(store, SOV_KIND, held, { source: SOV_SOURCE, now });
  const factionChanges = syncAll(store, FACTION_KIND, faction, { source: SOV_SOURCE, now });
  const quiet = entry => entry.opened.length === 0 && entry.changed.length === 0 && entry.closed.length === 0;
  return { ok: true, result, changes, factionChanges, unchanged: quiet(changes) && quiet(factionChanges) };
}

// Who holds this system, as of a moment. Null means no alliance held it -
// which is different from "we do not know", and a caller that has never synced
// should say so rather than drawing an empty map as if it were an answer.
// **One source, named.** Sovereignty has exactly one, the public map. A read across
// every source answers null for a system `heldSystems` still lists, and those two
// are the map ring and the sovereignty bar.
export function holderOf(store, systemId, at = Infinity) {
  return openForSource(store, SOV_KIND, systemId, SOV_SOURCE, at)?.value ?? null;
}

export function factionSystems(store) {
  const held = new Map();
  for (const entry of openObservations(store, FACTION_KIND, { source: SOV_SOURCE })) {
    held.set(Number(entry.key), { ...entry.value, since: entry.firstSeen, lastConfirmed: entry.lastConfirmed });
  }
  return held;
}

// Filtered to the same one source `holderOf` reads, so the two cannot disagree.
// Unfiltered it collapses two sources into one entry per system by writing the
// later over the earlier, which is a silent choice of whose observation counts.
export function heldSystems(store) {
  const held = new Map();
  for (const entry of openObservations(store, SOV_KIND, { source: SOV_SOURCE })) {
    held.set(Number(entry.key), { ...entry.value, since: entry.firstSeen, lastConfirmed: entry.lastConfirmed });
  }
  return held;
}

export function holdingsOf(store, allianceId) {
  const wanted = Number(allianceId);
  return [...heldSystems(store)].filter(([, value]) => value.alliance_id === wanted).map(([id]) => id);
}

// Where one alliance's space ends.
//
// A system is a border if it is held and at least one of its gate neighbours is
// held by somebody else, or by nobody. Both cases matter and they are different
// facts: a contested boundary is where two alliances meet, while a frontier is
// where sovereignty runs out into unclaimed space.
export function borders(atlas, store) {
  const held = heldSystems(store);
  const faction = factionSystems(store);
  const contested = [];
  const frontier = [];
  const empire = [];

  for (const [systemId, holding] of held) {
    const system = atlas.systems[String(systemId)];
    if (!system) continue;

    const neighbours = system.neighbors
      .map(id => ({ id, system: atlas.systems[String(id)], holding: held.get(Number(id)) ?? null }))
      .filter(entry => entry.system);

    const others = neighbours.filter(entry => entry.holding && entry.holding.alliance_id !== holding.alliance_id);
    // Three kinds of "not ours", not two. A neighbour held by a faction is empire
    // or NPC null and can never be taken; one held by nobody at all is claimable
    // space. Calling both "frontier" tells a very different story about where an
    // alliance can expand.
    const factionOwned = neighbours.filter(entry => !entry.holding && faction.has(Number(entry.id)));
    const unheld = neighbours.filter(entry => !entry.holding && !faction.has(Number(entry.id)));

    if (others.length) {
      contested.push({
        system,
        holding,
        facing: [...new Set(others.map(entry => entry.holding.alliance_id))],
        neighbours: others.map(entry => entry.system),
      });
    }
    if (unheld.length) {
      frontier.push({ system, holding, neighbours: unheld.map(entry => entry.system) });
    }
    if (factionOwned.length) {
      empire.push({
        system,
        holding,
        neighbours: factionOwned.map(entry => entry.system),
        factions: [...new Set(factionOwned.map(entry => faction.get(Number(entry.id)).faction_id))],
      });
    }
  }

  return { contested, frontier, empire, heldCount: held.size, factionCount: faction.size };
}

// Systems where two named alliances actually touch. The border-recon question
// in its most direct form.
export function frontBetween(atlas, store, allianceA, allianceB) {
  const a = Number(allianceA);
  const b = Number(allianceB);
  const held = heldSystems(store);
  const front = [];
  for (const [systemId, holding] of held) {
    if (holding.alliance_id !== a) continue;
    const system = atlas.systems[String(systemId)];
    if (!system) continue;
    const touching = system.neighbors
      .map(id => ({ id: Number(id), holding: held.get(Number(id)) ?? null }))
      .filter(entry => entry.holding?.alliance_id === b)
      .map(entry => atlas.systems[String(entry.id)]);
    if (touching.length) front.push({ system, touching });
  }
  return front;
}

// A stable colour per alliance, so the map does not reshuffle between loads and
// the same alliance is the same colour in every session. Hue only - saturation
// and lightness are fixed so no alliance gets a colour that reads as more
// important than another, the same rule the gate-line channels follow.
export function allianceColour(allianceId) {
  const id = Number(allianceId) || 0;
  // A cheap integer hash, spread around the wheel by a number coprime with 360.
  const hue = (Math.abs(Math.imul(id, 2654435761)) % 360);
  return `hsl(${hue} 55% 45%)`;
}
