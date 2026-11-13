"""German translations of campaign texts (NPCs, places, factions, quests, handouts, sessions) and the
bestiary, through DeepL (translate.py).

Unlike the library, these texts are the DM's own to edit, so the translation replaces the text and
the English original is kept beside it, once: entries in fields.body_en / fields.summary_en, sessions
in sessions.prep_en, monsters in custom_monsters.stat_block_en. Something translated already is left
alone (the DM may have edited the German since). The DM's secrets and notes are never sent.

Lines go through the same translation memory as the library: a sentence costs characters once. One
call translates up to max_chars characters and applies every text whose lines are all there; the
page calls again until nothing is left (or the month's characters are used up).
"""
import copy
import json
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from . import live, translate
from .db import get_conn
from .i18n import t as _t

router = APIRouter()

# Monster texts worth translating. The senses stay English: the sheets read "passive Perception 9" there.
_MONSTER_LISTS = ("special_abilities", "actions", "bonus_actions", "reactions", "legendary_actions")
_MONSTER_STRINGS = ("legendary_desc", "languages", "description")  # description: the book's text (book_import.py)


class ContentIn(BaseModel):
    campaign_id: Optional[int] = None  # every entry and session of the campaign
    entry_ids: list[int] = []
    session_ids: list[int] = []
    monsters: bool = False  # the whole bestiary
    monster_ids: list[int] = []
    dry_run: bool = False
    max_chars: int = 30_000


def _monster_texts(sb: dict) -> list[str]:
    out = []
    for key in _MONSTER_LISTS:
        for a in sb.get(key) or []:
            out += [a.get("name") or "", a.get("desc") or ""]
    out += [sb.get(k) or "" for k in _MONSTER_STRINGS]
    return [t for t in out if t.strip()]


def _monster_german(sb: dict, mem: translate.Memory) -> dict | None:
    out = copy.deepcopy(sb)

    def de(t):
        return t if not t or not translate.split_text(t)[1] else mem.text(t)
    for key in _MONSTER_LISTS:
        for a in out.get(key) or []:
            for f in ("name", "desc"):
                if a.get(f):
                    t = de(a[f])
                    if t is None:
                        return None
                    a[f] = t
    for k in _MONSTER_STRINGS:
        if out.get(k):
            t = de(out[k])
            if t is None:
                return None
            out[k] = t
    return out


def _items(conn, body: ContentIn) -> list[dict]:
    """What there is to translate: {kind, id, texts {key: English}} of everything not translated yet."""
    items: list[dict] = []
    entry_ids, session_ids = set(body.entry_ids), set(body.session_ids)
    if body.campaign_id is not None:
        entry_ids |= {r["id"] for r in conn.execute("SELECT id FROM entries WHERE campaign_id = ? AND type != 'pc'",
                                                    (body.campaign_id,))}
        session_ids |= {r["id"] for r in conn.execute("SELECT id FROM sessions WHERE campaign_id = ?", (body.campaign_id,))}
    for eid in sorted(entry_ids):
        r = conn.execute("SELECT id, name, summary, body, fields FROM entries WHERE id = ?", (eid,)).fetchone()
        if r is None:
            continue
        fields = json.loads(r["fields"] or "{}")
        if "body_en" in fields:
            continue
        texts = {k: r[k] for k in ("body", "summary") if (r[k] or "").strip() and translate.split_text(r[k])[1]}
        if texts:
            items.append({"kind": "entry", "id": r["id"], "name": r["name"], "texts": texts, "fields": fields})
    for sid in sorted(session_ids):
        r = conn.execute("SELECT id, title, prep, prep_en FROM sessions WHERE id = ?", (sid,)).fetchone()
        if r is None or r["prep_en"] is not None or not translate.split_text(r["prep"] or "")[1]:
            continue
        items.append({"kind": "session", "id": r["id"], "name": r["title"], "texts": {"prep": r["prep"]}})
    monster_ids = set(body.monster_ids)
    if body.monsters:
        monster_ids |= {r["id"] for r in conn.execute("SELECT id FROM custom_monsters")}
    for mid in sorted(monster_ids):
        r = conn.execute("SELECT id, name, stat_block, stat_block_en FROM custom_monsters WHERE id = ?", (mid,)).fetchone()
        if r is None or r["stat_block_en"] is not None or not r["stat_block"]:
            continue
        sb = json.loads(r["stat_block"])
        texts = {str(i): t for i, t in enumerate(_monster_texts(sb)) if translate.split_text(t)[1]}
        if texts:
            items.append({"kind": "monster", "id": r["id"], "name": r["name"], "texts": texts, "stat_block": sb})
    return items


def _missing(items: list[dict], mem: translate.Memory) -> list[str]:
    seen: dict[str, None] = {}
    for it in items:
        for t in it["texts"].values():
            for p in mem.missing(t):
                seen.setdefault(p)
    return list(seen)


def _apply(conn, it: dict, mem: translate.Memory) -> bool:
    """The German text in place of the English, the English kept; False while lines are missing."""
    if it["kind"] == "monster":
        german = _monster_german(it["stat_block"], mem)
        if german is None:
            return False
        conn.execute("UPDATE custom_monsters SET stat_block = ?, stat_block_en = ? WHERE id = ?",
                     (json.dumps(german), json.dumps(it["stat_block"]), it["id"]))
        return True
    german = {k: mem.text(t) for k, t in it["texts"].items()}
    if any(v is None for v in german.values()):
        return False
    if it["kind"] == "session":
        conn.execute("UPDATE sessions SET prep = ?, prep_en = ?, updated_at = datetime('now') WHERE id = ?",
                     (german["prep"], it["texts"]["prep"], it["id"]))
        return True
    fields = {**it["fields"], **{f"{k}_en": t for k, t in it["texts"].items()}}
    fields.setdefault("body_en", "")  # the marker: translated, also when only the summary had words
    values = {**german, "fields": json.dumps(fields)}
    cols = ", ".join(f"{k} = ?" for k in values)
    conn.execute(f"UPDATE entries SET {cols}, updated_at = datetime('now') WHERE id = ?", (*values.values(), it["id"]))
    return True


@router.post("/api/translate/content")
async def translate_content(body: ContentIn):
    with get_conn() as conn:
        items = _items(conn, body)
        mem = translate.Memory(conn)
    missing = _missing(items, mem)
    chars = sum(len(p) for p in missing)
    summary = {"items": len(items), "chars_missing": chars,
               "kinds": {k: sum(1 for i in items if i["kind"] == k) for k in ("entry", "session", "monster")}}
    if body.dry_run or not items:
        return {**summary, "done": 0, "remaining": len(items)}
    if missing and not translate._api_key():
        raise HTTPException(400, _t("Kein DeepL-Schlüssel: DEEPL_API_KEY in der Umgebung setzen."))

    budget = max(1000, min(body.max_chars, 100_000))
    todo, used = [], 0
    for p in missing:
        if todo and used + len(p) > budget:
            break
        todo.append(p)
        used += len(p)
    translated, skipped, quota = await translate.translate_and_store(todo)

    done = 0
    with get_conn() as conn:
        mem = translate.Memory(conn)
        for it in items:
            done += _apply(conn, it, mem)
        rest = _items(conn, body)
        left = sum(len(p) for p in _missing(rest, mem))
    if done:
        await live.notify()
    return {"items": len(items), "done": done, "remaining": len(rest), "chars_missing": left,
            "translated_chars": sum(len(s) for s, _ in translated), "skipped_lines": len(skipped),
            "quota_exceeded": quota,
            # Lines DeepL refused in every form keep their text from being finished; stop asking then.
            "stuck": bool(rest) and not translated and not quota}


class RestoreIn(BaseModel):
    kind: str  # entry, session, monster
    id: int


@router.post("/api/translate/content/original")
async def restore_original(body: RestoreIn):
    """Back to the English original (the German translation is dropped)."""
    with get_conn() as conn:
        if body.kind == "entry":
            r = conn.execute("SELECT fields FROM entries WHERE id = ?", (body.id,)).fetchone()
            fields = json.loads(r["fields"] or "{}") if r else {}
            if "body_en" not in fields:
                raise HTTPException(409, _t("Nicht übersetzt."))
            values = {k: fields.pop(f"{k}_en") for k in ("body", "summary") if f"{k}_en" in fields and fields[f"{k}_en"]}
            fields.pop("body_en", None)
            fields.pop("summary_en", None)
            values["fields"] = json.dumps(fields)
            cols = ", ".join(f"{k} = ?" for k in values)
            conn.execute(f"UPDATE entries SET {cols}, updated_at = datetime('now') WHERE id = ?", (*values.values(), body.id))
        elif body.kind == "session":
            conn.execute("UPDATE sessions SET prep = prep_en, prep_en = NULL WHERE id = ? AND prep_en IS NOT NULL", (body.id,))
        elif body.kind == "monster":
            conn.execute("UPDATE custom_monsters SET stat_block = stat_block_en, stat_block_en = NULL "
                         "WHERE id = ? AND stat_block_en IS NOT NULL", (body.id,))
        else:
            raise HTTPException(400, "kind must be entry, session or monster")
    await live.notify()
    return {"ok": True}
