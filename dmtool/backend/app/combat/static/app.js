const state = {
  campaigns: [],
  currentCampaignId: null,
  encounters: [],
  currentEncounterId: null,
  currentEncounter: null,
  roster: [],
  customMonsters: [],
  items: [],
  spells: [],
};

const CAMPAIGN_STORAGE_KEY = "combattracker_campaign_id";

const expandedCombatantStats = new Set();

// Campaigns, characters, bestiary, items and spells live in the Kampagnenbuch. This app forwards /kb/...
// to it (see kb.py), so its API and pictures are reached from here without a second origin.
const KB = "kb";
const kbPath = (path) => (path && path.startsWith("/uploads/") ? KB + path : path);

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
    throw new Error(`${method} ${path} -> ${resp.status}: ${text}`);
  }
  if (resp.status === 204) return null;
  return resp.json();
}


// ---------- campaigns ----------

async function loadCampaigns() {
  state.campaigns = (await api(`${KB}/api/campaigns`)).campaigns;

  if (state.campaigns.length === 0) {
    const name = prompt(t("Noch keine Kampagne vorhanden. Name der ersten Kampagne:"), t("Kampagne 1")) || t("Kampagne 1");
    state.campaigns = [await createCampaign(name)];
  }

  // The campaign open in the Kampagnenbuch, so all three parts show the same one; the one chosen
  // here last only if the Kampagnenbuch has none.
  const settings = await api(`${KB}/api/settings`).catch(() => ({}));
  const stored = parseInt(localStorage.getItem(CAMPAIGN_STORAGE_KEY), 10);
  const known = (id) => state.campaigns.some((c) => c.id === id);
  state.currentCampaignId = known(settings.campaign_id) ? settings.campaign_id : known(stored) ? stored : state.campaigns[0].id;
  reportActiveCampaign();

  renderCampaignSelect();
}

// Without a game world; the Kampagnenbuch asks for it when the campaign is opened there.
function createCampaign(name) {
  return api(`${KB}/api/campaigns`, "POST", { name, calendar: { type: "none" } });
}

// The player sheets (/spieler/ in the Kampagnenbuch) list only the characters of the campaign open here.
function reportActiveCampaign() {
  api(`${KB}/api/settings`, "PATCH", { campaign_id: state.currentCampaignId }).catch(() => {});
}

function renderCampaignSelect() {
  const sel = document.getElementById("campaign-select");
  sel.innerHTML =
    state.campaigns.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("") +
    `<option value="__new__">${t("+ Neue Kampagne...")}</option>`;
  sel.value = state.currentCampaignId;
}

async function switchCampaign(campaignId) {
  state.currentCampaignId = campaignId;
  localStorage.setItem(CAMPAIGN_STORAGE_KEY, String(campaignId));
  reportActiveCampaign();
  state.currentEncounterId = null;
  state.currentEncounter = null;
  document.getElementById("encounter-view").classList.add("hidden");
  await loadRoster();
  await loadEncounters();
  if (state.encounters.length > 0) {
    await selectEncounter(state.encounters[0].id);
  }
}

document.getElementById("campaign-select").addEventListener("change", async (e) => {
  const value = e.target.value;
  if (value === "__new__") {
    const name = prompt(t("Name der neuen Kampagne:"));
    if (!name) {
      renderCampaignSelect();
      return;
    }
    const created = await createCampaign(name);
    state.campaigns.push(created);
    state.currentCampaignId = created.id;
    renderCampaignSelect();
    await switchCampaign(created.id);
    return;
  }
  await switchCampaign(parseInt(value, 10));
});

document.getElementById("campaign-rename-btn").addEventListener("click", async () => {
  const current = state.campaigns.find((c) => c.id === state.currentCampaignId);
  if (!current) return;
  const name = prompt(t("Neuer Name der Kampagne:"), current.name);
  if (!name || name === current.name) return;
  const updated = await api(`${KB}/api/campaigns/${current.id}`, "PATCH", { name });
  const idx = state.campaigns.findIndex((c) => c.id === current.id);
  state.campaigns[idx] = updated;
  renderCampaignSelect();
});

document.getElementById("campaign-delete-btn").addEventListener("click", async () => {
  if (state.campaigns.length <= 1) return alert(t("Die letzte Kampagne kann nicht gelöscht werden."));
  const current = state.campaigns.find((c) => c.id === state.currentCampaignId);
  if (!current) return;
  const ok = confirm(
    t("Kampagne \"{name}\" wirklich löschen? Alles im Kampagnenbuch dazu (Einträge, Sessions, Charaktere) und alle Encounter werden unwiderruflich gelöscht.", { name: current.name })
  );
  if (!ok) return;
  await api(`${KB}/api/campaigns/${current.id}`, "DELETE");
  state.campaigns = state.campaigns.filter((c) => c.id !== current.id);
  await switchCampaign(state.campaigns[0].id);
  renderCampaignSelect();
});

// ---------- tabs ----------

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add("active");
    if (btn.dataset.tab === "display") loadDisplayTab();
  });
});


// ---------- party and library, read from the Kampagnenbuch ----------
// Edited there; the encounter only needs them to add combatants and to show their sheets.

async function loadRoster() {
  state.roster = await api(`${KB}/api/characters?campaign_id=${state.currentCampaignId}`);
  for (const pc of state.roster) pc.avatar_path = kbPath(pc.avatar_path);
  refreshAddRefUI();
}

async function loadCustomMonsters() {
  state.customMonsters = await api(`${KB}/api/monsters/custom`);
  for (const m of state.customMonsters) m.avatar_path = kbPath(m.avatar_path);
  refreshAddRefUI();
}

// Character sheets of the combatants show weapons, armor and spells from these.
async function loadLibrary() {
  [state.items, state.spells, state.options] = await Promise.all([
    api(`${KB}/api/items/custom`), api(`${KB}/api/spells/custom`), api(`${KB}/api/options`),
  ]);
  state.optionsUrl = `${KB}/api/options/entry`;
}

// ---------- encounters ----------

async function loadEncounters() {
  state.encounters = await api(`api/encounters?campaign_id=${state.currentCampaignId}`);
  const sel = document.getElementById("encounter-select");
  sel.innerHTML = `<option value="">${t("-- Encounter wählen --")}</option>`;
  for (const e of state.encounters) {
    const opt = document.createElement("option");
    opt.value = e.id;
    opt.textContent = `${e.name} (Runde ${e.round})`;
    sel.appendChild(opt);
  }
  if (state.currentEncounterId) {
    sel.value = state.currentEncounterId;
  }
  renderEncounterSidebar();
}

function renderEncounterSidebar() {
  const el = document.getElementById("encounter-sidebar-list");
  if (!el) return;
  el.innerHTML = "";
  if (state.encounters.length === 0) {
    el.innerHTML = `<p class="muted">${t("Keine Encounter in dieser Kampagne.")}</p>`;
    return;
  }
  for (const enc of state.encounters) {
    const item = document.createElement("div");
    item.className = `encounter-sidebar-item ${enc.id === state.currentEncounterId ? "active" : ""}`;
    const d = computeDifficulty(enc);
    const pill = d.level
      ? `<span class="difficulty-pill ${d.level}">${DIFFICULTY_LABELS[d.level]}</span>`
      : "";
    item.innerHTML = `
      <strong>${escapeHtml(enc.name)}</strong>
      <span class="muted">Runde ${enc.round}</span>
      ${pill}
    `;
    item.addEventListener("click", () => selectEncounter(enc.id));
    el.appendChild(item);
  }
}

async function selectEncounter(id) {
  state.currentEncounterId = id;
  document.getElementById("encounter-select").value = id || "";
  await refreshEncounter();
  renderEncounterSidebar();
  if (document.getElementById("add-kind").value === "pc") refreshAddRefUI();
}

document.getElementById("encounter-select").addEventListener("change", async (e) => {
  await selectEncounter(e.target.value ? parseInt(e.target.value, 10) : null);
});

document.getElementById("new-encounter-btn").addEventListener("click", async () => {
  const input = document.getElementById("new-encounter-name");
  const name = input.value.trim() || t("Encounter");
  const enc = await api("api/encounters", "POST", { campaign_id: state.currentCampaignId, name });
  input.value = "";
  state.currentEncounterId = enc.id;
  await loadEncounters();
  await refreshEncounter();
});

document.getElementById("rename-encounter-btn").addEventListener("click", async () => {
  if (!state.currentEncounterId) return;
  const current = state.encounters.find((e) => e.id === state.currentEncounterId);
  const name = prompt(t("Neuer Name des Encounters:"), current ? current.name : "");
  if (!name || (current && name === current.name)) return;
  await api(`api/encounters/${state.currentEncounterId}`, "PUT", { name });
  await loadEncounters();
});

document.getElementById("delete-encounter-btn").addEventListener("click", async () => {
  if (!state.currentEncounterId) return;
  if (!confirm(t("Encounter wirklich löschen?"))) return;
  await api(`api/encounters/${state.currentEncounterId}`, "DELETE");
  state.currentEncounterId = null;
  state.currentEncounter = null;
  await loadEncounters();
  document.getElementById("encounter-view").classList.add("hidden");
});

document.getElementById("next-turn-btn").addEventListener("click", async () => {
  if (!state.currentEncounterId) return;
  await api(`api/encounters/${state.currentEncounterId}/next-turn`, "POST");
  await refreshEncounter();
});

document.getElementById("prev-turn-btn").addEventListener("click", async () => {
  if (!state.currentEncounterId) return;
  await api(`api/encounters/${state.currentEncounterId}/prev-turn`, "POST");
  await refreshEncounter();
});

document.getElementById("roll-monster-init-btn").addEventListener("click", async () => {
  if (!state.currentEncounterId) return;
  await api(`api/encounters/${state.currentEncounterId}/roll-monster-initiative`, "POST");
  await refreshEncounter();
});

document.getElementById("reset-encounter-btn").addEventListener("click", async () => {
  if (!state.currentEncounterId) return;
  if (!confirm(t("Runde und Zugreihenfolge zurücksetzen?"))) return;
  await api(`api/encounters/${state.currentEncounterId}/reset`, "POST");
  await refreshEncounter();
});

async function refreshEncounter() {
  const view = document.getElementById("encounter-view");
  if (!state.currentEncounterId) {
    view.classList.add("hidden");
    return;
  }
  state.currentEncounter = await api(`api/encounters/${state.currentEncounterId}`);
  view.classList.remove("hidden");
  renderEncounter();
}

// ---------- encounter difficulty (DMG 2014: XP thresholds per character level,
// monster XP by challenge rating, multiplied by a factor for the number of monsters) ----------

const XP_THRESHOLDS_BY_LEVEL = {
  1: [25, 50, 75, 100], 2: [50, 100, 150, 200], 3: [75, 150, 225, 400],
  4: [125, 250, 375, 500], 5: [250, 500, 750, 1100], 6: [300, 600, 900, 1400],
  7: [350, 750, 1100, 1700], 8: [450, 900, 1400, 2100], 9: [550, 1100, 1600, 2400],
  10: [600, 1200, 1900, 2800], 11: [800, 1600, 2400, 3600], 12: [1000, 2000, 3000, 4500],
  13: [1100, 2200, 3400, 5100], 14: [1250, 2500, 3800, 5700], 15: [1400, 2800, 4300, 6400],
  16: [1600, 3200, 4800, 7200], 17: [2000, 3900, 5900, 8800], 18: [2100, 4200, 6300, 9500],
  19: [2400, 4900, 7300, 10900], 20: [2800, 5700, 8500, 12700],
};

const XP_BY_CR = {
  "0": 10, "1/8": 25, "1/4": 50, "1/2": 100, "1": 200, "2": 450, "3": 700, "4": 1100,
  "5": 1800, "6": 2300, "7": 2900, "8": 3900, "9": 5000, "10": 5900, "11": 7200, "12": 8400,
  "13": 10000, "14": 11500, "15": 13000, "16": 15000, "17": 18000, "18": 20000, "19": 22000,
  "20": 25000, "21": 33000, "22": 41000, "23": 50000, "24": 62000, "25": 75000, "26": 90000,
  "27": 105000, "28": 120000, "29": 135000, "30": 155000,
};

// DMG p. 82: multiplier by number of monsters, shifted one step for very small/large parties.
const ENCOUNTER_MULTIPLIERS = [1, 1.5, 2, 2.5, 3, 4];

function encounterMultiplierStep(monsterCount) {
  if (monsterCount <= 1) return 0;
  if (monsterCount === 2) return 1;
  if (monsterCount <= 6) return 2;
  if (monsterCount <= 10) return 3;
  if (monsterCount <= 14) return 4;
  return 5;
}

function computeDifficulty(enc) {
  const players = enc.combatants.filter((c) => c.kind === "pc");
  const monsters = enc.combatants.filter((c) => c.kind === "monster");
  if (players.length === 0 || monsters.length === 0) return { players, monsters };

  const thresholds = [0, 0, 0, 0];
  let unknownLevels = 0;
  for (const p of players) {
    const rawLevel = p.stat_block?.level;
    const level = Math.min(20, Math.max(1, parseInt(rawLevel, 10) || 1));
    if (!rawLevel) unknownLevels++;
    const t = XP_THRESHOLDS_BY_LEVEL[level];
    for (let i = 0; i < 4; i++) thresholds[i] += t[i];
  }

  let monsterXp = 0;
  let unknownCr = 0;
  for (const m of monsters) {
    const cr = m.stat_block?.challenge_rating;
    const xp = cr != null ? XP_BY_CR[String(cr).trim()] : undefined;
    if (xp === undefined) unknownCr++;
    else monsterXp += xp;
  }

  let step = encounterMultiplierStep(monsters.length);
  if (players.length < 3) step = Math.min(step + 1, ENCOUNTER_MULTIPLIERS.length - 1);
  else if (players.length >= 6) step = Math.max(step - 1, 0);
  const multiplier = ENCOUNTER_MULTIPLIERS[step];
  const adjustedXp = Math.round(monsterXp * multiplier);

  let level = "trivial";
  if (adjustedXp >= thresholds[3]) level = "toedlich";
  else if (adjustedXp >= thresholds[2]) level = "schwer";
  else if (adjustedXp >= thresholds[1]) level = "mittel";
  else if (adjustedXp >= thresholds[0]) level = "leicht";

  return { players, monsters, thresholds, monsterXp, multiplier, adjustedXp, level, unknownLevels, unknownCr };
}

const DIFFICULTY_LABELS = { trivial: t("Trivial"), leicht: t("Leicht"), mittel: t("Mittel"), schwer: t("Schwer"), toedlich: t("Tödlich") };

function renderDifficulty(enc) {
  const bar = document.getElementById("difficulty-bar");
  const d = computeDifficulty(enc);
  if (!d.thresholds) {
    // No players or no monsters in the encounter: nothing to rate yet.
    bar.classList.add("hidden");
    bar.innerHTML = "";
    return;
  }
  bar.classList.remove("hidden");

  const notes = [];
  if (d.unknownLevels > 0) notes.push(t("Stufe bei {n} Spieler(n) unbekannt, Stufe 1 angenommen.", { n: d.unknownLevels }));
  if (d.unknownCr > 0) notes.push(t("{n} Gegner ohne Herausforderungsgrad nicht mitgerechnet.", { n: d.unknownCr }));

  bar.innerHTML = `
    <span class="difficulty-pill ${d.level}">${DIFFICULTY_LABELS[d.level]}</span>
    <span class="difficulty-detail">
      ${t("{xp} XP (angepasst, ×{mult}) für {players} Spieler · Mittel ab {medium} · Schwer ab {hard} · Tödlich ab {deadly}", {
        xp: d.adjustedXp.toLocaleString(UI_LOCALE), mult: d.multiplier, players: d.players.length, medium: d.thresholds[1].toLocaleString(UI_LOCALE),
        hard: d.thresholds[2].toLocaleString(UI_LOCALE), deadly: d.thresholds[3].toLocaleString(UI_LOCALE) })}
    </span>
    ${notes.map((n) => `<span class="difficulty-note">${escapeHtml(n)}</span>`).join("")}
  `;
}

// Combatant id whose status dropdown is open; survives the re-render after each toggle.
let openStatusMenu = null;

function statusMenuHtml(c) {
  const active = new Set(c.status_effects.map((t) => conditionFor(t)?.key).filter(Boolean));
  return CONDITIONS.map(
    (cond) => `
      <label class="status-option">
        <input type="checkbox" data-cond="${cond.key}" ${active.has(cond.key) ? "checked" : ""} />
        <span class="status-icon">${conditionIconSvg(cond.key)}</span>
        <span>${cond.label}</span>
      </label>`
  ).join("");
}

document.addEventListener("click", (e) => {
  if (openStatusMenu !== null && !e.target.closest(".status-menu-wrap")) {
    openStatusMenu = null;
    renderEncounter();
  }
});

function renderEncounter() {
  const enc = state.currentEncounter;
  if (!enc) return;
  document.getElementById("round-num").textContent = enc.round;
  renderDifficulty(enc);

  const list = document.getElementById("combatant-list");
  list.innerHTML = "";
  if (enc.combatants.length === 0) {
    list.innerHTML = `<p class="muted">${t("Noch keine Kombattanten. Oben hinzufügen.")}</p>`;
    return;
  }

  for (const c of enc.combatants) {
    const row = document.createElement("div");
    const hpPct = c.max_hp > 0 ? (c.current_hp / c.max_hp) * 100 : 0;
    let barClass = "";
    if (hpPct <= 25) barClass = "critical";
    else if (hpPct <= 50) barClass = "low";

    const avatarEl = c.avatar_path
      ? `<img class="avatar" src="${c.avatar_path}" />`
      : `<div class="avatar-placeholder">${iconFor(c.kind, c.creature_type)}</div>`;
    const initBonusLabel =
      c.kind === "monster"
        ? ` <span class="muted">(${c.initiative_bonus >= 0 ? "+" : ""}${c.initiative_bonus})</span>`
        : "";
    // Every combatant has a sheet (name/HP/AC at least), PC or monster.
    const hasStats = true;

    row.className = `combatant-row ${c.kind} ${c.id === enc.current_combatant_id ? "active-turn" : ""} ${c.current_hp <= 0 ? "dead" : ""}`;
    row.innerHTML = `
      <div class="combatant-init">
        <input type="number" class="init-input" value="${c.initiative ?? ""}" placeholder="–" />
      </div>
      ${
        c.kind === "monster"
          ? `<div class="avatar-wrap ${c.is_boss ? "boss" : ""} ${c.is_hidden ? "hidden-monster" : ""}">
              ${avatarEl}
              <input type="checkbox" class="hide-cb" title="${t("Für Spieler verborgen")}" ${c.is_hidden ? "checked" : ""} />
              <input type="checkbox" class="boss-cb" title="${t("Boss")}" ${c.is_boss ? "checked" : ""} />
            </div>`
          : avatarEl
      }
      <div class="combatant-name">${escapeHtml(c.name)}${initBonusLabel}</div>
      <div class="combatant-hp-bar ${barClass}"><div style="width:${Math.max(0, hpPct)}%"></div></div>
      <div class="hp-stack">
        <div class="hp-controls">
          <button data-delta="-5">-5</button>
          <button data-delta="-1">-1</button>
          <span>${c.current_hp}/${c.max_hp}</span>
          <button data-delta="1">+1</button>
          <button data-delta="5">+5</button>
        </div>
        <div class="hp-controls temp-hp-controls">
          <button data-temp-delta="-5">-5</button>
          <button data-temp-delta="-1">-1</button>
          <span class="temp-hp-value">${c.temp_hp > 0 ? c.temp_hp : ""}</span>
          <button data-temp-delta="1">+1</button>
          <button data-temp-delta="5">+5</button>
        </div>
      </div>
      <div class="muted">AC ${c.ac}</div>
      <div class="status-tags" data-tags></div>
      <div class="status-menu-wrap">
        <button class="ghost status-btn">${t("Status ▾")}</button>
        <div class="status-menu ${openStatusMenu === c.id ? "" : "hidden"}">${statusMenuHtml(c)}</div>
      </div>
      ${hasStats ? `<button class="ghost sb-toggle">${t("📖 Stats")}</button>` : ""}
      <button class="danger remove-btn">✕</button>
    `;

    row.querySelector(".init-input").addEventListener("change", async (e) => {
      const val = parseInt(e.target.value, 10);
      if (isNaN(val)) {
        e.target.value = c.initiative ?? "";
        return;
      }
      await api(`api/encounters/${enc.id}/combatants/${c.id}`, "PATCH", { initiative: val });
      await refreshEncounter();
    });

    row.querySelectorAll("[data-delta]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const delta = parseInt(btn.dataset.delta, 10);
        await api(`api/encounters/${enc.id}/combatants/${c.id}`, "PATCH", { hp_delta: delta });
        await refreshEncounter();
      });
    });

    row.querySelectorAll("[data-temp-delta]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const delta = parseInt(btn.dataset.tempDelta, 10);
        await api(`api/encounters/${enc.id}/combatants/${c.id}`, "PATCH", { temp_hp_delta: delta });
        await refreshEncounter();
      });
    });

    // Monster flags on the avatar: boss (bottom left) and hidden from the player display (top left).
    for (const [selector, field] of [[".boss-cb", "is_boss"], [".hide-cb", "is_hidden"]]) {
      const cb = row.querySelector(selector);
      if (!cb) continue;
      cb.addEventListener("change", async () => {
        await api(`api/encounters/${enc.id}/combatants/${c.id}`, "PATCH", { [field]: cb.checked });
        await refreshEncounter();
      });
    }

    const setStatus = async (updated) => {
      await api(`api/encounters/${enc.id}/combatants/${c.id}`, "PATCH", { status_effects: updated });
      await refreshEncounter();
    };

    // Active statuses as small icons; click removes.
    const tagsEl = row.querySelector("[data-tags]");
    tagsEl.style.gridTemplateColumns = `repeat(${Math.min(c.status_effects.length, 4)}, 24px)`;
    for (const tag of c.status_effects) {
      const tagEl = document.createElement("span");
      tagEl.className = "status-tag";
      tagEl.innerHTML = conditionIconSvg(tag);
      tagEl.title = t("{name} – klicken zum Entfernen", { name: conditionLabel(tag) });
      tagEl.addEventListener("click", () => setStatus(c.status_effects.filter((x) => x !== tag)));
      tagsEl.appendChild(tagEl);
    }

    row.querySelector(".status-btn").addEventListener("click", () => {
      openStatusMenu = openStatusMenu === c.id ? null : c.id;
      renderEncounter();
    });

    row.querySelectorAll(".status-menu input[data-cond]").forEach((cb) => {
      cb.addEventListener("change", () => {
        const key = cb.dataset.cond;
        // Drop every tag that maps to this condition (also old free-text spellings), keep the rest in order.
        const others = c.status_effects.filter((t) => conditionFor(t)?.key !== key);
        setStatus(cb.checked ? [...others, key] : others);
      });
    });

    if (hasStats) {
      row.querySelector(".sb-toggle").addEventListener("click", () => {
        if (expandedCombatantStats.has(c.id)) expandedCombatantStats.delete(c.id);
        else expandedCombatantStats.add(c.id);
        renderEncounter();
      });
    }

    row.querySelector(".remove-btn").addEventListener("click", async () => {
      await api(`api/encounters/${enc.id}/combatants/${c.id}`, "DELETE");
      await refreshEncounter();
    });

    list.appendChild(row);

    const remoteStats = remoteShowStats && c.id === enc.current_combatant_id;
    if (hasStats && (expandedCombatantStats.has(c.id) || remoteStats)) {
      const sb = document.createElement("div");
      sb.innerHTML = renderCharSheet(c, c.kind);
      list.appendChild(sb);
    }
  }
}

// ---------- add combatant ----------

function refreshAddRefUI() {
  const kind = document.getElementById("add-kind").value;
  const wrap = document.getElementById("add-ref-wrap");
  wrap.innerHTML = "";
  addMonsterId = null;
  for (const id of ["add-hp", "add-ac"]) document.getElementById(id).placeholder = id === "add-hp" ? "HP" : "AC";

  if (kind === "pc") {
    // Players of the campaign; those already in the encounter are marked, they join automatically.
    const inEncounter = new Set(
      ((state.currentEncounter && state.currentEncounter.combatants) || [])
        .filter((c) => c.source === "roster")
        .map((c) => String(c.ref_id))
    );
    const sel = document.createElement("select");
    sel.id = "add-ref-select";
    sel.innerHTML =
      state.roster
        .map(
          (pc) =>
            `<option value="${pc.id}" data-init="${pc.initiative_bonus}">${escapeHtml(pc.name)} (HP ${pc.max_hp}/AC ${pc.ac})${inEncounter.has(String(pc.id)) ? t(" · schon dabei") : ""}</option>`
        )
        .join("") + `<option value="">${t("Manuell (Name, HP, AC unten eingeben)")}</option>`;
    const applyInit = () => {
      const opt = sel.options[sel.selectedIndex];
      document.getElementById("add-init").value = opt && opt.value ? opt.dataset.init : "";
    };
    sel.addEventListener("change", applyInit);
    wrap.appendChild(sel);
    applyInit();
    return;
  }

  // Monsters: type-ahead search over the bestiary.
  document.getElementById("add-init").value = "";
  wrap.innerHTML = `
    <div class="monster-picker">
      <input id="add-monster-query" type="search" placeholder="${t("Bestiarium durchsuchen…")}" autocomplete="off" />
      <div class="monster-results hidden"></div>
    </div>`;
  const input = wrap.querySelector("#add-monster-query");
  const list = wrap.querySelector(".monster-results");
  let hits = [];
  let active = 0;

  const pick = (m) => {
    addMonsterId = m.id;
    input.value = m.name;
    input.classList.add("picked");
    document.getElementById("add-hp").placeholder = `HP ${m.max_hp}`;
    document.getElementById("add-ac").placeholder = `AC ${m.ac}`;
    list.classList.add("hidden");
  };
  const show = () => {
    const q = input.value.trim().toLowerCase();
    const rank = (m) => {
      const n = m.name.toLowerCase();
      return n.startsWith(q) ? 0 : n.split(/[\s(,-]+/).some((w) => w.startsWith(q)) ? 1 : n.includes(q) ? 2 : 3;
    };
    hits = state.customMonsters
      .filter((m) => !q || rank(m) < 3 || (m.creature_type || "").toLowerCase().startsWith(q))
      .sort((a, b) => (q ? rank(a) - rank(b) : 0) || a.name.localeCompare(b.name))
      .slice(0, 12);
    active = 0;
    list.innerHTML = hits.length
      ? hits
          .map((m, i) => {
            const avatar = m.avatar_path
              ? `<img class="avatar" src="${m.avatar_path}" />`
              : `<div class="avatar-placeholder">${iconFor("monster", m.creature_type)}</div>`;
            return `<div class="monster-hit ${i === active ? "active" : ""}" data-i="${i}">
              ${avatar}
              <strong>${escapeHtml(m.name)}</strong>
              <span class="muted">CR ${escapeHtml(m.challenge_rating ?? "–")} · ${escapeHtml(capitalize(m.creature_type || "–"))} · HP ${m.max_hp} / AC ${m.ac}</span>
            </div>`;
          })
          .join("")
      : `<div class="monster-hit-empty muted">${t("Kein Treffer im Bestiarium. Neue Monster im Kampagnenbuch unter „Bestiarium“ anlegen oder HP/AC unten eingeben (manuell).")}</div>`;
    list.classList.remove("hidden");
  };
  const highlight = () => list.querySelectorAll(".monster-hit").forEach((el, i) => el.classList.toggle("active", i === active));

  input.addEventListener("focus", show);
  input.addEventListener("input", () => {
    addMonsterId = null;
    input.classList.remove("picked");
    document.getElementById("add-hp").placeholder = "HP";
    document.getElementById("add-ac").placeholder = "AC";
    show();
  });
  input.addEventListener("keydown", (e) => {
    if (list.classList.contains("hidden") || !hits.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      active = (active + (e.key === "ArrowDown" ? 1 : hits.length - 1)) % hits.length;
      highlight();
      list.querySelector(".monster-hit.active")?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(hits[active]);
    } else if (e.key === "Escape") {
      list.classList.add("hidden");
    }
  });
  // mousedown fires before the input loses focus, so the click still lands on the hit.
  list.addEventListener("mousedown", (e) => {
    const hit = e.target.closest(".monster-hit");
    if (!hit) return;
    e.preventDefault();
    pick(hits[Number(hit.dataset.i)]);
  });
  input.addEventListener("blur", () => list.classList.add("hidden"));
}

let addMonsterId = null;

document.getElementById("add-kind").addEventListener("change", refreshAddRefUI);

document.getElementById("add-combatant-btn").addEventListener("click", async () => {
  if (!state.currentEncounterId) return alert(t("Erst einen Encounter wählen/anlegen."));
  const kind = document.getElementById("add-kind").value;
  let source = "manual";
  let ref = null;
  let name = document.getElementById("add-name").value.trim() || null;
  if (kind === "pc") {
    ref = document.getElementById("add-ref-select")?.value || null;
    if (ref) source = "roster";
  } else if (addMonsterId) {
    source = "custom";
    ref = String(addMonsterId);
  } else {
    // Nothing picked: the typed search text becomes the name of a manual monster.
    name = name || document.getElementById("add-monster-query")?.value.trim() || null;
  }

  const hpVal = document.getElementById("add-hp").value;
  const acVal = document.getElementById("add-ac").value;
  const initVal = document.getElementById("add-init").value;

  const body = {
    kind,
    source,
    ref,
    name,
    max_hp: hpVal ? parseInt(hpVal, 10) : null,
    ac: acVal ? parseInt(acVal, 10) : null,
    initiative: initVal ? parseInt(initVal, 10) : null,
  };
  if (source === "manual" && (!body.name || body.max_hp === null || body.ac === null)) {
    return alert(kind === "pc" ? t("Manuell: Name, HP und AC eingeben.") : t("Monster im Bestiarium auswählen oder Name, HP und AC eingeben."));
  }

  try {
    await api(`api/encounters/${state.currentEncounterId}/combatants`, "POST", body);
  } catch (err) {
    return alert(err.message);
  }

  document.getElementById("add-name").value = "";
  document.getElementById("add-hp").value = "";
  document.getElementById("add-ac").value = "";
  document.getElementById("add-init").value = "";
  await refreshEncounter();
  // Keep the picked monster so several of the same kind can be added in a row.
  if (kind === "pc") refreshAddRefUI();
});

// ---------- player display ----------

// Inside the Kampagnenbuch (/tracker/) the display is on its public port under /anzeige/tracker/; at the
// old address (port 8420) it is the port after this one.
const IN_KB = location.pathname.startsWith("/tracker/");
const PLAYER_SHEET_PORT = 8441;
const DISPLAY_URL = IN_KB
  ? `${location.protocol}//${location.hostname}:${PLAYER_SHEET_PORT}/anzeige/tracker/`
  : `${location.protocol}//${location.hostname}:8421/`;

async function loadDisplayTab() {
  const sel = document.getElementById("display-encounter-select");
  sel.innerHTML =
    `<option value="">${t("-- kein Encounter --")}</option>` +
    state.encounters.map((e) => `<option value="${e.id}">${escapeHtml(e.name)} (Runde ${e.round})</option>`).join("");

  const current = await api("api/display/encounter");
  sel.value = current.encounter_id || "";

  const url = DISPLAY_URL;
  document.getElementById("display-url").textContent = url;
  document.getElementById("player-url").textContent = `${location.protocol}//${location.hostname}:${PLAYER_SHEET_PORT}/spieler/`;
  const iframe = document.getElementById("display-preview");
  if (iframe.src !== url) iframe.src = url;
}

document.getElementById("display-apply-btn").addEventListener("click", async () => {
  const sel = document.getElementById("display-encounter-select");
  const encounter_id = sel.value ? parseInt(sel.value, 10) : null;
  await api("api/display/encounter", "PUT", { encounter_id });
});

document.getElementById("display-clear-btn").addEventListener("click", async () => {
  await api("api/display/encounter", "PUT", { encounter_id: null });
  document.getElementById("display-encounter-select").value = "";
});

// ---------- utils ----------

function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// ---------- init ----------

// ---------- remote control (Stream Deck) ----------

// Stream Deck webhooks change the encounter on the server; poll so this view follows along.
let remoteRev = null;
// While on, the sheet of whoever's turn it is stays open and moves along with each turn.
let remoteShowStats = false;
// Latest character save (from /api/remote/state); undefined until the first poll.
let charactersRev;

const REMOTE_ACTIONS = [
  ["roll-monster-initiative", t("🎲 Initiative aller Monster würfeln")],
  ["next-turn", t("⟳ Nächster Zug")],
  ["prev-turn", t("⟲ Zurück")],
  ["toggle-stats", t("📖 Stats des aktuellen Kombattanten ein/aus")],
];

function renderRemoteUrls() {
  document.getElementById("remote-urls").innerHTML = REMOTE_ACTIONS.map(
    ([path, label]) => `<li><span>${label}</span><code>${new URL(`api/remote/${path}`, location.href).href}</code></li>`
  ).join("");
}

async function pollRemote() {
  let s;
  try {
    const resp = await fetch("api/remote/state", { cache: "no-store" });
    if (!resp.ok) return;
    s = await resp.json();
  } catch {
    return;
  }
  // Characters and monsters change in the Kampagnenbuch (players save their sheets there too); it tells
  // the tracker, which bumps this.
  if (charactersRev === undefined) charactersRev = s.characters_rev;
  else if (s.characters_rev !== charactersRev) {
    charactersRev = s.characters_rev;
    if (state.currentCampaignId) await loadRoster();
    await loadCustomMonsters();
    if (state.currentEncounterId) await refreshEncounter();
  }

  const first = remoteRev === null;
  const changed = s.rev !== remoteRev;
  remoteRev = s.rev;
  remoteShowStats = s.show_stats;
  if (first || !changed || s.encounter_id === null) return;

  if (s.encounter_id !== state.currentEncounterId) {
    if (s.campaign_id && s.campaign_id !== state.currentCampaignId) {
      await switchCampaign(s.campaign_id);
      renderCampaignSelect();
    }
    await selectEncounter(s.encounter_id);
  } else {
    await refreshEncounter();
  }
  const active = document.querySelector("#combatant-list .combatant-row.active-turn");
  if (active) active.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

renderRemoteUrls();
setInterval(pollRemote, 1500);

// ---------- setup drawer: database backup / restore ----------

function toggleSetup(open = document.getElementById("setup").hidden) {
  const setup = document.getElementById("setup");
  // Start below the header while it is in view, so the Einrichtung button stays reachable.
  setup.style.top = `${Math.max(0, document.querySelector("header").getBoundingClientRect().bottom)}px`;
  setup.hidden = !open;
  document.getElementById("btn-setup").classList.toggle("on", open);
}

document.getElementById("btn-setup").addEventListener("click", () => toggleSetup());
document.getElementById("btn-setup-close").addEventListener("click", () => toggleSetup(false));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !document.getElementById("setup").hidden) toggleSetup(false);
});

(async function init() {
  await loadCampaigns();
  await loadRoster();
  await loadCustomMonsters();
  await loadLibrary();
  await loadEncounters();
  refreshAddRefUI();
  if (state.encounters.length > 0) {
    await selectEncounter(state.encounters[0].id);
  }
})();

// The Kampagnenbuch's Einrichtung, also from the old address (port 8420/8430).
for (const a of document.querySelectorAll("[data-kb-link]")) {
  if (!["8440", ""].includes(location.port) && !location.pathname.startsWith("/tracker/") && !location.pathname.startsWith("/map/")) {
    a.href = `${location.protocol}//${location.hostname}:8440/`;
  }
}
