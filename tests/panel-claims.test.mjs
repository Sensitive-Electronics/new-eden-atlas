// The claims the panels make, checked against the code that produces the
// figures beside them.
//
// Every assertion in this file exists because a panel stated something the
// module underneath it does not do. None of them was catchable by reading
// either side alone: the prose was fluent, the arithmetic was right, and the
// sentence describing the arithmetic ran the other way. A jargon sweep will not
// find these - the words are plain English and the statement is false.
//
// So each one is written as a measurement first and a string check second. The
// measurement is what makes the check mean anything: asserting that a panel
// avoids a phrase only says the phrase is gone, while asserting the behaviour
// the phrase got wrong says it cannot come back under different wording.

import { readArchive, readShips, suite } from "./helpers.mjs";
import { JumpPlanner } from "../web/jump-planner.js";
import { RoutePlanner } from "../web/route-planner.js";
import { threatClasses, threatEnvelope, threatsTo } from "../web/threat-range.js";
import {
  BORDER_ROWS, SOLE_LINK_ROWS,
  campaignPanel, heatPanel, jumpPanel, rangePanel, routeHeatPanel, routePanel, tacticalPanel, threatPanel,
} from "../web/panels.js";
import { TacticalAnalyzer, buildOperationalBrief } from "../web/tactical-analyzer.js";
import { formatSecurity, securityColor } from "../web/map-utils.js";
import { legendMarkup } from "../web/controls.js";

const text = markup => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

export default function run() {
  const t = suite("panel claims");
  const atlas = readArchive();
  const shipData = readShips();
  const planner = new JumpPlanner(atlas, shipData);
  const routePlanner = new RoutePlanner(atlas);
  const id = name => planner.resolveSystem(name).system_id;

  // --- the hull multiplier runs downwards ------------------------------------
  //
  // `fatigueDistance` multiplies the light years jumped by the hull's
  // `fatigue_multiplier`, and on every hull that has one the number is below 1
  // - a jump freighter's is 0.1. The panel rendered "This hull tires 0.1x
  // faster than normal" two sections above a cell already labelled "Hull
  // reduction", so one panel described the same number in both directions.
  const reduced = shipData.ships.filter(ship => ship.fatigue_multiplier !== null
    && ship.fatigue_multiplier !== undefined);
  t.check(reduced.length > 0, `${reduced.length} hulls carry a fatigue multiplier`);
  t.check(reduced.every(ship => Number(ship.fatigue_multiplier) < 1),
    "and every one of them is a reduction, not an increase");

  const sample = reduced[0];
  t.check(planner.fatigueDistance(sample, 4) < 4,
    `${sample.name} accrues less fatigue than the distance jumped, not more`);

  const plan = planner.plan("Amamake", "1DQ1-A", { shipValue: "Ark" });
  const panel = text(jumpPanel(plan, () => "somewhere"));
  t.check(!/faster than normal/.test(panel),
    "so the panel does not call the reduction an increase");
  t.check(/of the distance jumped towards fatigue/.test(panel),
    "it says what the multiplier is applied to instead, which reads correctly either side of 1");

  // --- slower is usually fresher, never always -------------------------------
  //
  // "Fly it slower and you arrive fresher" is false wherever the 300 minute cap
  // bites. Waiting longer early lowers the fatigue carried into the next jump,
  // that jump's cooldown is computed from the lower figure and comes out
  // shorter, and the shorter cooldown is then all the pilot is made to wait -
  // so less fatigue decays before the last jump and they land on a longer
  // timer than the pilot who flew it flat out.
  const chain = [4.5, 4.5, 4.5, 4.5];
  const flatOut = planner.fatigueOver(chain, 0);
  const patient = planner.fatigueOver(chain, 0, 10);
  t.check(patient.travelWaitMinutes > flatOut.travelWaitMinutes,
    `a ten-minute floor under every wait is a slower chain (${patient.travelWaitMinutes} against ${flatOut.travelWaitMinutes} minutes)`);
  t.check(patient.finalCooldownMinutes > flatOut.finalCooldownMinutes,
    `and it ends on a longer timer, not a shorter one (${patient.finalCooldownMinutes.toFixed(2)} against ${flatOut.finalCooldownMinutes.toFixed(2)})`);
  t.check(flatOut.cappedOut && patient.cappedOut,
    "because both reach the fatigue cap, which throws the earlier saving away");

  // Below the cap the advice does hold, which is why the panel still gives it
  // and why it is qualified rather than deleted.
  const short = [1, 1, 1];
  t.check(planner.fatigueOver(short, 0, 30).finalCooldownMinutes
      < planner.fatigueOver(short, 0).finalCooldownMinutes,
    "a chain that stays under the cap does reward waiting");

  const fatiguePanel = text(jumpPanel(planner.plan("Amamake", "1DQ1-A", { shipValue: "Avatar" }), () => "somewhere"));
  t.check(!/arrive fresher/.test(fatiguePanel),
    "so the panel makes no unconditional promise that a slower chain arrives fresher");
  t.check(/usually, not always/i.test(fatiguePanel),
    "it says the advice is usual rather than certain");

  // --- the threat envelope is one jump, and said it was an upper bound -------
  //
  // "The real reach is this or smaller - never larger" was the only assumption
  // on that panel pointing the wrong way, and it read as safe because every
  // other one is pessimistic. A capital chains jumps: a titan staged in Tama
  // covers 52 systems in one and 155 in two.
  const classes = threatClasses(shipData);
  const titan = classes.find(entry => entry.group === "Titan");
  const [envelope] = threatEnvelope(planner, [id("Tama")], [titan]);
  const twoJumps = new Set(envelope.systemIds);
  for (const from of envelope.systemIds) {
    for (const entry of planner.rangeSet(from, titan.rangeLy).entries) twoJumps.add(entry.system.system_id);
  }
  t.check(twoJumps.size > envelope.systemIds.size * 2,
    `a second jump reaches far beyond the envelope (${envelope.systemIds.size} systems become ${twoJumps.size})`);

  const reach = text(threatPanel(threatsTo(threatEnvelope(planner, [id("Amamake")], classes), id("Siseide"))));
  t.check(!/never larger/.test(reach),
    "so the panel no longer claims the real reach can only be smaller");
  t.check(/one jump/.test(reach), "it says which question it answered");
  t.check(/second jump reaches further/.test(reach), "and that the next one reaches further");
  t.check(/cyno jammers/.test(reach), "while keeping the caveat that does point the pessimistic way");

  // --- an all-clear about a route the pilot's own system is on ----------------
  //
  // `hotCrossed` starts at index 1, which is right for *weighting* - there is
  // nothing to route around in the system you are already in - and is not what
  // "no system on this route" says. With 42 kills in Jita on a Jita-to-Perimeter route,
  // an unqualified sentence renders a flat all-clear while the Route sequence two
  // sections below renders Jita as step 00.
  {
    const kills = new Map();
    const jita = routePlanner.resolveSystem("Jita").system_id;
    kills.set(jita, 42);
    const hot = routePlanner.calculate("Jita", "Perimeter", "shortest", undefined, undefined,
      undefined, undefined, { kills, weight: 3, at: 1_000_000, applied: true });
    t.equal(hot.systems[0].name, "Jita", "the origin is step 00 of the route");
    t.equal(hot.hotCrossed.length, 0, "and is excluded from hotCrossed, as the weighting wants");
    t.equal(hot.originKills, 42, "so the planner carries its count separately");

    const said = text(routeHeatPanel(hot));
    t.check(!/No system on this route had a player kill/.test(said),
      "the panel does not give a flat all-clear about a route the pilot's system is on");
    t.check(/ahead of you/.test(said), "it says which systems it is about");
    t.check(/You are in Jita/.test(said) && /42/.test(said),
      `and names the one it excluded, with its count (${said.slice(0, 120)})`);
  }

  // --- readings are syncs, not hours -----------------------------------------
  //
  // `heat.trend` is one entry per sync that measured kills, capped at 24, and
  // `activity.js` says "an hour with no kill measurement in it is not an hour".
  // So three syncs a day apart rendered "1 of the last 3 hours", which reads as
  // "quiet for a day" when the truth is "three readings and no idea about the
  // gaps". `snapshot.js` carries `spanMs` to the *model* for exactly this
  // reason; the pilot was told nothing.
  {
    const day = 86_400_000;
    const trend = [
      { at: 1_000_000, playerKills: 6 },
      { at: 1_000_000 + day, playerKills: 0 },
      { at: 1_000_000 + 2 * day, playerKills: 0 },
    ];
    const said = text(heatPanel({ trend, at: 1_000_000 + 2 * day, text: "no player kills", playerKills: 0, shipKills: 0, podKills: 0 }));
    t.check(!/hours had a kill/.test(said), "the panel does not call its samples hours");
    t.check(/readings/.test(said), "it calls them readings");
    t.check(/reaching back 2 days/.test(said),
      `and says how far back they actually reach (${said.slice(0, 140)})`);
    t.check(/nothing is known about the gaps/.test(said),
      "and that the gaps between them are unknown");
    t.check(!/undefined/.test(said), "and nothing on it renders the word \"undefined\"");
    t.equal(heatPanel({ trend, at: 1_000_000 }), "",
      "a reading with no text to show is absent rather than a row saying undefined");

    // Both branches of the span, because a fixture that only reaches one leaves
    // the other free to say nothing. Six hours apart is the ordinary case - a
    // pilot syncing through an evening - and it is the one that reads most like
    // "hours" if the wording is wrong.
    const hour = 3_600_000;
    const evening = text(heatPanel({
      trend: [
        { at: 1_000_000, playerKills: 2 },
        { at: 1_000_000 + 3 * hour, playerKills: 0 },
        { at: 1_000_000 + 6 * hour, playerKills: 0 },
      ],
      at: 1_000_000 + 6 * hour, text: "no player kills", playerKills: 0, shipKills: 0, podKills: 0,
    }));
    t.check(/reaching back 6 hours/.test(evening),
      `a span inside two days is said in hours (${evening.slice(0, 130)})`);
  }

  // --- the jump range grid has to add up ---------------------------------------
  //
  // `byClass.high` was computed in `rangePanel` and rendered nowhere. With "Show
  // high-sec in range" on, Jita/Ark reported 448 systems in reach over cells
  // totalling 153: 295 systems counted and named in no cell, and twelve of twelve
  // at the head of "Nearest systems". Measured here rather than asserted from the
  // markup alone, because the markup was fluent and the arithmetic was the lie.
  {
    const secClass = value => (value >= 0.45 ? "high" : value > 0 ? "low" : "null");
    const origin = planner.resolveSystem("Jita");
    const ship = planner.resolveShip("Ark");
    const ly = planner.rangeFor(ship, 5) * planner.rangeMultiplierFor(ship, 5);

    for (const allowHighSec of [false, true]) {
      const set = planner.rangeSet(origin.system_id, ly, { allowHighSec });
      const range = { ...set, origin, ship };
      const by = { high: 0, low: 0, null: 0 };
      for (const entry of range.entries) by[secClass(entry.system.security)] += 1;

      const markup = rangePanel(range, regionId => atlas.regions[regionId].name, secClass);
      // Every cell's figure, paired with its label, straight out of the markup.
      const cells = [...markup.matchAll(/<strong>([^<]*)<\/strong><span>([^<]*)<\/span>/g)]
        .map(([, value, label]) => [label, Number(value.replace(/,/g, ""))]);
      const labelled = new Map(cells);

      t.equal(labelled.get("Systems in reach"), range.systemIds.size,
        `allowHighSec=${allowHighSec}: the headline counts what the map highlights`);

      // The security cells have to account for every system in the set - asserted over
      // the numbers, so it holds under any wording of the labels.
      const accounted = ["High-sec, no cyno", "Low-sec", "Null-sec"]
        .reduce((total, label) => total + (labelled.get(label) ?? 0), 0);
      t.equal(accounted, range.systemIds.size,
        `allowHighSec=${allowHighSec}: the security cells account for all `
        + `${range.systemIds.size} of them (${accounted})`);

      // Two columns, so an odd cell count leaves a bordered gap.
      t.equal(cells.length % 2, 0, `allowHighSec=${allowHighSec}: the grid stays even (${cells.length} cells)`);

      if (allowHighSec) {
        t.check(by.high > 0, `and there are high-sec systems in the set to account for (${by.high})`);
        t.equal(labelled.get("High-sec, no cyno"), by.high, "counted in their own cell");
        t.check(/cynosural field cannot be lit/.test(markup),
          "with the reason a capital cannot arrive in one of them");
      } else {
        t.equal(by.high, 0, "with the toggle off the set holds no high-sec system at all");
        t.check(!/High-sec/.test(markup), "so no high-sec cell is drawn to raise a question with no answer");
      }
    }
  }

  // --- "high security only" is not a preference --------------------------------
  //
  // The label read "High security only where possible", which promises a dip when
  // there is no other way. It is a hard exclusion: it refuses to route instead.
  // Measured across real routes, `belowHighSecurity` is never non-empty under it -
  // and the routes that would need a dip come back unroutable, which is the
  // behaviour the old wording denied.
  {
    const highSec = Object.values(atlas.systems)
      .filter(system => system.security >= 0.45).map(system => system.name).sort();
    let routed = 0;
    let dipped = 0;
    let refused = 0;
    for (let i = 0; i < highSec.length && routed + refused < 120; i += 41) {
      const to = highSec[(i * 7 + 3) % highSec.length];
      if (to === highSec[i]) continue;
      let out = null;
      try { out = routePlanner.calculate(highSec[i], to, "high-sec-only"); } catch { refused += 1; continue; }
      if (!out?.systems?.length) { refused += 1; continue; }
      routed += 1;
      if ((out.belowHighSecurity?.length ?? 0) > 0) dipped += 1;
    }
    t.check(routed > 20, `${routed} high-security-only routes were planned`);
    t.equal(dipped, 0, "and not one of them dipped below high security");
    t.check(refused > 0, `while ${refused} could not be routed at all, which is what the mode does instead`);

    const label = text(routePanel(routePlanner.calculate("Jita", "Amarr", "high-sec-only"),
      regionId => atlas.regions[regionId].name));
    t.check(!/where possible/.test(label),
      `so the panel does not offer a fallback that cannot happen (${label.slice(0, 80)})`);
    t.check(/High security only/.test(label), "and still names the mode");
  }

  // --- a timer nobody looked for, and no timer here ----------------------------
  //
  // `campaignPanel` returned "" for both, in the panel whose caller says the
  // difference "is the whole point" for a timer. A pilot cannot act on a blank
  // space, and the two blanks meant opposite things.
  {
    t.equal(campaignPanel(null), "", "nothing synced draws no timer section");
    const quiet = text(campaignPanel([]));
    t.check(quiet !== "", "a synced system with no timer still draws one");
    t.check(/No sovereignty timer/.test(quiet), `and says there is none (${quiet.slice(0, 70)})`);
    t.check(campaignPanel([]) !== campaignPanel(null),
      "so the two states cannot be confused for each other");
  }

  // --- two reasons kills are not weighed ---------------------------------------
  //
  // `killsKnown()` is false in two states and the panel reported both as "no
  // activity data has been synced". When activity synced and only the kills half
  // answered 503, that sentence contradicts the live bar sitting above it - and
  // `app.js` spells out that distinction as the reason the function exists.
  {
    const weighed = { weight: 2, applied: false, at: null };
    const never = text(routeHeatPanel({ heat: { ...weighed, unweighed: "never-synced" }, systems: [] }));
    const half = text(routeHeatPanel({ heat: { ...weighed, unweighed: "kills-absent" }, systems: [] }));

    t.check(/no activity data has been synced/.test(never),
      `never synced says so (${never.slice(0, 70)})`);
    t.check(!/no activity data has been synced/.test(half),
      `a half-failed sync does not claim nothing was synced (${half.slice(0, 90)})`);
    t.check(/kills half did not answer/.test(half), "it says which half failed");
    t.check(never !== half, "so the two states read differently");
    t.check(/nothing here says a system is quiet/.test(half),
      "and neither of them reads as an all-clear");
  }

  // --- the region key has a swatch for every colour drawn ----------------------
  //
  // `securityColor` draws four and the key carried three. The missing shade,
  // `#6aaee8`, is on 759 systems - the bulk of ordinary high security - under a
  // key whose "High-sec" swatch was the brighter 0.8+ colour only.
  //
  // Measured over the whole archive rather than over the function: the claim is
  // about what a pilot sees on a map of New Eden, so the population is New Eden.
  {
    const drawn = new Map();
    for (const system of Object.values(atlas.systems)) {
      const colour = securityColor(system.security);
      if (!drawn.has(colour)) drawn.set(colour, { count: 0, shown: new Set() });
      const entry = drawn.get(colour);
      entry.count += 1;
      entry.shown.add(formatSecurity(system.security));
    }
    const key = legendMarkup("region");
    t.check(drawn.size >= 4, `the region map draws ${drawn.size} security colours`);
    for (const [colour, entry] of drawn) {
      t.check(key.includes(colour),
        `${colour} is drawn on ${entry.count} systems and is in the key`);
    }

    // The two high-security shades are labelled by the decimal EVE shows, which is
    // only honest if rounding cannot put one value in both bands. Checked over
    // every system, because that is the guarantee the label depends on.
    const bright = drawn.get("#62d8c8")?.shown ?? new Set();
    const plain = drawn.get("#6aaee8")?.shown ?? new Set();
    const shared = [...bright].filter(value => plain.has(value));
    t.equal(shared.length, 0,
      `the two high-sec shades share no displayed value (${shared.join(" ") || "none"})`);
    t.check([...plain].every(value => /^0\.[567]$/.test(value)),
      `the 0.5-0.7 swatch covers exactly that (${[...plain].sort().join(" ")})`);
    t.check([...bright].every(value => /^(0\.[89]|1\.0)$/.test(value)),
      `and the 0.8+ swatch exactly that (${[...bright].sort().join(" ")})`);

    // **Each swatch's label against the band that swatch is actually drawn on.**
    // Derived from the archive, not from a list of expected words: the numbers in
    // a label have to bracket the displayed security values that colour appears
    // on, so a label moved to the wrong colour fails even though both labels
    // still exist and both colours are still in the key.
    const swatches = [...key.matchAll(/background:(#[0-9a-f]{6})"><\/i>([^<]*)</g)]
      .map(([, colour, label]) => [colour, label]);
    t.check(swatches.length >= 4, `the key pairs ${swatches.length} colours with labels`);
    for (const [colour, label] of swatches) {
      const entry = drawn.get(colour);
      if (!entry) continue;                          // an overlay colour, not a security band
      const numbers = [...label.matchAll(/\d\.\d/g)].map(([value]) => value);
      if (!numbers.length) continue;                 // "Low-sec" and "Null-sec" name no figure
      const shown = [...entry.shown].sort();
      t.equal(numbers[0], shown[0],
        `${colour} is labelled "${label}" and the lowest value it is drawn on is ${shown[0]}`);
      if (numbers.length > 1) {
        t.equal(numbers[numbers.length - 1], shown[shown.length - 1],
          `and the highest is ${shown[shown.length - 1]}`);
      } else {
        t.check(/\+/.test(label),
          `${colour}'s label names one figure, so it has to be open-ended ("${label}")`);
      }
    }
  }

  // --- a capped list must say it is capped --------------------------------------
  //
  // `tactical-analyzer.js` states the rule about its own choke cap: "anything that
  // counts this set has to say so". `snapshot.js` obeys it. The panel truncated
  // three lists without a word - sole links at 12, boundary systems at 24, and the
  // choke list the analyser had already capped at 20 while publishing
  // `chokesTruncated` that nothing read. Amarr at depth 10: 77 sole links and 104
  // boundary systems, twelve and twenty-four drawn.
  {
    const analyzer = new TacticalAnalyzer(atlas);
    const report = analyzer.analyze("Amarr", 10);
    const config = { blocks: { security: true, approaches: true, chokes: true, borders: true } };
    const brief = buildOperationalBrief(report, "hunt");
    const markup = tacticalPanel(report, brief, config,
      regionId => atlas.regions[regionId].name, "just now");
    const flat = text(markup);

    t.check(report.soleLinksInRange.length > SOLE_LINK_ROWS,
      `${report.soleLinksInRange.length} sole links, past the ${SOLE_LINK_ROWS} rows`);
    // Counted from the markup. Every sole-link row carries this phrase and nothing
    // else does, so it is an exact count of what was drawn.
    const drawnLinks = (markup.match(/losing this link severs the network here/g) ?? []).length;
    const linkNote = /Showing (\d+) of (\d+) sole links/.exec(flat);
    t.check(linkNote !== null, "the panel says the sole-link list is partial");
    t.equal(Number(linkNote[1]), drawnLinks,
      `and the figure it gives is the number of rows actually drawn (${drawnLinks})`);
    t.equal(Number(linkNote[2]), report.soleLinksInRange.length,
      "against the true total from the report");
    t.equal(drawnLinks, SOLE_LINK_ROWS, "which is the row limit this panel declares");
    t.check(report.borderSystems.length > BORDER_ROWS,
      `${report.borderSystems.length} boundary systems, past the ${BORDER_ROWS} rows`);
    // The same, for the boundary list. Its rows are the only ones naming a
    // boundary system, so they can be counted by name out of the markup rather
    // than trusted to the constant.
    const borderNote = /Showing (\d+) of (\d+) regional boundary systems/.exec(flat);
    t.check(borderNote !== null, "the panel says the boundary list is partial");
    const drawnBorders = report.borderSystems
      .filter(system => markup.includes(`data-tactical-system="${system.system_id}"`)).length;
    t.equal(Number(borderNote[1]), BORDER_ROWS, "with the row limit it declares");
    t.check(drawnBorders >= Number(borderNote[1]),
      `and at least that many boundary systems are on screen (${drawnBorders})`);
    t.equal(Number(borderNote[2]), report.borderSystems.length,
      "against the true total from the report");
    t.check(report.chokesTruncated, "the choke list is capped by the analyser");
    t.check(/Showing the top \d+ by routes/.test(flat),
      `which the panel now reads (${flat.slice(flat.indexOf("Showing the top"), flat.indexOf("Showing the top") + 70)})`);
    // The cap is not reported as a total, because this panel does not know the
    // total - the analyser truncated before it was handed over.
    t.check(!new RegExp(`of ${report.chokes.length} chokepoints`).test(flat),
      "and does not print a number it was never given");

    // A radius under every cap says nothing about caps.
    const small = analyzer.analyze("Tama", 2);
    const quiet = text(tacticalPanel(small, buildOperationalBrief(small, "hunt"), config,
      regionId => atlas.regions[regionId].name, "just now"));
    t.check(small.soleLinksInRange.length <= SOLE_LINK_ROWS && !small.chokesTruncated,
      "a small radius fits inside every cap");
    t.check(!/Showing/.test(quiet), "so nothing there claims to be showing part of a list");
  }

  // --- a brief counts the rows it carries ---------------------------------------
  //
  // The recon brief said "8 inbound gates assigned for first-pass coverage" over
  // five SCOUT items: three gates nobody is watching, stated as covered. The escape
  // brief had the same defect over three of six exit vectors, which the finding did
  // not name - the count and the slice were written three lines apart in both.
  {
    const analyzer = new TacticalAnalyzer(atlas);
    const report = analyzer.analyze("Jita", 8);
    for (const [mode, noun] of [["recon", "inbound gate"], ["escape", "exit vector"]]) {
      const brief = buildOperationalBrief(report, mode);
      const total = report.approaches.length;
      t.check(total > brief.items.length,
        `${mode}: ${total} ${noun}s, ${brief.items.length} rows`);
      t.check(brief.summary.startsWith(`${brief.items.length} of ${total}`),
        `${mode}: the summary counts the rows against the total (${brief.summary})`);
      t.check(!new RegExp(`^${total} ${noun}`).test(brief.summary),
        `${mode}: and does not open with the figure it is not carrying`);
    }
    const recon = buildOperationalBrief(report, "recon");
    t.check(/left uncovered/.test(recon.summary),
      `recon names the gates with no scout on them (${recon.summary})`);

    // Under the cap the summary is the plain sentence again, or every small brief
    // would read as though something had been left out.
    const small = analyzer.analyze("Tama", 2);
    for (const mode of ["recon", "escape"]) {
      const brief = buildOperationalBrief(small, mode);
      if (small.approaches.length > brief.items.length) continue;
      t.check(!/ of /.test(brief.summary),
        `${mode} under the cap states one figure (${brief.summary})`);
      t.check(!/uncovered/.test(brief.summary), `${mode} under the cap leaves nothing uncovered`);
    }
  }

  // --- the network chokepoint that was in no list ------------------------------
  //
  // Two claims failed for one reason. `report.chokes` is built from *local*
  // articulation points and excludes the frontier - correctly, because local
  // articulation at the edge of a search is an artefact of where the search
  // stopped. A system that cuts New Eden in two without also cutting this radius,
  // or that sits on its frontier, is not an artefact; it comes from the
  // precomputed metrics over the whole graph, and it was in no list at all.
  //
  // So "No system in this radius is one the network cannot route around" was an
  // all-clear printed with a real cut vertex standing in the radius, and the hunt
  // brief sorted `global` first over a pool that could not contain one.
  //
  // Swept over the map rather than asserted on a fixture, because the rates are
  // the finding: 3 false all-clears and 278 local PRIMARY slots in 3,951 analyses.
  {
    const analyzer = new TacticalAnalyzer(atlas);
    const config = { blocks: { security: true, approaches: true, chokes: true, borders: true } };
    const regionName = regionId => atlas.regions[regionId].name;
    const gated = Object.values(atlas.systems).filter(system => system.neighbors.length > 0);

    let analyses = 0;
    let falseAllClear = 0;
    let localPrimary = 0;
    let unrankedClaim = 0;
    let unflaggedLoss = 0;
    let sawNetworkOnly = 0;

    // Every 97th gated system at three depths: a few hundred analyses, enough to
    // reach the shapes above, and it keeps the suite's runtime honest.
    for (let i = 0; i < gated.length; i += 97) {
      for (const depth of [3, 4, 5]) {
        const report = analyzer.analyze(gated[i].name, depth);
        analyses += 1;
        const brief = buildOperationalBrief(report, "hunt");
        const flat = text(tacticalPanel(report, brief, config, regionName, "now"));

        const cutVertices = report.systems.filter(system =>
          system.metrics?.articulation && system.system_id !== report.focal.system_id);
        const listed = new Set([...report.chokes, ...report.networkChokes]
          .map(entry => entry.system.system_id));
        const missing = cutVertices.filter(system => !listed.has(system.system_id));

        // 1. The all-clear has to be true.
        if (/network cannot route around/.test(flat) && cutVertices.length) falseAllClear += 1;

        // 2. A LOCAL choke cannot head a list sorted by network control while a
        //    NETWORK one stands in the same radius.
        const primary = brief.items[0];
        if (primary && /^Local chokepoint/.test(primary.detail) && cutVertices.length) localPrimary += 1;

        // 3. The unsorted fallback must not claim a ranking.
        if (!report.chokes.length && !report.networkChokes.length
          && /ranked by network control/.test(brief.summary)) unrankedClaim += 1;

        // 4. Anything dropped by a cap has to be declared as dropped. This is the
        //    only acceptable way for a cut vertex to be absent.
        if (missing.length && !report.networkChokesTruncated) unflaggedLoss += 1;

        // That the fix reaches something at all: a cut vertex the local list does
        //    not hold, which is the whole case.
        if (report.networkChokes.some(entry =>
          !report.chokes.some(other => other.system.system_id === entry.system.system_id))) {
          sawNetworkOnly += 1;
        }
      }
    }

    t.check(analyses > 100, `${analyses} analyses swept across the map`);
    t.check(sawNetworkOnly > 0,
      `${sawNetworkOnly} of them hold a network cut vertex the local choke list does not (the case itself)`);
    t.equal(falseAllClear, 0,
      "no analysis says the network can route around everything while a cut vertex stands in the radius");
    t.equal(localPrimary, 0,
      "and none puts a LOCAL choke first while a NETWORK one is in the same radius");
    t.equal(unrankedClaim, 0,
      "and nothing claims a ranking over the unsorted fallback");
    t.equal(unflaggedLoss, 0,
      "and a cut vertex is only ever absent when the report says the list was capped");

    // **The three analyses this was measured on, by name.** The sweep above cannot
    // reach them: a false all-clear occurred in 3 analyses out of 3,951, and
    // sampling every 97th system is three orders of magnitude too coarse for that.
    // Mutation proved it - removing the all-clear's guard left the sweep green.
    //
    // Each of these has an empty *local* choke list and a real cut vertex in the radius,
    // which is the shape that matters: keyed on the local list, the panel prints an
    // all-clear and then ranks the focus system's own gates while calling it network
    // control.
    for (const [name, depth] of [["S-BWWQ", 3], ["Nidebora", 3], ["V4-L0X", 3]]) {
      const report = analyzer.analyze(name, depth);
      const brief = buildOperationalBrief(report, "hunt");
      const flat = text(tacticalPanel(report, brief, config, regionName, "now"));
      const cutVertices = report.systems.filter(system =>
        system.metrics?.articulation && system.system_id !== report.focal.system_id);

      t.equal(report.chokes.length, 0, `${name} at depth ${depth} has no local chokepoint`);
      t.check(cutVertices.length > 0,
        `but ${cutVertices.length} system(s) there cut the network, which is why the all-clear was false`);
      t.check(!/network cannot route around/.test(flat),
        `so the panel does not print the all-clear for ${name}`);
      t.check(/Network chokepoints in range/.test(flat),
        "and lists them under their own heading instead");
      t.check(/^Network chokepoint/.test(brief.items[0]?.detail ?? ""),
        `with the brief's first position being one of them (${brief.items[0]?.detail?.slice(0, 40)})`);
    }

    // And a radius with no chokepoint of either kind, where the brief really does
    // fall back to the focus system's own gates. That list is never sorted, so the
    // summary must not call it a ranking - 3 analyses in 3,951 did.
    {
      const report = analyzer.analyze("Tanoo", 1);
      const brief = buildOperationalBrief(report, "hunt");
      t.equal(report.chokes.length, 0, "Tanoo at depth 1 has no local chokepoint");
      t.equal(report.networkChokes.length, 0, "and no network chokepoint either");
      t.check(brief.items.length > 0, `yet the brief still offers ${brief.items.length} positions`);
      t.check(!/ranked by network control/.test(brief.summary),
        `which it does not call a ranking (${brief.summary})`);
      t.check(/no chokepoint in this radius to rank/.test(brief.summary),
        "and says why there is nothing to rank");
      t.check(brief.items.every(item => /^Direct gate from focus/.test(item.detail)),
        "every row being a direct gate rather than a chokepoint");
    }
  }

  // --- and the network block counts the rows it drew ---------------------------
  //
  // The rows are the cut vertices *not already listed above*, so the rendered count
  // is smaller than the capped set wherever the two overlap. The first version of
  // this note printed the cap as though it were the rows - wrong in all 27 analyses
  // that reach it, and a false figure introduced by the fix for false figures.
  {
    const analyzer = new TacticalAnalyzer(atlas);
    const config = { blocks: { security: true, approaches: true, chokes: true, borders: true } };
    const regionName = regionId => atlas.regions[regionId].name;
    const gated = Object.values(atlas.systems).filter(system => system.neighbors.length > 0);
    let checked = 0;

    for (let i = 0; i < gated.length && checked < 6; i += 13) {
      for (const depth of [4, 5]) {
        const report = analyzer.analyze(gated[i].name, depth);
        if (!report.networkChokesTruncated) continue;
        const shownAbove = new Set(report.chokes.map(entry => entry.system.system_id));
        const rendered = report.networkChokes
          .filter(entry => !shownAbove.has(entry.system.system_id)).length;
        if (!rendered) continue;
        const flat = text(tacticalPanel(report, buildOperationalBrief(report, "hunt"),
          config, regionName, "now"));
        const note = /Showing (\d+)\. The network list is capped at (\d+) by routes/.exec(flat);
        t.check(note !== null, `${gated[i].name} d${depth}: the capped network list says so`);
        if (note) {
          t.equal(Number(note[1]), rendered, "and the first figure is the rows it drew");
          t.equal(Number(note[2]), report.networkChokes.length, "the second is the cap on the set");
          t.check(Number(note[1]) <= Number(note[2]), "which is never the smaller of the two");
        }
        checked += 1;
        break;
      }
    }
    t.check(checked > 0, `${checked} capped network lists were checked against their own note`);
  }

  return t.results;
}
