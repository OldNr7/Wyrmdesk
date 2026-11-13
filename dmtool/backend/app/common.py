from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles

from . import tracker
from .db import UPLOAD_DIR
from . import i18n

APP_DIR = Path(__file__).parent


def setup_common(app: FastAPI) -> None:
    """Routes both the DM app and the handout display need: images and shared scripts."""

    @app.middleware("http")
    async def no_cache(request: Request, call_next):
        # Code updates should show up without a manual reload; uploads are immutable by name.
        response = await call_next(request)
        if not request.url.path.startswith("/uploads/"):
            response.headers["Cache-Control"] = "no-cache"
        return response

    @app.get("/tracker/avatars/{name}")
    async def tracker_avatar(name: str):
        # Player character portraits, served from the tracker.
        if "/" in name or ".." in name:
            raise HTTPException(400, "invalid name")
        result = await tracker.fetch_file(f"avatars/{name}")
        if result is None:
            raise HTTPException(404, "avatar not found")
        content, media_type = result
        return Response(content, media_type=media_type, headers={"Cache-Control": "max-age=300"})

    # The UI language (UI_LANG): its texts and i18n.js, loaded by every page first (see i18n.py).
    i18n.setup(app)

    app.mount("/uploads", StaticFiles(directory=str(UPLOAD_DIR)), name="uploads")
    app.mount("/shared", StaticFiles(directory=str(APP_DIR / "shared_static")), name="shared")
