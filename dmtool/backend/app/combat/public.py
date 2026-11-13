from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles

from .. import i18n
from . import kb
from .db import AVATAR_DIR, get_conn
from .display import display_payload

app = FastAPI(title="Combattracker Display")

# Port the Kampagnenbuch's player app is published on, see compose.yaml.
PLAYER_SHEET_PORT = 8441


@app.middleware("http")
async def no_cache(request: Request, call_next):
    # Display screens run unattended; force revalidation so code updates show up without a manual reload.
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-cache"
    return response


@app.get("/api/display/state")
def get_display_state():
    with get_conn() as conn:
        return display_payload(conn)


@app.get("/kb/uploads/{name}", include_in_schema=False)
async def kb_picture(name: str, request: Request):
    # Portraits of characters and bestiary monsters, kept by the Kampagnenbuch.
    return await kb.proxy(f"uploads/{name}", request)


@app.get("/spieler", include_in_schema=False)
@app.get("/spieler/", include_in_schema=False)
def player_page_redirect(request: Request):
    # The player sheets moved to the Kampagnenbuch; old bookmarks land there.
    return RedirectResponse(f"{request.url.scheme}://{request.url.hostname}:{PLAYER_SHEET_PORT}/spieler/")


# The UI language (UI_LANG), see ../i18n.py.
i18n.setup(app)

app.mount("/avatars", StaticFiles(directory=str(AVATAR_DIR)), name="avatars")
app.mount("/shared", StaticFiles(directory=str(Path(__file__).parent / "shared_static")), name="shared")
app.mount(
    "/",
    StaticFiles(directory=str(Path(__file__).parent / "display_static"), html=True),
    name="static",
)
