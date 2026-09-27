// Sovereignty: who holds what, and where one alliance's space ends.
//
// Real topology, synthetic holders. The gate graph has to be real because the
// border computation is entirely about adjacency, but who holds what changes
// hourly in the live game and a test pinned to it would fail for reasons that
// are not defects. So alliances are assigned here, and the assertions are about
// the shape of the answer rather than about the state of nullsec today.
//
// The fetch is injected, as everywhere: the suite uses no network.

import { readArchive, suite } from "./helpers.mjs";
import { createSightings, historyOf, openObservations } from "../web/sightings.js";
import {
  SOV_KIND, allianceColour, borders, factionSystems, frontBetween, heldSystems,
  holderOf, holdingsOf, syncSovereignty,
} from "../web/sovereignty.js";

const T = n => Date.parse("2026-09-01T00:00:00Z") + n * 3_600_000;

const headers = map => ({ get: name => map[name.toLowerCase()] ?? null });
const respond = rows => async () => ({
  ok: true,
  status: 200,
  headers: headers({ expires: new Date(T(24)).toUTCString(), etag: 'W/"sov"' }),
  json: async () => rows,
});

export default function run() {
  const t = suite("sovereignty");
  const atlas = readArchive();

  // A real chain of gate-connected systems, so adjacency is genuine.
  const chainStart = Object.values(atlas.systems).find(system => system.security < 0 && system.neighbors.length >= 2);
  const chain = [chainStart.system_id];
  while (chain.length < 6) {
    const last = atlas.systems[String(chain.at(-1))];
    const next = last.neighbors.find(id => !chain.includes(id) && atlas.systems[String(id)]);
    if (!next) break;
    chain.push(next);
  }

  return (async () => {
    t.check(chain.length >= 4, `a real chain of ${chain.length} connected systems is available`);

    // --- syncing ----------------------------------------------------------------
    const store = createSightings();
    const ALLIANCE_A = 111;
    const ALLIANCE_B = 222;
    const half = Math.floor(chain.length / 2);
    const firstRows = chain.map((id, index) => ({
      system_id: id,
      alliance_id: index < half ? ALLIANCE_A : ALLIANCE_B,
      corporation_id: 900 + index,
    }));

    const first = await syncSovereignty(store, { fetchImpl: respond(firstRows), now: T(0) });
    t.check(first.ok, "a successful pull reports success");
    t.equal(first.changes.opened.length, chain.length, "opening one sighting per held system");
    t.check(!first.unchanged, "and does not claim nothing happened");
    t.equal(holderOf(store, chain[0]).alliance_id, ALLIANCE_A, "the holder is recorded");
    t.equal(holderOf(store, chain[0]).corporation_id, 900, "with the holding corporation");

    // The endpoint returns all 8,490 systems and only about 2,712 carry an
    // alliance - the rest are empire space with a faction, or unclaimed. Only
    // alliance holdings are observed, and every synthetic row above has one, so
    // the filter would otherwise never be exercised by this suite at all.
    const withUnheld = createSightings();
    const mixedRows = [
      { system_id: chain[0], alliance_id: ALLIANCE_A, corporation_id: 900 },
      { system_id: chain[1], faction_id: 500001 },
      { system_id: chain[2] },
    ];
    const mixedSync = await syncSovereignty(withUnheld, { fetchImpl: respond(mixedRows), now: T(0) });
    t.equal(mixedSync.changes.opened.length, 1, "only the alliance-held system is observed");
    t.equal(holderOf(withUnheld, chain[1]), null, "a faction system is not a holding");
    t.equal(holderOf(withUnheld, chain[2]), null, "and neither is an unclaimed one");
    t.check(heldSystems(withUnheld).size === 1,
      "so empire space does not arrive in the live store as sovereignty held by nobody");

    // The property that makes an hourly whole-map pull affordable.
    const rows = store.observations.length;
    const again = await syncSovereignty(store, { fetchImpl: respond(firstRows), now: T(1) });
    t.equal(store.observations.length, rows, "an identical sync adds no rows");
    t.check(again.unchanged, "and says nothing moved rather than implying it did not look");
    t.equal(heldSystems(store).get(chain[0]).lastConfirmed, T(1), "though everything is re-confirmed");

    // --- a system changing hands ---------------------------------------------------
    const taken = firstRows.map((row, index) => (index === 0 ? { ...row, alliance_id: ALLIANCE_B } : row));
    const conquest = await syncSovereignty(store, { fetchImpl: respond(taken), now: T(2) });
    t.equal(conquest.changes.changed.length, 1, "one system changed hands");
    t.equal(conquest.changes.changed[0].from.alliance_id, ALLIANCE_A, "from its old holder");
    t.equal(conquest.changes.changed[0].to.alliance_id, ALLIANCE_B, "to its new one");
    t.equal(holderOf(store, chain[0]).alliance_id, ALLIANCE_B, "and the current holder follows");

    // The history is the point of storing it this way.
    t.equal(historyOf(store, SOV_KIND, chain[0]).length, 2, "both holdings are on the record");
    t.equal(holderOf(store, chain[0], T(1)).alliance_id, ALLIANCE_A,
      "so the store can still say who held it yesterday");

    // --- a system losing sovereignty entirely ----------------------------------------
    const dropped = taken.slice(1);
    const lost = await syncSovereignty(store, { fetchImpl: respond(dropped), now: T(3) });
    t.equal(lost.changes.closed.length, 1, "a system that stops being returned is closed");
    t.equal(holderOf(store, chain[0]), null, "and has no current holder");
    t.equal(historyOf(store, SOV_KIND, chain[0]).length, 2, "but its history is not deleted");
    t.check(historyOf(store, SOV_KIND, chain[0]).every(entry => entry.closedAt !== null),
      "every window it had is closed with a date");

    // --- failure ------------------------------------------------------------------------
    // The map works offline. A failed sync must leave the store untouched.
    const beforeFailure = store.observations.length;
    const offline = await syncSovereignty(store, {
      fetchImpl: async () => { throw new TypeError("Failed to fetch"); },
      now: T(4),
    });
    t.check(!offline.ok, "an unreachable endpoint is a failed sync");
    t.equal(offline.changes, null, "with no changes to report");
    t.equal(store.observations.length, beforeFailure, "and the store is untouched");
    t.equal(holderOf(store, chain[1]).alliance_id, ALLIANCE_A, "so what was known is still known");

    const broken = await syncSovereignty(store, {
      fetchImpl: async () => ({ ok: false, status: 500, headers: headers({}), json: async () => null }),
      now: T(5),
    });
    t.check(!broken.ok, "a server error is a failed sync rather than an empty map");
    t.equal(store.observations.length, beforeFailure,
      "which matters: treating a 500 as an empty response would close every holding in New Eden");

    // --- a 200 that is not a map ------------------------------------------------
    // JSON null and {} both arrive as HTTP 200 from a proxy or a captive
    // portal. Treating either as "nothing is held" closes every sovereignty
    // holding in New Eden and writes that sweep into the permanent history -
    // the most destructive thing this layer could do, and it would look like a
    // successful sync.
    const guarded = createSightings();
    await syncSovereignty(guarded, { fetchImpl: respond(firstRows), now: T(0) });
    const heldBefore = heldSystems(guarded).size;
    t.check(heldBefore > 0, "a store with holdings in it");

    for (const [body, what] of [[null, "JSON null"], [{}, "an object"], ["text", "a string"], [42, "a number"]]) {
      const bad = await syncSovereignty(guarded, { fetchImpl: respond(body), now: T(6) });
      t.check(!bad.ok, `a 200 carrying ${what} is a failed sync, not an empty map`);
      t.equal(heldSystems(guarded).size, heldBefore, `and ${what} leaves every holding alone`);
    }
    // **And `[]` is refused too, which the four shapes above are not enough to cover.**
    // A guard on "is not a list" catches `null`, `{}`, a string and a number, and the
    // one shape that *is* a list walks straight past it into `syncAll` with nothing
    // held, closing every
    // sovereignty window in New Eden and writing that sweep into the permanent
    // log. The next good sync reopens them all on a fresh `firstSeen`, so "who
    // holds this, and since when" is gone for the whole cluster and no pilot
    // action undoes it.
    //
    // `recognisedNothing` cannot catch it either: it requires `payload.length
    // > 0` by design, because for incursions, campaigns and scout an empty list
    // is a real answer. `/sovereignty/map/` is a whole-map endpoint that
    // returns thousands of rows every time and has no empty answer at all.
    const emptyList = await syncSovereignty(guarded, { fetchImpl: respond([]), now: T(7) });
    t.check(!emptyList.ok, "an empty list is refused too, because this endpoint is never empty");
    t.equal(emptyList.result.reason, "malformed", "and is reported as a failed sync rather than a quiet one");
    t.equal(heldSystems(guarded).size, heldBefore, "leaving every holding exactly as it was");

    // --- borders --------------------------------------------------------------------------
    const fresh = createSightings();
    await syncSovereignty(fresh, { fetchImpl: respond(firstRows), now: T(0) });
    const edge = borders(atlas, fresh);
    t.equal(edge.heldCount, chain.length, "every held system is counted");
    t.check(edge.contested.length > 0, "the two alliances meet somewhere");
    t.check(edge.contested.every(entry => entry.facing.length > 0), "and each contested system names who it faces");
    t.check(edge.contested.some(entry => entry.facing.includes(ALLIANCE_B) || entry.facing.includes(ALLIANCE_A)),
      "by alliance");

    // Contested and frontier are different facts and must not be conflated: one
    // is where two alliances meet, the other where sovereignty runs out.
    t.check(edge.frontier.length > 0, "the ends of the chain face unclaimed space");
    t.check(edge.frontier.every(entry => entry.neighbours.length > 0), "each naming the unheld systems beyond it");

    // A faction neighbour is empire or NPC null and can never be taken; an
    // unheld one is claimable. Counting both as frontier told a very different
    // story about where an alliance could actually expand.
    const withFaction = createSightings();
    const endSystem = atlas.systems[String(chain.at(-1))];
    const beyond = endSystem.neighbors.find(id => !chain.includes(id));
    await syncSovereignty(withFaction, {
      fetchImpl: respond([
        ...firstRows,
        ...(beyond ? [{ system_id: beyond, faction_id: 500001 }] : []),
      ]),
      now: T(0),
    });
    t.check(factionSystems(withFaction).size === (beyond ? 1 : 0), "faction space is observed separately");
    t.equal(holderOf(withFaction, beyond), null, "and is not an alliance holding");
    const classified = borders(atlas, withFaction);
    if (beyond) {
      t.check(classified.empire.some(entry => entry.neighbours.some(n => n.system_id === beyond)),
        "a faction neighbour is reported as a border with empire or NPC space");
      t.check(!classified.frontier.some(entry => entry.neighbours.some(n => n.system_id === beyond)),
        "and not as claimable frontier");
      t.check(classified.empire.every(entry => entry.factions.length > 0), "naming which faction");
    }

    // A single alliance holding everything has a frontier and no contested edge.
    const alone = createSightings();
    await syncSovereignty(alone, {
      fetchImpl: respond(chain.map(id => ({ system_id: id, alliance_id: ALLIANCE_A }))),
      now: T(0),
    });
    const solo = borders(atlas, alone);
    t.equal(solo.contested.length, 0, "one alliance alone contests nothing");
    t.check(solo.frontier.length > 0, "but still has a frontier");

    // --- the direct question -----------------------------------------------------------------
    const front = frontBetween(atlas, fresh, ALLIANCE_A, ALLIANCE_B);
    t.check(front.length > 0, "where do these two touch - answered directly");
    t.check(front.every(entry => holderOf(fresh, entry.system.system_id).alliance_id === ALLIANCE_A),
      "listing the first alliance's systems");
    t.check(front.every(entry => entry.touching.every(other => holderOf(fresh, other.system_id).alliance_id === ALLIANCE_B)),
      "each touching only the second's");
    t.equal(frontBetween(atlas, fresh, ALLIANCE_A, 999).length, 0,
      "and an alliance that holds nothing touches nothing");

    t.equal(holdingsOf(fresh, ALLIANCE_A).length, half, "holdings can be listed per alliance");
    t.equal(holdingsOf(fresh, 999).length, 0, "and an alliance with none has none");

    // --- colour ---------------------------------------------------------------------------------
    // Stable across loads, or the map reshuffles its palette every session.
    t.equal(allianceColour(ALLIANCE_A), allianceColour(ALLIANCE_A), "an alliance's colour is stable");
    t.check(allianceColour(ALLIANCE_A) !== allianceColour(ALLIANCE_B), "and differs between alliances");
    t.check(/^hsl\(\d+ 55% 45%\)$/.test(allianceColour(ALLIANCE_A)),
      "with fixed saturation and lightness, so no holder reads as more important than another");
    const hues = new Set([...Array(40).keys()].map(index => allianceColour(99000000 + index * 7)));
    t.check(hues.size > 30, `${hues.size} of 40 nearby alliance ids get distinct colours`);

    // --- nothing known -----------------------------------------------------------------------------
    // An empty store must be distinguishable from "everything is unclaimed".
    const empty = createSightings();
    t.equal(holderOf(empty, chain[0]), null, "an unsynced store knows no holder");
    t.equal(borders(atlas, empty).heldCount, 0, "and reports nothing held");
    t.equal(openObservations(empty, SOV_KIND).length, 0, "having observed nothing at all");

    return t.results;
  })();
}
