# Wyrmdesk native (dmtool)

Native Fenster statt Browser für das Kampagnenbuch (mit Combat Tracker und Battlemap), ohne Docker.
Wrapper nur - der komplette Code läuft unverändert aus `../backend/app`, genau wie im Docker-Image;
ein Feature wird einmal geschrieben und kommt in beiden Varianten an.

## Entwickeln (ohne Build)

Linux braucht vorher die System-Pakete für WebKitGTK (reines `pip install` reicht nicht, siehe
Stolperstein unten):
```sh
sudo apt install python3-gi gir1.2-webkit2-4.1 gir1.2-gtk-3.0   # Debian/Ubuntu; ältere Systeme: gir1.2-webkit2-4.0
```

```sh
python3 -m venv .venv --system-site-packages
. .venv/bin/activate          # Windows: .venv\Scripts\activate (dort ohne --system-site-packages, siehe unten)
pip install -r ../backend/requirements.txt -r requirements.txt
python launcher.py
```
Öffnet zwei Fenster: "Wyrmdesk – Spielleiter" (Kampagnenbuch, Tracker, Battlemap) und
"Wyrmdesk – Beamer" (für den Projektor). Daten landen unter `platformdirs.user_data_dir("Wyrmdesk")`
(Linux: `~/.local/share/Wyrmdesk/`, Windows: `%LOCALAPPDATA%\Wyrmdesk\`), nicht in `/data` wie im
Container.

Ports wie beim Docker-Stack, nur direkt (Variablen in `appdata.py`, ausgewertet in
`../backend/app/run.py`): 8440 Spielleiter, nur auf `127.0.0.1` (ohne Passwort, also nicht im LAN),
8441 Beamer und Spieler im LAN. Die Seiten verlinken fest auf 8440/8441, daher dieselben Nummern.
Die alten Adressen 8420–8431 fallen weg. Ist ein Port schon belegt (Docker-Stack läuft, App schon
offen), zeigt die App statt der beiden Fenster eine Fehlermeldung; ebenso, wenn der Server nicht
hochkommt (mit Traceback).

Mit `WYRMDESK_DEBUG=1 python launcher.py` öffnet Rechtsklick → „Untersuchen"/„Inspect" in jedem
Fenster die Web-Entwicklertools (Konsole, Netzwerk) - hilfreich, um echte Fehler von harmlosem
(z. B. aktiviertem Nebel des Krieges, der die Karte absichtlich schwarz zeigt) zu unterscheiden.

## Bauen und Pakete

PyInstaller baut nicht über Kreuz: Linux-Pakete auf Linux, den Windows-Installer auf Windows. Die
Version kommt aus `VERSION` (siehe `LIESMICH.md`, „Versionen und Releases“). Alles landet in
`dist/packages/` (nicht eingecheckt).

**Linux (.deb und AppImage)**, braucht nur Docker:
```sh
sh build-linux-packages.sh
```
Baut in einem Container mit Debian 12 als Basis (`linux/Dockerfile`, Skript `linux/build-packages.sh`),
damit die Pakete auch auf Distributionen ab etwa 2022 laufen, nicht nur auf der, auf der gebaut wurde:
- `wyrmdesk_<version>_amd64.deb`: Debian, Ubuntu und Verwandte, nach `/opt/wyrmdesk` mit Menüeintrag;
  `sudo apt install ./wyrmdesk_<version>_amd64.deb` zieht WebKitGTK als Abhängigkeit mit.
- `Wyrmdesk-<version>-x86_64.AppImage`: eine Datei für alle anderen; braucht GTK 3 und WebKitGTK 4.1
  vom System (auf GNOME-/KDE-Desktops meist schon da).

GTK, GLib und WebKitGTK werden **nicht** mitgepackt, sondern vom System genommen: WebKitGTK lässt sich
nicht mitliefern (startet Hilfsprozesse an festen Pfaden), und mitgebrachtes GTK neben dem WebKit des
Systems führt zu Abstürzen. `wyrmdesk.spec` filtert sie unter Linux heraus, `launcher.py` macht die
Pfade rückgängig, die PyInstallers GTK-Hooks setzen. Mitgepackt bleibt `libgirepository-1.0`, das
die mitgebrachte PyGObject-Anbindung braucht und neuere Distributionen nicht mehr installieren.

**Windows (Installer mit Inno Setup)**: Schritt für Schritt in [WINDOWS.md](WINDOWS.md), kurz:
venv mit `requirements-build.txt`, Inno Setup 6, dann `build-windows.bat` →
`Wyrmdesk-Setup-<version>.exe` (Installation pro Benutzer, ohne Adminrechte; Daten bleiben beim
Deinstallieren erhalten). Ohne Konsolenfenster; die Ausgabe steht in `%LOCALAPPDATA%\Wyrmdesk\wyrmdesk.log`.

**Nur schnell lokal (Linux, ohne Paket):** im venv `sh build-linux.sh` → `dist/wyrmdesk/`. Läuft nur
auf diesem Rechner und ähnlich neuen Systemen.

### Bekannter Stolperstein: `ModuleNotFoundError: No module named 'gi'` (Linux)

`python3-gi` (die Python-Anbindung an GTK/GObject-Introspection) ist ein System-Paket, kein
pip-Paket - ein gewöhnliches venv ist davon isoliert und sieht es nicht, selbst wenn
`sudo apt install python3-gi gir1.2-webkit2-4.1` vorher lief. Deshalb das venv mit
`--system-site-packages` anlegen (siehe oben), statt `gi` über pip (`PyGObject`) nachzubauen -
das kompiliert aus Quellcode gegen System-Header und ist unnötig fehleranfällig, wenn das
System-Paket schon da ist.

### Bekannter Stolperstein: `ReferenceError: Can't find variable: localStorage`

`webview.start()`s Voreinstellung `private_mode=True` lässt WebKitGTK `localStorage` komplett
weglassen (nicht nur dessen Persistenz) - die Kampagnenauswahl im Combat Tracker bricht damit
beim Laden ab (keine Kampagne wählbar, Encounter-Anlage schlägt mit `campaign_id: null` fehl).
`launcher.py` setzt deshalb `private_mode=False` in `webview.start()`.

### Bekannter Stolperstein: Download passiert nicht

`pywebview` bricht jeden Download stillschweigend ab (`settings["ALLOW_DOWNLOADS"]` ist
standardmäßig `False`), etwa „Sicherung herunterladen“. `launcher.py` erlaubt Downloads; sie
öffnen einen „Speichern unter“-Dialog.

### Icon in Titel- und Taskleiste (Linux, Wayland)

Unter Wayland (KDE, GNOME) ignoriert der Fenstermanager das Icon, das pywebview am Fenster setzt; er
sucht die `.desktop`-Datei zum Programmnamen. `launcher.py` nennt das Programm deshalb `wyrmdesk` und
legt beim Start eine versteckte `~/.local/share/applications/wyrmdesk.desktop` (`NoDisplay=true`)
plus das Icon unter `~/.local/share/icons/hicolor/256x256/apps/` an. Unter Windows kommt das Icon aus
der `.exe` (`icon=` in `wyrmdesk.spec`). Zeigt KDE es nicht sofort: `kbuildsycoca6`.

### Vollbild

Im Browser macht ein Klick auf den Beamer die Seite bildschirmfüllend (`requestFullscreen()`); im
App-Fenster füllte das nur das Fenster, Titelleiste und Rahmen blieben. `launcher.py` gibt das an
das Fenster weiter (randloses Vollbild auf dem Bildschirm, auf dem es gerade liegt) und ergänzt
F11 zum Umschalten und Esc zum Verlassen, in beiden Fenstern.

### Bekannter Stolperstein: fehlende uvicorn-Module

`uvicorn[standard]` wählt seine Event-Loop- und HTTP-Protokoll-Implementierung zur Laufzeit
(`uvicorn/loops/auto.py`, `uvicorn/protocols/*/auto.py`) - PyInstallers statische Analyse übersieht
das gelegentlich. `wyrmdesk.spec` deckt das pauschal mit `collect_submodules("uvicorn")` ab; taucht
beim Start des gebauten Programms trotzdem ein `ModuleNotFoundError` auf (im Terminal sichtbar,
solange `console=True` in der Spec steht), den fehlenden Modulnamen in `hiddenimports` ergänzen und
neu bauen.

## Was das hier NICHT ist

- Keine Code-Signierung der `.exe` - auf Windows ist eine SmartScreen-Warnung beim ersten Start zu
  erwarten.
- `pywebview` bringt selbst keine Browser-Engine mit (anders als Electron): es nutzt WebView2
  (Windows, meist über Edge vorhanden) bzw. WebKitGTK (Linux, meist Teil des Desktop-Unterbaus).
  Fehlt das auf einer Maschine, startet die App nicht.
