# Icons of the Charaktererstellung's creation wizard: writes the sprite (creation-icons.svg) and the
# placeholder portraits per class (class-portraits/*.svg) from the game-icons.net set (CC BY 3.0).
# The names here and the mapping in creation.js (WIZ_*) go together: change both.
#
#   curl -o gi.json https://cdn.jsdelivr.net/npm/@iconify-json/game-icons@1.2.1/icons.json
#   python tools/creation-icons.py gi.json charcreator/backend/app/shared_static
#   sh tools/check-shared.sh --copy     (the Kampagnenbuch has a copy of the class portraits)
#
# Icons can be looked at on https://game-icons.net (same names).
import json, re, sys
from pathlib import Path
gi = json.load(open(sys.argv[1], encoding="utf-8"))["icons"]
out = Path(sys.argv[2])
CLASSES = {
  "barbarian": ("battle-axe", "#9b2c22"), "bard": ("lyre", "#7a3f8c"), "cleric": ("holy-symbol", "#a07a12"),
  "druid": ("oak-leaf", "#3f6b22"), "fighter": ("crossed-swords", "#55606b"), "monk": ("fist", "#9a6a1c"),
  "paladin": ("templar-shield", "#6f7f8c"), "ranger": ("high-shot", "#2f5d3a"), "rogue": ("cloak-dagger", "#3a3530"),
  "sorcerer": ("fire-ray", "#b8521a"), "warlock": ("warlock-eye", "#4b2a6b"), "wizard": ("wizard-staff", "#2b4f86"),
  "marshal": ("knight-banner", "#7a1f1f"), "mechanist": ("gear-hammer", "#8a5a2b"),
}
RACES = "vitruvian-man woman-elf-face spider-face elf-ear dwarf-face pointy-hat hobbit-door brute orc-head dragon-head devil-mask giant cat shambling-zombie lizardman hood".split()
BGS = "prayer open-book spartan-helmet domino-mask crown star-medal compass dig-dug scroll-unfurled".split()
names = sorted({v[0] for v in CLASSES.values()} | set(RACES) | set(BGS))
assert all(n in gi for n in names), [n for n in names if n not in gi]
head = ('<svg xmlns="http://www.w3.org/2000/svg">\n<!-- Icons for the creation wizard (peoples, classes, backgrounds), from game-icons.net by Lorc, Delapouite and others,\n'
        '     CC BY 3.0 (https://creativecommons.org/licenses/by/3.0/). Mapping by English name: creation.js (WIZ_*). -->\n')
(out / "creation-icons.svg").write_text(head + "".join(f'<symbol id="{n}" viewBox="0 0 512 512">{gi[n]["body"]}</symbol>\n' for n in names) + "</svg>\n", encoding="utf-8", newline="\n")
def mix(c, t):
    r, g, b = (int(c[i:i + 2], 16) for i in (1, 3, 5))
    return "#%02x%02x%02x" % tuple(round(x + (255 - x) * t) for x in (r, g, b))
pdir = out / "class-portraits"
pdir.mkdir(exist_ok=True)
for en, (icon, color) in CLASSES.items():
    svg = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">\n'
           f'<!-- Placeholder portrait of the class ({en}); icon from game-icons.net, CC BY 3.0. -->\n'
           f'<defs><radialGradient id="g" cx="35%" cy="30%" r="85%"><stop offset="0" stop-color="{mix(color, 0.3)}"/><stop offset="1" stop-color="{color}"/></radialGradient></defs>\n'
           '<rect width="512" height="512" fill="url(#g)"/>\n'
           f'<g transform="translate(96 96) scale(0.625)" color="#f3dca0">{gi[icon]["body"]}</g>\n</svg>\n')
    (pdir / f"{en}.svg").write_text(svg, encoding="utf-8", newline="\n")
print(len(names), "icons,", len(CLASSES), "portraits")
