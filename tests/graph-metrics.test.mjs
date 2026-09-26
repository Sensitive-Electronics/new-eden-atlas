import { readArchive, suite } from "./helpers.mjs";
import { buildOperationalBrief, TacticalAnalyzer } from "../web/tactical-analyzer.js";

export default function run() {
  const t = suite("graph metrics");
  const atlas = readArchive();
  const systems = atlas.systems;
  const all = Object.values(systems);

  // --- the archive carries them -------------------------------------------
  t.check(all.every(s => s.metrics), "every system carries a metrics block");
  t.check(all.every(s => s.metrics.degree === s.neighbors.length),
    "degree agrees with the neighbour list it was derived from");
  t.check(all.every(s => s.metrics.betweenness >= 0), "no negative betweenness");
  t.check(all.filter(s => s.neighbors.length === 0).every(s => s.metrics.component === -1 && s.metrics.betweenness === 0),
    "a system with no gates is isolated and carries no shortest paths");
  t.check(all.filter(s => s.metrics.degree === 1).every(s => s.metrics.betweenness === 0),
    "a system with one gate lies on no shortest path between two others");

  // --- independent spot checks --------------------------------------------
  const adjacency = new Map(all.filter(s => s.neighbors.length).map(s => [s.system_id, s.neighbors]));
  const reachable = (from, to, { skipNode = null } = {}) => {
    if (from === to) return true;
    const seen = new Set([from]);
    if (skipNode !== null) seen.add(skipNode);
    const queue = [from];
    while (queue.length) {
      for (const next of adjacency.get(queue.shift()) ?? []) {
        if (seen.has(next)) continue;
        if (next === to) return true;
        seen.add(next);
        queue.push(next);
      }
    }
    return false;
  };

  // Deterministic sampling: a fixed stride, so a failure is reproducible.
  const sample = (list, count) => {
    const step = Math.max(1, Math.floor(list.length / count));
    return list.filter((_, i) => i % step === 0).slice(0, count);
  };

  const bridges = atlas.jumps.filter(j => j.bridge);
  const ordinary = atlas.jumps.filter(j => !j.bridge);
  t.check(bridges.length > 0, `${bridges.length} links are marked as bridges`);

  // Actually remove the link from both endpoints, then ask whether they can
  // still reach each other. Restoring afterwards keeps the graph shared.
  const withoutLink = (jump, probe) => {
    const saved = [adjacency.get(jump.from_system_id), adjacency.get(jump.to_system_id)];
    adjacency.set(jump.from_system_id, saved[0].filter(id => id !== jump.to_system_id));
    adjacency.set(jump.to_system_id, saved[1].filter(id => id !== jump.from_system_id));
    const answer = probe();
    adjacency.set(jump.from_system_id, saved[0]);
    adjacency.set(jump.to_system_id, saved[1]);
    return answer;
  };

  let badBridge = null;
  for (const jump of sample(bridges, 25)) {
    if (withoutLink(jump, () => reachable(jump.from_system_id, jump.to_system_id))) { badBridge = jump; break; }
  }
  t.check(badBridge === null,
    badBridge ? `${badBridge.from_system_id}-${badBridge.to_system_id} is marked a bridge but removing it changes nothing` : "sampled bridges genuinely sever their endpoints");

  let badOrdinary = null;
  for (const jump of sample(ordinary, 25)) {
    if (!withoutLink(jump, () => reachable(jump.from_system_id, jump.to_system_id))) { badOrdinary = jump; break; }
  }
  t.check(badOrdinary === null,
    badOrdinary ? `${badOrdinary.from_system_id}-${badOrdinary.to_system_id} is not marked a bridge but removing it severs its endpoints` : "sampled ordinary links genuinely do not");

  const splits = system => {
    const neighbours = system.neighbors.filter(id => adjacency.has(id));
    return neighbours.slice(1).some(other => !reachable(neighbours[0], other, { skipNode: system.system_id }));
  };
  const articulation = all.filter(s => s.metrics.articulation);
  const plain = all.filter(s => !s.metrics.articulation && s.metrics.degree >= 2);
  t.check(articulation.length > 0, `${articulation.length} systems are marked as articulation points`);
  t.check(sample(articulation, 15).every(splits), "sampled articulation points genuinely split their neighbourhood");
  t.check(sample(plain, 15).every(s => !splits(s)), "sampled ordinary systems genuinely do not");

  // --- components ---------------------------------------------------------
  const pochven = Object.values(atlas.regions).find(r => r.name === "Pochven");
  const pochvenIds = new Set(pochven.systems);
  const external = pochven.systems.filter(id => systems[id].neighbors.some(n => !pochvenIds.has(n)));
  t.equal(external.length, 0, "Pochven has no stargate link to the rest of the network");
  const pochvenComponents = new Set(pochven.systems.map(id => systems[id].metrics.component));
  t.equal(pochvenComponents.size, 1, "and forms a single component of its own");
  t.equal(systems[pochven.systems[0]].metrics.component_size, pochven.systems.length,
    "whose size is exactly Pochven");

  // --- the tactical analyzer uses them ------------------------------------
  const analyzer = new TacticalAnalyzer(atlas);
  const report = analyzer.analyze("Jita", 4);
  t.check(report.chokes.length > 0, `a 4-jump brief from Jita finds ${report.chokes.length} chokepoint candidates`);
  t.check(report.chokes.every((entry, i) => i === 0 || report.chokes[i - 1].betweenness >= entry.betweenness),
    "candidates are ranked by betweenness, highest first");
  t.check(report.chokes.every(entry => entry.global === Boolean(entry.system.metrics.articulation)),
    "the NETWORK flag matches the archive's own articulation metric");
  t.check(report.chokes.every(entry => entry.jumps < report.depth), "no candidate sits on the frontier");
  t.check(Array.isArray(report.soleLinksInRange), "the brief reports bridge links in range");
  t.check(report.soleLinksInRange.every(b =>
    atlas.jumps.some(j => j.bridge
      && Math.min(j.from_system_id, j.to_system_id) === Math.min(b.from.system_id, b.to.system_id)
      && Math.max(j.from_system_id, j.to_system_id) === Math.max(b.from.system_id, b.to.system_id))),
    "every reported bridge is one the archive marked");

  for (const mode of ["hunt", "escape", "recon"]) {
    const brief = buildOperationalBrief(report, mode);
    t.equal(brief.mode, mode, `${mode} brief keeps its requested objective`);
    t.check(brief.items.length > 0 && brief.items.length <= 5, `${mode} brief returns a compact priority list`);
    t.check(brief.items.every(item => item.system && item.title && item.detail), `${mode} priorities are actionable and explained`);
    t.check(new Set(brief.items.map(item => item.system.system_id)).size === brief.items.length,
      `${mode} priorities do not duplicate systems`);
  }
  const escape = buildOperationalBrief(report, "escape");
  t.check(escape.items[0].tag === "PRIMARY", "escape identifies one primary exit");
  const recon = buildOperationalBrief(report, "recon");
  t.check(recon.items.every((item, index) => item.tag === `SCOUT ${index + 1}`), "recon emits ordered scout assignments");
  const hunt = buildOperationalBrief(report, "hunt");
  t.check(hunt.items[0].tag === "PRIMARY", "hunt identifies one primary catch point");

  // The escape ranking weights structural risk heavily, and those weights were
  // doing real work with nothing pinning them: zeroing the choke penalty
  // changed which exit is recommended and no test noticed.
  //
  // Asserted as a property rather than a system name, so it survives an SDE
  // refresh: where the roomiest exit is not the safest, the brief must prefer
  // the safer one. At Tama the analyser picks an 11-system exit with one
  // network choke over a 36-system exit with eleven.
  const riskCases = ["Tama", "1DQ1-A"].map(name => {
    const local = analyzer.analyze(name, 4);
    const brief = buildOperationalBrief(local, "escape");
    const roomiest = [...local.approaches].sort((a, b) => b.reachableSystems - a.reachableSystems)[0];
    const chosen = local.approaches.find(v => v.system.system_id === brief.items[0].system.system_id);
    return { name, roomiest, chosen };
  }).filter(entry => entry.chosen && entry.roomiest
    && entry.roomiest.system.system_id !== entry.chosen.system.system_id);

  t.check(riskCases.length > 0,
    "at least one origin has a roomiest exit that is not the chosen one, so the weighting is exercised");
  for (const entry of riskCases) {
    t.check(entry.chosen.globalChokes <= entry.roomiest.globalChokes,
      `${entry.name}: the chosen exit (${entry.chosen.system.name}, ${entry.chosen.globalChokes} chokes) `
      + `is no riskier than the roomiest (${entry.roomiest.system.name}, ${entry.roomiest.globalChokes})`);
  }
  t.check(riskCases.some(entry => entry.chosen.globalChokes < entry.roomiest.globalChokes),
    "and in at least one case it is strictly safer, so structural risk genuinely outranks reach");

  // Each term pinned on its own. Two subtleties made an earlier attempt at
  // this vacuous. Real data correlates chokes with bridges, so zeroing either
  // weight left the same ordering; and the sort carries a SECONDARY tie-break
  // on globalChokes, so a pair that merely ties on score is decided by the
  // tie-break rather than the weight. Each case below therefore sets the term
  // under test against a competing term large enough to win without it.
  //
  // Baseline score = reach + frontier*2 + regions*6 - chokes*12 - bridges*8,
  // so the default vector scores 20 + 8 + 6 = 34.
  const vector = (name, overrides) => ({
    system: { system_id: name.length * 7919 + name.charCodeAt(0), name, region_id: 10000002, security: 0.5 },
    reachableSystems: 20,
    frontierSystems: 4,
    regions: ["A"],
    security: { high: 0, low: 20, null: 0 },
    borderSystems: 0,
    globalChokes: 0,
    bridgeLinks: 0,
    ...overrides,
  });
  const primaryOf = (a, b) => buildOperationalBrief({ ...report, approaches: [a, b] }, "escape").items[0].system.name;

  // Roomier but choked: 40 + 8 + 6 - 48 = 6, against a clean 34. Drop the
  // choke weight and the roomier one wins on reach alone.
  t.equal(primaryOf(vector("Choked", { reachableSystems: 40, globalChokes: 4 }), vector("Clean", {})), "Clean",
    "a roomier exit loses to a clean one when it is held together by network chokepoints");

  // Same shape for severable links: 40 + 8 + 6 - 32 = 22, against 34.
  t.equal(primaryOf(vector("Severable", { reachableSystems: 40, bridgeLinks: 4 }), vector("Clean", {})), "Clean",
    "and loses when its branch hangs on severable links");

  // Reach must still carry weight: 40 + 8 + 6 - 12 = 42 beats 4 + 8 + 6 = 18.
  // Zero the reach term and the cramped exit wins instead.
  t.equal(primaryOf(vector("Wide", { reachableSystems: 40, globalChokes: 1 }), vector("Cramped", { reachableSystems: 4 })), "Wide",
    "but reach still counts: one choke does not outweigh ten times the space");

  // Frontier systems carry a smaller weight, so it only shows against a
  // competing reach advantage: 20 + 20 + 6 = 46 beats 30 + 0 + 6 = 36.
  t.equal(primaryOf(vector("Open", { frontierSystems: 10 }), vector("Deep", { reachableSystems: 30, frontierSystems: 0 })), "Open",
    "an exit opening onto a wide frontier beats a slightly roomier dead end");

  // Hunt and escape must not be the same ranking wearing two labels.
  const huntOrder = hunt.items.map(item => item.system.system_id).join(",");
  const escapeOrder = escape.items.map(item => item.system.system_id).join(",");
  t.check(huntOrder !== escapeOrder || report.approaches.length <= 1,
    "hunt and escape rank differently; they are not one ordering with two names");

  const deep = analyzer.analyze("1DQ1-A", 3);
  t.check(deep.chokes.every(entry => entry.betweenness >= 0), "a null-security brief also ranks cleanly");


  // The approach-vector list covers standard gates and nothing else, and a
  // list of "the ways they can arrive" implies completeness it does not have.
  // Ansiblex bridges and cynos both put hostiles in a system that appears
  // nowhere on it, so the brief has to say so rather than leave it inferred.
  for (const preset of ["hunt", "escape", "recon"]) {
    const brief = buildOperationalBrief(report, preset);
    t.check(/Ansiblex/i.test(brief.caveat), `${preset}: the brief warns that bridges bypass this list`);
    t.check(/cyno/i.test(brief.caveat), `${preset}: and that cynos do too`);
    t.check(/standard gates only/i.test(brief.caveat), `${preset}: and says what it does cover`);
  }

  return t.results;
}
