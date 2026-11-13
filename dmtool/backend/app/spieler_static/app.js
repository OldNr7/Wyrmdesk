// Player sheets: pick a character, read or edit its sheet, optionally show the turn order above it.
// The sheet itself (pcSheetHtml, readPcSheet, bindPcSheet, bindPcLive) comes from /shared/charsheet.js.

// charsheet.js reads armor and weapons from state.items and the spells of the class from state.spells.
const state = { items: [], spells: [], options: [], optionsUrl: "/api/player/options" };
let spellsClass = null;

const CHAR_KEY = "spieler_character_id";
const INIT_KEY = "spieler_show_initiative";
// While reading, check for changes from the DM (or another device) this often.
const POLL_MS = 3000;

let current = null;
let editing = false;

const sheetEl = document.getElementById("sheet");
const selectEl = document.getElementById("char-select");

function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// Private windows and blocked site data make storage throw; the page works without it.
function load(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {}
}

async function api(path, method = "GET", body) {
  const resp = await fetch(path, {
    method,
    cache: "no-store",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!resp.ok) throw Object.assign(new Error(`${method} ${path} -> ${resp.status}`), { status: resp.status });
  return resp.json();
}

function showStatus(text, kind = "") {
  const el = document.getElementById("status");
  el.textContent = text;
  el.className = `status ${kind}`;
  el.hidden = !text;
}

// ---------- character list ----------

async function loadList() {
  const campaigns = await api("/api/player/characters");
  const wanted = String(current ? current.id : load(CHAR_KEY) || "");
  const none = campaigns.every((camp) => camp.characters.length === 0);
  const prompt = none
    ? `– ${campaigns.length === 1 ? t("Keine Charaktere in „{name}“", { name: escapeHtml(campaigns[0].name) }) : t("Keine Charaktere")} –`
    : t("– Charakter wählen –");
  selectEl.innerHTML =
    `<option value="">${prompt}</option>` +
    campaigns
      .map(
        (camp) =>
          `<optgroup label="${escapeHtml(camp.name)}">${camp.characters
            .map((c) => {
              const sub = [c.char_class, c.level && t("Stufe {n}", { n: c.level })].filter(Boolean).join(" ");
              return `<option value="${c.id}">${escapeHtml(c.name)}${sub ? ` (${escapeHtml(sub)})` : ""}</option>`;
            })
            .join("")}</optgroup>`
      )
      .join("");
  selectEl.value = wanted;
  // A remembered character that has since been deleted falls back to the empty choice.
  if (selectEl.value !== wanted) selectEl.value = "";
  return selectEl.value;
}

selectEl.addEventListener("change", async () => {
  if (editing && !confirm(t("Ungespeicherte Änderungen verwerfen?"))) {
    selectEl.value = String(current.id);
    return;
  }
  editing = false;
  store(CHAR_KEY, selectEl.value || null);
  await openCharacter(selectEl.value);
});

// The list can change while the page is open (DM adds a character); refresh it on opening.
selectEl.addEventListener("focus", () => loadList().catch(() => {}));

// ---------- sheet ----------

async function openCharacter(id) {
  showStatus("");
  current = id ? await api(`/api/player/characters/${id}`) : null;
  if (current) await loadSpells(current.stat_block && current.stat_block.class_key, current.stat_block);
  render();
}

// The spells of the character's class plus those its subclass added from other lists; loaded again
// when the class changes while editing. all: the whole library (the level-up offers any list).
async function loadSpells(classKey, sb, all = false) {
  const cls = CLASSES[classKey];
  const extra = ((sb && sb.spell_list) || []).filter((s) => s.extra && s.id != null).map((s) => s.id);
  if (!all && !extra.length && (!cls || !cls.spell)) return;
  const key = all ? "*" : `${classKey}|${extra.join(",")}`;
  if (spellsClass === key || spellsClass === "*") return;
  const q = new URLSearchParams();
  if (!all) {
    if (cls && cls.spell) q.set("dnd_class", cls.en);
    if (extra.length) q.set("ids", extra.join(","));
  }
  state.spells = await api(`/api/player/spells?${q}`);
  spellsClass = key;
}

// Sheet and play state change separately (editor vs. HP, slots, ammunition); either means redraw.
const versionOf = (c) => `${c.updated_at}|${c.state_updated_at}`;

function render() {
  for (const [btn, show] of [
    ["edit-btn", current && !editing],
    ["levelup-btn", current && !editing && canLevelUp(current)],
    ["save-btn", current && editing],
    ["cancel-btn", current && editing],
  ]) {
    document.getElementById(btn).hidden = !show;
  }
  selectEl.disabled = false;
  if (!current) {
    sheetEl.innerHTML = `<p class="empty">${t("Wähle oben deinen Charakter.")}</p>`;
    document.title = t("Charakterblatt");
    return;
  }
  document.title = `${current.name} – ${t("Charakterblatt")}`;
  // A fresh element every time, so listeners from the previous render don't pile up.
  const root = document.createElement("div");
  root.innerHTML = pcSheetHtml(current, editing, {
    live: true, portrait: current.avatar_path, portraitEdit: editing, portraitFallback: characterPortraitFallback(current),
  });
  sheetEl.replaceChildren(root);
  if (editing) bindSheet(root);
  else bindPcLive(root, current, liveActions);
}

// HP, spell slots, ammunition and rests change right away, without the editor.
const liveActions = {
  hp: (body) => liveChange(`/api/player/characters/${current.id}/hp`, "POST", body),
  // extra: sheet values that follow from play (equipped items, prepared spells) and the AC.
  // base: the state the change started from; refused (409) if it changed meanwhile.
  playState: (play_state, extra = {}) => liveChange(`/api/player/characters/${current.id}/play-state`, "PUT",
    { play_state, base: current.play_state || {}, ...extra }),
  rest: (kind) => liveChange(`/api/player/characters/${current.id}/rest?kind=${kind}`, "POST"),
};

async function liveChange(path, method, body) {
  try {
    const fresh = await api(path, method, body);
    if (!editing && current && fresh.id === current.id) {
      current = fresh;
      render();
    }
  } catch (err) {
    if (err.status === 409 && current) {
      // Changed meanwhile somewhere else (second device, the DM): take that state instead of overwriting it.
      await openCharacter(current.id).catch(() => {});
      showStatus(t("Inzwischen anderswo geändert – neu geladen. Bitte nochmals versuchen."), "error");
      return;
    }
    showStatus(t("Nicht gespeichert! Verbindung prüfen und nochmals versuchen."), "error");
  }
}

// Same as the DM view: derived values follow every input, the modifier under each ability too.
function bindSheet(container) {
  bindPcSheet(container);
  // A new class brings its own spell list for the picker.
  container.addEventListener("change", async (e) => {
    if (e.target.matches("[data-portrait-input]")) return e.target.files[0] && changePortrait(e.target.files[0]);
    if (!e.target.matches('[data-field="class_key"]')) return;
    await loadSpells(e.target.value).catch(() => {});
    refreshPcDerived(container);
  });
  container.addEventListener("click", (e) => {
    if (e.target.closest("[data-portrait-remove]")) changePortrait(null);
  });
  for (const input of container.querySelectorAll("[data-ability]")) {
    input.addEventListener("input", () => {
      const v = input.value === "" ? null : parseInt(input.value, 10);
      container.querySelector(`[data-mod="${input.dataset.ability}"]`).textContent = abilityMod(v);
    });
  }
}

// Portrait upload (file) or removal (null), as in the Charaktererstellung. While editing only the
// picture is swapped, so nothing typed into the sheet gets lost.
async function changePortrait(file) {
  const path = `/api/player/characters/${current.id}/avatar`;
  try {
    let fresh;
    if (file) {
      const resp = await fetch(`${path}?filename=${encodeURIComponent(file.name)}`, { method: "POST", body: file });
      if (!resp.ok) throw Object.assign(new Error(), { status: resp.status });
      fresh = await resp.json();
    } else {
      fresh = await api(path, "DELETE");
    }
    current.avatar_path = fresh.avatar_path;
    const wrap = sheetEl.querySelector(".pc-portrait-wrap");
    if (wrap) wrap.outerHTML = pcPortraitSlotHtml(current.avatar_path, editing, characterPortraitFallback(current));
    else render();
  } catch (e) {
    showStatus(
      e && e.status === 400 ? t("Dieses Bildformat geht nicht (PNG, JPG, WebP oder GIF).") : file ? t("Bild nicht hochgeladen. Verbindung prüfen.") : t("Bild nicht entfernt. Verbindung prüfen."),
      "error"
    );
  }
}

document.getElementById("edit-btn").addEventListener("click", async () => {
  // Start from the latest version so the save check compares against what is really stored.
  await openCharacter(current.id);
  editing = true;
  render();
});

// Guided level-up (levelup.js): starts from the latest version, saved like the editor.
document.getElementById("levelup-btn").addEventListener("click", async () => {
  await openCharacter(current.id);
  // Subclasses can add spells from any list (Arcana Domain: wizard cantrips).
  await loadSpells(current.stat_block && current.stat_block.class_key, current.stat_block, true).catch(() => {});
  openLevelUp(current, async (body) => {
    try {
      current = await api(`/api/player/characters/${current.id}`, "PUT", { ...body, updated_at: current.updated_at });
    } catch (e) {
      throw new Error(e.status === 409 ? t("Der Charakter wurde inzwischen anderswo geändert. Bitte neu starten.") : t("Nicht gespeichert. Verbindung prüfen."));
    }
    await loadSpells(current.stat_block && current.stat_block.class_key, current.stat_block);
    render();
    showStatus(t("Stufe {n} erreicht.", { n: current.stat_block.level }), "ok");
    setTimeout(() => showStatus(""), 3000);
    loadList().catch(() => {});
  });
});

document.getElementById("cancel-btn").addEventListener("click", () => {
  editing = false;
  render();
});

document.getElementById("save-btn").addEventListener("click", save);

async function save() {
  const body = readPcSheet(sheetEl.firstElementChild);
  if (!body.name) return showStatus(t("Der Charakter braucht einen Namen."), "error");
  if (body.max_hp === null) return showStatus(t("Trefferpunkte-Maximum fehlt."), "error");
  const path = `/api/player/characters/${current.id}`;
  try {
    current = await api(path, "PUT", { ...body, updated_at: current.updated_at });
  } catch (e) {
    if (e.status === 409) {
      // The DM (or another device) saved this sheet after editing started here.
      if (!confirm(t("Dein Charakter wurde inzwischen anderswo geändert, z.B. vom DM.\n\nOK: deine Fassung speichern und die andere überschreiben.\nAbbrechen: weiter bearbeiten."))) return;
      try {
        current = await api(path, "PUT", body);
      } catch {
        return showStatus(t("Nicht gespeichert! Verbindung prüfen und nochmals versuchen."), "error");
      }
    } else {
      return showStatus(t("Nicht gespeichert! Verbindung prüfen und nochmals versuchen."), "error");
    }
  }
  editing = false;
  showStatus(t("Gespeichert."), "ok");
  setTimeout(() => showStatus(""), 2000);
  render();
  loadList().catch(() => {});
}

// Picks up changes the DM made while the sheet is only being read. Editing is never interrupted.
async function poll() {
  if (!current || editing || document.hidden) return;
  try {
    const fresh = await api(`/api/player/characters/${current.id}`);
    if (editing || !current || fresh.id !== current.id || versionOf(fresh) === versionOf(current)) return;
    // Don't throw away a number the player is typing into the HP or temp HP field.
    if (document.activeElement && document.activeElement.matches(".pc-hp-amount, .pc-temp-input, [data-ammo-start]")) return;
    current = fresh;
    render();
  } catch (e) {
    if (e.status === 404) {
      current = null;
      store(CHAR_KEY, null);
      await loadList();
      render();
    }
  }
}

window.addEventListener("beforeunload", (e) => {
  if (editing) e.preventDefault();
});

// ---------- turn order ----------
// The tracker's player display in a frame, on its own port of the same host (see compose.yaml);
// it only loads (and polls) while shown.
const TRACKER_DISPLAY_PORT = 8421;

function showInitiative(on) {
  document.getElementById("initiative").hidden = !on;
  const btn = document.getElementById("init-toggle");
  btn.setAttribute("aria-pressed", String(on));
  btn.classList.toggle("active", on);
  const frame = document.getElementById("init-frame");
  if (on && !frame.getAttribute("src")) frame.src = `${location.protocol}//${location.hostname}:${TRACKER_DISPLAY_PORT}/`;
  if (!on) frame.removeAttribute("src");
  store(INIT_KEY, on ? "1" : null);
}

document.getElementById("init-toggle").addEventListener("click", () => {
  showInitiative(document.getElementById("initiative").hidden);
});

// ---------- start ----------

(async () => {
  showInitiative(load(INIT_KEY) === "1");
  try {
    [state.items, state.options] = await Promise.all([api("/api/player/items"), api("/api/player/options")]);
    const id = await loadList();
    await openCharacter(id);
  } catch {
    showStatus(t("Keine Verbindung zum Combattracker."), "error");
  }
  setInterval(poll, POLL_MS);
})();
