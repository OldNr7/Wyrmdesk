# Änderungen

Alle nennenswerten Änderungen an Wyrmdesk. Die Versionsnummer folgt
[Semantic Versioning](https://semver.org/lang/de/): `HAUPT.NEBEN.FEHLER`. Solange sie mit `0.` beginnt,
ist Wyrmdesk in Entwicklung, und von einer Version zur nächsten kann sich noch etwas ändern.

- **Fehlerbehebung** → letzte Stelle (0.1.0 → 0.1.1)
- **Neue Funktionen, Umbauten** → mittlere Stelle (0.1.x → 0.2.0)
- **1.0.0**, sobald Wyrmdesk als stabil gilt und Daten und Sicherungen ohne Umwege weiterverwendet werden können.

Neue Einträge kommen laufend unter „Unveröffentlicht“; beim Release bekommt der Abschnitt seine Nummer.

## Unveröffentlicht

## 0.2.0 – Wyrmdesk-Look und Kampagnen als Datei

- **Kampagnenbuch:** Vorlagen als Datei weitergeben und einspielen (Einrichtung → Vorlagen): eine ZIP-Datei
  mit allen Bildern, Karten und Dokumenten, standardmässig ohne Spielercharaktere und mit zurückgesetztem
  Spielstand. So lassen sich Kampagnen von wyrmdesk.ch übernehmen.
- **Kampagnenbuch:** «Kampagne als Vorlage sichern…» brach mit einem Fehler ab.

- **Kampagnenbuch, Tracker und Karte:** im Stil von wyrmdesk.ch: Kopfzeile, Themenleisten und Listen
  dunkel mit Gold, der Inhalt Pergament, Titel in Cinzel; im Tracker leuchtet der aktive Zug golden.
  Charakterblatt unverändert.
- **Beamer und Spieleransicht:** Handouts mit goldenem Titel und Pergament im Goldrahmen; die
  Spieleransicht dunkel wie die Charaktererstellung, das Blatt im goldenen Rahmen.

- **Charaktererstellung:** im Stil von wyrmdesk.ch, dunkel mit Glut und Gold, neue Startseite im
  offenen Modus, auch die Verwaltung. Charakterblatt und Assistent bleiben Pergament.

## 0.1.0 – erste Vorabversion

Erster veröffentlichter Stand, als Docker-Stack und als native App (Windows, Linux).

- **Kampagnenbuch:** Sessions, Einträge mit Verweisen (NPCs, Orte, Quests …), Handouts für den Beamer,
  Charakterblätter der Gruppe, Bibliothek mit Bestiarium, Gegenständen und Zaubern (SRD, Wyrmdesk-Inhalte,
  Open5e), Spieleransicht, Kampagnenvorlagen, Sicherung und automatische Sicherungen.
- **Combat Tracker:** Encounter, Initiative, Trefferpunkte und Zustände, Anzeige für die Spieler.
- **Battlemap:** Szenen, Nebel des Krieges, Wände und Sichtlinien (Spieler-Tokens als Sichtpunkte),
  Tokens, Kampf auf der Karte, Beamer mit Kalibrierung.
- **Charaktererstellung:** Assistent für Spieler, Verwaltung, Druck/PDF, Datei und Teilen-Link,
  offener Modus.
- **Handbuch** auf Deutsch und Englisch, in der App unter „?“.
- Oberfläche auf Deutsch und Englisch.
- Die Version steht in der Einrichtung und in jeder Sicherung; eine Sicherung aus einer neueren
  Version wird nur nach Rückfrage wiederhergestellt.
