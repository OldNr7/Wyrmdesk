"""Best-effort extraction of D&D stat blocks from a purchased .odt/.docx
sourcebook chapter. Formatting varies between publishers, so this is a
heuristic parser, not a guaranteed-correct one — every monster it produces is
meant to be reviewed (and corrected if needed) by the DM before it's trusted,
which is why callers save the result with verified=0."""

import re
import zipfile
from io import BytesIO

from .statblock import build_stat_block

TAG_RE = re.compile(r"<[^>]+>")
WS_RE = re.compile(r"[ \t]+")

SIZES = "Tiny|Small|Medium|Large|Huge|Gargantuan"
SIZE_TYPE_RE = re.compile(
    rf"^(?:{SIZES})\s+([A-Za-z][A-Za-z /]*?)(?:\s*\(([^)]*)\))?,\s*(.+)$"
)
# Some exports render the modifier's minus as the Unicode minus sign (U+2212)
# rather than a hyphen, so both are accepted.
ABILITY_RE = re.compile(r"(-?\d+)\s*\([+\-−]?\d+\)")
ABILITY_VALUE_LINE_RE = re.compile(r"^(\d+)\s*\([+\-−]?\d+\)$")
ABILITY_LABELS = ["str", "dex", "con", "int", "wis", "cha"]
TRAIT_RE = re.compile(r"^([A-Z][^.]{1,90}?)\.\s+(.+)$")

FIELD_PATTERNS = {
    "ac": re.compile(r"^Armor Class\s+(\d+)", re.IGNORECASE),
    "hp": re.compile(r"^Hit Points\s+(\d+)", re.IGNORECASE),
    "speed": re.compile(r"^Speed\s+(.+)$", re.IGNORECASE),
    "senses": re.compile(r"^Senses\s+(.+)$", re.IGNORECASE),
    "languages": re.compile(r"^Languages\s+(.+)$", re.IGNORECASE),
    "damage_vulnerabilities": re.compile(r"^Damage Vulnerabilities\s+(.+)$", re.IGNORECASE),
    "damage_resistances": re.compile(r"^Damage Resistances\s+(.+)$", re.IGNORECASE),
    "damage_immunities": re.compile(r"^Damage Immunities\s+(.+)$", re.IGNORECASE),
    "condition_immunities": re.compile(r"^Condition Immunities\s+(.+)$", re.IGNORECASE),
}
CHALLENGE_RE = re.compile(r"^Challenge\s+([\d/]+)", re.IGNORECASE)

# Canonical section a heading line switches into; anything not listed falls
# under "special_abilities" (the unheaded traits block right after Challenge).
SECTION_HEADERS = {
    "actions": "actions",
    "bonus actions": "actions",
    "reactions": "reactions",
    "legendary actions": "legendary_actions",
}


def _ability_mod(score) -> int:
    if score is None:
        return 0
    return (int(score) - 10) // 2


def _finalize_lines(xml: str) -> str:
    """Shared tail of both extractors: drop the remaining tags, unescape
    entities, and collapse each paragraph/row down to one clean line."""
    text = TAG_RE.sub("", xml)
    text = (
        text.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", '"')
        .replace("&apos;", "'")
    )
    lines = [WS_RE.sub(" ", ln).strip() for ln in text.split("\n")]
    return "\n".join(ln for ln in lines if ln)


def extract_text_odt(odt_bytes: bytes) -> str:
    try:
        with zipfile.ZipFile(BytesIO(odt_bytes)) as z:
            xml = z.read("content.xml").decode("utf-8")
    except (zipfile.BadZipFile, KeyError) as exc:
        raise ValueError("Datei ist kein gültiges .odt") from exc

    xml = xml.replace("<text:line-break/>", "\n").replace("<text:tab/>", " ")
    xml = re.sub(r"</text:(p|h)>", "\n", xml)
    xml = re.sub(r"</table:table-cell>", "\t", xml)
    xml = re.sub(r"</table:table-row>", "\n", xml)
    return _finalize_lines(xml)


def extract_text_docx(docx_bytes: bytes) -> str:
    try:
        with zipfile.ZipFile(BytesIO(docx_bytes)) as z:
            xml = z.read("word/document.xml").decode("utf-8")
    except (zipfile.BadZipFile, KeyError) as exc:
        raise ValueError("Datei ist kein gültiges .docx") from exc

    xml = re.sub(r"<w:br\s*/>", "\n", xml)
    xml = re.sub(r"<w:tab\s*/>", " ", xml)
    xml = re.sub(r"</w:p>", "\n", xml)
    xml = re.sub(r"</w:tc>", "\t", xml)
    xml = re.sub(r"</w:tr>", "\n", xml)
    return _finalize_lines(xml)


def _split_blocks(lines: list[str]) -> list[list[str]]:
    """A new stat block starts wherever a 'Small Humanoid, Chaotic Evil'-style
    line is immediately preceded by its monster's name line."""
    starts = [
        i - 1
        for i in range(1, len(lines))
        if SIZE_TYPE_RE.match(lines[i]) and not SIZE_TYPE_RE.match(lines[i - 1])
    ]
    blocks = []
    for idx, start in enumerate(starts):
        end = starts[idx + 1] - 1 if idx + 1 < len(starts) else len(lines)
        blocks.append(lines[start:end])
    return blocks


def _parse_features(body_lines: list[str]) -> tuple[dict, str | None]:
    sections: dict[str, list[dict]] = {"special_abilities": [], "actions": [], "reactions": [], "legendary_actions": []}
    current = "special_abilities"
    legendary_desc = None
    for ln in body_lines:
        header = SECTION_HEADERS.get(ln.strip().lower().rstrip(":"))
        if header:
            current = header
            continue
        m = TRAIT_RE.match(ln)
        if m:
            sections[current].append({"name": m.group(1).strip(), "desc": m.group(2).strip()})
        elif current == "legendary_actions" and not sections[current]:
            legendary_desc = f"{legendary_desc} {ln}" if legendary_desc else ln
        elif sections[current]:
            sections[current][-1]["desc"] += f" {ln}"
    return sections, legendary_desc


def _abilities_from_values(lines: list[str], start: int, value_at) -> list | None:
    values = []
    for j in range(6):
        m = ABILITY_VALUE_LINE_RE.match(lines[value_at(start, j)].strip())
        if not m:
            return None
        values.append(int(m.group(1)))
    return values


def _extract_abilities(lines: list[str]) -> tuple[list, list[str]]:
    """The six ability scores show up in one of a few shapes depending on how
    the source document's table survived conversion to plain text:
    - one line with six inline 'score (mod)' groups (a table row kept intact)
    - six label lines (STR/DEX/.../CHA) directly followed by six value lines
      (a table whose columns became two stacked rows of one-cell-per-line)
    - six alternating label/value line pairs (STR / 20(+5) / DEX / 8(-1) / ...)
    Returns the six raw scores in str/dex/.../cha order (None for any not
    found) and the lines with that table removed."""
    for i in range(len(lines) - 11):
        if [lines[i + j].strip().lower() for j in range(6)] != ABILITY_LABELS:
            continue
        values = _abilities_from_values(lines, i, lambda s, j: s + 6 + j)
        if values:
            return values, lines[:i] + lines[i + 12 :]

    for i in range(len(lines) - 11):
        if not all(lines[i + 2 * j].strip().lower() == ABILITY_LABELS[j] for j in range(6)):
            continue
        values = _abilities_from_values(lines, i, lambda s, j: s + 2 * j + 1)
        if values:
            return values, lines[:i] + lines[i + 12 :]

    for idx, ln in enumerate(lines):
        scores = ABILITY_RE.findall(ln)
        if len(scores) >= 6:
            return [int(s) for s in scores[:6]], lines[:idx] + lines[idx + 1 :]

    return [None] * 6, lines


def _parse_block(lines: list[str]) -> dict | None:
    if len(lines) < 2:
        return None
    name = lines[0]
    type_match = SIZE_TYPE_RE.match(lines[1])
    if not type_match:
        return None

    type_word = type_match.group(1).strip().lower()
    subtype = type_match.group(2)
    creature_type = f"{type_word} ({subtype.lower()})" if subtype else type_word

    abilities_raw, remaining = _extract_abilities(lines[2:])

    fields: dict[str, str] = {}
    challenge_rating = None
    body_lines: list[str] = []

    for ln in remaining:
        matched_field = False
        for key, pattern in FIELD_PATTERNS.items():
            m = pattern.match(ln)
            if m:
                fields[key] = m.group(1).strip()
                matched_field = True
                break
        if matched_field:
            continue

        m = CHALLENGE_RE.match(ln)
        if m:
            challenge_rating = m.group(1)
            continue

        body_lines.append(ln)

    ac = int(fields["ac"]) if fields.get("ac", "").isdigit() else None
    hp = int(fields["hp"]) if fields.get("hp", "").isdigit() else None
    str_, dex, con, int_, wis, cha = abilities_raw

    sections, legendary_desc = _parse_features(body_lines)

    return {
        "name": name,
        "max_hp": hp,
        "ac": ac,
        "initiative_bonus": _ability_mod(dex),
        "challenge_rating": challenge_rating,
        "creature_type": creature_type,
        "stat_block": build_stat_block(
            abilities={"str": str_, "dex": dex, "con": con, "int": int_, "wis": wis, "cha": cha},
            challenge_rating=challenge_rating,
            size=lines[1].split()[0].capitalize(),  # SIZE_TYPE_RE: the line starts with it
            speed=fields.get("speed"),
            senses=fields.get("senses"),
            languages=fields.get("languages"),
            damage_vulnerabilities=fields.get("damage_vulnerabilities"),
            damage_resistances=fields.get("damage_resistances"),
            damage_immunities=fields.get("damage_immunities"),
            condition_immunities=fields.get("condition_immunities"),
            legendary_desc=legendary_desc,
            **sections,
        ),
    }


def parse_monster_document(data: bytes, filename: str) -> list[dict]:
    ext = filename.lower().rsplit(".", 1)[-1] if "." in filename else ""
    if ext == "odt":
        text = extract_text_odt(data)
    elif ext == "docx":
        text = extract_text_docx(data)
    else:
        raise ValueError("nur .odt und .docx Dateien werden unterstützt")

    monsters = []
    for block in _split_blocks(text.split("\n")):
        parsed = _parse_block(block)
        if parsed:
            monsters.append(parsed)
    return monsters
