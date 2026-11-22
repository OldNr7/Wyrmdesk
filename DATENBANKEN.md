# Datenbanken von Wyrmdesk

Seit der Zusammenlegung der Tools teilen sich
Kampagnenbuch, Combat Tracker und Battlemap **eine** SQLite-Datei. Die Charaktererstellung hat ihre
eigene und tauscht nur per manuellem JSON-Export/Import aus.

| Tool | DB-Datei | Rolle |
|---|---|---|
| Kampagnenbuch (`dmtool`) mit Tracker (`app/combat`) und Battlemap (`app/battlemap`) | `/data/dmtool.db` | Kampagnen, Spielercharaktere, Bestiarium, Items, Zauber, Klassen/Völker/Hintergründe, **und** Encounter/Kämpfer, Szenen/Tokens |
| Charaktererstellung (`charcreator`) | `/data/charcreator.db` | Eigenständig, öffentlich erreichbar; Inhalte sind eine hochgeladene Kopie, Charaktere sind eigene Entwürfe |

Die früheren Dateien `combattracker.db` und `battlemap.db` (mit ihren Bildordnern, in den alten
Volumes unter `/data/combat` und `/data/battlemap`) hat `merge.py` beim ersten Start einmal kopiert;
sie werden seither nicht mehr geöffnet, aber auch nicht gelöscht. Vor dem Kopieren legt `merge.py`
`/data/before-merge.db` an.

## Gemeinsames Muster aller vier Schemas

- `app_settings` (`key`/`value`, Werte JSON-codiert) für Einstellungen, die nicht zu einer Kampagne/einem
  Datensatz gehören.
- `created_at`/`updated_at` als `TEXT` (`datetime('now')`); mehrere Tabellen tragen zusätzlich ein
  optimistisches `updated_at`-Versionsfeld, das ein Speichern mit veraltetem Stand ablehnt (409).
- Verschachtelte/variable Daten liegen als JSON in `TEXT`-Spalten (`stat_block`, `play_state`, `fields`,
  `calendar`, `data`, …), nicht in eigenen Tabellen.
- `schema.sql` wird bei jedem Start per `conn.executescript(...)` angewendet (`CREATE TABLE IF NOT
  EXISTS`, daher ungefährlich bei bereits existierender DB). Nachträglich hinzugekommene Spalten laufen
  über ein `MIGRATIONS`-Dict pro Tabelle, das fehlende Spalten per `ALTER TABLE ... ADD COLUMN` ergänzt
  (nur `dmtool`, `combattracker`, `battlemap` haben solche Migrationen; `charcreator` ist neu genug, dass
  es noch keine braucht).
- Die `characters`-Tabelle hat in `dmtool`, `combattracker` (Altlast, s. u.) und `charcreator` fast
  identische Spalten (`name`, `max_hp`, `ac`, `initiative_bonus`, `notes`, `stat_block`,
  `current_hp`/`temp_hp`/`play_state`/`state_updated_at`). Das ist bewusst so: Export/Import und die
  Sync-Aufrufe zwischen den Services verschieben diese Felder 1:1, ohne sie umzuformen.
- Die Trennung **Charakterblatt vs. Spielzustand** zieht sich durch: `max_hp`/`ac`/`notes`/`stat_block`
  ändern sich nur beim Bearbeiten des Blatts (mit Versionsprüfung über `updated_at`); `current_hp`,
  `temp_hp` und `play_state` (verbrauchte Zauberplätze, Munition, Ausrüstung, Rast-Verbrauch) ändern sich
  während des Spiels unabhängig davon und werden nie vom Sheet-Save überschrieben. Auch der
  Spielzustand ist gegen gleichzeitige Änderungen geschützt: die Spielerseite schickt bei
  `PUT …/play-state` den Stand mit, von dem sie ausging (`base`); weicht der gespeicherte inzwischen ab
  (zweites Gerät, Spielleiter), kommt 409 und die Seite lädt neu, statt zu überschreiben.

## Kampagnenbuch (dmtool)

| Tabelle | Zweck |
|---|---|
| `campaigns` | Eine Zeile pro Kampagne, inkl. Kalender (`calendar`) und aktuellem Spieldatum (`today`). |
| `entries` | Journal/Index: NPCs, Orte (`type='place'`, Art in `fields.kind`), Kapitel-Abschnitte aus dem Buchimport (`type='location'`, in der Oberfläche „Kapitel“), Fraktionen, Items, Quests, Handouts **und** `type='pc'`-Einträge, die nur Notizen/Verlinkung zu einem Charakter sind (`characters.entry_id`). Aus einem Abenteuer importierte tragen in `fields` ihre Stelle im Buch: `ddb_ref` (Überschrift), `ddb_chapter` (Kapiteltitel), `ddb_order` (Position im Kapitel). |
| `sessions` | Sitzungsprotokolle; `encounter_ids` verweist auf `encounters.id`. `ddb_ref`: aus welchem Kapitel eines D&D-Beyond-Abenteuers die Session stammt (Buchimport, `book_import.py`). `tracker_session_id` stammt aus dem einmaligen Import der alten Tracker-Sessions. |
| `events` | Zeitstrahl-Ereignisse im Kampagnendatum. |
| `documents` | Diverse Dokumente einer Kampagne: PDFs und Bilder (Datei unter `/uploads/`), Texte, Tabellen. |
| `characters` | Die eigentlichen, kampffähigen Charakterblätter: `max_hp`, `ac`, `initiative_bonus`, `notes`, `stat_block` (JSON), plus Spielzustand `current_hp`/`temp_hp`/`play_state`/`state_updated_at`. `avatar_path` zeigt auf `uploads/…`. |
| `custom_monsters`, `custom_items`, `custom_spells` | Bestiarium, Gegenstände, Zauber — kampagnenübergreifend. Jedes Monster hat im `stat_block` die Grösse (`size`: `Tiny` … `Gargantuan`, `null` wenn unbekannt; ältere Einträge einmal von Open5e ergänzt, `library.fill_monster_sizes`). Monster aus dem D&D-Beyond-Buchimport (`source='ddb'`) tragen im `stat_block` zusätzlich `saving_throws`, `skills`, `alignment` und `description` (Buchtext als Markdown). |
| `campaign_templates` | Kampagnenvorlagen (`templates.py`): Schnappschuss einer Kampagne als JSON in `data` (Einträge, Sessions, Ereignisse, Charaktere, Encounter mit Kämpfern, Szenen mit Tokens, mit den alten Ids). Kartenbilder und Nebelmasken als eigene Kopien `tpl-…` im Ordner `maps`, gelöscht mit der Vorlage. Eine Kampagne daraus bekommt neue Ids, Verweise werden umgeschrieben. |
| `char_options` | Klassen, Unterklassen, Völker, Hintergründe, Talente für das Charakterblatt (`kind`, `name`/`name_en`, `parent`, `is_2024`, `data` JSON, `desc`). |
| `encounters` | Kämpfe (Tracker): `campaign_id`, Runde, aktueller Zug (`current_combatant_id`). |
| `combatants` | Die Kämpfer eines Encounters (`source`: `roster` mit `ref_id` = `characters.id`, `custom` mit `ref_id` = `custom_monsters.id`, `open5e`, `manual`). Monster sind **Kopien** mit eigenen TP. |
| `combatant_view` (View) | Was der Tracker liest: Für `source='roster'` kommen TP, temporäre TP, RK, Initiativebonus, Werte und Bild **aus `characters`**; ein Kämpfer der Gruppe ist also der Charakter selbst. Die eigenen Spalten gelten nur, wenn der Charakter fehlt (gelöscht: dann wird der Kämpfer `manual` mit dessen letzten Werten). |
| *Übersetzt (DeepL)* | Kampagnentexte werden ersetzt, das Original bleibt: `entries.fields.body_en`/`summary_en`, `sessions.prep_en`, `custom_monsters.stat_block_en` (`content_translate.py`). |
| `scenes`, `tokens` | Battlemap: Karte, Raster, Nebel, Wände, Sicht, Zauberflächen; `scenes.campaign_id` ordnet eine Szene einer Kampagne zu (NULL: noch keiner, erscheint in jeder). Tokens mit optionalem `combatant_id`. |
| `app_settings` | Einstellungen; Tracker unter `tracker.<key>` (angezeigter Encounter, Stream-Deck-Zähler), Battlemap unter `map.<key>` (PPI, Rotation, Keystone, Blackout, …), Kampagnenbuch ohne Präfix, `merge.done` als Marker der Zusammenführung. |

Dateien liegen daneben: `uploads/` (Kampagnenbuch), `avatars/` (ältere Tracker-Porträts), `maps/`,
`tokens/` und `beamer_images/` (Battlemap, „Bild statt Battlemap“). Das Backup (`/api/backup`) enthält die
Datenbank und alle fünf Ordner.

## Charaktererstellung (charcreator)

| Tabelle | Zweck |
|---|---|
| `campaigns` | Eine Zeile pro Einladungslink (`token`, zufällig, Teil der URL `/k/<token>/`). |
| `char_options`, `items`, `spells` | **Kopie** von `dmtool.char_options`/`custom_items`/`custom_spells`, per Admin-Upload (`POST /api/admin/content`) komplett ersetzt — kein Live-Abgleich. |
| `characters` | Charakterentwürfe der Spieler, gleiche Spaltenform wie `dmtool.characters` plus `player_name`, `status` (`draft`/`fertig`) und `exported_at`. |

## Wie die Teile zusammenspielen

Kampagnenbuch, Tracker und Battlemap laufen in einem Prozess (`dmtool/backend/app/run.py`) auf einer
Datenbank:

- **Ein Kämpfer der Gruppe ist der Charakter.** Schaden oder Heilung im Tracker schreibt
  `characters.current_hp`/`temp_hp` (`set_character_hp`), das Spielerblatt ebenso; beide sehen dieselbe
  Zeile. Es gibt nichts mehr abzugleichen (früher: Sync per HTTP, Differenzrechnung, Prune).
- **Charakter gelöscht:** `tracker.unlink_character` schreibt seine letzten Werte in die Kämpfer und
  macht sie zu `manual` — in derselben Transaktion wie das Löschen.
- **Benachrichtigung:** Ändert sich ein Charakter, setzt das Kampagnenbuch `tracker.roster_rev`; die
  Spielleiteransicht des Trackers lädt dann neu. Jede Änderung in einem Kampf weckt über
  `internal.changed()` den Beobachter der Battlemap, der Beamer folgt sofort.
- **APIs bleiben:** Die Teile rufen einander noch über ihre HTTP-APIs auf (Battlemap → Tracker für
  Zug/TP/Zustände, Tracker → Kampagnenbuch für Monster und Bilder), aber im Prozess über
  `internal.py` statt übers Netz.
- **Adressen:** Spielleiter `:8440` (`/tracker/`, `/map/`), Beamer `:8441` (`/anzeige/tracker/`,
  `/beamer/`, Handouts an der Wurzel). Die alten Ports 8420/8421/8430 bedient derselbe Prozess
  übergangsweise, 8431 leitet auf `/beamer/` weiter.

### Charaktererstellung: bewusst ohne Live-Verbindung

`charcreator` hat keine `TRACKER_URL`/`DMTOOL_URL`-Umgebungsvariable und läuft als eigener Stack,
weil kein Service auf den anderen zur Laufzeit angewiesen ist. Der Datenaustausch läuft manuell über den
Spielleiter, in beide Richtungen als JSON-Datei:

1. **Inhalte hinein:** Kampagnenbuch → `GET /api/library/export` bündelt `char_options`, `custom_items`,
   `custom_spells` als Download. Der Spielleiter lädt diese Datei im Charaktererstellung-Admin
   (`POST /api/admin/content`) hoch; dort werden `char_options`/`items`/`spells` komplett ersetzt.
2. **Charaktere heraus:** fertige Entwürfe (`status='fertig'`) exportiert der Spielleiter über
   `GET /api/admin/characters/export`; der Import im Kampagnenbuch (`POST
   /api/characters/import?campaign_id=…`) legt für jeden neuen Namen eine `entries`-Zeile
   (`type='pc'`) plus die passende `characters`-Zeile an. Mit kommt auch der `play_state`
   (Startausrüstung: Inventar, Munition). Bei Namen, die die Kampagne schon hat, fragt die Oberfläche
   nach (`{"characters": […], "on_conflict": {"Name": "skip"|"replace"|"copy"}}`): überspringen
   (Standard, auch für die blosse Liste), **Charakterblatt ersetzen** (nur `max_hp`/`ac`/
   `initiative_bonus`/`notes`/`stat_block` mit neuem `updated_at`; TP und `play_state` aus dem Spiel
   bleiben, der Tracker zieht nach) oder als Kopie „Name (2)“ anlegen.

Die `characters`-Spalten sind in beiden Datenbanken absichtlich gleich, die Felder werden 1:1 kopiert.
Einzige Ausnahme sind die Verweise im `stat_block` (`char_import.py`): Klasse, Unterklasse, Volk,
Hintergrund und Talente (`*_ref.id`, `feats[].id`), Zauber (`spell_list[].id`) und Gegenstände
(`play_state.inventory[].item_id`, `equipped`) tragen die IDs des Kampagnenbuchs, aus dem das
Inhaltspaket stammt. Lokales und Server-Kampagnenbuch haben verschiedene IDs; deshalb prüft der
Import jede ID gegen den Namen (Bibliothekseinträge zusätzlich gegen englischen Namen und Regelwerk)
und stellt sie sonst über den Namen um. Was hier fehlt, verliert die ID und erscheint auf dem Blatt
als „nicht in der Bibliothek“; die Importmeldung nennt diese Namen.

## Dateispeicher neben der Datenbank

Bilder/Karten liegen nicht in SQLite, sondern als Dateien neben der DB (`uploads/` beim Kampagnenbuch,
`avatars/` beim Tracker, `maps/`+`tokens/` bei Battlemap), referenziert über Pfadspalten
(`avatar_path`, `image`, `map_file`, …). Greift ein Tool auf ein Bild eines anderen Tools zu, geschieht
das über eine Proxy-Route (`/kb/…`, `/tracker/…`) und nicht über einen direkten Dateizugriff.
