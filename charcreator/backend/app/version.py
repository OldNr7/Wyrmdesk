"""The Wyrmdesk version: VERSION next to this file, a copy of the one in the repository root
(tools/check-shared.sh --copy). One number for the whole repository, see CHANGELOG.md."""
import re
from pathlib import Path

VERSION = Path(__file__).with_name("VERSION").read_text(encoding="utf-8").strip()


def parse(version: str) -> tuple[int, ...]:
    """'0.1.0' -> (0, 1, 0); a suffix such as '-beta' is ignored, anything unreadable is (0,)."""
    m = re.match(r"\s*v?(\d+(?:\.\d+)*)", str(version or ""))
    return tuple(int(p) for p in m.group(1).split(".")) if m else (0,)
