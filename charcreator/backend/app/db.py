import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path

DB_PATH = Path(os.environ.get("DB_PATH", "/data/charcreator.db"))
SCHEMA_PATH = Path(__file__).parent / "schema.sql"

UPLOAD_DIR = DB_PATH.parent / "uploads"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
IMAGE_EXTS = {"png", "jpg", "jpeg", "webp", "gif"}

# Columns added after the initial schema; CREATE TABLE IF NOT EXISTS doesn't add them to a
# table that already exists, so a running instance needs these applied by hand.
MIGRATIONS: dict[str, list[tuple[str, str]]] = {
    "characters": [("avatar_path", "TEXT"), ("share_token", "TEXT")],
    "campaigns": [("password_hash", "TEXT"), ("is_open", "INTEGER NOT NULL DEFAULT 0"), ("last_active", "TEXT")],
    # German texts from the Kampagnenbuch's translation (content pack fields *_de).
    "char_options": [("desc_de", "TEXT")],
    "items": [("desc_de", "TEXT")],
    "spells": [("desc_de", "TEXT"), ("higher_level_de", "TEXT"), ("material_de", "TEXT")],
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
        # Indexes on migrated columns: only once the columns exist.
        conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_characters_share ON characters(share_token)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_campaigns_open ON campaigns(is_open, last_active)")


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
