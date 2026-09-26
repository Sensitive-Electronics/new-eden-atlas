// The ESI client.
//
// Every test here uses an injected fetch. The suite's promise is that it needs
// no network, and a client that could only be tested by calling CCP would break
// that - so the client takes its fetch as a parameter and these tests hand it
// one that answers from a script.
//
// What is being protected is mostly behaviour under failure, because that is
// what an offline-first tool is actually made of: the map works with no
// network, so every path through here has to degrade rather than throw.

import { suite } from "./helpers.mjs";
import {
  DATASOURCE, ERROR_FLOOR, FALLBACK_INTERVAL_MS, dataAge, describeAge, esiUrl,
  fetchEsi, isDue, nextPollAt, shouldBackOff, cacheExpiry, bucketState, BUCKET_FLOOR,
  APPLICATION, CONTACT_LIMIT, PUBLISHER, backoffKey, backoffUntil, clearBackoff,
  contactRouteSet, noteBackoff, retryAfterMs, setContactRoute, userAgent
} from "../web/esi.js";

const T0 = Date.parse("2026-09-18T18:00:00Z");

// A Headers-alike, since the shim has no fetch and no Headers.
const headers = map => ({ get: name => map[name.toLowerCase()] ?? null });

const reply = ({ status = 200, body = null, head = {} } = {}) => async () => ({
  ok: status >= 200 && status < 300,
  status,
  headers: headers(head),
  json: async () => {
    if (body instanceof Error) throw body;
    return body;
  },
});

export default function run() {
  const t = suite("esi");

  // --- urls -------------------------------------------------------------------
  const url = esiUrl("/sovereignty/map/");
  t.check(url.startsWith("https://esi.evetech.net/latest/sovereignty/map/"), "a path becomes a full URL");
  t.check(url.includes(`datasource=${DATASOURCE}`), "with the datasource always set");
  t.equal(esiUrl("sovereignty/map/"), url, "a leading slash is optional");
  t.check(esiUrl("/x/", { page: 2 }).includes("page=2"), "extra parameters are carried");
  t.check(!esiUrl("/x/", { page: null, size: undefined }).includes("page="),
    "and empty ones are left off rather than sent as the string null");

  // --- the ordinary case --------------------------------------------------------
  const expires = T0 + 3_600_000;
  const okHead = {
    expires: new Date(expires).toUTCString(),
    etag: 'W/"abc"',
    "x-esi-error-limit-remain": "100",
    "x-esi-error-limit-reset": "60",
  };

  return (async () => {
    const good = await fetchEsi("/sovereignty/map/", {
      fetchImpl: reply({ body: [{ system_id: 1 }], head: okHead }), now: T0,
    });
    t.check(good.ok, "a 200 is a success");
    t.equal(good.data.length, 1, "carrying the parsed body");
    t.equal(good.etag, 'W/"abc"', "and the etag, for asking cheaply next time");
    t.equal(good.expiresAt, expires, "and when the server says to ask again");
    t.equal(good.dataAt, T0, "with the moment the data itself was received");
    t.equal(good.errorsRemaining, 100, "and the remaining error budget");

    // --- conditional requests -----------------------------------------------------
    let sentHeaders = null;
    await fetchEsi("/x/", {
      cached: good,
      now: T0,
      fetchImpl: async (_, options) => {
        sentHeaders = options.headers;
        return { ok: false, status: 304, headers: headers(okHead), json: async () => null };
      },
    });
    t.equal(sentHeaders["If-None-Match"], 'W/"abc"', "a stored etag is sent back as If-None-Match");

    // --- what the user agent may and may not carry ---------------------------------
    //
    // CCP strongly prefer a contact address so they can reach an application's
    // author rather than throttling a misbehaving client blind, and they permit
    // a character name. This project sends the first and refuses the second -
    // not for privacy against CCP, who know exactly which character authorised
    // the application, but because a user agent identifies an *application*.
    //
    // The fact the rule rests on is that there is one constant and it goes
    // everywhere, including to the one third-party service. So that is what is
    // asserted: if a per-character agent is ever introduced, the third party
    // starts learning character names, and this is where it should fail.
    // **What it must contain, and what it must not.** This asked
    // `/@|https?:/` - "does it carry a contact route" - which one person's address
    // satisfied and nothing else did. So the test written to stop a per-character agent
    // was simultaneously requiring somebody's inbox in every copy, and it would have
    // failed the moment that was removed. It nearly did.
    const sent = sentHeaders["X-User-Agent"] ?? "";
    t.check(sent.startsWith(`${APPLICATION}/`),
      `the agent names the application and its version (${sent})`);
    t.check(sent.includes(PUBLISHER), "and who publishes it, which is who CCP would contact");
    t.equal(sent, userAgent(), "and it is the one string, built in one place");

    // No inbox, unless somebody deploying this puts one there deliberately.
    t.equal(contactRouteSet(), "", "no contact route is set by default");
    t.check(!sent.includes("@"),
      `so the default agent carries no address at all (${sent})`);

    // A configured one is carried, and is sanitised on the way in: this value goes
    // into an HTTP header, where a newline is request splitting rather than untidiness.
    try {
      setContactRoute(" ops@example.com\r\nX-Injected: yes ");
      t.equal(contactRouteSet(), "ops@example.comX-Injected: yes",
        "the control characters are dropped rather than passed to a header");
      t.check(userAgent().includes("ops@example.com"), "and the route reaches the agent");
      t.check(!userAgent().includes(String.fromCharCode(13)), "with no carriage return in it");
      t.check(!userAgent().includes(String.fromCharCode(10)), "and no newline");
      setContactRoute("x".repeat(CONTACT_LIMIT + 50));
      t.equal(contactRouteSet().length, CONTACT_LIMIT, `and it is capped at ${CONTACT_LIMIT}`);
    } finally {
      setContactRoute("");
    }
    t.equal(contactRouteSet(), "", "and the harness is left as it was found");

    let scoutHeaders = null;
    await fetchEsi("https://api.eve-scout.com/v2/public/signatures", {
      now: T0,
      fetchImpl: async (_, options) => {
        scoutHeaders = options.headers;
        return { ok: true, status: 200, headers: headers(okHead), json: async () => [] };
      },
    });
    t.equal(scoutHeaders["X-User-Agent"], userAgent(),
      "the third-party service is sent the same agent, which is why it must never name a character");

    const laterExpiry = T0 + 7_200_000;
    const unchanged = await fetchEsi("/x/", {
      cached: good,
      now: T0 + 3_600_001,
      fetchImpl: reply({ status: 304, head: { expires: new Date(laterExpiry).toUTCString() } }),
    });
    t.check(unchanged.ok && unchanged.notModified, "a 304 is a success, not a failure");
    t.equal(unchanged.data.length, 1, "the cached data is kept");
    t.equal(unchanged.expiresAt, laterExpiry, "and the new expiry is taken");
    t.equal(unchanged.dataAt, T0, "but the data is as old as it ever was - only the check is fresh");
    t.check(dataAge(unchanged, T0 + 3_600_001) > 3_600_000,
      "so its age keeps growing, which is what an interface must show");

    // --- failure --------------------------------------------------------------------
    // The map works offline. Nothing here may throw.
    const offline = await fetchEsi("/x/", {
      now: T0,
      fetchImpl: async () => { throw new TypeError("Failed to fetch"); },
    });
    t.check(!offline.ok, "an unreachable server is a failure");
    t.equal(offline.reason, "offline", "reported as offline");
    t.check(/Failed to fetch/.test(offline.detail), "with the detail kept for a log");

    const serverError = await fetchEsi("/x/", { now: T0, fetchImpl: reply({ status: 500, head: okHead }) });
    t.check(!serverError.ok && serverError.reason === "http", "a 500 is a failure");
    t.equal(serverError.status, 500, "carrying the status");

    const malformed = await fetchEsi("/x/", {
      now: T0,
      fetchImpl: reply({ body: new SyntaxError("Unexpected token <"), head: okHead }),
    });
    t.check(!malformed.ok && malformed.reason === "malformed",
      "a 200 that is not JSON is a failure rather than an exception - captive portals return HTML");

    // Explicitly false rather than undefined: Node has a global fetch, so
    // omitting it would fall through to the real one and this suite would be
    // making a network call - which it promises never to do.
    const noFetch = await fetchEsi("/x/", { now: T0, fetchImpl: false });
    t.check(!noFetch.ok, "with no fetch implementation at all it still returns");
    t.equal(noFetch.reason, "unavailable", "saying why");

    // --- when to ask again -------------------------------------------------------------
    t.equal(nextPollAt(good, { now: T0 }), expires, "the server's expiry decides the next poll");
    t.check(!isDue(good, { now: T0 }), "so nothing is due before it");
    t.check(isDue(good, { now: expires }), "and it is due at it");
    t.check(isDue(null, { now: T0 }), "never having asked is always due");
    const noExpiry = await fetchEsi("/x/", { now: T0, fetchImpl: reply({ body: [], head: {} }) });
    t.equal(nextPollAt(noExpiry, { now: T0 }), T0 + FALLBACK_INTERVAL_MS,
      "a missing Expires falls back to an hour rather than freezing the layer forever");
    t.check(isDue({ expiresAt: T0 - 1000 }, { now: T0 }),
      "an expiry already past is due now - the server has said it is stale, so waiting another hour would be inventing a schedule");

    // --- the error budget ----------------------------------------------------------------
    // Spending it to zero is how a third-party tool gets blocked.
    t.check(!shouldBackOff(good), "a healthy budget does not back off");
    t.check(shouldBackOff({ errorsRemaining: ERROR_FLOOR }), "at the floor it does");
    t.check(shouldBackOff({ errorsRemaining: 0 }), "and below it");
    t.check(!shouldBackOff({ errorsRemaining: null }), "an absent budget is not treated as exhausted");

    // A response with no error-limit headers at all must not look exhausted.
    // Number(null) is 0, which is finite, so the first guard turned "not
    // reported" into "none left" and backed off on every such response.
    const headerless = await fetchEsi("/x/", { now: T0, fetchImpl: reply({ body: [], head: {} }) });
    t.equal(headerless.errorsRemaining, null, "a missing error-budget header reads as unknown, not zero");
    t.check(!shouldBackOff(headerless), "so a response without the headers does not trigger a back-off");
    const emptyHeader = await fetchEsi("/x/", {
      now: T0, fetchImpl: reply({ body: [], head: { "x-esi-error-limit-remain": "" } }),
    });
    t.equal(emptyHeader.errorsRemaining, null, "and neither does an empty one");
    const real = await fetchEsi("/x/", {
      now: T0, fetchImpl: reply({ body: [], head: { "x-esi-error-limit-remain": "0" } }),
    });
    t.equal(real.errorsRemaining, 0, "while a reported zero is still zero");
    t.check(shouldBackOff(real), "and does back off, which is the case that matters");
    t.check(!shouldBackOff({}), "nor a missing one");

    // --- age --------------------------------------------------------------------------------
    t.equal(dataAge(null), null, "never synced has no age");
    t.equal(describeAge(null), "never synced", "and says so");
    t.equal(describeAge(0), "synced just now", "fresh data says so");
    t.check(/30m ago/.test(describeAge(30 * 60_000)), "minutes for recent data");
    t.check(/2h ago/.test(describeAge(2 * 3_600_000)), "hours for older");
    t.check(/3d ago/.test(describeAge(3 * 86_400_000)), "and days beyond that");

    // --- a Headers object that is not one -------------------------------------
  //
  // This client's whole contract is that it never throws, and a header read is
  // the one place it calls into something somebody else wrote. A real
  // `Response.headers` behaves; a polyfilled fetch, a browser extension or a
  // custom protocol handler in a native shell is not a real Response - and the
  // Tauri work makes that stop being hypothetical.
  const hostile = { get() { throw new Error("hostile headers"); } };
  const survived = await fetchEsi("/x/", {
    now: Date.parse("2026-09-18T12:00:00Z"),
    fetchImpl: async () => ({ ok: true, status: 200, headers: hostile, json: async () => [] }),
  });
  t.check(survived.ok, "a response whose headers throw is still a response");
  t.check(Array.isArray(survived.data), "and its body still arrives");
  t.equal(survived.etag, null, "with every header read reported as unknown");
  t.equal(survived.expiresAt, null, "rather than taking the caller down with it");
  t.equal(bucketState(hostile), null, "and the bucket reader survives it too");
  t.equal(cacheExpiry(hostile, 1), null, "as does the cache reader");

  const noHeaders = await fetchEsi("/x/", {
    now: Date.parse("2026-09-18T12:00:00Z"),
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => [] }),
  });
  t.check(noHeaders.ok, "a response with no headers at all is handled too");

  // --- the other rate limiter ------------------------------------------------
  //
  // ESI has two and they are mutually exclusive per route. The old one counts
  // errors; the new one is a floating-window bucket per route group. Checked
  // against live ESI: /sovereignty/map/ answers with `X-Ratelimit-Limit:
  // 600/15m` and **no error-limit headers at all**, so a client watching only
  // the error limit has no rate awareness there whatsoever. This one did not,
  // despite the project's own rules saying to inspect both.
  const bucketHeaders = headers({
    "x-ratelimit-group": "sovereignty",
    "x-ratelimit-limit": "600/15m",
    "x-ratelimit-remaining": "596",
    "x-ratelimit-used": "2",
  });
  const bucket = bucketState(bucketHeaders);
  t.equal(bucket.limit, 600, "the budget is read from the limit header");
  t.equal(bucket.windowMs, 900_000, "along with the window it refills over");
  t.equal(bucket.remaining, 596, "and what is left");
  t.equal(bucket.group, "sovereignty", "and which group it belongs to");
  t.check(Math.abs(bucket.share - 596 / 600) < 1e-9, "as a share of the budget");

  // A share rather than a count, because the budgets differ per group and a
  // fixed number means nothing against an unknown total.
  t.check(!shouldBackOff({ bucket }), "596 of 600 is not a reason to stop");
  t.check(shouldBackOff({ bucket: bucketState(headers({ "x-ratelimit-limit": "600/15m", "x-ratelimit-remaining": "30" })) }),
    "30 of 600 is");
  t.check(shouldBackOff({ bucket: bucketState(headers({ "x-ratelimit-limit": "10/1m", "x-ratelimit-remaining": "1" })) }),
    "and so is 1 of 10, which a fixed floor of ten would have called exhausted from the start");

  t.equal(bucketState(headers({})), null, "a route with no bucket headers reports no bucket");
  t.check(!shouldBackOff({ bucket: null, errorsRemaining: null }),
    "and silence is not evidence of headroom, but it is not evidence of exhaustion either");
  t.equal(bucketState(headers({ "x-ratelimit-limit": "nonsense", "x-ratelimit-remaining": "5" })).limit, null,
    "an unparseable budget is unknown rather than guessed");
  t.equal(bucketState(headers({ "x-ratelimit-limit": "nonsense", "x-ratelimit-remaining": "5" })).share, null,
    "and a share of an unknown total is not a number");

  // Both limiters are watched, because which one a route uses is not the
  // caller's business.
  t.check(shouldBackOff({ errorsRemaining: 2, bucket: null }), "a near-exhausted error limit still stops us");
  t.check(shouldBackOff({ errorsRemaining: 100, bucket: bucketState(headers({ "x-ratelimit-limit": "600/15m", "x-ratelimit-remaining": "5" })) }),
    "and so does a near-exhausted bucket while the error limit looks fine");

  const rateAt = Date.parse("2026-09-18T12:00:00Z");
  clearBackoff();
  const limited = await fetchEsi("/x/", {
    now: rateAt,
    fetchImpl: async () => ({
      ok: false, status: 429,
      headers: headers({ "retry-after": "42", "x-ratelimit-limit": "600/15m", "x-ratelimit-remaining": "0" }),
      json: async () => ({}),
    }),
  });
  t.check(!limited.ok, "a 429 is a failure");
  t.equal(limited.reason, "rate-limited", "named as a rate limit rather than a generic error");
  t.equal(limited.retryAfter, 42, "carrying how long to wait, which is what ignoring gets an app banned for");
  t.equal(limited.bucket?.remaining, 0, "and the bucket that caused it");

  // --- and the wait is actually taken ------------------------------------------
  //
  // Nothing polls on its own today, so a refusal just came back as a failure
  // and could be retried immediately. A scheduler turns that into a loop, and a
  // loop that ignores Retry-After is the shape of a ban.
  let reached = false;
  const blocked = await fetchEsi("/x/", {
    now: rateAt + 1000,
    fetchImpl: async () => { reached = true; throw new Error("should not be called"); },
  });
  t.check(!reached, "a request inside the stated wait never reaches the network");
  t.equal(blocked.reason, "backoff", "and says why it did not");
  t.check(blocked.retryAfter > 0, "with how much longer to wait");

  // Scoped, not global. The two limiters cover different things and so do
  // different hosts, and one shared timestamp would turn any single refusal
  // into a total outage.
  t.equal(backoffKey("https://esi.evetech.net/latest/x/", "sovereignty"), "esi:sovereignty",
    "a bucket refusal is that route group's");
  t.equal(backoffKey("https://esi.evetech.net/latest/x/", null), "esi:*",
    "an error-limit refusal is all of ESI's, as the documentation says");
  t.equal(backoffKey("https://api.eve-scout.com/v2/public/signatures"), "api.eve-scout.com",
    "and another service is its own");

  clearBackoff();
  t.equal(backoffUntil("https://esi.evetech.net/latest/x/", { now: rateAt }), null, "cleared, nothing is held");
  noteBackoff("https://esi.evetech.net/latest/x/", { group: "sovereignty", ms: 60_000, now: rateAt });
  t.check(backoffUntil("https://esi.evetech.net/latest/x/", { group: "sovereignty", now: rateAt }),
    "a limited group is held");
  t.equal(backoffUntil("https://esi.evetech.net/latest/x/", { group: "universe", now: rateAt }), null,
    "while another group carries on - a limited sovereignty must not stop the wormhole layer");
  t.equal(backoffUntil("https://api.eve-scout.com/v2/", { now: rateAt }), null,
    "and a third-party service is untouched by CCP's limits");

  clearBackoff();
  noteBackoff("https://esi.evetech.net/latest/x/", { ms: 60_000, now: rateAt });
  t.check(backoffUntil("https://esi.evetech.net/latest/x/", { group: "sovereignty", now: rateAt }),
    "an ESI-wide refusal covers every group, including ones with their own bucket");

  // Seconds or an HTTP date; a server may send either.
  t.equal(retryAfterMs("30", rateAt), 30_000, "Retry-After in seconds");
  t.equal(retryAfterMs(new Date(rateAt + 45_000).toUTCString(), rateAt), 45_000, "or as a date");
  t.equal(retryAfterMs("", rateAt), null, "absent is not zero");
  t.equal(retryAfterMs("soon", rateAt), null, "and unparseable is not zero either");
  // A real Retry-After date that has already passed is an instruction, and it
  // means there is nothing to wait for. Zero, not a refusal, and never negative.
  t.equal(retryAfterMs(new Date(rateAt - 45_000).toUTCString(), rateAt), 0,
    "a wait in the past is no wait, not a negative one");
  // "-5" was standing in for that case and is not a date at all - it is a
  // malformed delta-seconds, which Date.parse will happily read as a year.
  // Refusing it is not the same answer as "no wait", and the difference matters
  // because only one of the two is a server that told us something.
  t.equal(retryAfterMs("-5", rateAt), null, "a negative delta-seconds is malformed, not a zero wait");

  clearBackoff();

  // --- how long may this be held --------------------------------------------
  //
  // Cache-Control wins over Expires where both are present, which is what HTTP
  // says and what decides whether this project is a good citizen. EVE-Scout
  // sends max-age=300 alongside an Expires two seconds behind its own Date, so
  // a client reading only Expires treats the answer as permanently stale and
  // re-requests as fast as somebody clicks. Being rude to a small service that
  // does not have to exist is a correctness problem, not a style one.
  const at = Date.parse("2026-09-18T12:00:00Z");
  t.equal(cacheExpiry(headers({ "cache-control": "public, max-age=300" }), at), at + 300_000,
    "max-age is read as a freshness lifetime from now");
  t.equal(cacheExpiry(headers({ "cache-control": "max-age=0" }), at), at,
    "zero means it is already stale");
  t.equal(cacheExpiry(headers({ "cache-control": "no-store" }), at), at,
    "and so does a refusal to store it at all");
  t.equal(cacheExpiry(headers({ "cache-control": "public" }), at), null,
    "a header saying nothing about duration yields nothing, rather than now");
  t.equal(cacheExpiry(headers({}), at), null, "as does an absent header");
  t.equal(cacheExpiry(null, at), null, "and absent headers entirely");

  const stale = new Date(at - 2000).toUTCString();
  const both = await fetchEsi("/x/", {
    now: at,
    fetchImpl: async () => ({
      ok: true, status: 200,
      headers: headers({ expires: stale, "cache-control": "public, max-age=300" }),
      json: async () => [],
    }),
  });
  t.equal(both.expiresAt, at + 300_000,
    "a response with both is held for its max-age, not discarded for its Expires");
  t.check(!isDue({ expiresAt: both.expiresAt }, { now: at }), "so it is not immediately due again");

  // --- an absolute URL is somebody else's -------------------------------------
  //
  // This client is really "fetch a cacheable JSON resource, conditionally,
  // without ever throwing". The ESI-specific parts are the base and the
  // datasource, and the one third-party endpoint here reuses the rest rather
  // than growing a second, less careful copy.
  const absolute = "https://api.eve-scout.com/v2/public/signatures";
  t.equal(esiUrl(absolute), absolute, "an absolute URL is passed through untouched");
  t.check(!esiUrl(absolute).includes("datasource"),
    "without a datasource, which means nothing to a service that is not ESI");
  t.check(esiUrl(absolute, { page: 2 }).endsWith("?page=2"), "though it still takes parameters");
  t.check(esiUrl("/status/").startsWith("https://esi.evetech.net"),
    "while a path is still resolved against ESI");
  t.check(esiUrl("/status/").includes("datasource"), "with its datasource");

  let requested = null;
  await fetchEsi(absolute, { now: at, fetchImpl: async url => { requested = String(url); throw new TypeError("stop"); } });
  t.equal(requested, absolute, "and the request actually goes to that host");

  return t.results;
  })();
}
