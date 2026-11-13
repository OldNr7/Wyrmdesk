import re

import httpx

from .statblock import build_stat_block

# Monsters and spells use Open5e's v2 API: substantially more content than v1
# (3541 vs 3207 creatures, 1955 vs 1435 spells at last check) and it's the
# only place the 2024 SRD (5.2) shows up at all. Magic items stay on v1
# because v2's "items" endpoint currently only covers the 2024 SRD's base
# equipment (~440 entries) and is missing the ~1700 magic items (incl.
# Kobold Press etc.) that v1's magicitems/armor/weapons endpoints have.
CREATURES_BASE = "https://api.open5e.com/v2/creatures/"
SPELLS_BASE = "https://api.open5e.com/v2/spells/"
SEARCH_POOL_SIZE = 150


def _name_relevance(name: str, query: str) -> int:
    """Lower is better. Open5e's own 'search' matches across description text
    too and returns results in no particular order, so an exact-ish name match
    for 'orc' can end up buried behind 100 unrelated monsters. Re-rank by how
    closely the NAME matches what was typed."""
    name_l = name.lower().strip()
    q = query.lower().strip()
    if name_l == q:
        return 0
    if name_l.startswith(q):
        return 1
    if re.search(rf"\b{re.escape(q)}", name_l):
        return 2
    if q in name_l:
        return 3
    return 4


# ---------- shared v2 helpers (document/2024 provenance, generic search) ----------


def _doc_info(document: dict | None) -> dict:
    """Every v2 record carries its source document, including which ruleset
    it belongs to. gamesystem.key is '5e-2024' only for the 2024 SRD (5.2)
    and Open5e's own 2024-tagged originals; everything else, including the
    2014 SRD and all third-party books, is '5e-2014'."""
    document = document or {}
    gamesystem = document.get("gamesystem") or {}
    return {
        "source_name": document.get("name"),
        "is_2024": gamesystem.get("key") == "5e-2024",
    }


def import_note(entry: dict) -> str:
    """The note recorded on every online-imported bestiary/item/spell entry,
    naming its source document and flagging 2024-ruleset (SRD 5.2) content
    explicitly, so the DM can tell at a glance which ruleset a given entry
    follows."""
    source = entry.get("source_name") or entry.get("slug") or "Open5e"
    note = f"Importiert von Open5e ({source})"
    if entry.get("is_2024"):
        note += " – 2024-Regeln (SRD 5.2)"
    return note


async def _search_v2(base_url: str, query: str, limit: int, normalize, pool_size: int = 50) -> list[dict]:
    """v2's 'search' query param is ignored server-side (it returns the whole
    unfiltered, alphabetical collection), so name__icontains is used instead.
    That's already a much tighter match than v1's full-text search, hence the
    smaller pool before re-ranking."""
    async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
        resp = await client.get(base_url, params={"name__icontains": query, "limit": pool_size})
        resp.raise_for_status()
        data = resp.json()
    results = [normalize(entry) for entry in data.get("results", [])]
    results.sort(key=lambda r: (_name_relevance(r["name"] or "", query), r["name"] or ""))
    return results[:limit]


async def _get_one_v2(base_url: str, key: str, normalize) -> dict | None:
    async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
        resp = await client.get(f"{base_url}{key}/")
        if resp.status_code == 404:
            return None
        resp.raise_for_status()
    return normalize(resp.json())


# ---------- monsters (creatures) ----------

CR_FRACTIONS = {0.125: "1/8", 0.25: "1/4", 0.5: "1/2"}


def _format_cr(cr) -> str | None:
    if cr is None:
        return None
    if cr in CR_FRACTIONS:
        return CR_FRACTIONS[cr]
    return str(int(cr)) if float(cr).is_integer() else str(cr)


def _normalize_creature(entry: dict) -> dict:
    d = _doc_info(entry.get("document"))
    return {
        "slug": entry.get("key"),
        "name": entry.get("name"),
        "size": (entry.get("size") or {}).get("name"),
        "type": (entry.get("type") or {}).get("key"),
        "ac": entry.get("armor_class"),
        "hp": entry.get("hit_points"),
        "challenge_rating": _format_cr(entry.get("challenge_rating")),
        "source_name": d["source_name"],
        "is_2024": d["is_2024"],
    }


SENSE_FIELDS = [
    ("darkvision_range", "darkvision"),
    ("blindsight_range", "blindsight"),
    ("tremorsense_range", "tremorsense"),
    ("truesight_range", "truesight"),
]


def _senses_text(entry: dict) -> str | None:
    parts = [f"{label} {entry[key]} ft." for key, label in SENSE_FIELDS if entry.get(key)]
    return ", ".join(parts) or None


def _speed_dict(speed: dict | None) -> dict | None:
    """The frontend's formatSpeed() already knows how to render a {walk,
    fly, swim, ...} dict; it just doesn't expect the 'unit' key v2 adds."""
    if not speed:
        return None
    return {k: v for k, v in speed.items() if k != "unit"} or None


LEGENDARY_INTRO_RE = re.compile(r"\bcan take \d+ legendary actions?\b", re.I)


def _actions_by_type(actions: list | None, *types: str) -> list[dict]:
    items = sorted(
        (a for a in (actions or []) if a.get("action_type") in types),
        key=lambda a: a.get("order_in_statblock") or 0,
    )
    return [{"name": a.get("name"), "desc": a.get("desc")} for a in items]


def _legendary_actions(actions: list | None) -> tuple[str | None, list[dict]]:
    """v2 sometimes stores the 'can take N legendary actions...' preamble as
    a fake first legendary action rather than a separate field; split it back
    out into legendary_desc when present. Not every creature has it (mainly
    an A5e/third-party thing) — SRD dragons, for example, don't carry it."""
    items = sorted(
        (a for a in (actions or []) if a.get("action_type") == "LEGENDARY_ACTION"),
        key=lambda a: a.get("order_in_statblock") or 0,
    )
    desc = None
    if items and LEGENDARY_INTRO_RE.search(items[0].get("name") or ""):
        intro = items.pop(0)
        desc = f"{intro.get('name', '')}. {intro.get('desc') or ''}".strip()
    return desc, [{"name": a.get("name"), "desc": a.get("desc")} for a in items]


def _full_creature(entry: dict) -> dict:
    normalized = _normalize_creature(entry)
    scores = entry.get("ability_scores") or {}
    ri = entry.get("resistances_and_immunities") or {}
    legendary_desc, legendary_actions = _legendary_actions(entry.get("actions"))
    normalized["initiative_bonus"] = entry.get("initiative_bonus") or 0
    normalized["stat_block"] = build_stat_block(
        abilities={
            "str": scores.get("strength"),
            "dex": scores.get("dexterity"),
            "con": scores.get("constitution"),
            "int": scores.get("intelligence"),
            "wis": scores.get("wisdom"),
            "cha": scores.get("charisma"),
        },
        challenge_rating=normalized["challenge_rating"],
        size=normalized["size"],
        speed=_speed_dict(entry.get("speed")),
        senses=_senses_text(entry),
        passive_perception=entry.get("passive_perception"),
        languages=(entry.get("languages") or {}).get("as_string"),
        damage_vulnerabilities=ri.get("damage_vulnerabilities_display") or None,
        damage_resistances=ri.get("damage_resistances_display") or None,
        damage_immunities=ri.get("damage_immunities_display") or None,
        condition_immunities=ri.get("condition_immunities_display") or None,
        special_abilities=[
            {"name": t.get("name"), "desc": t.get("desc")} for t in (entry.get("traits") or [])
        ],
        # Bonus actions have no dedicated slot in our schema, so they're folded
        # into "actions" — the same thing the .odt importer does.
        actions=_actions_by_type(entry.get("actions"), "ACTION", "BONUS_ACTION"),
        reactions=_actions_by_type(entry.get("actions"), "REACTION"),
        legendary_desc=legendary_desc,
        legendary_actions=legendary_actions,
    )
    return normalized


async def search_monsters(query: str, limit: int = 20) -> list[dict]:
    return await _search_v2(CREATURES_BASE, query, limit, _normalize_creature)


async def get_monster(slug: str) -> dict | None:
    return await _get_one_v2(CREATURES_BASE, slug, _normalize_creature)


async def get_monster_full(slug: str) -> dict | None:
    return await _get_one_v2(CREATURES_BASE, slug, _full_creature)


# ---------- generic v1 search helper, reused by items below ----------


async def _search(base_url: str, query: str, limit: int, normalize) -> list[dict]:
    async with httpx.AsyncClient(timeout=10, follow_redirects=True) as client:
        resp = await client.get(base_url, params={"search": query, "limit": SEARCH_POOL_SIZE})
        resp.raise_for_status()
        data = resp.json()
    results = [normalize(entry) for entry in data.get("results", [])]
    results.sort(key=lambda r: (_name_relevance(r["name"] or "", query), r["name"] or ""))
    return results[:limit]


async def _get_one(base_url: str, slug: str, normalize) -> dict | None:
    async with httpx.AsyncClient(timeout=10, follow_redirects=True) as client:
        resp = await client.get(f"{base_url}{slug}/")
        if resp.status_code == 404:
            return None
        resp.raise_for_status()
    return normalize(resp.json())


# ---------- magic items (still v1 — see note at the top of this file) ----------

ITEMS_BASE = "https://api.open5e.com/v1/magicitems/"


def _normalize_item(entry: dict) -> dict:
    return {
        "slug": entry.get("slug"),
        "name": entry.get("name"),
        "item_type": entry.get("type"),
        "rarity": entry.get("rarity"),
        "requires_attunement": bool(entry.get("requires_attunement")),
        "desc": entry.get("desc"),
        "source_name": entry.get("document__title"),
        "is_2024": False,  # v1 predates the 2024 ruleset; nothing here is 2024 content.
    }


async def search_items(query: str, limit: int = 20) -> list[dict]:
    return await _search(ITEMS_BASE, query, limit, _normalize_item)


async def get_item_full(slug: str) -> dict | None:
    return await _get_one(ITEMS_BASE, slug, _normalize_item)


# ---------- mundane armor and weapons (SRD, v1) ----------

ARMOR_BASE = "https://api.open5e.com/v1/armor/"
WEAPONS_BASE = "https://api.open5e.com/v1/weapons/"
ARMOR_CATEGORIES = {"Light Armor": "light", "Medium Armor": "medium", "Heavy Armor": "heavy", "Shield": "shield"}
SRD_EQUIPMENT_NOTE = "Importiert von Open5e (SRD-Ausrüstung)"


def _armor_item(entry: dict) -> dict | None:
    """Open5e also lists class features and spells (Unarmored Defense, Mage Armor) as
    armor; those are handled by the character sheet itself, so only real armor is kept.
    max_dex: None = full DEX modifier, 0 = none, otherwise the cap."""
    category = ARMOR_CATEGORIES.get(entry.get("category"))
    if category is None:
        return None
    if category == "shield":
        armor = {"category": "shield", "base_ac": 2, "max_dex": 0}
    else:
        max_dex = (entry.get("plus_max") or None) if entry.get("plus_dex_mod") else 0
        armor = {"category": category, "base_ac": entry.get("base_ac"), "max_dex": max_dex}
    armor.update(
        bonus=0,
        str_req=entry.get("strength_requirement") or None,
        stealth_disadvantage=bool(entry.get("stealth_disadvantage")),
    )
    lines = [f"**AC:** {entry.get('ac_string')}", f"**Cost:** {entry.get('cost') or '-'}"]
    if armor["str_req"]:
        lines.append(f"**Strength:** {armor['str_req']}")
    if armor["stealth_disadvantage"]:
        lines.append("**Stealth:** Disadvantage")
    return {
        "name": entry.get("name"),
        "item_type": "Shield" if category == "shield" else f"Armor ({category})",
        "desc": "\n".join(lines),
        "stat_block": {"armor": armor, "cost": entry.get("cost"), "weight": entry.get("weight") or None},
        "notes": SRD_EQUIPMENT_NOTE,
    }


def _weapon_item(entry: dict) -> dict:
    category = (entry.get("category") or "").replace(" Weapons", "")
    props = entry.get("properties") or []
    weapon = {
        "category": category,
        "damage_dice": entry.get("damage_dice"),
        "damage_type": entry.get("damage_type"),
        "properties": props,
    }
    lines = [
        f"**Damage:** {weapon['damage_dice'] or '-'} {weapon['damage_type'] or ''}".rstrip(),
        f"**Properties:** {', '.join(props) if props else '-'}",
        f"**Cost:** {entry.get('cost') or '-'}",
    ]
    return {
        "name": entry.get("name"),
        "item_type": f"Weapon ({category.lower()})",
        "desc": "\n".join(lines),
        "stat_block": {"weapon": weapon, "cost": entry.get("cost"), "weight": entry.get("weight") or None},
        "notes": SRD_EQUIPMENT_NOTE,
    }


async def get_srd_equipment() -> list[dict]:
    params = {"document__slug": "wotc-srd", "limit": 200}
    async with httpx.AsyncClient(timeout=15, follow_redirects=True) as client:
        resp_a = await client.get(ARMOR_BASE, params=params)
        resp_w = await client.get(WEAPONS_BASE, params=params)
    for resp in (resp_a, resp_w):
        resp.raise_for_status()
    armor = resp_a.json()["results"]
    weapons = resp_w.json()["results"]
    items = [a for a in (_armor_item(e) for e in armor) if a] + [_weapon_item(e) for e in weapons]
    return sorted(items, key=lambda i: i["name"])


# ---------- spells (v2) ----------

CASTING_TIME_LABELS = {
    "action": "1 action",
    "bonus-action": "1 bonus action",
    "reaction": "1 reaction",
}
CASTING_TIME_DURATION_RE = re.compile(r"^(\d+)(minute|hour|day)s?$")


def _casting_time_text(entry: dict) -> str | None:
    ct = (entry.get("casting_time") or "").strip()
    if not ct:
        return None
    if ct in CASTING_TIME_LABELS:
        label = CASTING_TIME_LABELS[ct]
    else:
        m = CASTING_TIME_DURATION_RE.match(ct)
        if m:
            n, unit = m.groups()
            label = f"{n} {unit}" + ("s" if n != "1" else "")
        else:
            label = ct.replace("-", " ").replace("_", " ")
    if ct == "reaction" and entry.get("reaction_condition"):
        label = f"{label}, {entry['reaction_condition']}"
    return label


def _components_text(entry: dict) -> str:
    parts = []
    if entry.get("verbal"):
        parts.append("V")
    if entry.get("somatic"):
        parts.append("S")
    if entry.get("material"):
        parts.append("M")
    return ", ".join(parts)


def _normalize_spell(entry: dict) -> dict:
    d = _doc_info(entry.get("document"))
    classes = ", ".join(c.get("name") for c in (entry.get("classes") or []) if c.get("name"))
    return {
        "slug": entry.get("key"),
        "name": entry.get("name"),
        "school": (entry.get("school") or {}).get("name"),
        "level_int": entry.get("level"),
        "dnd_class": classes or None,
        "casting_time": _casting_time_text(entry),
        "range": entry.get("range_text"),
        "components": _components_text(entry),
        "material": entry.get("material_specified") or None,
        "duration": entry.get("duration"),
        "concentration": bool(entry.get("concentration")),
        "ritual": bool(entry.get("ritual")),
        "desc": entry.get("desc"),
        "higher_level": entry.get("higher_level"),
        "source_name": d["source_name"],
        "is_2024": d["is_2024"],
    }


async def search_spells(query: str, limit: int = 20) -> list[dict]:
    return await _search_v2(SPELLS_BASE, query, limit, _normalize_spell)


async def get_spell_full(slug: str) -> dict | None:
    return await _get_one_v2(SPELLS_BASE, slug, _normalize_spell)


# ---------- bulk import ----------

# "SRD only" spans both official WotC documents so a DM who only wants core
# rules gets both the 2014 and 2024 versions, clearly labeled, rather than
# just one of them.
SRD_DOCUMENT_KEYS = "srd-2014,srd-2024"

BULK_SOURCES = {
    "monsters": (CREATURES_BASE, _full_creature, True),
    "items": (ITEMS_BASE, _normalize_item, False),
    "spells": (SPELLS_BASE, _normalize_spell, True),
}


def _bulk_params(is_v2: bool, srd_only: bool, limit: int) -> dict:
    if is_v2:
        params = {"limit": limit}
        if srd_only:
            params["document__key__in"] = SRD_DOCUMENT_KEYS
        return params
    params = {"limit": limit}
    if srd_only:
        params["document__slug"] = "wotc-srd"
    return params


async def creature_sizes() -> dict[str, str]:
    """Name (lower case) -> size ("Medium") of every Open5e creature. Only the two fields are
    asked for, so all ~3500 come in a few seconds (full entries time out). Where several sources
    share a name, the 2014 SRD wins, then the 2024 one, then the first other."""
    rank = lambda key: 0 if key.startswith("srd_") else 1 if key.startswith("srd-2024_") else 2  # noqa: E731
    best: dict[str, tuple[int, str]] = {}
    url, params = CREATURES_BASE, {"fields": "key,name,size", "limit": 500}
    async with httpx.AsyncClient(timeout=90, follow_redirects=True) as client:
        while url:
            resp = await client.get(url, params=params)
            resp.raise_for_status()
            data = resp.json()
            for e in data.get("results", []):
                name, size = (e.get("name") or "").strip().lower(), (e.get("size") or {}).get("name")
                r = rank(e.get("key") or "")
                if name and size and (name not in best or r < best[name][0]):
                    best[name] = (r, size)
            url, params = data.get("next"), None  # "next" already carries the query
    return {name: size for name, (_, size) in best.items()}


async def count_all(kind: str, srd_only: bool) -> int:
    base, _, is_v2 = BULK_SOURCES[kind]
    async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
        resp = await client.get(base, params=_bulk_params(is_v2, srd_only, 1))
        resp.raise_for_status()
    return resp.json().get("count", 0)


async def fetch_all(kind: str, srd_only: bool) -> list[dict]:
    """Every entry of a category, page by page, normalized like a single import.
    Each entry keeps its slug/source so the importer can note where it came from.
    v2 (monsters/spells) is noticeably slower per page than v1 ever was, hence
    the smaller page size and longer per-request timeout."""
    base, normalize, is_v2 = BULK_SOURCES[kind]
    page_size = 100 if is_v2 else 500
    timeout = 40 if is_v2 else 60
    out = []
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
        url, params = base, _bulk_params(is_v2, srd_only, page_size)
        while url:
            resp = await client.get(url, params=params)
            resp.raise_for_status()
            data = resp.json()
            out.extend(normalize(e) for e in data.get("results", []))
            url, params = data.get("next"), None  # "next" already carries the query
    return out
