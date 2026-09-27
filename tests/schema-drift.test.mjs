// What happens when a live endpoint answers in a shape this build does not know.
//
// Every sighting layer guarded its response with `Array.isArray(result.data)`,
// and that guard is real but it is not the dangerous case. It catches a reply
// that is not a list at all - JSON null, `{}`, a captive portal's login page -
// and those do happen. What it cannot catch is a perfectly well-formed list of
// rows none of which this build understands, which is what schema drift looks
// like: `alliance_id` becomes `allianceId`, an ISO timestamp becomes an epoch
// number, a field moves one level down. Every row then fails its per-layer
// filter, the mapped list comes back empty, and an empty list is a legitimate
// answer in four of these five layers - "nothing is held", "nothing is being
// fought over", "no incursions", "no holes scanned".
//
// So syncAll closed every open observation for that source, wrote the sweep
// into the permanent log with today's date, and the sync returned ok. The live
// bar would have read "synced just now" over a map with no sovereignty on it.
//
// That is worse than a crash, which is the reason this file exists. A crash
// leaves yesterday's intelligence on screen with yesterday's age against it;
// this replaces it with a confident, dated, permanent false all-clear - and
// "gone is closed, never deleted" means the closure survives the correction.
//
// The rows below are drift, not garbage: each is a plausible next version of
// the endpoint, which is the point. Garbage would have been caught.

import { suite } from "./helpers.mjs";
import { createSightings, openObservations, recognisedNothing } from "../web/sightings.js";
import { SOV_KIND, syncSovereignty } from "../web/sovereignty.js";
import { CAMPAIGN_KIND, syncCampaigns } from "../web/campaigns.js";
import { FW_KIND, INCURSION_KIND, syncFactionWarfare, syncIncursions } from "../web/ambient.js";
import { SCOUT_KIND, syncScout } from "../web/eve-scout.js";

const T = n => Date.parse("2026-09-01T00:00:00Z") + n * 3_600_000;
const headers = map => ({ get: name => map[name.toLowerCase()] ?? null });
const respond = rows => async () => ({
  ok: true,
  status: 200,
  headers: headers({ expires: new Date(T(24)).toUTCString() }),
  json: async () => rows,
});

export default function run() {
  const t = suite("schema drift");

  return (async () => {
    // --- the helper, on its own ---------------------------------------------------
    t.check(recognisedNothing([{ a: 1 }], 0), "rows in, nothing recognised out, is drift");
    t.check(!recognisedNothing([], 0), "an empty payload is an empty answer, not drift");
    t.check(!recognisedNothing([{ a: 1 }], 1), "a payload we understood is not drift");
    t.check(!recognisedNothing(null, 0), "and a non-list is the other guard's business");

    // Each layer: a good sync, then a drifted one, then the proof that the
    // drifted sync neither closed anything nor claimed success.
    const layers = [
      {
        name: "sovereignty",
        key: "system_id",
        // The one endpoint here that returns the whole map rather than a list
        // of events, so an empty answer is not an answer.
        wholeMap: true,
        kind: SOV_KIND,
        sync: syncSovereignty,
        good: [{ system_id: 30000142, alliance_id: 99005338, corporation_id: 98000001 }],
        // The casing convention changes, as it has on other CCP endpoints.
        drift: [{ systemId: 30000142, allianceId: 99005338, corporationId: 98000001 }],
      },
      {
        name: "campaigns",
        key: "campaign_id",
        kind: CAMPAIGN_KIND,
        sync: syncCampaigns,
        good: [{
          campaign_id: 7001, event_type: "ihub_defense", constellation_id: 20000020,
          solar_system_id: 30000142, defender_id: 99005338, start_time: "2026-09-01T12:00:00Z",
          attackers_score: 0.4, defender_score: 0.6,
        }],
        drift: [{
          campaignId: 7001, eventType: "ihub_defense", constellationId: 20000020,
          solarSystemId: 30000142, defenderId: 99005338, startTime: 1788000000000,
        }],
      },
      {
        name: "incursions",
        key: "constellation_id",
        kind: INCURSION_KIND,
        sync: syncIncursions,
        good: [{
          constellation_id: 20000020, faction_id: 500019, state: "mobilizing",
          staging_solar_system_id: 30000142, has_boss: false,
          influence: 0.5, infested_solar_systems: [30000142],
        }],
        drift: [{
          constellationId: 20000020, factionId: 500019, state: "mobilizing",
          stagingSolarSystemId: 30000142, hasBoss: false,
          influence: 0.5, infestedSolarSystems: [30000142],
        }],
      },
      {
        name: "faction warfare",
        key: "solar_system_id",
        kind: FW_KIND,
        sync: syncFactionWarfare,
        // **One row per warzone system, contested or not** - measured at 160.
        // There is no empty answer, so `[]` is a broken response, and believing
        // it closed every frontline and dated the sweep. This was found and
        // fixed for sovereignty while its neighbour in the same file kept it,
        // because the guard above `syncIncursions` reasons correctly that
        // *incursions* may be empty and this inherited that by proximity.
        wholeMap: true,
        good: [{
          solar_system_id: 30000142, owner_faction_id: 500001, occupier_faction_id: 500004,
          contested: "contested", victory_points: 1000, victory_points_threshold: 3000,
        }],
        drift: [{
          solarSystemId: 30000142, ownerFactionId: 500001, occupierFactionId: 500004,
          contested: "contested", victoryPoints: 1000, victoryPointsThreshold: 3000,
        }],
      },
      {
        name: "eve-scout",
        // A signature id is an opaque string from a third party, not an EVE id,
        // so `false` legitimately becomes the id "false" and is kept. Only the
        // spellings that leave nothing to file under are refused.
        key: "id",
        unusableKeys: [null, "", "   "],
        kind: SCOUT_KIND,
        sync: syncScout,
        good: [{
          id: "sig-1", signature_type: "wormhole", out_system_id: 31000005,
          in_system_id: 30000142, expires_at: "2026-09-02T00:00:00Z",
          max_ship_size: "large", wh_exits_outward: true,
        }],
        // The v2 endpoint growing a v3 envelope, with the fields one level down.
        drift: [{ id: "sig-1", type: "wormhole", signature: { outSystemId: 31000005, inSystemId: 30000142 } }],
      },
    ];

    for (const layer of layers) {
      const store = createSightings();
      const first = await layer.sync(store, { fetchImpl: respond(layer.good), now: T(0) });
      const openAfterGood = openObservations(store, layer.kind).length;
      t.check(first.ok && openAfterGood > 0,
        `${layer.name}: a response this build understands opens an observation`);

      const drifted = await layer.sync(store, { fetchImpl: respond(layer.drift), now: T(1) });
      t.check(!drifted.ok, `${layer.name}: a drifted response is a failed sync, not an empty world`);
      t.equal(drifted.result?.reason, "malformed", `${layer.name}: and says why`);
      t.equal(openObservations(store, layer.kind).length, openAfterGood,
        `${layer.name}: nothing was closed on the strength of a payload we could not read`);

      // The part that cannot be undone. A closure is dated and kept, so a sweep
      // written here would outlive the fix.
      const closures = store.observations?.filter?.(o => o.kind === layer.kind && o.closedAt !== null) ?? [];
      t.equal(closures.length, 0, `${layer.name}: and nothing was written into the permanent log`);

      // --- a 304 confirms what it did not resend --------------------------------
      // Asking conditionally is the whole reason an etag exists: "unchanged"
      // is a statement that everything in the last answer is still true. Five
      // layers said so in a comment and returned without touching the store, so
      // last_confirmed froze the moment an etag started matching. ESI answers
      // most sovereignty syncs with a 304, so a holding confirmed hourly for a
      // month recorded the first sync as the last time anyone saw it.
      const reSynced = await layer.sync(store, {
        now: T(3),
        fetchImpl: async () => ({
          ok: true, status: 200, headers: headers({}), json: async () => layer.good,
        }),
      });
      t.check(reSynced.ok, `${layer.name}: a good response reopens the observation`);
      const beforeConfirm = openObservations(store, layer.kind).map(o => o.lastConfirmed);
      // **With the etag that was sent**, because that is the only way a 304
      // arises. This omitted `cached`, so the request carried no
      // `If-None-Match` and the 304 was an answer to a question nobody asked -
      // and `fetchEsi` believed it. A reverse proxy or captive portal answering
      // 304 to everything therefore kept the entire sighting log "confirmed
      // just now" having observed nothing, which is this project's law in the
      // mirror: absence of observation written as *presence*. The decision the
      // comment above states is unchanged; the fixture now sends what the
      // application sends.
      const conditionally = { etag: 'W/"held"', data: layer.good, dataAt: T(3), fetchedAt: T(3) };
      const notModified = await layer.sync(store, {
        now: T(9),
        cached: conditionally,
        fetchImpl: async () => ({ ok: false, status: 304, headers: headers({}), json: async () => null }),
      });
      t.check(notModified.ok && notModified.unchanged, `${layer.name}: a 304 is a success carrying nothing new`);
      const afterConfirm = openObservations(store, layer.kind).map(o => o.lastConfirmed);
      t.check(afterConfirm.length > 0 && afterConfirm.every(at => at === T(9)),
        `${layer.name}: and it advances last_confirmed, which is what it is a confirmation of`);
      t.check(beforeConfirm.every(at => at < T(9)),
        `${layer.name}: from the older instant it had before`);
      t.equal(openObservations(store, layer.kind).length, afterConfirm.length,
        `${layer.name}: without appending an observation, because nothing was resent`);

      // The other half of the guard, and **it depends on what the endpoint is.**
      //
      // For a list of events - incursions, campaigns, faction warfare, scout
      // signatures - an empty list is a real answer: there are none right now,
      // and refusing it would be the opposite mistake, leaving yesterday's
      // incursion open for ever.
      //
      // `/sovereignty/map/` is not that. It returns the entire map every time,
      // thousands of rows, and has no legitimate empty answer - so `[]` from a
      // CDN edge or a captive portal would close every sovereignty window in
      // New Eden and write that sweep into the permanent log, dated, with the
      // next good sync reopening them all on a fresh `firstSeen`. "Who holds
      // this, and since when" is the layer, and nothing a pilot can do undoes
      // it.
      //
      // This loop asserted the event-list rule over all five layers, which is
      // how the whole-map one came to be treated as an event list - the same
      // over-generalisation that had `recognisedNothing` guarding it, a
      // function that cannot fire on an empty payload by design.
      // **A row whose key does not parse is not a recognised row**, and four
      // layers tested it with `Number.isFinite(Number(x))` - which is `true` for
      // `null`, `""`, `false` and `[]`, every one of which is `Number` `0`. So a
      // proxy nulling one field, or drift renaming it, produced rows that
      // "parsed", counted as recognised, and collapsed onto the single key `0`
      // while every real observation was closed and dated. `recognisedNothing`
      // cannot help: from its point of view every row was understood.
      //
      // Sovereignty was worse than the other three - it validated no key at all
      // and gathered the whole cluster under `String(undefined)`.
      //
      // Asserted per layer, from the table, so a sixth cannot arrive without it.
      // `unusableKeys` is per layer because the key's *type* is: four of these
      // are EVE ids and one is an opaque string.
      for (const unusable of layer.unusableKeys ?? [null, "", false, []]) {
        const bent = layer.good.map((row) => ({ ...row, [layer.key]: unusable }));
        const outcome = await layer.sync(store, { fetchImpl: respond(bent), now: T(2) });
        t.check(!outcome.ok,
          `${layer.name}: a row keyed ${JSON.stringify(unusable)} is refused rather than filed under zero`);
        t.check(openObservations(store, layer.kind).length > 0,
          `${layer.name}: and nothing it had recorded was closed by it`);
      }

      // A 304 nobody asked for is a broken response, not a confirmation.
      // Nothing may be confirmed by it, because nothing was observed.
      {
        const beforeUnasked = openObservations(store, layer.kind).map(o => o.lastConfirmed);
        const unasked = await layer.sync(store, {
          now: T(11),
          fetchImpl: async () => ({ ok: false, status: 304, headers: headers({}), json: async () => null }),
        });
        t.check(!unasked.ok,
          `${layer.name}: a 304 with no etag sent is refused rather than believed`);
        t.equal(openObservations(store, layer.kind).map(o => o.lastConfirmed).join(","),
          beforeUnasked.join(","),
          `${layer.name}: and confirms nothing, because nothing was observed`);
      }

      const empty = await layer.sync(store, { fetchImpl: respond([]), now: T(2) });
      if (layer.wholeMap) {
        t.check(!empty.ok, `${layer.name}: an empty whole-map answer is refused, not believed`);
        t.check(openObservations(store, layer.kind).length > 0,
          `${layer.name}: and nothing it had recorded was closed by it`);
      } else {
        t.check(empty.ok, `${layer.name}: an empty list is still a real answer`);
        t.equal(openObservations(store, layer.kind).length, 0,
          `${layer.name}: and it does close what is no longer there`);
      }
    }

    return t.results;
  })();
}
