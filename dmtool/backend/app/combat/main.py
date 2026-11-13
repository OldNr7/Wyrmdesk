import json
import random
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .. import i18n, internal
from ..characters import set_character_hp
from . import kb
from .db import AVATAR_DIR, get_conn, get_setting, init_db, row_to_dict, set_setting
from .display import current_position, display_payload, get_display_encounter_id, set_display_encounter_id
from ..i18n import t as _t


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield


app = FastAPI(title="Wyrmdesk – Combattracker", lifespan=lifespan)


@app.middleware("http")
async def no_cache(request: Request, call_next):
    # Without this, browsers guess a cache lifetime and can mix an old app.js with new shared
    # scripts after an update, which breaks the page until a hard reload.
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-cache"
    # A fight changed: the battlemap and the beamer follow right away instead of at their next look.
    if request.method != "GET" and response.status_code < 400:
        internal.changed()
    return response


# ---------- schemas ----------

class EncounterIn(BaseModel):
    campaign_id: int
    name: str


class EncounterRename(BaseModel):
    name: str


class DisplaySettingIn(BaseModel):
    encounter_id: Optional[int] = None


class CombatantIn(BaseModel):
    kind: str  # 'pc' | 'monster'
    source: str = "manual"  # 'roster' | 'open5e' | 'custom' | 'manual'
    ref: Optional[str] = None  # character id / custom monster id / open5e slug
    name: Optional[str] = None
    max_hp: Optional[int] = None
    ac: Optional[int] = None
    initiative: Optional[int] = None
    notes: Optional[str] = None


class CombatantPatch(BaseModel):
    name: Optional[str] = None
    max_hp: Optional[int] = None
    current_hp: Optional[int] = None
    hp_delta: Optional[int] = None
    temp_hp: Optional[int] = None
    temp_hp_delta: Optional[int] = None
    ac: Optional[int] = None
    initiative: Optional[int] = None
    initiative_bonus: Optional[int] = None
    status_effects: Optional[list[str]] = None
    notes: Optional[str] = None
    is_boss: Optional[bool] = None
    is_hidden: Optional[bool] = None


# ---------- campaigns and characters: the Kampagnenbuch's own tables ----------

@app.get("/api/campaigns")
def list_campaigns():
    """The Kampagnenbuch's campaigns, for the battlemap and older callers that ask the tracker."""
    with get_conn() as conn:
        return [{"id": r["id"], "name": r["name"]} for r in conn.execute("SELECT id, name FROM campaigns ORDER BY id")]


@app.post("/api/campaigns/{campaign_id}/delete-encounters")
def delete_campaign_encounters(campaign_id: int):
    """Called by the Kampagnenbuch when it deletes a campaign."""
    with get_conn() as conn:
        # Combatants go with their encounter (ON DELETE CASCADE).
        conn.execute("DELETE FROM encounters WHERE campaign_id = ?", (campaign_id,))
    return {"ok": True}


@app.api_route("/kb/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"], include_in_schema=False)
async def kb_proxy(path: str, request: Request):
    return await kb.proxy(path, request)


def _bump_roster_rev(conn) -> None:
    # The DM view polls this (remote state) and reloads the party and the encounter when it changes.
    set_setting(conn, ROSTER_REV_KEY, datetime.now().isoformat(timespec="microseconds"))


# What the Kampagnenbuch calls when a character or monster changes (tracker.py there). A player
# character in a fight reads the character itself (combatant_view), so nothing needs copying; the DM
# view only has to know it should load again.

def characters_changed(conn) -> None:
    _bump_roster_rev(conn)


def _snapshot(conn, where: str, params: tuple) -> None:
    """The character's values into its combatants' own columns, for when the link goes."""
    conn.execute(
        "UPDATE combatants SET max_hp = ch.max_hp, current_hp = MIN(ch.max_hp, COALESCE(ch.current_hp, ch.max_hp)), "
        "temp_hp = ch.temp_hp, ac = ch.ac, initiative_bonus = ch.initiative_bonus, stat_block = ch.stat_block, "
        "avatar_path = CASE WHEN ch.avatar_path LIKE '/uploads/%' THEN '/kb' || ch.avatar_path ELSE ch.avatar_path END "
        f"FROM characters ch WHERE combatants.source = 'roster' AND ch.id = combatants.ref_id AND {where}", params)


def unlink_character(conn, char_id: int) -> None:
    """A character is about to be deleted: its combatants stay in the encounters, as manual entries
    with the character's last values."""
    _snapshot(conn, "ch.id = ?", (char_id,))
    conn.execute("UPDATE combatants SET source = 'manual', ref_id = NULL WHERE source = 'roster' AND ref_id = ?", (char_id,))
    _bump_roster_rev(conn)


def unlink_missing(conn) -> int:
    """Combatants of characters that are gone (deleted before this, or not in a restored backup)."""
    cur = conn.execute("UPDATE combatants SET source = 'manual', ref_id = NULL WHERE source = 'roster' AND "
                       "(ref_id IS NULL OR ref_id NOT IN (SELECT id FROM characters))")
    if cur.rowcount:
        _bump_roster_rev(conn)
    return cur.rowcount


def monster_picture(conn, monster_id: int, avatar_path: str | None) -> None:
    """A bestiary monster's new picture for its combatants (monsters are copies, their picture follows)."""
    conn.execute("UPDATE combatants SET avatar_path = ? WHERE source = 'custom' AND ref_id = ?",
                 (kb.browser_path(avatar_path), monster_id))
    _bump_roster_rev(conn)


# ---------- encounters ----------

def _turn_order(conn, encounter_id: int) -> list[dict]:
    rows = conn.execute(
        "SELECT * FROM combatant_view WHERE encounter_id = ? "
        "ORDER BY (initiative IS NULL), initiative DESC, sort_order ASC",
        (encounter_id,),
    ).fetchall()
    return [row_to_dict(r) for r in rows]


def _encounter_detail(conn, encounter_id: int) -> dict:
    encounter = conn.execute("SELECT * FROM encounters WHERE id = ?", (encounter_id,)).fetchone()
    if encounter is None:
        raise HTTPException(404, "encounter not found")
    encounter = row_to_dict(encounter)
    order = _turn_order(conn, encounter_id)
    for c in order:
        c["status_effects"] = json.loads(c["status_effects"])
        c["stat_block"] = json.loads(c["stat_block"]) if c["stat_block"] else None
    idx = current_position(order, encounter)
    encounter["combatants"] = order
    encounter["current_combatant_id"] = order[idx]["id"] if idx is not None else None
    encounter["current_turn_index"] = idx or 0
    return encounter


def _set_turn(conn, encounter_id: int, order: list, idx: int, round_: int | None = None) -> None:
    """Give the turn to order[idx]; the index is stored too, for older readers."""
    current = order[idx]["id"] if order else None
    if round_ is None:
        conn.execute("UPDATE encounters SET current_combatant_id = ?, current_turn_index = ? WHERE id = ?",
                     (current, idx, encounter_id))
    else:
        conn.execute("UPDATE encounters SET current_combatant_id = ?, current_turn_index = ?, round = ? "
                     "WHERE id = ?", (current, idx, round_, encounter_id))


@app.get("/api/encounters")
def list_encounters(campaign_id: int):
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM encounters WHERE campaign_id = ? ORDER BY created_at DESC", (campaign_id,)
        ).fetchall()
        encounters = [row_to_dict(r) for r in rows]
        for enc in encounters:
            # Only kind/stat_block are needed client-side to compute the difficulty rating.
            combatants = conn.execute(
                "SELECT kind, stat_block FROM combatant_view WHERE encounter_id = ?", (enc["id"],)
            ).fetchall()
            enc["combatants"] = [
                {"kind": c["kind"], "stat_block": json.loads(c["stat_block"]) if c["stat_block"] else None}
                for c in combatants
            ]
        return encounters


@app.post("/api/encounters")
def create_encounter(body: EncounterIn):
    # Start every encounter with the whole party; absent players get removed by hand.
    with get_conn() as conn:
        characters = [row_to_dict(r) for r in conn.execute(
            "SELECT * FROM characters WHERE campaign_id = ? ORDER BY name COLLATE NOCASE", (body.campaign_id,))]
        cur = conn.execute(
            "INSERT INTO encounters (campaign_id, name) VALUES (?, ?)", (body.campaign_id, body.name)
        )
        encounter_id = cur.lastrowid
        for order, ch in enumerate(characters):
            conn.execute(
                "INSERT INTO combatants (encounter_id, name, kind, source, max_hp, current_hp, ac, "
                "initiative, initiative_bonus, status_effects, sort_order, notes, avatar_path, stat_block, "
                "ref_id, temp_hp) VALUES (?, ?, 'pc', 'roster', ?, ?, ?, NULL, ?, '[]', ?, NULL, ?, ?, ?, ?)",
                (
                    encounter_id,
                    ch["name"],
                    ch["max_hp"],
                    # Characters keep their HP between fights (players track it on their sheet).
                    min(ch["max_hp"], ch["current_hp"] if ch["current_hp"] is not None else ch["max_hp"]),
                    ch["ac"],
                    ch["initiative_bonus"],
                    order,
                    kb.browser_path(ch["avatar_path"]),
                    ch["stat_block"],
                    ch["id"],
                    ch["temp_hp"],
                ),
            )
        return _encounter_detail(conn, encounter_id)


@app.get("/api/encounters/{encounter_id}")
def get_encounter(encounter_id: int):
    with get_conn() as conn:
        return _encounter_detail(conn, encounter_id)


@app.put("/api/encounters/{encounter_id}")
def rename_encounter(encounter_id: int, body: EncounterRename):
    with get_conn() as conn:
        conn.execute("UPDATE encounters SET name = ? WHERE id = ?", (body.name, encounter_id))
        return _encounter_detail(conn, encounter_id)


@app.delete("/api/encounters/{encounter_id}")
def delete_encounter(encounter_id: int):
    with get_conn() as conn:
        conn.execute("DELETE FROM encounters WHERE id = ?", (encounter_id,))
    return {"ok": True}


@app.post("/api/encounters/{encounter_id}/reset")
def reset_encounter(encounter_id: int):
    with get_conn() as conn:
        _set_turn(conn, encounter_id, _turn_order(conn, encounter_id), 0, round_=1)
        return _encounter_detail(conn, encounter_id)


@app.post("/api/encounters/{encounter_id}/next-turn")
def next_turn(encounter_id: int):
    with get_conn() as conn:
        encounter = conn.execute("SELECT * FROM encounters WHERE id = ?", (encounter_id,)).fetchone()
        if encounter is None:
            raise HTTPException(404, "encounter not found")
        order = _turn_order(conn, encounter_id)
        if not order:
            return _encounter_detail(conn, encounter_id)
        idx = current_position(order, encounter) + 1
        round_ = encounter["round"]
        if idx >= len(order):
            idx = 0
            round_ += 1
        _set_turn(conn, encounter_id, order, idx, round_)
        return _encounter_detail(conn, encounter_id)


@app.get("/api/display/encounter")
def get_display_setting():
    with get_conn() as conn:
        return {"encounter_id": get_display_encounter_id(conn)}


@app.put("/api/display/encounter")
def put_display_setting(body: DisplaySettingIn):
    with get_conn() as conn:
        set_display_encounter_id(conn, body.encounter_id)
        return {"encounter_id": body.encounter_id}


@app.get("/api/display/state")
def get_display_state():
    with get_conn() as conn:
        return display_payload(conn)


@app.post("/api/encounters/{encounter_id}/roll-monster-initiative")
def roll_monster_initiative(encounter_id: int):
    with get_conn() as conn:
        monsters = conn.execute(
            "SELECT id, initiative_bonus FROM combatants WHERE encounter_id = ? AND kind = 'monster'",
            (encounter_id,),
        ).fetchall()
        for m in monsters:
            roll = random.randint(1, 20) + (m["initiative_bonus"] or 0)
            conn.execute("UPDATE combatants SET initiative = ? WHERE id = ?", (roll, m["id"]))
        return _encounter_detail(conn, encounter_id)


@app.post("/api/encounters/{encounter_id}/prev-turn")
def prev_turn(encounter_id: int):
    with get_conn() as conn:
        encounter = conn.execute("SELECT * FROM encounters WHERE id = ?", (encounter_id,)).fetchone()
        if encounter is None:
            raise HTTPException(404, "encounter not found")
        order = _turn_order(conn, encounter_id)
        if not order:
            return _encounter_detail(conn, encounter_id)
        idx = current_position(order, encounter) - 1
        round_ = encounter["round"]
        if idx < 0:
            idx = len(order) - 1
            round_ = max(1, round_ - 1)
        _set_turn(conn, encounter_id, order, idx, round_)
        return _encounter_detail(conn, encounter_id)


# ---------- remote control (Elgato Stream Deck webhooks) ----------
# Stream Deck plugins fire plain HTTP requests, so every action accepts GET and POST.
# Actions target the encounter shown on the player display. The DM view polls
# /api/remote/state and follows along (turn changes, stats toggle) whenever rev changes.

REMOTE_REV_KEY = "remote_rev"
# Changes whenever the Kampagnenbuch reports a changed character or monster (see _bump_roster_rev).
ROSTER_REV_KEY = "roster_rev"
REMOTE_STATS_KEY = "remote_show_stats"


# The tracker's settings in the shared app_settings table ("tracker.<key>", db.py).
_get_setting = get_setting
_set_setting = set_setting


def _remote_encounter_id() -> int:
    with get_conn() as conn:
        encounter_id = get_display_encounter_id(conn)
    if encounter_id is None:
        raise HTTPException(409, _t("Kein Encounter in der Anzeige. Im Tab 'Anzeige' einen Encounter übernehmen."))
    return encounter_id


def _remote_done(encounter_id: int) -> dict:
    """Bump rev so the DM view refreshes, and return a short summary for the Stream Deck log."""
    with get_conn() as conn:
        rev = int(_get_setting(conn, REMOTE_REV_KEY, "0")) + 1
        _set_setting(conn, REMOTE_REV_KEY, str(rev))
        detail = _encounter_detail(conn, encounter_id)
        current = next((c for c in detail["combatants"] if c["id"] == detail["current_combatant_id"]), None)
        return {
            "ok": True,
            "encounter": detail["name"],
            "round": detail["round"],
            "current": current["name"] if current else None,
            "show_stats": _get_setting(conn, REMOTE_STATS_KEY) == "1",
        }


@app.api_route("/api/remote/roll-monster-initiative", methods=["GET", "POST"])
def remote_roll_monster_initiative():
    encounter_id = _remote_encounter_id()
    roll_monster_initiative(encounter_id)
    return _remote_done(encounter_id)


@app.api_route("/api/remote/next-turn", methods=["GET", "POST"])
def remote_next_turn():
    encounter_id = _remote_encounter_id()
    next_turn(encounter_id)
    return _remote_done(encounter_id)


@app.api_route("/api/remote/prev-turn", methods=["GET", "POST"])
def remote_prev_turn():
    encounter_id = _remote_encounter_id()
    prev_turn(encounter_id)
    return _remote_done(encounter_id)


@app.api_route("/api/remote/toggle-stats", methods=["GET", "POST"])
def remote_toggle_stats():
    encounter_id = _remote_encounter_id()
    with get_conn() as conn:
        show = _get_setting(conn, REMOTE_STATS_KEY) == "1"
        _set_setting(conn, REMOTE_STATS_KEY, "0" if show else "1")
    return _remote_done(encounter_id)


@app.api_route("/api/remote/show-encounter/{encounter_id}", methods=["GET", "POST"])
def remote_show_encounter(encounter_id: int):
    """Put an encounter on the player display; the DM view switches to it as after any remote action."""
    with get_conn() as conn:
        if conn.execute("SELECT 1 FROM encounters WHERE id = ?", (encounter_id,)).fetchone() is None:
            raise HTTPException(404, "encounter not found")
        set_display_encounter_id(conn, encounter_id)
    return _remote_done(encounter_id)


@app.get("/api/remote/state")
def remote_state():
    with get_conn() as conn:
        encounter_id = get_display_encounter_id(conn)
        campaign = None
        if encounter_id is not None:
            row = conn.execute("SELECT campaign_id FROM encounters WHERE id = ?", (encounter_id,)).fetchone()
            campaign = row["campaign_id"] if row else None
        return {
            "rev": int(_get_setting(conn, REMOTE_REV_KEY, "0")),
            "encounter_id": encounter_id,
            "campaign_id": campaign,
            "show_stats": _get_setting(conn, REMOTE_STATS_KEY) == "1",
            # Characters change in the Kampagnenbuch (players' sheets too); the DM view reloads the party then.
            "characters_rev": _get_setting(conn, ROSTER_REV_KEY),
        }


# ---------- combatants ----------

async def _roster_defaults(ref_id) -> dict:
    with get_conn() as conn:
        row = row_to_dict(conn.execute("SELECT * FROM characters WHERE id = ?", (ref_id,)).fetchone())
    if row is None:
        raise HTTPException(404, "character not found")
    return {
        "name": row["name"], "max_hp": row["max_hp"], "ac": row["ac"],
        "initiative_bonus": row["initiative_bonus"],
        "avatar_path": kb.browser_path(row["avatar_path"]),
        "stat_block": row["stat_block"],
        "ref_id": row["id"],
        # Characters keep their HP between fights (players track it on their sheet).
        "current_hp": row["current_hp"],
        "temp_hp": row["temp_hp"],
    }


async def _custom_monster_defaults(ref_id) -> dict:
    row = await kb.call("GET", f"/api/monsters/custom/{ref_id}")
    # Combatants have no CR column; carry it inside the statblock copy so the encounter sheet can show it.
    stat_block = row["stat_block"] or {}
    if row["challenge_rating"]:
        stat_block["challenge_rating"] = row["challenge_rating"]
    return {
        "name": row["name"], "max_hp": row["max_hp"], "ac": row["ac"],
        "initiative_bonus": row["initiative_bonus"],
        "avatar_path": kb.browser_path(row["avatar_path"]),
        "stat_block": json.dumps(stat_block) if stat_block else None,
        "ref_id": row["id"],
        "creature_type": row["creature_type"],
    }


async def _open5e_defaults(ref_id) -> dict:
    monster = await kb.call("GET", f"/api/monsters/open5e/{ref_id}")
    return {
        "name": monster["name"], "max_hp": monster["hp"], "ac": monster["ac"],
        "initiative_bonus": monster["initiative_bonus"],
        "stat_block": json.dumps(monster["stat_block"]),
        "creature_type": monster["type"],
    }


# Per source: which lookup resolves a ref, and which defaults keys it may fill in. name/max_hp/ac
# are merged separately below (the caller's own value always wins over the referenced entry's).
_SOURCE_LOOKUPS = {"roster": _roster_defaults, "custom": _custom_monster_defaults, "open5e": _open5e_defaults}


async def _resolve_defaults(body: CombatantIn) -> dict:
    """Fill in name/max_hp/ac/initiative_bonus/avatar/stat_block from the referenced
    roster/bestiary/open5e entry when the caller didn't override them."""
    defaults = {
        "name": body.name,
        "max_hp": body.max_hp,
        "ac": body.ac,
        "initiative_bonus": 0,
        "avatar_path": None,
        "stat_block": None,
        "ref_id": None,
        "creature_type": None,
        "current_hp": None,
        "temp_hp": 0,
    }
    lookup = _SOURCE_LOOKUPS.get(body.source)
    if lookup is not None and body.ref is not None:
        from_ref = await lookup(body.ref)
        defaults["name"] = defaults["name"] or from_ref["name"]
        defaults["max_hp"] = defaults["max_hp"] or from_ref["max_hp"]
        defaults["ac"] = defaults["ac"] or from_ref["ac"]
        for key in ("initiative_bonus", "avatar_path", "stat_block", "ref_id", "creature_type", "current_hp", "temp_hp"):
            if key in from_ref:
                defaults[key] = from_ref[key]

    if defaults["name"] is None or defaults["max_hp"] is None or defaults["ac"] is None:
        raise HTTPException(400, "name, max_hp and ac are required (directly or via ref)")
    return defaults


@app.post("/api/encounters/{encounter_id}/combatants")
async def add_combatant(encounter_id: int, body: CombatantIn):
    defaults = await _resolve_defaults(body)
    with get_conn() as conn:
        encounter = conn.execute("SELECT id FROM encounters WHERE id = ?", (encounter_id,)).fetchone()
        if encounter is None:
            raise HTTPException(404, "encounter not found")
        next_order = conn.execute(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM combatants WHERE encounter_id = ?",
            (encounter_id,),
        ).fetchone()["n"]
        cur = conn.execute(
            "INSERT INTO combatants (encounter_id, name, kind, source, max_hp, current_hp, ac, "
            "initiative, initiative_bonus, status_effects, sort_order, notes, avatar_path, stat_block, "
            "ref_id, creature_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?)",
            (
                encounter_id,
                defaults["name"],
                body.kind,
                body.source,
                defaults["max_hp"],
                defaults["max_hp"],
                defaults["ac"],
                body.initiative,
                defaults["initiative_bonus"],
                next_order,
                body.notes,
                defaults["avatar_path"],
                defaults["stat_block"],
                defaults["ref_id"],
                defaults["creature_type"],
            ),
        )
        if defaults["current_hp"] is not None:
            conn.execute(
                "UPDATE combatants SET current_hp = MIN(max_hp, ?), temp_hp = ? WHERE id = ?",
                (defaults["current_hp"], defaults["temp_hp"], cur.lastrowid),
            )
        row = row_to_dict(conn.execute("SELECT * FROM combatant_view WHERE id = ?", (cur.lastrowid,)).fetchone())
        row["status_effects"] = json.loads(row["status_effects"])
        row["stat_block"] = json.loads(row["stat_block"]) if row["stat_block"] else None
        return row


def _patch_fields(body: CombatantPatch) -> dict:
    """Fields the caller sent, mapped 1:1 onto the combatants row. HP/temp-HP need clamping against
    max_hp and are added by _clamp_hp, not here."""
    fields = {}
    if body.name is not None:
        fields["name"] = body.name
    if body.max_hp is not None:
        fields["max_hp"] = body.max_hp
    if body.ac is not None:
        fields["ac"] = body.ac
    if body.initiative is not None:
        fields["initiative"] = body.initiative
    if body.initiative_bonus is not None:
        fields["initiative_bonus"] = body.initiative_bonus
    if body.notes is not None:
        fields["notes"] = body.notes
    if body.status_effects is not None:
        fields["status_effects"] = json.dumps(body.status_effects)
    if body.is_boss is not None:
        fields["is_boss"] = 1 if body.is_boss else 0
    if body.is_hidden is not None:
        fields["is_hidden"] = 1 if body.is_hidden else 0
    return fields


def _clamp_hp(row: dict, fields: dict, body: CombatantPatch) -> None:
    """current_hp/temp_hp after an optional set and/or delta, clamped to [0, max_hp] resp. [0, inf).
    Adds "current_hp" and "temp_hp" to fields (any max_hp change in fields already applies)."""
    new_hp = row["current_hp"]
    if body.current_hp is not None:
        new_hp = body.current_hp
    if body.hp_delta is not None:
        new_hp += body.hp_delta
    max_hp = fields.get("max_hp", row["max_hp"])
    fields["current_hp"] = max(0, min(max_hp, new_hp))

    new_temp_hp = row["temp_hp"]
    if body.temp_hp is not None:
        new_temp_hp = body.temp_hp
    if body.temp_hp_delta is not None:
        new_temp_hp += body.temp_hp_delta
    fields["temp_hp"] = max(0, new_temp_hp)


@app.patch("/api/encounters/{encounter_id}/combatants/{combatant_id}")
async def patch_combatant(encounter_id: int, combatant_id: int, body: CombatantPatch):
    with get_conn() as conn:
        # As the tracker shows it: a player character's HP are the character's own.
        row = conn.execute(
            "SELECT * FROM combatant_view WHERE id = ? AND encounter_id = ?", (combatant_id, encounter_id)
        ).fetchone()
        if row is None:
            raise HTTPException(404, "combatant not found")
        row = row_to_dict(row)

        fields = _patch_fields(body)
        _clamp_hp(row, fields, body)

        set_clause = ", ".join(f"{k} = ?" for k in fields)
        conn.execute(
            f"UPDATE combatants SET {set_clause} WHERE id = ?", (*fields.values(), combatant_id)
        )
        linked = row["source"] == "roster" and row["ref_id"] is not None and conn.execute(
            "SELECT 1 FROM characters WHERE id = ?", (row["ref_id"],)).fetchone() is not None
        if linked and (fields["current_hp"] != row["current_hp"] or fields["temp_hp"] != row["temp_hp"]):
            # The character's own HP: the same on the player's sheet and in every encounter.
            set_character_hp(conn, row["ref_id"], fields["current_hp"], fields["temp_hp"])
            _bump_roster_rev(conn)
        updated = row_to_dict(conn.execute("SELECT * FROM combatant_view WHERE id = ?", (combatant_id,)).fetchone())
    updated["status_effects"] = json.loads(updated["status_effects"])
    updated["stat_block"] = json.loads(updated["stat_block"]) if updated["stat_block"] else None
    return updated


@app.delete("/api/encounters/{encounter_id}/combatants/{combatant_id}")
def delete_combatant(encounter_id: int, combatant_id: int):
    with get_conn() as conn:
        encounter = conn.execute("SELECT * FROM encounters WHERE id = ?", (encounter_id,)).fetchone()
        order = _turn_order(conn, encounter_id)
        idx = current_position(order, encounter) if encounter else None
        conn.execute(
            "DELETE FROM combatants WHERE id = ? AND encounter_id = ?", (combatant_id, encounter_id)
        )
        rest = [c for c in order if c["id"] != combatant_id]
        if idx is not None and rest:
            if order[idx]["id"] != combatant_id:
                # The turn stays with the same combatant, wherever they stand now.
                _set_turn(conn, encounter_id, rest, next(i for i, c in enumerate(rest) if c["id"] == order[idx]["id"]))
            elif idx < len(rest):
                # Removing whoever has the turn passes it to the next in line.
                _set_turn(conn, encounter_id, rest, idx)
            else:
                _set_turn(conn, encounter_id, rest, 0, encounter["round"] + 1)
    return {"ok": True}


# ---------- settings: database backup / restore ----------
# One database for the whole Kampagnenbuch now: its backup holds the fights too (⚙ Einrichtung there).

KB_PORT = 8440


@app.get("/api/settings/backup")
def download_backup(request: Request):
    # Inside the Kampagnenbuch (/tracker/, /map/) its own backup; at the old address the one on its port.
    if request.scope.get("root_path"):
        return RedirectResponse("/api/backup")
    return RedirectResponse(f"{request.url.scheme}://{request.url.hostname}:{KB_PORT}/api/backup")


@app.post("/api/settings/restore")
async def restore_backup():
    raise HTTPException(409, _t("Encounter und Kämpfer sind jetzt Teil des Kampagnenbuchs: Sicherungen dort einspielen (⚙ Einrichtung im Kampagnenbuch)."))


# Port the Kampagnenbuch's player app is published on, see compose.yaml.
PLAYER_SHEET_PORT = 8441


@app.get("/spieler", include_in_schema=False)
@app.get("/spieler/", include_in_schema=False)
def player_page_redirect(request: Request):
    # The player sheets moved to the Kampagnenbuch; old bookmarks land there.
    return RedirectResponse(f"{request.url.scheme}://{request.url.hostname}:{PLAYER_SHEET_PORT}/spieler/")


# The UI language (UI_LANG), see ../i18n.py.
i18n.setup(app)

app.mount("/avatars", StaticFiles(directory=str(AVATAR_DIR)), name="avatars")
# Condition icons etc., also served by the player display (public.py).
app.mount("/shared", StaticFiles(directory=str(Path(__file__).parent / "shared_static")), name="shared")
app.mount("/", StaticFiles(directory=str(Path(__file__).parent / "static"), html=True), name="static")
