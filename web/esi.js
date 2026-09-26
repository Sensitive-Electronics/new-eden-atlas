// The ESI client.
//
// One place for the things every endpoint needs: where to ask, when to ask
// again, how to ask cheaply, and what to do when the answer does not come.
// Endpoint-specific code sits on top of this and holds no HTTP of its own.
//
// Scope, deliberately: **public endpoints only**. No authentication, no token
// refresh, no character scopes. Those are a larger problem - a vault, a refresh
// cycle, somewhere safe to keep a refresh token - and none of the layers being
// built now need them. Sovereignty, incursions, faction warfare and system
// kills are all unauthenticated. This module is shaped so an auth layer can sit
// beside it later rather than requiring it to be rewritten, and that is as far
// as designing for it should go before something actually needs it.
//
// Four rules it exists to enforce:
//
// **Nothing throws.** A request that fails returns a result saying so. The map
// works offline, and a layer that cannot reach ESI must degrade to "no data,
// here is when I last had some" rather than take anything down with it.
//
// **The server decides when to ask again.** ESI sends `Expires` on every
// response. Polling on a timer of our own choosing either wastes calls or reads
// stale data; polling on theirs does neither.
//
// **Ask cheaply.** A stored `ETag` makes the next request conditional, and a
// 304 costs nothing against the error limit and returns no body.
//
// **Back off when told to.** ESI publishes an error budget in response headers.
// Spending it is how a third-party tool gets blocked, and no map layer is worth
// that.

export const ESI_BASE = "https://esi.evetech.net/latest";
export const DATASOURCE = "tranquility";

// Sent so CCP can identify the caller, which their third-party policy asks for and
// which is what gets a tool contacted rather than blocked when it misbehaves. They
// "strongly prefer" a contact address as well as a name and version.
//
// **It is the application that is identified, not a person.** A shipped binary
// carrying one person's inbox attributes every pilot's traffic to them and sends CCP
// to the wrong human about somebody else's client, which is worse than no contact at
// all because it looks like one. So the default names the application and who
// publishes it, and a contact route is **set by whoever deploys this, empty until
// they do**. An empty one is honest: CCP can still identify the application, which
// is the part they require, and nobody is falsely nominated as its operator.
//
// No character name, ever. Not for privacy against CCP, who run the game and know
// which character authorised this application, but because a user agent identifies
// an *application* rather than a session: the same string goes to EVE-Scout, which
// deliberately keeps no character names; with thirty characters there is no correct
// one to choose; and labelling an installation with one is a correlation handle
// nobody asked for.
export const APPLICATION = "NewEdenAtlas";
export const VERSION = "1.0";
export const PUBLISHER = "Sensitive Electronics";

// Bounded, because this ends up in an HTTP header.
export const CONTACT_LIMIT = 120;

let contactRoute = "";

// **A header value, so it is sanitised rather than trusted.** A configured contact is
// text from outside this file, and a carriage return or newline inside a header value
// is request splitting - the reason every character outside printable ASCII is dropped
// here rather than checked for later. Capped for the same reason `MAX_SIDECAR_LINE`
// exists: a bound nobody can argue with beats a length nobody checked.
export function setContactRoute(value) {
  const text = typeof value === "string" ? value : "";
  contactRoute = [...text]
    .filter((character) => {
      const code = character.codePointAt(0);
      return code >= 0x20 && code <= 0x7e;
    })
    .join("")
    .trim()
    .slice(0, CONTACT_LIMIT);
  return contactRoute;
}

export function contactRouteSet() {
  return contactRoute;
}

// Built rather than stored, so the contact cannot be set after the string was made
// and leave the two disagreeing - which is how a constant and a setting usually end.
export function userAgent() {
  return contactRoute
    ? `${APPLICATION}/${VERSION} (${PUBLISHER}; ${contactRoute})`
    : `${APPLICATION}/${VERSION} (${PUBLISHER})`;
}

export function esiUrl(path, params = {}) {
  // An absolute URL is passed through untouched. This client is really "fetch a
  // cacheable JSON resource, conditionally, without ever throwing", and the
  // only ESI-specific parts are the base and the datasource - so the one
  // third-party endpoint this project reaches can reuse the caching and
  // failure behaviour rather than growing a second, less careful copy of it.
  if (/^https?:\/\//i.test(path)) {
    const absolute = new URL(path);
    for (const [key, value] of Object.entries(params)) {
      if (value !== null && value !== undefined) absolute.searchParams.set(key, String(value));
    }
    return absolute.toString();
  }
  const url = new URL(`${ESI_BASE}${path.startsWith("/") ? path : `/${path}`}`);
  url.searchParams.set("datasource", DATASOURCE);
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

// One place that touches a Headers object, because this client's contract is
// that it never throws and a header read is the one thing here that calls into
// something somebody else wrote.
//
// A real `Response.headers` does not throw. A polyfilled fetch, a browser extension
// or a custom protocol handler in a native shell is not a real Response, and a
// throwing `get()` escapes every other guard in this module and takes a whole sync
// with it.
function readHeader(headers, name) {
  try {
    const raw = headers?.get?.(name);
    return raw === undefined ? null : raw;
  } catch {
    return null;
  }
}

function headerNumber(headers, name) {
  const raw = readHeader(headers, name);
  // An absent header is unknown, not zero. `Number(null)` is 0 and 0 is finite, so a
  // guard that only tests finiteness turns "no error budget reported" into "no error
  // budget left" and backs off on every response that omits the header.
  if (raw === null || raw === undefined || raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function headerDate(headers, name) {
  const raw = readHeader(headers, name);
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

// A single request. Returns a result rather than throwing, always, including
// when there is no network at all.
//
// `cached` is a previous result for the same path; its etag makes the request
// conditional and its data is returned unchanged on a 304.
// The freshness lifetime from Cache-Control, as an absolute instant. Null when
// the header is absent or says nothing about how long this may be held.
export function cacheExpiry(headers, now = Date.now()) {
  const control = readHeader(headers, "cache-control");
  if (typeof control !== "string") return null;
  if (/\bno-store\b|\bno-cache\b/i.test(control)) return now;
  const match = /\bmax-age\s*=\s*(\d+)/i.exec(control);
  if (!match) return null;
  return now + Number(match[1]) * 1000;
}

// --- honouring Retry-After -----------------------------------------------------
//
// A 429 or a 420 names how long to wait, and ignoring it is what gets an application
// banned. Every sync here is a button press, so a rejected request comes back as a
// failure and a pilot may press again - but a scheduler makes that a loop, and a loop
// that ignores Retry-After is the shape of a ban.
//
// **Not one global timestamp**, because the two limiters have different scopes and so
// do different hosts:
//
//   the error limiter is global to ESI - the docs say every request is
//     discarded until the window ends, whatever route it was for;
//   the bucket limiter is per route group, so a limited `sovereignty` group
//     must not stop the wormhole layer asking about something else;
//   and EVE-Scout is a different service entirely, whose limits say nothing
//     about CCP's.
//
// One shared timestamp would turn any single refusal into a total outage.
const backoffs = new Map();

// A rate limit we could not attribute belongs to the endpoint that earned it,
// not to all of ESI. Query strings are dropped so the same endpoint asked with
// different parameters shares one penalty.
export function urlKey(url) {
  try {
    const parsed = new URL(url);
    return `url:${parsed.origin}${parsed.pathname}`;
  } catch {
    return `url:${url}`;
  }
}

// The bucket group a URL was last seen to belong to.
//
// ESI names the group in the response, so it is not knowable when the request is
// made. Without this, a group-scoped backoff is written and never read: a check with
// no group resolves to the ESI-wide key and `esi:<group>` is consulted by nothing.
// Remembering what each endpoint answered with is what makes a group-scoped refusal
// enforceable.
const groupsSeen = new Map();

export function rememberGroup(url, group) {
  if (group) groupsSeen.set(urlKey(url), group);
  return group ?? null;
}

export function groupFor(url) {
  return groupsSeen.get(urlKey(url)) ?? null;
}

export function backoffKey(url, group = null) {
  let host;
  try {
    host = new URL(url).host;
  } catch {
    host = "unknown";
  }
  const esi = host === new URL(ESI_BASE).host;
  // Without a group, an ESI refusal is the error limiter's, which stops
  // everything. With one, it is that group's alone.
  if (esi) return group ? `esi:${group}` : "esi:*";
  return host;
}

// Every scope that could be holding this URL back: the error limiter, which
// stops all of ESI; this endpoint's bucket group, if we have ever seen which
// one it is; and the endpoint itself, for a refusal we could not attribute.
export function backoffUntil(url, { group = null, now = Date.now() } = {}) {
  const wide = backoffKey(url, null);
  const keys = new Set([wide, urlKey(url)]);
  const scoped = group ?? groupFor(url);
  if (scoped) keys.add(backoffKey(url, scoped));
  const until = [...keys].map(key => backoffs.get(key) ?? 0).reduce((a, b) => Math.max(a, b), 0);
  return until > now ? until : null;
}

// The longest wait this client will take from a header. A server asking for
// more than an hour is either broken or sending something we have misread, and
// a layer that goes quiet until 2057 is indistinguishable from one that is
// permanently dead.
export const MAX_BACKOFF_MS = 60 * 60 * 1000;

// Seconds, or an HTTP date. Both are legal and a server may send either.
//
// `Number()` accepts a great deal that `Retry-After` does not. HTTP defines the
// numeric form as delta-seconds - digits, nothing else - while `Number("1e9")` is a
// 31-year backoff, `Number("0x10")` is 16 seconds by accident and `Number("")` is 0.
// So the numeric form is matched literally, and anything else is offered to the date
// parser before being refused.
export function retryAfterMs(raw, now = Date.now()) {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  if (text === "") return null;
  if (/^\d+$/.test(text)) return Math.min(MAX_BACKOFF_MS, Number(text) * 1000);
  // Every legal HTTP-date carries a weekday and a month name, so a value with no
  // letters in it is not one. `Date.parse` is generous enough to read "-5" as a year,
  // and requiring the shape of a date first is what separates a server's instruction
  // from a string that merely survived a parser.
  if (!/[a-z]/i.test(text)) return null;
  const when = Date.parse(text);
  if (!Number.isFinite(when)) return null;
  // A date already past is a real instruction meaning there is nothing to wait
  // for. That is zero, not a refusal, and not a negative wait.
  return Math.min(MAX_BACKOFF_MS, Math.max(0, when - now));
}

// `scope` says how far the refusal reaches. "wide" is the error limiter and stops
// everything; "group" is one bucket; "url" is this endpoint alone, which is where an
// unattributable 429 belongs - scoping one endpoint's rate limit to all of ESI takes
// every live layer down over a single busy call.
export function noteBackoff(url, { group = null, scope = null, ms = 0, now = Date.now() } = {}) {
  if (!(ms > 0)) return null;
  const key = scope === "url" ? urlKey(url)
    : scope === "wide" ? backoffKey(url, null)
      : backoffKey(url, group);
  const until = now + ms;
  if ((backoffs.get(key) ?? 0) < until) backoffs.set(key, until);
  return until;
}

// For tests, and for a pilot who has waited and wants to try anyway.
export function clearBackoff() {
  backoffs.clear();
  groupsSeen.clear();
}

export async function fetchEsi(path, { params = {}, cached = null, fetchImpl = null, now = Date.now(), signal = null } = {}) {
  const url = esiUrl(path, params);
  const doFetch = fetchImpl ?? (typeof fetch === "function" ? fetch : null);
  if (!doFetch) {
    return { ok: false, reason: "unavailable", detail: "No fetch implementation is available.", url, fetchedAt: now };
  }

  // Refused by us, before it reaches them. A request sent during a stated
  // cooling-off period is the one that turns a rate limit into a ban.
  const held = backoffUntil(url, { now });
  if (held !== null) {
    return {
      ok: false,
      reason: "backoff",
      detail: `Waiting until ${new Date(held).toISOString()} as the server asked.`,
      retryAfter: Math.ceil((held - now) / 1000),
      url,
      fetchedAt: now,
    };
  }

  const headers = { Accept: "application/json" };
  // A browser refuses to set User-Agent, so this is sent where it is allowed
  // and silently dropped where it is not rather than failing the request.
  headers["X-User-Agent"] = userAgent();
  if (cached?.etag) headers["If-None-Match"] = cached.etag;

  let response;
  try {
    response = await doFetch(url, { headers, signal });
  } catch (error) {
    // Offline, blocked, cancelled. The caller keeps whatever it had.
    return { ok: false, reason: "offline", detail: String(error?.message ?? error), url, fetchedAt: now };
  }

  // A fetch that resolves with nothing. The `try` above guards the call and not what
  // comes back, so `response.headers` on an undefined response throws a TypeError out
  // of `fetchEsi` - past every caller's `if (!result.ok)`, out of the `Promise.all` in
  // `syncLive`, and the whole live sync dies without a word on screen. A service
  // worker, a stubbed fetch and a mocked test all produce it.
  //
  // Only a non-response is refused. A response that merely has no headers is
  // legitimate - `readHeader` guards every read - and rejecting it would turn a
  // working server behind a thin proxy into an outage.
  if (!response || typeof response !== "object") {
    return {
      ok: false,
      reason: "malformed",
      detail: "The fetch returned something that is not a response.",
      url,
      fetchedAt: now,
    };
  }

  // `max-age` wins over `Expires` where both are present, which is what HTTP says
  // and what matters here: EVE-Scout sends `Cache-Control: max-age=300` alongside an
  // `Expires` two seconds behind its own `Date`, so a client reading only `Expires`
  // treats it as permanently stale and polls a small volunteer-run service as fast as
  // the pilot clicks.
  const expiresAt = cacheExpiry(response.headers, now) ?? headerDate(response.headers, "expires");
  const etag = readHeader(response.headers, "etag");
  const errorsRemaining = headerNumber(response.headers, "x-esi-error-limit-remain");
  const errorWindowResets = headerNumber(response.headers, "x-esi-error-limit-reset");
  const bucket = bucketState(response.headers);
  // Recorded on every response, so a later refusal can be scoped to the group
  // this endpoint actually belongs to rather than to all of ESI.
  rememberGroup(url, bucket?.group ?? null);
  // 429 from the bucket limiter, 420 from the error limiter. Both name how long
  // to wait, and ignoring that is what gets an application banned.
  const retryAfter = headerNumber(response.headers, "retry-after");

  // **A 304 is only an answer to a question that was asked.**
  //
  // A 304 taken at face value is a reverse proxy, a captive portal or a
  // custom-protocol handler answering 304 to everything and being read as "nothing
  // changed since the reading you have" - so `confirmAll` advances `lastConfirmed` on
  // every open observation and the whole sighting log stays "confirmed just now"
  // having observed nothing.
  //
  // That is the governing law in the mirror: "a failed sync reports nothing; it does
  // not report that the world emptied" guards absence of observation being written as
  // absence of the world, and this is absence of observation written as *presence*.
  //
  // With no etag to have sent, a 304 is a broken response and falls through to the
  // `!response.ok` handling below, which reports a failed sync - so nothing is
  // confirmed and nothing is closed.
  if (response.status === 304 && cached?.etag) {
    // Nothing changed. Keep the data and take the new expiry, which is the
    // whole point of asking conditionally.
    return {
      ok: true, notModified: true, data: cached?.data ?? null,
      etag: cached?.etag ?? etag, expiresAt, fetchedAt: now,
      // The data is as old as it ever was; only the check is fresh.
      dataAt: cached?.dataAt ?? cached?.fetchedAt ?? null,
      errorsRemaining, errorWindowResets, bucket, retryAfter, url, status: 304,
    };
  }

  // An unasked-for 304 arrives here. `response.ok` is false for 304, so the
  // status is reported as it stands and the caller treats it as a failed sync -
  // which is what it is.
  if (!response.ok) {
    // 429 is the bucket limiter and applies to this group; 420 is the error
    // limiter and applies to everything on ESI. A Retry-After on any other
    // failure is honoured too - a server asking to be left alone is not
    // required to justify itself.
    const waitMs = retryAfterMs(readHeader(response.headers, "retry-after"), now)
      // 420 with no Retry-After still resets on a stated boundary.
      ?? (response.status === 420 && errorWindowResets !== null ? errorWindowResets * 1000 : null);
    if (waitMs !== null) {
      // 420 is the error limiter and stops all of ESI. 429 is one bucket's, and
      // reaches only as far as we can attribute it: the named group if there is
      // one, otherwise this endpoint alone.
      const group = bucket?.group ?? null;
      const scope = response.status === 420 ? "wide" : group ? "group" : "url";
      noteBackoff(url, { group, scope, ms: waitMs, now });
    }
    return {
      ok: false, reason: response.status === 429 || response.status === 420 ? "rate-limited" : "http",
      status: response.status,
      detail: `ESI returned ${response.status}.`,
      expiresAt, errorsRemaining, errorWindowResets, bucket, retryAfter, url, fetchedAt: now,
    };
  }

  let data;
  try {
    data = await response.json();
  } catch (error) {
    return { ok: false, reason: "malformed", detail: String(error?.message ?? error), url, fetchedAt: now, status: response.status };
  }

  return {
    ok: true, notModified: false, data, etag, expiresAt,
    fetchedAt: now,
    // When the data was produced, not when it was asked for. A 200 served from a
    // cache or a CDN can be most of its cache window old already, so treating the
    // moment of the request as the age of the answer overstates how current the map
    // is - by up to an hour on an hourly endpoint. `Last-Modified` is the age of the
    // representation.
    dataAt: headerDate(response.headers, "last-modified") ?? now,
    errorsRemaining, errorWindowResets, bucket, retryAfter,
    url, status: response.status,
  };
}

// When to ask again, taken from the server rather than chosen here.
//
// No Expires means we have no guidance, so a conservative hour is used - the
// same order as ESI's own caches for the slow endpoints, and short enough that
// a missing header does not freeze a layer forever.
export const FALLBACK_INTERVAL_MS = 60 * 60 * 1000;

export function nextPollAt(result, { now = Date.now(), fallbackMs = FALLBACK_INTERVAL_MS } = {}) {
  if (!result) return now;
  // An expiry already past means due now, not due in another hour. The server
  // has said the data is stale; waiting again would be inventing a schedule it
  // did not ask for.
  if (result.expiresAt) return result.expiresAt;
  const base = result.fetchedAt ?? now;
  return base + fallbackMs;
}

export function isDue(result, { now = Date.now(), fallbackMs = FALLBACK_INTERVAL_MS } = {}) {
  if (!result) return true;
  // At the expiry moment itself, due. Strictly-after left a request one
  // millisecond short of the time the server named.
  return now >= nextPollAt(result, { now, fallbackMs });
}

// The error budget. Below the floor, stop asking until the window resets:
// spending it to zero is how a third-party tool gets blocked, and no map layer
// is worth that.
export const ERROR_FLOOR = 10;

// ESI has two rate limiters and they are mutually exclusive per route.
//
// The old one counts errors: X-Esi-Error-Limit-Remain, and 420 when exhausted.
// The new one is a floating-window bucket: X-Ratelimit-Remaining against
// X-Ratelimit-Limit, per route group, and 429 when exhausted.
//
// Read live on 2026-09-18: `/sovereignty/map/` answers with
// `X-Ratelimit-Limit: 600/15m` and **no error-limit headers at all**, so a client
// watching only the error limit has no rate awareness on that route whatsoever. Both
// are inspected. The floor is a fraction rather than a count, because the limits
// differ per group and a fixed number means nothing against an unknown budget.
export const BUCKET_FLOOR = 0.1;

export function bucketState(headers) {
  const remaining = headerNumber(headers, "x-ratelimit-remaining");
  const used = headerNumber(headers, "x-ratelimit-used");
  const group = readHeader(headers, "x-ratelimit-group");
  // "600/15m" - the budget and the window it refills over.
  const raw = readHeader(headers, "x-ratelimit-limit");
  const parsed = typeof raw === "string" ? /^(\d+)\s*\/\s*(\d+)\s*([smh])$/i.exec(raw.trim()) : null;
  const limit = parsed ? Number(parsed[1]) : null;
  const windowMs = parsed
    ? Number(parsed[2]) * ({ s: 1000, m: 60_000, h: 3_600_000 })[parsed[3].toLowerCase()]
    : null;
  if (remaining === null && limit === null) return null;
  return {
    group,
    limit,
    used,
    remaining,
    windowMs,
    // What is left of the budget, as a fraction. Null when either half is
    // missing, because a share of an unknown total is not a number.
    share: remaining !== null && limit ? remaining / limit : null,
  };
}

// Either limiter running low is a reason to stop asking. Which one a route uses
// is not this caller's business, and a route that answers with neither is not
// evidence of headroom - only of silence.
export function shouldBackOff(result, { floor = ERROR_FLOOR, bucketFloor = BUCKET_FLOOR } = {}) {
  const errors = result?.errorsRemaining;
  if (errors !== null && errors !== undefined && errors <= floor) return true;
  const share = result?.bucket?.share;
  return share !== null && share !== undefined && share <= bucketFloor;
}

// How old the data is, as opposed to how long ago it was checked. A 304 makes
// those two different, and the interface must show the first.
export function dataAge(result, now = Date.now()) {
  const at = result?.dataAt ?? result?.fetchedAt ?? null;
  return at === null ? null : Math.max(0, now - at);
}

// The verb is a parameter because not everything that has an age was synced. A
// character's vault row shows when it was added, so "synced" there would be the
// application claiming to have checked something it has not. The verb belongs in the
// phrase rather than prefixed by the caller, or the line reads "added synced 20m
// ago".
export function describeAge(ageMs, verb = "synced") {
  if (ageMs === null || ageMs === undefined) return `never ${verb}`;
  const minutes = Math.floor(ageMs / 60000);
  if (minutes < 1) return `${verb} just now`;
  if (minutes < 60) return `${verb} ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${verb} ${hours}h ago`;
  return `${verb} ${Math.floor(hours / 24)}d ago`;
}

// What a failed sync leaves on a layer's meta.
//
// Every layer's failure path renders an error string and returns, leaving the
// previous meta untouched. That is right about the *data* - the last confirmed
// reading stands - and silent about the *attempt*, so a layer that just 503'd is
// indistinguishable from one that answered: honest about its age, hiding that it is
// no longer being refreshed.
//
// The error string is not enough, because it lives only on screen. Anything reading
// state rather than the DOM sees a layer that looks synced, and `sourceState` in
// `snapshot.js` asks `meta.failed === true`.
//
// Here rather than inside `app.js` so a test can call them: closed over in a module
// nothing imports, they are reachable only through a sync that fails.
//
// The previous `dataAt` survives deliberately. "The last reading is an hour old and
// the last attempt failed" is two facts and both matter; dropping the age turns a
// stale-but-real reading into no reading at all.
export function markSyncFailed(meta, reason, now = Date.now()) {
  return { ...(meta ?? {}), failed: true, failedAt: now, failedReason: String(reason ?? "unknown") };
}

// Its opposite, so a recovery clears the mark rather than leaving a layer
// permanently suspect. Success paths that build a fresh object drop the mark
// by accident; going through here makes it deliberate, so the next edit that
// spreads the old meta forward does not keep a recovered layer failed.
export function clearSyncFailure(meta) {
  if (!meta) return {};
  const cleared = { ...meta };
  delete cleared.failed;
  delete cleared.failedAt;
  delete cleared.failedReason;
  return cleared;
}
