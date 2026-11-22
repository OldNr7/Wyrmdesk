"""The content (classes, peoples, backgrounds, feats, items, spells) from the Wyrmdesk-Inhalte on the
website: the SRD with German texts, as a ready content pack (charaktererstellung.json, made by
tools/srd_export.py). For the open mode: only the SRD, nothing of anyone's own library. The admin page
loads it with one button; in open mode it is loaded on its own when there is none yet, and refreshed
once a day (open_mode.cleanup_loop).

WYRMDESK_CONTENT_URL  where it lives (default the website's /inhalte/srd/)
"""
import json
import os
import urllib.request

CONTENT_URL = (os.environ.get("WYRMDESK_CONTENT_URL") or "https://www.wyrmdesk.ch/inhalte/srd/").rstrip("/") + "/"
FORMAT = 1


def _get(name: str):
    req = urllib.request.Request(CONTENT_URL + name, headers={"User-Agent": "Wyrmdesk-Charaktererstellung"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.load(resp)


def fetch_pack() -> tuple[dict, str]:
    """(content pack, its date). Raises on anything wrong (network, format)."""
    index = _get("index.json")
    if index.get("format") != FORMAT or "content_pack" not in (index.get("files") or {}):
        raise ValueError("unbekanntes Format der Wyrmdesk-Inhalte")
    return _get(index["files"]["content_pack"]), str(index.get("generated") or "")
