// Rule texts and weapon data for the character sheet: explanations shown when a player clicks
// an ability, skill, class feature, weapon property or sheet term. Short summaries in our own words.
// Loaded before charsheet.js by the DM view and the player sheets, after i18n.js: the texts are
// German and go through t(); names that come from English keys (weapons, damage types) through enNames().

// Names in the UI language: the German table, or its English keys in title case.
const enNames = (table) => (UI_DE ? table
  : Object.fromEntries(Object.keys(table).map((k) => [k, k.replace(/(^|[\s-])(\w)/g, (m, a, b) => a + b.toUpperCase())])));

const ABILITY_INFO = {
  str: t("Körperkraft. Gilt für Nahkampfangriffe und -schaden, Athletik, Klettern, Springen, Tragen und das Stemmen schwerer Dinge. Schwere Rüstung verlangt oft eine Mindeststärke."),
  dex: t("Gewandtheit, Reflexe und Gleichgewicht. Gilt für Fernkampfangriffe, Finesse-Waffen, Initiative und die Rüstungsklasse ohne oder mit leichter/mittelschwerer Rüstung. Fertigkeiten: Akrobatik, Fingerfertigkeit, Heimlichkeit."),
  con: t("Gesundheit und Ausdauer. Der Modifikator kommt pro Stufe zu den Trefferpunkten dazu und gilt für Konzentrationswürfe beim Zaubern."),
  int: t("Verstand, Gedächtnis und Logik. Zauberattribut der Magier. Fertigkeiten: Arkane Kunde, Geschichte, Nachforschungen, Naturkunde, Religion."),
  wis: t("Wahrnehmung, Intuition und Willenskraft. Zauberattribut von Kleriker, Druide und Waldläufer. Fertigkeiten: Heilkunde, Mit Tieren umgehen, Motiv erkennen, Überlebenskunst, Wahrnehmung."),
  cha: t("Ausstrahlung, Überzeugungskraft und Persönlichkeit. Zauberattribut von Barde, Paladin, Zauberer und Hexenmeister. Fertigkeiten: Auftreten, Einschüchtern, Täuschen, Überzeugen."),
};

const SKILL_INFO = {
  acrobatics: t("Auf den Beinen bleiben: balancieren, abrollen, Saltos, sich aus einem Griff winden."),
  animal: t("Ein Tier beruhigen, ein Reittier lenken oder die Absicht eines Tieres erkennen."),
  arcana: t("Wissen über Zauber, magische Gegenstände, Symbole, Ebenen und ihre Bewohner."),
  athletics: t("Klettern, Springen, Schwimmen, Ringen, Stossen und andere Kraftakte."),
  deception: t("Überzeugend lügen, bluffen, sich verkleiden oder jemanden in die Irre führen."),
  history: t("Wissen über vergangene Ereignisse, Reiche, Kriege, Persönlichkeiten und Völker."),
  insight: t("Erkennen, ob jemand lügt, was er fühlt oder was er als Nächstes vorhat."),
  intimidation: t("Jemanden durch Drohungen, Gesten oder rohe Gewalt einschüchtern."),
  investigation: t("Hinweise suchen und daraus schliessen: Fallen finden, Schwachstellen entdecken, Schriften entschlüsseln."),
  medicine: t("Einen Sterbenden stabilisieren oder eine Krankheit erkennen."),
  nature: t("Wissen über Gelände, Pflanzen, Tiere, Wetter und natürliche Kreisläufe."),
  perception: t("Etwas bemerken: hören, sehen, riechen. Aufmerksam sein für Gefahren und Verstecktes."),
  performance: t("Ein Publikum mit Musik, Tanz, Schauspiel oder Erzählkunst begeistern."),
  persuasion: t("Mit Takt, Charme und guten Argumenten jemanden für sich gewinnen."),
  religion: t("Wissen über Götter, Riten, Gebete, heilige Symbole und religiöse Gruppen."),
  sleight: t("Taschendiebstahl, Taschenspielertricks, unbemerkt etwas verstecken oder platzieren."),
  stealth: t("Sich verstecken, leise bewegen und an Wachen vorbeischleichen."),
  survival: t("Spuren lesen, jagen, den Weg finden, das Wetter vorhersagen und Gefahren der Wildnis meiden."),
};

const TERM_INFO = {
  prof: [t("Übungsbonus"), t("Steigt mit der Stufe (+2 bis +6). Er kommt zu jedem Wurf dazu, in dem der Charakter geübt ist: Angriffe mit geübten Waffen, geübte Fertigkeiten und Rettungswürfe, Zauberangriffe und Zauber-SG.")],
  inspiration: [t("Inspiration"), t("Vergibt der Spielleiter für gutes Rollenspiel. Sie kann eingesetzt werden, um bei einem Angriff, Rettungswurf oder einer Probe Vorteil zu haben. Man hat sie oder hat sie nicht, sie stapelt sich nicht.")],
  saves: [t("Rettungswürfe"), t("Würfe, um einer Gefahr zu widerstehen, etwa einem Zauber, Gift oder einer Falle: W20 + Attributsmodifikator, plus Übungsbonus, wenn der Charakter darin geübt ist (gefüllter Punkt). Jede Klasse ist in zwei Rettungswürfen geübt.")],
  skills: [t("Fertigkeiten"), t("Attributsproben für bestimmte Tätigkeiten: W20 + Attributsmodifikator, plus Übungsbonus bei Übung (Punkt) oder doppelter Übungsbonus bei Expertise (Raute).")],
  passive: [t("Passive Wahrnehmung"), t("10 + Wahrnehmungsbonus. Der Spielleiter vergleicht sie verdeckt, etwa mit der Heimlichkeit eines Gegners, ohne dass gewürfelt wird.")],
  ac: [t("Rüstungsklasse (RK)"), t("Ein Angriff trifft, wenn der Angriffswurf die RK erreicht oder übertrifft. Sie ergibt sich aus Rüstung, Geschicklichkeit, Schild und Boni.")],
  init: [t("Initiative"), t("Zu Kampfbeginn würfelt jeder W20 + Initiative. Die Ergebnisse bestimmen die Reihenfolge der Züge. Normalerweise der Geschicklichkeitsmodifikator.")],
  speed: [t("Bewegungsrate"), t("So weit kann sich der Charakter in seinem Zug bewegen. Die Bewegung lässt sich vor, nach und zwischen Angriffen aufteilen. Schwieriges Gelände kostet doppelt.")],
  maxhp: [t("Trefferpunkte-Maximum"), t("Die höchstmögliche Zahl an Trefferpunkten. Sie steigt mit jeder Stufe um den Trefferwürfel plus den Konstitutionsmodifikator.")],
  hp: [t("Momentane Trefferpunkte"), t("Schaden zieht Trefferpunkte ab, Heilung bringt sie zurück, aber nie über das Maximum. Bei 0 fällt der Charakter bewusstlos um und macht Todesrettungswürfe. Eine lange Rast füllt sie ganz auf.")],
  temp: [t("Temporäre Trefferpunkte"), t("Ein Puffer, etwa durch Zauber oder Fähigkeiten. Schaden wird zuerst von ihnen abgezogen. Sie zählen nicht als Heilung, stapeln sich nicht (der höhere Wert gilt) und verfallen nach einer langen Rast.")],
  hitdice: [t("Trefferwürfel"), t("Einen pro Stufe. Bei einer kurzen Rast kann man beliebig viele ausgeben und heilt jeweils den Wurf plus Konstitutionsmodifikator („Ausgeben“ würfelt und heilt automatisch; ein Punkt lässt sich auch von Hand abhaken). Eine lange Rast bringt die Hälfte der Gesamtzahl zurück, mindestens einen.")],
  spellability: [t("Zauberattribut"), t("Das Attribut, mit dem die Klasse zaubert. Sein Modifikator bestimmt Zauber-SG und Zauberangriff.")],
  spelldc: [t("Zauber-SG"), t("8 + Übungsbonus + Modifikator des Zauberattributs. Diesen Wert muss ein Ziel mit seinem Rettungswurf erreichen, um dem Zauber zu widerstehen.")],
  spellattack: [t("Zauberangriff"), t("Übungsbonus + Modifikator des Zauberattributs. Kommt bei Zaubern mit Angriffswurf zum W20 dazu, z.B. Feuerpfeil.")],
  cantrips: [t("Zaubertricks"), t("Zauber des Grades 0. Sie kosten keine Zauberplätze und können beliebig oft gewirkt werden. Ihr Schaden steigt auf Stufe 5, 11 und 17.")],
  known: [t("Bekannte Zauber"), t("So viele Zauber (ohne Zaubertricks) kennt der Charakter. Beim Stufenaufstieg kann er einen bekannten Zauber gegen einen anderen tauschen.")],
  prepared: [t("Vorbereitete Zauber"), t("So viele Zauber (ohne Zaubertricks) können nach einer langen Rast aus der Zauberliste vorbereitet werden. Nur vorbereitete Zauber können gewirkt werden.")],
  slots: [t("Zauberplätze"), t("Jeder Zauber ab Grad 1 verbraucht einen Platz seines Grades oder höher. Mit einem höheren Platz wird der Zauber oft stärker. Ein Klick auf einen Platz markiert ihn als verbraucht. Eine lange Rast bringt alle zurück.")],
  pact: [t("Paktmagie"), t("Hexenmeister haben wenige Plätze, die alle den gleichen, höchsten Grad haben und schon nach einer kurzen Rast zurückkommen.")],
  ammo: [t("Munition"), t("Fernkampfwaffen mit der Eigenschaft Munition verbrauchen bei jedem Angriff ein Geschoss. Nach dem Kampf kann man die Hälfte der verschossenen Munition wieder einsammeln.")],
  attack: [t("Angriffe"), t("Angriffswurf: W20 + Bonus gegen die RK des Ziels. Bei einem Treffer wird der Schaden gewürfelt. Eine natürliche 20 ist ein kritischer Treffer: alle Schadenswürfel werden doppelt gewürfelt.")],
  rest: [t("Rasten"), t("Kurze Rast (mind. 1 Stunde): Trefferwürfel ausgeben, Paktmagie und manche Fähigkeiten kommen zurück. Lange Rast (8 Stunden): alle Trefferpunkte und Zauberplätze kommen zurück, temporäre Trefferpunkte verfallen.")],
  concentration: [t("Konzentration"), t("Nur ein Konzentrationszauber kann gleichzeitig wirken. Bei Schaden ist ein Konstitutionsrettungswurf nötig (SG 10 oder halber Schaden, der höhere Wert), sonst endet der Zauber.")],
  ritual: [t("Ritual"), t("Ritualzauber können ohne Zauberplatz gewirkt werden, wenn man 10 Minuten länger dafür braucht, sofern die Klasse Rituale wirken kann.")],
};

// Origin feats of the 2024 backgrounds, in short (the library only names them: "Feat: Alert").
// Keys: the English name in lower case, without the "(Cleric)" behind Magic Initiate.
const FEAT_INFO = {
  "alert": [t("Wachsam (Alert)"), t("Du addierst deinen Übungsbonus auf deine Initiative. Direkt nach dem Initiativewurf darfst du deine Initiative mit der eines bereitwilligen Verbündeten tauschen, solange keiner von euch kampfunfähig ist.")],
  "crafter": [t("Handwerker (Crafter)"), t("Übung mit drei Handwerkszeugen nach Wahl. Nichtmagische Gegenstände kaufst du 20 % günstiger. Nach einer langen Rast kannst du mit einem Werkzeug, in dem du geübt bist, einen einfachen Gegenstand anfertigen, der bis zur nächsten langen Rast hält.")],
  "healer": [t("Heiler (Healer)"), t("Mit einem Heilerset versorgst du als Aktion eine Kreatur: Sie gibt einen Trefferwürfel aus und heilt den Wurf plus deinen Übungsbonus. Würfelst du beim Heilen eine 1, darfst du neu würfeln.")],
  "lucky": [t("Glückspilz (Lucky)"), t("Du hast so viele Glückspunkte wie dein Übungsbonus (zurück nach einer langen Rast). Für einen Punkt hast du Vorteil auf einen eigenen W20-Wurf oder gibst einem Angriff gegen dich Nachteil.")],
  "magic initiate": [t("Magie-Eingeweihter (Magic Initiate)"), t("Zwei Zaubertricks und ein Zauber des 1. Grades aus der Liste in Klammern (Kleriker, Druide oder Magier). Den Grad-1-Zauber kannst du einmal pro langer Rast ohne Zauberplatz wirken, sonst mit deinen Zauberplätzen. Zauberattribut nach Wahl: Intelligenz, Weisheit oder Charisma. Bei jedem Stufenaufstieg darfst du einen der Zauber austauschen. Die Zauber bitte mit der Spielleitung festlegen und auf dem Blatt eintragen.")],
  "musician": [t("Musiker (Musician)"), t("Übung mit drei Musikinstrumenten. Nach einer kurzen oder langen Rast kannst du ein Lied spielen und damit so vielen Verbündeten Heldenmut geben, wie dein Übungsbonus beträgt.")],
  "savage attacker": [t("Wilder Angreifer (Savage Attacker)"), t("Einmal pro Zug, wenn du mit einer Waffe triffst, darfst du die Schadenswürfel der Waffe zweimal werfen und das bessere Ergebnis nehmen.")],
  "skilled": [t("Vielseitig (Skilled)"), t("Übung in drei Fertigkeiten oder Werkzeugen nach Wahl, beliebig gemischt.")],
  "tavern brawler": [t("Kneipenschläger (Tavern Brawler)"), t("Dein waffenloser Schlag macht W4 + Stärke Schaden, Einsen beim Schaden darfst du neu würfeln. Du bist mit improvisierten Waffen geübt und kannst einmal pro Zug ein Ziel, das du waffenlos triffst, 1,5 m wegstossen.")],
  "tough": [t("Zäh (Tough)"), t("Dein Trefferpunkte-Maximum steigt um das Doppelte deiner Stufe und bei jedem weiteren Stufenaufstieg um 2. Bitte beim TP-Maximum dazurechnen.")],
};

// Tools a background makes the character proficient with, in short. Keys: English, lower case.
const TOOL_INFO = {
  "thieves' tools": [t("Diebeswerkzeug"), t("Dietriche, Feile und Spiegel: Schlösser öffnen und Fallen entschärfen.")],
  "calligrapher's supplies": [t("Kalligrafie-Werkzeug"), t("Tinte, Federn und Pergament: kunstvoll schreiben, Abschriften anfertigen, gefälschte Handschriften erkennen.")],
  "gaming set": [t("Spielset"), t("Würfel, Karten oder Drachenschach: Glücks- und Strategiespiele spielen und Falschspieler erkennen.")],
  "herbalism kit": [t("Kräuterkunde-Ausrüstung"), t("Kräuter bestimmen und sammeln, Heiltränke und Gegengifte herstellen.")],
  "disguise kit": [t("Verkleidungsset"), t("Schminke, Perücken und Kostüme, um das eigene Aussehen zu verändern.")],
  "forgery kit": [t("Fälscherset"), t("Dokumente, Siegel und Unterschriften nachmachen.")],
  "poisoner's kit": [t("Giftmischer-Ausrüstung"), t("Gifte herstellen, erkennen und sicher handhaben.")],
  "navigator's tools": [t("Navigationswerkzeug"), t("Kurs bestimmen, Seekarten lesen, die Position nach den Sternen ermitteln.")],
  "cartographer's tools": [t("Kartografenwerkzeug"), t("Karten zeichnen, lesen und Gelände vermessen.")],
  "musical instrument": [t("Musikinstrument"), t("Auf dem Instrument spielen und damit auftreten.")],
  "vehicles (land)": [t("Landfahrzeuge"), t("Kutschen, Wagen und Schlitten lenken.")],
  "vehicles (water)": [t("Wasserfahrzeuge"), t("Boote und Schiffe steuern.")],
  "alchemist's supplies": [t("Alchemistenausrüstung"), t("Säure, Alchemistenfeuer und andere Mischungen herstellen und Stoffe bestimmen.")],
  "brewer's supplies": [t("Brauerausrüstung"), t("Bier und andere Getränke brauen, Wasser reinigen.")],
  "carpenter's tools": [t("Zimmermannswerkzeug"), t("Holzbauten errichten und reparieren, Türen verstärken oder aufbrechen.")],
  "cook's utensils": [t("Kochgeschirr"), t("Gute Mahlzeiten zubereiten, auch aus wenigen Vorräten.")],
  "smith's tools": [t("Schmiedewerkzeug"), t("Metall bearbeiten, Waffen und Rüstungen ausbessern.")],
  "tinker's tools": [t("Tüftlerwerkzeug"), t("Kleine Mechanismen bauen und reparieren.")],
  "leatherworker's tools": [t("Lederwerkzeug"), t("Leder verarbeiten, Rüstung und Ausrüstung aus Leder herstellen und flicken.")],
  "mason's tools": [t("Steinmetzwerkzeug"), t("Stein bearbeiten, Mauern bauen und Schwachstellen in Mauerwerk erkennen.")],
  "painter's supplies": [t("Malerausrüstung"), t("Bilder malen und Zeichnungen anfertigen.")],
  "potter's tools": [t("Töpferwerkzeug"), t("Gefässe aus Ton formen und brennen.")],
  "weaver's tools": [t("Weberwerkzeug"), t("Stoffe weben und Kleidung ausbessern.")],
  "woodcarver's tools": [t("Holzschnitzwerkzeug"), t("Holz schnitzen, Pfeile und kleine Holzgegenstände herstellen.")],
  "cobbler's tools": [t("Schusterwerkzeug"), t("Schuhe herstellen und reparieren.")],
  "jeweler's tools": [t("Juwelierwerkzeug"), t("Edelsteine schleifen, schätzen und Schmuck fertigen.")],
  "glassblower's tools": [t("Glasbläserwerkzeug"), t("Glas formen, Gefässe und Linsen herstellen.")],
};
const TOOL_RULE = t("Mit Übung kommt der Übungsbonus zu Proben dazu, bei denen das Werkzeug gebraucht wird.");

// Class spellcasting in short, shown under Zauberwirken.
const SPELLCASTING_RULES = {
  bard: t("Kennt eine feste Zahl Zauber aus der Bardenliste und kann sie jederzeit wirken. Rituale möglich, wenn der Zauber bekannt ist. Musikinstrument als Zauberfokus."),
  cleric: t("Bereitet nach jeder langen Rast Zauber aus der ganzen Klerikerliste vor (Weisheitsmodifikator + Stufe). Domänenzauber sind immer zusätzlich vorbereitet. Rituale möglich. Heiliges Symbol als Fokus."),
  druid: t("Bereitet nach jeder langen Rast Zauber aus der ganzen Druidenliste vor (Weisheitsmodifikator + Stufe). Rituale möglich. Druidenfokus (z.B. Mistelzweig, Stab)."),
  paladin: t("Zaubert ab Stufe 2. Bereitet nach jeder langen Rast Zauber vor (Charismamodifikator + halbe Stufe). Eidzauber sind immer zusätzlich vorbereitet. Heiliges Symbol als Fokus."),
  ranger: t("Zaubert ab Stufe 2. Kennt eine feste Zahl Zauber aus der Waldläuferliste. Beim Stufenaufstieg kann ein bekannter Zauber getauscht werden."),
  sorcerer: t("Kennt eine feste Zahl Zauber aus der Zaubererliste. Zauberpunkte und Metamagie verändern Zauber oder schaffen neue Plätze. Arkaner Fokus möglich."),
  warlock: t("Kennt eine feste Zahl Zauber. Alle Paktplätze haben den höchsten verfügbaren Grad und kommen nach einer kurzen Rast zurück. Ab Stufe 11 je ein Mystisches Arkanum für Grad 6 bis 9."),
  wizard: t("Zauberbuch mit 6 Zaubern auf Stufe 1, dazu 2 neue pro Stufe. Bereitet nach jeder langen Rast daraus vor (Intelligenzmodifikator + Stufe). Rituale aus dem Zauberbuch, auch unvorbereitet."),
};

const FEATURE_INFO = {
  "Kampfrausch": t("Bonusaktion, 1 Minute lang: Vorteil auf Stärkeproben und -rettungswürfe, Bonus auf Nahkampfschaden mit Stärke, Resistenz gegen Hieb-, Stich- und Wuchtschaden. Nicht mit schwerer Rüstung, kein Zaubern."),
  "Ungerüstete Verteidigung": t("Ohne Rüstung zählt eine eigene RK-Formel aus zwei Attributen (Barbar: GES + KON, auch mit Schild; Mönch: GES + WEI, ohne Schild)."),
  "Rücksichtsloser Angriff": t("Beim ersten Angriff im Zug wählbar: Vorteil auf Nahkampfangriffe mit Stärke in diesem Zug, dafür haben Angriffe gegen dich bis zum nächsten Zug ebenfalls Vorteil."),
  "Extra-Angriff": t("Mit der Angriffsaktion greifst du mehrmals statt einmal an."),
  "Schnelle Bewegung": t("Die Bewegungsrate steigt um 10 ft (3 m), solange keine schwere Rüstung getragen wird. Das Blatt rechnet sie automatisch ein."),
  "Brutaler kritischer Treffer": t("Bei einem kritischen Nahkampftreffer werden zusätzliche Waffenschadenswürfel gewürfelt."),
  "Bardische Inspiration": t("Bonusaktion: Ein Verbündeter in 18 m erhält einen Inspirationswürfel. Innerhalb von 10 Minuten kann er ihn zu einem Angriff, Rettungswurf oder einer Probe addieren."),
  "Lied der Erholung": t("Wer während einer kurzen Rast Trefferwürfel ausgibt und dein Lied hört, heilt zusätzlich den angegebenen Würfel."),
  "Hansdampf in allen Gassen": t("Halber Übungsbonus (abgerundet) auf alle Attributsproben, in denen du nicht geübt bist."),
  "Expertise": t("In den gewählten Fertigkeiten zählt der doppelte Übungsbonus (Raute auf dem Blatt)."),
  "Gegenzauber-Lied": t("Aktion: Bis Ende deines nächsten Zuges haben du und Verbündete in 9 m Vorteil auf Rettungswürfe gegen Verängstigt und Bezaubert."),
  "Göttliche Macht fokussieren": t("Göttliche Energie für einen Effekt deiner Gottheit oder deines Eides, z.B. Untote vertreiben. Kommt nach einer kurzen Rast zurück."),
  "Untote zerstören": t("Untote bis zum angegebenen Herausforderungsgrad, die vertrieben werden, werden sofort vernichtet."),
  "Göttliches Eingreifen": t("Du bittest deine Gottheit um Hilfe. Mit W100 bis zur angegebenen Chance greift sie ein; danach 7 Tage nicht mehr möglich."),
  "Druidisch": t("Geheime Sprache der Druiden, auch für versteckte Botschaften."),
  "Tiergestalt": t("Aktion: Verwandlung in ein bereits gesehenes Tier bis zum angegebenen Herausforderungsgrad. Du übernimmst dessen Werte und Trefferpunkte; fallen sie auf 0, kehrst du mit deinen eigenen zurück."),
  "Zeitlose Gestalt": t("Du alterst nur noch sehr langsam."),
  "Kampfstil": t("Gewählte Spezialisierung, z.B. Bogenschiessen (+2 auf Fernkampfangriffe), Verteidigung (+1 RK in Rüstung) oder Duellieren (+2 Schaden mit einer Einhandwaffe)."),
  "Durchatmen": t("Bonusaktion: Du heilst 1W10 + Stufe Trefferpunkte."),
  "Tatendrang": t("In deinem Zug eine zusätzliche Aktion."),
  "Unbeugsam": t("Einen misslungenen Rettungswurf wiederholen; das neue Ergebnis gilt."),
  "Kampfkunst": t("Mit waffenlosen Schlägen und Mönchswaffen GES statt STÄ nutzen, den Kampfkunstwürfel als Schaden verwenden und nach einem Angriff einen waffenlosen Schlag als Bonusaktion machen."),
  "Ki-Punkte": t("Für Ki-Fähigkeiten: Schlaghagel (zwei waffenlose Schläge als Bonusaktion), Geduldige Verteidigung (Ausweichen als Bonusaktion), Schritt des Windes (Spurt oder Rückzug als Bonusaktion). Kommen nach einer kurzen Rast zurück."),
  "Ungerüstete Bewegung": t("Ohne Rüstung und Schild ist die Bewegungsrate höher."),
  "Geschosse abwehren": t("Reaktion bei einem Fernkampftreffer: Schaden verringern. Fällt er auf 0, kannst du das Geschoss für 1 Ki zurückwerfen."),
  "Betäubender Schlag": t("Nach einem Nahkampftreffer 1 Ki: Das Ziel muss einen KON-Rettungswurf schaffen, sonst ist es bis Ende deines nächsten Zuges betäubt."),
  "Entrinnen": t("Bei Effekten mit GES-Rettungswurf für halben Schaden: kein Schaden bei Erfolg, halber bei Misserfolg."),
  "Göttliches Gespür": t("Aktion: Bis Ende deines nächsten Zuges spürst du Himmlische, Unholde und Untote in 18 m, die nicht in voller Deckung sind."),
  "Handauflegen": t("Ein Vorrat an Heilung, aus dem du per Berührung beliebig verteilst. 5 Punkte heilen alternativ eine Krankheit oder ein Gift."),
  "Göttliches Niederstrecken": t("Nach einem Nahkampftreffer einen Zauberplatz ausgeben für zusätzlichen gleissenden Schaden, gegen Untote und Unholde noch mehr."),
  "Aura des Schutzes": t("Du und Verbündete in Reichweite erhalten deinen Charismamodifikator auf alle Rettungswürfe, solange du bei Bewusstsein bist."),
  "Bevorzugter Feind": t("Vorteil beim Verfolgen und auf Wissensproben über die gewählten Feindtypen; dazu eine ihrer Sprachen."),
  "Erfahrener Erkunder": t("Im bevorzugten Gelände: doppelter Übungsbonus auf Wissensproben, kein Verirren, Reisen ohne Tempoverlust."),
  "Hinterhältiger Angriff": t("Einmal pro Zug Zusatzschaden, wenn du mit einer Finesse- oder Fernkampfwaffe triffst und Vorteil hast oder ein Verbündeter neben dem Ziel steht."),
  "Diebessprache": t("Geheime Mischung aus Zeichen und Jargon, mit der Schurken versteckte Botschaften austauschen."),
  "Raffinierte Aktion": t("Spurt, Rückzug oder Verstecken als Bonusaktion."),
  "Unglaubliches Ausweichen": t("Reaktion, wenn dich ein sichtbarer Angreifer trifft: Der Schaden wird halbiert."),
  "Zauberische Herkunft": t("Die Quelle deiner Magie, z.B. Drachenblut oder Wilde Magie, mit eigenen Fähigkeiten."),
  "Zauberpunkte": t("In Zauberplätze umwandelbar (und umgekehrt) oder für Metamagie einsetzbar. Kommen nach einer langen Rast zurück."),
  "Metamagie": t("Zauber mit Zauberpunkten verändern, z.B. zwei Ziele (Doppelt), mehr Reichweite (Weit) oder als Bonusaktion (Beschleunigt)."),
  "Paktmagie": t("Wenige Zauberplätze, alle vom höchsten Grad, zurück nach jeder kurzen Rast."),
  "Andersweltlicher Schutzpatron": t("Das Wesen, mit dem du den Pakt geschlossen hast, z.B. ein Erzfeen-Wesen, ein Unhold oder der Grosse Alte."),
  "Schauerliche Anrufungen": t("Dauerhafte magische Gaben, z.B. Schauerlicher Strahl verstärken oder im Dunkeln sehen."),
  "Paktgabe": t("Geschenk deines Patrons: Paktklinge (beschworene Waffe), Paktkette (besonderer Vertrauter) oder Paktfoliant (Buch mit Zaubertricks)."),
  "Mystisches Arkanum": t("Je ein Zauber der Grade 6 bis 9, der einmal pro langer Rast ohne Zauberplatz gewirkt werden kann."),
  "Arkane Erholung": t("Einmal am Tag nach einer kurzen Rast verbrauchte Zauberplätze zurückholen, bis zur angegebenen Summe der Grade (höchstens Grad 5)."),
  "Zauberbuch": t("Enthält alle Zauber, die der Magier vorbereiten kann. Gefundene Zauber lassen sich gegen Zeit und Gold abschreiben."),
  "Arkane Tradition": t("Gewählte Schule der Magie mit eigenen Fähigkeiten, z.B. Hervorrufung oder Bannmagie."),
};

// Weapon properties as Open5e lists them ("versatile (1d10)", "thrown (range 20/60)").
const WEAPON_PROPERTIES = {
  ammunition: [t("Munition"), t("Braucht Munition; jeder Angriff verbraucht ein Geschoss. Die Zahlen sind normale und maximale Reichweite in Fuss; auf grosse Entfernung mit Nachteil.")],
  finesse: [t("Finesse"), t("Für Angriff und Schaden kann wahlweise STÄ oder GES verwendet werden. Das Blatt nimmt automatisch den besseren Wert.")],
  heavy: [t("Schwer"), t("Kleine Kreaturen haben Nachteil auf Angriffe mit dieser Waffe.")],
  light: [t("Leicht"), t("Für den Kampf mit zwei Waffen: Nach einem Angriff mit einer leichten Waffe kann man als Bonusaktion mit einer zweiten leichten Waffe angreifen (ohne Modifikator auf den Schaden).")],
  loading: [t("Laden"), t("Pro Aktion, Bonusaktion oder Reaktion nur ein Schuss, auch mit Extra-Angriff.")],
  reach: [t("Reichweite"), t("Die Nahkampfreichweite ist 1,5 m grösser, also 3 m.")],
  special: [t("Speziell"), t("Hat eigene Regeln, siehe Beschreibung der Waffe.")],
  thrown: [t("Wurfwaffe"), t("Kann geworfen werden und nutzt dabei dasselbe Attribut wie im Nahkampf. Die Zahlen sind normale und maximale Reichweite in Fuss.")],
  "two-handed": [t("Zweihändig"), t("Braucht beide Hände zum Angreifen.")],
  versatile: [t("Vielseitig"), t("Einhändig oder zweihändig führbar; zweihändig gilt der Schaden in Klammern.")],
};

// SRD weapon names (Open5e, English) in German, also used to match "Weitere Übungen".
const WEAPON_DE = enNames({
  club: "Keule", dagger: "Dolch", greatclub: "Zweihandknüppel", handaxe: "Handaxt", javelin: "Wurfspeer",
  "light hammer": "Leichter Hammer", mace: "Streitkolben", quarterstaff: "Kampfstab", sickle: "Sichel", spear: "Speer",
  "crossbow, light": "Leichte Armbrust", dart: "Wurfpfeil", shortbow: "Kurzbogen", sling: "Schleuder",
  battleaxe: "Streitaxt", flail: "Flegel", glaive: "Glefe", greataxe: "Zweihandaxt", greatsword: "Zweihänder",
  halberd: "Hellebarde", lance: "Lanze", longsword: "Langschwert", maul: "Zweihandhammer", morningstar: "Morgenstern",
  pike: "Pike", rapier: "Rapier", scimitar: "Krummsäbel", shortsword: "Kurzschwert", trident: "Dreizack",
  "war pick": "Kriegspicke", warhammer: "Kriegshammer", whip: "Peitsche", blowgun: "Blasrohr",
  "crossbow, hand": "Handarmbrust", "crossbow, heavy": "Schwere Armbrust", longbow: "Langbogen", net: "Netz",
});

const DAMAGE_TYPE_DE = enNames({
  slashing: "Hieb", piercing: "Stich", bludgeoning: "Wucht", fire: "Feuer", cold: "Kälte", lightning: "Blitz",
  thunder: "Schall", acid: "Säure", poison: "Gift", necrotic: "Nekrotisch", radiant: "Gleissend",
  force: "Energie", psychic: "Psychisch",
});

// Ammunition always on offer, besides ammunition items from the library.
const STANDARD_AMMO = [t("Pfeile"), t("Armbrustbolzen"), t("Blasrohrnadeln"), t("Schleuderkugeln")];

// Base walking speed in feet by people (PHB and common supplements), matched against the free-text
// "Volk" field. First match wins, so subraces and "Halb-" peoples come before the plain names.
// extra: further movement types, also in feet.
const RACE_SPEEDS = [
  [["waldelf", "wood elf", "holzelf"], 35],
  [["halbelf", "half-elf", "half elf"], 30],
  [["halbork", "half-orc", "half orc"], 30],
  [["halbling", "halfling"], 25],
  [["zwerg", "dwarf", "duergar"], 25],
  [["gnom", "gnome"], 25],
  [["aarakocra"], 25, { fly: 50 }],
  [["tabaxi"], 30, { climb: 20 }],
  [["echsenmensch", "lizardfolk"], 30, { swim: 30 }],
  [["triton"], 30, { swim: 30 }],
  [["zentaur", "kentaur", "centaur"], 40],
  [["satyr"], 35],
  [["elf", "drow"], 30],
  [["mensch", "human", "drachenblütig", "dragonborn", "tiefling", "ork", "orc", "goliath", "firbolg", "kenku",
    "tortle", "goblin", "grottenschrat", "bugbear", "kobold", "aasimar", "genasi", "yuan-ti", "minotaur",
    "harengon", "wechselbalg", "changeling", "warforged", "kriegsgeschmiedet"], 30],
];

const MOVE_LABELS = { fly: t("Fliegen"), swim: t("Schwimmen"), climb: t("Klettern") };
