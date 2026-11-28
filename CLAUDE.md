# Wyrmdesk

Web-Tools für Tischrollenspiel-Sessions (5e), öffentlich als **Wyrmdesk**. Interne Namen
(Ordner `dmtool`/`charcreator`, Container, Volumes `dnd-tools_*`/`dnd-local_*`) bleiben bewusst, damit
bestehende Installationen ihre Daten behalten. Tracker und Battlemap sind Pakete im Kampagnenbuch und laufen in
dessen Container.

| Ordner | Tool | Rolle |
|---|---|---|
| `dmtool` | Kampagnenbuch | **Quelle der Wahrheit** für Kampagnen, Charaktere, Bestiarium, Items, Zauber |
| `dmtool/backend/app/combat` | Combat Tracker | Encounter/Initiative-Reihenfolge, unter `/tracker/` |
| `dmtool/backend/app/battlemap` | Battlemap | Karten, Tokens, Nebel/Sicht, unter `/map/`, Beamer `/beamer/` |
| `dmtool/desktop` | Native App (Windows/Linux) | Dünner `pywebview`/PyInstaller-Wrapper um `dmtool/backend/app`, unverändert; kein eigener Code-Pfad, berührt den Docker-Build nicht |
| `charcreator` | Charaktererstellung | Eigenständig, öffentlich erreichbar, Austausch nur per JSON-Export/Import (Datei oder Teilen-Link); mit `OPEN_MODE=1` für alle offen (`open_mode.py`) |

Die drei Teile des Kampagnenbuchs teilen sich eine Datenbank (`dmtool.db`); ein Kämpfer der Gruppe liest
den Charakter direkt (View `combatant_view`, s. `DATENBANKEN.md`).

Server-Stack: `dmtool/compose.yaml`, lokal: `compose.yaml` im Root. Start, Ports und interne
Verbindungen: `dmtool/backend/app/run.py`, `internal.py`.

Architektur/Datenbanken im Detail: [DATENBANKEN.md](DATENBANKEN.md).
Betrieb (URLs, Start/Stop, Backups, lokale vs. Server-Instanz): [LIESMICH.md](LIESMICH.md).

## Tech-Stack

- Backend: Python 3.12, **FastAPI** + `uvicorn`, async. Jeder Service läuft zwei FastAPI-Apps im selben
  Prozess (Haupt-API + öffentliche/Display-API, s. `backend/app/run.py`).
- Datenhaltung: **SQLite**, eine Datei pro Service, Schema in `backend/app/schema.sql`, angewendet per
  `executescript` beim Start; nachträgliche Spalten über ein `MIGRATIONS`-Dict (`db.py`). Keine
  gemeinsame DB, keine Foreign Keys über Service-Grenzen.
- Frontend: **Vanilla JS/HTML/CSS** unter `backend/app/*_static/`, kein Build-Step, kein Bundler,
  kein Framework.
- Deploy: Docker Compose, ein `compose.yaml` pro Service plus ein zusammenfassendes `compose.yaml` im
  Root für den lokalen Stack. Auf einem Server laufen `dmtool/compose.yaml` und
  `charcreator/compose.yaml` als eigene Stacks, siehe "Betrieb auf einem Server" in `LIESMICH.md`.
- Keine Tests im Repo. Keine Linter/Formatter-Config — an vorhandenem Stil orientieren.

## Konventionen

- Commit-Messages und UI-Texte sind **Deutsch**. Commit-Stil: `Bereich: kurze Beschreibung`
  (z. B. `Combat Tracker: Encounter-Schwierigkeit live anzeigen`).
- Jeder Service ist für sich lauffähig; Austausch zwischen den dreien (`dmtool`, `combattracker`,
  `battlemap`) läuft ausschliesslich über HTTP-APIs zur Laufzeit (`TRACKER_URL`, `DMTOOL_URL`), nie
  über direkten DB-Zugriff. `charcreator` hat keine Live-Verbindung, nur manuellen JSON-Export/Import (Datei oder Teilen-Link, den der Browser des Kampagnenbuchs abruft, nie dessen Server).
- Innerhalb eines Service: `main.py` (Haupt-API-Routen), `public.py`/`display.py` (öffentliche/Anzeige-
  Routen ohne Auth), `db.py` (Schema + Migrationen), weitere Module nach Fachbereich (`tracker.py`,
  `kb.py`, `library.py`, …). Statische Frontends liegen als `*_static/`-Ordner daneben und werden von
  FastAPI direkt ausgeliefert.
- `characters`-Tabellen in `dmtool`/`combattracker`/`charcreator` haben bewusst (fast) identische
  Spalten, damit Sync/Export/Import ohne Transformation läuft — das beim Ändern von Charakter-Feldern
  im Hinterkopf behalten.
- Das Charakterblatt (`charsheet.js`, `charsheet.css`, `charsheet-rules.js` unter `shared_static/`) gibt
  es in `charcreator` und `dmtool` als identische Kopie. Geändert wird die Fassung in `charcreator`,
  danach `sh tools/check-shared.sh --copy`; `sh tools/check-shared.sh` meldet Abweichungen. Dasselbe gilt
  für die Platzhalter-Portraits pro Klasse (`shared_static/class-portraits`, beim Charakter-Import gesetzt)
  und das Logo (`shared_static/brand`, erzeugt von `logo/build.py` im Website-Repo; `wyrmdesk.ico` der
  Desktop-App liegt in `dmtool/desktop`).
- UI-Texte: Deutsch steht im Code und ist selbst der Schlüssel, `t("Gespeichert.")` bzw.
  `t("Stufe {n} erreicht.", { n })`, gezählte Wörter mit `tn(n, "{n} Fertigkeit", "{n} Fertigkeiten")`
  (`shared_static/i18n.js`, Python `i18n.py`). Statisches HTML braucht kein Markup. Englisch in
  `lang/en.json` (Texte der geteilten Dateien in `shared_static/lang/en.json`). Grundsprache `UI_LANG`,
  pro Browser umschaltbar (Cookie `ui_lang`, Auswahl in der Kopfzeile); der Server übersetzt pro Anfrage
  (`i18n.lang()`), also in Python nichts beim Import übersetzen.
  Nach neuen Texten `python tools/check-i18n.py` und die fehlenden übersetzen. Gespeicherte Werte
  (z. B. `source: "Hintergrund"`, Gesinnung) bleiben Deutsch, markiert mit `tk("…")` und erst bei der
  Anzeige mit `t(wert)` übersetzt. Bibliotheksinhalte: `optName(o)`, `localized(en, de)`, Würfel
  über `diceDe()`. In Funktionen, die `t()` aufrufen, keine lokale Variable `t` (z. B. `e.target`).
  Python importiert `from .i18n import t as _t` (eine Schleifenvariable `t` würde es verdecken). Ein
  Wort mit zwei Bedeutungen bekommt einen Kontext: `tc("Ort", "Laden")`, Eintrag `"Ort|Laden"`. Was nur
  auf Deutsch Sinn ergibt (DeepL-Übersetzung), trägt `data-only-de` und ist auf Englisch ausgeblendet.
- Version: eine Nummer für alles in `VERSION` (Repo-Root, Semantic Versioning, `0.x` = Vorabversion),
  Kopien in `*/backend/app/VERSION` per `sh tools/check-shared.sh --copy`, gelesen von `version.py`.
  Neues für Nutzer Sichtbares unter „Unveröffentlicht“ in `CHANGELOG.md` eintragen. Release-Ablauf:
  `LIESMICH.md` → „Versionen und Releases“.
- Das Handbuch (DE/EN mit Screenshots) liegt in `dmtool/backend/app/handbuch_static`, in der App unter
  `/handbuch/` (Knopf „?“ aus `shared_static/nav.js`, springt zum Kapitel des aktuellen Teils). Die
  Website (Repo `wyrmdesk-webseite`) holt es per `sh tools/sync-handbuch.sh` und liefert es unter
  `/handbuch/` aus. Kapitel-Anker (`kampagnenbuch`/`campaign-book`, `tracker`, `karte`/`map`) nicht
  umbenennen, ohne `nav.js` anzupassen.
- Trennung Charakterblatt (`max_hp`/`ac`/`notes`/`stat_block`, mit `updated_at`-Versionsprüfung) vs.
  Spielzustand (`current_hp`/`temp_hp`/`play_state`, ändert sich während des Spiels) ist Absicht, nicht
  Zufall — nicht vermischen.

## Native App mitdenken (`dmtool/desktop`)

Jede Änderung an `dmtool/backend/app` landet auch in der nativen App (gleicher Code, kein eigener
Pfad). Was dort anders ist und bei Umbauten beachtet werden muss:

- **Nicht-Python-Dateien** (neuer `*_static`-Ordner, weitere `schema.sql`, Daten-/Sprachdateien an
  neuer Stelle) in `dmtool/desktop/wyrmdesk.spec` unter `datas` eintragen; nur dynamisch importierte
  Module unter `hiddenimports`. Sonst fehlen sie nur in der gebauten `.exe`, Docker und Dev-Start laufen.
- **Datenpfade** nur relativ zu `DB_PATH` (wie `uploads`, `maps`, `avatars`) oder über eine
  Umgebungsvariable, nie fest `/data` oder neben dem Code (in der `.exe` nicht beschreibbar). Neue
  Variable mit Container-Standardwert → passenden Wert in `dmtool/desktop/appdata.py` setzen.
- **Ports/Netzwerk**: In der App lauscht 8440 (Spielleiter) nur auf `127.0.0.1`, nur 8441
  (`public.py`, Beamer/Spieler) ist im LAN; die alten Ports 8420–8431 gibt es nicht. Alles, was andere
  Geräte brauchen, gehört auf die öffentliche App. Feste Ports im JS bleiben 8440/8441. Neue
  Bind-/Port-Einstellungen in `run.py` per Umgebungsvariable, Standard = Container-Verhalten.
- **Fenster statt Browser** (pywebview): Downloads, Datei-Uploads, neue Tabs/`target="_blank"`
  (öffnen ggf. im System-Browser), Zwischenablage, Vollbild, Drucken verhalten sich anders als im Browser.
  Neue Funktionen dieser Art in der App testen. Engines: Windows WebView2 (Chromium), Linux WebKitGTK
  (Safari-artig), neuere CSS/JS-Features also auch dort prüfen.
- Neue Python-Abhängigkeiten in `backend/requirements.txt` müssen PyInstaller-tauglich sein; die
  `.exe` bekommt Updates nur durch neuen Build (DB-Migrationen laufen wie gewohnt beim Start).

- **Pakete bauen:** Linux (`.deb`, AppImage) per `sh dmtool/desktop/build-linux-packages.sh` (Docker);
  Windows-Installer nur auf Windows: **an einem Windows-Rechner zuerst `dmtool/desktop/WINDOWS.md`
  lesen** und dort den Abschnitt „Stand“ nachführen.

## Lokal starten

```
docker compose up -d --build   # im Repo-Root
docker compose down            # stoppt nur, Daten bleiben in den Volumes
```
Niemals `docker compose down -v` (löscht alle Daten). Details zu Backups/Restore: `LIESMICH.md`.

## Git

Branch `main`. Vor dem Start einer Änderung `git status`/`git pull` prüfen. Private Betriebsnotizen
(eigener Server, Remote) liegen, falls vorhanden, im nicht eingecheckten Ordner `privat/`.

Das Repo ist öffentlich. In eingecheckte Dateien kommen **keine persönlichen Daten**: keine Namen,
E-Mail-Adressen, eigenen Server, IP-Adressen, Hostnamen oder Pfade aus dem eigenen Benutzerordner,
auch nicht als Beispiel (dafür `example.org`, `localhost`). Vor jeder Veröffentlichung den Ablauf in
`privat/SERVER.md` befolgen (falls vorhanden), inklusive der Prüfung dort.
