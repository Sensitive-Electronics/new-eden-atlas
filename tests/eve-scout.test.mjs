// Thera and Turnur connections, from EVE-Scout.
//
// The first thing here that reaches a service other than CCP's, so it is held
// to a stricter version of the same rule: optional, off by default, and
// incapable of changing anything if it never answers.
//
// Four things separate a wormhole from a bridge, and each has a failure that
// strands somebody:
//
//   it expires, and a route over a lapsed hole is fiction;
//   most of them land in J-space, which is not on the stargate graph at all;
//   it has a size limit, and a hole rated for cruisers is not one a freighter
//     can use;
//   and the payload names the scout who found it, which nothing here may keep.

import { readArchive, suite } from "./helpers.mjs";
import { mergeBridges, RoutePlanner } from "../web/route-planner.js";
import { createSightings, historyOf, openObservations } from "../web/sightings.js";
import {
  SHIP_CLASSES, carriesIdentity, describeSignature, expiredSignatures, fits,
  FIELD_LIMIT, SIGNATURE_LIMIT,
  openSignatures, routableSignatures, sanitize, scoutEndpoint, scoutHubs, scoutNetwork, syncScout,
} from "../web/eve-scout.js";

const headers = map => ({ get: name => map[name.toLowerCase()] ?? null });
const reply = rows => async () => ({
  ok: true,
  status: 200,
  headers: headers({ "cache-control": "public, max-age=300", etag: 'W/"s"' }),
  json: async () => rows,
});

const NOW = Date.parse("2026-09-18T12:00:00Z");
const hours = n => new Date(NOW + n * 3_600_000).toISOString();

// The payload as the endpoint really sends it, names and all.
const raw = (over = {}) => ({
  id: "73995",
  created_at: "2026-09-18T05:25:09Z",
  created_by_id: 2124689929,
  created_by_name: "A Scout",
  updated_by_id: 2124689929,
  updated_by_name: "A Scout",
  completed_by_id: 2124689929,
  completed_by_name: "A Scout",
  completed: true,
  wh_exits_outward: false,
  wh_type: "J377",
  max_ship_size: "medium",
  expires_at: hours(6),
  remaining_hours: 6,
  signature_type: "wormhole",
  out_system_id: 30002086,
  out_system_name: "Turnur",
  out_signature: "LWM-619",
  in_system_id: 31000492,
  in_system_class: "c2",
  in_system_name: "J170038",
  in_region_id: 11000005,
  in_region_name: "B-R00005",
  in_signature: "JVM-863",
  ...over,
});

export default function run(app) {
  const t = suite("eve-scout");
  const atlas = readArchive();
  const planner = new RoutePlanner(atlas);
  const id = name => planner.resolveSystem(name).system_id;
  // What makes a system part of the stargate graph. J-space has no gates, so a
  // hole into it cannot shorten a gate route however close it looks.
  const connected = systemId => (atlas.systems[String(systemId)]?.neighbors?.length ?? 0) > 0;

  // --- nothing that identifies a person survives the boundary --------------------
  const clean = sanitize(raw());
  t.check(!carriesIdentity(clean), "the transform keeps no field naming a person");
  for (const field of ["created_by_name", "completed_by_name", "updated_by_name",
                       "created_by_id", "completed_by_id", "updated_by_id"]) {
    t.equal(clean[field], undefined, `${field} is dropped at the boundary, not filtered later`);
  }
  t.check(!JSON.stringify(clean).includes("A Scout"),
    "and the name appears nowhere in what would be stored or exported");
  t.check(carriesIdentity(raw()), "while the check itself can tell - it sees the raw payload for what it is");

  t.equal(clean.id, "73995", "what is kept is the signature");
  t.equal(clean.expiresAt, Date.parse(hours(6)), "when it goes");
  t.equal(clean.maxShipSize, "medium", "what fits through it");
  t.equal(clean.inSystemClass, "c2", "and where it lands");

  t.equal(sanitize({}), null, "a row with no identity or expiry is refused rather than half-stored");
  t.equal(sanitize({ id: "1", expires_at: "not a date", out_system_id: 1, in_system_id: 2 }), null,
    "and so is one whose expiry will not parse - a hole with no end is not a hole");

  // --- what fits ----------------------------------------------------------------
  t.check(fits("medium", "large"), "a cruiser fits a hole rated for battleships");
  t.check(fits("large", "large"), "and a battleship fits its own rating");
  t.check(!fits("large", "medium"), "but not a smaller one");
  t.check(!fits("capital", "xlarge"), "and a capital is its own class, above xlarge");
  t.check(!fits("medium", null), "an unrated hole admits nothing, rather than everything");
  t.check(!fits("medium", "enormous"), "and nor does a rating nobody has seen before");
  t.check(!fits(null, "xlarge"), "a hull with no class fits nothing either");
  // The vocabulary is pinned, so a new value from upstream fails here rather
  // than being silently ordered wrong - and ordering it wrong strands a fleet.
  t.equal(SHIP_CLASSES.join(), "frigate,medium,large,xlarge,capital",
    "the size ladder is pinned, so an unknown rating is caught rather than guessed");

  return (async () => {
    const store = createSightings();
    const kToK = { id: "1", in_system_id: id("Amarr"), in_system_name: "Amarr", in_system_class: "hs" };
    const toJSpace = { id: "2", in_system_id: 31000492, in_system_name: "J170038", in_system_class: "c2" };

    const first = await syncScout(store, {
      fetchImpl: reply([raw(kToK), raw(toJSpace)]),
      now: NOW,
    });
    t.check(first.ok, "signatures sync");
    t.equal(openSignatures(store, NOW).length, 2, "both are recorded");

    // Routing sees only what can actually shorten a gate route. The other is
    // still recorded, because a hole into J-space is a scanning target and
    // throwing it away at ingest would destroy intelligence to save a filter.
    const routable = routableSignatures(store, { connected, now: NOW });
    t.equal(routable.length, 1, "only the connection whose far side has stargates can route");
    t.equal(routable[0].id, "1", "which is the k-space one");
    t.equal(openSignatures(store, NOW).length, 2,
      "while the J-space one is still held, because it is worth knowing about");

    // Size gates the edge, not the sync.
    t.equal(routableSignatures(store, { connected, hullClass: "medium", now: NOW }).length, 1,
      "a cruiser may use a medium hole");
    t.equal(routableSignatures(store, { connected, hullClass: "capital", now: NOW }).length, 0,
      "a capital may not, and is told so by getting no edge rather than a bad route");

    // --- a hub that nobody wrote down --------------------------------------------
    //
    // Thera has no stargates, so requiring both ends of a signature to be on the
    // gate graph excluded every Thera connection - most of them, and the point
    // of the service. Naming Thera in the source fixes today and reintroduces
    // the bug the day a third hub appears, which is not hypothetical: Turnur
    // was added in 2024. So the hubs are read from the data - the `out` side of
    // a signature is a hub by definition, because that is where the scanning
    // happened.
    const invented = createSightings();
    // A real system with no stargates that is *not* Thera, so the test proves
    // the derivation rather than the hardcoded name it replaced.
    const HUB = 30000326;   // WF-1LM, gateless, and nobody's hub today
    await syncScout(invented, {
      fetchImpl: reply([
        raw({ id: "h1", out_system_id: HUB, out_system_name: "WF-1LM",
              in_system_id: id("Amarr"), in_system_name: "Amarr", max_ship_size: "xlarge" }),
        raw({ id: "h2", out_system_id: HUB, out_system_name: "WF-1LM",
              in_system_id: id("Rens"), in_system_name: "Rens", max_ship_size: "xlarge" }),
      ]),
      now: NOW,
    });
    t.equal(routableSignatures(invented, { connected, now: NOW }).length, 2,
      "a hub with no stargates routes without being named in the source");
    t.check(scoutHubs(openSignatures(invented, NOW)).has(HUB),
      "because the hubs are whatever the scanners scanned from");
    t.check(!scoutEndpoint(id("Amarr"), () => false, scoutHubs([])),
      "and with no hubs, a system off the gate graph is still refused");

    // Two connections through one hub is a two-jump route, which is the shape
    // every Thera route has: in one side, out the other.
    const viaHub = scoutNetwork(planner, routableSignatures(invented, { connected, now: NOW }));
    const hopped = planner.calculate("Amarr", "Rens", "shortest", undefined, undefined, viaHub);
    t.equal(hopped.jumps, 2, "two connections through one hub make a two-jump route");
    t.equal(hopped.wormholeJumps, 2, "both legs reported as wormholes");
    t.check(hopped.systems.some(system => system.system_id === HUB),
      "passing through the hub itself");

    // An expired signature must not keep supplying a hub. Otherwise a live hole
    // whose far side is that hub still routes - into somewhere nothing else
    // reaches, because the connection out again has already gone.
    const stale = createSightings();
    await syncScout(stale, {
      fetchImpl: reply([
        raw({ id: "gone", out_system_id: HUB, in_system_id: id("Amarr"), in_system_name: "Amarr",
              expires_at: hours(1), max_ship_size: "xlarge" }),
        raw({ id: "live", out_system_id: id("Turnur"), out_system_name: "Turnur",
              in_system_id: HUB, in_system_name: "WF-1LM", expires_at: hours(9), max_ship_size: "xlarge" }),
      ]),
      now: NOW,
    });
    t.equal(routableSignatures(stale, { connected, now: NOW }).length, 2,
      "while both are open, the hub is a hub and both route");
    const afterOneLapsed = NOW + 2 * 3_600_000;
    t.check(!scoutHubs(openSignatures(stale, afterOneLapsed)).has(HUB),
      "once the connection out of the hub lapses, it stops being a hub");
    t.equal(routableSignatures(stale, { connected, now: afterOneLapsed }).length, 0,
      "so the way in stops being offered rather than leading somewhere with no exit");

    // --- expiry is applied on read ---------------------------------------------------
    // A sync may be hours old - the layer is optional and the network may be
    // gone - so a hole that lapsed in the meantime has to stop being offered
    // without anything having to run.
    const afterwards = NOW + 7 * 3_600_000;
    t.equal(openSignatures(store, afterwards).length, 0, "a lapsed signature stops being open");
    t.equal(routableSignatures(store, { connected, now: afterwards }).length, 0, "and stops routing");
    t.equal(expiredSignatures(store, afterwards).length, 2, "while still being visible as having lapsed");
    t.equal(openObservations(store, "eve-scout").length, 2,
      "expiry is a reading of the clock, not a change to the record");

    // --- the router takes it in the shape it already knows -------------------------------
    const network = scoutNetwork(planner, routableSignatures(store, { connected, now: NOW }));
    t.equal(network.count, 1, "a usable signature becomes one edge");
    t.check(network.links.get(id("Turnur"))?.includes(id("Amarr")),
      "traversable from the near side");
    t.check(network.links.get(id("Amarr"))?.includes(id("Turnur")),
      "and from the far side, because a wormhole is not one-way");

    const before = planner.calculate("Turnur", "Amarr").jumps;
    const through = planner.calculate("Turnur", "Amarr", "shortest", undefined, undefined, network);
    t.equal(through.jumps, 1, "and it shortens the route to a single jump");
    t.check(before > through.jumps, `which is a real saving (${before} jumps to ${through.jumps})`);
    t.equal(through.wormholeJumps, 1, "reported as a wormhole leg");
    t.equal(through.bridgeJumps, 0,
      "and not as a bridge - one is anchored and the other has hours to live");
    t.equal(through.legKinds.join(), "wormhole", "which is what the leg is labelled");

    const theraStore = createSightings();
    const thera = id("Thera");
    t.check(!connected(thera), "the actual archive gives Thera no gates");
    await syncScout(theraStore, { now: NOW, fetchImpl: reply([
      raw({ id: "thera-in", out_system_id: thera, in_system_id: id("Jita"), expires_at: hours(1) }),
      raw({ id: "thera-out", out_system_id: id("Amarr"), in_system_id: thera }),
      raw({ ...toJSpace, id: "thera-dead-end", out_system_id: thera }),
    ]) });
    const theraEdges = routableSignatures(theraStore, { connected, hullClass: "medium", now: NOW });
    t.equal(theraEdges.length, 2, "Thera accepts either endpoint orientation, excluding ordinary J-space");
    const theraNet = scoutNetwork(planner, theraEdges);
    const theraRoute = planner.calculate("Jita", "Amarr", "shortest", undefined, undefined, theraNet);
    t.equal(theraRoute.systems.map(s => s.name).join(), "Jita,Thera,Amarr", "routes through the gate-free hub");
    t.equal(theraRoute.legKinds.join(), "wormhole,wormhole", "both transit legs are wormholes");
    t.equal(planner.calculate("Amarr", "Jita", "shortest", undefined, undefined, theraNet).jumps, 2,
      "the same shortcut works in reverse");
    t.check(!planner.calculate("Jita", "Amarr", "high-sec-only", undefined, undefined, theraNet)
      .systems.some(s => s.system_id === thera), "high-security restrictions still exclude Thera");
    t.check(!planner.calculate("Jita", "Amarr", "shortest", planner.resolveAvoid("Thera"), undefined, theraNet)
      .systems.some(s => s.system_id === thera), "an avoided Thera is not used");
    t.equal(routableSignatures(theraStore, { connected, hullClass: "capital", now: NOW }).length, 0,
      "Thera does not bypass hull restrictions");
    const expiredNet = scoutNetwork(planner, routableSignatures(theraStore,
      { connected, hullClass: "medium", now: NOW + 3_600_000 }));
    t.check(planner.calculate("Jita", "Amarr", "shortest", undefined, undefined, expiredNet).jumps > 2,
      "the shortcut disappears when its entrance expires");

    // --- the log ---------------------------------------------------------------------------
    // A signature that stops being reported is closed with a date. What was
    // open last night is the record, and a hole that collapsed is intelligence.
    await syncScout(store, { fetchImpl: reply([raw(kToK)]), now: NOW + 60_000 });
    t.equal(openSignatures(store, NOW + 60_000).length, 1, "a signature that stops being listed closes");
    const history = historyOf(store, "eve-scout", "2");
    t.equal(history.length, 1, "without losing its record");
    t.check(Number.isFinite(history[0].closedAt), "which is closed with a date rather than deleted");

    // A malformed success must not close every hole at once.
    const bad = await syncScout(store, { fetchImpl: reply(null), now: NOW + 120_000 })
      .catch(error => ({ ok: false, threw: error }));
    t.check(!bad.threw, "a malformed payload is reported, not thrown");
    t.check(!bad.ok, "a 200 carrying null is a failed sync");
    t.equal(openSignatures(store, NOW + 120_000).length, 1, "and closes nothing");

    // Not every signature is a wormhole, and a gas site is not a route.
    await syncScout(store, {
      fetchImpl: reply([raw(kToK), raw({ ...toJSpace, id: "3", signature_type: "gas" })]),
      now: NOW + 180_000,
    });
    t.equal(openSignatures(store, NOW + 180_000).length, 1, "a signature that is not a wormhole is not kept");

    // --- bounds on the only input that is not CCP's -----------------------------------------
    //
    // Measured before they existed: 2,000 rows of 2 KB produced a 27.5 MB store
    // from one sync, and 20,000 rows of 4 KB produced a store `JSON.stringify`
    // cannot serialise - which takes the whole live store with it, not only this
    // layer. An optional third-party service had a path to destroying the
    // intelligence it is not allowed to touch.
    //
    // Refused **whole** rather than truncated, for the reason `parseHistoryFile`
    // refuses a file rather than importing part of it: a partial network reads
    // as a complete one, and a pilot flies the hole it does not mention.
    {
      const many = Array.from({ length: SIGNATURE_LIMIT + 1 }, (_, i) =>
        raw({ id: String(900000 + i), in_system_id: 31000000 + i }));
      const before = openSignatures(store, NOW + 240_000).length;
      const flood = await syncScout(store, { fetchImpl: reply(many), now: NOW + 240_000 });
      t.check(!flood.ok, `${SIGNATURE_LIMIT + 1} signatures are refused`);
      t.equal(flood.result.reason, "malformed", "as malformed rather than as a network fault");
      t.equal(flood.changes, null, "with nothing synced");
      t.equal(openSignatures(store, NOW + 240_000).length, before,
        "and the store left exactly as it was, so no hole is closed by a refusal");

      // The limit itself is not the refusal. A response at the cap is held, or
      // the bound would be one row tighter than it says it is.
      const brim = Array.from({ length: SIGNATURE_LIMIT }, (_, i) =>
        raw({ id: String(800000 + i), in_system_id: 31000000 + i, in_system_class: null }));
      const full = await syncScout(createSightings(), { fetchImpl: reply(brim), now: NOW + 240_000 });
      t.check(full.ok, `${SIGNATURE_LIMIT} signatures - the cap itself - are held`);
      // Read through `?.` so a tightened cap reports a number rather than
      // throwing: a stack trace names this line, an assertion names the rule.
      t.equal(full.changes?.opened.length ?? -1, SIGNATURE_LIMIT, "all of them");
    }

    // A field past the bound refuses its **row**, not the response: one corrupt
    // name should not cost a pilot the other connections. Refused rather than
    // trimmed, because a truncated system name is a different system and a
    // truncated size class could read as a different class.
    t.equal(sanitize(raw({ in_system_name: "J".repeat(FIELD_LIMIT + 1) })), null,
      "a row whose field is past the bound is refused");
    t.check(sanitize(raw({ in_system_name: "J".repeat(FIELD_LIMIT) })) !== null,
      "a field at the bound is kept, so the bound is where it says it is");
    t.equal(sanitize(raw({ id: "9".repeat(FIELD_LIMIT + 1) })), null,
      "including the id, which becomes a key in the store");

    // **Two signatures may not share an id.** `syncAll` keys on it, so a repeat
    // collapsed last-wins - and a later row claiming a larger `max_ship_size`
    // silently upgraded the hole a fleet was being routed through. That is the
    // wrong-way-round error on a third-party input, in the module whose header
    // says getting it wrong stranded is worse than getting it wrong slow.
    {
      const upgrade = [
        raw({ id: "5150", max_ship_size: "frigate" }),
        raw({ id: "5150", max_ship_size: "capital" }),
      ];
      const fresh = createSightings();
      const twice = await syncScout(fresh, { fetchImpl: reply(upgrade), now: NOW + 300_000 });
      t.check(!twice.ok, "two signatures sharing an id refuse the response");
      t.equal(twice.result.reason, "malformed", "as malformed - the service contradicted itself");
      t.equal(openSignatures(fresh, NOW + 300_000).length, 0, "and nothing is stored");
      t.check(!/5150/.test(twice.result.detail ?? ""),
        "and the id is not echoed back into a message, being third-party text");

      // The specific harm, stated as a property: no stored hole may claim a size
      // the response did not agree on. Before the refusal this held "capital".
      const held = openSignatures(fresh, NOW + 300_000).map(sig => sig.maxShipSize);
      t.check(!held.includes("capital"),
        "so a repeated id cannot upgrade a hole a freighter would then be routed through");
    }

    t.check(/Turnur/.test(describeSignature(routableSignatures(store, { connected, now: NOW + 180_000 })[0])),
      "a connection is described by where it starts");
    t.check(/medium and below/.test(describeSignature(sanitize(raw()))), "and what fits through it");
    t.equal(describeSignature(null), null, "nothing described is nothing");

    // --- what counts as being on the stargate graph ---------------------------------
  //
  // `onGateGraph` decides whether a wormhole endpoint is a shortcut or a
  // scanning target, and it survived a mutation from `> 0` to `>= 0` - which
  // makes *every* system gate-connected, including the 2,604 in Anoikis that
  // have no stargates at all. Thera would become a routable gate system.
  //
  // This project has recorded that exact failure once before: `isReachable`'s
  // neighbour clause refused 618 gateless systems and the only refusal anyone
  // tested was Thera, which a different check rejected first, so the clause was
  // never reached. Same shape, different function.
  const atlas = readArchive();
  const idOf = name => Object.values(atlas.systems).find(s => s.name === name)?.system_id;
  const saved = app.state.atlas;
  try {
    app.state.atlas = atlas;
    t.check(app.onGateGraph(idOf("Jita")), "Jita is on the stargate graph");
    t.check(app.onGateGraph(idOf("Amarr")), "so is Amarr");
    t.check(!app.onGateGraph(idOf("Thera")), "Thera is not - it is reached through a hole, not a gate");
    t.check(!app.onGateGraph(999999999), "and neither is a system that does not exist");

    const gateless = Object.values(atlas.systems).filter(s => s.neighbors.length === 0);
    t.check(gateless.length > 2000, `the archive holds ${gateless.length} gateless systems`);
    t.check(!gateless.some(s => app.onGateGraph(s.system_id)),
      "none of which is reported as gate-connected");
  } finally {
    app.state.atlas = saved;
  }

  // --- a network remembers when its links die ------------------------------
  //
  // `routableSignatures` drops the dead ones, so this module treated expiry as
  // settled and threw `expiresAt` away. It is settled for a button, which
  // rebuilds on every click; it is not settled for anything that keeps the
  // network, and a snapshot keeps one.
  {
    const planner = new RoutePlanner(readArchive());
    const HOUR = 3_600_000;
    const net = scoutNetwork(planner, [
      { outSystemId: 30000142, inSystemId: 30002187, expiresAt: NOW + HOUR },
    ]);
    t.equal(net.expiry.size, 1, "a scouted link records when it expires");
    t.equal([...net.expiry.values()][0], NOW + HOUR, "at the signature's own instant");
    t.equal([...net.kinds.values()][0], "wormhole", "and is still tagged a wormhole");

    // Merging two views of one link keeps the earlier death. Two sources
    // disagreeing about when a hole dies is not a reason to believe the
    // longer one.
    const later = scoutNetwork(planner, [
      { outSystemId: 30000142, inSystemId: 30002187, expiresAt: NOW + 10 * HOUR },
    ]);
    t.equal([...mergeBridges(later, net).expiry.values()][0], NOW + HOUR,
      "merging two views of one link keeps the earlier expiry");
    t.equal([...mergeBridges(net, later).expiry.values()][0], NOW + HOUR,
      "whichever order they merge in");

    // An Ansiblex has no expiry, and absent is not "expired at zero".
    const anchored = planner.resolveBridges([{ from: 30000142, to: 30002187 }]);
    t.equal(anchored.expiry.size, 0, "a bridge with no stated expiry records none");
    t.equal(anchored.count, 1, "and is still a link, because it does not expire");
    t.equal(mergeBridges(anchored, anchored).expiry.size, 0, "and merging does not invent one");

    // --- a hole whose life cannot be read is not a link ---------------------
    //
    // `Number(null)`, `Number("")` and `Number(false)` are all 0, and 0 is
    // finite - so three spellings of "I do not know when this expires"
    // recorded an expiry of 1970 and killed the link at every clock, while
    // `undefined` recorded none and meant it never expires. Two answers to one
    // question, opposite ways round, through the coercion this codebase warns
    // about for system ids in the same file.
    //
    // A wormhole without a readable expiry is now not offered at all. An edge
    // nothing will ever drop is right for an Ansiblex and is the whole failure
    // this mechanism exists to prevent for a hole, and they share
    // `resolveBridges` - so the caller that knows which it is building decides.
    // `parseSignature` already refuses a row whose `expires_at` will not
    // parse, which is why this is worth stating rather than assuming.
    for (const [what, value] of [
      ["undefined", undefined], ["null", null], ["an empty string", ""],
      ["false", false], ["NaN", NaN], ["Infinity", Infinity],
      ["a numeric string", "1700000000000"],
    ]) {
      const net = scoutNetwork(planner, [{ outSystemId: 30000142, inSystemId: 30002187, expiresAt: value }]);
      t.equal(net.count, 0, `a hole whose expiry is ${what} is not offered as a link`);
      t.equal(net.expiry.size, 0, `  and records no expiry for ${what}`);
    }
    const real = scoutNetwork(planner, [{ outSystemId: 30000142, inSystemId: 30002187, expiresAt: NOW + HOUR }]);
    t.equal(real.count, 1, "while a hole with a real instant is offered");
  }

  return t.results;
  })();
}
