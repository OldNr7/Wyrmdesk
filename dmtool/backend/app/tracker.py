"""Link to the combat tracker (app/combat), in this process and on this database.

The Kampagnenbuch reads encounters through the tracker's DM API (in-process, internal.py) and
tells it when characters or monsters change.
"""
import os

import httpx

from . import internal

from .db import get_conn

TRACKER_URL = os.environ.get("TRACKER_URL", "").rstrip("/")


class TrackerError(Exception):
    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status = status
        self.detail = detail


async def call(method: str, path: str, body: dict | None = None, params: dict | None = None):
    if not TRACKER_URL:
        raise TrackerError(409, "TRACKER_URL ist nicht gesetzt.")
    try:
        async with internal.client(timeout=5) as client:
            resp = await client.request(method, f"{TRACKER_URL}{path}", json=body, params=params)
    except httpx.HTTPError:
        raise TrackerError(502, "Der Combat Tracker antwortet nicht.")
    if resp.status_code >= 400:
        try:
            detail = resp.json().get("detail", resp.text)
        except ValueError:
            detail = resp.text
        raise TrackerError(resp.status_code, str(detail))
    return resp.json()


async def fetch_file(path: str) -> tuple[bytes, str] | None:
    if not TRACKER_URL:
        return None
    try:
        async with internal.client(timeout=10) as client:
            resp = await client.get(f"{TRACKER_URL}/{path.lstrip('/')}")
    except httpx.HTTPError:
        return None
    if resp.status_code != 200:
        return None
    return resp.content, resp.headers.get("content-type", "application/octet-stream")


async def push(path: str, body: dict) -> bool:
    """Best effort: tell the tracker about a change. A tracker that is down catches up when the
    combatant is added again or the next change comes; the Kampagnenbuch keeps working either way."""
    if not TRACKER_URL:
        return False
    try:
        async with internal.client(timeout=3) as client:
            resp = await client.post(f"{TRACKER_URL}{path}", json=body)
        return resp.status_code < 400
    except httpx.HTTPError:
        return False


# Encounters and combatants are tables of this database now. A player
# character in a fight is the character itself, so a changed character needs no copying: the tracker
# only learns to load again, the battlemap and the beamer to look again.

def _combat():
    from .combat import main as combat  # late: the tracker part imports from this package
    return combat


async def sync_character(char: dict) -> None:
    with get_conn() as conn:
        _combat().characters_changed(conn)
    internal.changed()


def unlink_character(conn, char_id: int) -> None:
    """Before a character is deleted: its combatants stay, as manual entries with its last values."""
    _combat().unlink_character(conn, char_id)


async def prune_roster() -> int:
    """Combatants of characters that are gone (after a restore, or deleted before this existed)."""
    with get_conn() as conn:
        n = _combat().unlink_missing(conn)
    internal.changed()
    return n


async def sync_monster(monster: dict) -> None:
    """Combatants made from this bestiary monster take its new picture."""
    with get_conn() as conn:
        _combat().monster_picture(conn, monster["id"], monster.get("avatar_path"))
    internal.changed()
