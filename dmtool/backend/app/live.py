"""Pushing the handout display state over WebSocket.

Both FastAPI apps (DM and handout display) run in the same process and event
loop (see run.py), so one in-memory registry of sockets serves both.
"""
import json

from fastapi import WebSocket

from .db import get_conn, get_settings

dm_sockets: set[WebSocket] = set()
player_sockets: set[WebSocket] = set()


def player_payload(conn) -> dict:
    settings = get_settings(conn)
    return {"rotation": settings["rotation"], "handout": settings["handout"]}


async def _send_all(sockets: set[WebSocket], message: dict) -> None:
    text = json.dumps(message)
    for ws in list(sockets):
        try:
            await ws.send_text(text)
        except Exception:
            sockets.discard(ws)


async def notify() -> None:
    """Refresh the handout display and tell open DM views what it shows."""
    with get_conn() as conn:
        payload = player_payload(conn)
    await _send_all(player_sockets, {"type": "state", "state": payload})
    await _send_all(dm_sockets, {"type": "display", "state": payload})
