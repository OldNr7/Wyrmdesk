from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import admin, i18n, player
from .db import UPLOAD_DIR, init_db

APP_DIR = Path(__file__).parent


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield


app = FastAPI(title="Wyrmdesk – Charaktererstellung", lifespan=lifespan)


@app.middleware("http")
async def no_cache(request: Request, call_next):
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-cache"
    return response


app.include_router(admin.router)
app.include_router(player.router)


# ---------- pages ----------
# /admin is one fixed page (DM only, password-protected API behind it).
# /k/<token> is the player page; the token is dynamic, so a static mount can't match it -
# these two routes hand out the same page shell, and its JS reads the token from the URL.

# The UI language (UI_LANG): its texts and i18n.js, loaded by every page first.
i18n.setup(app)


@app.get("/k/{token}", include_in_schema=False)
def player_page(token: str):
    return FileResponse(APP_DIR / "player_static" / "index.html")


@app.get("/k/{token}/", include_in_schema=False)
def player_page_slash(token: str):
    return FileResponse(APP_DIR / "player_static" / "index.html")


app.mount("/uploads", StaticFiles(directory=str(UPLOAD_DIR)), name="uploads")
app.mount("/admin", StaticFiles(directory=str(APP_DIR / "admin_static"), html=True), name="admin")
# charsheet.js/.css etc., copied from the Kampagnenbuch's shared_static (see its comment there).
app.mount("/shared", StaticFiles(directory=str(APP_DIR / "shared_static")), name="shared")
# Scripts/styles shared by the admin and player pages only (not synced with the Kampagnenbuch).
app.mount("/common", StaticFiles(directory=str(APP_DIR / "common_static")), name="common")
# Root: scripts/styles for the player page above, plus a neutral landing page for "/" itself.
app.mount("/", StaticFiles(directory=str(APP_DIR / "player_static"), html=True), name="player")
