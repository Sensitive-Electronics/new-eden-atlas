// The last sentence, and the only place the model writes its own words.
//
// **One sentence, at the end, carrying no number**, marked as a view rather
// than a fact. The brief is complete without it and renders without it whenever
// the advisor is absent, which is most of the time.
//
// It cannot be checked for truth, so it is bounded four ways instead: no digit
// outside a name the brief showed, no name the brief did not show, one
// sentence, and no word that counts or asserts a trend. The deny-list is the
// weakest of the four, which is why the other three are structural.
//
// It over-refuses on purpose. A refused opinion costs a brief nothing; an invented
// system costs a fleet.

import { project } from "./snapshot.js";

// Long enough for a real thought, short enough that nobody mistakes it for the
// brief. One sentence is the rule; this is the backstop for a sentence that
// never ends.
const LIMIT = 240;

// Whole words, never bare digit runs: matching runs as substrings let "1 jump
// away" through whenever a shown name contained a 1, which "1DQ1-A" does.
const WORD = /[^\s]+/g;

// Every numeral, not every ASCII digit. `/[0-9]/` let six kinds of number
// through - Arabic-Indic, Devanagari, fullwidth, superscript, vulgar fractions
// and Roman numerals - and "It is Ⅳ jumps." reads as a number to any human.
const HAS_DIGIT = /\p{N}/u;

// Control characters, format characters (which includes the zero-width space
// and every bidi override), and line or paragraph separators. Surrogates too:
// an unpaired one is not encodable as UTF-8 and a transport will either throw
// or replace it, so what a pilot reads would not be what was checked.
const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u;

// **A number spelled out is a number.** `HAS_DIGIT` catches "11"; without this,
// "Amarr is eleven jumps out" renders with zero measured figures behind it, which
// is a fabricated statistic in a tactical tool.
//
// This is **structural**, not a deny-list, and the distinction matters: English
// cardinals, ordinals and collectives are a closed set for any range a brief could
// use, so refusing them is the same rule as refusing a digit rather than a guess at
// which words a model might reach for. `COUNTING` below is the
// admitted-incomplete list.
const NUMBER_WORDS = new Set([
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen",
  "eighteen", "nineteen", "twenty", "thirty", "forty", "fifty", "sixty", "seventy",
  "eighty", "ninety", "hundred", "thousand", "million", "billion", "trillion",
  // Ordinals are a ranking, which is an operation this side performs.
  "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth",
  "ninth", "tenth", "eleventh", "twelfth", "last",
  // `first` is deliberately absent. In this register it is an adverb of
  // sequence - "scout Tama first" is advice, not a count - and the ranking
  // sense it could carry is already refused by the superlatives in `COUNTING`.
  // Every other ordinal is a position in an order this side did not compute.
  // Collectives that stand in for a count.
  "dozen", "score", "couple", "pair", "handful", "both", "half", "quarter",
  "third", "twice", "thrice", "double", "triple", "single", "once",
  // The plurals too. A collective pluralised is still a collective, and "hundreds"
  // is a vaguer count rather than a smaller one.
  "dozens", "scores", "couples", "pairs", "handfuls", "halves", "quarters",
  "hundreds", "thousands", "millions", "billions", "trillions", "tens",
]);

// Quantities and trends. Incomplete by admission - a banned-word list always
// is - so it is the last line rather than the first. "Rose" and "spiked" are
// here because a trend is an operation, and an opinion that asserts one has
// done arithmetic by eye.
//
// Comparatives sit beside their superlatives: a comparison is an operation whatever
// degree it is in.
const COUNTING = new Set([
  "all", "every", "each", "none", "most", "many", "few", "several",
  "majority", "minority",
  "rose", "rising", "risen", "fell", "fallen", "falling", "spiked", "surged",
  "doubled", "halved", "increased", "decreased", "climbing", "dropping",
  "more", "fewer", "less", "greater", "higher", "lower",
  // Superlatives, and the comparatives that were missing beside them.
  "worst", "best", "hardest", "busiest", "quietest", "safest", "deadliest",
  "worse", "better", "harder", "busier", "quieter", "safer", "deadlier",
  "nearer", "nearest", "closer", "closest", "further", "furthest",
  "farther", "farthest", "faster", "fastest", "slower", "slowest",
  "bigger", "biggest", "smaller", "smallest", "longer", "longest",
  "shorter", "shortest", "riskier", "riskiest", "calmer", "calmest",
  "emptier", "emptiest", "heavier", "heaviest", "lighter", "lightest",
]);

// Ordinary words an English sentence may capitalise: the first word, and "I".
// Deliberately short. Anything outside it that is capitalised and not a shown
// name is treated as an invented system, which fails closed.
const OPENERS = new Set([
  "i", "a", "an", "the", "this", "that", "these", "those", "it", "its",
  "if", "when", "while", "where", "there", "they", "their", "we", "our",
  "you", "your", "but", "and", "so", "given", "unless", "until", "once",
  "before", "after", "whether", "nothing", "anything", "something",
  "look", "looks", "watch", "consider", "expect", "assume", "avoid",
  "take", "treat", "hold", "push", "stage", "scout", "worth", "better",
  "probably", "likely", "possibly", "nobody", "somebody", "everybody",
  "his", "her", "hers", "theirs", "mine", "ours", "yours",
  // A question is one sentence, and English opens one with a verb.
  "is", "are", "was", "were", "do", "does", "did", "can", "could", "should",
  "would", "will", "has", "have", "why", "what", "which", "who", "whom", "how",
]);


function fault(message) {
  return { fault: String(message) };
}

// The names the brief showed, which is the whole vocabulary of proper nouns an
// opinion may use. Taken from the minted snapshot's own resolved record - the
// same place the projection and the operations take names from - so an opinion
// cannot name a system by a string that reached the snapshot some other way.
function shownNames(snapshot) {
  const names = new Set();
  const record = snapshot && snapshot.names;
  for (const finding of snapshot.findings || []) {
    const id = finding && finding.system && finding.system.system_id;
    if (!record || !Number.isFinite(id) || !Object.hasOwn(record, id)) continue;
    const name = record[id];
    if (typeof name === "string" && name.length > 0) names.add(name);
  }
  return names;
}

// A name may be several words - "Kor-Azor Prime", "Jita 4-4" - so the check is
// whether a run of words starting here matches one the brief showed.
function nameEndingAt(words, index, shown) {
  for (let length = Math.min(4, words.length - index); length >= 1; length -= 1) {
    const candidate = words.slice(index, index + length).join(" ");
    if (shown.has(candidate)) return length;
  }
  return 0;
}

// **Ordinary words that are also system names, read as words.**
//
// The bound is "no name the brief did not show", **in any case**. Checking only
// capitalised words lets "Stage in amamake instead." render while "Amamake" is
// refused, and a pilot reads the first as the system. Deciding that a lower-case
// word is a system name needs the archive, which the caller hands over as names it
// already has - data, not a resolver, exactly as `buildSnapshot` is handed the
// archive. A set of strings can be the wrong set; it cannot be a rule for making
// names up. **Absent, every opinion is refused**, so the check cannot be left
// half-wired.
//
// That costs ordinary English. New Eden contains systems called Exit, Access, Half,
// Parts, Bar, Col, Manifest, Celerity, Parses and Perimeter, and without an
// exemption the rule refuses the word "exit" in a sentence about an exit - the most
// natural word in an escape brief.
//
// **An out-of-date list can only over-refuse**, which is what makes a hand-kept set
// safe here: a name added by a future rebuild is simply not exempt, so the word is
// refused. The failure mode of forgetting to maintain this is a missing sentence,
// never a name that got through.
//
// Kept to one entry on purpose. `perimeter` is deliberately absent - Perimeter is a
// trade hub beside Jita, and a model writing it almost certainly means the system.
// Every addition is a hole, so each has to be needed rather than merely plausible.
const ORDINARY_WORDS = new Set(["exit"]);

// Built once per list rather than once per turn: the archive holds 8,490 names and
// `opine` runs on every advisor reply. Keyed weakly on the caller's own array, so
// nothing is kept alive for it.
const INDEX_CACHE = new WeakMap();

function loweredNames(names) {
  if (!names) return null;
  if (typeof names === "object") {
    const cached = INDEX_CACHE.get(names);
    if (cached !== undefined) return cached;
  }
  const index = new Set();
  for (const name of names) {
    if (typeof name !== "string" || !name) continue;
    const lowered = name.toLowerCase();
    if (ORDINARY_WORDS.has(lowered)) continue;
    index.add(lowered);
  }
  const built = index.size ? index : null;
  if (typeof names === "object") INDEX_CACHE.set(names, built);
  return built;
}

// Whether this word is the tail of a multi-word name the brief did show, so the
// third word of Old Man Star is not refused as invented. The lookback spans a
// whole name rather than one word, and three is the longest name in the archive.
function insideShownName(bare, index, shown) {
  for (let back = 1; back <= 3 && back <= index; back += 1) {
    if (nameEndingAt(bare, index - back, shown) > back) return true;
  }
  return false;
}

export function opine(snapshot, text, systemNames = null) {
  if (!snapshot || typeof snapshot !== "object") return fault("no snapshot");
  // The same brand the projection and the operations require. The names an
  // opinion may use come from the snapshot's own resolved record, and that
  // record is only trustworthy on a snapshot this project minted.
  if (project(snapshot).snapshotId === null) {
    return fault("this snapshot was not minted here, so nothing in it can be named");
  }
  const known = loweredNames(systemNames);
  if (known === null) {
    return fault("no name index was supplied, so a name this brief did not show cannot be recognised");
  }
  if (typeof text !== "string") return fault("an opinion is a sentence");
  // From the projection, which is the one place an identity is resolved and frozen,
  // and the same place the operations and the read take it from.
  const snapshotId = project(snapshot).snapshotId;

  const trimmed = text.trim();
  if (trimmed.length === 0) return fault("an opinion is a sentence");

  // **Printable characters only, checked before anything else.**
  //
  // Two attacks, one guard. A zero-width space *inside* a word splits it for the
  // word checks while leaving the rendered sentence intact - "the b\u200Best exit"
  // against "the best exit" - so every deny-list here could be walked through one
  // character at a time. And a right-to-left override reverses the rendering
  // direction of everything after it, making the sentence a pilot reads a different
  // sentence from the one that was checked.
  //
  // `bare` strips non-letters from the **ends** of a word and never catches an
  // interior one. Refusing the sentence outright covers both and costs nothing: no
  // opinion worth showing contains a control character.
  if (UNPRINTABLE.test(trimmed)) {
    return fault("an opinion is printable text, and that one carries a control or formatting character");
  }
  if (trimmed.length > LIMIT) return fault(`an opinion is one sentence, and that is ${trimmed.length} characters`);

  // A terminator is punctuation followed by a space or the end of the string.
  // Counting every full stop made "Security is 0.5 there." two sentences.
  const terminators = trimmed.match(/[.!?](?=\s|$)/g) || [];
  if (terminators.length === 0) return fault("an opinion ends in a full stop");
  if (terminators.length > 1 || !/[.!?]$/.test(trimmed)) {
    return fault("an opinion is one sentence, and that is more than one");
  }

  const shown = shownNames(snapshot);
  const words = trimmed.match(WORD) || [];
  // Punctuation comes off **both** ends, and the pairing is not optional. `WORD`
  // matches every non-space run so that non-ASCII numerals are caught, which also
  // makes "(Rancer)" start with a paren - and a leading paren fails a
  // capitalisation test rather than triggering it.
  const bare = words.map((word) => word
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .replace(/[^\p{L}\p{N}]+$/u, ""));

  let index = 0;
  while (index < bare.length) {
    const span = nameEndingAt(bare, index, shown);
    if (span > 0) {
      // A name the brief showed, digits and all. This is the whole reason the
      // check is word-level.
      index += span;
      continue;
    }
    const word = bare[index];
    if (HAS_DIGIT.test(word)) {
      // "1DQ1-B" is not a number, it is a name off by one character, and
      // saying "is a number" sends a reader looking in the wrong place.
      return /[A-Za-z]/.test(word)
        // **A category, not the token.** These messages become `opinionRefused` and
        // render on a pilot's surface, so echoing the model's own word puts its
        // digits on screen inside a refusal - and bounded, escaped and framed as a
        // refusal is still a model-typed digit in front of a pilot. The category
        // says which bound was crossed, which is all the surface needs.
        ? fault("a word the brief did not show as a name")
        : fault("a numeral, and an opinion carries none");
    }
    // The same rule, the other spelling. Checked here rather than in the
    // deny-list below because it is the digit rule, not a guess about phrasing.
    //
    // **Hyphenated parts, each on its own.** `bare` strips punctuation from the
    // *ends* of a word only, so an interior hyphen survives and exact equality
    // against a set of single words misses every English cardinal from **21 to 99**
    // - "thirty-four" renders where "eleven" is refused, while "thirty four" with a
    // space is refused, which is what keeps such a gap invisible.
    //
    // Splitting keeps the rule structural rather than adding seventy-nine entries,
    // and closes compound ordinals ("twenty-third") and "hundred-and-two" in the
    // same line. It also catches the non-ASCII joiners, a non-breaking hyphen and an
    // en dash among them.
    //
    // A shown name is consumed by `nameEndingAt` above before this runs, so "1DQ1-A"
    // is never split. Ordinary hyphenated English containing a number word -
    // "one-way", "half-hearted" - is refused, which is this module's direction.
    const parts = word.toLowerCase().split(/[-\u2010-\u2015\u2212]/u).filter(Boolean);
    const counted = parts.find((part) => NUMBER_WORDS.has(part));
    if (counted !== undefined) {
      return fault("a number written as a word, and an opinion carries none");
    }
    if (COUNTING.has(word.toLowerCase())) {
      return fault("a word that counts or asserts a trend, which is an operation rather than a view");
    }
    index += 1;
  }

  // **One loop, two reasons a word might be a name**: it is in the archive in any
  // case at all, or it is capitalised. Both are refused unless the brief showed it,
  // and they share one lookback - two expressions that have to agree by hand are two
  // expressions that will not.
  //
  // Every capitalised word is checked **including the first**, or "Rancer is the
  // better exit." passes as sentence-initial. Read off `bare` rather than `words`,
  // since "(Rancer)" begins with a bracket rather than a capital. The lookback spans
  // a whole name rather than one word, or the third word of Old Man Star is refused
  // as invented; three words is the longest name in the archive.
  //
  // The `OPENERS` exemption belongs only to the capitalisation rule: an ordinary
  // sentence opener is forgiven for being capitalised and is *not* forgiven for
  // being a system name. No opener is one, checked against all 8,490, so this
  // states the precedence rather than changing an outcome.
  for (let i = 0; i < words.length; i += 1) {
    const lowered = bare[i].toLowerCase();
    const isArchiveName = known.has(lowered);
    if (!isArchiveName && !/^\p{Lu}/u.test(bare[i])) continue;
    if (nameEndingAt(bare, i, shown) > 0) continue;
    if (insideShownName(bare, i, shown)) continue;
    if (!isArchiveName && OPENERS.has(lowered)) continue;
    return fault("a word the brief did not show as a name");
  }

  return Object.freeze({
    kind: "opinion",
    snapshotId,
    // Marked, and rendered where a marked thing goes: last, after everything
    // the deterministic side produced.
    text: trimmed,
  });
}
