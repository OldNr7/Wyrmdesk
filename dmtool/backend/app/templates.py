"""Campaign templates: a snapshot of one campaign with everything in it, to start it anew as often as
wanted (the same adventure with a second group).

A template is one row in campaign_templates; its data is the campaign's rows as they were, as JSON:
entries, sessions, timeline events, documents, player characters, the tracker's encounters with their
combatants and the battlemap's scenes with their tokens. Ids inside are the old ones; a new campaign
from it gets new ids and every reference between the rows is carried over (parent places, the
characters' entries, a session's encounters, a token's combatant). Texts link by name ([[Phandalin]]),
so they need nothing.

Pictures in /uploads and /tokens are never deleted, so a template just keeps their addresses. Map
images and fog masks are deleted with their scene, so the template keeps copies of its own (tpl-…
in the maps folder, removed with the template) and every new campaign gets copies again.

Starting from a template the DM picks whether the player characters come along (a new group usually
brings its own) and whether the play so far is reset: nothing known to the players, every session
planned again without recap and notes, timeline events of played sessions gone, fog closed again,
fights at their start with full hit points.
"""
import json
import shutil
from typing import Optional
from uuid import uuid4

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .battlemap.db import MAP_DIR
from .db import get_conn, set_setting
from .i18n import t as _t

router = APIRouter()

VERSION = 1


def _rows(conn, sql: str, *args) -> list[dict]:
    return [dict(r) for r in conn.execute(sql, args)]


def _columns(conn, table: str) -> set[str]:
    return {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}


def _insert(conn, table: str, row: dict, cols: dict) -> int:
    """A row into table, without its old id and with only the columns the table has (a template
    from before a migration lacks new ones, they take their defaults)."""
    if table not in cols:
        cols[table] = _columns(conn, table)
    values = {k: v for k, v in row.items() if k in cols[table] and k != "id"}
    names = ", ".join(values)
    return conn.execute(f"INSERT INTO {table} ({names}) VALUES ({', '.join('?' * len(values))})",
                        tuple(values.values())).lastrowid


def _copy_map(name: Optional[str], prefix: str) -> Optional[str]:
    """A copy of a map image or fog mask under a new name, None if the file is gone."""
    if not name or not (MAP_DIR / name).is_file():
        return None
    ext = name.rsplit(".", 1)[-1] if "." in name else "png"
    new = f"{prefix}-{uuid4().hex[:12]}.{ext}"
    shutil.copyfile(MAP_DIR / name, MAP_DIR / new)
    return new


def _map_files(data: dict) -> list[str]:
    return [s[k] for s in data.get("scenes", []) for k in ("map_file", "fog_base") if s.get(k)]


def snapshot(conn, campaign_id: int) -> dict:
    campaign = conn.execute("SELECT * FROM campaigns WHERE id = ?", (campaign_id,)).fetchone()
    if campaign is None:
        raise HTTPException(404, _t("Kampagne nicht gefunden"))
    data = {
        "version": VERSION,
        "campaign": {"name": campaign["name"], "calendar": campaign["calendar"], "today": campaign["today"]},
        "entries": _rows(conn, "SELECT * FROM entries WHERE campaign_id = ? ORDER BY id", campaign_id),
        "sessions": _rows(conn, "SELECT * FROM sessions WHERE campaign_id = ? ORDER BY number, id", campaign_id),
        "events": _rows(conn, "SELECT * FROM events WHERE campaign_id = ? ORDER BY id", campaign_id),
        "documents": _rows(conn, "SELECT * FROM documents WHERE campaign_id = ? ORDER BY sort_order, id", campaign_id),
        "characters": _rows(conn, "SELECT * FROM characters WHERE campaign_id = ? ORDER BY id", campaign_id),
        "encounters": [{**e, "combatants": _rows(conn, "SELECT * FROM combatants WHERE encounter_id = ? ORDER BY id", e["id"])}
                       for e in _rows(conn, "SELECT * FROM encounters WHERE campaign_id = ? ORDER BY id", campaign_id)],
        "scenes": [{**s, "tokens": _rows(conn, "SELECT * FROM tokens WHERE scene_id = ? ORDER BY id", s["id"])}
                   for s in _rows(conn, "SELECT * FROM scenes WHERE campaign_id = ? ORDER BY sort_order, id", campaign_id)],
    }
    for s in data["scenes"]:
        s["map_file"] = _copy_map(s["map_file"], "tpl")
        s["fog_base"] = _copy_map(s["fog_base"], "tpl")
    return data


def _counts(data: dict) -> dict:
    return {"entries": len([e for e in data["entries"] if e["type"] != "pc"]), "sessions": len(data["sessions"]),
            "characters": len(data["characters"]), "encounters": len(data["encounters"]), "scenes": len(data["scenes"])}


def instantiate(conn, data: dict, name: str, with_characters: bool, reset: bool) -> int:
    """A new campaign from a template's data; returns its id."""
    cols: dict = {}
    c = data["campaign"]
    cid = conn.execute("INSERT INTO campaigns (name, calendar, today) VALUES (?, ?, ?)",
                       (name, c.get("calendar"), c.get("today"))).lastrowid

    # Entries first (without "liegt in", that points at entries not made yet). Without the player
    # characters their 'pc' entries stay behind as well: they belong to the other group.
    entry_ids: dict[int, int] = {}
    for e in data["entries"]:
        if e["type"] == "pc" and not with_characters:
            continue
        entry_ids[e["id"]] = _insert(conn, "entries", {**e, "campaign_id": cid, "parent_id": None,
                                                         "known": 0 if reset else e["known"]}, cols)
    for e in data["entries"]:
        if e["id"] in entry_ids and e.get("parent_id") in entry_ids:
            conn.execute("UPDATE entries SET parent_id = ? WHERE id = ?", (entry_ids[e["parent_id"]], entry_ids[e["id"]]))

    char_ids: dict[int, int] = {}
    if with_characters:
        for ch in data["characters"]:
            row = {**ch, "campaign_id": cid, "entry_id": entry_ids.get(ch.get("entry_id"))}
            if reset:
                row.update(current_hp=None, temp_hp=0, play_state=None, state_updated_at=None)
            char_ids[ch["id"]] = _insert(conn, "characters", row, cols)
    # An entry may name its character (fields.tracker_character_id).
    for e in data["entries"]:
        fields = json.loads(e.get("fields") or "{}")
        if e["id"] in entry_ids and "tracker_character_id" in fields:
            new = char_ids.get(fields["tracker_character_id"])
            if new is None:
                del fields["tracker_character_id"]
            else:
                fields["tracker_character_id"] = new
            conn.execute("UPDATE entries SET fields = ? WHERE id = ?", (json.dumps(fields), entry_ids[e["id"]]))

    # Fights: a player character in one is that character, so without them only the monsters remain.
    encounter_ids: dict[int, int] = {}
    combatant_ids: dict[int, int] = {}
    left_out: set[int] = set()  # the other group's characters in the fights; their tokens go too
    for enc in data["encounters"]:
        fighters = enc.get("combatants", [])
        row = {**enc, "campaign_id": cid, "current_combatant_id": None}
        if reset:
            row.update(round=1, current_turn_index=0, status="active")
        new_enc = _insert(conn, "encounters", row, cols)
        encounter_ids[enc["id"]] = new_enc
        for f in fighters:
            f = {**f, "encounter_id": new_enc}
            if f["source"] == "roster":
                if f.get("ref_id") not in char_ids:
                    left_out.add(f["id"])
                    continue
                f["ref_id"] = char_ids[f["ref_id"]]
            if reset:
                f.update(current_hp=f["max_hp"], temp_hp=0, initiative=None, status_effects="[]")
            combatant_ids[f["id"]] = _insert(conn, "combatants", f, cols)
        if not reset and enc.get("current_combatant_id") in combatant_ids:
            conn.execute("UPDATE encounters SET current_combatant_id = ? WHERE id = ?",
                         (combatant_ids[enc["current_combatant_id"]], new_enc))

    session_ids: dict[int, int] = {}
    for s in data["sessions"]:
        old_encs = json.loads(s.get("encounter_ids") or "[]")
        row = {**s, "campaign_id": cid, "tracker_session_id": None,
               "encounter_ids": json.dumps([encounter_ids[i] for i in old_encs if i in encounter_ids])}
        if reset:
            row.update(status="planned", played_on=None, game_start=None, game_end=None, recap="", log="[]")
        session_ids[s["id"]] = _insert(conn, "sessions", row, cols)

    # The timeline: what happened in a played session is the other group's story.
    for ev in data["events"]:
        if reset and ev.get("session_id") is not None:
            continue
        _insert(conn, "events", {**ev, "campaign_id": cid, "session_id": session_ids.get(ev.get("session_id"))}, cols)

    # Diverse Dokumente; their files in /uploads are never deleted, the address is enough.
    for doc in data.get("documents", []):
        _insert(conn, "documents", {**doc, "campaign_id": cid}, cols)

    for s in data["scenes"]:
        tokens = s.get("tokens", [])
        row = {**s, "campaign_id": cid, "map_file": _copy_map(s.get("map_file"), "scene"),
               "fog_base": None if reset else _copy_map(s.get("fog_base"), "fog")}
        row.pop("tokens", None)
        if reset:
            row.update(fog_ops="[]", vision_polys="[]")
        sid = _insert(conn, "scenes", row, cols)
        for t in tokens:
            if t.get("combatant_id") in left_out:
                continue
            _insert(conn, "tokens", {**t, "scene_id": sid, "combatant_id": combatant_ids.get(t.get("combatant_id"))}, cols)
    return cid


# ---------- API ----------

class TemplateIn(BaseModel):
    name: str
    note: str = ""


class FromTemplateIn(BaseModel):
    name: str
    with_characters: bool = False
    reset: bool = True


def _template(r) -> dict:
    data = json.loads(r["data"])
    return {"id": r["id"], "name": r["name"], "note": r["note"], "source_name": r["source_name"],
            "created_at": r["created_at"], "counts": _counts(data)}


@router.get("/api/templates")
def list_templates():
    with get_conn() as conn:
        return [_template(r) for r in conn.execute("SELECT * FROM campaign_templates ORDER BY created_at DESC, id DESC")]


@router.post("/api/campaigns/{campaign_id}/templates")
def create_template(campaign_id: int, body: TemplateIn):
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "Die Vorlage braucht einen Namen.")
    with get_conn() as conn:
        data = snapshot(conn, campaign_id)
        try:
            tid = conn.execute(
                "INSERT INTO campaign_templates (name, note, source_campaign_id, source_name, data) VALUES (?, ?, ?, ?, ?)",
                (name, body.note.strip(), campaign_id, data["campaign"]["name"], json.dumps(data))).lastrowid
        except Exception:
            for f in _map_files(data):
                (MAP_DIR / f).unlink(missing_ok=True)
            raise
        return _template(conn.execute("SELECT * FROM campaign_templates WHERE id = ?", (tid,)).fetchone())


@router.delete("/api/templates/{template_id}")
def delete_template(template_id: int):
    with get_conn() as conn:
        r = conn.execute("SELECT data FROM campaign_templates WHERE id = ?", (template_id,)).fetchone()
        if r is None:
            raise HTTPException(404, _t("Vorlage nicht gefunden"))
        conn.execute("DELETE FROM campaign_templates WHERE id = ?", (template_id,))
    for f in _map_files(json.loads(r["data"])):
        (MAP_DIR / f).unlink(missing_ok=True)
    return {"ok": True}


@router.post("/api/templates/{template_id}/campaigns")
def campaign_from_template(template_id: int, body: FromTemplateIn):
    name = body.name.strip()
    if not name:
        raise HTTPException(400, _t("Bitte einen Namen angeben."))
    with get_conn() as conn:
        r = conn.execute("SELECT data FROM campaign_templates WHERE id = ?", (template_id,)).fetchone()
        if r is None:
            raise HTTPException(404, _t("Vorlage nicht gefunden"))
        data = json.loads(r["data"])
        if data.get("version", 0) > VERSION:
            raise HTTPException(400, "Die Vorlage stammt aus einer neueren Version des Kampagnenbuchs.")
        cid = instantiate(conn, data, name, body.with_characters, body.reset)
        set_setting(conn, "campaign_id", cid)
        row = conn.execute("SELECT * FROM campaigns WHERE id = ?", (cid,)).fetchone()
    return {"id": row["id"], "name": row["name"]}
