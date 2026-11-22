"""Where the native app keeps its data, and the env vars that point the unmodified backend (dmtool/
backend/app) there instead of the Docker image's /data. Kept free of any GUI/uvicorn/app import so it
stays trivially testable without a display or a running server.

Must run before anything from `app` is imported: app/db.py reads DB_PATH at import time and creates
a directory from it right away.
"""
import os
from pathlib import Path

import platformdirs


def data_dir() -> Path:
    return Path(platformdirs.user_data_dir("Wyrmdesk", appauthor=False))


def configure_env(dir: Path) -> None:
    dir.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("DB_PATH", str(dir / "dmtool.db"))
    os.environ.setdefault("BACKUP_DIR", str(dir / "backups"))
    # Old pre-merge locations (Combat Tracker/Battlemap before they moved into the Kampagnenbuch):
    # nothing exists there on a fresh native install, so merge.py's one-time migration is a no-op.
    os.environ.setdefault("COMBAT_DB_PATH", str(dir / "combat" / "combattracker.db"))
    os.environ.setdefault("MAP_DB_PATH", str(dir / "battlemap" / "battlemap.db"))
    # The ports the pages link to (8440 Spielleiter, 8441 Beamer/Spieler, as published by compose.yaml),
    # listened on directly. The Spielleiter part has no password, so only this computer reaches it;
    # Beamer and Spieler stay reachable on the LAN. The old addresses (8420 …) don't exist here.
    os.environ.setdefault("GM_HOST", "127.0.0.1")
    os.environ.setdefault("GM_PORT", str(GM_PORT))
    os.environ.setdefault("PUBLIC_LISTEN_PORT", str(PUBLIC_PORT))
    os.environ.setdefault("OLD_PORTS", "0")


GM_PORT = 8440
PUBLIC_PORT = 8441
