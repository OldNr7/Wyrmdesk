from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles

from .. import i18n
from . import kb, tracker
from .db import BEAMER_IMG_DIR, MAP_DIR, TOKEN_DIR

APP_DIR = Path(__file__).parent


def setup_common(app: FastAPI) -> None:
    """Routes both the DM app and the player display need: images and the shared renderer."""

    @app.middleware("http")
    async def no_cache(request: Request, call_next):
        # Code updates should show up without a manual reload; map images are immutable by name.
        response = await call_next(request)
        if not request.url.path.startswith(("/maps/", "/tokens/", "/beamer-images/")):
            response.headers["Cache-Control"] = "no-cache"
        return response

    @app.get("/tracker/avatars/{name}")
    async def tracker_avatar(name: str):
        if "/" in name or ".." in name:
            raise HTTPException(400, "invalid name")
        result = await tracker.fetch_file(f"avatars/{name}")
        if result is None:
            raise HTTPException(404, "avatar not found")
        content, media_type = result
        return Response(content, media_type=media_type, headers={"Cache-Control": "max-age=300"})

    @app.get("/kb/uploads/{name}")
    async def kb_upload(name: str):
        # Portraits of characters and bestiary monsters, kept by the Kampagnenbuch.
        if "/" in name or ".." in name:
            raise HTTPException(400, "invalid name")
        result = await kb.fetch_file(f"uploads/{name}")
        if result is None:
            raise HTTPException(404, "picture not found")
        content, media_type = result
        # Uploads there never change under the same name.
        return Response(content, media_type=media_type, headers={"Cache-Control": "max-age=86400"})

    @app.get("/tracker/shared/{name}")
    async def tracker_shared(name: str):
        # The tracker's condition list and icons, so both tools show the same statuses.
        if "/" in name or ".." in name:
            raise HTTPException(400, "invalid name")
        result = await tracker.fetch_file(f"shared/{name}")
        if result is None:
            raise HTTPException(404, "file not found")
        content, media_type = result
        return Response(content, media_type=media_type)

    # The UI language (UI_LANG), see ../i18n.py.
    i18n.setup(app)

    # The Kampagnenbuch's shared scripts (navigation between the parts), same process.
    app.mount("/kb/shared", StaticFiles(directory=str(APP_DIR.parent / "shared_static")), name="kb-shared")
    app.mount("/maps", StaticFiles(directory=str(MAP_DIR)), name="maps")
    app.mount("/tokens", StaticFiles(directory=str(TOKEN_DIR)), name="tokens")
    app.mount("/beamer-images", StaticFiles(directory=str(BEAMER_IMG_DIR)), name="beamer-images")
    app.mount("/shared", StaticFiles(directory=str(APP_DIR / "shared_static")), name="shared")
