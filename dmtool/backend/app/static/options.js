// Classes, subclasses, peoples and backgrounds: the library pages (#library/classes …) and the
// entries the character sheets offer in their dropdowns (state.options, see charsheet.js).
// Classic script after library.js, whose api(), escapeHtml(), state and bindBulkImport() it uses.

const OPTION_KINDS = {
  classes: { title: t("Klassen"), one: t("Klasse"), example: t("z.B. fighter") },
  subclasses: { title: t("Unterklassen"), one: t("Unterklasse"), example: t("z.B. champion") },
  races: { title: t("Völker"), one: t("Volk"), example: t("z.B. dwarf") },
  backgrounds: { title: t("Hintergründe"), one: t("Hintergrund"), example: t("z.B. acolyte") },
  feats: { title: t("Talente"), one: t("Talent"), example: t("z.B. alert") },
};

state.options = [];
state.optionsUrl = "/api/options/entry";
const optionFilters = Object.fromEntries(Object.keys(OPTION_KINDS).map((k) => [k, { search: "", rules: "", parent: "" }]));
const editingOptions = new Set();
const expandedOptions = new Set();

// Full entries (with descriptions): the DM page shows them, and the sheets need no second request.
async function loadCharOptions() {
  state.options = await api("/api/options?lean=false");
  for (const kind of Object.keys(OPTION_KINDS)) renderOptionList(kind);
}

const abilityName = (k) => ABILITY_SHORT[k] || k;
const skillName = (k) => (SKILLS.find((s) => s[0] === k) || [k, k])[1];

// The English names of all classes, which subclasses name as their parent.
function parentClassNames() {
  const names = new Set(Object.values(CLASSES).map((c) => c.en.charAt(0).toUpperCase() + c.en.slice(1)));
  for (const o of charOptions("classes")) if (o.name_en) names.add(o.name_en);
  return [...names].sort();
}

function optionSummary(o) {
  const d = o.data || {};
  const parts = [];
  if (o.kind === "classes") {
    if (d.hit_die) parts.push(`W${d.hit_die}`);
    if (d.saves && d.saves.length) parts.push(`RW ${d.saves.map(abilityName).join(", ")}`);
    if (d.features) parts.push(`${d.features.length} Merkmale`);
    if (classKeyFor(o)) parts.push(t("Regeln des Charakterblatts"));
  }
  if (o.kind === "subclasses") {
    parts.push(`von ${o.parent || "?"}`);
    if (d.features) parts.push(`${d.features.length} Merkmale`);
  }
  if (o.kind === "races" || o.kind === "backgrounds") parts.push(asiText(d.asi) || t("keine Attributsboni"));
  if (o.kind === "races" && d.speed && d.speed.walk) parts.push(`${d.speed.walk} ft`);
  if (o.kind === "races" && o.parent) parts.push(t("Unterart von {name}", { name: o.parent }));
  if (o.kind === "backgrounds" && d.skills && d.skills.length) parts.push(d.skills.map(skillName).join(", "));
  if (o.kind === "feats") {
    if (d.feat_type) parts.push(FEAT_TYPE_ONE[d.feat_type] || d.feat_type);
    if (d.prerequisite) parts.push(`Voraussetzung: ${d.prerequisite}`);
    if (d.asi) parts.push(asiText(d.asi));
  }
  return parts.join(" · ");
}

function optionDetailsHtml(o) {
  const d = o.data || {};
  const list = d.features || d.traits || d.benefits || [];
  const items = list
    .map((f) => {
      const lvl = f.levels && f.levels.length ? ` <span class="muted">(Stufe ${f.levels.join(", ")})</span>` : "";
      const name = f.name_de ? `${escapeHtml(f.name_de)} <span class="muted">(${escapeHtml(f.name)})</span>` : escapeHtml(f.name);
      return `<details class="opt-feature"><summary><b>${name}</b>${lvl}</summary>${trBlockHtml(f.desc, f.desc_de)}</details>`;
    })
    .join("");
  const profs = d.profs ? `<h4>${t("Übungen")}</h4>${trBlockHtml(d.profs, d.profs_de)}` : "";
  return `<div class="opt-details">${trBlockHtml(o.desc, o.desc_de)}${profs}${items ? `<h4>${o.kind === "races" ? t("Merkmale") : o.kind === "backgrounds" ? t("Vorteile") : t("Merkmale nach Stufe")}</h4>${items}` : ""}${
    o.notes ? `<p class="muted">${escapeHtml(o.notes)}</p>` : ""}</div>`;
}

// ---------- editor (new entries and changes) ----------

function asiFieldsHtml(asi) {
  const fixed = (asi && asi.fixed) || {};
  const choices = (asi && asi.choices) || [];
  const from = new Set(choices.flatMap((c) => c.from));
  const points = choices.reduce((s, c) => s + c.points, 0);
  const max = choices.length ? Math.max(...choices.map((c) => c.max)) : 1;
  return `
    <div class="edit-row"><span class="muted">${t("Feste Boni:")}</span>${ABILITIES.map(
      ([k, short]) => `<label class="inline-checkbox">${short} <input type="number" class="o-fixed" data-ab="${k}" min="-2" max="4" value="${fixed[k] || ""}" placeholder="0" /></label>`
    ).join("")}</div>
    <div class="edit-row"><span class="muted">${t("Frei verteilbar:")}</span>
      <input type="number" class="o-points" min="0" max="6" value="${points || ""}" placeholder="${t("Punkte")}" title="${t("Punkte")}" />
      <span class="muted">${t("je höchstens")}</span>
      <input type="number" class="o-max" min="1" max="2" value="${max}" title="${t("Höchstens pro Attribut")}" />
      <span class="muted">${t("auf")}</span>
      ${ABILITIES.map(([k, short]) => `<label class="inline-checkbox"><input type="checkbox" class="o-from" data-ab="${k}" ${from.has(k) || !choices.length ? "checked" : ""} /> ${short}</label>`).join("")}
    </div>`;
}

function readAsiFields(row, previous) {
  const fixed = {};
  for (const el of row.querySelectorAll(".o-fixed")) if (parseInt(el.value, 10)) fixed[el.dataset.ab] = parseInt(el.value, 10);
  const points = parseInt(row.querySelector(".o-points").value, 10) || 0;
  const max = parseInt(row.querySelector(".o-max").value, 10) || 1;
  const from = [...row.querySelectorAll(".o-from")].filter((c) => c.checked).map((c) => c.dataset.ab);
  // Unchanged choices keep their original split (e.g. a people with two separate choices).
  const old = (previous && previous.choices) || [];
  const same = old.length && old.reduce((s, c) => s + c.points, 0) === points && Math.max(...old.map((c) => c.max)) === max
    && [...new Set(old.flatMap((c) => c.from))].sort().join() === [...from].sort().join();
  const choices = same ? old : points && from.length ? [{ points, max, from }] : [];
  return Object.keys(fixed).length || choices.length ? { fixed, choices } : null;
}

function optionFormHtml(kind, o = {}) {
  const d = o.data || {};
  const esc = escapeHtml;
  const rows = [
    `<div class="edit-row">
      <input class="o-name" value="${esc(o.name || "")}" placeholder="${t("Name")}" />
      <input class="o-name-en" value="${esc(o.name_en || "")}" placeholder="${t("Englischer Name (Open5e)")}" title="${t("Klassen: so heisst die Klasse in den Zauberlisten")}" />
      <label class="inline-checkbox"><input type="checkbox" class="o-2024" ${o.is_2024 ? "checked" : ""} /> 2024-Regeln</label>
    </div>`,
  ];
  if (kind === "classes") {
    rows.push(`<div class="edit-row">
      <select class="o-hit-die">${[6, 8, 10, 12].map((n) => `<option value="${n}" ${d.hit_die === n ? "selected" : ""}>${t("Trefferwürfel W{n}", { n })}</option>`).join("")}</select>
      <span class="muted">${t("Rettungswürfe:")}</span>
      ${ABILITIES.map(([k, short]) => `<label class="inline-checkbox"><input type="checkbox" class="o-save" data-ab="${k}" ${(d.saves || []).includes(k) ? "checked" : ""} /> ${short}</label>`).join("")}
    </div>
    <div class="edit-row"><textarea class="o-profs" rows="2" placeholder="${t("Übungen (Rüstungen, Waffen, Werkzeuge)")}">${esc(d.profs || "")}</textarea></div>`);
  }
  if (kind === "subclasses") {
    rows.push(`<div class="edit-row"><select class="o-parent"><option value="">${t("-- Klasse --")}</option>${parentClassNames()
      .map((n) => `<option ${n === o.parent ? "selected" : ""}>${esc(n)}</option>`).join("")}</select></div>`);
  }
  if (kind === "feats") {
    rows.push(`<div class="edit-row">
      <select class="o-feat-type"><option value="">${t("-- Art --")}</option>${Object.entries(FEAT_TYPE_ONE)
        .map(([v, l]) => `<option value="${v}" ${d.feat_type === v ? "selected" : ""}>${l}</option>`).join("")}</select>
      <input class="o-prereq" value="${esc(d.prerequisite || "")}" placeholder="${t("Voraussetzung, z.B. Level 4+")}" />
      <label class="inline-checkbox"><input type="checkbox" class="o-repeatable" ${d.repeatable ? "checked" : ""} /> ${t("mehrfach wählbar")}</label>
    </div>`);
  }
  if (kind === "races" || kind === "backgrounds" || kind === "feats") rows.push(asiFieldsHtml(d.asi));
  if (kind === "races") {
    rows.push(`<div class="edit-row"><span class="muted">${t("Bewegungsrate (ft):")}</span><input type="number" class="o-speed" step="5" min="0" value="${(d.speed && d.speed.walk) || ""}" placeholder="30" /></div>`);
  }
  if (kind === "backgrounds") {
    rows.push(`<div class="edit-row"><span class="muted">${t("Fertigkeiten:")}</span>${SKILLS.map(
      ([k, label]) => `<label class="inline-checkbox"><input type="checkbox" class="o-skill" data-skill="${k}" ${(d.skills || []).includes(k) ? "checked" : ""} /> ${label}</label>`
    ).join("")}</div>`);
  }
  rows.push(`<div class="edit-row"><textarea class="o-desc" rows="3" placeholder="${t("Beschreibung")}">${esc(o.desc || "")}</textarea></div>`);
  if (FEATURE_LISTS[kind]) rows.push(featureListHtml(kind, (o.data || {})[FEATURE_LISTS[kind].key] || []));
  return rows.join("");
}

// The list each kind keeps: class and subclass features gained at a level, traits of a people,
// benefits of a background (feats have none: their text is the description). Imported entries also
// carry a type (SPEED, skill_proficiency …), kept as is.
const FEATURE_LISTS = {
  classes: { key: "features", title: t("Merkmale nach Stufe"), one: t("Merkmal"), levels: true },
  subclasses: { key: "features", title: t("Merkmale nach Stufe"), one: t("Merkmal"), levels: true },
  races: { key: "traits", title: t("Merkmale"), one: t("Merkmal"), levels: false },
  backgrounds: { key: "benefits", title: t("Vorteile"), one: t("Vorteil"), levels: false },
};

function featureRowHtml(kind, f = {}) {
  const esc = escapeHtml;
  const levels = FEATURE_LISTS[kind].levels
    ? `<input class="o-f-levels" value="${esc((f.levels || []).join(", "))}" placeholder="${t("Stufe, z.B. 3 oder 3, 10")}" title="${t("Ab welcher Stufe (mehrere mit Komma)")}" />`
    : "";
  return `<div class="opt-feature-row" ${f.type ? `data-type="${esc(f.type)}"` : ""}>
      <div class="edit-row"><input class="o-f-name" value="${esc(f.name || "")}" placeholder="${t("Name")}" />${levels}
        <button type="button" class="ghost o-f-del" title="${t("Entfernen")}">✕</button></div>
      <textarea class="o-f-desc" rows="3" placeholder="${t("Beschreibung (Markdown: **fett**, *kursiv*)")}">${esc(f.desc || "")}</textarea>
    </div>`;
}

// Collapsed when there are already entries, so long imported lists don't swamp the form.
function featureListHtml(kind, list) {
  const l = FEATURE_LISTS[kind];
  return `<details class="opt-feature-list" ${list.length ? "" : "open"}>
      <summary>${l.title} (${list.length})</summary>
      <div class="opt-feature-rows">${list.map((f) => featureRowHtml(kind, f)).join("")}</div>
      <button type="button" class="ghost o-f-add" data-kind="${kind}">+ ${l.one}</button>
    </details>`;
}

function readFeatureList(kind, row) {
  const levelsOf = (el) => [...new Set(String(el ? el.value : "").split(/[,;\s]+/).map((n) => parseInt(n, 10)).filter((n) => n >= 1 && n <= 20))].sort((a, b) => a - b);
  const list = [...row.querySelectorAll(".opt-feature-row")]
    .map((r) => {
      const f = { name: r.querySelector(".o-f-name").value.trim(), desc: r.querySelector(".o-f-desc").value.trim() || null };
      if (FEATURE_LISTS[kind].levels) f.levels = levelsOf(r.querySelector(".o-f-levels"));
      if (r.dataset.type) f.type = r.dataset.type;
      return f;
    })
    .filter((f) => f.name);
  if (FEATURE_LISTS[kind].levels) list.sort((a, b) => (a.levels[0] || 0) - (b.levels[0] || 0));
  return list;
}

// Adding and removing feature rows, in any form on the library pages.
document.getElementById("library").addEventListener("click", (e) => {
  const add = e.target.closest(".o-f-add");
  if (add) {
    add.previousElementSibling.insertAdjacentHTML("beforeend", featureRowHtml(add.dataset.kind));
    add.previousElementSibling.lastElementChild.querySelector(".o-f-name").focus();
  } else if (e.target.closest(".o-f-del")) {
    e.target.closest(".opt-feature-row").remove();
  }
});

function readOptionForm(kind, row, o = {}) {
  const name = row.querySelector(".o-name").value.trim();
  if (!name) return null;
  const data = { ...(o.data || {}) };
  if (kind === "classes") {
    data.hit_die = parseInt(row.querySelector(".o-hit-die").value, 10);
    data.saves = [...row.querySelectorAll(".o-save")].filter((c) => c.checked).map((c) => c.dataset.ab);
    data.profs = row.querySelector(".o-profs").value.trim() || null;
  }
  if (kind === "feats") {
    data.feat_type = row.querySelector(".o-feat-type").value || null;
    data.prerequisite = row.querySelector(".o-prereq").value.trim() || null;
    data.repeatable = row.querySelector(".o-repeatable").checked;
  }
  if (kind === "races" || kind === "backgrounds" || kind === "feats") data.asi = readAsiFields(row, data.asi);
  if (kind === "races") {
    const walk = parseInt(row.querySelector(".o-speed").value, 10);
    data.speed = walk ? { ...(data.speed || {}), walk } : data.speed || null;
  }
  if (kind === "backgrounds") data.skills = [...row.querySelectorAll(".o-skill")].filter((c) => c.checked).map((c) => c.dataset.skill);
  if (FEATURE_LISTS[kind]) data[FEATURE_LISTS[kind].key] = readFeatureList(kind, row);
  return {
    name,
    name_en: row.querySelector(".o-name-en").value.trim() || null,
    parent: kind === "subclasses" ? row.querySelector(".o-parent").value || null : o.parent || null,
    is_2024: row.querySelector(".o-2024").checked,
    data,
    desc: row.querySelector(".o-desc").value.trim() || null,
    notes: o.notes || null,
  };
}

// ---------- list ----------

function filteredOptions(kind) {
  const f = optionFilters[kind];
  return charOptions(kind).filter((o) => {
    if (f.search && !`${o.name} ${o.name_en || ""}`.toLowerCase().includes(f.search)) return false;
    if (f.rules && (f.rules === "2024") !== !!o.is_2024) return false;
    if (f.parent && o.parent !== f.parent) return false;
    return true;
  });
}

function renderOptionList(kind) {
  const el = document.getElementById(`opt-list-${kind}`);
  if (!el) return;
  const parentSel = document.querySelector(`#lib-${kind} .opt-parent-filter`);
  if (parentSel) {
    const parents = [...new Set(charOptions(kind).map((o) => o.parent).filter(Boolean))].sort();
    parentSel.innerHTML = `<option value="">${t("Alle Klassen")}</option>${parents.map((p) => `<option ${p === optionFilters[kind].parent ? "selected" : ""}>${escapeHtml(p)}</option>`).join("")}`;
  }
  const list = filteredOptions(kind);
  el.innerHTML = list.length ? "" : `<p class="muted">${charOptions(kind).length ? t("Keine Treffer für die aktuellen Filter.") : t("Noch nichts importiert.")}</p>`;
  for (const o of list) {
    const wrap = document.createElement("div");
    const row = document.createElement("div");
    row.className = "list-item";
    if (editingOptions.has(o.id)) {
      row.classList.add("opt-edit");
      row.innerHTML = `${optionFormHtml(kind, o)}
        <div class="edit-row"><button class="save-btn">${t("Speichern")}</button><button class="ghost cancel-btn">${t("Abbrechen")}</button></div>`;
      row.querySelector(".save-btn").addEventListener("click", async () => {
        const body = readOptionForm(kind, row, o);
        if (!body) return alert(t("Name ist nötig."));
        await api(`/api/options/${kind}/${o.id}`, "PUT", body);
        editingOptions.delete(o.id);
        await loadCharOptions();
      });
      row.querySelector(".cancel-btn").addEventListener("click", () => {
        editingOptions.delete(o.id);
        renderOptionList(kind);
      });
    } else {
      const en = o.name_en && o.name_en !== o.name ? `<span class="muted">${escapeHtml(o.name_en)}</span>` : "";
      row.innerHTML = `
        <strong>${escapeHtml(o.name)}</strong>${en}
        ${o.is_2024 ? '<span class="warn-text">2024-Regeln</span>' : ""}
        <span class="muted">${escapeHtml(optionSummary(o))}</span>
        <span class="spacer"></span>
        <button class="ghost sb-toggle">${t("📖 Details")}</button>
        <button class="ghost edit-btn">${t("Bearbeiten")}</button>
        <button class="danger del-btn">${t("Löschen")}</button>`;
      row.querySelector(".sb-toggle").addEventListener("click", () => {
        if (expandedOptions.has(o.id)) expandedOptions.delete(o.id);
        else expandedOptions.add(o.id);
        renderOptionList(kind);
      });
      row.querySelector(".edit-btn").addEventListener("click", () => {
        editingOptions.add(o.id);
        renderOptionList(kind);
      });
      row.querySelector(".del-btn").addEventListener("click", async () => {
        if (!confirm(t("{name} löschen? Charakterblätter behalten den Namen und die Boni.", { name: o.name }))) return;
        await api(`/api/options/${kind}/${o.id}`, "DELETE");
        await loadCharOptions();
      });
    }
    wrap.appendChild(row);
    if (expandedOptions.has(o.id) && !editingOptions.has(o.id)) {
      const details = document.createElement("div");
      details.innerHTML = optionDetailsHtml(o);
      wrap.appendChild(details);
    }
    el.appendChild(wrap);
  }
}

// ---------- D&D Beyond import (subclasses, backgrounds and feats the DM owns there, see ddb_import.py) ----------

// Runs on a D&D Beyond class, background or feat page in the DM's own browser: copies the subclasses,
// the background or the feat on it to the clipboard. Nothing is sent anywhere; the DM pastes it below.
const DDB_BOOKMARKLET = `(()=>{const r=[...document.querySelectorAll('.static-container-race')].find((x)=>{const t=x.querySelector('h1');return t&&/(species|race) details\\s*$/i.test(t.textContent.trim())});
const s=r?null:document.querySelector('.subitems-list-details');
const b=r||s?null:document.querySelector('.details-container-background,.details-container-feat');
const a=r||s||b?null:document.querySelector('.p-article-content');
if(!r&&!s&&!b&&!a){alert('Hier gibt es nichts zu kopieren. Bitte eine Klassen-, Volks-, Hintergrund- oder Talent-Seite oder ein Buchkapitel von D&D Beyond öffnen.');return}
const h=document.querySelector('.page-heading h1')||document.querySelector('h1');
const html=(a?'<meta name="ddb-url" content="'+location.href.split('#')[0]+'">':'')+'<div class="page-heading">'+(h?h.outerHTML:'')+'</div>'+(r||s||b||a).outerHTML;
const name=h?h.textContent.trim().split(/\\s{2,}/)[0]:'';
const what=a?'Kapitel '+name:r?'Volk '+name:s?s.querySelectorAll('.subitems-list-details-item').length+' Unterklassen':(b.matches('.details-container-feat')?'Talent ':'Hintergrund ')+name;
const ok=()=>alert(what+' kopiert. Jetzt im Kampagnenbuch einfügen'+(a?' (⚙ Einrichtung → Abenteuer von D&D Beyond).':'.'));
const old=()=>{const t=document.createElement('textarea');t.value=html;document.body.appendChild(t);t.select();
document.execCommand('copy');t.remove();ok()};
navigator.clipboard?navigator.clipboard.writeText(html).then(ok,old):old()})()`.replace(/\n/g, "");

const DDB_KINDS = ["subclasses", "races", "backgrounds", "feats"];

function ddbPanelHtml() {
  return `
    <details class="panel collapsible ddb-import">
      <summary><h3>${t("D&amp;D Beyond-Import")}</h3></summary>
      <p class="muted small">${t("Für Unterklassen, Völker, Hintergründe und Talente, die du auf D&amp;D Beyond gekauft hast. Einmalig das\n        Lesezeichen in die Lesezeichenleiste ziehen:")} <a class="ddb-bookmarklet" href="javascript:${encodeURIComponent(DDB_BOOKMARKLET)}"
        onclick="event.preventDefault(); alert(${escapeHtml(JSON.stringify(t("In die Lesezeichenleiste ziehen, nicht hier anklicken.")))})">${t("📋 DDB kopieren")}</a>.
        ${t("Dann auf D&amp;D Beyond angemeldet eine Klassenseite (für die Unterklassen, z.B. Cleric) oder die Seite eines Volks (mit seinen Untervölkern), Hintergrunds oder Talents öffnen, das Lesezeichen anklicken und hier einfügen. Mehrere Völker, Hintergründe und Talente kann man nacheinander kopieren und untereinander einfügen. Alternativ die Seite speichern (Strg+S, „nur HTML“) und die Datei wählen.")}</p>
      <div class="form-row">
        <textarea class="ddb-html" rows="2" placeholder="${t("Hier einfügen (Strg+V)")}"></textarea>
      </div>
      <div class="form-row">
        <input type="file" class="ddb-file" accept=".html,.htm,text/html" multiple />
        <button class="ddb-parse-btn">${t("Lesen")}</button>
        <span class="muted ddb-status"></span>
      </div>
      <div class="ddb-results"></div>
    </details>`;
}

// existing: the entry of the chosen ruleset with this name, which a ticked row replaces.
function ddbRowHtml(kind, e, i, info, existing, picked) {
  return `
    <label class="list-item">
      <input type="checkbox" class="ddb-pick" data-kind="${kind}" data-i="${i}" ${picked ? "checked" : ""} />
      <strong>${escapeHtml(e.name)}</strong>
      <span class="muted">${escapeHtml(e.source_name || "")}</span>
      <span class="muted">${info}</span>
      <span class="spacer"></span>
      ${existing ? `<span class="muted">${t("schon vorhanden ({source}) – angehakt wird ersetzt", { source: escapeHtml(existing.source) })}</span>` : ""}
    </label>`;
}

function bindDdbImport(sec) {
  const $ = (sel) => sec.querySelector(sel);
  const status = (t) => ($(".ddb-status").textContent = t);
  let page = null;
  // The ruleset of a row: the page's for subclasses (one class page), each row's own otherwise. Which
  // entry already exists depends on it; a row is ticked unless one does, until the DM ticks it.
  const rulesOf = (kind, e) => (kind === "subclasses" ? !!page.is_2024 : !!e.is_2024);
  const existingOf = (kind, e) => ((e.existing || {})[rulesOf(kind, e) ? "1" : "0"]) || null;
  const pickedOf = (kind, e) => ("picked" in e ? e.picked : !existingOf(kind, e));
  const row = (kind, e, i, info) => ddbRowHtml(kind, e, i, info, existingOf(kind, e), pickedOf(kind, e));
  const results = $(".ddb-results");
  results.addEventListener("input", (ev) => {
    if (ev.target.classList.contains("ddb-parent")) page.class_name = ev.target.value;
  });
  results.addEventListener("change", (ev) => {
    const t = ev.target;
    if (t.classList.contains("ddb-pick")) {
      page[t.dataset.kind][t.dataset.i].picked = t.checked;
      return;
    }
    if (t.classList.contains("ddb-2024")) {
      page.is_2024 = t.checked;
      for (const e of page.subclasses) delete e.picked;
    } else if (t.classList.contains("ddb-rules")) {
      const e = page[t.dataset.kind][t.dataset.i];
      e.is_2024 = t.value === "1";
      delete e.picked;
    } else return;
    render();
  });

  const render = () => {
    const el = $(".ddb-results");
    const subs = page.subclasses, bgs = page.backgrounds, feats = page.feats, races = page.races || [];
    if (!subs.length && !bgs.length && !feats.length && !races.length) {
      el.innerHTML = `<p class="muted">${t("{n} Einträge auf der Seite, aber keiner mit Inhalt – vermutlich nicht gekauft oder nicht angemeldet.", { n: page.found })}</p>`;
      return;
    }
    el.innerHTML = `
      ${subs.length ? `
        <h4>${t("Unterklassen")}</h4>
        <div class="form-row">
          <label>${t("Klasse (englisch)")} <input class="ddb-parent" value="${escapeHtml(page.class_name || "")}" /></label>
          <label><input type="checkbox" class="ddb-2024" ${page.is_2024 ? "checked" : ""} /> 2024-Regeln</label>
        </div>
        <div class="list">${subs.map((s, i) => row("subclasses", s, i,
          t("{n} Merkmale, Stufe {levels}", { n: s.features.length, levels: [...new Set(s.features.flatMap((f) => f.levels))].join(", ") }))).join("")}
        </div>` : ""}
      ${races.length ? `
        <h4>${t("Völker")}</h4>
        <div class="list">${races.map((r, i) => row("races", r, i, `
          <select class="ddb-rules" data-kind="races" data-i="${i}">
            <option value="0" ${r.is_2024 ? "" : "selected"}>2014</option>
            <option value="1" ${r.is_2024 ? "selected" : ""}>2024</option>
          </select> ${r.parent ? `${t("Untervolk von {name}", { name: escapeHtml(r.parent) })} · ` : ""}${t("{n} Merkmale", { n: r.traits.length })}`)).join("")}
        </div>` : ""}
      ${bgs.length ? `
        <h4>${t("Hintergründe")}</h4>
        <div class="list">${bgs.map((b, i) => row("backgrounds", b, i, `
          <select class="ddb-rules" data-kind="backgrounds" data-i="${i}">
            <option value="0" ${b.is_2024 ? "" : "selected"}>2014</option>
            <option value="1" ${b.is_2024 ? "selected" : ""}>2024</option>
          </select> ${b.benefits.map((x) => escapeHtml(x.name)).join(" · ")}`)).join("")}
        </div>` : ""}
      ${feats.length ? `
        <h4>${t("Talente")}</h4>
        <div class="list">${feats.map((f, i) => row("feats", f, i, `
          <select class="ddb-rules" data-kind="feats" data-i="${i}">
            <option value="0" ${f.is_2024 ? "" : "selected"}>2014</option>
            <option value="1" ${f.is_2024 ? "selected" : ""}>2024</option>
          </select> ${escapeHtml([FEAT_TYPE_ONE[f.feat_type] || f.feat_type, f.prerequisite && `Voraussetzung: ${f.prerequisite}`].filter(Boolean).join(" · "))}`)).join("")}
        </div>` : ""}
      <button class="ddb-import-btn">${t("Ausgewählte importieren")}</button>`;
    $(".ddb-import-btn").addEventListener("click", async (ev) => {
      const entries = [];
      for (const c of sec.querySelectorAll(".ddb-pick:checked")) {
        const kind = c.dataset.kind;
        const e = page[kind][c.dataset.i];
        const existing = existingOf(kind, e);
        const base = { kind, name: e.name, source_name: e.source_name, desc: e.desc, is_2024: rulesOf(kind, e),
          replace_id: existing ? existing.id : null };
        if (kind === "subclasses") {
          const parent = (page.class_name || "").trim();
          if (!parent) return alert(t("Klasse ist nötig."));
          entries.push({ ...base, parent, features: e.features });
        } else if (kind === "backgrounds") {
          entries.push({ ...base, benefits: e.benefits });
        } else if (kind === "races") {
          entries.push({ ...base, parent: e.parent, traits: e.traits });
        } else {
          entries.push({ ...base, feat_type: e.feat_type, prerequisite: e.prerequisite });
        }
      }
      if (!entries.length) return;
      ev.target.disabled = true;
      try {
        await api("/api/options/ddb/import", "POST", { entries });
        status(`✓ ${entries.length} importiert`);
        $(".ddb-results").innerHTML = "";
        $(".ddb-html").value = "";
        $(".ddb-file").value = "";
        await loadCharOptions();
      } catch (err) {
        ev.target.disabled = false;
        status(err.message);
      }
    });
  };

  $(".ddb-parse-btn").addEventListener("click", async () => {
    const files = [...$(".ddb-file").files];
    const html = [$(".ddb-html").value.trim(), ...(await Promise.all(files.map((f) => f.text())))].join("\n");
    if (!html.trim()) return status(t("Erst einfügen oder eine Datei wählen."));
    status(t("Lese …"));
    try {
      page = await api("/api/options/ddb/parse", "POST", { html });
    } catch (err) {
      $(".ddb-results").innerHTML = "";
      return status(err.message.includes("400") ? t("Nichts gefunden – ist das eine Klassen-, Hintergrund- oder Talent-Seite von D&D Beyond?") : err.message);
    }
    status("");
    render();
  });
}

// ---------- pages ----------

function optionSectionHtml(kind) {
  const k = OPTION_KINDS[kind];
  const parentFilter = kind === "subclasses" ? '<select class="opt-parent-filter"></select>' : "";
  return `
    <details class="panel collapsible" open>
      <summary><h3>${t("Open5e {what}-Suche", { what: k.title })}</h3></summary>
      <div class="form-row">
        <input class="opt-search-input" placeholder="${k.example}" />
        <button class="opt-search-btn">${t("Suchen")}</button>
      </div>
      <div class="form-row bulk-import" data-kind="${kind}" data-label="${k.title}">
        <select class="bulk-scope">
          <option value="srd">${t("Nur 5e-SRD (offizielle Grundregeln)")}</option>
          <option value="all">${t("Alle Open5e-Quellen (inkl. Drittanbieter)")}</option>
        </select>
        <button class="ghost bulk-btn">⇩ Alle ${k.title} importieren</button>
        <span class="muted bulk-status"></span>
      </div>
      <p class="muted small">${t("Die Texte sind englisch (Open5e). SRD-Einträge erhalten deutsche Namen; 2014- und 2024-Fassung werden beide übernommen.")}</p>
      <div class="opt-results list"></div>
    </details>
    ${DDB_KINDS.includes(kind) ? ddbPanelHtml() : ""}
    <details class="panel collapsible">
      <summary><h3>${t("{what} selbst anlegen", { what: k.one })}</h3></summary>
      <div class="opt-new">${optionFormHtml(kind)}</div>
      <button class="opt-add-btn">${t("Hinzufügen")}</button>
    </details>
    <div class="panel">
      <div class="form-row">
        <input class="opt-filter" placeholder="${t("Name suchen...")}" />
        <select class="opt-rules-filter"><option value="">${t("Alle Regelwerke")}</option><option value="2014">2014</option><option value="2024">2024</option></select>
        ${parentFilter}
      </div>
      <div id="opt-list-${kind}" class="list"></div>
    </div>`;
}

for (const kind of Object.keys(OPTION_KINDS)) {
  const sec = document.createElement("section");
  sec.id = `lib-${kind}`;
  sec.className = "lib-tab";
  sec.hidden = true;
  sec.innerHTML = optionSectionHtml(kind);
  document.getElementById("library").appendChild(sec);
  const $ = (sel) => sec.querySelector(sel);
  bindBulkImport($(".bulk-import"), loadCharOptions);
  if (DDB_KINDS.includes(kind)) bindDdbImport(sec);

  const search = async () => {
    const q = $(".opt-search-input").value.trim();
    if (!q) return;
    const results = $(".opt-results");
    results.innerHTML = `<p class="muted">${t("Suche … (beim ersten Mal lädt Open5e die ganze Liste)")}</p>`;
    let hits;
    try {
      hits = await api(`/api/options/${kind}/open5e/search?q=${encodeURIComponent(q)}`);
    } catch (err) {
      results.innerHTML = `<p class="muted">${t("Open5e antwortet nicht: {error}", { error: escapeHtml(err.message) })}</p>`;
      return;
    }
    results.innerHTML = hits.length ? "" : `<p class="muted">${t("Nichts gefunden.")}</p>`;
    for (const r of hits) {
      const row = document.createElement("div");
      row.className = "list-item";
      row.innerHTML = `
        <strong>${escapeHtml(r.name)}</strong>
        ${r.name_en !== r.name ? `<span class="muted">${escapeHtml(r.name_en)}</span>` : ""}
        ${r.parent ? `<span class="muted">${kind === "subclasses" ? "von" : t("Unterart von")} ${escapeHtml(r.parent)}</span>` : ""}
        ${open5eSourceBadgeHtml(r)}
        <span class="spacer"></span>
        <button class="import-btn">${t("+ Import")}</button>`;
      row.querySelector(".import-btn").addEventListener("click", (ev) =>
        importOpen5eOne(ev.target, `/api/options/${kind}/import-open5e/${encodeURIComponent(r.slug)}`, loadCharOptions));
      results.appendChild(row);
    }
  };
  $(".opt-search-btn").addEventListener("click", search);
  $(".opt-search-input").addEventListener("keydown", (e) => e.key === "Enter" && search());

  $(".opt-add-btn").addEventListener("click", async () => {
    const form = $(".opt-new");
    const body = readOptionForm(kind, form);
    if (!body) return alert(t("Name ist nötig."));
    await api(`/api/options/${kind}`, "POST", body);
    form.innerHTML = optionFormHtml(kind);
    await loadCharOptions();
  });

  $(".opt-filter").addEventListener("input", (e) => {
    optionFilters[kind].search = e.target.value.trim().toLowerCase();
    renderOptionList(kind);
  });
  $(".opt-rules-filter").addEventListener("change", (e) => {
    optionFilters[kind].rules = e.target.value;
    renderOptionList(kind);
  });
  $(".opt-parent-filter")?.addEventListener("change", (e) => {
    optionFilters[kind].parent = e.target.value;
    renderOptionList(kind);
  });
}

window.libraryReady = Promise.all([window.libraryReady, loadCharOptions()]);
