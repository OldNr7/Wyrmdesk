"""Exports the SRD (5.1 and 5.2) as the "Wyrmdesk-Inhalte" for the website, with German texts.

    python tools/srd_export.py --out ../wyrmdesk-webseite/inhalte/srd             # export
    python tools/srd_export.py --out … --dry-run                                  # only count
    python tools/srd_export.py --out … --memory ~/.local/share/Wyrmdesk/dmtool.db  # reuse translations
    DEEPL_API_KEY=… python tools/srd_export.py --out … --max-chars 400000          # translate the rest

Run it with the Kampagnenbuch's Python environment (e.g. dmtool/desktop/.venv): it uses the app's own
Open5e import (open5e.py, char_options.py), so the entries are exactly what the "SRD only" bulk import
fetches, in the same normalized form the library inserts (library.py, wyrmdesk_content.py).

German: every text the Kampagnenbuch would translate is split into lines like translate.py does. A
line's German comes from, in this order, the export's own translation file (uebersetzungen-de.json in
--out, from earlier runs), a Kampagnenbuch database given with --memory (read only; only lines that
occur in the SRD are taken, nothing else of it leaves), and DeepL for the rest (up to --max-chars per
run, so the free plan's 500 000 characters a month are not overrun; run again next month).
The translation file is written after every DeepL batch, so a stop (quota) loses nothing.

Also written: charaktererstellung.json, the content pack for the Charaktererstellung's open mode (classes,
peoples, backgrounds, feats, items and spells with their German texts, in the shape the Kampagnenbuch's
"Charakterinhalte exportieren" gives). It is made by importing the entries into a fresh, temporary
Kampagnenbuch database with the app's own code (library.insert_wyrmdesk, main.content_pack), so the
public Charaktererstellung only ever holds the SRD, never anything else of a library.

Nothing is written to any Kampagnenbuch database of yours.
"""
import argparse
import asyncio
import datetime
import json
import os
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "dmtool" / "backend"))
# The temporary database the content pack is built in (deleted and made anew every run).
os.environ["DB_PATH"] = str(Path(os.environ.get("TMPDIR", "/tmp")) / "srd-export" / "dmtool.db")

import httpx  # noqa: E402

from app import char_options, content_translate, i18n, open5e, translate  # noqa: E402

FORMAT = 1
OPTION_KINDS = ("classes", "subclasses", "races", "backgrounds", "feats")
TRANSLATIONS_FILE = "uebersetzungen-de.json"
CONTENT_PACK_FILE = "charaktererstellung.json"
ATTRIBUTION = {
    "de": "Enthält Material aus dem System Reference Document 5.1 und 5.2 von Wizards of the Coast LLC, "
          "lizenziert unter CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). Abgerufen über Open5e. "
          "Deutsche Texte: eigene Übersetzung (maschinell mit DeepL, teils von Hand).",
    "en": "Includes material from the System Reference Document 5.1 and 5.2 by Wizards of the Coast LLC, "
          "licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). Retrieved via Open5e. "
          "German texts: own translation (machine translated with DeepL, partly by hand).",
}


# ---------- entries ----------

async def fetch_entries() -> dict[str, list[dict]]:
    """English entries (UI language en: SRD options keep their English names; the Kampagnenbuch gives
    them German ones on import, like its own Open5e import does)."""
    i18n._current.set("en")
    out: dict[str, list[dict]] = {}
    for kind in ("monsters", "spells", "items"):
        print(f"  {kind} …", flush=True)
        out[kind] = await open5e.fetch_all(kind, srd_only=True)
    print("  equipment …", flush=True)
    out["equipment"] = await open5e.get_srd_equipment()
    for kind in OPTION_KINDS:
        print(f"  {kind} …", flush=True)
        out[kind] = await char_options.fetch_kind(kind, srd_only=True)
    for entries in out.values():
        entries.sort(key=lambda e: ((e.get("name") or "").lower(), e.get("slug") or ""))
    return out


def texts_of(kind: str, entry: dict) -> list[str]:
    """The texts the Kampagnenbuch translates for an entry of this kind (translate.py,
    content_translate.py)."""
    if kind == "monsters":
        return content_translate._monster_texts(entry.get("stat_block") or {})
    if kind == "spells":
        return translate._spell_texts(entry)
    if kind in ("items", "equipment"):
        return translate._item_texts(entry)
    return translate._option_texts(entry)


def lines_needed(entries: dict[str, list[dict]]) -> list[str]:
    seen: dict[str, None] = {}
    for kind, items in entries.items():
        for e in items:
            for text in texts_of(kind, e):
                for piece in translate.split_text(text)[1]:
                    seen.setdefault(piece)
    return list(seen)


# ---------- translations ----------

def load_own(out: Path) -> dict[str, str]:
    path = out / TRANSLATIONS_FILE
    if not path.exists():
        return {}
    return {en: de for en, de in json.loads(path.read_text(encoding="utf-8"))["lines"]}


def load_memory(db: Path, wanted: set[str]) -> dict[str, str]:
    """Lines of the SRD already translated in a Kampagnenbuch database (opened read only)."""
    by_hash = {translate._hash(s): s for s in wanted}
    conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    try:
        rows = conn.execute("SELECT source_hash, text_de FROM translations WHERE manual = 0").fetchall()
    finally:
        conn.close()
    return {by_hash[h]: de for h, de in rows if h in by_hash}


def save_translations(out: Path, lines: dict[str, str], needed: list[str]) -> None:
    pairs = [[en, lines[en]] for en in needed if en in lines]
    # Fixed terms that occur in the SRD, also as corrections: they replace older translations
    # in a Kampagnenbuch's memory too (translate.store_lines).
    fixed = [[en, de] for en, de in translate.FIXED_TERMS.items() if en in set(needed)]
    data = {"format": FORMAT, "lang": "de", "lines": pairs, "fixed": fixed}
    (out / TRANSLATIONS_FILE).write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


async def deepl(todo: list[str], lines: dict[str, str], out: Path, needed: list[str]) -> tuple[int, bool]:
    """Translates the lines with the Kampagnenbuch's DeepL code (glossary, markup), saving after each
    batch. Returns (characters translated, quota used up)."""
    key = (os.environ.get("DEEPL_API_KEY") or "").strip()
    if not key:
        print("  DEEPL_API_KEY fehlt: keine Übersetzung.")
        return 0, False
    i18n._current.set("de")  # translate._api_key() only answers for a German UI
    done_chars = 0
    async with httpx.AsyncClient(timeout=60) as client:
        glossary = await _glossary(client)
        batches, batch, size = [], [], 0
        for p in todo:
            if batch and (len(batch) >= translate.BATCH_TEXTS or size + len(p) > translate.BATCH_CHARS):
                batches.append(batch)
                batch, size = [], 0
            batch.append(p)
            size += len(p)
        if batch:
            batches.append(batch)
        try:
            for n, b in enumerate(batches, 1):
                done, refused = await translate._translate_lines(client, b, glossary)
                for en, de in done:
                    lines[en] = de
                done_chars += sum(len(en) for en, _ in done)
                if refused:
                    print(f"  {len(refused)} Zeilen von DeepL abgelehnt (bleiben englisch).")
                save_translations(out, lines, needed)
                print(f"  DeepL: Paket {n}/{len(batches)}, {done_chars} Zeichen", flush=True)
        except translate.QuotaExceeded:
            return done_chars, True
        finally:
            if glossary:
                try:
                    await client.delete(f"{translate._api_url()}/v2/glossaries/{glossary}", headers=translate._headers())
                except httpx.HTTPError:
                    pass
    return done_chars, False


async def _glossary(client: httpx.AsyncClient) -> str | None:
    """A glossary for this run only (deleted afterwards), with the Kampagnenbuch's rule terms."""
    try:
        resp = await client.post(
            f"{translate._api_url()}/v2/glossaries", headers=translate._headers(),
            json={"name": "Wyrmdesk SRD-Export", "source_lang": "en", "target_lang": "de",
                  "entries": translate._glossary_tsv(), "entries_format": "tsv"})
        translate._raise_for(resp)
        return resp.json().get("glossary_id")
    except Exception as e:  # without a glossary DeepL still translates
        print(f"  Glossar nicht angelegt ({e}), übersetze ohne.")
        return None


# ---------- output ----------

def coverage(entries: dict[str, list[dict]], lines: dict[str, str]) -> dict[str, dict]:
    """Per kind: entries, and how many of them are completely available in German."""
    out = {}
    for kind, items in entries.items():
        full = sum(1 for e in items
                   if all(p in lines for t in texts_of(kind, e) for p in translate.split_text(t)[1]))
        out[kind] = {"entries": len(items), "german": full}
    return out


def content_pack(entries: dict[str, list[dict]], lines: dict[str, str], needed: list[str]) -> dict:
    """The Charaktererstellung's content pack, built in a fresh temporary Kampagnenbuch database."""
    from app import db, library, main as dm_main  # main: only here, it sets up the whole app

    path = Path(os.environ["DB_PATH"])
    path.parent.mkdir(parents=True, exist_ok=True)
    path.unlink(missing_ok=True)
    db.init_db()
    i18n._current.set("de")  # German names of the SRD options, as a German Kampagnenbuch imports them
    pairs = [(en, lines[en]) for en in needed if en in lines]
    fixed = [(en, de) for en, de in translate.FIXED_TERMS.items() if en in set(needed)]
    with db.get_conn() as conn:
        library.insert_wyrmdesk(conn, "spells", entries["spells"], pairs, fixed)
        library.insert_wyrmdesk(conn, "items", entries["items"] + [{**e, "equipment": True} for e in entries["equipment"]],
                                (), ())
        for kind in OPTION_KINDS:
            names = char_options.NAMES_DE[kind]
            library.insert_wyrmdesk(conn, kind, [{**e, "name": names.get(e["name_en"], e["name_en"])} for e in entries[kind]],
                                    (), ())
        pack = dm_main.content_pack(conn)
    path.unlink(missing_ok=True)
    return pack


def write(out: Path, entries: dict[str, list[dict]], lines: dict[str, str], needed: list[str]) -> None:
    out.mkdir(parents=True, exist_ok=True)
    for kind, items in entries.items():
        (out / f"{kind}.json").write_text(json.dumps(items, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    save_translations(out, lines, needed)
    pack = content_pack(entries, lines, needed)
    (out / CONTENT_PACK_FILE).write_text(json.dumps(pack, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    cov = coverage(entries, lines)
    index = {
        "format": FORMAT,
        "name": "SRD 5.1 + 5.2",
        "generated": datetime.date.today().isoformat(),
        "license": "CC BY 4.0",
        "attribution": ATTRIBUTION,
        "files": {**{kind: f"{kind}.json" for kind in entries}, "translations_de": TRANSLATIONS_FILE,
                  "content_pack": CONTENT_PACK_FILE},
        "counts": cov,
        "lines": {"total": len(needed), "german": sum(1 for p in needed if p in lines)},
    }
    (out / "index.json").write_text(json.dumps(index, ensure_ascii=False, indent=1), encoding="utf-8")


async def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--out", required=True, type=Path, help="Zielordner (z. B. ../wyrmdesk-webseite/inhalte/srd)")
    ap.add_argument("--memory", type=Path, help="Datenbank eines Kampagnenbuchs mit Übersetzungen (nur lesend)")
    ap.add_argument("--max-chars", type=int, default=0, help="höchstens so viele Zeichen über DeepL (0 = keine)")
    ap.add_argument("--dry-run", action="store_true", help="nur zählen, nichts schreiben")
    args = ap.parse_args()

    print("Hole Einträge von Open5e (SRD 5.1 + 5.2) …")
    entries = await fetch_entries()
    needed = lines_needed(entries)
    lines = load_own(args.out)
    own = len(lines)
    if args.memory:
        for en, de in load_memory(args.memory, set(needed) - set(lines)).items():
            lines.setdefault(en, de)
    lines.update({en: de for en, de in translate.FIXED_TERMS.items() if en in set(needed)})
    missing = [p for p in needed if p not in lines]
    print(f"Einträge: " + ", ".join(f"{k} {len(v)}" for k, v in entries.items()))
    print(f"Zeilen: {len(needed)}, davon übersetzt {len(needed) - len(missing)} "
          f"({own} aus früheren Läufen, {len(lines) - own} aus --memory), "
          f"fehlen {len(missing)} mit {sum(len(p) for p in missing)} Zeichen")
    if args.dry_run:
        return

    if args.max_chars and missing:
        todo, used = [], 0
        for p in missing:
            if used + len(p) > args.max_chars:
                break
            todo.append(p)
            used += len(p)
        args.out.mkdir(parents=True, exist_ok=True)
        chars, quota = await deepl(todo, lines, args.out, needed)
        print(f"DeepL: {chars} Zeichen übersetzt" + (" – Monatskontingent erschöpft" if quota else ""))

    write(args.out, entries, lines, needed)
    left = [p for p in needed if p not in lines]
    print(f"Geschrieben nach {args.out}. Noch ohne Deutsch: {len(left)} Zeilen, {sum(len(p) for p in left)} Zeichen.")


if __name__ == "__main__":
    asyncio.run(main())
