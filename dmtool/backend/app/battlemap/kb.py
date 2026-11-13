"""Link to the Kampagnenbuch, which keeps campaigns, characters, bestiary, items and spells.

The battlemap reads the campaign list and the spell library from there, and serves the portraits it keeps
(combatants carry them as /kb/uploads/...) through its own /kb route (see common.py).
"""
import os

import httpx

from .. import internal

from .tracker import TrackerError

DMTOOL_URL = os.environ.get("DMTOOL_URL", "").rstrip("/")


async def call(method: str, path: str, params: dict | None = None):
    if not DMTOOL_URL:
        raise TrackerError(409, "DMTOOL_URL ist nicht gesetzt.")
    try:
        async with internal.client(timeout=5) as client:
            resp = await client.request(method, f"{DMTOOL_URL}{path}", params=params)
    except httpx.HTTPError:
        raise TrackerError(502, "Das Kampagnenbuch antwortet nicht.")
    if resp.status_code >= 400:
        raise TrackerError(resp.status_code, resp.text)
    return resp.json()


async def fetch_file(path: str) -> tuple[bytes, str] | None:
    if not DMTOOL_URL:
        return None
    try:
        async with internal.client(timeout=5) as client:
            resp = await client.get(f"{DMTOOL_URL}/{path}")
    except httpx.HTTPError:
        return None
    if resp.status_code != 200:
        return None
    return resp.content, resp.headers.get("content-type", "application/octet-stream")
