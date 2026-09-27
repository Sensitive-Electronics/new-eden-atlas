// Capital jump navigation over the static archive.
//
// Everything here is geometry plus values taken from CCP's own export. Ranges
// and fuel rates come from data/ships.json, which the builder reads out of the
// SDE's dogma attributes, and the skill scaling comes from the skill records in
// the same file. No jump figure in this module is a remembered constant.
//
// What is NOT modelled, and why:
//
//   Cynosural availability, ship mass, capacitor state, and whether anyone can
//   actually light a cyno where you are going.
//
// Jump fatigue is PARTLY modelled. The SDE states the part that is a ship
// statistic: jumpFatigueMultiplier, which the hull's own trait text describes
// as a "reduction to effective distance traveled for jump fatigue" - 0.1 on
// jump freighters and the Rorqual, 0.25 on black ops, absent elsewhere. The
// effective distance a jump contributes is therefore derived, not guessed.
//
// The rule by which that distance becomes fatigue minutes and a cooldown is
// NOT in the static export. It is applied from the constants in
// data/ships.json under fatigueModel, which are marked there as coming from
// outside the archive, so a wrong or outdated constant is corrected in one
// place without touching this module. Anything the model produces is labelled
// as a model wherever it is shown.
//
// Those constants and the order they are applied in are pinned against CCP's
// own worked examples, in tests/jump-planner.test.mjs: an Archon making three
// 5 ly jumps and an Ark making three 10 ly jumps. Six published figures, all
// reproduced. The examples are historical, so they fix the FORMULA only; the
// current 300-minute and 30-minute caps come from the live rules and are
// tested separately.

// The one definition of the boundary, imported rather than repeated.
//
// `HIGH_SECURITY` is 0.45 and not 0.5 because that is where the client's rounding
// puts the line, and 119 systems sit in the gap. A second copy here would be a
// specific failure rather than a cosmetic one: a cynosural field cannot be lit in
// high security, so if the boundary moved, the map and the router would follow it
// and this planner would not - offering capitals arrivals the rest of the
// application calls high security.
import { HIGH_SECURITY } from "./map-utils.js";

export const METERS_PER_LIGHT_YEAR = 9_460_730_472_580_800;

// Wormhole space cannot be jumped to. Region identifiers in this band are
// wormhole regions in the SDE.
const WORMHOLE_REGION_MIN = 11000000;
const WORMHOLE_REGION_MAX = 12000000;

function normalizeName(value) {
  // `toLowerCase`, not `toLocaleLowerCase`: the latter is host-locale dependent, and
  // under a Turkish locale "Itamo" lowercases to a dotless i, which makes 530 system
  // names impossible to type.
  return String(value ?? "").trim().toLowerCase();
}

export function skillMultiplier(perLevelPercent, level) {
  const bonus = Number(perLevelPercent);
  if (!Number.isFinite(bonus)) return 1;
  return 1 + (bonus * Math.max(0, Math.min(5, Number(level) || 0))) / 100;
}

export class JumpPlanner {
  constructor(atlas, shipData) {
    this.atlas = atlas;
    this.systems = atlas.systems;
    this.ships = (shipData?.ships ?? []).slice();
    this.skills = shipData?.skills ?? {};
    this.fuelTypes = shipData?.fuel_types ?? {};
    // Not from the SDE. Absent or malformed, fatigue is simply not reported.
    this.fatigueModel = shipData?.fatigue_model ?? null;
    // Fitted modules that cut jump fuel. A scan of the whole export found no
    // implant or booster that affects jump range, fuel or fatigue, so these
    // three meta variants are the only fitted term there is.
    this.fuelModules = shipData?.fuel_modules ?? [];

    this.byName = new Map();
    this.byShipName = new Map(this.ships.map(ship => [normalizeName(ship.name), ship]));

    // Coordinates in light-years, computed once. A jump is a straight line
    // between system centres, which is what the game measures too.
    this.points = new Map();
    this.jumpable = [];
    for (const system of Object.values(this.systems)) {
      this.byName.set(normalizeName(system.name), system);
      // A system with no stargate is not somewhere a fleet can be. In K-space
      // these are the Jove regions and the Abyssal proving grounds: 618
      // systems that are unreachable and cannot host a cynosural field, so a
      // route through one would be fiction.
      if (this.isWormhole(system) || !system.neighbors.length) continue;
      const [x, y, z] = system.position;
      this.points.set(system.system_id, [
        x / METERS_PER_LIGHT_YEAR,
        y / METERS_PER_LIGHT_YEAR,
        z / METERS_PER_LIGHT_YEAR,
      ]);
      this.jumpable.push(system);
    }

    this.grid = null;
    this.gridCell = 0;
  }

  isWormhole(system) {
    return system.region_id >= WORMHOLE_REGION_MIN && system.region_id < WORMHOLE_REGION_MAX;
  }

  isReachable(system) {
    return Boolean(system) && !this.isWormhole(system) && system.neighbors.length > 0;
  }

  // These systems are geometrically close to known space but do not accept
  // ordinary cynosural arrivals. They remain valid origins so a hull already
  // there can plan an outbound jump.
  isRestrictedArrival(system) {
    const regionName = this.atlas.regions[system?.region_id]?.name;
    return regionName === "Pochven" || system?.name === "Zarzakh";
  }

  resolveSystem(value) {
    const query = normalizeName(value);
    if (!query) return null;
    if (this.byName.has(query)) return this.byName.get(query);
    const matches = [];
    for (const [name, system] of this.byName) {
      if (name.startsWith(query)) matches.push(system);
      if (matches.length > 1) break;
    }
    return matches.length === 1 ? matches[0] : null;
  }

  resolveShip(value) {
    const query = normalizeName(value);
    if (!query) return null;
    if (this.byShipName.has(query)) return this.byShipName.get(query);
    const matches = [];
    for (const [name, ship] of this.byShipName) {
      if (name.startsWith(query)) matches.push(ship);
      if (matches.length > 1) break;
    }
    return matches.length === 1 ? matches[0] : null;
  }

  rangeFor(ship, calibrationLevel = 5) {
    const bonus = this.skills["Jump Drive Calibration"]?.range_bonus_per_level;
    return Number(ship.base_range_ly) * skillMultiplier(bonus, calibrationLevel);
  }

  // Two multipliers, not one. Jump Fuel Conservation applies to every jump drive,
  // and a hull may carry a further per-level bonus in its own traits, which every
  // jump freighter does ("10% reduction in jump fuel requirement" per level of Jump
  // Freighters). Missing the second doubles every freighter fuel figure.
  fuelModule(typeId) {
    if (typeId === null || typeId === undefined || typeId === "") return null;
    return this.fuelModules.find(module => String(module.type_id) === String(typeId)) ?? null;
  }

  fuelPerLy(ship, conservationLevel = 5, hullSkillLevel = 5, moduleTypeId = null) {
    const conservation = skillMultiplier(this.skills["Jump Fuel Conservation"]?.fuel_bonus_per_level, conservationLevel);
    const hull = ship.hull_fuel_bonus
      ? skillMultiplier(ship.hull_fuel_bonus.percent_per_level, hullSkillLevel)
      : 1;
    const module = this.fuelModule(moduleTypeId);
    const fitted = module ? 1 + module.fuel_bonus_percent / 100 : 1;
    return Number(ship.base_fuel_per_ly) * conservation * hull * fitted;
  }

  rangeMultiplierFor(ship, hullSkillLevel = 5) {
    return ship.hull_range_bonus ? skillMultiplier(ship.hull_range_bonus.percent_per_level, hullSkillLevel) : 1;
  }

  // The distance a jump contributes to fatigue, after the hull's reduction.
  // This part is a ship statistic and comes straight from the export.
  fatigueDistance(ship, lightYears) {
    const multiplier = ship.fatigue_multiplier === null || ship.fatigue_multiplier === undefined
      ? 1
      : Number(ship.fatigue_multiplier);
    return lightYears * multiplier;
  }

  // Applies the configured model to a sequence of effective distances.
  // Returns null when no model is configured, rather than inventing one.
  //
  // Three details decide whether the numbers are right:
  //
  // 1. The cooldown is computed BEFORE fatigue is recalculated, from the fatigue the
  //    pilot carried into the jump. Deriving it from the new fatigue inflates every
  //    cooldown after the first.
  // 2. Fatigue is floored at 10 minutes before multiplying, not 1, so a first
  //    unreduced 5 ly jump produces 60 minutes and not 6.
  // 3. Fatigue decays in real time, and the pilot spends the cooldown waiting.
  //    Without that decay a chain compounds too fast: CCP's own Archon example
  //    reaches 324 minutes on its second jump, and 360 if the wait is ignored.
  //
  // schedule() therefore models jumping again at the earliest moment allowed.
  // Pass waitMinutes to model a pilot who waits longer than required.
  fatigueOver(effectiveDistances, startingFatigueMinutes = 0, waitMinutes = null) {
    const model = this.fatigueModel;
    if (!model) return null;

    const clamp = (value, cap) => (cap === null || cap === undefined ? value : Math.min(cap, value));
    let fatigue = Math.max(0, Number(startingFatigueMinutes) || 0);
    let elapsed = 0;
    const steps = [];
    const distances = [...effectiveDistances];

    distances.forEach((distance, index) => {
      const fatigueBefore = fatigue;
      const cooldown = clamp(
        Math.max(1 + distance, fatigueBefore / model.cooldownDivisor),
        model.cooldownCapMinutes,
      );
      fatigue = clamp(Math.max(fatigueBefore, model.floorMinutes) * (1 + distance), model.capMinutes);
      steps.push({
        effectiveLy: distance,
        fatigueBeforeMinutes: fatigueBefore,
        fatigueMinutes: fatigue,
        cooldownMinutes: cooldown,
        atCap: model.capMinutes !== null && fatigue >= model.capMinutes - 1e-9,
      });
      if (index < distances.length - 1) {
        // The pilot waits out the cooldown, or longer if asked, and fatigue
        // decays over that wait. This is travel time, not the final timer.
        const wait = waitMinutes === null ? cooldown : Math.max(cooldown, Number(waitMinutes) || 0);
        elapsed += wait;
        fatigue = Math.max(0, fatigue - wait * model.decayMinutesPerMinute);
      }
    });

    const finalCooldown = steps.length ? steps.at(-1).cooldownMinutes : 0;
    return {
      steps,
      finalFatigueMinutes: fatigue,
      // Time spent waiting between jumps to fly the chain at the earliest
      // legal pace. It deliberately excludes the last cooldown, which is
      // served after arrival and delays the NEXT jump, not this journey.
      travelWaitMinutes: elapsed,
      finalCooldownMinutes: finalCooldown,
      totalCooldownMinutes: elapsed + finalCooldown,
      cappedOut: steps.some(step => step.atCap),
      model,
    };
  }

  fuelTypeName(ship) {
    return this.fuelTypes[String(ship.fuel_type_id)] ?? "isotopes";
  }

  distanceLy(fromId, toId) {
    const a = this.points.get(fromId);
    const b = this.points.get(toId);
    if (!a || !b) return Infinity;
    return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  }

  // A uniform grid keyed to the search range, so finding everything within one
  // jump touches a handful of cells instead of all 8,000 systems.
  buildGrid(cell) {
    if (this.grid && Math.abs(this.gridCell - cell) < 1e-9) return this.grid;
    const grid = new Map();
    for (const system of this.jumpable) {
      const [x, y, z] = this.points.get(system.system_id);
      const key = `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
      let bucket = grid.get(key);
      if (!bucket) grid.set(key, (bucket = []));
      bucket.push(system);
    }
    this.grid = grid;
    this.gridCell = cell;
    return grid;
  }

  systemsInRange(originId, rangeLy, { allowHighSec = false, excludeOrigin = true } = {}) {
    const origin = this.points.get(originId);
    if (!origin) return [];
    const cell = Math.max(rangeLy, 0.5);
    const grid = this.buildGrid(cell);
    const [ox, oy, oz] = origin;
    const base = [Math.floor(ox / cell), Math.floor(oy / cell), Math.floor(oz / cell)];
    const found = [];

    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dz = -1; dz <= 1; dz += 1) {
          const bucket = grid.get(`${base[0] + dx},${base[1] + dy},${base[2] + dz}`);
          if (!bucket) continue;
          for (const system of bucket) {
            if (excludeOrigin && system.system_id === originId) continue;
            if (this.isRestrictedArrival(system)) continue;
            if (!allowHighSec && this.isHighSecurity(system)) continue;
            const distance = this.distanceLy(originId, system.system_id);
            if (distance <= rangeLy) found.push({ system, distanceLy: distance });
          }
        }
      }
    }
    found.sort((a, b) => a.distanceLy - b.distanceLy || a.system.name.localeCompare(b.system.name));
    return found;
  }

  // A cynosural field cannot be lit in high security space, so a capital
  // cannot arrive there. This is a game rule, not something the static archive
  // states, which is why it is an explicit option rather than a silent filter.
  isHighSecurity(system) {
    return Number(system.security) >= HIGH_SECURITY;
  }

  // Everything reachable in one jump, as sets the map can mark against.
  // Membership is decided by real three-dimensional distance, never by where
  // a system happens to land on a two-dimensional map.
  rangeSet(originId, rangeLy, { allowHighSec = false } = {}) {
    const entries = this.systemsInRange(originId, rangeLy, { allowHighSec });
    return {
      originId,
      rangeLy,
      allowHighSec,
      entries,
      systemIds: new Set(entries.map(entry => entry.system.system_id)),
      regionIds: new Set(entries.map(entry => entry.system.region_id)),
    };
  }

  plan(fromValue, toValue, options = {}) {
    // No arbitrary cap. The jump graph is finite, so the search ends when the
    // frontier does: a titan crossing New Eden needs 26 jumps and an untrained pilot
    // at 3 ly can need 67, so a low cap turns real routes into a flat "no route"
    // claim. `maxJumps` is a constraint the caller may impose, and hitting it says so
    // rather than denying the route exists.
    const { shipValue, calibration = 5, conservation = 5, hullSkill = 5, fuelModule = null, maxJumps = Infinity } = options;

    const ship = this.resolveShip(shipValue);
    if (!ship) throw new Error(`Ship not found or ambiguous: ${shipValue || "(empty)"}`);

    const origin = this.resolveSystem(fromValue);
    const destination = this.resolveSystem(toValue);
    if (!origin) throw new Error(`Origin system not found or ambiguous: ${fromValue || "(empty)"}`);
    if (!destination) throw new Error(`Destination system not found or ambiguous: ${toValue || "(empty)"}`);

    if (!this.isReachable(origin)) {
      throw new Error(`${origin.name} is not on the stargate network and cannot be jumped from.`);
    }
    if (!this.isReachable(destination)) {
      throw new Error(`${destination.name} is not on the stargate network and cannot be jumped to.`);
    }
    if (this.isHighSecurity(destination)) {
      throw new Error(`${destination.name} is high security, where a cynosural field cannot be lit.`);
    }
    if (this.isRestrictedArrival(destination)) {
      throw new Error(`${destination.name} does not accept ordinary cynosural arrivals.`);
    }

    const range = this.rangeFor(ship, calibration) * this.rangeMultiplierFor(ship, hullSkill);
    const perLy = this.fuelPerLy(ship, conservation, hullSkill, fuelModule);

    if (origin.system_id === destination.system_id) {
      return this.describe(ship, [origin], [], range, perLy, calibration, conservation, hullSkill, false, fuelModule);
    }

    // Breadth-first over the jump graph: every jump costs one, so the first
    // arrival is a route with the fewest jumps.
    const previous = new Map([[origin.system_id, null]]);
    let frontier = [origin.system_id];
    let depth = 0;
    let reached = false;

    while (frontier.length && depth < maxJumps && !reached) {
      const next = [];
      for (const currentId of frontier) {
        for (const { system } of this.systemsInRange(currentId, range)) {
          if (previous.has(system.system_id)) continue;
          previous.set(system.system_id, currentId);
          if (system.system_id === destination.system_id) { reached = true; break; }
          next.push(system.system_id);
        }
        if (reached) break;
      }
      frontier = next;
      depth += 1;
    }

    if (!previous.has(destination.system_id)) {
      if (Number.isFinite(maxJumps) && depth >= maxJumps && frontier.length) {
        throw new Error(
          `${destination.name} was not reached within ${maxJumps} jumps. The search stopped at that limit; ` +
          "a longer route may exist.");
      }
      throw new Error(
        `No jump route from ${origin.name} to ${destination.name} within ${range.toFixed(2)} ly per jump` +
        ", excluding restricted and high-security arrivals.");
    }

    const path = [destination.system_id];
    while (previous.get(path[0]) !== null) path.unshift(previous.get(path[0]));

    const legs = [];
    for (let i = 1; i < path.length; i += 1) {
      const distance = this.distanceLy(path[i - 1], path[i]);
      legs.push({
        from: this.systems[path[i - 1]],
        to: this.systems[path[i]],
        distanceLy: distance,
        fuel: distance * perLy,
        // Fuel is drawn per jump, so the integer is decided per leg. Deciding it
        // here rather than at display time is what keeps the legs and the total
        // agreeing: rounded independently, a Jita to 1DQ1-A Ark run reports 117,323
        // against legs summing to 117,325.
        fuelUnits: Math.ceil(distance * perLy),
      });
    }

    return this.describe(ship, path.map(id => this.systems[id]), legs, range, perLy, calibration, conservation, hullSkill, false, fuelModule);
  }

  describe(ship, systems, legs, range, perLy, calibration, conservation, hullSkill, allowHighSec, fuelModuleUsed = null) {
    const totalLy = legs.reduce((sum, leg) => sum + leg.distanceLy, 0);
    const effective = legs.map(leg => this.fatigueDistance(ship, leg.distanceLy));
    const fatigue = this.fatigueOver(effective);
    return {
      ship,
      systems,
      legs,
      jumps: legs.length,
      rangeLy: range,
      fuelPerLy: perLy,
      fuelTypeName: this.fuelTypeName(ship),
      totalLy,
      // The sum of what is actually drawn at each gate, so it always equals
      // the legs shown beside it. totalFuelRaw keeps the unrounded figure for
      // anything comparing plans rather than loading a ship.
      totalFuel: legs.reduce((sum, leg) => sum + leg.fuelUnits, 0),
      totalFuelRaw: legs.reduce((sum, leg) => sum + leg.fuel, 0),
      longestLeg: legs.reduce((longest, leg) => Math.max(longest, leg.distanceLy), 0),
      calibration,
      conservation,
      hullSkill,
      allowHighSec,
      fuelTypeId: ship.fuel_type_id,
      fuelModule: this.fuelModule(fuelModuleUsed),
      hullFuelBonus: ship.hull_fuel_bonus ?? null,
      effectiveLy: effective.reduce((sum, value) => sum + value, 0),
      fatigue,
      fatigueMultiplier: ship.fatigue_multiplier ?? null,
      regions: [...new Set(systems.map(s => this.atlas.regions[s.region_id].name))],
    };
  }
}
