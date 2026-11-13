"""Character rows and saving, shared by the DM view (library.py) and the player sheets (public.py)."""

import json
from datetime import datetime
from typing import Optional

from fastapi import HTTPException
from pydantic import BaseModel

from .db import row_to_dict
from .links import rename_links
from .i18n import t as _t


class CharacterFields(BaseModel):
    name: str
    max_hp: int
    ac: int
    initiative_bonus: int = 0
    notes: Optional[str] = None
    # {"abilities": {"str": .., ...}, "passive_perception": .., "speed": "..", "languages": ".."}
    stat_block: Optional[dict] = None
    # updated_at of the version the edit started from. When someone else saved in between
    # the save is refused with 409 instead of silently overwriting their changes. None skips the check.
    updated_at: Optional[str] = None
    # Level-up: the current HP rise along with the maximum.
    hp_gain: Optional[int] = None


def character_row(row) -> dict:
    d = row_to_dict(row)
    d["stat_block"] = json.loads(d["stat_block"]) if d["stat_block"] else None
    if "play_state" in d:
        d["play_state"] = json.loads(d["play_state"]) if d["play_state"] else {}
    return d


def get_character(conn, char_id: int) -> dict:
    row = conn.execute("SELECT * FROM characters WHERE id = ?", (char_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "character not found")
    return character_row(row)


def set_character_hp(conn, char_id: int, current_hp: int, temp_hp: int) -> None:
    """HP of a character. The caller tells the tracker (tracker.sync_character), whose combatants follow."""
    conn.execute(
        "UPDATE characters SET current_hp = MAX(0, MIN(max_hp, ?)), temp_hp = MAX(0, ?), state_updated_at = ? "
        "WHERE id = ?",
        (current_hp, temp_hp, new_version(), char_id),
    )


def set_play_state(conn, char_id: int, play_state: dict) -> None:
    conn.execute(
        "UPDATE characters SET play_state = ?, state_updated_at = ? WHERE id = ?",
        (json.dumps(play_state), new_version(), char_id),
    )


def new_version() -> str:
    return datetime.now().isoformat(timespec="microseconds")


def save_character(conn, char_id: int, body: CharacterFields) -> dict:
    stat_block = json.dumps(body.stat_block) if body.stat_block is not None else None
    cur = conn.execute(
        "UPDATE characters SET name=?, max_hp=?, ac=?, initiative_bonus=?, notes=?, stat_block=?, updated_at=? "
        "WHERE id=? AND (? IS NULL OR updated_at = ?)",
        (body.name, body.max_hp, body.ac, body.initiative_bonus, body.notes, stat_block, new_version(),
         char_id, body.updated_at, body.updated_at),
    )
    if cur.rowcount == 0:
        if conn.execute("SELECT 1 FROM characters WHERE id = ?", (char_id,)).fetchone() is None:
            raise HTTPException(404, "character not found")
        raise HTTPException(409, _t("Der Charakter wurde inzwischen anderswo geändert."))
    if body.hp_gain:
        conn.execute("UPDATE characters SET current_hp = current_hp + ?, state_updated_at = ? WHERE id = ? AND current_hp IS NOT NULL",
                     (body.hp_gain, new_version(), char_id))
    # A lower maximum caps the current HP.
    conn.execute("UPDATE characters SET current_hp = MIN(max_hp, COALESCE(current_hp, max_hp)) WHERE id = ?", (char_id,))
    char = get_character(conn, char_id)
    # The notes entry carries the same name, so [[links]] to the character keep working.
    entry = conn.execute("SELECT name FROM entries WHERE id = ?", (char["entry_id"],)).fetchone()
    if entry is not None and entry["name"] != char["name"]:
        rename_links(conn, char["campaign_id"], entry["name"], char["name"])
        conn.execute("UPDATE entries SET name = ? WHERE id = ?", (char["name"], char["entry_id"]))
    return char
