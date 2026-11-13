let authHeader = sessionStorage.getItem("authHeader") || null;

// Names come from the public player page: never put them into the page as HTML.
function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function api(path, options = {}) {
  const resp = await fetch(path, {
    ...options,
    headers: { ...(options.headers || {}), Authorization: authHeader },
  });
  if (resp.status === 401) {
    sessionStorage.removeItem("authHeader");
    authHeader = null;
    showLogin();
    throw new Error(t("nicht angemeldet"));
  }
  if (!resp.ok) {
    const detail = await resp.json().catch(() => ({}));
    throw new Error(detail.detail || `${resp.status} ${resp.statusText}`);
  }
  return resp.status === 204 ? null : resp.json();
}

function showLogin() {
  document.querySelector("#login-gate").hidden = false;
  document.querySelector("#app").hidden = true;
}

function showApp() {
  document.querySelector("#login-gate").hidden = true;
  document.querySelector("#app").hidden = false;
  loadCampaigns();
  loadContentStatus();
  loadCharacters();
}

document.querySelector("#login").addEventListener("submit", async (e) => {
  e.preventDefault();
  const password = e.target.password.value;
  authHeader = "Basic " + btoa("admin:" + password);
  const resp = await fetch("/api/admin/campaigns", { headers: { Authorization: authHeader } });
  if (!resp.ok) {
    authHeader = null;
    document.querySelector("#login-error").textContent = t("Falsches Passwort.");
    return;
  }
  sessionStorage.setItem("authHeader", authHeader);
  e.target.reset();
  document.querySelector("#login-error").textContent = "";
  showApp();
});

let campaignsCache = [];

async function loadCampaigns() {
  const campaigns = await api("/api/admin/campaigns");
  campaignsCache = campaigns;
  const list = document.querySelector("#campaigns");
  list.innerHTML = "";
  for (const c of campaigns) {
    const link = `${location.origin}/k/${c.token}/`;
    const entry = document.createElement("div");
    entry.className = "campaign-entry";
    entry.innerHTML = `
      <div class="campaign-row">
        <div class="campaign-name">${escapeHtml(c.name)}</div>
        <div class="campaign-password">${c.has_password ? t("gesetzt") : t("kein Passwort")} <button data-password="${c.id}">${c.has_password ? t("Ändern") : t("Setzen")}</button></div>
        <div class="campaign-characters">${c.character_count}</div>
        <div class="campaign-delete"><button data-delete="${c.id}">${t("Löschen")}</button></div>
      </div>
      <div class="campaign-link">
        <span class="link-label">${t("Link für Spieler:")}</span>
        <span class="copy-link" title="${t("Klicken, um zu kopieren")}">${escapeHtml(link)}</span>
      </div>
    `;
    entry.querySelector(".copy-link").addEventListener("click", (e) => {
      navigator.clipboard.writeText(link);
      e.target.textContent = t("kopiert!");
      setTimeout(() => (e.target.textContent = link), 1000);
    });
    entry.querySelector("[data-password]").addEventListener("click", async () => {
      const pw = prompt(t("Neues Passwort für \"{name}\" (leer lassen, um es zu entfernen):", { name: c.name }));
      if (pw === null) return;
      await api(`/api/admin/campaigns/${c.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(pw ? { password: pw } : { clear_password: true }),
      });
      loadCampaigns();
    });
    entry.querySelector("[data-delete]").addEventListener("click", async () => {
      if (!confirm(t("Kampagne \"{name}\" und alle ihre Charaktere löschen?", { name: c.name }))) return;
      await api(`/api/admin/campaigns/${c.id}`, { method: "DELETE" });
      loadCampaigns();
    });
    list.appendChild(entry);
  }
  renderDatesCampaignSelect();
  renderCharactersCampaignSelect();
}

document.querySelector("#new-campaign").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = e.target.name.value.trim();
  if (!name) return;
  const password = e.target.password.value || null;
  await api("/api/admin/campaigns", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, password }),
  });
  e.target.reset();
  loadCampaigns();
});

async function loadContentStatus() {
  const s = await api("/api/admin/content");
  const el = document.querySelector("#content-status");
  el.textContent = s.uploaded_at
    ? t("{options} Klassen/Völker/Hintergründe, {items} Gegenstände, {spells} Zauber – hochgeladen am {date}",
        { options: s.char_options, items: s.items, spells: s.spells, date: s.uploaded_at })
    : t("Noch keine Inhalte hochgeladen.");
}

document.querySelector("#upload-content").addEventListener("submit", async (e) => {
  e.preventDefault();
  const file = e.target.file.files[0];
  if (!file) return;
  const text = await file.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    alert(t("Das ist keine gültige JSON-Datei."));
    return;
  }
  await api("/api/admin/content", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  e.target.reset();
  loadContentStatus();
});

let charactersCampaignId = null; // null: all campaigns

function renderCharactersCampaignSelect() {
  const sel = document.querySelector("#characters-campaign");
  const prev = charactersCampaignId;
  sel.innerHTML = `<option value="">${t("Alle Kampagnen")}</option>` +
    campaignsCache.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("");
  charactersCampaignId = campaignsCache.some((c) => c.id === prev) ? prev : null;
  sel.value = charactersCampaignId === null ? "" : String(charactersCampaignId);
}

document.querySelector("#characters-campaign").addEventListener("change", (e) => {
  charactersCampaignId = e.target.value ? Number(e.target.value) : null;
  loadCharacters();
});

async function loadCharacters() {
  const query = charactersCampaignId ? `?campaign_id=${charactersCampaignId}` : "";
  const chars = await api(`/api/admin/characters${query}`);
  const tbody = document.querySelector("#characters tbody");
  tbody.innerHTML = "";
  for (const c of chars) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(c.campaign_name)}</td>
      <td>${escapeHtml(c.player_name)}</td>
      <td>${escapeHtml(c.name)}</td>
      <td>${c.status === "fertig" ? t("fertig") : t("Entwurf")}</td>
      <td>${escapeHtml(c.updated_at)}</td>
      <td><button data-delete-char>${t("Löschen")}</button></td>
    `;
    tr.querySelector("[data-delete-char]").addEventListener("click", async () => {
      const who = c.player_name ? ` (${c.player_name})` : "";
      if (!confirm(t("Charakter \"{name}\"{who} aus \"{campaign}\" endgültig löschen?", { name: c.name || t("ohne Namen"), who, campaign: c.campaign_name }))) return;
      try {
        await api(`/api/admin/characters/${c.id}`, { method: "DELETE" });
      } catch (e) {
        alert(t("Nicht gelöscht: {error}", { error: e.message }));
      }
      loadCharacters();
      loadCampaigns(); // character count per campaign
    });
    tbody.appendChild(tr);
  }
  if (!chars.length) tbody.innerHTML = `<tr><td colspan="6" class="hint">${t("Noch keine Charaktere.")}</td></tr>`;
}

document.querySelector("#export-characters").addEventListener("click", async () => {
  const query = charactersCampaignId ? `?campaign_id=${charactersCampaignId}` : "";
  const chars = await api(`/api/admin/characters/export${query}`);
  // Only finished characters go out: an empty file would import as nothing, without a word.
  if (!chars.length) {
    const drafts = (await api(`/api/admin/characters${query}`)).filter((c) => c.status !== "fertig");
    alert(drafts.length
      ? t("Keine fertigen Charaktere zum Exportieren.\n\nNoch Entwurf: {names}.\n\nExportiert werden nur Charaktere, die in der Spieleransicht mit „✓ Als fertig melden“ fertig gemeldet sind.",
        { names: drafts.map((c) => c.name || t("ohne Namen")).join(", ") })
      : t("Keine Charaktere zum Exportieren."));
    return;
  }
  const campaignName = charactersCampaignId ? campaignsCache.find((c) => c.id === charactersCampaignId)?.name : null;
  const blob = new Blob([JSON.stringify(chars, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  const suffix = campaignName ? `-${campaignName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}` : "";
  a.download = `charaktere${suffix}-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  loadCharacters();
});

// ---------- Termine (session date poll, one calendar per campaign) ----------

let selectedCampaignId = null;
let currentDates = [];
let calView = (() => {
  const t = new Date();
  return { year: t.getFullYear(), month: t.getMonth() };
})();

function renderDatesCampaignSelect() {
  const sel = document.querySelector("#dates-campaign");
  const prev = selectedCampaignId;
  sel.innerHTML = campaignsCache.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("");
  if (!campaignsCache.length) {
    selectedCampaignId = null;
    document.querySelector("#dates-calendar").innerHTML = "";
    document.querySelector("#dates-list").innerHTML = `<li class="hint">${t("Noch keine Kampagne angelegt.")}</li>`;
    return;
  }
  selectedCampaignId = campaignsCache.some((c) => c.id === prev) ? prev : campaignsCache[0].id;
  sel.value = String(selectedCampaignId);
  loadDates();
}

document.querySelector("#dates-campaign").addEventListener("change", (e) => {
  selectedCampaignId = Number(e.target.value);
  loadDates();
});

async function loadDates() {
  if (!selectedCampaignId) return;
  closeDatePopover();
  currentDates = await api(`/api/admin/campaigns/${selectedCampaignId}/dates`);
  renderDatesCalendar();
  renderDatesList();
}

// Which color a day gets in the overview: green only once everyone who answered said yes -
// a single "nein" makes it red, a single "vielleicht" (with no "nein") makes it amber, and no
// answers at all leave it "open".
function overviewMark(counts) {
  if (counts.no) return "no";
  if (counts.maybe) return "maybe";
  if (counts.yes) return "yes";
  return "open";
}

function renderDatesCalendar() {
  const marks = {};
  for (const d of currentDates) marks[d.date] = overviewMark(d.counts);
  renderMonthCalendar(document.querySelector("#dates-calendar"), {
    year: calView.year,
    month: calView.month,
    marks,
    onNavigate: (year, month) => {
      closeDatePopover();
      calView = { year, month };
      renderDatesCalendar();
    },
    onPick: onPickDay,
  });
}

// A day with no proposal yet: a small popover to confirm it. A day that already has one:
// jump to it below instead of offering a second proposal for the same day.
function onPickDay(iso, cellEl) {
  closeDatePopover();
  const existing = currentDates.find((d) => d.date === iso);
  if (existing) {
    const li = document.querySelector(`#dates-list li[data-date-id="${existing.id}"]`);
    if (li) {
      li.scrollIntoView({ behavior: "smooth", block: "center" });
      li.classList.add("highlight");
      setTimeout(() => li.classList.remove("highlight"), 1500);
    }
    return;
  }
  openDatePopover(iso, cellEl);
}

function closeDatePopover() {
  const pop = document.querySelector(".date-popover");
  if (pop) pop.remove();
  document.removeEventListener("mousedown", onOutsideDatePopoverClick, true);
  document.removeEventListener("keydown", onDatePopoverKeydown, true);
}

function onOutsideDatePopoverClick(e) {
  const pop = document.querySelector(".date-popover");
  if (pop && !pop.contains(e.target)) closeDatePopover();
}

function onDatePopoverKeydown(e) {
  if (e.key === "Escape") closeDatePopover();
}

function openDatePopover(iso, cellEl) {
  const container = document.querySelector("#dates-calendar");
  const pop = document.createElement("div");
  pop.className = "date-popover";
  pop.innerHTML = `
    <div class="date-popover-title">${escapeHtml(formatDateLabel(iso))}</div>
    <input type="text" class="date-popover-note" placeholder="${escapeHtml(t("Notiz (optional), z. B. \"ab 19 Uhr\""))}">
    <div class="date-popover-actions">
      <button type="button" data-cancel>${t("Abbrechen")}</button>
      <button type="button" data-confirm>${t("Als Termin vorschlagen")}</button>
    </div>`;
  pop.style.top = `${cellEl.offsetTop + cellEl.offsetHeight + 4}px`;
  pop.style.left = `${Math.max(0, Math.min(cellEl.offsetLeft, container.clientWidth - 230))}px`;
  container.appendChild(pop);
  pop.querySelector(".date-popover-note").focus();

  pop.querySelector("[data-cancel]").addEventListener("click", closeDatePopover);
  pop.querySelector("[data-confirm]").addEventListener("click", async () => {
    const note = pop.querySelector(".date-popover-note").value.trim() || null;
    closeDatePopover();
    await api(`/api/admin/campaigns/${selectedCampaignId}/dates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date: iso, note }),
    });
    loadDates();
  });
  // Delayed so the click that opened the popover doesn't immediately close it again.
  setTimeout(() => {
    document.addEventListener("mousedown", onOutsideDatePopoverClick, true);
    document.addEventListener("keydown", onDatePopoverKeydown, true);
  }, 0);
}

function renderDatesList() {
  const ul = document.querySelector("#dates-list");
  ul.innerHTML = "";
  if (!currentDates.length) {
    ul.innerHTML = `<li class="hint">${t("Noch keine Termine vorgeschlagen.")}</li>`;
    return;
  }
  for (const d of currentDates) {
    const names = (answer) => d.votes.filter((v) => v.answer === answer).map((v) => escapeHtml(v.player_name)).join(", ") || "–";
    const li = document.createElement("li");
    li.dataset.dateId = d.id;
    li.innerHTML = `
      <span class="date-title">${escapeHtml(formatDateLabel(d.date))}</span>
      ${d.note ? `<span class="date-note">${escapeHtml(d.note)}</span>` : ""}
      <span class="date-counts">
        <span class="yes">✓ ${d.counts.yes}</span> · <span class="maybe">? ${d.counts.maybe}</span> · <span class="no">✗ ${d.counts.no}</span>
        <span class="hint"> – ✓ ${names("yes")} · ? ${names("maybe")} · ✗ ${names("no")}</span>
      </span>
      <button data-delete-date>${t("Löschen")}</button>
    `;
    li.querySelector("[data-delete-date]").addEventListener("click", async () => {
      if (!confirm(t("Termin \"{date}\" löschen?", { date: formatDateLabel(d.date) }))) return;
      await api(`/api/admin/dates/${d.id}`, { method: "DELETE" });
      loadDates();
    });
    ul.appendChild(li);
  }
}

if (authHeader) {
  showApp();
} else {
  showLogin();
}
