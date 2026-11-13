"""DM-only: manage campaigns (and their player links), upload the content pack exported
from the Kampagnenbuch, export characters players have finished, and propose session dates.
"""
import base64
import json
import re
import secrets
from datetime import datetime
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .auth import require_admin
from .db import UPLOAD_DIR, get_conn, row_to_dict
from .player import _delete_image
from .security import hash_password

router = APIRouter(prefix="/api/admin", dependencies=[Depends(require_admin)])

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


# ---------- campaigns ----------

def _campaign_out(row: dict) -> dict:
    """Never hand the hash itself to the browser - just whether one is set."""
    d = {**row, "has_password": bool(row.get("password_hash"))}
    d.pop("password_hash", None)
    return d


class CampaignIn(BaseModel):
    name: str
    password: Optional[str] = None


@router.get("/campaigns")
def list_campaigns():
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT c.*, (SELECT COUNT(*) FROM characters WHERE campaign_id = c.id) AS character_count "
            "FROM campaigns c ORDER BY c.id DESC"
        ).fetchall()
        return [_campaign_out(row_to_dict(r)) for r in rows]


@router.post("/campaigns")
def create_campaign(body: CampaignIn):
    token = secrets.token_urlsafe(16)
    password_hash = hash_password(body.password) if body.password else None
    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO campaigns (name, token, password_hash) VALUES (?, ?, ?)",
            (body.name, token, password_hash),
        )
        row = conn.execute("SELECT * FROM campaigns WHERE id = ?", (cur.lastrowid,)).fetchone()
        return _campaign_out(row_to_dict(row))


class CampaignUpdate(BaseModel):
    name: Optional[str] = None
    password: Optional[str] = None  # set/change
    clear_password: bool = False  # remove it (wins over `password` if both are given)


@router.put("/campaigns/{campaign_id}")
def update_campaign(campaign_id: int, body: CampaignUpdate):
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM campaigns WHERE id = ?", (campaign_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "campaign not found")
        name = body.name.strip() if body.name and body.name.strip() else row["name"]
        if body.clear_password:
            password_hash = None
        elif body.password:
            password_hash = hash_password(body.password)
        else:
            password_hash = row["password_hash"]
        conn.execute(
            "UPDATE campaigns SET name = ?, password_hash = ? WHERE id = ?",
            (name, password_hash, campaign_id),
        )
        updated = conn.execute("SELECT * FROM campaigns WHERE id = ?", (campaign_id,)).fetchone()
        return _campaign_out(row_to_dict(updated))


@router.delete("/campaigns/{campaign_id}")
def delete_campaign(campaign_id: int):
    with get_conn() as conn:
        # The characters go with the campaign (ON DELETE CASCADE), their portrait files don't.
        portraits = [r["avatar_path"] for r in conn.execute(
            "SELECT avatar_path FROM characters WHERE campaign_id = ? AND avatar_path IS NOT NULL", (campaign_id,)
        ).fetchall()]
        conn.execute("DELETE FROM campaigns WHERE id = ?", (campaign_id,))
    for path in portraits:
        _delete_image(path)
    return {"ok": True}


# ---------- content pack (classes/subclasses/races/backgrounds, items, spells) ----------
# Uploaded as one JSON file, exported from the Kampagnenbuch (dmtool). Replaces what was
# there before; characters already created keep whatever they picked. The rows keep their ids
# from there, so the refs on an exported sheet (class_ref, subclass_ref, spell_list ids) point to
# the same entries once it is imported into the Kampagnenbuch again.

class ContentPackIn(BaseModel):
    char_options: list[dict] = []
    items: list[dict] = []
    spells: list[dict] = []


@router.get("/content")
def content_status():
    with get_conn() as conn:
        counts = {
            "char_options": conn.execute("SELECT COUNT(*) AS n FROM char_options").fetchone()["n"],
            "items": conn.execute("SELECT COUNT(*) AS n FROM items").fetchone()["n"],
            "spells": conn.execute("SELECT COUNT(*) AS n FROM spells").fetchone()["n"],
        }
        uploaded_at = conn.execute("SELECT value FROM app_settings WHERE key = 'content_uploaded_at'").fetchone()
        return {**counts, "uploaded_at": uploaded_at["value"] if uploaded_at else None}


@router.post("/content")
def upload_content(body: ContentPackIn):
    with get_conn() as conn:
        conn.execute("DELETE FROM char_options")
        conn.execute("DELETE FROM items")
        conn.execute("DELETE FROM spells")
        for o in body.char_options:
            conn.execute(
                "INSERT INTO char_options (id, kind, name, name_en, parent, is_2024, data, desc, desc_de, source, notes) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (o.get("id"), o["kind"], o["name"], o.get("name_en"), o.get("parent"), int(o.get("is_2024") or 0),
                 json.dumps(o["data"]) if isinstance(o.get("data"), dict) else (o.get("data") or "{}"),
                 o.get("desc"), o.get("desc_de"), o.get("source", "import"), o.get("notes")),
            )
        for i in body.items:
            conn.execute(
                "INSERT INTO items (id, name, item_type, rarity, requires_attunement, desc, desc_de, stat_block, notes) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (i.get("id"), i["name"], i.get("item_type"), i.get("rarity"), int(i.get("requires_attunement") or 0),
                 i.get("desc"), i.get("desc_de"),
                 json.dumps(i["stat_block"]) if isinstance(i.get("stat_block"), dict) else i.get("stat_block"),
                 i.get("notes")),
            )
        for s in body.spells:
            conn.execute(
                "INSERT INTO spells (id, name, school, level_int, dnd_class, casting_time, range, components, "
                "material, duration, concentration, ritual, higher_level, desc, notes, "
                "desc_de, higher_level_de, material_de) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (s.get("id"), s["name"], s.get("school"), s.get("level_int"), s.get("dnd_class"), s.get("casting_time"),
                 s.get("range"), s.get("components"), s.get("material"), s.get("duration"),
                 int(s.get("concentration") or 0), int(s.get("ritual") or 0), s.get("higher_level"),
                 s.get("desc"), s.get("notes"), s.get("desc_de"), s.get("higher_level_de"), s.get("material_de")),
            )
        conn.execute(
            "INSERT INTO app_settings (key, value) VALUES ('content_uploaded_at', ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (datetime.now().isoformat(timespec="seconds"),),
        )
    return content_status()


# ---------- characters ----------

@router.get("/characters")
def list_characters(campaign_id: Optional[int] = None):
    with get_conn() as conn:
        query = ("SELECT ch.id, ch.campaign_id, c.name AS campaign_name, ch.player_name, ch.name, "
                  "ch.status, ch.updated_at FROM characters ch JOIN campaigns c ON c.id = ch.campaign_id")
        params: tuple = ()
        if campaign_id is not None:
            query += " WHERE ch.campaign_id = ?"
            params = (campaign_id,)
        query += " ORDER BY ch.updated_at DESC"
        rows = conn.execute(query, params).fetchall()
        return [row_to_dict(r) for r in rows]


# The placeholder pictures per class (made by tools/creation-icons.py); the Kampagnenbuch has the same set.
CLASS_PORTRAITS = Path(__file__).parent / "shared_static" / "class-portraits"


def _portrait_class(stat_block: dict) -> Optional[str]:
    """English class name of the sheet, if there is a placeholder picture for it."""
    key = str(stat_block.get("class_key") or "")
    ref = stat_block.get("class_ref") or {}
    en = str(ref.get("name_en") or ref.get("name") or "").strip().lower() if key.startswith("lib:") else key
    return en if en and (CLASS_PORTRAITS / f"{en}.svg").is_file() else None


def _avatar_export(avatar_path: Optional[str], stat_block: dict) -> dict:
    """The portrait goes into the export itself (base64), since the Kampagnenbuch can't reach this
    server's /uploads. Its avatar_path is dropped: it would point to a file the other side lacks.
    Without a picture of its own the character shows its class's here; the export then names the
    class (avatar_class), and the Kampagnenbuch takes that picture from its own copy of the set."""
    path = UPLOAD_DIR / avatar_path.rsplit("/", 1)[-1] if avatar_path else None
    if path and path.is_file():
        return {"avatar_path": None, "avatar_name": path.name, "avatar_data": base64.b64encode(path.read_bytes()).decode("ascii")}
    cls = _portrait_class(stat_block)
    return {"avatar_path": None, **({"avatar_class": cls} if cls else {})}


@router.get("/characters/export")
def export_characters(campaign_id: Optional[int] = None):
    """Finished characters, in the shape the Kampagnenbuch's import expects."""
    with get_conn() as conn:
        query = "SELECT * FROM characters WHERE status = 'fertig'"
        params: tuple = ()
        if campaign_id is not None:
            query += " AND campaign_id = ?"
            params = (campaign_id,)
        rows = conn.execute(query, params).fetchall()
        out = []
        for r in rows:
            d = row_to_dict(r)
            d["stat_block"] = json.loads(d["stat_block"]) if d["stat_block"] else {}
            d.update(_avatar_export(d.get("avatar_path"), d["stat_block"]))
            out.append(d)
        conn.execute(
            "UPDATE characters SET exported_at = ? WHERE status = 'fertig'" + (" AND campaign_id = ?" if campaign_id is not None else ""),
            (datetime.now().isoformat(timespec="seconds"),) + params,
        )
        return out


@router.delete("/characters/{character_id}")
def delete_character(character_id: int):
    with get_conn() as conn:
        row = conn.execute("SELECT avatar_path FROM characters WHERE id = ?", (character_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "character not found")
        if row["avatar_path"]:
            _delete_image(row["avatar_path"])
        conn.execute("DELETE FROM characters WHERE id = ?", (character_id,))
    return {"ok": True}


# ---------- Termine (session date poll, one calendar per campaign) ----------

def _date_out(conn, row: dict) -> dict:
    votes = [row_to_dict(v) for v in conn.execute(
        "SELECT player_name, answer FROM session_votes WHERE date_id = ? ORDER BY player_name COLLATE NOCASE",
        (row["id"],),
    ).fetchall()]
    counts = {"yes": 0, "maybe": 0, "no": 0}
    for v in votes:
        counts[v["answer"]] += 1
    return {**row, "votes": votes, "counts": counts}


class SessionDateIn(BaseModel):
    date: str  # YYYY-MM-DD
    note: Optional[str] = None


@router.get("/campaigns/{campaign_id}/dates")
def list_dates(campaign_id: int):
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM session_dates WHERE campaign_id = ? ORDER BY date", (campaign_id,)
        ).fetchall()
        return [_date_out(conn, row_to_dict(r)) for r in rows]


@router.post("/campaigns/{campaign_id}/dates")
def propose_date(campaign_id: int, body: SessionDateIn):
    if not DATE_RE.match(body.date):
        raise HTTPException(400, "date must be YYYY-MM-DD")
    with get_conn() as conn:
        if conn.execute("SELECT 1 FROM campaigns WHERE id = ?", (campaign_id,)).fetchone() is None:
            raise HTTPException(404, "campaign not found")
        cur = conn.execute(
            "INSERT INTO session_dates (campaign_id, date, note) VALUES (?, ?, ?)",
            (campaign_id, body.date, body.note),
        )
        row = row_to_dict(conn.execute("SELECT * FROM session_dates WHERE id = ?", (cur.lastrowid,)).fetchone())
        return _date_out(conn, row)


@router.delete("/dates/{date_id}")
def delete_date(date_id: int):
    with get_conn() as conn:
        if conn.execute("DELETE FROM session_dates WHERE id = ?", (date_id,)).rowcount == 0:
            raise HTTPException(404, "date not found")
    return {"ok": True}
