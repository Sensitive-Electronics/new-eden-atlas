// Thera and Turnur connections, from EVE-Scout.
//
// The first thing in this project that reaches a service other than CCP's, and
// it is treated accordingly: optional, absent by default, and incapable of
// stopping anything else working. No connection means no wormhole layer and
// nothing else changes - the same contract ESI gets.
//
// Confirmed live on 2026-09-18 against `/v2/public/signatures`, which is the
// endpoint; `/v2/public/wormholes` does not exist.
//
// --- three things make this different from a bridge ---------------------------
//
// **It expires.** Every signature carries `expires_at`, and the observed spread
// was 0 to 20 hours. A route computed over a hole with minutes left is fiction,
// so expiry is enforced at read time rather than trusted to a sync.
//
// **Half of them go nowhere useful.** A Thera connection usually lands in
// J-space, which is not on the stargate graph, so it cannot shorten a gate
// route at all. Those are scanning targets, not shortcuts, and they are kept
// out of routing while remaining visible as intelligence.
//
// **It has a size limit.** A hole rated for cruisers is not a hole a freighter
// can use. That is a property of the edge and the hull together, which nothing
// else in this router has needed, and getting it wrong stranded is worse than
// getting it wrong slow.
//
// --- and one thing makes it sensitive ------------------------------------------
//
// The payload names the scout who found each signature, and their character id.
// This project's rule is that nothing exported may carry a character identity.
// Those fields are dropped in the transform below, before anything is stored,
// so there is no later filter to forget.

import { fetchEsi } from "./esi.js";
import { confirmAll, openObservations, recognisedNothing, syncAll } from "./sightings.js";

// **Bounds, because this is the only input here that is not CCP's.**
//
// Measured: 2,000 rows of 2 KB produce a 27.5 MB store from a single sync, and
// 20,000 rows of 4 KB produce a store `JSON.stringify` cannot serialise at all -
// which takes the whole live store down, not only this layer. Unbounded, an
// optional third-party service has a path to destroying the archive's
// intelligence, which is the one thing it may not touch.
//
// An over-long response is **refused whole** rather than truncated, for the reason
// `parseHistoryFile` refuses a file rather than importing part of it: a partial
// answer leaves a pilot believing they hold a network they do not have, and this
// layer exists to say whether the hole they are about to fly is really there.
// Refusing costs only the layer's own absence, which is its default state and is
// always displayed with its age.
//
// 1,000 is several times the busiest response observed across both hubs. A third
// hub would still fit; a fourth refuses, visibly, with the store intact.
export const SIGNATURE_LIMIT = 1000;

// The longest system name in the archive is 18 characters, so 128 is far past
// anything this endpoint carries. A row breaching it is **refused rather than
// trimmed**: a truncated system name is a different system, and a truncated
// `max_ship_size` could read as a different size class, which is the one error
// this module's own header says it must not make.
export const FIELD_LIMIT = 128;

export const SCOUT_KIND = "eve-scout";
export const SCOUT_SOURCE = "public:eve-scout";
export const SCOUT_URL = "https://api.eve-scout.com/v2/public/signatures";

// A hub joins scanned entrances to exits without necessarily having stargates of
// its own. Thera has none at all, so requiring both ends of a signature to be on
// the gate graph excludes every Thera connection - which is most of them, and the
// point of the service.
//
// The hubs are **read from the data rather than written down**. EVE-Scout scans
// outward from its hubs, so the `out` side of every signature is a hub by
// definition. Naming Thera in the source would exclude the next hub silently;
// Turnur was added in 2024.
export function scoutHubs(signatures) {
  return new Set(signatures.map(signature => signature.outSystemId).filter(Number.isInteger));
}

export function scoutEndpoint(systemId, connected, hubs = null) {
  return Boolean(hubs?.has(systemId)) || connected(systemId);
}

// EVE-Scout's own vocabulary for how big a hole is, ordered by the mass it
// passes. A hull fits when its class sits at or below the hole's rating.
//
// Pinned rather than assumed: a value outside this list is refused rather than
// guessed at, because guessing high strands somebody and there is a test that
// fails when a new one appears.
export const SHIP_CLASSES = ["frigate", "medium", "large", "xlarge", "capital"];

// The hull a route is planned for.
//
// "active" means the ship the pilot is actually sitting in, which needs
// `esi-location.read_ship_type.v1` and therefore a character this project does
// not yet hold. Until it does, the option exists and is refused: the rule is
// that nothing here synthesises what a token we do not have would have said,
// and quietly falling back to a guess is exactly that. A pilot told "needs a
// character" knows where they stand; one silently routed as a cruiser does not.
export const ACTIVE_HULL = "active";

export function resolveHull(choice, { activeShipClass = null } = {}) {
  if (choice !== ACTIVE_HULL) return SHIP_CLASSES.includes(choice) ? choice : null;
  return SHIP_CLASSES.includes(activeShipClass) ? activeShipClass : null;
}

export function fits(hullClass, maxShipSize) {
  const hull = SHIP_CLASSES.indexOf(String(hullClass ?? "").toLowerCase());
  const hole = SHIP_CLASSES.indexOf(String(maxShipSize ?? "").toLowerCase());
  // Unknown either way: not usable. The alternative is routing a fleet through
  // a hole nobody has established it can pass.
  if (hull < 0 || hole < 0) return false;
  return hull <= hole;
}

// The transform. Everything that identifies a person is dropped here, at the
// boundary, so nothing downstream ever holds it and no export has to remember
// to strip it.
// An **own** property, never an inherited one. The rows come from `JSON.parse`, so
// they carry no prototype of their own - what they carry is whatever
// `Object.prototype` has, and a polluted `Object.prototype.max_ship_size` would
// upgrade the advertised size of every hole in the response. This module's own
// header says getting that wrong stranded is worse than getting it wrong slow.
const own = (row, key) => (
  row && typeof row === "object" && Object.hasOwn(row, key) ? row[key] : undefined
);

export function sanitize(row) {
  const id = String(own(row, "id") ?? "").trim();
  const expiresAt = Date.parse(own(row, "expires_at"));
  const outId = Number(own(row, "out_system_id"));
  const inId = Number(own(row, "in_system_id"));
  if (!id || !Number.isFinite(expiresAt) || !Number.isInteger(outId) || !Number.isInteger(inId)) return null;
  const clean = {
    id,
    signatureType: typeof own(row, "signature_type") === "string" ? own(row, "signature_type") : "unknown",
    whType: typeof own(row, "wh_type") === "string" ? own(row, "wh_type") : null,
    maxShipSize: typeof own(row, "max_ship_size") === "string" ? own(row, "max_ship_size").toLowerCase() : null,
    expiresAt,
    outSystemId: outId,
    outSystemName: typeof own(row, "out_system_name") === "string" ? own(row, "out_system_name") : null,
    outSignature: typeof own(row, "out_signature") === "string" ? own(row, "out_signature") : null,
    inSystemId: inId,
    inSystemName: typeof own(row, "in_system_name") === "string" ? own(row, "in_system_name") : null,
    inSystemClass: typeof own(row, "in_system_class") === "string" ? own(row, "in_system_class") : null,
    inRegionName: typeof own(row, "in_region_name") === "string" ? own(row, "in_region_name") : null,
    inSignature: typeof own(row, "in_signature") === "string" ? own(row, "in_signature") : null,
  };
  // Checked over the row this function *built*, not over a list of field names, so
  // a field added above cannot escape the bound by being forgotten here. Same
  // reason `carriesIdentity` reads the keys rather than trusting the code to have
  // been read correctly.
  if (Object.values(clean).some(value => typeof value === "string" && value.length > FIELD_LIMIT)) {
    return null;
  }
  return clean;
}

// Belt and braces for the rule above: the shape sanitize produces, checked.
// A field added upstream cannot arrive by accident, because nothing is copied
// wholesale - but this makes the guarantee testable rather than a claim about
// the code being read correctly.
const IDENTIFYING = /_by_|character|pilot|scout/i;
export function carriesIdentity(value) {
  if (!value || typeof value !== "object") return false;
  return Object.keys(value).some(key => IDENTIFYING.test(key));
}

export async function syncScout(store, { fetchImpl = null, cached = null, now = Date.now() } = {}) {
  const result = await fetchEsi(SCOUT_URL, { cached, fetchImpl, now });
  if (!result.ok) return { ok: false, result, changes: null };
  if (result.notModified && !result.data) {
    // Unchanged means confirmed, not ignored. See confirmAll in sightings.js.
    const confirmed = confirmAll(store, SCOUT_KIND, { source: SCOUT_SOURCE, now });
    return { ok: true, result, changes: null, unchanged: true, confirmed };
  }

  // An empty list is a real answer - Thera can genuinely have nothing scanned.
  // A non-list is not, and reading one as "no connections" would close every
  // known hole at once.
  if (!Array.isArray(result.data)) {
    return {
      ok: false,
      result: { ...result, ok: false, reason: "malformed", detail: "EVE-Scout signatures were not a list." },
      changes: null,
    };
  }

  // Refused whole rather than truncated - see SIGNATURE_LIMIT. Checked before
  // anything is parsed, because the cost being bounded is the point: mapping
  // 20,000 rows to build them and then throwing them away has already done the
  // work that made this dangerous.
  if (result.data.length > SIGNATURE_LIMIT) {
    return {
      ok: false,
      result: {
        ...result,
        ok: false,
        reason: "malformed",
        detail: `EVE-Scout returned ${result.data.length} signatures, past the ${SIGNATURE_LIMIT} this build will hold.`,
      },
      changes: null,
    };
  }

  const parsed = result.data.map(sanitize).filter(Boolean);
  const seen = parsed
    // Only wormholes. The endpoint has carried other signature types before and
    // a gas site is not a route.
    .filter(row => row.signatureType === "wormhole")
    .map(row => ({ key: row.id, value: row }));

  // Measured on what sanitize understood, not on what survived the wormhole
  // filter. A response of nothing but gas sites is a real answer meaning no
  // holes are scanned; a response nothing at all parsed from is EVE-Scout having
  // changed its schema, and closing every known hole on the strength of it would
  // take the wormhole network off the map and record that it had closed.
  if (recognisedNothing(result.data, parsed.length)) {
    return {
      ok: false,
      result: { ...result, ok: false, reason: "malformed", detail: "EVE-Scout signatures arrived in a shape this build does not recognise." },
      changes: null,
    };
  }

  // **Two signatures may not share an id.** `syncAll` keys on it, so a repeat
  // collapses last-wins, and a later row claiming a larger `max_ship_size`
  // silently *upgrades* the hole a fleet is about to be routed through.
  //
  // Neither row can be preferred: the service is contradicting itself about its own
  // primary key, and choosing one is guessing - which is what `fits` refuses to do
  // with a size it does not recognise. Dropping both is worse than it looks, because
  // the hole would vanish from the response, `syncAll` would close it, and the log
  // would carry a collapse nobody observed. Refusing the whole response is the only
  // outcome that neither strands a pilot nor falsifies the log: the store is left
  // exactly as it was, shown with its age.
  const ids = new Set(seen.map(row => row.key));
  if (ids.size !== seen.length) {
    return {
      ok: false,
      result: {
        ...result,
        ok: false,
        // The id itself is not echoed. It is third-party text, and this string
        // is read by a person rather than matched by code.
        reason: "malformed",
        detail: "EVE-Scout returned two signatures with the same id, so which of them is true cannot be known.",
      },
      changes: null,
    };
  }

  const changes = syncAll(store, SCOUT_KIND, seen, { source: SCOUT_SOURCE, now });
  const quiet = !changes.opened.length && !changes.changed.length && !changes.closed.length;
  return { ok: true, result, changes, unchanged: quiet };
}

// Everything still open and not yet expired.
//
// Expiry is applied on read, not on sync. A sync may be hours old - the layer is
// optional and the network may be gone - and a hole that lapsed in the meantime
// must stop being offered without anything having to run.
export function openSignatures(store, now = Date.now()) {
  return openObservations(store, SCOUT_KIND, { source: SCOUT_SOURCE })
    .map(entry => ({ ...entry.value, since: entry.firstSeen, lastConfirmed: entry.lastConfirmed }))
    .filter(signature => signature.expiresAt > now)
    .sort((a, b) => a.expiresAt - b.expiresAt);
}

export function expiredSignatures(store, now = Date.now()) {
  return openObservations(store, SCOUT_KIND, { source: SCOUT_SOURCE })
    .map(entry => ({ ...entry.value }))
    .filter(signature => signature.expiresAt <= now);
}

// Connections whose far side is on the stargate graph, and which this hull can
// actually pass. These are the only ones that can shorten a gate route.
//
// `connected` answers whether a system has stargates, which is what makes it
// part of the graph - J-space has none, so a Thera-to-J-space hole is a
// scanning target rather than a shortcut, and is excluded here while staying
// visible everywhere else.
export function routableSignatures(store, { connected, hullClass = null, now = Date.now() } = {}) {
  const open = openSignatures(store, now);
  const hubs = scoutHubs(open);
  return open.filter(signature =>
    scoutEndpoint(signature.outSystemId, connected, hubs)
    && scoutEndpoint(signature.inSystemId, connected, hubs)
    && (hullClass === null || fits(hullClass, signature.maxShipSize)));
}

// The shape the router already takes for bridges. A wormhole is an undirected
// edge costing one jump, which is what a bridge is; it differs in expiring and
// in refusing hulls.
//
// The hull is settled before we get here and stays settled - a network built for a
// cruiser is a cruiser's network. **Expiry is not.** `routableSignatures` drops the
// dead ones at read time, which is enough for a button that rebuilds the network on
// every click and wrong for a snapshot that keeps one: a frozen network carrying no
// `expiresAt` routes a pilot through a hole that collapsed hours ago and reports
// "1 jump".
export function scoutNetwork(planner, signatures) {
  // Tagged, so a route can say "wormhole" rather than "bridge". They are the same
  // edge to the graph and very different promises to a pilot: one is a structure an
  // alliance anchored, the other has hours to live and a mass limit.
  //
  // **A wormhole without a usable expiry is not offered at all.** `sanitize` refuses
  // a row whose `expires_at` will not parse, so this cannot happen from the live
  // endpoint - which is why it is worth stating rather than assuming. An edge with
  // no expiry is an edge nothing will ever drop: correct for an Ansiblex, and for a
  // hole the failure this mechanism exists to prevent. The two share
  // `resolveBridges`, so the distinction is made by the caller that knows which it
  // is building.
  const dated = signatures.filter(signature =>
    typeof signature?.expiresAt === "number" && Number.isFinite(signature.expiresAt));
  return planner.resolveBridges(dated.map(signature => ({
    from: signature.outSystemId,
    to: signature.inSystemId,
    // Carried now, so whoever holds this network can ask the question again.
    expiresAt: signature.expiresAt,
  })), { kind: "wormhole" });
}

export function describeSignature(signature) {
  if (!signature) return null;
  const size = signature.maxShipSize ? `${signature.maxShipSize} and below` : "size unknown";
  const where = signature.inSystemName ?? "unknown";
  const cls = signature.inSystemClass ? ` (${signature.inSystemClass.toUpperCase()})` : "";
  return `${signature.outSystemName ?? "?"} → ${where}${cls} · ${size}`;
}
