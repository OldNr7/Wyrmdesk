"""Open mode (OPEN_MODE=1): the Charaktererstellung for anyone, without a DM handing out links.

"Neuen Charakter erstellen" on the start page makes a collection of its own: a campaign row with
is_open = 1 whose token is the private link to come back with (bookmark). Everything else is the
campaign page as it is, minus what only makes sense for a group (session dates) and minus uploading
pictures (a public server is no image host; the class pictures stay). A collection nobody opened for
OPEN_DAYS days is deleted with its characters (cleanup, hourly).

Players hand a character to their DM by file (player.py) or by share link (share.py).

Settings (environment):
  OPEN_MODE              1: open mode on (default off: campaigns only, as before)
  OPEN_DAYS              days without use before a collection is deleted (30)
  OPEN_MAX_NEW_PER_HOUR  new collections per address and hour (10)
  OPEN_MAX_COLLECTIONS   collections at most, all together (5000)
  OPEN_MAX_CHARACTERS    characters per collection (5)
  IMPRINT_URL, PRIVACY_URL  shown at the foot of the page (the website's imprint and privacy policy)
"""
import asyncio
import os
import secrets
import sys
import time
from collections import defaultdict, deque

from fastapi import APIRouter, HTTPException, Request

from .db import UPLOAD_DIR, get_conn
from .i18n import t


def _int(name: str, default: int) -> int:
    try:
        return max(1, int(os.environ.get(name) or default))
    except ValueError:
        return default


OPEN_MODE = (os.environ.get("OPEN_MODE") or "").strip().lower() in ("1", "true", "yes", "on")
OPEN_DAYS = _int("OPEN_DAYS", 30)
OPEN_MAX_NEW_PER_HOUR = _int("OPEN_MAX_NEW_PER_HOUR", 10)
OPEN_MAX_COLLECTIONS = _int("OPEN_MAX_COLLECTIONS", 5000)
OPEN_MAX_CHARACTERS = _int("OPEN_MAX_CHARACTERS", 5)
IMPRINT_URL = os.environ.get("IMPRINT_URL", "").strip()
PRIVACY_URL = os.environ.get("PRIVACY_URL", "").strip()

router = APIRouter(prefix="/api/open")

_recent: dict[str, deque] = defaultdict(deque)


def client_ip(request: Request) -> str:
    """The visitor's address. Behind the reverse proxy (as on a server) every request comes from the
    proxy, which appends the real address to X-Forwarded-For; the last entry is the one it saw,
    anything before it the visitor could have sent themselves."""
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded.strip():
        return forwarded.split(",")[-1].strip()
    return request.client.host if request.client else "?"


def _rate_limited(ip: str) -> bool:
    now = time.monotonic()
    hits = _recent[ip]
    while hits and now - hits[0] > 3600:
        hits.popleft()
    if len(hits) >= OPEN_MAX_NEW_PER_HOUR:
        return True
    hits.append(now)
    if len(_recent) > 10000:  # forget addresses that went quiet
        for key in [k for k, v in _recent.items() if not v or now - v[-1] > 3600]:
            del _recent[key]
    return False


@router.get("")
def info():
    """Whether this instance is open, for the start page; asked by every page, also with open mode off."""
    return {"open": OPEN_MODE, "days": OPEN_DAYS, "max_characters": OPEN_MAX_CHARACTERS,
            "imprint_url": IMPRINT_URL or None, "privacy_url": PRIVACY_URL or None}


@router.post("/new")
def new_collection(request: Request):
    if not OPEN_MODE:
        raise HTTPException(404, "not found")
    if _rate_limited(client_ip(request)):
        raise HTTPException(429, t("Zu viele neue Sammlungen in kurzer Zeit. Bitte später nochmals versuchen."))
    with get_conn() as conn:
        n = conn.execute("SELECT COUNT(*) AS n FROM campaigns WHERE is_open = 1").fetchone()["n"]
        if n >= OPEN_MAX_COLLECTIONS:
            raise HTTPException(503, t("Im Moment können keine neuen Charaktere angelegt werden. Bitte später nochmals versuchen."))
        token = secrets.token_urlsafe(16)
        conn.execute("INSERT INTO campaigns (name, token, is_open, last_active) VALUES ('', ?, 1, datetime('now'))",
                     (token,))
    return {"token": token}


def touch(conn, campaign: dict) -> None:
    """An open collection counts as used whenever its page talks to the server (at most once an hour
    written, the expiry only counts days)."""
    if campaign.get("is_open"):
        conn.execute("UPDATE campaigns SET last_active = datetime('now') WHERE id = ? "
                     "AND (last_active IS NULL OR last_active < datetime('now', '-1 hour'))", (campaign["id"],))


def cleanup() -> int:
    """Deletes the open collections unused for OPEN_DAYS days, with their characters and pictures."""
    with get_conn() as conn:
        old = [r["id"] for r in conn.execute(
            "SELECT id FROM campaigns WHERE is_open = 1 AND COALESCE(last_active, created_at) < datetime('now', ?)",
            (f"-{OPEN_DAYS} days",))]
        if not old:
            return 0
        marks = ",".join("?" * len(old))
        for r in conn.execute(f"SELECT avatar_path FROM characters WHERE campaign_id IN ({marks}) "
                              "AND avatar_path IS NOT NULL", old):
            (UPLOAD_DIR / r["avatar_path"].rsplit("/", 1)[-1]).unlink(missing_ok=True)
        conn.execute(f"DELETE FROM campaigns WHERE id IN ({marks})", old)  # characters go along (cascade)
    return len(old)


def refresh_content() -> bool:
    """The website's content (content.py), when there is none yet or it came from there and is a day old.
    A pack uploaded by hand on the admin page stays. True when it was (re)loaded."""
    from . import admin, content  # admin imports player, which imports this module

    with get_conn() as conn:
        row = lambda key: conn.execute("SELECT value FROM app_settings WHERE key = ?", (key,)).fetchone()
        source, at = row("content_source"), row("content_uploaded_at")
        empty = conn.execute("SELECT COUNT(*) AS n FROM char_options").fetchone()["n"] == 0
        stale = conn.execute("SELECT ? < datetime('now', '-1 day')", (at["value"] if at else "",)).fetchone()[0]
    if not empty and not (source and source["value"].startswith("wyrmdesk:") and stale):
        return False
    pack, generated = content.fetch_pack()
    with get_conn() as conn:
        same = conn.execute("SELECT value FROM app_settings WHERE key = 'content_source'").fetchone()
    if not empty and same and same["value"] == f"wyrmdesk:{generated}":
        with get_conn() as conn:  # unchanged on the website: only note that it was checked
            conn.execute("UPDATE app_settings SET value = datetime('now') WHERE key = 'content_uploaded_at'")
        return False
    admin.store_content(pack, f"wyrmdesk:{generated}")
    return True


async def cleanup_loop() -> None:
    while True:
        try:
            if n := cleanup():
                print(f"Offener Modus: {n} unbenutzte Sammlung(en) gelöscht.", file=sys.stderr, flush=True)
        except Exception as e:  # never let the loop die
            print(f"Offener Modus: Aufräumen fehlgeschlagen ({e}).", file=sys.stderr, flush=True)
        try:
            if await asyncio.to_thread(refresh_content):
                print("Offener Modus: Inhalte von den Wyrmdesk-Inhalten geladen.", file=sys.stderr, flush=True)
        except Exception as e:
            print(f"Offener Modus: Inhalte nicht geladen ({e}).", file=sys.stderr, flush=True)
        await asyncio.sleep(3600)
