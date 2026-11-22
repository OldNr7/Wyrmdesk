// Character sheet (player characters, plus the helpers the DM view's monster sheet uses).
// Shared by the DM view (port 8000) and the player sheets (port 8001, /spieler/); both serve it under /shared/.
// Expects the page to define escapeHtml() and a global state.items with the item library (armor choice).

const ABILITIES = [
  ["str", "STR", t("Stärke")],
  ["dex", "DEX", t("Geschicklichkeit")],
  ["con", "CON", t("Konstitution")],
  ["int", "INT", t("Intelligenz")],
  ["wis", "WIS", t("Weisheit")],
  ["cha", "CHA", t("Charisma")],
];

const SHEET_SHIELD_PATH = "M12 1 L22 5 V13 C22 20 17 25 12 27 C7 25 2 20 2 13 V5 Z";

const SPEED_LABELS = { walk: "", fly: t("Fliegen"), swim: t("Schwimmen"), climb: t("Klettern"), burrow: t("Graben") };

// Monster-only rows of the "Resistenzen & Immunitäten" box (stat_block keys as delivered by Open5e).
const DEFENSES = [
  ["damage_vulnerabilities", t("Verwundbar")],
  ["damage_resistances", t("Resistent")],
  ["damage_immunities", t("Immun")],
  ["condition_immunities", t("Zustandsimmun")],
];

// Open5e text blocks; shown read-only and kept untouched when a monster is edited.
const FEATURE_SECTIONS = [
  ["special_abilities", t("Merkmale")],
  ["actions", t("Aktionen")],
  ["reactions", t("Reaktionen")],
  ["legendary_actions", t("Legendäre Aktionen")],
];

const PASSIVE_RE = /,?\s*passive Perception\s+(\d+)/i;

function abilityMod(score) {
  if (score === null || score === undefined || score === "" || isNaN(score)) return "–";
  const mod = Math.floor((score - 10) / 2);
  return mod >= 0 ? `+${mod}` : `${mod}`;
}

function signed(n) {
  if (n === null || n === undefined || n === "" || isNaN(n)) return "–";
  return n >= 0 ? `+${n}` : `${n}`;
}

function valOrEmpty(v) {
  return v === null || v === undefined ? "" : v;
}

// Open5e delivers speed as {walk: 30, fly: 60, hover: true}; sheets store a plain string.
function formatSpeed(speed) {
  if (!speed) return "";
  if (typeof speed !== "object") return String(speed);
  const parts = [];
  for (const [k, v] of Object.entries(speed)) {
    if (k === "hover" || v === null || v === undefined || v === false) continue;
    const val = typeof v === "number" ? `${v} ft` : v;
    const label = k in SPEED_LABELS ? SPEED_LABELS[k] : k;
    parts.push(label ? `${label} ${val}` : val);
  }
  if (speed.hover) parts.push(t("(schwebend)"));
  return parts.join(", ");
}

// Open5e puts passive perception into the senses text ("darkvision 60 ft., passive Perception 9").
function splitSenses(sb) {
  const senses = sb.senses || "";
  const m = senses.match(PASSIVE_RE);
  const passive = sb.passive_perception ?? (m ? parseInt(m[1], 10) : null);
  const rest = senses.replace(PASSIVE_RE, "").replace(/^[,\s]+|[,\s]+$/g, "");
  return { senses: rest || null, passive };
}

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

// Flattens a character, monster or combatant into the fields shown on the sheet.
function sheetFields(entity, kind) {
  entity = entity || {};
  const sb = entity.stat_block || {};
  const { senses, passive } = splitSenses(sb);
  const f = {
    name: entity.name,
    max_hp: entity.max_hp,
    ac: entity.ac,
    initiative_bonus: entity.initiative_bonus ?? 0,
    notes: entity.notes,
    abilities: sb.abilities || {},
    passive_perception: passive,
    speed: formatSpeed(sb.speed) || null,
    languages: sb.languages,
  };
  if (kind === "monster") {
    f.creature_type = entity.creature_type || null;
    f.challenge_rating = entity.challenge_rating ?? sb.challenge_rating;
    f.senses = senses;
    for (const [key] of DEFENSES) f[key] = sb[key] || null;
  } else {
    f.race = sb.race;
    f.char_class = sb.char_class;
  }
  return f;
}

// ---------- full player character sheet (class-aware) ----------

const SKILLS = [
  ["acrobatics", t("Akrobatik"), "dex"],
  ["arcana", t("Arkane Kunde"), "int"],
  ["athletics", t("Athletik"), "str"],
  ["performance", t("Auftreten"), "cha"],
  ["intimidation", t("Einschüchtern"), "cha"],
  ["sleight", t("Fingerfertigkeit"), "dex"],
  ["history", t("Geschichte"), "int"],
  ["medicine", t("Heilkunde"), "wis"],
  ["stealth", t("Heimlichkeit"), "dex"],
  ["animal", t("Mit Tieren umgehen"), "wis"],
  ["insight", t("Motiv erkennen"), "wis"],
  ["investigation", t("Nachforschungen"), "int"],
  ["nature", t("Naturkunde"), "int"],
  ["religion", t("Religion"), "int"],
  ["deception", t("Täuschen"), "cha"],
  ["survival", t("Überlebenskunst"), "wis"],
  ["persuasion", t("Überzeugen"), "cha"],
  ["perception", t("Wahrnehmung"), "wis"],
].sort((a, b) => a[1].localeCompare(b[1], UI_LOCALE));

// Stored in German; shown in the UI language.
const ALIGNMENTS = [
  tk("Rechtschaffen gut"), tk("Neutral gut"), tk("Chaotisch gut"),
  tk("Rechtschaffen neutral"), tk("Neutral"), tk("Chaotisch neutral"),
  tk("Rechtschaffen böse"), tk("Neutral böse"), tk("Chaotisch böse"),
];

const COINS = [["cp", t("KM")], ["sp", t("SM")], ["ep", t("EM")], ["gp", t("GM")], ["pp", t("PM")]];

// Spell slots per spell level for a full caster of character level 1–20 (SRD table).
const FULL_CASTER_SLOTS = [
  [2], [3], [4, 2], [4, 3], [4, 3, 2], [4, 3, 3], [4, 3, 3, 1], [4, 3, 3, 2], [4, 3, 3, 3, 1], [4, 3, 3, 3, 2],
  [4, 3, 3, 3, 2, 1], [4, 3, 3, 3, 2, 1], [4, 3, 3, 3, 2, 1, 1], [4, 3, 3, 3, 2, 1, 1], [4, 3, 3, 3, 2, 1, 1, 1],
  [4, 3, 3, 3, 2, 1, 1, 1], [4, 3, 3, 3, 2, 1, 1, 1, 1], [4, 3, 3, 3, 3, 1, 1, 1, 1], [4, 3, 3, 3, 3, 2, 1, 1, 1],
  [4, 3, 3, 3, 3, 2, 2, 1, 1],
];

// Picks the value for a level from [[fromLevel, value], ...] sorted ascending.
const byLevel = (lvl, steps) => steps.reduce((v, [from, val]) => (lvl >= from ? val : v), steps[0][1]);
const atLeast1 = (n) => Math.max(1, n);

// Everything that differs per class: hit die, saving throws, skill choices, proficiencies,
// spellcasting and the class resources shown under "Klassenmerkmale" (SRD 5.1 values).
const CLASSES = {
  barbarian: {
    label: t("Barbar"), en: "barbarian", hitDie: 12, saves: ["str", "con"],
    skills: [2, ["animal", "athletics", "intimidation", "nature", "perception", "survival"]],
    profs: t("Leichte und mittlere Rüstung, Schilde; einfache Waffen, Kriegswaffen"),
    resources: (l, m) => [
      [tk("Kampfrausch"), t("{uses}, +{n} Schaden", {
        uses: l >= 20 ? t("unbegrenzt") : t("{n}× pro langer Rast", { n: byLevel(l, [[1, 2], [3, 3], [6, 4], [12, 5], [17, 6]]) }),
        n: byLevel(l, [[1, 2], [9, 3], [16, 4]]) })],
      [tk("Ungerüstete Verteidigung"), t("RK {ac}", { ac: 10 + m.dex + m.con })],
      l >= 2 && [tk("Rücksichtsloser Angriff"), t("Vorteil auf STR-Angriffe, Angriffe gegen dich mit Vorteil")],
      l >= 5 && [tk("Extra-Angriff"), t("2 Angriffe pro Aktion")],
      l >= 5 && [tk("Schnelle Bewegung"), t("+10 ft ohne schwere Rüstung")],
      l >= 9 && [tk("Brutaler kritischer Treffer"), t("+{n} Waffenwürfel", { n: byLevel(l, [[9, 1], [13, 2], [17, 3]]) })],
    ],
  },
  bard: {
    label: t("Barde"), en: "bard", hitDie: 8, saves: ["dex", "cha"],
    skills: [3, null],
    profs: t("Leichte Rüstung; einfache Waffen, Handarmbrust, Langschwert, Rapier, Kurzschwert; drei Musikinstrumente"),
    spell: { ability: "cha", type: "full", cantrips: [[1, 2], [4, 3], [10, 4]],
      known: [4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 15, 15, 16, 18, 19, 19, 20, 22, 22, 22] },
    resources: (l, m) => [
      [tk("Bardische Inspiration"), `${diceDe(`d${byLevel(l, [[1, 6], [5, 8], [10, 10], [15, 12]])}`)}, ${l >= 5
        ? t("{n}× pro kurzer Rast", { n: atLeast1(m.cha) }) : t("{n}× pro langer Rast", { n: atLeast1(m.cha) })}`],
      l >= 2 && [tk("Lied der Erholung"), t("+{dice} TP bei kurzer Rast", { dice: diceDe(`d${byLevel(l, [[2, 6], [9, 8], [13, 10], [17, 12]])}`) })],
      l >= 2 && [tk("Hansdampf in allen Gassen"), t("+½ Übungsbonus auf Proben ohne Übung")],
      l >= 3 && [tk("Expertise"), t("{n} Fertigkeiten mit doppeltem Übungsbonus", { n: l >= 10 ? 4 : 2 })],
      l >= 6 && [tk("Gegenzauber-Lied"), t("Vorteil gegen Verängstigen/Bezaubern in 9 m")],
    ],
  },
  cleric: {
    label: t("Kleriker"), en: "cleric", hitDie: 8, saves: ["wis", "cha"],
    skills: [2, ["history", "insight", "medicine", "persuasion", "religion"]],
    profs: t("Leichte und mittlere Rüstung, Schilde; einfache Waffen"),
    spell: { ability: "wis", type: "full", cantrips: [[1, 3], [4, 4], [10, 5]], prepared: (l, m) => atLeast1(l + m.wis) },
    resources: (l) => [
      l >= 2 && [tk("Göttliche Macht fokussieren"), t("{n}× pro kurzer Rast", { n: byLevel(l, [[2, 1], [6, 2], [18, 3]]) })],
      l >= 5 && [tk("Untote zerstören"), t("bis HG {cr}", { cr: byLevel(l, [[5, "1/2"], [8, "1"], [11, "2"], [14, "3"], [17, "4"]]) })],
      l >= 10 && [tk("Göttliches Eingreifen"), l >= 20 ? t("gelingt automatisch, 1× pro Woche") : t("{n}% Chance, 1× pro Woche", { n: l })],
    ],
  },
  druid: {
    label: t("Druide"), en: "druid", hitDie: 8, saves: ["int", "wis"],
    skills: [2, ["arcana", "animal", "insight", "medicine", "nature", "perception", "religion", "survival"]],
    profs: t("Leichte und mittlere Rüstung, Schilde (kein Metall); Keule, Dolch, Wurfpfeil, Speer, Streitkolben, Kampfstab, Krummsäbel, Sichel, Schleuder; Kräuterkundeausrüstung"),
    spell: { ability: "wis", type: "full", cantrips: [[1, 2], [4, 3], [10, 4]], prepared: (l, m) => atLeast1(l + m.wis) },
    resources: (l) => [
      [tk("Druidisch"), t("Geheimsprache der Druiden")],
      l >= 2 && [tk("Tiergestalt"), t("2× pro kurzer Rast, bis HG {cr}, {h} Std.", {
        cr: byLevel(l, [[2, t("1/4, kein Fliegen/Schwimmen")], [4, t("1/2, kein Fliegen")], [8, "1"]]), h: Math.floor(l / 2) })],
      l >= 18 && [tk("Zeitlose Gestalt"), t("altert nur 1 Jahr pro 10 Jahre")],
    ],
  },
  fighter: {
    label: t("Kämpfer"), en: "fighter", hitDie: 10, saves: ["str", "con"],
    skills: [2, ["acrobatics", "animal", "athletics", "history", "insight", "intimidation", "perception", "survival"]],
    profs: t("Alle Rüstungen, Schilde; einfache Waffen, Kriegswaffen"),
    resources: (l) => [
      [tk("Kampfstil"), t("gewählter Stil")],
      [tk("Durchatmen"), t("1W10 + {n} TP, 1× pro kurzer Rast", { n: l })],
      l >= 2 && [tk("Tatendrang"), t("{n}× pro kurzer Rast", { n: l >= 17 ? 2 : 1 })],
      l >= 5 && [tk("Extra-Angriff"), t("{n} Angriffe pro Aktion", { n: byLevel(l, [[5, 2], [11, 3], [20, 4]]) })],
      l >= 9 && [tk("Unbeugsam"), t("{n}× pro langer Rast", { n: byLevel(l, [[9, 1], [13, 2], [17, 3]]) })],
    ],
  },
  monk: {
    label: t("Mönch"), en: "monk", hitDie: 8, saves: ["str", "dex"],
    skills: [2, ["acrobatics", "athletics", "history", "insight", "religion", "stealth"]],
    profs: t("Einfache Waffen, Kurzschwert; ein Handwerkszeug oder Musikinstrument"),
    resources: (l, m, p) => [
      [tk("Kampfkunst"), t("{dice} waffenloser Schaden", { dice: diceDe(`d${byLevel(l, [[1, 4], [5, 6], [11, 8], [17, 10]])}`) })],
      [tk("Ungerüstete Verteidigung"), t("RK {ac}", { ac: 10 + m.dex + m.wis })],
      l >= 2 && [tk("Ki-Punkte"), t("{n} pro kurzer Rast, SG {dc}", { n: l, dc: 8 + p + m.wis })],
      l >= 2 && [tk("Ungerüstete Bewegung"), `+${byLevel(l, [[2, 10], [6, 15], [10, 20], [14, 25], [18, 30]])} ft`],
      l >= 3 && [tk("Geschosse abwehren"), t("Schaden −(1W10 + {n})", { n: m.dex + l })],
      l >= 5 && [tk("Extra-Angriff"), t("2 Angriffe pro Aktion")],
      l >= 5 && [tk("Betäubender Schlag"), t("1 Ki, KON-Rettungswurf SG {dc}", { dc: 8 + p + m.wis })],
      l >= 7 && [tk("Entrinnen"), t("kein/halber Schaden bei GES-Rettungswürfen")],
    ],
  },
  paladin: {
    label: t("Paladin"), en: "paladin", hitDie: 10, saves: ["wis", "cha"],
    skills: [2, ["athletics", "insight", "intimidation", "medicine", "persuasion", "religion"]],
    profs: t("Alle Rüstungen, Schilde; einfache Waffen, Kriegswaffen"),
    spell: { ability: "cha", type: "half", prepared: (l, m) => atLeast1(Math.floor(l / 2) + m.cha) },
    resources: (l, m) => [
      [tk("Göttliches Gespür"), t("{n}× pro langer Rast", { n: atLeast1(1 + m.cha) })],
      [tk("Handauflegen"), t("{n} TP pro langer Rast", { n: 5 * l })],
      l >= 2 && [tk("Göttliches Niederstrecken"), t("+2W8 gleissend pro Zauberplatz (+1W8 pro Grad)")],
      l >= 3 && [tk("Göttliche Macht fokussieren"), t("{n}× pro kurzer Rast", { n: 1 })],
      l >= 5 && [tk("Extra-Angriff"), t("2 Angriffe pro Aktion")],
      l >= 6 && [tk("Aura des Schutzes"), t("+{n} auf Rettungswürfe, {ft} ft", { n: atLeast1(m.cha), ft: l >= 18 ? 30 : 10 })],
    ],
  },
  ranger: {
    label: t("Waldläufer"), en: "ranger", hitDie: 10, saves: ["str", "dex"],
    skills: [3, ["animal", "athletics", "insight", "investigation", "nature", "perception", "stealth", "survival"]],
    profs: t("Leichte und mittlere Rüstung, Schilde; einfache Waffen, Kriegswaffen"),
    spell: { ability: "wis", type: "half", known: [0, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11] },
    resources: (l) => [
      [tk("Bevorzugter Feind"), t("{n} Feindtyp(en)", { n: byLevel(l, [[1, 1], [6, 2], [14, 3]]) })],
      [tk("Erfahrener Erkunder"), t("{n} bevorzugte(s) Gelände", { n: byLevel(l, [[1, 1], [6, 2], [10, 3]]) })],
      l >= 2 && [tk("Kampfstil"), t("gewählter Stil")],
      l >= 5 && [tk("Extra-Angriff"), t("2 Angriffe pro Aktion")],
    ],
  },
  rogue: {
    label: t("Schurke"), en: "rogue", hitDie: 8, saves: ["dex", "int"],
    skills: [4, ["acrobatics", "athletics", "deception", "insight", "intimidation", "investigation", "perception", "performance", "persuasion", "sleight", "stealth"]],
    profs: t("Leichte Rüstung; einfache Waffen, Handarmbrust, Langschwert, Rapier, Kurzschwert; Diebeswerkzeug"),
    resources: (l) => [
      [tk("Hinterhältiger Angriff"), diceDe(`${Math.ceil(l / 2)}d6`)],
      [tk("Expertise"), t("{n} Fertigkeiten mit doppeltem Übungsbonus", { n: l >= 6 ? 4 : 2 })],
      [tk("Diebessprache"), t("geheime Zeichen und Jargon")],
      l >= 2 && [tk("Raffinierte Aktion"), t("Spurt, Rückzug oder Verstecken als Bonusaktion")],
      l >= 5 && [tk("Unglaubliches Ausweichen"), t("Reaktion: Schaden halbieren")],
      l >= 7 && [tk("Entrinnen"), t("kein/halber Schaden bei GES-Rettungswürfen")],
    ],
  },
  sorcerer: {
    label: t("Zauberer"), en: "sorcerer", hitDie: 6, saves: ["con", "cha"],
    skills: [2, ["arcana", "deception", "insight", "intimidation", "persuasion", "religion"]],
    profs: t("Dolch, Wurfpfeil, Schleuder, Kampfstab, leichte Armbrust"),
    spell: { ability: "cha", type: "full", cantrips: [[1, 4], [4, 5], [10, 6]],
      known: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 12, 13, 13, 14, 14, 15, 15, 15, 15] },
    resources: (l) => [
      [tk("Zauberische Herkunft"), t("gewählte Herkunft")],
      l >= 2 && [tk("Zauberpunkte"), t("{n} pro langer Rast", { n: l })],
      l >= 3 && [tk("Metamagie"), t("{n} Optionen", { n: byLevel(l, [[3, 2], [10, 3], [17, 4]]) })],
    ],
  },
  warlock: {
    label: t("Hexenmeister"), en: "warlock", hitDie: 8, saves: ["wis", "cha"],
    skills: [2, ["arcana", "deception", "history", "intimidation", "investigation", "nature", "religion"]],
    profs: t("Leichte Rüstung; einfache Waffen"),
    spell: { ability: "cha", type: "pact", cantrips: [[1, 2], [4, 3], [10, 4]],
      known: [2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 11, 11, 12, 12, 13, 13, 14, 14, 15, 15] },
    resources: (l) => [
      [tk("Paktmagie"), t("{n} Plätze Grad {g}, pro kurzer Rast", {
        n: byLevel(l, [[1, 1], [2, 2], [11, 3], [17, 4]]), g: byLevel(l, [[1, 1], [3, 2], [5, 3], [7, 4], [9, 5]]) })],
      [tk("Andersweltlicher Schutzpatron"), t("gewählter Patron")],
      l >= 2 && [tk("Schauerliche Anrufungen"), t("{n} bekannt", { n: byLevel(l, [[2, 2], [5, 3], [7, 4], [9, 5], [12, 6], [15, 7], [18, 8]]) })],
      l >= 3 && [tk("Paktgabe"), t("Klinge, Kette oder Foliant")],
      l >= 11 && [tk("Mystisches Arkanum"), t("Grad {list}, je 1× pro langer Rast", { list: [6, l >= 13 && 7, l >= 15 && 8, l >= 17 && 9].filter(Boolean).join(", ") })],
    ],
  },
  wizard: {
    label: t("Magier"), en: "wizard", hitDie: 6, saves: ["int", "wis"],
    skills: [2, ["arcana", "history", "insight", "investigation", "medicine", "religion"]],
    profs: t("Dolch, Wurfpfeil, Schleuder, Kampfstab, leichte Armbrust"),
    spell: { ability: "int", type: "full", cantrips: [[1, 3], [4, 4], [10, 5]], prepared: (l, m) => atLeast1(l + m.int) },
    resources: (l) => [
      [tk("Arkane Erholung"), t("{n} Zaubergrade bei kurzer Rast, 1× pro Tag", { n: Math.ceil(l / 2) })],
      [tk("Zauberbuch"), t("mind. {n} Zauber", { n: 6 + 2 * (l - 1) })],
      l >= 2 && [tk("Arkane Tradition"), t("gewählte Schule")],
    ],
  },
};

const ABILITY_SHORT = Object.fromEntries(ABILITIES.map(([k, s]) => [k, s]));

// Old sheets stored the class as free text ("Bardin", "Kämpferin"); map that onto a class key.
function guessClassKey(text) {
  const t = (text || "").toLowerCase().trim();
  if (!t) return "";
  const hit = Object.entries(CLASSES).find(
    ([, c]) => t.startsWith(c.label.toLowerCase().slice(0, 4)) || t.startsWith(c.en.slice(0, 4))
  );
  return hit ? hit[0] : "";
}

// ---------- classes, subclasses, peoples and backgrounds from the library ----------

// The page loads them into state.options (lean: without the long texts) and sets state.optionsUrl,
// where a full entry is fetched for the explanations (<optionsUrl>/<id>).
const charOptions = (kind) => ((typeof state !== "undefined" && state.options) || []).filter((o) => o.kind === kind);
const optionById = (id) => ((typeof state !== "undefined" && state.options) || []).find((o) => o.id === id) || null;
// The name in the UI language: library entries keep the English one in name_en.
const optName = (o) => (o ? (UI_DE ? o.name : o.name_en || o.name) : "");
const optionLabel = (o) => `${optName(o)}${o.is_2024 ? " (2024)" : ""}`;

// The peoples of the Player's Handbook (and their subraces), by their English name.
const STANDARD_RACES = new Set([
  "dwarf", "hill dwarf", "mountain dwarf", "elf", "high elf", "wood elf", "dark elf", "halfling", "lightfoot",
  "stout", "human", "dragonborn", "gnome", "forest gnome", "rock gnome", "half-elf", "half-orc", "tiefling",
  "aasimar", "goliath", "orc",
]);
// Standard: from the official rules (SRD 5.1/5.2 in the import note), or a hand-made entry under a
// Player's Handbook name. A "Drow" from Tome of Heroes is a third-party one, so it goes to the others.
function isStandardRace(o) {
  const note = String(o.notes || "");
  if (/system reference document/i.test(note)) return true;
  if (/importiert/i.test(note)) return false;
  return STANDARD_RACES.has(String(o.name_en || o.name || "").trim().toLowerCase());
}

// <option>s of the peoples in two groups: standard ones first, then all others.
function raceOptgroupsHtml(list, optionHtml) {
  const std = list.filter(isStandardRace);
  const other = list.filter((o) => !isStandardRace(o));
  const group = (label, items) => (items.length ? `<optgroup label="${label}">${items.map(optionHtml).join("")}</optgroup>` : "");
  return group(t("Standardvölker (Grundregeln)"), std) + group(t("Weitere Völker"), other);
}

// What a sheet keeps of a chosen entry: enough to calculate with even if the entry is deleted later.
function optionRef(o) {
  if (!o) return null;
  const data = o.data || {};
  const ref = { id: o.id, name: o.name, name_en: o.name_en || null, is_2024: !!o.is_2024 };
  if (o.kind === "races") Object.assign(ref, { asi: data.asi || null, speed: data.speed || null });
  if (o.kind === "backgrounds") Object.assign(ref, { asi: data.asi || null, skills: data.skills || [] });
  if (o.kind === "feats") Object.assign(ref, { asi: data.asi || null });
  if (o.kind === "classes") Object.assign(ref, { hit_die: data.hit_die, saves: data.saves || [], profs: data.profs || "" });
  return ref;
}

// Older sheets only have the name ("Zwerg"); it's looked up in the library, 2014 rules first.
function findOptionByName(kind, name) {
  const n = String(name || "").trim().toLowerCase();
  if (!n) return null;
  const hits = charOptions(kind).filter((o) => o.name.toLowerCase() === n || String(o.name_en || "").toLowerCase() === n);
  return hits.find((o) => !o.is_2024) || hits[0] || null;
}

// Library classes the sheet has its own rules for (the SRD ones) appear as those; the others
// (third-party classes from Open5e) are offered as "lib:<id>" with hit die, saves and proficiencies.
const classKeyFor = (o) => Object.keys(CLASSES).find((k) => CLASSES[k].en === String(o.name_en || "").toLowerCase());
const libraryClasses = () => charOptions("classes").filter((o) => !classKeyFor(o));

function classInfo(key, ref) {
  if (CLASSES[key]) return CLASSES[key];
  if (!String(key || "").startsWith("lib:") || !ref) return undefined;
  return {
    label: ref.name,
    en: String(ref.name_en || ref.name).toLowerCase(),
    hitDie: ref.hit_die || 8,
    saves: ref.saves || [],
    skills: null,
    profs: String(ref.profs || "").replace(/\*\*/g, "").replace(/\s*\n+\s*/g, " · ").trim(),
    resources: () => [],
  };
}

// The library entry with the class's features: the chosen third-party class, or the SRD class by name.
function classOption(d) {
  if (d.class_ref) return optionById(d.class_ref.id);
  const cls = CLASSES[d.class_key];
  if (!cls) return null;
  const hits = charOptions("classes").filter((o) => String(o.name_en || "").toLowerCase() === cls.en);
  return hits.find((o) => !o.is_2024) || hits[0] || null;
}

const subclassesFor = (cls) => (cls ? charOptions("subclasses").filter((o) => String(o.parent || "").toLowerCase() === cls.en) : []);

// Fixed bonuses of people and background plus the points the player distributed (ability_choice).
function abilityFixed(...refs) {
  const bonus = Object.fromEntries(ABILITIES.map(([k]) => [k, 0]));
  for (const ref of refs) {
    for (const [k, n] of Object.entries((ref && ref.asi && ref.asi.fixed) || {})) bonus[k] += n;
  }
  return bonus;
}

function abilityBonus(d) {
  const bonus = abilityFixed(d.race_ref, d.background_ref, ...(d.feats || []));
  for (const [k, n] of Object.entries(d.ability_choice || {})) if (k in bonus) bonus[k] += Number(n) || 0;
  return bonus;
}

const asiChoices = (d) =>
  [d.race_ref, d.background_ref, ...(d.feats || [])].flatMap((ref) => ((ref && ref.asi && ref.asi.choices) || []).map((c) => ({ ...c, source: ref.name })));

// Under a base value while editing: "+2 → 16".
// Ability scores never exceed 20, whatever people, background or items add.
const ABILITY_MAX = 20;
const abilityTotal = (base, bonus) => Math.min(ABILITY_MAX, base + bonus);

// Under a base value while editing: "+2 → 16", or "+2 → 20 (max.)" when the bonus is cut off.
function abilityBonusHtml(base, bonus) {
  if (!bonus) return "";
  const num = base !== null && base !== undefined && base !== "" && !isNaN(base);
  if (!num) return `${signed(bonus)} → –`;
  const total = abilityTotal(Number(base), bonus);
  return `${signed(bonus)} → ${total}${Number(base) + bonus > ABILITY_MAX ? ` ${t("(max.)")}` : ""}`;
}

// The bonus panel is rebuilt only when people or background change, so a choice isn't reset while typing.
const asiKey = (d) => `${(d.race_ref && d.race_ref.id) ?? ""}|${(d.background_ref && d.background_ref.id) ?? ""}|${(d.feats || []).map((f) => f.id ?? f.name).join(",")}`;

// Points per ability the choices allow at most (an ability can be in several choices).
function asiChoiceMax(choices) {
  const max = Object.fromEntries(ABILITIES.map(([k]) => [k, 0]));
  for (const c of choices) for (const k of c.from) max[k] += c.max;
  return max;
}

// New people, background or feat: the distributed points stay where the new choices still allow them
// (up to each ability's maximum and the number of free points); only what no longer fits goes.
function fitAbilityChoice(choice, choices) {
  const max = asiChoiceMax(choices);
  let left = choices.reduce((s, c) => s + c.points, 0);
  const out = {};
  for (const [k] of ABILITIES) {
    const v = Math.min(Number((choice || {})[k]) || 0, max[k], left);
    if (v > 0) { out[k] = v; left -= v; }
  }
  return out;
}

function asiStatusHtml(d) {
  const choices = asiChoices(d);
  if (!choices.length) return "";
  const points = choices.reduce((s, c) => s + c.points, 0);
  const used = Object.values(d.ability_choice || {}).reduce((s, n) => s + (Number(n) || 0), 0);
  const text = t("Verteilt: {used} von {points}", { used, points: tn(points, "{n} Punkt", "{n} Punkten") });
  return used === points ? text : `<span class="pc-warn">⚠ ${text}</span>`;
}

// Editing only: where the bonuses come from, and the free points of people, background and feats.
function asiPanelHtml(d) {
  const lines = [d.race_ref, d.background_ref, ...(d.feats || [])]
    .filter((ref) => ref && ref.asi && Object.keys(ref.asi.fixed || {}).length)
    .map((ref) => `<div>${escapeHtml(optName(ref))}: ${Object.entries(ref.asi.fixed).map(([k, n]) => `${ABILITY_SHORT[k]} ${signed(n)}`).join(", ")}</div>`);
  const choices = asiChoices(d);
  for (const c of choices) {
    lines.push(`<div>${escapeHtml(c.source)}: ${t("{points} frei verteilen, je höchstens +{max} auf {list}", { points: tn(c.points, "{n} Punkt", "{n} Punkte"), max: c.max, list: c.from.map((k) => ABILITY_SHORT[k]).join(", ") })}</div>`);
  }
  if (!lines.length) return "";
  const max = asiChoiceMax(choices);
  const pickers = choices.length
    ? `<div class="pc-asi-picks">${ABILITIES.filter(([k]) => max[k])
        .map(([k, short]) => {
          const val = Number(d.ability_choice[k]) || 0;
          const opts = Array.from({ length: max[k] + 1 }, (_, n) => `<option value="${n}" ${n === val ? "selected" : ""}>${n ? `+${n}` : "–"}</option>`).join("");
          return `<label>${short}<select data-asi-choice="${k}">${opts}</select></label>`;
        })
        .join("")}</div>
      <div class="pc-hint" data-derived="asi-status">${asiStatusHtml(d)}</div>`
    : "";
  const legacy = d.legacy_abilities && Object.values(abilityFixed(d.race_ref, d.background_ref)).some(Boolean)
    ? `<div class="pc-hint">${t("Die bisher eingetragenen Werte enthielten diese Boni schon. Oben stehen jetzt die Grundwerte ohne Boni, die Gesamtwerte bleiben gleich. Bitte prüfen.")}</div>`
    : "";
  return `<div class="cs-panel-title">${t("Attributserhöhungen")} <span class="pc-legend">${t("automatisch")}</span></div>${lines.join("")}${pickers}${legacy}`;
}

// ---------- how many skills and languages the character should have (hints while editing) ----------

const COUNT_WORDS = { one: 1, two: 2, three: 3, four: 4 };

// Skills a trait of the people grants: "proficiency in the Perception skill" = 1, "two skills of
// your choice" = 2. "Considered proficient" (Stonecunning) only applies to certain checks.
function traitSkillCount(t) {
  const desc = String(t.desc || "").toLowerCase();
  if (!/proficien/.test(desc) || !/\bskills?\b/.test(desc) || /considered proficient/.test(desc)) return 0;
  const m = desc.match(/\b(one|two|three|four) skills?\b/);
  return m ? COUNT_WORDS[m[1]] : 1;
}

// ---------- what the subclass grants ----------
// The server reads each subclass feature's English text into f.grants (char_options.parse_grants):
// proficiencies, skills, spells always known/prepared, spells to choose, domain spell tables, and
// Potent Spellcasting. A feature counts from the first level it lists.

// Subclass features with grants up to this level: [{o, f, i, g, at}].
function subclassGrants(d, lvl, subRef = d.subclass_ref) {
  const o = subRef && optionById(subRef.id);
  if (!o) return [];
  return ((o.data || {}).features || [])
    .map((f, i) => ({ o, f, i, g: f.grants, at: (f.levels || [])[0] }))
    .filter((e) => e.g && e.at && e.at <= lvl);
}

const PROF_DE = {
  "light armor": "Leichte Rüstung", "medium armor": "Mittlere Rüstung", "heavy armor": "Schwere Rüstung",
  "all armor": "Alle Rüstungen", shields: "Schilde", shield: "Schilde", "simple weapons": "Einfache Waffen",
  "martial weapons": "Kriegswaffen", "smith's tools": "Schmiedewerkzeug", "thieves' tools": "Diebeswerkzeug",
  "mason's tools": "Maurerwerkzeug", "herbalism kit": "Kräuterkundeausrüstung", "navigator's tools": "Navigationswerkzeug",
  "tinker's tools": "Tüftlerwerkzeug", "alchemist's supplies": "Alchemistenausrüstung", "disguise kit": "Verkleidungsausrüstung",
};
const profDe = (p) => {
  if (!UI_DE) return capitalize(String(p));
  const k = String(p).toLowerCase();
  const w = WEAPON_DE[k] || WEAPON_DE[k.replace(/s$/, "")];
  return PROF_DE[k] || (w ? w : p);
};

// "Cleric" -> "Kleriker".
const classLabelEn = (en) => (Object.values(CLASSES).find((c) => c.en === String(en).toLowerCase()) || {}).label || en;

// The library spell of that name (case doesn't matter), if there is one.
const libSpellByName = (name) => spellLibrary().find((sp) => sp.name.toLowerCase() === String(name).toLowerCase());

// Whether a chosen spell counts as a spell of that class (English name, "Cleric"): marked so by its
// subclass, or on the class list of a character of that class.
function spellCountsAs(s, sp, d, classEn) {
  const want = String(classEn).toLowerCase();
  if (s.class_en) return s.class_en.toLowerCase() === want;
  const cls = classInfo(d.class_key, d.class_ref);
  return !!cls && cls.en === want && !!sp && String(sp.dnd_class || "").toLowerCase().split(",").map((c) => c.trim()).includes(want);
}

// Damage of a cantrip at the character's level, with Potent Spellcasting and the like: "2W8 + 3 Gleissend".
function cantripDamage(s, d, x) {
  if (s.level !== 0) return null;
  const sp = findSpell(s);
  if (!sp) return null;
  const text = `${sp.desc || ""} ${sp.higher_level || ""}`;
  const m = /(\d+)d(\d+)\s+([a-z]+)\s+damage/i.exec(text);
  if (!m) return null;
  const tier = /\b5th level\b|\blevel 5\b/i.test(text) ? 1 + [5, 11, 17].filter((l) => x.lvl >= l).length : 1;
  const beams = /\bbeams?\b/i.test(text);
  let mod = 0;
  const why = [];
  for (const { f, g } of subclassGrants(d, x.lvl)) {
    const cd = g.cantrip_damage;
    if (cd && spellCountsAs(s, sp, d, cd.class)) {
      mod += x.m[cd.ability];
      why.push(`${signed(x.m[cd.ability])} ${ABILITY_SHORT[cd.ability]} (${localized(f.name, f.name_de)})`);
    }
  }
  const dice = beams && tier > 1 ? `${tier}× ${diceDe(`${m[1]}d${m[2]}`)}` : diceDe(`${Number(m[1]) * tier}d${m[2]}`);
  return {
    text: `${dice}${mod ? ` ${mod > 0 ? "+" : "−"} ${Math.abs(mod)}` : ""} ${DAMAGE_TYPE_DE[m[3].toLowerCase()] || m[3]}`,
    title: why.length ? t("Schaden auf Stufe {n}, inkl. {list}", { n: x.lvl, list: why.join(", ") }) : t("Schaden auf Stufe {n}", { n: x.lvl }),
  };
}

// Class, background (always two, also in the 2024 rules) and people; null where the class doesn't say.
function skillBudget(d, x) {
  const parts = [];
  if (x.cls) parts.push([tk("Klasse"), x.cls.skills ? x.cls.skills[0] : null]);
  if (d.background_ref || d.background) parts.push([tk("Hintergrund"), (d.background_ref && d.background_ref.skills && d.background_ref.skills.length) || 2]);
  const race = d.race_ref && optionById(d.race_ref.id);
  const fromRace = race ? ((race.data || {}).traits || []).reduce((s, t) => s + traitSkillCount(t), 0) : 0;
  if (fromRace) parts.push([tk("Volk"), fromRace]);
  // Expertise: rogue from level 1 (and 6), bard from level 3 (and 10).
  let expertise = d.class_key === "rogue" ? (x.lvl >= 6 ? 4 : 2) : d.class_key === "bard" ? (x.lvl >= 10 ? 4 : x.lvl >= 3 ? 2 : 0) : 0;
  const sub = subclassGrants(d, x.lvl);
  const fromSub = sub.reduce((s, { g }) => s + (g.skills || []).length + ((g.skill_choice && g.skill_choice.n) || 0), 0);
  if (fromSub) parts.push([tk("Unterklasse"), fromSub]);
  expertise += sub.reduce((s, { g }) => s + (g.skill_choice && g.skill_choice.expertise ? g.skill_choice.n : 0), 0);
  return { parts, total: parts.some(([, n]) => n === null) ? null : parts.reduce((s, [, n]) => s + n, 0), expertise };
}

function skillCountHtml(d, x) {
  const b = skillBudget(d, x);
  if (!b.parts.length) return "";
  const have = d.skill_prof.length;
  const title = t("Geübte Fertigkeiten: {list}", { list: b.parts.map(([l, n]) => `${t(l)} ${n ?? "?"}`).join(", ") });
  const ok = b.total === null || have === b.total;
  let html = `<span class="pc-count ${ok ? "" : "warn"}" title="${escapeHtml(title)}">● ${have}/${b.total ?? "?"}</span>`;
  if (b.expertise) {
    const exp = d.skill_expertise.length;
    html += ` <span class="pc-count ${exp === b.expertise ? "" : "warn"}" title="${t("Expertise der Klasse")}">◆ ${exp}/${b.expertise}</span>`;
  }
  return html;
}

const LANGUAGES_DE = enNames({
  common: "Gemeinsprache", dwarvish: "Zwergisch", elvish: "Elfisch", giant: "Riesisch", gnomish: "Gnomisch",
  goblin: "Goblinisch", halfling: "Halblingisch", orc: "Orkisch", draconic: "Drakonisch", infernal: "Infernalisch",
  abyssal: "Abyssisch", celestial: "Celestisch", sylvan: "Sylvanisch", undercommon: "Gemeinsprache der Unterreiche",
  primordial: "Urtümlich", "deep speech": "Tiefensprache",
});

// Named languages and free picks in a text like "Common, Elvish, and one extra language of your choice"
// or a background's "Two of your choice". Only the first sentence names languages.
function languageGrant(text) {
  const t = String(text || "").toLowerCase();
  const first = t.split(/\.\s/)[0];
  const named = Object.keys(LANGUAGES_DE).filter((k) => new RegExp(`\\b${k}\\b`).test(first)).map((k) => LANGUAGES_DE[k]);
  // "one extra language of your choice", "Two of your choice" (but not "one of the oldest languages")
  const m = t.match(/\b(one|two|three|four) (?:(?:extra|other|additional) )?(?:languages? )?of your choice/)
    || t.match(/\b(one|two|three|four) (?:extra|other|additional) languages?/);
  return { named, free: m ? COUNT_WORDS[m[1]] : 0 };
}

// 2014: the people names its languages, the background adds free ones. 2024: Common and two more for everyone.
function languageBudget(d) {
  const parts = [];
  const race = d.race_ref && optionById(d.race_ref.id);
  if (race && race.is_2024) parts.push([tk("Grundregel 2024"), { named: [LANGUAGES_DE.common], free: 2 }]);
  else if (race) {
    const grants = ((race.data || {}).traits || []).filter((t) => /language/i.test(t.name || "")).map((t) => languageGrant(t.desc));
    if (grants.length) parts.push([tk("Volk"), { named: grants.flatMap((g) => g.named), free: grants.reduce((s, g) => s + g.free, 0) }]);
  }
  const bg = d.background_ref && optionById(d.background_ref.id);
  const bgText = bg && ((bg.data || {}).benefits || []).find((b) => b.type === "language" || /language/i.test(b.name || ""));
  if (bgText) parts.push([tk("Hintergrund"), languageGrant(bgText.desc)]);
  const lvl = Math.min(20, Math.max(1, parseInt(d.level, 10) || 1));
  const fromSub = subclassGrants(d, lvl).reduce((s, { g }) => s + (g.languages || 0), 0);
  if (fromSub) parts.push([tk("Unterklasse"), { named: [], free: fromSub }]);
  return parts;
}

const enteredLanguages = (text) => String(text || "").split(/[,;\n]+|\s+(?:und|and)\s+/).map((s) => s.trim()).filter(Boolean).length;

function languageCountHtml(d) {
  const parts = languageBudget(d);
  if (!parts.length) return "";
  const total = parts.reduce((s, [, g]) => s + g.named.length + g.free, 0);
  const have = enteredLanguages(d.languages);
  const title = parts.map(([l, g]) => `${t(l)}: ${[...g.named, g.free ? t("{n} frei wählbar", { n: g.free }) : ""].filter(Boolean).join(", ")}`).join(" · ");
  return `<span class="pc-count ${have === total ? "" : "warn"}" title="${escapeHtml(title)}">${have}/${total}</span>`;
}

// Placeholder of the empty languages field: what people and background give.
function languagePlaceholder(d) {
  const parts = languageBudget(d);
  if (!parts.length) return t("z.B. Gemeinsprache, Zwergisch");
  const named = parts.flatMap(([, g]) => g.named);
  const free = parts.reduce((s, [, g]) => s + g.free, 0);
  return [named.join(", "), free ? `+ ${t("{n} frei wählbar", { n: free })}` : ""].filter(Boolean).join(" ");
}

// <option>s of a library dropdown. A name without a library entry (typed into an older sheet, or
// an entry deleted since) stays selectable, with the reference the sheet still has.
function optionSelectOptions(list, ref, text, empty) {
  const esc = (v) => escapeHtml(String(v ?? ""));
  const selectedId = ref && ref.id;
  const known = list.some((o) => o.id === selectedId);
  const name = ref ? ref.name : text;
  const free = name && !known
    ? `<option value="text" data-name="${esc(name)}" ${ref ? `data-ref="${esc(JSON.stringify(ref))}"` : ""} selected>${esc(name)}${list.length ? ` ${t("(nicht in der Bibliothek)")}` : ""}</option>`
    : "";
  const optionHtml = (o) => `<option value="${o.id}" data-ref="${esc(JSON.stringify(optionRef(o)))}" ${o.id === selectedId ? "selected" : ""}>${esc(optionLabel(o))}</option>`;
  const options = list.length && list.every((o) => o.kind === "races") ? raceOptgroupsHtml(list, optionHtml) : list.map(optionHtml).join("");
  return `<option value="">${empty}</option>${free}${options}`;
}

// [ref, name] of a library dropdown while editing.
function readOptionSelect(container, field) {
  const o = container.querySelector(`[data-option="${field}"]`)?.selectedOptions[0];
  if (!o || !o.value) return [null, null];
  const ref = JSON.parse(o.dataset.ref || "null");
  return [ref, ref ? ref.name : o.dataset.name || null];
}

// A Markdown table ("| Dragon | Damage Type |" lines, the second one "|---|---|") as <table>.
function mdTableHtml(lines) {
  const cells = (l) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
  const isRule = (l) => /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l.trim());
  const rows = lines.filter((l) => !isRule(l)).map(cells);
  const head = lines.length > 1 && isRule(lines[1]) ? rows.shift() : null;
  const width = Math.max(...rows.map((r) => r.length), head ? head.length : 0);
  const pad = (r) => [...r, ...Array(Math.max(0, width - r.length)).fill("")];
  return `<div class="pc-md-table-wrap"><table class="pc-md-table">
    ${head ? `<thead><tr>${pad(head).map((c) => `<th>${c}</th>`).join("")}</tr></thead>` : ""}
    <tbody>${rows.map((r) => `<tr>${pad(r).map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody>
  </table></div>`;
}

// Open5e texts are Markdown; enough of it for the explanations: bold, italics, paragraphs,
// headings ("###Archery"), bullet lists and tables.
function optionTextHtml(text) {
  const html = escapeHtml(text || "")
    .replace(/\r/g, "")
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/(^|[\s(])[*_](\S.*?)[*_](?=[\s.,;:)]|$)/gm, "$1<i>$2</i>");
  const out = [];
  let para = [];
  let list = [];
  let table = [];
  const flushPara = () => { if (para.length) out.push(`<p>${para.join("<br>")}</p>`); para = []; };
  const flushList = () => { if (list.length) out.push(`<ul class="pc-info-list">${list.map((li) => `<li>${li}</li>`).join("")}</ul>`); list = []; };
  const flushTable = () => { if (table.length) out.push(mdTableHtml(table)); table = []; };
  const flush = () => { flushPara(); flushList(); flushTable(); };
  for (const raw of html.split("\n")) {
    const line = raw.trim();
    if (!line) { flush(); continue; }
    // Table rows start with "|"; some headers only end with one ("Cleric Level | Spells |").
    const tableRow = line.startsWith("|") || (line.endsWith("|") && line.split("|").length > 2);
    if (tableRow) { flushPara(); flushList(); table.push(line); continue; }
    flushTable();
    const h = /^#{1,6}\s*(.+)$/.exec(line);
    if (h) { flush(); out.push(`<p class="pc-md-h"><b>${h[1]}</b></p>`); continue; }
    const li = /^[-*•]\s+(.+)$/.exec(line);
    if (li) { flushPara(); list.push(li[1]); continue; }
    const caption = /^Table:\s*(.+)$/i.exec(line);
    if (caption) { flush(); out.push(`<p class="pc-md-caption"><b>${caption[1]}</b></p>`); continue; }
    flushList();
    para.push(line);
  }
  flush();
  return out.join("");
}

// Features, traits and benefits worth a chip on the sheet (no size, age, equipment …).
const SKIP_TRAITS = /^(ability score|age|alignment|size|speed|languages|suggested characteristics|equipment)/i;

// Chips for what class, subclass, people and background give, up to the character's level.
function libFeaturesHtml(d, x) {
  const groups = [];
  const add = (title, o, key, keep) => {
    if (!o) return;
    const items = ((o.data || {})[key] || []).map((f, i) => ({ ...f, i })).filter(keep);
    if (items.length) groups.push({ title, o, key, items });
  };
  const reached = (f) => !f.levels || !f.levels.length || f.levels[0] <= x.lvl;
  const plain = (f) => !SKIP_TRAITS.test(f.name || "") && !["SIZE", "SPEED", "ability_score", "skill_proficiency"].includes(f.type);
  add(t("Klasse"), classOption(d), "features", reached);
  add(t("Unterklasse"), d.subclass_ref && optionById(d.subclass_ref.id), "features", reached);
  add(t("Volk"), d.race_ref && optionById(d.race_ref.id), "traits", plain);
  add(t("Hintergrund"), d.background_ref && optionById(d.background_ref.id), "benefits", plain);
  return groups
    .map(({ title, o, key, items }) => {
      const chips = items
        .map((f) => {
          const lvl = key === "features" && f.levels && f.levels.length ? ` <span class="pc-ab">(${t("St. {n}", { n: f.levels[0] })})</span>` : "";
          return `<span class="pc-chip"><span class="cs-info-link" ${infoAttr(`opt:${o.id}:${key}:${f.i}`)}>${escapeHtml(localized(f.name, f.name_de))}</span>${lvl}</span>`;
        })
        .join("");
      return `<div class="pc-spell-level"><div class="pc-spell-level-label">${title}: ${escapeHtml(optName(o))}</div><div class="pc-chips">${chips}</div></div>`;
    })
    .join("");
}

// ---------- feats ----------
// sb.feats: [{id, name, asi, source, detail}]: the feat's library entry (optionRef) plus where it comes
// from ("Hintergrund", "Stufe 4" …) and what is chosen with it ("Cleric" for Magic Initiate).

const FEAT_TYPE_NAMES = { Origin: t("Herkunftstalente"), General: t("Allgemeine Talente"), "Fighting Style": t("Kampfstile"), "Epic Boon": t("Epische Gaben") };
const FEAT_TYPE_ONE = { Origin: t("Herkunftstalent"), General: t("Allgemeines Talent"), "Fighting Style": t("Kampfstil"), "Epic Boon": t("Epische Gabe") };

// A feat named in a text ("Magic Initiate (Cleric)"): the library entry, same rules first.
function findFeat(text, is2024) {
  const m = /^\s*(.+?)\s*(?:\((.+)\))?\s*$/.exec(String(text || ""));
  if (!m) return null;
  const n = m[1].toLowerCase();
  const hits = charOptions("feats").filter((o) => o.name.toLowerCase() === n || String(o.name_en || "").toLowerCase() === n);
  const o = hits.find((h) => !!h.is_2024 === !!is2024) || hits[0];
  return o ? { option: o, detail: m[2] || null } : null;
}

// The origin feat of the chosen background (2024), if it isn't on the sheet yet.
function backgroundFeat(d) {
  const bg = d.background_ref && optionById(d.background_ref.id);
  const benefit = bg && ((bg.data || {}).benefits || []).find((b) => b.type === "feat" || /^feat\b/i.test(b.name || ""));
  if (!benefit || !benefit.desc) return null;
  const hit = findFeat(benefit.desc, bg.is_2024);
  if (!hit || (d.feats || []).some((f) => f.id === hit.option.id)) return null;
  return { ...hit, text: benefit.desc };
}

// Where a feat comes from, stored in German ("Hintergrund", "Stufe 4"), in the UI language.
const featSourceLabel = (s) => {
  const m = /^Stufe (\d+)$/.exec(String(s || ""));
  return m ? t("Stufe {n}", { n: m[1] }) : t(s);
};
// The stored name is the library one as picked ("Magie-Eingeweihter"); shown in the UI language.
const featLabel = (f) => `${(f.id && optName(optionById(f.id))) || f.name}${f.detail ? ` (${f.detail})` : ""}`;

// The chosen feats: chips to read, rows with ✕ while editing.
function featListHtml(d, editable) {
  const feats = d.feats || [];
  const esc = (v) => escapeHtml(String(v ?? ""));
  const name = (f) => (f.id && optionById(f.id) ? `<span class="cs-info-link" ${infoAttr(`opt:${f.id}`)}>${esc(featLabel(f))}</span>` : esc(featLabel(f)));
  const bgFeat = editable ? backgroundFeat(d) : null;
  const bgHint = bgFeat
    ? `<div class="pc-hint">${t("Der Hintergrund gibt das Talent „{feat}“.", { feat: esc(bgFeat.text) })} <button type="button" class="ghost pc-btn" data-feat-bg>${t("übernehmen")}</button></div>`
    : "";
  if (!editable) {
    return feats.length
      ? `<div class="pc-chips">${feats.map((f) => `<span class="pc-chip">${name(f)}${f.source ? ` <span class="pc-ab">(${esc(featSourceLabel(f.source))})</span>` : ""}</span>`).join("")}</div>`
      : "";
  }
  const rows = feats.map((f, i) => `<div class="pc-feat-row">${name(f)}${f.source ? ` <span class="pc-ab">(${esc(featSourceLabel(f.source))})</span>` : ""}
      <button type="button" class="ghost pc-btn" data-feat-remove="${i}" title="${t("Entfernen")}">✕</button></div>`).join("");
  return `${rows || `<div class="pc-hint">${t("Noch keine Talente.")}</div>`}${bgHint}`;
}

// Editing: a dropdown of the library's feats, grouped by kind, and where the feat comes from.
function featPickerHtml() {
  const feats = charOptions("feats");
  if (!feats.length) return `<div class="pc-hint">${t("Keine Talente in der Bibliothek (Kampagnenbuch → Talente).")}</div>`;
  const esc = (v) => escapeHtml(String(v ?? ""));
  const groups = {};
  for (const o of feats) (groups[(o.data || {}).feat_type || ""] ||= []).push(o);
  const order = [...Object.keys(FEAT_TYPE_NAMES), ""].filter((k) => groups[k]);
  for (const k of Object.keys(groups)) if (!order.includes(k)) order.push(k);
  const opts = order.map((k) => `<optgroup label="${esc(FEAT_TYPE_NAMES[k] || k || t("Weitere"))}">${groups[k]
    .map((o) => {
      const pre = (o.data || {}).prerequisite;
      return `<option value="${o.id}">${esc(optionLabel(o))}${pre ? ` – ${esc(pre)}` : ""}</option>`;
    })
    .join("")}</optgroup>`).join("");
  return `<div class="pc-feat-pick">
      <select data-feat-pick><option value="">${t("-- Talent --")}</option>${opts}</select>
      <input data-feat-source placeholder="${t("Herkunft, z.B. Stufe 4")}" />
      <button type="button" class="ghost pc-btn" data-feat-add>${t("+ Talent")}</button>
    </div>`;
}

// Full entries, fetched once per page for the explanations.
const fullOptions = new Map();

async function fullOption(id) {
  const lean = optionById(id);
  if (lean && "desc" in lean) return lean;
  if (!fullOptions.has(id)) {
    const base = (typeof state !== "undefined" && state.optionsUrl) || "/api/options/entry";
    fullOptions.set(id, fetch(`${base}/${id}`).then((r) => (r.ok ? r.json() : null)));
  }
  return fullOptions.get(id);
}

function asiText(asi) {
  if (!asi) return "";
  const fixed = Object.entries(asi.fixed || {}).map(([k, n]) => `${ABILITY_SHORT[k]} ${signed(n)}`);
  const choices = (asi.choices || []).map(
    (c) => t("{points} frei (je höchstens +{max}: {list})", { points: tn(c.points, "{n} Punkt", "{n} Punkte"), max: c.max, list: c.from.map((k) => ABILITY_SHORT[k]).join(", ") })
  );
  return [...fixed, ...choices].join(", ");
}

// English names of the skills as the library texts spell them ("Sleight of Hand and Stealth").
const SKILL_NAMES_EN = Object.fromEntries(SKILLS.map(([k]) => [k, { sleight: "sleight of hand", animal: "animal handling" }[k] || k]));

// Background benefits that only name things (feat "Alert", skills, tools), with each name
// clickable for its explanation. null where there's nothing to link: the text is shown as it is.
function benefitLinksHtml(f) {
  const text = String(f.desc || "").trim();
  const link = (info, label) => `<span class="cs-info-link" ${infoAttr(info)}>${escapeHtml(label)}</span>`;
  if (f.type === "feat" || /^feat/i.test(f.name || "")) {
    // The feat's library entry if there is one, else the short text of FEAT_INFO.
    const hit = findFeat(text, true);
    if (hit) return `<p>${link(`opt:${hit.option.id}`, text)}</p>`;
    const key = text.replace(/\s*\(.*\)\s*$/, "").trim().toLowerCase();
    return FEAT_INFO[key] ? `<p>${link(`feat:${key}`, text)}</p>` : null;
  }
  if (f.type === "skill_proficiency" || /^skill prof/i.test(f.name || "")) {
    const lower = text.toLowerCase();
    const found = SKILLS.filter(([k]) => new RegExp(`\\b${SKILL_NAMES_EN[k]}\\b`).test(lower));
    if (!found.length) return null;
    const choice = /choose|of your choice|\bor\b/i.test(text) ? ` <span class="pc-hint">(${escapeHtml(text)})</span>` : "";
    return `<p>${found.map(([k, label]) => link(`skill:${k}`, label)).join(", ")}${choice}</p>`;
  }
  if (f.type === "tool_proficiency" || /^tool prof/i.test(f.name || "")) {
    let html = escapeHtml(text);
    let any = false;
    // Longest names first, so "gaming set" isn't found inside something longer.
    for (const name of Object.keys(TOOL_INFO).sort((a, b) => b.length - a.length)) {
      const re = new RegExp(`(${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/'/g, "(?:'|&#39;|’)")})`, "i");
      if (re.test(html)) {
        html = html.replace(re, (m) => `<span class="cs-info-link" ${infoAttr(`tool:${name}`)}>${m}</span>`);
        any = true;
      }
    }
    return any ? `<p>${html}</p>` : `<p>${html} <span class="cs-info-link" ${infoAttr("tool:")}>ⓘ</span></p>`;
  }
  return null;
}

// Which data[] list holds this entry's levelled features, by option kind.
function optionFeatureKey(o) {
  if (o.kind === "races") return "traits";
  if (o.kind === "backgrounds") return "benefits";
  return "features"; // classes, subclasses
}

// Full facts + description for a library entry, including every feature/trait/benefit (with
// its own text) sorted by the level it's gained at - not just a name, used both for the sheet's
// info popup and inline in the creation wizard (see creation.js).
function optionInfoHtml(o) {
  const data = o.data || {};
  const key = optionFeatureKey(o);
  const facts = [
    data.hit_die && t("<b>Trefferwürfel:</b> W{n}", { n: data.hit_die }),
    data.saves && data.saves.length && t("<b>Rettungswürfe:</b> {list}", { list: data.saves.map((k) => ABILITY_SHORT[k]).join(", ") }),
    data.feat_type && t("<b>Art:</b> {type}", { type: escapeHtml(FEAT_TYPE_ONE[data.feat_type] || data.feat_type) }),
    data.prerequisite && t("<b>Voraussetzung:</b> {text}", { text: escapeHtml(data.prerequisite) }),
    data.asi && t("<b>Attribute:</b> {text}", { text: escapeHtml(asiText(data.asi)) }),
    data.speed && data.speed.walk && t("<b>Bewegungsrate:</b> {ft} ft ({m})", { ft: data.speed.walk, m: ftToM(data.speed.walk) }),
    data.skills && data.skills.length && t("<b>Fertigkeiten:</b> {list}", { list: data.skills.map((k) => (SKILLS.find((s) => s[0] === k) || [k, k])[1]).join(", ") }),
  ].filter(Boolean);
  const items = (data[key] || []).filter((f) => !SKIP_TRAITS.test(f.name || ""));
  const sorted = [...items].sort((a, b) => (a.levels?.[0] || 0) - (b.levels?.[0] || 0));
  const featureList = sorted.length
    ? `<ul class="pc-info-list">${sorted
        .map(
          (f) => `<li class="pc-info-item">
            <b>${escapeHtml(localized(f.name, f.name_de))}${f.levels && f.levels.length ? ` <span class="pc-hint">(${t("Stufe {n}", { n: f.levels.join(", ") })})</span>` : ""}</b>
            ${benefitLinksHtml(f) || deTextHtml(f.desc, f.desc_de, optionTextHtml)}
          </li>`
        )
        .join("")}</ul>`
    : "";
  const source = o.notes ? `<p class="pc-hint">${escapeHtml(o.notes)}</p>` : "";
  return `${facts.length ? `<p>${facts.join("<br>")}</p>` : ""}${deTextHtml(o.desc, o.desc_de, optionTextHtml)}${featureList}${source}`;
}

// "opt:<id>" explains a whole entry, "opt:<id>:<list>:<index>" one of its features.
async function openOptionInfo(info) {
  const [, id, key, index] = info.split(":");
  const o = await fullOption(Number(id));
  if (!o) return showSheetPopup(null, para(t("Dieser Eintrag ist nicht (mehr) in der Bibliothek.")));
  if (key) {
    const f = ((o.data || {})[key] || [])[Number(index)];
    if (!f) return;
    const lvl = f.levels && f.levels.length ? `<p class="pc-hint">${t("{name}, ab Stufe {n}", { name: escapeHtml(optName(o)), n: f.levels.join(", ") })}</p>` : `<p class="pc-hint">${escapeHtml(optName(o))}</p>`;
    return showSheetPopup(localized(f.name, f.name_de), lvl + deTextHtml(f.desc, f.desc_de, optionTextHtml));
  }
  showSheetPopup(optionLabel(o), optionInfoHtml(o));
}

// Flattens a character (or PC combatant) into the values the full sheet works with.
function pcData(entity) {
  entity = entity || {};
  const sb = entity.stat_block || {};
  const classKey = sb.class_key ?? guessClassKey(sb.char_class);
  const cls = classInfo(classKey, sb.class_ref);
  // Sheets saved before the library choices hold only the final scores and the names of people,
  // background and subclass. The names are looked up in the library; the scores stay as they are,
  // so the base value is the score without the bonus found that way.
  const legacy = !sb.ability_base;
  const match = (kind, name) => (legacy ? optionRef(findOptionByName(kind, name)) : null);
  const race_ref = sb.race_ref || match("races", sb.race);
  const background_ref = sb.background_ref || match("backgrounds", sb.background);
  const ability_choice = sb.ability_choice || {};
  const isNum = (v) => v !== null && v !== undefined && v !== "" && !isNaN(v);
  let base = sb.ability_base;
  if (legacy) {
    const fixed = abilityFixed(race_ref, background_ref);
    base = Object.fromEntries(Object.entries(sb.abilities || {}).map(([k, v]) => [k, isNum(v) ? v - (fixed[k] || 0) : v]));
  }
  const feats = Array.isArray(sb.feats) ? sb.feats : [];
  const bonus = abilityBonus({ race_ref, background_ref, ability_choice, feats });
  const abilities = Object.fromEntries(ABILITIES.map(([k]) => [k, isNum(base[k]) ? abilityTotal(Number(base[k]), bonus[k]) : null]));
  // Worn magic items: Gauntlets of Ogre Power set STR to 19 and so on.
  const equipment = pcEquipment(entity, sb);
  const effects = equipmentEffects(equipment);
  for (const [k, v] of Object.entries(effects.set)) if (abilities[k] !== null && abilities[k] < v) abilities[k] = v;
  return {
    name: entity.name,
    max_hp: entity.max_hp,
    ac: entity.ac,
    notes: entity.notes,
    // Final scores (base + people + background); everything else calculates with these.
    abilities,
    ability_base: base,
    ability_bonus: bonus,
    ability_choice,
    legacy_abilities: legacy && Object.values(sb.abilities || {}).some(isNum),
    race: sb.race,
    race_ref,
    class_key: classKey || "",
    class_ref: sb.class_ref || null,
    subclass: sb.subclass,
    subclass_ref: sb.subclass_ref || (legacy ? optionRef(subclassesFor(cls).find((o) => o.name.toLowerCase() === String(sb.subclass || "").trim().toLowerCase())) : null),
    level: sb.level ?? 1,
    background: sb.background,
    background_ref,
    feats,
    alignment: sb.alignment,
    xp: sb.xp,
    inspiration: !!sb.inspiration,
    save_prof: sb.save_prof ?? (cls ? cls.saves : []),
    skill_prof: sb.skill_prof || [],
    skill_expertise: sb.skill_expertise || [],
    // Hand-typed speed from before the calculation; only shown as a hint while editing.
    speed: "speed_adjust" in sb ? null : formatSpeed(sb.speed) || null,
    speed_adjust: sb.speed_adjust || 0,
    // Initiative is DEX modifier + this adjustment (feats, items), always kept in sync - never a
    // frozen full value. Older sheets stored the whole total in the top-level initiative_bonus
    // column (entity.initiative_bonus); carried over once as the starting adjustment.
    initiative_adjust: "initiative_adjust" in sb ? sb.initiative_adjust : entity.initiative_bonus || 0,
    languages: sb.languages,
    proficiencies: sb.proficiencies,
    attacks: sb.attacks || [],
    equipment: sb.equipment,
    coins: sb.coins || {},
    personality: sb.personality,
    ideals: sb.ideals,
    bonds: sb.bonds,
    flaws: sb.flaws,
    features: sb.features,
    spells: sb.spells,
    // Equipped in the inventory (see pcEquipment): armor and shield copies, weapons, worn items.
    equip: equipment,
    effects,
    armor: equipment.armor,
    shield: !!equipment.shield,
    shield_bonus: (equipment.shield && equipment.shield.bonus) || 0,
    // Mage Armor is a spell, so it's a switch on the sheet rather than an item.
    mage_armor: !!sb.mage_armor || sb.armor_id === MAGE_ARMOR,
    // null marks a sheet saved before the AC calculation existed.
    ac_adjust: "ac_adjust" in sb ? sb.ac_adjust : entity.id || entity.ac != null ? null : 0,
    // Equipped weapons: [{item_id, name, weapon: {category, damage_dice, damage_type, properties, bonus, base}, two_handed}]
    weapons: equipment.weapons,
    // Chosen spells: [{id, name, level, prepared}] (prepared only matters for the wizard's spellbook)
    spell_list: sb.spell_list || [],
    // Play state, kept outside the sheet (see schema.sql).
    current_hp: entity.current_hp ?? entity.max_hp,
    temp_hp: entity.temp_hp || 0,
    play: entity.play_state || {},
  };
}

// All values the sheet calculates from abilities, level and class.
function pcDerived(d) {
  const lvl = Math.min(20, Math.max(1, parseInt(d.level, 10) || 1));
  const prof = 2 + Math.floor((lvl - 1) / 4);
  const has = (k) => {
    const s = d.abilities[k];
    return s !== null && s !== undefined && s !== "" && !isNaN(s);
  };
  const m = Object.fromEntries(ABILITIES.map(([k]) => [k, has(k) ? Math.floor((d.abilities[k] - 10) / 2) : 0]));
  const saves = Object.fromEntries(ABILITIES.map(([k]) => [k, m[k] + (d.save_prof.includes(k) ? prof : 0) + ((d.effects && d.effects.saves) || 0)]));
  const skills = Object.fromEntries(
    SKILLS.map(([k, , ab]) => [k, m[ab] + prof * (d.skill_expertise.includes(k) ? 2 : d.skill_prof.includes(k) ? 1 : 0)])
  );
  const cls = classInfo(d.class_key, d.class_ref);
  const x = { lvl, prof, m, saves, skills, passive: 10 + skills.perception, cls, spell: null, resources: [] };
  if (!cls) return x;

  x.hitDice = diceDe(`${lvl}d${cls.hitDie}`);
  if (has("con")) x.hpSuggest = cls.hitDie + m.con + (lvl - 1) * (cls.hitDie / 2 + 1 + m.con);
  x.skillHint = !cls.skills ? null : cls.skills[1]
    ? `${cls.label}: ${t("{n} aus {list}", { n: cls.skills[0], list: cls.skills[1].map((k) => SKILLS.find((s) => s[0] === k)[1]).join(", ") })}`
    : `${cls.label}: ${t("{n} beliebige", { n: cls.skills[0] })}`;
  x.resources = cls.resources(lvl, m, prof).filter(Boolean);

  const sp = cls.spell;
  if (sp && !(sp.type === "half" && lvl < 2)) {
    const mod = m[sp.ability];
    let slots = [];
    let pact = null;
    if (sp.type === "full") slots = FULL_CASTER_SLOTS[lvl - 1];
    else if (sp.type === "half") slots = FULL_CASTER_SLOTS[Math.ceil(lvl / 2) - 1];
    else pact = { count: byLevel(lvl, [[1, 1], [2, 2], [11, 3], [17, 4]]), level: byLevel(lvl, [[1, 1], [3, 2], [5, 3], [7, 4], [9, 5]]) };
    x.spell = {
      ability: sp.ability,
      dc: 8 + prof + mod,
      attack: prof + mod,
      cantrips: sp.cantrips ? byLevel(lvl, sp.cantrips) : null,
      known: sp.known ? sp.known[lvl - 1] : null,
      prepared: sp.prepared ? sp.prepared(lvl, m) : null,
      slots,
      pact,
    };
    x.maxSpellLevel = pact ? pact.level : slots.length;
  }
  return x;
}

// Clicking an element with data-info opens its explanation (see openSheetInfo).
const infoAttr = (key) => `data-info="${escapeHtml(key)}"`;

function pcResourcesHtml(x) {
  if (!x.cls) return `<div class="cs-feature muted-ink">${t("Klasse wählen, um die Klassenmerkmale zu sehen.")}</div>`;
  return x.resources
    .map(([name, val]) => {
      const link = FEATURE_INFO[name] ? `class="cs-info-link" ${infoAttr(`feature:${name}`)}` : "";
      return `<div class="cs-feature"><b ${link}>${escapeHtml(t(name))}.</b> ${escapeHtml(val)}</div>`;
    })
    .join("");
}

// Spellbook (wizard) or the list of known/prepared spells (everyone else).
const isSpellbook = (d) => d.class_key === "wizard";

// Spells from the subclass (extra) are always prepared and don't count against the class limits.
function pcSpellCounts(d) {
  const own = d.spell_list.filter((s) => !s.extra);
  const cantrips = own.filter((s) => s.level === 0).length;
  const leveled = own.filter((s) => s.level > 0);
  return { cantrips, spells: leveled.length, prepared: leveled.filter((s) => s.prepared).length };
}

function pcSpellHeadHtml(x, d) {
  const s = x.spell;
  if (!s) return "";
  const n = pcSpellCounts(d);
  // Counts over the class limit turn red; the DM may allow more, so it's only a warning.
  const box = (val, label, info, over = false) =>
    `<div class="cs-box ${over ? "pc-over" : ""}"><div class="cs-box-val">${val}</div><div class="cs-small-label cs-info-link" ${infoAttr(`term:${info}`)}>${label}</div></div>`;
  const prepared = isSpellbook(d) ? n.prepared : n.spells;
  return [
    box(ABILITY_SHORT[s.ability], t("Zauberattribut"), "spellability"),
    box(s.dc, t("Zauber-SG"), "spelldc"),
    box(signed(s.attack), t("Zauberangriff"), "spellattack"),
    s.cantrips !== null ? box(`${n.cantrips}/${s.cantrips}`, t("Zaubertricks"), "cantrips", n.cantrips > s.cantrips) : "",
    s.known !== null ? box(`${n.spells}/${s.known}`, t("Bekannte Zauber"), "known", n.spells > s.known) : "",
    isSpellbook(d) ? box(n.spells, t("Im Zauberbuch"), "known") : "",
    s.prepared !== null ? box(`${prepared}/${s.prepared}`, t("Vorbereitet"), "prepared", prepared > s.prepared) : "",
    box(x.maxSpellLevel ? t("Grad {n}", { n: x.maxSpellLevel }) : "–", t("Höchster Grad"), "slots"),
  ].join("");
}

// One pip per use, filled = used; live sheets toggle them by clicking (play_state).
function pipsHtml(total, used, attr, live) {
  return Array.from({ length: total }, (_, i) =>
    live
      ? `<button type="button" class="pc-pip ${i < used ? "used" : ""}" ${attr} data-pip="${i}" title="${i < used ? t("verbraucht") : t("frei")}"></button>`
      : `<span class="pc-pip ${i < used ? "used" : ""}"></span>`
  ).join("");
}

// Spell slots with one pip per slot.
function pcSlotsHtml(x, play = {}, live = false) {
  const s = x.spell;
  if (!s) return "";
  const pips = (total, used, attr) => pipsHtml(total, used, attr, live);
  if (s.pact) {
    const used = Math.min(s.pact.count, play.pact_used || 0);
    return `<div class="pc-slot pact"><div class="pc-slot-val">${s.pact.count - used}/${s.pact.count} × ${t("Grad {n}", { n: s.pact.level })}</div><div class="pc-pips">${pips(s.pact.count, used, "data-pact")}</div><div class="cs-small-label cs-info-link" ${infoAttr("term:pact")}>${t("Paktmagie (kurze Rast)")}</div></div>`;
  }
  const usedBy = play.slots_used || {};
  return s.slots
    .map((n, i) => {
      const used = Math.min(n, usedBy[i + 1] || 0);
      return `<div class="pc-slot"><div class="pc-slot-val">${n - used}/${n}</div><div class="pc-pips">${pips(n, used, `data-slot-level="${i + 1}"`)}</div><div class="cs-small-label">${t("Grad {n}", { n: i + 1 })}</div></div>`;
    })
    .join("");
}

// Class resources with limited uses, tracked like spell slots. The key names the rest that brings
// them back ("short:" or "long:"), so the server can reset them without knowing the classes.
function pcTrackers(d, x) {
  const list = [];
  if (d.class_key === "monk" && x.lvl >= 2) list.push({ key: "short:ki", label: t("Ki-Punkte"), max: x.lvl, rest: t("kurze Rast"), info: "feature:Ki-Punkte" });
  return list;
}

function pcTrackersHtml(d, x, live) {
  const used = d.play.res_used || {};
  return pcTrackers(d, x)
    .map((r) => {
      const u = Math.min(r.max, used[r.key] || 0);
      return `<div class="pc-slot pc-tracker"><div class="pc-slot-val">${r.max - u}/${r.max}</div><div class="pc-pips">${pipsHtml(r.max, u, `data-res="${r.key}"`, live)}</div><div class="cs-small-label cs-info-link" ${infoAttr(r.info)}>${r.label} (${r.rest})</div></div>`;
    })
    .join("");
}

// ---------- spells ----------

const spellLibrary = () => (typeof state !== "undefined" && state.spells) || [];

// Spells of a class from the library; Open5e names the classes in English ("Sorcerer, Wizard").
function classSpells(classKey) {
  const cls = CLASSES[classKey];
  if (!cls) return [];
  return spellLibrary().filter((sp) =>
    String(sp.dnd_class || "").toLowerCase().split(",").map((c) => c.trim()).includes(cls.en)
  );
}

const spellGroupLabel = (lvl) => (lvl === 0 ? t("Zaubertricks") : lvl == null ? t("Grad unbekannt (nicht in der Zauberliste)") : t("Grad {n}", { n: lvl }));

function findSpell(entry) {
  const lib = spellLibrary();
  const byId = lib.find((sp) => String(sp.id) === String(entry.id));
  if (byId && (!entry.name || byId.name === entry.name)) return byId;
  return lib.find((sp) => sp.name === entry.name) || (entry.name ? null : byId) || null;
}
// Chosen spells grouped by level. Editing shows remove buttons and the wizard's "vorbereitet" box; a live
// sheet (player view) a star button to prepare a spell from the spellbook.
function pcSpellListHtml(d, editable, live = false) {
  if (!d.spell_list.length) return `<div class="pc-hint">${editable ? t("Noch keine Zauber gewählt.") : t("Keine Zauber gewählt.")}</div>`;
  const levels = [...new Set(d.spell_list.map((s) => s.level ?? null))].sort((a, b) => (a ?? 99) - (b ?? 99));
  const x = pcDerived(d);
  return levels
    .map((lvl) => {
      const items = d.spell_list
        .map((s, i) => ({ s, i }))
        .filter(({ s }) => (s.level ?? null) === lvl)
        .sort((a, b) => a.s.name.localeCompare(b.s.name))
        .map(({ s, i }) => {
          const sp = findSpell(s);
          const subTitle = `${s.source ? t("Aus der Unterklasse ({source}): immer vorbereitet, zählt nicht mit", { source: s.source }) : t("Aus der Unterklasse: immer vorbereitet, zählt nicht mit")}${s.class_en ? `, ${t("gilt als {class}-Zauber", { class: classLabelEn(s.class_en) })}` : ""}`;
          const marks = `${sp && sp.concentration ? `<span class="pc-mark" title="${t("Konzentration")}">${t("K")}</span>` : ""}${s.ritual_only ? `<span class="pc-mark" title="${t("Nur als Ritual")}">${t("nur R")}</span>` : sp && sp.ritual ? `<span class="pc-mark" title="${t("Ritual")}">R</span>` : ""}${s.extra ? `<span class="pc-mark pc-mark-sub" title="${escapeHtml(subTitle)}">${t("U")}</span>` : ""}`;
          const dmg = cantripDamage(s, d, x);
          const dmgHtml = dmg ? `<span class="pc-dmg" title="${escapeHtml(dmg.title)}">${escapeHtml(dmg.text)}</span>` : "";
          const prep =
            isSpellbook(d) && lvl > 0
              ? editable
                ? `<label class="pc-prep" title="${t("Vorbereitet")}"><input type="checkbox" data-spell-prep="${i}" ${s.prepared ? "checked" : ""} />★</label>`
                : live
                  ? `<button type="button" class="pc-prep-btn ${s.prepared ? "on" : ""}" data-spell-prep-live="${i}" title="${s.prepared ? t("Vorbereitet: antippen zum Entfernen") : t("Antippen zum Vorbereiten")}">★</button>`
                  : s.prepared ? `<span class="pc-prep on" title="${t("Vorbereitet")}">★</span>` : ""
              : "";
          const remove = editable ? `<button type="button" class="pc-x" data-spell-remove="${i}" title="${t("Entfernen")}">✕</button>` : "";
          return `<span class="pc-chip ${isSpellbook(d) && lvl > 0 && !s.prepared ? "dim" : ""}">${prep}<span class="cs-info-link" ${infoAttr(`spell:${s.id ?? ""}:${s.name}`)}>${escapeHtml(s.name)}</span>${marks}${dmgHtml}${remove}</span>`;
        })
        .join("");
      return `<div class="pc-spell-level"><div class="pc-spell-level-label">${spellGroupLabel(lvl)}</div><div class="pc-chips">${items}</div></div>`;
    })
    .join("");
}

// Picker for new spells: the class list up to the highest castable level, without the chosen ones.
function pcSpellPickerHtml(d, x) {
  if (!x.spell) return "";
  const chosen = new Set(d.spell_list.map((s) => String(s.id)));
  const options = classSpells(d.class_key).filter((sp) => sp.level_int <= x.maxSpellLevel && !chosen.has(String(sp.id)));
  if (!options.length) {
    return `<div class="pc-hint">${spellLibrary().length ? t("Keine weiteren Zauber dieser Klasse in der Zauberliste.") : t("Die Zauberliste ist leer: im Tracker unter „Zauber“ importieren.")}</div>`;
  }
  const groups = [...new Set(options.map((sp) => sp.level_int))].sort((a, b) => a - b);
  return `
    <div class="pc-add-row">
      <select data-spell-pick>
        <option value="">${t("Zauber hinzufügen …")}</option>
        ${groups
          .map(
            (lvl) =>
              `<optgroup label="${spellGroupLabel(lvl)}">${options
                .filter((sp) => sp.level_int === lvl)
                .map((sp) => `<option value="${sp.id}">${escapeHtml(sp.name)}${sp.concentration ? ` (${t("K")})` : ""}${sp.ritual ? " (R)" : ""}</option>`)
                .join("")}</optgroup>`
          )
          .join("")}
      </select>
      <button type="button" class="ghost pc-btn" data-spell-add>${t("Hinzufügen")}</button>
    </div>`;
}

// ---------- weapons and ammunition ----------

const weaponKey = (name) => String(name || "").toLowerCase().trim();
// German dice are written W6, 2W8; in other languages they stay d6, 2d8.
const diceDe = (dice) => (UI_DE ? String(dice || "").replace(/(^|\d)d(\d)/gi, "$1W$2") : String(dice || ""));

// +1 to +3 from the name or the description of a magic weapon ("+1 Langschwert …").
function magicBonus(it) {
  const m = /(^|[\s(])\+([1-3])(?=[\s)]|$)/.exec(`${it.name || ""} ${it.desc || ""}`);
  return m ? Number(m[2]) : 0;
}

// Weapon values of a library item: its own (SRD weapons) or, for named magic weapons such as
// "Talon" (type "Weapon (longsword)"), those of the base weapon plus the magic bonus.
function itemWeapon(it) {
  if (!it) return null;
  const sb = it.stat_block || {};
  if (sb.weapon) return { ...sb.weapon, bonus: magicBonus(it), base: it.name };
  const m = /weapon\s*\(([^)]+)\)/i.exec(it.item_type || "");
  const base = m && state.items.find((b) => b.stat_block && b.stat_block.weapon && weaponKey(b.name) === weaponKey(m[1]));
  return base ? { ...base.stat_block.weapon, bonus: magicBonus(it), base: base.name } : null;
}

const libraryWeapons = () => state.items.filter((it) => itemWeapon(it));
const weaponNameDe = (name) => WEAPON_DE[weaponKey(name)] || name;

function weaponProps(w) {
  return (w.properties || []).map((p) => {
    const m = /^([a-z-]+)\s*(?:\((.*)\))?/i.exec(String(p).trim());
    return { key: m ? m[1].toLowerCase() : String(p), arg: m && m[2] ? m[2] : "" };
  });
}

// Proficient when the class or "Weitere Übungen" names the weapon group or the weapon itself.
function weaponProficient(w, d) {
  const text = `${d.proficiencies || ""} ${(classInfo(d.class_key, d.class_ref) || {}).profs || ""}`.toLowerCase();
  // Third-party classes list their proficiencies in English.
  const martial = /martial/i.test(w.category || "");
  if (text.includes(martial ? "kriegswaffen" : "einfache waffen") || text.includes(martial ? "martial weapons" : "simple weapons")) return true;
  const de = (WEAPON_DE[weaponKey(w.base)] || "").toLowerCase();
  return !!de && text.includes(de);
}

// Attack bonus and damage of an equipped weapon, following the PHB: STR for melee, DEX for ranged,
// the better of both for finesse (and monk) weapons; proficiency only when proficient.
// offhand: the second light weapon when fighting with two (bonus action, no positive modifier on damage).
function weaponAttack(entry, d, x, offhand = false) {
  const item = libItem(entry.item_id);
  const w = (item && itemWeapon(item)) || entry.weapon || {};
  const props = weaponProps(w);
  const has = (k) => props.some((p) => p.key === k);
  const ranged = /ranged/i.test(w.category || "");
  const monkWeapon =
    d.class_key === "monk" && !ranged &&
    (weaponKey(w.base) === "shortsword" || (/simple/i.test(w.category || "") && !has("heavy") && !has("two-handed")));
  const ab = ranged ? "dex" : (has("finesse") || monkWeapon) && x.m.dex > x.m.str ? "dex" : "str";
  const prof = weaponProficient(w, d);
  const bonus = w.bonus || 0;
  const mod = (offhand ? Math.min(0, x.m[ab]) : x.m[ab]) + bonus;
  const dmg = (dice) => `${diceDe(dice)}${mod ? ` ${mod > 0 ? "+" : "−"} ${Math.abs(mod)}` : ""}`;
  const versatile = props.find((p) => p.key === "versatile" && p.arg);
  const type = DAMAGE_TYPE_DE[w.damage_type] || w.damage_type || "";
  // Versatile: wielded with both hands (inventory) it uses the bigger die.
  const twoHanded = !!(entry.two_handed && versatile);
  return {
    name: `${entry.name}${twoHanded ? ` ${t("(zweihändig)")}` : ""}${offhand ? ` ${t("(Zweitwaffe, Bonusaktion)")}` : ""}`,
    item_id: entry.item_id,
    offhand,
    toHit: x.m[ab] + (prof ? x.prof : 0) + bonus,
    damage: twoHanded
      ? `${dmg(versatile.arg)} ${type}`.trim()
      : `${dmg(w.damage_dice)} ${type}`.trim() + (versatile && !d.shield && d.weapons.length < 2 ? ` ${t("(zweihändig {dice})", { dice: dmg(versatile.arg) })}` : ""),
    ab,
    abMod: x.m[ab],
    prof,
    profBonus: prof ? x.prof : 0,
    bonus,
    base: w.base,
    props,
  };
}

// One table row per equipped weapon; the name opens the explanation with the calculation.
function weaponRowsHtml(d, x) {
  // Two light weapons: the second one attacks as a bonus action (two-weapon fighting).
  const dual = d.weapons.length === 2 && d.weapons.every((w) => isLight(w.weapon));
  return d.weapons
    .map((entry, i) => {
      const a = weaponAttack(entry, d, x, dual && i === 1);
      const data = escapeHtml(JSON.stringify(a));
      return `<tr class="pc-weapon-row"><td><span class="cs-info-link" data-info="weapon" data-weapon="${data}">${escapeHtml(a.name)}</span>${a.prof ? "" : ` <span class="pc-warn" title="${t("Nicht geübt: kein Übungsbonus")}">⚠</span>`}</td><td>${signed(a.toHit)}</td><td>${escapeHtml(a.damage)}</td></tr>`;
    })
    .join("");
}

// Ammunition lives in the play state: counted down during play without opening the editor.
function ammoHtml(d, live) {
  const ammo = d.play.ammo || [];
  const rows = ammo
    .map((a, i) =>
      live
        ? `<div class="pc-ammo-row"><span class="pc-ammo-name">${escapeHtml(a.name)}</span><button type="button" class="pc-hp-btn" data-ammo-step="-1" data-ammo="${i}">−</button><span class="pc-ammo-count">${a.count}</span><button type="button" class="pc-hp-btn" data-ammo-step="1" data-ammo="${i}">+</button><button type="button" class="pc-x" data-ammo-remove="${i}" title="${t("Entfernen")}">✕</button></div>`
        : `<div class="pc-ammo-row"><span class="pc-ammo-name">${escapeHtml(a.name)}</span><span class="pc-ammo-count">${a.count}</span></div>`
    )
    .join("");
  if (!live) return rows || `<div class="pc-hint">${t("Keine Munition.")}</div>`;
  const libraryAmmo = state.items
    .filter((it) => /ammunition|arrow|bolt|needle|bullet/i.test(`${it.item_type || ""} ${it.name}`) && !itemWeapon(it))
    .map((it) => it.name);
  const names = [...new Set([...STANDARD_AMMO, ...libraryAmmo])].filter((n) => !ammo.some((a) => a.name === n));
  return `${rows}
    <div class="pc-add-row"><select data-ammo-pick><option value="">${t("Munition hinzufügen …")}</option>${names.map((n) => `<option>${escapeHtml(n)}</option>`).join("")}</select><input type="number" min="0" data-ammo-start value="20" title="${t("Anzahl")}" /><button type="button" class="ghost pc-btn" data-ammo-add>${t("Hinzufügen")}</button></div>`;
}

// ---------- hit points ----------

function pcHpHtml(d, live) {
  const hp = d.current_hp ?? d.max_hp;
  const controls = live
    ? `
      <div class="pc-hp-row">
        <button type="button" class="pc-hp-btn" data-hp-step="-5">−5</button>
        <button type="button" class="pc-hp-btn" data-hp-step="-1">−1</button>
        <input type="number" min="0" class="pc-hp-amount" placeholder="${t("Wert")}" inputmode="numeric" title="${t("Enter = Schaden, Shift+Enter = Heilen")}" />
        <button type="button" class="pc-hp-btn" data-hp-step="1">+1</button>
        <button type="button" class="pc-hp-btn" data-hp-step="5">+5</button>
      </div>
      <div class="pc-hp-row">
        <button type="button" class="pc-hp-btn damage" data-hp-apply="damage">${t("Schaden")}</button>
        <button type="button" class="pc-hp-btn heal" data-hp-apply="heal">${t("Heilen")}</button>
      </div>`
    : "";
  const temp = live
    ? `<div class="pc-hp-row">
        <button type="button" class="pc-hp-btn" data-temp-step="-5">−5</button>
        <button type="button" class="pc-hp-btn" data-temp-step="-1">−1</button>
        <input type="number" min="0" class="pc-temp-input" value="${d.temp_hp}" inputmode="numeric" title="${t("Neuer Wert")}" />
        <button type="button" class="pc-hp-btn" data-temp-step="1">+1</button>
        <button type="button" class="pc-hp-btn" data-temp-step="5">+5</button>
      </div>`
    : `<div class="cs-box-val">${d.temp_hp}</div>`;
  const rest = live
    ? `<div class="pc-hp-row pc-rest">
        <button type="button" class="ghost pc-btn" data-rest="short">${t("Kurze Rast")}</button>
        <button type="button" class="ghost pc-btn" data-rest="long">${t("Lange Rast")}</button>
        <span class="cs-info-link pc-legend" ${infoAttr("term:rest")}>?</span>
      </div>`
    : "";
  return `
    <div class="cs-combat pc-hp-wrap">
      <div class="cs-box pc-hp ${hp <= 0 ? "down" : ""}">
        <div class="pc-hp-now"><span class="pc-hp-val">${hp ?? "–"}</span><span class="pc-hp-of">/ ${d.max_hp ?? "–"}</span></div>
        <div class="cs-small-label cs-info-link" ${infoAttr("term:hp")}>${t("Momentane Trefferpunkte")}</div>
        ${controls}
        ${rest}
      </div>
      <div class="cs-box pc-temp">
        ${temp}
        <div class="cs-small-label cs-info-link" ${infoAttr("term:temp")}>${t("Temporäre Trefferpunkte")}</div>
      </div>
    </div>`;
}

// ---------- hit dice ----------

// Spent hit dice (play_state.hd_used); a long rest brings back half the total, at least one (PHB).
function hitDiceHtml(d, x, live) {
  if (!x.cls) return "";
  const used = Math.min(x.lvl, d.play.hd_used || 0);
  return `
    <div class="pc-hd-left">${t("{n}/{max} übrig", { n: x.lvl - used, max: x.lvl })}</div>
    <div class="pc-pips">${pipsHtml(x.lvl, used, "data-hd", live)}</div>
    ${live && used < x.lvl ? `<button type="button" class="pc-hp-btn pc-hd-roll" data-hd-roll title="${t("Einen Trefferwürfel ausgeben: W{die} + KON heilen", { die: x.cls.hitDie })}">${t("Ausgeben (W{die} {con})", { die: x.cls.hitDie, con: signed(x.m.con) })}</button>` : ""}`;
}

// ---------- inventory ----------

// play_state.inventory: [{name, qty, item_id}] with item_id set for items from the tracker's item list.
function inventoryHtml(d, live) {
  const inv = equipInventory(d);
  const rows = inv
    .map((e, i) => {
      const it = libItem(e.item_id);
      const name = it
        ? `<span class="cs-info-link" ${infoAttr(`item:${e.item_id}`)}>${escapeHtml(e.name)}</span>`
        : escapeHtml(e.name);
      // Armor, shields, weapons, rings and wondrous items get the "equipped" box; a versatile weapon
      // in hand also one for wielding it with both hands.
      const info = equipInfo(e);
      const box = info
        ? live
          ? `<input type="checkbox" class="cs-dot pc-equip" data-inv-equip="${i}" ${e.equipped ? "checked" : ""} title="${t("Ausgerüstet")}" />`
          : `<span class="cs-dot pc-equip ${e.equipped ? "on" : ""}" title="${e.equipped ? t("Ausgerüstet") : t("Nicht ausgerüstet")}"></span>`
        : '<span class="pc-equip-none"></span>';
      const twoHand = info && info.kind === "weapon" && e.equipped && isVersatile(info.weapon)
        ? live
          ? `<label class="pc-2h" title="${t("Vielseitig: zweihändig führen (grösserer Schadenswürfel, keine Hand für einen Schild)")}"><input type="checkbox" data-inv-two-hand="${i}" ${e.two_handed ? "checked" : ""} />2H</label>`
          : e.two_handed ? '<span class="pc-2h">2H</span>' : ""
        : "";
      const attune = info && info.attune ? `<span class="pc-mark" title="${t("Erfordert Einstimmung")}">${t("E")}</span>` : "";
      return live
        ? `<div class="pc-ammo-row">${box}<span class="pc-ammo-name">${name}${attune}${twoHand}</span><button type="button" class="pc-hp-btn" data-inv-step="-1" data-inv="${i}">−</button><span class="pc-ammo-count">${e.qty}</span><button type="button" class="pc-hp-btn" data-inv-step="1" data-inv="${i}">+</button><button type="button" class="pc-x" data-inv-remove="${i}" title="${t("Entfernen")}">✕</button></div>`
        : `<div class="pc-ammo-row">${box}<span class="pc-ammo-name">${name}${attune}${twoHand}</span><span class="pc-ammo-count">${e.qty}</span></div>`;
    })
    .join("");
  if (!live) return rows || `<div class="pc-hint">${t("Leer.")}</div>`;
  // Type-ahead over the item list; anything else typed in becomes a free entry.
  const listId = "pc-inv-items";
  return `${rows || `<div class="pc-hint">${t("Noch nichts im Inventar.")}</div>`}
    <div class="pc-add-row">
      <input data-inv-name list="${listId}" placeholder="${t("Gegenstand suchen oder eintippen …")}" />
      <datalist id="${listId}">${state.items.map((it) => `<option value="${escapeHtml(it.name)}">${escapeHtml(it.item_type || "")}</option>`).join("")}</datalist>
      <input type="number" min="1" data-inv-qty value="1" title="${t("Anzahl")}" />
      <button type="button" class="ghost pc-btn" data-inv-add>${t("Hinzufügen")}</button>
    </div>`;
}

// ---------- speed ----------

// 5 ft = 1.5 m = one square on the battlemap.
const ftToM = (ft) => `${String((ft / 5) * 1.5).replace(".", UI_DE ? "," : ".")} m`;
const isDwarf = (d) => /zwerg|dwarf|duergar/i.test(d.race || "");

function raceSpeed(race) {
  const r = String(race || "").toLowerCase();
  return r ? RACE_SPEEDS.find(([keys]) => keys.some((k) => r.includes(k))) || null : null;
}

// Walking speed per the PHB: base speed of the people, monk Unarmored Movement (no armor, no shield),
// barbarian Fast Movement (not in heavy armor), -10 ft in heavy armor without its strength
// (dwarves excepted), then the manual adjustment (feats, magic items).
function pcSpeed(d, x, acr) {
  // A people from the library brings its own speeds; otherwise the name is matched (RACE_SPEEDS).
  const own = d.race_ref && d.race_ref.speed && d.race_ref.speed.walk ? d.race_ref.speed : null;
  const hit = own
    ? [[], own.walk, Object.fromEntries(Object.entries(own).filter(([k]) => k !== "walk" && MOVE_LABELS[k]))]
    : raceSpeed(d.race);
  let ft = hit ? hit[1] : 30;
  const parts = [hit ? `${d.race_ref ? optName(d.race_ref) : d.race}: ${ft} ft` : t("Grundwert 30 ft (Volk nicht erkannt)")];
  const notes = [];
  const heavy = acr.armor && acr.armor.category === "heavy";
  if (d.class_key === "monk" && x.lvl >= 2) {
    const bonus = byLevel(x.lvl, [[2, 10], [6, 15], [10, 20], [14, 25], [18, 30]]);
    if (!acr.armor && !d.shield) {
      ft += bonus;
      parts.push(t("Ungerüstete Bewegung +{n} ft", { n: bonus }));
    } else notes.push(t("Ungerüstete Bewegung (+{n} ft) gilt nur ohne Rüstung und Schild.", { n: bonus }));
  }
  if (d.class_key === "barbarian" && x.lvl >= 5) {
    if (!heavy) {
      ft += 10;
      parts.push(t("Schnelle Bewegung +10 ft"));
    } else notes.push(t("Schnelle Bewegung (+10 ft) gilt nicht in schwerer Rüstung."));
  }
  if (acr.armor && acr.armor.str_req && (d.abilities.str ?? 0) < acr.armor.str_req) {
    if (isDwarf(d)) notes.push(t("{armor}: Zwerge werden durch schwere Rüstung nicht langsamer.", { armor: acr.armor.name }));
    else {
      ft -= 10;
      parts.push(t("{armor} ohne STÄ {n}: −10 ft", { armor: acr.armor.name, n: acr.armor.str_req }));
    }
  }
  const adjust = parseInt(d.speed_adjust, 10) || 0;
  if (adjust) {
    ft += adjust;
    parts.push(t("Anpassung {n} ft", { n: signed(adjust) }));
  }
  ft = Math.max(0, ft);
  const extra = Object.entries((hit && hit[2]) || {}).map(([k, v]) => `${MOVE_LABELS[k]} ${ftToM(v)} (${v} ft)`);
  return { ft, parts, notes, extra };
}

function speedSubHtml(sp) {
  const squares = Math.floor(sp.ft / 5);
  return `${sp.ft} ft · ${tn(squares, "{n} Feld", "{n} Felder")}${sp.extra.map((e) => `<br>${escapeHtml(e)}`).join("")}`;
}

// ---------- armor class ----------

// Item stat_block.armor: {category, base_ac, max_dex (null = full DEX, 0 = none), bonus, str_req, stealth_disadvantage}
const ARMOR_CATEGORIES = [
  ["light", t("Leichte Rüstung")],
  ["medium", t("Mittelschwere Rüstung")],
  ["heavy", t("Schwere Rüstung")],
  ["shield", t("Schild")],
];
const ARMOR_DEX_CAP = { light: null, medium: 2, heavy: 0, shield: 0 };
const MAGE_ARMOR = "mage";

const itemArmor = (it) => (it && it.stat_block && it.stat_block.armor) || null;

function armorFormula(a) {
  const bonus = a.bonus ? ` ${signed(a.bonus)}` : "";
  if (a.category === "shield") return `${signed((a.base_ac ?? 2) + (a.bonus || 0))}`;
  const dex = a.max_dex === 0 ? "" : a.max_dex ? ` + ${t("GES (max {n})", { n: a.max_dex })}` : ` + ${t("GES")}`;
  return `${a.base_ac ?? "?"}${dex}${bonus}`;
}

// Body armor in the item library, for the sheet's armor dropdown.
const libraryArmor = () => state.items.filter((it) => itemArmor(it) && itemArmor(it).category !== "shield");

// ---------- equipment: items equipped in the inventory ----------

const libItem = (id) => (id === null || id === undefined ? null : state.items.find((it) => String(it.id) === String(id)) || null);

// Armor values of an item: its own (SRD armor and shield) or, for magic armor such as "Dragonguard"
// (type "Armor (breastplate)") or "Shield, +1", those of the base armor plus the magic bonus.
function itemArmorFull(it) {
  if (!it) return null;
  const own = itemArmor(it);
  if (own) return own;
  const type = it.item_type || "";
  const m = /^armor\s*\(([^)]+)\)/i.exec(type);
  const isShield = /^shield/i.test(type) || (m && /shield/i.test(m[1]));
  const base = isShield
    ? state.items.find((b) => (itemArmor(b) || {}).category === "shield")
    : m && libraryArmor().find((b) => weaponKey(b.name) === weaponKey(m[1]) || weaponKey(b.name).startsWith(weaponKey(m[1])));
  if (!base) return isShield ? { category: "shield", base_ac: 2, bonus: magicBonus(it) } : null;
  return { ...itemArmor(base), bonus: (itemArmor(base).bonus || 0) + magicBonus(it) };
}

// What an inventory entry is when equipped; null for things that aren't worn or held (potions, gear).
function equipInfo(entry) {
  const it = libItem(entry.item_id);
  const armor = itemArmorFull(it) || entry.armor || null;
  const weapon = (it && itemWeapon(it)) || entry.weapon || null;
  const type = String((it && it.item_type) || "");
  const attune = !!(it && it.requires_attunement);
  if (armor) return { kind: armor.category === "shield" ? "shield" : "armor", armor, attune };
  if (weapon) return { kind: "weapon", weapon, attune };
  if (/^ring/i.test(type)) return { kind: "ring", attune };
  if (/wondrous|rod|staff|wand/i.test(type)) return { kind: "worn", attune };
  return null;
}

// Hands a weapon (entry) takes: two-handed weapons two, versatile ones two when wielded so.
function weaponHands(entry, weapon) {
  const props = weaponProps(weapon || {});
  if (props.some((p) => p.key === "two-handed")) return 2;
  if (entry.two_handed && props.some((p) => p.key === "versatile")) return 2;
  return 1;
}
const isLight = (weapon) => weaponProps(weapon || {}).some((p) => p.key === "light");
const isVersatile = (weapon) => weaponProps(weapon || {}).some((p) => p.key === "versatile");

// Magic items that change numbers on the sheet while worn (and attuned), by their Open5e name.
// "set" raises a score to that value; the sheet's maximum of 20 still applies.
const ITEM_EFFECTS = [
  [/^ring of protection$/i, { ac: 1, saves: 1 }],
  [/^cloak of protection$/i, { ac: 1, saves: 1 }],
  [/^bracers of defense$/i, { acUnarmored: 2 }],
  [/^(stone of good luck|luckstone)/i, { saves: 1 }],
  [/^ioun stone.*protection/i, { ac: 1 }],
  [/^gauntlets of ogre power$/i, { set: { str: 19 } }],
  [/^headband of intellect$/i, { set: { int: 19 } }],
  [/^amulet of health$/i, { set: { con: 19 } }],
  [/^belt of .*giant strength$/i, { set: { str: 20 } }],
];
const itemEffect = (name) => (ITEM_EFFECTS.find(([re]) => re.test(String(name || "").trim())) || [null, null])[1];

// The equipped items of an inventory: {armor, shield, weapons, worn}. Armor and shield are
// {name, item_id, category, base_ac, bonus …}; weapons {item_id, name, weapon, two_handed}.
function equipmentFromInventory(inv) {
  const eq = { armor: null, shield: null, weapons: [], worn: [] };
  for (const e of inv) {
    if (!e.equipped) continue;
    const info = equipInfo(e);
    if (!info) continue;
    if (info.kind === "armor") eq.armor = { name: e.name, item_id: e.item_id ?? null, ...info.armor };
    else if (info.kind === "shield") eq.shield = { name: e.name, item_id: e.item_id ?? null, ...info.armor };
    else if (info.kind === "weapon") eq.weapons.push({ item_id: e.item_id ?? null, name: e.name, weapon: info.weapon, two_handed: !!e.two_handed });
    else eq.worn.push({ name: (libItem(e.item_id) || e).name, item_id: e.item_id ?? null });
  }
  return eq;
}

// Sheets from before the inventory equipment: armor dropdown, shield box and weapon list.
function legacyEquipment(sb) {
  let armor = null;
  if (sb.armor_id && sb.armor_id !== MAGE_ARMOR) {
    const it = libItem(sb.armor_id);
    armor = it && itemArmor(it) ? { name: it.name, item_id: it.id, ...itemArmor(it) } : sb.armor ? { item_id: sb.armor_id, ...sb.armor } : null;
  }
  return {
    armor,
    shield: sb.shield ? { name: t("Schild"), item_id: null, category: "shield", base_ac: 2, bonus: 0 } : null,
    weapons: (sb.weapons || []).map((w) => ({ ...w, two_handed: !!w.two_handed })),
    worn: [],
  };
}

// The inventory decides once an entry has been equipped there; until then the stored copy
// (sheet.equipped, which is also what the tracker sees) or the old fields.
function pcEquipment(entity, sb) {
  const inv = ((entity && entity.play_state) || {}).inventory || [];
  if (inv.some((e) => "equipped" in e)) return equipmentFromInventory(inv);
  return sb.equipped || legacyEquipment(sb);
}

function equipmentEffects(eq) {
  const fx = { ac: 0, saves: 0, acUnarmored: 0, set: {}, sources: [] };
  for (const w of eq.worn || []) {
    const e = itemEffect(w.name);
    if (!e) continue;
    fx.ac += e.ac || 0;
    fx.saves += e.saves || 0;
    fx.acUnarmored += e.acUnarmored || 0;
    for (const [k, v] of Object.entries(e.set || {})) fx.set[k] = Math.max(fx.set[k] || 0, Math.min(ABILITY_MAX, v));
    fx.sources.push(w.name);
  }
  return fx;
}

// The inventory with "equipped" flags. Equipment from before the inventory (armor dropdown, weapon
// list) shows up here as equipped entries; the first change in the inventory saves them that way.
function equipInventory(d) {
  const inv = (d.play.inventory || []).map((e) => ({ ...e }));
  if (inv.some((e) => "equipped" in e)) return inv;
  const eq = d.equip;
  const add = (name, itemId, extra) => {
    const same = itemId !== null && itemId !== undefined && inv.find((e) => String(e.item_id) === String(itemId));
    if (same) same.equipped = true;
    else inv.push({ name, qty: 1, item_id: itemId ?? null, equipped: true, ...extra });
  };
  const strip = ({ name, item_id, ...rest }) => rest;
  if (eq.armor) add(eq.armor.name, eq.armor.item_id, { armor: strip(eq.armor) });
  if (eq.shield) {
    const it = eq.shield.item_id ?? null ? libItem(eq.shield.item_id) : state.items.find((b) => (itemArmor(b) || {}).category === "shield");
    add(it ? it.name : eq.shield.name, it ? it.id : null, { armor: strip(eq.shield) });
  }
  for (const w of eq.weapons) add(w.name, w.item_id, { weapon: w.weapon, two_handed: !!w.two_handed });
  for (const w of eq.worn) add(w.name, w.item_id, {});
  return inv.map((e) => ({ ...e, equipped: !!e.equipped }));
}

function attunementHtml(d) {
  const n = equipInventory(d).filter((e) => e.equipped && (equipInfo(e) || {}).attune).length;
  return n ? `<span class="pc-count ${n > 3 ? "warn" : ""}" title="${t("Eingestimmte Gegenstände (höchstens 3)")}">${t("E")} ${n}/3</span> ` : "";
}

// Why an item can't be equipped (D&D rules), or null. inv is the inventory with the item already
// marked; armor and shield replace the previous one before this check.
function equipProblem(inv) {
  const eq = inv.filter((e) => e.equipped).map((e) => ({ e, info: equipInfo(e) })).filter((x) => x.info);
  const weapons = eq.filter((x) => x.info.kind === "weapon");
  const shield = eq.some((x) => x.info.kind === "shield");
  const hands = weapons.reduce((s, x) => s + weaponHands(x.e, x.info.weapon), 0) + (shield ? 1 : 0);
  if (shield && weapons.some((x) => weaponHands(x.e, x.info.weapon) === 2)) {
    return weapons.some((x) => weaponProps(x.info.weapon).some((p) => p.key === "two-handed"))
      ? t("Eine Zweihandwaffe braucht beide Hände: kein Schild dazu.")
      : t("Eine vielseitige Waffe zweihändig geführt lässt keine Hand für den Schild frei.");
  }
  if (hands > 2) return t("Dafür reichen zwei Hände nicht. Lege zuerst etwas ab.");
  if (weapons.length === 2 && !weapons.every((x) => isLight(x.info.weapon))) {
    return t("Kampf mit zwei Waffen geht nur, wenn beide Waffen leicht sind.");
  }
  if (eq.filter((x) => x.info.kind === "ring").length > 2) return t("Mehr als zwei Ringe lassen sich nicht tragen.");
  if (eq.filter((x) => x.info.attune).length > 3) return t("Höchstens drei Gegenstände können gleichzeitig eingestimmt sein.");
  return null;
}

// Armor class per the PHB: unarmored 10 + DEX (Barbarian + CON, Monk + WIS without shield),
// Mage Armor 13 + DEX, light armor base + DEX, medium base + DEX (max 2), heavy base only;
// a shield adds +2 (plus its magic), worn items like a Ring of Protection theirs, then the manual
// adjustment on top. Armor and shield are the ones equipped in the inventory (see pcEquipment).
function pcArmorClass(d, m) {
  const armor = d.armor || null;
  const fx = d.effects || { ac: 0, acUnarmored: 0, sources: [] };
  const parts = [];
  const notes = [];
  let ac;
  if (armor) {
    const dex = armor.max_dex === 0 ? 0 : armor.max_dex ? Math.min(m.dex, armor.max_dex) : m.dex;
    ac = (armor.base_ac || 10) + dex + (armor.bonus || 0);
    parts.push(`${armor.name} ${armor.base_ac}`);
    if (armor.max_dex !== 0) parts.push(`${t("GES")} ${signed(dex)}`);
    if (armor.bonus) parts.push(`${t("Bonus")} ${signed(armor.bonus)}`);
    if (armor.str_req && (d.abilities.str ?? 0) < armor.str_req && !isDwarf(d)) notes.push(t("STÄ {n} nötig: Bewegungsrate −3 m", { n: armor.str_req }));
    if (armor.stealth_disadvantage) notes.push(t("Nachteil auf Heimlichkeit"));
  } else if (d.mage_armor) {
    ac = 13 + m.dex;
    parts.push(t("Magierrüstung 13"), `${t("GES")} ${signed(m.dex)}`);
  } else if (d.class_key === "barbarian") {
    ac = 10 + m.dex + m.con;
    parts.push(t("Ungerüstete Verteidigung 10"), `${t("GES")} ${signed(m.dex)}`, `${t("KON")} ${signed(m.con)}`);
  } else if (d.class_key === "monk" && !d.shield) {
    ac = 10 + m.dex + m.wis;
    parts.push(t("Ungerüstete Verteidigung 10"), `${t("GES")} ${signed(m.dex)}`, `${t("WEI")} ${signed(m.wis)}`);
  } else {
    ac = 10 + m.dex;
    parts.push(t("Ohne Rüstung 10"), `${t("GES")} ${signed(m.dex)}`);
  }
  if (d.shield) {
    const s = 2 + (d.shield_bonus || 0);
    ac += s;
    parts.push(`${t("Schild")} ${signed(s)}`);
  }
  if (fx.acUnarmored && !armor && !d.shield) {
    ac += fx.acUnarmored;
    parts.push(`${t("Gegenstände")} ${signed(fx.acUnarmored)}`);
  }
  if (fx.ac) {
    ac += fx.ac;
    parts.push(`${fx.sources.filter((n) => (itemEffect(n) || {}).ac).join(", ")} ${signed(fx.ac)}`);
  }
  const adjust = parseInt(d.ac_adjust, 10) || 0;
  if (adjust) {
    ac += adjust;
    parts.push(`${t("Anpassung")} ${signed(adjust)}`);
  }
  return { ac, armor, breakdown: parts.join(" · "), notes };
}

function pcArmorInfoHtml(r) {
  return `${escapeHtml(r.breakdown)}${r.notes.map((n) => `<br><span class="pc-warn">⚠ ${escapeHtml(n)}</span>`).join("")}`;
}

// opts.live: HP, spell slots, ammunition and rests can be changed while reading (player sheets,
// see bindPcLive); everywhere else they are only shown. opts.portrait: picture URL for the top left corner.
function pcSheetHtml(entity, editable, opts = {}) {
  const live = !!opts.live && !editable;
  const d = pcData(entity);
  const x = pcDerived(d);
  // Characters from before the calculation had a hand-typed AC; keep it via the adjustment.
  const legacyAc = d.ac_adjust === null && entity && entity.ac != null;
  if (legacyAc) d.ac_adjust = entity.ac - pcArmorClass({ ...d, ac_adjust: 0 }, x.m).ac;
  const acr = pcArmorClass(d, x.m);
  const sp = pcSpeed(d, x, acr);
  const esc = (v) => escapeHtml(String(v ?? ""));
  const show = (v) => (v === null || v === undefined || v === "" ? "–" : esc(v));
  const input = (key, cls, { type = "text", placeholder = "", value = d[key], min, max } = {}) =>
    editable
      ? `<input class="${cls}" data-field="${key}" type="${type}" value="${esc(value)}" placeholder="${esc(placeholder)}"${min !== undefined ? ` min="${min}"` : ""}${max !== undefined ? ` max="${max}"` : ""} />`
      : `<div class="${cls}">${show(value)}</div>`;
  const area = (key, placeholder, rows = 3) =>
    editable
      ? `<textarea class="cs-area" data-field="${key}" rows="${rows}" placeholder="${esc(placeholder)}">${esc(d[key])}</textarea>`
      : `<div class="cs-area">${show(d[key])}</div>`;
  const dot = (attr, key, on, title) =>
    editable
      ? `<input type="checkbox" class="cs-dot" ${attr}="${key}" ${on ? "checked" : ""} title="${title}" />`
      : `<span class="cs-dot ${on ? "on" : ""}" title="${title}"></span>`;
  const info = (content, label) => `<div class="cs-info">${content}<div class="cs-small-label">${label}</div></div>`;
  const select = (key, options, value, empty) =>
    editable
      ? `<select class="cs-info-val" data-field="${key}"><option value="">${empty}</option>${options
          .map(([v, l]) => `<option value="${esc(v)}" ${v === value ? "selected" : ""}>${esc(l)}</option>`)
          .join("")}</select>`
      : `<div class="cs-info-val">${show((options.find(([v]) => v === value) || [])[1] || value)}</div>`;

  const alignOptions = ALIGNMENTS.map((a) => [a, t(a)]);
  const cls = classInfo(d.class_key, d.class_ref);
  // Third-party classes from the library come after the SRD ones; a chosen one that was deleted stays.
  const libClasses = libraryClasses();
  if (d.class_ref && !libClasses.some((o) => `lib:${o.id}` === d.class_key)) libClasses.push({ ...d.class_ref, kind: "classes", missing: true });
  const classSelect = editable
    ? `<select class="cs-info-val" data-field="class_key"><option value="">${t("-- Klasse --")}</option>${Object.entries(CLASSES)
        .map(([k, c]) => `<option value="${k}" ${k === d.class_key ? "selected" : ""}>${esc(c.label)}</option>`)
        .join("")}${libClasses
        .map((o) => {
          const ref = o.missing ? d.class_ref : optionRef(o);
          return `<option value="lib:${o.id}" data-ref="${esc(JSON.stringify(ref))}" ${`lib:${o.id}` === d.class_key ? "selected" : ""}>${esc(optionLabel(o))}</option>`;
        })
        .join("")}</select>`
    : `<div class="cs-info-val">${classOption(d) ? `<span class="cs-info-link" ${infoAttr(`opt:${classOption(d).id}`)}>${show(cls && cls.label)}</span>` : show(cls ? cls.label : null)}</div>`;
  // Subclass, people and background: dropdowns of the library; reading shows the name with its explanation.
  const optionField = (field, list, ref, text, empty) =>
    editable
      ? `<select class="cs-info-val" data-option="${field}" data-prev-ref="${esc(JSON.stringify(ref))}">${optionSelectOptions(list, ref, text, empty)}</select>`
      : `<div class="cs-info-val">${ref && optionById(ref.id) ? `<span class="cs-info-link" ${infoAttr(`opt:${ref.id}`)}>${esc(optName(ref))}</span>` : show(ref ? optName(ref) : text)}</div>`;

  const abilities = ABILITIES.map(([key, short, long]) => {
    const score = d.abilities[key];
    const bonus = d.ability_bonus[key];
    const scoreEl = editable
      ? `<input class="cs-ability-score" data-ability="${key}" type="number" min="1" max="20" value="${valOrEmpty(d.ability_base[key])}" placeholder="10" title="${t("Grundwert, ohne Boni von Volk und Hintergrund")}" />
         <div class="pc-abil-bonus" data-derived="abil-${key}">${abilityBonusHtml(d.ability_base[key], bonus)}</div>`
      : `<div class="cs-ability-score" ${bonus ? `title="${t("Grundwert {base} {bonus} (Volk, Hintergrund)", { base: esc(d.ability_base[key]), bonus: signed(bonus) })}"` : ""}>${show(score)}</div>`;
    return `
      <div class="cs-ability" title="${long}">
        <div class="cs-ability-label cs-info-link" ${infoAttr(`ability:${key}`)}>${short}</div>
        <div class="cs-ability-mod" data-mod="${key}">${abilityMod(score)}</div>
        ${scoreEl}
      </div>`;
  }).join("");

  const saves = ABILITIES.map(
    ([key, short, long]) => `
      <div class="pc-check-row">
        ${dot("data-save", key, d.save_prof.includes(key), t("Geübt"))}
        <span class="pc-check-val" data-derived="save-${key}">${signed(x.saves[key])}</span>
        <span class="pc-check-name cs-info-link" ${infoAttr(`save:${key}`)}>${long}</span>
      </div>`
  ).join("");

  const skills = SKILLS.map(
    ([key, label, ab]) => `
      <div class="pc-check-row">
        ${dot("data-skill", key, d.skill_prof.includes(key), t("Geübt"))}
        ${dot("data-expert", key, d.skill_expertise.includes(key), t("Expertise (doppelter Übungsbonus)"))}
        <span class="pc-check-val" data-derived="skill-${key}">${signed(x.skills[key])}</span>
        <span class="pc-check-name cs-info-link" ${infoAttr(`skill:${key}`)}>${label} <span class="pc-ab">(${ABILITY_SHORT[ab]})</span></span>
      </div>`
  ).join("");

  // Equipped weapons are calculated; below them five free rows when editing, only filled ones when reading.
  const attackRows = editable ? [0, 1, 2, 3, 4].map((i) => d.attacks[i] || {}) : d.attacks.filter((a) => a && a.name);
  const attackCell = (i, key, a, placeholder) =>
    editable
      ? `<input data-attack="${i}" data-attack-key="${key}" value="${esc(a[key])}" placeholder="${placeholder}" />`
      : esc(a[key]);
  const attacks = attackRows.length || d.weapons.length || editable
    ? `<table class="pc-attacks">
        <tr><th>${t("Name")}</th><th>${t("Bonus")}</th><th>${t("Schaden / Art")}</th></tr>
        <tbody data-derived="weapon-attacks">${weaponRowsHtml(d, x)}</tbody>
        ${attackRows
          .map(
            (a, i) =>
              `<tr><td>${attackCell(i, "name", a, t("z.B. Langschwert"))}</td><td>${attackCell(i, "bonus", a, "+5")}</td><td>${attackCell(i, "damage", a, t("1W8+3 Hieb"))}</td></tr>`
          )
          .join("")}
      </table>`
    : '<div class="cs-area">–</div>';

  const coins = COINS.map(
    ([key, label]) => `
      <div class="pc-coin">
        ${editable ? `<input type="number" min="0" data-coin="${key}" value="${valOrEmpty(d.coins[key])}" placeholder="0" />` : `<div>${show(d.coins[key])}</div>`}
        <div class="cs-small-label">${label}</div>
      </div>`
  ).join("");

  const initTotal = x.m.dex + (d.initiative_adjust || 0);

  // Armor, shield and weapons are equipped in the inventory; here only what isn't an item.
  const worn = [acr.armor ? acr.armor.name : d.mage_armor ? t("Magierrüstung") : t("keine Rüstung"), d.equip.shield && d.equip.shield.name,
    ...d.weapons.map((w) => w.name), ...d.equip.worn.map((w) => w.name)].filter(Boolean);
  const armorControls = editable
    ? `
      <div class="pc-armor">
        <input type="hidden" data-equipped value="${esc(JSON.stringify(d.equip))}" />
        <div class="pc-armor-read"><b>${t("Ausgerüstet:")}</b> ${esc(worn.join(" · "))}</div>
        <div class="pc-hint">${t("Rüstung, Schild, Waffen und Ringe werden im Inventar ausgerüstet (Spieleransicht, Häkchen „Ausgerüstet“).")}</div>
        <label class="pc-armor-shield"><input type="checkbox" class="cs-dot" data-field-check="mage_armor" ${d.mage_armor ? "checked" : ""} /> ${t("Magierrüstung (Zauber): 13 + GES ohne Rüstung")}</label>
        <div class="pc-armor-adjust" title="${t("Talente, Deckung, Gegenstände ohne eigene Regel …")}">
          <span class="pc-armor-label">${t("RK-Anpassung")}</span>
          <button type="button" class="ghost pc-step" data-step="-1">−</button>
          <input type="number" data-field="ac_adjust" value="${esc(d.ac_adjust || 0)}" ${legacyAc && d.ac_adjust ? "data-legacy" : ""} />
          <button type="button" class="ghost pc-step" data-step="1">+</button>
        </div>
        ${legacyAc && d.ac_adjust ? `<div class="pc-hint" data-legacy-hint>${t("Bisherige RK {ac} übernommen (als Anpassung).", { ac: esc(entity.ac) })}</div>` : ""}
        <div class="pc-hint" data-derived="ac-info">${pcArmorInfoHtml(acr)}</div>
      </div>`
    : `
      <div class="pc-armor">
        <div class="pc-armor-read"><b>${t("Ausgerüstet:")}</b> ${esc(worn.join(" · "))}${d.ac_adjust ? ` · ${t("RK-Anpassung")} ${signed(d.ac_adjust)}` : ""}</div>
        <div class="pc-hint">${pcArmorInfoHtml(acr)}</div>
      </div>`;

  // opts.portraitEdit: the picture can be changed (upload/remove buttons); only pages that handle
  // [data-portrait-input] and [data-portrait-remove] ask for it.
  const portraitEdit = !!opts.portraitEdit;
  // opts.portraitFallback: picture shown while there is no portrait (the class's, Charaktererstellung).
  const portraitSlot = pcPortraitSlotHtml(opts.portrait, portraitEdit, opts.portraitFallback);

  return `
    <div class="char-sheet pc-sheet ${editable ? "editing" : ""}">
      <div class="cs-header ${portraitSlot ? "with-portrait" : ""}">
        ${portraitSlot}
        <div class="cs-name">
          ${input("name", "cs-name-val", { placeholder: t("Name") })}
          <div class="cs-small-label">${t("Charaktername")}</div>
        </div>
        <div class="pc-header-grid">
          ${info(classSelect, t("Klasse"))}
          ${info(input("level", "cs-info-val", { type: "number", min: 1, max: 20, placeholder: "1" }), t("Stufe"))}
          ${info(optionField("subclass", subclassesFor(cls), d.subclass_ref, d.subclass, t("-- Unterklasse --")), t("Unterklasse"))}
          ${info(optionField("background", charOptions("backgrounds"), d.background_ref, d.background, t("-- Hintergrund --")), t("Hintergrund"))}
          ${info(optionField("race", charOptions("races"), d.race_ref, d.race, t("-- Volk --")), t("Volk"))}
          ${info(select("alignment", alignOptions, d.alignment, t("-- Gesinnung --")), t("Gesinnung"))}
          ${info(input("xp", "cs-info-val", { type: "number", min: 0, placeholder: "0" }), t("Erfahrungspunkte"))}
          ${info(`<div class="cs-info-val" data-derived="prof">${signed(x.prof)}</div>`, t("Übungsbonus"))}
        </div>
      </div>

      <div class="pc-grid">
        <div class="pc-col pc-col-a">
          <div class="pc-abil-wrap">
            <div class="pc-abil-stack">${abilities}</div>
            <div class="pc-abil-side">
              <div class="pc-pill">${dot("data-field-check", "inspiration", d.inspiration, t("Inspiration"))}<span class="cs-small-label cs-info-link" ${infoAttr("term:inspiration")}>${t("Inspiration")}</span></div>
              <div class="pc-pill"><b data-derived="prof">${signed(x.prof)}</b><span class="cs-small-label cs-info-link" ${infoAttr("term:prof")}>${t("Übungsbonus")}</span></div>
              <div class="cs-panel pc-checks">
                <div class="cs-panel-title cs-info-link" ${infoAttr("term:saves")}>${t("Rettungswürfe")}</div>
                ${saves}
              </div>
              <div class="cs-panel pc-checks">
                <div class="cs-panel-title"><span class="cs-info-link" ${infoAttr("term:skills")}>${t("Fertigkeiten")}</span>${editable ? ` <span data-derived="skill-count">${skillCountHtml(d, x)}</span>` : ""} <span class="pc-legend">● ${t("geübt")} · ◆ ${t("Expertise")}</span></div>
                ${skills}
                <div class="pc-hint" data-derived="skill-hint">${esc(x.skillHint || "")}</div>
              </div>
            </div>
          </div>
          ${editable ? `<div class="cs-panel pc-asi" data-asi-panel data-key="${asiKey(d)}" ${d.legacy_abilities ? "data-legacy" : ""} ${asiPanelHtml(d) ? "" : "hidden"}>${asiPanelHtml(d)}</div>` : ""}
          <div class="cs-passive">
            <div class="cs-passive-val" data-derived="passive">${x.passive}</div>
            <div class="cs-passive-label cs-info-link" ${infoAttr("term:passive")}>${t("Passive Wahrnehmung")}</div>
          </div>
          <div class="cs-panel">
            <div class="cs-panel-title">${t("Sprachen")}${editable ? ` <span data-derived="lang-count">${languageCountHtml(d)}</span>` : ""}</div>
            ${area("languages", languagePlaceholder(d), 2)}
            <div class="cs-panel-title pc-sub">${t("Weitere Übungen")}</div>
            ${area("proficiencies", x.cls ? x.cls.profs : t("Rüstungen, Waffen, Werkzeuge"), 3)}
          </div>
        </div>

        <div class="pc-col pc-col-b">
          <div class="cs-combat">
            <div class="cs-ac" title="${t("Rüstungsklasse (berechnet)")}">
              <svg viewBox="0 0 24 28" aria-hidden="true"><path d="${SHEET_SHIELD_PATH}" /></svg>
              <div class="cs-ac-val" data-derived="ac">${acr.ac}</div>
              <div class="cs-ac-label cs-info-link" ${infoAttr("term:ac")}>${t("RK")}</div>
            </div>
            <div class="cs-box">
              <div class="cs-box-val" data-derived="initiative">${signed(initTotal)}</div>
              ${editable
                ? `<div class="pc-armor-adjust" title="${t("Talente, magische Gegenstände, Zauber …")}">
                    <button type="button" class="ghost pc-step" data-init-step="-1">−</button>
                    <input type="number" data-field="initiative_adjust" value="${esc(d.initiative_adjust || 0)}" />
                    <button type="button" class="ghost pc-step" data-init-step="1">+</button>
                  </div>`
                : ""}
              <div class="cs-small-label cs-info-link" ${infoAttr("term:init")}>${t("Initiative")}</div>
            </div>
            <div class="cs-box pc-speed">
              <div class="cs-box-val" data-derived="speed">${ftToM(sp.ft)}</div>
              <div class="pc-speed-sub" data-derived="speed-sub">${speedSubHtml(sp)}</div>
              ${editable
                ? `<div class="pc-armor-adjust" title="${t("Talente, magische Gegenstände, Zauber …")}">
                    <button type="button" class="ghost pc-step" data-speed-step="-5">−</button>
                    <input type="number" step="5" data-field="speed_adjust" value="${esc(d.speed_adjust)}" />
                    <button type="button" class="ghost pc-step" data-speed-step="5">+</button>
                  </div>
                  <div class="pc-hint">${t("Anpassung in ft")}${d.speed ? ` · ${t("bisher eingetragen: {speed}", { speed: esc(d.speed) })}` : ""}</div>`
                : ""}
              <div class="cs-small-label cs-info-link" data-info="speed" data-speed="${esc(JSON.stringify(sp))}">${t("Bewegungsrate")}</div>
            </div>
          </div>
          <div class="cs-combat">
            <div class="cs-box cs-hp">
              ${input("max_hp", "cs-box-val", { type: "number", placeholder: t("HP") })}
              <div class="cs-small-label cs-info-link" ${infoAttr("term:maxhp")}>${t("Trefferpunkte-Max.")}</div>
              ${editable ? `<div class="pc-hint">${t("Vorschlag:")} <span data-derived="hp-suggest">${x.hpSuggest ?? "–"}</span> ${t("(Durchschnitt)")}</div>` : ""}
            </div>
            <div class="cs-box">
              <div class="cs-box-val" data-derived="hit-dice">${x.hitDice || "–"}</div>
              ${editable ? "" : hitDiceHtml(d, x, live)}
              <div class="cs-small-label cs-info-link" ${infoAttr("term:hitdice")}>${t("Trefferwürfel")}</div>
            </div>
          </div>
          ${pcHpHtml(d, live)}
          <div class="cs-panel">
            <div class="cs-panel-title cs-info-link" ${infoAttr("term:attack")}>${t("Angriffe &amp; Zauberwirken")}</div>
            ${attacks}
          </div>
          <div class="cs-panel">
            <div class="cs-panel-title">${t("Ausrüstung")}</div>
            ${armorControls}
            ${live || (d.play.ammo || []).length
              ? `<div class="pc-armor pc-ammo">
                  <span class="pc-armor-label cs-info-link" ${infoAttr("term:ammo")}>${t("Munition")}</span>
                  ${ammoHtml(d, live)}
                </div>`
              : ""}
            <div class="pc-coins">${coins}</div>
            ${area("equipment", t("Waffen, Rüstung, Abenteurerausrüstung …"), 5)}
          </div>
          <div class="cs-panel pc-inventory">
            <div class="cs-panel-title">${t("Inventar")} ${attunementHtml(d)}<span class="pc-legend">☑ ${t("ausgerüstet")} · ${t("Name antippen für Details")}</span></div>
            ${inventoryHtml(d, live)}
          </div>
        </div>

        <div class="pc-col pc-col-c">
          <div class="cs-panel">
            <div class="cs-panel-title">${t("Persönlichkeitsmerkmale")}</div>
            ${area("personality", t("Wie verhält sich der Charakter?"), 2)}
            <div class="cs-panel-title pc-sub">${t("Ideale")}</div>
            ${area("ideals", t("Woran glaubt er?"), 2)}
            <div class="cs-panel-title pc-sub">${t("Bindungen")}</div>
            ${area("bonds", t("Wem oder was fühlt er sich verbunden?"), 2)}
            <div class="cs-panel-title pc-sub">${t("Makel")}</div>
            ${area("flaws", t("Schwächen, Laster, Ängste"), 2)}
          </div>
          <div class="cs-panel">
            <div class="cs-panel-title">${t("Klassenmerkmale")} <span class="pc-legend">${t("automatisch")}</span></div>
            <div class="pc-slots pc-trackers" data-derived="trackers">${pcTrackersHtml(d, x, live)}</div>
            <div data-derived="resources">${pcResourcesHtml(x)}</div>
          </div>
          <div class="cs-panel">
            <div class="cs-panel-title">${t("Merkmale &amp; Fähigkeiten")}</div>
            <div class="cs-panel-title pc-sub">${t("Talente")}</div>
            ${editable ? `<input type="hidden" data-feat-list value="${esc(JSON.stringify(d.feats))}" />` : ""}
            <div data-derived="feat-list">${featListHtml(d, editable)}</div>
            ${editable ? featPickerHtml() : ""}
            <div data-derived="lib-features">${libFeaturesHtml(d, x)}</div>
            ${area("features", t("Volksmerkmale, Hintergrundmerkmal, Talente, Unterklassen-Fähigkeiten …"), 5)}
          </div>
        </div>
      </div>

      <div class="cs-panel pc-spells ${x.spell || d.spell_list.length ? "" : "hidden"}" data-derived-show="spell">
        <div class="cs-panel-title">${t("Zauberwirken")}</div>
        <div class="pc-hint" data-derived="spell-rules">${escapeHtml(SPELLCASTING_RULES[d.class_key] || "")}</div>
        <div class="cs-combat" data-derived="spell-head">${pcSpellHeadHtml(x, d)}</div>
        <div class="pc-slots" data-derived="slots">${pcSlotsHtml(x, d.play, live)}</div>
        <div class="cs-panel-title pc-sub">${t("Zaubertricks &amp; Zauber")} <span class="pc-legend">${t("K Konzentration · R Ritual")}${isSpellbook(d) ? ` · ★ ${t("vorbereitet")}` : ""}${d.spell_list.some((s) => s.extra) ? ` · ${t("U aus der Unterklasse")}` : ""} · ${t("Name antippen für Details")}</span></div>
        ${editable ? `<input type="hidden" data-spell-list value="${esc(JSON.stringify(d.spell_list))}" />` : ""}
        <div data-derived="spell-list">${pcSpellListHtml(d, editable, live)}</div>
        ${editable ? `<div data-spell-picker>${pcSpellPickerHtml(d, x)}</div>` : ""}
        <div class="cs-panel-title pc-sub">${t("Notizen zu Zaubern")}</div>
        ${area("spells", t("z.B. Domänenzauber, Zauber aus Gegenständen …"), 2)}
      </div>

      <div class="cs-notes">
        ${editable ? `<input class="cs-notes-val" data-field="notes" value="${esc(d.notes)}" placeholder="${t("Hintergrundgeschichte, Verbündete, Sonstiges …")}" />` : `<div class="cs-notes-val">${show(d.notes)}</div>`}
        <div class="cs-small-label">${t("Notizen")}</div>
      </div>
    </div>`;
}

// Reads the full sheet back into the API body; derived values (passive perception) are stored too.
// Placeholder portrait while a character has no picture of its own: the picture of its class, from
// /shared/class-portraits (made by tools/creation-icons.py, in both tools). Takes the sheet's class
// (class_key/class_ref, as pcData gives them) or just the class name.
const CLASS_PORTRAITS = new Set(["barbarian", "bard", "cleric", "druid", "fighter", "monk", "paladin", "ranger",
  "rogue", "sorcerer", "warlock", "wizard", "marshal", "mechanist"]);
function classPortraitUrl(classKey, classRef, className) {
  const en = CLASSES[classKey] ? CLASSES[classKey].en
    : classRef ? String(classRef.name_en || classRef.name || "").toLowerCase()
    : (CLASSES[guessClassKey(className)] || {}).en || String(className || "").trim().toLowerCase();
  return CLASS_PORTRAITS.has(en) ? `/shared/class-portraits/${en}.svg` : null;
}
// The same for a whole character (row with stat_block), as the pages hold it.
const characterPortraitFallback = (ch) => {
  const sb = (ch && ch.stat_block) || {};
  return classPortraitUrl(sb.class_key ?? guessClassKey(sb.char_class), sb.class_ref, sb.char_class ?? ch?.char_class);
};

// The portrait at the top left of the sheet. Editable: an empty slot is itself the button to add
// one, a picture gets small buttons to replace or remove it. The page handles [data-portrait-input]
// (change) and [data-portrait-remove] (click), and swaps just this element in afterwards
// (.pc-portrait-wrap), so whatever else is being edited stays as it is. fallback: a stand-in picture
// for a missing portrait; it can be replaced by uploading, but not removed.
function pcPortraitSlotHtml(portrait, editable, fallback) {
  if (!editable && !portrait && !fallback) return "";
  const esc = (v) => escapeHtml(String(v ?? ""));
  const file = '<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" data-portrait-input hidden />';
  if (!portrait && fallback) {
    return `<div class="pc-portrait-wrap">
      <img class="pc-portrait pc-portrait-fallback" src="${esc(fallback)}" alt="" title="${t("Platzhalter, bis ein eigenes Portrait hochgeladen ist")}" />
      ${editable ? `<label class="pc-portrait-upload" title="${t("Eigenes Portrait hochladen")}">📷${file}</label>` : ""}
    </div>`;
  }
  if (!portrait) {
    return `<div class="pc-portrait-wrap">
      <label class="pc-portrait pc-portrait-empty pc-portrait-add" title="${t("Portrait hochladen")}"><span class="pc-portrait-icon">📷</span><span>${t("Portrait hinzufügen")}</span>${file}</label>
    </div>`;
  }
  return `<div class="pc-portrait-wrap">
    <img class="pc-portrait" src="${esc(portrait)}" alt="" />
    ${editable ? `
      <label class="pc-portrait-upload" title="${t("Anderes Bild wählen")}">📷${file}</label>
      <button type="button" class="ghost pc-portrait-remove" data-portrait-remove title="${t("Bild entfernen")}">✕</button>` : ""}
  </div>`;
}

function readPcSheet(container) {
  const q = (sel) => container.querySelector(sel);
  const text = (key) => (q(`[data-field="${key}"]`)?.value ?? "").trim();
  const int = (key) => {
    const v = parseInt(text(key), 10);
    return isNaN(v) ? null : v;
  };
  const checked = (attr) => [...container.querySelectorAll(`[${attr}]`)].filter((c) => c.checked).map((c) => c.getAttribute(attr));

  const abilities = {};
  for (const el of container.querySelectorAll("[data-ability]")) {
    const v = parseInt(el.value, 10);
    abilities[el.dataset.ability] = isNaN(v) ? null : Math.min(ABILITY_MAX, Math.max(1, v));
  }
  const attacks = [];
  for (const el of container.querySelectorAll("[data-attack]")) {
    const i = Number(el.dataset.attack);
    attacks[i] = attacks[i] || {};
    attacks[i][el.dataset.attackKey] = el.value.trim();
  }
  const coins = {};
  for (const el of container.querySelectorAll("[data-coin]")) {
    const v = parseInt(el.value, 10);
    if (!isNaN(v)) coins[el.dataset.coin] = v;
  }
  const classKey = text("class_key");
  const classRef = classKey.startsWith("lib:") ? JSON.parse(q('[data-field="class_key"]').selectedOptions[0].dataset.ref || "null") : null;
  const [raceRef, race] = readOptionSelect(container, "race");
  const [backgroundRef, background] = readOptionSelect(container, "background");
  const [subclassRef, subclass] = readOptionSelect(container, "subclass");
  const abilityChoice = {};
  for (const el of container.querySelectorAll("[data-asi-choice]")) if (Number(el.value)) abilityChoice[el.dataset.asiChoice] = Number(el.value);
  // The inputs hold the base values; stored are those and the final scores, which everything else reads.
  const feats = JSON.parse(q("[data-feat-list]")?.value || "[]");
  const bonus = abilityBonus({ race_ref: raceRef, background_ref: backgroundRef, ability_choice: abilityChoice, feats });
  const totals = Object.fromEntries(Object.entries(abilities).map(([k, v]) => [k, v === null ? null : abilityTotal(v, bonus[k])]));
  const sb = {
    abilities: totals,
    ability_base: abilities,
    ability_choice: abilityChoice,
    class_key: classKey || null,
    class_ref: classRef,
    char_class: classInfo(classKey, classRef) ? classInfo(classKey, classRef).label : null,
    subclass,
    subclass_ref: subclassRef,
    level: Math.min(20, Math.max(1, int("level") ?? 1)),
    background,
    background_ref: backgroundRef,
    feats,
    race,
    race_ref: raceRef,
    alignment: text("alignment") || null,
    xp: int("xp"),
    inspiration: !!q('[data-field-check="inspiration"]')?.checked,
    save_prof: checked("data-save"),
    skill_prof: checked("data-skill"),
    skill_expertise: checked("data-expert"),
    speed_adjust: int("speed_adjust") ?? 0,
    initiative_adjust: int("initiative_adjust") ?? 0,
    languages: text("languages") || null,
    proficiencies: text("proficiencies") || null,
    attacks: attacks.filter((a) => a && (a.name || a.bonus || a.damage)),
    equipment: text("equipment") || null,
    coins,
    personality: text("personality") || null,
    ideals: text("ideals") || null,
    bonds: text("bonds") || null,
    flaws: text("flaws") || null,
    features: text("features") || null,
    spells: text("spells") || null,
    // What the inventory has equipped, carried over unchanged (the editor doesn't equip anything).
    equipped: JSON.parse(q("[data-equipped]")?.value || "null") || undefined,
    mage_armor: !!q('[data-field-check="mage_armor"]')?.checked,
    ac_adjust: int("ac_adjust") ?? 0,
    spell_list: JSON.parse(q("[data-spell-list]")?.value || "[]"),
  };
  const d = pcData({ stat_block: sb });
  const x = pcDerived(d);
  sb.passive_perception = x.passive;
  const acr = pcArmorClass(d, x.m);
  // Stored too, for anything that reads the speed without calculating it.
  const sp = pcSpeed(d, x, acr);
  sb.speed = ftToM(sp.ft);
  sb.speed_ft = sp.ft;
  return {
    name: text("name"),
    max_hp: int("max_hp"),
    ac: acr.ac,
    // The column other apps (combattracker) add straight to a d20 roll: always DEX + adjustment.
    initiative_bonus: x.m.dex + sb.initiative_adjust,
    notes: text("notes"),
    stat_block: sb,
  };
}

// Recomputes every derived number while the sheet is being filled in.
function refreshPcDerived(container) {
  const body = readPcSheet(container);
  const d = pcData({ ...body, stat_block: body.stat_block });
  const x = pcDerived(d);
  const set = (name, html) => container.querySelectorAll(`[data-derived="${name}"]`).forEach((el) => (el.innerHTML = html));
  set("prof", signed(x.prof));
  for (const [k] of ABILITIES) set(`save-${k}`, signed(x.saves[k]));
  for (const [k] of SKILLS) set(`skill-${k}`, signed(x.skills[k]));
  set("passive", String(x.passive));
  set("hit-dice", x.hitDice || "–");
  set("hp-suggest", x.hpSuggest ?? "–");
  set("skill-hint", escapeHtml(x.skillHint || ""));
  set("resources", pcResourcesHtml(x));
  set("trackers", pcTrackersHtml(d, x, false));
  set("spell-head", pcSpellHeadHtml(x, d));
  set("slots", pcSlotsHtml(x));
  set("spell-rules", escapeHtml(SPELLCASTING_RULES[d.class_key] || ""));
  set("spell-list", pcSpellListHtml(d, true));
  set("weapon-attacks", weaponRowsHtml(d, x));
  for (const [k] of ABILITIES) {
    const mod = container.querySelector(`[data-mod="${k}"]`);
    if (mod) mod.textContent = abilityMod(d.abilities[k]);
    set(`abil-${k}`, abilityBonusHtml(d.ability_base[k], d.ability_bonus[k]));
  }
  // New people, background or feat: new bonuses and free points; the distribution keeps what still fits.
  const asi = container.querySelector("[data-asi-panel]");
  if (asi && asi.dataset.key !== asiKey(d)) {
    asi.dataset.key = asiKey(d);
    d.ability_choice = fitAbilityChoice(d.ability_choice, asiChoices(d));
    d.legacy_abilities = asi.hasAttribute("data-legacy");
    asi.innerHTML = asiPanelHtml(d);
    asi.hidden = !asi.innerHTML;
    refreshPcDerived(container);
    return;
  }
  set("asi-status", asiStatusHtml(d));
  set("skill-count", skillCountHtml(d, x));
  set("lang-count", languageCountHtml(d));
  const langs = container.querySelector('[data-field="languages"]');
  if (langs) langs.placeholder = languagePlaceholder(d);
  set("lib-features", libFeaturesHtml(d, x));
  set("feat-list", featListHtml(d, true));
  // Rebuilt only when its choices change, so a picked but not yet added spell stays selected.
  const picker = container.querySelector("[data-spell-picker]");
  const pickerKey = `${d.class_key}|${x.maxSpellLevel}|${d.spell_list.map((s) => s.id).join(",")}|${spellLibrary().length}`;
  if (picker && picker.dataset.key !== pickerKey) {
    picker.dataset.key = pickerKey;
    picker.innerHTML = pcSpellPickerHtml(d, x);
  }
  set("ac", String(body.ac));
  set("initiative", signed(body.initiative_bonus));
  const sp = pcSpeed(d, x, pcArmorClass(d, x.m));
  set("speed", ftToM(sp.ft));
  set("speed-sub", speedSubHtml(sp));
  const speedLabel = container.querySelector('[data-info="speed"]');
  if (speedLabel) speedLabel.dataset.speed = JSON.stringify(sp);
  set("ac-info", pcArmorInfoHtml(pcArmorClass(pcData({ stat_block: body.stat_block }), x.m)));
  container.querySelector('[data-derived-show="spell"]').classList.toggle("hidden", !x.spell && !d.spell_list.length);
}

// The sheet as it is being edited, as pcData (for helpers that need the current choices).
function readPcData(container) {
  const body = readPcSheet(container);
  return pcData({ ...body, stat_block: body.stat_block });
}

function bindPcSheet(container) {
  // The "prepared" box sits in the spell list, which a refresh rebuilds: its change event has to come
  // first (below), or it would land on a box that is no longer in the sheet.
  container.addEventListener("input", (e) => {
    if (e.target.dataset.spellPrep === undefined) refreshPcDerived(container);
  });
  // Spells are kept as JSON in a hidden input while editing; readPcSheet picks them up.
  const listOf = (attr) => JSON.parse(container.querySelector(`[${attr}]`).value || "[]");
  const setList = (attr, list) => (container.querySelector(`[${attr}]`).value = JSON.stringify(list));
  container.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    if (btn.dataset.step) {
      const adj = container.querySelector('[data-field="ac_adjust"]');
      adj.value = (parseInt(adj.value, 10) || 0) + Number(btn.dataset.step);
    } else if (btn.dataset.speedStep) {
      const adj = container.querySelector('[data-field="speed_adjust"]');
      adj.value = (parseInt(adj.value, 10) || 0) + Number(btn.dataset.speedStep);
    } else if (btn.dataset.initStep) {
      const adj = container.querySelector('[data-field="initiative_adjust"]');
      adj.value = (parseInt(adj.value, 10) || 0) + Number(btn.dataset.initStep);
    } else if (btn.hasAttribute("data-spell-add")) {
      const sp = spellLibrary().find((s) => String(s.id) === container.querySelector("[data-spell-pick]").value);
      if (!sp) return;
      setList("data-spell-list", [...listOf("data-spell-list"), { id: sp.id, name: sp.name, level: sp.level_int, prepared: false }]);
    } else if (btn.hasAttribute("data-feat-add")) {
      const o = optionById(Number(container.querySelector("[data-feat-pick]").value));
      if (!o) return;
      const source = container.querySelector("[data-feat-source]").value.trim() || null;
      setList("data-feat-list", [...listOf("data-feat-list"), { ...optionRef(o), source }]);
      container.querySelector("[data-feat-pick]").value = "";
      container.querySelector("[data-feat-source]").value = "";
    } else if (btn.hasAttribute("data-feat-bg")) {
      const hit = backgroundFeat(readPcData(container));
      if (!hit) return;
      setList("data-feat-list", [...listOf("data-feat-list"), { ...optionRef(hit.option), source: "Hintergrund", detail: hit.detail }]);
    } else if (btn.dataset.featRemove !== undefined) {
      setList("data-feat-list", listOf("data-feat-list").filter((_, i) => i !== Number(btn.dataset.featRemove)));
    } else if (btn.dataset.spellRemove !== undefined) {
      setList("data-spell-list", listOf("data-spell-list").filter((_, i) => i !== Number(btn.dataset.spellRemove)));
    } else {
      return;
    }
    refreshPcDerived(container);
  });
  container.addEventListener("change", (e) => {
    if (e.target.matches("[data-ability]") && parseInt(e.target.value, 10) > ABILITY_MAX) e.target.value = ABILITY_MAX;
    if (e.target.dataset.spellPrep !== undefined) {
      const list = listOf("data-spell-list");
      list[Number(e.target.dataset.spellPrep)].prepared = e.target.checked;
      setList("data-spell-list", list);
    }
    // A hand-typed AC from before the calculation is replaced once armor or shield is chosen.
    const legacy = container.querySelector("[data-field=\"ac_adjust\"][data-legacy]");
    if (legacy && e.target.matches('[data-field-check="mage_armor"]')) {
      legacy.value = 0;
      legacy.removeAttribute("data-legacy");
      container.querySelector("[data-legacy-hint]")?.remove();
    }
    // Picking a class sets its saving throws and fills in its proficiencies if still empty.
    if (e.target.matches('[data-field="class_key"]')) {
      const cls = classInfo(e.target.value, JSON.parse(e.target.selectedOptions[0].dataset.ref || "null"));
      if (cls) {
        container.querySelectorAll("[data-save]").forEach((c) => (c.checked = cls.saves.includes(c.dataset.save)));
        const profs = container.querySelector('[data-field="proficiencies"]');
        if (profs && !profs.value.trim()) profs.value = cls.profs;
      }
      // Only the subclasses of the new class; the chosen one stays if it belongs to it.
      const sub = container.querySelector('[data-option="subclass"]');
      const [ref] = readOptionSelect(container, "subclass");
      const list = subclassesFor(cls);
      sub.innerHTML = optionSelectOptions(list, ref && list.some((o) => o.id === ref.id) ? ref : null, null, t("-- Unterklasse --"));
    }
    if (e.target.matches('[data-option="race"], [data-option="background"]')) {
      const [ref] = readOptionSelect(container, e.target.dataset.option);
      // Older sheets hold final scores: a newly chosen people or background only splits them into
      // base value and bonus, so the scores stay what the player had entered.
      if (container.querySelector("[data-asi-panel][data-legacy]")) {
        const before = abilityFixed(JSON.parse(e.target.dataset.prevRef || "null"));
        const after = abilityFixed(ref);
        for (const input of container.querySelectorAll("[data-ability]")) {
          const v = parseInt(input.value, 10);
          if (!isNaN(v)) input.value = v - (after[input.dataset.ability] - before[input.dataset.ability]);
        }
      }
      e.target.dataset.prevRef = JSON.stringify(ref);
      // A background's skills are ticked (never unticked: they may come from the class as well).
      if (e.target.dataset.option === "background" && ref) {
        for (const k of ref.skills || []) {
          const box = container.querySelector(`[data-skill="${k}"]`);
          if (box) box.checked = true;
        }
      }
    }
    refreshPcDerived(container);
  });
}

// ---------- explanations (click on anything marked as a link) ----------

function showSheetPopup(title, html) {
  let dlg = document.getElementById("cs-popup");
  if (!dlg) {
    dlg = document.createElement("dialog");
    dlg.id = "cs-popup";
    dlg.className = "cs-popup";
    // A click on the backdrop (the dialog itself, outside its body) closes it.
    dlg.addEventListener("click", (e) => {
      if (e.target === dlg || e.target.closest(".cs-popup-close")) dlg.close();
    });
    document.body.appendChild(dlg);
  }
  dlg.innerHTML = `
    <div class="cs-popup-body">
      <button type="button" class="cs-popup-close" aria-label="Schliessen">✕</button>
      ${title ? `<h3>${escapeHtml(title)}</h3>` : ""}
      ${html}
    </div>`;
  dlg.showModal();
}

const para = (text, cls = "") => (text ? `<p${cls ? ` class="${cls}"` : ""}>${escapeHtml(text)}</p>` : "");

function weaponInfoHtml(a) {
  const parts = [`${ABILITY_SHORT[a.ab]} ${signed(a.abMod)}`];
  if (a.profBonus) parts.push(`${t("Übung")} ${signed(a.profBonus)}`);
  if (a.bonus) parts.push(`${t("Magie")} ${signed(a.bonus)}`);
  const props = a.props
    .map((p) => {
      const [label, text] = WEAPON_PROPERTIES[p.key] || [p.key, ""];
      // "range 150/600" (feet) and "1d10" in German notation
      const arg = diceDe(p.arg).replace(/^range\s*(.+)$/i, (m, r) => t("Reichweite {range} ft", { range: r }));
      return `<li><b>${escapeHtml(label)}${arg ? ` (${escapeHtml(arg)})` : ""}:</b> ${escapeHtml(text)}</li>`;
    })
    .join("");
  const it = state.items.find((i) => String(i.id) === String(a.item_id));
  return `
    <p><b>${t("Angriff:")}</b> ${signed(a.toHit)} (${parts.join(", ")})<br><b>${t("Schaden:")}</b> ${escapeHtml(a.damage)}</p>
    ${a.prof ? "" : para(t("Nicht geübt: Der Übungsbonus zählt nicht. Geübt ist, was Klasse oder „Weitere Übungen“ nennen (einfache Waffen, Kriegswaffen oder die Waffe selbst)."), "pc-warn")}
    ${a.base && weaponNameDe(a.base) !== a.base ? para(t("Waffe: {name}", { name: weaponNameDe(a.base) })) : ""}
    ${props ? `<ul class="pc-info-list">${props}</ul>` : ""}
    ${it ? itemSheetHtml(it) : ""}`;
}

// [title, html] for an element with data-info="kind:key".
function sheetInfoContent(el) {
  const [kind, ...rest] = el.dataset.info.split(":");
  const key = rest.join(":");
  const ability = ABILITIES.find(([k]) => k === key);
  if (kind === "ability" && ability) {
    return [`${ability[2]} (${ability[1]})`, para(ABILITY_INFO[key]) + para(t("Modifikator = (Wert − 10) / 2, abgerundet. Er kommt zu allen Würfen mit diesem Attribut dazu."), "pc-hint")];
  }
  if (kind === "save" && ability) {
    return [t("Rettungswurf {ability}", { ability: ability[2] }), para(TERM_INFO.saves[1]) + para(ABILITY_INFO[key], "pc-hint")];
  }
  if (kind === "skill") {
    const skill = SKILLS.find(([k]) => k === key);
    if (skill) return [`${skill[1]} (${ABILITY_SHORT[skill[2]]})`, para(SKILL_INFO[key]) + para(TERM_INFO.skills[1], "pc-hint")];
  }
  if (kind === "term" && TERM_INFO[key]) return [TERM_INFO[key][0], para(TERM_INFO[key][1])];
  if (kind === "feat" && FEAT_INFO[key]) {
    return [FEAT_INFO[key][0], para(FEAT_INFO[key][1]) + para(t("Herkunftstalent: Der Hintergrund gibt es auf Stufe 1."), "pc-hint")];
  }
  if (kind === "tool") {
    const tool = TOOL_INFO[key];
    return [tool ? tool[0] : t("Werkzeug-Übung"), (tool ? para(tool[1]) : "") + para(TOOL_RULE, tool ? "pc-hint" : "")];
  }
  if (kind === "feature" && FEATURE_INFO[key]) {
    // The sheet line holds the value for this character ("3× pro langer Rast, +2 Schaden").
    const value = el.parentElement.textContent.replace(el.textContent, "").trim();
    return [t(key), para(FEATURE_INFO[key]) + (value ? `<p class="pc-hint"><b>${t("Bei diesem Charakter:")}</b> ${escapeHtml(value)}</p>` : "")];
  }
  if (kind === "spell") {
    const [id, ...name] = key.split(":");
    const sp = findSpell({ id, name: name.join(":") });
    return sp ? [null, spellSheetHtml(sp)] : [name.join(":"), para(t("Dieser Zauber ist nicht (mehr) in der Zauberliste des Trackers."))];
  }
  if (kind === "item") {
    const it = state.items.find((i) => String(i.id) === key);
    return it ? [null, itemSheetHtml(it)] : null;
  }
  if (kind === "speed" && el.dataset.speed) {
    const sp = JSON.parse(el.dataset.speed);
    const squares = Math.floor(sp.ft / 5);
    return [
      t("Bewegungsrate"),
      `<p><b>${ftToM(sp.ft)}</b> = ${sp.ft} ft = ${t("{squares} auf der Battlemap", { squares: tn(squares, "{n} Feld", "{n} Felder") })}</p>
      <ul class="pc-info-list">${sp.parts.map((p) => `<li>${escapeHtml(p)}</li>`).join("")}</ul>
      ${sp.extra.length ? para(t("Weitere Bewegungsarten: {list}", { list: sp.extra.join(", ") })) : ""}
      ${sp.notes.map((n) => para(n, "pc-warn")).join("")}
      ${para(TERM_INFO.speed[1])}
      ${para(t("Umrechnung: 5 ft = 1,5 m = 1 Feld. Der Grundwert kommt vom Volk; nicht erkannte Völker zählen 30 ft und lassen sich mit der Anpassung korrigieren."), "pc-hint")}`,
    ];
  }
  if (kind === "weapon" && el.dataset.weapon) {
    const a = JSON.parse(el.dataset.weapon);
    return [a.name, weaponInfoHtml(a)];
  }
  return null;
}

document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-info]");
  // On the sheet, and inside an explanation (a feat named in a background's popup).
  if (!el || !el.closest(".pc-sheet, #cs-popup")) return;
  if (el.dataset.info.startsWith("opt:")) return openOptionInfo(el.dataset.info);
  const content = sheetInfoContent(el);
  if (content) showSheetPopup(...content);
});

// ---------- play controls (player sheets) ----------

// HP, spell slots, ammunition and rests on a sheet rendered with opts.live. Each action goes to the
// server; the page renders the sheet again with the answer. actions = { hp(body), playState(state), rest(kind) }.
function bindPcLive(root, entity, actions) {
  const d = pcData(entity);
  const play = () => JSON.parse(JSON.stringify(d.play || {}));
  const amount = root.querySelector(".pc-hp-amount");
  const apply = (kind) => {
    const v = parseInt(amount.value, 10);
    if (v > 0) actions.hp({ [kind]: v });
  };
  root.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    const ds = b.dataset;
    if (ds.hpStep) {
      const n = Number(ds.hpStep);
      actions.hp(n < 0 ? { damage: -n } : { heal: n });
    } else if (ds.hpApply) {
      apply(ds.hpApply);
    } else if (ds.tempStep) {
      actions.hp({ temp_hp: Math.max(0, d.temp_hp + Number(ds.tempStep)) });
    } else if (ds.pip !== undefined) {
      // Clicking a used slot frees it and all after it; clicking a free one uses it and all before it.
      const i = Number(ds.pip);
      const st = play();
      if (b.hasAttribute("data-hd")) {
        st.hd_used = i < (st.hd_used || 0) ? i : i + 1;
      } else if (ds.res) {
        st.res_used = { ...(st.res_used || {}) };
        st.res_used[ds.res] = i < (st.res_used[ds.res] || 0) ? i : i + 1;
      } else if (b.hasAttribute("data-pact")) {
        st.pact_used = i < (st.pact_used || 0) ? i : i + 1;
      } else {
        st.slots_used = { ...(st.slots_used || {}) };
        st.slots_used[ds.slotLevel] = i < (st.slots_used[ds.slotLevel] || 0) ? i : i + 1;
      }
      actions.playState(st);
    } else if (ds.ammoStep) {
      const st = play();
      const a = st.ammo[Number(ds.ammo)];
      a.count = Math.max(0, a.count + Number(ds.ammoStep));
      actions.playState(st);
    } else if (ds.ammoRemove !== undefined) {
      const st = play();
      const i = Number(ds.ammoRemove);
      if (!confirm(t("{name} entfernen?", { name: st.ammo[i].name }))) return;
      st.ammo.splice(i, 1);
      actions.playState(st);
    } else if (b.hasAttribute("data-ammo-add")) {
      const name = root.querySelector("[data-ammo-pick]").value;
      if (!name) return;
      const count = Math.max(0, parseInt(root.querySelector("[data-ammo-start]").value, 10) || 0);
      const st = play();
      st.ammo = [...(st.ammo || []), { name, count }];
      actions.playState(st);
    } else if (b.hasAttribute("data-hd-roll")) {
      // Short rest healing: roll the class hit die + CON, mark the die as spent, heal the result.
      const x = pcDerived(d);
      const roll = 1 + Math.floor(Math.random() * x.cls.hitDie);
      const heal = Math.max(0, roll + x.m.con);
      const st = play();
      st.hd_used = (st.hd_used || 0) + 1;
      Promise.resolve(actions.playState(st)).then(() => actions.hp({ heal })).then(() =>
        showSheetPopup(t("Trefferwürfel ausgegeben"), `<p>${t("W{die}: <b>{roll}</b> {sign} {con} (KON) = <b>{heal} TP</b> geheilt.", { die: x.cls.hitDie, roll, sign: x.m.con >= 0 ? "+" : "−", con: Math.abs(x.m.con), heal })}</p>`)
      );
    } else if (ds.spellPrepLive !== undefined) {
      // The wizard prepares spells from the spellbook after a long rest.
      const list = d.spell_list.map((s) => ({ ...s }));
      const s = list[Number(ds.spellPrepLive)];
      s.prepared = !s.prepared;
      actions.playState(play(), { sheet: { spell_list: list } });
    } else if (ds.invStep) {
      // The rows are those of equipInventory (old equipment included), so the indexes match it.
      const st = play();
      st.inventory = equipInventory(d);
      const e = st.inventory[Number(ds.inv)];
      e.qty = Math.max(0, e.qty + Number(ds.invStep));
      actions.playState(st);
    } else if (ds.invRemove !== undefined) {
      const inv = equipInventory(d);
      const i = Number(ds.invRemove);
      if (!confirm(t("{name} aus dem Inventar entfernen?", { name: inv[i].name }))) return;
      const [removed] = inv.splice(i, 1);
      if (removed.equipped) saveEquipment(inv);
      else actions.playState({ ...play(), inventory: inv });
    } else if (b.hasAttribute("data-inv-add")) {
      const name = root.querySelector("[data-inv-name]").value.trim();
      if (!name) return;
      const qty = Math.max(1, parseInt(root.querySelector("[data-inv-qty]").value, 10) || 1);
      const it = state.items.find((i) => i.name.toLowerCase() === name.toLowerCase());
      const st = play();
      st.inventory = equipInventory(d);
      // The same item again only raises the count.
      const same = st.inventory.find((e) => (it ? String(e.item_id) === String(it.id) : !e.item_id && e.name.toLowerCase() === name.toLowerCase()));
      if (same) same.qty += qty;
      else st.inventory.push({ name: it ? it.name : name, qty, item_id: it ? it.id : null });
      actions.playState(st);
    } else if (ds.rest) {
      const text =
        ds.rest === "long"
          ? t("Lange Rast: Alle Trefferpunkte und Zauberplätze kommen zurück, dazu die Hälfte der Trefferwürfel (mindestens einer). Temporäre Trefferpunkte verfallen.")
          : t("Kurze Rast: Paktmagie-Plätze und Ki-Punkte kommen zurück. Trefferwürfel selbst würfeln und als Heilung eintragen.");
      if (confirm(`${text}\n\n${t("Jetzt rasten?")}`)) actions.rest(ds.rest);
    }
  });
  // Equipping changes the sheet as well: the equipped copy (what the tracker sees) and the AC.
  const saveEquipment = (inv) => {
    const st = play();
    st.inventory = inv;
    const nd = pcData({ ...entity, play_state: st });
    // A hand-typed AC from before the calculation keeps its difference as adjustment.
    const adjust = d.ac_adjust === null ? (entity.ac ?? 0) - pcArmorClass({ ...d, ac_adjust: 0 }, pcDerived(d).m).ac : d.ac_adjust;
    const ac = pcArmorClass({ ...nd, ac_adjust: adjust }, pcDerived(nd).m).ac;
    actions.playState(st, { sheet: { equipped: nd.equip, ac_adjust: adjust }, ac });
  };
  root.addEventListener("change", (e) => {
    const el = e.target;
    if (el.dataset.invEquip === undefined && el.dataset.invTwoHand === undefined) return;
    const inv = equipInventory(d);
    const i = Number(el.dataset.invEquip ?? el.dataset.invTwoHand);
    const entry = inv[i];
    const info = equipInfo(entry);
    if (!info) return;
    if (el.dataset.invEquip !== undefined) {
      entry.equipped = el.checked;
      if (el.checked) {
        // A new armor or shield replaces the one worn so far.
        if (info.kind === "armor" || info.kind === "shield") {
          inv.forEach((o, j) => {
            if (j !== i && o.equipped && (equipInfo(o) || {}).kind === info.kind) o.equipped = false;
          });
        }
        // Kept with the entry, so it still works if the item leaves the library.
        if (info.armor) entry.armor = info.armor;
        if (info.weapon) entry.weapon = info.weapon;
      } else entry.two_handed = false;
    } else entry.two_handed = el.checked;
    const problem = equipProblem(inv);
    if (problem) {
      el.checked = !el.checked;
      showSheetPopup(t("Geht nicht"), para(problem));
      return;
    }
    saveEquipment(inv);
  });
  amount?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") apply(e.shiftKey ? "heal" : "damage");
  });
  root.querySelector("[data-inv-name]")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") root.querySelector("[data-inv-add]").click();
  });
  root.querySelector(".pc-temp-input")?.addEventListener("change", (e) => {
    const v = parseInt(e.target.value, 10);
    actions.hp({ temp_hp: isNaN(v) ? 0 : Math.max(0, v) });
  });
}

// ---------- item and spell sheets (popups on the character sheet, item/spell tabs in the DM view) ----------

// One icon per school of magic, matched by name so Open5e's English and German entries both work.
const SPELL_SCHOOL_ICONS = [
  [["abjuration", "bann"], "🛡️", t("Bannmagie: schützt und wehrt ab")],
  [["conjuration", "beschwör"], "🌀", t("Beschwörung: ruft Wesen und Dinge herbei")],
  [["divination", "erkennt", "wahrsag"], "🔮", t("Erkenntnismagie: enthüllt Wissen")],
  [["enchantment", "verzauber"], "💫", t("Verzauberung: beeinflusst den Geist")],
  [["evocation", "hervorruf", "evokation"], "🔥", t("Hervorrufung: entfesselt Energie")],
  [["illusion"], "🎭", t("Illusion: täuscht die Sinne")],
  [["necromancy", "nekroman"], "💀", t("Nekromantie: Leben und Tod")],
  [["transmutation", "verwandl"], "⚗️", t("Verwandlung: verändert die Natur der Dinge")],
];

function spellSchoolIcon(school) {
  const s = (school || "").toLowerCase();
  const hit = SPELL_SCHOOL_ICONS.find(([keys]) => keys.some((k) => s.includes(k)));
  return hit ? { icon: hit[1], title: hit[2] } : { icon: "✨", title: t("Unbekannte Schule") };
}

// Open5e descriptions use a little Markdown: **bold**, _italic_, blank-line paragraphs and pipe tables.
function mdLiteHtml(text) {
  const inline = (s) =>
    escapeHtml(s)
      .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
      .replace(/(^|[\s(])[_*](\S(?:.*?\S)?)[_*](?=[\s).,;:!?]|$)/g, "$1<i>$2</i>");
  const blocks = String(text || "").trim().split(/\n\s*\n/);
  return blocks
    .map((block) => {
      const lines = block.split("\n").map((l) => l.trim());
      if (lines.length >= 2 && lines.every((l) => l.startsWith("|"))) {
        const cells = (l) => l.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
        const rows = lines.filter((l) => !/^\|[\s|:-]+\|$/.test(l)).map(cells);
        const [head, ...body] = rows;
        return `<table class="cs-table"><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr>${body
          .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`)
          .join("")}</table>`;
      }
      return `<p>${lines.map(inline).join("<br>")}</p>`;
    })
    .join("");
}

// Read-only sheet pieces shared by the item and spell stats, in the look of the character sheet.
function sheetInfo(value, label) {
  return `
    <div class="cs-info">
      <div class="cs-info-val">${value ? escapeHtml(String(value)) : "–"}</div>
      <div class="cs-small-label">${label}</div>
    </div>`;
}

function sheetBox(value, label) {
  const text = value === null || value === undefined || value === "" ? "–" : String(value);
  return `
    <div class="cs-box">
      <div class="cs-box-val ${text.length > 10 ? "long" : ""}">${escapeHtml(text)}</div>
      <div class="cs-small-label">${label}</div>
    </div>`;
}

function sheetPanel(title, html) {
  return html ? `<div class="cs-panel"><div class="cs-panel-title">${title}</div><div class="cs-text">${html}</div></div>` : "";
}

function sheetHeader(name, kindLabel, infos) {
  return `
    <div class="cs-header">
      <div class="cs-name">
        <div class="cs-name-val">${escapeHtml(name)}</div>
        <div class="cs-small-label">${kindLabel}</div>
      </div>
      <div class="cs-header-info">${infos}</div>
    </div>`;
}

const sourceLabel = (s) => (s === "import" ? "Open5e" : t("Eigene"));

function itemSheetHtml(it) {
  const sb = it.stat_block || {};
  const a = sb.armor;
  const w = sb.weapon;
  const armorBoxes = a
    ? `<div class="cs-combat">
        ${sheetBox(t("RK {ac}", { ac: armorFormula(a) }), t("Rüstungsklasse"))}
        ${sheetBox((ARMOR_CATEGORIES.find(([v]) => v === a.category) || [])[1], t("Kategorie"))}
        ${sheetBox(a.str_req ? `${t("STÄ")} ${a.str_req}` : "–", t("Stärke"))}
        ${sheetBox(a.stealth_disadvantage ? t("Nachteil") : "–", t("Heimlichkeit"))}
      </div>`
    : "";
  const weaponBoxes = w
    ? `<div class="cs-combat">
        ${sheetBox(`${diceDe(w.damage_dice) || "–"} ${(w.damage_type && DAMAGE_TYPE_DE[w.damage_type]) || w.damage_type || ""}`.trim(), t("Schaden"))}
        ${sheetBox(w.category, t("Kategorie"))}
      </div>`
    : "";
  return `
    <div class="char-sheet item-sheet">
      ${sheetHeader(it.name, t("Gegenstand"), sheetInfo(it.item_type, t("Typ")) + sheetInfo(it.rarity && capitalize(it.rarity), t("Seltenheit")))}
      ${armorBoxes}${weaponBoxes}
      <div class="cs-combat">
        ${sheetBox(it.requires_attunement ? t("Ja") : t("Nein"), t("Attunement"))}
        ${sb.cost ? sheetBox(sb.cost, t("Preis")) : ""}
        ${sb.weight ? sheetBox(sb.weight, t("Gewicht")) : ""}
        ${sheetBox(sourceLabel(it.source), t("Quelle"))}
      </div>
      ${sheetPanel(t("Eigenschaften"), w && w.properties && w.properties.length ? escapeHtml(w.properties.join(", ")) : "")}
      ${sheetPanel(t("Beschreibung"), it.desc ? deTextHtml(it.desc, it.desc_de) : "")}
      ${sheetPanel(t("Hinweis"), it.notes ? escapeHtml(it.notes) : "")}
    </div>`;
}

// German text if the library has one (translate.py in the Kampagnenbuch), the English
// original folded away below it; otherwise just the original.
// German text where the library has a translation, with the English original below; in English the original only.
function deTextHtml(en, de, render = mdLiteHtml) {
  if (!de || !UI_DE) return en ? render(en) : de ? render(de) : "";
  return `${render(de)}<details class="pc-orig"><summary>${t("Original (englisch)")}</summary>${en ? render(en) : ""}</details>`;
}

function spellSheetHtml(sp) {
  const level = sp.level_int === 0 ? t("Zaubertrick") : sp.level_int != null ? t("Grad {n}", { n: sp.level_int }) : "";
  return `
    <div class="char-sheet spell-sheet">
      ${sheetHeader(
        sp.name,
        t("Zauber"),
        sheetInfo(sp.school && `${spellSchoolIcon(sp.school).icon} ${sp.school}`, t("Schule")) + sheetInfo(level, t("Grad"))
      )}
      <div class="cs-combat">
        ${sheetBox(sp.casting_time, t("Zauberdauer"))}
        ${sheetBox(sp.range, t("Reichweite"))}
        ${sheetBox(sp.components, t("Komponenten"))}
        ${sheetBox(sp.duration, t("Wirkungsdauer"))}
      </div>
      <div class="cs-combat">
        ${sheetBox(sp.concentration ? t("Ja") : t("Nein"), t("Konzentration"))}
        ${sheetBox(sp.ritual ? t("Ja") : t("Nein"), t("Ritual"))}
        ${sheetBox(sourceLabel(sp.source), t("Quelle"))}
      </div>
      ${sheetPanel(t("Klassen"), sp.dnd_class ? escapeHtml(sp.dnd_class) : "")}
      ${sheetPanel(t("Material"), sp.material ? deTextHtml(sp.material, sp.material_de) : "")}
      ${sheetPanel(t("Beschreibung"), sp.desc ? deTextHtml(sp.desc, sp.desc_de) : "")}
      ${sheetPanel(t("Bei höherem Grad"), sp.higher_level ? deTextHtml(sp.higher_level, sp.higher_level_de) : "")}
      ${sheetPanel(t("Hinweis"), sp.notes ? escapeHtml(sp.notes) : "")}
    </div>`;
}

// ---------- print / PDF ----------
// The sheet as on paper: read-only (no buttons for HP, rests and the like), then one page per spell with
// its description. Built in a block of its own that only the print media shows (charsheet.css), so the
// page behind it stays as it is; the browser's print dialog also saves it as PDF.
// spells: library entries (id, name, desc …) to look the character's spells up in.
function printPcSheet(entity, opts = {}, spells = []) {
  document.querySelector(".pc-print")?.remove();
  const d = pcData(entity);
  const byId = new Map(spells.map((s) => [String(s.id), s]));
  const pages = d.spell_list
    .map((s) => byId.get(String(s.id)))
    .filter(Boolean)
    .sort((a, b) => (a.level_int ?? 99) - (b.level_int ?? 99) || a.name.localeCompare(b.name, UI_LOCALE));
  const box = document.createElement("div");
  box.className = "pc-print";
  box.innerHTML = pcSheetHtml(entity, false, opts)
    + (pages.length ? `<div class="pc-print-spells"><h2>${t("Zauber")}</h2><div class="pc-print-cols">${pages.map(spellPrintHtml).join("")}</div></div>` : "");
  document.body.append(box);
  const done = () => box.remove();
  window.addEventListener("afterprint", done, { once: true });
  // Pictures (portrait, school icons) have to be there before the dialog takes its snapshot.
  const imgs = [...box.querySelectorAll("img")].filter((i) => !i.complete);
  Promise.all(imgs.map((i) => new Promise((r) => { i.onload = i.onerror = r; }))).then(() => window.print());
}

// One spell, compact for the print: the facts in a line, then the texts (German where there is one).
function spellPrintHtml(sp) {
  const level = sp.level_int === 0 ? t("Zaubertrick") : sp.level_int != null ? t("Grad {n}", { n: sp.level_int }) : "";
  const facts = [
    [t("Zauberdauer"), sp.casting_time], [t("Reichweite"), sp.range], [t("Komponenten"), sp.components],
    [t("Wirkungsdauer"), sp.duration],
  ].filter(([, v]) => v).map(([l, v]) => `<span><b>${l}:</b> ${escapeHtml(v)}</span>`);
  if (sp.concentration) facts.push(`<span>${t("Konzentration")}</span>`);
  if (sp.ritual) facts.push(`<span>${t("Ritual")}</span>`);
  const text = (en, de) => (en || de ? (de ? mdLiteHtml(de) : mdLiteHtml(en)) : "");
  return `
    <div class="pc-print-spell">
      <div class="pc-print-spell-head"><b>${escapeHtml(sp.name)}</b><span>${escapeHtml([level, sp.school].filter(Boolean).join(" · "))}</span></div>
      <div class="pc-print-spell-facts">${facts.join("")}</div>
      ${sp.material ? `<div class="pc-print-spell-facts"><span><b>${t("Material")}:</b> ${escapeHtml(sp.material_de || sp.material)}</span></div>` : ""}
      <div class="pc-print-spell-text">${text(sp.desc, sp.desc_de)}</div>
      ${sp.higher_level ? `<div class="pc-print-spell-text"><b>${t("Bei höherem Grad")}:</b> ${text(sp.higher_level, sp.higher_level_de)}</div>` : ""}
    </div>`;
}
