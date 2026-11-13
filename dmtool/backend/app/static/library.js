// Bestiary, items and spells: the library the combat tracker used to keep, moved here with its pages.
// Classic script, so charsheet.js and monstersheet.js (which read the global state) see the same data;
// app.js shows the pages (#library) when their topic is picked in the rail.

const state = {
  customMonsters: [],
  items: [],
  spells: [],
};

const editingMonsters = new Set();
const expandedMonsterStats = new Set();

async function api(path, method = "GET", body) {
  // Guards against the swapped argument order used by static/app.js/battlemap's api(method, url, body):
  // a call copied from there would otherwise send a request with the method as its path.
  if (!/^(GET|POST|PUT|PATCH|DELETE)$/.test(method)) {
    throw new Error(`api(): "${method}" ist keine HTTP-Methode – Reihenfolge ist api(path, method, body)`);
  }
  const resp = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw Object.assign(new Error(`${method} ${path} -> ${resp.status}: ${text}`), { status: resp.status });
  }
  if (resp.status === 204) return null;
  return resp.json();
}

// "+ Import" of one Open5e hit. A name the library already has is refused (409), like the import of a
// whole category skips it.
async function importOpen5eOne(btn, path, reload) {
  btn.disabled = true;
  btn.textContent = t("Importiere...");
  try {
    await api(path, "POST");
  } catch (err) {
    btn.textContent = err.status === 409 ? t("Schon vorhanden") : t("Fehler");
    if (err.status !== 409) btn.disabled = false;
    return;
  }
  btn.textContent = t("✓ Importiert");
  await reload();
}

async function uploadAvatar(avatarPath, file) {
  const resp = await fetch(`${avatarPath}?filename=${encodeURIComponent(file.name)}`, {
    method: "POST",
    body: file,
  });
  if (!resp.ok) throw new Error(await resp.text());
  return resp.json();
}

// Shown on every Open5e search result, so the source (and 2024-ruleset
// content in particular) is visible before the DM imports anything.
function open5eSourceBadgeHtml(entry) {
  const source = entry.source_name ? `<span class="muted">${escapeHtml(entry.source_name)}</span>` : "";
  const badge2024 = entry.is_2024 ? '<span class="warn-text">2024-Regeln</span>' : "";
  return `${source}${badge2024}`;
}

function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// Where a monster or item came from (its source column): made here, Open5e or an .odt/.docx file,
// or the D&D Beyond book import (book_import.py).
const librarySourceLabel = (s) => ({ import: t("Importiert (Open5e, Datei)"), ddb: t("D&D Beyond") })[s] || t("Eigene Erstellung");

// The list shows only the start of the notes; all of it is on the sheet (📖 Stats).
const firstLine = (s) => {
  const lines = String(s || "").split("\n").filter((l) => l.trim());
  return lines.length > 1 ? `${lines[0]} …` : lines[0] || "";
};

// ---------- bestiary: custom monsters ----------

async function loadCustomMonsters() {
  state.customMonsters = await api("/api/monsters/custom");
  rebuildBestiaryFilterOptions();
  renderCustomMonsters();
}

// ---- bestiary filters ----

const bestiaryFilters = { search: "", types: new Set(), crs: new Set(), sources: new Set(), needsReview: false };
let openBestiaryFilter = null;

function crToNumber(cr) {
  if (!cr) return -1;
  if (cr.includes("/")) {
    const [n, d] = cr.split("/").map(Number);
    return n / d;
  }
  return parseFloat(cr);
}

function renderBestiaryFilterMenu(key, values, selectedSet, labelFn) {
  const el = document.getElementById(`bestiary-filter-${key}`);
  if (values.length === 0) {
    el.innerHTML = `<p class="muted" style="margin:4px;">${t("Keine Werte vorhanden.")}</p>`;
    return;
  }
  el.innerHTML = values
    .map(
      (v) => `
    <label class="status-option">
      <input type="checkbox" data-value="${escapeHtml(v)}" ${selectedSet.has(v) ? "checked" : ""} />
      <span>${labelFn(v)}</span>
    </label>`
    )
    .join("");
  el.querySelectorAll("input[type=checkbox]").forEach((cb) => {
    cb.addEventListener("change", (e) => {
      const val = e.target.dataset.value;
      if (e.target.checked) selectedSet.add(val);
      else selectedSet.delete(val);
      updateBestiaryFilterToggleLabels();
      renderCustomMonsters();
    });
  });
}

function updateBestiaryFilterToggleLabels() {
  const specs = { type: [t("Typ"), bestiaryFilters.types], cr: ["CR", bestiaryFilters.crs], source: [t("Quelle"), bestiaryFilters.sources] };
  // Scope to buttons with no data-scope (or an explicit "bestiary" one) so this
  // doesn't also sweep up the item/spell filter toggles, which share the CSS class
  // but use different filter keys.
  document.querySelectorAll(".bestiary-filter-toggle").forEach((btn) => {
    const scope = btn.dataset.scope || "bestiary";
    if (scope !== "bestiary") return;
    const [base, set] = specs[btn.dataset.filter];
    btn.textContent = set.size > 0 ? `${base} (${set.size}) ▾` : `${base} ▾`;
    btn.classList.toggle("active-filter", set.size > 0);
  });
}

function rebuildBestiaryFilterOptions() {
  const types = new Set(state.customMonsters.map((m) => m.creature_type || ""));
  const crs = new Set(state.customMonsters.map((m) => m.challenge_rating || ""));
  for (const t of [...bestiaryFilters.types]) if (!types.has(t)) bestiaryFilters.types.delete(t);
  for (const c of [...bestiaryFilters.crs]) if (!crs.has(c)) bestiaryFilters.crs.delete(c);

  renderBestiaryFilterMenu(
    "type",
    [...types].sort(),
    bestiaryFilters.types,
    (type) => (type ? `${iconFor("monster", type)} ${type.charAt(0).toUpperCase() + type.slice(1)}` : t("Kein Typ"))
  );
  renderBestiaryFilterMenu("cr", [...crs].sort((a, b) => crToNumber(a) - crToNumber(b)), bestiaryFilters.crs, (c) =>
    c ? `CR ${escapeHtml(c)}` : t("Kein CR")
  );
  renderBestiaryFilterMenu("source", ["custom", "import", "ddb"], bestiaryFilters.sources, librarySourceLabel);
  updateBestiaryFilterToggleLabels();
}

// Shared by bestiary/item/spell filter sidebars: scope defaults to "bestiary"
// for the original monster filters, which predate the data-scope attribute
// but already follow the same "<scope>-filter-<key>" id convention.
document.querySelectorAll(".bestiary-filter-toggle").forEach((btn) => {
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const scope = btn.dataset.scope || "bestiary";
    const menuId = `${scope}-filter-${btn.dataset.filter}`;
    openBestiaryFilter = openBestiaryFilter === menuId ? null : menuId;
    document.querySelectorAll(".bestiary-filter-menu").forEach((m) => m.classList.add("hidden"));
    if (openBestiaryFilter) document.getElementById(openBestiaryFilter).classList.remove("hidden");
  });
});

document.addEventListener("click", (e) => {
  if (openBestiaryFilter !== null && !e.target.closest(".bestiary-filter-group")) {
    openBestiaryFilter = null;
    document.querySelectorAll(".bestiary-filter-menu").forEach((m) => m.classList.add("hidden"));
  }
});

document.getElementById("bestiary-search").addEventListener("input", (e) => {
  bestiaryFilters.search = e.target.value.trim().toLowerCase();
  renderCustomMonsters();
});

document.getElementById("bestiary-filter-reset").addEventListener("click", () => {
  bestiaryFilters.search = "";
  bestiaryFilters.types.clear();
  bestiaryFilters.crs.clear();
  bestiaryFilters.sources.clear();
  bestiaryFilters.needsReview = false;
  document.getElementById("bestiary-search").value = "";
  document.getElementById("bestiary-filter-unverified").classList.remove("active-filter");
  rebuildBestiaryFilterOptions();
  renderCustomMonsters();
});

document.getElementById("bestiary-filter-unverified").addEventListener("click", (e) => {
  bestiaryFilters.needsReview = !bestiaryFilters.needsReview;
  e.target.classList.toggle("active-filter", bestiaryFilters.needsReview);
  renderCustomMonsters();
});

function getFilteredCustomMonsters() {
  return state.customMonsters.filter((m) => {
    if (bestiaryFilters.search && !m.name.toLowerCase().includes(bestiaryFilters.search)) return false;
    if (bestiaryFilters.types.size > 0 && !bestiaryFilters.types.has(m.creature_type || "")) return false;
    if (bestiaryFilters.crs.size > 0 && !bestiaryFilters.crs.has(m.challenge_rating || "")) return false;
    if (bestiaryFilters.sources.size > 0 && !bestiaryFilters.sources.has(m.source)) return false;
    if (bestiaryFilters.needsReview && m.verified) return false;
    return true;
  });
}

function renderCustomMonsters() {
  const el = document.getElementById("custom-monster-list");
  el.innerHTML = "";
  const filtered = getFilteredCustomMonsters();
  if (filtered.length === 0) {
    el.innerHTML = `<p class="muted">${t("Keine Treffer für die aktuellen Filter.")}</p>`;
    return;
  }
  for (const m of filtered) {
    const wrap = document.createElement("div");

    const row = document.createElement("div");
    row.className = "list-item";

    if (editingMonsters.has(m.id)) {
      row.classList.add("editing");
      row.innerHTML = `
        <div class="e-sheet">${charSheetFormHtml(m, "monster")}</div>
        <div class="edit-row">
          <button class="save-btn">${t("Speichern")}</button>
          <button class="ghost cancel-btn">${t("Abbrechen")}</button>
        </div>
      `;
      bindCharSheetForm(row.querySelector(".e-sheet"));
      row.querySelector(".save-btn").addEventListener("click", async () => {
        const body = readCharSheetForm(row.querySelector(".e-sheet"), "monster");
        if (!body.name || body.max_hp === null || body.ac === null) return alert(t("Name, HP und AC sind nötig."));
        // Keep the Open5e actions/traits; the sheet only edits the remaining keys.
        body.stat_block = { ...(m.stat_block || {}), ...body.stat_block };
        // Reviewing and re-saving an import is how the DM confirms it's correct.
        body.verified = true;
        await api(`/api/monsters/custom/${m.id}`, "PUT", body);
        editingMonsters.delete(m.id);
        await loadCustomMonsters();
      });
      row.querySelector(".cancel-btn").addEventListener("click", () => {
        editingMonsters.delete(m.id);
        renderCustomMonsters();
      });
    } else {
      const avatarEl = m.avatar_path
        ? `<img class="avatar" src="${m.avatar_path}" />`
        : `<div class="avatar-placeholder">${iconFor("monster", m.creature_type)}</div>`;
      row.innerHTML = `
        ${avatarEl}
        <strong>${escapeHtml(m.name)}</strong>
        ${!m.verified ? `<span class="warn-text">${t("⚠ Zu kontrollieren")}</span>` : ""}
        <span class="muted">HP ${m.max_hp} · AC ${m.ac} · Init ${signed(m.initiative_bonus)} · CR ${escapeHtml(m.challenge_rating || "-")}</span>
        <span class="muted">${escapeHtml(firstLine(m.notes))}</span>
        <span class="spacer"></span>
        <label class="avatar-upload-label">${t("Bild")}
          <input type="file" accept="image/*" class="avatar-input" hidden />
        </label>
        <button class="ghost sb-toggle">${t("📖 Stats")}</button>
        ${!m.verified ? `<button class="ghost verify-btn">${t("✓ Verifizieren")}</button>` : ""}
        <button class="ghost edit-btn">${t("Bearbeiten")}</button>
        <button class="danger del-btn">${t("Löschen")}</button>
      `;
      row.querySelector(".avatar-input").addEventListener("change", async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        await uploadAvatar(`/api/monsters/custom/${m.id}/avatar`, file);
        await loadCustomMonsters();
      });
      if (!m.verified) {
        row.querySelector(".verify-btn").addEventListener("click", async () => {
          await api(`/api/monsters/custom/${m.id}/verify`, "POST");
          await loadCustomMonsters();
        });
      }
      row.querySelector(".sb-toggle").addEventListener("click", () => {
        if (expandedMonsterStats.has(m.id)) expandedMonsterStats.delete(m.id);
        else expandedMonsterStats.add(m.id);
        renderCustomMonsters();
      });
      row.querySelector(".edit-btn").addEventListener("click", () => {
        editingMonsters.add(m.id);
        renderCustomMonsters();
      });
      row.querySelector(".del-btn").addEventListener("click", async () => {
        await api(`/api/monsters/custom/${m.id}`, "DELETE");
        await loadCustomMonsters();
      });
    }
    wrap.appendChild(row);

    if (expandedMonsterStats.has(m.id) && !editingMonsters.has(m.id)) {
      const sb = document.createElement("div");
      sb.innerHTML = renderCharSheet(m, "monster");
      wrap.appendChild(sb);
    }

    el.appendChild(wrap);
  }
}

const cmSheetEl = document.getElementById("cm-sheet");
cmSheetEl.innerHTML = charSheetFormHtml(null, "monster");
bindCharSheetForm(cmSheetEl);

document.getElementById("cm-add-btn").addEventListener("click", async () => {
  const body = readCharSheetForm(cmSheetEl, "monster");
  if (!body.name || body.max_hp === null || body.ac === null) return alert(t("Name, HP und AC sind nötig."));
  await api("/api/monsters/custom", "POST", body);
  cmSheetEl.innerHTML = charSheetFormHtml(null, "monster");
  bindCharSheetForm(cmSheetEl);
  await loadCustomMonsters();
});

document.getElementById("open5e-search-btn").addEventListener("click", async () => {
  const q = document.getElementById("open5e-search-input").value.trim();
  if (!q) return;
  const results = await api(`/api/monsters/open5e/search?q=${encodeURIComponent(q)}`);
  const el = document.getElementById("open5e-results");
  el.innerHTML = "";
  for (const m of results) {
    const row = document.createElement("div");
    row.className = "list-item";
    row.innerHTML = `
      <strong>${escapeHtml(m.name)}</strong>
      <span class="muted">HP ${m.hp} · AC ${m.ac} · CR ${escapeHtml(m.challenge_rating || "-")} · ${escapeHtml(m.type || "")}</span>
      ${open5eSourceBadgeHtml(m)}
      <span class="spacer"></span>
      <button class="import-btn">${t("+ Import")}</button>
    `;
    row.querySelector(".import-btn").addEventListener("click", (ev) => importOpen5eOne(ev.target, `/api/monsters/custom/import-open5e/${m.slug}`, loadCustomMonsters));
    el.appendChild(row);
  }
});

// ---------- bestiary: import monsters from an .odt/.docx sourcebook chapter ----------

async function uploadOdtForParsing(file) {
  const resp = await fetch(`/api/monsters/custom/parse-doc?filename=${encodeURIComponent(file.name)}`, {
    method: "POST",
    body: file,
  });
  if (!resp.ok) throw new Error(await resp.text());
  return resp.json();
}

document.getElementById("odt-import-btn").addEventListener("click", async () => {
  const input = document.getElementById("odt-import-input");
  const file = input.files[0];
  if (!file) return alert(t("Bitte zuerst eine .odt- oder .docx-Datei auswählen."));
  const btn = document.getElementById("odt-import-btn");
  const el = document.getElementById("odt-import-results");
  btn.disabled = true;
  btn.textContent = t("Lese ein...");
  try {
    const candidates = await uploadOdtForParsing(file);
    el.innerHTML =
      candidates.length === 0 ? `<p class="muted">${t("Keine Statblocks erkannt.")}</p>` : "";
    for (const candidate of candidates) {
      const wrap = document.createElement("div");
      wrap.className = "list-item editing";
      wrap.innerHTML = `
        <div class="e-sheet"></div>
        <div class="edit-row">
          <button class="save-btn">${t("In Bestiarium übernehmen")}</button>
          <button class="ghost cancel-btn">${t("Verwerfen")}</button>
        </div>
      `;
      const sheetEl = wrap.querySelector(".e-sheet");
      sheetEl.innerHTML = charSheetFormHtml(candidate, "monster");
      bindCharSheetForm(sheetEl);
      wrap.querySelector(".save-btn").addEventListener("click", async (ev) => {
        const body = readCharSheetForm(sheetEl, "monster");
        if (!body.name || body.max_hp === null || body.ac === null) {
          return alert(t("Name, HP und AC sind nötig (ggf. in den Feldern ergänzen)."));
        }
        // The simple form only edits the top-level fields; keep the parsed actions/traits.
        body.stat_block = { ...(candidate.stat_block || {}), ...body.stat_block };
        body.source = "import";
        body.verified = false;
        ev.target.disabled = true;
        await api("/api/monsters/custom", "POST", body);
        wrap.remove();
        await loadCustomMonsters();
      });
      wrap.querySelector(".cancel-btn").addEventListener("click", () => wrap.remove());
      el.appendChild(wrap);
    }
  } catch (err) {
    alert(t("Einlesen fehlgeschlagen: {error}", { error: err.message }));
  } finally {
    btn.disabled = false;
    btn.textContent = t("Datei einlesen");
    input.value = "";
  }
});

// ---------- items & spells: shared generic filter helper ----------

function renderFilterMenu(elId, values, selectedSet, labelFn, onChange) {
  const el = document.getElementById(elId);
  if (!el) return;
  if (values.length === 0) {
    el.innerHTML = `<p class="muted" style="margin:4px;">${t("Keine Werte vorhanden.")}</p>`;
    return;
  }
  el.innerHTML = values
    .map(
      (v) => `
    <label class="status-option">
      <input type="checkbox" data-value="${escapeHtml(v)}" ${selectedSet.has(v) ? "checked" : ""} />
      <span>${labelFn(v)}</span>
    </label>`
    )
    .join("");
  el.querySelectorAll("input[type=checkbox]").forEach((cb) => {
    cb.addEventListener("change", (e) => {
      const val = e.target.dataset.value;
      if (e.target.checked) selectedSet.add(val);
      else selectedSet.delete(val);
      onChange();
    });
  });
}

function updateScopedFilterToggleLabels(scope, specs) {
  document.querySelectorAll(`.bestiary-filter-toggle[data-scope="${scope}"]`).forEach((btn) => {
    const [base, set] = specs[btn.dataset.filter];
    btn.textContent = set.size > 0 ? `${base} (${set.size}) ▾` : `${base} ▾`;
    btn.classList.toggle("active-filter", set.size > 0);
  });
}

// ---------- items (magic items) ----------

const itemFilters = { search: "", item_type: new Set(), rarity: new Set(), source: new Set() };
const RARITY_ORDER = ["common", "uncommon", "rare", "very rare", "legendary", "artifact", ""];
const editingItems = new Set();

async function loadCustomItems() {
  state.items = await api("/api/items/custom");
  rebuildItemFilterOptions();
  renderCustomItems();
}

function rebuildItemFilterOptions() {
  const types = new Set(state.items.map((i) => i.item_type || ""));
  const rarities = new Set(state.items.map((i) => i.rarity || ""));
  for (const t of [...itemFilters.item_type]) if (!types.has(t)) itemFilters.item_type.delete(t);
  for (const r of [...itemFilters.rarity]) if (!rarities.has(r)) itemFilters.rarity.delete(r);

  const onChange = () => {
    updateItemFilterToggleLabels();
    renderCustomItems();
  };
  renderFilterMenu("item-filter-item_type", [...types].sort(), itemFilters.item_type, (type) => type || t("Kein Typ"), onChange);
  renderFilterMenu(
    "item-filter-rarity",
    [...rarities].sort((a, b) => RARITY_ORDER.indexOf(a) - RARITY_ORDER.indexOf(b)),
    itemFilters.rarity,
    (r) => (r ? r.charAt(0).toUpperCase() + r.slice(1) : t("Unbekannt")),
    onChange
  );
  renderFilterMenu(
    "item-filter-source",
    ["custom", "import", "ddb"],
    itemFilters.source,
    librarySourceLabel,
    onChange
  );
  updateItemFilterToggleLabels();
}

function updateItemFilterToggleLabels() {
  updateScopedFilterToggleLabels("item", {
    item_type: [t("Typ"), itemFilters.item_type],
    rarity: [t("Seltenheit"), itemFilters.rarity],
    source: [t("Quelle"), itemFilters.source],
  });
}

function getFilteredItems() {
  return state.items.filter((i) => {
    if (itemFilters.search && !i.name.toLowerCase().includes(itemFilters.search)) return false;
    if (itemFilters.item_type.size > 0 && !itemFilters.item_type.has(i.item_type || "")) return false;
    if (itemFilters.rarity.size > 0 && !itemFilters.rarity.has(i.rarity || "")) return false;
    if (itemFilters.source.size > 0 && !itemFilters.source.has(i.source)) return false;
    return true;
  });
}

const expandedItemStats = new Set();

// Placeholder for items without a picture, picked from the item type.
const ITEM_TYPE_ICONS = [
  ["potion", "🧪"],
  ["ring", "💍"],
  ["scroll", "📜"],
  ["wand", "🪄"],
  ["staff", "🦯"],
  ["rod", "🦯"],
  ["armor", "🛡️"],
  ["shield", "🛡️"],
  ["weapon", "⚔️"],
];

function itemIcon(itemType) {
  const t = (itemType || "").toLowerCase();
  const hit = ITEM_TYPE_ICONS.find(([key]) => t.includes(key));
  return hit ? hit[1] : "🎒";
}

// Armor values of an item, edited in the item forms; empty category = not armor.
function armorFieldsHtml(armor) {
  const a = armor || {};
  return `
    <label class="inline-label">${t("Rüstung")}
      <select class="e-armor-cat">
        <option value="">${t("-- keine Rüstung --")}</option>
        ${ARMOR_CATEGORIES.map(([v, l]) => `<option value="${v}" ${a.category === v ? "selected" : ""}>${l}</option>`).join("")}
      </select>
    </label>
    <input class="e-armor-base" type="number" min="0" value="${valOrEmpty(a.base_ac)}" placeholder="${t("Basis-RK (Schild: 2)")}" title="${t("Basis-RK")}" />
    <input class="e-armor-bonus" type="number" value="${a.bonus ? a.bonus : ""}" placeholder="${t("Magiebonus (z.B. 1)")}" title="${t("Magischer Bonus")}" />`;
}

function readArmorFields(container, previous) {
  const category = container.querySelector(".e-armor-cat").value;
  if (!category) return null;
  const base = parseInt(container.querySelector(".e-armor-base").value, 10);
  const bonus = parseInt(container.querySelector(".e-armor-bonus").value, 10);
  // Strength and stealth come from Open5e; keep them as long as the category stays the same.
  const keep = previous && previous.category === category ? previous : {};
  return {
    ...keep,
    category,
    base_ac: isNaN(base) ? (category === "shield" ? 2 : 10) : base,
    max_dex: keep.category ? keep.max_dex : ARMOR_DEX_CAP[category],
    bonus: isNaN(bonus) ? 0 : bonus,
  };
}

// Merges the edited armor into the item's stat_block without touching weapon values.
function itemStatBlock(it, armor) {
  const sb = { ...((it && it.stat_block) || {}) };
  if (armor) sb.armor = armor;
  else delete sb.armor;
  return Object.keys(sb).length ? sb : null;
}

function itemSummary(it) {
  const sb = it.stat_block || {};
  if (sb.armor) return `RK ${armorFormula(sb.armor)}`;
  if (sb.weapon) return `${sb.weapon.damage_dice || "–"} ${sb.weapon.damage_type || ""}`.trim();
  return "";
}

function renderCustomItems() {
  const el = document.getElementById("custom-item-list");
  el.innerHTML = "";
  const filtered = getFilteredItems();
  if (filtered.length === 0) {
    el.innerHTML = `<p class="muted">${t("Keine Treffer für die aktuellen Filter.")}</p>`;
    return;
  }
  for (const it of filtered) {
    const wrap = document.createElement("div");
    const row = document.createElement("div");
    row.className = "list-item";
    if (editingItems.has(it.id)) {
      row.innerHTML = `
        <div class="edit-row">
          <input class="e-name" value="${escapeHtml(it.name)}" placeholder="${t("Name")}" />
          <input class="e-type" value="${escapeHtml(it.item_type || "")}" placeholder="${t("Typ")}" />
          <select class="e-rarity">
            ${["", "common", "uncommon", "rare", "very rare", "legendary", "artifact"]
              .map((r) => `<option value="${r}" ${it.rarity === r ? "selected" : ""}>${r || t("-- Seltenheit --")}</option>`)
              .join("")}
          </select>
          <label class="inline-checkbox"><input type="checkbox" class="e-attunement" ${it.requires_attunement ? "checked" : ""} /> ${t("Attunement")}</label>
        </div>
        <div class="edit-row">${armorFieldsHtml(itemArmor(it))}</div>
        <div class="edit-row">
          <textarea class="e-desc" rows="3" placeholder="${t("Beschreibung")}">${escapeHtml(it.desc || "")}</textarea>
        </div>
        <div class="edit-row">
          <button class="save-btn">${t("Speichern")}</button>
          <button class="ghost cancel-btn">${t("Abbrechen")}</button>
        </div>
      `;
      row.querySelector(".save-btn").addEventListener("click", async () => {
        const name = row.querySelector(".e-name").value.trim();
        if (!name) return alert(t("Name ist nötig."));
        const body = {
          name,
          item_type: row.querySelector(".e-type").value.trim() || null,
          rarity: row.querySelector(".e-rarity").value || null,
          requires_attunement: row.querySelector(".e-attunement").checked,
          desc: row.querySelector(".e-desc").value.trim() || null,
          stat_block: itemStatBlock(it, readArmorFields(row, itemArmor(it))),
        };
        await api(`/api/items/custom/${it.id}`, "PUT", body);
        editingItems.delete(it.id);
        await loadCustomItems();
      });
      row.querySelector(".cancel-btn").addEventListener("click", () => {
        editingItems.delete(it.id);
        renderCustomItems();
      });
    } else {
      const avatarEl = it.avatar_path
        ? `<img class="avatar" src="${it.avatar_path}" />`
        : `<div class="avatar-placeholder">${itemIcon(it.item_type)}</div>`;
      row.innerHTML = `
        ${avatarEl}
        <strong>${escapeHtml(it.name)}</strong>
        <span class="muted">${escapeHtml(it.item_type || "-")} · ${escapeHtml(it.rarity || "-")}${it.requires_attunement ? t(" · Attunement") : ""}${itemSummary(it) ? ` · <b>${escapeHtml(itemSummary(it))}</b>` : ""}</span>
        <span class="spacer"></span>
        <label class="avatar-upload-label">${t("Bild")}
          <input type="file" accept="image/*" class="avatar-input" hidden />
        </label>
        ${it.avatar_path ? `<button class="ghost avatar-del-btn" title="${t("Bild entfernen")}">${t("✕ Bild")}</button>` : ""}
        <button class="ghost sb-toggle">${t("📖 Stats")}</button>
        <button class="ghost edit-btn">${t("Bearbeiten")}</button>
        <button class="danger del-btn">${t("Löschen")}</button>
      `;
      row.querySelector(".avatar-input").addEventListener("change", async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        await uploadAvatar(`/api/items/custom/${it.id}/avatar`, file);
        await loadCustomItems();
      });
      row.querySelector(".avatar-del-btn")?.addEventListener("click", async () => {
        await api(`/api/items/custom/${it.id}/avatar`, "DELETE");
        await loadCustomItems();
      });
      row.querySelector(".sb-toggle").addEventListener("click", () => {
        if (expandedItemStats.has(it.id)) expandedItemStats.delete(it.id);
        else expandedItemStats.add(it.id);
        renderCustomItems();
      });
      row.querySelector(".edit-btn").addEventListener("click", () => {
        editingItems.add(it.id);
        renderCustomItems();
      });
      row.querySelector(".del-btn").addEventListener("click", async () => {
        await api(`/api/items/custom/${it.id}`, "DELETE");
        await loadCustomItems();
      });
    }
    wrap.appendChild(row);

    if (expandedItemStats.has(it.id) && !editingItems.has(it.id)) {
      const sb = document.createElement("div");
      sb.innerHTML = itemSheetHtml(it) + trFieldsHtml([[t("Beschreibung"), it.desc, it.desc_de]]);
      wrap.appendChild(sb);
    }

    el.appendChild(wrap);
  }
}

document.getElementById("open5e-item-search-btn").addEventListener("click", async () => {
  const q = document.getElementById("open5e-item-search-input").value.trim();
  if (!q) return;
  const results = await api(`/api/items/open5e/search?q=${encodeURIComponent(q)}`);
  const el = document.getElementById("open5e-item-results");
  el.innerHTML = "";
  for (const r of results) {
    const row = document.createElement("div");
    row.className = "list-item";
    row.innerHTML = `
      <strong>${escapeHtml(r.name)}</strong>
      <span class="muted">${escapeHtml(r.item_type || "")} · ${escapeHtml(r.rarity || "")}</span>
      ${open5eSourceBadgeHtml(r)}
      <span class="spacer"></span>
      <button class="import-btn">${t("+ Import")}</button>
    `;
    row.querySelector(".import-btn").addEventListener("click", (ev) => importOpen5eOne(ev.target, `/api/items/custom/import-open5e/${r.slug}`, loadCustomItems));
    el.appendChild(row);
  }
});

document.getElementById("item-armor-row").innerHTML = armorFieldsHtml(null);

document.getElementById("srd-equipment-btn").addEventListener("click", async (ev) => {
  const btn = ev.currentTarget;
  btn.disabled = true;
  btn.textContent = t("Importiere...");
  try {
    const res = await api("/api/items/custom/import-srd-equipment", "POST");
    btn.textContent = `✓ ${t("{added} importiert, {skipped} schon vorhanden", { added: res.added.length, skipped: res.skipped })}`;
    await loadCustomItems();
  } catch (err) {
    btn.textContent = t("+ SRD-Rüstungen & Waffen importieren");
    alert(t("Import fehlgeschlagen: ") + err.message);
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("item-add-btn").addEventListener("click", async () => {
  const name = document.getElementById("item-name").value.trim();
  if (!name) return alert(t("Name ist nötig."));
  const body = {
    name,
    item_type: document.getElementById("item-type").value.trim() || null,
    rarity: document.getElementById("item-rarity").value || null,
    requires_attunement: document.getElementById("item-attunement").checked,
    desc: document.getElementById("item-desc").value.trim() || null,
    stat_block: itemStatBlock(null, readArmorFields(document.getElementById("item-armor-row"), null)),
  };
  await api("/api/items/custom", "POST", body);
  document.getElementById("item-armor-row").innerHTML = armorFieldsHtml(null);
  document.getElementById("item-name").value = "";
  document.getElementById("item-type").value = "";
  document.getElementById("item-rarity").value = "";
  document.getElementById("item-attunement").checked = false;
  document.getElementById("item-desc").value = "";
  await loadCustomItems();
});

document.getElementById("item-search").addEventListener("input", (e) => {
  itemFilters.search = e.target.value.trim().toLowerCase();
  renderCustomItems();
});

document.getElementById("item-filter-reset").addEventListener("click", () => {
  itemFilters.search = "";
  itemFilters.item_type.clear();
  itemFilters.rarity.clear();
  itemFilters.source.clear();
  document.getElementById("item-search").value = "";
  rebuildItemFilterOptions();
  renderCustomItems();
});

// ---------- spells ----------

const spellFilters = { search: "", school: new Set(), level_int: new Set(), dnd_class: new Set(), source: new Set() };
const editingSpells = new Set();
const expandedSpellDesc = new Set();

function spellClassList(spell) {
  return (spell.dnd_class || "")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
}

function spellLevelLabel(lvl) {
  if (lvl === "" || lvl === null || lvl === undefined) return t("Unbekannt");
  return lvl === "0" ? t("Zaubertrick") : `Grad ${lvl}`;
}

async function loadCustomSpells() {
  state.spells = await api("/api/spells/custom");
  rebuildSpellFilterOptions();
  renderCustomSpells();
}

function rebuildSpellFilterOptions() {
  const schools = new Set(state.spells.map((s) => s.school || ""));
  const levels = new Set(state.spells.map((s) => String(s.level_int ?? "")));
  const classes = new Set(state.spells.flatMap((s) => spellClassList(s)));
  for (const v of [...spellFilters.school]) if (!schools.has(v)) spellFilters.school.delete(v);
  for (const v of [...spellFilters.level_int]) if (!levels.has(v)) spellFilters.level_int.delete(v);
  for (const v of [...spellFilters.dnd_class]) if (!classes.has(v)) spellFilters.dnd_class.delete(v);

  const onChange = () => {
    updateSpellFilterToggleLabels();
    renderCustomSpells();
  };
  renderFilterMenu("spell-filter-school", [...schools].sort(), spellFilters.school, (s) => s || t("Keine Schule"), onChange);
  renderFilterMenu(
    "spell-filter-level_int",
    [...levels].sort((a, b) => Number(a) - Number(b)),
    spellFilters.level_int,
    spellLevelLabel,
    onChange
  );
  renderFilterMenu("spell-filter-dnd_class", [...classes].sort(), spellFilters.dnd_class, (c) => c, onChange);
  renderFilterMenu(
    "spell-filter-source",
    ["custom", "import"],
    spellFilters.source,
    (s) => (s === "import" ? t("Importiert (Open5e)") : t("Eigene Erstellung")),
    onChange
  );
  updateSpellFilterToggleLabels();
}

function updateSpellFilterToggleLabels() {
  updateScopedFilterToggleLabels("spell", {
    school: [t("Schule"), spellFilters.school],
    level_int: [t("Grad"), spellFilters.level_int],
    dnd_class: [t("Klasse"), spellFilters.dnd_class],
    source: [t("Quelle"), spellFilters.source],
  });
}

function getFilteredSpells() {
  return state.spells.filter((s) => {
    if (spellFilters.search && !s.name.toLowerCase().includes(spellFilters.search)) return false;
    if (spellFilters.school.size > 0 && !spellFilters.school.has(s.school || "")) return false;
    if (spellFilters.level_int.size > 0 && !spellFilters.level_int.has(String(s.level_int ?? ""))) return false;
    if (spellFilters.dnd_class.size > 0) {
      const classes = spellClassList(s);
      if (!classes.some((c) => spellFilters.dnd_class.has(c))) return false;
    }
    if (spellFilters.source.size > 0 && !spellFilters.source.has(s.source)) return false;
    return true;
  });
}

function renderCustomSpells() {
  const el = document.getElementById("custom-spell-list");
  el.innerHTML = "";
  const filtered = getFilteredSpells();
  if (filtered.length === 0) {
    el.innerHTML = `<p class="muted">${t("Keine Treffer für die aktuellen Filter.")}</p>`;
    return;
  }
  for (const sp of filtered) {
    const wrap = document.createElement("div");
    const row = document.createElement("div");
    row.className = "list-item";
    if (editingSpells.has(sp.id)) {
      row.innerHTML = `
        <div class="edit-row">
          <input class="e-name" value="${escapeHtml(sp.name)}" placeholder="${t("Name")}" />
          <input class="e-school" value="${escapeHtml(sp.school || "")}" placeholder="${t("Schule")}" />
          <input class="e-level" type="number" min="0" max="9" value="${sp.level_int ?? ""}" placeholder="${t("Grad")}" />
          <input class="e-class" value="${escapeHtml(sp.dnd_class || "")}" placeholder="${t("Klassen")}" />
        </div>
        <div class="edit-row">
          <input class="e-casting" value="${escapeHtml(sp.casting_time || "")}" placeholder="${t("Zauberdauer")}" />
          <input class="e-range" value="${escapeHtml(sp.range || "")}" placeholder="${t("Reichweite")}" />
          <input class="e-components" value="${escapeHtml(sp.components || "")}" placeholder="${t("Komponenten")}" />
          <input class="e-duration" value="${escapeHtml(sp.duration || "")}" placeholder="${t("Wirkungsdauer")}" />
        </div>
        <div class="edit-row">
          <label class="inline-checkbox"><input type="checkbox" class="e-concentration" ${sp.concentration ? "checked" : ""} /> ${t("Konzentration")}</label>
          <label class="inline-checkbox"><input type="checkbox" class="e-ritual" ${sp.ritual ? "checked" : ""} /> ${t("Ritual")}</label>
        </div>
        <div class="edit-row">
          <textarea class="e-desc" rows="3" placeholder="${t("Beschreibung")}">${escapeHtml(sp.desc || "")}</textarea>
        </div>
        <div class="edit-row">
          <button class="save-btn">${t("Speichern")}</button>
          <button class="ghost cancel-btn">${t("Abbrechen")}</button>
        </div>
      `;
      row.querySelector(".save-btn").addEventListener("click", async () => {
        const name = row.querySelector(".e-name").value.trim();
        if (!name) return alert(t("Name ist nötig."));
        const levelVal = row.querySelector(".e-level").value;
        const body = {
          name,
          school: row.querySelector(".e-school").value.trim() || null,
          level_int: levelVal === "" ? null : parseInt(levelVal, 10),
          dnd_class: row.querySelector(".e-class").value.trim() || null,
          casting_time: row.querySelector(".e-casting").value.trim() || null,
          range: row.querySelector(".e-range").value.trim() || null,
          components: row.querySelector(".e-components").value.trim() || null,
          material: sp.material || null,
          duration: row.querySelector(".e-duration").value.trim() || null,
          concentration: row.querySelector(".e-concentration").checked,
          ritual: row.querySelector(".e-ritual").checked,
          higher_level: sp.higher_level || null,
          desc: row.querySelector(".e-desc").value.trim() || null,
        };
        await api(`/api/spells/custom/${sp.id}`, "PUT", body);
        editingSpells.delete(sp.id);
        await loadCustomSpells();
      });
      row.querySelector(".cancel-btn").addEventListener("click", () => {
        editingSpells.delete(sp.id);
        renderCustomSpells();
      });
    } else {
      const levelLabel = sp.level_int === 0 ? t("Zaubertrick") : sp.level_int != null ? `Grad ${sp.level_int}` : "";
      const school = spellSchoolIcon(sp.school);
      row.innerHTML = `
        <div class="avatar-placeholder school-icon" title="${escapeHtml(school.title)}">${school.icon}</div>
        <strong>${escapeHtml(sp.name)}</strong>
        <span class="muted">${escapeHtml(sp.school || "-")} · ${levelLabel} ${sp.concentration ? t("· Konzentration") : ""} ${sp.ritual ? t("· Ritual") : ""}</span>
        <span class="muted">${escapeHtml(sp.dnd_class || "")}</span>
        <span class="spacer"></span>
        <button class="ghost sb-toggle">${t("📖 Stats")}</button>
        <button class="ghost edit-btn">${t("Bearbeiten")}</button>
        <button class="danger del-btn">${t("Löschen")}</button>
      `;
      row.querySelector(".sb-toggle").addEventListener("click", () => {
        if (expandedSpellDesc.has(sp.id)) expandedSpellDesc.delete(sp.id);
        else expandedSpellDesc.add(sp.id);
        renderCustomSpells();
      });
      row.querySelector(".edit-btn").addEventListener("click", () => {
        editingSpells.add(sp.id);
        renderCustomSpells();
      });
      row.querySelector(".del-btn").addEventListener("click", async () => {
        await api(`/api/spells/custom/${sp.id}`, "DELETE");
        await loadCustomSpells();
      });
    }
    wrap.appendChild(row);

    if (expandedSpellDesc.has(sp.id) && !editingSpells.has(sp.id)) {
      const details = document.createElement("div");
      details.innerHTML = spellSheetHtml(sp) + trFieldsHtml([
        [t("Beschreibung"), sp.desc, sp.desc_de], [t("Bei höherem Grad"), sp.higher_level, sp.higher_level_de], [t("Material"), sp.material, sp.material_de],
      ]);
      wrap.appendChild(details);
    }

    el.appendChild(wrap);
  }
}

document.getElementById("open5e-spell-search-btn").addEventListener("click", async () => {
  const q = document.getElementById("open5e-spell-search-input").value.trim();
  if (!q) return;
  const results = await api(`/api/spells/open5e/search?q=${encodeURIComponent(q)}`);
  const el = document.getElementById("open5e-spell-results");
  el.innerHTML = "";
  for (const r of results) {
    const row = document.createElement("div");
    row.className = "list-item";
    const levelLabel = r.level_int === 0 ? t("Zaubertrick") : `Grad ${r.level_int}`;
    row.innerHTML = `
      <strong>${escapeHtml(r.name)}</strong>
      <span class="muted">${escapeHtml(r.school || "")} · ${levelLabel}</span>
      ${open5eSourceBadgeHtml(r)}
      <span class="spacer"></span>
      <button class="import-btn">${t("+ Import")}</button>
    `;
    row.querySelector(".import-btn").addEventListener("click", (ev) => importOpen5eOne(ev.target, `/api/spells/custom/import-open5e/${r.slug}`, loadCustomSpells));
    el.appendChild(row);
  }
});

document.getElementById("spell-add-btn").addEventListener("click", async () => {
  const name = document.getElementById("spell-name").value.trim();
  if (!name) return alert(t("Name ist nötig."));
  const levelVal = document.getElementById("spell-level").value;
  const body = {
    name,
    school: document.getElementById("spell-school").value || null,
    level_int: levelVal === "" ? null : parseInt(levelVal, 10),
    dnd_class: document.getElementById("spell-class").value.trim() || null,
    casting_time: document.getElementById("spell-casting-time").value.trim() || null,
    range: document.getElementById("spell-range").value.trim() || null,
    components: document.getElementById("spell-components").value.trim() || null,
    material: document.getElementById("spell-material").value.trim() || null,
    duration: document.getElementById("spell-duration").value.trim() || null,
    concentration: document.getElementById("spell-concentration").checked,
    ritual: document.getElementById("spell-ritual").checked,
    higher_level: document.getElementById("spell-higher-level").value.trim() || null,
    desc: document.getElementById("spell-desc").value.trim() || null,
  };
  await api("/api/spells/custom", "POST", body);
  [
    "spell-name",
    "spell-school",
    "spell-level",
    "spell-class",
    "spell-casting-time",
    "spell-range",
    "spell-components",
    "spell-material",
    "spell-duration",
    "spell-higher-level",
    "spell-desc",
  ].forEach((id) => (document.getElementById(id).value = ""));
  document.getElementById("spell-concentration").checked = false;
  document.getElementById("spell-ritual").checked = false;
  await loadCustomSpells();
});

document.getElementById("spell-search").addEventListener("input", (e) => {
  spellFilters.search = e.target.value.trim().toLowerCase();
  renderCustomSpells();
});

document.getElementById("spell-filter-reset").addEventListener("click", () => {
  spellFilters.search = "";
  spellFilters.school.clear();
  spellFilters.level_int.clear();
  spellFilters.dnd_class.clear();
  spellFilters.source.clear();
  document.getElementById("spell-search").value = "";
  rebuildSpellFilterOptions();
  renderCustomSpells();
});

// ---------- bulk import of a whole Open5e category ----------

const BULK_RELOAD = { monsters: () => loadCustomMonsters(), items: () => loadCustomItems(), spells: () => loadCustomSpells() };

// reload: refreshes the list afterwards (the character options in options.js pass their own).
function bindBulkImport(row, reload) {
  const { kind, label } = row.dataset;
  const btn = row.querySelector(".bulk-btn");
  const status = row.querySelector(".bulk-status");
  btn.addEventListener("click", async () => {
    const srd = row.querySelector(".bulk-scope").value === "srd";
    btn.disabled = true;
    status.textContent = t("Zähle Einträge …");
    try {
      const { count } = await api(`/api/${kind}/open5e-all/count?srd=${srd}`);
      const where = srd ? t("aus dem 5e-SRD") : t("aus allen Open5e-Quellen");
      if (!confirm(t("{count} {what} {where} importieren?\nBereits vorhandene Namen werden übersprungen.", { count, what: label, where }))) {
        status.textContent = "";
        return;
      }
      status.textContent = t("Importiere {count} {what} … (kann bis zu einer Minute dauern)", { count, what: label });
      const res = await api(`/api/${kind}/custom/import-open5e-all?srd=${srd}`, "POST");
      status.textContent = `✓ ${t("{added} importiert, {skipped} übersprungen (schon vorhanden)", { added: res.added, skipped: res.skipped })}`;
      await reload();
    } catch (err) {
      status.textContent = "";
      alert(t("Import fehlgeschlagen: ") + err.message);
    } finally {
      btn.disabled = false;
    }
  });
}

for (const row of document.querySelectorAll(".bulk-import")) bindBulkImport(row, BULK_RELOAD[row.dataset.kind]);

// Loaded once at start; the character sheets need items and spells as well.
window.libraryReady = Promise.all([loadCustomMonsters(), loadCustomItems(), loadCustomSpells()]);
