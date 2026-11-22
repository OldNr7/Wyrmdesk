"""German translations of the library texts (classes, subclasses, peoples, backgrounds, spells,
items) through the DeepL API (the free plan: 500 000 characters a month).

Translated once and kept here, never on page views: the English originals stay untouched in their
tables, the German texts are added as extra fields (desc_de, name_de, ...) wherever entries are
handed out (attach_*), including the export for the Charaktererstellung.

The store is a translation memory of single lines (table cells, list items, paragraphs), keyed by
a hash of the English line: the same sentence in twenty subclasses costs characters once, and an
entry re-imported from Open5e finds its translation again. A text corrected by hand is kept as a
whole (manual = 1) and wins over the line-by-line translation; it's never overwritten.

Needs DEEPL_API_KEY (environment, e.g. in the .env). Keys of the free plan end in ":fx"
and go to api-free.deepl.com; DEEPL_API_URL overrides the address (tests).
"""
import hashlib
import html
import json
import os
import re
from datetime import datetime

from xml.etree import ElementTree

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .db import get_conn
from . import i18n
from .i18n import t as _t

router = APIRouter()

# Rule terms DeepL should always render the way the sheets (and the German rulebooks) say them.
GLOSSARY = {
    "saving throw": "Rettungswurf", "saving throws": "Rettungswürfe", "Saving Throws": "Rettungswürfe",
    "feat": "Talent", "feats": "Talente", "Feat": "Talent", "Feats": "Talente", "Origin feat": "Herkunftstalent",
    "Armor Class": "Rüstungsklasse", "hit points": "Trefferpunkte", "Hit Points": "Trefferpunkte",
    "hit point maximum": "Trefferpunktemaximum", "temporary hit points": "temporäre Trefferpunkte",
    "Hit Dice": "Trefferwürfel", "Hit Die": "Trefferwürfel", "hit die": "Trefferwürfel",
    "proficiency bonus": "Übungsbonus", "Proficiency Bonus": "Übungsbonus",
    "ability check": "Attributsprobe", "ability checks": "Attributsproben",
    "ability score": "Attributswert", "ability scores": "Attributswerte", "ability modifier": "Attributsmodifikator",
    "Ability Score Improvement": "Attributswerterhöhung",
    "Strength": "Stärke", "Dexterity": "Geschicklichkeit", "Constitution": "Konstitution",
    "Intelligence": "Intelligenz", "Wisdom": "Weisheit", "Charisma": "Charisma",
    "cantrip": "Zaubertrick", "cantrips": "Zaubertricks", "Cantrips": "Zaubertricks",
    "spell slot": "Zauberplatz", "spell slots": "Zauberplätze", "spell save DC": "Zauberrettungswurf-SG",
    "spell attack": "Zauberangriff", "spellcasting ability": "Zauberattribut", "spellcasting focus": "Zauberfokus",
    "Spellcasting": "Zauberwirken", "Pact Magic": "Paktmagie", "concentration": "Konzentration",
    "short rest": "kurze Rast", "long rest": "lange Rast", "Short Rest": "kurze Rast", "Long Rest": "lange Rast",
    "advantage": "Vorteil", "disadvantage": "Nachteil", "bonus action": "Bonusaktion", "Bonus Action": "Bonusaktion",
    "opportunity attack": "Gelegenheitsangriff", "difficult terrain": "schwieriges Gelände",
    "darkvision": "Dunkelsicht", "Darkvision": "Dunkelsicht", "critical hit": "kritischer Treffer",
    "Extra Attack": "Zusätzlicher Angriff", "Sneak Attack": "Hinterhältiger Angriff", "Rage": "Kampfrausch",
    "Unarmored Defense": "Ungerüstete Verteidigung", "Fighting Style": "Kampfstil", "Second Wind": "Durchatmen",
    "Action Surge": "Tatendrang", "Cunning Action": "Raffinierte Aktion", "Wild Shape": "Tiergestalt",
    "Channel Divinity": "Göttliche Macht fokussieren", "Lay on Hands": "Handauflegen",
    "Divine Smite": "Göttliches Niederstrecken", "Bardic Inspiration": "Bardische Inspiration",
    "Sorcery Points": "Zauberpunkte", "Metamagic": "Metamagie", "Eldritch Invocations": "Schauerliche Anrufungen",
    "Arcane Recovery": "Arkane Erholung", "Expertise": "Expertise",
    "acid damage": "Säureschaden", "bludgeoning damage": "Wuchtschaden", "cold damage": "Kälteschaden",
    "fire damage": "Feuerschaden", "force damage": "Energieschaden", "lightning damage": "Blitzschaden",
    "necrotic damage": "nekrotischen Schaden", "piercing damage": "Stichschaden", "poison damage": "Giftschaden",
    "psychic damage": "psychischen Schaden", "radiant damage": "gleißenden Schaden", "slashing damage": "Hiebschaden",
    "thunder damage": "Schallschaden",
    "blinded": "blind", "charmed": "bezaubert", "deafened": "taub", "frightened": "verängstigt",
    "grappled": "gepackt", "incapacitated": "kampfunfähig", "paralyzed": "gelähmt", "petrified": "versteinert",
    "poisoned": "vergiftet", "prone": "liegend", "restrained": "festgesetzt", "stunned": "betäubt",
    "unconscious": "bewusstlos", "exhaustion": "Erschöpfung",
}

# The SRD weapons by their German names. On its own a name is easily mistranslated ("Club" ->
# "Verein", "Mace" -> "Pfefferspray", "Sling" -> "Tragegurt"), so they are glossary terms as well.
WEAPONS_DE = {
    "Club": "Knüppel", "Dagger": "Dolch", "Greatclub": "Zweihandknüppel", "Handaxe": "Handbeil",
    "Javelin": "Wurfspeer", "Light Hammer": "Leichter Hammer", "Mace": "Streitkolben", "Quarterstaff": "Kampfstab",
    "Sickle": "Sichel", "Spear": "Speer", "Light Crossbow": "Leichte Armbrust", "Dart": "Wurfpfeil",
    "Shortbow": "Kurzbogen", "Sling": "Schleuder", "Battleaxe": "Streitaxt", "Flail": "Flegel", "Glaive": "Glefe",
    "Greataxe": "Zweihandaxt", "Greatsword": "Zweihandschwert", "Halberd": "Hellebarde", "Lance": "Lanze",
    "Longsword": "Langschwert", "Maul": "Zweihandhammer", "Morningstar": "Morgenstern", "Pike": "Pike",
    "Rapier": "Rapier", "Scimitar": "Krummsäbel", "Shortsword": "Kurzschwert", "Trident": "Dreizack",
    "War Pick": "Kriegspicke", "Warhammer": "Kriegshammer", "Whip": "Peitsche", "Blowgun": "Blasrohr",
    "Hand Crossbow": "Handarmbrust", "Heavy Crossbow": "Schwere Armbrust", "Longbow": "Langbogen",
}
GLOSSARY.update(WEAPONS_DE)

# Whole texts with a fixed German form, wherever they stand alone (a monster's attack, a table
# cell): the weapons, and natural attacks DeepL leaves English or gets wrong without context.
# The Wyrmdesk-Inhalte ship them as corrections (manual), so they also fix older translations.
FIXED_TERMS = {
    **WEAPONS_DE,
    "Slam": "Hieb", "Gore": "Aufspießen", "Sting": "Stachel", "Pseudopod": "Pseudopodium", "Rend": "Zerfleischen",
    "Hoof": "Huf", "Hooves": "Hufe", "Bite": "Biss", "Claw": "Klaue", "Claws": "Klauen", "Talons": "Krallen",
    "Tail": "Schwanz", "Tentacle": "Tentakel", "Tentacles": "Tentakel", "Fist": "Faust", "Ram": "Rammen",
    "Beak": "Schnabel", "Horns": "Hörner", "Tusk": "Hauer", "Wing Attack": "Flügelangriff",
    "Unarmed Strike": "Waffenloser Schlag", "Multiattack": "Mehrfachangriff",
}

BATCH_TEXTS = 50  # DeepL: at most 50 texts per request
BATCH_CHARS = 30_000  # and well under its 128 KiB per request


class QuotaExceeded(Exception):
    pass


class InputRejected(Exception):
    """DeepL refused the texts themselves (400), e.g. markup it couldn't parse."""


def _hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _manual_hash(text: str) -> str:
    """Corrections are keyed apart from the lines: a one-line text ("Rage") can be both."""
    return "m:" + _hash(text)


# ---------- splitting texts into lines worth translating ----------

_TABLE_RULE = re.compile(r"^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$")
_WORDS = re.compile(r"[A-Za-z]{2,}")


def _is_table_row(line: str) -> bool:
    return line.startswith("|") or (line.endswith("|") and line.count("|") >= 2)


def split_text(text: str) -> tuple[list, list[str]]:
    """The text as a skeleton (strings kept as they are, ints = index into the pieces) and the
    pieces to translate: whole lines, list items without their bullet, headings without "###",
    table cells one by one. Numbers, dice and rules lines ("|---|") stay out."""
    skeleton: list = []
    pieces: list[str] = []

    def piece(s: str):
        core = s.strip()
        # A line that is only [[links]] (the lists of a session) has nothing to translate.
        if not _WORDS.search(_WIKI.sub("", core)):
            skeleton.append(s)
            return
        lead = s[: len(s) - len(s.lstrip())]
        trail = s[len(s.rstrip()):]
        skeleton.append(lead)
        skeleton.append(len(pieces))
        pieces.append(core)
        skeleton.append(trail)

    lines = text.replace("\r", "").split("\n")
    for n, line in enumerate(lines):
        if n:
            skeleton.append("\n")
        stripped = line.strip()
        if not stripped or _TABLE_RULE.match(stripped):
            skeleton.append(line)
        elif _is_table_row(stripped):
            for i, cell in enumerate(line.split("|")):
                if i:
                    skeleton.append("|")
                piece(cell)
        else:
            # Block quotes (read-aloud boxes of the adventures) keep their ">" too.
            m = re.match(r"^(\s*(?:>\s*)*(?:#{1,6}\s*|[-*•]\s+|\d+\.\s+)?)(.*)$", line)
            skeleton.append(m.group(1))
            piece(m.group(2))
    return skeleton, pieces


def join_text(skeleton: list, translated: list[str]) -> str:
    return "".join(translated[p] if isinstance(p, int) else p for p in skeleton)


# Markdown emphasis and dice travel to DeepL as XML, so it keeps them where they belong:
# ***x*** -> <b><i>, **x** -> <b>, *x* -> <i>, 2d6 + 3 -> <x> (left untranslated).
_BOLD_ITALIC = re.compile(r"\*\*\*(.+?)\*\*\*")
_BOLD = re.compile(r"\*\*(.+?)\*\*")
_ITALIC = re.compile(r"(?<![\w*])[*_](\S(?:.*?\S)?)[*_](?![\w*])")
_DICE = re.compile(r"\b\d*d\d+(?:\s*[+−-]\s*\d+)?\b")
# [[Target|label]] / [[Target]] of the campaign texts: the target is an entry's name and stays as it
# is; a label is translated with the sentence around it.
_WIKI = re.compile(r"\[\[([^\]|]+)(?:\|([^\]]*))?\]\]")


def _wiki_to_xml(s: str) -> str:
    def one(m: re.Match) -> str:
        target, label = m.group(1), m.group(2)
        if label is None or label == target:
            return f"<x>{m.group(0)}</x>"
        return f'<w t="{html.escape(target, quote=True)}">{label}</w>'
    return _WIKI.sub(one, s)


def _wiki_from_xml(s: str) -> str:
    return re.sub(r'<w t="([^"]*)">(.*?)</w>', lambda m: f"[[{html.unescape(m.group(1))}|{m.group(2)}]]", s, flags=re.S)


def _well_formed(xml: str) -> bool:
    try:
        ElementTree.fromstring(f"<r>{xml}</r>")
        return True
    except ElementTree.ParseError:
        return False


def to_xml(s: str) -> str:
    """The line as XML for DeepL. Emphasis that doesn't nest cleanly (stray or overlapping
    asterisks) is sent as plain text instead, so one odd line can't make DeepL refuse a request."""
    plain = html.escape(s, quote=False)
    marked = _BOLD_ITALIC.sub(r"<b><i>\1</i></b>", plain)
    marked = _BOLD.sub(r"<b>\1</b>", marked)
    marked = _ITALIC.sub(r"<i>\1</i>", marked)
    if not _well_formed(marked):
        marked = plain
    return _wiki_to_xml(_DICE.sub(lambda m: f"<x>{m.group(0)}</x>", marked))


def from_xml(s: str) -> str:
    s = _wiki_from_xml(s)
    s = re.sub(r"</?x>", "", s)
    s = re.sub(r"<b>(.*?)</b>", r"**\1**", s, flags=re.S)
    s = re.sub(r"<i>(.*?)</i>", r"*\1*", s, flags=re.S)
    return html.unescape(s)


# ---------- which texts there are ----------

def _option_texts(o: dict) -> list[str]:
    d = o.get("data") or {}
    out = [o.get("desc"), d.get("profs") if isinstance(d.get("profs"), str) else None]
    for key in ("features", "traits", "benefits"):
        for f in d.get(key) or []:
            # Equipment stays English: the creation wizard reads its items from it.
            if f.get("type") == "equipment" or re.match(r"(?i)^equipment", f.get("name") or ""):
                continue
            out += [f.get("name"), None if _german_desc(f) else f.get("desc")]
    return [t for t in out if t and t.strip()]


def _german_desc(f: dict) -> bool:
    """Columns of the class table ("Stufe 1: +2 · Stufe 9: +3") are written in German already;
    "[Column data]" is the Open5e placeholder before they were read (see char_options)."""
    return bool(f.get("column")) or (f.get("desc") or "").strip() == "[Column data]"


def _spell_texts(s: dict) -> list[str]:
    return [t for t in (s.get("desc"), s.get("higher_level"), s.get("material")) if t and t.strip()]


def _item_texts(i: dict) -> list[str]:
    return [i["desc"]] if i.get("desc") and i["desc"].strip() else []


def _is_standard(o: dict) -> bool:
    return "system reference document" in (o.get("notes") or "").lower()


def collect(conn, scope: str = "all") -> list[tuple[str, str]]:
    """(group, text) of every text, most wanted first: the official rules (SRD), then spells and
    items, then everything from the supplements. scope "standard" stops before the supplements."""
    from .char_options import list_options  # here, to keep the import order of main.py simple

    options = list_options(conn)
    spells = [dict(r) for r in conn.execute("SELECT * FROM custom_spells ORDER BY level_int, name")]
    items = [dict(r) for r in conn.execute("SELECT * FROM custom_items ORDER BY name")]
    order = ["classes", "races", "backgrounds", "subclasses", "feats"]
    out: list[tuple[str, str]] = []
    for kind in order:
        out += [(kind, t) for o in options if o["kind"] == kind and _is_standard(o) for t in _option_texts(o)]
    out += [("spells", t) for s in spells for t in _spell_texts(s)]
    out += [("items", t) for i in items for t in _item_texts(i)]
    if scope == "all":
        for kind in order:
            out += [(kind, t) for o in options if o["kind"] == kind and not _is_standard(o) for t in _option_texts(o)]
    return out


# ---------- looking translations up ----------

class Memory:
    """All stored translations, read once per request."""

    def __init__(self, conn):
        self.lines: dict[str, str] = {}
        self.manual: dict[str, str] = {}
        for r in conn.execute("SELECT source_hash, text_de, manual FROM translations"):
            (self.manual if r["manual"] else self.lines)[r["source_hash"]] = r["text_de"]

    def text(self, source: str | None) -> str | None:
        """The German text, or None while any of its lines is still missing."""
        if not source or not source.strip():
            return None
        manual = self.manual.get(_manual_hash(source))
        if manual is not None:
            return manual
        skeleton, pieces = split_text(source)
        if not pieces:
            return None
        out = []
        for p in pieces:
            t = self.lines.get(_hash(p))
            if t is None:
                return None
            out.append(t)
        return join_text(skeleton, out)

    def missing(self, source: str) -> list[str]:
        if _manual_hash(source) in self.manual:
            return []
        return [p for p in split_text(source)[1] if _hash(p) not in self.lines]


def _set(target: dict, key: str, mem: Memory, source) -> None:
    t = mem.text(source) if isinstance(source, str) else None
    if t:
        target[f"{key}_de"] = t


def attach_option(o: dict, mem: Memory) -> dict:
    _set(o, "desc", mem, o.get("desc"))
    d = o.get("data") or {}
    _set(d, "profs", mem, d.get("profs"))
    for key in ("features", "traits", "benefits"):
        for f in d.get(key) or []:
            if f.get("type") == "equipment" or re.match(r"(?i)^equipment", f.get("name") or ""):
                continue
            _set(f, "name", mem, f.get("name"))
            if not _german_desc(f):
                _set(f, "desc", mem, f.get("desc"))
    return o


def attach_spell(s: dict, mem: Memory) -> dict:
    for key in ("desc", "higher_level", "material"):
        _set(s, key, mem, s.get(key))
    return s


def attach_item(i: dict, mem: Memory) -> dict:
    _set(i, "desc", mem, i.get("desc"))
    return i


# ---------- DeepL ----------

def _api_key() -> str | None:
    # The translation into German only makes sense with a German UI (i18n.lang()).
    if i18n.lang() != "de":
        return None
    return (os.environ.get("DEEPL_API_KEY") or "").strip() or None


def _api_url() -> str:
    url = os.environ.get("DEEPL_API_URL")
    if url:
        return url.rstrip("/")
    key = _api_key() or ""
    return "https://api-free.deepl.com" if key.endswith(":fx") else "https://api.deepl.com"


def _headers() -> dict:
    return {"Authorization": f"DeepL-Auth-Key {_api_key()}"}


def _raise_for(resp: httpx.Response) -> None:
    if resp.status_code == 456:
        raise QuotaExceeded()
    if resp.status_code == 400:
        raise InputRejected(resp.text[:300])
    if resp.status_code == 403:
        raise HTTPException(502, _t("DeepL lehnt den API-Schlüssel ab. DEEPL_API_KEY prüfen."))
    if resp.status_code >= 400:
        raise HTTPException(502, f"DeepL antwortet mit Fehler {resp.status_code}: {resp.text[:200]}")


async def _usage(client: httpx.AsyncClient) -> dict | None:
    resp = await client.get(f"{_api_url()}/v2/usage", headers=_headers())
    _raise_for(resp)
    d = resp.json()
    return {"count": d.get("character_count", 0), "limit": d.get("character_limit", 0)}


def _glossary_tsv() -> str:
    return "\n".join(f"{en}\t{de}" for en, de in GLOSSARY.items())


async def _glossary_id(client: httpx.AsyncClient, conn) -> str | None:
    """The glossary on DeepL, created once and again whenever GLOSSARY changes. Without one
    (DeepL refuses it) the translation simply goes on without. A glossary belongs to one DeepL
    account, so the key is part of the hash: a new key gets its own glossary."""
    tsv = _glossary_tsv()
    wanted = _hash(tsv + "\n" + (_api_key() or ""))
    row = conn.execute("SELECT value FROM app_settings WHERE key = 'deepl_glossary'").fetchone()
    stored = json.loads(row["value"]) if row and row["value"] else None
    if stored and stored.get("hash") == wanted:
        return stored["id"]
    try:
        resp = await client.post(
            f"{_api_url()}/v2/glossaries",
            headers=_headers(),
            json={"name": "Wyrmdesk Regelbegriffe", "source_lang": "en", "target_lang": "de",
                  "entries": tsv, "entries_format": "tsv"},
        )
        _raise_for(resp)
    except (HTTPException, InputRejected, httpx.HTTPError):
        return None
    gid = resp.json().get("glossary_id")
    if stored and stored.get("id"):
        try:
            await client.delete(f"{_api_url()}/v2/glossaries/{stored['id']}", headers=_headers())
        except httpx.HTTPError:
            pass
    conn.execute(
        "INSERT INTO app_settings (key, value) VALUES ('deepl_glossary', ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (json.dumps({"id": gid, "hash": wanted}),),
    )
    return gid


async def _translate_batch(client: httpx.AsyncClient, lines: list[str], glossary: str | None,
                           plain: bool = False) -> list[str]:
    """plain: the lines as they are, without the XML markup (last resort for a refused line)."""
    body = {
        "text": list(lines) if plain else [to_xml(s) for s in lines],
        "source_lang": "EN",
        "target_lang": "DE",
        "formality": "prefer_less",  # "du", like the rest of the sheets
        "preserve_formatting": True,
    }
    if not plain:
        body.update({"tag_handling": "xml", "ignore_tags": ["x"]})
    if glossary:
        body["glossary_id"] = glossary
    resp = await client.post(f"{_api_url()}/v2/translate", headers=_headers(), json=body, timeout=60)
    _raise_for(resp)
    texts = [t["text"] for t in resp.json()["translations"]]
    return texts if plain else [from_xml(t) for t in texts]


async def _translate_lines(client: httpx.AsyncClient, lines: list[str], glossary: str | None) -> tuple[list, list]:
    """(translated pairs, skipped lines) of one batch. If DeepL refuses the batch (400), each line
    is tried on its own, and a line refused again once more as plain text; only a line refused
    even then is skipped, so a single odd line never stops the rest."""
    try:
        return list(zip(lines, await _translate_batch(client, lines, glossary))), []
    except InputRejected:
        if len(lines) == 1:
            try:
                return list(zip(lines, await _translate_batch(client, lines, glossary, plain=True))), []
            except InputRejected:
                return [], list(lines)
    done: list = []
    skipped: list = []
    for line in lines:
        d, s = await _translate_lines(client, [line], glossary)
        done += d
        skipped += s
    return done, skipped


def store_lines(conn, pairs: list[tuple[str, str]], fixed: list[tuple[str, str]] = ()) -> int:
    """Adds ready translations (English line, German line) to the memory, e.g. those of the
    Wyrmdesk-Inhalte (wyrmdesk_content.py). Lines already there (DeepL or corrected) stay as they are.
    fixed: whole texts with a set German form (FIXED_TERMS), stored as corrections, so they win over
    an older line translation ("Club" -> "Verein"); a correction made here by hand stays."""
    now = datetime.now().isoformat(timespec="seconds")
    before = conn.total_changes
    sql = ("INSERT INTO translations (source_hash, source, text_de, manual, updated_at) VALUES (?, ?, ?, ?, ?) "
           "ON CONFLICT(source_hash) DO NOTHING")
    conn.executemany(sql, [(_hash(en), en, de, 0, now) for en, de in pairs if en and de])
    conn.executemany(sql, [(_manual_hash(en), en, de, 1, now) for en, de in fixed if en and de])
    return conn.total_changes - before


# ---------- API ----------

def _status(conn, mem: Memory | None = None) -> dict:
    mem = mem or Memory(conn)
    groups: dict[str, dict] = {}
    for scope in ("standard", "all"):
        seen: set[str] = set()
        total = done = chars = 0
        for group, text in collect(conn, scope):
            if scope == "all":
                g = groups.setdefault(group, {"texts": 0, "done": 0})
                g["texts"] += 1
                g["done"] += mem.text(text) is not None
            total += 1
            done += mem.text(text) is not None
            for p in mem.missing(text):
                if p not in seen:
                    seen.add(p)
                    chars += len(p)
        groups[f"_{scope}"] = {"texts": total, "done": done, "chars_missing": chars}
    return {
        "configured": bool(_api_key()),
        "standard": groups.pop("_standard"),
        "all": groups.pop("_all"),
        "groups": groups,
        "manual": len(mem.manual),
    }


@router.get("/api/translate/status")
async def translate_status(usage: bool = False):
    with get_conn() as conn:
        out = _status(conn)
    if usage and out["configured"]:
        async with httpx.AsyncClient(timeout=20) as client:
            try:
                out["usage"] = await _usage(client)
            except (HTTPException, httpx.HTTPError) as e:
                out["usage_error"] = getattr(e, "detail", None) or "DeepL nicht erreichbar."
    return out


@router.post("/api/translate/run")
async def translate_run(scope: str = "standard", max_chars: int = 20_000):
    """Translates the next missing lines, up to max_chars characters; the page calls this again
    and again until nothing is missing (or the month's characters are used up)."""
    if not _api_key():
        raise HTTPException(400, _t("Kein DeepL-Schlüssel: DEEPL_API_KEY in der Umgebung setzen."))
    if scope not in ("standard", "all"):
        raise HTTPException(400, "scope must be standard or all")
    with get_conn() as conn:
        mem = Memory(conn)
        todo: list[str] = []
        seen: set[str] = set()
        budget = max(1000, min(max_chars, 100_000))
        used = 0
        for _, text in collect(conn, scope):
            for p in mem.missing(text):
                if p in seen:
                    continue
                if used + len(p) > budget and todo:
                    break
                seen.add(p)
                todo.append(p)
                used += len(p)
            if used >= budget:
                break

    translated, skipped, quota = await translate_and_store(todo)
    with get_conn() as conn:
        status = _status(conn)
    status["translated_lines"] = len(translated)
    status["translated_chars"] = sum(len(s) for s, _ in translated)
    status["quota_exceeded"] = quota
    # Lines DeepL refused in every form: they stay English, the page says how many.
    status["skipped_lines"] = len(skipped)
    return status


async def translate_and_store(todo: list[str]) -> tuple[list, list, bool]:
    """Translates the lines and keeps them in the memory: (translated pairs, refused lines, quota
    used up). Stops cleanly when the month's characters are used up."""
    quota = False
    translated: list[tuple[str, str]] = []
    skipped: list[str] = []
    if todo:
        async with httpx.AsyncClient(timeout=60) as client:
            with get_conn() as conn:
                glossary = await _glossary_id(client, conn)
            batch: list[str] = []
            size = 0
            batches: list[list[str]] = []
            for p in todo:
                if batch and (len(batch) >= BATCH_TEXTS or size + len(p) > BATCH_CHARS):
                    batches.append(batch)
                    batch, size = [], 0
                batch.append(p)
                size += len(p)
            if batch:
                batches.append(batch)
            try:
                for b in batches:
                    done, refused = await _translate_lines(client, b, glossary)
                    translated += done
                    skipped += refused
            except QuotaExceeded:
                quota = True
            except httpx.HTTPError:
                if not translated:
                    raise HTTPException(502, "DeepL nicht erreichbar.")

    with get_conn() as conn:
        now = datetime.now().isoformat(timespec="seconds")
        for src, de in translated:
            conn.execute(
                "INSERT INTO translations (source_hash, source, text_de, manual, updated_at) VALUES (?, ?, ?, 0, ?) "
                "ON CONFLICT(source_hash) DO NOTHING",
                (_hash(src), src, de, now),
            )
    return translated, skipped, quota


class ManualIn(BaseModel):
    source: str
    text_de: str


@router.put("/api/translate/manual")
def save_manual(body: ManualIn):
    """A whole text corrected by hand; an empty text_de goes back to the machine translation."""
    if not body.source.strip():
        raise HTTPException(400, "source is empty")
    with get_conn() as conn:
        key = _manual_hash(body.source)
        text = body.text_de.strip()
        if not text:
            conn.execute("DELETE FROM translations WHERE source_hash = ?", (key,))
        else:
            conn.execute(
                "INSERT INTO translations (source_hash, source, text_de, manual, updated_at) VALUES (?, ?, ?, 1, ?) "
                "ON CONFLICT(source_hash) DO UPDATE SET text_de = excluded.text_de, updated_at = excluded.updated_at",
                (key, body.source, text, datetime.now().isoformat(timespec="seconds")),
            )
        mem = Memory(conn)
        return {"text_de": mem.text(body.source), "manual": key in mem.manual}
