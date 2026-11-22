"""Share links: a player hands one character to their DM as a link instead of a file.

The link (/teilen/<share_token>) is a token of its own per character, apart from the collection's or
campaign's link, so whoever gets it can download that one character and nothing else, and can't change
anything. The DM pastes it into the Kampagnenbuch (Charaktere importieren), whose page fetches
/api/teilen/<share_token> directly from the browser: hence the CORS header, on this one read-only
route. The player can withdraw the link (player.py); it also goes with the character.
"""
import json

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse

from . import export
from .db import get_conn, row_to_dict
from .i18n import t

router = APIRouter(prefix="/api/teilen")

CORS = {"Access-Control-Allow-Origin": "*"}


def load(conn, share_token: str) -> dict:
    row = conn.execute("SELECT * FROM characters WHERE share_token = ?", (share_token,)).fetchone()
    if row is None or not share_token:
        raise HTTPException(404, t("Dieser Link ist ungültig oder abgelaufen."), headers=CORS)
    d = row_to_dict(row)
    d["stat_block"] = json.loads(d["stat_block"]) if d["stat_block"] else {}
    d["play_state"] = json.loads(d["play_state"]) if d["play_state"] else {}
    return d


@router.get("/{share_token}")
def shared_character(share_token: str, download: bool = False):
    """The character in the export's shape (a list of one), as the Kampagnenbuch imports it. Without
    internal ids and tokens: they mean nothing elsewhere."""
    with get_conn() as conn:
        ch = load(conn, share_token)
    out = export.export_character(ch)
    for key in ("id", "campaign_id", "exported_at"):
        out.pop(key, None)
    headers = dict(CORS)
    if download:
        headers["Content-Disposition"] = f'attachment; filename="{export.export_filename(ch["name"])}"'
    return JSONResponse([out], headers=headers)
