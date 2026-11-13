"""Adventure chapters from D&D Beyond (/sources/dnd/lmop/goblin-arrows), into a campaign's entries.

As with ddb_import.py nothing is fetched from D&D Beyond: the DM copies the chapter in their own,
signed-in browser (bookmarklet) or saves the page ("Webseite, komplett" keeps the maps as files).

A chapter page is one flat run of headings and their text:
  .page-heading h1                       the chapter ("Goblin Arrows")
  div.p-article-content
    h1#Part1GoblinArrows                 the chapter again, with its number
    h2#CragmawHideout                    a section: a place or an encounter
    h3#1CaveMouth                        an area of it, numbered on the map ("1. Cave Mouth"),
                                         or a subtitle ("General Features", "What's Next?")
    h4#CaveMouthDevelopments             Developments, Treasure, "Roleplaying Sildar"
    p, ul, table                         text
    aside.text--quote-box                boxed text to read aloud
    aside.text--rules-sidebar            a sidebar ("Rests", "What the Goblins Know")
    figure#Map11CragmawHideout           a map: img + figcaption "Cragmaw Hideout"
    a href="…/goblin-arrows#6GoblinDen"  a reference to another heading (any chapter)

The introduction of a book ("Campaign Overview", /sources/dnd/tod/campaign-overview) goes into the
campaign's Kapitel entry "Kapitel 0: Einleitung" instead (parse_chapter(intro=True), use "intro"):
everything becomes its description,
headed as in the book, except the factions and allies of "Campaign Villains"/"Campaign Allies",
suggested as entries of their own. Its pictures (portraits, faction symbols) stay in the text where
they stood, or become the picture of the faction they head.

parse_chapter() turns every heading into a row with a suggested use (the chapter a planned session,
place, NPC, part of the text above, left out); the DM changes them in the preview, and import_rows()
writes the entries. References become [[wiki links]] where their target became an entry of its own.
Every entry keeps its place in the book (fields ddb_ref, ddb_chapter, ddb_order), so the lists can
group places by chapter and follow the book's order; the session (sessions.ddb_ref) lists them.
"""
import json
import re
from typing import Optional

from bs4 import BeautifulSoup, NavigableString, Tag
from fastapi import APIRouter, HTTPException
from markdownify import markdownify
from pydantic import BaseModel

from .db import get_conn
from .statblock import build_stat_block
from .i18n import t as _t

router = APIRouter()

# The types an imported heading can become, and which types may hold it (parent_id), as in app.js.
ENTRY_TYPES = {"location", "place", "npc", "faction", "item", "quest", "handout"}
PARENT_TYPES = {"location": {"location"}, "place": {"place"}, "npc": {"place", "location"}, "faction": {"place", "location"},
                "item": {"pc", "npc", "faction", "place", "location"}, "quest": {"npc", "faction", "pc"}}
_AREA = re.compile(r"^(\d+[a-z]?)\.\s+(.+)$")
_ROLEPLAY = re.compile(r"^roleplaying\s+(.+)$", re.I)
_REF = re.compile(r"/sources/(?:dnd/)?([a-z0-9-]+)/([a-z0-9-]+)/?(?:#([\w-]+))?", re.I)
# Sections of an introduction whose headings are factions and people rather than more text.
_PEOPLE_SECTION = re.compile(r"\b(allies|villains|factions|verbündete|schurken|fraktionen)\b", re.I)
_NOT_A_PERSON = re.compile(r"^(using|on|the|a|an|dissent|daily|wearers|cult|rath)\b", re.I)
# A picture of an introduction in the text, until the import knows its uploaded address.
_PIC_RE = re.compile(r"⟪(\d+)⟫")
# A reference inside the text until the import knows whether its target became an entry.
_TOKEN = "⟦{}‖{}⟧"
_TOKEN_RE = re.compile("⟦([^‖⟧]+)‖([^⟧]*)⟧")


def _text(el) -> str:
    return re.sub(r"\s+", " ", el.get_text(" ") if isinstance(el, Tag) else str(el)).strip()


def _chapter_ref(soup: BeautifulSoup) -> Optional[str]:
    """"lmop/goblin-arrows" from the page's address (saved page or bookmarklet copy)."""
    for el, attr in ((soup.find("link", rel="canonical"), "href"), (soup.find("meta", attrs={"name": "ddb-url"}), "content"),
                     (soup.find("meta", property="og:url"), "content")):
        m = _REF.search((el.get(attr) or "") if el else "")
        if m:
            return f"{m.group(1)}/{m.group(2)}".lower()
    m = re.search(r"saved from url=\(\d+\)(\S+)", str(soup)[:2000])
    m = _REF.search(m.group(1)) if m else None
    return f"{m.group(1)}/{m.group(2)}".lower() if m else None


def _ref_of(href: str, chapter: Optional[str]) -> Optional[str]:
    """A link's target as "book/chapter#Anchor" (or "book/chapter"), None if it leaves the book."""
    if href.startswith("#"):
        return f"{chapter}{href}" if chapter else None
    m = _REF.search(href)
    if not m or m.group(1) in ("basic-rules", "free-rules", "phb", "dmg", "mm"):
        return None
    ref = f"{m.group(1)}/{m.group(2)}".lower()
    return f"{ref}#{m.group(3)}" if m.group(3) else ref


def _md(nodes: list, chapter: Optional[str]) -> str:
    """Markdown of the nodes. References in the book become tokens, every other link (rules,
    monsters, skills) plain text; read-aloud boxes and sidebars become block quotes."""
    parts = []
    for node in nodes:
        node = BeautifulSoup(str(node), "html.parser")
        for a in node.find_all("a"):
            label = _text(a)
            ref = _ref_of(a.get("href") or "", chapter)
            a.replace_with(NavigableString(_TOKEN.format(ref, label) if ref and label else label))
        for img in node.find_all(["img", "figure", "script", "select"]):
            img.decompose()
        text = markdownify(str(node), heading_style="ATX", bullets="-", strip=["span"]).replace("\xa0", " ")
        root = next((c for c in node.children if isinstance(c, Tag)), None)
        if root is not None and root.name == "aside":
            text = "\n".join(f"> {line}" if line.strip() else ">" for line in text.strip().splitlines())
        parts.append(text.strip())
    out = "\n\n".join(p for p in parts if p)
    out = re.sub(r"\*\*\*(.+?)\*\*\*", r"**\1**", out)
    return re.sub(r"\n{3,}", "\n\n", out).strip()


def _summary(md: str) -> str:
    """The first sentence of the first plain paragraph, for the lists."""
    for para in md.split("\n\n"):
        if para.startswith((">", "#", "-", "|")) or not _PIC_RE.sub("", para).strip():
            continue
        plain = re.sub(r"[*_]", "", _TOKEN_RE.sub(lambda m: m.group(2), para)).strip()
        m = re.match(r"(.{20,240}?[.!?])(\s|$)", plain)
        return (m.group(1) if m else plain[:240]).strip()
    return ""


def _full_name(first: str, text: str) -> str:
    """"Roleplaying Sildar": the text calls him "Sildar Hallwinter"."""
    found = re.findall(rf"\b{re.escape(first)} ([A-Z][\w’']+)", text)
    if not found:
        return first
    last = max(set(found), key=found.count)
    return f"{first} {last}" if found.count(last) > 1 else first


# ---------- the appendices: stat blocks for the bestiary, magic items for the library ----------
#
# A stat block (Appendix B, also inside chapters):
#   div.stat-block-background
#     p.Stat-Block-Styles_Stat-Block-Title       "Bugbear"
#     p.…-Metadata                                "Medium humanoid (goblinoid), chaotic evil"
#     p.…-Data / -Data-Last                       <strong>Armor Class</strong> 16 (hide armor, shield)
#     div.stat-block-ability-scores               six .stat-block-ability-scores-score
#     p.…-Body                                    <em><strong>Brute.</strong></em> text
#     p.…-Hanging, ol                             lines of the feature above (spell lists)
#     p.…-Heading                                 "Actions", "Reactions", "Legendary Actions"
#     a > img                                     the creature's picture (saved page only)
# A magic item (Appendix A): a heading whose words are the item's link (a.magic-item-tooltip),
# then its description; older books put "Wondrous item, rare (requires attunement)" first.

LIBRARY_USES = {"monster", "library_item"}
_SIZE_META = re.compile(r"^(?:tiny|small|medium|large|huge|gargantuan)(?:\s+or\s+\w+)?\s+(.+?)(?:,\s*([^,]+))?$", re.I)
_SECTIONS = {"actions": "actions", "bonus actions": "actions", "reactions": "reactions",
             "legendary actions": "legendary_actions", "mythic actions": "legendary_actions"}
_DATA_KEYS = {"armor class": "ac", "hit points": "hp", "speed": "speed", "saving throws": "saves", "skills": "skills",
              "senses": "senses", "languages": "languages", "challenge": "challenge",
              "damage vulnerabilities": "damage_vulnerabilities", "damage resistances": "damage_resistances",
              "damage immunities": "damage_immunities", "condition immunities": "condition_immunities"}
_ITEM_META = re.compile(r"^(.+?),\s*(common|uncommon|rare|very rare|legendary|artifact|rarity varies)\b(.*)$", re.I)
_ITEM_TYPES = [(r"\bpotion|elixir|philter", "Potion"), (r"\bring\b", "Ring"), (r"\bwand\b", "Wand"), (r"\bstaff\b", "Staff"),
               (r"\brod\b", "Rod"), (r"\bscroll\b", "Scroll"), (r"\barmor\b|\bshield\b|\bplate\b|\bmail\b", "Armor"),
               (r"\bweapon\b|\bsword\b|\baxe\b|\bbow\b|\bdagger\b|\bmace\b|\bhammer\b|\bspear\b|\bblade\b|\btalon\b", "Weapon")]


def _first_int(text: str) -> Optional[int]:
    m = re.search(r"\d+", text or "")
    return int(m.group()) if m else None


def _plain(md: str) -> str:
    """Book text for the library: references are just their words there."""
    return _TOKEN_RE.sub(lambda m: m.group(2), md or "").strip()


def _stext(el) -> str:
    """Plain words of a stat block line, without the gaps the links leave ("a spider staff .")."""
    return re.sub(r"\(\s+", "(", re.sub(r"\s+([.,;:!?)])", r"\1", _text(el)))


_DATA_LABELS = sorted(_DATA_KEYS, key=len, reverse=True)


def is_stat_block(el: Tag) -> bool:
    """A stat block's frame: div.stat-block-background (Lost Mine of Phandelver) or a plain
    div.Basic-Text-Frame (Out of the Abyss), with a title and the six ability scores."""
    return (el.name == "div" and el.select_one("[class*=Stat-Block-Title]") is not None
            and el.select_one(".stat-block-ability-scores") is not None)


def _feature_name(el: Tag, text: str) -> str:
    """"Brute" of "Brute. A melee weapon…": the bold start of a feature, in <strong> or in a span
    styled Inline-Subhead or Bold-Sans (legendary actions in Out of the Abyss). The book sometimes
    puts more into it ("Javelin. Melee or ")."""
    lead = el.find(lambda t: t.name in ("strong", "b")
                   or any("Inline-Subhead" in c or "Bold-Sans" in c for c in t.get("class") or []))
    if lead is None:
        return ""
    # Up to the first full stop, a leading number kept ("1. Beguiling Gaze" in Demogorgon's gaze).
    name = re.match(r"((?:\d+\.\s*)?[^.]*)", _stext(lead)).group(1).strip()
    return name if name and text.startswith(name) else ""


def parse_stat_block(block: Tag) -> Optional[dict]:
    """A stat block as a bestiary entry (custom_monsters, stat_block as open5e.py and monster_import.py
    write it). None if it lacks a name or the numbers the tracker needs."""
    title = block.select_one("[class*=Stat-Block-Title]")
    name = _stext(title) if title else ""
    if not name:
        return None
    # The frame itself is the title's parent: Out of the Abyss wraps Orcus's in two more divs.
    block = title.parent
    meta = block.select_one("[class*=Stat-Block-Metadata]")
    m = _SIZE_META.match(_stext(meta)) if meta else None
    creature_type = m.group(1).strip().lower() if m else None
    size = _stext(meta).split()[0].capitalize() if m else None  # "Medium" of "Medium humanoid (goblinoid), …"
    # "Armor Class 16 (…)": the label in <strong> (Lost Mine of Phandelver), in a span or plain
    # (Out of the Abyss), so it is read from the words themselves.
    data: dict[str, str] = {}
    for p in block.select("[class*=Stat-Block-Data]"):
        text = _stext(p)
        label = next((k for k in _DATA_LABELS if text.lower().startswith(k)), None)
        if label:
            data[_DATA_KEYS[label]] = text[len(label):].strip()
    scores = [_first_int(_stext(s)) for s in block.select(".stat-block-ability-scores-score")]
    abilities = dict(zip(("str", "dex", "con", "int", "wis", "cha"), scores + [None] * (6 - len(scores))))
    ac, hp = _first_int(data.get("ac", "")), _first_int(data.get("hp", ""))
    if ac is None or hp is None:
        return None
    cr = re.match(r"\s*(\d+(?:/\d+)?)", data.get("challenge", ""))
    cr = cr.group(1) if cr else None

    sections = {"special_abilities": [], "actions": [], "reactions": [], "legendary_actions": []}
    legendary_desc = None
    section = "special_abilities"
    for el in block.find_all(["p", "ol", "ul"], recursive=False):
        cls = " ".join(el.get("class") or [])
        if "Stat-Block-Heading" in cls:
            section = _SECTIONS.get(_stext(el).lower(), section)
            continue
        if "Stat-Block-Body" not in cls and "Stat-Block-Hanging" not in cls:
            continue
        items = sections[section]
        if el.name in ("ol", "ul"):
            lines = "\n".join(f"- {_stext(li)}" for li in el.find_all("li"))
            if items:
                items[-1]["desc"] = f"{items[-1]['desc']}\n{lines}".strip()
            continue
        text = _stext(el)
        lead = _feature_name(el, text)
        # A hanging line with a name of its own is a legendary action (Out of the Abyss); without
        # one it continues the feature above (a spell list).
        if lead:
            items.append({"name": lead, "desc": text[len(lead):].lstrip(" .").strip()})
        elif section == "legendary_actions" and not items and legendary_desc is None:
            legendary_desc = text
        elif items:
            items[-1]["desc"] = f"{items[-1]['desc']}\n{text}".strip()
        else:
            items.append({"name": "", "desc": text})
    img = block.find("img")
    dex = abilities.get("dex")
    passive = re.search(r"passive Perception\s+(\d+)", data.get("senses", ""), re.I)
    return {
        "name": name,
        "max_hp": hp,
        "ac": ac,
        "initiative_bonus": (dex - 10) // 2 if isinstance(dex, int) else 0,
        "challenge_rating": cr,
        "creature_type": creature_type,
        "alignment": m.group(2).strip() if m and m.group(2) else None,
        "saves": data.get("saves"),
        "skills": data.get("skills"),
        "image_file": (img.get("src") or "").rsplit("/", 1)[-1] if img is not None else None,
        "stat_block": build_stat_block(
            abilities=abilities,
            challenge_rating=cr,
            size=size,
            speed=data.get("speed"),
            senses=data.get("senses"),
            passive_perception=int(passive.group(1)) if passive else None,
            languages=data.get("languages"),
            damage_vulnerabilities=data.get("damage_vulnerabilities"),
            damage_resistances=data.get("damage_resistances"),
            damage_immunities=data.get("damage_immunities"),
            condition_immunities=data.get("condition_immunities"),
            legendary_desc=legendary_desc,
            **sections,
        ),
    }


def _item_heading(el: Tag) -> bool:
    """A heading that is a magic item's name: its words are the item's link."""
    a = el.find("a", class_=re.compile(r"(magic-)?item-tooltip"))
    return a is not None and _text(a).lower() == _text(el).lower()


def parse_item(name: str, nodes: list, chapter: Optional[str]) -> dict:
    """A magic item for the library (custom_items) from its heading and the text below it."""
    item_type = rarity = None
    attune = False
    # The first paragraph with words (Out of the Abyss puts the item's picture in one before it).
    first = next((n for n in nodes if isinstance(n, Tag) and n.name == "p" and _text(n)), None)
    if first is not None and first.find("em") is not None and _text(first.find("em")) == _text(first):
        m = _ITEM_META.match(_text(first))
        if m:
            item_type, rarity = m.group(1).strip(), m.group(2).lower()
            attune = "requires attunement" in m.group(3).lower()  # not "attunement optional"
            nodes = [n for n in nodes if n is not first]
    img = next((i for n in nodes if isinstance(n, Tag) for i in n.find_all("img")), None)
    desc = _plain(_md(nodes, chapter))
    if item_type is None:
        item_type = next((t for pat, t in _ITEM_TYPES if re.search(pat, name, re.I)), "Wondrous item")
    if not attune:
        attune = bool(re.search(r"\b(must be attuned|while (?:you are )?attuned|are attuned to it|requires attunement)\b",
                                desc, re.I))
    return {"name": name, "item_type": item_type, "rarity": rarity, "requires_attunement": attune, "desc": desc,
            "image_file": (img.get("src") or "").rsplit("/", 1)[-1] if img is not None else None}


def _picture(el: Tag) -> Optional[dict]:
    """A picture that is no map: a figure without a map's marks ("Map 1.1", a player version), or an
    image standing alone between paragraphs (the faction symbols)."""
    img = el.find("img") if el.name != "img" else el
    if img is None:
        return None
    if el.name == "figure":
        caption = el.find("figcaption")
        hrefs = [a.get("href") or "" for a in caption.find_all("a")] if caption is not None else []
        if (el.get("id") or "").lower().startswith("map") or any("player" in h.lower() for h in hrefs):
            return None
        title = _text(caption.find(string=True, recursive=False) or caption) if caption is not None else ""
    elif _text(el):
        return None  # an image within text
    else:
        title = ""
    return {"file": (img.get("src") or "").rsplit("/", 1)[-1], "title": title}


def parse_chapter(html: str, intro: bool = False) -> dict:
    soup = BeautifulSoup(html, "html.parser")
    article = soup.select_one(".p-article-content")
    if article is None:
        raise HTTPException(400, "Kein Buchkapitel gefunden – ist das eine Kapitelseite eines D&D-Beyond-Buchs "
                                 "(dndbeyond.com/sources/…)?")
    chapter = _chapter_ref(soup)
    heading = soup.select_one(".page-heading h1")
    rows: list[dict] = []
    stack: list[dict] = []  # the open headings above the current one
    current: Optional[dict] = None
    # Text after a creature's stat block belongs to the next heading: the appendix sets the
    # commoner's description below the bugbear's block, before the heading "Commoner".
    after_block: list = []
    in_appendix = False
    pictures: list[dict] = []  # an introduction's pictures, in page order
    for el in article.children:
        if not isinstance(el, Tag) or el.name in ("select", "script") or el.get("id") == "comp-next-nav":
            continue
        if el.name in ("h1", "h2", "h3", "h4"):
            level = int(el.name[1])
            if not rows:
                in_appendix = bool(re.match(r"appendix\b", _text(el), re.I))
            while stack and stack[-1]["level"] >= level:
                stack.pop()
            title = _text(el)
            current = {"anchor": el.get("id"), "level": level, "title": title, "nodes": after_block, "maps": [],
                       "parent": stack[-1]["anchor"] if stack else None, "item": level >= 2 and _item_heading(el)}
            after_block = []
            rows.append(current)
            stack.append(current)
            continue
        if current is None:
            continue
        if is_stat_block(el):
            monster = parse_stat_block(el)
            if monster is None:
                current["nodes"].append(el)
            elif monster["name"].lower() == current["title"].lower() and not current.get("monster"):
                # The heading is the creature (the appendix); its spelling wins ("DerrO" in the block).
                current["monster"] = {**monster, "name": current["title"]}
                current["after"] = True
            elif in_appendix and (owner := next((s for s in reversed(stack) if s["title"].lower() == monster["name"].lower()
                                                 and not s.get("monster")), None)):
                # A heading further up is the creature: the demon lords of Out of the Abyss have their
                # description, "Orcus's Lair" and "Madness of Orcus" before the block, which comes last.
                owner["monster"] = {**monster, "name": owner["title"]}
            else:
                # A stat block within a chapter's text: a row of its own below the heading.
                rows.append({"anchor": None, "level": min(current["level"] + 1, 6), "title": monster["name"],
                             "nodes": [], "maps": [], "parent": current["anchor"], "monster": monster})
            continue
        if intro and (pic := _picture(el)) is not None:
            i = len(pictures)
            pictures.append(pic)
            current.setdefault("pictures", []).append(i)
            if not current["nodes"] and current.get("picture") is None and pic["title"] in ("", current["title"]):
                current["picture"] = i  # right below its heading: the faction's symbol
            else:
                current["nodes"].append(BeautifulSoup(f"<p>⟪{i}⟫</p>", "html.parser").p)
            continue
        if current.get("after") and el.name == "p":
            # A plain paragraph only: a box below the block (Out of the Abyss: "Variant: Derro
            # Savant") still belongs to the creature.
            after_block.append(el)
            continue
        if el.name == "figure":
            img = el.find("img")
            caption = el.find("figcaption")
            if img is not None and caption is not None:
                title = _text(caption.find(string=True, recursive=False) or caption).split(" View ")[0].strip()
                player = next((a.get("href") for a in caption.find_all("a") if "player" in (a.get("href") or "").lower()), None)
                current["maps"].append({"title": title or "Karte", "file": (img.get("src") or "").rsplit("/", 1)[-1],
                                        "src": img.get("src"), "player_src": player, "anchor": el.get("id")})
            continue
        current["nodes"].append(el)

    by_anchor = {r["anchor"]: r for r in rows if r["anchor"]}
    all_text = _text(article)
    # An appendix (magic items, monsters) is no session and no places: only its creatures and items
    # are worth importing, the rules around them are left out.
    appendix = bool(re.match(r"appendix\b", rows[0]["title"], re.I)) if rows else False
    out = []
    for r in rows:
        parent = by_anchor.get(r["parent"])
        name, use = r["title"], "merge"
        area = _AREA.match(r["title"])
        role = _ROLEPLAY.match(r["title"])
        md = _md(r["nodes"], chapter)
        row = {"anchor": r["anchor"], "ref": f"{chapter}#{r['anchor']}" if chapter and r["anchor"] else None,
               "level": r["level"], "title": r["title"], "parent": r["parent"], "maps": r["maps"],
               "picture": r.get("picture"), "pictures": r.get("pictures", [])}
        if r.get("monster"):
            m = r["monster"]
            out.append({**row, "name": m["name"], "use": "monster", "text": md, "summary": "", "monster": m})
            continue
        if r.get("item"):
            out.append({**row, "name": name, "use": "library_item", "text": md, "summary": "",
                        "item": parse_item(name, r["nodes"], chapter)})
            continue
        up = parent
        while up is not None and not (up.get("item") or up.get("monster")):
            up = by_anchor.get(up["parent"])
        if up is not None:
            # A subtitle of an item or creature (the Spell Gem's table, Orcus's lair and its lair
            # actions): its text goes along.
            use = "merge"
        elif appendix:
            use = "skip"
        elif intro:
            # All of it into the Einleitung, except who the campaign's sides are.
            section = parent
            while section is not None and section["level"] > 2:
                section = by_anchor.get(section["parent"])
            people = section is not None and _PEOPLE_SECTION.search(section["title"])
            if r["level"] == 1:
                use = "intro"
            elif people and r["level"] == 3 and not any(o["use"] == "faction" and o["name"] == name for o in out):
                use = "faction"  # "Giants" stands among the villains and the allies: one faction
            elif people and r["level"] == 4 and re.search(r"allies|verbündete", section["title"], re.I) \
                    and not _NOT_A_PERSON.match(r["title"]):
                use = "npc"
        elif r["level"] == 1:
            use = "session"
        elif r["level"] == 2:
            use = "location"
        elif r["level"] == 3 and area:
            use = "location"
            # "1. Cave Mouth" exists in many places; the section names them apart.
            name = f"{parent['title']} – {r['title']}" if parent else r["title"]
        elif role:
            use, name = "npc", _full_name(role.group(1).strip(), all_text)
        out.append({**row, "name": name, "use": use, "text": md, "summary": _summary(md)})
    # The book's name for the library's notes: the saved page's title is "Appendix B: Monsters - Lost
    # Mine of Phandelver - … - D&D Beyond"; the bookmarklet's copy has none, there the address names it ("lmop").
    page_title = soup.find("title")
    parts = _text(page_title).split(" - ") if page_title else []
    book = parts[1].strip() if len(parts) > 2 else None
    return {"chapter": chapter, "book": book or (chapter.split("/")[0] if chapter else None),
            "title": _text(heading) if heading else (rows[0]["title"] if rows else None), "rows": out,
            "pictures": pictures}


# ---------- import ----------

class ParseIn(BaseModel):
    campaign_id: int
    html: str
    # The introduction into this entry (the campaign's Kapitel "Kapitel 0: Einleitung").
    intro_entry_id: Optional[int] = None


class RowIn(BaseModel):
    anchor: Optional[str] = None
    ref: Optional[str] = None
    level: int
    title: str
    name: str
    # An entry type, "session" (the chapter: a planned session), "intro" (a book's introduction: into
    # the intro chapter, target_id), "merge" (text goes to the heading above) or "skip".
    use: str
    parent: Optional[str] = None
    text: str = ""
    summary: str = ""
    target_id: Optional[int] = None  # an existing entry (or session) to fill instead of a new one
    maps: list[dict] = []  # [{title, url}]: maps under this heading, uploaded (/uploads/…)
    # "monster" and "library_item": what goes to the bestiary and the item library (parse_stat_block,
    # parse_item); target_id is then the library's entry of that name, to replace. image_url: the
    # creature's picture, uploaded.
    monster: Optional[dict] = None
    item: Optional[dict] = None
    image_url: Optional[str] = None
    picture: Optional[int] = None  # an introduction's picture right below the heading (pictures[i])


class PictureIn(BaseModel):
    file: str = ""
    title: str = ""
    url: Optional[str] = None  # uploaded (/uploads/…); a picture not picked with the page is left out


class ImportIn(BaseModel):
    campaign_id: int
    chapter: Optional[str] = None
    book: Optional[str] = None
    rows: list[RowIn]
    pictures: list[PictureIn] = []


def _entries(conn, campaign_id: int) -> list[dict]:
    rows = conn.execute("SELECT id, type, name, body, image, parent_id, fields FROM entries WHERE campaign_id = ?",
                        (campaign_id,)).fetchall()
    return [{**dict(r), "fields": json.loads(r["fields"] or "{}")} for r in rows]


def _sessions(conn, campaign_id: int) -> list[dict]:
    return [dict(r) for r in conn.execute("SELECT id, number, title, prep, prep_en, ddb_ref FROM sessions WHERE campaign_id = ?",
                                          (campaign_id,))]


@router.post("/api/book/parse")
def parse(body: ParseIn):
    page = parse_chapter(body.html, intro=body.intro_entry_id is not None)
    if not page["rows"]:
        raise HTTPException(400, _t("Das Kapitel hat keine Überschriften – vermutlich nicht gekauft oder nicht angemeldet."))
    with get_conn() as conn:
        entries = _entries(conn, body.campaign_id)
        sessions = _sessions(conn, body.campaign_id)
        library = {use: {row["name"].lower(): dict(row) for row in conn.execute(f"SELECT id, name, source FROM {table}")}
                   for use, table in (("monster", "custom_monsters"), ("library_item", "custom_items"))}
    by_ref = {e["fields"].get("ddb_ref"): e for e in entries if e["fields"].get("ddb_ref")}
    for r in page["rows"]:
        if r["use"] in LIBRARY_USES:
            # Imported from D&D Beyond before: replaced. Anything else of that name (Open5e, the DM's
            # own) stays unless the DM picks it in the preview.
            old = library[r["use"]].get(r["name"].lower())
            r["library"] = {"id": old["id"], "name": old["name"]} if old else None
            r["imported_id"] = old["id"] if old and old["source"] == "ddb" else None
            r["target_id"] = r["imported_id"]
            if old and not r["imported_id"]:
                r["use"] = "skip"
        elif r["use"] in ENTRY_TYPES:
            # Imported before (same heading), or an entry of that name and type the DM made by hand.
            done = by_ref.get(r["ref"])
            same = next((e for e in entries if e["type"] == r["use"] and e["name"].lower() == r["name"].lower()), None)
            r["imported_id"] = done["id"] if done else None
            r["target_id"] = (done or same or {}).get("id")
        elif r["use"] == "intro":
            r["imported_id"] = None
            r["target_id"] = body.intro_entry_id
        elif r["use"] == "session":
            done = next((s for s in sessions if s["ddb_ref"] and s["ddb_ref"] == r["ref"]), None)
            same = next((s for s in sessions if s["title"].lower() == r["name"].lower()), None)
            r["imported_id"] = done["id"] if done else None
            r["target_id"] = (done or same or {}).get("id")
    page["entries"] = [{"id": e["id"], "type": e["type"], "name": e["name"]} for e in entries if e["type"] in ENTRY_TYPES]
    page["sessions"] = [{"id": s["id"], "name": f"{s['number']} · {s['title']}"} for s in sorted(sessions, key=lambda s: s["number"])]
    return page


def _merge_text(old: str, new: str) -> str:
    """The book's text into an entry: as it is if the entry has none, else below the DM's own."""
    if not new:
        return old
    if not old.strip():
        return new
    if new in old:
        return old  # imported before
    return f"{old.rstrip()}\n\n---\n\n{new}"


# What a chapter's session lists below its text, in this order.
_SESSION_LISTS = [("location", "Abschnitte"), ("place", "Orte"), ("npc", "NPCs"), ("faction", "Fraktionen"), ("quest", "Quests"),
                  ("item", "Gegenstände"), ("handout", "Handouts und Karten")]


@router.post("/api/book/import")
def import_rows(body: ImportIn):
    rows = body.rows
    by_anchor = {r.anchor: r for r in rows if r.anchor}
    # A creature or item for the library keeps its subtitles' text too, away from the campaign's entries.
    owners_uses = ENTRY_TYPES | {"session", "intro"} | LIBRARY_USES
    for r in rows:
        if r.use not in owners_uses | {"merge", "skip"}:
            raise HTTPException(400, _t("„{title}“: unbekannte Verwendung {use}", title=r.title, use=r.use))
        if (r.use == "monster" and not r.monster) or (r.use == "library_item" and not r.item):
            raise HTTPException(400, _t("„{title}“: kein Werteblock oder Gegenstand im Buch", title=r.title))
    # The chapter's title for grouping its places ("Part 1: Goblin Arrows"), and every heading's
    # position in it, so lists can follow the book instead of the alphabet.
    chapter_title = next((r.title for r in rows if r.level == 1), None)
    order = {id(r): i for i, r in enumerate(rows)}

    def owner(r: RowIn) -> Optional[RowIn]:
        """The row whose entry holds r's text: r itself, or the nearest heading above it that
        becomes an entry or the session (a skipped one takes its subtitles along)."""
        while r is not None:
            if r.use == "skip":
                return None
            if r.use in owners_uses:
                return r
            r = by_anchor.get(r.parent)
        return None

    # Maps go to the entry that holds their heading (Cragmaw Hideout for the one under "General
    # Features"), and each one becomes a handout of its own to show on the beamer.
    maps_of: dict[int, list[dict]] = {}
    for r in rows:
        o = owner(r)
        for m in r.maps:
            if m.get("url") and o is not None:
                maps_of.setdefault(id(o), []).append(m)

    # Text of every entry, its own and that of the subtitles merged into it, in page order.
    texts: dict[int, list[str]] = {}
    owners: dict[str, RowIn] = {}
    for r in rows:
        o = owner(r)
        if o is None:
            continue
        if r.anchor:
            owners[r.anchor] = o
        part = r.text
        if r.picture is not None and (r.use not in ENTRY_TYPES or r.use == "location"):
            part = f"⟪{r.picture}⟫\n\n{part}".strip()  # no entry to show it: in the text
        if r is not o:
            depth = max(3, min(6, r.level + 1))
            part = f"{'#' * depth} {r.title}\n\n{r.text}".strip()
        texts.setdefault(id(o), []).append(part)

    def book_fields(r: RowIn, fields: dict) -> dict:
        """Where the heading stands in the book. An entry imported before keeps its own place."""
        out = dict(fields)
        if r.ref:
            out.setdefault("ddb_ref", r.ref)
        if chapter_title:
            out.setdefault("ddb_chapter", chapter_title)
        out.setdefault("ddb_order", order[id(r)])
        return out

    with get_conn() as conn:
        entries = {e["id"]: e for e in _entries(conn, body.campaign_id)}
        by_ref = {e["fields"].get("ddb_ref"): e for e in entries.values() if e["fields"].get("ddb_ref")}
        ids: dict[int, int] = {}  # id(row) -> entry id
        names: dict[int, str] = {}
        for r in rows:
            if r.use not in ENTRY_TYPES:
                continue
            target = entries.get(r.target_id) if r.target_id else None
            if target is not None and target["type"] != r.use:
                raise HTTPException(409, _t("„{name}“: der gewählte vorhandene Eintrag ist ein anderer Typ.", name=r.name))
            if target is None:
                fields = book_fields(r, {})
                eid = conn.execute(
                    "INSERT INTO entries (campaign_id, type, name, status, fields, known) VALUES (?, ?, ?, ?, ?, 0)",
                    (body.campaign_id, r.use, r.name.strip(), "offen" if r.use == "quest" else "", json.dumps(fields))).lastrowid
                entries[eid] = {"id": eid, "type": r.use, "name": r.name.strip(), "body": "", "image": None,
                                "parent_id": None, "fields": fields}
            else:
                eid = target["id"]
            ids[id(r)] = eid
            names[id(r)] = entries[eid]["name"]
            if r.ref:
                by_ref[r.ref] = entries[eid]

        def link(m: re.Match, own: str) -> str:
            """A reference: a wiki link if its target is (in) another entry, else just its words
            (also for "see Developments" within the same entry)."""
            ref, label = m.group(1), m.group(2)
            anchor = ref.split("#", 1)[1] if "#" in ref else None
            same_chapter = body.chapter and ref.split("#", 1)[0] == body.chapter
            o = owners.get(anchor) if same_chapter and anchor else None
            name = names.get(id(o)) if o is not None else (by_ref.get(ref) or {}).get("name")
            if not name or name == own:
                return label
            return f"[[{name}]]" if name.lower() == label.lower() else f"[[{name}|{label}]]"

        def picture(m: re.Match) -> str:
            i = int(m.group(1))
            p = body.pictures[i] if i < len(body.pictures) else None
            return f"![{p.title}]({p.url})" if p is not None and p.url else ""

        def text_of(r: RowIn, own: str) -> str:
            text = _TOKEN_RE.sub(lambda m: link(m, own), "\n\n".join(p for p in texts.get(id(r), []) if p))
            return re.sub(r"\n{3,}", "\n\n", _PIC_RE.sub(picture, text)).strip()

        done = []
        chapter_entries: list[int] = []  # what the chapter's session links to, in book order
        for r in rows:
            if id(r) not in ids:
                continue
            eid = ids[id(r)]
            e = entries[eid]
            text = text_of(r, e["name"])
            original = e["fields"].get("body_en")
            if original is not None and (not text or text in original):
                values = {}  # translated before (content_translate.py): the German text stays
            else:
                values = {"body": _merge_text(e["body"] or "", text)}
            p = owner(by_anchor.get(r.parent)) if r.parent in by_anchor else None
            parent_id = ids.get(id(p)) if p is not None else None
            if parent_id and not e["parent_id"] and entries[parent_id]["type"] in PARENT_TYPES.get(r.use, set()):
                values["parent_id"] = parent_id
                e["parent_id"] = parent_id
            if maps_of.get(id(r)) and not e["image"]:
                values["image"] = maps_of[id(r)][0]["url"]
            elif r.picture is not None and r.use != "location" and not e["image"]:
                pic = body.pictures[r.picture] if r.picture < len(body.pictures) else None
                if pic is not None and pic.url:
                    values["image"] = e["image"] = pic.url
            if r.summary and original is None:
                values["summary"] = conn.execute("SELECT summary FROM entries WHERE id = ?", (eid,)).fetchone()["summary"] or r.summary
            fields = book_fields(r, e["fields"])
            if fields != e["fields"]:
                values["fields"] = json.dumps(fields)
            if values:
                cols = ", ".join(f"{k} = ?" for k in values)
                conn.execute(f"UPDATE entries SET {cols}, updated_at = datetime('now') WHERE id = ?", (*values.values(), eid))
            done.append(eid)
            chapter_entries.append(eid)
        for o_maps in maps_of.values():
            for m in o_maps:
                name = f"Karte: {m.get('title') or 'ohne Titel'}"
                old = next((e for e in entries.values() if e["type"] == "handout" and (e["image"] == m["url"] or e["name"] == name)), None)
                if old is not None:
                    chapter_entries.append(old["id"])  # imported before (perhaps a new upload of the same map)
                    continue
                fields = {"ddb_map": m.get("file"), "ddb_chapter": chapter_title} if chapter_title else {"ddb_map": m.get("file")}
                eid = conn.execute(
                    "INSERT INTO entries (campaign_id, type, name, image, fields, known) VALUES (?, 'handout', ?, ?, ?, 0)",
                    (body.campaign_id, name, m["url"], json.dumps(fields))).lastrowid
                entries[eid] = {"id": eid, "type": "handout", "name": name, "image": m["url"], "parent_id": None, "fields": fields}
                done.append(eid)
                chapter_entries.append(eid)

        # The chapter as a planned session (or the introduction in its chapter): its own text, then
        # links to what the chapter brought.
        session_ids = []
        sessions = {s["id"]: s for s in _sessions(conn, body.campaign_id)}
        for r in rows:
            if r.use not in ("session", "intro"):
                continue
            lists = []
            for etype, label in _SESSION_LISTS:
                # Sections and places only at their top level: the areas and buildings are inside them.
                picked = [entries[i] for i in dict.fromkeys(chapter_entries) if entries[i]["type"] == etype
                          and not (etype in ("location", "place") and entries[i]["parent_id"] in chapter_entries)]
                if picked:
                    lists.append(f"### {label}\n\n" + "\n".join(f"- [[{e['name']}]]" for e in picked))
            prep = "\n\n".join(x for x in (text_of(r, r.name), *lists) if x)
            if r.use == "intro":
                e = entries.get(r.target_id) if r.target_id else None
                if e is None or e["type"] != "location":
                    raise HTTPException(400, _t("Das Kapitel für die Einleitung fehlt."))
                original = e["fields"].get("body_en")
                if original is None or prep not in original:  # else translated before: the German text stays
                    summary = conn.execute("SELECT summary FROM entries WHERE id = ?", (e["id"],)).fetchone()["summary"]
                    conn.execute("UPDATE entries SET body = ?, summary = ?, updated_at = datetime('now') WHERE id = ?",
                                 (_merge_text(e["body"] or "", prep), summary or r.summary, e["id"]))
                done.append(e["id"])
                continue
            target = sessions.get(r.target_id) if r.target_id else None
            if target is None:
                number = conn.execute("SELECT COALESCE(MAX(number), 0) + 1 AS n FROM sessions WHERE campaign_id = ?",
                                      (body.campaign_id,)).fetchone()["n"]
                sid = conn.execute(
                    "INSERT INTO sessions (campaign_id, number, title, status, prep, ddb_ref) VALUES (?, ?, ?, 'planned', ?, ?)",
                    (body.campaign_id, number, r.name.strip(), prep, r.ref)).lastrowid
            else:
                sid = target["id"]
                if target.get("prep_en") is not None and prep in target["prep_en"]:
                    pass  # translated before: the German prep stays
                else:
                    conn.execute("UPDATE sessions SET prep = ?, ddb_ref = COALESCE(ddb_ref, ?), updated_at = datetime('now') "
                                 "WHERE id = ?", (_merge_text(target["prep"] or "", prep), r.ref, sid))
            session_ids.append(sid)

        monster_ids, item_ids = [], []
        note = f"Importiert von D&D Beyond ({body.book or body.chapter or 'Buch'})"
        for r in rows:
            if r.use not in LIBRARY_USES:
                continue
            # The text below the heading (and its subtitles): the item's description, the creature's
            # notes. Subtitles merged in keep their heading, as in the entries.
            text = _plain(text_of(r, r.name))
            if r.use == "monster":
                monster_ids.append(_save_monster(conn, r, text, note))
            else:
                # The item's own text without its type line (parse_item), then its subtitles.
                subtitles = _plain(_TOKEN_RE.sub(lambda m: link(m, r.name), "\n\n".join(p for p in texts.get(id(r), [])[1:] if p)))
                item_ids.append(_save_item(conn, r, note, subtitles))
    return {"imported": len(done), "ids": done, "sessions": session_ids, "monsters": monster_ids, "items": item_ids}


def _save_monster(conn, r: RowIn, lore: str, note: str) -> int:
    """A stat block into the bestiary: new, or over the one picked in the preview (a book's creature
    imported before). The DM's own notes on that one stay."""
    m = r.monster
    # The sheet shows saving throws, skills, alignment and the book's description (with its lair
    # and variants) in places of their own; the notes keep only where it came from, for the DM's own.
    stat_block = {**m["stat_block"], "saving_throws": m.get("saves"), "skills": m.get("skills"),
                  "alignment": m.get("alignment"), "description": lore or None}
    notes = note
    values = {"name": r.name.strip() or m["name"], "max_hp": m["max_hp"], "ac": m["ac"],
              "initiative_bonus": m.get("initiative_bonus") or 0, "challenge_rating": m.get("challenge_rating"),
              "creature_type": m.get("creature_type"), "stat_block": json.dumps(stat_block), "source": "ddb",
              "verified": 1}
    old = conn.execute("SELECT id, notes, source, avatar_path FROM custom_monsters WHERE id = ?",
                       (r.target_id,)).fetchone() if r.target_id else None
    if old is None:
        values.update(notes=notes, avatar_path=r.image_url)
        cols = ", ".join(values)
        return conn.execute(f"INSERT INTO custom_monsters ({cols}) VALUES ({', '.join('?' * len(values))})",
                            tuple(values.values())).lastrowid
    if old["source"] in ("ddb", "import") or not (old["notes"] or "").strip():
        values["notes"] = notes
    if r.image_url and not old["avatar_path"]:
        values["avatar_path"] = r.image_url
    values["stat_block_en"] = None  # the book's English again: a translation can be made anew
    conn.execute(f"UPDATE custom_monsters SET {', '.join(f'{k} = ?' for k in values)} WHERE id = ?",
                 (*values.values(), old["id"]))
    return old["id"]


_OLD_EXTRA = {"Rettungswürfe": "saving_throws", "Fertigkeiten": "skills", "Gesinnung": "alignment"}


def restructure_imported_monsters(conn) -> int:
    """Monsters imported before the sheet had places for them carry saving throws, skills,
    alignment and the book's text in their notes ("Importiert von D&D Beyond (oota)", then
    "Rettungswürfe: … · Fertigkeiten: … · Gesinnung: …", then the description). Moved into the
    stat block once, at start; the DM's own lines after them stay in the description, which shows
    them as they were. Returns how many were changed."""
    done = 0
    rows = conn.execute("SELECT id, notes, stat_block, stat_block_en FROM custom_monsters "
                        "WHERE source = 'ddb' AND notes LIKE 'Importiert von D&D Beyond%'").fetchall()
    for r in rows:
        sb = json.loads(r["stat_block"] or "{}")
        if "description" in sb:
            continue
        paras = (r["notes"] or "").split("\n\n")
        note, rest = paras[0].strip(), paras[1:]
        extra = {}
        if rest and any(rest[0].startswith(f"{label}:") for label in _OLD_EXTRA):
            for part in rest.pop(0).split(" · "):
                label, _, value = part.partition(":")
                if label.strip() in _OLD_EXTRA:
                    extra[_OLD_EXTRA[label.strip()]] = value.strip() or None
        moved = {"saving_throws": None, "skills": None, "alignment": None, **extra,
                 "description": "\n\n".join(rest).strip() or None}
        values = [json.dumps({**sb, **moved}), note]
        sql = "UPDATE custom_monsters SET stat_block = ?, notes = ?"
        if r["stat_block_en"]:
            sql += ", stat_block_en = ?"
            values.append(json.dumps({**json.loads(r["stat_block_en"]), **moved}))
        conn.execute(sql + " WHERE id = ?", (*values, r["id"]))
        done += 1
    return done


def _save_item(conn, r: RowIn, note: str, subtitles: str = "") -> int:
    it = r.item
    desc = "\n\n".join(x for x in (it.get("desc") or "", subtitles) if x)
    values = {"name": r.name.strip() or it["name"], "item_type": it.get("item_type"), "rarity": it.get("rarity"),
              "requires_attunement": int(bool(it.get("requires_attunement"))), "desc": desc,
              "source": "ddb", "notes": note}
    old = conn.execute("SELECT id, notes, source, avatar_path FROM custom_items WHERE id = ?",
                       (r.target_id,)).fetchone() if r.target_id else None
    if old is not None and old["source"] not in ("ddb", "import") and (old["notes"] or "").strip():
        del values["notes"]  # the DM's own
    if r.image_url and (old is None or not old["avatar_path"]):
        values["avatar_path"] = r.image_url
    if old is None:
        cols = ", ".join(values)
        return conn.execute(f"INSERT INTO custom_items ({cols}) VALUES ({', '.join('?' * len(values))})",
                            tuple(values.values())).lastrowid
    conn.execute(f"UPDATE custom_items SET {', '.join(f'{k} = ?' for k in values)} WHERE id = ?",
                 (*values.values(), old["id"]))
    return old["id"]
