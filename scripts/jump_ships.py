"""Jump-capable ship data, taken from CCP's own export.

Jump ranges and fuel rates are game values. Recalling them from memory would
make the capital calculator confidently wrong, so every number here is read out
of the SDE: the per-hull attributes, and the per-level skill bonuses that scale
them. Nothing in this module is a remembered constant.

Attributes used (from dogmaAttributes.jsonl):

    861  canJump                     has a jump drive at all
    866  jumpDriveConsumptionType    which isotope it burns
    867  jumpDriveRange              base range, before skills
    868  jumpDriveConsumptionAmount  base fuel per light-year
    870  jumpDriveRangeBonus         range bonus per skill level
    898  jumpDriveCapacitorNeed      capacitor per light-year
    1971 jumpFatigueMultiplier       per-hull fatigue scaling, where set
    1296                             fuel consumption bonus per skill level
"""

from __future__ import annotations

import json
import re

RANGE = 867
FUEL_PER_LY = 868
FUEL_TYPE = 866
RANGE_BONUS = 870
CAP_NEED = 898
FATIGUE = 1971
FUEL_BONUS = 1296

CALIBRATION_SKILL = "Jump Drive Calibration"
CONSERVATION_SKILL = "Jump Fuel Conservation"

# Some hulls carry a further per-level bonus in their own trait text rather
# than in a shared attribute. Jump freighters are the case that matters: every
# one reads "10% reduction in jump fuel requirement" per level of Jump
# Freighters, which stacks with Jump Fuel Conservation. Missing it made every
# jump freighter fuel figure exactly twice what it should be.
#
# The text is matched rather than a hard-coded hull list, so a hull that gains
# such a bonus later is picked up by a rebuild.
HULL_FUEL_BONUS = re.compile(r"reduction in jump fuel", re.I)

# Fitted modules that reduce jump fuel. Matched by group name so the meta
# variants are picked up together, and so a future addition to the group
# appears without a code change.
FUEL_MODULE_GROUP = re.compile(r"jump drive economizer", re.I)
# Direction matters: a "reduction in" clause must never be stored as a bonus.
# The previous pattern alternated at the top level, so its second branch
# matched any text containing the phrase and swallowed penalties as bonuses.
HULL_RANGE_BONUS = re.compile(r"(?:bonus|increase)\s+to\s+(?:[^.]*\s)?jump\s+(?:drive\s+)?range", re.I)
HULL_RANGE_PENALTY = re.compile(r"(?:reduction|penalty)\s+(?:in|to)\s+(?:[^.]*\s)?jump\s+(?:drive\s+)?range", re.I)

# The number of hulls expected to carry a jump-fuel trait bonus. The build
# asserts this, because losing the match silently doubles every figure.
EXPECTED_HULL_FUEL_BONUSES = 4
# Nothing in the current SDE matches HULL_RANGE_BONUS or HULL_RANGE_PENALTY, so
# every line that reads a hull range bonus is unreachable - including the
# verifier's direction check, which is a check that cannot fail. Pinned at the
# real number so gaining one is a deliberate decision rather than an unnoticed
# regex hit on a reworded trait.
EXPECTED_HULL_RANGE_BONUSES = 0

# Only actual ships belong in a ship picker. Jump bridges and portal arrays
# are structures, and the project does not model ansiblexes in any case. The
# test is the category rather than the group name, which is a label that can be
# renamed without warning.
SHIP_CATEGORY = "Ship"


def _english(value):
    if isinstance(value, dict):
        return value.get("en") or next(iter(value.values()), "")
    return value


def _hull_bonuses(zf, wanted_ids, names):
    """Per-level trait bonuses that scale jump fuel or jump range, by type."""
    found = {}
    for record in _read(zf, "typeBonus.jsonl"):
        type_id = int(record["_key"])
        if type_id not in wanted_ids:
            continue
        for group in record.get("types") or []:
            skill_id = int(group["_key"])
            for bonus in group.get("_value") or []:
                text = _english((bonus.get("bonusText") or {})) or ""
                value = bonus.get("bonus")
                if value is None:
                    continue
                if HULL_FUEL_BONUS.search(text):
                    found.setdefault(type_id, {})["fuel"] = {
                        "skill": names.get(skill_id, str(skill_id)),
                        "percent_per_level": -abs(float(value)),
                        "trait": text,
                    }
                elif HULL_RANGE_BONUS.search(text) or HULL_RANGE_PENALTY.search(text):
                    signed = -abs(float(value)) if HULL_RANGE_PENALTY.search(text) else abs(float(value))
                    found.setdefault(type_id, {})["range"] = {
                        "skill": names.get(skill_id, str(skill_id)),
                        "percent_per_level": signed,
                        "trait": text,
                    }
        # Role bonuses carry the fatigue reduction, which the attribute states
        # numerically; the text is kept so the number can be read back.
        for bonus in record.get("roleBonuses") or []:
            text = _english((bonus.get("bonusText") or {})) or ""
            if "jump fatigue" in text.lower():
                found.setdefault(type_id, {})["fatigue_trait"] = text
    return found


def _read(zf, name):
    with zf.open(name) as raw:
        for line in raw:
            if line.strip():
                yield json.loads(line)


def extract(zf):
    """Return {"ships": [...], "skills": {...}, "fuel_types": {...}}."""
    attributes = {}
    for record in _read(zf, "typeDogma.jsonl"):
        wanted = {}
        for attribute in record.get("dogmaAttributes") or []:
            key = attribute.get("attributeID")
            if key in (RANGE, FUEL_PER_LY, FUEL_TYPE, RANGE_BONUS, CAP_NEED, FATIGUE, FUEL_BONUS):
                wanted[key] = attribute.get("value")
        if wanted:
            attributes[int(record["_key"])] = wanted

    categories = {int(c["_key"]): _english(c.get("name")) for c in _read(zf, "categories.jsonl")}
    groups = {}
    group_category = {}
    for group in _read(zf, "groups.jsonl"):
        group_id = int(group["_key"])
        groups[group_id] = _english(group.get("name"))
        group_category[group_id] = categories.get(int(group.get("categoryID", 0)), "")

    ships = []
    modules = []
    skills = {}
    fuel_type_ids = set()
    names = {}

    for record in _read(zf, "types.jsonl"):
        type_id = int(record["_key"])
        name = _english(record.get("name"))
        names[type_id] = name

        if name in (CALIBRATION_SKILL, CONSERVATION_SKILL):
            values = attributes.get(type_id, {})
            skills[name] = {
                "type_id": type_id,
                "range_bonus_per_level": values.get(RANGE_BONUS),
                "fuel_bonus_per_level": values.get(FUEL_BONUS),
            }

        values = attributes.get(type_id)
        group_id = int(record.get("groupID", 0))
        group = groups.get(group_id, "")
        category = group_category.get(group_id, "")

        if record.get("published") and values and FUEL_MODULE_GROUP.search(group) and FUEL_BONUS in values:
            modules.append({
                "type_id": type_id,
                "name": name,
                "group": group,
                "fuel_bonus_percent": float(values[FUEL_BONUS]),
            })

        if not values or RANGE not in values or not record.get("published"):
            continue
        if category != SHIP_CATEGORY:
            continue

        fuel_type = values.get(FUEL_TYPE)
        if fuel_type:
            fuel_type_ids.add(int(fuel_type))

        ships.append({
            "type_id": type_id,
            "name": name,
            "group": group,
            "base_range_ly": values.get(RANGE),
            "base_fuel_per_ly": values.get(FUEL_PER_LY),
            "fuel_type_id": int(fuel_type) if fuel_type else None,
            "capacitor_per_ly": values.get(CAP_NEED),
            "fatigue_multiplier": values.get(FATIGUE),
        })

    hull_bonuses = _hull_bonuses(zf, {s["type_id"] for s in ships}, names)
    for ship in ships:
        extra = hull_bonuses.get(ship["type_id"], {})
        ship["hull_fuel_bonus"] = extra.get("fuel")
        ship["hull_range_bonus"] = extra.get("range")
        ship["fatigue_trait"] = extra.get("fatigue_trait")

    ships.sort(key=lambda s: (s["group"], s["name"]))
    # Weakest reduction first, so a picker reads in meta order. The strongest
    # is the LAST entry, not the first.
    modules.sort(key=lambda m: m["fuel_bonus_percent"], reverse=True)
    fuel_types = {tid: names[tid] for tid in sorted(fuel_type_ids) if tid in names}

    return {
        "ships": ships,
        "fuel_modules": modules,
        "skills": skills,
        "fuel_types": fuel_types,
        # NOT FROM THE SDE. The static export states the per-hull fatigue
        # multiplier, but not the rule turning effective distance into fatigue
        # minutes and a cooldown. These constants are the applied model; they
        # are kept here so a correction is a data edit, not a code change, and
        # anything derived from them is labelled as a model where it is shown.
        "fatigue_model": {
            "source": "game rule, not present in the Static Data Export",
            # Order matters: the cooldown is read from the fatigue carried INTO
            # the jump, before fatigue is recalculated. Pinned against CCP's
            # published Archon and Ark examples in tests/jump-planner.test.mjs.
            "formula": (
                "cooldown = min(cooldownCapMinutes, max(1 + effective_ly, fatigue / cooldownDivisor)); "
                "then fatigue = min(capMinutes, max(fatigue, floorMinutes) * (1 + effective_ly)); "
                "fatigue decays by decayMinutesPerMinute per minute of real time"
            ),
            "floorMinutes": 10,
            "cooldownDivisor": 10,
            "capMinutes": 300,
            "cooldownCapMinutes": 30,
            "decayMinutesPerMinute": 1,
        },
        "note": (
            "Ranges and fuel rates are base hull values from the SDE. Range is multiplied "
            "by (1 + range_bonus_per_level * level / 100) from the Jump Drive Calibration "
            "record, and fuel by (1 + fuel_bonus_per_level * level / 100) from Jump Fuel "
            "Conservation. A hull carrying hull_fuel_bonus or hull_range_bonus applies that "
            "as a further multiplier at the level of the named skill. fatigue_multiplier is "
            "a reduction to the effective distance travelled for jump fatigue, per the "
            "hull's own role-bonus text. fuel_modules are fitted modules whose "
            "fuel_bonus_percent applies as one further multiplier; no implant or booster "
            "in the export affects jump range, fuel or fatigue."
        ),
    }
