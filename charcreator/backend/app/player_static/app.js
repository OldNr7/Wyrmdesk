// Charaktererstellung: a campaign's characters, each built on the Kampagnenbuch's own sheet
// (pcSheetHtml, readPcSheet, bindPcSheet, bindPcLive, from /shared/charsheet.js) in edit mode.
// charsheet.js reads armor/weapons from state.items and the spells of the class from state.spells.
const state = { items: [], spells: [], options: [] };
let spellsClass = null;

function token() {
  const m = location.pathname.match(/^\/k\/([^/]+)/);
  return m ? m[1] : null;
}
const TOKEN = token();
const API = TOKEN ? `/api/k/${TOKEN}` : null;
const pwKey = () => `ccpw:${TOKEN}`;

let campaign = null;
let characters = [];
let current = null; // the open character, or null while on the list
let editing = false;

const appEl = document.getElementById("app");
const backBtn = document.getElementById("back-btn");
const statusBtn = document.getElementById("status-btn");

function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function authHeaders() {
  const pw = TOKEN && localStorage.getItem(pwKey());
  return pw ? { "X-Campaign-Password": pw } : {};
}

async function api(path, method = "GET", body) {
  const headers = authHeaders();
  if (body) headers["Content-Type"] = "application/json";
  const resp = await fetch(path, {
    method,
    cache: "no-store",
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!resp.ok) {
    let detail = `${method} ${path} -> ${resp.status}`;
    try { detail = (await resp.json()).detail || detail; } catch { /* not json */ }
    throw Object.assign(new Error(detail), { status: resp.status });
  }
  return resp.json();
}

function showStatus(text, kind = "") {
  const el = document.getElementById("status");
  el.textContent = text;
  el.className = `status ${kind}`;
  el.hidden = !text;
}

// ---------- list ----------

async function loadList() {
  characters = await api(`${API}/characters`);
}

function renderList() {
  document.getElementById("campaign-name").textContent = campaign.name;
  backBtn.hidden = true;
  statusBtn.hidden = true;
  for (const id of ["edit-btn", "levelup-btn", "save-btn", "cancel-btn"]) document.getElementById(id).hidden = true;
  document.title = campaign.name;

  const items = characters.map((c) => {
    const cls = [c.char_class, c.subclass].filter(Boolean).join(" – ");
    const facts = [c.race, cls ? `${cls}${c.level ? ` ${t("Stufe {n}", { n: c.level })}` : ""}` : ""].filter(Boolean).join(" · ");
    return `
    <li data-open="${c.id}">
      ${c.avatar_path || listPortrait(c)
        ? `<img class="char-pic" src="${escapeHtml(c.avatar_path || listPortrait(c))}" alt="" />`
        : `<span class="char-pic no-pic" aria-hidden="true">${escapeHtml((c.name || "?").trim()[0] || "?")}</span>`}
      <span class="char-main">
        <span class="name">${escapeHtml(c.name) || t("(unbenannt)")}</span>
        <span class="facts">${facts ? escapeHtml(facts) : t("Noch kein Volk und keine Klasse")}</span>
      </span>
      ${c.player_name ? `<span class="player">${escapeHtml(c.player_name)}</span>` : ""}
      <span class="badge ${c.status}">${c.status === "fertig" ? t("fertig") : t("Entwurf")}</span>
    </li>`;
  }).join("");

  appEl.innerHTML = `
    ${characters.length ? `<ul class="char-list">${items}</ul>` : `<p class="empty">${t("Noch keine Charaktere. Leg unten den ersten an.")}</p>`}
    <form class="new-char-form" id="new-char">
      <input type="text" name="name" placeholder="${t("Name des Charakters")}" required>
      <input type="text" name="player_name" placeholder="${t("Dein Name")}">
      <button type="submit">${t("+ Neuen Charakter anlegen")}</button>
    </form>
    <button type="button" id="dates-btn" class="dates-link">${t("📅 Termine")}</button>`;

  appEl.querySelectorAll("[data-open]").forEach((li) => {
    li.addEventListener("click", () => openCharacter(Number(li.dataset.open)));
  });
  document.getElementById("dates-btn").addEventListener("click", showDates);
  document.getElementById("new-char").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = e.target.name.value.trim();
    if (!name) return;
    const player_name = e.target.player_name.value.trim() || null;
    try {
      const c = await api(`${API}/characters`, "POST", { name, player_name, max_hp: 1, ac: 10 });
      openCreationWizard(c, {
        // The sheet, then the starting gear (inventory and ammunition live in play_state), then
        // full HP: the draft was created with 1, and saving the sheet only ever lowers current HP.
        save: async (body, play_state) => {
          await api(`${API}/characters/${c.id}`, "PUT", { ...body, updated_at: c.updated_at });
          if (play_state) await api(`${API}/characters/${c.id}/play-state`, "PUT", { play_state });
          await api(`${API}/characters/${c.id}/hp`, "POST", { heal: body.max_hp });
        },
        discard: () => api(`${API}/characters/${c.id}`, "DELETE"),
        portrait: (file) => setPortrait(c.id, file).then((fresh) => {
          c.updated_at = fresh.updated_at; // the save above checks against this
          return fresh;
        }),
        onClose: () => showList(),
      });
    } catch {
      showStatus(t("Nicht angelegt. Verbindung prüfen."), "error");
    }
  });
}

async function showList() {
  closeVotePopover();
  current = null;
  editing = false;
  showStatus("");
  await loadList();
  renderList();
}

backBtn.addEventListener("click", () => {
  if (editing && !confirm(t("Ungespeicherte Änderungen verwerfen?"))) return;
  showList();
});

// ---------- sheet ----------

async function openCharacter(id) {
  showStatus("");
  current = await api(`${API}/characters/${id}`);
  await loadSpells(current.stat_block && current.stat_block.class_key, current.stat_block);
  editing = false;
  renderSheet();
}

// The spells of the character's class plus those its subclass added from other lists (as in the
// Kampagnenbuch). all: the whole list (the creation wizard offers spells from any list).
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
  state.spells = await api(`${API}/spells?${q}`);
  spellsClass = key;
}

function renderSheet() {
  backBtn.hidden = false;
  document.getElementById("edit-btn").hidden = editing;
  document.getElementById("levelup-btn").hidden = editing || !canLevelUp(current);
  document.getElementById("save-btn").hidden = !editing;
  document.getElementById("cancel-btn").hidden = !editing;
  const sBtn = document.getElementById("status-btn");
  sBtn.hidden = editing;
  sBtn.textContent = current.status === "fertig" ? t("Als Entwurf markieren") : t("✓ Als fertig melden");
  document.title = `${current.name || t("Charakter")} – ${t("Charaktererstellung")}`;
  document.getElementById("campaign-name").textContent = campaign.name;

  const root = document.createElement("div");
  root.innerHTML = pcSheetHtml(current, editing, { live: true, portrait: current.avatar_path, portraitEdit: editing, portraitFallback: sheetPortrait() });
  appEl.replaceChildren(root);
  if (editing) bindSheet(root);
  else bindPcLive(root, current, liveActions);
}

// Without a picture of its own a character shows its class's (creation.js); the list only knows the
// class by name, the open sheet by its key.
const listPortrait = (c) => classPortraitUrl("", null, c.char_class);
const sheetPortrait = () => {
  const d = pcData(current);
  return classPortraitUrl(d.class_key, d.class_ref, current.char_class);
};

const liveActions = {
  hp: (body) => liveChange(`${API}/characters/${current.id}/hp`, "POST", body),
  // base: the state the change started from; refused (409) if it changed meanwhile.
  playState: (play_state, extra = {}) => liveChange(`${API}/characters/${current.id}/play-state`, "PUT",
    { play_state, base: current.play_state || {}, ...extra }),
  rest: (kind) => liveChange(`${API}/characters/${current.id}/rest?kind=${kind}`, "POST"),
};

async function liveChange(path, method, body) {
  try {
    const fresh = await api(path, method, body);
    if (!editing && current && fresh.id === current.id) {
      current = fresh;
      renderSheet();
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

function bindSheet(container) {
  bindPcSheet(container);
  container.addEventListener("change", async (e) => {
    if (e.target.matches("[data-portrait-input]")) return uploadPortrait(e.target.files[0]);
    if (!e.target.matches('[data-field="class_key"]')) return;
    await loadSpells(e.target.value, current && current.stat_block).catch(() => {});
    refreshPcDerived(container);
  });
  container.addEventListener("click", (e) => {
    if (e.target.closest("[data-portrait-remove]")) removePortrait();
  });
  for (const input of container.querySelectorAll("[data-ability]")) {
    input.addEventListener("input", () => {
      const v = input.value === "" ? null : parseInt(input.value, 10);
      container.querySelector(`[data-mod="${input.dataset.ability}"]`).textContent = abilityMod(v);
    });
  }
}

// Uploads (file) or removes (null) a character's portrait; returns the fresh character row.
async function setPortrait(characterId, file) {
  if (!file) return api(`${API}/characters/${characterId}/avatar`, "DELETE");
  const resp = await fetch(`${API}/characters/${characterId}/avatar?filename=${encodeURIComponent(file.name)}`, {
    method: "POST",
    headers: authHeaders(),
    body: file,
  });
  if (!resp.ok) throw Object.assign(new Error(), { status: resp.status });
  return resp.json();
}

// While editing only the picture is swapped, so nothing typed into the sheet gets lost. The
// upload moves updated_at on the server, so the edit-conflict check needs the new value.
async function changePortrait(file) {
  try {
    const fresh = await setPortrait(current.id, file);
    current.avatar_path = fresh.avatar_path;
    current.updated_at = fresh.updated_at;
    const wrap = appEl.querySelector(".pc-portrait-wrap");
    if (wrap) wrap.outerHTML = pcPortraitSlotHtml(current.avatar_path, editing, sheetPortrait());
    else renderSheet();
  } catch (e) {
    showStatus(
      e && e.status === 400 ? t("Dieses Bildformat geht nicht (PNG, JPG, WebP oder GIF).")
        : file ? t("Bild nicht hochgeladen. Verbindung prüfen.") : t("Bild nicht entfernt. Verbindung prüfen."),
      "error"
    );
  }
}

const uploadPortrait = (file) => file && changePortrait(file);
const removePortrait = () => changePortrait(null);

document.getElementById("edit-btn").addEventListener("click", async () => {
  current = await api(`${API}/characters/${current.id}`);
  editing = true;
  renderSheet();
});

// Guided level-up (levelup.js), as in the Kampagnenbuch: starts from the latest version, saved
// like the editor, hp_gain raises the current HP along with the maximum.
document.getElementById("levelup-btn").addEventListener("click", async () => {
  current = await api(`${API}/characters/${current.id}`);
  // Subclasses can add spells from any list (Arcana Domain: wizard cantrips).
  await loadSpells(current.stat_block && current.stat_block.class_key, current.stat_block, true).catch(() => {});
  openLevelUp(current, async (body) => {
    try {
      current = await api(`${API}/characters/${current.id}`, "PUT", { ...body, updated_at: current.updated_at });
    } catch (e) {
      throw new Error(e.status === 409 ? t("Der Charakter wurde inzwischen anderswo geändert. Bitte neu starten.") : t("Nicht gespeichert. Verbindung prüfen."));
    }
    await loadSpells(current.stat_block && current.stat_block.class_key, current.stat_block);
    renderSheet();
    showStatus(t("Stufe {n} erreicht.", { n: current.stat_block.level }), "ok");
    setTimeout(() => showStatus(""), 3000);
  });
});

document.getElementById("cancel-btn").addEventListener("click", async () => {
  editing = false;
  current = await api(`${API}/characters/${current.id}`);
  renderSheet();
});

document.getElementById("save-btn").addEventListener("click", save);

async function save() {
  const body = readPcSheet(appEl.firstElementChild);
  if (!body.name) return showStatus(t("Der Charakter braucht einen Namen."), "error");
  if (body.max_hp === null) return showStatus(t("Trefferpunkte-Maximum fehlt."), "error");
  const path = `${API}/characters/${current.id}`;
  try {
    current = await api(path, "PUT", { ...body, updated_at: current.updated_at });
  } catch (e) {
    if (e.status === 409) {
      if (!confirm(t("Der Charakter wurde inzwischen anderswo geändert.\n\nOK: deine Fassung speichern und die andere überschreiben.\nAbbrechen: weiter bearbeiten."))) return;
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
  renderSheet();
}

statusBtn.addEventListener("click", async () => {
  const next = current.status === "fertig" ? "draft" : "fertig";
  try {
    current = await api(`${API}/characters/${current.id}/status`, "PUT", { status: next });
    renderSheet();
    if (next === "fertig") {
      showStatus(t("Als fertig gemeldet. Deine Spielleitung kann den Charakter jetzt übernehmen."), "ok");
      setTimeout(() => showStatus(""), 4000);
    }
  } catch {
    showStatus(t("Nicht gespeichert! Verbindung prüfen."), "error");
  }
});

window.addEventListener("beforeunload", (e) => {
  if (editing) e.preventDefault();
});

// ---------- Termine (session date poll) ----------
// The DM proposes dates in the admin view; here players just answer each with one of three
// buttons. No accounts: "Dein Name" picks one of the campaign's linked players (one who already
// has a character here) or a freshly typed one, kept in localStorage, same trust level as the
// campaign link itself.

let dates = [];
let datesCalView = (() => {
  const t = new Date();
  return { year: t.getFullYear(), month: t.getMonth() };
})();
const nameKey = () => `ccname:${TOKEN}`;

async function showDates() {
  current = null;
  editing = false;
  showStatus("");
  const [datesResult] = await Promise.all([api(`${API}/dates`), loadList()]);
  dates = datesResult;
  renderDates();
}

function myVote(d, name) {
  const n = name.trim().toLowerCase();
  return n ? d.votes.find((v) => v.player_name.trim().toLowerCase() === n) : null;
}

// Distinct player_name values of this campaign's characters, so a player can pick themselves
// instead of retyping their name every time.
function linkedPlayerNames() {
  const names = new Set();
  for (const c of characters) {
    const n = (c.player_name || "").trim();
    if (n) names.add(n);
  }
  return [...names].sort((a, b) => a.localeCompare(b, UI_LOCALE));
}

// The character (picture, for the calendar) behind a player name: prefers one with a picture,
// since one player can have more than one character. None of theirs has one: null.
function characterFor(name) {
  const n = name.trim().toLowerCase();
  if (!n) return null;
  const mine = characters.filter((c) => (c.player_name || "").trim().toLowerCase() === n);
  return mine.find((c) => c.avatar_path) || mine.find(listPortrait) || mine[0] || null;
}

// Which color a day gets: green only once everyone who answered said yes - a single "nein"
// makes it red, a single "vielleicht" (with no "nein") makes it amber, and no answers at all
// leave it "open". Same rule as the admin view, so the color means the same thing everywhere.
function overviewMark(counts) {
  if (counts.no) return "no";
  if (counts.maybe) return "maybe";
  if (counts.yes) return "yes";
  return "open";
}

// Read-only summary card; voting itself happens in the calendar popover below, not here.
function dateCardHtml(d) {
  const namesFor = (answer) => d.votes.filter((v) => v.answer === answer).map((v) => escapeHtml(v.player_name)).join(", ") || "–";
  return `
    <li class="date-card mark-${overviewMark(d.counts)}">
      <div class="date-head">
        <span class="date-title">${escapeHtml(formatDateLabel(d.date))}</span>
        ${d.note ? `<span class="date-note">${escapeHtml(d.note)}</span>` : ""}
      </div>
      <div class="vote-list">
        <span class="yes">${t("Bin dabei:")} ${namesFor("yes")}</span> ·
        <span class="maybe">${t("Vielleicht:")} ${namesFor("maybe")}</span> ·
        <span class="no">${t("Nicht möglich:")} ${namesFor("no")}</span>
      </div>
    </li>`;
}

function renderDatesCalendar(marks, avatars) {
  renderMonthCalendar(document.getElementById("dates-calendar"), {
    year: datesCalView.year,
    month: datesCalView.month,
    marks,
    avatars,
    onNavigate: (year, month) => {
      closeVotePopover();
      datesCalView = { year, month };
      renderDatesCalendar(marks, avatars);
    },
    onPick: (iso, cellEl) => {
      const d = dates.find((x) => x.date === iso);
      if (d) openVotePopover(d, cellEl);
    },
  });
}

// ---------- vote popover: answering for one day, opened from the calendar ----------

function closeVotePopover() {
  const pop = document.querySelector(".date-popover");
  if (pop) pop.remove();
  document.removeEventListener("mousedown", onOutsideVotePopoverClick, true);
  document.removeEventListener("keydown", onVotePopoverKeydown, true);
}

function onOutsideVotePopoverClick(e) {
  const pop = document.querySelector(".date-popover");
  if (pop && !pop.contains(e.target)) closeVotePopover();
}

function onVotePopoverKeydown(e) {
  if (e.key === "Escape") closeVotePopover();
}

function openVotePopover(d, cellEl) {
  closeVotePopover();
  const container = document.getElementById("dates-calendar");
  const myName = localStorage.getItem(nameKey()) || "";
  const mine = myVote(d, myName);
  const namesFor = (answer) => d.votes.filter((v) => v.answer === answer).map((v) => escapeHtml(v.player_name)).join(", ") || "–";
  const voteBtn = (answer, label) =>
    `<button type="button" class="vote-btn ${answer}${mine && mine.answer === answer ? " active" : ""}" data-vote="${answer}">${label}</button>`;

  const pop = document.createElement("div");
  pop.className = "date-popover";
  pop.innerHTML = `
    <div class="date-popover-title">${escapeHtml(formatDateLabel(d.date))}</div>
    ${d.note ? `<div class="date-popover-note-text">${escapeHtml(d.note)}</div>` : ""}
    <div class="vote-buttons">
      ${voteBtn("no", t("Nicht möglich"))}
      ${voteBtn("maybe", t("Vielleicht"))}
      ${voteBtn("yes", t("Bin dabei"))}
    </div>
    <div class="vote-list">
      <span class="yes">${t("Bin dabei:")} ${namesFor("yes")}</span> ·
      <span class="maybe">${t("Vielleicht:")} ${namesFor("maybe")}</span> ·
      <span class="no">${t("Nicht möglich:")} ${namesFor("no")}</span>
    </div>`;
  pop.style.top = `${cellEl.offsetTop + cellEl.offsetHeight + 4}px`;
  pop.style.left = `${Math.max(0, Math.min(cellEl.offsetLeft, container.clientWidth - 240))}px`;
  container.appendChild(pop);

  pop.querySelectorAll("[data-vote]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const ok = btn.classList.contains("active") ? await unvoteDate(d.id) : await voteDate(d.id, btn.dataset.vote);
      if (!ok) return;
      // voteDate/unvoteDate re-render the whole page (fresh marks/avatars); reopen with the
      // now-current data and cell so the popover reflects the vote it just placed.
      const fresh = dates.find((x) => x.id === d.id);
      const freshCell = fresh && document.querySelector(`.cal-day[data-date="${fresh.date}"]`);
      if (fresh && freshCell) openVotePopover(fresh, freshCell);
    });
  });

  // Delayed so the click that opened the popover doesn't immediately close it again.
  setTimeout(() => {
    document.addEventListener("mousedown", onOutsideVotePopoverClick, true);
    document.addEventListener("keydown", onVotePopoverKeydown, true);
  }, 0);
}

const NEW_NAME_VALUE = "__new__";

function renderVoterSelect(select, myName) {
  const names = linkedPlayerNames();
  if (myName && !names.includes(myName)) names.push(myName);
  select.innerHTML = `<option value="">${t("– wähle dich aus –")}</option>` +
    names.map((n) => `<option value="${escapeHtml(n)}"${n === myName ? " selected" : ""}>${escapeHtml(n)}</option>`).join("") +
    `<option value="${NEW_NAME_VALUE}">${t("Neuer Name …")}</option>`;
}

function renderDates() {
  closeVotePopover();
  backBtn.hidden = false;
  statusBtn.hidden = true;
  for (const id of ["edit-btn", "levelup-btn", "save-btn", "cancel-btn"]) document.getElementById(id).hidden = true;
  document.getElementById("campaign-name").textContent = campaign.name;
  document.title = `${t("Termine")} – ${campaign.name}`;

  const myName = localStorage.getItem(nameKey()) || "";
  const marks = {};
  const avatars = {};
  for (const d of dates) {
    // The day's cell is tinted by the overall vote status (same colors as the admin view) -
    // the picture(s) of whoever answered sit on top of that, each ringed in their own answer,
    // once someone has actually answered.
    marks[d.date] = overviewMark(d.counts);
    if (d.votes.length) {
      avatars[d.date] = d.votes.map((v) => {
        const ch = characterFor(v.player_name);
        return {
          url: ch && (ch.avatar_path || listPortrait(ch)),
          initial: (v.player_name || "?").trim()[0]?.toUpperCase() || "?",
          mark: v.answer,
        };
      });
    }
  }

  appEl.innerHTML = `
    <div class="dates-page">
      <label class="name-field">${t("Dein Name")}
        <select id="voter-select"></select>
        <input type="text" id="voter-new-name" placeholder="${t("Name eingeben")}" hidden>
      </label>
      <div id="dates-calendar"></div>
      <div class="cal-legend">
        <span><span class="dot open"></span>${t("vorgeschlagen, noch nicht abgestimmt")}</span>
        <span><span class="dot yes"></span>${t("Bin dabei")}</span>
        <span><span class="dot maybe"></span>${t("Vielleicht")}</span>
        <span><span class="dot no"></span>${t("Nicht möglich")}</span>
      </div>
      ${dates.length
        ? `<ul class="dates-list">${dates.map((d) => dateCardHtml(d)).join("")}</ul>`
        : `<p class="empty">${t("Deine Spielleitung hat noch keine Termine vorgeschlagen.")}</p>`}
    </div>`;

  renderDatesCalendar(marks, avatars);

  const voterSelect = document.getElementById("voter-select");
  const newNameInput = document.getElementById("voter-new-name");
  renderVoterSelect(voterSelect, myName);

  voterSelect.addEventListener("change", () => {
    if (voterSelect.value === NEW_NAME_VALUE) {
      newNameInput.hidden = false;
      newNameInput.value = "";
      newNameInput.focus();
      return;
    }
    localStorage.setItem(nameKey(), voterSelect.value);
    renderDates();
  });
  newNameInput.addEventListener("change", () => {
    const name = newNameInput.value.trim();
    if (!name) return;
    localStorage.setItem(nameKey(), name);
    renderDates();
  });
}

function currentVoterName() {
  const select = document.getElementById("voter-select");
  const newInput = document.getElementById("voter-new-name");
  const picking = !newInput.hidden;
  const name = (picking ? newInput.value : select.value).trim();
  if (!name || name === NEW_NAME_VALUE) {
    showStatus(t("Bitte zuerst deinen Namen auswählen."), "error");
    (picking ? newInput : select).focus();
    return null;
  }
  localStorage.setItem(nameKey(), name);
  return name;
}

async function voteDate(dateId, answer) {
  const name = currentVoterName();
  if (!name) return false;
  try {
    dates = await api(`${API}/dates/${dateId}/vote`, "PUT", { player_name: name, answer });
    renderDates();
    return true;
  } catch {
    showStatus(t("Nicht gespeichert! Verbindung prüfen."), "error");
    return false;
  }
}

async function unvoteDate(dateId) {
  const name = currentVoterName();
  if (!name) return false;
  try {
    dates = await api(`${API}/dates/${dateId}/vote?player_name=${encodeURIComponent(name)}`, "DELETE");
    renderDates();
    return true;
  } catch {
    showStatus(t("Nicht gespeichert! Verbindung prüfen."), "error");
    return false;
  }
}

// ---------- campaign password ----------
// The campaign itself (GET /api/k/{token}) is unprotected on purpose, so the page can find out
// whether it needs a password before it has one to send. Once a correct password is entered it's
// kept in localStorage (per campaign), so returning players aren't asked again.

function renderPasswordGate(error) {
  appEl.innerHTML = `
    <form class="password-gate" id="password-gate">
      <p>${t("{name} ist passwortgeschützt.", { name: escapeHtml(campaign.name) })}</p>
      <input type="password" name="password" placeholder="${t("Passwort")}" required autofocus>
      <button type="submit">${t("Weiter")}</button>
      ${error ? `<p class="status error">${escapeHtml(error)}</p>` : ""}
    </form>`;
  document.getElementById("password-gate").addEventListener("submit", async (e) => {
    e.preventDefault();
    localStorage.setItem(pwKey(), e.target.password.value);
    if (await checkPassword()) startApp();
    else renderPasswordGate(t("Falsches Passwort."));
  });
}

async function checkPassword() {
  try {
    await api(`${API}/characters`);
    return true;
  } catch (e) {
    if (e.status === 401) localStorage.removeItem(pwKey());
    return false;
  }
}

async function ensurePassword() {
  if (!campaign.password_required) return true;
  if (localStorage.getItem(pwKey()) && (await checkPassword())) return true;
  renderPasswordGate();
  return false;
}

// ---------- start ----------

async function startApp() {
  try {
    [state.items, state.options] = await Promise.all([api(`${API}/items`), api(`${API}/options`)]);
  } catch {
    showStatus(t("Inhalte (Klassen, Völker, …) konnten nicht geladen werden."), "error");
  }
  await showList();
}

(async () => {
  if (!TOKEN) {
    appEl.innerHTML = `<p class="empty">${t("Diese Seite braucht den Link, den dir deine Spielleitung geschickt hat.")}</p>`;
    return;
  }
  try {
    campaign = await api(API);
  } catch {
    appEl.innerHTML = `<p class="empty">${t("Dieser Link ist ungültig oder nicht mehr aktiv. Frag deine Spielleitung nach einem neuen.")}</p>`;
    return;
  }
  if (await ensurePassword()) await startApp();
})();
