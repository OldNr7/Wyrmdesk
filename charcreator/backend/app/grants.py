"""What a subclass feature grants, read from its English text (same as char_options.parse_grants
in the Kampagnenbuch, dmtool/backend/app/char_options.py - keep the two in step).

The content pack uploaded from the Kampagnenbuch may come from an older version without grants, so
they are read here again at every load of the options (never stored).
"""
import re

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
