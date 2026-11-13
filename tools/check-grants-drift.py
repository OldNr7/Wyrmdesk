#!/usr/bin/env python3
"""The subclass-grant parser exists twice, like the character sheet (see check-shared.sh): in the
Kampagnenbuch (dmtool/backend/app/char_options.py) and in the Charaktererstellung
(charcreator/backend/app/grants.py). Both modules' own docstrings say to keep them in step; this
reports any of the shared constants or functions that have drifted apart.

Unlike the character sheet the two are not byte-identical files - char_options.py also has the
Open5e/DDB-import code grants.py doesn't - so this compares only the specific names both sides
define, by parsing (never importing) the two files.

  python3 tools/check-grants-drift.py
"""
import ast
import difflib
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FILE_A = ROOT / "dmtool/backend/app/char_options.py"
FILE_B = ROOT / "charcreator/backend/app/grants.py"

# Names both files define identically, by the two modules' own docstrings ("keep the two in step").
SHARED_NAMES = [
    "ABILITY_EN", "SKILL_EN", "COUNT", "_CHOICE", "_NOT_SPELLS",
    "parse_skills", "_split_names", "_class_lists", "_spell_table",
    "_parse_profs", "_parse_skill_grants", "_parse_language_grant",
    "_parse_spell_choices", "_parse_known_spells", "_parse_cantrip_damage",
    "parse_grants",
]


def _segments(path: Path) -> dict[str, str]:
    """Source text of each top-level assignment/function in SHARED_NAMES, keyed by name."""
    source = path.read_text()
    tree = ast.parse(source, filename=str(path))
    segments: dict[str, str] = {}
    for node in tree.body:
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id in SHARED_NAMES:
                    segments[target.id] = ast.get_source_segment(source, node)
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in SHARED_NAMES:
            segments[node.name] = ast.get_source_segment(source, node)
    return segments


def main() -> int:
    a, b = _segments(FILE_A), _segments(FILE_B)
    missing = [f"{name} (in {FILE_A.name if name not in a else FILE_B.name})"
               for name in SHARED_NAMES if name not in a or name not in b]
    if missing:
        print("Nicht in beiden Dateien gefunden: " + ", ".join(missing))
        return 1

    drifted = []
    for name in SHARED_NAMES:
        if a[name] != b[name]:
            drifted.append(name)
            print(f"\n--- {name} ist unterschiedlich ---")
            sys.stdout.writelines(difflib.unified_diff(
                a[name].splitlines(keepends=True), b[name].splitlines(keepends=True),
                fromfile=str(FILE_A.relative_to(ROOT)), tofile=str(FILE_B.relative_to(ROOT)),
            ))

    if drifted:
        print(f"\n{len(drifted)} von {len(SHARED_NAMES)} geteilten Namen sind auseinandergelaufen "
              "(siehe Diff oben) - beide Module sagen in ihrem Docstring, sie sollen gleich bleiben.")
        return 1
    print(f"OK: alle {len(SHARED_NAMES)} geteilten Namen sind in {FILE_A.relative_to(ROOT)} und "
          f"{FILE_B.relative_to(ROOT)} identisch.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
