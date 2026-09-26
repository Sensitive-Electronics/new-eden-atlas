// Incursions and faction-warfare frontlines.
//
// Neither changes who owns space. Both change whether space is safe to cross,
// and both are public - no token, no authentication.
//
// The hard part is not the fetch. It is that these endpoints carry two kinds of
// field at once: identities, which the sighting store was built for, and
// measurements, which it was not. Influence and victory points move every few
// minutes, and stored raw they would append a window per sync and bury the
// events worth keeping under a river of readings. So they are bucketed before
// storage, and most of what follows is about that line holding.

import { readArchive, suite } from "./helpers.mjs";
import { bucketScore } from "../web/campaigns.js";
import { createSightings, historyOf, openObservations } from "../web/sightings.js";
import {
  bucket, contestedFrontlines, describeFrontline, describeIncursion, factionName,
  frontlineSystems, incursionIn, incursionSystems, syncFactionWarfare, syncIncursions,
} from "../web/ambient.js";

const headers = map => ({ get: name => map[name.toLowerCase()] ?? null });
const reply = (rows, extra = {}) => async () => ({
  ok: true,
  status: 200,
  headers: headers({ expires: new Date(Date.now() + 300_000).toUTCString(), etag: 'W/"a"', ...extra }),
  json: async () => rows,
});

const incursion = (over = {}) => ({
  constellation_id: 20000526,
  faction_id: 500019,
  has_boss: true,
  infested_solar_systems: [30003616, 30003615, 30003614],
  influence: 1,
  staging_solar_system_id: 30003615,
  state: "mobilizing",
  type: "Incursion",
  ...over,
});

const frontline = (over = {}) => ({
  contested: "contested",
  occupier_faction_id: 500003,
  owner_faction_id: 500002,
  solar_system_id: 30002957,
  victory_points: 0,
  victory_points_threshold: 75000,
  ...over,
});

export default function run() {
  const t = suite("ambient");
  const atlas = readArchive();

  // --- bucketing --------------------------------------------------------------
  t.equal(bucket(1), 1, "a full reading buckets to itself");
  t.equal(bucket(0.97), 0.95, "and a reading rounds to its bucket");
  t.equal(bucket(0.93), 0.95, "from either side");
  t.equal(bucket(null), null, "a missing reading stays missing rather than becoming zero");
  t.equal(bucket(undefined), null, "and so does an absent one");
  t.equal(bucket(""), null, "and an empty one, which Number() also turns into zero");
  t.equal(bucket(0), 0, "while a genuine zero survives, because it is a reading");
  t.equal(bucket("nonsense"), null, "and anything unparseable, rather than NaN reaching the store");

  // --- an incursion ------------------------------------------------------------
  const store = createSightings();

  return (async () => {
    const first = await syncIncursions(store, { fetchImpl: reply([incursion()]) });
    t.check(first.ok, "a live incursion syncs");
    t.equal(first.changes.opened.length, 1, "and opens one record, keyed by constellation");
    t.equal(openObservations(store, "incursion").length, 1,
      "one record, not one per infested system - it is a single incursion");

    const infested = incursionSystems(store);
    t.equal(infested.size, 3, "but every infested system can be asked about");
    t.check(infested.get(30003615).isStaging, "the staging system is marked");
    t.check(!infested.get(30003616).isStaging, "and the others are not");
    t.equal(incursionIn(store, 30000142), null, "a system outside it reports nothing");

    // Measurements must not churn the log. An incursion grinding from 1.00 to
    // 0.97 to 0.96 is one event, not three.
    await syncIncursions(store, { fetchImpl: reply([incursion({ influence: 0.99 })]) });
    await syncIncursions(store, { fetchImpl: reply([incursion({ influence: 0.98 })]) });
    t.equal(historyOf(store, "incursion", 20000526).length, 1,
      "readings inside one bucket do not append a window");
    t.equal(incursionIn(store, 30003615).influence, 1,
      "and the stored value is the bucket, clean, rather than a float that drifted into its own");

    await syncIncursions(store, { fetchImpl: reply([incursion({ influence: 0.6 })]) });
    t.equal(historyOf(store, "incursion", 20000526).length, 2,
      "but crossing a bucket does, because being ground down is the intelligence");
    t.equal(incursionIn(store, 30003615).influence, 0.6, "and the current reading is the new one");

    // A state change is an event whatever the influence did.
    await syncIncursions(store, { fetchImpl: reply([incursion({ influence: 0.6, state: "established" })]) });
    t.equal(historyOf(store, "incursion", 20000526).length, 3, "a change of state opens a window");
    t.equal(incursionIn(store, 30003615).state, "established", "and is what is reported");

    // An empty list is a real answer here, unlike sovereignty: most of the time
    // there are no incursions. The incursion ended, and ending is closed with a
    // date rather than erased.
    const before = historyOf(store, "incursion", 20000526).length;
    await syncIncursions(store, { fetchImpl: reply([]) });
    t.equal(incursionSystems(store).size, 0, "an empty response ends the incursion");
    t.equal(historyOf(store, "incursion", 20000526).length, before, "without adding a window");
    t.check(Number.isFinite(historyOf(store, "incursion", 20000526).at(-1).closedAt),
      "and closes the last one with a date rather than deleting it");

    // A malformed success must not be read as "no incursions". Closing every
    // incursion because a captive portal returned HTML would write a false
    // all-clear into the permanent record.
    await syncIncursions(store, { fetchImpl: reply([incursion()]) });
    const live = incursionSystems(store).size;
    const bad = await syncIncursions(store, { fetchImpl: reply(null) });
    t.check(!bad.ok, "a 200 carrying null is a failed sync");
    t.equal(incursionSystems(store).size, live, "and changes nothing");
    const alsoBad = await syncIncursions(store, { fetchImpl: reply({}) });
    t.check(!alsoBad.ok, "and so is an object where a list belongs");
    t.equal(incursionSystems(store).size, live, "which also changes nothing");

    // --- frontlines --------------------------------------------------------------
    const fw = createSightings();
    const firstFw = await syncFactionWarfare(fw, { fetchImpl: reply([frontline()]) });
    t.check(firstFw.ok, "frontlines sync");
    const front = frontlineSystems(fw).get(30002957);
    t.check(front.occupied, "a system held by someone other than its owner is marked occupied");
    t.equal(front.contested, "contested", "with the contest state kept separately");
    t.equal(front.progress, 0, "and the grind reported as a fraction of its own threshold");

    // Thresholds differ between systems, so raw points mean nothing without one.
    await syncFactionWarfare(fw, { fetchImpl: reply([frontline({ victory_points: 37500 })]) });
    t.equal(frontlineSystems(fw).get(30002957).progress, 0.5,
      "half the threshold reads as half, whatever the threshold is");
    await syncFactionWarfare(fw, { fetchImpl: reply([frontline({ victory_points: 37600 })]) });
    t.equal(historyOf(fw, "faction-warfare", 30002957).length, 2,
      "and a hundred points inside the same bucket is not an event");

    await syncFactionWarfare(fw, { fetchImpl: reply([frontline({ victory_points_threshold: 0 })]) });
    t.equal(frontlineSystems(fw).get(30002957).progress, null,
      "a zero threshold gives no progress rather than a division by zero");

    // Occupied and contested are different facts and must not collapse.
    await syncFactionWarfare(fw, { fetchImpl: reply([frontline({ contested: "uncontested", occupier_faction_id: 500002 })]) });
    const quiet = frontlineSystems(fw).get(30002957);
    t.check(!quiet.occupied, "a system back in its owner's hands is not occupied");
    t.equal(quiet.contested, "uncontested", "and not contested either");
    t.equal(contestedFrontlines(fw).length, 0, "so nothing is being fought over");

    await syncFactionWarfare(fw, { fetchImpl: reply([frontline({ contested: "vulnerable", victory_points: 75000 })]) });
    t.equal(contestedFrontlines(fw).length, 1, "a vulnerable system is being fought over");
    t.equal(contestedFrontlines(fw)[0].systemId, 30002957, "and is named");

    // --- naming ----------------------------------------------------------------
    // From the archive, which carries all 27 from the export. A hand-written
    // table is data pretending to be code: it goes stale and nothing recomputes
    // it. The militia count is the proof - a list would have said four empires,
    // and been wrong since the pirate factions gained militias.
    t.equal(factionName(atlas, 500019), "Sansha's Nation", "a faction is named from the archive");
    t.equal(factionName(atlas, 500002), "Minmatar Republic", "including the empires");
    t.equal(factionName(atlas, null), null, "an absent faction is absent, not 'Faction null'");
    t.check(/Faction 999999/.test(factionName(atlas, 999999)),
      "and an unknown id shows the id rather than inventing a name");
    t.equal(Object.values(atlas.factions).filter(f => f.militia_corporation_id).length, 6,
      "six factions field a militia, not the four empires");

    const described = describeIncursion(incursionIn(store, 30003615), atlas);
    t.check(/Sansha's Nation/.test(described), "an incursion is described by faction");
    t.check(/staging/.test(described), "and says when the system is the staging one");
    t.check(/100%|95%/.test(described), "and how strong it is");
    t.equal(describeIncursion(null), null, "nothing described is nothing, not an empty sentence");

    const line = describeFrontline(frontlineSystems(fw).get(30002957), atlas);
    t.check(/Minmatar Republic/.test(line), "a frontline names the owner");
    t.check(/vulnerable/.test(line), "and its state");

    // --- a reading that is not there is not a zero ------------------------------
    // The old guard listed null, undefined and "" and stopped. Everything else
    // reached Number(), where " ", false and [] are all 0 - stored as an
    // influence of nought, "completely ground out", the strongest possible claim
    // made from no information. `true` arrived as 1: a fully contested system
    // conjured from a boolean. The comment above the guard named the hazard
    // exactly, and the code guarded three spellings of it.
    for (const absent of [null, undefined, "", " ", false, true, [], {}, "abc"]) {
      const shown = JSON.stringify(absent) ?? "undefined";
      t.equal(bucket(absent), null, `${shown} is no reading, not a zero`);
      t.equal(bucketScore(absent), null, `${shown} scores nothing either`);
    }
    // Out of range is a misread, not a measurement. These are all fractions.
    for (const impossible of [-1, -0.01, 1.01, 2, "1e3", Infinity]) {
      const shown = JSON.stringify(impossible) ?? "Infinity";
      t.equal(bucket(impossible), null, `${shown} is outside what a fraction can be`);
      t.equal(bucketScore(impossible), null, `${shown} likewise as a score`);
    }
    // And the ends of the range are real readings, not edge cases to reject.
    t.equal(bucket(0), 0, "zero influence is a measurement");
    t.equal(bucket(1), 1, "and so is total influence");
    t.equal(bucketScore(0), 0, "a score of nothing is a score");
    t.equal(bucketScore(1), 1, "and so is a score of everything");
    t.equal(bucket("0.5"), 0.5, "a numeric string is still a number, which is how JSON often carries these");

    return t.results;
  })();
}
