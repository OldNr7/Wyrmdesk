// Guided character creation: a dialog that walks through race, class, background, abilities,
// skills, languages, spells (if the class casts) and equipment, step by step, ending in the full
// character sheet with Save/Discard. Modeled directly on the Kampagnenbuch's level-up dialog
// (dmtool/backend/app/shared_static/levelup.js), which charcreator never had a copy of: same
// steps-array-of-{title, html(), valid()} shape, same <dialog class="cs-popup lu">, same
// data-back/data-next click delegation - "Zurück" works at every step for free because all the
// choices live in one closure object (c) instead of being written to the DOM as we go.
//
// Needs charsheet.js (pcData, pcDerived, CLASSES, the option/ability/skill/language helpers,
// optionInfoHtml, readPcSheet, pcSheetHtml, equipInfo/equipProblem) and the page's state
// (state.options, state.items, state.spells via loadSpells(), all set up by player_static/app.js
// before this ever opens).
//
// openCreationWizard(character, actions): character is the bare draft row already created via
// POST (name/player_name only). actions.save(body, playState) PUTs the finished sheet and then the
// starting inventory/ammunition; actions.portrait(file | null) uploads/removes the portrait and
// returns the fresh row; actions.discard() DELETEs the draft; actions.onClose() runs once
// the dialog closes however it closes (saved, discarded, or cancelled) - the caller just goes back
// to the character list either way.

// ---------- languages ----------

// The languages of the PHB, as checkboxes. Exotic ones usually need the DM's OK.
const WIZ_LANGUAGES = [
  [t("Standardsprachen"), ["common", "dwarvish", "elvish", "giant", "gnomish", "goblin", "halfling", "orc"]],
  [t("Exotische Sprachen"), ["abyssal", "celestial", "draconic", "deep speech", "infernal", "primordial", "sylvan", "undercommon"]],
];

// Where a given skill or language comes from: charsheet.js names it in German ("Volk" …), shown in the UI language.
const WIZ_SOURCE = { Volk: t("Volk"), Hintergrund: t("Hintergrund"), Klasse: t("Klasse"), Unterklasse: t("Unterklasse") };
const wizSource = (s) => WIZ_SOURCE[s] || s;

// ---------- skills a people or background gives outright ----------

// "You have proficiency in the Perception skill" names it; "Insight, Perception, or Survival" or
// "two skills of your choice" are choices, which the player makes in the list like any other.
function raceFixedSkills(race) {
  const out = [];
  for (const t of ((race && race.data) || {}).traits || []) {
    const n = traitSkillCount(t);
    if (!n) continue;
    const desc = String(t.desc || "").toLowerCase();
    if (/of your choice/.test(desc)) continue;
    const named = SKILLS.filter(([k]) => new RegExp(`\\b${SKILL_NAMES_EN[k]}\\b`).test(desc)).map(([k]) => k);
    if (named.length && named.length <= n) out.push(...named);
  }
  return out;
}

// ---------- starting equipment: the suggestions of class and background, parsed into pieces ----------

const NUM_WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twenty: 20 };
const COIN_DE = Object.fromEntries(COINS);
const AMMO_DE = [
  [/^arrows?$/i, t("Pfeile")],
  [/^(crossbow )?bolts?$/i, t("Armbrustbolzen")],
  [/^(blowgun )?needles?$/i, t("Blasrohrnadeln")],
  [/^sling bullets?$/i, t("Schleuderkugeln")],
];
const MAGIC_RARITY = /uncommon|rare|legendary|artifact/i;

// What the equipment packs hold (SRD), shown under the pack's name.
const PACK_CONTENTS = {
  burglar: t("Rucksack, Beutel mit 1000 Kugellagerkugeln, 3 m Schnur, Glocke, 5 Kerzen, Brecheisen, Hammer, 10 Kletterhaken, Blendlaterne, 2 Flaschen Öl, Rationen für 5 Tage, Zunderkästchen, Wasserschlauch, 15 m Hanfseil"),
  diplomat: t("Truhe, 2 Karten- und Schriftrollenbehälter, feine Kleidung, Tintenfass, Schreibfeder, Lampe, 2 Flaschen Öl, 5 Blatt Papier, Fläschchen Parfüm, Siegelwachs, Seife"),
  dungeoneer: t("Rucksack, Brecheisen, Hammer, 10 Kletterhaken, 10 Fackeln, Zunderkästchen, Rationen für 10 Tage, Wasserschlauch, 15 m Hanfseil"),
  entertainer: t("Rucksack, Schlafsack, 2 Kostüme, 5 Kerzen, Rationen für 5 Tage, Wasserschlauch, Verkleidungsset"),
  explorer: t("Rucksack, Schlafsack, Essgeschirr, Zunderkästchen, 10 Fackeln, Rationen für 10 Tage, Wasserschlauch, 15 m Hanfseil"),
  priest: t("Rucksack, Decke, 10 Kerzen, Zunderkästchen, Almosenkästchen, 2 Blöcke Weihrauch, Weihrauchfass, Gewänder, Rationen für 2 Tage, Wasserschlauch"),
  scholar: t("Rucksack, Buch mit Wissen, Tintenfass, Schreibfeder, 10 Blatt Pergament, Beutelchen Sand, kleines Messer"),
};
const packContents = (name) => {
  const m = /\b(burglar|diplomat|dungeoneer|entertainer|explorer|priest|scholar)'?s?\s+pack\b/i.exec(String(name || ""));
  return m ? PACK_CONTENTS[m[1].toLowerCase()] : null;
};

// Lookup key of a library item: "Crossbow, light" is also found as "light crossbow".
const gearKey = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9' ,]/g, "").replace(/\s+/g, " ").trim();
function gearIndex() {
  const idx = new Map();
  for (const it of state.items || []) {
    if (MAGIC_RARITY.test(it.rarity || "")) continue;
    const k = gearKey(it.name);
    idx.set(k, it);
    const m = /^(.+), (.+)$/.exec(k);
    if (m) idx.set(`${m[2]} ${m[1]}`, it);
  }
  return idx;
}
// "handaxes", "leather armor", "wooden shield" -> the library's Handaxe, Leather, Shield.
function gearMatch(idx, name) {
  const k = gearKey(name);
  const tries = [k, k.replace(/ armor$/, ""), k.replace(/es$/, ""), k.replace(/s$/, ""), /\bshield$/.test(k) ? "shield" : ""];
  for (const t of tries) if (t && idx.has(t)) return idx.get(t);
  return null;
}

const capFirst = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// One comma-separated piece ("two handaxes", "20 arrows", "16 GP", "any simple weapon") as
// [{qty, name, item?, coin?, ammo?, generic?}]; "quiver of 20 arrows" becomes two.
function gearPieces(idx, raw) {
  let t = raw.trim().replace(/^(?:and|or)\s+/i, "").replace(/[.;]+$/, "").trim();
  if (!t) return [];
  const quiver = /^(?:an?\s+)?quiver of (\d+) (\w+)$/i.exec(t);
  if (quiver) return [...gearPieces(idx, "a quiver"), ...gearPieces(idx, `${quiver[1]} ${quiver[2]}`)];
  const pouch = /^(.*?)\s+containing\s+(.+)$/i.exec(t);
  if (pouch) return [...gearPieces(idx, pouch[1]), ...gearPieces(idx, pouch[2])];
  const coin = /^(\d+)\s*(cp|sp|ep|gp|pp)$/i.exec(t);
  if (coin) return [{ qty: Number(coin[1]), coin: coin[2].toLowerCase() }];
  let qty = 1;
  const q = /^(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|twenty)\s+(.+)$/i.exec(t);
  if (q) {
    qty = /^\d+$/.test(q[1]) ? Number(q[1]) : NUM_WORDS[q[1].toLowerCase()];
    t = q[2];
  }
  const generic = /^(?:any\s+(?:other\s+)?)?(simple|martial)(?:\s+(melee|ranged))?\s+weapons?$/i.exec(t);
  if (generic) {
    const cat = generic[1].toLowerCase();
    const range = (generic[2] || "").toLowerCase();
    // window.t: the local t is the text here.
    const label = `${cat === "simple" ? window.t("Einfache Waffe") : window.t("Kriegswaffe")}${range ? ` ${range === "melee" ? window.t("(Nahkampf)") : window.t("(Fernkampf)")}` : ""} ${window.t("nach Wahl")}`;
    return [{ qty, generic: { cat, range }, name: label }];
  }
  const ammo = AMMO_DE.find(([re]) => re.test(t));
  if (ammo) return [{ qty, ammo: ammo[1] }];
  const item = gearMatch(idx, t);
  return [{ qty, name: item ? item.name : capFirst(t), item }];
}

// The pieces of one option ("leather armor, longbow, and 20 arrows").
function gearOption(idx, text) {
  return text
    .split(/\s*,\s*(?:and\s+)?|\s+and\s+/i)
    .flatMap((part) => gearPieces(idx, part));
}

// "(a) chain mail or (b) leather armor, longbow, and 20 arrows" -> one choice group, a line
// without (a)/(b) -> a single option. Lines "Name: …" keep the name as the group label.
function gearLine(idx, line) {
  let text = line.trim();
  let label = "";
  const lm = /^([^:]{1,70}):\s*(.+)$/.exec(text);
  if (lm) [label, text] = [lm[1].trim(), lm[2]];
  if (/^choose\b/i.test(label)) label = "";
  const parts = text.split(/\(\s*[a-c]\s*\)/i);
  const options = (parts.length > 1 ? parts.slice(1) : parts)
    .map((p) => p.replace(/[\s,;]*\bor\b[\s,;]*$/i, "").replace(/[\s,;]+$/, "").trim())
    .filter(Boolean)
    .map((p) => ({ text: p, pieces: gearOption(idx, p) }))
    .filter((o) => o.pieces.length);
  return { label, options };
}

function cleanGearText(t) {
  return String(t || "")
    .replace(/�|[’‘]/g, "'")
    .replace(/\*+/g, "")
    .replace(/\r/g, "")
    .replace(/\s*\((?:same as above|if proficient)\)/gi, "")
    // Remarks in brackets like "(a gift to you when you entered the priesthood)", not "Book (prayers)".
    .replace(/\s*\(([^)]*)\)/g, (m, inner) => (inner.trim().split(/\s+/).length > 2 ? "" : m));
}

// Groups of options from one source text: bullet lines (class) or a single line (background).
function gearGroups(idx, source, rawText) {
  const text = cleanGearText(rawText);
  if (!text.trim()) return [];
  const bullets = text.split("\n").map((l) => /^\s*[-•]\s+(.*)$/.exec(l)).filter(Boolean).map((m) => m[1]);
  // Older texts mark bullets with "*", which the cleanup above already removed: lines after the intro.
  const lines = bullets.length
    ? bullets
    : text.split("\n").map((l) => l.trim()).filter((l) => l && !/^you (start|begin)\b/i.test(l));
  const groups = lines.map((l) => ({ source, ...gearLine(idx, l) })).filter((g) => g.options.length);
  // "Choose one of the following packages": every line named ("Soldier's Set: …") -> one choice.
  if (groups.length > 1 && groups.every((g) => g.label && g.options.length === 1)) {
    return [{ source, label: "", options: groups.map((g) => ({ ...g.options[0], text: `${g.label}: ${g.options[0].text}`, title: g.label })) }];
  }
  return groups;
}

// Weapons of the library for "any simple weapon", "two martial weapons" …
function genericWeapons(generic) {
  return (state.items || []).filter((it) => {
    if (!itemWeapon(it) || MAGIC_RARITY.test(it.rarity || "")) return false;
    const type = String(it.item_type || "").toLowerCase();
    return type.includes(generic.cat) && (!generic.range || type.includes(generic.range));
  });
}

// ---------- people, class and background as picture tiles ----------

// Icon (symbol in creation-icons.svg) per English name; classes also get an accent colour and a
// short line. Unknown entries (new imports) fall back to a neutral icon. Sprite and class portraits
// are made by tools/creation-icons.py, which has the same class list.
const WIZ_RACE_ICONS = {
  human: "vitruvian-man", elf: "woman-elf-face", drow: "spider-face", "half-elf": "elf-ear",
  dwarf: "dwarf-face", gnome: "pointy-hat", halfling: "hobbit-door", "half-orc": "brute", orc: "orc-head",
  dragonborn: "dragon-head", tiefling: "devil-mask", goliath: "giant", catfolk: "cat",
  darakhul: "shambling-zombie", satarre: "lizardman",
};
const WIZ_CLASS_LOOK = {
  barbarian: ["battle-axe", "#9b2c22", t("Kampfwut, schwere Waffen")],
  bard: ["lyre", "#7a3f8c", t("Musik, Inspiration, Vielseitigkeit")],
  cleric: ["holy-symbol", "#a07a12", t("Göttliche Magie, Heilung")],
  druid: ["oak-leaf", "#3f6b22", t("Natur, Tiergestalt")],
  fighter: ["crossed-swords", "#55606b", t("Waffenmeister, Rüstung")],
  monk: ["fist", "#9a6a1c", t("Waffenlos, Ki")],
  paladin: ["templar-shield", "#6f7f8c", t("Eid, heilige Schläge")],
  ranger: ["high-shot", "#2f5d3a", t("Fernkampf, Wildnis")],
  rogue: ["cloak-dagger", "#3a3530", t("Hinterhalt, Fertigkeiten")],
  sorcerer: ["fire-ray", "#b8521a", t("Angeborene Magie")],
  warlock: ["warlock-eye", "#4b2a6b", t("Pakt mit einer Macht")],
  wizard: ["wizard-staff", "#2b4f86", t("Zauberbuch, gelehrte Magie")],
  marshal: ["knight-banner", "#7a1f1f", t("Anführer, Befehle")],
  mechanist: ["gear-hammer", "#8a5a2b", t("Erfindungen, Konstrukte")],
};
const WIZ_BACKGROUND_ICONS = {
  acolyte: "prayer", sage: "open-book", soldier: "spartan-helmet", criminal: "domino-mask",
  "criminal / spy": "domino-mask", noble: "crown", "folk hero": "star-medal", anthropologist: "compass",
  archaeologist: "dig-dug",
};
const WIZ_CASTER = { full: t("Vollzauberer"), half: t("Halbzauberer"), pact: t("Paktmagie") };
const WIZ_ICON_CREDIT = '<p class="wz-tile-hint">Icons: <a href="https://game-icons.net" target="_blank" rel="noopener">game-icons.net</a>, CC BY 3.0</p>';
const wizIcon = (id) => `<svg class="wz-tile-icon" aria-hidden="true"><use href="/shared/creation-icons.svg#${id}"/></svg>`;

// Peoples grouped under their main people: a subrace (parent = name of a main people) joins that
// tile, both editions of a people share one tile. A subrace whose parent is missing gets its own.
function raceTileGroups() {
  const all = charOptions("races");
  const mains = new Set(all.filter((o) => !o.parent).map((o) => o.name));
  const groups = new Map();
  for (const o of all) {
    const key = o.parent && mains.has(o.parent) ? o.parent : o.name;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(o);
  }
  return [...groups].map(([name, list]) => {
    const main = list.filter((o) => o.name === name);
    // The main people first (2024 before 2014), then the subraces by name.
    list.sort((a, b) => (a.name === name) !== (b.name === name) ? (a.name === name ? -1 : 1)
      : a.name === b.name ? b.is_2024 - a.is_2024 : a.name.localeCompare(b.name, UI_LOCALE));
    const head = main[0] || list[0];
    return { name, label: optName(head), list, standard: isStandardRace(head), icon: WIZ_RACE_ICONS[String(head.name_en || "").toLowerCase()] || "hood" };
  }).sort((a, b) => a.label.localeCompare(b.label, UI_LOCALE));
}

// Backgrounds grouped by their English name, so "Soldat" (2024) and "Soldier" (2014) share a tile.
// The tile carries the German name where one of the entries has it (English UI: the English one).
function backgroundTileGroups() {
  const groups = new Map();
  for (const o of charOptions("backgrounds")) {
    const key = String(o.name_en || o.name).trim().toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(o);
  }
  return [...groups].map(([key, list]) => {
    list.sort((a, b) => b.is_2024 - a.is_2024 || a.name.localeCompare(b.name, UI_LOCALE));
    const de = list.find((o) => o.name_en && o.name !== o.name_en);
    const name = (de || list[0]).name;
    return { name, label: UI_DE ? name : optName(list.find((o) => o.name_en) || list[0]), list, icon: WIZ_BACKGROUND_ICONS[key] || "scroll-unfurled" };
  }).sort((a, b) => a.label.localeCompare(b.label, UI_LOCALE));
}


// ---------- values shown in the wizard ----------

// The three computed cells of an ability row: increase (people, background, feat), score, modifier.
function abilityCalcHtml(base, bonus) {
  const num = base !== null && base !== undefined && base !== "" && !isNaN(base);
  const total = num ? abilityTotal(Number(base), bonus || 0) : null;
  const capped = num && Number(base) + (bonus || 0) > ABILITY_MAX;
  return `<span>${bonus ? signed(bonus) : "–"}</span>
    <span class="wz-abil-total">${total ?? "–"}${capped ? ` <span class="wz-meta" title="${t("Höchstens 20")}">${t("(max.)")}</span>` : ""}</span>
    <span class="wz-abil-mod">${total === null ? "–" : signed(Math.floor((total - 10) / 2))}</span>`;
}

const ARMOR_CATEGORY_DE = { light: t("Leichte Rüstung"), medium: t("Mittelschwere Rüstung"), heavy: t("Schwere Rüstung") };

// Short values of a weapon or armor beside its name in the equipment step: AC, damage, how it is
// held, light, the ability it attacks with, range. Nothing for other gear.
function gearStatsHtml(item) {
  if (!item) return "";
  const chips = [];
  const armor = itemArmorFull(item);
  const weapon = !armor && itemWeapon(item);
  if (armor) {
    chips.push(armor.category === "shield" ? t("RK {ac} (Schild)", { ac: armorFormula(armor) }) : t("RK {ac}", { ac: armorFormula(armor) }));
    if (ARMOR_CATEGORY_DE[armor.category]) chips.push(ARMOR_CATEGORY_DE[armor.category]);
    if (armor.str_req) chips.push(t("{ability} {n} nötig", { ability: ABILITY_SHORT.str, n: armor.str_req }));
    if (armor.stealth_disadvantage) chips.push(t("Nachteil auf Heimlichkeit"));
  } else if (weapon) {
    const props = weaponProps(weapon);
    const prop = (k) => props.find((p) => p.key === k);
    const range = (p) => (p && p.arg ? ` ${p.arg.replace(/^range\s*/i, "")} ft` : "");
    const type = DAMAGE_TYPE_DE[weapon.damage_type] || weapon.damage_type || "";
    if (weapon.damage_dice) chips.push(`${diceDe(weapon.damage_dice)}${weapon.bonus ? ` ${signed(weapon.bonus)}` : ""} ${type}`.trim());
    if (prop("two-handed")) chips.push(t("Zweihändig"));
    else if (prop("versatile")) chips.push(prop("versatile").arg ? t("Vielseitig (zweihändig {dice})", { dice: diceDe(prop("versatile").arg) }) : t("Vielseitig"));
    else chips.push(t("Einhändig"));
    if (prop("light")) chips.push(t("Leicht"));
    const ranged = /ranged/i.test(weapon.category || "");
    chips.push(ranged ? ABILITY_SHORT.dex : prop("finesse") ? t("{a} oder {b}", { a: ABILITY_SHORT.str, b: ABILITY_SHORT.dex }) : ABILITY_SHORT.str);
    if (prop("ammunition")) chips.push(`${t("Fernkampf")}${range(prop("ammunition"))}`);
    if (prop("thrown")) chips.push(`${t("Wurfwaffe")}${range(prop("thrown"))}`);
    for (const k of ["finesse", "heavy", "reach", "loading"]) if (prop(k)) chips.push(WEAPON_PROPERTIES[k][0]);
  }
  return chips.length ? `<span class="wz-stats">${chips.map((t) => `<span>${escapeHtml(t)}</span>`).join("")}</span>` : "";
}

function openCreationWizard(character, actions) {
  const esc = (v) => escapeHtml(String(v ?? ""));

  const c = {
    race_ref: null,
    background_ref: null,
    class_key: "",
    class_ref: null,
    subclass_ref: null, // only for classes that pick it on level 1 (cleric, sorcerer, warlock in 2014)
    ability_base: {},
    ability_choice: {},
    skill_prof: [],
    skill_expertise: [],
    skill_fixed: {}, // skill -> "Volk"/"Hintergrund": given, not chosen
    lang: new Set(), // chosen languages (keys of LANGUAGES_DE), without those people/background name
    lang_other: "",
    equipment: "", // free text beside the inventory
    equip_key: null, // class|background the picks below belong to
    equip_pick: [], // per group: index of the chosen option, or null
    equip_any: {}, // "group:option:piece:n" -> item id for "any simple weapon"
    cantrips: new Set(),
    spells: new Set(),
    sub_off: new Set(), // keys of unticked fixed subclass grants
    sub_picks: {}, // subclass choice key -> Set of skill keys or spell ids
    exp_fixed: [], // expertise the subclass gives (Knowledge Domain), locked in the skills step
    feat_pick: "", // the feat the people lets choose (Human 2024: an origin feat), library id
  };
  // The opened tile per kind (its name); its variants show below the tiles.
  const openTile = { races: null, backgrounds: null };
  const tileGroups = { races: raceTileGroups, backgrounds: backgroundTileGroups };
  const refKey = { races: "race_ref", backgrounds: "background_ref" };

  const selectOption = (kind, o) => {
    c[refKey[kind]] = optionRef(o) || null;
    if (kind === "races") c.feat_pick = "";
    fitChoice();
  };

  // Tiles of grouped entries (peoples, backgrounds) with the variants of the opened one as chips.
  const groupTilesHtml = (kind, sections) => {
    const ref = c[refKey[kind]];
    const groups = sections.flatMap((s) => s.groups);
    const open = groups.find((g) => g.name === openTile[kind]) || (ref && groups.find((g) => g.list.some((o) => o.id === ref.id)));
    const tile = (g) => `<button type="button" class="wz-tile" data-wiz-tile="${kind}" data-name="${esc(g.name)}" aria-pressed="${g === open}">
        <span class="wz-medal">${wizIcon(g.icon)}</span>
        <span class="wz-tile-name">${esc(g.label)}</span>
        ${g.list.length > 1 ? `<span class="wz-tile-line">${t("{n} Varianten", { n: g.list.length })}</span>` : ""}
      </button>`;
    const variants = open && open.list.length > 1
      ? `<div class="wz-variants"><span class="wz-variants-head">${t("Variante von {name}:", { name: esc(open.label) })}</span>${open.list
          .map((o) => `<button type="button" class="wz-chip" data-wiz-pick="${kind}" data-id="${o.id}" aria-pressed="${!!ref && ref.id === o.id}">${esc(optionLabel(o))}</button>`)
          .join("")}</div>`
      : "";
    return sections
      .filter((s) => s.groups.length)
      .map((s) => `${s.label ? `<h4 class="wz-tiles-head">${s.label}</h4>` : ""}<div class="wz-tiles">${s.groups.map(tile).join("")}</div>`)
      .join("") + variants + WIZ_ICON_CREDIT;
  };
  const selectClass = (key, ref) => {
    c.class_key = key;
    c.class_ref = ref;
    c.subclass_ref = null;
    c.sub_off.clear();
    c.sub_picks = {};
    c.cantrips.clear();
    c.spells.clear();
    c.skill_expertise = [];
    // The whole spell list: a subclass may add spells from other lists (Arcana Domain).
    loadSpells(c.class_key, null, true).catch(() => {}).then(draw);
  };

  // ---------- derived choices ----------

  const fixedSkillsBase = () => {
    const m = {};
    const race = c.race_ref && optionById(c.race_ref.id);
    for (const k of raceFixedSkills(race)) m[k] = "Volk";
    for (const k of (c.background_ref && c.background_ref.skills) || []) m[k] = "Hintergrund";
    return m;
  };
  const fixedSkills = () => {
    const m = fixedSkillsBase();
    const sr = subResult();
    for (const k of (sr && sr.skills) || []) if (!(k in m)) m[k] = "Unterklasse";
    return m;
  };
  // Skills of people/background are ticked (and locked); ones from an earlier choice taken back.
  const syncFixedSkills = () => {
    const now = fixedSkills();
    for (const k of Object.keys(c.skill_fixed)) {
      if (!(k in now)) {
        c.skill_prof = c.skill_prof.filter((s) => s !== k);
        c.skill_expertise = c.skill_expertise.filter((s) => s !== k);
      }
    }
    for (const k of Object.keys(now)) if (!c.skill_prof.includes(k)) c.skill_prof.push(k);
    c.skill_fixed = now;
    const sr = subResult();
    const exp = (sr && sr.expertise) || [];
    c.skill_expertise = c.skill_expertise.filter((k) => !c.exp_fixed.includes(k) || exp.includes(k));
    for (const k of exp) if (!c.skill_expertise.includes(k)) c.skill_expertise.push(k);
    c.exp_fixed = exp;
    // A spell the subclass gives (or had picked) isn't also one of the class's own picks.
    for (const sp of (sr && sr.spells) || []) {
      if (sp.id == null) continue;
      c.cantrips.delete(String(sp.id));
      c.spells.delete(String(sp.id));
    }
  };

  // Languages people and background name, how many more are free, and what's ticked so far.
  const langState = () => {
    const parts = languageBudget({ race_ref: c.race_ref, background_ref: c.background_ref, subclass_ref: c.subclass_ref, level: 1 });
    const named = [...new Set(parts.flatMap(([, g]) => g.named))];
    const free = parts.reduce((s, [, g]) => s + g.free, 0);
    const other = c.lang_other.split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean);
    const chosen = WIZ_LANGUAGES.flatMap(([, keys]) => keys).filter((k) => c.lang.has(k) && !named.includes(LANGUAGES_DE[k]));
    return {
      parts, named, free, other, chosen,
      total: parts.length ? named.length + free : null,
      count: named.length + chosen.length + other.length,
      text: [...named, ...chosen.map((k) => LANGUAGES_DE[k]), ...other].join(", "),
    };
  };

  // Equipment suggestions of class and background, re-parsed when either changes.
  let gearCache = { key: null, groups: [] };
  const gearGroupsNow = () => {
    const key = `${c.class_key}|${c.class_ref ? c.class_ref.id : ""}|${c.background_ref ? c.background_ref.id : ""}`;
    if (gearCache.key !== key) {
      const idx = gearIndex();
      const co = classOption({ class_key: c.class_key, class_ref: c.class_ref });
      const bg = c.background_ref && optionById(c.background_ref.id);
      const feature = (o, list) => o && ((o.data || {})[list] || []).find((f) => /^equipment/i.test(f.name || ""));
      const classText = co ? (co.data || {}).equipment || (feature(co, "features") || {}).desc : "";
      const bgText = bg ? (feature(bg, "benefits") || {}).desc : "";
      gearCache = {
        key,
        groups: [...gearGroups(idx, t("Klasse"), classText), ...gearGroups(idx, t("Hintergrund"), bgText)],
      };
    }
    if (c.equip_key !== key) {
      c.equip_key = key;
      // Fixed lines are ticked from the start, choices wait for the player.
      c.equip_pick = gearCache.groups.map((g) => (g.options.length === 1 ? 0 : null));
      c.equip_any = {};
    }
    return gearCache.groups;
  };

  // Inventory, ammunition and coins of the ticked options. Armor, a shield and the weapons that
  // still fit in two hands are equipped right away, so AC and attacks are on the sheet from the start.
  const draftGear = () => {
    const inv = [];
    const ammo = [];
    const coins = {};
    const add = (name, qty, item) => {
      const same = inv.find((e) => (item ? String(e.item_id) === String(item.id) : !e.item_id && e.name.toLowerCase() === name.toLowerCase()));
      if (same) same.qty += qty;
      else inv.push({ name: item ? item.name : name, qty, item_id: item ? item.id : null, equipped: false });
    };
    gearGroupsNow().forEach((g, gi) => {
      const oi = c.equip_pick[gi];
      if (oi === null || oi === undefined || !g.options[oi]) return;
      g.options[oi].pieces.forEach((p, pi) => {
        if (p.coin) coins[p.coin] = (coins[p.coin] || 0) + p.qty;
        else if (p.ammo) {
          const a = ammo.find((x) => x.name === p.ammo);
          if (a) a.count += p.qty;
          else ammo.push({ name: p.ammo, count: p.qty });
        } else if (p.generic) {
          for (let n = 0; n < p.qty; n++) {
            const it = libItem(c.equip_any[`${gi}:${oi}:${pi}:${n}`]);
            add(it ? it.name : p.name, 1, it);
          }
        } else add(p.name, p.qty, p.item);
      });
    });
    const kind = (e) => (equipInfo(e) || {}).kind;
    const tryEquip = (e) => {
      e.equipped = true;
      if (equipProblem(inv)) e.equipped = false;
    };
    const armor = inv.find((e) => kind(e) === "armor");
    if (armor) armor.equipped = true;
    const shield = inv.find((e) => kind(e) === "shield");
    if (shield) tryEquip(shield);
    inv.filter((e) => kind(e) === "weapon").forEach(tryEquip);
    return { inv, ammo, coins };
  };

  // ---------- what a level-1 subclass gives (subclassGrants, as in the Kampagnenbuch's level-up) ----------
  // Fixed things (proficiencies, skills, spells, the domain spells of level 1) are ticked and can be
  // unticked; choices (Knowledge Domain skills, Arcana Domain wizard cantrips, Death Domain's
  // necromancy cantrip) are made in the step "Aus der Unterklasse". Spells from the subclass are
  // marked extra: always prepared, not counted, and they count as spells of the class (class_en).
  // None of this looks at d()/x(), which are built from it.
  const subPlan = () => {
    const list = c.subclass_ref ? subclassGrants({}, 1, c.subclass_ref) : [];
    if (!list.length) return null;
    const o = list[0].o;
    const cl = cls();
    const parentEn = String(o.parent || (cl && cl.en) || "");
    const profText = String((cl && cl.profs) || "").toLowerCase();
    const fixed = [];
    const seen = new Set();
    const spell = (name, src, extra = {}) => {
      const k = `spell:${String(name).toLowerCase()}`;
      if (seen.has(k)) return;
      seen.add(k);
      const sp = libSpellByName(name);
      fixed.push({ key: k, kind: "spell", name: sp ? sp.name : String(name).replace(/\b\w/g, (ch) => ch.toUpperCase()), sp, src, ...extra });
    };
    const choices = [];
    for (const { f, i, g } of list) {
      const src = f.name_de || f.name;
      for (const p of g.profs || []) {
        const de = profDe(p);
        if (!profText.includes(de.toLowerCase()) && !profText.includes(String(p).toLowerCase()) && !seen.has(`prof:${de}`)) {
          seen.add(`prof:${de}`);
          fixed.push({ key: `prof:${de}`, kind: "prof", label: de, src });
        }
      }
      for (const k of g.skills || []) {
        if (seen.has(`skill:${k}`)) continue;
        seen.add(`skill:${k}`);
        fixed.push({ key: `skill:${k}`, kind: "skill", skill: k, src });
      }
      for (const sp of g.spells || []) spell(sp.name, src, { ritual_only: !!sp.ritual_only });
      for (const row of g.table || []) {
        if (row.level > 1) continue;
        // Level of a spell missing from the library: a full caster's level-1 spells are 1st level.
        const guess = cl && cl.spell && cl.spell.type === "full" ? 1 : null;
        for (const name of row.spells) spell(name, src, { guess });
      }
      if (g.skill_choice) choices.push({ key: `${o.id}:${i}:skills`, kind: "skills", src, ...g.skill_choice });
      (g.spell_choice || []).forEach((ch, j) => choices.push({ key: `${o.id}:${i}:${j}`, kind: "spells", src, ...ch }));
    }
    return { o, parentEn, fixed, choices };
  };
  // Spells a choice offers: by list, school and level (on level 1: cantrips and 1st level), none
  // the subclass already gives or another choice holds.
  const choicePool = (p, ch) => {
    const lists = ch.lists ? ch.lists.map((l) => l.toLowerCase()) : null;
    const taken = new Set([
      ...p.fixed.filter((e) => e.kind === "spell" && e.sp).map((e) => String(e.sp.id)),
      ...Object.entries(c.sub_picks).filter(([k]) => k !== ch.key).flatMap(([, set]) => [...set]),
    ]);
    return spellLibrary().filter((sp) => {
      if (taken.has(String(sp.id))) return false;
      if (lists && !String(sp.dnd_class || "").toLowerCase().split(",").map((x) => x.trim()).some((x) => lists.includes(x))) return false;
      if (ch.school && String(sp.school || "").toLowerCase() !== ch.school) return false;
      if (ch.cantrip) return sp.level_int === 0;
      if (ch.spell_level) return sp.level_int === ch.spell_level;
      return sp.level_int <= 1;
    });
  };
  // Skills a choice offers: with expertise any of the list, otherwise only ones not given already.
  const skillPool = (ch) => {
    const given = fixedSkillsBase();
    return (ch.from || SKILLS.map((s) => s[0])).filter((k) => ch.expertise || !(k in given));
  };
  const choiceNeed = (p, ch) => Math.min(ch.n, ch.kind === "skills" ? skillPool(ch).length : choicePool(p, ch).length);
  const hasSubStep = () => {
    const p = subPlan();
    return !!p && (p.fixed.length > 0 || p.choices.length > 0);
  };
  // What the subclass puts on the sheet.
  const subResult = () => {
    const p = subPlan();
    if (!p) return null;
    const on = p.fixed.filter((e) => !c.sub_off.has(e.key));
    const mark = { extra: true, source: p.o.name, class_en: p.parentEn };
    const entry = (sp, name, level, more) => ({
      id: sp ? sp.id : null, name: sp ? sp.name : name, level: sp ? sp.level_int : level ?? null, prepared: false, ...mark, ...more,
    });
    const r = {
      profs: on.filter((e) => e.kind === "prof").map((e) => e.label),
      skills: on.filter((e) => e.kind === "skill").map((e) => e.skill),
      expertise: [],
      spells: on.filter((e) => e.kind === "spell").map((e) => entry(e.sp, e.name, e.guess, e.ritual_only ? { ritual_only: true } : {})),
    };
    for (const ch of p.choices) {
      for (const v of c.sub_picks[ch.key] || []) {
        if (ch.kind === "skills") {
          if (!r.skills.includes(v)) r.skills.push(v);
          if (ch.expertise) r.expertise.push(v);
          continue;
        }
        const sp = findSpell({ id: v });
        if (sp) r.spells.push(entry(sp, sp.name, null, { grant: ch.key }));
      }
    }
    return r;
  };
  // The class's proficiencies plus the subclass's, as the level-up writes them; undefined without.
  const subProficiencies = () => {
    const r = subResult();
    if (!r || !r.profs.length) return undefined;
    return [(cls() || {}).profs || "", r.profs.join(", ")].filter(Boolean).join("; ");
  };

  // ---------- feats on level 1 ----------
  // The background's origin feat (2024) comes with it; a people may let the player choose one
  // ("You gain an Origin feat of your choice", the 2014 Variant Human "one feat of your choice").
  const speciesFeatGrant = () => {
    const race = c.race_ref && optionById(c.race_ref.id);
    for (const tr of (race && (race.data || {}).traits) || []) {
      const m = /\bgain (?:an?|one) (origin )?feat of your choice/i.exec(String(tr.desc || ""));
      if (m) return { origin: !!m[1], trait: tr.name_de || tr.name };
    }
    return null;
  };
  const speciesFeatList = () => {
    const g = speciesFeatGrant();
    if (!g) return [];
    return charOptions("feats").filter((o) => (g.origin ? (o.data || {}).feat_type === "Origin" : !(o.data || {}).prerequisite || /^\s*$/.test(o.data.prerequisite)));
  };
  const featsDraft = () => {
    const out = [];
    const bg = backgroundFeat({ background_ref: c.background_ref, feats: [] });
    if (bg) out.push({ ...optionRef(bg.option), source: "Hintergrund", detail: bg.detail });
    const o = speciesFeatGrant() && c.feat_pick ? optionById(Number(c.feat_pick)) : null;
    if (o) out.push({ ...optionRef(o), source: "Volk" });
    return out;
  };

  // The stat_block the choices so far would produce, and the pcData()/pcDerived() built from it -
  // recomputed fresh every time, so going back and changing an earlier choice always takes effect.
  const draftStatBlock = (gear = draftGear()) => ({
    level: 1,
    race: c.race_ref ? c.race_ref.name : undefined,
    race_ref: c.race_ref,
    background: c.background_ref ? c.background_ref.name : undefined,
    background_ref: c.background_ref,
    class_key: c.class_key,
    class_ref: c.class_ref,
    subclass: c.subclass_ref ? c.subclass_ref.name : undefined,
    subclass_ref: c.subclass_ref,
    proficiencies: subProficiencies(),
    ability_base: c.ability_base,
    ability_choice: c.ability_choice,
    feats: featsDraft(),
    skill_prof: c.skill_prof,
    skill_expertise: c.skill_expertise,
    languages: langState().text,
    equipment: c.equipment,
    coins: gear.coins,
    // Without this, pcData() treats the brand-new character like an old pre-calculation sheet
    // (entity.ac is still the bare "10" from creation) and invents a bogus AC adjustment for it.
    ac_adjust: 0,
    spell_list: [
      ...[...c.cantrips, ...c.spells]
        .map((id) => findSpell({ id }))
        .filter(Boolean)
        .map((sp) => ({ id: sp.id, name: sp.name, level: sp.level_int, prepared: false })),
      ...((subResult() || {}).spells || []),
    ],
  });
  const draftEntity = () => {
    const gear = draftGear();
    return { ...character, stat_block: draftStatBlock(gear), play_state: { inventory: gear.inv, ammo: gear.ammo } };
  };
  const d = () => pcData(draftEntity());
  const x = () => pcDerived(d());
  const cls = () => classInfo(c.class_key, c.class_ref);

  // Level 1 max HP: hit die maximum + CON modifier, at least 1 (5e gives no choice here).
  const hp1 = () => {
    const die = cls().hitDie;
    const con = x().m.con;
    return { die, con, total: Math.max(1, die + con) };
  };

  // The class's own feature for choosing the subclass ("Divine Domain", "Sorcerous Origin",
  // "Otherworldly Patron" …) says on which level that happens; only level 1 is part of creation.
  const subclassFeature = () => {
    const co = classOption({ class_key: c.class_key, class_ref: c.class_ref });
    const re = /subclass|domain|origin|patron|archetype|tradition|college|circle|oath|path/i;
    return co ? ((co.data || {}).features || []).find((f) => re.test(f.name || "") && (f.levels || [])[0] === 1) || null : null;
  };
  // Subclasses of the same rules edition as the class (2014 class, 2014 subclasses).
  const subclassChoices = () => {
    const co = classOption({ class_key: c.class_key, class_ref: c.class_ref });
    return subclassesFor(cls()).filter((s) => !co || !!s.is_2024 === !!co.is_2024);
  };

  // After a new people, background or feat: keep the distributed points that still fit.
  const fitChoice = () => {
    c.ability_choice = fitAbilityChoice(c.ability_choice,
      asiChoices({ race_ref: c.race_ref, background_ref: c.background_ref, feats: featsDraft() }));
  };

  // Free ability points of people and background: distributed / available.
  const asiPoints = () => {
    const choices = asiChoices({ race_ref: c.race_ref, background_ref: c.background_ref, feats: featsDraft() });
    const points = choices.reduce((s, ch) => s + ch.points, 0);
    const used = Object.values(c.ability_choice).reduce((s, n) => s + (Number(n) || 0), 0);
    return { points, used };
  };

  function srdClassFallbackHtml(cl) {
    const facts = [
      t("<b>Trefferwürfel:</b> W{n}", { n: cl.hitDie }),
      cl.saves.length && t("<b>Rettungswürfe:</b> {list}", { list: cl.saves.map((k) => ABILITY_SHORT[k]).join(", ") }),
      cl.skills &&
        (cl.skills[1]
          ? t("<b>Fertigkeiten:</b> {n} aus {list}", { n: cl.skills[0], list: cl.skills[1].map((k) => (SKILLS.find((s) => s[0] === k) || [k, k])[1]).join(", ") })
          : t("<b>Fertigkeiten:</b> {n} beliebige", { n: cl.skills[0] })),
      cl.profs && t("<b>Übungen:</b> {list}", { list: escapeHtml(cl.profs) }),
    ].filter(Boolean);
    return `<p>${facts.join("<br>")}</p><p class="pc-hint">${t("Nicht in der Bibliothek: Merkmale bitte im Regelwerk nachschlagen.")}</p>`;
  }

  // Spells to pick for a fresh level-1 character: cantrips from the class table, plus known
  // spells (bard/sorcerer/ranger-style) or the wizard's level-1 spellbook (6 by the SRD).
  const spellNeeds = () => {
    const xx = x();
    if (!xx.spell) return null;
    // The subclass's spells aren't offered again (Grave Domain: Spare the Dying).
    const fromSub = new Set(((subResult() || {}).spells || []).map((sp) => String(sp.id)));
    const pool = classSpells(c.class_key).filter((sp) => !fromSub.has(String(sp.id)));
    const cantripPool = pool.filter((sp) => sp.level_int === 0);
    const spellPool = pool.filter((sp) => sp.level_int === 1);
    const cantripsWant = xx.spell.cantrips || 0;
    const spellsWant = xx.spell.known !== null ? xx.spell.known : isSpellbook(d()) ? 6 : 0;
    return {
      cantrips: Math.min(cantripsWant, cantripPool.length), cantripPool,
      spells: Math.min(spellsWant, spellPool.length), spellPool,
      short: cantripsWant > cantripPool.length || spellsWant > spellPool.length,
    };
  };

  // One piece of an equipment option, as shown next to its checkbox.
  const pieceHtml = (p) => {
    const n = p.qty > 1 ? `${p.qty}× ` : "";
    if (p.coin) return `${p.qty} ${COIN_DE[p.coin] || p.coin.toUpperCase()}`;
    if (p.ammo) return `${p.qty} ${esc(p.ammo)}`;
    if (p.item) return `${n}<span class="cs-info-link" ${infoAttr(`item:${p.item.id}`)}>${esc(p.item.name)}</span>${gearStatsHtml(p.item)}`;
    return `${n}${esc(p.name)}`;
  };
  // Under an option's line: what its packs hold, one small line per pack.
  const packsHtml = (pieces) =>
    pieces
      .filter((p) => !p.coin && !p.ammo && !p.item && packContents(p.name))
      .map((p) => `<span class="wz-pack">${esc(p.name)}: (${esc(packContents(p.name))})</span>`)
      .join("");

  const steps = [
    {
      title: t("Rasse"),
      html: () => {
        const ref = c.race_ref;
        const full = ref && optionById(ref.id);
        const groups = raceTileGroups();
        return `<p>${t("Wähle das Volk deines Charakters.")}</p>
          ${groupTilesHtml("races", [
            { label: t("Standardvölker (Grundregeln)"), groups: groups.filter((g) => g.standard) },
            { label: t("Weitere Völker"), groups: groups.filter((g) => !g.standard) },
          ])}
          <div class="lu-option-info">${full ? optionInfoHtml(full) : ""}</div>`;
      },
      valid: () => (c.race_ref || charOptions("races").length === 0 ? true : t("Volk wählen.")),
    },
    {
      title: t("Klasse"),
      html: () => {
        const libClasses = libraryClasses();
        const dd = d();
        const co = classOption(dd);
        const info = co ? optionInfoHtml(co) : c.class_key ? srdClassFallbackHtml(cls()) : "";
        const tile = (key, label, en, hitDie, saves, caster) => {
          const [icon, color, line] = WIZ_CLASS_LOOK[en] || ["crossed-swords", "", ""];
          return `<button type="button" class="wz-tile wz-tile-class" data-wiz-class="${esc(key)}" aria-pressed="${key === c.class_key}"${color ? ` style="--wz-c:${color}"` : ""}>
            <span class="wz-medal">${wizIcon(icon)}</span>
            <span class="wz-tile-name">${esc(label)}</span>
            ${line ? `<span class="wz-tile-line">${esc(line)}</span>` : ""}
            <span class="wz-tile-stats"><span>${t("W{n}", { n: hitDie })}</span>${saves.length ? `<span>${t("RW {list}", { list: saves.map((s) => ABILITY_SHORT[s] || s).join("/") })}</span>` : ""}${caster ? `<span>${caster}</span>` : ""}</span>
          </button>`;
        };
        return `<p>${t("Wähle die Klasse deines Charakters.")}</p>
          <div class="wz-tiles wz-tiles-class">
            ${Object.entries(CLASSES).map(([k, cl]) => tile(k, cl.label, cl.en, cl.hitDie, cl.saves, cl.spell && WIZ_CASTER[cl.spell.type])).join("")}
            ${libClasses.map((o) => {
              const r = optionRef(o);
              return tile(`lib:${o.id}`, optionLabel(o), String(o.name_en || o.name).toLowerCase(), r.hit_die || 8, r.saves || [], "");
            }).join("")}
          </div>
          ${WIZ_ICON_CREDIT}
          <div class="lu-option-info">${info}</div>`;
      },
      valid: () => (c.class_key ? true : t("Klasse wählen.")),
    },
    {
      title: t("Unterklasse"),
      skip: () => !subclassFeature(),
      html: () => {
        const f = subclassFeature();
        const list = subclassChoices();
        const ref = c.subclass_ref;
        const full = ref && optionById(ref.id);
        return `<p>${t("Als {class} wählst du schon auf Stufe 1 deine Unterklasse{feature}.", { class: esc(cls().label), feature: f ? ` (${esc(localized(f.name, f.name_de))})` : "" })}</p>
          ${f && f.desc ? `<details class="wz-details"><summary>${t("Was das bedeutet")}</summary>${deTextHtml(f.desc, f.desc_de, optionTextHtml)}</details>` : ""}
          ${list.length
            ? `<select class="cs-info-val lu-select" data-wiz="subclass"><option value="">${t("-- Unterklasse wählen --")}</option>${list
                .map((o) => `<option value="${o.id}" ${ref && ref.id === o.id ? "selected" : ""}>${esc(optionLabel(o))}</option>`)
                .join("")}</select>`
            : `<p class="pc-warn">${t("Die Bibliothek hat keine Unterklassen für diese Klasse. Bitte später auf dem Blatt eintragen.")}</p>`}
          <div class="lu-option-info">${full ? optionInfoHtml(full) : ""}</div>`;
      },
      valid: () => (c.subclass_ref || subclassChoices().length === 0 ? true : t("Unterklasse wählen.")),
    },
    {
      title: t("Hintergrund"),
      html: () => {
        const ref = c.background_ref;
        const full = ref && optionById(ref.id);
        return `<p>${t("Wähle den Hintergrund deines Charakters.")}</p>
          ${groupTilesHtml("backgrounds", [{ label: "", groups: backgroundTileGroups() }])}
          <div class="lu-option-info">${full ? optionInfoHtml(full) : ""}</div>`;
      },
      valid: () => (c.background_ref || charOptions("backgrounds").length === 0 ? true : t("Hintergrund wählen.")),
    },
    {
      title: t("Talente"),
      skip: () => !featsDraft().length && !speciesFeatGrant(),
      html: () => {
        const bg = backgroundFeat({ background_ref: c.background_ref, feats: [] });
        const g = speciesFeatGrant();
        const list = speciesFeatList();
        const pick = c.feat_pick && optionById(Number(c.feat_pick));
        const info = (o) => (o ? `<div class="lu-option-info">${optionInfoHtml(o)}</div>` : "");
        return `${bg ? `<p>${t("Dein Hintergrund gibt dir das Herkunftstalent <b>{feat}</b>.", { feat: esc(featLabel({ id: bg.option.id, name: bg.option.name, detail: bg.detail })) })}</p>${info(bg.option)}` : ""}
          ${g ? `<p>${g.origin ? t("{trait} (Volk): wähle ein Herkunftstalent.", { trait: esc(g.trait) }) : t("{trait} (Volk): wähle ein Talent.", { trait: esc(g.trait) })}</p>
            ${list.length
              ? `<select class="cs-info-val lu-select" data-wiz="feat"><option value="">${t("-- Talent wählen --")}</option>${list
                  .map((o) => `<option value="${o.id}" ${pick && pick.id === o.id ? "selected" : ""}>${esc(optionLabel(o))}</option>`)
                  .join("")}</select>${info(pick)}`
              : `<p class="pc-warn">${t("Die Bibliothek hat keine passenden Talente. Bitte später auf dem Blatt eintragen.")}</p>`}` : ""}
          <p class="pc-hint">${t("Erhöht ein Talent ein Attribut, verteilst du den Punkt im nächsten Schritt. Was es sonst bewirkt (Initiative, Zauber …), steht in der Beschreibung; das trägst du auf dem Blatt selbst ein.")}</p>`;
      },
      valid: () => (!speciesFeatGrant() || c.feat_pick || !speciesFeatList().length ? true : t("Talent wählen.")),
    },
    {
      title: t("Aus der Unterklasse"),
      skip: () => !hasSubStep(),
      html: () => {
        const p = subPlan();
        const skillName = (k) => (SKILLS.find((sk) => sk[0] === k) || [, k])[1];
        const spellLink = (sp, name) => (sp ? `<span class="cs-info-link" data-wiz-spell-info="${sp.id}" title="${t("Beschreibung anzeigen")}">${esc(sp.name)}</span>` : esc(name));
        const fixedRow = (e) => {
          const what = e.kind === "prof" ? t("Übung: <b>{name}</b>", { name: esc(e.label) })
            : e.kind === "skill" ? t("Fertigkeit: <b>{name}</b>", { name: esc(skillName(e.skill)) })
            : `${e.sp && e.sp.level_int === 0 ? t("Zaubertrick:") : t("Zauber:")} ${spellLink(e.sp, e.name)}${e.ritual_only ? ` ${t("(nur als Ritual)")}` : ""}${e.sp ? "" : ` <span class="pc-warn">${t("nicht in der Zauberliste")}</span>`}`;
          return `<label class="wz-check"><input type="checkbox" data-sub-fixed="${esc(e.key)}" ${c.sub_off.has(e.key) ? "" : "checked"} />
            <span>${what} <span class="pc-ab">· ${esc(e.src)}</span></span></label>`;
        };
        const choiceHtml = (ch) => {
          const set = c.sub_picks[ch.key] || new Set();
          const need = choiceNeed(p, ch);
          const count = `<span class="pc-count ${set.size === need ? "" : "warn"}">${set.size}/${need}</span>`;
          if (ch.kind === "skills") {
            const opts = skillPool(ch)
              .map((k) => `<label class="wz-check"><input type="checkbox" data-sub-pick="${esc(ch.key)}" value="${k}" ${set.has(k) ? "checked" : ""} ${!set.has(k) && set.size >= need ? "disabled" : ""} />
                <span>${esc(skillName(k))}</span></label>`)
              .join("");
            return `<div class="wz-spell-head"><b>${esc(ch.src)}</b>: ${tn(ch.n, "{n} Fertigkeit", "{n} Fertigkeiten")}${ch.expertise ? ` ${t("mit doppeltem Übungsbonus (Expertise)")}` : ""} ${count}</div>
              <div class="wz-grid">${opts}</div>`;
          }
          const pool = choicePool(p, ch).sort((a, b) => a.level_int - b.level_int || a.name.localeCompare(b.name));
          const what = ch.cantrip ? (ch.n > 1 ? t("Zaubertricks") : t("Zaubertrick")) : ch.spell_level ? t("Zauber des Grades {n}", { n: ch.spell_level }) : t("Zauber (oder Zaubertricks)");
          const from = `${ch.school ? `${t("der Schule {school}", { school: esc(ch.school) })} ` : ""}${ch.lists ? t("von der Liste: {lists}", { lists: ch.lists.map((l) => esc(classLabelEn(l))).join(", ") }) : t("von beliebigen Listen")}`;
          const rows = pool
            .map((sp) => {
              const on = set.has(String(sp.id));
              return `<div class="wz-spell">
                <input type="checkbox" data-sub-pick="${esc(ch.key)}" value="${sp.id}" ${on ? "checked" : ""} ${!on && set.size >= need ? "disabled" : ""} aria-label="${t("{name} wählen", { name: esc(sp.name) })}" />
                <span class="wz-spell-name">${spellLink(sp)}</span>
                <span class="wz-meta">${esc(sp.school || "")}${sp.level_int ? ` · ${t("Grad {n}", { n: sp.level_int })}` : ""}</span>
              </div>`;
            })
            .join("");
          return `<div class="wz-spell-head"><b>${esc(ch.src)}</b>: ${ch.n} ${what} ${from}, ${t("gilt als {class}-Zauber", { class: esc(classLabelEn(p.parentEn)) })} ${count}</div>
            ${need ? `<div class="wz-spells">${rows}</div>` : `<p class="pc-warn">${t("Keine passenden Zauber in der Zauberliste.")}</p>`}`;
        };
        return `<p>${t("Was <b>{name}</b> auf Stufe 1 mitbringt:", { name: esc(optionLabel(p.o)) })}</p>
          ${p.fixed.length ? `<div class="wz-grid">${p.fixed.map(fixedRow).join("")}</div>` : ""}
          ${p.choices.map(choiceHtml).join("")}
          <p class="pc-hint">${t("Zauber aus der Unterklasse sind immer vorbereitet und zählen nicht zu den Zaubertricks oder vorbereiteten Zaubern der Klasse (U auf dem Blatt). Erkannt aus den englischen Merkmalstexten der Bibliothek: Häkchen entfernen, was nicht passt.")}</p>`;
      },
      valid: () => {
        const p = subPlan();
        if (!p) return true;
        for (const ch of p.choices) {
          if ((c.sub_picks[ch.key] || new Set()).size !== choiceNeed(p, ch)) return t("{source}: noch auswählen.", { source: ch.src });
        }
        return true;
      },
    },
    {
      title: t("Attribute"),
      html: () => {
        const dd = d();
        const cl = cls();
        const castWith = cl && cl.spell ? cl.spell.ability : null;
        const rows = ABILITIES.map(([key, short, long]) => {
          const base = c.ability_base[key];
          const mark = key === castWith
            ? ` <span class="wz-cast" title="${t("{class} wirkt Zauber mit {ability}: Angriffswurf und Rettungswurf-SG der Zauber hängen davon ab.", { class: esc(cl.label), ability: long })}">✦ ${t("Zauber")}</span>`
            : "";
          return `<div class="wz-abil-row">
            <span class="wz-abil-name">${long} (${short})${mark}</span>
            <input type="number" min="1" max="20" data-wiz-ability="${key}" value="${base ?? ""}" placeholder="10" aria-label="${t("{ability}, Grundwert", { ability: long })}" />
            <span class="wz-abil-calc" data-wiz-abil-calc="${key}">${abilityCalcHtml(base, dd.ability_bonus[key])}</span>
          </div>`;
        }).join("");
        return `<p>${t("Trage die Grundwerte deiner Attribute ein (1–20, ohne die Boni von Volk und Hintergrund).")}</p>
          ${castWith ? `<p class="pc-hint">✦ ${t("{class} wirkt Zauber mit <b>{ability}</b>: ein hoher Wert dort macht die Zauber treffsicherer und schwerer abzuwehren.", { class: esc(cl.label), ability: esc(ABILITIES.find(([k]) => k === castWith)[2]) })}</p>` : ""}
          <div class="wz-abil">
            <div class="wz-abil-row wz-abil-head"><span>${t("Attribut")}</span><span>${t("Grundwert")}</span><span class="wz-abil-calc"><span>${t("Erhöhung")}</span><span>${t("Ergebnis")}</span><span>${t("Modifikator")}</span></span></div>
            ${rows}
          </div>
          <div class="cs-panel pc-asi" data-asi-panel>${asiPanelHtml(dd)}</div>`;
      },
      valid: () => {
        const bad = ABILITIES.find(([k]) => {
          const v = c.ability_base[k];
          return v === undefined || v === null || v < 1 || v > 20;
        });
        if (bad) return t("Alle sechs Attribute eintragen (1–20).");
        const { points, used } = asiPoints();
        if (used > points) return t("Zu viele Attributspunkte verteilt: {n} von {max}.", { n: used, max: points });
        if (used < points) return t("Noch {what} verteilen.", { what: tn(points - used, "{n} Attributspunkt", "{n} Attributspunkte") });
        return true;
      },
    },
    {
      title: t("Fertigkeiten"),
      html: () => {
        const dd = d();
        const xx = x();
        const b = skillBudget(dd, xx);
        const full = b.total !== null && c.skill_prof.length >= b.total;
        const expFull = c.skill_expertise.length >= b.expertise;
        const rows = SKILLS.map(([key, label, ab]) => {
          const prof = c.skill_prof.includes(key);
          const fixed = c.skill_fixed[key];
          const exp = c.skill_expertise.includes(key);
          const expBox = b.expertise
            ? `<input type="checkbox" class="cs-dot" data-wiz-expert="${key}" ${exp ? "checked" : ""} ${prof && (exp || !expFull) && !c.exp_fixed.includes(key) ? "" : "disabled"} title="${c.exp_fixed.includes(key) ? t("Expertise durch Unterklasse") : t("Expertise (doppelter Übungsbonus)")}" />`
            : "";
          return `
            <div class="pc-check-row">
              <input type="checkbox" class="cs-dot" data-wiz-skill="${key}" ${prof ? "checked" : ""} ${fixed || (!prof && full) ? "disabled" : ""} title="${fixed ? t("Geübt durch {source}", { source: wizSource(fixed) }) : t("Geübt")}" />
              ${expBox}
              <span class="pc-check-name">${label} <span class="pc-ab">(${ABILITY_SHORT[ab]})</span>${fixed ? ` <span class="pc-ab">· ${wizSource(fixed)}</span>` : ""}</span>
            </div>`;
        }).join("");
        const cl = cls();
        const classHint = cl && cl.skills
          ? `<div class="pc-hint">${cl.skills[1] ? t("Klasse: {n} aus {list}.", { n: cl.skills[0], list: cl.skills[1].map((k) => (SKILLS.find((s) => s[0] === k) || [k, k])[1]).join(", ") }) : t("Klasse: {n} beliebige.", { n: cl.skills[0] })}</div>`
          : "";
        return `<p>${t("Wähle deine geübten Fertigkeiten. Was Volk, Hintergrund und Unterklasse geben, ist schon angekreuzt.")}
            <span class="pc-legend">● ${t("geübt")}${b.expertise ? ` · ◆ ${t("Expertise")}` : ""}</span></p>
          <div class="pc-checks">${rows}</div>
          ${classHint}
          <div class="pc-hint">${skillCountHtml(dd, xx) || t("Keine Klassen-/Hintergrundangabe zum Budget gefunden.")}</div>`;
      },
      valid: () => {
        const b = skillBudget(d(), x());
        const have = c.skill_prof.length;
        if (b.total !== null && have > b.total) return t("Zu viele Fertigkeiten: {n} von {max}.", { n: have, max: b.total });
        if (b.total !== null && have < b.total) return t("Noch {what} wählen.", { what: tn(b.total - have, "{n} Fertigkeit", "{n} Fertigkeiten") });
        const exp = c.skill_expertise.length;
        if (exp > b.expertise) return t("Zu viele Expertisen: {n} von {max}.", { n: exp, max: b.expertise });
        if (exp < b.expertise) return t("Noch {n} Expertise wählen.", { n: b.expertise - exp });
        return true;
      },
    },
    {
      title: t("Sprachen"),
      html: () => {
        const ls = langState();
        const full = ls.total !== null && ls.count >= ls.total;
        const groups = WIZ_LANGUAGES.map(([title, keys]) => {
          const boxes = keys
            .map((k) => {
              const name = LANGUAGES_DE[k];
              const given = ls.named.includes(name);
              const on = given || c.lang.has(k);
              return `<label class="wz-check"><input type="checkbox" data-wiz-lang="${k}" ${on ? "checked" : ""} ${given || (!on && full) ? "disabled" : ""} />
                <span>${esc(name)}${given ? ` <span class="pc-ab">· ${t("vorgegeben")}</span>` : ""}</span></label>`;
            })
            .join("");
          return `<div class="pc-spell-level-label">${title}</div><div class="wz-grid">${boxes}</div>`;
        }).join("");
        const given = ls.named.filter((n) => !Object.values(LANGUAGES_DE).includes(n));
        const budget = ls.total === null
          ? t("Volk und Hintergrund nennen keine Sprachen: wähle, was mit der Spielleitung abgesprochen ist.")
          : `${ls.parts.map(([l, g]) => `${wizSource(l)}: ${[...g.named, g.free ? t("{n} frei wählbar", { n: g.free }) : ""].filter(Boolean).join(", ")}`).join(" · ")}`;
        return `<p>${t("Wähle die Sprachen deines Charakters. Was Volk und Hintergrund vorgeben, ist schon angekreuzt.")}</p>
          ${given.length ? `<p>${t("Vorgegeben: {list}", { list: esc(given.join(", ")) })}</p>` : ""}
          ${groups}
          <div class="pc-spell-level-label">${t("Weitere Sprachen")}</div>
          <input class="wz-wide" data-wiz="lang-other" value="${esc(c.lang_other)}" placeholder="${t("z.B. Diebessprache (mit Komma trennen)")}" />
          <div class="pc-hint">${esc(budget)}${ls.total !== null ? ` <span class="pc-count ${ls.count === ls.total ? "" : "warn"}">${ls.count}/${ls.total}</span>` : ""}</div>`;
      },
      valid: () => {
        const ls = langState();
        if (ls.total === null) return true;
        if (ls.count > ls.total) return t("Zu viele Sprachen: {n} von {max}.", { n: ls.count, max: ls.total });
        if (ls.count < ls.total) return t("Noch {what} wählen.", { what: tn(ls.total - ls.count, "{n} Sprache", "{n} Sprachen") });
        return true;
      },
    },
    {
      title: t("Zauber"),
      skip: () => !x().spell,
      html: () => {
        const s = spellNeeds();
        const dd = d();
        const xx = x();
        const group = (title, pool, set, need, attr) => {
          if (!need) return "";
          const rows = [...pool]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((sp) => {
              const on = set.has(String(sp.id));
              const marks = `${sp.concentration ? `<span class="pc-mark" title="${t("Konzentration")}">${t("K")}</span>` : ""}${sp.ritual ? `<span class="pc-mark" title="${t("Ritual")}">R</span>` : ""}`;
              return `<div class="wz-spell">
                <input type="checkbox" ${attr}="${sp.id}" ${on ? "checked" : ""} ${!on && set.size >= need ? "disabled" : ""} aria-label="${t("{name} wählen", { name: esc(sp.name) })}" />
                <span class="wz-spell-name"><span class="cs-info-link" data-wiz-spell-info="${sp.id}" title="${t("Beschreibung anzeigen")}">${esc(sp.name)}</span>${marks}</span>
                <span class="wz-meta">${esc(sp.school || "")}</span>
              </div>`;
            })
            .join("");
          return `<div class="wz-spell-head"><b>${title}</b> <span class="pc-count ${set.size === need ? "" : "warn"}">${set.size}/${need}</span></div>
            <div class="wz-spells">${rows}</div>`;
        };
        const prepared = xx.spell && xx.spell.prepared !== null && !isSpellbook(dd)
          ? `<p class="pc-hint">${t("Vorbereitete Zauber: {n} pro Tag, gewählt nach einer langen Rast.", { n: xx.spell.prepared })}</p>`
          : "";
        return `<p>${t("Kreuze deine Zauber an. Ein Klick auf den Namen zeigt die Beschreibung.")}</p>
          ${group(t("Zaubertricks"), s.cantripPool, c.cantrips, s.cantrips, "data-cantrip")}
          ${group(isSpellbook(dd) ? t("Zauber im Zauberbuch (Grad 1)") : t("Bekannte Zauber (Grad 1)"), s.spellPool, c.spells, s.spells, "data-spell")}
          ${prepared}
          ${s.short ? `<p class="pc-warn">${t("Die Zauberliste der Bibliothek hat weniger Zauber dieser Klasse, als jetzt gewählt werden dürften.")}</p>` : ""}`;
      },
      valid: () => {
        const s = spellNeeds();
        if (!s) return true;
        const left = s.cantrips - c.cantrips.size + (s.spells - c.spells.size);
        return left === 0 ? true : t("Noch {what} wählen.", { what: tn(left, "{n} Zauber", "{n} Zauber") });
      },
    },
    {
      title: t("Ausrüstung"),
      html: () => {
        const groups = gearGroupsNow();
        let lastSource = null;
        const body = groups
          .map((g, gi) => {
            const head = g.source !== lastSource ? `<div class="pc-spell-level-label">${g.source}</div>` : "";
            lastSource = g.source;
            const choice = g.options.length > 1;
            const opts = g.options
              .map((o, oi) => {
                const on = c.equip_pick[gi] === oi;
                const selects = o.pieces
                  .map((p, pi) => {
                    if (!p.generic) return "";
                    const weapons = genericWeapons(p.generic);
                    return Array.from({ length: p.qty }, (_, n) => {
                      const key = `${gi}:${oi}:${pi}:${n}`;
                      const sel = c.equip_any[key];
                      return `<span class="wz-equip-any-pick"><select data-equip-any="${key}" ${on ? "" : "disabled"}>
                        <option value="">${esc(p.name)} …</option>
                        ${weapons.map((it) => `<option value="${it.id}" ${String(sel) === String(it.id) ? "selected" : ""}>${esc(it.name)}</option>`).join("")}
                      </select>${sel ? gearStatsHtml(libItem(sel)) : ""}</span>`;
                    }).join("");
                  })
                  .join("");
                return `<div class="wz-equip-opt ${on ? "on" : ""}">
                  <label class="wz-check"><input type="checkbox" data-equip-pick="${gi}:${oi}" ${on ? "checked" : ""} />
                    <span>${choice ? `<b>(${String.fromCharCode(97 + oi)})</b> ` : ""}${o.title ? `<b>${esc(o.title)}:</b> ` : ""}${o.pieces.map(pieceHtml).join(", ")}${packsHtml(o.pieces)}</span></label>
                  ${selects ? `<div class="wz-equip-any">${selects}</div>` : ""}
                </div>`;
              })
              .join("");
            return `${head}<div class="wz-equip-group ${choice ? "choice" : ""}">
              ${g.label ? `<div class="wz-meta">${esc(g.label)}</div>` : ""}
              ${choice ? `<div class="wz-meta">${t("Eines davon wählen:")}</div>` : ""}${opts}</div>`;
          })
          .join("");
        const gear = draftGear();
        const inv = gear.inv.map((e) => `${e.qty > 1 ? `${e.qty}× ` : ""}${esc(e.name)}${e.equipped ? " ✓" : ""}`);
        const ammo = gear.ammo.map((a) => `${a.count} ${esc(a.name)}`);
        const coins = COINS.filter(([k]) => gear.coins[k]).map(([k, l]) => `${gear.coins[k]} ${l}`);
        const summary = [...inv, ...ammo, ...coins];
        const open = groups.filter((g, gi) => g.options.length > 1 && (c.equip_pick[gi] === null || c.equip_pick[gi] === undefined)).length;
        const openHint = open ? `<p class="pc-warn">${t("Noch {what} offen (a, b …): ohne Haken kommt davon nichts ins Inventar.", { what: tn(open, "{n} Auswahl", "{n} Auswahlen") })}</p>` : "";
        return `<p>${t("Kreuze deine Startausrüstung an. Alles Angekreuzte kommt ins Inventar; Rüstung, Schild und Waffen werden gleich ausgerüstet (✓).")}</p>
          ${body || `<p class="pc-hint">${t("Klasse und Hintergrund haben keine Ausrüstungsvorschläge in der Bibliothek.")}</p>`}
          ${openHint}
          <div class="cs-panel wz-equip-sum"><div class="cs-panel-title">${t("Ins Inventar")}</div>${summary.length ? summary.join(", ") : `<span class="pc-hint">${t("Noch nichts gewählt.")}</span>`}</div>
          <div class="pc-spell-level-label">${t("Weitere Ausrüstung / Notizen")}</div>
          <textarea class="cs-area" rows="3" data-wiz="equipment" placeholder="${t("Frei, z.B. Erbstück, Schmuckstück")}">${esc(c.equipment)}</textarea>`;
      },
      valid: () => true,
    },
    {
      title: t("Charakterblatt"),
      html: () => {
        const g = hp1();
        return `<p class="pc-hint">${t("Trefferpunkte auf Stufe 1: <b>{total}</b> (Trefferwürfel-Maximum W{die} {sign} {con} KON).", { total: g.total, die: g.die, sign: g.con >= 0 ? "+" : "−", con: Math.abs(g.con) })}
            ${actions.portrait ? (character.avatar_path ? t("Oben links kannst du das Portrait ändern.") : t("Oben links kannst du ein Portrait deines Charakters hochladen. Bis dahin zeigt das Blatt das Bild deiner Klasse.")) : ""}</p>
          <div class="pc-warn" data-portrait-msg hidden></div>
          ${pcSheetHtml({ ...draftEntity(), max_hp: g.total, current_hp: g.total }, false, { portrait: character.avatar_path, portraitEdit: !!actions.portrait, portraitFallback: classPortraitUrl(c.class_key, c.class_ref) })}`;
      },
      valid: () => true,
    },
  ];

  let dlg = document.getElementById("cs-creation");
  if (!dlg) {
    dlg = document.createElement("dialog");
    dlg.id = "cs-creation";
    dlg.className = "cs-popup lu";
    document.body.appendChild(dlg);
  }
  let i = 0;
  let busy = false;

  const visible = (n) => !(steps[n].skip && steps[n].skip());

  const draw = () => {
    syncFixedSkills();
    const step = steps[i];
    const ok = step.valid();
    const last = i === steps.length - 1;
    const scroll = dlg.querySelector(".lu-body")?.scrollTop || 0;
    const sameStep = dlg.dataset.step === String(i);
    // The finished sheet needs the room of the real one, to show its columns the same way.
    dlg.classList.toggle("lu-wide", last);
    dlg.innerHTML = `
      <div class="cs-popup-body">
        <button type="button" class="cs-popup-close" aria-label="${t("Abbrechen")}">✕</button>
        <h3>${t("Charakter erstellen")}${character.name ? `: ${esc(character.name)}` : ""}</h3>
        <ol class="lu-steps">${steps.map((s, n) => (visible(n) ? `<li class="${n === i ? "now" : n < i ? "done" : ""}">${s.title}</li>` : "")).join("")}</ol>
        <div class="lu-body char-sheet">${step.html()}</div>
        <div class="lu-nav">
          <button type="button" class="ghost pc-btn" data-back ${i === 0 || busy ? "disabled" : ""}>${t("Zurück")}</button>
          <span class="pc-hint lu-why">${ok === true ? "" : esc(ok)}</span>
          ${last
            ? `<button type="button" class="ghost pc-btn" data-discard ${busy ? "disabled" : ""}>${t("Verwerfen")}</button>
               <button type="button" class="pc-btn lu-next" data-save ${busy ? "disabled" : ""}>${t("Speichern")}</button>`
            : `<button type="button" class="pc-btn lu-next" data-next ${ok === true && !busy ? "" : "disabled"}>${t("Weiter")}</button>`}
        </div>
      </div>`;
    // Ticking a box redraws the step: keep the list where it was.
    if (sameStep) dlg.querySelector(".lu-body").scrollTop = scroll;
    dlg.dataset.step = String(i);
  };

  // Typing only updates the button/hint, so the field keeps its focus (see levelup.js).
  const refreshNav = () => {
    const ok = steps[i].valid();
    const nextBtn = dlg.querySelector("[data-next]");
    if (nextBtn) nextBtn.disabled = ok !== true || busy;
    const why = dlg.querySelector(".lu-why");
    if (why) why.textContent = ok === true ? "" : ok;
  };

  function stepForward() {
    i++;
    while (i < steps.length - 1 && !visible(i)) i++;
    draw();
  }
  function stepBack() {
    i--;
    while (i > 0 && !visible(i)) i--;
    draw();
  }

  async function doSave() {
    const g = hp1();
    const entity = { ...draftEntity(), max_hp: g.total };
    const tmp = document.createElement("div");
    tmp.innerHTML = pcSheetHtml(entity, true);
    const body = readPcSheet(tmp);
    body.max_hp = g.total;
    busy = true;
    draw();
    try {
      await actions.save(body, entity.play_state);
      dlg.close();
    } catch (e) {
      busy = false;
      draw();
      dlg.querySelector(".lu-why").textContent = (e && e.message) || t("Nicht gespeichert. Verbindung prüfen.");
    }
  }

  async function doDiscard() {
    if (!confirm(t("Charakter verwerfen? Alle Angaben gehen verloren."))) return;
    busy = true;
    draw();
    try {
      await actions.discard();
      dlg.close();
    } catch {
      busy = false;
      draw();
      dlg.querySelector(".lu-why").textContent = t("Nicht gelöscht. Verbindung prüfen.");
    }
  }

  // The portrait is uploaded right away (the draft character already exists on the server).
  async function doPortrait(file) {
    const msg = dlg.querySelector("[data-portrait-msg]");
    try {
      const fresh = await actions.portrait(file);
      character.avatar_path = fresh.avatar_path;
      draw();
    } catch (e) {
      if (!msg) return;
      msg.textContent = e && e.status === 400 ? t("Dieses Bildformat geht nicht (PNG, JPG, WebP oder GIF).") : t("Bild nicht gespeichert. Verbindung prüfen.");
      msg.hidden = false;
    }
  }

  dlg.onclick = (e) => {
    if (e.target.closest("[data-portrait-remove]")) return doPortrait(null);
    if (e.target === dlg || e.target.closest(".cs-popup-close")) {
      if (i === 0 || confirm(t("Charaktererstellung abbrechen? Deine Auswahl geht verloren."))) dlg.close();
      return;
    }
    // Spell names and library items explain themselves in a popup above the wizard. On the last
    // step the sheet's own handler (charsheet.js, inside .pc-sheet) does that already.
    const spellInfo = e.target.closest("[data-wiz-spell-info]");
    if (spellInfo) {
      const sp = findSpell({ id: spellInfo.dataset.wizSpellInfo });
      if (sp) showSheetPopup(null, spellSheetHtml(sp));
      return;
    }
    const info = e.target.closest("[data-info]");
    if (info && !info.closest(".pc-sheet")) {
      e.preventDefault(); // inside a <label>: don't tick the box as well
      if (info.dataset.info.startsWith("opt:")) openOptionInfo(info.dataset.info);
      else {
        const content = sheetInfoContent(info);
        if (content) showSheetPopup(...content);
      }
      return;
    }
    const btn = e.target.closest("button");
    if (!btn || btn.disabled) return;
    if (btn.dataset.wizTile) {
      const kind = btn.dataset.wizTile;
      const g = tileGroups[kind]().find((g) => g.name === btn.dataset.name);
      if (!g) return;
      openTile[kind] = g.name;
      // One entry only: chosen right away. Otherwise a variant of the new tile is still to pick.
      const ref = c[refKey[kind]];
      if (g.list.length === 1) selectOption(kind, g.list[0]);
      else if (!ref || !g.list.some((o) => o.id === ref.id)) selectOption(kind, null);
      draw();
      dlg.querySelector(".wz-variants")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      return;
    }
    if (btn.dataset.wizPick) {
      const kind = btn.dataset.wizPick;
      selectOption(kind, charOptions(kind).find((o) => String(o.id) === btn.dataset.id));
      return draw();
    }
    if (btn.dataset.wizClass) {
      const key = btn.dataset.wizClass;
      if (key === c.class_key) return;
      selectClass(key, key.startsWith("lib:") ? optionRef(optionById(Number(key.slice(4)))) : null);
      return draw();
    }
    if (btn.hasAttribute("data-next")) return stepForward();
    if (btn.hasAttribute("data-back")) return stepBack();
    if (btn.hasAttribute("data-save")) return doSave();
    if (btn.hasAttribute("data-discard")) return doDiscard();
  };

  dlg.onchange = (e) => {
    const t = e.target;
    if (t.matches("[data-portrait-input]")) {
      if (t.files[0]) doPortrait(t.files[0]);
      return;
    }
    if (t.dataset.wiz === "feat") {
      c.feat_pick = t.value;
      fitChoice();
    } else if (t.dataset.wiz === "subclass") {
      c.subclass_ref = optionRef(subclassChoices().find((o) => String(o.id) === t.value)) || null;
      c.sub_off.clear();
      c.sub_picks = {};
    } else if (t.dataset.subFixed) {
      if (t.checked) c.sub_off.delete(t.dataset.subFixed);
      else c.sub_off.add(t.dataset.subFixed);
    } else if (t.dataset.subPick) {
      const set = (c.sub_picks[t.dataset.subPick] = c.sub_picks[t.dataset.subPick] || new Set());
      if (t.checked) set.add(t.value);
      else set.delete(t.value);
    } else if (t.dataset.asiChoice) {
      c.ability_choice[t.dataset.asiChoice] = Number(t.value) || 0;
    } else if (t.dataset.wizSkill) {
      const k = t.dataset.wizSkill;
      if (t.checked) { if (!c.skill_prof.includes(k)) c.skill_prof.push(k); }
      else {
        c.skill_prof = c.skill_prof.filter((s) => s !== k);
        c.skill_expertise = c.skill_expertise.filter((s) => s !== k);
      }
    } else if (t.dataset.wizExpert) {
      const k = t.dataset.wizExpert;
      if (t.checked) { if (!c.skill_expertise.includes(k)) c.skill_expertise.push(k); }
      else c.skill_expertise = c.skill_expertise.filter((s) => s !== k);
    } else if (t.dataset.wizLang) {
      if (t.checked) c.lang.add(t.dataset.wizLang);
      else c.lang.delete(t.dataset.wizLang);
    } else if (t.dataset.wiz === "lang-other") {
      c.lang_other = t.value;
    } else if (t.dataset.cantrip || t.dataset.spell) {
      const set = t.dataset.cantrip ? c.cantrips : c.spells;
      const id = t.dataset.cantrip || t.dataset.spell;
      if (t.checked) set.add(id);
      else set.delete(id);
    } else if (t.dataset.equipPick) {
      // Within a group the options exclude each other, like (a) or (b) in the rules.
      const [gi, oi] = t.dataset.equipPick.split(":").map(Number);
      c.equip_pick[gi] = t.checked ? oi : null;
    } else if (t.dataset.equipAny) {
      c.equip_any[t.dataset.equipAny] = t.value || undefined;
    } else return;
    draw();
  };

  dlg.oninput = (e) => {
    const t = e.target;
    if (t.dataset.wizAbility) {
      const k = t.dataset.wizAbility;
      const v = t.value === "" ? undefined : parseInt(t.value, 10);
      c.ability_base[k] = Number.isFinite(v) ? v : undefined;
      const calcEl = dlg.querySelector(`[data-wiz-abil-calc="${k}"]`);
      if (calcEl) calcEl.innerHTML = abilityCalcHtml(c.ability_base[k], d().ability_bonus[k]);
    } else if (t.dataset.wiz === "lang-other") {
      c.lang_other = t.value;
    } else if (t.dataset.wiz === "equipment") {
      c.equipment = t.value;
    } else return;
    refreshNav();
  };

  dlg.addEventListener("close", () => actions.onClose && actions.onClose(), { once: true });

  draw();
  dlg.showModal();
}
