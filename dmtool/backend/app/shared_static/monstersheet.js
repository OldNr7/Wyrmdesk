// Monster sheet and the helpers around it, shared by the Kampagnenbuch (bestiary) and the combat tracker
// (encounters). Player characters use the full sheet from charsheet.js, which must be loaded first.
// Expects the page to define escapeHtml().

const TYPE_ICONS = {
  aberration: "🐙",
  beast: "🐺",
  celestial: "👼",
  construct: "🤖",
  dragon: "🐉",
  elemental: "🔥",
  fey: "🧚",
  fiend: "😈",
  giant: "🧌",
  humanoid: "👤",
  monstrosity: "🦖",
  ooze: "🟢",
  plant: "🌿",
  undead: "💀",
};

function iconFor(kind, creatureType) {
  if (kind === "pc") return "🧑";
  const key = (creatureType || "").toLowerCase();
  for (const [type, icon] of Object.entries(TYPE_ICONS)) {
    if (key.includes(type)) return icon;
  }
  return "👹";
}

function typeOptionsHtml(selected) {
  const sel = (selected || "").toLowerCase();
  let html = `<option value="" ${sel ? "" : "selected"}>${t("-- kein Typ --")}</option>`;
  for (const type of Object.keys(TYPE_ICONS)) {
    const label = type.charAt(0).toUpperCase() + type.slice(1);
    html += `<option value="${type}" ${sel === type ? "selected" : ""}>${TYPE_ICONS[type]} ${label}</option>`;
  }
  // Open5e types like "swarm of Tiny beasts" aren't in the list; keep them selectable so saving doesn't wipe them.
  if (sel && !(sel in TYPE_ICONS)) {
    html += `<option value="${escapeHtml(selected)}" selected>${iconFor("monster", selected)} ${escapeHtml(selected)}</option>`;
  }
  return html;
}

// ---------- character / monster sheet ----------
// The player character sheet and its helpers live in charsheet.js (also used by /spieler/).

// One layout for PCs and monsters in both modes, styled after the classic D&D character sheet.
// editable=false renders plain values, editable=true renders inputs in the same boxes.
// Player characters get the full class-aware sheet from charsheet.js.
// Monster fields the shared sheet (charsheet.js) has no place for: rows of their own here.
const MONSTER_PROFICIENCIES = [["saving_throws", t("Rettungswürfe")], ["skills", t("Fertigkeiten")]];
const MONSTER_EXTRA_KEYS = ["saving_throws", "skills", "alignment"];
// stat_block.size as the rules write it (Open5e, D&D Beyond), shown in German.
const MONSTER_SIZES = [["Tiny", t("Winzig")], ["Small", t("Klein")], ["Medium", t("Mittelgross")], ["Large", t("Gross")],
  ["Huge", t("Riesig")], ["Gargantuan", t("Gigantisch")]];
const sizeLabel = (s) => (MONSTER_SIZES.find(([k]) => k.toLowerCase() === String(s || "").toLowerCase()) || [s, s])[1];

// Markdown where the page has the renderer (the Kampagnenbuch loads marked), else plain lines.
function monsterMarkdown(text) {
  if (window.marked?.parse) return window.marked.parse(text, { gfm: true, breaks: true });
  return escapeHtml(text).replace(/\n/g, "<br>");
}

function charSheetHtml(entity, editable, kind = "pc") {
  if (kind !== "monster") return pcSheetHtml(entity, editable);
  const isMonster = kind === "monster";
  const f = sheetFields(entity, kind);
  const sb = (entity && entity.stat_block) || {};
  for (const key of MONSTER_EXTRA_KEYS) f[key] = sb[key] || null;
  f.size = sb.size || null;
  const show =(v, fmt) => (valOrEmpty(v) === "" ? "–" : escapeHtml(String(fmt ? fmt(v) : v)));
  const field = (key, cls, { type = "text", placeholder = "", fmt } = {}) =>
    editable
      ? `<input class="${cls}" data-field="${key}" type="${type}" value="${escapeHtml(String(valOrEmpty(f[key])))}" placeholder="${placeholder}" />`
      : `<div class="${cls} ${String(valOrEmpty(f[key])).length > 10 ? "long" : ""}">${show(f[key], fmt)}</div>`;

  const sizeSel = (cur) => {
    const known = MONSTER_SIZES.some(([k]) => k.toLowerCase() === String(cur || "").toLowerCase());
    return `<select class="cs-info-val" data-field="size"><option value="">–</option>${MONSTER_SIZES.map(([k, l]) =>
      `<option value="${k}" ${String(cur || "").toLowerCase() === k.toLowerCase() ? "selected" : ""}>${l}</option>`).join("")}${
      cur && !known ? `<option value="${escapeHtml(cur)}" selected>${escapeHtml(cur)}</option>` : ""}</select>`;
  };
  const headerInfo = isMonster
    ? `
      <div class="cs-info">
        ${editable ? sizeSel(f.size) : `<div class="cs-info-val">${show(f.size, sizeLabel)}</div>`}
        <div class="cs-small-label">${t("Grösse")}</div>
      </div>
      <div class="cs-info">
        ${
          editable
            ? `<select class="cs-info-val" data-field="creature_type">${typeOptionsHtml(f.creature_type)}</select>`
            : `<div class="cs-info-val">${show(f.creature_type, capitalize)}</div>`
        }
        <div class="cs-small-label">${t("Typ")}</div>
      </div>
      <div class="cs-info">
        ${field("challenge_rating", "cs-info-val", { placeholder: "z.B. 1/4" })}
        <div class="cs-small-label">${t("Herausforderungsgrad")}</div>
      </div>
      ${editable || f.alignment ? `<div class="cs-info">
        ${field("alignment", "cs-info-val", { placeholder: t("z.B. chaotic evil") })}
        <div class="cs-small-label">${t("Gesinnung")}</div>
      </div>` : ""}`
    : `
      <div class="cs-info">
        ${field("race", "cs-info-val", { placeholder: t("z.B. Drachenblütiger") })}
        <div class="cs-small-label">${t("Rasse")}</div>
      </div>
      <div class="cs-info">
        ${field("char_class", "cs-info-val", { placeholder: t("z.B. Paladin") })}
        <div class="cs-small-label">${t("Klasse")}</div>
      </div>`;

  const abilities = ABILITIES.map(([key, short, long]) => {
    const score = f.abilities[key];
    const scoreEl = editable
      ? `<input class="cs-ability-score" data-ability="${key}" type="number" min="1" max="30" value="${valOrEmpty(score)}" placeholder="10" />`
      : `<div class="cs-ability-score">${show(score)}</div>`;
    return `
      <div class="cs-ability" title="${long}">
        <div class="cs-ability-label">${short}</div>
        <div class="cs-ability-mod" data-mod="${key}">${abilityMod(score)}</div>
        ${scoreEl}
      </div>`;
  }).join("");

  const senses = isMonster
    ? `<div class="cs-languages">
        ${field("senses", "cs-languages-val", { placeholder: t("z.B. Dunkelsicht 18 m") })}
        <div class="cs-small-label">${t("Sinne")}</div>
      </div>`
    : "";

  const defRows = (list) => list.filter(([key]) => editable || f[key])
    .map(([key, label]) => `
        <div class="cs-def-row">
          <div class="cs-def-label">${label}</div>
          ${field(key, "cs-def-val", { placeholder: "–" })}
        </div>`)
    .join("");
  const panel = (title, rows) => (rows ? `
        <div class="cs-panel">
          <div class="cs-panel-title">${title}</div>
          ${rows}
        </div>` : "");
  const defenses = isMonster
    ? panel(t("Rettungswürfe &amp; Fertigkeiten"), defRows(MONSTER_PROFICIENCIES))
      + panel(t("Resistenzen &amp; Immunitäten"), defRows(DEFENSES))
    : "";

  // The book's text (D&D Beyond import: description, variants, lair, madness), closed by default.
  const description = isMonster && sb.description
    ? `<details class="cs-panel cs-description">
        <summary class="cs-panel-title">${t("Beschreibung aus dem Buch")}</summary>
        <div class="prose">${monsterMarkdown(sb.description)}</div>
      </details>`
    : "";

  const features = isMonster
    ? FEATURE_SECTIONS.map(([key, title]) => {
        const items = sb[key] || [];
        const intro = key === "legendary_actions" && sb.legendary_desc ? sb.legendary_desc : "";
        if (items.length === 0 && !intro) return "";
        const entries = items
          // Spell lists are lines of their own ("At will: …").
          .map((i) => `<div class="cs-feature">${i.name ? `<b>${escapeHtml(i.name)}.</b> ` : ""}${escapeHtml(i.desc || "").replace(/\n/g, "<br>")}</div>`)
          .join("");
        return `
          <div class="cs-panel">
            <div class="cs-panel-title">${title}</div>
            ${intro ? `<div class="cs-feature">${escapeHtml(intro)}</div>` : ""}
            ${entries}
          </div>`;
      }).join("")
    : "";

  const notes =
    editable || f.notes
      ? `<div class="cs-notes">
          ${editable
            // A text area: the DM's notes can run over several lines.
            ? `<textarea class="cs-notes-val" data-field="notes" rows="6" style="width:100%;box-sizing:border-box;resize:vertical" placeholder="${isMonster ? t("Taktik, Beute, Hinweise …") : t("Merkmale, Ausrüstung, Hintergrund …")}">${escapeHtml(String(valOrEmpty(f.notes)))}</textarea>`
            : field("notes", "cs-notes-val")}
          <div class="cs-small-label">${t("Notizen")}</div>
        </div>`
      : "";

  return `
    <div class="char-sheet ${editable ? "editing" : ""} ${isMonster ? "monster" : ""}">
      <div class="cs-header">
        <div class="cs-name">
          ${field("name", "cs-name-val", { placeholder: t("Name") })}
          <div class="cs-small-label">${isMonster ? t("Monster") : t("Charaktername")}</div>
        </div>
        <div class="cs-header-info">${headerInfo}</div>
      </div>

      <div class="cs-combat">
        <div class="cs-ac" title="${t("Rüstungsklasse")}">
          <svg viewBox="0 0 24 28" aria-hidden="true"><path d="${SHEET_SHIELD_PATH}" /></svg>
          ${field("ac", "cs-ac-val", { type: "number", placeholder: "10" })}
          <div class="cs-ac-label">RK</div>
        </div>
        <div class="cs-box">
          ${field("initiative_bonus", "cs-box-val", { type: "number", placeholder: "0", fmt: signed })}
          <div class="cs-small-label">${t("Initiative")}</div>
        </div>
        <div class="cs-box">
          ${field("speed", "cs-box-val", { placeholder: "9 m" })}
          <div class="cs-small-label">${t("Bewegungsrate")}</div>
        </div>
        <div class="cs-box cs-hp">
          ${field("max_hp", "cs-box-val", { type: "number", placeholder: "HP" })}
          <div class="cs-small-label">${t("Trefferpunkte-Max.")}</div>
        </div>
      </div>

      <div class="cs-abilities">${abilities}</div>

      <div class="cs-extras">
        <div class="cs-passive">
          ${field("passive_perception", "cs-passive-val", { type: "number", placeholder: "10" })}
          <div class="cs-passive-label">${t("Passive Wahrnehmung")}</div>
        </div>
        ${senses}
        <div class="cs-languages">
          ${field("languages", "cs-languages-val", { placeholder: t("z.B. Gemeinsprache, Elfisch") })}
          <div class="cs-small-label">${t("Sprachen")}</div>
        </div>
      </div>

      ${defenses}
      ${features}
      ${description}
      ${notes}
    </div>
  `;
}

function renderCharSheet(entity, kind = "pc") {
  return charSheetHtml(entity, false, kind);
}

function charSheetFormHtml(entity, kind = "pc") {
  return charSheetHtml(entity, true, kind);
}

function bindCharSheetForm(container) {
  // The full sheet updates its modifiers itself (they include the bonuses of people and background).
  if (container.querySelector(".pc-sheet")) return bindPcSheet(container);
  for (const input of container.querySelectorAll("[data-ability]")) {
    input.addEventListener("input", () => {
      const v = input.value === "" ? null : parseInt(input.value, 10);
      container.querySelector(`[data-mod="${input.dataset.ability}"]`).textContent = abilityMod(v);
    });
  }
}

// Returns the body for POST/PUT. For PCs stat_block is null when no sheet extras were entered;
// for monsters it holds only the editable keys, so callers merge it over the existing statblock
// (keeping the Open5e actions/traits).
function readCharSheetForm(container, kind = "pc") {
  if (kind !== "monster") return readPcSheet(container);
  const text = (key) => container.querySelector(`[data-field="${key}"]`).value.trim();
  const int = (key) => {
    const v = parseInt(text(key), 10);
    return isNaN(v) ? null : v;
  };

  const abilities = {};
  let any = false;
  for (const input of container.querySelectorAll("[data-ability]")) {
    const v = parseInt(input.value, 10);
    abilities[input.dataset.ability] = isNaN(v) ? null : v;
    if (!isNaN(v)) any = true;
  }
  const extras = {
    passive_perception: int("passive_perception"),
    speed: text("speed") || null,
    languages: text("languages") || null,
  };

  const body = {
    name: text("name"),
    max_hp: int("max_hp"),
    ac: int("ac"),
    initiative_bonus: int("initiative_bonus") ?? 0,
    notes: text("notes"),
  };

  if (kind === "monster") {
    extras.senses = text("senses") || null;
    for (const [key] of DEFENSES) extras[key] = text(key) || null;
    for (const key of MONSTER_EXTRA_KEYS) extras[key] = text(key) || null;
    extras.size = text("size") || null;
    body.creature_type = text("creature_type") || null;
    body.challenge_rating = text("challenge_rating");
    body.stat_block = { abilities, ...extras };
    return body;
  }

  extras.race = text("race") || null;
  extras.char_class = text("char_class") || null;
  if (Object.values(extras).some((v) => v !== null)) any = true;
  body.stat_block = any ? { abilities, ...extras } : null;
  return body;
}

function charSubtitle(pc) {
  const sb = pc.stat_block || {};
  const cls = [sb.char_class, sb.subclass && `(${sb.subclass})`].filter(Boolean).join(" ");
  return [sb.race, cls, sb.class_key && t("Stufe {n}", { n: sb.level ?? 1 })].filter(Boolean).join(" · ");
}

