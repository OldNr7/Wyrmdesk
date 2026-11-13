"""Kampagnenbuch, Combat Tracker and Battlemap in one process.

  port 8000  Spielleiter: Kampagnenbuch at /, Combat Tracker at /tracker/, Battlemap at /map/
  port 8001  Beamer and players: handouts at /, /spieler/, tracker display at /anzeige/tracker/,
             battlemap beamer at /beamer/
  8002-8005  the old addresses, for bookmarks and the Stream Deck webhooks until phase 3: the tracker
             (8420), its display (8421), the battlemap (8430) at their root as before; the old beamer
             port (8431) sends the browser to /beamer/ on 8001

Since phase 2 all parts use this database (merge.py moved the old ones in once); they still talk to
each other through their APIs, in-process (internal.py), and a change in a fight wakes the battlemap.
"""
import asyncio
import os

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles
from starlette.routing import Mount, Route

from . import backup, book_import, char_options, internal, library, merge, tracker
from .battlemap import db as map_db, kb as map_kb, live as map_live, tracker as map_tracker
from .battlemap.main import app as map_app
from .battlemap.public import app as map_public_app
from .combat import db as combat_db, kb as combat_kb
from .combat.main import app as combat_app
from .combat.public import app as combat_public_app
from .db import DB_PATH, get_conn, init_db
from .main import BACKUP_DB_NAME, BACKUP_FOLDERS, app as main_app
from .public import app as public_app

# Where the beamer finds the tracker strip and the handouts: the same origin as the beamer page now.
TRACKER_DISPLAY_PATH = "/anzeige/tracker"
OLD_BEAMER_TARGET_PORT = int(os.environ.get("PUBLIC_PORT", "8441"))


def _slash(prefix: str) -> Route:
    """/tracker -> /tracker/, so the pages' relative paths resolve inside their part."""
    async def redirect(request: Request):
        return RedirectResponse(f"{prefix}/" + (f"?{request.url.query}" if request.url.query else ""))
    return Route(prefix, redirect)


def _picture_mounts() -> list[Mount]:
    """Pictures the parts store with absolute paths: tracker portraits, battlemap maps and tokens."""
    return [Mount("/avatars", app=StaticFiles(directory=str(combat_db.AVATAR_DIR))),
            Mount("/maps", app=StaticFiles(directory=str(map_db.MAP_DIR))),
            Mount("/tokens", app=StaticFiles(directory=str(map_db.TOKEN_DIR))),
            Mount("/beamer-images", app=StaticFiles(directory=str(map_db.BEAMER_IMG_DIR)))]


def _mount_parts() -> None:
    """The parts in front of the Kampagnenbuch's own routes (its "/" static mount would take everything).
    The root mounts serve picture paths stored in the databases ("/avatars/…", "/kb/uploads/…")."""
    main_app.router.routes[0:0] = [
        _slash("/tracker"), Mount("/tracker", app=combat_app),
        _slash("/map"), Mount("/map", app=map_app),
        *_picture_mounts(),
        Mount("/kb", app=main_app),  # what the parts reached as "/kb/…" is the Kampagnenbuch itself
    ]
    public_app.router.routes[0:0] = [
        _slash(TRACKER_DISPLAY_PATH), Mount(TRACKER_DISPLAY_PATH, app=combat_public_app),
        _slash("/beamer"), Mount("/beamer", app=map_public_app),
        *_picture_mounts(),
        Mount("/kb", app=main_app),  # the tracker display proxied this to the Kampagnenbuch before
    ]


def _connect_parts() -> None:
    """Every link between the parts goes to the app in this process."""
    internal.register(internal.KB_URL, main_app)
    internal.register(internal.TRACKER_URL, combat_app)
    tracker.TRACKER_URL = internal.TRACKER_URL
    combat_kb.DMTOOL_URL = internal.KB_URL
    map_kb.DMTOOL_URL = internal.KB_URL
    map_tracker.TRACKER_URL = internal.TRACKER_URL
    map_tracker.state["configured"] = True
    map_tracker.TRACKER_DISPLAY_URL = TRACKER_DISPLAY_PATH
    map_tracker.state["display_url"] = TRACKER_DISPLAY_PATH
    map_live.HANDOUT_URL = "/?overlay=1"
    # A change in a fight (or a character's HP): the battlemap looks again now, not in 1.5 s.
    internal.on_change(map_tracker._wake.set)
    # Another campaign: the battlemap lists its scenes (DM views get the new list right away).
    internal.on_campaign(lambda: asyncio.get_running_loop().create_task(map_live.notify(scenes=True)))


def _old_beamer() -> FastAPI:
    """The old beamer port: the beamer page now lives on the public port, under /beamer/."""
    app = FastAPI(title="Battlemap Beamer (alte Adresse)")

    @app.api_route("/{path:path}", methods=["GET", "HEAD"])
    async def moved(path: str, request: Request):
        query = f"?{request.url.query}" if request.url.query else ""
        return RedirectResponse(f"{request.url.scheme}://{request.url.hostname}:{OLD_BEAMER_TARGET_PORT}/beamer/{path}{query}")
    return app


async def repair_library() -> None:
    """One-off fixes of imported library entries that need Open5e (see repair_columns)."""
    try:
        fixed = await char_options.repair_columns()
        if fixed:
            print(f"Bibliothek: {fixed} Tabellenspalten von Open5e ergänzt", flush=True)
    except Exception as e:  # no internet, Open5e down …: try again on the next start
        print(f"Bibliothek: Tabellenspalten nicht ergänzt ({e})", flush=True)
    try:
        sized = await library.fill_monster_sizes()
        if sized:
            print(f"Bestiarium: Grösse von {sized} Monstern von Open5e ergänzt", flush=True)
    except Exception as e:
        print(f"Bestiarium: Grössen nicht ergänzt ({e})", flush=True)


async def prune_tracker() -> None:
    """Combatants of characters deleted while the tracker was down."""
    await asyncio.sleep(2)
    await tracker.prune_roster()


async def main() -> None:
    init_db()
    combat_db.init_db()
    map_db.init_db()
    merged = merge.run(list(map_db.DEFAULT_SETTINGS))
    with get_conn() as conn:
        moved = book_import.restructure_imported_monsters(conn)
    if moved:
        print(f"Bestiarium: {moved} Monster aus D&D Beyond neu gegliedert", flush=True)
    if merged:
        print(f"Zusammenführung: {merged}", flush=True)
    _mount_parts()
    _connect_parts()
    repair = asyncio.create_task(repair_library())  # noqa: F841 - keeps the task referenced
    prune = asyncio.create_task(prune_tracker())  # noqa: F841
    apps = [(main_app, 8000), (public_app, 8001),
            (combat_app, 8002), (combat_public_app, 8003), (map_app, 8004), (_old_beamer(), 8005)]
    # One process for all apps, so the WebSocket registries (live.py of each part) are shared.
    servers = [uvicorn.Server(uvicorn.Config(a, host="0.0.0.0", port=p, log_level="info")) for a, p in apps]
    await asyncio.gather(
        *(s.serve() for s in servers),
        map_tracker.poll_forever(map_live.notify_tracker),
        backup.auto_backup_forever(DB_PATH, BACKUP_DB_NAME, BACKUP_FOLDERS, "dmtool"),
    )


if __name__ == "__main__":
    asyncio.run(main())
