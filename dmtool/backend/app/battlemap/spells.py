"""Spell search on the Kampagnenbuch's spell library, with the area of effect read from the text.

The library entries are Open5e imports in English, so the area comes from phrases like
"in a 15-foot cone", "a 20-foot-radius sphere" or "a line 100 feet long and 5 feet wide".
"""
import re
import time

from . import kb

CACHE_SECONDS = 60
_cache: dict = {"at": 0.0, "spells": []}

_FT = r"(?:foot|feet|ft\.?)"
_N = r"(\d+)"
# (pattern, shape, which groups hold size and width); the earliest match in the text wins.
_PATTERNS = [
    (rf"\bline\b[^.]{{0,30}}?{_N} {_FT} long and {_N} {_FT} wide", "line", (1, 2)),
    (rf"{_N}-{_FT}-wide,? {_N}-{_FT}-long line", "line", (2, 1)),
    (rf"{_N}-{_FT}-long,? {_N}-{_FT}-wide line", "line", (1, 2)),
    (rf"{_N}[- ]{_FT}[- ]long line", "line", (1, None)),
    (rf"{_N}[- ]{_FT}[- ]cone", "cone", (1, None)),
    (rf"{_N}[- ]{_FT}[- ]cube", "square", (1, None)),
    (rf"cube (?:up to |that is )?{_N} {_FT} on (?:a|each) side", "square", (1, None)),
    (rf"{_N}[- ]{_FT}[- ]radius", "circle", (1, None)),
    (rf"radius of {_N} {_FT}", "circle", (1, None)),
    (rf"{_N}[- ]{_FT}[- ]diameter", "diameter", (1, None)),
    (rf"{_N} {_FT} in diameter", "diameter", (1, None)),
]
_COMPILED = [(re.compile(p, re.I), shape, groups) for p, shape, groups in _PATTERNS]


def _clean(text: str) -> str:
    # Soft hyphens and doubled dashes from the import: "10-\xad--foot-\xad--radius" -> "10-foot-radius".
    text = (text or "").replace("\xad", "")
    text = re.sub(r"[-‐-—]{2,}", "-", text)
    return re.sub(r"\s+", " ", text)


def parse_area(spell: dict) -> dict | None:
    """Area of effect as {shape, size, width} in feet, or None if the text names none.

    The range ("Self (15-foot cone)") is read before the description. Light a spell sheds
    ("bright light in a 20-foot radius") only counts when nothing else is found.
    """
    text = _clean(f"{spell.get('range') or ''}. {spell.get('desc') or ''}")
    found = []
    for regex, shape, (size_group, width_group) in _COMPILED:
        for m in regex.finditer(text):
            size = int(m.group(size_group))
            width = int(m.group(width_group)) if width_group else 5
            if shape == "diameter":
                shape_out, size = "circle", size / 2
            else:
                shape_out = shape
            if size <= 0:
                continue
            is_light = bool(re.search(r"light\b[^.]{0,20}$", text[max(0, m.start() - 30):m.start()], re.I))
            found.append((is_light, m.start(), {"shape": shape_out, "size": size, "width": width, "text": m.group(0)}))
    if not found:
        return None
    found.sort(key=lambda f: (f[0], f[1]))
    area = found[0][2]
    if float(area["size"]).is_integer():
        area["size"] = int(area["size"])
    return area


async def _library() -> list[dict]:
    if time.monotonic() - _cache["at"] > CACHE_SECONDS:
        spells = await kb.call("GET", "/api/spells/custom")
        _cache.update(at=time.monotonic(), spells=spells)
    return _cache["spells"]


def _relevance(name: str, q: str) -> int:
    name = name.lower()
    if name == q:
        return 0
    if name.startswith(q):
        return 1
    if re.search(rf"\b{re.escape(q)}", name):
        return 2
    return 3


async def search(query: str, limit: int = 15) -> list[dict]:
    q = query.strip().lower()
    if not q:
        return []
    hits = [s for s in await _library() if q in (s.get("name") or "").lower()]
    hits.sort(key=lambda s: (_relevance(s["name"], q), s["name"]))
    return [
        {"id": s["id"], "name": s["name"], "level": s.get("level_int"), "range": s.get("range"), "area": parse_area(s)}
        for s in hits[:limit]
    ]
