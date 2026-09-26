// Inspector panel templates.
//
// **Every figure on a panel has to be true of the rows beside it**, which is the
// rule these templates exist to keep: the words are plain English, the arithmetic is
// right, and it is the sentence describing the arithmetic that goes wrong. A grid's
// cells account for the figure above them; a capped list says it is capped, with the
// number it drew; a summary counts its own rows; and the key has a swatch for every
// colour drawn.
//
// Everything here takes data and returns a string. No DOM, no module state, no
// event handlers. The caller inserts the result and binds the buttons, so these
// can be read, diffed and tested directly, and a template cannot quietly reach
// for application state that may not be current.

import { escapeHtml as esc, formatSecurity as secFormat, pathRank, RANKABLE } from "./map-utils.js";
import { liveTime, sentence } from "./live-time.js";

// --- shared formatting ------------------------------------------------------

export function lightYears(value) {
  return `${value.toFixed(2)} ly`;
}

export function minutes(value) {
  const total = Math.max(0, Math.round(Number(value) || 0));
  if (total < 60) return `${total} min`;
  if (total < 1440) return `${Math.floor(total / 60)}h ${total % 60}m`;
  return `${Math.floor(total / 1440)}d ${Math.floor((total % 1440) / 60)}h`;
}

const cell = (value, label) => `<div class="intel-cell"><strong>${value}</strong><span>${label}</span></div>`;
const grid = cells => `<div class="intel-grid">${cells.join("")}</div>`;
const section = (heading, body) => `<div class="inspector-section"><h3>${heading}</h3>${body}</div>`;
// A section with no heading. Some blocks are a single control and a title
// above it would be noise.
const plainSection = body => `<div class="inspector-section">${body}</div>`;

// describeAge returns a phrase, not a sentence - "synced just now", "synced 5m
// ago" - because it also has to read mid-line in the live bar. Where it starts
// a sentence instead, it needs a capital, and the alternative of baking one in
// would put it in the middle of the bar.
const header = (tag, heading, sub) =>
  `<div class="inspector-header"><span class="inspector-tag">${tag}</span><h2>${heading}</h2><p>${sub}</p></div>`;

// --- capital jump plan ------------------------------------------------------

// regionNameFor resolves a region id to its name. Passed in rather than read
// from the atlas here, so this file never touches application state.
export function jumpPanel(plan, regionNameFor) {
  return [
    header(
      "Capital jump plan",
      `${plan.jumps} ${plan.jumps === 1 ? "jump" : "jumps"}`,
      `${esc(plan.systems[0].name)} → ${esc(plan.systems.at(-1).name)} · ${esc(plan.ship.name)}`,
    ),
    grid([
      cell(lightYears(plan.rangeLy), "Jump range"),
      cell(lightYears(plan.totalLy), "Distance flown"),
      cell(plan.totalFuel.toLocaleString(), esc(plan.fuelTypeName)),
      cell(lightYears(plan.longestLeg), "Longest leg"),
    ]),
    section("Assumptions", jumpAssumptions(plan)),
    section("Regions crossed", `<p class="route-regions">${plan.regions.map(esc).join(" → ")}</p>`),
    plan.fatigue ? section("Jump fatigue", jumpFatigue(plan)) : "",
    section("Jump sequence", jumpSequence(plan, regionNameFor)),
  ].join("");
}

function jumpAssumptions(plan) {
  const parts = [
    `Jump Drive Calibration ${plan.calibration}`,
    `Jump Fuel Conservation ${plan.conservation}`,
    `${Math.round(plan.fuelPerLy).toLocaleString()} ${esc(plan.fuelTypeName)} per ly`,
  ];
  if (plan.hullFuelBonus) parts.push(`${esc(plan.hullFuelBonus.skill)} ${plan.hullSkill}`);
  if (plan.fuelModule) parts.push(esc(plan.fuelModule.name));
  if (plan.allowHighSec) parts.push("high-security arrivals allowed");

  // The rounding caveat is deliberate and belongs on screen: rounding up per
  // jump is this project's assumption, not a measured game rule.
  const note = "<strong>Load more fuel than this.</strong> The figures are the hull's own "
    + "numbers scaled by these skills, with each jump rounded up to a whole unit - but whether "
    + "the game rounds the same way has never been confirmed, so the total can be short."
    // The multiplier is a **reduction** on every hull that has one - a jump
    // freighter's is 0.1 - so "tires 0.1x faster than normal" is backwards. The row
    // says what `fatigueDistance` does with it instead, which reads correctly
    // whichever side of 1 the number falls on.
    + (plan.fatigueMultiplier !== null ? ` This hull counts ×${plan.fatigueMultiplier} of the distance jumped towards fatigue.` : "")
    + " The fatigue figures below are our model, not the game's own rule.";

  return `<p class="route-regions">${parts.join(" · ")}</p><p class="tactical-note">${note}</p>`;
}

// **Slower is usually fresher, never always.**
//
// "Fly it slower and you arrive fresher" is false wherever the fatigue cap bites,
// which is most chains worth planning. Four 4.5 ly jumps flown flat out end on a
// 27.33 minute timer; the same four with a ten-minute floor under every wait end on
// 27.63.
//
// The mechanism is the cap: the extra wait before the second jump drops fatigue going
// into the third, the third's cooldown is computed from that lower fatigue and comes
// out shorter, and a shorter cooldown is then all the pilot is made to wait - so less
// fatigue decays before the last jump and it lands more fatigued than the fast pilot.
// Both routes are at the 300 minute cap after jump three, which is what throws away
// the earlier saving. Below the cap the advice holds.
function jumpFatigue(plan) {
  const fatigue = plan.fatigue;
  const note = (fatigue.cappedOut ? "<strong>This route maxes out your fatigue.</strong> " : "")
    + "<strong>The waits below are the fastest legal pace, not the best one.</strong> Fatigue "
    + "burns off while you sit, so a slower chain usually ends on a shorter timer - usually, not "
    + "always. Once fatigue is at its cap, waiting longer early buys a shorter cooldown mid-route, "
    + "and that shorter cooldown is then all you are made to wait, so less fatigue decays before "
    + "the last jump. After the last jump you "
    + `are stuck for ${minutes(fatigue.finalCooldownMinutes)} before you can jump again. `
    + "Treat every figure here as an estimate: the hull's distance reduction is the game's own "
    + `number, but the rule turning it into fatigue is a model we wrote (${esc(fatigue.model.formula)}) `
    + "rather than anything the game publishes.";

  return grid([
    cell(lightYears(plan.effectiveLy), "Effective distance"),
    cell(minutes(fatigue.finalFatigueMinutes), "Fatigue after last jump"),
    cell(minutes(fatigue.travelWaitMinutes), "Waiting en route"),
    cell(plan.fatigueMultiplier === null ? "none" : `×${plan.fatigueMultiplier}`, "Hull reduction"),
  ]) + `<p class="tactical-note">${note}</p>`;
}

function jumpSequence(plan, regionNameFor) {
  if (!plan.legs.length) {
    return '<p class="tactical-note">Origin and destination are the same system.</p>';
  }
  return plan.legs.map((leg, index) => {
    const step = String(index + 1).padStart(2, "0");
    const region = regionNameFor(leg.to.region_id);
    return `<div class="jump-leg">`
      + `<button data-jump-system="${esc(leg.to.system_id)}" data-jump-region="${esc(region)}">${step} ${esc(leg.to.name)}</button>`
      + `<strong>${lightYears(leg.distanceLy)}</strong>`
      + `<small>from ${esc(leg.from.name)} · ${leg.fuelUnits.toLocaleString()} ${esc(plan.fuelTypeName)} · ${secFormat(leg.to.security)}</small>`
      + `</div>`;
  }).join("");
}

// --- stargate route ---------------------------------------------------------

const ROUTE_MODE_LABELS = {
  shortest: "Shortest route",
  safer: "Safer route",
  // **A hard exclusion, and the label must not promise a dip.** `high-sec-only`
  // refuses to route rather than leaving high security, so `belowHighSecurity` is
  // provably always empty under it - measured over 91 routes, 23 of which came back
  // unroutable. "Where possible" tells a pilot the router will dip if it has to; it
  // will not, and a pilot who believes otherwise reads "no route" as a bug rather
  // than as the answer.
  "high-sec-only": "High security only",
  "less-secure": "Low/null preference",
};

export function routePanel(route, regionNameFor) {
  return [
    header(
      route.wormholeJumps || route.bridgeJumps ? "Mixed route" : "Stargate route",
      `${route.jumps} ${route.jumps === 1 ? "jump" : "jumps"}`,
      `${esc(route.origin.name)} \u2192 ${esc(route.destination.name)}`,
    ),
    grid([
      cell(route.security.high, "High-sec systems"),
      cell(route.security.low, "Low-sec systems"),
      cell(route.security.null, "Null-sec systems"),
      cell(route.regions.length, "Regions crossed"),
    ]),
    section(esc(ROUTE_MODE_LABELS[route.mode] ?? ROUTE_MODE_LABELS.shortest), `<p class="route-regions">${route.regions.map(esc).join(" \u2192 ")}</p>`),
    routeConstraintsPanel(route),
    routeProtestPanel(route),
    routeHeatPanel(route),
    section("Route sequence", route.systems.map((system, index) =>
      `<button class="route-step" data-route-system="${esc(system.system_id)}" data-route-region="${esc(regionNameFor(system.region_id))}">`
      + `<span class="route-step-index">${String(index).padStart(2, "0")}</span>`
      + `<span>${esc(system.name)}`
      + (index > 0 && route.legKinds?.[index - 1] && route.legKinds[index - 1] !== "gate"
        ? `<small class="route-leg-kind">${esc(route.legKinds[index - 1])}</small>` : "")
      + `</span>`
      + `<span class="route-step-meta">${secFormat(system.security)}</span>`
      + `</button>`).join("")),
  ].join("");
}

// Constraints are only shown when there are some, so an unconstrained route
// does not carry an empty heading implying otherwise.
export function routeConstraintsPanel(route) {
  // Said before the constraints that *are* in force, because it changes what
  // the rest of the section means.
  const suspended = Number(route.avoidanceSuspended) || 0;
  const suspendedNote = suspended
    ? `<p class="tactical-note">Avoidance is off. ${suspended} `
      + `${suspended === 1 ? "entry is" : "entries are"} not being applied, so this route may cross them.</p>`
    : "";
  const parts = [];
  if (route.limits) {
    if (route.limits.min !== null) parts.push(`Security at least ${route.limits.min.toFixed(1)}`);
    if (route.limits.max !== null) parts.push(`Security at most ${route.limits.max.toFixed(1)}`);
  }
  if (route.avoid) {
    parts.push(...route.avoid.regionNames.map(name => `${esc(name)} (region)`), ...route.avoid.systemNames.map(esc));
  }
  if (!parts.length) return suspendedNote ? section("Avoiding", suspendedNote) : "";
  return section("Avoiding", `<p class="route-regions">${parts.join(" \u00b7 ")}</p>` + suspendedNote);
}

// Hot systems the route crosses, and whether kills were weighed at all.
//
// The two are reported together because the dangerous reading is the silent
// one: a route with no "crossed" list, from a tool that never had kill data,
// looks exactly like a route that checked and found nothing.
export function routeHeatPanel(route) {
  const heat = route.heat ?? null;
  const crossed = route.hotCrossed ?? [];
  // Weighting kills and preferring high security are priced in one currency, so
  // avoiding a camp can buy a jump out of high security. That is a real trade
  // and the pilot may well want it - a high-security system with forty kills in
  // it is a gank camp, and a quiet low-security system may genuinely be safer -
  // but they set a security word and a danger word for the same reason and have
  // no way to know the two argue. Measured against the same route unweighted,
  // never inferred, and shown before the kill list because it is the part that
  // contradicts what the mode selector says.
  const traded = route.heatTradedSecurity ?? null;
  // Weighting was applied and it changed something, so the clean result is the
  // weighting's doing rather than an empty map.
  const crossedAround = Boolean(route.heat?.applied && route.heat?.kills?.size);
  // Every number says what it is. A bare parenthetical - "(1 against 0, 21 jumps)"
  // beside a 22-jump route - reads as this route's jump count and does not match it.
  const tradeNote = traded
    ? `<p class="tactical-note">Avoiding kills took this route through `
      + `${traded.extra} more ${traded.extra === 1 ? "system" : "systems"} outside high security `
      + `than it needed to. This route crosses ${traded.withHeat}; the same route unweighted `
      + `crosses ${traded.without} in ${traded.unweightedJumps} jumps. `
      + `Lower the kill weighting, or use high-security only, to refuse the trade.</p>`
    : "";
  if (!heat?.weight && !crossed.length) return "";
  if (heat?.weight && !heat.applied) {
    // Which of the two is true changes what a pilot should do about it, and one
    // of them contradicts the live bar if reported as the other.
    const because = heat.unweighed === "kills-absent"
      ? 'Not weighed - activity synced, but the kills half did not answer.'
      : 'Not weighed - no activity data has been synced.';
    const next = heat.unweighed === "kills-absent"
      ? 'The route is the unweighted one. Jump counts are current; kills are not, so nothing here '
        + 'says a system is quiet. Re-sync to weigh them.'
      : 'The route is the unweighted one. Sync the live layers to weigh kills.';
    return section("Kills", `<p class="route-regions">${because}</p>`
      + `<p class="tactical-note">${next}</p>`);
  }
  const heatAge = heat?.at ? ` <span class="tactical-note">${liveTime("age", heat.at)}.</span>` : "";
  if (!crossed.length) {
    // Why there are none, when the weighting is what put them off the route.
    // "No system on this route had a player kill" directly above "avoiding
    // kills took this route through one more system outside high security"
    // reads as a contradiction - both are true, and the second is the reason
    // for the first, which the reader should not have to work out.
    const why = traded || crossedAround ? " The weighting routed around them." : "";
    // **"On this route" would include the origin, which is on the route.**
    //
    // `route-planner.js` builds `hotCrossed` with `index > 0`, which is right for
    // *weighting* - you are already there, so there is nothing to route around - and
    // is not what a sentence about the route says. Unqualified, it gives an explicit
    // all-clear to a pilot sitting in a system with forty-two kills in the reported
    // hour, while the Route sequence below renders that system as step 00.
    //
    // So the sentence says which systems it is about, and the origin is named
    // separately when it is hot: "you are in it" is a different fact from "you will
    // fly through it".
    const origin = route.systems?.[0] ?? null;
    const originKills = route.originKills ?? 0;
    const plural = originKills === 1 ? "player kill" : "player kills";
    const standing = origin && originKills > 0
      ? ` You are in ${esc(origin.name)}, which had ${originKills.toLocaleString()} ${plural} in it.`
      : "";
    return section("Kills",
      '<p class="route-regions">No system ahead of you on this route had a player kill in the hour this reading covers.'
      + esc(why) + standing + heatAge + '</p>' + tradeNote);
  }
  return section("Kills", tradeNote + crossed.map(entry =>
    `<button class="neighbor" data-route-system="${esc(entry.system.system_id)}">`
    + `<span>${esc(entry.system.name)}</span>`
    + `<span>${entry.playerKills} in the reported hour</span>`
    + `</button>`).join("")
    + '<p class="tactical-note">Crossed anyway: going round cost more than the kills were worth '
    + `at this setting.${heatAge}</p>`);
}

// A soft entry the route had to use is the one thing the avoidance mechanism
// must never do quietly. The pilot asked to stay out and the router went
// through anyway because there was no way around; saying nothing would present
// a route that breaks a standing order as an ordinary one.
export function routeProtestPanel(route) {
  const systems = (route.avoidedAnyway ?? []).map(system => esc(system.name));
  // Every kind that is not a gate says which it is, derived from the kind
  // rather than from a list naming one of them.
  //
  // Testing for "bridge" alone renders a soft-ignored hole crossed anyway as a bare
  // pair of names, identical to a gate - and there is no gate between Jita and Thera.
  // This panel exists so a pilot knows which standing order was broken, and an
  // unlabelled entry cannot tell them.
  const edges = (route.edgesUsedAnyway ?? []).map(edge =>
    `${esc(edge.from.name)} \u2014 ${esc(edge.to.name)}`
    + (edge.kind && edge.kind !== "gate" ? ` (${esc(edge.kind)})` : ""));
  const used = [...systems, ...edges];
  if (!used.length) return "";
  return section("Used anyway", `<p class="route-regions">${used.join(" \u00b7 ")}</p>`
    + '<p class="tactical-note">There was no way around these. They are avoided, not blocked - '
    + 'make an entry hard if the route should fail instead of going through.</p>');
}

// --- jump range -------------------------------------------------------------

export function rangePanel(range, regionNameFor, securityClassOf) {
  const regions = [...range.regionIds].map(regionNameFor).sort();
  const byClass = { high: 0, low: 0, null: 0 };
  for (const entry of range.entries) byClass[securityClassOf(entry.system.security)] += 1;

  const reach = section("Regions in reach",
    `<p class="route-regions">${regions.map(esc).join(" \u00b7 ")}</p>`
    + '<p class="tactical-note">Highlighting is computed from real distance. The ring is a flat '
    + 'guide through a three-dimensional volume, so read it as orientation rather than a boundary.</p>'
    + (range.allowHighSec
      ? '<p class="tactical-note">High-security systems are listed because the toggle asks for them. '
        + 'A cynosural field cannot be lit in high security, so they are inside the ring and are not '
        + 'places this ship can arrive.</p>'
      : ""));

  const nearest = section("Nearest systems", range.entries.slice(0, 12).map(entry => {
    const region = regionNameFor(entry.system.region_id);
    return `<div class="jump-leg">`
      + `<button data-range-system="${esc(entry.system.system_id)}" data-range-region="${esc(region)}">${esc(entry.system.name)}</button>`
      + `<strong>${lightYears(entry.distanceLy)}</strong>`
      + `<small>${esc(region)} \u00b7 ${secFormat(entry.system.security)}</small>`
      + `</div>`;
  }).join(""));

  // **The cells have to add up to the figure above them.** With "Show high-sec in
  // range" on, a high-security count computed and rendered nowhere leaves Jita/Ark
  // reading 448 systems in reach over cells totalling 153: 295 systems present,
  // counted, and named in no cell, twelve of them heading the Nearest block.
  //
  // Two readings, because a capital pilot is asking two questions: what the ring
  // covers, and where the ship can actually come out. A cynosural field cannot be
  // lit in high security, so a high-sec system inside the ring is orientation and
  // not a destination - which is why the count is labelled with the reason rather
  // than left to be inferred from a security word.
  //
  // Only when they are in the set. With the toggle off `systemsInRange` excludes
  // them, the four cells already add up, and a "High-sec 0" cell would raise a
  // question with no answer. The grid is two columns, so the count stays even.
  const arrivable = byClass.low + byClass.null;
  const cells = [
    cell(range.systemIds.size.toLocaleString(), "Systems in reach"),
    cell(regions.length, "Regions touched"),
  ];
  if (range.allowHighSec) {
    cells.push(
      cell(arrivable.toLocaleString(), "Can arrive"),
      cell(byClass.high.toLocaleString(), "High-sec, no cyno"),
    );
  }
  cells.push(
    cell(byClass.low.toLocaleString(), "Low-sec"),
    cell(byClass.null.toLocaleString(), "Null-sec"),
  );

  return header("Jump range", lightYears(range.rangeLy), `${esc(range.origin.name)} \u00b7 ${esc(range.ship.name)}`)
    + grid(cells)
    + reach
    + nearest;
}

// --- regional file ----------------------------------------------------------

export function regionPanel(region, facts, regionNameFor, showOpenButton) {
  const boundary = facts.adjacentRegionIds.length
    ? facts.adjacentRegionIds.map(id =>
      `<button class="neighbor" data-region="${esc(id)}">`
      + `<span>${esc(regionNameFor(id) || id)}</span><span>REGION ↗</span>`
      + `</button>`).join("")
    : '<p class="muted">No standard boundary gate recorded.</p>';
  const open = showOpenButton
    ? `<button class="open-region" data-open="${esc(region.name)}">Open regional map</button>`
    : "";

  return header("Regional file", esc(region.name), `Administrative region ${region.region_id}`)
    + grid([
      cell(region.systems.length, "Systems"),
      cell(region.constellations.length, "Constellations"),
      cell(facts.adjacentRegionIds.length, "Adjacent regions"),
      cell(facts.meanSecurity.toFixed(2), "Mean security"),
    ])
    + section("Border gates", boundary + open);
}

// --- solar system -----------------------------------------------------------

export function compactNumber(value) {
  const n = Number(value) || 0;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

// A separate block because it is the one part of the system panel that is a
// claim about the **network** rather than about the system. The caveat that
// matters - that these are shapes on the map and not reports of anybody being
// there - is said in those words rather than as "structural, not traffic",
// which is the same distinction in terms a pilot has to translate.
//
// None of the three labels here is a term of art. A label that is one forces the note
// under it to spend its first sentence defining a word instead of saying what to do
// about it, and a pilot deciding whether to undock should not have to translate.
// **A row has to distinguish something, or it reads as a figure that never moves.**
//
// Counting the systems on the same network prints 5,228 on 5,228 of the 5,268 gated
// panels, beside three rows that do change - so a pilot clicking system after system
// sees one value stuck.
//
// What varies is the fact worth having: whether this system has a gate route to the rest
// of the cluster at all. Pochven's 27 do not, and neither do two pockets of 7 and 6. So
// the value classifies and the count rides along.
//
// The row stays on every panel rather than appearing only for the interesting 40. An
// absent row cannot be told from a broken one, and "on the main network" is a real
// answer to the question the label asks.
function networkLabel(metrics, scale) {
  if (metrics.component < 0) return "Isolated";
  const size = Number(metrics.component_size);
  if (!Number.isFinite(size)) return "not measured";
  const counted = `${size.toLocaleString()} systems`;
  // `reduce`, not `Math.max(...)`: the house rule about spreading an array, even
  // though four components could never reach the argument limit.
  const largest = scale?.components
    ? [...scale.components.values()].reduce((most, list) => Math.max(most, list.length), 0)
    : 0;
  // No scale is nothing to compare against, so the count stands alone rather than
  // claiming a relationship this call could not check.
  if (largest === 0) return counted;
  return size === largest ? `Main network, ${counted}` : `${counted}, no gate route out`;
}

export function graphPositionPanel(system, scale = null) {
  const metrics = system.metrics;
  if (!metrics) return "";
  // Null when no archive was handed over, and the row then shows the figure
  // alone - which is what it did everywhere before, and is still better than a
  // rank computed from nothing.
  // **Only a measured figure is rendered at all.** `compactNumber` is
  // `Number(value) || 0`, so a system whose metrics carry no path count shows a bare
  // `0`, which reads as "nothing goes through here" when the truth is that nobody
  // counted. A figure nobody measured is not a zero.
  const counted = Number.isFinite(metrics.betweenness);
  // Ranked inside its own network, and suppressed where that network is too
  // small for a percentage to mean anything.
  const component = metrics.component;
  const peers = scale?.components?.get(component)?.length ?? 0;
  const rank = peers >= RANKABLE ? pathRank(scale, metrics.betweenness, component) : null;
  const rows = [
    ["Gate links", metrics.degree],
    // **"Routes through here", and the game's word for it.**
    //
    // EVE calls this a route - it is what the autopilot sets and what a pilot says - so
    // the label says route, and the note under it says route, and they are the same word.
    // A label reading "paths" over a note reading "gate routes" is one vocabulary too
    // many in the place a reader looks first.
    //
    // The figure is a count of shortest routes that pass through this system, so the
    // plain name is also the accurate one - and it is the label that makes the caveat
    // below read as a clarification rather than as a correction.
    ["Routes through here", !counted
      ? "not measured"
      : rank === null
        ? compactNumber(metrics.betweenness)
        // **Floored, never rounded.** `pathRank` is a lower bound, so the busiest
        // system in a component ranks (n-1)/n, and rounding turns 99.98% into "busier
        // than 100%" - a claim that it is busier than itself. Flooring also never
        // overstates how much of a pipe something is.
        : `${compactNumber(metrics.betweenness)} · busier than ${Math.floor(rank * 100)}%`],
    ["Chokepoint", metrics.articulation ? "Yes" : "No"],
    ["Gate network", networkLabel(metrics, scale)],
  ];
  // **Said the way a pilot would say it.** "Pipe" is the word for a system every
  // route has to fly, and it is the exact concept this number measures - so the
  // EVE word is also the accurate one, and using it costs nothing in precision.
  // The caveat lands harder in it too: "an empty pipe scores as high as a camped
  // one" is a sentence an FC recognises immediately.
  // **One paragraph per figure.** `tests/brief-language.test.mjs` holds every note here
  // under 320 characters, because a note longer than the panel it explains is a note
  // nobody reads under fire - and two explanations sharing that budget leave neither room
  // to be a sentence rather than a telegram. Split, each uses about two thirds of it.
  //
  // Three branches on the first, because the figure above it has three states and a note
  // that describes the usual case is wrong on the other two.
  const share = scale && Number.isFinite(scale.chokeShare)
    ? Math.round(scale.chokeShare * 100) : 0;
  const pipe = "A high count means a pipe - good hunting, bad hauling. It counts routes, "
    + "not ships: an empty pipe scores as high as a camped one.";
  // **The scope is named, because it decides what the figure means.** These are routes
  // across the whole network, not traffic in the area a pilot is working in - and a system
  // can be the 96th percentile of the cluster while carrying almost nothing within its own
  // region, which is what Ahbazon is. Measured: scoping this to a region instead drops the
  // median rank of the 667 systems with a gate out of theirs by 46 points, and takes the
  // worst of them from the 99th percentile of the cluster to the 0th of their region. A
  // system on a border carries few routes *within* that border. Those are the pipes.
  //
  // So the local question - what is forced through the area I am operating in - is the
  // analyser's, where the radius is centred on the pilot rather than on an administrative
  // boundary. The chokepoint note below points at it.
  const paths = !counted
    ? "No route count was measured here, so the traffic forced through this system is "
      + "unknown rather than low."
    : rank === null
      ? "Routes through here counts the gate routes across the whole network forced through "
        + `this system. ${pipe} This network is too small to rank within.`
      : "Routes through here counts the gate routes across the whole network forced through "
        + `this system, ranked against the rest of the network. ${pipe}`;
  // Said because a "Yes" above reads as rare and is not. Measured from the archive
  // rather than written down, so a rebuild cannot make it stale - and guarded on the
  // **rounded** figure, or an archive with a handful of chokepoints prints "0% are
  // chokepoints" beside a row saying Yes.
  // **No definition.** A pilot knows what a chokepoint is; what they cannot know from a
  // bare Yes is how ordinary one is, which is the only reason this note exists.
  const choke = share > 0
    ? `${share}% of gated systems are chokepoints, so a Yes here is commoner than it looks. `
      + "The tactical analyser finds the ones inside a radius you pick."
    : "";
  return section("Where this sits",
    rows.map(([label, value]) =>
      `<button class="neighbor"><span>${esc(label)}</span><span>${esc(value)}</span></button>`).join("")
    + `<p class="tactical-note">${paths}</p>`
    + (choke ? `<p class="tactical-note">${choke}</p>` : ""));
}

// Null means nothing is known, which is not the same as nobody holding it. An
// unsynced store must not present an empty universe as a finding.
export function sovereigntyPanel(sovereignty) {
  if (!sovereignty) return "";
  if (!sovereignty.holding) {
    return section("Sovereignty", '<p class="tactical-note">No alliance holds this system. '
      + `${liveTime("age", sovereignty.at)}.</p>`);
  }
  const swatch = `<i class="sec-dot" style="color:${esc(sovereignty.colour)};background:${esc(sovereignty.colour)}"></i>`;
  return section("Sovereignty",
    `<button class="neighbor"><span class="sec-line">${swatch}Alliance</span>`
    + `<span>${esc(sovereignty.holding.alliance_id)}</span></button>`
    + (sovereignty.holding.corporation_id
      ? `<button class="neighbor"><span>Holding corporation</span><span>${esc(sovereignty.holding.corporation_id)}</span></button>`
      : "")
    + `<p class="tactical-note">${liveTime("age", sovereignty.at)}. `
    + 'Sovereignty is live data and is only as current as the last sync.</p>');
}

// Two ways to avoid a system, because they are two different commitments and
// collapsing them would lose one. The first belongs to the route being planned
// and travels with a corridor if it is saved or shared. The second is a
// standing order that outlives the route, expires on its own and is the one a
// pilot means by "this system is camped".
function avoidControls(avoided) {
  const left = avoided ? liveTime("remaining", avoided.expiresAt, { embedded: true }) : "";
  const standing = avoided
    ? `<button class="open-region" data-avoid-standing="clear">Stop avoiding${left ? ` (${left})` : ""}</button>`
    : '<button class="open-region" data-avoid-standing="day">Avoid for a day</button>';
  return '<button class="open-region" data-avoid-add="1">Add to avoid list</button>' + standing;
}

// What reaches this system, and from where.
//
// Absent when no staging has been set - the same distinction sovereignty makes
// between "never synced" and "nothing held". An empty section here would read
// as "nothing reaches you", which is the one answer this overlay must never
// give by accident.
export function threatPanel(threats) {
  if (threats === null) return "";
  // **"Never larger" is the one thing this cannot promise.** The envelope is a single
  // jump from each staging system and a capital can chain: a titan staged in Tama
  // covers 52 systems in one jump and 155 in two, so 103 systems sit outside an
  // overlay whose note claims the real reach is this or smaller. Every other
  // assumption in it does point the pessimistic way, which is what makes such a
  // sentence read as safe.
  //
  // One jump is the model - a hull that double-jumps arrives under a cooldown it
  // cannot leave under, which is a different operational question - so the note says
  // which question it answered.
  const note = '<p class="tactical-note">This is <strong>one jump</strong> from the staging you '
    + 'listed, at perfect skills, with every staging system live and no cyno jammers up. Jammers '
    + 'shrink it and cannot be seen by any tool outside the game. A second jump reaches further '
    + 'again, at the cost of a cooldown the hull cannot leave under. Read it as reach, never as a '
    + 'boundary.</p>';
  if (!threats.length) {
    return section("Threat reach",
      '<p class="route-regions">No jump-capable hull reaches this system from the staging set.</p>' + note);
  }
  if (threats[0].isStaging) {
    return section("Threat reach",
      '<p class="route-regions">This is one of the staging systems.</p>' + note);
  }
  // A hauler is named as one. The two longest-reaching groups in New Eden are a
  // Rorqual and a jump freighter, so sorted by reach they head a list titled "Threat
  // reach": they sort below the combat hulls, and the row says what it is rather than
  // relying on a pilot knowing the group names.
  return section("Threat reach", threats.map(threat =>
    `<button class="neighbor" data-threat-from="${esc(threat.fromId)}">`
    + `<span>${esc(threat.group)}${threat.combat === false ? " \u00b7 not a combat hull" : ""}</span>`
    + `<span>${lightYears(threat.distanceLy)} from ${esc(threat.fromSystem.name)}</span>`
    + `</button>`).join("") + note);
}

// Incursions and frontlines, in the inspector.
//
// Absent when nothing has been synced - the same line sovereignty draws. A
// quiet section would read as "nothing is happening here", which is a claim,
// and an unsynced tool has no business making it.
export function ambientPanel(ambient) {
  if (!ambient) return "";
  const rows = [];
  if (ambient.incursionText) {
    rows.push(`<button class="neighbor"><span>Incursion</span><span>${esc(ambient.incursionText)}</span></button>`);
  }
  if (ambient.frontlineText) {
    rows.push(`<button class="neighbor"><span>Faction warfare</span><span>${esc(ambient.frontlineText)}</span></button>`);
  }
  // **Synced and quiet is a finding.** Returning "" makes a system with no incursion
  // identical to a system nobody has asked about. `ambientOf` returns null when
  // nothing has been synced, so reaching this point means the question was asked and
  // the answer was nothing - which is worth a sentence, with its age, exactly as
  // sovereignty does one section down.
  if (!rows.length) {
    return section("Incursions and FW",
      '<p class="tactical-note">No incursion and no faction-warfare frontline here. '
      + `${liveTime("age", ambient.at)}.</p>`);
  }
  return section("Incursions and FW", rows.join("")
    + `<p class="tactical-note">${liveTime("age", ambient.at)}.</p>`);
}

// Kills and traffic, in the inspector.
//
// Absent when nothing has been synced. A measured zero and an unmeasured one
// are different claims, and "no kills here" from a tool that has never asked
// is the more dangerous of the two.
// How far back the readings actually reach, said plainly, because the count
// alone cannot say it.
function trendSpan(trend) {
  const stamps = (trend ?? []).map(point => point?.at).filter(Number.isFinite);
  if (stamps.length < 2) return "";
  const across = Math.max(...stamps) - Math.min(...stamps);
  const hours = across / 3_600_000;
  if (hours < 1.5) return ", taken within the hour";
  if (hours < 48) return `, reaching back ${Math.round(hours)} hours`;
  return `, reaching back ${Math.round(hours / 24)} days`;
}

export function heatPanel(heat) {
  // Absent rather than the word "undefined". `heat.text` is what `describeHeat` wrote
  // and is the whole content of the row; without it there is nothing to report, which
  // is not the same as a reading of nothing.
  if (!heat || typeof heat.text !== "string") return "";
  const trend = (heat.trend ?? []).filter(point => point.playerKills > 0).length;
  // **Readings, not hours.** `heat.trend` is one entry per sync that measured
  // kills, capped at `HISTORY_LIMIT` - and `activity.js` says in as many words
  // that "an hour with no kill measurement in it is not an hour". Nothing
  // bucket-fills the gaps. So three syncs a day apart rendered "1 of the last 3
  // hours had a kill in them", and a full history reads "1 of the last 24
  // hours" over a series that may span a fortnight.
  //
  // It reads as "this system has been quiet for a day" when the truth is "we
  // have twenty-four readings and no idea what happened between them" - on the
  // one sentence on this panel a pilot would act on before undocking.
  //
  // The project already knew: `snapshot.js` carries `spanMs` to the model for
  // exactly this reason, noting that "twenty-four entries can cover a day or a
  // fortnight". The model was told and the pilot was not, so the span is said
  // here too.
  const readings = heat.trend?.length ?? 0;
  const shape = readings > 1
    ? `<p class="tactical-note">${trend} of the last ${readings} `
      + `${readings === 1 ? "reading" : "readings"} had a kill in them${trendSpan(heat.trend)}. `
      + "Readings are syncs, not hours - nothing is known about the gaps between them.</p>"
    : "";
  // Every other live panel shows the age of what it is showing; this one was
  // handed `heat.at` and dropped it, so a six-hour-old count was presented with
  // no qualification at all. The heading says "Last reading" rather than "Last
  // hour" for the same reason: the hour it describes may not be this one.
  const age = heat.at ? `<p class="tactical-note">${liveTime("age", heat.at)}.</p>` : "";
  return section("Activity",
    `<button class="neighbor"><span>Last reading</span><span>${esc(heat.text)}</span></button>`
    + shape + age);
}

// Sovereignty timers in this system.
//
// A live fight and a scheduled one are separated rather than listed together,
// because a fleet commander reads them differently and a timetable that mixes
// them is a timetable you have to decode.
export function campaignPanel(campaigns) {
  // Null is "nobody has looked", an empty list is "looked, and there is no timer
  // here". `campaignsFor` is explicit about returning null for the first, and its
  // own comment says the difference "is the whole point" for a timer - and then
  // this collapsed the two into the same blank space.
  if (!campaigns) return "";
  if (!campaigns.length) {
    return section("Sovereignty timers",
      '<p class="tactical-note">No sovereignty timer here. Timers move; this is what the last '
      + 'sync said, and the age is on the live bar.</p>');
  }
  // The countdown carries its own instant, so the tick recomputes it rather
  // than leaving "in 3h 20m" on screen three hours later.
  const row = campaign =>
    `<button class="neighbor"><span>${esc(campaign.live ? "Under attack" : "Scheduled")}</span>`
    + `<span>${esc(campaign.label)} · ${liveTime("countdown", campaign.startTime, { embedded: true })}</span>`
    + `</button>`;
  const live = campaigns.filter(campaign => campaign.live);
  const soon = campaigns.filter(campaign => !campaign.live);
  return section("Sovereignty timers", [...live, ...soon].map(row).join("")
    + '<p class="tactical-note">Timers move. This is what the last sync said, and the age is on the live bar.</p>');
}

export function systemPanel(system, context) {
  const { constellationName, regionName, neighbors, regionNameFor, securityColour, securityName } = context;
  const sovereignty = context.sovereignty ?? null;
  const external = neighbors.filter(n => n.region_id !== system.region_id);

  const adjacency = neighbors.map(n =>
    `<button class="neighbor" data-system="${esc(n.system_id)}" data-region-name="${esc(regionNameFor(n.region_id))}">`
    + `<span>${esc(n.name)}</span>`
    + `<span>${secFormat(n.security)} ${n.region_id !== system.region_id ? "↗" : ""}</span>`
    + `</button>`).join("");

  const colour = securityColour(system.security);
  const securityCell = `<div class="intel-cell"><strong class="sec-line">`
    + `<i class="sec-dot" style="color:${esc(colour)};background:${esc(colour)}"></i>${secFormat(system.security)}</strong>`
    + `<span>${securityName(system.security)}</span></div>`;

  return header("Solar system", esc(system.name), `${esc(constellationName)} · ${esc(regionName)}`)
    + `<div class="intel-grid">${securityCell}`
    + cell(neighbors.length, "Gate links")
    + cell(neighbors.length - external.length, "Internal links")
    + cell(external.length, "Boundary links")
    + `</div>`
    // Perishable before permanent.
    //
    // These sections arrived one at a time, each appended below the last, and
    // the result put a timer that starts in ten minutes underneath a list of
    // stargates that has not changed since 2003. Ordered by how fast the fact
    // goes stale, the urgent things are at the top and - because every live
    // section is absent until its layer is synced - an unsynced install still
    // opens on the familiar static panel rather than a column of empty
    // headings.
    + campaignPanel(context.campaigns ?? null)
    + heatPanel(context.heat ?? null)
    + ambientPanel(context.ambient ?? null)
    + threatPanel(context.threats ?? null)
    + sovereigntyPanel(sovereignty)
    + section("Gates from here", adjacency)
    + plainSection(avoidControls(context.avoided ?? null))
    + graphPositionPanel(system, context.graphScale ?? null)
    + section("Archive identifiers",
      `<button class="neighbor"><span>System ID</span><span>${system.system_id}</span></button>`
      + `<button class="neighbor"><span>Constellation ID</span><span>${system.constellation_id}</span></button>`);
}

// --- tactical brief ---------------------------------------------------------
//
// The largest template in the project, and the one whose blocks are optional,
// so it is built from named pieces rather than one expression. Each block
// states what it means when empty, because an empty block and an absent one
// look identical on screen and mean different things.

const systemButton = (system, regionNameFor, label = system.name) =>
  `<button class="neighbor" data-tactical-system="${esc(system.system_id)}" `
  + `data-tactical-region="${esc(regionNameFor(system.region_id))}">`
  + `<span>${esc(label)}</span><span>${secFormat(system.security)}</span></button>`;

const vector = (system, regionNameFor, strong, small) =>
  `<div class="tactical-vector">`
  + `<button data-tactical-system="${esc(system.system_id)}" data-tactical-region="${esc(regionNameFor(system.region_id))}">`
  + `${esc(system.name)}</button>`
  + `<strong>${strong}</strong><small>${small}</small></div>`;

// --- how a note is written ---------------------------------------------------
//
// The obvious order is **what the number is**, then how it is computed, then where it
// came from, then - last - what it means for the pilot. That is backwards: the last
// clause is the only one that changes what anybody does, and it should not sit behind a
// definition.
//
// "Betweenness is the share of all shortest stargate paths between all other
// system pairs that passes through here" is a correct sentence that tells an FC
// nothing at the moment they are reading it. They are not asking what the
// metric is. They are asking whether to go there.
//
// So a note leads with **what it means for the pilot**, then **the limit on
// trusting it**, and gives a definition only where the word itself would
// otherwise mislead. The caveats are not dropped - "structural, not traffic",
// "a model rather than the archive", "upper bound" are load-bearing and this
// project exists to keep them - they are moved to where they are read, and
// said in words rather than in terms.
//
// What went is the provenance prose. Where a figure comes from belongs in the
// comment above the code that computes it, which is where a reader who needs it
// will be; on screen it crowds out the sentence that matters.
const emptyNote = text => `<p class="tactical-note">${text}</p>`;

// How many rows the tactical lists carry. Named rather than spelled at the slice,
// for the reason `CHOKE_LIMIT` is named: the sentence beside a list has to say the
// same number the slice used, and a literal in two places is two numbers.
export const SOLE_LINK_ROWS = 12;
export const BORDER_ROWS = 24;

// **"Anything that counts this set has to say so."** That is
// `tactical-analyzer.js`'s own rule about `CHOKE_LIMIT`, and `snapshot.js` obeys
// it. This panel did not, in three places: sole links at 12, border systems at 24,
// and the choke list the analyser had already capped at 20 while publishing
// `chokesTruncated` that nothing here read. Amarr at depth 10 carries 77 sole
// links and 104 boundary systems; twelve and twenty-four were drawn, and nothing
// on screen said the other 65 and 80 existed. A capped list read as a complete
// one is a pilot planning around a map that is missing most of it.
const truncationNote = (shown, total, what) => (total > shown
  ? emptyNote(`Showing ${shown} of ${total} ${what}. The rest are inside this radius and not on this list.`)
  : "");

export function tacticalPanel(report, brief, config, regionNameFor, generatedAtText) {
  const priorities = report && brief.items.length
    ? brief.items.map(item =>
      `<button class="command-priority" data-tactical-system="${esc(item.system.system_id)}" `
      + `data-tactical-region="${esc(regionNameFor(item.system.region_id))}">`
      + `<span class="command-tag">${esc(item.tag)}</span>`
      + `<strong>${esc(item.title)}</strong><small>${esc(item.detail)}</small></button>`).join("")
    : emptyNote("No standard-gate decision is available from this system.");

  const blocks = [];
  if (config.blocks.security) {
    blocks.push(grid([
      cell(report.security.high, "High-sec systems"),
      cell(report.security.low, "Low-sec systems"),
      cell(report.security.null, "Null-sec systems"),
      cell(report.regionNames.length, "Regions exposed"),
    ]));
  }
  if (config.blocks.approaches) blocks.push(section("Approach vectors", approachBlock(report, regionNameFor)));
  if (config.blocks.chokes) blocks.push(section("Chokepoint candidates", chokeBlock(report, regionNameFor)));
  if (config.blocks.borders) blocks.push(section("Regional boundary exposure", borderBlock(report, regionNameFor)));

  const command = `<div class="command-section"><div class="command-heading"><h3>Command priorities</h3>`
    + `<span>${esc(brief.summary)}</span></div>${priorities}`
    + `<p class="command-caveat">${esc(brief.caveat)}</p></div>`;

  const coverage = section("Coverage",
    `<p class="route-regions">${report.regionNames.map(esc).join(" → ")}</p>`
    + `<p class="tactical-time">Generated ${generatedAtText} · OFFLINE SDE</p>`);

  return header(
    `${esc(brief.label)} · static`,
    esc(report.focal.name),
    `${report.depth}-jump radius · ${report.systemCount} systems · ${report.frontierCount} on frontier`,
  ) + command + coverage + blocks.join("");
}

function approachBlock(report, regionNameFor) {
  if (!report.approaches.length) return emptyNote("No standard stargate approach vectors.");
  return report.approaches.map(entry => vector(
    entry.system,
    regionNameFor,
    `${entry.reachableSystems} SYS`,
    `${entry.frontierSystems} on frontier · ${entry.regions.map(esc).join(", ")}`,
  )).join("");
}

function chokeBlock(report, regionNameFor) {
  const chokes = report.chokes.length
    ? report.chokes.map(entry => vector(
      entry.system,
      regionNameFor,
      entry.global ? "NETWORK" : "LOCAL",
      // `paths` rather than `betweenness`, for the reason the system panel gives
      // at length: it is the plain word *and* the accurate one, and this row is
      // read under fire, so the row uses the same word the panel above it does.
      `${entry.jumps} jumps · ${entry.degree} gates · ${compactNumber(entry.betweenness)} paths`,
    )).join("")
    // **True of both sets or not said at all.** This is a statement about the network,
    // so printing it whenever the *local* choke list is empty is wrong: that list holds
    // local articulation points and excludes the frontier by design, so it can be empty
    // while a genuine network cut vertex stands in the radius. Rare - 3 analyses in
    // 3,951 - and the worst possible direction for a sentence to be wrong in, being an
    // all-clear about the one system whose loss cuts the cluster.
    : (report.networkChokes?.length
      ? ""
      : emptyNote("No system in this radius is one the network cannot route around."));

  // **Not "bridge".** To every EVE player that word means an Ansiblex, a structure an
  // alliance anchored; these are ordinary stargate links that happen to be the only
  // connection between two halves of the map. The name crosses to a model and back onto
  // a pilot's screen, so it is the name a pilot would use.
  const bridges = report.soleLinksInRange && report.soleLinksInRange.length
    ? `<h3 class="tactical-subhead">Sole links in range</h3>`
      + report.soleLinksInRange.slice(0, SOLE_LINK_ROWS).map(bridge =>
        `<div class="tactical-vector">`
        + `<button data-tactical-system="${esc(bridge.from.system_id)}" `
        + `data-tactical-region="${esc(regionNameFor(bridge.from.region_id))}">`
        + `${esc(bridge.from.name)} — ${esc(bridge.to.name)}</button>`
        + `<strong>${bridge.jumps} J</strong>`
        + `<small>losing this link severs the network here</small></div>`).join("")
      + truncationNote(SOLE_LINK_ROWS, report.soleLinksInRange.length, "sole links")
    : "";

  // LOCAL and NETWORK are easy to confuse and mean very different things, so
  // the distinction is stated on screen rather than left to the legend.
  const note = "NETWORK: losing this system cuts the cluster in two. "
    + `LOCAL: it only cuts this ${report.depth}-jump area, and the cluster routes around it. `
    + "Both are shapes on the map - neither says anyone is sitting there now.";

  // The analyser truncated this one before the panel saw it, so the true total is
  // not available here - `chokesTruncated` says only that there are more. Saying
  // "at least" is the honest shape: a number this panel does not have cannot be
  // printed, and a capped count presented as a finding is what the rule forbids.
  const capped = report.chokesTruncated
    ? emptyNote(`Showing the top ${report.chokes.length} by routes. There are more chokepoints in `
      + `this radius than that, and the analyser stops counting at the cap.`)
    : "";
  // Network cut vertices that the list above cannot hold: ones that do not also
  // cut this radius, or that sit on its frontier, where a local reading would be an
  // artefact of where the search stopped. They are the same kind of finding and a
  // more serious one, so they are shown rather than left to the brief.
  const alreadyShown = new Set(report.chokes.map(entry => entry.system.system_id));
  const extraNetwork = (report.networkChokes ?? [])
    .filter(entry => !alreadyShown.has(entry.system.system_id));
  const network = extraNetwork.length
    ? `<h3 class="tactical-subhead">Network chokepoints in range</h3>`
      + extraNetwork.map(entry => vector(
        entry.system,
        regionNameFor,
        "NETWORK",
        `${entry.jumps} jumps \u00b7 ${entry.degree} gates \u00b7 ${compactNumber(entry.betweenness)} paths`,
      )).join("")
      // **Two numbers, and neither is the other.** The rows here are the network
      // cut vertices *not already listed above*, so the rendered count is smaller
      // than the capped set whenever the two overlap - and the first version of
      // this note printed the cap as though it were the rows, wrong in all 27 of
      // the 3,951 analyses that reach it. Found by measuring the note against the
      // markup, which is the check this whole pass exists to install.
      + (report.networkChokesTruncated
        ? emptyNote(`Showing ${extraNetwork.length}. The network list is capped at `
          + `${report.networkChokes.length} by routes, so there are more in this radius than are listed.`)
        : "")
    : "";

  return chokes + capped + network + bridges + emptyNote(note);
}

function borderBlock(report, regionNameFor) {
  if (!report.borderSystems.length) return emptyNote("No regional boundary systems inside this radius.");
  return report.borderSystems.slice(0, BORDER_ROWS)
    .map(system => systemButton(system, regionNameFor)).join("")
    + truncationNote(BORDER_ROWS, report.borderSystems.length, "regional boundary systems");
}
