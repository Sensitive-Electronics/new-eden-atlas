// Heat-weighted routing, and the cost model underneath it.
//
// Two things are tested here and they are closely related, because the second
// is why the first could not simply be added.
//
// **The tiers.** One number with each tier scaled to out-weigh the one below cannot
// work at this size: the tiers accumulate over a path of up to 8,489 edges, so each has
// to dominate the accumulated total of the next - 56 bits of separation, in a double
// that carries 53. The shortfall is reachable: with `HIGH_SEC_DETOUR` and
// `SOFT_PENALTY` both 10,000, one soft avoid trades for exactly one low-sec jump, and a
// route needing two to honour the avoid list goes through the avoided system instead.
//
// That trade rate was an accident of two constants being equal rather than a
// decision, and no constants could have made it principled. Comparing tier by
// tier makes the ordering deliberate: a system the pilot named is a specific
// instruction and the security mode is a general preference, so the specific
// one wins and the route reports the dip.
//
// **Heat.** Kills in the last hour, expressed as jumps of detour, sitting in
// the primary tier because that is exactly the trade a pilot is making when
// they route around a camp.

import { readArchive, suite } from "./helpers.mjs";
import {
  HEAT_LEVELS, MAX_HEAT_PENALTY, RoutePlanner, addCost, compareCost, emptyAvoid,
  emptyBridges, emptyHeat, emptyLimits, heatCeiling, heatPenalty,
} from "../web/route-planner.js";
import { createStore, setOverride } from "../web/overrides.js";
import { routeHeatPanel } from "../web/panels.js";

export default function run() {
  const t = suite("heat routing");
  const atlas = readArchive();
  const planner = new RoutePlanner(atlas);
  const id = name => planner.resolveSystem(name).system_id;
  const names = route => route.systems.map(system => system.name);

  const withHeat = (kills, weight) => ({
    kills: new Map(Object.entries(kills).map(([name, count]) => [id(name), count])),
    weight,
    at: Date.now(),
    applied: true,
  });

  // --- the penalty curve --------------------------------------------------------
  t.equal(heatPenalty(0, HEAT_LEVELS.cautious), 0, "a system nobody died in costs nothing extra");
  t.equal(heatPenalty(50, HEAT_LEVELS.off), 0, "and with weighting off, nor does a slaughter");
  t.equal(heatPenalty(1, HEAT_LEVELS.cautious), 2, "one kill is worth a couple of jumps");
  t.check(heatPenalty(30, HEAT_LEVELS.cautious) > heatPenalty(1, HEAT_LEVELS.cautious),
    "more kills cost more");

  // Each doubling adds one step, so the gap between one kill and thirty is
  // large and the gap between thirty and thirty-one is nothing - which a linear
  // term gets wrong in both directions.
  t.equal(heatPenalty(31, HEAT_LEVELS.cautious) - heatPenalty(15, HEAT_LEVELS.cautious),
    heatPenalty(15, HEAT_LEVELS.cautious) - heatPenalty(7, HEAT_LEVELS.cautious),
    "equal doublings cost equal detours");
  t.equal(heatPenalty(30, HEAT_LEVELS.cautious), heatPenalty(31, HEAT_LEVELS.cautious),
    "and one more kill on a system that is already hot changes nothing");
  t.check(heatPenalty(100_000, HEAT_LEVELS.paranoid) <= MAX_HEAT_PENALTY,
    "the penalty is capped, so the worst system on the map is still a number you can hold in your head");
  t.check(heatPenalty(20, HEAT_LEVELS.paranoid) > heatPenalty(20, HEAT_LEVELS.cautious),
    "and the pilot chooses how strongly it weighs");
  t.equal(heatPenalty(-5, HEAT_LEVELS.cautious), 0, "a nonsense count costs nothing rather than crediting a detour");

  // --- the tiers hold ---------------------------------------------------------------
  // Compared rather than subtracted. Subtracting is the obvious way to write a
  // comparator and it returns NaN for two equal infinities, which a heap reads
  // as neither-less-nor-greater and orders wrongly - and the sentinel for an
  // unreached system is exactly that value.
  const INF = [Infinity, Infinity, Infinity];
  t.equal(compareCost(INF, INF), 0, "two unreachable costs compare equal rather than NaN");
  t.check(compareCost([0, 1, 0], INF) < 0, "and anything finite beats an unreachable one");
  t.check(compareCost(INF, [0, 1, 0]) > 0, "in both directions");
  t.check(Number.isFinite(compareCost(INF, INF)), "the comparator never returns NaN");

  // A route from a system to itself is zero jumps. It crosses nothing, so no
  // security restriction can be violated by it - refusing one answered a
  // question nobody asked.
  t.equal(planner.calculate("1DQ1-A", "1DQ1-A", "high-sec-only").jumps, 0,
    "a null-sec system routes to itself in high-sec-only, because that is zero jumps");
  t.equal(planner.calculate("Jita", "Jita", "high-sec-only").jumps, 0, "as does a high-sec one");

  t.check(compareCost([0, 999_999, 0], [1, 0, 0]) < 0,
    "no amount of primary cost is worth one soft avoid");
  t.check(compareCost([0, 5, 999_999], [0, 6, 0]) < 0,
    "and no amount of trust is worth one unit of primary cost");
  t.check(addCost([1, 2, 3], [4, 5, 6]).join() === "5,7,9", "costs add tier by tier");

  // On the real graph: a soft avoid is honoured wherever any alternative
  // exists, whatever that alternative costs. Checked across a whole route
  // rather than at one system, because the property is about every system and
  // a single example would only show one.
  const sampleRoute = planner.calculate("Jita", "Orvolle", "safer");
  let checked = 0;
  for (const system of sampleRoute.systems.slice(1, -1)) {
    const soft = createStore();
    setOverride(soft, { target: "system", key: system.system_id, strength: "soft" });
    const honoured = planner.calculate("Jita", "Orvolle", "safer", emptyAvoid(), emptyLimits(), emptyBridges(), soft);
    if (honoured.avoidedAnyway.length) continue;
    checked += 1;
    if (names(honoured).includes(system.name)) {
      t.check(false, `${system.name} was soft-avoided, reported no protest, and was routed through anyway`);
      break;
    }
  }
  t.check(checked > 5, `a soft avoid held at every one of ${checked} systems that had an alternative`);

  // --- heat moves a route -------------------------------------------------------------
  const plain = planner.calculate("Jita", "Amarr");
  const onRoute = plain.systems[3].name;
  t.equal(plain.jumps, 11, "the plain route is the plain route");

  // The trade, rather than a magic outcome. Going round this system costs
  // twelve extra jumps, and forty kills is worth eleven at cautious and
  // twenty-seven at paranoid - so the weight decides, which is the whole point
  // of letting the pilot set it.
  const around = planner.calculate("Jita", "Amarr", "shortest",
    { ...emptyAvoid(), systemIds: new Set([id(onRoute)]) });
  const detourCost = around.jumps - plain.jumps;
  t.check(detourCost > heatPenalty(40, HEAT_LEVELS.cautious),
    `going round ${onRoute} costs ${detourCost} jumps, more than forty kills is worth at cautious`);
  t.check(detourCost < heatPenalty(40, HEAT_LEVELS.paranoid),
    "and less than it is worth at paranoid");

  const cautious = planner.calculate("Jita", "Amarr", "shortest", emptyAvoid(), emptyLimits(), emptyBridges(),
    createStore(), withHeat({ [onRoute]: 40 }, HEAT_LEVELS.cautious));
  t.equal(cautious.jumps, plain.jumps, "so at cautious the route goes through rather than paying more than it is worth");
  t.check(cautious.hotCrossed.some(entry => entry.system.name === onRoute),
    "and says it crossed a system with forty kills in it");

  const hot = planner.calculate("Jita", "Amarr", "shortest", emptyAvoid(), emptyLimits(), emptyBridges(),
    createStore(), withHeat({ [onRoute]: 40 }, HEAT_LEVELS.paranoid));
  t.check(!names(hot).includes(onRoute), `while at paranoid it is routed around (${onRoute})`);
  t.equal(hot.jumps, around.jumps, "by exactly the detour that avoiding it costs");
  t.equal(hot.heat.weight, HEAT_LEVELS.paranoid, "and the route says how strongly it weighed");
  t.check(hot.heat.applied, "and that it weighed at all");

  // One kill is not worth a long detour. A term that sent a fleet around the
  // long way for a single frigate loss would be turned off within a day.
  const barely = planner.calculate("Jita", "Amarr", "shortest", emptyAvoid(), emptyLimits(), emptyBridges(),
    createStore(), withHeat({ [onRoute]: 1 }, HEAT_LEVELS.cautious));
  t.equal(barely.jumps, plain.jumps, "one kill does not buy a detour of any length");

  // --- what it reports -----------------------------------------------------------------
  // The route has to enter hot systems sometimes, and must say so. Silence
  // reads as an all-clear.
  const unavoidable = planner.calculate("Jita", "Perimeter", "shortest", emptyAvoid(), emptyLimits(), emptyBridges(),
    createStore(), withHeat({ Perimeter: 25 }, HEAT_LEVELS.paranoid));
  t.equal(unavoidable.jumps, 1, "a hot destination is still reached");
  t.check(unavoidable.hotCrossed.some(entry => entry.system.name === "Perimeter"),
    "and the route says it crossed a system with kills in it");
  t.equal(unavoidable.hotCrossed[0]?.playerKills ?? null, 25, "with the count, not just the fact");

  // Ordered worst first, because that is the one that decides whether to go.
  const many = planner.calculate("Jita", "Amarr", "shortest", emptyAvoid(), emptyLimits(), emptyBridges(),
    createStore(), withHeat(Object.fromEntries(plain.systems.slice(1).map((s, i) => [s.name, i + 1])), HEAT_LEVELS.off));
  t.check(many.hotCrossed.length > 1, "several hot systems are all reported");
  t.check((many.hotCrossed[0]?.playerKills ?? 0) >= (many.hotCrossed.at(-1)?.playerKills ?? 0) && many.hotCrossed.length > 0,
    "worst first, which is the one that decides whether to go at all");

  // --- nothing synced is not an all-clear ------------------------------------------------
  const none = planner.calculate("Jita", "Amarr", "shortest", emptyAvoid(), emptyLimits(), emptyBridges(),
    createStore(), emptyHeat());
  t.check(!none.heat.applied, "with no activity data, heat was not applied");
  t.equal(none.hotCrossed.length, 0, "and no system is reported hot");
  t.equal(none.jumps, plain.jumps, "the route is exactly the unweighted one");

  // The dangerous case: weighting asked for, data absent. The route must not
  // claim to have weighed anything.
  const asked = planner.calculate("Jita", "Amarr", "shortest", emptyAvoid(), emptyLimits(), emptyBridges(),
    createStore(), { kills: new Map(), weight: HEAT_LEVELS.paranoid, at: null, applied: false });
  t.check(!asked.heat.applied,
    "asking for weighting without data does not count as having weighed it");
  t.equal(asked.jumps, plain.jumps, "and changes no route");

  // --- heat never overrides an explicit instruction ------------------------------------
  // A pilot who soft-avoided a system means it more than a kill count does.
  const both = createStore();
  const detourSystem = plain.systems[5].name;
  setOverride(both, { target: "system", key: id(detourSystem), strength: "soft" });
  const weighed = planner.calculate("Jita", "Amarr", "shortest", emptyAvoid(), emptyLimits(), emptyBridges(),
    both, withHeat(Object.fromEntries(plain.systems.slice(1, -1).map(s => [s.name, 0])), HEAT_LEVELS.paranoid));
  t.check(!names(weighed).includes(detourSystem),
    "the named system is still avoided whatever the kill numbers say around it");

  // --- heat trades against the security preference, and must say so -------------
  // Found by sweeping routes rather than by reading code, and the first fix was
  // wrong, so the reasoning is worth keeping.
  //
  // Heat is denominated in jumps and added to the *mode-weighted* edge cost,
  // where under "safer" a low-security jump costs 7. At paranoid a single system
  // with forty kills scored 27, so heat did not so much argue with the security
  // preference as flatten it, and a sweep of these hub pairs came back less
  // secure half the time. The instinct was to forbid the trade outright.
  //
  // It cannot be forbidden. `safer` is documented and tested as a preference
  // that takes a low-security shortcut when the shortcut is short enough
  // (route-planner.test.mjs, Jita to Amarr through Ahbazon at 0.4), so a kill
  // count in jumps has to be able to argue with it - and a per-edge cap cannot
  // enforce a path property anyway, because the penalties accumulate: one hot
  // system still flipped two routes of forty, through ties at the cap.
  //
  // What was actually wrong was the scale, and the silence. 27 against a
  // preference worth 6 is not a trade, and the pilot - who set a security word
  // and a danger word for the same reason - was never told the two were priced
  // in one currency. So the ceiling fixes the scale, and every dip that remains
  // is reported as a measured difference against the same route unweighted.
  const hubs = ["Jita", "Amarr", "Dodixie", "Rens", "Hek"];
  let sweptRoutes = 0;
  let traded = 0;
  let undisclosed = 0;
  let sawHeatAct = 0;
  for (const from of hubs) {
    for (const to of hubs) {
      if (from === to) continue;
      const base = planner.calculate(from, to, "safer");
      if (!base.systems?.length) continue;
      // Seeded on the route the pilot would otherwise take, which is the only
      // shape that tempts the router off it; kills on a system nobody was
      // routed through prove nothing.
      const seeded = Object.fromEntries(base.systems.slice(1, -1).map(s => [s.name, 40]));
      for (const weight of ["cautious", "paranoid"]) {
        const hot = planner.calculate(from, to, "safer", emptyAvoid(), emptyLimits(), emptyBridges(),
          createStore(), withHeat(seeded, HEAT_LEVELS[weight]));
        if (!hot.systems?.length) continue;
        sweptRoutes += 1;
        if (hot.jumps !== base.jumps) sawHeatAct += 1;
        const dips = hot.belowHighSecurity.length - base.belowHighSecurity.length;
        if (dips <= 0) continue;
        traded += 1;
        if (!hot.heatTradedSecurity || hot.heatTradedSecurity.extra !== dips) undisclosed += 1;
      }
    }
  }
  t.check(sweptRoutes >= 30, `the sweep actually ran (${sweptRoutes} weighted routes)`);
  t.equal(undisclosed, 0,
    `every route heat took below high security reports it (${traded} traded, ${undisclosed} silently)`);
  // Both halves must be non-empty or the assertion above is vacuous: nothing to
  // disclose, or nothing moving at all.
  t.check(traded > 0, `the sweep still contains routes where heat traded security (${traded})`);
  t.check(sawHeatAct > 0, `and heat still reroutes (${sawHeatAct} of ${sweptRoutes} routes moved)`);

  // --- comparing costs tier by tier ---------------------------------------------
  // A literal 3 agrees with a three-tier tuple, so nothing fails - and a fourth tier
  // would be ignored in silence. A tier that is not compared is a preference that is
  // not honoured, which is the same class of bug the tuple replaced.
  t.equal(compareCost([1, 2, 3], [1, 2, 3]), 0, "identical costs compare equal");
  t.equal(compareCost([1, 2, 3], [1, 2, 4]), -1, "the last tier still decides when the earlier ones tie");
  t.equal(compareCost([1, 2, 3, 4], [1, 2, 3, 5]), -1,
    "and a fourth tier decides too, rather than being dropped by a hard-coded bound");
  t.equal(compareCost([1, 2, 3, 5], [1, 2, 3, 4]), 1, "in both directions");
  t.equal(compareCost([1, 2, 3], [1, 2, 3, 1]), -1, "a tuple with fewer tiers reads the missing ones as zero");
  t.equal(compareCost([0, 0, 0], [0, 0, 0]), 0, "and all-zero costs are equal, not merely not-greater");

  // A route heat did not push below high security must not claim it did.
  const quiet = planner.calculate("Jita", "Amarr", "safer");
  t.equal(quiet.heatTradedSecurity, null, "an unweighted route reports no trade");
  t.equal(planner.calculate("Jita", "Amarr", "shortest", emptyAvoid(), emptyLimits(), emptyBridges(),
    createStore(), withHeat({ Perimeter: 40 }, HEAT_LEVELS.paranoid)).heatTradedSecurity, null,
    "and nor does a mode that expressed no security preference to trade against");

  // Weighting applied, the route moved, and it crossed no *more* low-security
  // systems than it would have anyway. There is no trade to report, and
  // reporting one would print "took this route through 0 more systems outside
  // high security" - a disclosure of nothing, which reads as a warning.
  let equalDips = 0;
  let checkedPairs = 0;
  // Ahbazon is 0.4, so it is a dip the route cannot avoid however the weighting
  // is set - which is exactly the shape that matters here: dips above zero, and
  // identical with and without heat. Routes between high-security hubs mostly
  // end at zero dips, where the disclosure returns early and this case is never
  // reached.
  for (const [from, to] of [["Jita", "Ahbazon"], ["Amarr", "Ahbazon"], ["Sobaseki", "Ahbazon"],
    ["Jita", "Amarr"], ["Rens", "Dodixie"]]) {
    const base = planner.calculate(from, to, "safer");
    if (!base.systems?.length) continue;
    const seeded = Object.fromEntries(base.systems.slice(1, -1).map(s => [s.name, 40]));
    const hot = planner.calculate(from, to, "safer", emptyAvoid(), emptyLimits(), emptyBridges(),
      createStore(), withHeat(seeded, HEAT_LEVELS.paranoid));
    if (!hot.systems?.length) continue;
    checkedPairs += 1;
    if (hot.belowHighSecurity.length > 0 && hot.belowHighSecurity.length <= base.belowHighSecurity.length) {
      equalDips += 1;
      t.equal(hot.heatTradedSecurity, null,
        `${from} to ${to}: no extra dip, so no trade is claimed (${hot.belowHighSecurity.length} against ${base.belowHighSecurity.length})`);
    }
  }
  t.check(checkedPairs >= 3, `the no-trade case was exercised on real routes (${checkedPairs} pairs)`);
  t.check(equalDips > 0,
    `at least one crossed low security without heat having caused it (${equalDips}), `
    + "which is the case the early return exists for");

  // A field nobody renders is not a disclosure. Find a route that actually
  // traded and read what the pilot would see.
  let tradedRoute = null;
  for (const from of hubs) {
    for (const to of hubs) {
      if (from === to || tradedRoute) continue;
      const base = planner.calculate(from, to, "safer");
      if (!base.systems?.length) continue;
      const seeded = Object.fromEntries(base.systems.slice(1, -1).map(s => [s.name, 40]));
      const hot = planner.calculate(from, to, "safer", emptyAvoid(), emptyLimits(), emptyBridges(),
        createStore(), withHeat(seeded, HEAT_LEVELS.paranoid));
      if (hot.heatTradedSecurity) tradedRoute = hot;
    }
  }
  t.check(tradedRoute, "the sweep found a route to read the panel for");
  const tradedText = routeHeatPanel(tradedRoute).replace(/<[^>]+>/g, " ");
  t.check(/outside high security/.test(tradedText),
    "and the panel tells the pilot the route left high security to avoid kills");
  t.check(/the same route unweighted/.test(tradedText),
    "naming what it is measured against, so it reads as a comparison rather than a warning");
  // Every number labelled. The parenthetical read "(1 against 0, 21 jumps)"
  // beside a 22-jump route, so the jump count looked like this route's own and
  // disagreed with it.
  t.check(/This route crosses \d+/.test(tradedText), "and saying which count belongs to this route");
  t.check(/in \d+ jumps/.test(tradedText), "and that the jump count is the unweighted route's");
  t.check(/high-security only/.test(tradedText), "and how to refuse the trade");
  t.check(!/outside high security/.test(routeHeatPanel(planner.calculate("Jita", "Amarr", "safer"))),
    "a route that made no such trade says nothing about one");

  // --- the mode the disclosure was not gated on -------------------------------
  //
  // It only ran for "safer", on the reasoning that the trade is a contradiction
  // only when the pilot set a security word. But "shortest" is the default
  // mode, and under it the weighting leaves high security at no cost in jumps
  // and said nothing at all: Hatakani to Hykkota is 10 jumps either way, and
  // the weighted route crosses Vecamia and Ahbazon at 0.4 while the plain one
  // crosses nothing below high security. A pilot sets kill-avoidance in order
  // to be safer; the route it buys them is through low security, and the only
  // surface that could have said so was silent because of a mode name.
  const camp = Object.fromEntries(["Onnamon", "Kaunokka", "Uedama", "Sivala", "Hatakani",
    "Nourvukaiken", "Tunttaras"].map(name => [name, 40]));
  const plainShortest = planner.calculate("Hatakani", "Hykkota", "shortest");
  const weighted = planner.calculate("Hatakani", "Hykkota", "shortest", emptyAvoid(), emptyLimits(),
    emptyBridges(), createStore(), withHeat(camp, HEAT_LEVELS.paranoid));
  t.equal(plainShortest.belowHighSecurity.length, 0, "the plain shortest route stays in high security");
  t.check(weighted.belowHighSecurity.length > 0,
    `while weighting kills takes it out (${weighted.belowHighSecurity.map(s => s.name).join(", ")})`);
  t.equal(weighted.jumps, plainShortest.jumps, "for no extra jumps at all, so nothing else would hint at it");
  t.check(weighted.heatTradedSecurity, "and the trade is disclosed under shortest, not only under safer");
  t.check(/outside high security/.test(routeHeatPanel(weighted).replace(/<[^>]+>/g, " ")),
    "with the panel saying so in words");

  // "less-secure" stays excluded, because there the dip is the request.
  const wanted = planner.calculate("Hatakani", "Hykkota", "less-secure", emptyAvoid(), emptyLimits(),
    emptyBridges(), createStore(), withHeat(camp, HEAT_LEVELS.paranoid));
  t.check(wanted.belowHighSecurity.length > 0, "a less-secure route crosses low security");
  t.equal(wanted.heatTradedSecurity, null,
    "and claims no trade for it - the pilot asked to go there");

  // The ceiling itself, so a change to the mode weights fails here with a
  // readable number rather than somewhere inside the sweep.
  const costs = mode => [1, 0.5, 0.2, -0.5].map(security => planner.edgeCost({ security }, mode));
  t.equal(heatCeiling(costs("safer")), 5,
    "under safer, heat is capped one below the 6-jump premium on leaving high security");
  t.equal(heatCeiling(costs("shortest")), MAX_HEAT_PENALTY,
    "under shortest nothing is charged for security, so heat keeps its full range");
  t.equal(heatCeiling(costs("less-secure")), MAX_HEAT_PENALTY,
    "and under less-secure the low-security jump is already cheaper, so there is nothing for heat to buy");
  t.equal(heatCeiling([1, 1, 1]), MAX_HEAT_PENALTY, "a mode that charges nothing constrains nothing");
  t.equal(heatCeiling([26, 7, 1]), MAX_HEAT_PENALTY,
    "and the ceiling is only ever raised against the direction that reduces security");

  return t.results;
}
