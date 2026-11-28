"""Campaign templates as a file: one zip to pass on (the website's downloads, another computer) and to
bring in again as a template.

The zip holds
  kampagne.json   {"format": "wyrmdesk-kampagne", "format_version": 1, "wyrmdesk": "<version>",
                   "name": …, "note": …, "template": <a template's data, see templates.py>}
  dateien/<folder>/<name>   the pictures and documents it points at: uploads (entries, characters,
                   pictures in texts, documents), avatars and tokens (fights, battlemap) and maps
                   (scene images and fog masks)

Export goes through a campaign made from the template and read back (templates.instantiate, then
templates.snapshot, all rolled back): the same rules as "Neue Kampagne daraus…", so by default without
the player characters (and their players' names) and with the play reset.

Import checks the file before it touches anything (size, paths, file types, the data by making a
campaign from it, rolled back again), then stores the files under new names, points every address in
the data at them and adds a template; a campaign is started from it as from any other template.
"""
import json
import re
import shutil
import sqlite3
import tempfile
import unicodedata
import zipfile
from pathlib import Path
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

from . import templates
from .battlemap.db import MAP_DIR, TOKEN_DIR
from .char_import import CLASS_PORTRAITS
from .combat.db import AVATAR_DIR
from .db import DOCUMENT_EXTS, IMAGE_EXTS, UPLOAD_DIR, get_conn
from .i18n import t as _t
from .version import VERSION

router = APIRouter()

FORMAT = "wyrmdesk-kampagne"
FORMAT_VERSION = 1
DATA_NAME = "kampagne.json"
FILES = "dateien"
FOLDERS = {"uploads": UPLOAD_DIR, "avatars": AVATAR_DIR, "tokens": TOKEN_DIR, "maps": MAP_DIR}
# What may come in per folder. SVG only as one of the class placeholders this tool ships (an SVG from
# elsewhere could carry script, and /uploads is served from this origin).
ALLOWED = {"uploads": DOCUMENT_EXTS | {"svg"}, "avatars": IMAGE_EXTS, "tokens": IMAGE_EXTS, "maps": IMAGE_EXTS}

MAX_UPLOAD = 500 * 1024 * 1024       # the zip itself
MAX_UNPACKED = 1500 * 1024 * 1024    # everything in it together
MAX_DATA = 50 * 1024 * 1024          # kampagne.json
MAX_MEMBERS = 5000

# Addresses inside the data: "/uploads/x.png", also as "/kb/uploads/…", "/avatars/…", "/tracker/avatars/…",
# "/tokens/…". Only the part from the folder on is replaced, a prefix in front stays.
REF = re.compile(r"/(uploads|avatars|tokens)/([A-Za-z0-9][A-Za-z0-9._-]{0,120})")
SAFE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$")
LISTS = ("entries", "sessions", "events", "documents", "characters", "encounters", "scenes")


def _ext(name: str) -> str:
    return name.rsplit(".", 1)[-1].lower() if "." in name else ""


def _slug(text: str) -> str:
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:60] or "kampagne"


def _scene_files(data: dict) -> list[str]:
    return [s[k] for s in data.get("scenes", []) for k in ("map_file", "fog_base") if s.get(k)]


def _trial(conn, data: dict, with_characters: bool, reset: bool) -> dict:
    """The data as a campaign made from it would hold (instantiate, snapshot), then everything rolled
    back. Raises what instantiate raises on data it cannot use. The map copies snapshot makes stay
    (the caller packs and removes them), those instantiate made are removed here."""
    made: list[str] = []
    try:
        cid = templates.instantiate(conn, data, "export", with_characters, reset)
        made = [f for r in conn.execute("SELECT map_file, fog_base FROM scenes WHERE campaign_id = ?", (cid,))
                for f in (r["map_file"], r["fog_base"]) if f]
        return templates.snapshot(conn, cid)
    finally:
        conn.rollback()
        for f in made:
            (MAP_DIR / f).unlink(missing_ok=True)


# ---------- export ----------

@router.get("/api/templates/{template_id}/export")
def export_template(template_id: int, with_characters: bool = False, reset: bool = True):
    with get_conn() as conn:
        r = conn.execute("SELECT * FROM campaign_templates WHERE id = ?", (template_id,)).fetchone()
        if r is None:
            raise HTTPException(404, _t("Vorlage nicht gefunden"))
        clean = _trial(conn, json.loads(r["data"]), with_characters, reset)
    maps = _scene_files(clean)  # copies (tpl-…) made by snapshot, removed below
    try:
        clean["campaign"]["name"] = r["source_name"] or r["name"]
        text = json.dumps(clean, ensure_ascii=False)
        refs = sorted({(m.group(1), m.group(2)) for m in REF.finditer(text)})
        zip_path = Path(tempfile.gettempdir()) / f"kampagne-{uuid4().hex}.zip"
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
            z.writestr(DATA_NAME, json.dumps({
                "format": FORMAT, "format_version": FORMAT_VERSION, "wyrmdesk": VERSION,
                "name": r["name"], "note": r["note"], "template": clean,
            }, ensure_ascii=False, indent=1))
            for folder, name in refs:
                path = FOLDERS[folder] / name
                if path.is_file():
                    # Pictures are compressed already; storing them keeps big ones fast.
                    z.write(path, f"{FILES}/{folder}/{name}", compress_type=zipfile.ZIP_STORED)
            for name in maps:
                if (MAP_DIR / name).is_file():
                    z.write(MAP_DIR / name, f"{FILES}/maps/{name}", compress_type=zipfile.ZIP_STORED)
    finally:
        for name in maps:
            (MAP_DIR / name).unlink(missing_ok=True)
    return FileResponse(zip_path, filename=f"{_slug(r['name'])}.wyrmdesk.zip", media_type="application/zip",
                        background=BackgroundTask(zip_path.unlink))


# ---------- import ----------

def _bad(text: str) -> HTTPException:
    return HTTPException(400, text)


def _read_data(z: zipfile.ZipFile) -> dict:
    try:
        info = z.getinfo(DATA_NAME)
    except KeyError:
        raise _bad(_t("In der Datei fehlt {name}. Ist es eine Kampagne aus Wyrmdesk?", name=DATA_NAME))
    if info.file_size > MAX_DATA:
        raise _bad(_t("Die Kampagnendaten sind zu gross."))
    try:
        meta = json.loads(z.read(info).decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        raise _bad(_t("Die Kampagnendaten sind beschädigt."))
    if not isinstance(meta, dict) or meta.get("format") != FORMAT:
        raise _bad(_t("Das ist keine Kampagne aus Wyrmdesk."))
    if not isinstance(meta.get("format_version"), int) or meta["format_version"] > FORMAT_VERSION:
        raise _bad(_t("Die Kampagne stammt aus einer neueren Version von Wyrmdesk ({version}). Bitte zuerst Wyrmdesk aktualisieren.",
                      version=str(meta.get("wyrmdesk") or "?")))
    data = meta.get("template")
    if (not isinstance(data, dict) or not isinstance(data.get("campaign"), dict)
            or any(not isinstance(data.get(k, []), list) for k in LISTS)
            or any(not isinstance(row, dict) or not isinstance(row.get("id"), int) for k in LISTS for row in data.get(k, []))):
        raise _bad(_t("Die Kampagnendaten sind beschädigt."))
    if data.get("version", 0) > templates.VERSION:
        raise _bad(_t("Die Kampagne stammt aus einer neueren Version von Wyrmdesk ({version}). Bitte zuerst Wyrmdesk aktualisieren.",
                      version=str(meta.get("wyrmdesk") or "?")))
    for k in LISTS:
        data.setdefault(k, [])
    return meta


def _members(z: zipfile.ZipFile) -> list[tuple[zipfile.ZipInfo, str, str]]:
    """The files to take over as (info, folder, name); anything else in the zip is left alone."""
    infos = z.infolist()
    if len(infos) > MAX_MEMBERS:
        raise _bad(_t("Die Datei enthält zu viele Dateien."))
    if sum(i.file_size for i in infos) > MAX_UNPACKED:
        raise _bad(_t("Die Datei ist ausgepackt zu gross."))
    portraits = {p.read_bytes() for p in CLASS_PORTRAITS.glob("*.svg")}
    found = []
    for info in infos:
        parts = info.filename.split("/")
        if info.is_dir() or len(parts) != 3 or parts[0] != FILES:
            continue
        folder, name = parts[1], parts[2]
        if folder not in FOLDERS or not SAFE_NAME.match(name) or ".." in name:
            continue
        ext = _ext(name)
        if ext not in ALLOWED[folder]:
            continue
        if ext == "svg" and z.read(info) not in portraits:
            continue
        found.append((info, folder, name))
    return found


@router.post("/api/templates/import")
async def import_template(request: Request):
    tmp = Path(tempfile.mkdtemp(prefix="kampagne-"))
    written: list[Path] = []
    try:
        upload = tmp / "upload.zip"
        size = 0
        with upload.open("wb") as out:
            async for chunk in request.stream():
                size += len(chunk)
                if size > MAX_UPLOAD:
                    raise _bad(_t("Die Datei ist zu gross (höchstens {mb} MB).", mb=MAX_UPLOAD // (1024 * 1024)))
                out.write(chunk)
        try:
            z = zipfile.ZipFile(upload)
        except zipfile.BadZipFile:
            raise _bad(_t("Das ist keine ZIP-Datei."))
        with z:
            meta = _read_data(z)
            members = _members(z)
            # New names for every file; the data then points at them.
            new_names: dict[tuple[str, str], str] = {}
            for info, folder, name in members:
                prefix = "tpl-" if folder == "maps" else ""  # maps belong to the template (deleted with it)
                new = f"{prefix}{uuid4().hex}.{_ext(name)}"
                dest = FOLDERS[folder] / new
                dest.parent.mkdir(parents=True, exist_ok=True)
                with z.open(info) as src, dest.open("wb") as out:
                    shutil.copyfileobj(src, out)
                written.append(dest)
                new_names[(folder, name)] = new

        data = meta["template"]
        text = json.dumps(data, ensure_ascii=False)
        text = REF.sub(lambda m: f"/{m.group(1)}/{new_names.get((m.group(1), m.group(2)), m.group(2))}", text)
        data = json.loads(text)
        for s in data["scenes"]:
            for k in ("map_file", "fog_base"):
                if s.get(k):
                    s[k] = new_names.get(("maps", s[k]))  # a map not in the file: the scene stays without it

        name = str(meta.get("name") or data["campaign"].get("name") or _t("Kampagne")).strip()[:200]
        note = str(meta.get("note") or "").strip()[:2000]
        with get_conn() as conn:
            try:
                trial = _trial(conn, data, True, False)  # can a campaign be made from it at all?
            except (sqlite3.Error, KeyError, TypeError, ValueError, AttributeError):
                raise _bad(_t("Aus dieser Datei lässt sich keine Kampagne anlegen. Sie ist beschädigt oder passt nicht zu dieser Version."))
            for f in _scene_files(trial):
                (MAP_DIR / f).unlink(missing_ok=True)
            tid = conn.execute(
                "INSERT INTO campaign_templates (name, note, source_campaign_id, source_name, data) VALUES (?, ?, NULL, ?, ?)",
                (name, note, str(data["campaign"].get("name") or name)[:200], json.dumps(data, ensure_ascii=False))).lastrowid
            row = conn.execute("SELECT * FROM campaign_templates WHERE id = ?", (tid,)).fetchone()
        written.clear()  # kept: the template uses them now
        return templates._template(row)
    finally:
        for f in written:  # an import that failed leaves nothing behind
            f.unlink(missing_ok=True)
        shutil.rmtree(tmp, ignore_errors=True)
