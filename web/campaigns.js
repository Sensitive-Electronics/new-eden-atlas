// Sovereignty campaigns: what is being fought over, where, and when.
//
// `/sovereignty/campaigns/` is public and needs no token. Its cache window is
// **five seconds**, by far the shortest in this project: CCP expects it to be
// polled during a fight, which tells you what it is for.
//
// Unlike kill counts, a campaign is an object with a lifetime. It is announced,
// it runs, and it ends. So this belongs in the sighting log and the store law
// fits it exactly: a campaign that stops being returned is closed with a date,
// and the record of what was contested last week survives.
//
// Most of a campaign is fixed once announced - the constellation, the system,
// the structure, the defender, the moment it starts. Only the two scores move,
// and they move constantly during a fight, so they are bucketed before storage
// for the same reason influence is: the log should record that a fight turned,
// not resample it every few seconds.

import { fetchEsi } from "./esi.js";
import { confirmAll, openObservations, positiveId, recognisedNothing, syncAll } from "./sightings.js";

export const CAMPAIGN_KIND = "sov-campaign";
export const CAMPAIGN_SOURCE = "public:sovereignty-campaigns";
export const CAMPAIGN_PATH = "/sovereignty/campaigns/";

// The event types CCP publishes. Kept as data rather than assumed, and an
// unknown one is carried through rather than dropped: a new event type is
// something to show, not something to hide until this file is edited.
export const EVENT_LABELS = {
  tcu_defense: "TCU",
  ihub_defense: "Infrastructure hub",
  station_defense: "Station",
  station_freeport: "Freeport",
};

export const SCORE_BUCKET = 0.05;

// Same shape as ambient's bucket, and the same rule: a score is a fraction, and
// `" "`, `false` or `[]` reaching `Number()` stores 0 - a fight fully lost - from
// a value nobody could read.
export function bucketScore(value) {
  const number = typeof value === "number" ? value
    : typeof value === "string" && value.trim() !== "" ? Number(value)
      : null;
  if (number === null || !Number.isFinite(number) || number < 0 || number > 1) return null;
  return Number((Math.round(number / SCORE_BUCKET) * SCORE_BUCKET).toFixed(6));
}

export function eventLabel(eventType) {
  return EVENT_LABELS[eventType] ?? String(eventType ?? "Unknown").replace(/_/g, " ");
}

export async function syncCampaigns(store, { fetchImpl = null, cached = null, now = Date.now() } = {}) {
  const result = await fetchEsi(CAMPAIGN_PATH, { cached, fetchImpl, now });
  if (!result.ok) return { ok: false, result, changes: null };
  if (result.notModified && !result.data) {
    // Unchanged means confirmed, not ignored. See confirmAll in sightings.js.
    const confirmed = confirmAll(store, CAMPAIGN_KIND, { source: CAMPAIGN_SOURCE, now });
    return { ok: true, result, changes: null, unchanged: true, confirmed };
  }

  // An empty list is a real answer - most of the time nothing is being fought
  // over. A non-list is not, and reading one as "no campaigns" would close every
  // live timer on the map and write that all-clear into the permanent record.
  if (!Array.isArray(result.data)) {
    return {
      ok: false,
      result: { ...result, ok: false, reason: "malformed", detail: "Campaigns were not a list." },
      changes: null,
    };
  }

  const seen = result.data
    .filter(row => row && positiveId(row.campaign_id) !== null)
    .map(row => ({
      key: positiveId(row.campaign_id),
      value: {
        event_type: typeof row.event_type === "string" ? row.event_type : "unknown",
        constellation_id: Number(row.constellation_id) || null,
        solar_system_id: Number(row.solar_system_id) || null,
        defender_id: Number(row.defender_id) || null,
        structure_id: Number(row.structure_id) || null,
        // Parsed once, here, so nothing downstream has to know it arrived as a
        // string. Unparseable means unknown rather than the epoch, which would
        // put every broken row at the top of a list sorted by time.
        startTime: Number.isFinite(Date.parse(row.start_time)) ? Date.parse(row.start_time) : null,
        attackers: bucketScore(row.attackers_score),
        defenders: bucketScore(row.defender_score),
      },
    }));

  // A list of rows none of which parsed is schema drift, not an empty world.
  if (recognisedNothing(result.data, seen.length)) {
    return {
      ok: false,
      result: { ...result, ok: false, reason: "malformed", detail: "Campaigns arrived in a shape this build does not recognise." },
      changes: null,
    };
  }

  const changes = syncAll(store, CAMPAIGN_KIND, seen, { source: CAMPAIGN_SOURCE, now });
  const quiet = !changes.opened.length && !changes.changed.length && !changes.closed.length;
  return { ok: true, result, changes, unchanged: quiet };
}

function entryOf(entry) {
  return {
    campaignId: Number(entry.key),
    ...entry.value,
    since: entry.firstSeen,
    lastConfirmed: entry.lastConfirmed,
  };
}

// Everything currently announced, soonest first. A campaign that has already
// started sorts before one that has not, because it is happening now.
export function openCampaigns(store) {
  return openObservations(store, CAMPAIGN_KIND, { source: CAMPAIGN_SOURCE })
    .map(entryOf)
    .sort((a, b) => (a.startTime ?? Infinity) - (b.startTime ?? Infinity) || a.campaignId - b.campaignId);
}

// Campaigns in one system. A list rather than one, because a constellation can
// carry several and a system can host more than one structure.
export function campaignsIn(store, systemId) {
  const id = Number(systemId);
  return openCampaigns(store).filter(campaign => campaign.solar_system_id === id);
}

export function campaignSystems(store) {
  const systems = new Map();
  for (const campaign of openCampaigns(store)) {
    if (!campaign.solar_system_id) continue;
    if (!systems.has(campaign.solar_system_id)) systems.set(campaign.solar_system_id, []);
    systems.get(campaign.solar_system_id).push(campaign);
  }
  return systems;
}

// Started, and therefore happening rather than scheduled. The distinction is
// the whole point of the layer: one is a fight to join and the other is a
// fight to plan for.
export function liveNow(store, now = Date.now()) {
  return openCampaigns(store).filter(c => c.startTime !== null && c.startTime <= now);
}

export function upcoming(store, { now = Date.now(), within = 24 * 3_600_000 } = {}) {
  return openCampaigns(store)
    .filter(c => c.startTime !== null && c.startTime > now && c.startTime - now <= within);
}

// How long until it starts, or how long it has been running. Both matter and
// they read differently, so they are not collapsed into one signed number that
// a caller has to interpret.
export function describeTiming(campaign, now = Date.now()) {
  if (!campaign || campaign.startTime === null) return "start time unknown";
  const delta = campaign.startTime - now;
  const minutes = Math.round(Math.abs(delta) / 60000);
  const shape = minutes < 60
    ? `${minutes}m`
    : minutes < 24 * 60
      ? `${Math.floor(minutes / 60)}h ${minutes % 60}m`
      : `${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h`;
  return delta > 0 ? `in ${shape}` : `started ${shape} ago`;
}

export function describeCampaign(campaign, now = Date.now()) {
  if (!campaign) return null;
  const parts = [eventLabel(campaign.event_type), describeTiming(campaign, now)];
  // The scores are only meaningful once there is a fight to score. Before it
  // starts they are a starting position, and showing them as progress would
  // read as a contest that is already under way.
  if (campaign.startTime !== null && campaign.startTime <= now
    && campaign.attackers !== null && campaign.defenders !== null) {
    parts.push(`${Math.round(campaign.attackers * 100)}% attackers`);
  }
  return parts.join(" · ");
}
