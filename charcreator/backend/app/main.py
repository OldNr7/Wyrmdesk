import asyncio
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import admin, i18n, open_mode, player, share
from .db import UPLOAD_DIR, init_db

APP_DIR = Path(__file__).parent


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    cleanup = asyncio.create_task(open_mode.cleanup_loop()) if open_mode.OPEN_MODE else None
    yield
    if cleanup:
        cleanup.cancel()


# Publicly reachable: no API documentation (/docs, /redoc, /openapi.json), it would map every route
# for an attacker. Nothing in Wyrmdesk uses it.
app = FastAPI(title="Wyrmdesk – Charaktererstellung", lifespan=lifespan,
              docs_url=None, redoc_url=None, openapi_url=None)


# Publicly reachable, so the usual browser protections. Everything comes from this server (no inline
# scripts, no other hosts); styles set inline by the pages need 'unsafe-inline'. No referrer: the
# address holds the campaign's or collection's link, which a click on a link elsewhere (imprint,
# privacy policy, game-icons.net) would otherwise hand to that site. HTTPS and HSTS: the reverse proxy.
SECURITY_HEADERS = {
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
                               "img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; "
                               "frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
}


@app.middleware("http")
async def no_cache(request: Request, call_next):
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-cache"
    for key, value in SECURITY_HEADERS.items():
        response.headers.setdefault(key, value)
    return response


app.include_router(admin.router)
app.include_router(player.router)
app.include_router(open_mode.router)
app.include_router(share.router)


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


# A share link (share.py): the same page shell, which shows the download for the DM.
@app.get("/teilen/{share_token}", include_in_schema=False)
def share_page(share_token: str):
    return FileResponse(APP_DIR / "player_static" / "index.html")


app.mount("/uploads", StaticFiles(directory=str(UPLOAD_DIR)), name="uploads")
app.mount("/admin", StaticFiles(directory=str(APP_DIR / "admin_static"), html=True), name="admin")
# charsheet.js/.css etc., copied from the Kampagnenbuch's shared_static (see its comment there).
app.mount("/shared", StaticFiles(directory=str(APP_DIR / "shared_static")), name="shared")
# Scripts/styles shared by the admin and player pages only (not synced with the Kampagnenbuch).
app.mount("/common", StaticFiles(directory=str(APP_DIR / "common_static")), name="common")
# Root: scripts/styles for the player page above, plus a neutral landing page for "/" itself.
app.mount("/", StaticFiles(directory=str(APP_DIR / "player_static"), html=True), name="player")
