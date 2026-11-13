# Wyrmdesk

Self-hosted web tools for running tabletop role-playing sessions (D&D 5e): a campaign book for the game
master, a combat tracker, a battlemap with fog of war for a projector, and a character creation for the
players. The UI is German by default and can be switched to English per browser.

> Deutsch: Die ausführliche Bedienungsanleitung steht in [LIESMICH.md](LIESMICH.md), Aufbau und
> Datenbanken in [DATENBANKEN.md](DATENBANKEN.md).

| Part | What it does | Address (local) |
|---|---|---|
| **Kampagnenbuch** (campaign book) | Campaigns, NPCs, places, quests, sessions and journal, player characters with a full character sheet, bestiary, items, spells, classes/species/backgrounds; handouts for the players | http://localhost:8440 |
| **Combat Tracker** | Encounters, initiative order, HP and conditions; a display for the players | http://localhost:8440/tracker/ |
| **Battlemap** | Maps, tokens, fog of war and line of sight; a projector view | http://localhost:8440/map/ |
| Player/projector views | Handouts, player pages, tracker display, beamer | http://localhost:8441 |
| **Charaktererstellung** (character creation) | Players create and level up their characters via a personal link; the game master imports them into the campaign book | http://localhost:8450 |

The campaign book, combat tracker and battlemap run in one container with one SQLite database. The
character creation is a separate service meant to be reachable by the players; it exchanges data with
the campaign book only through JSON export/import.

## Quick start

Requirements: Docker with Compose.

```
git clone https://github.com/OldNr7/Wyrmdesk.git wyrmdesk
cd wyrmdesk
cp .env.example .env              # optional: UI_LANG, DEEPL_API_KEY
docker compose up -d --build      # campaign book, tracker, battlemap on :8440 / :8441

cd charcreator
cp .env.example .env              # optional: ADMIN_PASSWORD
docker compose up -d --build      # character creation on :8450
```

Without `ADMIN_PASSWORD` the character creation generates a password on its first start and prints it
once to the log (`docker compose logs charcreator`); it is kept in the volume at `/data/admin-password`.

`docker compose down` stops the services, the data stays in the Docker volumes. **Never run
`docker compose down -v`**, that deletes all data. Backups can be downloaded and restored in the UI
(⚙ Einrichtung → Datensicherung); automatic backups are kept as well.

## Content

The repository ships no rules content apart from the SRD tables of the character sheet. Monsters,
spells, items, classes, species, backgrounds and feats are imported from the [Open5e](https://open5e.com)
API in the campaign book (the 5e SRD or all Open5e sources), or entered by hand. The character
creation gets them from the campaign book as a JSON export.

Optionally, the English texts of the library can be machine-translated to German with a free
[DeepL API](https://www.deepl.com/pro-api) key (`DEEPL_API_KEY`).

### D&D Beyond imports

The campaign book can import subclasses, species, backgrounds, feats and adventure chapters from
D&D Beyond pages. This only reads pages you open yourself in your browser while signed in to your own
account (via a bookmarklet or a saved page). **Use it only for content you have purchased, and only for
your own games.** Nothing from D&D Beyond is contained in this repository, and imported content must
not be redistributed.

## Security

- **The campaign book, combat tracker and battlemap have no login.** Run them in your own network
  only, or behind a reverse proxy that adds authentication. Do not expose ports 8440/8441 to the
  internet.
- The character creation is designed to be reachable from the internet: players use personal links,
  the administration is protected by the admin password. Put it behind a reverse proxy with HTTPS.

## Language

`UI_LANG` (`de` or `en`) sets the default language; every browser can switch it with the selector in
the page header. Stored game data (e.g. alignments, place types) stays in German and is translated when
shown. Contributors: German UI text is its own translation key, see [CLAUDE.md](CLAUDE.md) for the
conventions and `python tools/check-i18n.py` for missing English texts.

## Development

FastAPI and SQLite in Python 3.12, plain JavaScript/HTML/CSS without a build step. The code under
`dmtool/backend/app` is mounted into the local container, so changes to static files are live and
Python changes need a restart (`docker compose restart`). Conventions and structure: [CLAUDE.md](CLAUDE.md).

## Support

Wyrmdesk is free and stays free. If it is useful at your table and you want to say thanks, you can
support it via [GitHub Sponsors](https://github.com/sponsors/OldNr7). Donations are voluntary and
come with no claim to support or features; bug reports and ideas are just as welcome as
[issues](https://github.com/OldNr7/Wyrmdesk/issues).

## License

Copyright (C) 2026 the Wyrmdesk contributors.

Wyrmdesk is free software under the [GNU Affero General Public License v3.0](LICENSE): you may use,
change and share it, and if you run a changed version as a network service, you must offer its source
code to its users. Third-party material (SRD 5.1/5.2 under CC BY 4.0, icons from game-icons.net under
CC BY 3.0, libraries) is listed in [NOTICE.md](NOTICE.md).

Wyrmdesk is unofficial fan content, not approved, endorsed or sponsored by Wizards of the Coast or
D&D Beyond. Dungeons & Dragons, D&D and D&D Beyond are trademarks of Wizards of the Coast LLC.
