# Wyrmdesk für Windows bauen

Anleitung für den Windows-Rechner, für Menschen und für Claude. Die Linux-Pakete entstehen auf Linux
(`build-linux-packages.sh`); PyInstaller baut nicht über Kreuz, daher wird die Windows-Fassung hier
gebaut. Ergebnis: `dist\packages\Wyrmdesk-Setup-<Version>.exe`, ein Installer ohne Adminrechte.

## Stand (bitte nachführen)

**28.11.2026, Version 0.2.0** (Tag `v0.2.0`, gleiche Werkzeuge wie 0.1.0). Ohne Änderungen an
`wyrmdesk.spec` und den Requirements:

1. ✅ `build-windows.bat` baut `dist\packages\Wyrmdesk-Setup-0.2.0.exe` (26 MB), ProductVersion „0.2.0“.
   Der neue Look (`shared_static/wyrmdesk.css` mit Schriften) und `app.campaign_file` sind im Build.
2. ✅ Installer von Hand getestet: läuft, darunter der neue Look in allen Teilen, die Kampagnen-Datei
   (Export einer Vorlage als Datei im App-Fenster, Einspielen über „Vorlage aus Datei…“).

Die Linux-Pakete zu 0.2.0 baut der CI-Runner beim Push des Tags.

**22.11.2026, Version 0.1.0, erster Build auf Windows 11** (Python 3.12, PyInstaller 6.22.3,
Inno Setup 6.7.3). Ohne Änderungen am Code:

1. ✅ Bauen klappt: `dist\wyrmdesk\` (67 MB), keine zusätzlichen `hiddenimports` nötig (Warnungen zu
   `pycparser.lextab`/`yacctab` und `tzdata` sind harmlos). Alle Teile antworten (`/`, `/tracker/`, `/map/`,
   `/handbuch/`, `/beamer/`, `/spieler/`), beide Fenster öffnen sich.
2. ✅ Ohne Konsole: per Doppelklick kein Konsolenfenster, Ausgabe in `%LOCALAPPDATA%\Wyrmdesk\wyrmdesk.log`.
   Aus einer Shell gestartet bleibt die Ausgabe in der Shell, das ist gewollt.
3. ✅ Datei-Eigenschaften: ProductName „Wyrmdesk“, FileVersion/ProductVersion „0.1.0“.
4. ✅ Inno Setup baut `dist\packages\Wyrmdesk-Setup-0.1.0.exe` (26 MB) ohne Warnungen. Stumm
   installiert (`/VERYSILENT /CURRENTUSER`) startet die App, Deinstallation entfernt Programm,
   Startmenü-Eintrag und Registry-Eintrag.
5. ✅ `.bat` und `.iss` mit CRLF.

6. ✅ Die ganze Liste unter „Testen“ mit dem Installer von Hand durchgegangen, alles in Ordnung
   (Installation, SmartScreen, Startmenü, Firewall, Sicherung, Handbuch, Vollbild, Update, Deinstallation).

Release 0.1.0 erschienen, mit den Linux-Paketen aus demselben Commit.

Was hier erledigt oder geändert wurde, in diesem Abschnitt festhalten und committen.

## Einmalig einrichten

Windows 10/11, 64 Bit. In PowerShell:

```powershell
winget install Git.Git
winget install Python.Python.3.12
winget install JRSoftware.InnoSetup
```

Python **3.12**, wie im Docker-Image und im Linux-Build (numpy 2.5 braucht ≥ 3.12; pythonnet, das
pywebview unter Windows nutzt, gibt es nicht für jede neuere Version). WebView2 bringt Windows 10/11
praktisch immer mit (über Edge); fehlt es, startet die App nicht: https://developer.microsoft.com/microsoft-edge/webview2/

Repo holen (oder `git pull`, wenn schon da), dann im Ordner `dmtool\desktop`:

```powershell
py -3.12 -m venv .venv
.venv\Scripts\activate
pip install -r ..\backend\requirements.txt -r requirements.txt -r requirements-build.txt
```

Unter Windows **ohne** `--system-site-packages` (das braucht nur Linux für GTK). `requirements.txt`
zieht über pywebview automatisch `pythonnet` nach.

## Bauen

1. Erst ohne Build testen: `python launcher.py`. Zwei Fenster (Spielleiter, Beamer) müssen kommen.
   Daten landen in `%LOCALAPPDATA%\Wyrmdesk\`.
2. `build-windows.bat` (im aktivierten venv). Baut `dist\wyrmdesk\` und daraus den Installer
   `dist\packages\Wyrmdesk-Setup-<Version>.exe`. Die Version kommt aus `..\backend\app\VERSION`.
   **Welche Datei?** Nach dem Bauen gibt es drei ähnlich heißende `.exe`:

   | Datei | Was sie ist |
   |---|---|
   | `build\wyrmdesk\wyrmdesk.exe` | ❌ Zwischenstand von PyInstaller ohne Python-Laufzeit, meldet „Failed to load Python DLL“. Nie starten. |
   | `dist\wyrmdesk\wyrmdesk.exe` | Fertige App als loser Ordner, läuft ohne Installation (schneller Test nach dem Bauen). |
   | `dist\packages\Wyrmdesk-Setup-<Version>.exe` | ✅ **Der Installer**: zum Testen und Verteilen. Danach Wyrmdesk über das Startmenü starten (installiert nach `%LOCALAPPDATA%\Programs\Wyrmdesk\`). |
3. Startet die gebaute App nicht, mit sichtbarer Konsole neu bauen, damit der Fehler zu sehen ist:
   `set WYRMDESK_CONSOLE=1` und nochmals `build-windows.bat`. Sonst steht die Ausgabe in
   `%LOCALAPPDATA%\Wyrmdesk\wyrmdesk.log` (der Lauf davor in `wyrmdesk.log.1`).
4. Fehlt ein Modul (`ModuleNotFoundError` im Log/der Konsole): den Namen in `wyrmdesk.spec` unter
   `hiddenimports` ergänzen und neu bauen (bei pywebview unter Windows typisch: `clr`, `webview.platforms.edgechromium`,
   `webview.platforms.winforms`).

## Testen (mit dem Installer, nicht nur mit dist\wyrmdesk)

- Installer starten: kommt die SmartScreen-Warnung „Unbekannter Herausgeber“, ist das erwartet (die
  `.exe` ist nicht signiert): „Weitere Informationen“ → „Trotzdem ausführen“.
- Installation ohne Adminrechte, Startmenü-Eintrag „Wyrmdesk“ mit Icon.
- Start: Spielleiter- und Beamer-Fenster, kein Konsolenfenster.
- Windows-Firewall fragt beim ersten Start nach (Port 8441 für Beamer und Spieler im Netz):
  „Zugriff zulassen“ für private Netzwerke. Ohne das erreichen Handys/Tablets die Spieleransicht nicht.
- Einrichtung (⚙): unten „Wyrmdesk Version …“ mit der richtigen Nummer.
- Sicherung herunterladen (Speichern-Dialog) und wieder einspielen.
- Handbuch über „?“: öffnet im Browser beim passenden Kapitel.
- Beamer-Fenster: Klick/F11 Vollbild, Esc zurück.
- Dateieigenschaften von `wyrmdesk.exe` (Rechtsklick → Eigenschaften → Details): Version.
- Update: denselben Installer nochmals ausführen; Daten bleiben.
- Deinstallieren (Einstellungen → Apps): Programm weg, `%LOCALAPPDATA%\Wyrmdesk\` (Daten) bleibt.

## Danach

- Korrekturen committen (Deutsch, `Native App: …`), `dist\` und `build\` nie (stehen in `.gitignore`), pushen.
- Den Abschnitt „Stand“ oben nachführen.
- Den Installer nicht ins Repo: Er kommt beim Release ans Release auf GitHub, siehe `LIESMICH.md` →
  „Versionen und Releases“. Den Tag `v<Version>` erst setzen, wenn Linux- und Windows-Pakete aus
  demselben Commit gebaut und getestet sind.
