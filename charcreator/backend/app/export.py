"""Characters in the shape the Kampagnenbuch's import takes (char_import.py there): the DM's export of
the finished ones (admin.py) and a player's own download or share link (player.py, share.py)."""
import base64
import re
from pathlib import Path
from typing import Optional

from .db import UPLOAD_DIR

# The placeholder pictures per class (made by tools/creation-icons.py); the Kampagnenbuch has the same set.
CLASS_PORTRAITS = Path(__file__).parent / "shared_static" / "class-portraits"


def _portrait_class(stat_block: dict) -> Optional[str]:
    """English class name of the sheet, if there is a placeholder picture for it."""
    key = str(stat_block.get("class_key") or "")
    ref = stat_block.get("class_ref") or {}
    en = str(ref.get("name_en") or ref.get("name") or "").strip().lower() if key.startswith("lib:") else key
    return en if en and (CLASS_PORTRAITS / f"{en}.svg").is_file() else None


def avatar_export(avatar_path: Optional[str], stat_block: dict) -> dict:
    """The portrait goes into the export itself (base64), since the Kampagnenbuch can't reach this
    server's /uploads. Its avatar_path is dropped: it would point to a file the other side lacks.
    Without a picture of its own the character shows its class's here; the export then names the
    class (avatar_class), and the Kampagnenbuch takes that picture from its own copy of the set."""
    path = UPLOAD_DIR / avatar_path.rsplit("/", 1)[-1] if avatar_path else None
    if path and path.is_file():
        return {"avatar_path": None, "avatar_name": path.name, "avatar_data": base64.b64encode(path.read_bytes()).decode("ascii")}
    cls = _portrait_class(stat_block)
    return {"avatar_path": None, **({"avatar_class": cls} if cls else {})}


def export_character(ch: dict) -> dict:
    """A character row (stat_block/play_state already parsed) as one entry of the export list."""
    out = {**ch, **avatar_export(ch.get("avatar_path"), ch.get("stat_block") or {})}
    out.pop("share_token", None)  # the player's link, nothing for the DM's file
    return out


def export_filename(name: str) -> str:
    """File name for a download: the character's name, without what file systems dislike."""
    safe = re.sub(r"[^\w\- ]+", "", name or "", flags=re.UNICODE).strip().replace(" ", "-")
    return f"{safe or 'charakter'}.wyrmdesk.json"
