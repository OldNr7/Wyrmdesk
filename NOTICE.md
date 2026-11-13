# Notices and third-party material

Wyrmdesk is licensed under the GNU Affero General Public License v3.0 (see [LICENSE](LICENSE)).
The following parts come from others and keep their own licenses.

## Game rules: System Reference Document

This work includes material taken from the System Reference Document 5.1 ("SRD 5.1") and the System
Reference Document 5.2 ("SRD 5.2") by Wizards of the Coast LLC, available at
https://dnd.wizards.com/resources/systems-reference-document. The SRD 5.1 and SRD 5.2 are licensed
under the Creative Commons Attribution 4.0 International License, available at
https://creativecommons.org/licenses/by/4.0/legalcode.

This concerns the rule tables of the character sheet (spell slots, class features and resources,
weapons, armor, conditions) and the names of SRD content, partly translated into German.

## Content loaded at runtime

Monsters, spells, items, classes, species, backgrounds and feats are not part of this repository. The
Kampagnenbuch fetches them on request from the [Open5e](https://open5e.com) API; each entry keeps its
source (`document`), and its license is the one of that source (for the SRD: CC BY 4.0 as above; for
third-party publications, the license their publisher gives on Open5e).

The D&D Beyond imports only read pages the user opens in their own browser while signed in; nothing
from D&D Beyond is included here. See the section on imports in the [README](README.md).

## Icons

The class portraits (`shared_static/class-portraits/*.svg`) and the icons of the creation wizard
(`charcreator/backend/app/shared_static/creation-icons.svg`) are from [game-icons.net](https://game-icons.net)
by Lorc, Delapouite and other contributors, licensed under
[CC BY 3.0](https://creativecommons.org/licenses/by/3.0/).

## Libraries

| Library | Where | License |
|---|---|---|
| [marked](https://github.com/markedjs/marked) 12.0.2, © 2011–2024 Christopher Jeffrey | `dmtool/backend/app/shared_static/vendor/marked.min.js` | MIT |
| [Turndown](https://github.com/mixmark-io/turndown), © Dom Christie | `dmtool/backend/app/shared_static/vendor/turndown.js` | MIT |

Python dependencies (FastAPI, uvicorn, …) are installed from PyPI at build time, see the
`requirements.txt` of each service.

## Trademarks

Dungeons & Dragons, D&D, D&D Beyond and Forgotten Realms are trademarks of Wizards of the Coast LLC.
Wyrmdesk is unofficial fan content, not approved, endorsed or sponsored by Wizards of the Coast or
D&D Beyond.
