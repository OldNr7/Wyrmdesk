"""Player-facing API, reached only with a campaign's token in the URL. No accounts: whoever
has the link can see and create characters for that campaign, same as the other tools on
the home LAN - except here the token stands in for "being in the room".

The sheet itself (pcSheetHtml, readPcSheet, bindPcSheet, bindPcLive, from the Kampagnenbuch's
shared_static/charsheet.js) is reused as is, edit mode acting as the creation form. Equipping
gear, HP and resting change play_state outside the editor, the same split as there - see
public.py in the dmtool backend, which this mirrors (minus the tracker sync, which doesn't
apply here).
"""
import json
import secrets
from datetime import datetime
from typing import Optional
from uuid import uuid4

from fastapi import APIRouter, Header, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from . import export, open_mode
from .db import IMAGE_EXTS, UPLOAD_DIR, get_conn, row_to_dict
from .grants import parse_grants
from .security import verify_password
from .i18n import t

router = APIRouter(prefix="/api/k/{token}")

# Declared once so every route below can just add `password: Optional[str] = CampaignPassword`
# to its signature without repeating the Header(...) incantation each time.
CampaignPassword = Header(None, alias="X-Campaign-Password")


def _campaign(conn, token: str, password: Optional[str] = None) -> dict:
    row = conn.execute("SELECT * FROM campaigns WHERE token = ?", (token,)).fetchone()
    if row is None:
        raise HTTPException(404, t("Unbekannter oder abgelaufener Link."))
    c = row_to_dict(row)
    if c["password_hash"] and not (password and verify_password(password, c["password_hash"])):
        raise HTTPException(401, t("Falsches Passwort."))
    open_mode.touch(conn, c)
    return c


def _group_only(c: dict) -> None:
    """Session dates belong to a group with a DM: not in an open collection (open_mode.py)."""
    if c.get("is_open"):
        raise HTTPException(404, "not found")


@router.get("")
def get_campaign(token: str):
    """Unprotected on purpose: the page needs this to know whether to ask for a password
    before it has one to send."""
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM campaigns WHERE token = ?", (token,)).fetchone()
        if row is None:
            raise HTTPException(404, t("Unbekannter oder abgelaufener Link."))
        c = row_to_dict(row)
        return {"id": c["id"], "name": c["name"], "password_required": bool(c["password_hash"]),
                "open": bool(c["is_open"]),
                **({"days": open_mode.OPEN_DAYS, "max_characters": open_mode.OPEN_MAX_CHARACTERS} if c["is_open"] else {})}


@router.get("/characters")
def list_characters(token: str, password: Optional[str] = CampaignPassword):
    with get_conn() as conn:
        c = _campaign(conn, token, password)
        # Enough of the sheet for the list: picture, people, class and level.
        rows = conn.execute(
            "SELECT id, player_name, name, status, updated_at, avatar_path, "
            "json_extract(stat_block, '$.race') AS race, json_extract(stat_block, '$.char_class') AS char_class, "
            "json_extract(stat_block, '$.subclass') AS subclass, json_extract(stat_block, '$.level') AS level "
            "FROM characters WHERE campaign_id = ? ORDER BY id",
            (c["id"],),
        ).fetchall()
        return [row_to_dict(r) for r in rows]


class CharacterIn(BaseModel):
    player_name: Optional[str] = None
    name: str = ""
    max_hp: int = 1
    ac: int = 10
    initiative_bonus: int = 0
    notes: Optional[str] = None
    stat_block: Optional[dict] = None
    updated_at: Optional[str] = None  # edit-conflict check, as in the Kampagnenbuch
    hp_gain: Optional[int] = None  # level-up: the current HP rise along with the maximum


@router.post("/characters")
def create_character(token: str, body: CharacterIn, password: Optional[str] = CampaignPassword):
    with get_conn() as conn:
        c = _campaign(conn, token, password)
        if c["is_open"] and conn.execute("SELECT COUNT(*) AS n FROM characters WHERE campaign_id = ?",
                                         (c["id"],)).fetchone()["n"] >= open_mode.OPEN_MAX_CHARACTERS:
            raise HTTPException(400, t("Hier haben höchstens {n} Charaktere Platz.", n=open_mode.OPEN_MAX_CHARACTERS))
        cur = conn.execute(
            "INSERT INTO characters (campaign_id, player_name, name, max_hp, ac, initiative_bonus, notes, "
            "stat_block, current_hp, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (c["id"], body.player_name, body.name, body.max_hp, body.ac, body.initiative_bonus, body.notes,
             json.dumps(body.stat_block or {}), body.max_hp, _now()),
        )
        return _character(conn, c["id"], cur.lastrowid)


@router.get("/characters/{character_id}")
def get_character(token: str, character_id: int, password: Optional[str] = CampaignPassword):
    with get_conn() as conn:
        c = _campaign(conn, token, password)
        return _character(conn, c["id"], character_id)


@router.put("/characters/{character_id}")
def save_character(token: str, character_id: int, body: CharacterIn, password: Optional[str] = CampaignPassword):
    with get_conn() as conn:
        c = _campaign(conn, token, password)
        _character(conn, c["id"], character_id)  # 404s if it's not (or no longer) this campaign's
        # player_name isn't part of the sheet form (readPcSheet doesn't set it): keep it unless given.
        cur = conn.execute(
            "UPDATE characters SET player_name = COALESCE(?, player_name), name = ?, max_hp = ?, ac = ?, "
            "initiative_bonus = ?, notes = ?, stat_block = ?, updated_at = ? "
            "WHERE id = ? AND (? IS NULL OR updated_at = ?)",
            (body.player_name, body.name, body.max_hp, body.ac, body.initiative_bonus, body.notes,
             json.dumps(body.stat_block or {}), _now(), character_id, body.updated_at, body.updated_at),
        )
        if cur.rowcount == 0:
            raise HTTPException(409, t("Der Charakter wurde inzwischen anderswo geändert."))
        if body.hp_gain:
            conn.execute("UPDATE characters SET current_hp = current_hp + ? WHERE id = ? AND current_hp IS NOT NULL",
                         (body.hp_gain, character_id))
        conn.execute("UPDATE characters SET current_hp = MIN(max_hp, COALESCE(current_hp, max_hp)) WHERE id = ?",
                     (character_id,))
        return _character(conn, c["id"], character_id)


class StatusIn(BaseModel):
    status: str  # draft | fertig


@router.get("/characters/{character_id}/export")
def export_character(token: str, character_id: int, password: Optional[str] = CampaignPassword):
    """The character as a file for the DM: the same shape as the DM's export of the finished ones (a list),
    so the Kampagnenbuch imports it the same way."""
    with get_conn() as conn:
        c = _campaign(conn, token, password)
        ch = _character(conn, c["id"], character_id)
    return JSONResponse([export.export_character(ch)],
                        headers={"Content-Disposition": f'attachment; filename="{export.export_filename(ch["name"])}"'})


@router.post("/characters/{character_id}/share")
def share_character(token: str, character_id: int, password: Optional[str] = CampaignPassword):
    """The character's share link (share.py), made on first use; the same one after that."""
    with get_conn() as conn:
        c = _campaign(conn, token, password)
        ch = _character(conn, c["id"], character_id)
        if not ch["share_token"]:
            conn.execute("UPDATE characters SET share_token = ? WHERE id = ?", (secrets.token_urlsafe(16), character_id))
        return _character(conn, c["id"], character_id)


@router.delete("/characters/{character_id}/share")
def unshare_character(token: str, character_id: int, password: Optional[str] = CampaignPassword):
    """Withdraws the share link: whoever has it can't download the character any more."""
    with get_conn() as conn:
        c = _campaign(conn, token, password)
        _character(conn, c["id"], character_id)
        conn.execute("UPDATE characters SET share_token = NULL WHERE id = ?", (character_id,))
        return _character(conn, c["id"], character_id)


@router.put("/characters/{character_id}/status")
def set_status(token: str, character_id: int, body: StatusIn, password: Optional[str] = CampaignPassword):
    if body.status not in ("draft", "fertig"):
        raise HTTPException(400, "status must be draft or fertig")
    with get_conn() as conn:
        c = _campaign(conn, token, password)
        _character(conn, c["id"], character_id)
        conn.execute("UPDATE characters SET status = ?, updated_at = ? WHERE id = ?",
                     (body.status, _now(), character_id))
        return _character(conn, c["id"], character_id)


@router.delete("/characters/{character_id}")
def delete_character(token: str, character_id: int, password: Optional[str] = CampaignPassword):
    with get_conn() as conn:
        c = _campaign(conn, token, password)
        ch = _character(conn, c["id"], character_id)
        if ch["avatar_path"]:
            _delete_image(ch["avatar_path"])
        conn.execute("DELETE FROM characters WHERE id = ?", (character_id,))
    return {"ok": True}


# ---------- portrait ----------

def _save_image(data: bytes, filename: str) -> str:
    ext = (filename or "").rsplit(".", 1)[-1].lower()
    if ext not in IMAGE_EXTS:
        raise HTTPException(400, f"unsupported image type: {ext}")
    # Unique name per upload: uploads are cached as immutable, so a new picture needs a new address.
    name = f"{uuid4().hex}.{ext}"
    (UPLOAD_DIR / name).write_bytes(data)
    return f"/uploads/{name}"


def _delete_image(avatar_path: str) -> None:
    name = avatar_path.rsplit("/", 1)[-1]
    (UPLOAD_DIR / name).unlink(missing_ok=True)


@router.post("/characters/{character_id}/avatar")
async def upload_character_avatar(token: str, character_id: int, filename: str, request: Request,
                                   password: Optional[str] = CampaignPassword):
    data = await request.body()
    with get_conn() as conn:
        c = _campaign(conn, token, password)
        if c["is_open"]:  # a public server is no image host; the class pictures stay
            raise HTTPException(403, t("Eigene Bilder gehen hier nicht."))
        ch = _character(conn, c["id"], character_id)
        new_path = _save_image(data, filename)
        conn.execute("UPDATE characters SET avatar_path = ?, updated_at = ? WHERE id = ?",
                     (new_path, _now(), character_id))
        if ch["avatar_path"]:
            _delete_image(ch["avatar_path"])
        return _character(conn, c["id"], character_id)


@router.delete("/characters/{character_id}/avatar")
def delete_character_avatar(token: str, character_id: int, password: Optional[str] = CampaignPassword):
    with get_conn() as conn:
        c = _campaign(conn, token, password)
        ch = _character(conn, c["id"], character_id)
        if ch["avatar_path"]:
            _delete_image(ch["avatar_path"])
        conn.execute("UPDATE characters SET avatar_path = NULL, updated_at = ? WHERE id = ?",
                     (_now(), character_id))
        return _character(conn, c["id"], character_id)


# ---------- play state: HP, resting, equipping gear (outside the sheet editor) ----------

class HpChange(BaseModel):
    damage: Optional[int] = None
    heal: Optional[int] = None
    temp_hp: Optional[int] = None


@router.post("/characters/{character_id}/hp")
def change_hp(token: str, character_id: int, body: HpChange, password: Optional[str] = CampaignPassword):
    with get_conn() as conn:
        c = _campaign(conn, token, password)
        ch = _character(conn, c["id"], character_id)
        hp = ch["current_hp"] if ch["current_hp"] is not None else ch["max_hp"]
        temp = ch["temp_hp"] or 0
        if body.damage:
            absorbed = min(temp, max(0, body.damage))
            temp -= absorbed
            hp -= max(0, body.damage) - absorbed
        if body.heal:
            hp += max(0, body.heal)
        if body.temp_hp is not None:
            temp = max(0, body.temp_hp)
        conn.execute(
            "UPDATE characters SET current_hp = MAX(0, MIN(max_hp, ?)), temp_hp = MAX(0, ?), state_updated_at = ? "
            "WHERE id = ?", (hp, temp, _now(), character_id),
        )
        return _character(conn, c["id"], character_id)


class PlayStateIn(BaseModel):
    play_state: dict
    base: Optional[dict] = None  # the state the change started from; refused (409) if it changed meanwhile
    sheet: Optional[dict] = None  # equipped items, prepared spells: also change the sheet
    ac: Optional[int] = None


LIVE_SHEET_KEYS = {"equipped", "spell_list", "ac_adjust", "mage_armor"}


@router.put("/characters/{character_id}/play-state")
def set_play_state(token: str, character_id: int, body: PlayStateIn, password: Optional[str] = CampaignPassword):
    with get_conn() as conn:
        c = _campaign(conn, token, password)
        ch = _character(conn, c["id"], character_id)
        if body.base is not None and body.base != (ch["play_state"] or {}):
            raise HTTPException(409, t("Der Spielzustand wurde inzwischen anderswo geändert."))
        conn.execute("UPDATE characters SET play_state = ?, state_updated_at = ? WHERE id = ?",
                     (json.dumps(body.play_state), _now(), character_id))
        sheet = {k: v for k, v in (body.sheet or {}).items() if k in LIVE_SHEET_KEYS}
        if sheet or body.ac is not None:
            stat_block = {**(ch["stat_block"] or {}), **sheet}
            conn.execute("UPDATE characters SET stat_block = ?, ac = COALESCE(?, ac), updated_at = ? WHERE id = ?",
                         (json.dumps(stat_block), body.ac, _now(), character_id))
        return _character(conn, c["id"], character_id)


@router.post("/characters/{character_id}/rest")
def rest(token: str, character_id: int, kind: str, password: Optional[str] = CampaignPassword):
    if kind not in ("short", "long"):
        raise HTTPException(400, "kind must be short or long")
    with get_conn() as conn:
        c = _campaign(conn, token, password)
        ch = _character(conn, c["id"], character_id)
        st = dict(ch["play_state"])
        st["pact_used"] = 0
        st["res_used"] = {k: v for k, v in st.get("res_used", {}).items() if kind == "short" and not k.startswith("short:")}
        if kind == "long":
            st["slots_used"] = {}
            level = int((ch["stat_block"] or {}).get("level") or 1)
            st["hd_used"] = max(0, int(st.get("hd_used", 0)) - max(1, level // 2))
            conn.execute("UPDATE characters SET current_hp = max_hp, temp_hp = 0 WHERE id = ?", (character_id,))
        conn.execute("UPDATE characters SET play_state = ?, state_updated_at = ? WHERE id = ?",
                     (json.dumps(st), _now(), character_id))
        return _character(conn, c["id"], character_id)


def _now() -> str:
    return datetime.now().isoformat(timespec="microseconds")


def _character(conn, campaign_id: int, character_id: int) -> dict:
    row = conn.execute(
        "SELECT * FROM characters WHERE id = ? AND campaign_id = ?", (character_id, campaign_id)
    ).fetchone()
    if row is None:
        raise HTTPException(404, "character not found")
    d = row_to_dict(row)
    d["stat_block"] = json.loads(d["stat_block"]) if d["stat_block"] else {}
    d["play_state"] = json.loads(d["play_state"]) if d["play_state"] else {}
    return d


# ---------- content pack, read-only for the sheet's dropdowns ----------

@router.get("/options")
def options(token: str, kind: Optional[str] = None, password: Optional[str] = CampaignPassword):
    with get_conn() as conn:
        _campaign(conn, token, password)
        if kind:
            rows = conn.execute("SELECT * FROM char_options WHERE kind = ? ORDER BY name, is_2024", (kind,)).fetchall()
        else:
            rows = conn.execute("SELECT * FROM char_options ORDER BY kind, name, is_2024").fetchall()
        out = []
        for r in rows:
            d = row_to_dict(r)
            d["data"] = json.loads(d["data"]) if d["data"] else {}
            if d["kind"] == "subclasses":
                for f in d["data"].get("features") or []:
                    f.pop("grants", None)
                    g = parse_grants(f)
                    if g:
                        f["grants"] = g
            out.append(d)
        return out


@router.get("/items")
def items(token: str, password: Optional[str] = CampaignPassword):
    with get_conn() as conn:
        _campaign(conn, token, password)
        rows = conn.execute("SELECT * FROM items ORDER BY name").fetchall()
        out = []
        for r in rows:
            d = row_to_dict(r)
            d["stat_block"] = json.loads(d["stat_block"]) if d["stat_block"] else {}
            out.append(d)
        return out


# ---------- Termine: the DM's proposed session dates, answered yes/maybe/no ----------
# No player accounts (see module docstring): player_name is free text, typed once and kept in
# the browser's localStorage, same trust level as the token link itself.

ANSWERS = {"yes", "maybe", "no"}


def _dates_out(conn, campaign_id: int) -> list[dict]:
    rows = conn.execute("SELECT * FROM session_dates WHERE campaign_id = ? ORDER BY date", (campaign_id,)).fetchall()
    out = []
    for r in rows:
        d = row_to_dict(r)
        votes = [row_to_dict(v) for v in conn.execute(
            "SELECT player_name, answer FROM session_votes WHERE date_id = ? ORDER BY player_name COLLATE NOCASE",
            (d["id"],),
        ).fetchall()]
        d["votes"] = votes
        d["counts"] = {"yes": 0, "maybe": 0, "no": 0}
        for v in votes:
            d["counts"][v["answer"]] += 1
        out.append(d)
    return out


@router.get("/dates")
def list_dates(token: str, password: Optional[str] = CampaignPassword):
    with get_conn() as conn:
        c = _campaign(conn, token, password)
        _group_only(c)
        return _dates_out(conn, c["id"])


class VoteIn(BaseModel):
    player_name: str
    answer: str  # yes | maybe | no


@router.put("/dates/{date_id}/vote")
def vote_date(token: str, date_id: int, body: VoteIn, password: Optional[str] = CampaignPassword):
    if body.answer not in ANSWERS:
        raise HTTPException(400, "answer must be yes, maybe or no")
    name = body.player_name.strip()
    if not name:
        raise HTTPException(400, t("Name fehlt."))
    with get_conn() as conn:
        c = _campaign(conn, token, password)
        _group_only(c)
        if conn.execute(
            "SELECT 1 FROM session_dates WHERE id = ? AND campaign_id = ?", (date_id, c["id"])
        ).fetchone() is None:
            raise HTTPException(404, "date not found")
        conn.execute(
            "INSERT INTO session_votes (date_id, player_name, answer, updated_at) VALUES (?, ?, ?, ?) "
            "ON CONFLICT(date_id, player_name) DO UPDATE SET answer = excluded.answer, updated_at = excluded.updated_at",
            (date_id, name, body.answer, _now()),
        )
        return _dates_out(conn, c["id"])


@router.delete("/dates/{date_id}/vote")
def clear_vote(token: str, date_id: int, player_name: str, password: Optional[str] = CampaignPassword):
    with get_conn() as conn:
        c = _campaign(conn, token, password)
        _group_only(c)
        conn.execute(
            "DELETE FROM session_votes WHERE date_id = ? AND player_name = ? "
            "AND date_id IN (SELECT id FROM session_dates WHERE campaign_id = ?)",
            (date_id, player_name.strip(), c["id"]),
        )
        return _dates_out(conn, c["id"])


@router.get("/spells")
def spells(token: str, dnd_class: Optional[str] = None, ids: Optional[str] = None,
           password: Optional[str] = CampaignPassword):
    """The spells of one class, plus the ones named in ids (comma-separated: spells a subclass adds
    from other lists, as in the Kampagnenbuch). Neither given: the whole list (the creation wizard
    offers spells from any list, e.g. the Arcana Domain's wizard cantrips)."""
    wanted = [int(i) for i in (ids or "").split(",") if i.strip().isdigit()]
    with get_conn() as conn:
        _campaign(conn, token, password)
        if dnd_class or wanted:
            marks = ",".join("?" * len(wanted)) or "NULL"
            rows = conn.execute(
                f"SELECT * FROM spells WHERE (? <> '' AND dnd_class LIKE ?) OR id IN ({marks}) ORDER BY level_int, name",
                (dnd_class or "", f"%{dnd_class or ''}%", *wanted),
            ).fetchall()
        else:
            rows = conn.execute("SELECT * FROM spells ORDER BY level_int, name").fetchall()
        return [row_to_dict(r) for r in rows]
