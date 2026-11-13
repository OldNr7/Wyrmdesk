"""One-time move of the Combat Tracker's and the Battlemap's own databases into this one.

Runs on start until it has run once (marker "merge.done" in app_settings). Before it copies anything it
saves this database as before-merge.db. The old files (combattracker.db, battlemap.db and their picture
folders, in their old volumes) are only read, never changed, so the old services could still be started
on them.

Copied with their ids, so every reference stays right: sessions.encounter_ids, tokens.combatant_id,
the turn in encounters.current_combatant_id. The tracker's copies of campaigns, characters and the
library and its old sessions are not taken over; they moved to the Kampagnenbuch long ago.
"""
import json
import os
import shutil
import sqlite3
from datetime import datetime
from pathlib import Path

from .db import DB_PATH

OLD_COMBAT_DB = Path(os.environ.get("COMBAT_DB_PATH", "/data/combat/combattracker.db"))
OLD_MAP_DB = Path(os.environ.get("MAP_DB_PATH", "/data/battlemap/battlemap.db"))
MARKER = "merge.done"

TRACKER_SETTINGS = ("display_encounter_id", "remote_rev", "remote_show_stats", "roster_rev")


def _columns(conn, schema: str, table: str) -> list[str]:
    return [r[1] for r in conn.execute(f"PRAGMA {schema}.table_info({table})")]


def _copy_table(conn, schema: str, table: str) -> int | str:
    """All rows with the columns both sides have. A table that has rows already was copied before (a
    start that stopped halfway) and is left as it is."""
    if not _columns(conn, schema, table):
        return 0
    if conn.execute(f"SELECT 1 FROM main.{table} LIMIT 1").fetchone():
        return "schon vorhanden"
    cols = [c for c in _columns(conn, schema, table) if c in set(_columns(conn, "main", table))]
    names = ", ".join(cols)
    return conn.execute(f"INSERT INTO main.{table} ({names}) SELECT {names} FROM {schema}.{table}").rowcount


def _copy_settings(conn, schema: str, prefix: str, keys) -> int:
    n = 0
    for key in keys:
        row = conn.execute(f"SELECT value FROM {schema}.app_settings WHERE key = ?", (key,)).fetchone()
        if row is not None:
            conn.execute("INSERT INTO main.app_settings (key, value) VALUES (?, ?) "
                         "ON CONFLICT(key) DO UPDATE SET value = excluded.value", (prefix + key, row[0]))
            n += 1
    return n


def _copy_folder(src: Path, dst: Path) -> int:
    if not src.is_dir() or src.resolve() == dst.resolve():
        return 0
    dst.mkdir(parents=True, exist_ok=True)
    n = 0
    for f in src.iterdir():
        if f.is_file() and not (dst / f.name).exists():
            shutil.copy2(f, dst / f.name)
            n += 1
    return n


def run(map_settings) -> dict | None:
    """Moves the old databases in once; returns what it did, None if there was nothing to do."""
    conn = sqlite3.connect(DB_PATH, isolation_level=None)  # ATTACH/DETACH outside of transactions
    try:
        if conn.execute("SELECT 1 FROM app_settings WHERE key = ?", (MARKER,)).fetchone():
            return None
        report: dict = {"at": datetime.now().isoformat(timespec="seconds")}
        if OLD_COMBAT_DB.exists() or OLD_MAP_DB.exists():
            backup = sqlite3.connect(DB_PATH.parent / "before-merge.db")
            conn.backup(backup)
            backup.close()
        if OLD_COMBAT_DB.exists():
            conn.execute("ATTACH DATABASE ? AS old_combat", (str(OLD_COMBAT_DB),))
            conn.execute("BEGIN")
            report["encounters"] = _copy_table(conn, "old_combat", "encounters")
            report["combatants"] = _copy_table(conn, "old_combat", "combatants")
            report["tracker_settings"] = _copy_settings(conn, "old_combat", "tracker.", TRACKER_SETTINGS)
            conn.execute("COMMIT")
            conn.execute("DETACH DATABASE old_combat")
            report["avatars"] = _copy_folder(OLD_COMBAT_DB.parent / "avatars", DB_PATH.parent / "avatars")
        if OLD_MAP_DB.exists():
            conn.execute("ATTACH DATABASE ? AS old_map", (str(OLD_MAP_DB),))
            conn.execute("BEGIN")
            report["scenes"] = _copy_table(conn, "old_map", "scenes")
            report["tokens"] = _copy_table(conn, "old_map", "tokens")
            report["map_settings"] = _copy_settings(conn, "old_map", "map.", map_settings)
            conn.execute("COMMIT")
            conn.execute("DETACH DATABASE old_map")
            report["maps"] = _copy_folder(OLD_MAP_DB.parent / "maps", DB_PATH.parent / "maps")
            report["tokens_pictures"] = _copy_folder(OLD_MAP_DB.parent / "tokens", DB_PATH.parent / "tokens")
        if not (OLD_COMBAT_DB.exists() or OLD_MAP_DB.exists()):
            # Nothing to take over (a new installation, or the old volumes not mounted yet): no marker, so
            # the move still happens once they are there.
            return None
        conn.execute("INSERT INTO app_settings (key, value) VALUES (?, ?)", (MARKER, json.dumps(report)))
        return report
    except Exception:
        if conn.in_transaction:
            conn.execute("ROLLBACK")
        raise
    finally:
        conn.close()
