"""Classes, subclasses, peoples (races/species) and backgrounds for the character sheet.

One table (char_options) holds all four kinds; what differs per kind lives in its JSON `data`:
  class      {hit_die, saves, caster_type, profs, equipment, features: [{name, levels, desc}]}
  subclass   {features}                       parent = English name of the class ("Fighter")
  race       {asi, speed, traits: [{name, desc}]}   a subrace carries its parent's values too
  background {asi, skills, benefits: [{name, desc}]}
  feat       {feat_type, prerequisite, asi, repeatable}   the text in desc
asi = {"fixed": {"con": 2}, "choices": [{"points": 2, "max": 1, "from": ["str", ...]}]}: fixed bonuses
plus points the player distributes (at most `max` per ability), read from the English Open5e texts.

Open5e's v2 classes endpoint ignores every filter (name, subclass_of), so each collection is fetched
whole (151 classes, 63 species, 58 backgrounds) and filtered here; it's cached for a few minutes so a
search followed by an import doesn't download it twice.
"""
import json
import re
import time
from typing import Optional

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from . import i18n, open5e, translate
from .db import get_conn

router = APIRouter()

KINDS = ("classes", "subclasses", "races", "backgrounds", "feats")
KIND_LABELS = {"classes": "Klasse", "subclasses": "Unterklasse", "races": "Volk", "backgrounds": "Hintergrund", "feats": "Talent"}
SOURCES = {
    "classes": "https://api.open5e.com/v2/classes/",
    "subclasses": "https://api.open5e.com/v2/classes/",
    "races": "https://api.open5e.com/v2/species/",
    "backgrounds": "https://api.open5e.com/v2/backgrounds/",
    "feats": "https://api.open5e.com/v2/feats/",
}
SRD_DOCUMENTS = {"srd-2014", "srd-2024"}
CACHE_SECONDS = 600

ABILITIES = ["str", "dex", "con", "int", "wis", "cha"]
ABILITY_EN = {
    "strength": "str", "dexterity": "dex", "constitution": "con",
    "intelligence": "int", "wisdom": "wis", "wisdon": "wis", "charisma": "cha",
}
# Sheet skill keys (charsheet.js SKILLS) by their English name.
SKILL_EN = {
    "acrobatics": "acrobatics", "arcana": "arcana", "athletics": "athletics", "performance": "performance",
    "intimidation": "intimidation", "sleight of hand": "sleight", "history": "history", "medicine": "medicine",
    "stealth": "stealth", "animal handling": "animal", "insight": "insight", "investigation": "investigation",
    "nature": "nature", "religion": "religion", "deception": "deception", "survival": "survival",
    "persuasion": "persuasion", "perception": "perception",
}

# German names for the SRD entries, so they read like the rest of the sheet and match the peoples
# already typed into older sheets ("Zwerg"). Everything else keeps its Open5e name.
NAMES_DE = {
    "classes": {
        "Barbarian": "Barbar", "Bard": "Barde", "Cleric": "Kleriker", "Druid": "Druide", "Fighter": "Kämpfer",
        "Monk": "Mönch", "Paladin": "Paladin", "Ranger": "Waldläufer", "Rogue": "Schurke",
        "Sorcerer": "Zauberer", "Warlock": "Hexenmeister", "Wizard": "Magier",
    },
    "subclasses": {
        "Path of the Berserker": "Pfad des Berserkers", "College of Lore": "Schule des Wissens",
        "Life Domain": "Domäne des Lebens", "Circle of the Land": "Zirkel des Landes", "Champion": "Champion",
        "Way of the Open Hand": "Weg der offenen Hand", "Warrior of the Open Hand": "Krieger der offenen Hand",
        "Oath of Devotion": "Eid der Hingabe", "Hunter": "Jäger", "Thief": "Dieb",
        "Draconic Bloodline": "Drakonische Blutlinie", "Draconic Sorcery": "Drakonische Zauberei",
        "The Fiend": "Der Unhold", "Fiend Patron": "Unhold-Schutzherr",
        "School of Evocation": "Schule der Hervorrufung", "Evoker": "Hervorrufer",
    },
    "races": {
        "Dragonborn": "Drachenblütiger", "Dwarf": "Zwerg", "Elf": "Elf", "Gnome": "Gnom", "Goliath": "Goliath",
        "Halfling": "Halbling", "Human": "Mensch", "Orc": "Ork", "Tiefling": "Tiefling", "Half-Elf": "Halbelf",
        "Half-Orc": "Halbork", "High Elf": "Hochelf", "Hill Dwarf": "Hügelzwerg", "Lightfoot": "Leichtfuss-Halbling",
        "Rock Gnome": "Felsengnom",
    },
    "backgrounds": {"Acolyte": "Tempeldiener", "Criminal": "Krimineller", "Sage": "Weiser", "Soldier": "Soldat"},
    "feats": {
        "Ability Score Improvement": "Attributswerterhöhung", "Alert": "Wachsam", "Archery": "Bogenschiessen",
        "Defense": "Verteidigung", "Grappler": "Ringer", "Great Weapon Fighting": "Kampf mit grossen Waffen",
        "Magic Initiate": "Magie-Eingeweihter", "Savage Attacker": "Wilder Angreifer", "Skilled": "Vielseitig",
        "Two-Weapon Fighting": "Kampf mit zwei Waffen", "Boon of Combat Prowess": "Segen der Kampfkunst",
        "Boon of Dimensional Travel": "Segen der Dimensionsreise", "Boon of Fate": "Segen des Schicksals",
        "Boon of Irresistible Offense": "Segen des unwiderstehlichen Angriffs",
        "Boon of Spell Recall": "Segen der Zaubererinnerung", "Boon of the Night Spirit": "Segen des Nachtgeists",
        "Boon of Truesight": "Segen der wahren Sicht",
    },
}


# ---------- reading the English rule texts ----------

def _abilities_in(text: str) -> list[str]:
    found = []
    for word in re.findall(r"[a-z]+", text.lower()):
        ab = ABILITY_EN.get(word)
        if ab and ab not in found:
            found.append(ab)
    return found


NUMBER_WORDS = {"one": 1, "two": 2, "three": 3}


def parse_asi(text: str | None) -> dict | None:
    """Ability score increases from a 2014 people's trait or a background benefit; None if none found."""
    if not text:
        return None
    t = re.sub(r"[*_]", "", text).lower()
    fixed: dict[str, int] = {}
    choices: list[dict] = []
    if re.search(r"ability scores each increase by 1", t):
        return {"fixed": {ab: 1 for ab in ABILITIES}, "choices": []}
    # "Your Strength or Dexterity score increases by 1", "increase either your Wisdom or Charisma score by 1"
    for a, b, n in re.findall(r"(\w+) or (?:your )?(\w+) score (?:increases? )?by (\d)", t):
        abs_ = [ABILITY_EN.get(a), ABILITY_EN.get(b)]
        if all(abs_):
            choices.append({"points": int(n), "max": int(n), "from": abs_})
    t_fixed = re.sub(r"(\w+) or (?:your )?(\w+) score (?:increases? )?by \d", "", t)
    for word, n in re.findall(r"(\w+) score increases? by (\d)", t_fixed):
        ab = ABILITY_EN.get(word)
        if ab:
            fixed[ab] = fixed.get(ab, 0) + int(n)
    # "+1 to Wisdom and one other ability score" (Level Up backgrounds)
    for n, word in re.findall(r"\+(\d) (?:to )?(\w+)", t):
        ab = ABILITY_EN.get(word)
        if ab:
            fixed[ab] = fixed.get(ab, 0) + int(n)
    m = re.search(r"\b(one|two|three) (?:other |different )?ability scores?(?: of your choice)?"
                  r"(?:, other than (\w+),)? increases? by (\d)", t)
    if m:
        count, amount = NUMBER_WORDS[m.group(1)], int(m.group(3))
        excluded = set(fixed) | {ABILITY_EN.get(m.group(2) or "")}
        choices.append({"points": count * amount, "max": amount, "from": [a for a in ABILITIES if a not in excluded]})
    elif re.search(r"\+\d (?:to )?\w+ and one other ability score", t):
        choices.append({"points": 1, "max": 1, "from": [a for a in ABILITIES if a not in fixed]})
    if not fixed and not choices:
        # 2024 backgrounds just list three abilities: +2/+1 or +1/+1/+1 among them.
        listed = _abilities_in(t)
        if len(listed) == 3 and len(t) < 80:
            choices.append({"points": 3, "max": 2, "from": listed})
    if not fixed and not choices:
        return None
    return {"fixed": fixed, "choices": choices}


def parse_feat_asi(text: str | None) -> dict | None:
    """A feat's ability score increase: "Increase one ability score of your choice by 1", "Increase
    your Strength or Dexterity score by 1", the Ability Score Improvement feat itself (2 points)."""
    t = re.sub(r"[*_]", "", text or "").lower()
    if re.search(r"by 2, or increase two ability scores", t):
        return {"fixed": {}, "choices": [{"points": 2, "max": 2, "from": list(ABILITIES)}]}
    m = re.search(r"increase one ability score of your choice by (\d)", t)
    if m:
        n = int(m.group(1))
        return {"fixed": {}, "choices": [{"points": n, "max": n, "from": list(ABILITIES)}]}
    m = re.search(r"increase (?:your )?((?:\w+,\s*)+(?:or\s+)?\w+) score by (\d)", t)
    if m:
        listed = _abilities_in(m.group(1))
        if len(listed) > 1:
            return {"fixed": {}, "choices": [{"points": int(m.group(2)), "max": int(m.group(2)), "from": listed}]}
    return parse_asi(text)


def merge_asi(*parts: dict | None) -> dict | None:
    fixed: dict[str, int] = {}
    choices: list[dict] = []
    for p in parts:
        if not p:
            continue
        for ab, n in p.get("fixed", {}).items():
            fixed[ab] = fixed.get(ab, 0) + n
        choices.extend(p.get("choices", []))
    return {"fixed": fixed, "choices": choices} if fixed or choices else None


SPEED_KINDS = {"flying": "fly", "swimming": "swim", "climbing": "climb"}


def parse_speed(traits: list[dict]) -> dict | None:
    """{"walk": 25, "fly": 50, ...} in feet, from the Speed trait and any "flying speed of 50 feet"."""
    speed: dict[str, int] = {}
    for t in traits:
        desc = (t.get("desc") or "").lower()
        if t.get("type") == "SPEED" or (t.get("name") or "").strip().lower() == "speed":
            m = re.search(r"(\d+)\s*(?:feet|foot|ft)", desc)
            if m:
                speed["walk"] = int(m.group(1))
        # A later trait raising it: Wood Elf "Your Speed increases to 35 feet" (2014: "base walking speed").
        # A table row is only one option to choose (the Elven Lineages table), not the people's speed.
        for line in desc.splitlines():
            m = re.search(r"\b(?:base walking )?speed increases to (\d+)\s*(?:feet|foot|ft)", line)
            if m and not line.lstrip().startswith("|"):
                speed["walk"] = int(m.group(1))
        for word, n in re.findall(r"(flying|swimming|climbing) speed (?:of|equal to)? ?(\d+)", desc):
            speed[SPEED_KINDS[word]] = int(n)
    return speed or None


def parse_skills(text: str | None) -> list[str]:
    t = (text or "").lower()
    return [key for name, key in SKILL_EN.items() if re.search(rf"\b{name}\b", t)]


# ---------- what a subclass feature grants ----------
# Read from the English text at every load (never stored), so corrected texts take effect at once:
#   profs        ["heavy armor", "smith's tools"]            armor, weapons, tools
#   skills       ["arcana"]                                  fixed skill proficiencies
#   skill_choice {"n": 2, "from": ["arcana", ...] | None, "expertise": True}
#   languages    2                                           languages of the player's choice
#   spells       [{"name": "beast sense", "ritual_only": True}]   always known / prepared
#   spell_choice [{"n": 2, "cantrip": True, "lists": ["Wizard"] | None, "school": "necromancy",
#                  "spell_level": 6}]                        cantrip False: a cantrip or a castable spell
#   table        [{"level": 3, "spells": ["Aid", "Bless"]}]  domain/oath spells by class level
#   cantrip_damage {"ability": "wis", "class": "Cleric"}     Potent Spellcasting

COUNT = {"a": 1, "an": 1, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5}
_CHOICE = r"of (?:your|his or her|their) choice"
_NOT_SPELLS = {"spell", "spells", "same", "chosen", "a", "that", "this"}


def _split_names(text: str, commas_only: bool = False) -> list[str]:
    sep = r",\s*" if commas_only else r",\s*(?:and |or )?|\s+(?:and|or)\s+"
    parts = re.split(sep, re.sub(r"\([^)]*\)", "", text.replace("*", "")))
    return [p.strip(" .") for p in parts if p.strip(" .")]


def _class_lists(text: str) -> list[str] | None:
    names = [n.strip().capitalize() for n in _split_names(re.sub(r"\bthe\b", "", text, flags=re.I))]
    return [n for n in names if n] or None


def _spell_table(desc: str) -> list[dict]:
    """Rows of a two-column Markdown table "| Cleric Level | Spells |": | 3rd | aid, bless |."""
    rows = []
    for line in desc.splitlines():
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) != 2:
            continue
        m = re.fullmatch(r"(\d+)(?:st|nd|rd|th)?", cells[0], flags=re.I)
        names = [n for n in _split_names(cells[1], commas_only=True) if n and not re.fullmatch(r"-+", n)]
        if m and names:
            rows.append({"level": int(m.group(1)), "spells": names})
    # The same level twice: one table per terrain to choose from (Circle of the Land), nothing
    # that applies as it is.
    if len({r["level"] for r in rows}) != len(rows):
        return []
    return rows


def _parse_profs(flat: str) -> list[str]:
    """Armor, weapons, tools: "you gain proficiency with medium armor, shields, and martial weapons.\""""
    profs: list[str] = []
    for m in re.finditer(r"\b(?:gain|gains|have) proficiency with ([^.;:]+)", flat):
        if "chosen" in m.group(1):
            continue
        items = [re.sub(r"^(?:the|a|an|one|all) ", "", i) for i in _split_names(m.group(1))]
        items = [i for i in items if i and len(i) < 40 and not re.search(r"skill|saving throw|\byou\b", i)]
        profs.extend(items)
    return profs


def _parse_skill_grants(flat: str) -> dict:
    """Skills: fixed ("proficiency in the Arcana skill") or a choice."""
    g: dict = {}
    fixed = [SKILL_EN[s] for s in re.findall(r"proficiency in the ([a-z ]+?) skill", flat) if s in SKILL_EN]
    if fixed:
        g["skills"] = fixed
    m = re.search(r"proficien\w* (?:in|with) your choice of (\w+) of the following skills: ([^.]+)", flat)
    if m:
        g["skill_choice"] = {"n": COUNT.get(m.group(1), 1), "from": parse_skills(m.group(2))}
    else:
        m = re.search(r"proficien\w* (?:in|with) (\w+) skills? " + _CHOICE, flat)
        if m and m.group(1) in COUNT:
            g["skill_choice"] = {"n": COUNT[m.group(1)], "from": None}
    if "skill_choice" in g and re.search(r"proficiency bonus is doubled", flat):
        g["skill_choice"]["expertise"] = True
    return g


def _parse_language_grant(flat: str) -> int | None:
    m = re.search(r"learn (\w+) languages? " + _CHOICE, flat)
    return COUNT[m.group(1)] if m and m.group(1) in COUNT else None


def _parse_spell_choices(flat: str) -> list[dict]:
    """Spells to choose."""
    choices = []
    for m in re.finditer(r"(?:gain|learn|learns) (\w+) (?:(\w+) )?cantrips? " + _CHOICE + r" from (?:the )?(any|[a-z]+) spell list", flat):
        if m.group(1) in COUNT:
            school = m.group(2) if m.group(2) not in (None, "other", "additional", "more") else None
            choices.append({"n": COUNT[m.group(1)], "cantrip": True, "school": school,
                            "lists": None if m.group(3) == "any" else [m.group(3).capitalize()]})
    m = re.search(r"learn (\w+) spells " + _CHOICE + r" from any class", flat)
    if m and m.group(1) in COUNT:
        choices.append({"n": COUNT[m.group(1)], "cantrip": False, "lists": None})
    m = re.search(r"learn (\w+) spells " + _CHOICE + r"\. these spells can come from the ([^.]+?) spell lists?", flat)
    if m and m.group(1) in COUNT:
        choices.append({"n": COUNT[m.group(1)], "cantrip": False, "lists": _class_lists(m.group(2))})
    m = re.search(r"choose (\w+) spells from the (\w+) spell list, one from each of the following levels: ([^.]+)", flat)
    if m:
        for lvl in re.findall(r"(\d+)(?:st|nd|rd|th)", m.group(3)):
            choices.append({"n": 1, "cantrip": False, "lists": [m.group(2).capitalize()], "spell_level": int(lvl)})
    return choices


def _parse_known_spells(desc: str) -> list[dict]:
    """Spells always known/prepared: "cast the beast sense and speak with animals spells, but only as
    rituals", "you learn the spare the dying cantrip", "you cast *command*"."""
    spells: dict[str, dict] = {}
    for sentence in re.split(r"(?<=[.!?])\s+|\n+", desc):
        s = sentence.lower()
        if re.search(_CHOICE + r"|\bchoose\b", s):
            continue
        ritual = bool(re.search(r"only as (?:a )?rituals?", s))
        names = []
        for m in re.finditer(r"\b(?:you|can|also|ability to) (?:cast|learn)s? the \*?([a-z][a-z*' /-]*?)\*? (?:cantrip|spells?)\b", s):
            names += _split_names(m.group(1))
        if re.search(r"\byou (?:can |also )?(?:cast|learn)\b", s):
            names += re.findall(r"\*([^*]{3,40})\*", s)
        for n in names:
            n = n.strip()
            if (n and n not in _NOT_SPELLS and len(n.split()) <= 4 and not n.endswith(".")
                    and not re.search(r"\b(?:spells?|cantrips?)\b|^the\b", n)):
                spells.setdefault(n, {"name": n, "ritual_only": ritual})
    return list(spells.values())


def _parse_cantrip_damage(flat: str) -> dict | None:
    m = re.search(r"add your (\w+) modifier to the damage you deal with any (\w+) cantrip", flat)
    if m and ABILITY_EN.get(m.group(1)):
        return {"ability": ABILITY_EN[m.group(1)], "class": m.group(2).capitalize()}
    return None


def parse_grants(f: dict) -> dict:
    desc = (f.get("desc") or "").replace("’", "'")
    name = f.get("name") or ""
    if not desc:
        return {}
    t = desc.lower()
    flat = re.sub(r"\s+", " ", t.replace("*", ""))

    g: dict = {}
    profs = _parse_profs(flat)
    if profs:
        g["profs"] = profs
    g.update(_parse_skill_grants(flat))
    languages = _parse_language_grant(flat)
    if languages is not None:
        g["languages"] = languages
    choices = _parse_spell_choices(flat)
    if choices:
        g["spell_choice"] = choices
    spells = _parse_known_spells(desc)
    if spells:
        g["spells"] = spells

    # "Expanded Spell List" (warlock patrons) only widens the list to choose from.
    if re.search(r"\bspells?\b", name, flags=re.I) and not re.search(r"expanded", name, flags=re.I):
        table = _spell_table(desc)
        if table:
            g["table"] = table

    cantrip_damage = _parse_cantrip_damage(flat)
    if cantrip_damage:
        g["cantrip_damage"] = cantrip_damage
    return g


# ---------- Open5e records -> char_options rows ----------

def _base(entry: dict, kind: str) -> dict:
    doc = open5e._doc_info(entry.get("document"))
    name_en = entry.get("name") or ""
    srd = (entry.get("document") or {}).get("key") in SRD_DOCUMENTS
    return {
        "slug": entry.get("key"),
        "kind": kind,
        # German names for the SRD entries only with a German UI (i18n.lang()); name_en keeps the original.
        "name": NAMES_DE[kind].get(name_en, name_en) if srd and i18n.lang() == "de" else name_en,
        "name_en": name_en,
        "parent": None,
        "desc": entry.get("desc") or None,
        "source_name": doc["source_name"],
        "is_2024": doc["is_2024"],
    }


COLUMN_PLACEHOLDER = "[Column data]"
_COLUMN_WORDS = {"unlimited": "unbegrenzt"}


def _column(table: list[dict]) -> list[list]:
    """A column of the class table (Rage Damage, Ki Points, Sorcery Points …) as [[level, value]],
    without the levels where it's still empty ("-")."""
    rows = sorted((g.get("level"), str(g.get("column_value") or "").strip()) for g in table or [] if g.get("level"))

    def de(v: str) -> str:
        v = _COLUMN_WORDS.get(v.lower(), v)
        return re.sub(r"^(\d+)(st|nd|rd|th)$", r"Grad \1", v)  # Slot Level "3rd" -> "Grad 3"

    return [[lvl, de(v)] for lvl, v in rows if v and v not in ("-", "—", "–")]


def column_desc(col: list[list]) -> str:
    """Only where the value changes: "Stufe 1: +2 · Stufe 9: +3 · Stufe 16: +4"; a value that's
    always the level itself (Ki Points, Sorcery Points) in short."""
    if len(col) > 2 and all(str(v) == str(lvl) for lvl, v in col):
        return f"So viele wie die Stufe, ab Stufe {col[0][0]} (Stufe {col[0][0]}: {col[0][1]} … Stufe {col[-1][0]}: {col[-1][1]})"
    out, last = [], None
    for lvl, v in col:
        if v != last:
            out.append(f"Stufe {lvl}: {v}")
            last = v
    return " · ".join(out)


def _features(entry: dict) -> list[dict]:
    out = []
    for f in entry.get("features") or []:
        if f.get("feature_type") != "CLASS_LEVEL_FEATURE":
            continue
        levels = sorted({g.get("level") for g in f.get("gained_at") or [] if g.get("level")})
        col = _column(f.get("data_for_class_table"))
        if col and (not levels or (f.get("desc") or "").strip() == COLUMN_PLACEHOLDER):
            # Open5e lists the table columns as features whose text is only "[Column data]";
            # the values per level are what matters. column: kept for the sheets, text in German.
            out.append({"name": f.get("name"), "levels": [col[0][0]], "desc": column_desc(col), "column": col})
            continue
        out.append({"name": f.get("name"), "levels": levels, "desc": f.get("desc")})
    out.sort(key=lambda f: (f["levels"][0] if f["levels"] else 0, f["name"] or ""))
    return out


def _feature_text(entry: dict, feature_type: str) -> str | None:
    for f in entry.get("features") or []:
        if f.get("feature_type") == feature_type:
            return f.get("desc")
    return None


def _normalize_class(entry: dict) -> dict:
    row = _base(entry, "classes")
    hit_die = re.search(r"\d+", entry.get("hit_dice") or "")
    row["data"] = {
        "hit_die": int(hit_die.group()) if hit_die else None,
        "saves": [ABILITY_EN[s["name"].lower()] for s in entry.get("saving_throws") or [] if s.get("name", "").lower() in ABILITY_EN],
        "caster_type": entry.get("caster_type") if entry.get("caster_type") not in (None, "NONE") else None,
        "profs": _feature_text(entry, "PROFICIENCIES"),
        "equipment": _feature_text(entry, "STARTING_EQUIPMENT"),
        "features": _features(entry),
    }
    return row


def _normalize_subclass(entry: dict) -> dict:
    row = _base(entry, "subclasses")
    row["parent"] = (entry.get("subclass_of") or {}).get("name")
    row["data"] = {"features": _features(entry)}
    return row


def _traits(entry: dict) -> list[dict]:
    return [{"name": t.get("name"), "desc": t.get("desc"), "type": t.get("type")} for t in entry.get("traits") or []]


def _normalize_race(entry: dict, parent: dict | None = None) -> dict:
    row = _base(entry, "races")
    traits = _traits(entry)
    own_asi = parse_asi(next((t["desc"] for t in traits if "ability score" in (t["name"] or "").lower()), None))
    data = {"asi": own_asi, "speed": parse_speed(traits), "traits": traits}
    if parent:
        # A subrace (Hill Dwarf) includes everything of its people (Dwarf).
        p = _normalize_race(parent)
        row["parent"] = p["name"]
        data = {
            "asi": merge_asi(p["data"]["asi"], own_asi),
            "speed": {**(p["data"]["speed"] or {}), **(data["speed"] or {})} or None,
            "traits": p["data"]["traits"] + traits,
        }
        if not row["desc"]:
            row["desc"] = p["desc"]
    row["data"] = data
    return row


def race_data(traits: list[dict]) -> dict:
    """{asi, speed, traits} from traits [{name, desc, type}], as _normalize_race stores them. A subrace
    passes its people's traits first; every "Ability Score Increase" counts (Dwarf +2 CON, Hill +1 WIS)."""
    asi = merge_asi(*(parse_asi(t["desc"]) for t in traits if "ability score" in (t["name"] or "").lower()))
    return {"asi": asi, "speed": parse_speed(traits), "traits": traits}


def _normalize_background(entry: dict) -> dict:
    row = _base(entry, "backgrounds")
    benefits = [{"name": b.get("name"), "desc": b.get("desc"), "type": b.get("type")} for b in entry.get("benefits") or []]
    row["data"] = background_data(benefits)
    return row


def background_data(benefits: list[dict]) -> dict:
    """{asi, skills, skill_options, benefits} from benefits [{name, desc, type}] (Open5e's types:
    ability_score, skill_proficiency, tool_proficiency, language, equipment, feat …)."""
    asi_text = next((b["desc"] for b in benefits if b["type"] == "ability_score"), None)
    skills_text = next((b["desc"] for b in benefits
                        if b["type"] == "skill_proficiency" or (b["name"] or "").lower().startswith("skill proficienc")), None)
    skills = parse_skills(skills_text)
    # "Religion, and either Insight or Persuasion": the player picks, so nothing is ticked automatically.
    choice = bool(re.search(r"\b(choose|either|or)\b", (skills_text or "").lower()))
    return {"asi": parse_asi(asi_text), "skills": [] if choice else skills,
            "skill_options": skills if choice else [], "benefits": benefits}


FEAT_TYPES = {"origin": "Origin", "general": "General", "fighting style": "Fighting Style", "epic boon": "Epic Boon"}


def feat_desc(intro: str | None, benefits: list[str]) -> str:
    """The intro, then each benefit as a list item."""
    listed = "\n".join(f"- {b.strip()}" for b in benefits if b and b.strip())
    return "\n\n".join(p for p in [(intro or "").strip(), listed] if p)


def feat_data(desc: str | None, feat_type: str | None, prerequisite: str | None) -> dict:
    return {
        "feat_type": FEAT_TYPES.get((feat_type or "").strip().lower(), (feat_type or "").strip() or None),
        "prerequisite": (prerequisite or "").strip() or None,
        "asi": parse_feat_asi(desc),
        "repeatable": bool(re.search(r"take this feat more than once", desc or "", flags=re.I)),
    }


def _normalize_feat(entry: dict) -> dict:
    row = _base(entry, "feats")
    row["desc"] = feat_desc(entry.get("desc"), [b.get("desc") for b in entry.get("benefits") or []]) or None
    row["data"] = feat_data(row["desc"], entry.get("type"), entry.get("prerequisite"))
    return row


_cache: dict[str, tuple[float, list[dict]]] = {}


async def _collection(kind: str) -> list[dict]:
    url = SOURCES[kind]
    hit = _cache.get(url)
    if hit and time.monotonic() - hit[0] < CACHE_SECONDS:
        return hit[1]
    out = []
    async with httpx.AsyncClient(timeout=60, follow_redirects=True) as client:
        next_url, params = url, {"limit": 200}
        while next_url:
            resp = await client.get(next_url, params=params)
            resp.raise_for_status()
            data = resp.json()
            out.extend(data.get("results", []))
            next_url, params = data.get("next"), None
    _cache[url] = (time.monotonic(), out)
    return out


async def fetch_kind(kind: str, srd_only: bool = False) -> list[dict]:
    """All Open5e entries of a kind, normalized."""
    entries = await _collection(kind)
    if kind == "classes":
        entries = [e for e in entries if not e.get("subclass_of")]
    elif kind == "subclasses":
        entries = [e for e in entries if e.get("subclass_of")]
    if srd_only:
        entries = [e for e in entries if (e.get("document") or {}).get("key") in SRD_DOCUMENTS]
    if kind == "races":
        by_key = {e["key"]: e for e in await _collection("races")}
        return [_normalize_race(e, by_key.get(e.get("subspecies_of"))) for e in entries]
    normalize = {"classes": _normalize_class, "subclasses": _normalize_subclass, "backgrounds": _normalize_background,
                 "feats": _normalize_feat}[kind]
    return [normalize(e) for e in entries]


async def search(kind: str, query: str, limit: int = 30) -> list[dict]:
    q = query.lower().strip()
    hits = [e for e in await fetch_kind(kind) if q in (e["name"] or "").lower() or q in (e["name_en"] or "").lower()]
    hits.sort(key=lambda e: (min(open5e._name_relevance(e["name"], q), open5e._name_relevance(e["name_en"], q)), e["name"]))
    return [{k: e[k] for k in ("slug", "name", "name_en", "parent", "source_name", "is_2024")} for e in hits[:limit]]


async def get_one(kind: str, slug: str) -> dict | None:
    return next((e for e in await fetch_kind(kind) if e["slug"] == slug), None)


# ---------- storage ----------

def _kind(kind: str) -> str:
    if kind not in KINDS:
        raise HTTPException(404, "unknown category")
    return kind


def _counted(f: dict) -> bool:
    """Traits and benefits the sheet counts languages and skill proficiencies from keep their text."""
    desc = (f.get("desc") or "").lower()
    return "language" in (f.get("name") or "").lower() or f.get("type") in ("language", "feat") or (
        "proficien" in desc and "skill" in desc)


def option_row(row, lean: bool = False) -> dict:
    """lean: without the long texts, for the character sheets (descriptions are fetched on click)."""
    out = dict(row)
    out["data"] = json.loads(out["data"] or "{}")
    if out.get("kind") == "subclasses":
        for f in out["data"].get("features") or []:
            f.pop("grants", None)
            g = parse_grants(f)
            if g:
                f["grants"] = g
    if lean:
        out.pop("desc", None)
        out.pop("notes", None)
        for key in ("features", "traits", "benefits"):
            if key in out["data"]:
                out["data"][key] = [f if _counted(f) else {k: v for k, v in f.items() if k != "desc"} for f in out["data"][key]]
        out["data"].pop("equipment", None)
    return out


def list_options(conn, kind: str | None = None, lean: bool = False) -> list[dict]:
    if kind:
        rows = conn.execute("SELECT * FROM char_options WHERE kind = ? ORDER BY name, is_2024", (kind,))
    else:
        rows = conn.execute("SELECT * FROM char_options ORDER BY kind, name, is_2024")
    return [option_row(r, lean) for r in rows]


def get_option(conn, option_id: int) -> dict:
    row = conn.execute("SELECT * FROM char_options WHERE id = ?", (option_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "not found")
    return option_row(row)


def insert_open5e(conn, entry: dict) -> int:
    return conn.execute(
        "INSERT INTO char_options (kind, name, name_en, parent, is_2024, data, desc, source, notes) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, 'import', ?)",
        (entry["kind"], entry["name"], entry["name_en"], entry["parent"], int(entry["is_2024"]),
         json.dumps(entry["data"]), entry["desc"], open5e.import_note(entry)),
    ).lastrowid


async def repair_columns() -> int:
    """Entries imported before the class table columns were read still say "[Column data]":
    fetch those classes and subclasses from Open5e once more and fill in the values. Runs on
    start; without internet it simply tries again on the next start. Returns the features fixed."""
    with get_conn() as conn:
        rows = [dict(r) for r in conn.execute(
            "SELECT id, kind, name_en, is_2024, data FROM char_options WHERE kind IN ('classes', 'subclasses') "
            "AND data LIKE ?", (f"%{COLUMN_PLACEHOLDER}%",))]
    if not rows:
        return 0
    entries = await _collection("classes")
    fresh: dict[tuple, dict] = {}
    for e in entries:
        is_sub = bool(e.get("subclass_of"))
        norm = _normalize_subclass(e) if is_sub else _normalize_class(e)
        key = ("subclasses" if is_sub else "classes", (norm["name_en"] or "").lower(), int(norm["is_2024"]))
        fresh[key] = {f["name"]: f for f in norm["data"]["features"] if f.get("column")}
    fixed = 0
    with get_conn() as conn:
        for r in rows:
            cols = fresh.get((r["kind"], (r["name_en"] or "").lower(), int(r["is_2024"])))
            if not cols:
                continue
            data = json.loads(r["data"] or "{}")
            changed = False
            for f in data.get("features") or []:
                new = cols.get(f.get("name"))
                if new and (f.get("desc") or "").strip() == COLUMN_PLACEHOLDER:
                    f.update(levels=new["levels"], desc=new["desc"], column=new["column"])
                    changed = True
                    fixed += 1
            if changed:
                conn.execute("UPDATE char_options SET data = ? WHERE id = ?", (json.dumps(data), r["id"]))
    return fixed


def existing_keys(conn, kind: str) -> set[tuple[str, int]]:
    """Name and ruleset, so the 2014 and 2024 versions of a class can both be imported. The English
    name counts too: an entry replaced from D&D Beyond may carry it as its name."""
    keys = set()
    for r in conn.execute("SELECT name, name_en, is_2024 FROM char_options WHERE kind = ?", (kind,)):
        for n in (r["name"], r["name_en"]):
            if n:
                keys.add((n.strip().lower(), r["is_2024"]))
    return keys


def entry_keys(entry: dict) -> set[tuple[str, int]]:
    """The keys existing_keys() would give this (normalized Open5e) entry."""
    return {(n.strip().lower(), int(entry["is_2024"])) for n in (entry.get("name"), entry.get("name_en")) if n and n.strip()}


class OptionIn(BaseModel):
    name: str
    name_en: Optional[str] = None
    parent: Optional[str] = None
    is_2024: bool = False
    data: dict = {}
    desc: Optional[str] = None
    notes: Optional[str] = None


@router.get("/api/options")
def all_options(lean: bool = True):
    """Everything the character sheet offers in its dropdowns."""
    with get_conn() as conn:
        mem = translate.Memory(conn)
        return [translate.attach_option(o, mem) for o in list_options(conn, lean=lean)]


@router.get("/api/options/entry/{option_id}")
def read_option(option_id: int):
    with get_conn() as conn:
        return translate.attach_option(get_option(conn, option_id), translate.Memory(conn))


@router.get("/api/options/{kind}")
def list_kind(kind: str):
    with get_conn() as conn:
        mem = translate.Memory(conn)
        return [translate.attach_option(o, mem) for o in list_options(conn, _kind(kind))]


@router.post("/api/options/{kind}")
def create_option(kind: str, body: OptionIn):
    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO char_options (kind, name, name_en, parent, is_2024, data, desc, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (_kind(kind), body.name, body.name_en or body.name, body.parent, int(body.is_2024),
             json.dumps(body.data), body.desc, body.notes),
        )
        return get_option(conn, cur.lastrowid)


@router.put("/api/options/{kind}/{option_id}")
def update_option(kind: str, option_id: int, body: OptionIn):
    with get_conn() as conn:
        get_option(conn, option_id)
        conn.execute(
            "UPDATE char_options SET name=?, name_en=?, parent=?, is_2024=?, data=?, desc=?, notes=? WHERE id=? AND kind=?",
            (body.name, body.name_en or body.name, body.parent, int(body.is_2024), json.dumps(body.data),
             body.desc, body.notes, option_id, _kind(kind)),
        )
        return get_option(conn, option_id)


@router.delete("/api/options/{kind}/{option_id}")
def delete_option(kind: str, option_id: int):
    with get_conn() as conn:
        conn.execute("DELETE FROM char_options WHERE id = ? AND kind = ?", (option_id, _kind(kind)))
    return {"ok": True}


@router.get("/api/options/{kind}/open5e/search")
async def search_open5e(kind: str, q: str):
    return await search(_kind(kind), q)


@router.post("/api/options/{kind}/import-open5e/{slug}")
async def import_open5e(kind: str, slug: str):
    entry = await get_one(_kind(kind), slug)
    if entry is None:
        raise HTTPException(404, "not found on open5e")
    with get_conn() as conn:
        # Same check as the import of a whole category: name (German or English) and ruleset.
        if entry_keys(entry) & existing_keys(conn, entry["kind"]):
            raise HTTPException(409, f"{entry['name']} ist schon in der Bibliothek.")
        return get_option(conn, insert_open5e(conn, entry))
