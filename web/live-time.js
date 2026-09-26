// Everything on screen whose text depends on the clock.
//
// Its own module because three things need it and none of them should own it: the
// templates that first render a time, the tick that refreshes them, and the
// status bars that embed a time mid-line. Put the formatter in any one of those
// and the other two grow their own copy.
//
// **One transform, called by every path.** `liveTime` does not accept
// pre-rendered text. It takes the kind and the instant and produces the string
// itself, from the same function the tick uses, so a template and a tick cannot
// render the same fact differently.
//
// Instants are milliseconds, the JavaScript epoch, everywhere. A seconds-based
// timestamp would be off by a factor of a thousand and read as 1970.

import { escapeHtml as esc } from "./map-utils.js";
import { describeAge } from "./esi.js";
import { describeTiming } from "./campaigns.js";
import { describeRemaining } from "./overrides.js";

// describeAge returns a phrase rather than a sentence - "synced 5m ago" -
// because it also has to read mid-line in the live bar. Where it starts a
// sentence it needs a capital, and baking one in would put it mid-bar.
export const sentence = text => String(text ?? "").replace(/^[a-z]/, c => c.toUpperCase());

export const LIVE_TIME_KINDS = ["age", "countdown", "remaining"];

// How old this data is, how long until this starts, how long is left of this.
// Three different questions, one place that answers them.
// `embedded` is whether this sits mid-line - "sov: 42 held / synced 5m ago" - or
// starts a sentence of its own. The caller knows where the text goes and nothing
// else does, but the *wording* is decided here either way, so no caller
// capitalises or rephrases its own copy.
export function liveTimeText(kind, at, { now = Date.now(), embedded = false, verb } = {}) {
  if (!Number.isFinite(at)) return "";
  // `verb` is only meaningful for an age, and only where the thing described was
  // not synced: a snapshot is *taken*. `liveTime` writes it into the span and the
  // tick reads it back, so a custom verb survives every tick rather than only the
  // first render.
  const text = kind === "age" ? describeAge(Math.max(0, now - at), verb ?? "synced")
    : kind === "countdown" ? describeTiming({ startTime: at }, now)
    : kind === "remaining" ? describeRemaining(at - now)
    : "";
  return embedded ? text : sentence(text);
}

// A span that carries what it is about, so the tick can find it by selector and
// recompute it. Nothing registers, nothing unregisters: a span that is removed
// from the document stops being found, which is the whole of the cleanup.
export function liveTime(kind, at, { now = Date.now(), embedded = false, verb } = {}) {
  const text = liveTimeText(kind, at, { now, embedded, verb });
  if (!text) return "";
  // The verb travels with the span, not with the caller. The tick recomputes
  // from these attributes and nothing else, so a verb the span does not carry
  // is a verb that survives exactly one render.
  const carried = typeof verb === "string" && verb !== "" ? ` data-live-verb="${esc(verb)}"` : "";
  return `<span data-live-at="${esc(at)}" data-live-kind="${esc(kind)}"${carried}`
    + `${embedded ? ' data-live-embedded="true"' : ""}>${esc(text)}</span>`;
}

// Refresh every time-driven span under these roots. Called by the one tick, and
// by anything that has just changed what the clock is being measured against.
export function refreshLiveTimes(roots, now = Date.now()) {
  let refreshed = 0;
  for (const root of roots) {
    if (!root?.querySelectorAll) continue;
    for (const element of root.querySelectorAll("[data-live-at]")) {
      const text = liveTimeText(element.dataset.liveKind, Number(element.dataset.liveAt), {
        now,
        embedded: element.dataset.liveEmbedded === "true",
        // Absent means the default, which is what every existing span carries.
        verb: element.dataset.liveVerb,
      });
      if (!text) continue;
      element.textContent = text;
      refreshed += 1;
    }
  }
  return refreshed;
}
