import json
from typing import Optional

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import char_options, library, live, tracker, translate
from .characters import (CharacterFields, character_row, get_character, new_version, save_character, set_character_hp,
                         set_play_state)
from .common import APP_DIR, setup_common
from .db import get_conn, get_settings
from .i18n import t as _t

app = FastAPI(title="Kampagnenbuch Handouts")


@app.get("/api/state")
def get_state():
    with get_conn() as conn:
        return live.player_payload(conn)


@app.websocket("/ws")
async def player_socket(ws: WebSocket):
    await ws.accept()
    live.player_sockets.add(ws)
    with get_conn() as conn:
        await ws.send_text(json.dumps({"type": "state", "state": live.player_payload(conn)}))
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        live.player_sockets.discard(ws)


# ---------- player sheets (/spieler/) ----------
# Players pick their character from a list (the campaign open in the Kampagnenbuch) and edit the full sheet,
# like the DM does. There is no login: everyone who reaches this port can open every sheet.

@app.get("/api/player/characters")
def player_character_list():
    """The campaign open in the Kampagnenbuch, with its characters.

    Returned as a list of campaigns; all campaigns with characters when none is open (or it is gone).
    """
    with get_conn() as conn:
        active = conn.execute(
            "SELECT id, name FROM campaigns WHERE id = ?", (get_settings(conn)["campaign_id"],)
        ).fetchone()
        campaigns = [active] if active else conn.execute(
            "SELECT id, name FROM campaigns WHERE id IN (SELECT campaign_id FROM characters) ORDER BY id DESC"
        ).fetchall()
        result = []
        for camp in campaigns:
            rows = conn.execute(
                "SELECT * FROM characters WHERE campaign_id = ? ORDER BY name", (camp["id"],)
            ).fetchall()
            chars = []
            for r in rows:
                sb = character_row(r)["stat_block"] or {}
                chars.append({"id": r["id"], "name": r["name"], "avatar_path": r["avatar_path"],
                              "char_class": sb.get("char_class"), "level": sb.get("level")})
            result.append({"id": camp["id"], "name": camp["name"], "characters": chars})
        return result


@app.get("/api/player/characters/{char_id}")
def player_get_character(char_id: int):
    with get_conn() as conn:
        return get_character(conn, char_id)


@app.put("/api/player/characters/{char_id}")
async def player_save_character(char_id: int, body: CharacterFields):
    with get_conn() as conn:
        char = save_character(conn, char_id, body)
    await tracker.sync_character(char)
    return char


# The portrait, as in the Charaktererstellung: uploaded or removed from the sheet's edit mode.
@app.post("/api/player/characters/{char_id}/avatar")
async def player_upload_avatar(char_id: int, filename: str, request: Request):
    data = await request.body()
    with get_conn() as conn:
        get_character(conn, char_id)
        char = library.set_character_avatar(conn, char_id, library.save_image(data, filename))
    await tracker.sync_character(char)
    return char


@app.delete("/api/player/characters/{char_id}/avatar")
async def player_delete_avatar(char_id: int):
    with get_conn() as conn:
        get_character(conn, char_id)
        char = library.set_character_avatar(conn, char_id, None)
    await tracker.sync_character(char)
    return char


class HpChange(BaseModel):
    damage: Optional[int] = None  # takes temporary HP first, as in the rules
    heal: Optional[int] = None  # up to the maximum; temporary HP stay as they are
    temp_hp: Optional[int] = None  # replaces the value; temporary HP from two sources never add up


@app.post("/api/player/characters/{char_id}/hp")
async def player_change_hp(char_id: int, body: HpChange):
    with get_conn() as conn:
        c = get_character(conn, char_id)
        hp = c["current_hp"] if c["current_hp"] is not None else c["max_hp"]
        temp = c["temp_hp"] or 0
        if body.damage:
            absorbed = min(temp, max(0, body.damage))
            temp -= absorbed
            hp -= max(0, body.damage) - absorbed
        if body.heal:
            hp += max(0, body.heal)
        if body.temp_hp is not None:
            temp = max(0, body.temp_hp)
        set_character_hp(conn, char_id, hp, temp)
        char = get_character(conn, char_id)
    await tracker.sync_character(char)
    return char


class PlayState(BaseModel):
    play_state: dict
    # The state the change started from. Given and no longer the stored one, the change is refused (409):
    # a second device or the DM changed it meanwhile, and the page loads that instead of overwriting it.
    base: Optional[dict] = None
    # Sheet values that follow from play: equipped items (and the AC they give), prepared spells.
    sheet: Optional[dict] = None
    ac: Optional[int] = None


# The only stat_block keys a live change may set; everything else needs the editor.
LIVE_SHEET_KEYS = {"equipped", "spell_list", "ac_adjust", "mage_armor"}


@app.put("/api/player/characters/{char_id}/play-state")
async def player_set_play_state(char_id: int, body: PlayState):
    """Used spell slots, Ki, hit dice, ammunition and inventory, changed during play without the editor.
    Equipping an item or preparing a spell also changes the sheet (and the AC), which the tracker follows."""
    with get_conn() as conn:
        c = get_character(conn, char_id)
        if body.base is not None and body.base != (c["play_state"] or {}):
            raise HTTPException(409, _t("Der Spielzustand wurde inzwischen anderswo geändert."))
        set_play_state(conn, char_id, body.play_state)
        sheet = {k: v for k, v in (body.sheet or {}).items() if k in LIVE_SHEET_KEYS}
        if sheet or body.ac is not None:
            stat_block = {**(c["stat_block"] or {}), **sheet}
            conn.execute("UPDATE characters SET stat_block = ?, ac = COALESCE(?, ac), updated_at = ? WHERE id = ?",
                         (json.dumps(stat_block), body.ac, new_version(), char_id))
        char = get_character(conn, char_id)
    if sheet or body.ac is not None:
        await tracker.sync_character(char)
    return char


@app.post("/api/player/characters/{char_id}/rest")
async def player_rest(char_id: int, kind: str):
    """Short rest: pact magic slots and short-rest resources (Ki) come back.
    Long rest: everything, plus all HP and spell slots; temporary HP end."""
    if kind not in ("short", "long"):
        raise HTTPException(400, "kind must be short or long")
    with get_conn() as conn:
        c = get_character(conn, char_id)
        state = dict(c["play_state"])
        state["pact_used"] = 0
        # Class resources are keyed by the rest that restores them ("short:ki").
        state["res_used"] = {k: v for k, v in state.get("res_used", {}).items() if kind == "short" and not k.startswith("short:")}
        if kind == "long":
            state["slots_used"] = {}
            # Half the hit dice (character level), at least one, come back.
            level = int((c["stat_block"] or {}).get("level") or 1)
            state["hd_used"] = max(0, int(state.get("hd_used", 0)) - max(1, level // 2))
            set_character_hp(conn, char_id, c["max_hp"], 0)
        set_play_state(conn, char_id, state)
        char = get_character(conn, char_id)
    if kind == "long":
        await tracker.sync_character(char)
    return char


@app.get("/api/player/items")
def player_items():
    """The whole item library (same shape as /api/items/custom): armor and weapons for the sheet,
    everything for the inventory."""
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT id, name, item_type, rarity, requires_attunement, desc, source, stat_block FROM custom_items "
            "ORDER BY name"
        ).fetchall()
        mem = translate.Memory(conn)
        return [translate.attach_item(character_row(r), mem) for r in rows]


@app.get("/api/player/spells")
def player_spells(dnd_class: str | None = None, ids: str | None = None):
    """Spells of one class from the spell library (dnd_class is the English class name, as Open5e
    lists it), plus the ones named in ids (comma-separated: spells a subclass adds from other
    lists). Neither given: the whole library (the level-up offers spells from any list)."""
    wanted = [int(i) for i in (ids or "").split(",") if i.strip().isdigit()]
    with get_conn() as conn:
        if dnd_class is None and not wanted:
            rows = conn.execute("SELECT * FROM custom_spells ORDER BY level_int, name").fetchall()
        else:
            marks = ",".join("?" * len(wanted)) or "NULL"
            rows = conn.execute(
                "SELECT * FROM custom_spells WHERE (', ' || lower(dnd_class) || ',') LIKE ? "
                f"OR id IN ({marks}) ORDER BY level_int, name",
                (f"%, {(dnd_class or '').lower()},%" if dnd_class else "", *wanted),
            ).fetchall()
        mem = translate.Memory(conn)
        return [translate.attach_spell(dict(r), mem) for r in rows]


@app.get("/api/player/options")
def player_options():
    """Classes, subclasses, peoples and backgrounds for the dropdowns, without the long texts."""
    with get_conn() as conn:
        mem = translate.Memory(conn)
        return [translate.attach_option(o, mem) for o in char_options.list_options(conn, lean=True)]


@app.get("/api/player/options/{option_id}")
def player_option(option_id: int):
    with get_conn() as conn:
        return translate.attach_option(char_options.get_option(conn, option_id), translate.Memory(conn))


@app.get("/spieler", include_in_schema=False)
def player_page_redirect():
    # Typed without the trailing slash the static mount would not match and "/" would answer 404.
    return RedirectResponse("/spieler/")


setup_common(app)
app.mount("/spieler", StaticFiles(directory=str(APP_DIR / "spieler_static"), html=True), name="spieler")
app.mount("/", StaticFiles(directory=str(APP_DIR / "player_static"), html=True), name="static")
