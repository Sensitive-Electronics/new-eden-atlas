// The chrome around the map: legend, search results, filter buttons, select
// options and the small counters on the planner panels.
//
// Separate from panels.js, which is the inspector. These are controls, and the
// distinction is worth keeping: an inspector panel describes a result, while
// these describe what the interface can currently do.
//
// As with the panels, everything here takes data and returns a string. The one
// exception is `searchMatches`, which is not markup at all: it is the matching
// itself, kept here so its ordering and limits can be examined and tested.

import { escapeHtml as esc, formatSecurity as secFormat } from "./map-utils.js";
import { liveTime } from "./live-time.js";

// --- legend ------------------------------------------------------------------

// **A swatch for every colour drawn.** `securityColor` has two high-security
// shades - `#62d8c8` above `ELEVATED_SECURITY` and `#6aaee8` above `HIGH_SECURITY`
// - and the dimmer one covers the bulk of ordinary high security, so a key holding
// one of them leaves those systems' colour unexplained.
//
// Named by the decimal EVE itself shows, because that is the number on the pilot's
// screen: the raw thresholds are 0.45 and 0.75 and appear nowhere in the client.
// Checked across all 8,490 systems - the two shades share no displayed value,
// `#6aaee8` being exactly 0.5, 0.6 and 0.7 and `#62d8c8` exactly 0.8, 0.9 and 1.0 -
// so the split can be stated in those terms without rounding making a label false.
const REGION_LEGEND = '<span><i style="background:#62d8c8"></i>High-sec 0.8+</span>'
  + '<span><i style="background:#6aaee8"></i>High-sec 0.5-0.7</span>'
  + '<span><i style="background:#e5a45f"></i>Low-sec</span>'
  + '<span><i style="background:#db6a6a"></i>Null-sec</span>'
  + '<span><i style="border:1px solid #d9b95b"></i>Boundary</span>';

const UNIVERSE_LEGEND = '<span><i style="background:#6fe0d2"></i>Empire</span>'
  + '<span><i style="background:#607380"></i>Null</span>'
  + '<span><i style="background:#d9b95b"></i>Special</span>';

// Overlays are appended in a fixed order so the legend does not reshuffle as
// things are switched on and off. A jump plan and a stargate route are mutually
// exclusive by construction, and the legend says only which one is showing.
export function legendMarkup(mode, overlays = {}) {
  let markup = mode === "region" ? REGION_LEGEND : UNIVERSE_LEGEND;
  if (overlays.jump) markup += '<span><i style="background:#9d8cff"></i>Jump plan</span>';
  else if (overlays.route) markup += '<span><i style="background:#ff5fa2"></i>Route</span>';
  if (overlays.range) markup += '<span><i style="border:1px dashed #9d8cff"></i>Jump range</span>';
  if (overlays.excluded) markup += '<span><i style="border:1px dashed #8b97a0"></i>Excluded</span>';
  // Last, so it reads as an addition to whatever else is on the map rather than
  // a replacement for it - which is how the marking behaves too.
  if (overlays.threat) markup += '<span><i style="border:1px solid #e2565f"></i>Hostile reach</span>';
  if (overlays.timers) markup += '<span><i style="background:#ff4d4d"></i>Under attack</span>'
    + '<span><i style="background:#ff9c4d"></i>Timer</span>';
  if (overlays.ambient) markup += '<span><i style="background:#d95fd0"></i>Incursion</span>'
    + '<span><i style="background:repeating-linear-gradient(125deg,transparent 0 2px,#f1ddb2 2px 4px)"></i>Contested</span>';
  return markup;
}

// --- search -------------------------------------------------------------------

export const SEARCH_LIMITS = { regions: 5, systems: 10, total: 12 };

// Regions first, then systems, because a region name is almost always the
// coarser answer and someone typing "Delve" wants the region before its
// systems. The caps are what keeps the dropdown a dropdown.
export function searchMatches(query, { regions = [], systems = [], regionNameFor, securityOf }) {
  const needle = String(query ?? "").trim().toLowerCase();
  if (!needle) return [];
  const matches = name => String(name ?? "").toLowerCase().includes(needle);

  const regionHits = regions
    .filter(region => matches(region.name))
    .slice(0, SEARCH_LIMITS.regions)
    .map(region => ({ type: "region", name: region.name, sub: `${region.system_count} systems` }));

  const systemHits = systems
    .filter(system => matches(system.name))
    .slice(0, SEARCH_LIMITS.systems)
    .map(system => {
      const region = regionNameFor(system.region_id);
      return {
        type: "system",
        name: system.name,
        sub: `${region} · ${secFormat(securityOf(system))}`,
        id: system.system_id,
        region,
      };
    });

  return [...regionHits, ...systemHits].slice(0, SEARCH_LIMITS.total);
}

export function searchResultsMarkup(matches) {
  if (!matches.length) return '<div class="search-result"><span>No archive match</span></div>';
  return matches.map((match, index) =>
    `<button class="search-result" data-i="${esc(index)}">`
    + `<strong>${esc(match.name)}</strong><span>${esc(match.sub)}</span><em>${match.type}</em>`
    + `</button>`).join("");
}

// --- constellation filter -----------------------------------------------------

export function constellationButtons(constellations) {
  const sorted = [...constellations].sort((a, b) => a.name.localeCompare(b.name));
  return '<button class="active" data-c="all">All constellations</button>'
    + sorted.map(entry =>
      `<button data-c="${esc(entry.constellation_id)}">${esc(entry.name)} · ${entry.solar_system_ids.length}</button>`
    ).join("");
}

// --- jump planner selects ------------------------------------------------------

export function shipOptions(ships) {
  const groups = new Map();
  for (const ship of ships) {
    if (!groups.has(ship.group)) groups.set(ship.group, []);
    groups.get(ship.group).push(ship);
  }
  return [...groups].map(([group, members]) =>
    `<optgroup label="${esc(group)}">`
    + members.map(ship => `<option value="${esc(ship.name)}">${esc(ship.name)}</option>`).join("")
    + `</optgroup>`).join("");
}

export function fuelModuleOptions(modules) {
  return `<option value="">No fuel module</option>`
    + modules.map(module =>
      `<option value="${esc(module.type_id)}">${esc(module.name)} (${esc(module.fuel_bonus_percent)}%)</option>`).join("");
}

// --- counters ------------------------------------------------------------------

// `resolved` is null when a limit was typed but does not resolve to anything.
// That is a different state from "no limits", and showing a count of zero for
// it would report the constraints as inactive when they are in fact broken.
export function limitsSummaryMarkup(rawCount, resolved) {
  if (!rawCount) return "<span>Route limits</span>";
  const title = resolved === null ? "One or more limits do not resolve" : "Limits in force";
  const badge = resolved === null ? "!" : resolved;
  return `<span>Route limits</span><span class="route-avoid-count" title="${esc(title)}">${badge}</span>`;
}

export function corridorSummaryMarkup(count) {
  return `<span>Corridors</span>${count ? `<span class="route-avoid-count">${count}</span>` : ""}`;
}

export function corridorRows(corridors, detailOf) {
  if (!corridors.length) return '<p class="corridor-empty">No corridors saved yet.</p>';
  return corridors.map(corridor =>
    `<div class="corridor-row">`
    + `<button class="corridor-open" data-corridor="${esc(corridor.name)}" title="${esc(corridor.name)}">`
    + `<strong>${esc(corridor.name)}</strong><span>${esc(detailOf(corridor))}</span></button>`
    + `<button class="corridor-drop" data-drop="${esc(corridor.name)}" `
    + `title="Remove ${esc(corridor.name)}" aria-label="Remove ${esc(corridor.name)}">✕</button>`
    + `</div>`).join("");
}

// --- bridges and the avoidance list -------------------------------------------

export function bridgeSummaryMarkup(count) {
  return `<span>Ansiblex bridges</span>${count ? `<span class="route-avoid-count">${count}</span>` : ""}`;
}

export function bridgeRows(bridges) {
  if (!bridges.length) {
    return `<p class="corridor-empty">No bridges recorded. Only your own alliance's can be used.</p>`;
  }
  return bridges.map(bridge =>
    `<div class="corridor-row">`
    + `<span class="corridor-open" title="Recorded by ${esc(bridge.source)}">`
    + `<strong>${esc(bridge.fromName)} — ${esc(bridge.toName)}</strong>`
    + `<span>${esc(bridge.source)}</span></span>`
    + `<button class="corridor-drop" data-drop-bridge="${esc(bridge.key)}" `
    + `data-drop-source="${esc(bridge.source ?? "manual")}" type="button" `
    + `title="Mark this bridge gone" aria-label="Mark ${esc(bridge.fromName)} to ${esc(bridge.toName)} gone">✕</button>`
    + `</div>`).join("");
}

// One row per hull class, longest reach first - the order the module returns them
// in, and the order that matters: the longest reach is the one you find out about
// last.
export function threatRows(envelopes) {
  if (!envelopes.length) {
    return '<p class="corridor-empty">No staging systems set. Enter where the hostiles live.</p>';
  }
  return envelopes.map(envelope =>
    `<div class="corridor-row">`
    + `<span class="corridor-open">`
    // Two of these ten groups are haulers and they out-range every hull that can
    // shoot, so they sort below the combat classes and the row says which it is
    // rather than relying on a pilot knowing the group names. The inspector's
    // threat section carries the same label.
    + `<strong>${esc(envelope.group)}</strong>`
    + `<span>${envelope.rangeLy.toFixed(2)} ly \u00b7 ${envelope.systemIds.size.toLocaleString()} systems`
    + `${envelope.combat === false ? " \u00b7 not a combat hull" : ""}`
    + `${envelope.uniform ? "" : " \u00b7 widest hull in group"}</span>`
    + `</span>`
    + `</div>`).join("");
}

// The off state is shown on the closed panel as well as inside it. A list being
// ignored looks exactly like an empty one from the outside, and a pilot who cannot
// see the difference reads a route that ran through a camp as the tool having no
// opinion about it.
export function ignoreSummaryMarkup(count, applied = true) {
  const chip = count ? `<span class="route-avoid-count">${count}</span>` : "";
  return `<span>Avoided${applied ? "" : " \u00b7 off"}</span>${chip}`;
}

// One list for everything being avoided, whatever put it there.
//
// Two kinds of entry share it. A standing order lives in the override store,
// applies to every route and expires on its own. A route entry was typed into
// this route's avoid fields, travels with the corridor when it is saved or
// shared, and lasts exactly as long as the route does. They are genuinely
// different things - a shared corridor must not rewrite the recipient's
// standing orders - but they must be visible in one place, because the failure
// this list exists to prevent is avoiding something in one list and being
// routed through it by the other.
export function ignoreRows(entries, applied = true) {
  if (!entries.length) return '<p class="corridor-empty">Nothing is being avoided.</p>';
  if (!applied) {
    return '<p class="corridor-empty">Avoidance is off. These are kept, and none of them are being applied.</p>'
      + entries.map(entry =>
        `<div class="corridor-row suspended">`
        + `<span class="corridor-open"><strong>${esc(entry.label)}</strong>`
        + `<span>${entry.scope === "route" ? "this route only" : liveTime("remaining", entry.expiresAt, { embedded: true })}</span></span>`
        + `</div>`).join("");
  }
  return entries.map(entry => entry.scope === "route"
    ? `<div class="corridor-row">`
      + `<span class="corridor-open">`
      + `<strong>${esc(entry.label)}</strong>`
      + `<span>routed around · this route only</span></span>`
      + `<button class="corridor-drop" data-unavoid="${esc(entry.kind)}|${esc(entry.label)}" type="button" `
      + `title="Stop avoiding this" aria-label="Stop avoiding ${esc(entry.label)}">✕</button>`
      + `</div>`
    : `<div class="corridor-row">`
      + `<span class="corridor-open">`
      + `<strong>${esc(entry.label)}</strong>`
      + `<span>${esc(entry.strength === "hard" ? "never routed" : "routed around")}`
      + ` · ${liveTime("remaining", entry.expiresAt, { embedded: true })}`
      + `${entry.reason ? ` · ${esc(entry.reason)}` : ""}</span>`
      + `</span>`
      + `<button class="corridor-drop" data-restore="${esc(entry.target)}|${esc(entry.key)}" type="button" `
      + `title="Stop avoiding this" aria-label="Stop avoiding ${esc(entry.label)}">↺</button>`
      + `</div>`).join("");
}

// --- Thera and Turnur -----------------------------------------------------------

export function scoutSummaryMarkup(usable, enabled) {
  if (!enabled) return "<span>Wormholes</span><span class=\"route-avoid-count\">off</span>";
  return `<span>Wormholes</span>${usable ? `<span class="route-avoid-count">${usable}</span>` : ""}`;
}

// Every connection scanned, including the ones this hull cannot use and the
// ones that lead somewhere the router cannot follow.
//
// Listing only the usable ones would answer a different question. A hole into
// J-space is why somebody opens this panel, and a hole two sizes too small is
// the reason a route did not get shorter - both are facts, and hiding them
// leaves the pilot to guess which.
export function scoutRows(signatures, known) {
  if (!known) {
    return '<p class="corridor-empty">Not scanned yet. Sync to ask EVE-Scout what is open.</p>';
  }
  if (!signatures.length) {
    return '<p class="corridor-empty">Nothing open from Thera or Turnur right now.</p>';
  }
  return signatures.map(signature =>
    `<div class="corridor-row${signature.unusable ? " suspended" : ""}">`
    + `<span class="corridor-open">`
    + `<strong>${esc(signature.text)}</strong>`
    + `<span>${signature.unusable ? esc(signature.unusable) : "usable"}`
    + ` \u00b7 ${liveTime("remaining", signature.expiresAt, { embedded: true })}</span>`
    + `</span></div>`).join("");
}
