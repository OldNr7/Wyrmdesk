# Wyrmdesk

Kampagnenbuch, Combat Tracker und Battlemap laufen in **einem** Container, die Charaktererstellung in
einem eigenen. Voraussetzung: Docker (z. B. Docker Desktop) läuft.

| Tool | Spielleiter | Anzeige |
|---|---|---|
| Kampagnenbuch | http://localhost:8440 | http://localhost:8441 (Handouts), http://localhost:8441/spieler/ |
| Combat Tracker | http://localhost:8440/tracker/ | http://localhost:8441/anzeige/tracker/ |
| Battlemap | http://localhost:8440/map/ | http://localhost:8441/beamer/ (Beamer) |

Die alten Adressen funktionieren übergangsweise weiter (Lesezeichen, Stream-Deck-Webhooks): Tracker
:8420 und :8421, Battlemap :8430; :8431 leitet auf :8441/beamer/ weiter. Alles liegt in
**einer** Datenbank (`/data/dmtool.db`) mit **einem** Backup (⚙ Einrichtung im Kampagnenbuch); die
„Sicherung“-Knöpfe in Tracker und Battlemap führen dorthin. Die alten Datenbanken in `/data/combat`
und `/data/battlemap` wurden beim ersten Start einmal übernommen und bleiben unverändert liegen.
Oben in jeder Kopfleiste wechselt „📖 Kampagnenbuch | ⚔ Kampf | 🗺 Karte“ zwischen den drei Teilen;
die Kampagne wählt man im Kampagnenbuch, im Tracker oder in der Karte, alle drei zeigen dieselbe.
Die Karte listet nur die Szenen dieser Kampagne; neue Szenen gehören automatisch zu ihr. Szenen von
vor der Zuordnung stehen unter „Ohne Kampagne“ und kommen mit „→“ in die gewählte Kampagne;
„Nächste/vorherige Szene“ (Stream Deck) blättert nur innerhalb der Kampagne.

## Wo welche Daten liegen

Das Kampagnenbuch ist die Quelle für Kampagnen, Spielercharaktere (Menü „Gruppe“, mit vollem
Charakterblatt), Bestiarium, Items und Zauber. Combat Tracker und Battlemap holen diese Daten von dort.
Der Tracker hält nur noch die Encounter mit ihren Kämpfern; ändert sich ein Charakter oder ein
Monsterbild im Kampagnenbuch, ziehen die Kämpfer in allen Encountern nach.

## Charakterblätter für Spieler

Unter http://localhost:8441/spieler/ wählen Spieler ihren Charakter aus einer Liste und sehen und
bearbeiten das volle Charakterblatt. „⚔ Kampfreihenfolge“ blendet die Anzeige von :8421 darüber ein.
Die alte Adresse :8421/spieler/ leitet dorthin weiter. Die Liste zeigt die Charaktere der Kampagne, die
zuletzt im Tracker oder im Kampagnenbuch geöffnet wurde.
Vom Handy aus statt `localhost` die IP-Adresse des Laptops verwenden; die Adresse steht im Tracker
unter „Anzeige“. Es gibt keine Anmeldung, jeder im Netz kann jedes Blatt öffnen.

Speichern DM und Spieler dasselbe Blatt kurz nacheinander, fragt das zweite Speichern nach, ob die
andere Fassung überschrieben werden soll. Nur lesend geöffnete Blätter aktualisieren sich selbst.

Ohne „Bearbeiten“ ändern Spieler direkt: momentane und temporäre TP (Schaden nimmt zuerst die
temporären), verbrauchte Zauberplätze, Munition sowie kurze und lange Rast. Die TP gehören zum
Charakter und laufen mit seinen Kämpfern in allen Encountern gleich, egal ob sie im Tracker, auf der
Battlemap oder auf dem Blatt geändert werden. Neue Encounter starten mit den aktuellen TP.
Rüstung, Schild, Waffen, Ringe und wundersame Gegenstände werden im Inventar mit dem Punkt links
ausgerüstet. RK, Angriffe und Schaden rechnet das Blatt daraus nach den Regeln: Zweihandwaffe ohne
Schild, vielseitige Waffe (Häkchen „2H“) zweihändig nur ohne Schild, zwei Waffen nur wenn beide leicht
(die zweite als Bonusaktion ohne Attributsbonus auf den Schaden), höchstens zwei Ringe und drei
eingestimmte Gegenstände. Bekannte magische Gegenstände wirken mit (Ring/Umhang des Schutzes,
Armschienen der Verteidigung, Ogerkraft-Handschuhe usw.). Der Magier bereitet Zauber aus dem Zauberbuch
mit dem ★ vor. Zauber kommen aus der Zauberliste des Kampagnenbuchs (nur die der Klasse, bis zum
höchsten Grad, den die Stufe erlaubt). Unterstrichene Begriffe zeigen beim Antippen eine Erklärung.
Die Bewegungsrate rechnet das Blatt aus Volk, Klasse und Rüstung (in m, ft und Feldern à 1,5 m);
Talente oder Gegenstände kommen über die Anpassung dazu.

Klassen, Unterklassen, Völker und Hintergründe importiert das Kampagnenbuch von Open5e (Menüpunkte
links, wie Bestiarium und Zauber; SRD-Einträge mit deutschen Namen, 2014 und 2024 getrennt). Auf dem
Blatt werden sie per Dropdown gewählt; die Unterklassen passen sich der Klasse an. Bei den Attributen
trägt man die Grundwerte ein, die Boni von Volk und Hintergrund rechnet das Blatt dazu. Frei
verteilbare Punkte (z.B. Halbelf, Hintergründe 2024) wählt man unter „Attributserhöhungen“. Kein
Attribut steigt über 20, auch nicht durch Boni („+2 → 20 (max.)“). Ältere
Blätter behalten ihre Werte: Wird das Volk erkannt, gilt der Bonus als schon enthalten.

Talente (Feats) kommen ebenso von Open5e (Menüpunkt „Talente“; das SRD hat nur 18, darunter die
Herkunftstalente der 2024-Hintergründe) oder von D&D Beyond. Auf dem Blatt stehen sie unter „Merkmale
& Fähigkeiten → Talente“: aus der Liste wählen, Herkunft dazuschreiben („Stufe 4“). Das
Herkunftstalent des Hintergrunds übernimmt ein Klick („übernehmen“). Erhöht ein Talent ein Attribut
(„+1 Stärke oder Geschicklichkeit“), kommt der Punkt zu den „Attributserhöhungen“; alles andere,
was ein Talent bewirkt (Initiative, Zauber …), trägt man selbst ein. Der Stufenaufstieg bietet statt
der Attributserhöhung die Talente der Bibliothek an, die Charaktererstellung hat einen Schritt
„Talente“ (Herkunftstalent des Hintergrunds, Talentwahl beim Menschen 2024).

Gekaufte Unterklassen, Völker, Hintergründe und Talente von D&D Beyond kommen über „D&D Beyond-Import“ auf
den Seiten Unterklassen, Völker, Hintergründe bzw. Talente dazu. Einmalig das Lesezeichen „📋 DDB kopieren“ von dort in
die Lesezeichenleiste ziehen (ein älteres „📋 DDB-Unterklassen kopieren“ kann gelöscht werden). Dann
im eigenen Browser bei D&D Beyond angemeldet eine Klassenseite (für deren Unterklassen, z.B.
`dndbeyond.com/classes/2-cleric`) oder die Seite eines Volks (`dndbeyond.com/species/13-dwarf`),
Hintergrunds oder Talents öffnen, das Lesezeichen anklicken, im Kampagnenbuch einfügen und „Lesen“.
Völker, Hintergründe und Talente haben je eine eigene Seite; mehrere
kann man nacheinander kopieren und untereinander einfügen. Alternativ die Seiten speichern (Strg+S)
und die Dateien wählen. Das Kampagnenbuch ruft D&D Beyond nie selbst ab. Es zeigt, was es gefunden
hat; schon vorhandene Einträge (z.B. die SRD-Fassung von Open5e) sind nicht angehakt und werden nur
ersetzt, wenn man sie anhakt. Die Stufen der Unterklassen-Merkmale liest es aus dem Text („Starting
at 6th level“). Ob 2014 oder 2024 gilt, schätzt es bei Unterklassen aus den „Legacy“-Markierungen,
bei Hintergründen daraus, ob sie Attributswerte und ein Talent geben, bei Talenten aus der Zeile
„General Feat (Prerequisite: …)“, die nur 2024-Talente haben, bei Völkern aus der „Legacy“-Markierung
der Seite; vor dem Import prüfen. Untervölker (2014, z.B. Hügelzwerg) werden eigene Einträge mit
allen Merkmalen ihres Volks, wie beim Open5e-Import; ersetzt ein Untervolk laut Text ein Merkmal
(„Variant Human … replace the human's Ability Score Increase trait“), fällt dieses weg. 2024-Völker
haben statt Untervölkern eine Abstammung zur Wahl (Elf: Drow, High Elf, Wood Elf; Gnom: Forest, Rock;
Tiefling: Abyssal, Chthonic, Infernal); jede davon wird zusätzlich ein eigener Eintrag unter dem Volk,
mit nur ihrer Zeile der Abstammungstabelle, damit man z.B. den Wood Elf direkt wählen kann. Das
Lesezeichen erkennt Volksseiten von selbst; ein schon in die Leiste gezogenes muss dafür einmal
neu gezogen werden.

Gekaufte Abenteuer von D&D Beyond (z.B. Lost Mine of Phandelver) kommen kapitelweise in die offene
Kampagne: ⚙ Einrichtung → „Abenteuer von D&D Beyond“ → „📖 Kapitel in diese Kampagne importieren“.
Auf D&D Beyond angemeldet eine Kapitelseite öffnen (`dndbeyond.com/sources/dnd/lmop/goblin-arrows`),
dasselbe Lesezeichen „📋 DDB kopieren“ anklicken und einfügen. Karten gibt es nur mit der gespeicherten
Seite: Strg+S „Webseite, komplett“, dann die .html-Datei und die Kartenbilder aus dem Ordner „…_files“
zusammen wählen. Die Vorschau zeigt jede Überschrift mit einem Vorschlag, der sich pro Zeile ändern
lässt: das Kapitel wird eine geplante Session (Vorbereitung: Einstiegstext und allgemeine Texte des
Kapitels, darunter Verweise auf alle seine Abschnitte, NPCs, Quests und Karten), Abschnitte (Goblin Ambush,
Cragmaw Hideout) kommen unter „Kapitel“, nummerierte Bereiche („1. Cave Mouth“) darunter, „Roleplaying Sildar“
ein NPC; Zwischentitel wie Developments und Treasure bleiben Text im Eintrag darüber. Vorlesetexte
und Kästen stehen als hervorgehobene Zitate im Text, Verweise zwischen Abschnitten werden
`[[Verweise]]`, Karten Handouts (und Bild ihres Orts). Statt neu anzulegen kann jede Zeile in einen
vorhandenen Eintrag gehen (z.B. den eigenen „Phandalin“): der Buchtext kommt dann unter den eigenen,
Bild und „Liegt in“ nur, wenn er noch keine hat. Alles bleibt „den Spielern unbekannt“, bis man es
freigibt; ein zweiter Import desselben Kapitels erkennt die Einträge wieder und verdoppelt nichts.
Gespeicherte Seiten im Hauptordner des Repos ignoriert Git.

Die Anhänge gehen genauso (`…/lmop/appendix-a-magic-items`, `…/lmop/appendix-b-monsters`): jeder
Werteblock wird ein Monster im Bestiarium (RK, TP, HG, Gesinnung, Attribute, Rettungswürfe, Fertigkeiten,
Merkmale, Aktionen, Reaktionen, legendäre Aktionen; die Beschreibung aus dem Buch mit Varianten, Lair und
Madness zugeklappt auf dem Werteblatt, das Bild mit der gespeicherten Seite; die Notizen bleiben frei),
jeder magische Gegenstand einer in der Bibliothek (Typ aus dem Namen geraten, Einstimmung aus dem
Text; die Seltenheit nennt das Buch nicht). Bestiarium und Bibliothek gelten für alle Kampagnen. Was
dort schon so heisst (etwa von Open5e), wird vorgeschlagen wegzulassen und lässt sich in der Vorschau
„ersetzen“; was schon einmal von D&D Beyond kam, wird ersetzt, eigene Notizen bleiben. Die Regeltexte
der Anhänge sind „weglassen“. Werteblöcke mitten in einem Kapitel erscheinen als eigene Zeile.

Die Liste „📑 Kapitel“ zeigt die importierten Abschnitte nach Kapitel getrennt (feine Überschrift,
z.B. „Part 1: Goblin Arrows“, in der Reihenfolge der Sessions), eigene darüber unter „Ohne Kapitel“.
Innerhalb eines Kapitels stehen sie in der Reihenfolge des Buchs, sonst nach Namen mit Zahlen in
natürlicher Folge (2 vor 10). Abschnitte mit Unterabschnitten lassen sich mit ▸/▾ auf- und zuklappen,
Kapitel mit einem Klick auf ihre Überschrift; das merkt sich der Browser, der Weg zum offenen Eintrag
bleibt immer offen. (In der Datenbank heissen sie weiter `type='location'`.)

„🏰 Orte“ sind die wirklichen Orte der Welt, von Hand angelegt: jeder mit einer Art, die sein Icon
bestimmt (🗺 Land, 🏞 Region, ⛰ Gebirge, 🌲 Wald, 🌊 Gewässer, 🌾 Wildnis, 🏙 Stadt, 🏘 Dorf, 🧱 Viertel,
🏰 Burg, 🏠 Gebäude, 🍺 Taverne, ⛪ Tempel, 🛒 Laden, 🗼 Turm, 🏚 Ruine, 🪨 Höhle, 🕳 Dungeon; ohne Art 📍),
und „Liegt in“ für die Ordnung Land → Stadt → Gebäude. NPCs (Aufenthaltsort), Fraktionen (Sitz) und
Gegenstände (Im Besitz von) können auf Orte wie auf Kapitel-Abschnitte zeigen.
Kapitel, die vor dieser Änderung als Quest importiert wurden: einmal neu importieren, dann entsteht
die Session (die Quest kann man danach löschen).

„⬆ Stufenaufstieg“ (Spielerseite und Kampagnenbuch) führt Schritt für Schritt zur nächsten Stufe:
Übersicht der neuen Merkmale, Unterklasse (wenn fällig), Attributserhöhung oder Talent (auf den
Stufen dafür), Trefferpunkte (Durchschnitt oder Würfeln), neue Zauber, Abschluss. „Weiter“ geht erst,
wenn der Schritt erledigt ist; erst „Abschliessen“ speichert.

## Starten und stoppen

In diesem Ordner:

```
docker compose up -d --build
docker compose down
```

`down` stoppt nur. Die Daten liegen in den Docker-Volumes `dnd-local_combattracker_data`,
`dnd-local_battlemap_data` und `dnd-local_dmtool_data` und bleiben erhalten.
Nie `docker compose down -v` ausführen: das löscht die Volumes und damit alle Daten.

## Daten übernehmen

In jedem Tool unter „⚙ Einrichtung → Datensicherung“ eine Sicherung herunterladen und im anderen
Tool über „Sicherung wiederherstellen“ einspielen. Reihenfolge: zuerst das Kampagnenbuch (Kampagnen,
Charaktere, Bibliothek), dann den Combat Tracker (Encounter), zuletzt die Battlemap.

Stände von vor dem Umzug der Charaktere und der Bibliothek: Tracker-Sicherung einspielen, dann im
Kampagnenbuch unter „⚙ Einrichtung → Combat Tracker“ einmalig „Charaktere und Bibliothek aus dem
Tracker übernehmen“. Das geht nur, solange Charaktere, Bestiarium, Items und Zauber dort noch leer sind.

## Kampagnenvorlagen (dieselbe Kampagne mit einer anderen Gruppe)

„⚙ Einrichtung → Vorlagen → Kampagne als Vorlage sichern…“ legt einen Schnappschuss der offenen
Kampagne an: Einträge, Sessions, Zeitleiste, Charaktere, Encounter des Trackers und Szenen der
Battlemap (mit eigenen Kopien der Kartenbilder). Die Kampagne selbst bleibt unverändert, die Vorlage
auch, wenn man an der Kampagne weiterarbeitet oder sie löscht. Aus einer Vorlage entsteht beliebig oft
eine neue Kampagne: „Neue Kampagne daraus…“ in der Liste, oder „+ Neue Kampagne…“ und dort „Aus
Vorlage“ wählen. Dabei wählbar:

- **Spielstand zurücksetzen** (vorgewählt): nichts den Spielern bekannt, alle Sessions wieder geplant
  ohne Rückblick und Notizen, Zeitleisten-Ereignisse gespielter Sessions weg, Nebel wieder zu,
  Encounter in Runde 1 mit vollen TP und ohne Initiative. Vorbereitungen, Texte, Bilder bleiben.
- **Spielercharaktere übernehmen** (nicht vorgewählt): sonst bleiben die Charaktere der anderen Gruppe
  weg, mit ihren Gruppe-Einträgen, ihren Plätzen in den Encountern und ihren Spielfiguren auf den Karten.

Bestiarium, Gegenstände und Zauber gelten ohnehin für alle Kampagnen und werden nicht kopiert.
Vorlagen stecken in der Datenbank und damit in jeder Sicherung.

## Automatische Sicherungen

Jedes Tool legt selbst Sicherungen in `backups\auto` ab (`combattracker-auto-…zip`,
`battlemap-auto-…zip`, `dmtool-auto-…zip`), im selben Format wie „Sicherung herunterladen“:
beim Start und danach stündlich geprüft, aber nur wenn sich seit der letzten Sicherung etwas
geändert hat und diese mindestens 12 Stunden alt ist. Pro Tool bleiben die neuesten 14 erhalten.
Wiederherstellen wie oben über „Sicherung wiederherstellen“. Den Ordner ab und zu auf ein anderes
Laufwerk kopieren, dann übersteht er auch einen Defekt des Rechners.

## Deutsche Übersetzung der Bibliothek (DeepL)

Die Texte von Klassen, Unterklassen, Völkern, Hintergründen, Zaubern und Gegenständen sind
englisch (Open5e). Das Kampagnenbuch kann sie mit DeepL übersetzen; die Originale bleiben dabei
erhalten, die deutschen Texte kommen als zusätzliche Felder dazu.

1. Bei [DeepL](https://www.deepl.com/pro-api) ein Konto für „DeepL API Free“ anlegen (gratis,
   500 000 Zeichen pro Monat; DeepL verlangt zur Prüfung eine Kreditkarte, belastet aber nichts).
   Den API-Schlüssel kopieren (endet auf `:fx`).
2. Schlüssel als Umgebungsvariable `DEEPL_API_KEY` setzen:
   in einer Datei `.env` neben der `compose.yaml` (`DEEPL_API_KEY=…`, Vorlage `.env.example`),
   nicht einchecken; auf einem Server alternativ in der Umgebung des Stacks.
   Danach den Stack neu starten.
3. Im Kampagnenbuch ⚙ Einrichtung → „Deutsche Übersetzung“ → „Grundregeln, Zauber und
   Gegenstände übersetzen“. Das sind rund 500 000 Zeichen, also etwa ein Monatskontingent; ist es
   aufgebraucht, hält die Übersetzung an und macht nächsten Monat mit dem Rest weiter.
   „Alles übersetzen“ nimmt auch die Zusatzbücher dazu (insgesamt rund 950 000 Zeichen).
4. Falsche Übersetzungen in der Bibliothek mit ✎ korrigieren. Korrekturen werden nie mehr
   automatisch überschrieben; leer speichern bzw. „Maschinelle Übersetzung“ stellt die
   automatische wieder her.
5. Für die Charaktererstellung die Charakterinhalte neu exportieren und dort hochladen.

Die Übersetzungen liegen in der Datenbank des Kampagnenbuchs (Tabelle `translations`) und sind
damit in der normalen Sicherung enthalten.

**Kampagnentexte und Bestiarium.** Auch NPCs, Orte, Fraktionen, Gegenstände, Quests, Handouts, die
Vorbereitung von Sessions und die Monster lassen sich übersetzen, z.B. nach einem Kapitel-Import
von D&D Beyond. Anders als bei der Bibliothek **ersetzt** die Übersetzung hier den Text, weil man ihn
selbst weiterbearbeitet; das englische Original bleibt bei jedem Eintrag als „🇬🇧 Englisches
Original“ aufklappbar und lässt sich mit „Original wiederherstellen“ zurückholen. Auslösen:
„🌐 Auf Deutsch übersetzen“ unter dem Text eines Eintrags oder einer Session, das Häkchen „danach auf
Deutsch übersetzen“ im Kapitel-Import, oder in der Einrichtung „Diese Kampagne übersetzen“ bzw.
„Bestiarium übersetzen“. Vorher zeigt jede Variante die Zeichenzahl (ein Kapitel wie „Goblin Arrows“
hat rund 35 000). Geheimnisse und Notizen werden nie übersetzt, Namen von Einträgen bleiben, wie
sie sind ([[Verweise]] funktionieren weiter), Schon-Übersetztes wird übersprungen, und ein erneuter
Kapitel-Import hängt den englischen Text nicht wieder an. Bei Monstern bleiben die Sinne englisch
(„passive Perception“ wird dort ausgelesen), Werte und Würfel unverändert.

## Sprache der Oberfläche

Oben rechts in jeder Kopfzeile wählt man die Sprache (Deutsch/English). Die Wahl gilt für diesen
Browser (Cookie, für alle Teile auf demselben Rechner) und auch für die Meldungen des Servers.
Beamer und Anzeigen ohne Kopfzeile folgen dem Browser, in dem sie laufen.

Ohne Wahl gilt die Grundeinstellung: Deutsch, oder `UI_LANG=en` in der `.env` neben der
`compose.yaml` (danach `docker compose up -d`); für die Charaktererstellung in `charcreator/`, für
Kampagnenbuch, Tracker und Battlemap im Root bzw. `dmtool/`. Übersetzt ist alles: Charaktererstellung,
Kampagnenbuch mit Bibliothek und Einrichtung, Combat Tracker, Battlemap, Beamer- und Spieleransichten,
Charakterblatt und Stufenaufstieg, dazu die Fehlermeldungen des Servers.

Auf Englisch zeigen Bibliothekseinträge ihren englischen Namen und Text (die deutsche Übersetzung
nur, wo es kein Original gibt), Würfel heissen d6 statt W6. Was gespeichert wird, bleibt gleich:
eine Gesinnung etwa steht weiter deutsch in der Datenbank. Frei eingetippte Texte und neu
eingetragene Namen (Munition, Übungen der Klasse) kommen in der Sprache, die gerade eingestellt ist.
Die deutsche Übersetzung der Bibliothek mit DeepL gibt es nur auf Deutsch; auf Englisch ist sie
ausgeblendet, und SRD-Einträge aus Open5e behalten ihre englischen Namen.

Fehlende englische Texte zeigt `python tools/check-i18n.py` (mit `--add` werden sie leer in die
Wörterbücher `lang/en.json` eingetragen; leere Einträge zeigen weiter den deutschen Text).

## Betrieb auf einem Server

- Der Root-`compose.yaml` ist für den lokalen Betrieb gedacht. Auf einem Server läuft das Kampagnenbuch
  (mit Tracker und Battlemap) aus `dmtool/compose.yaml`, die Charaktererstellung als eigener Stack aus
  `charcreator/compose.yaml`. Einstellungen kommen aus einer `.env` neben der jeweiligen `compose.yaml`
  (Vorlage: `.env.example`).
- **Das Kampagnenbuch, der Tracker und die Battlemap haben keine Anmeldung.** Sie gehören ins eigene
  Netz (oder hinter einen Reverse Proxy mit Anmeldung), nie ungeschützt ins Internet.
- Die Charaktererstellung ist für Spieler gedacht und kann öffentlich erreichbar sein: Spieler kommen
  über einen persönlichen Link, die Verwaltung ist durch das Admin-Passwort geschützt (`ADMIN_PASSWORD`
  oder `ADMIN_PASSWORD_FILE`; ohne beides erzeugt sie beim ersten Start eines und schreibt es nach
  `/data/admin-password` und einmal ins Log). Davor gehört ein Reverse Proxy mit HTTPS.
