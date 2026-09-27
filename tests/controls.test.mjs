// The chrome around the map.
//
// Most of this is markup, but searchMatches is not: it is the matching itself,
// and it spent its life inside a 446-character line in an input handler where
// its ordering and its caps could not be examined. It decides what someone
// typing a name is offered, which makes it worth asserting.

import { readArchive, suite } from "./helpers.mjs";
import {
  SEARCH_LIMITS, constellationButtons, corridorRows, corridorSummaryMarkup, fuelModuleOptions,
  legendMarkup, limitsSummaryMarkup, searchMatches, searchResultsMarkup, shipOptions,
} from "../web/controls.js";

export default function run() {
  const t = suite("controls");
  const atlas = readArchive();
  const regions = Object.values(atlas.regions)
    .map(r => ({ name: r.name, region_id: r.region_id, system_count: r.system_count }));
  const systems = Object.values(atlas.systems);
  const context = {
    regions,
    systems,
    regionNameFor: id => atlas.regions[id].name,
    securityOf: system => system.security,
  };

  // --- search ---------------------------------------------------------------
  t.equal(searchMatches("", context).length, 0, "an empty query matches nothing");
  t.equal(searchMatches("   ", context).length, 0, "and neither does whitespace");
  t.equal(searchMatches(null, context).length, 0, "nor a missing query, rather than throwing");

  const jita = searchMatches("jita", context);
  t.check(jita.some(m => m.type === "system" && m.name === "Jita"), "a system is found by name");
  t.check(searchMatches("JITA", context).length === jita.length, "matching ignores case");
  t.check(searchMatches(" jita ", context).length === jita.length, "and surrounding space");

  // Regions come first. Someone typing a region name usually wants the region,
  // and the systems inside it are the finer answer.
  //
  // Built rather than drawn from the archive: no real region name is also a
  // substring of a system name, so a live query never puts both kinds in the
  // list and could not tell the ordering apart. The first version of this test
  // used "delve", which matches one region and no systems, and passed happily
  // with the order reversed.
  const mixed = searchMatches("zeta", {
    regions: [{ name: "Zeta", region_id: 1, system_count: 7 }],
    systems: [
      { name: "Zeta Prime", system_id: 11, region_id: 1, security: 0.4 },
      { name: "Zeta Minor", system_id: 12, region_id: 1, security: -0.2 },
    ],
    regionNameFor: () => "Zeta",
    securityOf: system => system.security,
  });
  t.equal(mixed.length, 3, "a query matching both kinds returns both");
  t.equal(mixed[0].type, "region", "with the region first");
  const firstSystem = mixed.findIndex(m => m.type === "system");
  t.check(mixed.slice(0, firstSystem).every(m => m.type === "region")
    && mixed.slice(firstSystem).every(m => m.type === "system"),
    "and every region ahead of every system, not interleaved");

  // The caps are what keeps a dropdown a dropdown. "a" matches thousands.
  const broad = searchMatches("a", context);
  t.check(broad.length <= SEARCH_LIMITS.total, `a very broad query returns at most ${SEARCH_LIMITS.total}`);
  t.check(broad.filter(m => m.type === "region").length <= SEARCH_LIMITS.regions,
    `with at most ${SEARCH_LIMITS.regions} regions`);
  t.check(broad.length === SEARCH_LIMITS.total, "and a broad query does fill the list, so the cap is exercised");

  // A system result must carry what its click handler needs, or selecting it
  // loads nothing.
  const system = jita.find(m => m.type === "system");
  t.check(Number.isInteger(system.id), "a system result carries its id");
  t.check(typeof system.region === "string" && system.region.length > 0, "and the region to open");
  t.check(/·/.test(system.sub), "and a subtitle naming region and security");

  t.equal(searchMatches("no-such-place-anywhere", context).length, 0, "an unmatched query returns nothing");
  t.check(/No archive match/.test(searchResultsMarkup([])), "which renders as an explicit no-match row");
  t.check(!/<button/.test(searchResultsMarkup([])), "with nothing clickable in it");
  const markup = searchResultsMarkup(jita);
  t.equal((markup.match(/data-i="/g) || []).length, jita.length, "every match renders one button");
  t.check(/data-i="0"/.test(markup), "indexed from zero, matching the array the handler reads");

  // --- legend ---------------------------------------------------------------
  t.check(/High-sec/.test(legendMarkup("region")), "the regional legend names the security classes");
  t.check(/Empire/.test(legendMarkup("universe")), "the universe legend names region types");
  t.check(!/High-sec/.test(legendMarkup("universe")), "and does not claim to show security");

  // A jump plan and a route cannot both be displayed; the legend shows one.
  const both = legendMarkup("region", { jump: true, route: true });
  t.check(/Jump plan/.test(both) && !/>Route</.test(both), "with both set, the jump plan wins and the route is not listed");
  t.check(/>Route</.test(legendMarkup("region", { route: true })), "a route alone is listed");
  t.check(/Jump range/.test(legendMarkup("region", { range: true })), "a displayed range is listed");
  t.check(/Excluded/.test(legendMarkup("region", { excluded: true })), "and so are exclusions");
  t.check(!/Jump range|Excluded|Route/.test(legendMarkup("region")), "with nothing displayed, nothing extra is claimed");

  // --- counters -------------------------------------------------------------
  // A typed limit that does not resolve is not the same as no limits, and
  // showing zero for it would report broken constraints as inactive.
  t.check(!/route-avoid-count/.test(limitsSummaryMarkup(0, null)), "no limits means no badge");
  t.check(/>3</.test(limitsSummaryMarkup(3, 3)), "resolved limits show their count");
  t.check(/>!</.test(limitsSummaryMarkup(2, null)), "an unresolvable limit shows a warning, not a count");
  t.check(/do not resolve/.test(limitsSummaryMarkup(2, null)), "and says so on hover");
  t.check(/>0</.test(limitsSummaryMarkup(2, 0)),
    "a typed limit that resolves to nothing still shows zero, which is a different state again");

  t.check(!/route-avoid-count/.test(corridorSummaryMarkup(0)), "no corridors means no badge");
  t.check(/>4</.test(corridorSummaryMarkup(4)), "and four corridors say four");

  // --- lists ----------------------------------------------------------------
  t.check(/No corridors saved yet/.test(corridorRows([], () => "")), "an empty corridor list says so");
  const rows = corridorRows([{ name: "Home run" }, { name: "Back door" }], c => `detail for ${c.name}`);
  t.equal((rows.match(/corridor-row/g) || []).length, 2, "each corridor is a row");
  t.check(/detail for Home run/.test(rows), "showing the detail the caller computed");
  t.check(/aria-label="Remove Home run"/.test(rows), "with a labelled remove control");

  // Names are player-supplied and go into attributes as well as text.
  const nasty = corridorRows([{ name: '"><img src=x onerror=alert(1)>' }], () => "d");
  t.check(!/<img/.test(nasty), "a corridor name cannot inject markup");
  t.check(/&lt;img/.test(nasty) || /&quot;/.test(nasty), "it is escaped instead");

  const cons = constellationButtons([
    { constellation_id: 2, name: "Zulu", solar_system_ids: [1, 2] },
    { constellation_id: 1, name: "Alpha", solar_system_ids: [3] },
  ]);
  t.check(cons.indexOf("Alpha") < cons.indexOf("Zulu"), "constellations are listed alphabetically");
  t.check(/data-c="all"/.test(cons), "with an all-constellations entry");
  t.check(cons.indexOf('data-c="all"') === 0 || cons.indexOf('data-c="all"') < cons.indexOf("Alpha"),
    "which comes first");
  t.check(/Alpha · 1/.test(cons), "each carries its system count");

  // --- selects --------------------------------------------------------------
  const ships = shipOptions([
    { name: "Ark", group: "Jump Freighter" },
    { name: "Anshar", group: "Jump Freighter" },
    { name: "Archon", group: "Carrier" },
  ]);
  t.equal((ships.match(/<optgroup/g) || []).length, 2, "ships are grouped by hull class");
  t.check(ships.indexOf("Jump Freighter") < ships.indexOf("Carrier"),
    "in the order first seen, so the list does not reshuffle between loads");
  t.equal((ships.match(/<option/g) || []).length, 3, "and every hull appears once");

  const modules = fuelModuleOptions([{ type_id: 7, name: "Economizer", fuel_bonus_percent: -10 }]);
  t.check(/value=""/.test(modules), "the module list offers fitting nothing");
  t.check(/Economizer \(-10%\)/.test(modules), "and names each module with its bonus");

  return t.results;
}
