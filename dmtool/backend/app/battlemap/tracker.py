"""Link to the combat tracker (app/combat, same process and database).

Follows the encounter the tracker currently shows on its player display, so the
map knows whose turn it is, who is down and who is still hidden. It reads the
tracker's tables directly and looks again whenever a fight changes (internal.changed()
wakes it; POLL_SECONDS is only the fallback). Turn and combatant changes made here
go through the tracker's DM API, in-process.
"""
import asyncio
import os
from urllib.parse import urlsplit, urlunsplit

import httpx

from .. import internal

TRACKER_URL = os.environ.get("TRACKER_URL", "").rstrip("/")
# The tracker's player display, loaded by the beamer browser itself (not proxied).
TRACKER_DISPLAY_URL = os.environ.get("TRACKER_DISPLAY_URL", "").rstrip("/")
if not TRACKER_DISPLAY_URL and TRACKER_URL:
    # The tracker serves its display on the port after its DM port (8420 -> 8421).
    _url = urlsplit(TRACKER_URL)
    if _url.port:
        TRACKER_DISPLAY_URL = urlunsplit(_url._replace(netloc=f"{_url.hostname}:{_url.port + 1}"))
POLL_SECONDS = 5

state: dict = {"configured": bool(TRACKER_URL), "display_url": TRACKER_DISPLAY_URL, "ok": False, "encounter_id": None, "encounter": None,
               "round": None, "current_combatant_id": None, "combatants": []}


def combatant_status(combatant_id: int | None) -> dict:
    if combatant_id is None:
        return {}
    c = next((c for c in state["combatants"] if c["id"] == combatant_id), None)
    if c is None:
        return {}
    return {
        "current": c["id"] == state["current_combatant_id"],
        "dead": c["current_hp"] <= 0,
        "hidden": bool(c["is_hidden"]),
    }


def _avatar(path: str | None) -> str | None:
    if not path:
        return None
    return path.lstrip("/") if path.startswith("/kb/") else f"tracker{path}"


def _combat():
    from ..combat import display, main  # late: the tracker part is loaded next to this one
    return display, main


async def _fetch() -> dict:
    display, combat = _combat()
    with combat.get_conn() as conn:
        encounter_id = display.get_display_encounter_id(conn)
        enc = combat._encounter_detail(conn, encounter_id) if encounter_id is not None else None
    if enc is None:
        return {**state, "ok": True, "encounter_id": None, "encounter": None, "round": None,
                "current_combatant_id": None, "combatants": []}
    combatants = [
        {
            "id": c["id"], "name": c["name"], "kind": c["kind"], "current_hp": c["current_hp"],
            "max_hp": c["max_hp"], "temp_hp": c.get("temp_hp", 0), "ac": c.get("ac"),
            "initiative": c.get("initiative"), "initiative_bonus": c.get("initiative_bonus"),
            "status_effects": c.get("status_effects") or [],
            "is_hidden": c.get("is_hidden", 0), "is_boss": c.get("is_boss", 0),
            # Served through our own proxies (/kb for the Kampagnenbuch's portraits, /tracker for older ones
            # still kept by the tracker), so the player display needs no second origin.
            "avatar": _avatar(c.get("avatar_path")),
        }
        for c in enc["combatants"]
    ]
    return {**state, "ok": True, "encounter_id": encounter_id, "encounter": enc["name"], "round": enc["round"],
            "current_combatant_id": enc["current_combatant_id"], "combatants": combatants}


async def poll_forever(on_change) -> None:
    if not TRACKER_URL:
        return
    while True:
        try:
            new = await _fetch()
        except Exception:
            new = {**state, "ok": False}
        if new != state:
            state.clear()
            state.update(new)
            await on_change()
        # Any change in a fight wakes the loop (internal.changed(), and actions sent from here).
        try:
            await asyncio.wait_for(_wake.wait(), POLL_SECONDS)
        except asyncio.TimeoutError:
            pass
        _wake.clear()


_wake = asyncio.Event()


class TrackerError(Exception):
    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status = status
        self.detail = detail


async def call(method: str, path: str, body: dict | None = None) -> dict:
    """Send one request to the tracker's DM API and poll again straight after."""
    if not TRACKER_URL:
        raise TrackerError(409, "TRACKER_URL ist nicht gesetzt.")
    try:
        async with internal.client(timeout=5) as client:
            resp = await client.request(method, f"{TRACKER_URL}{path}", json=body)
    except httpx.HTTPError:
        raise TrackerError(502, "Der Combat Tracker antwortet nicht.")
    if resp.status_code >= 400:
        try:
            detail = resp.json().get("detail", resp.text)
        except ValueError:
            detail = resp.text
        raise TrackerError(resp.status_code, str(detail))
    _wake.set()
    return resp.json()


async def encounters(campaign_list: list[dict]) -> list[dict]:
    """Every encounter in the tracker, grouped by the given campaigns (from the Kampagnenbuch), newest first
    as the tracker lists them."""
    if not TRACKER_URL:
        raise TrackerError(409, "TRACKER_URL ist nicht gesetzt.")
    try:
        async with internal.client(timeout=5) as client:
            campaigns = []
            for camp in campaign_list:
                enc = await client.get(f"{TRACKER_URL}/api/encounters", params={"campaign_id": camp["id"]})
                enc.raise_for_status()
                campaigns.append({"id": camp["id"], "name": camp["name"],
                                  "encounters": [{"id": e["id"], "name": e["name"]} for e in enc.json()]})
    except httpx.HTTPError:
        raise TrackerError(502, "Der Combat Tracker antwortet nicht.")
    return campaigns


async def fetch_file(path: str) -> tuple[bytes, str] | None:
    if not TRACKER_URL:
        return None
    async with internal.client(timeout=5) as client:
        resp = await client.get(f"{TRACKER_URL}/{path}")
    if resp.status_code != 200:
        return None
    return resp.content, resp.headers.get("content-type", "application/octet-stream")
