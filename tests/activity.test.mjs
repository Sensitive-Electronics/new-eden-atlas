// Kills and jumps: where people are dying and where they are travelling.
//
// This layer is deliberately not a sighting log, and most of what can go wrong
// with it follows from that. A series has two failure modes the sighting store
// never had: a sample recorded twice, which turns a flat hour into a rising
// one, and a missing sample read as a quiet one, which is a false all-clear.
//
// The third is arithmetic honesty. NPC kills are ratting. They say people are
// present and nothing about whether it is safe to pass through, and the moment
// they are added into a danger number the busiest ratting system in New Eden
// becomes the most dangerous place on the map.

import { suite } from "./helpers.mjs";
import {
  HISTORY_LIMIT, busiest, createActivity, describeHeat, fromJSON, heatOf, hottest,
  playerKills, playerKillsIn, recordSample, sampleCount, syncActivity, toJSON, trendOf,
} from "../web/activity.js";

const headers = map => ({ get: name => map[name.toLowerCase()] ?? null });

// One fake for both endpoints, dispatching on path, with a Last-Modified the
// caller controls - which is what identifies a sample.
const serve = ({ kills = [], jumps = [], at = Date.now(), failing = null } = {}) => async url => {
  const which = String(url).includes("system_kills") ? "kills" : "jumps";
  if (failing === which || failing === "both") throw new TypeError("Failed to fetch");
  const body = which === "kills" ? kills : jumps;
  return {
    ok: true,
    status: 200,
    headers: headers({
      "last-modified": new Date(at).toUTCString(),
      expires: new Date(at + 3_600_000).toUTCString(),
      etag: `W/"${which}"`,
    }),
    json: async () => body,
  };
};

const killRow = (id, ship, pod, npc = 0) => ({ system_id: id, ship_kills: ship, pod_kills: pod, npc_kills: npc });
const jumpRow = (id, count) => ({ system_id: id, ship_jumps: count });

export default function run() {
  const t = suite("activity");

  // --- the arithmetic ----------------------------------------------------------
  t.equal(playerKills({ shipKills: 3, podKills: 2 }), 5, "player kills are ships plus pods");
  t.equal(playerKills({ shipKills: 3, podKills: 2, npcKills: 3000 }), 5,
    "and never include NPC kills, or the busiest ratting system becomes the deadliest");
  t.equal(playerKills(null), 0, "nothing known is zero rather than a throw");
  t.equal(playerKills({}), 0, "and so is an empty reading");

  return (async () => {
    const store = createActivity();
    const hour = 3_600_000;
    const t0 = Date.parse("2026-09-18T00:00:00Z");

    // --- a sync ----------------------------------------------------------------
    const first = await syncActivity(store, {
      fetchImpl: serve({
        at: t0,
        kills: [killRow(30000142, 4, 2, 0), killRow(30002187, 0, 0, 3001), killRow(30000144, 1, 0, 12)],
        jumps: [jumpRow(30000142, 1672), jumpRow(30000144, 40)],
      }),
    });
    t.check(first.ok, "both endpoints sync");
    t.equal(store.latest.at, t0, "the sample is stamped when the data was produced, not when it was fetched");

    const jita = heatOf(store, 30000142);
    t.equal(jita.shipKills, 4, "ship kills are read");
    t.equal(jita.podKills, 2, "and pod kills");
    t.equal(jita.jumps, 1672, "and traffic");
    t.equal(playerKillsIn(store, 30000142), 6, "which combine into player kills");

    const amarr = heatOf(store, 30002187);
    t.equal(amarr.npcKills, 3001, "NPC kills are kept");
    t.equal(playerKills(amarr), 0, "but are not danger");

    // A system in neither list is quiet, not unknown: these endpoints report
    // every system with any activity, so absence is a measured zero.
    const quiet = heatOf(store, 30000001);
    t.equal(quiet.shipKills, 0, "a system in neither list reports no kills");
    t.equal(quiet.jumps, 0, "and no traffic");

    t.equal(hottest(store)[0]?.systemId ?? null, 30000142, "the hottest system is the one people died in");
    t.check(!hottest(store).some(entry => entry.systemId === 30002187),
      "and a ratting system with 3,001 NPC kills is not on the list at all");
    t.equal(hottest(store).length, 2, "only systems with a player kill are");
    t.equal(busiest(store)[0]?.jumps ?? null, 1672, "traffic is its own list");

    // --- the same hour, fetched twice --------------------------------------------
    // ESI republishes hourly and serves the same body for the rest of the hour.
    // Appending both would put one hour into the series twice and make a flat
    // hour look like a rising one.
    t.equal(sampleCount(store), 1, "one sync, one sample");
    await syncActivity(store, {
      fetchImpl: serve({ at: t0, kills: [killRow(30000142, 4, 2, 0)], jumps: [jumpRow(30000142, 1672)] }),
    });
    t.equal(sampleCount(store), 1, "the same hour fetched again is the same sample, not a second one");

    await syncActivity(store, {
      fetchImpl: serve({ at: t0 + hour, kills: [killRow(30000142, 9, 3, 0)], jumps: [jumpRow(30000142, 1500)] }),
    });
    t.equal(sampleCount(store), 2, "a new hour is a new sample");
    t.equal(playerKillsIn(store, 30000142), 12, "carrying the new numbers");

    // --- the trend -----------------------------------------------------------------
    const trend = trendOf(store, 30000142);
    t.equal(trend.length, 2, "the trend has a point per sample");
    t.equal(trend[0]?.playerKills ?? null, 6, "oldest first");
    t.equal(trend[1]?.playerKills ?? null, 12, "newest last");

    // A quiet hour must still be a point. Skipping it would turn a lull into a
    // missing hour and flatten the shape the series exists to show.
    //
    // **Spelled the way the game spells it.** This used `kills: []`, which says
    // something different and impossible: not "Jita was quiet" but "nothing
    // anywhere in New Eden died this hour", from an endpoint measured at 2,605
    // reporting systems where NPC ratting alone guarantees thousands of rows.
    // So `[]` is refused now, and the quiet hour is written as what it actually
    // is - a payload with other systems in it and no row for this one. The
    // decision the comment above states is untouched: a system absent from a
    // sample reads as zero for that sample, which is exactly what `trendOf`
    // does with `sample.kills.get(id)`.
    await syncActivity(store, {
      fetchImpl: serve({ at: t0 + 2 * hour, kills: [killRow(30002187, 4, 1, 0)], jumps: [jumpRow(30002187, 40)] }),
    });
    const withGap = trendOf(store, 30000142);
    t.equal(withGap.length, 3, "an hour in which this system saw nothing is still a sample");
    t.equal(withGap[2]?.playerKills ?? null, 0, "recorded as zero rather than left out");

    // And the shape that cannot happen is refused rather than recorded as a
    // cluster-wide all-clear. It costs more than a missing sample: the half
    // stays measured, so `buildHeat` returns `applied: true` with an empty kill
    // map and re-weights a route - "not 'no weighting' but 'weighted as though
    // it were safe'".
    const impossible = await syncActivity(store, {
      fetchImpl: serve({ at: t0 + 3 * hour, kills: [], jumps: [] }),
    });
    t.check(!impossible.ok, "an empty whole-endpoint answer is refused, not believed");
    t.equal(trendOf(store, 30000142).length, 3, "and writes no sample at all");

    // --- the series is bounded --------------------------------------------------------
    for (let i = 3; i < HISTORY_LIMIT + 6; i += 1) {
      await syncActivity(store, {
        fetchImpl: serve({ at: t0 + i * hour, kills: [killRow(30000142, i, 0, 0)], jumps: [] }),
      });
    }
    t.equal(sampleCount(store), HISTORY_LIMIT, "the series never grows past its limit");
    t.equal(trendOf(store, 30000142).length, HISTORY_LIMIT, "and neither does a trend read from it");
    const times = store.history.map(sample => sample.at);
    t.check(times.every((value, index) => index === 0 || value > times[index - 1]),
      "samples stay in order, oldest first");
    t.check(times.at(-1) === t0 + (HISTORY_LIMIT + 5) * hour, "and the newest is kept");

    // --- half a sync --------------------------------------------------------------------
    await syncActivity(store, {
      fetchImpl: serve({ at: t0 + 99 * hour, kills: [], jumps: [jumpRow(30000142, 903)] }),
    });
    t.equal(heatOf(store, 30000142).jumps, 903, "traffic is recorded when it is reported");

    const half = await syncActivity(store, {
      fetchImpl: serve({ at: t0 + 100 * hour, kills: [killRow(30000142, 7, 0, 0)], failing: "jumps" }),
    });
    t.check(half.ok, "one endpoint down is still a sync");
    t.check(half.killsState.ok, "for the half that worked");
    t.check(!half.jumpsState.ok, "and the failure is reported");
    t.equal(playerKillsIn(store, 30000142), 7, "the working half updates");
    t.equal(heatOf(store, 30000142).jumps, 903,
      "and the failed half keeps the last traffic figure it had rather than dropping it to zero");

    // The other half, which is the one that matters and which this file tested
    // only in its harmless direction for a long time. Jumps failing costs a
    // traffic figure. Kills failing costs the answer to "is it safe", and the
    // old code answered it anyway: the missing map became an empty map, an
    // empty map became a measured zero, and the panel said "no player kills"
    // over an endpoint that had returned 503.
    const beforeKillsFail = sampleCount(store);
    const killsDown = await syncActivity(store, {
      fetchImpl: serve({ at: t0 + 101 * hour, jumps: [jumpRow(30000142, 640)], failing: "kills" }),
    });
    t.check(killsDown.ok, "kills down is still a sync, because traffic arrived");
    t.check(killsDown.partial, "but the sync says it is partial rather than reporting plain success");
    t.check(!killsDown.killsState.ok, "and names the half that failed");

    const blind = heatOf(store, 30000142);
    // The last good numbers stand. Discarding them would throw away real
    // intelligence, and this project keeps what it last confirmed - the whole
    // store is built on that. What must not happen is that they are restamped.
    t.equal(blind.shipKills, 7, "the last measured kill figure is kept rather than discarded");
    t.equal(blind.killsFresh, false, "but the reading knows this sync did not measure them");
    t.equal(blind.killsAt, t0 + 100 * hour, "and it carries the hour they were actually measured");
    t.check(blind.killsAt < blind.at,
      "which is older than the sample, because only the jumps half answered this time");
    t.equal(blind.jumps, 640, "while the half that answered is reported normally");
    t.equal(blind.jumpsAt, blind.at, "stamped now");
    t.check(/last measured earlier/.test(describeHeat(blind)),
      "and the sentence a pilot reads does not let old counts pass as this hour's");

    // Never measured at all is the other case, and it is not a zero.
    const virgin = heatOf(await (async () => {
      const fresh = createActivity();
      await syncActivity(fresh, { fetchImpl: serve({ at: t0, jumps: [jumpRow(30000142, 10)], failing: "kills" }) });
      return fresh;
    })(), 30000142);
    t.equal(virgin.killsMeasured, false, "a store whose kills half has never answered has no kill reading");
    t.equal(virgin.shipKills, null, "so the count is absent rather than zero");
    t.check(/kills not measured/.test(describeHeat(virgin)), "and it says so");
    t.check(!/no player kills/.test(describeHeat(virgin)),
      "rather than telling a pilot nobody died, which is the claim that gets somebody killed");

    t.equal(sampleCount(store), beforeKillsFail,
      "no hour is appended for a sync with no kill measurement in it");
    // The reason that matters: an appended hour would copy the previous hour's
    // kills forward under a new timestamp, so one reading of seven becomes two
    // consecutive hours with kills in them - which is what the heat panel counts
    // and what the routing weight is built from.
    const carried = trendOf(store, 30000142);
    t.check(carried.at(-1)?.at !== t0 + 101 * hour,
      "so a single reading never becomes two hours of them");

    // And it must survive a save unchanged - in *both* directions.
    //
    // A carried reading must come back carried, not `null`. Losing `killsAt` across
    // the save leaves `heatOf` unable to tell a carried reading from one that never
    // happened, which contradicts the assertions thirty lines above - "the last
    // measured kill figure is kept rather than discarded". And `killsKnown()` asks
    // `killsAt !== null`, which `undefined` passes, so the status bar would print the
    // carried count with no age while the inspector called it unmeasured.
    //
    // The guard the comment was reaching for is real and is the `virgin` case:
    // never measured must not come back as a quiet zero. Both are asserted now.
    const blindRound = heatOf(fromJSON(JSON.parse(JSON.stringify(toJSON(store)))), 30000142);
    t.equal(blindRound.shipKills, 7, "a carried reading survives a save with its numbers");
    t.equal(blindRound.killsAt, t0 + 100 * hour, "and with the hour they were measured");
    t.equal(blindRound.killsFresh, false, "and still knows it was not measured this sync");
    t.check(/last measured earlier/.test(describeHeat(blindRound)),
      "so the sentence a pilot reads is the same one as before the reload");

    const virginRound = heatOf(fromJSON(JSON.parse(JSON.stringify(toJSON(await (async () => {
      const fresh = createActivity();
      await syncActivity(fresh, { fetchImpl: serve({ at: t0, jumps: [jumpRow(30000142, 10)], failing: "kills" }) });
      return fresh;
    })())))), 30000142);
    t.equal(virginRound.killsMeasured, false,
      "while a half that never answered does not come back measured");
    t.equal(virginRound.shipKills, null, "nor its count laundered into a zero");
    t.equal(virginRound.killsAt, null,
      "and its age is null rather than undefined, which killsKnown would have passed");

    // Recovery: the next good sync puts it back to a measurement.
    await syncActivity(store, {
      fetchImpl: serve({ at: t0 + 102 * hour, kills: [killRow(30000142, 5, 2, 0)], jumps: [jumpRow(30000142, 903)] }),
    });
    t.equal(heatOf(store, 30000142).killsMeasured, true, "a good sync restores the measurement");
    t.equal(heatOf(store, 30000142).shipKills, 5, "with the new numbers");
    t.equal(playerKillsIn(store, 30000142), 7, "totalling seven again");

    // --- rows we cannot read are not a quiet hour ---------------------------------
    // These endpoints list only the systems with activity in them, so an empty
    // map is a legitimate answer. That makes schema drift invisible: rename
    // system_id to systemId and every row fails its id check, the map comes back
    // empty, and a quiet hour is recorded for a response nobody could read. The
    // series is what the routing weight and the "N of the last M hours" count
    // are built from, so it is a false all-clear with consequences.
    const drift = createActivity();
    await syncActivity(drift, {
      fetchImpl: serve({ at: t0, kills: [killRow(30000142, 4, 1, 0)], jumps: [jumpRow(30000142, 100)] }),
    });
    const beforeDrift = sampleCount(drift);
    const drifted = await syncActivity(drift, {
      fetchImpl: serve({
        at: t0 + hour,
        kills: [{ systemId: 30000142, shipKills: 9, podKills: 2 }],
        jumps: [{ systemId: 30000142, shipJumps: 500 }],
      }),
    });
    t.check(!drifted.ok, "a response whose rows none parsed is a failed sync, not an empty universe");
    t.equal(drifted.killsState.reason, "malformed", "and the kills half says why");
    t.equal(drifted.jumpsState.reason, "malformed", "as does the jumps half");
    t.equal(sampleCount(drift), beforeDrift, "no hour is written for a payload nobody could read");
    t.equal(playerKillsIn(drift, 30000142), 5, "and the last real reading stands");

    // One half drifting is still half a sync.
    const halfDrift = await syncActivity(drift, {
      fetchImpl: serve({
        at: t0 + 2 * hour,
        kills: [killRow(30000142, 3, 0, 0)],
        jumps: [{ systemId: 30000142, shipJumps: 500 }],
      }),
    });
    t.check(halfDrift.ok, "the half that parsed is still a sync");
    t.check(halfDrift.partial, "reported as partial");
    t.equal(playerKillsIn(drift, 30000142), 3, "with the readable half recorded");

    // A quiet hour for *this* system is a real answer, and it arrives as rows
    // for other systems. A wholly empty payload is not a quiet hour - see the
    // note in the series block above - and is refused.
    const quietHour = await syncActivity(drift, {
      fetchImpl: serve({ at: t0 + 3 * hour, kills: [killRow(30002187, 2, 0, 0)], jumps: [jumpRow(30002187, 20)] }),
    });
    t.check(quietHour.ok, "an hour with no kills in this system is a measured hour, not drift");

    // --- a count that is absent is not a count of zero ------------------------------
    const partialRow = createActivity();
    await syncActivity(partialRow, {
      fetchImpl: serve({ at: t0, kills: [{ system_id: 30000142, ship_kills: 6 }], jumps: [] }),
    });
    t.equal(heatOf(partialRow, 30000142).shipKills, 6, "a row with one readable count is understood");
    t.equal(heatOf(partialRow, 30000142).podKills, 0, "and its absent fields read as zero within that row");

    const rubbish = createActivity();
    const rubbishSync = await syncActivity(rubbish, {
      fetchImpl: serve({
        at: t0,
        kills: [{ system_id: 30000142, ship_kills: "lots", pod_kills: null, npc_kills: "" }],
        jumps: [jumpRow(30000142, 10)],
      }),
    });
    t.check(!rubbishSync.killsState.ok,
      "a row whose every count is unreadable is not a system where nobody died");
    // The jumps half is kept in the latest reading, but no hour is appended to
    // the series: an hour with no kill measurement in it is not an hour, which
    // is the rule that stops one reading becoming two.
    t.equal(heatOf(rubbish, 30000142).jumps, 10, "the jumps half is still recorded");
    t.equal(heatOf(rubbish, 30000142).killsMeasured, false, "while the kills half reports no reading");
    t.equal(sampleCount(rubbish), 0, "and no hour is written to the series without a kill measurement");

    const none = await syncActivity(store, { fetchImpl: serve({ failing: "both" }) });
    t.check(!none.ok, "both down is a failed sync");
    t.equal(playerKillsIn(store, 30000142), 7, "which changes nothing");

    // A 200 carrying something that is not a list must not be read as an hour
    // in which nobody died anywhere. That false all-clear would sit in the
    // series for a day.
    const before = sampleCount(store);
    const bad = await syncActivity(store, {
      fetchImpl: async () => ({ ok: true, status: 200, headers: headers({}), json: async () => null }),
    });
    t.check(!bad.ok, "a 200 carrying null is a failed sync");
    t.equal(sampleCount(store), before, "and appends no sample");
    t.equal(playerKillsIn(store, 30000142), 7, "leaving the last real reading in place");

    // --- persistence -----------------------------------------------------------------
    const round = fromJSON(JSON.parse(JSON.stringify(toJSON(store))));
    t.equal(sampleCount(round), sampleCount(store), "a saved series comes back whole");
    t.equal(playerKillsIn(round, 30000142), 7, "with the latest reading");
    t.equal(heatOf(round, 30000142).npcKills, heatOf(store, 30000142).npcKills,
      "and the NPC figure, which only the latest sample carries");
    t.equal(trendOf(round, 30000142).length, trendOf(store, 30000142).length, "and the trend intact");
    t.equal(sampleCount(fromJSON(null)), 0, "a missing save is an empty series rather than a throw");
    t.equal(heatOf(fromJSON(null), 30000142), null, "which reports nothing known, not zero");
    t.equal(sampleCount(fromJSON({ history: [{ at: "nonsense" }, {}] })), 0,
      "and a corrupt one drops what it cannot read rather than carrying it");

    // The saved shape has to stay small: a day of full samples measured 2.3 MB
    // against the live endpoints, which is why only player kills are kept.
    const saved = JSON.stringify(toJSON(store));
    t.check(saved.length < 400_000, `the whole series stays small (${saved.length} bytes)`);

    // --- description -------------------------------------------------------------------
    const described = describeHeat(heatOf(store, 30000142));
    t.check(/7 player kills/.test(described), "a reading is described in player kills");
    // "the reported hour", not "the last hour". The counts are as old as the
    // sample they came from, which is six hours back whenever the endpoint has
    // been unreachable that long, and the panel prints this sentence next to
    // that age. Asserting the old phrase was asserting the claim itself.
    t.check(/reported hour/.test(described), "over the window it actually covers, not the one just past");
    t.check(!/last hour/.test(described), "so a stale reading never calls itself current");
    t.check(/no player kills/.test(describeHeat(heatOf(store, 30000001))),
      "and a quiet system says so rather than saying nothing");
    t.equal(describeHeat(null), null, "nothing known is described as nothing");

    return t.results;
  })();
}
