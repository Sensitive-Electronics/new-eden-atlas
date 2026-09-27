// Sovereignty campaigns: what is being fought over, where, and when.
//
// Unlike kill counts, a campaign is an object with a lifetime - announced, run,
// ended - so it belongs in the sighting log and the store law fits it exactly.
// What has to be got right is the timing, because this layer's whole value is
// the difference between a fight to join and a fight to plan for, and those two
// look identical if the start time is mishandled.
//
// The scores are the one part that moves, and they move constantly during a
// fight, so they are bucketed for the same reason incursion influence is.

import { suite } from "./helpers.mjs";
import { createSightings, historyOf, openObservations } from "../web/sightings.js";
import {
  bucketScore, campaignsIn, campaignSystems, describeCampaign, describeTiming,
  eventLabel, liveNow, openCampaigns, syncCampaigns, upcoming,
} from "../web/campaigns.js";

const headers = map => ({ get: name => map[name.toLowerCase()] ?? null });
const reply = rows => async () => ({
  ok: true,
  status: 200,
  // Five seconds, which is what the endpoint actually returns.
  headers: headers({ expires: new Date(Date.now() + 5_000).toUTCString(), etag: 'W/"c"' }),
  json: async () => rows,
});

const NOW = Date.parse("2026-09-18T12:00:00Z");
const campaign = (over = {}) => ({
  attackers_score: 0.4,
  campaign_id: 112178,
  constellation_id: 20000258,
  defender_id: 99014050,
  defender_score: 0.6,
  event_type: "ihub_defense",
  solar_system_id: 30001744,
  start_time: "2026-09-18T16:40:45Z",
  structure_id: 1051396895714,
  ...over,
});

export default function run() {
  const t = suite("campaigns");

  t.equal(eventLabel("ihub_defense"), "Infrastructure hub", "a known event type reads as words");
  t.equal(eventLabel("tcu_defense"), "TCU", "including the abbreviations people actually say");
  t.equal(eventLabel("something_new"), "something new",
    "and an unknown one is shown rather than hidden until this file is edited");
  t.equal(bucketScore(0.43), 0.45, "scores bucket like every other live reading here");
  t.equal(bucketScore(0.42), 0.4, "and 0.42 is the neighbouring bucket, not the same one");
  t.equal(bucketScore(null), null, "a missing score stays missing rather than becoming zero");
  t.equal(bucketScore(0), 0, "while a real zero survives");

  return (async () => {
    const store = createSightings();
    const first = await syncCampaigns(store, { fetchImpl: reply([campaign()]), now: NOW });
    t.check(first.ok, "campaigns sync");
    t.equal(first.changes.opened.length, 1, "and open a record");

    const [only] = openCampaigns(store);
    t.equal(only.campaignId, 112178, "keyed by the campaign");
    t.equal(only.startTime, Date.parse("2026-09-18T16:40:45Z"), "with the start time parsed once, here");
    t.equal(only.solar_system_id, 30001744, "and the system it is in");

    // The distinction the layer exists for.
    t.equal(liveNow(store, NOW).length, 0, "a campaign four hours out is not happening yet");
    t.equal(upcoming(store, { now: NOW }).length, 1, "it is upcoming");
    const later = NOW + 5 * 3_600_000;
    t.equal(liveNow(store, later).length, 1, "and once its time comes it is live");
    t.equal(upcoming(store, { now: later }).length, 0, "and no longer merely upcoming");
    t.equal(upcoming(store, { now: NOW, within: 60_000 }).length, 0,
      "a window shorter than the wait excludes it");

    t.check(/in 4h 41m/.test(describeTiming(only, NOW)),
      `a future start reads as a countdown (${describeTiming(only, NOW)})`);
    t.check(/started 19m ago/.test(describeTiming(only, only.startTime + 19 * 60_000)),
      "and a past one reads as elapsed, because those are different facts");
    t.equal(describeTiming({ startTime: null }), "start time unknown",
      "an unparseable time says so rather than reading as the epoch");

    // Scores are a starting position until there is a fight to score. Shown
    // before the timer, they read as a contest already under way.
    t.check(!/attackers/.test(describeCampaign(only, NOW)),
      "a campaign that has not started does not report a score");
    t.check(/40% attackers/.test(describeCampaign(only, later)),
      "and one that has started does");
    t.check(/Infrastructure hub/.test(describeCampaign(only, NOW)), "with what is being fought over");

    // --- the log ------------------------------------------------------------------
    // Scores move constantly during a fight. Bucketed, the log records that it
    // turned rather than resampling it every few seconds.
    await syncCampaigns(store, { fetchImpl: reply([campaign({ attackers_score: 0.41 })]), now: NOW + 5000 });
    await syncCampaigns(store, { fetchImpl: reply([campaign({ attackers_score: 0.42 })]), now: NOW + 10_000 });
    t.equal(historyOf(store, "sov-campaign", 112178).length, 1,
      "a score drifting inside one bucket does not append a window");
    await syncCampaigns(store, { fetchImpl: reply([campaign({ attackers_score: 0.75 })]), now: NOW + 15_000 });
    t.equal(historyOf(store, "sov-campaign", 112178).length, 2,
      "but a fight turning does, because that is the intelligence");

    // A campaign that ends is closed with a date, not erased. What was
    // contested last week is the record this store exists to keep.
    await syncCampaigns(store, { fetchImpl: reply([]), now: NOW + 20_000 });
    t.equal(openCampaigns(store).length, 0, "an ended campaign stops being live");
    const history = historyOf(store, "sov-campaign", 112178);
    t.equal(history.length, 2, "without losing its history");
    t.check(Number.isFinite(history.at(-1).closedAt), "and is closed with a date rather than deleted");

    // A row whose start time will not parse. Left as NaN it compares false
    // against everything, so the campaign would count as neither live nor
    // upcoming and vanish from both totals while still sitting in the store -
    // present, invisible, and impossible to explain.
    const broken = createSightings();
    await syncCampaigns(broken, {
      fetchImpl: reply([campaign({ campaign_id: 7, start_time: "not a date" })]),
      now: NOW,
    });
    const [odd] = openCampaigns(broken);
    // Checked rather than compared: JSON.stringify(NaN) is "null", so an equality
    // failure here reports "expected null, got null" and says nothing at all.
    t.check(odd.startTime === null,
      `an unparseable start time becomes null, not NaN (got ${String(odd.startTime)})`);
    t.equal(liveNow(broken, NOW).length, 0, "so it is not counted as running");
    t.equal(upcoming(broken, { now: NOW }).length, 0, "nor as scheduled");
    t.equal(openCampaigns(broken).length, 1, "but it is still listed, because it is still a campaign");
    t.check(/start time unknown/.test(describeCampaign(odd, NOW)),
      "and says its time is unknown rather than showing a countdown to nowhere");

    // Missing entirely, which is the same problem arriving a different way.
    const absent = createSightings();
    await syncCampaigns(absent, { fetchImpl: reply([campaign({ start_time: undefined })]), now: NOW });
    t.equal(openCampaigns(absent)[0].startTime, null, "an absent start time is null too");

    // A malformed success must not close every live timer on the map.
    await syncCampaigns(store, { fetchImpl: reply([campaign(), campaign({ campaign_id: 999 })]), now: NOW + 25_000 });
    t.equal(openCampaigns(store).length, 2, "two campaigns are two records");
    const bad = await syncCampaigns(store, { fetchImpl: reply(null), now: NOW + 30_000 })
      .catch(error => ({ ok: false, threw: error }));
    t.check(!bad.threw, "a malformed payload is reported, not thrown");
    t.check(!bad.ok, "a 200 carrying null is a failed sync");
    t.equal(openCampaigns(store).length, 2, "and closes nothing");
    const alsoBad = await syncCampaigns(store, { fetchImpl: reply({}), now: NOW + 30_000 });
    t.check(!alsoBad.ok, "as is an object where a list belongs");
    t.equal(openCampaigns(store).length, 2, "which also closes nothing");

    // --- by system ---------------------------------------------------------------------
    await syncCampaigns(store, {
      fetchImpl: reply([campaign(), campaign({ campaign_id: 999, structure_id: 42 })]),
      now: NOW + 35_000,
    });
    t.equal(campaignsIn(store, 30001744).length, 2,
      "a system with two structures under attack reports both");
    t.equal(campaignsIn(store, 30000142).length, 0, "and a quiet system reports none");
    t.equal(campaignSystems(store).size, 1, "the map index groups them by system");

    // Soonest first, so a list reads as a timetable.
    await syncCampaigns(store, {
      fetchImpl: reply([
        campaign({ campaign_id: 3, start_time: "2026-09-19T00:00:00Z" }),
        campaign({ campaign_id: 1, start_time: "2026-09-18T13:00:00Z" }),
        campaign({ campaign_id: 2, start_time: "2026-09-18T20:00:00Z" }),
      ]),
      now: NOW + 40_000,
    });
    t.check(openCampaigns(store).map(c => c.campaignId).join() === "1,2,3",
      "campaigns are ordered by when they start, soonest first");

    t.equal(openObservations(store, "sov-campaign").length, 3, "and only the open ones are listed");
    return t.results;
  })();
}
