"""The "Wyrmdesk-Inhalte": the SRD (5.1 and 5.2) as published on wyrmdesk.ch, with German texts.

The website holds static JSON files (made by tools/srd_export.py from the same Open5e import this app
uses): index.json, one file per category with entries already in the normalized form open5e.py and
char_options.py produce, and uebersetzungen-de.json, the German lines for the translation memory
(translate.py). So an import from here is the Open5e "SRD only" import plus German texts, without a
DeepL key and without depending on Open5e being up.

WYRMDESK_CONTENT_URL points elsewhere (a test site, a local copy).
"""
import os
import time

import httpx
from fastapi import HTTPException

from . import char_options, i18n
from .i18n import t as _t

CONTENT_URL = (os.environ.get("WYRMDESK_CONTENT_URL") or "https://www.wyrmdesk.ch/inhalte/srd/").rstrip("/") + "/"
FORMAT = 1
CACHE_SECONDS = 600
# Category of the library -> file(s) of the export. Items: the magic items plus the mundane SRD gear.
FILES = {
    "monsters": ["monsters"], "spells": ["spells"], "items": ["items", "equipment"],
    **{kind: [kind] for kind in char_options.KINDS},
}

_cache: dict[str, tuple[float, object]] = {}


async def _get(name: str):
    hit = _cache.get(name)
    if hit and time.monotonic() - hit[0] < CACHE_SECONDS:
        return hit[1]
    try:
        async with httpx.AsyncClient(timeout=60, follow_redirects=True) as client:
            resp = await client.get(CONTENT_URL + name)
            resp.raise_for_status()
            data = resp.json()
    except (httpx.HTTPError, ValueError):
        raise HTTPException(502, _t("Wyrmdesk-Inhalte nicht erreichbar ({url}).", url=CONTENT_URL))
    _cache[name] = (time.monotonic(), data)
    return data


async def index() -> dict:
    data = await _get("index.json")
    if data.get("format") != FORMAT:
        raise HTTPException(502, _t("Die Wyrmdesk-Inhalte haben ein neueres Format. Bitte Wyrmdesk aktualisieren."))
    return data


async def fetch_kind(kind: str) -> list[dict]:
    """Entries of a library category, normalized like the Open5e import. "Equipment" entries carry
    `equipment: True` (they are inserted like library.import_srd_equipment does)."""
    files = (await index())["files"]
    out: list[dict] = []
    for name in FILES[kind]:
        entries = await _get(files[name])
        if name == "equipment":
            entries = [{**e, "equipment": True} for e in entries]
        out += entries
    if kind in char_options.KINDS and i18n.lang() == "de":
        # Exported with English names; German ones for a German UI, as the Open5e import gives them.
        names = char_options.NAMES_DE[kind]
        out = [{**e, "name": names.get(e["name_en"], e["name_en"])} for e in out]
    return out


async def translations() -> tuple[list[tuple[str, str]], list[tuple[str, str]]]:
    """(English line, German line) pairs for the translation memory, and the fixed terms
    (translate.FIXED_TERMS of the export) that go in as corrections."""
    files = (await index())["files"]
    data = await _get(files["translations_de"])
    return ([(en, de) for en, de in data.get("lines", [])], [(en, de) for en, de in data.get("fixed", [])])


def import_note(entry: dict) -> str:
    """Like open5e.import_note, naming the website: the document name stays in it, which is how
    translate.py tells the official rules (System Reference Document) from supplements."""
    note = f"Importiert aus den Wyrmdesk-Inhalten ({entry.get('source_name') or 'SRD'})"
    if entry.get("is_2024"):
        note += " – 2024-Regeln (SRD 5.2)"
    return note
