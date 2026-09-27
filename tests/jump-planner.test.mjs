import { readArchive, readShips, suite } from "./helpers.mjs";
import { JumpPlanner, skillMultiplier } from "../web/jump-planner.js";

export default function run(app) {
  const t = suite("jump planner");
  const atlas = readArchive();
  const shipData = readShips();
  const planner = new JumpPlanner(atlas, shipData);

  // --- the data is CCP's, not remembered --------------------------------
  t.check(shipData.ships.length > 40, `${shipData.ships.length} jump-capable hulls extracted from the SDE`);
  t.check(shipData.ships.every(s => s.base_range_ly > 0 && s.base_fuel_per_ly > 0),
    "every hull carries a base range and fuel rate");
  t.check(!shipData.ships.some(s => /jump bridge|jump portal/i.test(s.group)),
    "structures are excluded from the ship list");
  t.equal(shipData.skills["Jump Drive Calibration"].range_bonus_per_level, 20,
    "the range bonus per level is read from the skill, not hard-coded");
  t.equal(shipData.skills["Jump Fuel Conservation"].fuel_bonus_per_level, -10,
    "and so is the fuel bonus");

  t.equal(skillMultiplier(20, 5), 2, "a +20%/level skill doubles at level 5");
  t.equal(skillMultiplier(-10, 5), 0.5, "a -10%/level skill halves at level 5");
  t.equal(skillMultiplier(20, 0), 1, "level 0 is no bonus");
  t.equal(skillMultiplier(20, 99), 2, "levels above 5 are clamped");
  t.equal(skillMultiplier(null, 5), 1, "a missing bonus is no bonus");

  // These are the figures the game is known for, but they are DERIVED here.
  const ark = planner.resolveShip("Ark");
  const archon = planner.resolveShip("Archon");
  const avatar = planner.resolveShip("Avatar");
  t.equal(planner.rangeFor(ark, 5), 10, "a jump freighter reaches 10.0 ly at Calibration V");
  t.equal(planner.rangeFor(archon, 5), 7, "a carrier reaches 7.0 ly");
  t.equal(planner.rangeFor(avatar, 5), 6, "a titan reaches 6.0 ly");
  t.equal(planner.rangeFor(ark, 0), 5, "and an untrained pilot gets the hull's base 5.0 ly");
  // Two multipliers stack on a jump freighter: Jump Fuel Conservation, and the
  // hull's own "10% reduction in jump fuel requirement" per level of Jump
  // Freighters. Applying only the first made every freighter figure double.
  t.equal(planner.fuelPerLy(ark, 0, 0), 8800, "untrained, fuel is the hull base");
  t.equal(planner.fuelPerLy(ark, 5, 0), 4400, "Conservation V alone halves it");
  t.equal(planner.fuelPerLy(ark, 0, 5), 4400, "the hull skill alone halves it");
  t.equal(planner.fuelPerLy(ark, 5, 5), 2200, "both at V quarter it");
  t.check(ark.hull_fuel_bonus && /jump fuel/i.test(ark.hull_fuel_bonus.trait),
    `the hull bonus is read from the SDE trait text: "${ark.hull_fuel_bonus?.trait}"`);
  t.equal(ark.hull_fuel_bonus.skill, "Jump Freighters", "and is tied to the right skill");

  // A hull without that bonus must be unaffected by the hull skill level.
  t.equal(planner.fuelPerLy(archon, 5, 0), planner.fuelPerLy(archon, 5, 5),
    "a carrier has no hull fuel bonus, so the hull skill changes nothing");
  t.equal(planner.fuelPerLy(archon, 5, 5), 1500, "and burns half its base at Conservation V");

  // The four racial isotopes, one per hull, straight from the export.
  const fuels = new Set(planner.ships.map(s => planner.fuelTypeName(s)));
  t.equal(fuels.size, 4, `exactly four fuel types across every hull: ${[...fuels].sort().join(", ")}`);
  t.equal(planner.fuelTypeName(ark), "Helium Isotopes", "the Ark burns Helium");
  t.equal(planner.fuelTypeName(planner.resolveShip("Rhea")), "Nitrogen Isotopes", "the Rhea burns Nitrogen");
  t.equal(planner.fuelTypeName(planner.resolveShip("Nomad")), "Hydrogen Isotopes", "the Nomad burns Hydrogen");
  t.equal(planner.fuelTypeName(planner.resolveShip("Anshar")), "Oxygen Isotopes", "the Anshar burns Oxygen");
  t.check(planner.fuelTypeName(ark).length > 0, `fuel type resolves to a name (${planner.fuelTypeName(ark)})`);

  // --- fitted fuel modules ------------------------------------------------
  // A sweep of the whole export found no implant or booster touching jump
  // range, fuel or fatigue. These three modules are the only fitted term.
  t.check(shipData.fuel_modules.length === 3,
    `${shipData.fuel_modules.length} fuel modules extracted: ${shipData.fuel_modules.map(m => m.name).join(", ")}`);
  t.check(shipData.fuel_modules.every(m => m.fuel_bonus_percent < 0), "every one reduces fuel");
  // Listed weakest first, as a picker should read.
  t.check(shipData.fuel_modules.every((m, i) => i === 0 || m.fuel_bonus_percent <= shipData.fuel_modules[i - 1].fuel_bonus_percent),
    "modules are listed from weakest reduction to strongest");
  const best = shipData.fuel_modules.at(-1);
  t.equal(best.fuel_bonus_percent, -10, `the strongest is a 10% reduction (${best.name})`);
  t.equal(planner.fuelPerLy(ark, 5, 5, best.type_id), 1980, "fitting it takes the Ark from 2200 to 1980 per ly");
  t.equal(planner.fuelPerLy(ark, 5, 5, null), 2200, "and omitting it changes nothing");
  t.equal(planner.fuelPerLy(ark, 5, 5, ""), 2200, "an empty selection is treated as no module");
  t.equal(planner.fuelPerLy(ark, 5, 5, 999999), 2200, "an unknown module is ignored rather than throwing");
  t.check(planner.plan("Jita", "1DQ1-A", { shipValue: "Ark", fuelModule: best.type_id }).totalFuel
    < planner.plan("Jita", "1DQ1-A", { shipValue: "Ark" }).totalFuel,
    "and a plan with one fitted burns less");

  // --- fuel rounding ------------------------------------------------------
  // Fuel is drawn per jump, so the integer is decided per leg and the total is
  // the sum of those integers. Rounding the raw total separately made the
  // summary disagree with the legs printed directly beneath it: a Jita to
  // 1DQ1-A Ark run showed 117,323 against legs summing to 117,325.
  for (const shipValue of ["Ark", "Panther", "Archon"]) {
    const plan = planner.plan("Jita", "1DQ1-A", { shipValue });
    const legs = plan.legs.reduce((sum, leg) => sum + leg.fuelUnits, 0);
    t.equal(plan.totalFuel, legs, `${shipValue}: the total equals the legs shown beside it`);
    t.check(Number.isInteger(plan.totalFuel), `${shipValue}: and is a whole number of units`);
    t.check(plan.legs.every(leg => Number.isInteger(leg.fuelUnits)),
      `${shipValue}: as is every leg`);
    t.check(plan.totalFuel >= plan.totalFuelRaw,
      `${shipValue}: rounding up never reports less fuel than the trip needs`);
    t.check(plan.totalFuel - plan.totalFuelRaw < plan.legs.length,
      `${shipValue}: and never overstates it by more than one unit per jump`);
  }
  t.equal(planner.plan("Jita", "1DQ1-A", { shipValue: "Ark" }).totalFuel, 117325,
    "the Ark run reports 117,325, the figure its own legs add up to");

  // --- jump fatigue -------------------------------------------------------
  // The hull's reduction to effective distance IS in the export. The rule
  // turning distance into minutes is not, and lives in the data file.
  t.equal(planner.fatigueDistance(ark, 10), 1, "a jump freighter's 0.1 multiplier cuts 10 ly to 1 effective");
  t.equal(planner.fatigueDistance(planner.resolveShip("Redeemer"), 10), 2.5, "black ops cut it to 2.5");
  t.equal(planner.fatigueDistance(archon, 10), 10, "a carrier gets no reduction at all");
  t.check(shipData.fatigue_model && /not present in the Static Data Export/i.test(shipData.fatigue_model.source),
    "the fatigue model declares that it is not from the archive");

  // CCP's own worked examples, from the Phoebe travel-change dev blog. These
  // are the authority for the FORMULA and nothing else: they were published
  // under a 30-day fatigue cap, so the Archon's later figures exceed today's
  // 300-minute cap and could not be reproduced with the live constants. The
  // caps are therefore lifted here and tested separately below.
  //
  // Every number on the right is CCP's, not this implementation's. If the
  // order of operations drifts, these fail.
  const historical = new JumpPlanner(atlas, {
    ...shipData,
    fatigue_model: { ...shipData.fatigue_model, capMinutes: 43200, cooldownCapMinutes: null },
  });
  const round = value => Math.round(value * 100) / 100;
  const published = (distances, expected, label) => {
    const steps = historical.fatigueOver(distances).steps;
    t.equal(steps.length, expected.length, `${label}: one step per jump`);
    expected.forEach(([fatigue, cooldown], index) => {
      t.equal(round(steps[index].fatigueMinutes), fatigue,
        `${label} jump ${index + 1}: ${fatigue} minutes of fatigue`);
      t.equal(round(steps[index].cooldownMinutes), cooldown,
        `${label} jump ${index + 1}: ${cooldown} minute cooldown`);
    });
  };

  // "Archon ... three jumps of 5LY each": 60/6, 324/6, 1908/31.8.
  published([5, 5, 5], [[60, 6], [324, 6], [1908, 31.8]], "CCP's Archon example");
  // "Ark ... three jumps of 10LY", 0.1 multiplier making each 1 ly effective:
  // 20/2, 36/2, 68/3.4.
  published([1, 1, 1], [[20, 2], [36, 2], [68, 3.4]], "CCP's Ark example");

  // The Ark figures must also be reachable from a real hull's own multiplier
  // rather than from a hand-supplied 1, or the reduction is not wired up.
  t.equal(round(historical.fatigueOver([10, 10, 10].map(ly => historical.fatigueDistance(ark, ly)))
    .steps.at(-1).fatigueMinutes), 68,
    "and the Ark's own 0.1 multiplier reproduces them from the 10 ly distances CCP quoted");

  // Each of the three rules that were previously wrong, isolated. Without the
  // decay across the wait, jump two reads 360 rather than CCP's 324; without
  // the 10-minute floor, a first 5 ly jump reads 6 rather than 60; and reading
  // the cooldown after recalculation makes jump one 6 rather than 6 but jump
  // two 32.4 rather than 6.
  t.equal(round(historical.fatigueOver([5]).steps[0].fatigueMinutes), 60,
    "a first unreduced 5 ly jump is 60 minutes of fatigue, not 6");
  t.equal(round(historical.fatigueOver([5]).steps[0].cooldownMinutes), 6,
    "with a 6 minute cooldown");
  t.equal(round(historical.fatigueOver([5, 5]).steps[1].cooldownMinutes), 6,
    "the second cooldown is read from the fatigue carried into the jump, not the fatigue it creates");
  t.equal(round(historical.fatigueOver([5, 5]).steps[1].fatigueBeforeMinutes), 54,
    "which is 60 decayed by the 6 minutes spent waiting out the first cooldown");

  // Waiting longer than required decays more, so the chain fatigues less.
  t.check(historical.fatigueOver([5, 5, 5], 0, 60).finalFatigueMinutes
    < historical.fatigueOver([5, 5, 5]).finalFatigueMinutes,
    "a pilot who waits longer than the cooldown arrives less fatigued");
  t.equal(round(historical.fatigueOver([5, 5], 0, 60).steps[1].fatigueBeforeMinutes), 0,
    "and an hour's wait clears 60 minutes of fatigue entirely");

  // The live caps, which the historical examples cannot test.
  const live = shipData.fatigue_model;
  t.equal(live.capMinutes, 300, "fatigue is capped at 5 hours");
  t.equal(live.cooldownCapMinutes, 30, "and the cooldown at 30 minutes");
  const capped = planner.fatigueOver([5, 5, 5, 5, 5]);
  t.check(capped.steps.every(step => step.fatigueMinutes <= 300 + 1e-9),
    "no step exceeds the fatigue cap");
  t.check(capped.steps.every(step => step.cooldownMinutes <= 30 + 1e-9),
    "and none exceeds the cooldown cap");
  t.check(capped.cappedOut, "a long carrier chain reports that it reached the cap");
  t.equal(round(planner.fatigueOver([5, 5]).steps[1].fatigueMinutes), 300,
    "the second 5 ly carrier jump is held at 300 rather than CCP's historical 324");

  // Travel waits and the final timer are different things and must be reported
  // separately: the last cooldown delays the NEXT journey, not this one.
  const chain = planner.fatigueOver([2, 2, 2]);
  t.equal(round(chain.travelWaitMinutes),
    round(chain.steps[0].cooldownMinutes + chain.steps[1].cooldownMinutes),
    "travel waiting counts the cooldowns actually served en route");
  t.equal(round(chain.finalCooldownMinutes), round(chain.steps.at(-1).cooldownMinutes),
    "the final cooldown is the one served after arrival");
  t.equal(round(chain.totalCooldownMinutes), round(chain.travelWaitMinutes + chain.finalCooldownMinutes),
    "and the total is the two added, with nothing double-counted");
  t.equal(planner.fatigueOver([5]).travelWaitMinutes, 0,
    "a single jump involves no waiting en route at all");

  // Cooldown can never fall below 1 + the effective distance.
  t.check(planner.fatigueOver([0.5, 0.5, 0.5]).steps.every((step, i) =>
    step.cooldownMinutes >= 1 + [0.5, 0.5, 0.5][i] - 1e-9),
    "every cooldown is at least one minute plus the effective light years jumped");

  const fatiguePlan = planner.plan("Jita", "1DQ1-A", { shipValue: "Ark" });
  t.check(fatiguePlan.fatigue !== null, "a plan carries a fatigue projection");
  t.equal(fatiguePlan.fatigue.steps.length, fatiguePlan.jumps, "one fatigue step per jump");
  t.check(Math.abs(fatiguePlan.effectiveLy - fatiguePlan.totalLy * 0.1) < 1e-6,
    "effective distance is the actual distance after the hull reduction");
  t.check(fatiguePlan.effectiveLy < fatiguePlan.totalLy, "which is less than the distance actually flown");

  // The same route in a hull with no reduction must fatigue harder.
  const carrierFatigue = planner.plan("Jita", "1DQ1-A", { shipValue: "Archon" });
  t.check(carrierFatigue.effectiveLy > fatiguePlan.effectiveLy,
    "a carrier accrues far more effective distance than a freighter over the same trip");
  t.check(carrierFatigue.fatigue.finalFatigueMinutes >= fatiguePlan.fatigue.finalFatigueMinutes,
    "and therefore at least as much fatigue");
  t.check(carrierFatigue.fatigue.cappedOut, "long carrier chains reach the model's cap, and say so");

  // A missing model must disable the projection, never invent one.
  const modelless = new JumpPlanner(atlas, { ...shipData, fatigue_model: null });
  t.check(modelless.fatigueOver([1, 2, 3]) === null, "with no model configured, no fatigue is reported");
  t.check(modelless.plan("Jita", "1DQ1-A", { shipValue: "Ark" }).fatigue === null,
    "and a plan simply carries none");
  t.check(modelless.plan("Jita", "1DQ1-A", { shipValue: "Ark" }).effectiveLy > 0,
    "while the effective distance, which the archive does state, is still reported");

  // --- what can be jumped to --------------------------------------------
  t.equal(planner.jumpable.length, 5268, "only systems on the stargate network are jumpable");
  t.check(planner.jumpable.every(s => !planner.isWormhole(s)), "no wormhole system is jumpable");
  t.check(planner.jumpable.every(s => s.neighbors.length > 0),
    "no gateless system is jumpable: the Jove regions and Abyssal grounds are excluded");

  const jita = planner.resolveSystem("Jita");
  const inRange = planner.systemsInRange(jita.system_id, 7);
  t.check(inRange.length > 0, `${inRange.length} systems lie within 7 ly of Jita`);
  t.check(inRange.every(e => e.distanceLy <= 7), "every one is genuinely within range");
  t.check(inRange.every(e => e.system.security < 0.45), "and none is high security by default");
  t.check(inRange.every((e, i) => i === 0 || inRange[i - 1].distanceLy <= e.distanceLy), "sorted by distance");
  t.check(planner.systemsInRange(jita.system_id, 7, { allowHighSec: true }).length > inRange.length,
    "a geometric range display can include high security systems");

  // The grid must not change the answer. Brute force says the same thing.
  const brute = planner.jumpable.filter(s =>
    s.system_id !== jita.system_id && !planner.isRestrictedArrival(s)
    && s.security < 0.45 && planner.distanceLy(jita.system_id, s.system_id) <= 7);
  t.equal(inRange.length, brute.length, "the spatial grid agrees with an exhaustive scan");

  // --- planning ----------------------------------------------------------
  const plan = planner.plan("Jita", "1DQ1-A", { shipValue: "Ark" });
  t.check(plan.jumps > 0, `Jita to 1DQ1-A takes ${plan.jumps} jumps in an Ark`);
  t.check(plan.legs.every(leg => leg.distanceLy <= plan.rangeLy + 1e-9), "no leg exceeds the ship's range");
  t.check(plan.systems.slice(1).every(s => s.security < 0.45), "no leg arrives in high security");
  t.check(plan.systems.every(s => planner.isReachable(s)), "every system on the plan is on the gate network");
  t.check(plan.systems.slice(1).every(s => !planner.isRestrictedArrival(s)),
    "no leg arrives in Pochven or Zarzakh");

  // ...which on this plan proves nothing, and did not for a long time.
  //
  // No restricted system is ever within range at any point of Jita to 1DQ1-A,
  // so that assertion could not fail however the exclusion was written. A
  // temptation is required: Urhinichi sits in Pochven **0.31 ly** from Inaro,
  // which is inside the range of every capital in the game, so an origin there
  // is a real chance to get this wrong rather than a hypothetical one.
  const inaro = planner.resolveSystem("Inaro");
  const urhinichi = planner.resolveSystem("Urhinichi");
  t.check(planner.isRestrictedArrival(urhinichi), "Urhinichi is a restricted arrival");
  t.check(planner.distanceLy(inaro.system_id, urhinichi.system_id) < 1,
    `and sits ${planner.distanceLy(inaro.system_id, urhinichi.system_id).toFixed(2)} ly from Inaro, well inside any capital's range`);

  const tempted = planner.rangeSet(inaro.system_id, 5, { allowHighSec: false });
  t.check(tempted.entries.length > 0, "a range set from Inaro finds systems at all");
  t.check(!tempted.entries.some(entry => entry.system.system_id === urhinichi.system_id),
    "and excludes the Pochven system half a light year away, which a capital cannot enter");
  t.check(tempted.entries.every(entry => !planner.isRestrictedArrival(entry.system)),
    "as it excludes every restricted arrival, not merely that one");

  // The same temptation through a plan, so the exclusion is checked where a
  // pilot would actually meet it.
  const away = planner.plan("Inaro", "1DQ1-A", { shipValue: "Ark" });
  t.check(away.systems.every(system => !planner.isRestrictedArrival(system)),
    "and a plan starting beside Pochven never routes through it");
  t.check(plan.legs.every((leg, i) => leg.from.system_id === plan.systems[i].system_id
    && leg.to.system_id === plan.systems[i + 1].system_id), "legs match the system sequence");
  t.check(Math.abs(plan.totalLy - plan.legs.reduce((sum, l) => sum + l.distanceLy, 0)) < 1e-9,
    "total distance is the sum of its legs");
  t.check(Math.abs(plan.totalFuelRaw - plan.totalLy * plan.fuelPerLy) < 1e-6,
    "raw fuel is distance times the per-ly rate");
  t.check(plan.totalFuel >= plan.totalFuelRaw && plan.totalFuel - plan.totalFuelRaw < plan.legs.length,
    "and the reported figure is that raw amount rounded up once per jump");
  t.equal(plan.systems[0].name, "Jita", "the plan starts where asked");
  t.equal(plan.systems.at(-1).name, "1DQ1-A", "and ends where asked");

  // A shorter-ranged hull cannot do better than a longer-ranged one.
  const carrier = planner.plan("Jita", "1DQ1-A", { shipValue: "Archon" });
  const titan = planner.plan("Jita", "1DQ1-A", { shipValue: "Avatar" });
  t.check(carrier.jumps >= plan.jumps, `a 7 ly carrier needs ${carrier.jumps} jumps against the freighter's ${plan.jumps}`);
  t.check(titan.jumps >= carrier.jumps, `a 6 ly titan needs ${titan.jumps}`);

  // Lower skill cannot help.
  const untrained = planner.plan("Jita", "1DQ1-A", { shipValue: "Ark", calibration: 0 });
  t.check(untrained.jumps >= plan.jumps, `at Calibration 0 the same trip takes ${untrained.jumps} jumps`);
  t.check(untrained.rangeLy === 5, "because range falls to the hull base");

  // --- refusals ----------------------------------------------------------
  t.throws(() => planner.plan("Jita", "1DQ1-A", { shipValue: "Rifter" }), "Ship not found", "a non-jumping ship is refused");
  t.throws(() => planner.plan("Notasystem", "1DQ1-A", { shipValue: "Ark" }), "Origin system not found", "unknown origin refused");
  t.throws(() => planner.plan("Jita", "Amarr", { shipValue: "Ark" }), "cynosural field cannot be lit",
    "a high-security destination is refused, and says why");
  t.throws(() => planner.plan("Jita", "Thera", { shipValue: "Ark" }), "not on the stargate network",
    "a wormhole destination is refused");

  t.throws(() => planner.plan("Jita", "Amarr", { shipValue: "Ark", allowHighSec: true }), "cynosural field cannot be lit",
    "even a legacy allowHighSec option cannot make a high-security arrival legal");

  const pochven = Object.values(atlas.regions).find(region => region.name === "Pochven");
  const pochvenOrigin = pochven.systems.map(id => atlas.systems[id])
    .find(system => planner.systemsInRange(system.system_id, planner.rangeFor(ark, 5)).length);
  const outboundTarget = planner.systemsInRange(pochvenOrigin.system_id, planner.rangeFor(ark, 5))[0]?.system;
  t.check(Boolean(outboundTarget), "at least one Pochven system has a legal outbound jump target");
  const outbound = planner.plan(pochvenOrigin.name, outboundTarget.name, { shipValue: "Ark" });
  t.equal(outbound.systems[0].name, pochvenOrigin.name, "Pochven remains legal as an origin for a trapped jump-capable hull");
  t.throws(() => planner.plan("Jita", pochvenOrigin.name, { shipValue: "Ark" }), "does not accept ordinary cynosural arrivals",
    "Pochven is refused as a destination");
  t.throws(() => planner.plan("Jita", "Zarzakh", { shipValue: "Ark" }), "does not accept ordinary cynosural arrivals",
    "Zarzakh is refused as a destination");

  // --- determinism -------------------------------------------------------
  const again = planner.plan("Jita", "1DQ1-A", { shipValue: "Ark" });
  t.check(JSON.stringify(again.systems.map(s => s.system_id)) === JSON.stringify(plan.systems.map(s => s.system_id)),
    "planning is deterministic");

  // --- the interface -----------------------------------------------------
  if (app) {
    const ui = id => document.getElementById(id);
    const { state } = app;
    state.atlas = atlas;
    state.jumpPlanner = planner;
    app.populateShips();
    t.check(ui("jumpShip").innerHTML.includes("optgroup"), "the ship picker groups hulls by class");
    t.check(ui("jumpShip").innerHTML.includes("Ark"), "and lists them");

    ui("jumpShip").value = "Ark";
    ui("jumpFrom").value = "Jita";
    ui("jumpTo").value = "1DQ1-A";
    ui("jumpCalibration").value = "5";
    ui("jumpConservation").value = "5";
    ui("jumpHighSec").checked = false;
    app.planJump();
    t.equal(ui("jumpError").textContent, "", "a valid plan reports no error");
    t.check(state.jump && state.jump.jumps > 0, "and produces a plan");
    const panel = ui("inspectorContent").innerHTML;
    t.check(panel.includes("Capital jump plan"), "the brief is rendered");
    t.check(panel.includes("Jump range"), "with the range used");
    t.check(panel.includes("Assumptions"), "and the assumptions it rests on");
    // The panel models fatigue now, so it must say which half comes from the
    // archive and which is a model, rather than claiming neither exists.
    t.check(panel.includes("Jump fatigue"), "the panel reports fatigue");
    t.check(panel.includes("Effective distance"), "with the distance the archive does state");
    t.check(panel.includes("is a model"), "and marks the accrual rule as a model");
    t.check(!panel.includes("Fatigue accrual is not modelled"),
      "and no longer carries the older claim that it is not modelled at all");

    ui("jumpTo").value = "Amarr";
    ui("jumpHighSec").checked = true;
    app.planJump();
    t.check(ui("jumpError").textContent.includes("cynosural"),
      "the range-only high-sec toggle cannot make a high-security arrival legal");
  }

  // --- what counts as somewhere a fleet can actually be -------------------------
  // `isReachable` refuses a system on no stargate. Wormhole space is caught by
  // its region id, but the Jove regions and the Abyssal proving grounds are
  // ordinary K-space with no gates at all - 618 systems - and for those the
  // neighbour clause is the only thing doing the work.
  //
  // A mutation sweep showed it was doing that work unwatched: relaxing
  // `system.neighbors.length > 0` to `>= 0` left the whole suite green, because
  // the only refusal anyone tested was Thera, which the wormhole check rejects
  // before the neighbour clause is ever reached. Accepting one of these would
  // plan a capital move from a system no capital can be in.
  const gateless = Object.values(atlas.systems).filter(system =>
    system.neighbors.length === 0 && !planner.isWormhole(system));
  t.check(gateless.length > 100, `K-space systems with no stargate exist (${gateless.length})`);
  const stranded = gateless[0];
  t.equal(planner.isWormhole(stranded), false,
    `${stranded.name} is not wormhole space, so the region check does not catch it`);
  t.equal(planner.isReachable(stranded), false, "and it is still refused, on the strength of having no gate");
  t.check(!planner.jumpable.some(s => s.system_id === stranded.system_id),
    "so it is not in the jumpable set");
  t.throws(() => planner.plan(stranded.name, "Jita", { shipValue: "Ark" }), "stargate network",
    "and planning from it is refused rather than answered");

  // The region bounds are a rule about id ranges, and no region sits exactly on
  // either one - 11000001 is the lowest and 11000033 the highest - so the
  // comparisons are never evaluated at their boundaries by real data.
  const ids = [...new Set(Object.values(atlas.systems).map(s => s.region_id))];
  t.check(!ids.includes(11000000) && !ids.includes(12000000),
    "no region sits exactly on a wormhole bound, so real data never tests them");
  t.equal(planner.isWormhole({ region_id: 11000000 }), true, "the lower bound is inclusive");
  t.equal(planner.isWormhole({ region_id: 10999999 }), false, "and below it is not wormhole space");
  t.equal(planner.isWormhole({ region_id: 11999999 }), true, "the top of the range is wormhole space");
  t.equal(planner.isWormhole({ region_id: 12000000 }), false, "and the upper bound is exclusive");
  // 12000001 upward is the Abyssal proving grounds: not wormhole space, and
  // excluded from jumping by having no gates rather than by its region.
  t.equal(planner.isWormhole({ region_id: 12000001 }), false,
    "the Abyssal grounds are not wormhole space");
  t.equal(planner.isReachable({ region_id: 12000001, neighbors: [] }), false,
    "but are still unreachable, because they have no stargate");

  return t.results;
}
