# ESI and third-party service rules

Read from CCP's developer documentation and from live response headers on
**2026-09-18**, and filed here because the network is not always there and
because "we checked" is worth less than "here is what it said".

Sources:

- <https://developers.eveonline.com/docs/services/esi/best-practices/>
- <https://developers.eveonline.com/docs/services/esi/rate-limiting/>
- <https://developers.eveonline.com/docs/services/sso/>

Re-read before any work that changes how this project talks to a server. CCP
changes these, and the most important thing on this page - that one of the two
rate limiters has been switched off on the routes we use - was true on the day
it was written and was not true when the client was first built.

---

## The two rate limiters, and why watching one is watching none

ESI has **two** limiters and they are **mutually exclusive per route**.

| | old | new |
| --- | --- | --- |
| counts | errors | all requests |
| window | fixed | floating |
| headers | `X-Esi-Error-Limit-Remain`, `X-Esi-Error-Limit-Reset` | `X-Ratelimit-Limit`, `X-Ratelimit-Remaining`, `X-Ratelimit-Used`, `X-Ratelimit-Group` |
| exhausted | `420` on every route | `429` |

**Measured on `/sovereignty/map/`, 2026-09-18:**

```
X-Ratelimit-Group          sovereignty
X-Ratelimit-Limit          600/15m
X-Ratelimit-Remaining      596
X-Esi-Error-Limit-Remain   (absent)
```

The error-limit headers are **gone** on that route. A client watching only them
has no rate awareness there at all, which is what this one had until the
`bucketState` work. The limit is expressed as a budget over a window and
**differs per group**, so a fixed floor of "ten remaining" is meaningless -
against a budget of ten it means exhausted from the first request. The floor
here is a *share* of the budget.

Rate limiting is not yet on every route. Neither family of headers is a promise;
**silence is not evidence of headroom.**

## Caching, and the one way to get banned by accident

> You should not update before [Expires]. ... In the worst case scenario you
> will get new data, and it may count as circumventing the ESI caching.
> Circumventing the ESI caching can get you banned from ESI.

- `Expires` - when to ask again. Do not ask earlier.
- `Last-Modified` - when the data was produced, which is **not** when you asked.
  A cached response can already be most of its window old.
- `ETag` - send it back as `If-None-Match` and take the `304`.
- Paginated resources should carry the **same** `Last-Modified` across pages;
  a difference means the data changed mid-read and the result is inconsistent.

**On `Cache-Control` vs `Expires`:** ESI sends both and they agree -
`max-age=3600` against `Expires - Date = 3600s` on `/sovereignty/map/`. HTTP says
`max-age` wins, and this project follows that, which is safe here because they
agree and *necessary* for EVE-Scout, which sends `max-age=300` alongside an
`Expires` two seconds **behind its own `Date`**. Reading only `Expires` there
means treating every answer as already stale and re-requesting as fast as
somebody clicks.

## Cache windows, and the two nobody has measured

What a source's cache window is decides what a snapshot may say about its
freshness, so it is recorded here rather than guessed at the call site.

| source | window | where it is recorded |
| --- | --- | --- |
| `/universe/system_kills/`, `/universe/system_jumps/` | 3600s | "These endpoints republish **hourly**", below |
| `/sovereignty/map/` | 3600s | `max-age=3600`, above |
| EVE-Scout | 300s | `max-age=300`, above |
| `/sovereignty/campaigns/` | **5s** | `web/campaigns.js`, confirmed live 2026-09-18 |
| `/incursions/` | **300s** | measured 2026-09-23, below |
| `/fw/systems/` | **1800s** | measured 2026-09-23, below |

### The two, measured 2026-09-23

Read live, twice, four minutes apart. Headers verbatim:

    GET https://esi.evetech.net/latest/incursions/
      cache-control : public
      last-modified : Wed, 23 Sep 2026 21:02:15 GMT
      expires       : Wed, 23 Sep 2026 21:07:15 GMT      -> 300s

    GET https://esi.evetech.net/latest/fw/systems/
      cache-control : public
      last-modified : Wed, 23 Sep 2026 20:41:56 GMT
      expires       : Wed, 23 Sep 2026 21:11:56 GMT      -> 1800s

**`Expires - Last-Modified`, not `Expires - Date`.** The second is only the
*remaining* time on whatever cached copy answered, so it reads lower the later
in a window you ask - the first incursions sample showed 8 seconds because it
landed just before a rollover, and the window is 300. Measuring the remaining
time and calling it the cadence would understate every window by however long
the response had already been sitting.

Confirmed by catching both ends: the incursions window rolled over between the
two probes, from 8 seconds remaining to 290.

**Neither sends `max-age`** - `cache-control` is bare `public` - so `Expires` is
the authority for these two. The rule above about `max-age` winning does not
apply where there is none.

**And they are not one cadence.** Faction warfare is *six times* slower than
incursions. Carrying a single "ambient" window for the pair would have been
wrong by that factor in one direction or the other, which is the arithmetic
behind naming them apart in `web/snapshot.js`.

**Do not guess a number for anything still unmeasured.** `web/snapshot.js` carries a
cache window in milliseconds and crosses `null` when there is none, which is
the correct value until somebody reads a live response. A guessed 60000, or
the word "minute", is exactly the defect that replacing the word list removed:
campaigns' five seconds would have been overstated twelvefold.

Measuring them is one GET each. Record the `Cache-Control: max-age` or
`Expires - Date`, the date it was read, and the header verbatim - here and in
the comment in `web/snapshot.js`.

Catalogue accessors for those two layers can be written against their row
shape without a window. **A sentence about freshness cannot.**

If ESI ever sends a `max-age` **shorter** than its `Expires`, following `max-age`
would poll early and risk exactly the ban above. That is worth re-checking here
rather than assuming it stays true.

## User agents

Browser applications cannot reliably set `User-Agent` - Chrome silently drops it
from `fetch` - so the documented answer is the **`X-User-Agent`** header, which
is what this project sends. Failing that, a `user_agent` query parameter.

It should contain an email address and an app name with version, both "strongly
preferred", and may carry a source URL, a Discord handle or a character name.

**Note for this project:** app name and a contact address, never a character
name. The reason is not privacy against CCP - they run the game and know exactly
which character authorised this application, so a name in a header tells them
nothing new. It is that a user agent identifies an **application, not a
session**:

- one constant string is sent to EVE-Scout as well, and that layer deliberately
  keeps no character names;
- with thirty characters there is no correct name to choose, and picking one
  labels the installation with that alt permanently;
- it is a correlation handle serving no purpose CCP asked for - their stated
  reason for wanting contact details is reaching the author, which an address
  does.

The contact address is currently the author's own, set by explicit decision on
2026-09-20. **It must become a setting before any public release**, or every
user's traffic is attributed to one person and CCP contacts the wrong human
about someone else's client.

## SSO, for when tokens arrive

- ~~Authorization code flow **with PKCE** for a local application.~~ **Written
  2026-09-20**, in `src-tauri/src/sso.rs`, and checked without contacting CCP:
  the challenge derivation is verified against RFC 7636's own vector rather than
  against its own output, and the authorize URL is asserted to carry the
  challenge and never the verifier.
- Validate the access token's signature, issuer, audience, expiry, character and
  granted scopes. **Not yet** - this waits on a registered application, and is
  the next slice along with the exchange itself.
- Refresh tokens are long-lived character credentials. They belong in the
  operating system's credential store, **not** in browser storage - which is one
  of the two reasons the Tauri decision exists. **Not yet**, and when it lands
  the token is already a `Secret`: a type that redacts under `Debug`, has no
  `Display`, and is read only through an `expose()` that makes every read
  greppable.
- Request the minimum scopes per feature rather than a blanket grant. **The
  first vault slice requests `publicData`, and one scope is the floor rather
  than a choice.** A token with no scopes does still identify its character -
  that part was right - but see below: CCP return no refresh token at all
  unless the authorize request asked for at least one.
- **The redirect is `http://localhost:47624/callback`**, fixed, because CCP match
  it character-for-character and an ephemeral port cannot be registered. The
  listener answers on both `::1` and `127.0.0.1`, because a browser resolving
  `localhost` tries IPv6 first on Windows.
- **There is no client secret and must not be.** A secret in an open-source
  desktop application is a secret on every user's disk. The client id is not a
  secret either, but it is an identity, so no real one is ever committed.

## A second source, not yet read

A killboard is a **V2 option** and no code talks to one. When that changes, its
own API rules are read and recorded here with the date, the way CCP's are: a
different organisation, different limits, and this project does not talk to a
server on an assumption about what it permits.

The reason it is worth the trouble is in the section below. The fifteen-minute
decay convention is possible against discrete killmails and is not possible
against an hourly count, and a killmail says who - which is what would let a pod
count distinguish a gate camp from a Triglavian fleet. Neither is available from
`/universe/system_kills/` at any amount of cleverness.

## How the numbers are read, and by whom

Read 2026-09-22, from how third-party intel tools present the same endpoints.
Recorded because the advisor's default ordering has to have a reason, and
"whatever was easiest to compute" is not one.

- **Pod kills are the signal intel tools lean on, and the rule they attach is
  wrong.** Those tools assume NPCs do not pod. Checked 2026-09-22: **Drifters,
  Sleepers, Triglavians and rogue drones podkill**, and Triglavian invasion
  fleets did so in high security. CONCORD is the one that does not - it kills
  ships and leaves capsules - which is the opposite of the exception usually
  quoted. So a pod count is a fact, and "somebody chose to" is not a rule that
  can be welded to it.
- **NPC kills are presence, not danger.** Ratting says people are here. It says
  nothing about whether a route is safe, which is why `playerKills` refuses to
  add them in.
- **Ship jumps are traffic** - occupancy rather than threat, and the reason a
  camp is worth setting at all.
- **Recency beats totals, at the resolution the data actually has.** The
  fifteen-minute decay those tools use comes from polling a killboard in
  near-real-time. These endpoints republish **hourly**, `activity.js` keeps
  jumps and NPC counts for the latest sample only, and the 24-sample history is
  player kills alone. Rank the samples that exist; a decay finer than the data
  is a precision nobody measured.

**No weighting, by anyone.** These are not combined into a danger score here,
because a weight is a judgement made here and then shown as though it had
been measured. Third-party tools do weight them; this one does not, and the
difference is deliberate.

## What this project already obeys

- `X-User-Agent`, since the browser cannot set `User-Agent`.
- `ETag` / `If-None-Match`, and a `304` keeps the data and takes the new expiry.
- `Expires`, and `Cache-Control: max-age` where it is present.
- `Last-Modified` as the age of the data, rather than the moment we asked.
- Both rate limiters, as a share of the budget where one is published.
- Never throwing: a failed call leaves the store as it was and the map drawing.

## Still to do

- ~~`Retry-After` is read but not acted on.~~ **Done.** A stated wait is now
  taken at the fetch boundary, and the request never reaches the network.
  Scoped rather than global, because the limiters are: a `429` holds that route
  **group**, a `420` holds **all of ESI** as the documentation says, and another
  service is its own. One shared timestamp would have turned any single refusal
  into a total outage.
- `X-Esi-Cache-Status` (`HIT`/`MISS`) is not read. It would say whether an
  answer came from cache, which is the cheapest way to notice we are asking too
  often.

## SSO, checked against CCP's own documents - 2026-09-20

Read directly from `docs.esi.evetech.net` while wiring the exchange, rather than
from this file's earlier summary. Four things the implementation had to change.

**The audience claim is an AND, and the obvious library call is an OR.** CCP:
*"the `aud` claim contains the audience and must include **both** the `client_id`
and the string value `EVE Online`"*. `jsonwebtoken`'s `Validation::set_audience`
accepts a token carrying *any one* of the values given to it. Every EVE SSO
token in existence carries `"EVE Online"`, so the loose check would accept
another developer's token as though it were ours and file what it said under one
of this pilot's characters. Both are now required explicitly.

**The issuer has two legal spellings.** *"handle looking for both the host name
and the URI"* - `login.eveonline.com` and `https://login.eveonline.com`. Already
accepted; now confirmed rather than assumed.

**The authorize endpoint carries a trailing slash** in CCP's example:
`https://login.eveonline.com/v2/oauth/authorize/?response_type=code...`. The
form without it is answered, but a redirect between the two is a place a query
string can be dropped.

**A refresh returns a refresh token that may differ from the one sent.** *"the
`refresh_token` returned may not be the same as the refresh token submitted"*,
and CCP say rotation will eventually be enabled for native applications. A
refresh that keeps the new access token and discards the new refresh token works
until the day rotation is switched on and then locks the pilot out permanently.
Noted at the function, unwired so far.

**Confirmed correct as built:** verifier is 32 random bytes base64url-encoded;
challenge is base64url of the SHA-256 of the verifier, unpadded; token endpoint
takes `Content-Type: application/x-www-form-urlencoded` and `Host:
login.eveonline.com`; the authorization_code body is exactly `grant_type`,
`code`, `client_id`, `code_verifier`; **no client secret and no Basic header** -
CCP: *"a code challenge is used instead of basic authentication to allow your
application to ship without its secret key"*; `sub` is `CHARACTER:EVE:<id>`;
`name` and `scp` carry the character and its scopes.

**A REFRESH TOKEN REQUIRES A SCOPE. Read 2026-09-20, after the first slice had
already been built to request none.** CCP: *"a refresh token is returned when
any valid scope was requested in the initial redirect to the SSO using the
authorization code flow"*. No scopes, no refresh token - and without one, a
character cannot survive a restart, which is the entire point of the vault.

The slice was designed around "a token with no scopes still identifies its
character". True, and beside the point. It now requests `publicData`, the
smallest scope that meets the condition; it grants nothing this application
reads, because the identity is in the token rather than behind the scope.

This would not have failed quietly - `tokens_from` requires a `refresh_token`
and the exchange reports "the reply carried no refresh_token" - but it would
have failed on the first real sign-in, which is a poor moment to start reading
documentation.

**Still undocumented, decided here:** what to send when requesting no scopes at
all. RFC 6749 makes `scope` optional, so it is omitted entirely rather than sent
as `scope=`, which invites being read as a scope whose name is the empty string.
No caller does that now, and the handling stays because it is the right answer
to the question.

**Noted, not acted on:** CCP say the SSO *"will also support ES-256 in the near
future"*. This build accepts RS256 and refuses anything else by name, which is
the right failure - but it will need ES-256 before CCP switch.
