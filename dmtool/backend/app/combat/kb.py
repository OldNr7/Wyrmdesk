"""Link to the Kampagnenbuch, which keeps campaigns, player characters, bestiary, items and spells.

Same process and database: characters are read directly (combatant_view); this module
is left for the bestiary and Open5e lookups and the /kb/… picture proxy, through internal.py.
"""
import os

import httpx

from .. import internal
from fastapi import HTTPException, Request
from fastapi.responses import Response

DMTOOL_URL = os.environ.get("DMTOOL_URL", "").rstrip("/")

# Prefix under which the browser reaches the Kampagnenbuch through this app (see proxy()).
PREFIX = "/kb"


def browser_path(path: str | None) -> str | None:
    """A Kampagnenbuch picture path ("/uploads/x.png") as this app serves it."""
    return f"{PREFIX}{path}" if path and path.startswith("/uploads/") else path


async def call(method: str, path: str, body: dict | None = None, params: dict | None = None):
    if not DMTOOL_URL:
        raise HTTPException(409, "DMTOOL_URL ist nicht gesetzt.")
    try:
        async with internal.client(timeout=10) as client:
            resp = await client.request(method, f"{DMTOOL_URL}{path}", json=body, params=params)
    except httpx.HTTPError:
        raise HTTPException(502, "Das Kampagnenbuch antwortet nicht.")
    if resp.status_code >= 400:
        try:
            detail = resp.json().get("detail", resp.text)
        except ValueError:
            detail = resp.text
        raise HTTPException(resp.status_code, str(detail))
    return resp.json()


HOP_HEADERS = {"connection", "content-encoding", "content-length", "transfer-encoding", "keep-alive"}


async def proxy(path: str, request: Request) -> Response:
    """Forwards /kb/<path> to the Kampagnenbuch, so this app's pages reach its API, scripts and pictures
    without a second origin."""
    if not DMTOOL_URL:
        raise HTTPException(409, "DMTOOL_URL ist nicht gesetzt.")
    try:
        async with internal.client(timeout=120) as client:
            resp = await client.request(
                request.method, f"{DMTOOL_URL}/{path}", params=request.query_params, content=await request.body(),
                headers={k: v for k, v in request.headers.items() if k.lower() == "content-type"},
            )
    except httpx.HTTPError:
        raise HTTPException(502, "Das Kampagnenbuch antwortet nicht.")
    headers = {k: v for k, v in resp.headers.items() if k.lower() not in HOP_HEADERS}
    return Response(resp.content, status_code=resp.status_code, headers=headers)
