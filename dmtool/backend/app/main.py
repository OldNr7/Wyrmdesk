import json
import re
from datetime import datetime
from typing import Any, Optional
from uuid import uuid4

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.background import BackgroundTask

from . import (backup, book_import, char_import, char_options, content_translate, ddb_import, internal, library, live,
               merge, templates, tracker, translate)
from .battlemap import db as map_db
from .combat import db as combat_db
from .common import APP_DIR, setup_common
from .db import (DB_PATH, DOCUMENT_EXTS, IMAGE_EXTS, UPLOAD_DIR, add_intro_chapter, get_conn, get_settings, init_db,
                 row_to_dict, set_setting)
from .characters import CharacterFields, character_row, get_character
from .links import rename_links
from . import public as player_api
from .i18n import t as _t

app = FastAPI(title="Wyrmdesk – Kampagnenbuch")
app.include_router(library.router)
app.include_router(char_options.router)
app.include_router(ddb_import.router)
app.include_router(book_import.router)
app.include_router(content_translate.router)
app.include_router(translate.router)
app.include_router(templates.router)

ENTRY_TYPES = {"pc", "npc", "place", "location", "faction", "item", "quest", "decision", "handout"}
# [[Name]] or [[Name|shown text]]
LINK_RE = re.compile(r"\[\[([^\]|]+)(?:\|[^\]]*)?\]\]")


# ---------- schemas ----------

class SettingsPatch(BaseModel):
    campaign_id: Optional[int] = None
    editor: Optional[str] = None
    rotation: Optional[int] = None


class CampaignIn(BaseModel):
    name: str
    calendar: dict
    today: Optional[dict] = None


class CampaignPatch(BaseModel):
    name: Optional[str] = None
    calendar: Optional[dict] = None
    today: Optional[dict] = None


class EntryIn(BaseModel):
    campaign_id: int
    type: str
    name: str
    summary: str = ""
    body: str = ""
    status: str = ""
    parent_id: Optional[int] = None
    fields: dict = {}


class EntryPatch(BaseModel):
    name: Optional[str] = None
    summary: Optional[str] = None
    body: Optional[str] = None
    secrets: Optional[str] = None
    image: Optional[str] = None
    status: Optional[str] = None
    parent_id: Optional[int] = None
    fields: Optional[dict] = None
    known: Optional[bool] = None


class SessionIn(BaseModel):
    campaign_id: int
    title: str
    played_on: Optional[str] = None
    # Set when a past session is added afterwards to write its recap.
    number: Optional[int] = None
    status: str = "planned"
    game_start: Optional[dict] = None
    game_end: Optional[dict] = None


class SessionPatch(BaseModel):
    title: Optional[str] = None
    number: Optional[int] = None
    played_on: Optional[str] = None
    status: Optional[str] = None
    game_start: Optional[dict] = None
    game_end: Optional[dict] = None
    prep: Optional[str] = None
    recap: Optional[str] = None
    log: Optional[list[dict]] = None
    encounter_ids: Optional[list[int]] = None


class EventIn(BaseModel):
    campaign_id: int
    title: str
    date: Optional[dict] = None
    sort_key: float = 0
    session_id: Optional[int] = None
    body: str = ""


class EventPatch(BaseModel):
    title: Optional[str] = None
    date: Optional[dict] = None
    sort_key: Optional[float] = None
    session_id: Optional[int] = None
    body: Optional[str] = None


DOCUMENT_KINDS = {"pdf", "image", "text", "table"}


class DocumentIn(BaseModel):
    campaign_id: int
    kind: str
    title: str
    file: Optional[str] = None
    body: str = ""
    data: dict = {}


class DocumentPatch(BaseModel):
    title: Optional[str] = None
    file: Optional[str] = None
    body: Optional[str] = None
    data: Optional[dict] = None


class DisplayIn(BaseModel):
    entry_id: Optional[int] = None
    with_text: bool = False
    title: Optional[str] = None
    image: Optional[str] = None


class EncounterDisplayIn(BaseModel):
    encounter_id: Optional[int] = None


# ---------- helpers ----------

async def _tracker(method: str, path: str, body: dict | None = None, params: dict | None = None):
    try:
        return await tracker.call(method, path, body, params)
    except tracker.TrackerError as e:
        raise HTTPException(e.status, e.detail)


def _json_cols(d: dict, *cols: str) -> dict:
    for col in cols:
        if col in d and isinstance(d[col], str):
            d[col] = json.loads(d[col])
    return d


def _entry(row) -> dict:
    d = _json_cols(row_to_dict(row), "fields")
    d["known"] = bool(d["known"])
    return d


def _session(row) -> dict:
    return _json_cols(row_to_dict(row), "game_start", "game_end", "log", "encounter_ids")


def _event(row) -> dict:
    return _json_cols(row_to_dict(row), "date")


def _document(row) -> dict:
    return _json_cols(row_to_dict(row), "data")


def _table_text(data: str) -> str:
    rows = json.loads(data or "{}").get("rows") or []
    return "\n".join(" | ".join(str(c) for c in r) for r in rows)


def _campaign(row) -> dict:
    return _json_cols(row_to_dict(row), "calendar", "today")


def _ensure_campaign(conn, campaign_id: int, name: str | None = None) -> None:
    conn.execute("INSERT OR IGNORE INTO campaigns (id, name) VALUES (?, ?)", (campaign_id, name or ""))
    if name:
        conn.execute("UPDATE campaigns SET name = ? WHERE id = ?", (name, campaign_id))


def _links(text: str) -> set[str]:
    return {m.group(1).strip().lower() for m in LINK_RE.finditer(text or "")}


def _texts(conn, campaign_id: int):
    """Every text that can hold [[links]], as (kind, row, {column: text})."""
    for r in conn.execute("SELECT * FROM entries WHERE campaign_id = ?", (campaign_id,)):
        yield "entry", r, {"summary": r["summary"], "body": r["body"], "secrets": r["secrets"]}
    for r in conn.execute("SELECT * FROM sessions WHERE campaign_id = ?", (campaign_id,)):
        log = " ".join(n.get("text", "") for n in json.loads(r["log"]))
        yield "session", r, {"prep": r["prep"], "recap": r["recap"], "log": log}
    for r in conn.execute("SELECT * FROM events WHERE campaign_id = ?", (campaign_id,)):
        yield "event", r, {"title": r["title"], "body": r["body"]}
    for r in conn.execute("SELECT * FROM documents WHERE campaign_id = ?", (campaign_id,)):
        yield "document", r, {"body": r["body"], "table": _table_text(r["data"])}


def _backlinks(conn, entry: dict) -> list[dict]:
    name = entry["name"].strip().lower()
    found = []
    for kind, row, texts in _texts(conn, entry["campaign_id"]):
        if kind == "entry" and row["id"] == entry["id"]:
            continue
        where = [col for col, text in texts.items() if name in _links(text)]
        if not where:
            continue
        item = {"kind": kind, "id": row["id"], "where": where}
        if kind == "entry":
            item.update(title=row["name"], type=row["type"])
        elif kind == "session":
            item.update(title=row["title"], number=row["number"])
        elif kind == "document":
            item.update(title=row["title"], doc_kind=row["kind"])
        else:
            item.update(title=row["title"])
        found.append(item)
    return found


def _update(conn, table: str, row_id: int, values: dict) -> None:
    if not values:
        return
    cols = ", ".join(f"{k} = ?" for k in values)
    stamp = ", updated_at = datetime('now')" if table in ("entries", "sessions", "documents") else ""
    conn.execute(f"UPDATE {table} SET {cols}{stamp} WHERE id = ?", (*values.values(), row_id))


def _encode(values: dict, *json_cols: str) -> dict:
    return {k: (json.dumps(v) if k in json_cols and v is not None else v) for k, v in values.items()}


def _save_upload(data: bytes, ext: str, allowed: set[str] = IMAGE_EXTS) -> str:
    ext = ext.lower()
    if ext not in allowed:
        raise HTTPException(400, _t("Dateityp nicht unterstützt: {ext}", ext=ext))
    name = f"{uuid4().hex}.{ext}"
    (UPLOAD_DIR / name).write_bytes(data)
    return f"/uploads/{name}"


# ---------- settings ----------

@app.get("/api/settings")
def get_app_settings():
    with get_conn() as conn:
        settings = get_settings(conn)
    return {**settings, "tracker_configured": bool(tracker.TRACKER_URL),
            "deepl_configured": bool(translate._api_key())}


@app.patch("/api/settings")
async def patch_settings(body: SettingsPatch):
    values = body.model_dump(exclude_unset=True)
    if "editor" in values and values["editor"] not in ("rich", "markdown"):
        raise HTTPException(400, "Unbekannter Editor.")
    if "rotation" in values:
        values["rotation"] = values["rotation"] % 360
    with get_conn() as conn:
        for key, value in values.items():
            set_setting(conn, key, value)
    if "rotation" in values:
        await live.notify()
    if "campaign_id" in values:
        internal.campaign_changed()
    return get_app_settings()


# ---------- campaigns ----------
# The Kampagnenbuch keeps the campaign list; the tracker and the battlemap read it from here.

@app.get("/api/campaigns")
async def list_campaigns():
    with get_conn() as conn:
        rows = conn.execute("SELECT * FROM campaigns ORDER BY id").fetchall()
    try:
        await tracker.call("GET", "/api/display/encounter")
        tracker_ok = True
    except tracker.TrackerError:
        tracker_ok = False
    return {"tracker_ok": tracker_ok, "campaigns": [_campaign(r) for r in rows]}


@app.post("/api/campaigns")
def create_campaign(body: CampaignIn):
    with get_conn() as conn:
        campaign_id = conn.execute(
            "INSERT INTO campaigns (name, calendar, today) VALUES (?, ?, ?)",
            (body.name.strip(), json.dumps(body.calendar), json.dumps(body.today) if body.today else None),
        ).lastrowid
        add_intro_chapter(conn, campaign_id)
        set_setting(conn, "campaign_id", campaign_id)
        return _campaign(conn.execute("SELECT * FROM campaigns WHERE id = ?", (campaign_id,)).fetchone())


@app.patch("/api/campaigns/{campaign_id}")
def patch_campaign(campaign_id: int, body: CampaignPatch):
    values = _encode(body.model_dump(exclude_unset=True), "calendar", "today")
    if "name" in values:
        values["name"] = values["name"].strip()
        if not values["name"]:
            raise HTTPException(400, "Der Name darf nicht leer sein.")
    with get_conn() as conn:
        _ensure_campaign(conn, campaign_id)
        _update(conn, "campaigns", campaign_id, values)
        return _campaign(conn.execute("SELECT * FROM campaigns WHERE id = ?", (campaign_id,)).fetchone())


@app.delete("/api/campaigns/{campaign_id}")
async def delete_campaign(campaign_id: int):
    """The campaign with everything in it, here and its encounters in the tracker."""
    with get_conn() as conn:
        if conn.execute("SELECT COUNT(*) AS n FROM campaigns").fetchone()["n"] <= 1:
            raise HTTPException(400, _t("Die letzte Kampagne kann nicht gelöscht werden."))
        for table in ("characters", "events", "sessions", "entries", "documents"):
            conn.execute(f"DELETE FROM {table} WHERE campaign_id = ?", (campaign_id,))
        conn.execute("DELETE FROM campaigns WHERE id = ?", (campaign_id,))
    await tracker.push(f"/api/campaigns/{campaign_id}/delete-encounters", {})
    return {"ok": True}


@app.get("/api/campaigns/{campaign_id}/index")
def campaign_index(campaign_id: int):
    """Everything the lists and [[link]] lookups need, without the long texts."""
    with get_conn() as conn:
        _ensure_campaign(conn, campaign_id)
        campaign = _campaign(conn.execute("SELECT * FROM campaigns WHERE id = ?", (campaign_id,)).fetchone())
        entries = [_entry(r) for r in conn.execute(
            "SELECT id, campaign_id, type, name, summary, image, status, parent_id, fields, known, updated_at "
            "FROM entries WHERE campaign_id = ? ORDER BY name COLLATE NOCASE", (campaign_id,))]
        sessions = [_session(r) for r in conn.execute(
            "SELECT id, campaign_id, number, title, played_on, status, game_start, game_end, encounter_ids, ddb_ref, updated_at "
            "FROM sessions WHERE campaign_id = ? ORDER BY number, id", (campaign_id,))]
        events = [_event(r) for r in conn.execute(
            "SELECT * FROM events WHERE campaign_id = ? ORDER BY sort_key, id", (campaign_id,))]
        documents = [row_to_dict(r) for r in conn.execute(
            "SELECT id, campaign_id, kind, title, file, sort_order, updated_at "
            "FROM documents WHERE campaign_id = ? ORDER BY sort_order, id", (campaign_id,))]
    return {"campaign": campaign, "entries": entries, "sessions": sessions, "events": events, "documents": documents}


@app.get("/api/campaigns/{campaign_id}/journal")
def campaign_journal(campaign_id: int):
    with get_conn() as conn:
        rows = conn.execute("SELECT * FROM sessions WHERE campaign_id = ? AND status = 'played' ORDER BY number, id",
                            (campaign_id,)).fetchall()
        return [_session(r) for r in rows]


# ---------- entries ----------

@app.get("/api/entries/{entry_id}")
def get_entry(entry_id: int):
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM entries WHERE id = ?", (entry_id,)).fetchone()
        if row is None:
            raise HTTPException(404, _t("Eintrag nicht gefunden."))
        entry = _entry(row)
        entry["backlinks"] = _backlinks(conn, entry)
        if entry["type"] == "pc":
            # The rules side of a party member: the full character sheet.
            char = conn.execute("SELECT * FROM characters WHERE entry_id = ?", (entry_id,)).fetchone()
            entry["character"] = character_row(char) if char else None
        return entry


@app.post("/api/entries")
def create_entry(body: EntryIn):
    if body.type not in ENTRY_TYPES:
        raise HTTPException(400, "Unbekannter Eintragstyp.")
    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO entries (campaign_id, type, name, summary, body, status, parent_id, fields, known) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (body.campaign_id, body.type, body.name.strip(), body.summary, body.body, body.status,
             body.parent_id, json.dumps(body.fields), int(body.type == "pc")),
        )
        if body.type == "pc":
            # Starts with placeholder values; the DM fills in the sheet on the entry page.
            library.create_character_row(conn, body.campaign_id,
                                         CharacterFields(name=body.name.strip(), max_hp=10, ac=10), cur.lastrowid)
        return _entry(conn.execute("SELECT * FROM entries WHERE id = ?", (cur.lastrowid,)).fetchone())


@app.patch("/api/entries/{entry_id}")
async def patch_entry(entry_id: int, body: EntryPatch):
    values = _encode(body.model_dump(exclude_unset=True), "fields")
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM entries WHERE id = ?", (entry_id,)).fetchone()
        if row is None:
            raise HTTPException(404, _t("Eintrag nicht gefunden."))
        if "name" in values:
            values["name"] = values["name"].strip()
            if values["name"] != row["name"]:
                rename_links(conn, row["campaign_id"], row["name"], values["name"])
        if values.get("parent_id") == entry_id:
            raise HTTPException(400, "Ein Ort kann nicht in sich selbst liegen.")
        _update(conn, "entries", entry_id, values)
        char = None
        if row["type"] == "pc" and ("name" in values or "image" in values):
            # Name and portrait belong to the character as well.
            char_values = {k: values[k] for k in ("name",) if k in values}
            if "image" in values:
                char_values["avatar_path"] = values["image"]
            for key, value in char_values.items():
                conn.execute(f"UPDATE characters SET {key} = ? WHERE entry_id = ?", (value, entry_id))
            char_row = conn.execute("SELECT * FROM characters WHERE entry_id = ?", (entry_id,)).fetchone()
            char = character_row(char_row) if char_row else None
        entry = _entry(conn.execute("SELECT * FROM entries WHERE id = ?", (entry_id,)).fetchone())
    if char is not None:
        await tracker.sync_character(char)
    return entry


@app.delete("/api/entries/{entry_id}")
async def delete_entry(entry_id: int):
    with get_conn() as conn:
        conn.execute("DELETE FROM characters WHERE entry_id = ?", (entry_id,))
        conn.execute("DELETE FROM entries WHERE id = ?", (entry_id,))
        handout = get_settings(conn)["handout"]
        cleared = handout is not None and handout.get("entry_id") == entry_id
        if cleared:
            set_setting(conn, "handout", None)
    if cleared:
        await live.notify()
    return {"ok": True}


# ---------- sessions ----------

@app.get("/api/sessions/{session_id}")
def get_session(session_id: int):
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
        if row is None:
            raise HTTPException(404, _t("Sitzung nicht gefunden."))
        return _session(row)


@app.post("/api/sessions")
def create_session(body: SessionIn):
    if body.status not in ("planned", "played"):
        raise HTTPException(400, "Unbekannter Status.")
    with get_conn() as conn:
        number = body.number or conn.execute("SELECT COALESCE(MAX(number), 0) + 1 AS n FROM sessions WHERE campaign_id = ?",
                                             (body.campaign_id,)).fetchone()["n"]
        values = _encode({"game_start": body.game_start, "game_end": body.game_end}, "game_start", "game_end")
        cur = conn.execute(
            "INSERT INTO sessions (campaign_id, number, title, played_on, status, game_start, game_end) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (body.campaign_id, number, body.title.strip(), body.played_on, body.status, values["game_start"], values["game_end"]))
        return _session(conn.execute("SELECT * FROM sessions WHERE id = ?", (cur.lastrowid,)).fetchone())


@app.patch("/api/sessions/{session_id}")
def patch_session(session_id: int, body: SessionPatch):
    values = _encode(body.model_dump(exclude_unset=True), "game_start", "game_end", "log", "encounter_ids")
    if values.get("status") not in (None, "planned", "played"):
        raise HTTPException(400, "Unbekannter Status.")
    with get_conn() as conn:
        if conn.execute("SELECT id FROM sessions WHERE id = ?", (session_id,)).fetchone() is None:
            raise HTTPException(404, _t("Sitzung nicht gefunden."))
        _update(conn, "sessions", session_id, values)
        return _session(conn.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone())


@app.delete("/api/sessions/{session_id}")
def delete_session(session_id: int):
    with get_conn() as conn:
        conn.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
    return {"ok": True}


# ---------- timeline events ----------

@app.post("/api/events")
def create_event(body: EventIn):
    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO events (campaign_id, title, date, sort_key, session_id, body) VALUES (?, ?, ?, ?, ?, ?)",
            (body.campaign_id, body.title.strip(), json.dumps(body.date) if body.date else None,
             body.sort_key, body.session_id, body.body),
        )
        return _event(conn.execute("SELECT * FROM events WHERE id = ?", (cur.lastrowid,)).fetchone())


@app.patch("/api/events/{event_id}")
def patch_event(event_id: int, body: EventPatch):
    values = _encode(body.model_dump(exclude_unset=True), "date")
    with get_conn() as conn:
        _update(conn, "events", event_id, values)
        row = conn.execute("SELECT * FROM events WHERE id = ?", (event_id,)).fetchone()
        if row is None:
            raise HTTPException(404, _t("Ereignis nicht gefunden."))
        return _event(row)


@app.delete("/api/events/{event_id}")
def delete_event(event_id: int):
    with get_conn() as conn:
        conn.execute("DELETE FROM events WHERE id = ?", (event_id,))
    return {"ok": True}


# ---------- diverse Dokumente ----------

@app.get("/api/documents/{document_id}")
def get_document(document_id: int):
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM documents WHERE id = ?", (document_id,)).fetchone()
        if row is None:
            raise HTTPException(404, _t("Dokument nicht gefunden."))
        return _document(row)


@app.post("/api/documents")
def create_document(body: DocumentIn):
    if body.kind not in DOCUMENT_KINDS:
        raise HTTPException(400, "Unbekannte Dokumentenart.")
    if body.kind in ("pdf", "image") and not body.file:
        raise HTTPException(400, "Die Datei fehlt.")
    data = body.data or ({"rows": [["Spalte 1", "Spalte 2"], ["", ""]]} if body.kind == "table" else {})
    with get_conn() as conn:
        # New ones go to the end of the list.
        order = conn.execute("SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM documents WHERE campaign_id = ?",
                             (body.campaign_id,)).fetchone()["n"]
        cur = conn.execute(
            "INSERT INTO documents (campaign_id, kind, title, file, body, data, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (body.campaign_id, body.kind, body.title.strip() or "Ohne Titel", body.file, body.body, json.dumps(data), order))
        return _document(conn.execute("SELECT * FROM documents WHERE id = ?", (cur.lastrowid,)).fetchone())


@app.patch("/api/documents/{document_id}")
def patch_document(document_id: int, body: DocumentPatch):
    values = _encode(body.model_dump(exclude_unset=True), "data")
    if "title" in values:
        values["title"] = values["title"].strip()
        if not values["title"]:
            raise HTTPException(400, "Der Titel darf nicht leer sein.")
    with get_conn() as conn:
        if conn.execute("SELECT id FROM documents WHERE id = ?", (document_id,)).fetchone() is None:
            raise HTTPException(404, _t("Dokument nicht gefunden."))
        _update(conn, "documents", document_id, values)
        return _document(conn.execute("SELECT * FROM documents WHERE id = ?", (document_id,)).fetchone())


@app.post("/api/documents/{document_id}/move")
def move_document(document_id: int, delta: int):
    """One place up (delta -1) or down (+1) in the list; returns the new order of the ids."""
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM documents WHERE id = ?", (document_id,)).fetchone()
        if row is None:
            raise HTTPException(404, _t("Dokument nicht gefunden."))
        ids = [r["id"] for r in conn.execute("SELECT id FROM documents WHERE campaign_id = ? ORDER BY sort_order, id",
                                             (row["campaign_id"],))]
        i = ids.index(document_id)
        j = i + (1 if delta > 0 else -1)
        if 0 <= j < len(ids):
            ids[i], ids[j] = ids[j], ids[i]
        for n, doc_id in enumerate(ids, 1):
            conn.execute("UPDATE documents SET sort_order = ? WHERE id = ?", (n, doc_id))
    return {"ids": ids}


@app.delete("/api/documents/{document_id}")
def delete_document(document_id: int):
    with get_conn() as conn:
        conn.execute("DELETE FROM documents WHERE id = ?", (document_id,))
    return {"ok": True}


# ---------- search ----------

def _plain(text: str) -> str:
    """Markdown as readable plain text, for search snippets."""
    text = LINK_RE.sub(lambda m: m.group(0)[2:-2].split("|")[-1], text or "")
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)|[#>*_`]", "", text)
    text = re.sub(r"^\s*-\s+", "", text, flags=re.MULTILINE)
    return re.sub(r"\s+", " ", text).strip()


def _snippet(text: str, q: str) -> str:
    text = _plain(text)
    i = text.lower().find(q.lower())
    if i < 0:
        return text[:120]
    start = max(0, i - 50)
    end = i + len(q) + 70
    return ("…" if start else "") + text[start:end] + ("…" if end < len(text) else "")


@app.get("/api/search")
def search(campaign_id: int, q: str):
    q = q.strip()
    if len(q) < 2:
        return []
    results: list[dict[str, Any]] = []
    with get_conn() as conn:
        for kind, row, texts in _texts(conn, campaign_id):
            title = row["name"] if kind == "entry" else row["title"]
            hay = {"title": title, **texts}
            hit = next((col for col, text in hay.items() if q.lower() in (text or "").lower()), None)
            if hit is None:
                continue
            item = {"kind": kind, "id": row["id"], "title": title, "in_title": hit == "title",
                    "snippet": "" if hit == "title" else _snippet(hay[hit], q)}
            if kind == "entry":
                item["type"] = row["type"]
            if kind == "session":
                item["number"] = row["number"]
            if kind == "document":
                item["doc_kind"] = row["kind"]
            results.append(item)
        # The bestiary and the item library belong to every campaign: found by name, after the
        # campaign's own (the page opens them filtered to the name).
        like = f"%{q}%"
        for kind, table in (("monster", "custom_monsters"), ("item", "custom_items")):
            for row in conn.execute(f"SELECT id, name FROM {table} WHERE name LIKE ? ORDER BY name LIMIT 10", (like,)):
                results.append({"kind": kind, "id": row["id"], "title": row["name"], "in_title": True, "snippet": "",
                                "library": True})
    results.sort(key=lambda r: (not r["in_title"], bool(r.get("library"))))
    return results[:40]


# ---------- uploads ----------

@app.post("/api/uploads")
async def upload(filename: str, request: Request, document: bool = False):
    """A picture; with document=true also a PDF (Diverse Dokumente)."""
    ext = (filename or "").rsplit(".", 1)[-1]
    return {"url": _save_upload(await request.body(), ext, DOCUMENT_EXTS if document else IMAGE_EXTS)}


# ---------- handout display ----------

@app.post("/api/display")
async def show_on_display(body: DisplayIn):
    handout = {"entry_id": body.entry_id, "title": body.title, "image": body.image, "text": None}
    with get_conn() as conn:
        if body.entry_id is not None:
            row = conn.execute("SELECT * FROM entries WHERE id = ?", (body.entry_id,)).fetchone()
            if row is None:
                raise HTTPException(404, _t("Eintrag nicht gefunden."))
            handout["title"] = body.title or row["name"]
            handout["image"] = body.image or row["image"]
            if body.with_text:
                handout["text"] = row["body"]
        if not handout["image"] and not handout["text"]:
            raise HTTPException(400, _t("Nichts zum Anzeigen: kein Bild und kein Text."))
        set_setting(conn, "handout", handout)
    await live.notify()
    return handout


@app.delete("/api/display")
async def clear_display():
    with get_conn() as conn:
        set_setting(conn, "handout", None)
    await live.notify()
    return {"ok": True}


# Stream Deck webhooks (Einrichtung → Stream Deck): plain GET/POST, like the tracker's /api/remote/….
# The same as "📽 Auf Beamer zeigen" on the entry page, the entry then counts as known to the players.

@app.api_route("/api/remote/display/{entry_id}", methods=["GET", "POST"])
async def remote_display(entry_id: int, text: Optional[bool] = None, toggle: bool = False):
    """text: show the entry's text too (default: as set on the handout); toggle: hide it when it is
    shown already, so one button shows and hides."""
    with get_conn() as conn:
        row = conn.execute("SELECT type, name, image, fields FROM entries WHERE id = ?", (entry_id,)).fetchone()
        if row is None:
            raise HTTPException(404, _t("Eintrag nicht gefunden."))
        shown = get_settings(conn)["handout"]
    if toggle and shown and shown.get("entry_id") == entry_id:
        await clear_display()
        return {"ok": True, "shown": None}
    if text is None:
        text = row["type"] == "handout" and json.loads(row["fields"] or "{}").get("with_text", True)
    handout = await show_on_display(DisplayIn(entry_id=entry_id, with_text=text))
    if row["type"] != "pc":
        with get_conn() as conn:
            conn.execute("UPDATE entries SET known = 1 WHERE id = ? AND NOT known", (entry_id,))
    return {"ok": True, "shown": handout["title"]}


@app.api_route("/api/remote/display-clear", methods=["GET", "POST"])
async def remote_display_clear():
    await clear_display()
    return {"ok": True, "shown": None}


# ---------- tracker: encounters ----------

@app.get("/api/tracker/encounters")
async def tracker_encounters(campaign_id: int):
    encounters = await _tracker("GET", "/api/encounters", params={"campaign_id": campaign_id})
    shown = await _tracker("GET", "/api/display/encounter")
    return {"encounters": encounters, "display_encounter_id": shown.get("encounter_id")}


@app.put("/api/tracker/display")
async def tracker_display(body: EncounterDisplayIn):
    return await _tracker("PUT", "/api/display/encounter", {"encounter_id": body.encounter_id})


# ---------- content export (für die Charaktererstellung auf dem Server) ----------

@app.get("/api/library/export")
def export_content():
    """Classes/subclasses/peoples/backgrounds, items and spells as one JSON file, for the
    standalone Charaktererstellung, which has no live connection to this (LAN-only) tool."""
    with get_conn() as conn:
        char_opts = char_options.list_options(conn, lean=False)
        items = []
        for r in conn.execute("SELECT * FROM custom_items ORDER BY name").fetchall():
            d = row_to_dict(r)
            d["stat_block"] = json.loads(d["stat_block"]) if d.get("stat_block") else None
            d.pop("avatar_path", None)  # images aren't reachable from the other server
            items.append(d)
        spells = [row_to_dict(r) for r in conn.execute("SELECT * FROM custom_spells ORDER BY name").fetchall()]
        # German texts beside the English ones (desc_de, name_de …), as far as translated.
        mem = translate.Memory(conn)
        char_opts = [translate.attach_option(o, mem) for o in char_opts]
        items = [translate.attach_item(i, mem) for i in items]
        spells = [translate.attach_spell(s, mem) for s in spells]
    body = {"char_options": char_opts, "items": items, "spells": spells}
    filename = f"kampagnenbuch-inhalte-{datetime.now().strftime('%Y-%m-%d_%H%M%S')}.json"
    return JSONResponse(body, headers={"Content-Disposition": f'attachment; filename="{filename}"'})


@app.post("/api/characters/import")
async def import_characters(campaign_id: int, request: Request):
    """Finished characters exported from the Charaktererstellung, into one campaign here.
    The body is the export (a list), or {"characters": [...], "on_conflict": {"Name": "skip"|"replace"|"copy"}}.
    A name the campaign already has is skipped unless on_conflict says otherwise, so re-uploading the
    same export is safe. The starting gear comes along, and the library references are matched to this
    library (char_import.py)."""
    body = await request.json()
    on_conflict = None
    if isinstance(body, dict):
        on_conflict = body.get("on_conflict") if isinstance(body.get("on_conflict"), dict) else None
        body = body.get("characters")
    if not isinstance(body, list):
        raise HTTPException(400, _t("Erwartet wird die Liste der Charaktere aus der Charaktererstellung."))
    with get_conn() as conn:
        if conn.execute("SELECT 1 FROM campaigns WHERE id = ?", (campaign_id,)).fetchone() is None:
            raise HTTPException(404, _t("Kampagne nicht gefunden."))
        result = char_import.import_characters(
            conn, campaign_id, body, library.create_character_row, on_conflict,
            lambda conn, char_id, data, filename, trusted: library.set_character_avatar(
                conn, char_id, library.save_image(data, filename, allow_svg=trusted)))
        changed = [get_character(conn, i) for i in result.pop("replaced_ids")]
    # Combatants of a replaced sheet follow it.
    for char in changed:
        await tracker.sync_character(char)
    return result


# The DM's sheet is played like the players' (HP, spell slots, rests, inventory): the same code as
# /api/player/… on the public port, so both ways change the character alike.
app.add_api_route("/api/characters/{char_id}/hp", player_api.player_change_hp, methods=["POST"])
app.add_api_route("/api/characters/{char_id}/play-state", player_api.player_set_play_state, methods=["PUT"])
app.add_api_route("/api/characters/{char_id}/rest", player_api.player_rest, methods=["POST"])


# ---------- backup ----------

BACKUP_DB_NAME = "dmtool.db"
# One database for Kampagnenbuch, tracker and battlemap: their pictures go along.
BACKUP_FOLDERS = {"uploads": UPLOAD_DIR, "avatars": combat_db.AVATAR_DIR, "maps": map_db.MAP_DIR,
                  "tokens": map_db.TOKEN_DIR}


@app.get("/api/backup")
def download_backup():
    """Database plus uploaded images as one zip."""
    zip_path = backup.make_zip(DB_PATH, BACKUP_DB_NAME, BACKUP_FOLDERS)
    filename = f"kampagnenbuch-backup-{datetime.now().strftime('%Y-%m-%d_%H%M%S')}.zip"
    return FileResponse(zip_path, filename=filename, media_type="application/zip",
                        background=BackgroundTask(zip_path.unlink))


@app.post("/api/backup/restore")
async def restore_backup(request: Request):
    result = await backup.restore_zip(request, DB_PATH, BACKUP_DB_NAME, BACKUP_FOLDERS, "entries")
    # An older backup may lack columns added since, or (from before phase 2) the fights and maps:
    # those come from the old databases again, as on the first start.
    init_db()
    combat_db.init_db()
    map_db.init_db()
    result["merged"] = merge.run(list(map_db.DEFAULT_SETTINGS))
    await tracker.prune_roster()
    await live.notify()
    return result


# ---------- websocket ----------

@app.websocket("/ws")
async def dm_socket(ws: WebSocket):
    await ws.accept()
    live.dm_sockets.add(ws)
    with get_conn() as conn:
        await ws.send_text(json.dumps({"type": "display", "state": live.player_payload(conn)}))
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        live.dm_sockets.discard(ws)


setup_common(app)
app.mount("/", StaticFiles(directory=str(APP_DIR / "static"), html=True), name="static")
