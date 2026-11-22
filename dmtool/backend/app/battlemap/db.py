import json
import sqlite3
from contextlib import contextmanager
from pathlib import Path

# The Kampagnenbuch's database; merge.py copied the old battlemap.db over once.
# Settings live in the shared app_settings table under "map.<key>"; maps and tokens next to it.
from ..db import DB_PATH  # noqa: E402

SETTING_PREFIX = "map."
SCHEMA_PATH = Path(__file__).parent / "schema.sql"

MAP_DIR = DB_PATH.parent / "maps"
TOKEN_DIR = DB_PATH.parent / "tokens"
BEAMER_IMG_DIR = DB_PATH.parent / "beamer_images"
MAP_DIR.mkdir(parents=True, exist_ok=True)
TOKEN_DIR.mkdir(parents=True, exist_ok=True)
BEAMER_IMG_DIR.mkdir(parents=True, exist_ok=True)
IMAGE_EXTS = {"png", "jpg", "jpeg", "webp", "gif"}

# Table setup, shared by all scenes. Values are stored JSON-encoded in app_settings.
DEFAULT_SETTINGS = {
    "active_scene_id": None,
    # A beamer_images.id to show on the beamer instead of the battlemap; None shows the battlemap.
    "active_beamer_image_id": None,
    "blackout": False,
    "calibrate": False,
    # Beamer pixels per inch on the table; one grid cell is drawn this big.
    "ppi": 40.0,
    # Rotation of the player view in degrees, so the map faces the right side of the table.
    "rotation": 0,
    # Keystone correction: where the four screen corners (tl, tr, br, bl) should land,
    # as fractions of the screen. None means no correction.
    "keystone": None,
    # Screen size the player view last reported, so the DM can see the beamer frame.
    "player_screen": None,
    # The combat tracker's player display, embedded as a strip along the left beamer edge.
    "tracker_strip": True,
    "tracker_strip_px": 200,
    # Handouts shown in the Kampagnenbuch appear over the blurred map.
    "handout_overlay": True,
}


# Columns added after the initial release. CREATE TABLE IF NOT EXISTS won't
# retrofit these onto an existing database file, so they're added on startup.
MIGRATIONS = {
    "scenes": [
        ("walls", "TEXT NOT NULL DEFAULT '[]'"),
        ("vision_enabled", "INTEGER NOT NULL DEFAULT 0"),
        ("vision_polys", "TEXT NOT NULL DEFAULT '[]'"),
        ("templates", "TEXT NOT NULL DEFAULT '[]'"),
        ("fog_base", "TEXT"),
        ("campaign_id", "INTEGER"),
    ],
    "tokens": [
        ("vision", "INTEGER NOT NULL DEFAULT 0"),
    ],
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
        # Sight used to come from separate DM-only viewpoint tokens (vision = 1, no tracker link); now
        # player tokens see themselves, so those leftovers go, and their sight with them.
        scenes = [r["scene_id"] for r in conn.execute(
            "SELECT DISTINCT scene_id FROM tokens WHERE vision = 1 AND combatant_id IS NULL")]
        if scenes:
            conn.execute("DELETE FROM tokens WHERE vision = 1 AND combatant_id IS NULL")
            conn.executemany("UPDATE scenes SET vision_polys = '[]' WHERE id = ?", [(s,) for s in scenes])


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


def current_campaign(conn) -> int | None:
    """The campaign open in the Kampagnenbuch (its own setting, shared by all three parts)."""
    row = conn.execute("SELECT value FROM app_settings WHERE key = 'campaign_id'").fetchone()
    return json.loads(row["value"]) if row and row["value"] else None


def get_settings(conn) -> dict:
    settings = dict(DEFAULT_SETTINGS)
    for row in conn.execute("SELECT key, value FROM app_settings WHERE key LIKE ?", (SETTING_PREFIX + "%",)):
        key = row["key"][len(SETTING_PREFIX):]
        if key in settings and row["value"] is not None:
            settings[key] = json.loads(row["value"])
    return settings


def set_setting(conn, key: str, value) -> None:
    conn.execute(
        "INSERT INTO app_settings (key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (SETTING_PREFIX + key, json.dumps(value)),
    )
