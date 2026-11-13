"""Player characters and the bestiary, item and spell library.

The paths are the ones the tracker used, so its frontend code came along unchanged. The tracker and the
battlemap read these through the API; whenever a character or monster changes, the tracker is told
(tracker.sync_character / sync_monster) so the combatants already in its encounters follow.
"""
import json
from typing import Optional
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from . import char_options, monster_import, open5e, tracker, translate
from .characters import CharacterFields, character_row, get_character, new_version, save_character, set_character_hp
from .db import IMAGE_EXTS, UPLOAD_DIR, get_conn, row_to_dict

router = APIRouter()


class CharacterIn(CharacterFields):
    campaign_id: int


class CustomMonsterIn(BaseModel):
    name: str
    max_hp: int
    ac: int
    initiative_bonus: int = 0
    challenge_rating: Optional[str] = None
    notes: Optional[str] = None
    stat_block: Optional[dict] = None
    creature_type: Optional[str] = None
    # None = leave unchanged on update; create falls back to the DB defaults
    # ('custom' / verified). Only the .odt import flow sets these explicitly.
    source: Optional[str] = None
    verified: Optional[bool] = None


class CustomItemIn(BaseModel):
    name: str
    item_type: Optional[str] = None
    rarity: Optional[str] = None
    requires_attunement: bool = False
    desc: Optional[str] = None
    stat_block: Optional[dict] = None  # {"armor": {...}} / {"weapon": {...}}, see open5e._armor_item
    notes: Optional[str] = None  # None on update = leave unchanged (e.g. import provenance)


class CustomSpellIn(BaseModel):
    name: str
    school: Optional[str] = None
    level_int: Optional[int] = None
    dnd_class: Optional[str] = None
    casting_time: Optional[str] = None
    range: Optional[str] = None
    components: Optional[str] = None
    material: Optional[str] = None
    duration: Optional[str] = None
    concentration: bool = False
    ritual: bool = False
    higher_level: Optional[str] = None
    desc: Optional[str] = None
    notes: Optional[str] = None  # None on update = leave unchanged (e.g. import provenance)


# ---------- characters (roster) ----------
# Each character has a 'pc' entry (type "Gruppe") for notes and [[links]]; name and picture are kept the same on both.

def create_character_row(conn, campaign_id: int, body: CharacterFields, entry_id: int | None = None) -> dict:
    """A new character, with its notes entry unless one is given."""
    if entry_id is None:
        entry_id = conn.execute(
            "INSERT INTO entries (campaign_id, type, name, known) VALUES (?, 'pc', ?, 1)", (campaign_id, body.name)
        ).lastrowid
    stat_block = json.dumps(body.stat_block) if body.stat_block is not None else None
    cur = conn.execute(
        "INSERT INTO characters (campaign_id, entry_id, name, max_hp, ac, initiative_bonus, notes, stat_block, "
        "updated_at, current_hp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (campaign_id, entry_id, body.name, body.max_hp, body.ac, body.initiative_bonus, body.notes, stat_block,
         new_version(), body.max_hp),
    )
    return get_character(conn, cur.lastrowid)


def set_character_avatar(conn, char_id: int, avatar_path: str | None) -> dict:
    """Portrait of the character and of its notes entry, which are the same person."""
    conn.execute("UPDATE characters SET avatar_path = ? WHERE id = ?", (avatar_path, char_id))
    char = get_character(conn, char_id)
    if char["entry_id"] is not None:
        conn.execute("UPDATE entries SET image = ? WHERE id = ?", (avatar_path, char["entry_id"]))
    return char


def save_image(data: bytes, filename: str, allow_svg: bool = False) -> str:
    """allow_svg: only for pictures of this tool's own (the class placeholders of a character import);
    an uploaded SVG could carry scripts."""
    ext = (filename or "").rsplit(".", 1)[-1].lower()
    if ext not in IMAGE_EXTS and not (allow_svg and ext == "svg"):
        raise HTTPException(400, f"unsupported image type: {ext}")
    # Unique name per upload: uploads are cached as immutable, so a new picture needs a new address.
    name = f"{uuid4().hex}.{ext}"
    (UPLOAD_DIR / name).write_bytes(data)
    return f"/uploads/{name}"


@router.get("/api/characters")
def list_characters(campaign_id: int):
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM characters WHERE campaign_id = ? ORDER BY name", (campaign_id,)
        ).fetchall()
        return [character_row(r) for r in rows]


@router.get("/api/characters/{char_id}")
def read_character(char_id: int):
    with get_conn() as conn:
        return get_character(conn, char_id)


@router.post("/api/characters")
async def create_character(body: CharacterIn):
    with get_conn() as conn:
        char = create_character_row(conn, body.campaign_id, body)
    return char


@router.put("/api/characters/{char_id}")
async def update_character(char_id: int, body: CharacterIn):
    with get_conn() as conn:
        char = save_character(conn, char_id, body)
    await tracker.sync_character(char)
    return char


@router.delete("/api/characters/{char_id}")
async def delete_character(char_id: int):
    with get_conn() as conn:
        row = conn.execute("SELECT entry_id FROM characters WHERE id = ?", (char_id,)).fetchone()
        # Its combatants stay in their encounters, as manual entries with its last values.
        tracker.unlink_character(conn, char_id)
        conn.execute("DELETE FROM characters WHERE id = ?", (char_id,))
        if row is not None and row["entry_id"] is not None:
            conn.execute("DELETE FROM entries WHERE id = ?", (row["entry_id"],))
    await tracker.prune_roster()
    return {"ok": True}


@router.post("/api/characters/{char_id}/avatar")
async def upload_character_avatar(char_id: int, filename: str, request: Request):
    data = await request.body()
    with get_conn() as conn:
        get_character(conn, char_id)
        char = set_character_avatar(conn, char_id, save_image(data, filename))
    await tracker.sync_character(char)
    return char


@router.delete("/api/characters/{char_id}/avatar")
async def delete_character_avatar(char_id: int):
    with get_conn() as conn:
        get_character(conn, char_id)
        char = set_character_avatar(conn, char_id, None)
    await tracker.sync_character(char)
    return char


class HpSet(BaseModel):
    current_hp: int
    temp_hp: int = 0
    # The values the change started from, as the sender saw them. Given, only the difference is applied,
    # so a change made here meanwhile (a player's damage or healing) is kept.
    from_hp: Optional[int] = None
    from_temp: Optional[int] = None


@router.put("/api/characters/{char_id}/hp")
async def set_hp(char_id: int, body: HpSet):
    """Set by the tracker (and the battlemap through it) when a combatant of this character takes damage or heals."""
    with get_conn() as conn:
        c = get_character(conn, char_id)
        hp, temp = body.current_hp, body.temp_hp
        if body.from_hp is not None:
            hp = (c["current_hp"] if c["current_hp"] is not None else c["max_hp"]) + body.current_hp - body.from_hp
        if body.from_temp is not None:
            temp = (c["temp_hp"] or 0) + body.temp_hp - body.from_temp
        set_character_hp(conn, char_id, hp, temp)
        char = get_character(conn, char_id)
    # The same person may stand in other encounters too.
    await tracker.sync_character(char)
    return char


def refuse_duplicate(conn, table: str, name: str) -> None:
    """A single Open5e import of a name the library already has: refused, as the import of a whole
    category skips it (by name, case ignored)."""
    if conn.execute(f"SELECT 1 FROM {table} WHERE lower(name) = lower(?)", ((name or "").strip(),)).fetchone():
        raise HTTPException(409, f"{name} ist schon in der Bibliothek.")


# ---------- custom monsters (bestiary) ----------

def _custom_monster_row(row) -> dict:
    d = row_to_dict(row)
    d["stat_block"] = json.loads(d["stat_block"]) if d["stat_block"] else None
    return d


def _get_monster(conn, monster_id: int) -> dict:
    row = conn.execute("SELECT * FROM custom_monsters WHERE id = ?", (monster_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "custom monster not found")
    return _custom_monster_row(row)


@router.get("/api/monsters/custom")
def list_custom_monsters():
    with get_conn() as conn:
        rows = conn.execute("SELECT * FROM custom_monsters ORDER BY name").fetchall()
        return [_custom_monster_row(r) for r in rows]


@router.get("/api/monsters/custom/{monster_id}")
def read_custom_monster(monster_id: int):
    with get_conn() as conn:
        return _get_monster(conn, monster_id)


@router.post("/api/monsters/custom")
def create_custom_monster(body: CustomMonsterIn):
    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO custom_monsters (name, max_hp, ac, initiative_bonus, challenge_rating, notes, "
            "stat_block, creature_type, source, verified) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                body.name,
                body.max_hp,
                body.ac,
                body.initiative_bonus,
                body.challenge_rating,
                body.notes,
                json.dumps(body.stat_block) if body.stat_block is not None else None,
                body.creature_type,
                body.source or "custom",
                1 if body.verified is None else int(body.verified),
            ),
        )
        return _custom_monster_row(
            conn.execute("SELECT * FROM custom_monsters WHERE id = ?", (cur.lastrowid,)).fetchone()
        )


@router.put("/api/monsters/custom/{monster_id}")
def update_custom_monster(monster_id: int, body: CustomMonsterIn):
    with get_conn() as conn:
        existing = conn.execute(
            "SELECT stat_block, source, verified FROM custom_monsters WHERE id = ?", (monster_id,)
        ).fetchone()
        if existing is None:
            raise HTTPException(404, "custom monster not found")
        stat_block = json.dumps(body.stat_block) if body.stat_block is not None else existing["stat_block"]
        source = body.source if body.source is not None else existing["source"]
        verified = int(body.verified) if body.verified is not None else existing["verified"]
        conn.execute(
            "UPDATE custom_monsters SET name=?, max_hp=?, ac=?, initiative_bonus=?, challenge_rating=?, "
            "notes=?, stat_block=?, creature_type=?, source=?, verified=? WHERE id=?",
            (
                body.name,
                body.max_hp,
                body.ac,
                body.initiative_bonus,
                body.challenge_rating,
                body.notes,
                stat_block,
                body.creature_type,
                source,
                verified,
                monster_id,
            ),
        )
        row = conn.execute("SELECT * FROM custom_monsters WHERE id = ?", (monster_id,)).fetchone()
        return _custom_monster_row(row)


@router.delete("/api/monsters/custom/{monster_id}")
def delete_custom_monster(monster_id: int):
    with get_conn() as conn:
        conn.execute("DELETE FROM custom_monsters WHERE id = ?", (monster_id,))
    return {"ok": True}


@router.post("/api/monsters/custom/{monster_id}/verify")
def verify_custom_monster(monster_id: int):
    with get_conn() as conn:
        row = conn.execute("SELECT id FROM custom_monsters WHERE id = ?", (monster_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "custom monster not found")
        conn.execute("UPDATE custom_monsters SET verified = 1 WHERE id = ?", (monster_id,))
        return _custom_monster_row(
            conn.execute("SELECT * FROM custom_monsters WHERE id = ?", (monster_id,)).fetchone()
        )


@router.post("/api/monsters/custom/import-open5e/{slug}")
async def import_open5e_monster(slug: str):
    monster = await open5e.get_monster_full(slug)
    if monster is None:
        raise HTTPException(404, "monster not found on open5e")
    with get_conn() as conn:
        refuse_duplicate(conn, "custom_monsters", monster["name"])
        monster_id = _insert_open5e_monster(conn, monster)
        return _custom_monster_row(
            conn.execute("SELECT * FROM custom_monsters WHERE id = ?", (monster_id,)).fetchone()
        )


def _insert_open5e_monster(conn, monster: dict) -> int:
    return conn.execute(
        "INSERT INTO custom_monsters (name, max_hp, ac, initiative_bonus, challenge_rating, notes, "
        "stat_block, creature_type, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'import')",
        (
            monster["name"],
            monster["hp"],
            monster["ac"],
            monster["initiative_bonus"],
            monster["challenge_rating"],
            open5e.import_note(monster),
            json.dumps(monster["stat_block"]),
            monster["type"],
        ),
    ).lastrowid


@router.post("/api/monsters/custom/parse-doc")
async def parse_monster_doc(filename: str, request: Request):
    """Parses stat blocks out of an uploaded .odt/.docx chapter and returns
    them for review — nothing is written to the bestiary here. The heuristics
    behind this are best-effort (publishers format stat blocks differently),
    so the DM confirms/corrects each candidate before it's saved as verified."""
    body = await request.body()
    try:
        monsters = monster_import.parse_monster_document(body, filename)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    for m in monsters:
        m["notes"] = f"Importiert aus {filename} – noch nicht verifiziert"
    return monsters


@router.post("/api/monsters/custom/{monster_id}/avatar")
async def upload_custom_monster_avatar(monster_id: int, filename: str, request: Request):
    data = await request.body()
    with get_conn() as conn:
        _get_monster(conn, monster_id)
        conn.execute("UPDATE custom_monsters SET avatar_path = ? WHERE id = ?", (save_image(data, filename), monster_id))
        monster = _get_monster(conn, monster_id)
    await tracker.sync_monster(monster)
    return monster


@router.delete("/api/monsters/custom/{monster_id}/avatar")
async def delete_custom_monster_avatar(monster_id: int):
    with get_conn() as conn:
        _get_monster(conn, monster_id)
        conn.execute("UPDATE custom_monsters SET avatar_path = NULL WHERE id = ?", (monster_id,))
        monster = _get_monster(conn, monster_id)
    await tracker.sync_monster(monster)
    return monster


# ---------- open5e proxy ----------

@router.get("/api/monsters/open5e/search")
async def search_open5e(q: str):
    return await open5e.search_monsters(q)


@router.get("/api/monsters/open5e/{slug}")
async def get_open5e(slug: str):
    monster = await open5e.get_monster_full(slug)
    if monster is None:
        raise HTTPException(404, "monster not found on open5e")
    return monster


# ---------- items (magic items) ----------

def _item_row(row) -> dict:
    d = row_to_dict(row)
    d["stat_block"] = json.loads(d["stat_block"]) if d.get("stat_block") else None
    return d


def _get_item(conn, item_id: int) -> dict:
    row = conn.execute("SELECT * FROM custom_items WHERE id = ?", (item_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "custom item not found")
    return _item_row(row)


@router.get("/api/items/custom")
def list_custom_items():
    with get_conn() as conn:
        rows = conn.execute("SELECT * FROM custom_items ORDER BY name").fetchall()
        mem = translate.Memory(conn)
        return [translate.attach_item(_item_row(r), mem) for r in rows]


@router.post("/api/items/custom")
def create_custom_item(body: CustomItemIn):
    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO custom_items (name, item_type, rarity, requires_attunement, desc, stat_block, notes) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                body.name,
                body.item_type,
                body.rarity,
                int(body.requires_attunement),
                body.desc,
                json.dumps(body.stat_block) if body.stat_block else None,
                body.notes,
            ),
        )
        return _get_item(conn, cur.lastrowid)


@router.put("/api/items/custom/{item_id}")
def update_custom_item(item_id: int, body: CustomItemIn):
    with get_conn() as conn:
        existing = conn.execute("SELECT notes FROM custom_items WHERE id = ?", (item_id,)).fetchone()
        if existing is None:
            raise HTTPException(404, "custom item not found")
        notes = body.notes if body.notes is not None else existing["notes"]
        conn.execute(
            "UPDATE custom_items SET name=?, item_type=?, rarity=?, requires_attunement=?, desc=?, stat_block=?, "
            "notes=? WHERE id=?",
            (
                body.name,
                body.item_type,
                body.rarity,
                int(body.requires_attunement),
                body.desc,
                json.dumps(body.stat_block) if body.stat_block else None,
                notes,
                item_id,
            ),
        )
        row = conn.execute("SELECT * FROM custom_items WHERE id = ?", (item_id,)).fetchone()
        return _item_row(row)


@router.delete("/api/items/custom/{item_id}")
def delete_custom_item(item_id: int):
    with get_conn() as conn:
        conn.execute("DELETE FROM custom_items WHERE id = ?", (item_id,))
    return {"ok": True}


@router.post("/api/items/custom/{item_id}/avatar")
async def upload_custom_item_avatar(item_id: int, filename: str, request: Request):
    data = await request.body()
    with get_conn() as conn:
        if conn.execute("SELECT id FROM custom_items WHERE id = ?", (item_id,)).fetchone() is None:
            raise HTTPException(404, "item not found")
        conn.execute("UPDATE custom_items SET avatar_path = ? WHERE id = ?", (save_image(data, filename), item_id))
        return _get_item(conn, item_id)


@router.delete("/api/items/custom/{item_id}/avatar")
def delete_custom_item_avatar(item_id: int):
    with get_conn() as conn:
        row = conn.execute("SELECT id FROM custom_items WHERE id = ?", (item_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "item not found")
        conn.execute("UPDATE custom_items SET avatar_path = NULL WHERE id = ?", (item_id,))
        return _get_item(conn, item_id)


@router.post("/api/items/custom/import-open5e/{slug}")
async def import_open5e_item(slug: str):
    item = await open5e.get_item_full(slug)
    if item is None:
        raise HTTPException(404, "item not found on open5e")
    with get_conn() as conn:
        refuse_duplicate(conn, "custom_items", item["name"])
        return _get_item(conn, _insert_open5e_item(conn, item))


def _insert_open5e_item(conn, item: dict) -> int:
    return conn.execute(
        "INSERT INTO custom_items (name, item_type, rarity, requires_attunement, desc, source, notes) "
        "VALUES (?, ?, ?, ?, ?, 'import', ?)",
        (
            item["name"],
            item["item_type"],
            item["rarity"],
            int(item["requires_attunement"]),
            item["desc"],
            open5e.import_note(item),
        ),
    ).lastrowid


@router.post("/api/items/custom/import-srd-equipment")
async def import_srd_equipment():
    """Imports every mundane armor and weapon of the SRD. Items whose name is already
    in the library are skipped, so the button can be pressed again safely."""
    items = await open5e.get_srd_equipment()
    added = []
    with get_conn() as conn:
        existing = {r["name"].lower() for r in conn.execute("SELECT name FROM custom_items")}
        for item in items:
            if item["name"].lower() in existing:
                continue
            conn.execute(
                "INSERT INTO custom_items (name, item_type, rarity, requires_attunement, desc, stat_block, "
                "source, notes) VALUES (?, ?, NULL, 0, ?, ?, 'import', ?)",
                (item["name"], item["item_type"], item["desc"], json.dumps(item["stat_block"]), item["notes"]),
            )
            existing.add(item["name"].lower())
            added.append(item["name"])
    return {"added": added, "skipped": len(items) - len(added)}


@router.get("/api/items/open5e/search")
async def search_open5e_items(q: str):
    return await open5e.search_items(q)


@router.get("/api/items/open5e/{slug}")
async def get_open5e_item(slug: str):
    item = await open5e.get_item_full(slug)
    if item is None:
        raise HTTPException(404, "item not found on open5e")
    return item


# ---------- spells ----------

@router.get("/api/spells/custom")
def list_custom_spells():
    with get_conn() as conn:
        rows = conn.execute("SELECT * FROM custom_spells ORDER BY name").fetchall()
        mem = translate.Memory(conn)
        return [translate.attach_spell(row_to_dict(r), mem) for r in rows]


@router.post("/api/spells/custom")
def create_custom_spell(body: CustomSpellIn):
    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO custom_spells (name, school, level_int, dnd_class, casting_time, range, "
            "components, material, duration, concentration, ritual, higher_level, desc, notes) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                body.name,
                body.school,
                body.level_int,
                body.dnd_class,
                body.casting_time,
                body.range,
                body.components,
                body.material,
                body.duration,
                int(body.concentration),
                int(body.ritual),
                body.higher_level,
                body.desc,
                body.notes,
            ),
        )
        return row_to_dict(conn.execute("SELECT * FROM custom_spells WHERE id = ?", (cur.lastrowid,)).fetchone())


@router.put("/api/spells/custom/{spell_id}")
def update_custom_spell(spell_id: int, body: CustomSpellIn):
    with get_conn() as conn:
        existing = conn.execute("SELECT notes FROM custom_spells WHERE id = ?", (spell_id,)).fetchone()
        if existing is None:
            raise HTTPException(404, "custom spell not found")
        notes = body.notes if body.notes is not None else existing["notes"]
        conn.execute(
            "UPDATE custom_spells SET name=?, school=?, level_int=?, dnd_class=?, casting_time=?, range=?, "
            "components=?, material=?, duration=?, concentration=?, ritual=?, higher_level=?, desc=?, notes=? "
            "WHERE id=?",
            (
                body.name,
                body.school,
                body.level_int,
                body.dnd_class,
                body.casting_time,
                body.range,
                body.components,
                body.material,
                body.duration,
                int(body.concentration),
                int(body.ritual),
                body.higher_level,
                body.desc,
                notes,
                spell_id,
            ),
        )
        row = conn.execute("SELECT * FROM custom_spells WHERE id = ?", (spell_id,)).fetchone()
        return row_to_dict(row)


@router.delete("/api/spells/custom/{spell_id}")
def delete_custom_spell(spell_id: int):
    with get_conn() as conn:
        conn.execute("DELETE FROM custom_spells WHERE id = ?", (spell_id,))
    return {"ok": True}


@router.post("/api/spells/custom/import-open5e/{slug}")
async def import_open5e_spell(slug: str):
    spell = await open5e.get_spell_full(slug)
    if spell is None:
        raise HTTPException(404, "spell not found on open5e")
    with get_conn() as conn:
        refuse_duplicate(conn, "custom_spells", spell["name"])
        spell_id = _insert_open5e_spell(conn, spell)
        return row_to_dict(conn.execute("SELECT * FROM custom_spells WHERE id = ?", (spell_id,)).fetchone())


def _insert_open5e_spell(conn, spell: dict) -> int:
    return conn.execute(
        "INSERT INTO custom_spells (name, school, level_int, dnd_class, casting_time, range, "
        "components, material, duration, concentration, ritual, higher_level, desc, source, notes) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'import', ?)",
        (
            spell["name"],
            spell["school"],
            spell["level_int"],
            spell["dnd_class"],
            spell["casting_time"],
            spell["range"],
            spell["components"],
            spell["material"],
            spell["duration"],
            int(spell["concentration"]),
            int(spell["ritual"]),
            spell["higher_level"],
            spell["desc"],
            open5e.import_note(spell),
        ),
    ).lastrowid


async def fill_monster_sizes() -> int:
    """The bestiary kept no size before (stat_block.size, "Medium"). Monsters without one get it
    from Open5e by name, once: whoever is not found there (a book's own creature) is marked with
    size None and not looked up again; importing its page once more brings it. Nothing is marked
    when Open5e can't be reached, so the next start tries again. Returns how many got a size."""
    with get_conn() as conn:
        missing = [dict(r) for r in conn.execute("SELECT id, name, stat_block, stat_block_en FROM custom_monsters")
                   if "size" not in json.loads(r["stat_block"] or "{}")]
    if not missing:
        return 0
    sizes = await open5e.creature_sizes()
    found = 0
    with get_conn() as conn:
        for m in missing:
            size = sizes.get(m["name"].strip().lower())
            found += size is not None
            values = [json.dumps({**json.loads(m["stat_block"] or "{}"), "size": size})]
            sql = "UPDATE custom_monsters SET stat_block = ?"
            if m["stat_block_en"]:
                sql += ", stat_block_en = ?"
                values.append(json.dumps({**json.loads(m["stat_block_en"]), "size": size}))
            conn.execute(sql + " WHERE id = ?", (*values, m["id"]))
    return found


# ---------- bulk import of a whole Open5e category ----------

BULK_TARGETS = {
    "monsters": ("custom_monsters", _insert_open5e_monster),
    "items": ("custom_items", _insert_open5e_item),
    "spells": ("custom_spells", _insert_open5e_spell),
}


def _bulk_kind(kind: str) -> str:
    if kind not in BULK_TARGETS:
        raise HTTPException(404, "unknown category")
    return kind


@router.get("/api/{kind}/open5e-all/count")
async def count_open5e_all(kind: str, srd: bool = True):
    if kind in char_options.KINDS:
        return {"count": len(await char_options.fetch_kind(kind, srd))}
    return {"count": await open5e.count_all(_bulk_kind(kind), srd)}


@router.post("/api/{kind}/custom/import-open5e-all")
async def import_open5e_all(kind: str, srd: bool = True):
    """Imports a whole category. Names already in the library are skipped, so it can be
    run again (or after single imports) without creating duplicates; across Open5e
    sources the first entry of a name wins."""
    if kind in char_options.KINDS:
        return await _import_all_options(kind, srd)
    table, insert = BULK_TARGETS[_bulk_kind(kind)]
    entries = await open5e.fetch_all(kind, srd)
    added = 0
    with get_conn() as conn:
        existing = {r["name"].lower() for r in conn.execute(f"SELECT name FROM {table}")}
        for entry in sorted(entries, key=lambda e: (e["name"] or "").lower()):
            name = (entry["name"] or "").strip()
            if not name or name.lower() in existing:
                continue
            insert(conn, entry)
            existing.add(name.lower())
            added += 1
    return {"added": added, "skipped": len(entries) - added}


async def _import_all_options(kind: str, srd: bool) -> dict:
    """Like the other categories, but 2014 and 2024 versions of the same name are both kept."""
    entries = await char_options.fetch_kind(kind, srd)
    added = 0
    with get_conn() as conn:
        existing = char_options.existing_keys(conn, kind)
        for entry in sorted(entries, key=lambda e: (e["name"] or "").lower()):
            keys = char_options.entry_keys(entry)
            if not keys or keys & existing:
                continue
            char_options.insert_open5e(conn, entry)
            existing |= keys
            added += 1
    return {"added": added, "skipped": len(entries) - added}


@router.get("/api/spells/open5e/search")
async def search_open5e_spells(q: str):
    return await open5e.search_spells(q)


@router.get("/api/spells/open5e/{slug}")
async def get_open5e_spell(slug: str):
    spell = await open5e.get_spell_full(slug)
    if spell is None:
        raise HTTPException(404, "spell not found on open5e")
    return spell




