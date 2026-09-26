// The closed set of relations a read may state, and the code that checks one is
// true before it is rendered.
//
// The model names an unordered set of findings and a relation id. Three
// properties follow from that shape:
//
//   - **The model writes no words.** No template string, so no free-text slot
//     can be added by accident.
//   - **The model does not choose the order.** Findings are sorted into the
//     order the panel rendered them, because slot order is a ranking.
//   - **The model cannot state something false.** A relation that does not hold
//     is refused, never hedged.
//
// **The five below state the obvious.** Every one reads archive topology, which is
// what the map already draws. The mechanism is the part that matters; the set
// grows as live layers become catalogue sets.

import { project, referenceFault, RELATIONS as RELATION_VOCABULARY } from "./snapshot.js";
import { securityName } from "./map-utils.js";
import { lookup } from "./contract.js";

// Names are joined here rather than in each relation, so no relation can
// invent a connective. Oxford comma omitted deliberately: it matches the
// project's existing prose.
function listOf(names) {
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function fieldOf(finding, key) {
  const system = finding && finding.system;
  // `Object.hasOwn`, as the name lookup below already does. Every key read here is
  // one the archive vouched for, so nothing inherited can be reached today - and
  // that is a property of the callers rather than of this function.
  return system && typeof system === "object" && Object.hasOwn(system, key)
    ? system[key]
    : undefined;
}

function allShare(findings, key) {
  const first = fieldOf(findings[0], key);
  if (first === undefined) return false;
  return findings.every((finding) => fieldOf(finding, key) === first);
}

function securityBand(finding) {
  const security = fieldOf(finding, "security");
  return Number.isFinite(security) ? securityName(security) : null;
}

// Every relation: an id, the fewest findings it means anything over, a
// predicate, and a sentence. `holds` sees the findings in on-screen order.
export const RELATIONS = Object.freeze({
  "same-region": Object.freeze({
    minimum: 2,
    holds: (findings) => allShare(findings, "region_id"),
    say: (names) => `${listOf(names)} are in the same region.`,
  }),

  "same-constellation": Object.freeze({
    minimum: 2,
    holds: (findings) => allShare(findings, "constellation_id"),
    say: (names) => `${listOf(names)} are in the same constellation.`,
  }),

  // One jump apart, which is the relation an FC acts on fastest.
  "adjacent": Object.freeze({
    minimum: 2,
    holds: (findings) => findings.every((finding, index) => {
      if (index === 0) return true;
      const neighbors = fieldOf(findings[index - 1], "neighbors");
      const id = fieldOf(finding, "system_id");
      return Array.isArray(neighbors) && Number.isFinite(id) && neighbors.includes(id);
    }),
    // Pairs, named explicitly. A chain sentence - "Alpha, Bravo and Cee are each
    // one jump from the last" - reads under a relation called `adjacent` as a claim
    // about the set, and Alpha and Cee are two jumps apart. A deterministic
    // sentence that is false is the one thing this register exists to prevent.
    say: (names) => (names.length === 2
      ? `${names[0]} and ${names[1]} are one jump apart.`
      : `${names.slice(1).map((name, i) => `${names[i]} is one jump from ${name}`).join(", ")}.`),
  }),

  // The band, never the float. 0.457 and 0.443 differ by 0.014 and by the
  // whole of CONCORD; the band is the part a fleet acts on.
  "same-security-band": Object.freeze({
    minimum: 2,
    holds: (findings) => {
      const first = securityBand(findings[0]);
      return first !== null && findings.every((finding) => securityBand(finding) === first);
    },
    // No "all" and no "both". They are quantifiers, and even rendered by code
    // they read as a claim about a set the sentence does not show - which is
    // the thing this register exists to keep out.
    say: (names, findings) => `${listOf(names)} are ${securityBand(findings[0]).toLowerCase()}.`,
  }),

  "crosses-a-security-band": Object.freeze({
    minimum: 2,
    holds: (findings) => {
      const bands = findings.map(securityBand);
      return bands.every((band) => band !== null) && new Set(bands).size > 1;
    },
    say: (names, findings) => {
      const parts = names.map((name, index) => `${name} is ${securityBand(findings[index]).toLowerCase()}`);
      return `${listOf(parts)}.`;
    },
  }),
});

export const RELATION_IDS = Object.freeze(Object.keys(RELATIONS));

// How many findings one relation may span.
//
// Everything else in a reply is bounded - twelve operations, twenty rendered
// members, two hundred and forty characters of opinion - and a relation sentence
// has to be too. `crosses-a-security-band` names every finding it spans, so over
// thousands of findings it is tens of thousands of characters, on the webview's
// main thread, as the one string the deterministic side writes for a pilot to read.
//
// The argument `operations.js` gives for its render limit applies verbatim: past a
// point the check a reader is offered degrades into no check at all. A figure at
// least carries `population` and `renderedAll` to say so; a sentence carries
// nothing, so it is true and unreadable, which under fire is the same as false.
//
// **Refused rather than truncated.** Half a relation sentence is a claim about
// a set that is not the set - a false sentence, which is the one thing this
// register exists to make impossible. Past a handful a relation is a list, and
// a list is what the figures are for.
export const RELATION_LIMIT = 8;

// The projection carries the ids; this module carries what they mean. Two places,
// so they can drift - checked at load rather than in a test, because the thing that
// must be impossible is shipping with the drift.
{
  const offered = [...RELATION_VOCABULARY].sort().join(",");
  const understood = [...RELATION_IDS].sort().join(",");
  if (offered !== understood) {
    throw new Error(`the projection offers relations [${offered}] and this module understands [${understood}]`);
  }
}

function safe(value) {
  let text;
  try {
    text = String(value);
  } catch {
    return "<unprintable>";
  }
  return text.length > 60 ? `${text.slice(0, 60)}...` : text;
}

function fault(message) {
  return { fault: String(message) };
}

const FINDING = "finding:";

// A read. Returns `{relation, findings, text}` or `{fault}` - never a sentence
// this could not check.
export function read(snapshot, request) {
  if (!snapshot || typeof snapshot !== "object") return fault("no snapshot");
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    return fault("a read is one relation over one set of findings");
  }

  const projection = project(snapshot);
  if (projection.snapshotId === null) {
    return fault("this snapshot was not minted here, so nothing in it can be named");
  }

  const relation = lookup(RELATIONS, request.relation);
  if (relation === undefined) {
    return fault(`unknown relation: ${safe(request.relation)}; the set is ${RELATION_IDS.join(", ")}`);
  }

  const refs = request.findings;
  if (!Array.isArray(refs) || refs.length < relation.minimum) {
    return fault(`${safe(request.relation)} relates at least ${relation.minimum} findings`);
  }
  if (refs.length > RELATION_LIMIT) {
    return fault(`a relation spans at most ${RELATION_LIMIT} findings, and that one names ${refs.length}`);
  }

  const seen = new Set();
  const chosen = [];
  for (const ref of refs) {
    const bad = referenceFault(projection, ref);
    if (bad) return fault(bad);
    if (typeof ref.ref !== "string" || !ref.ref.startsWith(FINDING)) {
      return fault(`${safe(ref && ref.ref)} is not a finding`);
    }
    // A relation over a thing and itself holds trivially and says nothing.
    if (seen.has(ref.ref)) return fault("a read relates different findings");
    seen.add(ref.ref);
    const finding = (snapshot.findings || []).find((each) => each.id === ref.ref);
    if (!finding) return fault(`${safe(ref.ref)} is not in this snapshot`);
    chosen.push(finding);
  }

  // On-screen order, taken from the id this module did not mint. The model
  // supplied a set; the panel supplied the order.
  // Ranked once rather than searched per comparison: `indexOf` inside a comparator
  // is O(n^2 log n).
  const rank = new Map((snapshot.findings || []).map((finding, index) => [finding.id, index]));
  chosen.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));

  let satisfied;
  try {
    satisfied = relation.holds(chosen);
  } catch {
    satisfied = false;
  }
  if (!satisfied) {
    // Refused, not softened. A read that may be hedged is a read that may be
    // wrong, and the whole register exists because a wrong sentence under the
    // findings is the order the fleet follows.
    // `safe()`, like every other interpolation of a model-supplied value in this
    // file. `request.relation` has already passed `lookup()` and so is a key of
    // `RELATIONS`, which makes it inert here - but this string reaches the ask
    // window as `record.error`, and a bound that holds everywhere except once is a
    // bound somebody will move.
    return fault(`${safe(request.relation)} does not hold for those findings`);
  }

  // Names come from the minted snapshot's own resolved record, the same place
  // the projection and the operations take them from. A finding with no
  // vouched name has no sentence to appear in.
  const names = chosen.map((finding) => {
    const id = fieldOf(finding, "system_id");
    const vouched = snapshot.names;
    if (!vouched || !Number.isFinite(id) || !Object.hasOwn(vouched, id)) return null;
    const name = vouched[id];
    return typeof name === "string" ? name : null;
  });
  if (names.some((name) => name === null)) {
    return fault("a finding in that set has no name the archive vouched for");
  }

  let text;
  try {
    text = relation.say(names, chosen);
  } catch {
    return fault(`${safe(request.relation)} could not be rendered`);
  }

  return Object.freeze({
    relation: request.relation,
    snapshotId: projection.snapshotId,
    findings: Object.freeze(chosen.map((finding) => finding.id)),
    // Every word of this was written here.
    text,
  });
}
