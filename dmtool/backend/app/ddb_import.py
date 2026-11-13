"""Subclasses, backgrounds and feats from D&D Beyond pages, for content the DM owns there.

Nothing is fetched from D&D Beyond: the DM opens the page in their own, signed-in browser and hands
its HTML over (bookmarklet copies the relevant part to the clipboard, or the page saved as a file;
several copied backgrounds can be pasted one after another). The pages are rendered on the server,
so a saved page holds the same markup.

Class page (/classes/2-cleric):
  div.subitems-list-details-item          one subclass
    hgroup > h2  (+ span.badge "legacy")   its name
    hgroup > p > em                        source book
    p …                                    introduction
    h4.Table-Styles_Table-Title + table    "Life Domain Spells"
    h4 + p …                               one feature each; the level is in its text
                                           ("Starting at 6th level"), 2024 pages "Level 3: Name"

Background page (/backgrounds/11-sage), one background each:
  .page-heading h1                        its name
  div.details-container-background
    .details-container-content-description-text
      p                                   introduction
      dl > dt  <strong>Label:</strong> …  Skill Proficiencies, Languages, Equipment (2024: Ability
                                          Scores, Feat, Tool Proficiency)
      div > strong + p …                  Specialty, Feature: Researcher
      h5 + p/table …                      Suggested Characteristics
    p.source                              source book

Species page (/species/1751436-dwarf, 2014 ones /species/13-dwarf), one people each:
  div.static-container-race .content-container
    h1 (+ legacy badge)                   2014 pages carry the badge
    p / h2 + p …                          introduction (2014: lore sections)
    h2 "Dwarf Traits"                     then the traits:
      p  <strong>Size:</strong> …<br>     2024: Creature Type, Size, Speed in one paragraph
      h4 + span/p/table …                 one trait each; 2024 lineages are one of them ("Elven
                                          Lineage" with a table, "Gnomish Lineage" with bold options)
    div.subitems-list-details             2014 subraces, in the markup of subclasses:
                                          .subitems-list-details-item, hgroup > h2, h4 + span
  .source-summary                         "Player's Handbook, pg. 189"

Feat page (/feats/1789147-grappler), one feat each:
  div.details-container-feat … description-text
    2024: p > em "General Feat (Prerequisite: Level 4+, …)", then the text
    2014: div > strong "Prerequisite:" …, then the text

Everything becomes the same data the Open5e import stores, in Markdown, so parse_grants(),
background_data(), race_data() and the translation work on it unchanged.
"""
import json
import re
from typing import Optional

from bs4 import BeautifulSoup, Tag
from fastapi import APIRouter, HTTPException
from markdownify import markdownify
from pydantic import BaseModel

from .char_options import background_data, feat_data, get_option, race_data
from .db import get_conn
from .i18n import t as _t

router = APIRouter()

SOURCE = "dndbeyond"
_LEGACY = '[aria-label="legacy"], #legacy-badge'
_LEVEL_RE = re.compile(
    r"\b(?:at|from|starting at|beginning at|when you reach|reach|reaching|by) (\d{1,2})(?:st|nd|rd|th)[ -]level", re.I)
_LEVEL_PREFIX = re.compile(r"^\s*Level (\d{1,2})\s*:\s*", re.I)
# dt label -> Open5e's benefit type
_BENEFIT_TYPES = [
    (r"ability score", "ability_score"), (r"skill proficienc", "skill_proficiency"),
    (r"tool proficienc", "tool_proficiency"), (r"language", "language"), (r"equipment", "equipment"),
    (r"^feat\b|origin feat", "feat"),
]


def _md(nodes: list) -> str:
    html = "".join(str(n) for n in nodes)
    text = markdownify(html, heading_style="ATX", strip=["a", "img", "span"], bullets="-")
    text = text.replace("\xa0", " ")
    text = re.sub(r"\*\*\*(.+?)\*\*\*", r"**\1**", text)  # <em><strong>Name.</strong></em>: bold is enough
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def _text(el: Tag) -> str:
    return re.sub(r"\s+", " ", el.get_text(" ")).strip()


def _heading_text(h: Tag) -> str:
    for badge in h.select(".badge"):
        badge.decompose()
    return _text(h)


def _page_name(el: Tag) -> Optional[str]:
    """The page title before el (pages pasted one after another: its own). Full pages have more
    than one h1; the title is the one in .page-heading."""
    heads = el.find_all_previous("h1")
    h1 = next((h for h in heads if h.find_parent(class_="page-heading")), heads[0] if heads else None)
    return _heading_text(h1) if h1 else None


def _first_level(text: str) -> Optional[int]:
    m = _LEVEL_RE.search(text)
    return int(m.group(1)) if m else None


# ---------- subclasses ----------

def _parse_subclass(item: Tag) -> Optional[dict]:
    header = item.find("hgroup") or item
    h2 = header.find("h2")
    if h2 is None:
        return None
    name = _heading_text(h2)
    em = header.select_one("p em")
    source_name = _text(em) if em else None

    intro: list = []
    features: list[dict] = []
    current: Optional[dict] = None
    for el in item.children:
        if not isinstance(el, Tag) or el is header or el.name == "hgroup":
            continue
        if el.name in ("h3", "h4"):
            current = {"name": _heading_text(el), "nodes": [], "table": "Table-Title" in " ".join(el.get("class") or [])}
            features.append(current)
        elif current is None:
            intro.append(el)
        else:
            current["nodes"].append(el)

    out = []
    for f in features:
        desc = _md(f["nodes"])
        if not desc:
            continue
        title = f["name"]
        level = None
        m = _LEVEL_PREFIX.match(title)
        if m:
            level, title = int(m.group(1)), title[m.end():].strip()
        if f["table"]:
            rows = re.findall(r"^\|\s*(\d{1,2})(?:st|nd|rd|th)?\s*\|", desc, flags=re.M)
            level = level or (int(rows[0]) if rows else None)
        level = level or _first_level(desc)
        out.append({"name": title, "level": level, "desc": desc})
    if not out:
        return None  # not owned: D&D Beyond shows only the name and a marketplace hint

    # Features without a level in their text (spell tables, follow-ups): the one before them, or
    # the subclass's first level.
    known = [f["level"] for f in out if f["level"]]
    last = min(known) if known else None
    for f in out:
        f["level"] = f["level"] or last
        last = f["level"]
    feats = [{"name": f["name"], "levels": [f["level"]] if f["level"] else [], "desc": f["desc"]} for f in out]
    feats.sort(key=lambda f: f["levels"][0] if f["levels"] else 0)  # stable: page order within a level
    return {"name": name, "source_name": source_name, "desc": _md(intro) or None, "features": feats}


# ---------- backgrounds ----------

def _benefit_type(label: str) -> Optional[str]:
    low = label.lower()
    return next((t for pattern, t in _BENEFIT_TYPES if re.search(pattern, low)), None)


def _parse_background(box: Tag) -> Optional[dict]:
    name = _page_name(box)
    text = box.select_one(".details-container-content-description-text")
    if not name or text is None:
        return None
    src = box.select_one("p.source")
    source_name = re.sub(r",?\s*pg\.?\s*\d+.*$", "", _text(src)) if src else None

    intro: list = []
    benefits: list[dict] = []
    current: Optional[dict] = None
    for el in text.children:
        if not isinstance(el, Tag) or "line" in (el.get("class") or []):
            continue
        if el.name == "dl":
            for dt in el.find_all("dt"):
                label = dt.find("strong")
                lname = _text(label).rstrip(":") if label else _text(dt).split(":")[0]
                if label:
                    label.extract()
                desc = _md([dt]).lstrip(": ").strip() if label else _text(dt).split(":", 1)[-1].strip()
                for dd in dt.find_next_siblings():  # some pages put the value in a <dd>
                    if dd.name != "dd":
                        break
                    desc = (desc + " " + _md([dd])).strip()
                benefits.append({"name": lname, "desc": desc, "type": _benefit_type(lname)})
            current = None
        elif el.name == "div" and el.find("strong", recursive=False):
            title = el.find("strong", recursive=False).extract()
            benefits.append({"name": _text(title).rstrip(":."), "desc": _md(list(el.children)), "type": None})
            current = None
        elif el.name in ("h3", "h4", "h5"):
            current = {"name": _text(el), "nodes": []}
            benefits.append(current)
        elif current is not None:
            current["nodes"].append(el)
        elif not benefits:
            intro.append(el)
    for b in benefits:
        if "nodes" in b:
            b["desc"], b["type"] = _md(b.pop("nodes")), None
    benefits = [b for b in benefits if b["desc"]]
    if not benefits:
        return None  # not owned
    types = {b["type"] for b in benefits}
    return {"name": name, "source_name": source_name, "desc": _md(intro) or None, "benefits": benefits,
            # 2024 backgrounds give ability scores and an origin feat; 2014 ones never do.
            "is_2024": {"ability_score", "feat"} <= types}


# ---------- feats ----------

_FEAT_LINE = re.compile(r"^(Origin|General|Fighting Style|Epic Boon) Feat(?:\s*\(Prerequisite:\s*(.+?)\))?\s*$", re.I)


def _parse_feat(box: Tag) -> Optional[dict]:
    name = _page_name(box)
    texts = box.select(".details-container-content-description-text")
    if not name or not texts:
        return None
    src = box.select_one("p.source")
    source_name = re.sub(r",?\s*pg\.?\s*\d+.*$", "", _text(src)) if src else None
    feat_type = prerequisite = None
    nodes: list = []
    for text in texts:
        for el in text.children:
            if not isinstance(el, Tag) or "line" in (el.get("class") or []):
                continue
            strong = el.find("strong", recursive=False) if el.name == "div" else None
            if strong and re.match(r"prerequisite", _text(strong), re.I):
                strong.extract()
                prerequisite = _text(el).lstrip(": ").strip() or None
                continue
            m = _FEAT_LINE.match(_text(el)) if el.name == "p" and feat_type is None and not nodes else None
            if m:
                feat_type, prerequisite = m.group(1).title(), m.group(2) or prerequisite
                continue
            nodes.append(el)
    desc = _md(nodes)
    if not desc:
        return None  # not owned
    return {"name": name, "source_name": source_name, "desc": desc, "feat_type": feat_type,
            "prerequisite": prerequisite, "is_2024": feat_type is not None}


# ---------- species (peoples) ----------

_TRAITS_HEAD = re.compile(r"\btraits\s*$", re.I)
# Class pages use the same container (static-container-race); its own h1 tells them apart.
_SPECIES_H1 = re.compile(r"\b(?:species|race) details\s*$", re.I)
_REPLACES = re.compile(r"replaces? (?:the |your )?[\w'’]+ ([\w ]+?) traits?\b", re.I)


def _source(box: Tag) -> Optional[str]:
    src = box.select_one(".source-summary, p.source")
    return re.sub(r",?\s*pg\.?\s*\d+.*$", "", _text(src)) if src else None


def _trait_list(nodes: list) -> list[dict]:
    """h4 + following nodes -> [{name, desc, type}]; a paragraph of <strong>Label:</strong> value
    lines (2024: Creature Type, Size, Speed) gives one trait per label."""
    traits: list[dict] = []
    current: Optional[dict] = None
    for el in nodes:
        if el.name in ("h3", "h4", "h5"):
            current = {"name": _heading_text(el), "nodes": []}
            traits.append(current)
        elif current is not None:
            current["nodes"].append(el)
        elif el.name == "p" and el.find("strong"):
            for part in re.split(r"<br\s*/?>", el.decode_contents()):
                m = re.match(r"\s*<strong>(.*?)</strong>(.*)$", part, re.S)
                if m:
                    label = re.sub(r"<[^>]+>|:", "", m.group(1)).strip()
                    value = _md([BeautifulSoup(m.group(2), "html.parser")]).lstrip(": ").strip()
                    traits.append({"name": label, "desc": value})
    out = []
    for t in traits:
        desc = t["desc"] if "desc" in t else _md(t["nodes"])
        if desc:
            out.append({"name": t["name"], "desc": desc, "type": "SPEED" if t["name"].lower() == "speed" else None})
    return out


_LINEAGE_TRAIT = re.compile(r"\b(?:lineage|legacy)\s*$", re.I)


def _lineage_options(nodes: list) -> tuple[str, list[tuple[str, str]]]:
    """A 2024 lineage trait (Elven Lineage, Fiendish Legacy, Gnomish Lineage): its general text and
    one (name, Markdown) per option, from its table (Lineage | Level 1 | Level 3 | Level 5) or from
    paragraphs that start with the option in bold ("Forest Gnome. You know …")."""
    general: list = []
    options: list[tuple[str, str]] = []
    for node in nodes:
        node = BeautifulSoup(str(node), "html.parser")  # a copy: the people keeps the full trait
        for table in node.find_all("table"):
            heads = [_text(th) for th in table.select("thead th")]
            for tr in table.select("tbody tr"):
                cells = tr.find_all(["td", "th"])
                if len(cells) < 2:
                    continue
                values = [(h, _md(list(c.children))) for h, c in zip(heads[1:], cells[1:])]
                lines = [f"**{h}:** {v}" for h, v in values if v]
                options.append((_text(cells[0]), "\n\n".join(lines)))
            table.decompose()
        for p in node.find_all("p"):
            first = next((c for c in p.children if not (isinstance(c, str) and not c.strip())), None)
            if isinstance(first, Tag) and first.name == "strong" and _text(first).endswith("."):
                label = _text(first).rstrip(".").strip()
                first.extract()
                options.append((label, _md([p])))
                p.decompose()
        general.append(node)
    return _md(general), options


def _lineages(people: dict, trait_nodes: list) -> list[dict]:
    """2024 peoples choose a lineage instead of a subrace (Elf: Drow, High Elf, Wood Elf). Each one
    becomes an entry of its own under the people, which has the people's traits with only its own
    row of the lineage trait, so it can be picked directly (as the Open5e subraces of 2014)."""
    heads = [i for i, el in enumerate(trait_nodes) if el.name in ("h3", "h4", "h5")]
    for n, i in enumerate(heads):
        trait = _heading_text(BeautifulSoup(str(trait_nodes[i]), "html.parser"))
        if not _LINEAGE_TRAIT.search(trait):
            continue
        end = heads[n + 1] if n + 1 < len(heads) else len(trait_nodes)
        general, options = _lineage_options(trait_nodes[i + 1:end])
        out = []
        for label, desc in options:
            # Lineages have names of their own (Wood Elf, Drow, Rock Gnome); a legacy is just an
            # adjective of its people (Abyssal -> Abyssal Tiefling).
            legacy = "legacy" in trait.lower() and people["name"].lower() not in label.lower()
            full = f"{label} {people['name']}" if legacy else label
            own = {"name": f"{trait}: {label}", "desc": "\n\n".join(x for x in (desc, general) if x), "type": None}
            traits = [own if t["name"] == trait else t for t in people["traits"]]
            # The people's description too, as the Open5e import gives a subrace without one.
            out.append({**people, "name": full, "parent": people["name"], "traits": traits})
        return out
    return []


def _is_species(box: Tag) -> bool:
    h1 = box.find("h1")
    return h1 is not None and bool(_SPECIES_H1.search(_text(h1)))


def _parse_races(box: Tag) -> list[dict]:
    """The people of a species page, and its subraces (2014) as entries of their own that hold the
    people's traits too, as the Open5e import stores them."""
    name = _page_name(box)
    content = box.select_one(".content-container") or box
    if not name:
        return []
    is_2024 = not box.select(_LEGACY)
    source_name = _source(box)
    intro: list = []
    trait_nodes: list = []
    in_traits = False
    for el in content.children:
        if not isinstance(el, Tag) or el.name in ("script", "hr", "h1") or "content-image" in (el.get("class") or []):
            continue
        if "subitems-list-details" in (el.get("class") or []):
            break
        if el.name == "h2" and _TRAITS_HEAD.search(_text(el)):
            in_traits = True
        elif in_traits:
            trait_nodes.append(el)
        else:
            intro.append(el)
    traits = _trait_list(trait_nodes)
    if not traits:
        return []  # not owned: only the introduction and a marketplace hint
    out = [{"name": name, "parent": None, "source_name": source_name, "desc": _md(intro) or None,
            "traits": traits, "is_2024": is_2024}]
    out += _lineages(out[0], trait_nodes)
    for item in content.select(".subitems-list-details-item"):
        header = item.find("hgroup") or item
        h2 = header.find("h2")
        if h2 is None:
            continue
        nodes = [el for el in item.children if isinstance(el, Tag) and el is not header and el.name != "hgroup"]
        first = next((i for i, el in enumerate(nodes) if el.name in ("h3", "h4", "h5")), len(nodes))
        own = _trait_list(nodes[first:])
        if own:
            desc = _md(nodes[:first]) or None
            # Usually the subrace adds to its people (Hill Dwarf: +1 WIS on top of +2 CON); Variant Human
            # says which trait it replaces instead ("replace the human's Ability Score Increase trait").
            replaced = {n.strip().lower() for n in _REPLACES.findall(desc or "")}
            inherited = [t for t in traits if t["name"].lower() not in replaced]
            out.append({"name": _heading_text(h2), "parent": name, "source_name": source_name,
                        "desc": desc, "traits": inherited + own, "is_2024": is_2024})
    return out


# ---------- page ----------

def parse_page(html: str) -> dict:
    soup = BeautifulSoup(html, "html.parser")
    # 2014 class pages flag the superseded (PHB 2014) content "legacy"; a page without any badge
    # is 2024. Read before the headings, which drop their badges.
    race_boxes = [b for b in soup.select(".static-container-race") if _is_species(b)]

    def in_species(el: Tag) -> bool:
        return any(b in el.parents for b in race_boxes)

    # Subraces use the markup of subclasses; on a species page they belong to the people.
    items = [i for i in soup.select(".subitems-list-details-item") if not in_species(i)]
    is_2024 = not any(not in_species(b) for b in soup.select(_LEGACY))
    boxes = soup.select(".details-container-background")
    feat_boxes = soup.select(".details-container-feat")
    class_name = _page_name(items[0]) if items else None
    return {
        "class_name": class_name, "is_2024": is_2024,
        "subclasses": [s for s in (_parse_subclass(i) for i in items) if s],
        "backgrounds": [b for b in (_parse_background(x) for x in boxes) if b],
        "feats": [f for f in (_parse_feat(x) for x in feat_boxes) if f],
        "races": [r for x in race_boxes for r in _parse_races(x)],
        "found": len(items) + len(boxes) + len(feat_boxes) + len(race_boxes),
    }


class ParseIn(BaseModel):
    html: str


class ImportEntry(BaseModel):
    kind: str = "subclasses"
    name: str
    parent: Optional[str] = None
    is_2024: bool = False
    source_name: Optional[str] = None
    desc: Optional[str] = None
    features: list[dict] = []
    benefits: list[dict] = []
    feat_type: Optional[str] = None
    prerequisite: Optional[str] = None
    traits: list[dict] = []
    replace_id: Optional[int] = None


class ImportIn(BaseModel):
    entries: list[ImportEntry]


def _existing(conn, kind: str, name: str, is_2024: bool) -> Optional[dict]:
    row = conn.execute(
        "SELECT id, source FROM char_options WHERE kind = ? AND is_2024 = ? AND "
        "(lower(name_en) = lower(?) OR lower(name) = lower(?))", (kind, int(is_2024), name, name)).fetchone()
    return dict(row) if row else None


@router.post("/api/options/ddb/parse")
def parse(body: ParseIn):
    page = parse_page(body.html)
    if not page["found"]:
        raise HTTPException(400, _t("Nichts gefunden – ist das eine Klassen-, Volks-, Hintergrund- oder Talent-Seite von D&D Beyond?"))
    # Per ruleset ("0" 2014, "1" 2024): the preview lets the DM change the guessed one, and only an
    # entry of the chosen ruleset may be replaced.
    with get_conn() as conn:
        for kind in ("subclasses", "backgrounds", "feats", "races"):
            for e in page[kind]:
                e["existing"] = {str(r): _existing(conn, kind, e["name"], bool(r)) for r in (0, 1)}
    return page


@router.post("/api/options/ddb/import")
def import_entries(body: ImportIn):
    done = []
    with get_conn() as conn:
        for e in body.entries:
            if e.kind == "subclasses":
                data = {"features": e.features}
            elif e.kind == "backgrounds":
                data = background_data(e.benefits)
            elif e.kind == "feats":
                data = feat_data(e.desc, e.feat_type, e.prerequisite)
            elif e.kind == "races":
                data = race_data([{"name": t.get("name"), "desc": t.get("desc"), "type": t.get("type")} for t in e.traits])
            else:
                raise HTTPException(400, "unknown category")
            note = f"Importiert von D&D Beyond ({e.source_name or 'eigener Inhalt'})"
            parent = e.parent if e.kind in ("subclasses", "races") else None
            if e.kind == "races" and parent:
                # As the Open5e import does: a subrace names its people as the library has it (Zwerg).
                people = _existing(conn, "races", parent, e.is_2024)
                if people:
                    parent = conn.execute("SELECT name FROM char_options WHERE id = ?", (people["id"],)).fetchone()["name"]
            if e.replace_id:
                target = conn.execute("SELECT kind, is_2024 FROM char_options WHERE id = ?", (e.replace_id,)).fetchone()
                if target is None or target["kind"] != e.kind or bool(target["is_2024"]) != e.is_2024:
                    raise HTTPException(409, _t("„{name}“: der Eintrag zum Ersetzen passt nicht (mehr) zum gewählten Regelwerk. Bitte neu lesen.", name=e.name))
                # The name stays (a German one of the SRD, references on sheets); the English one is D&D Beyond's.
                conn.execute(
                    "UPDATE char_options SET name_en=?, parent=?, data=?, desc=?, notes=?, source=? WHERE id=?",
                    (e.name, parent, json.dumps(data), e.desc, note, SOURCE, e.replace_id))
                done.append(e.replace_id)
            else:
                done.append(conn.execute(
                    "INSERT INTO char_options (kind, name, name_en, parent, is_2024, data, desc, notes, source) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (e.kind, e.name, e.name, parent, int(e.is_2024), json.dumps(data), e.desc, note, SOURCE)).lastrowid)
        return [get_option(conn, i) for i in done]
