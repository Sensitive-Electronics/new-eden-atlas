// What the brief's notes have to carry, and how they have to read.
//
// The notes on this screen were all ordered the same way: what the number is,
// how it is computed, where it came from, and - last - what it means for the
// pilot. That last clause is the only one that changes what anybody does, and
// it sat behind a definition.
//
//     "Betweenness is the share of all shortest stargate paths between all
//      other system pairs that passes through here. It is structural, not
//      traffic."
//
// Every word true, and it answers a question the reader is not asking. They are
// not asking what the metric is. They are asking whether to go there.
//
// So two things are asserted here, and they pull in opposite directions on
// purpose:
//
//   - **The caveat survives.** "It counts paths, not ships", "this is a model
//     rather than the game's rule", "jammers shrink this and cannot be seen" are
//     load-bearing, and a rewrite for readability is exactly when one gets
//     lost. Each is pinned by meaning rather than by phrasing, so the sentence
//     can be improved again without the guarantee going with it.
//   - **The reading stays plain.** No note may reach for the vocabulary the
//     rewrite removed - "articulation point", "subgraph", "betweenness is the
//     share of" - because that is the failure returning, and it returns by
//     someone adding one precise word to a sentence that was clear.

import { readArchive, suite } from "./helpers.mjs";
import { graphPositionPanel, tacticalPanel } from "../web/panels.js";
import { graphScale } from "../web/map-utils.js";
import { buildOperationalBrief, TacticalAnalyzer } from "../web/tactical-analyzer.js";

// Terms that are correct and that a pilot should not have to translate while
// deciding whether to undock.
const JARGON = [
  "articulation point",
  "subgraph",
  // The term, not only a sentence it opens. A note under a term of art has to explain
  // the term, so rewriting the note while the *label* above it stays a term of art
  // leaves the definition where the advice should be. Both are refused here.
  "betweenness",
  "graph position",
  "shortest stargate paths between all other",
  "structural, not traffic",
  "structural indicator",
  "the archive speaking",
];

export default function run() {
  const t = suite("brief language");

  const system = {
    system_id: 30000142,
    name: "Jita",
    metrics: { degree: 5, betweenness: 481_223, articulation: true, component: 0, component_size: 5431 },
  };
  // **Both forms, because only one of them ships.** This rendered the panel with
  // no scale, which is the fallback - so the note a pilot actually reads, the
  // one carrying the share and the chokepoint frequency, was never measured
  // against the ceiling or scanned for jargon. It was 310 characters against a
  // 320 limit and nothing would have said so.
  const scale = graphScale(readArchive());
  const graph = graphPositionPanel(system, scale);
  const bare = graphPositionPanel(system);

  // --- the caveat, by meaning -----------------------------------------------
  t.check(graph.length > 0, "the graph position panel renders");
  t.check(/counts paths|not ships/i.test(graph),
    "betweenness says it counts paths rather than ships");
  t.check(/empty .*same|same .*camped|as high as a camped/i.test(graph),
    "and says an empty chokepoint scores like a camped one, which is the whole caveat");

  // --- and the reading ------------------------------------------------------
  for (const term of JARGON) {
    t.check(!graph.toLowerCase().includes(term.toLowerCase()),
      `the graph position note does not reach for "${term}"`);
  }

  // A note that is longer than the panel it explains is a note nobody reads
  // under fire. This is a ceiling, not a target.
  //
  // **Every note, not the first one.** The panel carries one paragraph per figure, and
  // measuring only the first would let a second grow without limit - which is the shape
  // this ceiling exists to refuse.
  const notesIn = (html) =>
    [...html.matchAll(/<p class="tactical-note">([^<]*)<\/p>/g)].map((m) => m[1]);
  for (const [what, html] of [["with a scale", graph], ["with none", bare]]) {
    const notes = notesIn(html);
    t.check(notes.length > 0, `the note ${what} is there to be measured`);
    notes.forEach((note, index) => {
      t.check(note.length > 0, `note ${index + 1} ${what} is not empty`);
      t.check(note.length < 320,
        `note ${index + 1} ${what} is short enough to read in one go (${note.length} characters)`);
      for (const term of JARGON) {
        t.check(!note.toLowerCase().includes(term.toLowerCase()),
          `and note ${index + 1} ${what} does not reach for "${term}"`);
      }
    });
  }
  const note = notesIn(graph).join(" ");

  // **A figure with no scale is not information.** The count spreads across
  // three orders of magnitude - the median gated system is 16,946 and the
  // highest is 5,061,831 - so "a big number means a pipe" asked a pilot to
  // place a number they had nothing to place it against. Worse, the intuition
  // it invited was wrong: Jita is only the top 13%, because high-sec is densely
  // connected and there is usually a way round.
  // **One direction.** It read "top N%", which ran two ways on one panel: top 1%
  // was Zarzakh and top 100% was a one-gate dead end - and 1,101 gated systems,
  // a fifth of the map, rendered `0 · top 100%` directly under "near the top
  // means a pipe". A share of what a system is above only increases with the
  // figure beside it, so there is no second reading to get wrong.
  t.check(/busier than \d+%/.test(graph), "the count is rendered against the scale, not alone");
  t.check(!/top \d+%/.test(graph), "and in the one direction the figure runs");
  // And a "Yes" on the chokepoint row reads as rare when nearly a quarter of
  // gated systems are one.
  t.check(/% of gated systems are chokepoints/.test(note),
    "and the note says how common a chokepoint actually is");
  t.check(!/\bis the\b.*\bof all\b/.test(note),
    "and does not open by defining the metric, which is the shape this replaced");

  // --- the same two rules for the chokepoint note ---------------------------
  //
  // Rendered through the real entry point rather than asserted against the
  // source, because a check that reads prose is checking prose - which this
  // project has been caught doing twice.
  const report = new TacticalAnalyzer(readArchive()).analyze("Jita", 3);
  const config = { depth: 3, blocks: { security: true, approaches: true, chokes: true, borders: true } };
  const structure = tacticalPanel(report, { items: [], mode: "escape" }, config, () => "The Forge", () => "just now");
  {
    t.check(/cuts the cluster|cuts this/i.test(structure),
      "LOCAL and NETWORK are told apart by what losing the system does");
    t.check(/no one|nobody|neither says anyone|sitting there/i.test(structure),
      "and the note says neither is a report of anyone being there");
    for (const term of JARGON) {
      t.check(!structure.toLowerCase().includes(term.toLowerCase()),
        `the structure note does not reach for "${term}"`);
    }
  }

  // --- the branch with nothing to report ------------------------------------
  //
  // Every check above renders a system that *has* chokepoints, so the
  // empty-list branch was never executed - and "No articulation points detected
  // inside this analysis radius" survived two passes that were written to
  // remove exactly that phrase, two lines from a row one of them rewrote. The
  // analyser's own fallback sentence carried it too.
  //
  // A jargon check that only renders the populated branch is a jargon check
  // over half the strings.
  {
    const analyzer = new TacticalAnalyzer(readArchive());
    const bare = analyzer.analyze("Eskunen", 2);
    t.equal(bare.chokes.length, 0, "Eskunen at depth 2 has no chokepoints to report");

    const empty = tacticalPanel(bare, { items: [], mode: "escape" }, config, () => "The Forge", () => "just now");
    for (const term of JARGON) {
      t.check(!empty.toLowerCase().includes(term.toLowerCase()),
        `the empty-chokepoint panel does not reach for "${term}"`);
    }

    // And the analyser's own sentences, which the panel renders verbatim.
    //
    // **String values only.** The brief's item objects carry a `betweenness`
    // field - the archive's own name for the measure, which is internal and
    // correct - so stringifying the whole structure scans field names as well
    // as prose and flags a word nobody renders.
    const sentences = (value, into = []) => {
      if (typeof value === "string") into.push(value);
      else if (value && typeof value === "object") Object.values(value).forEach(v => sentences(v, into));
      return into;
    };
    for (const mode of ["hunt", "escape", "recon"]) {
      const said = sentences(buildOperationalBrief(bare, mode)).join(" ").toLowerCase();
      t.check(said.length > 0, `the ${mode} brief for a choke-free system says something`);
      for (const term of JARGON) {
        t.check(!said.includes(term.toLowerCase()),
          `the ${mode} brief for a choke-free system does not reach for "${term}"`);
      }
    }
  }

  return t.results;
}
