"""Finished characters from the Charaktererstellung, into a campaign of this Kampagnenbuch.

A sheet points to library entries by id: class, subclass, people, background and feats (char_options),
spells (custom_spells), items in the inventory and equipped ones (custom_items). Those ids are the ones
of the Kampagnenbuch the content pack was exported from, which need not be this one (the local copy and
the server have their own ids). So every reference is checked: an id whose entry carries the same name
stays, any other is looked up again by name (and ruleset), and one found nowhere loses its id - the
sheet then shows the name as "nicht in der Bibliothek" instead of a wrong entry.
"""
import base64
import binascii
import json
from pathlib import Path
from typing import Callable, Optional

from .characters import CharacterFields, new_version, set_play_state

OPTION_REFS = {"race_ref": "races", "background_ref": "backgrounds", "subclass_ref": "subclasses", "class_ref": "classes"}


class Library:
    def __init__(self, conn):
        self.options = [dict(r) for r in conn.execute("SELECT id, kind, name, name_en, is_2024 FROM char_options")]
        self.option_by_id = {o["id"]: o for o in self.options}
        self.spells = {r["id"]: r["name"] for r in conn.execute("SELECT id, name FROM custom_spells")}
        self.items = {r["id"]: r["name"] for r in conn.execute("SELECT id, name FROM custom_items")}
        self.changed = 0
        self.missing: list[str] = []

    @staticmethod
    def _names(*names) -> set[str]:
        return {str(n).strip().lower() for n in names if n}

    def option(self, kind: str, ref: Optional[dict]) -> Optional[dict]:
        if not isinstance(ref, dict) or not ref.get("name"):
            return ref
        names = self._names(ref.get("name"), ref.get("name_en"))
        same = lambda o: o["kind"] == kind and bool(names & self._names(o["name"], o["name_en"]))
        o = self.option_by_id.get(ref.get("id"))
        if o and same(o) and ("is_2024" not in ref or bool(o["is_2024"]) == bool(ref["is_2024"])):
            return ref
        hits = [x for x in self.options if same(x)]
        if "is_2024" in ref:
            hits = [x for x in hits if bool(x["is_2024"]) == bool(ref["is_2024"])] or hits
        # Without the ruleset on the sheet (older sheets): the same id's ruleset if it was a hit, else 2014 first.
        hits.sort(key=lambda x: (x["id"] != ref.get("id"), x["is_2024"]))
        if hits:
            if hits[0]["id"] != ref.get("id"):
                self.changed += 1
            return {**ref, "id": hits[0]["id"]}
        if ref.get("id") is not None:
            self.changed += 1
            self.missing.append(ref["name"])
        return {**ref, "id": None}

    def _by_name(self, table: dict[int, str], entry: dict, key: str) -> None:
        if not isinstance(entry, dict) or entry.get(key) is None:
            return
        name = str(entry.get("name") or "").strip().lower()
        if table.get(entry[key], "").strip().lower() == name:
            return
        hit = next((i for i, n in table.items() if n.strip().lower() == name), None) if name else None
        if hit is None:
            self.missing.append(entry.get("name") or f"#{entry[key]}")
        entry[key] = hit
        self.changed += 1

    def spell(self, entry: dict) -> None:
        self._by_name(self.spells, entry, "id")

    def item(self, entry: dict) -> None:
        self._by_name(self.items, entry, "item_id")


def remap_sheet(lib: Library, sb: dict, play_state: dict) -> None:
    for key, kind in OPTION_REFS.items():
        if sb.get(key):
            sb[key] = lib.option(kind, sb[key])
    # A third-party class is chosen as "lib:<id>" beside its ref.
    if str(sb.get("class_key") or "").startswith("lib:") and isinstance(sb.get("class_ref"), dict):
        new_id = sb["class_ref"].get("id")
        if new_id is not None:
            sb["class_key"] = f"lib:{new_id}"
    if isinstance(sb.get("feats"), list):
        sb["feats"] = [lib.option("feats", f) for f in sb["feats"]]
    for s in sb.get("spell_list") or []:
        lib.spell(s)
    for e in play_state.get("inventory") or []:
        lib.item(e)
    eq = sb.get("equipped")
    if isinstance(eq, dict):
        for k in ("armor", "shield"):
            lib.item(eq.get(k))
        for k in ("weapons", "worn"):
            for e in eq.get(k) or []:
                lib.item(e)


ACTIONS = ("skip", "replace", "copy")


def _free_name(name: str, taken: set) -> str:
    n = 2
    while f"{name} ({n})" in taken:
        n += 1
    return f"{name} ({n})"


# The Charaktererstellung's placeholder pictures per class (same set, see tools/check-shared.sh).
CLASS_PORTRAITS = Path(__file__).parent / "shared_static" / "class-portraits"


def _avatar_source(c: dict) -> Optional[tuple[bytes, str, bool]]:
    """The portrait of an exported character as (data, filename, trusted): its own picture from the
    export (avatar_data, base64), or else the placeholder of its class (avatar_class) from this
    tool's own copy - trusted, as no picture data of the file is used for it."""
    data = c.get("avatar_data")
    if data and c.get("avatar_name"):
        try:
            return base64.b64decode(data, validate=True), str(c["avatar_name"]), False
        except (binascii.Error, ValueError):
            return None
    cls = str(c.get("avatar_class") or "")
    if cls in {p.stem for p in CLASS_PORTRAITS.glob("*.svg")}:
        return (CLASS_PORTRAITS / f"{cls}.svg").read_bytes(), f"{cls}.svg", True
    return None


def import_characters(conn, campaign_id: int, chars: list, create_row, on_conflict: Optional[dict] = None,
                      set_avatar: Optional[Callable] = None) -> dict:
    """on_conflict says, by name, what happens to a character whose name the campaign already has:
    "skip" (the default) leaves it alone, "replace" takes over the sheet of the export and keeps the play
    state (HP, slots, inventory) of the one here, "copy" adds it as "Name (2)".
    set_avatar(conn, char_id, data, filename, trusted) stores the portrait of the export; a replaced character
    only gets it when it has none here yet (a picture chosen in the Kampagnenbuch stays)."""
    on_conflict = on_conflict or {}
    avatars = 0

    def take_avatar(c: dict, char_id: int) -> None:
        nonlocal avatars
        source = _avatar_source(c)
        if source is None or set_avatar is None:
            return
        try:
            set_avatar(conn, char_id, *source)
            avatars += 1
        except Exception:  # an unusable picture must not stop the import of the sheet
            pass

    rows = conn.execute("SELECT id, name FROM characters WHERE campaign_id = ? ORDER BY id", (campaign_id,)).fetchall()
    by_name = {}
    for r in rows:
        by_name.setdefault(r["name"], r["id"])
    taken = set(by_name)
    lib = Library(conn)
    imported = skipped = 0
    replaced = []
    for c in chars:
        name = (c.get("name") or "").strip()
        action = on_conflict.get(name, "skip") if name in taken else None
        if not name or action not in (None, *ACTIONS) or action == "skip":
            skipped += 1
            continue
        if action == "copy":
            name = _free_name(name, taken)
        sb = c.get("stat_block") or {}
        if isinstance(sb, str):
            sb = json.loads(sb or "{}")
        # The starting gear of the creation wizard lives in the play state (inventory, ammunition).
        play_state = c.get("play_state") or {}
        if isinstance(play_state, str):
            play_state = json.loads(play_state or "{}")
        remap_sheet(lib, sb, play_state)
        fields = CharacterFields(
            name=name, max_hp=c.get("max_hp") or 1, ac=c.get("ac") or 10,
            initiative_bonus=c.get("initiative_bonus") or 0, notes=c.get("notes"), stat_block=sb,
        )
        if action == "replace":
            # The sheet only: what happened in play stays (the starting gear of the export is not wanted twice).
            char_id = by_name[name]
            conn.execute(
                "UPDATE characters SET max_hp = ?, ac = ?, initiative_bonus = ?, notes = ?, stat_block = ?, "
                "updated_at = ?, current_hp = MIN(COALESCE(current_hp, ?), ?) WHERE id = ?",
                (fields.max_hp, fields.ac, fields.initiative_bonus, fields.notes, json.dumps(sb), new_version(),
                 fields.max_hp, fields.max_hp, char_id),
            )
            if not conn.execute("SELECT avatar_path FROM characters WHERE id = ?", (char_id,)).fetchone()["avatar_path"]:
                take_avatar(c, char_id)
            replaced.append(char_id)
            continue
        char = create_row(conn, campaign_id, fields)
        if play_state:
            set_play_state(conn, char["id"], play_state)
        take_avatar(c, char["id"])
        taken.add(name)
        imported += 1
    return {"imported": imported, "skipped": skipped, "replaced": len(replaced), "replaced_ids": replaced,
            "avatars": avatars, "remapped": lib.changed, "missing": sorted(set(lib.missing))}
