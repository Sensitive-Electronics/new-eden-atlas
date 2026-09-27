// Rate limits, backoff scope, and the two ways a live sync died in silence.
//
// These are not edge cases in the decorative sense. Every one of them was found
// by reading the code adversarially rather than by anything failing, and every
// one of them either takes the whole live layer off screen without a message or
// keeps talking to a server that has asked to be left alone. CCP's own docs say
// circumventing the limits is how an application gets banned; the project's
// first law says a live layer must never be able to stop the map drawing.
//
// The two limiters are mutually exclusive and are not interchangeable:
//   420 - the error limiter, X-Esi-Error-Limit-*. Applies to all of ESI.
//   429 - the bucket limiter, X-Ratelimit-*. Applies to one named group.
// Treating a 429 as though it were a 420 takes every layer down over one busy
// endpoint, which is the third test below.

import { suite } from "./helpers.mjs";
import {
  MAX_BACKOFF_MS, backoffUntil, clearBackoff, fetchEsi, groupFor,
  noteBackoff, rememberGroup, retryAfterMs,
} from "../web/esi.js";
import { syncIncursions } from "../web/ambient.js";
import { createSightings, openObservations } from "../web/sightings.js";
import { INCURSION_KIND } from "../web/ambient.js";

const NOW = Date.UTC(2026, 8, 19);
const SOV = "https://esi.evetech.net/latest/sovereignty/map/";
const KILLS = "https://esi.evetech.net/latest/universe/system_kills/";

const headers = map => ({ get: name => map[name.toLowerCase()] ?? null });

export default function run() {
  const t = suite("esi limits");

  return (async () => {
    // --- Retry-After is delta-seconds, not any number JavaScript will take -------
    // `Number()` is far more permissive than the header's grammar, and the gap
    // between them was a thirty-one year backoff from a five-character string.
    clearBackoff();
    t.equal(retryAfterMs("7", NOW), 7000, "plain seconds are seconds");
    t.equal(retryAfterMs("  7  ", NOW), 7000, "with whitespace tolerated");
    t.equal(retryAfterMs("1e9", NOW), null,
      "exponent notation is refused rather than read as 31 years of silence");
    t.equal(retryAfterMs("0x10", NOW), null, "and hexadecimal rather than read as 16 seconds");
    t.equal(retryAfterMs("-5", NOW), null, "and a negative wait, which is not a wait");
    t.equal(retryAfterMs("soon", NOW), null, "and prose");
    t.equal(retryAfterMs("", NOW), null, "an empty header is no instruction");
    t.equal(retryAfterMs(null, NOW), null, "and an absent one is not zero seconds");
    t.equal(retryAfterMs("99999", NOW), MAX_BACKOFF_MS,
      "an implausible wait is capped rather than obeyed, because a layer quiet until 2057 reads as dead");
    t.equal(retryAfterMs(new Date(NOW + 30_000).toUTCString(), NOW), 30_000,
      "and the HTTP-date form is still accepted, because servers send it");

    // --- a group backoff has to be readable, or it is only bookkeeping -----------
    // ESI names the bucket group in the *response*, so it is not known when the
    // request is made. fetchEsi checked without a group, that resolved to the
    // ESI-wide key, and every `esi:<group>` entry ever written was consulted by
    // nothing at all: the client recorded that it had been asked to wait, and
    // then carried straight on asking.
    clearBackoff();
    rememberGroup(SOV, "sovereignty");
    t.equal(groupFor(SOV), "sovereignty", "the group an endpoint answered with is remembered");
    t.equal(groupFor(KILLS), null, "and is not invented for one that has never answered");
    noteBackoff(SOV, { group: "sovereignty", scope: "group", ms: 60_000, now: NOW });
    t.check(backoffUntil(SOV, { now: NOW }) !== null,
      "a group backoff is honoured by the endpoint that earned it");
    t.check(backoffUntil(KILLS, { now: NOW }) === null,
      "and leaves an endpoint in another group alone");
    t.check(backoffUntil(SOV, { now: NOW + 61_000 }) === null, "and it expires");

    // --- an unattributable 429 belongs to its endpoint, not to all of ESI --------
    clearBackoff();
    noteBackoff(SOV, { group: null, scope: "url", ms: 60_000, now: NOW });
    t.check(backoffUntil(SOV, { now: NOW }) !== null, "a 429 with no group header holds its own endpoint");
    t.check(backoffUntil(KILLS, { now: NOW }) === null,
      "without taking every other live layer off the screen with it");

    // --- but the error limiter really does stop everything -----------------------
    clearBackoff();
    noteBackoff(SOV, { scope: "wide", ms: 60_000, now: NOW });
    t.check(backoffUntil(KILLS, { now: NOW }) !== null,
      "a 420 is the error limiter and does stop all of ESI, which is the point of telling them apart");
    clearBackoff();

    // --- the limits, end to end through fetchEsi ----------------------------------
    const serve = (status, map) => async () => ({
      ok: status >= 200 && status < 300,
      status,
      headers: headers(map),
      json: async () => ({}),
    });

    clearBackoff();
    const limited = await fetchEsi("/sovereignty/map/", {
      fetchImpl: serve(429, { "retry-after": "30", "x-ratelimit-group": "sovereignty" }),
      now: NOW,
    });
    t.equal(limited.reason, "rate-limited", "a 429 is reported as a rate limit");
    t.check(backoffUntil(SOV, { now: NOW }) !== null, "and the wait is recorded");
    const refused = await fetchEsi("/sovereignty/map/", {
      fetchImpl: async () => { throw new Error("this request should never have been sent"); },
      now: NOW + 1000,
    });
    t.equal(refused.reason, "backoff", "the next call is refused here rather than sent to a server asking for quiet");
    t.check(backoffUntil(KILLS, { now: NOW + 1000 }) === null,
      "while an endpoint in another group is still reachable");
    clearBackoff();

    // --- a fetch that resolves with nothing ---------------------------------------
    // The try/catch guards the call, not what comes back. `response.headers` on
    // an undefined response threw a TypeError straight out of fetchEsi, past
    // every caller's `if (!result.ok)`, out of the Promise.all in syncLive - and
    // the whole live sync died with nothing said on screen.
    for (const [label, value] of [["undefined", undefined], ["null", null], ["a string", "OK"], ["a number", 200]]) {
      const result = await fetchEsi("/sovereignty/map/", { fetchImpl: async () => value, now: NOW });
      t.equal(result.ok, false, `a fetch resolving with ${label} is a failed sync`);
      t.equal(result.reason, "malformed", `and says so rather than throwing (${label})`);
    }
    // A response that merely has no headers is a different case and must still
    // work, or a server behind a thin proxy becomes an outage.
    const bare = await fetchEsi("/sovereignty/map/", {
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => [] }),
      now: NOW,
    });
    t.equal(bare.ok, true, "a response with no headers at all is still a response");

    // --- one malformed row must not cost every layer -------------------------------
    // `(row.infested_solar_systems ?? []).map(Number)` reaches `.map` on any
    // non-array that is not null, throws, and takes the sync with it.
    const store = createSightings();
    for (const shape of [{}, "30000142", 30000142, { count: 3 }]) {
      const outcome = await syncIncursions(store, {
        now: NOW,
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          headers: headers({ expires: new Date(NOW + 3_600_000).toUTCString() }),
          json: async () => [
            { constellation_id: 20000020, state: "mobilizing", influence: 0.5, infested_solar_systems: shape },
            { constellation_id: 20000021, state: "established", influence: 0.1, infested_solar_systems: [30000142] },
          ],
        }),
      });
      t.equal(outcome.ok, true, `an infested list arriving as ${typeof shape} does not throw the sync away`);
    }
    t.check(openObservations(store, INCURSION_KIND).length > 0,
      "and the rows that were readable are still recorded");

    // --- the one way this application can hammer a public service ---------------
    // There is no polling loop here: the only timer refreshes displayed ages and
    // never issues a request, so every call to ESI is a person pressing Sync.
    // That is not the automated circumvention CCP's docs warn about, and gating
    // it on each endpoint's Expires would make the button lie - most windows are
    // an hour, and a pilot who has waited should be able to look again.
    //
    // A held-down button is the real exposure. Five seconds is ESI's own
    // shortest cache window, so below it there is nothing new to fetch by the
    // server's own account.
    // The runner installs the DOM and imports app.js once, before any module
    // runs. Re-installing it here reset state that other suites were already
    // holding, so this takes the cached module rather than a second one.
    const app = await import("../web/app.js");
    const at = Date.UTC(2026, 8, 19);
    t.equal(app.liveSyncAllowed(at, null), null, "a first sync is never held back");
    t.equal(app.liveSyncAllowed(at, at - 3_600_000), null, "nor one an hour after the last");
    t.equal(app.liveSyncAllowed(at, at - app.MIN_SYNC_INTERVAL_MS), null,
      "nor one exactly at the floor, which is a boundary and not a wall");
    t.check(app.liveSyncAllowed(at, at - 1_000) !== null, "a second press one second later is held");
    t.check(app.liveSyncAllowed(at, at - 4_900) !== null, "and one just inside the floor");
    t.equal(app.liveSyncAllowed(at, at - 1_000), 1,
      "and it reports how long ago, because a button that quietly does nothing reads as broken");

    return t.results;
  })();
}
