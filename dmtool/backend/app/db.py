import json
import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path

from .i18n import t as _t

DB_PATH = Path(os.environ.get("DB_PATH", "/data/dmtool.db"))
SCHEMA_PATH = Path(__file__).parent / "schema.sql"

UPLOAD_DIR = DB_PATH.parent / "uploads"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
IMAGE_EXTS = {"png", "jpg", "jpeg", "webp", "gif"}
# Files of the Diverse Dokumente: pictures and PDFs.
DOCUMENT_EXTS = IMAGE_EXTS | {"pdf"}

# Values are stored JSON-encoded in app_settings.
DEFAULT_SETTINGS = {
    "campaign_id": None,
    # "rich" (formatting toolbar) or "markdown" (plain text); texts are stored as Markdown either way.
    "editor": "rich",
    # Rotation of the handout display in degrees, so handouts face the players at the table.
    "rotation": 0,
    # What the handout display shows: {"entry_id", "title", "image", "text"} or None.
    "handout": None,
}

# Columns added after the initial release, added on startup if missing.
MIGRATIONS: dict[str, list[tuple[str, str]]] = {
    # The chapter of a D&D Beyond adventure the session was made from (book_import.py).
    "sessions": [("ddb_ref", "TEXT"),
                 # The English original of a prep translated with DeepL (content_translate.py).
                 ("prep_en", "TEXT")],
    "custom_monsters": [("stat_block_en", "TEXT")],
}


def init_db() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with get_conn() as conn:
        conn.executescript(SCHEMA_PATH.read_text())
        for table, columns in MIGRATIONS.items():
            existing = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}
            for name, decl in columns:
                if name not in existing:
                    conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {decl}")
        # Once: every campaign gets the Kapitel "Kapitel 0: Einleitung" (which takes a book's
        # introduction) new campaigns start with. A flag rather than a check for the entry, so one the
        # DM deleted stays deleted.
        if conn.execute("SELECT 1 FROM app_settings WHERE key = 'intro_chapters'").fetchone() is None:
            for row in conn.execute("SELECT id FROM campaigns").fetchall():
                add_intro_chapter(conn, row["id"])
            conn.execute("INSERT INTO app_settings (key, value) VALUES ('intro_chapters', 'true')")


# fields of the intro chapter: marked as such (the import button), and a chapter of its own in the
# Kapitel list (app.js groups by ddb_ref and puts "intro" first). Its name is in the UI language of
# the request that creates it; it is found by fields.intro, not by the name.
def intro_chapter_name() -> str:
    return _t("Kapitel 0: Einleitung")


def add_intro_chapter(conn, campaign_id: int) -> None:
    """The Kapitel entry "Kapitel 0: Einleitung", unless the campaign has its intro chapter already."""
    for row in conn.execute("SELECT fields FROM entries WHERE campaign_id = ? AND type = 'location'", (campaign_id,)):
        if json.loads(row["fields"] or "{}").get("intro"):
            return
    name = intro_chapter_name()
    fields = {"intro": True, "ddb_ref": "intro", "ddb_chapter": name, "ddb_order": 0}
    conn.execute("INSERT INTO entries (campaign_id, type, name, fields) VALUES (?, 'location', ?, ?)",
                 (campaign_id, name, json.dumps(fields)))


@contextmanager
def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def row_to_dict(row: sqlite3.Row) -> dict:
    return dict(row) if row is not None else None


def get_settings(conn) -> dict:
    settings = dict(DEFAULT_SETTINGS)
    for row in conn.execute("SELECT key, value FROM app_settings"):
        if row["key"] in settings and row["value"] is not None:
            settings[row["key"]] = json.loads(row["value"])
    return settings


def set_setting(conn, key: str, value) -> None:
    conn.execute(
        "INSERT INTO app_settings (key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, json.dumps(value)),
    )
