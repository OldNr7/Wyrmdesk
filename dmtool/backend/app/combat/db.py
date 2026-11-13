"""The Combat Tracker's tables, in the Kampagnenbuch's database.

The tracker used to have a database of its own (combattracker.db, with copies of campaigns,
characters and the library); merge.py copied its encounters and combatants over once. Its settings
live in the shared app_settings table under "tracker.<key>".
"""
import sqlite3
from contextlib import contextmanager
from pathlib import Path

from ..db import DB_PATH

SCHEMA_PATH = Path(__file__).parent / "schema.sql"
SETTING_PREFIX = "tracker."

# Portraits of combatants that were uploaded to the tracker itself (older ones; new ones come from the
# Kampagnenbuch's uploads). Served at /avatars/.
AVATAR_DIR = DB_PATH.parent / "avatars"
AVATAR_DIR.mkdir(parents=True, exist_ok=True)

# Columns added after the initial release, for databases older than them.
MIGRATIONS = {
    "encounters": [
        ("campaign_id", "INTEGER"),
        ("current_combatant_id", "INTEGER"),
    ],
    "combatants": [
        ("initiative_bonus", "INTEGER NOT NULL DEFAULT 0"),
        ("avatar_path", "TEXT"),
        ("stat_block", "TEXT"),
        ("ref_id", "INTEGER"),
        ("creature_type", "TEXT"),
        ("is_boss", "INTEGER NOT NULL DEFAULT 0"),
        ("is_hidden", "INTEGER NOT NULL DEFAULT 0"),
        ("temp_hp", "INTEGER NOT NULL DEFAULT 0"),
    ],
}


def init_db() -> None:
    with get_conn() as conn:
        for table, columns in MIGRATIONS.items():
            if not conn.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (table,)).fetchone():
                continue
            existing = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}
            for name, decl in columns:
                if name not in existing:
                    conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {decl}")
        conn.executescript(SCHEMA_PATH.read_text())
        _backfill_current_combatant(conn)


def _backfill_current_combatant(conn) -> None:
    """Encounters advanced before current_combatant_id existed only know the turn's
    position; pin it to the combatant standing there now."""
    rows = conn.execute(
        "SELECT id, current_turn_index FROM encounters WHERE current_combatant_id IS NULL"
    ).fetchall()
    for enc in rows:
        current = conn.execute(
            "SELECT id FROM combatants WHERE encounter_id = ? "
            "ORDER BY (initiative IS NULL), initiative DESC, sort_order ASC LIMIT 1 OFFSET ?",
            (enc["id"], enc["current_turn_index"]),
        ).fetchone()
        if current is not None:
            conn.execute("UPDATE encounters SET current_combatant_id = ? WHERE id = ?", (current["id"], enc["id"]))


def get_setting(conn, key: str, default: str | None = None) -> str | None:
    row = conn.execute("SELECT value FROM app_settings WHERE key = ?", (SETTING_PREFIX + key,)).fetchone()
    return row["value"] if row is not None and row["value"] is not None else default


def set_setting(conn, key: str, value: str | None) -> None:
    conn.execute(
        "INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (SETTING_PREFIX + key, value),
    )


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
