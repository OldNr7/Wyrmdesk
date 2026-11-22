import { createRenderer, escapeHtml as esc } from "/shared/markdown.js";
import { createEditor } from "./editor.js";
import * as cal from "./calendar.js";
import { openBookImport } from "./book.js";

const $ = (sel, root = document) => root.querySelector(sel);

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false || k === "value") continue;
    if (k === "class") el.className = v;
    else if (k === "html") el.innerHTML = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k in el) el[k] = v;
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  }
  if (props && "value" in props && props.value != null) el.value = props.value;
  return el;
}

// ---------- entry types ----------

// Values are stored in German (tk), the label is shown in the UI language.
const opt = (list) => list.map((o) => (Array.isArray(o) ? o : [o, o ? t(o) : "–"]));

// Kinds of places, roughly from large to small, with the icon a place of that kind shows.
// Stored in German (fields.kind), shown with t().
const PLACE_KINDS = [
  [tk("Land"), "🗺"], [tk("Region"), "🏞"], [tk("Gebirge"), "⛰"], [tk("Wald"), "🌲"], [tk("Gewässer"), "🌊"], [tk("Wildnis"), "🌾"],
  [tk("Stadt"), "🏙"], [tk("Dorf"), "🏘"], [tk("Viertel"), "🧱"], [tk("Burg"), "🏰"], [tk("Gebäude"), "🏠"], [tk("Taverne"), "🍺"],
  [tk("Tempel"), "⛪"], [tk("Laden"), "🛒"] /* tc("Ort", "Laden") */, [tk("Turm"), "🗼"], [tk("Ruine"), "🏚"], [tk("Höhle"), "🪨"], [tk("Dungeon"), "🕳"],
];
const PLACE_ICONS = Object.fromEntries(PLACE_KINDS);

const TYPES = {
  pc: {
    label: t("Gruppe"), one: t("Spielercharakter"), icon: "🛡",
    fields: [
      { key: "player", label: t("Spieler"), placeholder: t("Name") },
      { key: "class", label: t("Volk und Klasse"), placeholder: t("z. B. Zwergin, Klerikerin 5") },
    ],
    text: { body: t("Hintergrund"), secrets: t("Notizen (nur DM)") },
  },
  npc: {
    label: "NPCs", one: "NPC", icon: "👤",
    status: opt(["", tk("lebt"), tk("tot"), tk("verschollen"), tk("unbekannt")]),
    fields: [
      { key: "role", label: t("Rolle"), placeholder: t("z. B. Wirt der Goldenen Gans") },
      { key: "attitude", label: t("Haltung"), options: opt(["", tk("freundlich"), tk("neutral"), tk("misstrauisch"), tk("feindlich")]) },
    ],
    parent: { label: t("Aufenthaltsort"), types: ["place", "location"] },
  },
  // The real places of the world, from a country down to a single building, each kind with its icon.
  place: {
    label: t("Orte"), one: t("Ort"), icon: "🏰", tree: true,
    fields: [{ key: "kind", label: t("Art"), options: [["", "–"], ...PLACE_KINDS.map(([k, i]) => [k, `${i} ${tc("Ort", k)}`])] }],
    parent: { label: t("Liegt in"), types: ["place"] },
    iconFor: (e) => PLACE_ICONS[e.fields?.kind] || "📍",
  },
  // The chapters of an adventure: what the D&D Beyond import makes of its sections and numbered
  // areas (book_import.py), grouped by chapter. The type is still "location" in the database.
  location: {
    label: t("Kapitel"), one: t("Abschnitt"), icon: "📑", tree: true,
    fields: [{ key: "kind", label: t("Art"), placeholder: t("z. B. Begegnung, Bereich, Dungeon") }],
    parent: { label: t("Liegt in"), types: ["location"] },
  },
  faction: {
    label: t("Fraktionen"), one: t("Fraktion"), icon: "⚑",
    status: opt(["", tk("aktiv"), tk("zerschlagen")]),
    fields: [{ key: "standing", label: t("Ansehen der Gruppe"), options: opt(["", tk("verfeindet"), tk("misstrauisch"), tk("neutral"), tk("wohlgesinnt"), tk("verbündet")]) }],
    parent: { label: t("Sitz"), types: ["place", "location"] },
  },
  item: {
    label: t("Gegenstände"), one: t("Gegenstand"), icon: "💎",
    fields: [{ key: "kind", label: t("Art"), placeholder: t("z. B. Waffe, Artefakt, Brief") }],
    parent: { label: t("Im Besitz von"), types: ["pc", "npc", "faction", "place", "location"] },
  },
  quest: {
    label: t("Quests und offene Fäden"), one: t("Quest"), icon: "❗",
    status: opt([tk("offen"), tk("erledigt"), tk("gescheitert"), tk("aufgegeben")]), defaultStatus: "offen",
    parent: { label: t("Auftraggeber"), types: ["npc", "faction", "pc"] },
    text: { body: t("Worum geht es?"), secrets: t("Hintergrund (nur DM)") },
  },
  decision: {
    label: t("Entscheidungen"), one: t("Entscheidung"), icon: "⚖",
    status: [[tk("ausstehend"), t("Folgen ausstehend")], [tk("ausgespielt"), t("Folgen ausgespielt")]], defaultStatus: "ausstehend",
    session: true,
    text: { body: t("Was wurde entschieden?"), secrets: t("Mögliche Folgen (nur DM)") },
  },
  handout: {
    label: t("Handouts"), one: t("Handout"), icon: "📽", handout: true,
    text: { body: t("Text für die Spieler"), secrets: t("Notizen (nur DM)") },
  },
};

// An entry's icon: its type's, or one of its own (a place shows its kind).
const iconOf = (e) => TYPES[e.type]?.iconFor?.(e) || TYPES[e.type]?.icon || "•";

const STATUS_CLASS = {
  lebt: "good", aktiv: "good", erledigt: "good", ausgespielt: "good",
  tot: "bad", zerschlagen: "bad", gescheitert: "bad",
  offen: "open", ausstehend: "open",
};

const WHERE = {
  prep: t("Vorbereitung"), recap: t("Rückblick"), log: t("Notizen"), body: t("Beschreibung"), secrets: t("Geheimnisse"),
  summary: t("Kurzbeschreibung"), title: t("Titel"), table: t("Tabelle"),
};

// ---------- state ----------

const S = {
  settings: null,
  campaigns: [],
  trackerOk: false,
  campaign: null,
  entries: [],
  sessions: [],
  events: [],
  documents: [],
  topic: null,
  editing: false,
  editNext: false,
  sessionTab: {},
  display: null,
  timelineFilter: "",
};

const byName = () => new Map(S.entries.map((e) => [e.name.trim().toLowerCase(), e]));
let nameIndex = new Map();
const render = createRenderer((name) => nameIndex.has(name.trim().toLowerCase()));
const calendar = () => S.campaign?.calendar || { type: "none" };

// ---------- helpers ----------

function toast(text, bad = false) {
  const t = $("#toast");
  t.textContent = text;
  t.className = bad ? "bad" : "";
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, bad ? 6000 : 2500);
}

async function api(method, url, body) {
  // Guards against the swapped argument order used by library.js/combat's api(path, method, body):
  // a call copied from there would otherwise send a request with the URL as its HTTP method.
  if (!/^(GET|POST|PUT|PATCH|DELETE)$/.test(method)) {
    throw new Error(`api(): "${method}" ist keine HTTP-Methode – Reihenfolge ist api(method, url, body)`);
  }
  const resp = await fetch(url, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!resp.ok) {
    let detail = resp.statusText;
    try { detail = (await resp.json()).detail || detail; } catch { /* not json */ }
    toast(typeof detail === "string" ? detail : t("Fehler beim Speichern"), true);
    throw Object.assign(new Error(detail), { status: resp.status });
  }
  return resp.json();
}

async function upload(file) {
  const resp = await fetch(`/api/uploads?filename=${encodeURIComponent(file.name || "bild.png")}`, { method: "POST", body: file });
  if (!resp.ok) {
    toast(t("Bild konnte nicht hochgeladen werden."), true);
    throw new Error("upload failed");
  }
  return (await resp.json()).url;
}

function pickImage() {
  return new Promise((resolve) => {
    const input = h("input", { type: "file", accept: "image/*" });
    input.addEventListener("change", async () => resolve(input.files[0] ? await upload(input.files[0]) : null));
    input.click();
  });
}

function suggest(typed) {
  const q = typed.trim().toLowerCase();
  return S.entries
    .filter((e) => e.name.toLowerCase().includes(q))
    .sort((a, b) => (b.name.toLowerCase().startsWith(q) - a.name.toLowerCase().startsWith(q)) || a.name.localeCompare(b.name))
    .slice(0, 8)
    .map((e) => ({ name: e.name, hint: TYPES[e.type].one }));
}

const todayIso = () => new Date().toISOString().slice(0, 10);
const nowTime = () => new Date().toTimeString().slice(0, 5);
const formatDay = (iso) => (iso ? new Date(`${iso}T12:00`).toLocaleDateString(UI_LOCALE) : "");
const go = (hash) => { if (location.hash === hash) route(); else location.hash = hash; };

// Debounced saving while typing; flushed before leaving a page.
const pendingSaves = new Map();
const SAVE_RETRY_MS = 5000;
function saveLater(key, fn, delay = 700) {
  clearTimeout(pendingSaves.get(key)?.timer);
  setSaveState("Ungespeichert…");
  const job = { fn, timer: setTimeout(() => runSave(key), delay) };
  pendingSaves.set(key, job);
}
async function runSave(key) {
  const job = pendingSaves.get(key);
  if (!job) return;
  pendingSaves.delete(key);
  clearTimeout(job.timer);
  setSaveState("Speichert…");
  try {
    await job.fn();
    if (!pendingSaves.size) setSaveState("Gespeichert");
  } catch (err) {
    // The server refused this text (it said why in the toast); sending it again won't help.
    if (err.status && err.status < 500) {
      setSaveState(t("Nicht gespeichert!"));
      return;
    }
    // Unreachable or failing server, e.g. while it restarts: keep the text and try again,
    // unless newer typing has queued its own save by now. A pending job also keeps the
    // warning on leaving the page.
    if (!pendingSaves.has(key)) {
      pendingSaves.set(key, { fn: job.fn, timer: setTimeout(() => runSave(key), SAVE_RETRY_MS) });
    }
    setSaveState(t("Nicht gespeichert – neuer Versuch…"));
  }
}
async function flushSaves() {
  await Promise.all([...pendingSaves.keys()].map(runSave));
}
function setSaveState(text) {
  const el = $("#save-state");
  if (el) el.textContent = text;
}
window.addEventListener("beforeunload", (e) => {
  if (pendingSaves.size) { flushSaves(); e.preventDefault(); }
});

// ---------- campaign data ----------

async function loadCampaigns() {
  const res = await api("GET", "/api/campaigns");
  S.campaigns = res.campaigns;
  S.trackerOk = res.tracker_ok;
  const sel = $("#campaign");
  sel.innerHTML = "";
  for (const c of S.campaigns) sel.append(h("option", { value: c.id }, c.name || `Kampagne ${c.id}`));
  // As in the tracker: a new campaign straight from the dropdown (also under ⚙ Einrichtung).
  sel.append(h("option", { value: "__new__" }, t("+ Neue Kampagne…")));
  let id = S.settings.campaign_id;
  if (!S.campaigns.some((c) => c.id === id)) id = S.campaigns[0]?.id ?? null;
  sel.value = id ?? "";
  renderTrackerStatus();
  return id;
}

async function openCampaign(id) {
  if (id == null) {
    S.campaign = null;
    S.entries = S.sessions = S.events = S.documents = [];
    renderAll();
    return;
  }
  if (S.settings.campaign_id !== id) {
    S.settings = await api("PATCH", "/api/settings", { campaign_id: id });
  }
  await reloadIndex(id);
  if (!S.campaign.calendar) openWorldModal({ create: false });
}

async function reloadIndex(id = S.campaign?.id) {
  const idx = await api("GET", `/api/campaigns/${id}/index`);
  S.campaign = { ...idx.campaign, name: S.campaigns.find((c) => c.id === id)?.name || idx.campaign.name };
  S.entries = idx.entries.sort(byNameOrder);
  S.sessions = idx.sessions;
  S.events = idx.events;
  S.documents = idx.documents || [];
  renderAll();
}

function renderAll() {
  nameIndex = byName();
  renderHeader();
  renderPanel();
  route();
}

// Names in natural order: "Cragmaw Hideout – 2. …" before "… – 10. …".
const NAME_ORDER = new Intl.Collator("de", { sensitivity: "base", numeric: true });
const byNameOrder = (a, b) => NAME_ORDER.compare(a.name, b.name);

function upsert(list, item) {
  const i = list.findIndex((x) => x.id === item.id);
  if (i >= 0) list[i] = { ...list[i], ...item };
  else list.push(item);
}

function entryChanged(entry) {
  upsert(S.entries, entry);
  S.entries.sort(byNameOrder);
  nameIndex = byName();
  renderPanel();
}

function sessionChanged(session) {
  upsert(S.sessions, session);
  S.sessions.sort((a, b) => a.number - b.number || a.id - b.id);
  renderPanel();
}

async function patchEntry(id, values) {
  const entry = await api("PATCH", `/api/entries/${id}`, values);
  entryChanged(entry);
  return entry;
}

async function patchSession(id, values) {
  const session = await api("PATCH", `/api/sessions/${id}`, values);
  sessionChanged(session);
  return session;
}

async function createEntry(type, name, extra = {}) {
  const spec = TYPES[type];
  const entry = await api("POST", "/api/entries", {
    campaign_id: S.campaign.id, type, name, status: spec.defaultStatus || "", ...extra,
  });
  entryChanged(entry);
  return entry;
}

// ---------- header ----------

function renderHeader() {
  const btn = $("#today-btn");
  const c = S.campaign;
  btn.hidden = !c;
  if (c) {
    const today = cal.formatDate(calendar(), c.today);
    btn.textContent = `📅 ${today || t("Datum in der Spielwelt")}`;
  }
  document.body.classList.toggle("no-campaign", !c);
  const world = c?.calendar ? cal.WORLDS[c.calendar.type]?.label : t("noch nicht festgelegt");
  $("#setup-campaign").textContent = c ? `${c.name} · Welt: ${world}` : t("Keine Kampagne gewählt.");
  renderDisplayBadge();
}

function renderDisplayBadge() {
  const badge = $("#display-badge");
  badge.hidden = !S.display;
  if (S.display) badge.textContent = `📽 ${S.display.title || t("Handout")} ✕`;
  document.querySelectorAll("[data-display-entry]").forEach((el) => {
    const shown = S.display?.entry_id === Number(el.dataset.displayEntry);
    el.textContent = shown ? t("📽 Ausblenden") : t("📽 Auf Beamer zeigen");
    el.classList.toggle("on", shown);
  });
}

function renderTrackerStatus() {
  const el = $("#tracker-status");
  el.textContent = !S.settings.tracker_configured ? t("TRACKER_URL ist nicht gesetzt.")
    : S.trackerOk ? t("✓ Verbunden.") : t("✕ Der Combat Tracker antwortet nicht.");
}

// ---------- rail and list panel ----------

// Topics without a list panel: their page (library.js) has its own search and filters.
const LIBRARY_TOPICS = ["bestiary", "items", "spells", "classes", "subclasses", "races", "backgrounds", "feats"];

function setTopic(topic, { toggle = false } = {}) {
  const panel = $("#panel");
  if (LIBRARY_TOPICS.includes(topic)) {
    S.topic = topic;
    panel.hidden = true;
    go(`#library/${topic}`);
  } else if (toggle && S.topic === topic && !panel.hidden) {
    panel.hidden = true;
  } else {
    S.topic = topic;
    panel.hidden = false;
  }
  document.querySelectorAll("#rail button").forEach((b) => b.classList.toggle("open",
    (!panel.hidden || LIBRARY_TOPICS.includes(S.topic)) && b.dataset.topic === S.topic));
  renderPanel();
}

function renderPanel() {
  const panel = $("#panel");
  if (panel.hidden || !S.topic) return;
  panel.innerHTML = "";
  if (!S.campaign) {
    panel.append(h("section", {}, h("div", { class: "muted" }, t("Zuerst eine Kampagne wählen oder unter Einrichtung anlegen."))));
    return;
  }
  if (S.topic === "sessions") panel.append(sessionList());
  else if (S.topic === "journal") panel.append(journalList());
  else if (S.topic === "timeline") panel.append(timelinePanel());
  else if (S.topic === "documents") panel.append(documentList());
  else panel.append(entryList(S.topic));
}

function currentRoute() {
  const [kind, id] = location.hash.slice(1).split("/");
  return { kind, id: id ? Number(id) : null };
}

// The bestiary, item or spell page a #library/<topic> route shows, if it is one.
function libraryRoute() {
  const [kind, topic] = location.hash.slice(1).split("/");
  return kind === "library" && LIBRARY_TOPICS.includes(topic) ? topic : null;
}

// toggle: {open, onToggle} puts an arrow in front to open or close the children (place tree);
// toggle === false keeps its room, so the names of a tree stay in line.
function listItem({ icon, image, title, sub, badge, active, onClick, indent = 0, toggle }) {
  const arrow = toggle
    ? h("span", { class: "tree-toggle", title: toggle.open ? t("Zuklappen") : t("Aufklappen"),
      onclick: (e) => { e.stopPropagation(); toggle.onToggle(); } }, toggle.open ? "▾" : "▸")
    : toggle === false ? h("span", { class: "tree-toggle" }) : null;
  return h("li", { class: active ? "active" : "", onclick: onClick, style: indent ? `padding-left:${6 + indent * 14}px` : null },
    arrow,
    image ? h("img", { class: "thumb", src: image, alt: "" }) : h("span", { class: "thumb icon" }, icon || ""),
    h("span", { class: "li-main" }, h("span", { class: "li-title" }, title), sub ? h("span", { class: "li-sub muted small" }, sub) : null),
    badge ? h("span", { class: `badge ${STATUS_CLASS[badge] || ""}` }, t(badge)) : null,
  );
}

function newItemForm(placeholder, onCreate) {
  const input = h("input", { type: "text", placeholder });
  const form = h("form", { class: "new-item", hidden: true, onsubmit: async (e) => {
    e.preventDefault();
    const name = input.value.trim();
    if (!name) return;
    input.value = "";
    form.hidden = true;
    await onCreate(name);
  } }, input);
  input.addEventListener("keydown", (e) => { if (e.key === "Escape") form.hidden = true; });
  input.addEventListener("blur", () => { if (!input.value.trim()) form.hidden = true; });
  return { form, open: () => { form.hidden = false; input.focus(); } };
}

function entryList(type) {
  const spec = TYPES[type];
  const sec = h("section");
  const filter = h("input", { type: "search", placeholder: t("Filtern…") });
  const list = h("ul", { class: "list" });
  const fresh = newItemForm(spec.one === "NPC" ? t("Name des neuen NPC") : t("Name ({type})", { type: spec.one }), async (name) => {
    const entry = await createEntry(type, name);
    S.editNext = true;
    go(`#entry/${entry.id}`);
  });
  const head = h("div", { class: "panel-head" }, h("h2", {}, spec.label),
    h("button", { class: "primary small-btn", onclick: fresh.open }, t("+ Neu")));
  sec.append(head, fresh.form, filter);

  let statusFilter = null;
  if (spec.status) {
    const chips = h("div", { class: "chips" });
    const values = [null, ...spec.status.map((s) => s[0]).filter(Boolean)];
    for (const v of values) {
      chips.append(h("button", { class: `chip${v === statusFilter ? " on" : ""}`, onclick: (e) => {
        statusFilter = v;
        chips.querySelectorAll(".chip").forEach((c) => c.classList.remove("on"));
        e.target.classList.add("on");
        draw();
      } }, v ? spec.status.find((s) => s[0] === v)[1] : t("Alle")));
    }
    chips.firstChild.classList.add("on");
    sec.append(chips);
  }
  sec.append(list);

  function draw() {
    const q = filter.value.trim().toLowerCase();
    const r = currentRoute();
    let items = S.entries.filter((e) => e.type === type);
    if (statusFilter) items = items.filter((e) => e.status === statusFilter);
    if (q) items = items.filter((e) => `${e.name} ${e.summary}`.toLowerCase().includes(q));
    list.innerHTML = "";
    const item = (e, indent = 0, toggle) => listItem({
      icon: iconOf(e), image: e.image, title: e.name, sub: e.summary || e.fields?.role || e.fields?.kind, indent, toggle,
      badge: e.status && e.status !== "lebt" && e.status !== "aktiv" ? e.status : null,
      active: r.kind === "entry" && r.id === e.id, onClick: () => go(`#entry/${e.id}`),
    });
    if (spec.tree && !q && !statusFilter) {
      drawTree(list, items, r.kind === "entry" ? r.id : null, item, draw);
    } else {
      items.forEach((e) => list.append(item(e)));
    }
    if (!items.length) list.append(h("li", { class: "muted empty-li" }, q || statusFilter ? t("Nichts gefunden.") : t("Noch keine Einträge.")));
  }
  filter.addEventListener("input", draw);
  draw();
  return sec;
}

// ---------- place tree: chapters, open/closed ----------

// Places a DM opened stay open (per browser); the way to the open entry is always open.
const TREE_KEY = "treeOpen";
function treeOpen() {
  try { return new Set(JSON.parse(localStorageGet(TREE_KEY, "[]"))); } catch { return new Set(); }
}
function setTreeOpen(key, open) {
  const s = treeOpen();
  if (open) s.add(key); else s.delete(key);
  localStorageSet(TREE_KEY, JSON.stringify([...s]));
}

// The chapter of an adventure an entry was imported from (book_import.py), "" for the DM's own.
const chapterKey = (e) => (e.fields?.ddb_ref || "").split("#")[0];
function chapterTitle(key, members) {
  const named = members.find((e) => e.fields?.ddb_chapter);
  if (named) return named.fields.ddb_chapter;
  const s = S.sessions.find((x) => (x.ddb_ref || "").split("#")[0] === key);
  if (s) return s.title;
  const slug = key.split("/").pop() || key;
  return slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// In the book's order where both come from the same chapter, else by name.
function bookOrder(a, b) {
  const oa = a.fields?.ddb_order, ob = b.fields?.ddb_order;
  if (oa != null && ob != null && chapterKey(a) === chapterKey(b)) return oa - ob;
  return byNameOrder(a, b);
}

// Entries of no chapter first (all of them for places), then one group per chapter (in the order of its session, else of
// the import), each under a fine heading. Places with places inside open and close.
function drawTree(list, items, activeId, item, redraw) {
  const ids = new Set(items.map((e) => e.id));
  const kids = new Map();
  for (const e of items) {
    const pid = ids.has(e.parent_id) ? e.parent_id : null;
    if (!kids.has(pid)) kids.set(pid, []);
    kids.get(pid).push(e);
  }
  for (const k of kids.values()) k.sort(bookOrder);
  const open = treeOpen();
  const onPath = new Set();
  for (let cur = items.find((e) => e.id === activeId); cur && ids.has(cur.parent_id);) {
    onPath.add(cur.parent_id);
    cur = items.find((e) => e.id === cur.parent_id);
  }
  const walk = (pid, depth) => (kids.get(pid) || []).forEach((e) => {
    const has = kids.has(e.id);
    const isOpen = has && (open.has(`e${e.id}`) || onPath.has(e.id));
    list.append(item(e, depth, has ? { open: isOpen, onToggle: () => { setTreeOpen(`e${e.id}`, !isOpen); redraw(); } } : false));
    if (isOpen) walk(e.id, depth + 1);
  });
  const roots = kids.get(null) || [];
  const groups = new Map();
  for (const e of roots) {
    const key = chapterKey(e);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  const rank = (key) => {
    if (key === "intro") return -Infinity;
    if (!key) return -1e12;
    const s = S.sessions.find((x) => (x.ddb_ref || "").split("#")[0] === key);
    return s ? s.number : 1e6 + Math.min(...groups.get(key).map((e) => e.id));
  };
  const keys = [...groups.keys()].sort((a, b) => rank(a) - rank(b));
  for (const key of keys) {
    const members = groups.get(key);
    // Entries of no chapter get a heading only next to chapters.
    if (key || keys.length > 1) {
      const closed = open.has(`c${key}`);  // groups are open unless closed
      list.append(h("li", { class: "list-group-head", title: closed ? t("Aufklappen") : t("Zuklappen"),
        onclick: () => { setTreeOpen(`c${key}`, !closed); redraw(); } },
        h("span", { class: "tree-toggle" }, closed ? "▸" : "▾"), key ? chapterTitle(key, members) : t("Ohne Kapitel")));
      if (closed && !members.some((e) => e.id === activeId || onPath.has(e.id))) continue;
    }
    const saved = kids.get(null);
    kids.set(null, members);
    walk(null, 0);
    kids.set(null, saved);
  }
}

function sessionLabel(s) {
  return `${s.number} · ${s.title}`;
}

function sessionList() {
  const sec = h("section");
  const fresh = newItemForm(t("Titel der neuen Session"), async (title) => {
    const s = await api("POST", "/api/sessions", { campaign_id: S.campaign.id, title });
    sessionChanged(s);
    S.sessionTab[s.id] = "prep";
    go(`#session/${s.id}`);
  });
  sec.append(h("div", { class: "panel-head" }, h("h2", {}, t("Sessions")),
    h("span", { class: "panel-actions" },
      h("button", { class: "small-btn", title: t("Rückblick für eine Session nachtragen, die nicht hier geplant wurde"), onclick: openPastSessionModal }, t("↺ Nachtragen")),
      h("button", { class: "primary small-btn", onclick: fresh.open }, t("+ Neu")))), fresh.form);
  const list = h("ul", { class: "list" });
  const r = currentRoute();
  for (const s of [...S.sessions].reverse()) {
    list.append(listItem({
      icon: s.status === "played" ? "✓" : "✎", title: sessionLabel(s),
      sub: [formatDay(s.played_on), cal.formatRange(calendar(), s.game_start, s.game_end)].filter(Boolean).join(" · "),
      badge: s.status === "planned" ? "geplant" : null,
      active: r.kind === "session" && r.id === s.id, onClick: () => go(`#session/${s.id}`),
    }));
  }
  if (!S.sessions.length) list.append(h("li", { class: "muted empty-li" }, t("Noch keine Sessions.")));
  sec.append(list);
  return sec;
}

function journalList() {
  const sec = h("section", {}, h("div", { class: "panel-head" }, h("h2", {}, t("Journal")),
    h("button", { class: "small-btn", title: t("Rückblick für eine Session nachtragen, die nicht hier geplant wurde"), onclick: openPastSessionModal }, t("↺ Nachtragen"))));
  const list = h("ul", { class: "list" });
  const played = S.sessions.filter((s) => s.status === "played");
  for (const s of [...played].reverse()) {
    list.append(listItem({
      icon: "📖", title: sessionLabel(s), sub: formatDay(s.played_on),
      onClick: () => {
        if (currentRoute().kind !== "journal") go("#journal");
        setTimeout(() => document.getElementById(`j-${s.id}`)?.scrollIntoView({ behavior: "smooth" }), 50);
      },
    }));
  }
  if (!played.length) list.append(h("li", { class: "muted empty-li" }, t("Noch keine gespielten Sessions.")));
  sec.append(list, h("div", { class: "muted small hint" }, t("Das Journal zeigt die Rückblicke aller gespielten Sessions.")));
  return sec;
}

function timelinePanel() {
  const filter = h("input", { type: "search", placeholder: t("Filtern, z. B. nach NPC…"), value: S.timelineFilter });
  filter.addEventListener("input", () => {
    S.timelineFilter = filter.value;
    if (currentRoute().kind === "timeline") drawTimeline();
  });
  return h("section", {},
    h("div", { class: "panel-head" }, h("h2", {}, t("Timeline")),
      h("button", { class: "primary small-btn", onclick: () => { go("#timeline"); setTimeout(() => newEventForm(), 30); } }, t("+ Ereignis"))),
    filter,
    h("div", { class: "muted small hint" }, t("Ereignisse nach Datum in der Spielwelt. Sessions mit Datum erscheinen automatisch.")),
  );
}

// ---------- diverse Dokumente ----------

const DOC_KINDS = {
  pdf: { label: "PDF", icon: "📕", accept: "application/pdf,.pdf" },
  image: { label: t("Bild"), icon: "🖼", accept: "image/*" },
  text: { label: t("Text"), icon: "📝" },
  table: { label: t("Tabelle"), icon: "📊" },
};

async function uploadDocumentFile(file) {
  const resp = await fetch(`/api/uploads?document=true&filename=${encodeURIComponent(file.name || "datei")}`, { method: "POST", body: file });
  if (!resp.ok) {
    let detail = t("Datei konnte nicht hochgeladen werden.");
    try { detail = (await resp.json()).detail || detail; } catch { /* not json */ }
    toast(detail, true);
    throw new Error("upload failed");
  }
  return (await resp.json()).url;
}

function documentChanged(doc) {
  const { body, data, ...lean } = doc;  // the list keeps what the index has
  upsert(S.documents, lean);
  renderPanel();
}

// PDFs and pictures from files (picked or dropped), each its own document; opens the last one.
async function addDocumentFiles(files) {
  let last = null;
  for (const file of files) {
    const kind = file.type === "application/pdf" || /\.pdf$/i.test(file.name) ? "pdf" : file.type.startsWith("image/") ? "image" : null;
    if (!kind) {
      toast(t("„{name}“: nur PDFs und Bilder.", { name: file.name }), true);
      continue;
    }
    const url = await uploadDocumentFile(file);
    last = await api("POST", "/api/documents", {
      campaign_id: S.campaign.id, kind, title: file.name.replace(/\.[^.]+$/, ""), file: url,
    });
    documentChanged(last);
  }
  if (last) go(`#doc/${last.id}`);
}

function pickDocumentFiles(kind) {
  const input = h("input", { type: "file", accept: DOC_KINDS[kind].accept, multiple: true });
  input.addEventListener("change", () => addDocumentFiles([...input.files]));
  input.click();
}

function documentList() {
  const sec = h("section", { class: "doc-panel" });
  let newKind = "text";
  const fresh = newItemForm(t("Titel des neuen Dokuments"), async (title) => {
    const doc = await api("POST", "/api/documents", { campaign_id: S.campaign.id, kind: newKind, title });
    documentChanged(doc);
    S.editNext = true;
    go(`#doc/${doc.id}`);
  });
  const menu = h("div", { class: "doc-new", hidden: true },
    Object.entries(DOC_KINDS).map(([kind, k]) => h("button", { class: "small-btn", onclick: () => {
      menu.hidden = true;
      if (k.accept) return pickDocumentFiles(kind);
      newKind = kind;
      fresh.open();
    } }, `${k.icon} ${k.label}`)));
  sec.append(h("div", { class: "panel-head" }, h("h2", {}, t("Dokumente")),
    h("button", { class: "primary small-btn", onclick: () => { menu.hidden = !menu.hidden; } }, t("+ Neu"))), menu, fresh.form);
  const list = h("ul", { class: "list" });
  const r = currentRoute();
  for (const d of S.documents) {
    list.append(listItem({
      icon: DOC_KINDS[d.kind]?.icon, image: d.kind === "image" ? d.file : null, title: d.title,
      sub: DOC_KINDS[d.kind]?.label, active: r.kind === "doc" && r.id === d.id, onClick: () => go(`#doc/${d.id}`),
    }));
  }
  if (!S.documents.length) list.append(h("li", { class: "muted empty-li" }, t("Noch keine Dokumente.")));
  sec.append(list, h("div", { class: "muted small hint" }, t("PDFs und Bilder kannst du auch hierher ziehen.")));
  sec.addEventListener("dragover", (e) => { e.preventDefault(); sec.classList.add("drop"); });
  sec.addEventListener("dragleave", (e) => { if (!sec.contains(e.relatedTarget)) sec.classList.remove("drop"); });
  sec.addEventListener("drop", (e) => {
    e.preventDefault();
    sec.classList.remove("drop");
    if (e.dataTransfer.files.length) addDocumentFiles([...e.dataTransfer.files]);
  });
  return sec;
}

function documentPage(d) {
  const save = async (values) => {
    const u = await api("PATCH", `/api/documents/${d.id}`, values);
    documentChanged(u);
    return Object.assign(d, u);
  };
  const k = DOC_KINDS[d.kind] || { label: d.kind, icon: "📄" };
  const move = async (delta) => {
    const { ids } = await api("POST", `/api/documents/${d.id}/move?delta=${delta}`);
    S.documents.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
    renderPanel();
  };
  const actions = [editToggle()];
  if (d.file) {
    actions.push(h("a", { class: "button", href: d.file, target: "_blank", title: t("In einem neuen Tab öffnen") }, t("↗ Öffnen")));
  }
  if (d.kind === "image") {
    actions.push(h("button", { onclick: () => api("POST", "/api/display", { title: d.title, image: d.file }) }, t("📽 Auf Beamer zeigen")));
  }
  if (S.editing) {
    if (k.accept) {
      actions.push(h("button", { onclick: () => {
        const input = h("input", { type: "file", accept: k.accept });
        input.addEventListener("change", async () => {
          if (!input.files[0]) return;
          await save({ file: await uploadDocumentFile(input.files[0]) });
          route();
        });
        input.click();
      } }, t("Datei ersetzen")));
    }
    actions.push(h("span", { class: "move-btns" },
      h("button", { title: t("In der Liste nach oben"), onclick: () => move(-1) }, "↑"),
      h("button", { title: t("In der Liste nach unten"), onclick: () => move(1) }, "↓")));
  }
  actions.push(h("button", { class: "danger", title: t("Dokument löschen"), onclick: async () => {
    if (!confirm(t("Dokument „{title}“ wirklich löschen?", { title: d.title }))) return;
    await api("DELETE", `/api/documents/${d.id}`);
    S.documents = S.documents.filter((x) => x.id !== d.id);
    go("");
  } }, "🗑"));
  const titleEdit = S.editing
    ? h("input", { type: "text", class: "title-input", value: d.title, onchange: (ev) => ev.target.value.trim() && save({ title: ev.target.value.trim() }) })
    : null;

  const page = h("div", { class: `page doc doc-${d.kind}` },
    pageHead({ kicker: `${k.icon} ${k.label}`, title: d.title, titleEdit, actions }));
  if (d.kind === "pdf") {
    page.append(h("iframe", { class: "doc-pdf", src: d.file, title: d.title }));
  } else if (d.kind === "image") {
    page.append(h("a", { href: d.file, target: "_blank" }, h("img", { class: "doc-image", src: d.file, alt: d.title })));
  } else if (d.kind === "table") {
    page.append(documentTable(d, save));
  }
  page.append(textField({
    key: `d${d.id}:body`, label: d.kind === "text" ? t("Text") : t("Notizen"), value: d.body, onSave: (v) => save({ body: v }),
    placeholder: t("Mit [[ verknüpfst du NPCs und Orte."), empty: d.kind === "text" ? t("Noch leer. Doppelklick zum Bearbeiten.") : t("Keine Notizen."),
  }));
  return page;
}

// A table: shown as is, edited cell by cell. Tab-separated text (copied from Excel) pasted into a
// cell fills the cells from there on.
function documentTable(d, save) {
  const sec = h("section", { class: "field" });
  let rows = (d.data?.rows || []).map((r) => [...r]);
  const width = () => Math.max(1, ...rows.map((r) => r.length));
  const store = () => saveLater(`d${d.id}:data`, () => save({ data: { rows } }));

  if (!S.editing) {
    if (!rows.length || rows.every((r) => r.every((c) => !String(c).trim()))) {
      sec.append(h("div", { class: "muted empty", ondblclick: () => { S.editing = true; route(); } }, t("Die Tabelle ist noch leer. Doppelklick zum Bearbeiten.")));
      return sec;
    }
    const w = width();
    const cells = (r, tag) => Array.from({ length: w }, (_, i) => h(tag, { html: render(String(r[i] ?? "")) }));
    sec.append(h("div", { class: "doc-table-wrap" }, h("table", { class: "doc-table prose" },
      h("thead", {}, h("tr", {}, cells(rows[0], "th"))),
      h("tbody", {}, rows.slice(1).map((r) => h("tr", {}, cells(r, "td")))))));
    return sec;
  }

  const wrap = h("div", { class: "doc-table-wrap" });
  const draw = () => {
    const w = width();
    rows = rows.map((r) => [...r, ...Array(w - r.length).fill("")]);
    if (!rows.length) rows = [Array(w).fill("")];
    const table = h("table", { class: "doc-table editing" });
    table.append(h("tr", { class: "col-tools" }, rows[0].map((_, c) => h("td", {},
      h("button", { class: "mini", title: t("Spalte löschen"), disabled: w <= 1, onclick: () => {
        rows.forEach((r) => r.splice(c, 1));
        store();
        draw();
      } }, "✕"))), h("td")));
    rows.forEach((r, ri) => {
      table.append(h("tr", { class: ri === 0 ? "head-row" : "" },
        r.map((cell, ci) => h("td", {}, (() => {
          const input = h("input", { type: "text", value: cell, placeholder: ri === 0 ? t("Überschrift") : "" });
          input.addEventListener("input", () => { rows[ri][ci] = input.value; store(); });
          input.addEventListener("paste", (e) => {
            const text = e.clipboardData.getData("text/plain");
            if (!/[\t\n]/.test(text.trim())) return;
            e.preventDefault();
            text.replace(/\r/g, "").replace(/\n$/, "").split("\n").forEach((line, dr) => {
              line.split("\t").forEach((value, dc) => {
                while (rows.length <= ri + dr) rows.push([]);
                const row = rows[ri + dr];
                while (row.length <= ci + dc) row.push("");
                row[ci + dc] = value;
              });
            });
            store();
            draw();
          });
          return input;
        })())),
        h("td", {}, h("button", { class: "mini", title: t("Zeile löschen"), disabled: rows.length <= 1, onclick: () => {
          rows.splice(ri, 1);
          store();
          draw();
        } }, "✕"))));
    });
    wrap.replaceChildren(table);
  };
  draw();
  sec.append(wrap, h("div", { class: "doc-table-actions" },
    h("button", { class: "small-btn", onclick: () => { rows.push(Array(width()).fill("")); store(); draw(); } }, t("+ Zeile")),
    h("button", { class: "small-btn", onclick: () => { rows.forEach((r) => r.push("")); store(); draw(); } }, t("+ Spalte")),
    h("span", { class: "muted small" }, t("Die erste Zeile ist die Überschrift. Aus Excel kopierte Zellen lassen sich einfügen."))));
  return sec;
}

// ---------- routing ----------

let routeToken = 0;
async function route() {
  await flushSaves();
  const token = ++routeToken;
  const page = $("#page");
  const { kind, id } = currentRoute();
  // Bestiary, items and spells belong to no campaign and keep their state, so they are shown, not rebuilt.
  const topic = libraryRoute();
  $("#library").hidden = !topic;
  page.hidden = !!topic;
  if (topic) {
    S.topic = topic;
    $("#panel").hidden = true;
    document.querySelectorAll("#rail button").forEach((b) => b.classList.toggle("open", b.dataset.topic === topic));
    document.querySelectorAll("#library .lib-tab").forEach((t) => { t.hidden = t.id !== `lib-${topic}`; });
    $("#content").scrollTop = 0;
    return;
  }
  if (LIBRARY_TOPICS.includes(S.topic)) {
    // Left the library through a link or the search: its rail button no longer applies.
    S.topic = null;
    document.querySelectorAll("#rail button").forEach((b) => b.classList.remove("open"));
  }
  if (!S.campaign) {
    page.replaceChildren(welcomePage());
    return;
  }
  try {
    if (kind === "entry" && id) {
      const entry = await api("GET", `/api/entries/${id}`);
      // A party member's sheet needs the item and spell library.
      if (entry.character) await window.libraryReady;
      if (token !== routeToken) return;
      if (entry.campaign_id !== S.campaign.id) return go("");
      page.replaceChildren(entryPage(entry));
    } else if (kind === "session" && id) {
      const session = await api("GET", `/api/sessions/${id}`);
      if (token !== routeToken) return;
      if (session.campaign_id !== S.campaign.id) return go("");
      page.replaceChildren(sessionPage(session));
    } else if (kind === "journal") {
      const sessions = await api("GET", `/api/campaigns/${S.campaign.id}/journal`);
      if (token !== routeToken) return;
      page.replaceChildren(journalPage(sessions));
    } else if (kind === "timeline") {
      page.replaceChildren(timelinePage(id));
    } else if (kind === "doc" && id) {
      const doc = await api("GET", `/api/documents/${id}`);
      if (token !== routeToken) return;
      if (doc.campaign_id !== S.campaign.id) return go("");
      page.replaceChildren(documentPage(doc));
    } else {
      page.replaceChildren(homePage());
    }
  } catch {
    page.replaceChildren(h("div", { class: "page" }, h("p", { class: "muted" }, t("Nicht gefunden."))));
  }
  $("#content").scrollTop = 0;
  renderPanel();
  renderDisplayBadge();
}

window.addEventListener("hashchange", () => {
  S.editing = S.editNext;
  S.editNext = false;
  route();
});

// Clicks on [[links]] anywhere in the page.
$("#page").addEventListener("click", (e) => {
  const a = e.target.closest("a.wl");
  if (!a || a.closest(".editable")) return;
  e.preventDefault();
  const entry = nameIndex.get(a.dataset.name.trim().toLowerCase());
  if (entry) go(`#entry/${entry.id}`);
  else openCreateLinkModal(a.dataset.name);
});

// ---------- page building blocks ----------

function pageHead({ kicker, title, titleEdit, image, onImage, imageIcon, facts, actions }) {
  const portrait = image !== undefined
    ? h("div", { class: "portrait", title: t("Bild ändern"), onclick: onImage },
      image ? h("img", { src: image, alt: "" }) : h("span", { class: "portrait-empty" }, imageIcon, h("span", { class: "small" }, t("Bild"))))
    : null;
  return h("div", { class: "page-head" },
    portrait,
    h("div", { class: "head-main" },
      h("div", { class: "kicker muted small" }, kicker, h("span", { id: "save-state" })),
      titleEdit || h("h1", {}, title),
      facts?.length ? h("div", { class: "facts" }, facts) : null),
    h("div", { class: "head-actions" }, actions),
  );
}

function editToggle() {
  return h("button", { class: S.editing ? "primary" : "", onclick: async () => {
    await flushSaves();
    S.editing = !S.editing;
    route();
  } }, S.editing ? t("✓ Fertig") : t("✎ Bearbeiten"));
}

function factSelect(label, options, value, onChange) {
  const sel = h("select", { onchange: () => onChange(sel.value) },
    options.map(([v, l]) => h("option", { value: v }, l)));
  sel.value = value ?? "";
  return h("label", { class: "fact" }, h("span", { class: "fact-label" }, label), sel);
}

function factText(label, value, placeholder, onChange) {
  const input = h("input", { type: "text", value: value || "", placeholder, onchange: () => onChange(input.value.trim()) });
  return h("label", { class: "fact" }, h("span", { class: "fact-label" }, label), input);
}

function factCheck(label, checked, onChange) {
  const box = h("input", { type: "checkbox", checked, onchange: () => onChange(box.checked) });
  return h("label", { class: "fact check" }, box, h("span", {}, label));
}

function textField({ key, label, value, placeholder, onSave, cls = "", empty = t("Noch leer.") }) {
  const sec = h("section", { class: `field ${cls}` }, h("h3", {}, label));
  if (S.editing) {
    const ed = createEditor({
      mode: S.settings.editor, value, render, suggest, upload, placeholder,
      onChange: (v) => saveLater(key, () => onSave(v)),
    });
    sec.append(ed.el);
  } else if (value?.trim()) {
    sec.append(h("div", { class: "prose", html: render(value) }));
  } else {
    sec.append(h("div", { class: "muted empty", ondblclick: () => { S.editing = true; route(); } }, empty));
  }
  return sec;
}

// ---------- DeepL for campaign texts (content_translate.py) ----------

// Translates step by step until nothing is left; onProgress gets the latest answer. Resolves with
// {done, message}.
async function translateContent(body, onProgress = () => {}) {
  let done = 0;
  for (;;) {
    const r = await api("POST", "/api/translate/content", { ...body, max_chars: 30000 });
    done += r.done;
    onProgress({ ...r, done });
    if (r.quota_exceeded) return { done, message: t("Das DeepL-Kontingent für diesen Monat ist aufgebraucht; der Rest bleibt englisch.") };
    if (!r.remaining) return { done, message: "" };
    if (r.stuck) return { done, message: t("{n} Texte konnten nicht fertig übersetzt werden (DeepL lehnt Zeilen ab).", { n: r.remaining }) };
  }
}

// Under a translated text: the English original, to read or to go back to.
function originalBox(kind, id, original) {
  return h("details", { class: "field original-box" },
    h("summary", {}, t("🇬🇧 Englisches Original")),
    original?.trim() ? h("div", { class: "prose", html: render(original) }) : h("p", { class: "muted small" }, t("Nur die Kurzbeschreibung war englisch.")),
    h("button", { class: "small-btn", onclick: async () => {
      if (!confirm(t("Zurück zum englischen Original? Die deutsche Übersetzung (und was du darin geändert hast) geht verloren."))) return;
      await api("POST", "/api/translate/content/original", { kind, id });
      if (kind === "entry") await reloadIndex(); else route();
    } }, t("Original wiederherstellen")));
}

// "Auf Deutsch übersetzen" for one entry or session; asks first with the number of characters.
function translateButton(body, what) {
  if (!S.settings.deepl_configured) return null;
  return h("button", { class: "small-btn translate-btn", onclick: async (ev) => {
    const est = await api("POST", "/api/translate/content", { ...body, dry_run: true });
    if (!est.items) return toast(t("Nichts zu übersetzen."));
    if (!confirm(t("{what} mit DeepL auf Deutsch übersetzen? Etwa {n} Zeichen (der Gratis-Plan hat 500 000 im Monat). Das englische Original bleibt erhalten.", { what, n: est.chars_missing.toLocaleString(UI_LOCALE) }))) return;
    ev.target.disabled = true;
    ev.target.textContent = t("Wird übersetzt …");
    try {
      const res = await translateContent(body);
      if (res.message) toast(res.message, !res.done);
      await reloadIndex();
    } catch {
      ev.target.disabled = false;
      ev.target.textContent = t("🌐 Auf Deutsch übersetzen");
    }
  } }, t("🌐 Auf Deutsch übersetzen"));
}

function entryChip(e) {
  return h("a", { class: "chip-link", href: `#entry/${e.id}` }, `${iconOf(e)} ${e.name}`);
}

function linkedEntries(...texts) {
  const names = new Set();
  for (const t of texts) for (const m of (t || "").matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)) names.add(m[1].trim().toLowerCase());
  return [...names].map((n) => nameIndex.get(n)).filter(Boolean);
}

// ---------- entry page ----------

function entryPage(e) {
  const spec = TYPES[e.type];
  const text = { body: t("Beschreibung"), secrets: t("Geheimnisse (nur DM)"), ...spec.text };
  const save = (values) => patchEntry(e.id, values).then((u) => Object.assign(e, u));
  const saveField = (key, value) => save({ fields: { ...e.fields, [key]: value } });

  const facts = [];
  if (spec.status) facts.push(factSelect("Status", spec.status, e.status, (v) => save({ status: v })));
  for (const f of spec.fields || []) {
    facts.push(f.options
      ? factSelect(f.label, f.options, e.fields[f.key], (v) => saveField(f.key, v))
      : factText(f.label, e.fields[f.key], f.placeholder, (v) => saveField(f.key, v)));
  }
  if (spec.parent) {
    const candidates = S.entries.filter((x) => spec.parent.types.includes(x.type) && x.id !== e.id);
    facts.push(factSelect(spec.parent.label, [["", "–"], ...candidates.map((x) => [String(x.id), `${iconOf(x)} ${x.name}`])],
      e.parent_id ? String(e.parent_id) : "", (v) => save({ parent_id: v ? Number(v) : null })));
  }
  if (spec.session) {
    facts.push(factSelect("In Session", [["", "–"], ...[...S.sessions].reverse().map((s) => [String(s.id), sessionLabel(s)])],
      e.fields.session_id ? String(e.fields.session_id) : "", (v) => saveField("session_id", v ? Number(v) : null)));
  }
  if (e.type !== "pc") facts.push(factCheck(t("Den Spielern bekannt"), e.known, (v) => save({ known: v })));

  const actions = [editToggle()];
  if (e.image || spec.handout) {
    const withText = spec.handout ? factCheck(t("Text mitzeigen"), e.fields.with_text ?? true, (v) => saveField("with_text", v)) : null;
    actions.push(h("button", { "data-display-entry": e.id, onclick: () => toggleDisplay(e) }, t("📽 Auf Beamer zeigen")), withText);
  }
  if (e.type === "location" && e.fields?.intro) {
    // Kapitel 0 takes the book's introduction ("Campaign Overview").
    actions.push(h("button", { title: t("Einleitung eines D&D-Beyond-Buchs in dieses Kapitel importieren"), onclick: async () => {
      await flushSaves();
      openBookImport({ api, h, toast, campaign: S.campaign, openModal, closeModal, intro: { id: e.id, title: e.name },
        reload: () => reloadIndex(), translate: S.settings.deepl_configured ? translateContent : null });
    } }, t("📥 Einleitung importieren")));
  }
  actions.push(h("button", { class: "danger", title: t("Eintrag löschen"), onclick: async () => {
    const what = e.type === "pc" ? t(" mitsamt Charakterblatt") : "";
    if (!confirm(t("„{name}“{what} wirklich löschen?", { name: e.name, what }))) return;
    await api("DELETE", `/api/entries/${e.id}`);
    S.entries = S.entries.filter((x) => x.id !== e.id);
    nameIndex = byName();
    go("");
  } }, "🗑"));

  const nameInput = S.editing
    ? h("input", { type: "text", class: "title-input", value: e.name, onchange: async (ev) => {
      const name = ev.target.value.trim();
      if (name && name !== e.name) await save({ name });
    } })
    : null;

  const page = h("div", { class: `page entry type-${e.type}` },
    pageHead({
      kicker: spec.one,
      // A party member without a picture shows its class's (as in the Charaktererstellung), until one is chosen.
      title: e.name, titleEdit: nameInput, image: e.image || (e.character ? characterPortraitFallback(e.character) : null), imageIcon: iconOf(e),
      onImage: async () => {
        const url = await pickImage();
        if (url) { await save({ image: url }); route(); }
      },
      facts, actions,
    }));
  if (S.editing) {
    page.append(h("section", { class: "field" }, h("h3", {}, t("Kurzbeschreibung")),
      h("input", { type: "text", value: e.summary, placeholder: t("Eine Zeile: wer oder was ist das?"),
        oninput: (ev) => saveLater(`e${e.id}:summary`, () => save({ summary: ev.target.value })) })));
    if (e.image) page.append(h("button", { class: "small-btn", onclick: async () => { await save({ image: null }); route(); } }, t("Bild entfernen")));
  } else if (e.summary) {
    page.append(h("p", { class: "summary" }, e.summary));
  }
  if (e.character) page.append(characterSection(e));
  page.append(
    textField({ key: `e${e.id}:body`, label: text.body, value: e.body, onSave: (v) => save({ body: v }),
      placeholder: t("Text… Mit [[ verknüpfst du andere Einträge."), empty: t("Noch leer. Doppelklick zum Bearbeiten.") }),
    textField({ key: `e${e.id}:secrets`, label: text.secrets, value: e.secrets, cls: "secret", onSave: (v) => save({ secrets: v }),
      placeholder: t("Was die Spieler (noch) nicht wissen…"), empty: t("Keine.") }),
  );
  if (!S.editing && e.type !== "pc") {
    if (e.fields && "body_en" in e.fields) page.append(originalBox("entry", e.id, e.fields.body_en));
    else if (`${e.body}${e.summary}`.trim()) {
      const btn = translateButton({ entry_ids: [e.id] }, `„${e.name}“`);
      if (btn) page.append(h("div", { class: "row" }, btn));
    }
  }

  const children = S.entries.filter((x) => x.parent_id === e.id);
  if (children.length) {
    const groups = h("section", { class: "field" }, h("h3", {}, t("Zugehörig")));
    for (const t of Object.keys(TYPES)) {
      const list = children.filter((x) => x.type === t);
      if (list.length) groups.append(h("div", { class: "chip-row" }, h("span", { class: "muted small" }, TYPES[t].label), list.map(entryChip)));
    }
    page.append(groups);
  }
  page.append(backlinkSection(e.backlinks));
  return page;
}

// The rules side of a party member: the character sheet the tracker and the players use, with its own
// edit mode (players may save the same sheet from /spieler/ meanwhile, see the 409 below).
function characterSection(e) {
  const c = e.character;
  const sec = h("section", { class: "field charsheet-field" });
  let sheet;
  // Outside the editor the sheet is played as in the players' view and the Charaktererstellung: HP,
  // spell slots, hit dice, rests, inventory and equipping change right away.
  const live = {
    hp: (body) => liveChange(`/api/characters/${c.id}/hp`, "POST", body),
    playState: (play_state, extra = {}) => liveChange(`/api/characters/${c.id}/play-state`, "PUT",
      { play_state, base: c.play_state || {}, ...extra }),
    rest: (kind) => liveChange(`/api/characters/${c.id}/rest?kind=${kind}`, "POST"),
  };
  async function liveChange(path, method, body) {
    try {
      Object.assign(c, await api(method, path, body));
    } catch (err) {
      // A player changed it meanwhile (409): show that state instead of overwriting it.
      Object.assign(c, await api("GET", `/api/characters/${c.id}`));
      toast(err.status === 409 ? t("Inzwischen anderswo geändert – neu geladen. Bitte nochmals versuchen.") : t("Nicht gespeichert."), true);
    }
    show(false);
  }
  const show = (editing) => {
    // A fresh element every time, so listeners of the previous view don't pile up.
    sheet = h("div");
    sheet.innerHTML = editing ? charSheetFormHtml(c) : pcSheetHtml(c, false, { live: true });
    if (editing) bindCharSheetForm(sheet);
    else bindPcLive(sheet, c, live);
    const buttons = editing
      ? [h("button", { class: "primary", onclick: save }, t("Speichern")), h("button", { onclick: () => show(false) }, t("Abbrechen"))]
      : [
          ...(canLevelUp(c) ? [h("button", { onclick: levelUp }, t("⬆ Stufenaufstieg"))] : []),
          h("button", { onclick: () => show(true) }, t("✎ Blatt bearbeiten")),
        ];
    sec.replaceChildren(h("div", { class: "charsheet-head" }, h("h3", {}, t("Charakterblatt")), ...buttons), sheet);
  };
  async function save() {
    const body = readCharSheetForm(sheet);
    if (!body.name || body.max_hp === null || body.ac === null) return toast(t("Name, TP und RK sind nötig."), true);
    const put = (extra) => fetch(`/api/characters/${c.id}`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ campaign_id: c.campaign_id, ...body, ...extra }),
    });
    let resp = await put({ updated_at: c.updated_at });
    if (resp.status === 409) {
      if (!confirm(t("{name} wurde inzwischen von einem Spieler geändert.\n\nOK: deine Fassung speichern und die Änderungen des Spielers überschreiben.\nAbbrechen: weiter bearbeiten.", { name: c.name }))) return;
      resp = await put({});
    }
    if (!resp.ok) return toast(t("Charakterblatt konnte nicht gespeichert werden."), true);
    Object.assign(c, await resp.json());
    // A new name shows in the lists and [[links]] too.
    if (c.name !== e.name) await reloadIndex();
    else route();
  }
  // Guided level-up (levelup.js), from the latest version of the sheet.
  async function levelUp() {
    Object.assign(c, await api("GET", `/api/characters/${c.id}`));
    openLevelUp(c, async (body) => {
      const resp = await fetch(`/api/characters/${c.id}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ campaign_id: c.campaign_id, ...body, updated_at: c.updated_at }),
      });
      if (!resp.ok) throw new Error(resp.status === 409 ? t("Der Charakter wurde inzwischen anderswo geändert. Bitte neu starten.") : t("Nicht gespeichert."));
      Object.assign(c, await resp.json());
      toast(t("{name} ist jetzt Stufe {n}.", { name: c.name, n: c.stat_block.level }));
      route();
    });
  }
  show(false);
  return sec;
}

function backlinkSection(backlinks) {
  const sec = h("section", { class: "field" }, h("h3", {}, t("Erwähnt in")));
  if (!backlinks.length) {
    sec.append(h("div", { class: "muted empty" }, t("Noch nirgends verknüpft.")));
    return sec;
  }
  const list = h("ul", { class: "backlinks" });
  for (const b of backlinks) {
    const where = b.where.map((w) => WHERE[w] || w).join(", ");
    const href = refHref(b);
    const icon = refIcon(b);
    const title = b.kind === "session" ? `Session ${b.number}: ${b.title}` : b.title;
    list.append(h("li", {}, h("a", { href }, `${icon} ${title}`), h("span", { class: "muted small" }, ` · ${where}`)));
  }
  sec.append(list);
  return sec;
}

// Where a backlink or search result leads, and its icon.
function refHref(r) {
  return r.kind === "entry" ? `#entry/${r.id}` : r.kind === "session" ? `#session/${r.id}`
    : r.kind === "document" ? `#doc/${r.id}` : `#timeline/${r.id}`;
}
function refIcon(r) {
  return r.kind === "entry" ? iconOf(r) : r.kind === "session" ? "📜"
    : r.kind === "document" ? DOC_KINDS[r.doc_kind]?.icon || "📄" : "⏳";
}

async function toggleDisplay(e) {
  if (S.display?.entry_id === e.id) {
    await api("DELETE", "/api/display");
    return;
  }
  const withText = TYPES[e.type].handout ? (e.fields.with_text ?? true) : false;
  await api("POST", "/api/display", { entry_id: e.id, with_text: withText });
  // Whatever was shown on the beamer is known to the players now.
  if (!e.known && e.type !== "pc") {
    const u = await patchEntry(e.id, { known: true });
    Object.assign(e, u);
    const box = document.querySelector(".fact.check input");
    if (box) box.checked = true;
  }
}

// ---------- session page ----------

function sessionPage(s) {
  const save = (values) => patchSession(s.id, values).then((u) => Object.assign(s, u));
  const tab = S.sessionTab[s.id] || (s.status === "played" ? "recap" : "prep");
  const c = calendar();

  const facts = [
    factSelect("Status", [["planned", "geplant"], ["played", "gespielt"]], s.status, (v) => save({ status: v })),
    (() => {
      const input = h("input", { type: "date", value: s.played_on || "", onchange: () => save({ played_on: input.value || null }) });
      return h("label", { class: "fact" }, h("span", { class: "fact-label" }, t("Spielabend")), input);
    })(),
    h("label", { class: "fact" }, h("span", { class: "fact-label" }, t("Spielwelt von")),
      cal.dateInput(c, s.game_start, (d) => save({ game_start: d }))),
    h("label", { class: "fact" }, h("span", { class: "fact-label" }, "bis"),
      cal.dateInput(c, s.game_end, (d) => save({ game_end: d }))),
  ];
  const actions = [
    editToggle(),
    h("button", { class: "danger", title: t("Session löschen"), onclick: async () => {
      if (!confirm(t("Session „{title}“ wirklich löschen?", { title: s.title }))) return;
      await api("DELETE", `/api/sessions/${s.id}`);
      S.sessions = S.sessions.filter((x) => x.id !== s.id);
      go("");
    } }, "🗑"),
  ];
  const titleEdit = S.editing
    ? h("div", { class: "title-row" },
      h("input", { type: "number", class: "num-input", value: s.number, title: t("Nummer"), onchange: (ev) => save({ number: Number(ev.target.value) }) }),
      h("input", { type: "text", class: "title-input", value: s.title, onchange: (ev) => ev.target.value.trim() && save({ title: ev.target.value.trim() }) }))
    : null;

  const tabs = h("div", { class: "tabs" });
  const body = h("div", { class: "tab-body" });
  const TABS = [["prep", t("Vorbereitung")], ["table", t("Am Spieltisch")], ["recap", t("Rückblick")]];
  for (const [key, label] of TABS) {
    tabs.append(h("button", { class: key === tab ? "on" : "", onclick: async () => {
      await flushSaves();
      S.sessionTab[s.id] = key;
      route();
    } }, label));
  }

  if (tab === "prep") {
    body.append(
      textField({ key: `s${s.id}:prep`, label: t("Vorbereitung"), value: s.prep, onSave: (v) => save({ prep: v }),
        placeholder: t("Ablauf, Szenen, Vorlesetexte… Mit [[ verknüpfst du NPCs und Orte."), empty: t("Noch nichts vorbereitet. Doppelklick zum Bearbeiten.") }),
      encounterBox(s, save),
    );
    if (!S.editing) {
      if (s.prep_en != null) body.append(originalBox("session", s.id, s.prep_en));
      else if (s.prep.trim()) {
        const btn = translateButton({ session_ids: [s.id] }, t("Die Vorbereitung dieser Session"));
        if (btn) body.append(h("div", { class: "row" }, btn));
      }
    }
    const involved = linkedEntries(s.prep);
    if (involved.length) body.append(h("section", { class: "field" }, h("h3", {}, t("Beteiligt")), h("div", { class: "chip-row" }, involved.map(entryChip))));
  } else if (tab === "table") {
    body.append(notesSection(s, save), encounterBox(s, save));
    if (s.prep.trim()) {
      body.append(h("details", { class: "field prep-peek" }, h("summary", {}, t("Vorbereitung anzeigen")), h("div", { class: "prose", html: render(s.prep) })));
    }
  } else {
    body.append(textField({ key: `s${s.id}:recap`, label: t("Rückblick fürs Journal"), value: s.recap, onSave: (v) => save({ recap: v }),
      placeholder: t("Was ist passiert? Was haben die Spieler entschieden?"), empty: t("Noch kein Rückblick. Doppelklick zum Schreiben.") }));
    if (!s.recap.trim() && s.log.length) {
      body.append(h("button", { onclick: async () => {
        await save({ recap: s.log.map((n) => `- ${n.text}`).join("\n") });
        S.editing = true;
        route();
      } }, t("Notizen vom Spieltisch als Entwurf übernehmen")));
    }
  }

  return h("div", { class: "page session" },
    pageHead({ kicker: `Session ${s.number} · ${s.status === "played" ? "gespielt" : "geplant"}`, title: s.title, titleEdit, facts, actions }),
    tabs, body);
}

function notesSection(s, save) {
  const input = h("input", { type: "text", class: "note-input", placeholder: t("Notiz… Enter speichert, [[Name]] verknüpft") });
  const list = h("ul", { class: "notes" });
  const sec = h("section", { class: "field" }, h("h3", {}, t("Notizen am Spieltisch")), input, list);

  async function convert(i, kind) {
    const note = s.log[i];
    let ref;
    if (kind === "decision") {
      const e = await createEntry("decision", note.text.slice(0, 80), { body: note.text, fields: { session_id: s.id } });
      ref = { kind: "entry", id: e.id };
    } else if (kind === "npc") {
      const name = prompt(t("Name des NPC:"), "");
      if (!name?.trim()) return;
      const e = await createEntry("npc", name.trim(), { body: `${note.text}\n\n${t("Erstmals in Session {n}.", { n: s.number })}`, status: "lebt" });
      ref = { kind: "entry", id: e.id };
    } else {
      const date = s.game_end || s.game_start || S.campaign.today || null;
      const ev = await api("POST", "/api/events", {
        campaign_id: S.campaign.id, title: note.text.slice(0, 120), body: note.text.length > 120 ? note.text : "",
        date, sort_key: cal.sortKey(calendar(), date), session_id: s.id,
      });
      S.events.push(ev);
      ref = { kind: "event", id: ev.id };
    }
    const log = s.log.map((n, j) => (j === i ? { ...n, ref } : n));
    await save({ log });
    toast(t("Übernommen."));
    draw();
  }

  function draw() {
    list.innerHTML = "";
    s.log.forEach((n, i) => {
      const refLink = n.ref
        ? h("a", { class: "small", href: n.ref.kind === "entry" ? `#entry/${n.ref.id}` : `#timeline/${n.ref.id}` }, t("↗ übernommen"))
        : null;
      list.append(h("li", {},
        h("span", { class: "time muted small" }, n.t),
        h("span", { class: "note-text prose", html: render(n.text) }),
        h("span", { class: "note-actions" }, refLink,
          n.ref ? null : h("button", { title: t("Als Entscheidung festhalten"), onclick: () => convert(i, "decision") }, "⚖"),
          n.ref ? null : h("button", { title: t("Als Ereignis in die Timeline"), onclick: () => convert(i, "event") }, "⏳"),
          n.ref ? null : h("button", { title: t("Neuen NPC daraus anlegen"), onclick: () => convert(i, "npc") }, "👤"),
          h("button", { title: t("Notiz löschen"), onclick: async () => { await save({ log: s.log.filter((_, j) => j !== i) }); draw(); } }, "✕")),
      ));
    });
    if (!s.log.length) list.append(h("li", { class: "muted empty-li" }, t("Noch keine Notizen.")));
  }
  input.addEventListener("keydown", async (e) => {
    if (e.key !== "Enter" || !input.value.trim()) return;
    const text = input.value.trim();
    input.value = "";
    await save({ log: [...s.log, { t: nowTime(), text }] });
    draw();
  });
  draw();

  if (s.status !== "played") {
    sec.append(h("button", { class: "primary wide", onclick: async () => {
      const values = { status: "played" };
      if (!s.played_on) values.played_on = todayIso();
      if (!s.recap.trim() && s.log.length) values.recap = s.log.map((n) => `- ${n.text}`).join("\n");
      await save(values);
      const end = s.game_end || s.game_start;
      if (end) {
        S.campaign = { ...S.campaign, ...(await api("PATCH", `/api/campaigns/${S.campaign.id}`, { today: end })) };
        renderHeader();
      }
      S.sessionTab[s.id] = "recap";
      toast(t("Session abgeschlossen. Notizen sind als Rückblick-Entwurf übernommen."));
      route();
    } }, t("✓ Session abschliessen")));
  }
  return sec;
}

function encounterBox(s, save) {
  const sec = h("section", { class: "field encounters" }, h("h3", {}, t("Encounter (Combat Tracker)")));
  const body = h("div", { class: "muted small" }, t("Lade…"));
  sec.append(body);
  (async () => {
    let data;
    try {
      const resp = await fetch(`/api/tracker/encounters?campaign_id=${S.campaign.id}`);
      if (!resp.ok) throw new Error();
      data = await resp.json();
    } catch {
      body.textContent = t("Der Combat Tracker ist nicht erreichbar.");
      return;
    }
    const byId = new Map(data.encounters.map((e) => [e.id, e]));
    const draw = () => {
      body.className = "";
      body.innerHTML = "";
      const list = h("ul", { class: "enc-list" });
      for (const id of s.encounter_ids) {
        const enc = byId.get(id);
        const shown = data.display_encounter_id === id;
        list.append(h("li", { class: shown ? "shown" : "" },
          h("span", { class: "enc-name" }, enc ? enc.name : t("Encounter {id} (gelöscht)", { id })),
          enc ? h("button", { class: shown ? "on" : "", title: t("Im Tracker auf die Spieleranzeige schalten"), onclick: async () => {
            await api("PUT", "/api/tracker/display", { encounter_id: shown ? null : id });
            data.display_encounter_id = shown ? null : id;
            draw();
          } }, shown ? t("● Angezeigt") : t("▶ Anzeigen")) : null,
          h("button", { title: t("Verknüpfung entfernen"), onclick: async () => {
            await save({ encounter_ids: s.encounter_ids.filter((x) => x !== id) });
            draw();
          } }, "✕")));
      }
      if (!s.encounter_ids.length) list.append(h("li", { class: "muted empty-li" }, t("Keine Encounter verknüpft.")));
      const free = data.encounters.filter((e) => !s.encounter_ids.includes(e.id));
      const sel = h("select", {}, h("option", { value: "" }, t("Encounter verknüpfen…")), free.map((e) => h("option", { value: e.id }, e.name)));
      sel.addEventListener("change", async () => {
        if (!sel.value) return;
        await save({ encounter_ids: [...s.encounter_ids, Number(sel.value)] });
        draw();
      });
      body.append(list, free.length ? sel : h("div", { class: "muted small" }, data.encounters.length ? "" : t("Für diese Kampagne gibt es im Tracker noch keine Encounter.")));
    };
    draw();
  })();
  return sec;
}

// ---------- journal ----------

function journalPage(sessions) {
  let newestFirst = localStorageGet("journalNewestFirst", "1") === "1";
  const page = h("div", { class: "page journal" });
  const list = h("div");
  const toggle = h("button", { onclick: () => {
    newestFirst = !newestFirst;
    localStorageSet("journalNewestFirst", newestFirst ? "1" : "0");
    draw();
  } });
  page.append(h("div", { class: "page-head simple" }, h("div", { class: "head-main" },
    h("div", { class: "kicker muted small" }, S.campaign.name), h("h1", {}, t("Journal"))), h("div", { class: "head-actions" }, toggle)), list);
  function draw() {
    toggle.textContent = newestFirst ? t("↓ Neueste zuerst") : t("↑ Älteste zuerst");
    list.innerHTML = "";
    const ordered = newestFirst ? [...sessions].reverse() : sessions;
    for (const s of ordered) {
      const dates = [formatDay(s.played_on), cal.formatRange(calendar(), s.game_start, s.game_end)].filter(Boolean).join(" · ");
      list.append(h("article", { class: "journal-entry", id: `j-${s.id}` },
        h("h2", {}, h("a", { href: `#session/${s.id}` }, `Session ${s.number}: ${s.title}`)),
        dates ? h("div", { class: "muted small" }, dates) : null,
        s.recap.trim() ? h("div", { class: "prose", html: render(s.recap) })
          : h("div", { class: "muted empty" }, t("Noch kein Rückblick geschrieben."))));
    }
    if (!sessions.length) list.append(h("p", { class: "muted" }, t("Sobald eine Session als gespielt markiert ist, erscheint ihr Rückblick hier.")));
  }
  draw();
  return page;
}

function localStorageGet(key, fallback) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function localStorageSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* private mode */ }
}

// ---------- timeline ----------

let timelineOpenId = null;

function timelinePage(openId) {
  timelineOpenId = openId;
  const page = h("div", { class: "page timeline" },
    h("div", { class: "page-head simple" },
      h("div", { class: "head-main" }, h("div", { class: "kicker muted small" }, S.campaign.name), h("h1", {}, t("Timeline"))),
      h("div", { class: "head-actions" }, h("button", { class: "primary", onclick: () => newEventForm() }, t("+ Ereignis")))),
    h("div", { id: "new-event" }),
    h("ol", { id: "timeline-list", class: "timeline-list" }));
  setTimeout(() => {
    drawTimeline();
    if (openId) document.getElementById(`ev-${openId}`)?.scrollIntoView({ block: "center" });
  });
  return page;
}

function newEventForm() {
  const box = $("#new-event");
  if (!box) return;
  const c = calendar();
  let date = S.campaign.today || null;
  const title = h("input", { type: "text", placeholder: t("Was ist passiert?") });
  const sessionSel = h("select", {}, h("option", { value: "" }, t("Ohne Session")),
    [...S.sessions].reverse().map((s) => h("option", { value: s.id }, sessionLabel(s))));
  const submit = async (e) => {
    e.preventDefault();
    if (!title.value.trim()) return;
    const ev = await api("POST", "/api/events", {
      campaign_id: S.campaign.id, title: title.value.trim(), date, sort_key: cal.sortKey(c, date),
      session_id: sessionSel.value ? Number(sessionSel.value) : null,
    });
    S.events.push(ev);
    box.innerHTML = "";
    timelineOpenId = ev.id;
    drawTimeline();
  };
  box.replaceChildren(h("form", { class: "event-form", onsubmit: submit },
    title, cal.dateInput(c, date, (d) => { date = d; }), sessionSel,
    h("button", { class: "primary", type: "submit" }, t("Hinzufügen")),
    h("button", { type: "button", onclick: () => box.replaceChildren() }, t("Abbrechen"))));
  title.focus();
}

function drawTimeline() {
  const list = $("#timeline-list");
  if (!list) return;
  const c = calendar();
  const q = S.timelineFilter.trim().toLowerCase();
  const items = S.events.map((ev) => ({ kind: "event", key: ev.sort_key, ev }));
  if (cal.hasDates(c)) {
    for (const s of S.sessions) {
      if (s.game_start || s.game_end) items.push({ kind: "session", key: cal.sortKey(c, s.game_start || s.game_end) - 0.5, s });
    }
  }
  items.sort((a, b) => a.key - b.key || (a.ev?.id || 0) - (b.ev?.id || 0));
  list.innerHTML = "";
  for (const it of items) {
    if (it.kind === "session") {
      const s = it.s;
      if (q && !s.title.toLowerCase().includes(q)) continue;
      list.append(h("li", { class: "tl-session" },
        h("div", { class: "tl-date muted small" }, cal.formatRange(c, s.game_start, s.game_end)),
        h("div", { class: "tl-card" }, h("a", { href: `#session/${s.id}` }, `📜 Session ${s.number}: ${s.title}`))));
      continue;
    }
    const ev = it.ev;
    if (q && !`${ev.title} ${ev.body}`.toLowerCase().includes(q)) continue;
    list.append(eventItem(ev));
  }
  if (!list.children.length) {
    list.append(h("li", { class: "muted empty-li" }, q ? t("Nichts gefunden.") : t("Noch keine Ereignisse. Mit „+ Ereignis“ oder aus den Notizen einer Session anlegen.")));
  }
}

function eventItem(ev) {
  const c = calendar();
  const session = S.sessions.find((s) => s.id === ev.session_id);
  const open = timelineOpenId === ev.id;
  const li = h("li", { class: `tl-event${open ? " open" : ""}`, id: `ev-${ev.id}` },
    h("div", { class: "tl-date muted small" }, cal.formatDate(c, ev.date) || t("ohne Datum")));
  const save = async (values) => {
    if ("date" in values) values.sort_key = cal.sortKey(c, values.date);
    const u = await api("PATCH", `/api/events/${ev.id}`, values);
    Object.assign(ev, u);
  };
  if (!open) {
    li.append(h("div", { class: "tl-card", onclick: (e) => {
      if (e.target.closest("a")) return;
      timelineOpenId = ev.id;
      drawTimeline();
    } },
      h("div", { class: "tl-title", html: render(ev.title).replace(/^<p>|<\/p>\s*$/g, "") }),
      ev.body.trim() ? h("div", { class: "prose small-prose", html: render(ev.body) }) : null,
      session ? h("a", { class: "muted small", href: `#session/${session.id}` }, `📜 ${t("Session {n}", { n: session.number })}`) : null));
    return li;
  }
  const sessionSel = h("select", { onchange: () => save({ session_id: sessionSel.value ? Number(sessionSel.value) : null }) },
    h("option", { value: "" }, t("Ohne Session")), [...S.sessions].reverse().map((s) => h("option", { value: s.id }, sessionLabel(s))));
  sessionSel.value = ev.session_id ?? "";
  const ed = createEditor({
    mode: S.settings.editor, value: ev.body, render, suggest, upload, placeholder: t("Details…"),
    onChange: (v) => saveLater(`ev${ev.id}:body`, () => save({ body: v })),
  });
  li.append(h("div", { class: "tl-card editing" },
    h("input", { type: "text", class: "tl-title-input", value: ev.title, oninput: (e) => saveLater(`ev${ev.id}:title`, () => save({ title: e.target.value })) }),
    h("div", { class: "row" }, cal.dateInput(c, ev.date, async (d) => { await save({ date: d }); S.events.sort((a, b) => a.sort_key - b.sort_key || a.id - b.id); }), sessionSel),
    ed.el,
    h("div", { class: "row" },
      h("button", { class: "primary", onclick: async () => { await flushSaves(); timelineOpenId = null; drawTimeline(); } }, t("✓ Fertig")),
      h("button", { class: "danger", onclick: async () => {
        if (!confirm(t("Ereignis löschen?"))) return;
        await api("DELETE", `/api/events/${ev.id}`);
        S.events = S.events.filter((x) => x.id !== ev.id);
        drawTimeline();
      } }, t("🗑 Löschen")))));
  return li;
}

// ---------- home and welcome ----------

function homePage() {
  const c = S.campaign;
  const planned = S.sessions.filter((s) => s.status === "planned");
  const played = S.sessions.filter((s) => s.status === "played");
  const last = played[played.length - 1];
  const quests = S.entries.filter((e) => e.type === "quest" && e.status === "offen");
  const pending = S.entries.filter((e) => e.type === "decision" && e.status === "ausstehend");
  const recent = [...S.entries].filter((e) => e.type !== "pc").sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 8);
  const card = (title, ...kids) => h("section", { class: "card" }, h("h3", {}, title), ...kids);
  const entryLinks = (list, empty) => (list.length
    ? h("ul", { class: "plain" }, list.map((e) => h("li", {}, entryChip(e), e.summary ? h("span", { class: "muted small" }, ` ${e.summary}`) : null)))
    : h("div", { class: "muted small" }, empty));
  const world = c.calendar ? cal.WORLDS[c.calendar.type]?.label : t("Welt noch nicht festgelegt");
  return h("div", { class: "page home" },
    h("div", { class: "page-head simple" }, h("div", { class: "head-main" },
      h("div", { class: "kicker muted small" }, `${world}${c.today ? ` · ${cal.formatDate(calendar(), c.today)}` : ""}`),
      h("h1", {}, c.name))),
    h("div", { class: "cards" },
      card(t("Nächste Session"),
        planned[0] ? h("a", { class: "big-link", href: `#session/${planned[0].id}` }, `📜 ${sessionLabel(planned[0])}`)
          : h("div", { class: "muted small" }, t("Keine geplant.")),
        h("button", { class: "small-btn", onclick: () => setTopic("sessions") }, t("Alle Sessions"))),
      card(t("Zuletzt gespielt"),
        last ? h("div", {}, h("a", { class: "big-link", href: `#session/${last.id}` }, `📖 ${sessionLabel(last)}`),
          last.played_on ? h("div", { class: "muted small" }, formatDay(last.played_on)) : null)
          : h("div", { class: "muted small" }, t("Noch keine Session gespielt."))),
      card(t("Offene Quests"), entryLinks(quests, t("Keine offenen Quests."))),
      card(t("Folgen ausstehend"), entryLinks(pending, t("Keine offenen Entscheidungen."))),
      card(t("Zuletzt geändert"), entryLinks(recent, t("Noch keine Einträge.")))));
}

function welcomePage() {
  return h("div", { class: "page" }, h("h1", {}, t("Willkommen")),
    h("p", {}, S.campaigns.length ? t("Oben eine Kampagne wählen.") : t("Es gibt noch keine Kampagne.")),
    h("button", { class: "primary", onclick: () => openWorldModal({ create: true }) }, t("+ Neue Kampagne")));
}

// ---------- modals ----------

// opts.wide: a broad dialog (the preview of a book chapter import).
function openModal(content, opts = {}) {
  const modal = $("#modal");
  modal.classList.toggle("wide", !!opts.wide);
  modal.replaceChildren(content);
  $("#modal-backdrop").hidden = false;
  modal.querySelector("input, select, button")?.focus();
}
function closeModal() {
  $("#modal-backdrop").hidden = true;
  $("#modal").replaceChildren();
}
$("#modal-backdrop").addEventListener("mousedown", (e) => { if (e.target.id === "modal-backdrop") closeModal(); });

async function openWorldModal({ create, templateId = null }) {
  const templates = create ? await api("GET", "/api/templates") : [];
  const current = create ? null : S.campaign?.calendar;
  let type = current?.type || "harptos";
  let custom = current?.type === "custom" ? current : cal.customTemplate();
  let today = create ? null : S.campaign?.today;
  const name = h("input", { type: "text", placeholder: t("Name der Kampagne") });
  const radios = h("div", { class: "world-choice" });
  const customBox = h("div", { class: "custom-cal" });
  const dateBox = h("div", { class: "row" });
  const era = h("input", { type: "text", value: custom.era, placeholder: "z. B. n. Z." });
  const months = h("textarea", { rows: 8, value: cal.monthsToText(custom.months) });

  const calendarNow = () => (type === "harptos" ? cal.harptos()
    : type === "custom" ? { type: "custom", era: era.value.trim(), months: cal.monthsFromText(months.value) }
      : { type: "none" });
  function drawDate() {
    dateBox.replaceChildren(h("span", { class: "fact-label" }, t("Aktuelles Datum in der Spielwelt")),
      cal.dateInput(calendarNow(), today, (d) => { today = d; }));
  }
  for (const [key, w] of Object.entries(cal.WORLDS)) {
    const input = h("input", { type: "radio", name: "world", value: key, checked: key === type, onchange: () => {
      if (type !== key) today = null;
      type = key;
      customBox.hidden = type !== "custom";
      drawDate();
    } });
    radios.append(h("label", { class: "choice" }, input, h("span", {}, h("b", {}, w.label), h("br"), h("span", { class: "muted small" }, w.hint))));
  }
  customBox.append(
    h("label", { class: "fact" }, h("span", { class: "fact-label" }, t("Zeitrechnung (hinter der Jahreszahl)")), era),
    h("label", { class: "fact" }, h("span", { class: "fact-label" }, t("Monate, eine Zeile pro Monat: Name = Tage. Ein Monat mit 1 Tag gilt als Feiertag.")), months));
  customBox.hidden = type !== "custom";
  months.addEventListener("change", drawDate);
  era.addEventListener("change", drawDate);
  drawDate();

  // A new campaign can start from a template (templates.py): then its world, date and contents
  // come from there, and the DM picks what of the earlier group's play comes along.
  const templateSel = h("select", {}, h("option", { value: "" }, t("keine, leere Kampagne")),
    ...templates.map((t) => h("option", { value: String(t.id), selected: t.id === templateId }, t.name)));
  const withChars = h("input", { type: "checkbox" });
  const reset = h("input", { type: "checkbox", checked: true });
  const templateBox = h("div", { class: "template-from" },
    h("label", { class: "choice" }, reset, h("span", {}, h("b", {}, t("Spielstand zurücksetzen")), h("br"),
      h("span", { class: "muted small" }, t("Nichts den Spielern bekannt, alle Sessions wieder geplant (ohne Rückblick und Notizen), Zeitleiste der gespielten Sessions weg, Nebel wieder zu, Encounter am Anfang mit vollen TP.")))),
    h("label", { class: "choice" }, withChars, h("span", {}, h("b", {}, t("Spielercharaktere übernehmen")), h("br"),
      h("span", { class: "muted small" }, t("Sonst bleiben die Charaktere der anderen Gruppe (mit ihren Einträgen und Spielfiguren) weg.")))));
  const worldBox = h("div", {}, h("div", { class: "fact-label", style: "margin-top:10px" }, t("In welcher Welt spielt die Kampagne?")),
    radios, customBox, dateBox);
  const showTemplate = () => {
    const tpl = templates.find((x) => String(x.id) === templateSel.value);
    templateBox.hidden = !tpl;
    worldBox.hidden = !!tpl;
    if (tpl && !name.value.trim()) name.placeholder = t("z.B. {name} (neue Gruppe)", { name: tpl.source_name || tpl.name });
  };
  templateSel.addEventListener("change", showTemplate);

  const save = async () => {
    if (create && templateSel.value) {
      if (!name.value.trim()) return toast(t("Bitte einen Namen angeben."), true);
      const created = await api("POST", `/api/templates/${templateSel.value}/campaigns`,
        { name: name.value.trim(), with_characters: withChars.checked, reset: reset.checked });
      closeModal();
      await loadCampaigns();
      $("#campaign").value = created.id;
      await openCampaign(created.id);
      toast(t("Kampagne „{name}“ aus der Vorlage angelegt.", { name: created.name }));
      return;
    }
    const calendarValue = calendarNow();
    if (calendarValue.type === "custom" && !calendarValue.months.length) return toast(t("Bitte mindestens einen Monat angeben."), true);
    if (create) {
      if (!name.value.trim()) return toast(t("Bitte einen Namen angeben."), true);
      const created = await api("POST", "/api/campaigns", { name: name.value.trim(), calendar: calendarValue, today });
      closeModal();
      await loadCampaigns();
      $("#campaign").value = created.id;
      await openCampaign(created.id);  // also stores it as the chosen one, for the tracker and the map
      toast(t("Kampagne angelegt, auch im Combat Tracker."));
    } else {
      S.campaign = { ...S.campaign, ...(await api("PATCH", `/api/campaigns/${S.campaign.id}`, { calendar: calendarValue, today })) };
      closeModal();
      renderAll();
    }
  };

  openModal(h("div", {},
    h("h2", {}, create ? t("Neue Kampagne") : t("Welt für „{name}“", { name: S.campaign.name })),
    create ? h("label", { class: "fact" }, h("span", { class: "fact-label" }, t("Name")), name) : null,
    create && templates.length ? h("label", { class: "fact" }, h("span", { class: "fact-label" }, t("Aus Vorlage")), templateSel) : null,
    templateBox, worldBox,
    !create && current ? h("div", { class: "muted small" }, t("Bereits erfasste Daten werden beim Wechsel des Kalenders nicht umgerechnet.")) : null,
    h("div", { class: "modal-actions" },
      h("button", { onclick: closeModal }, t("Abbrechen")),
      h("button", { class: "primary", onclick: save }, create ? t("Anlegen") : t("Speichern")))));
  showTemplate();
  if (create) name.focus();
}

function openTodayModal() {
  const c = calendar();
  let today = S.campaign.today;
  const box = h("div", { class: "row" });
  const draw = () => box.replaceChildren(cal.dateInput(c, today, (d) => { today = d; }));
  draw();
  const save = async () => {
    S.campaign = { ...S.campaign, ...(await api("PATCH", `/api/campaigns/${S.campaign.id}`, { today })) };
    closeModal();
    renderHeader();
    if (!currentRoute().kind) route();
  };
  openModal(h("div", {},
    h("h2", {}, t("Datum in der Spielwelt")),
    box,
    cal.hasDates(c) ? h("button", { class: "small-btn", onclick: () => { today = cal.nextDay(c, today); draw(); } }, "+1 Tag") : null,
    h("div", { class: "modal-actions" },
      h("button", { onclick: closeModal }, t("Abbrechen")),
      h("button", { class: "primary", onclick: save }, t("Übernehmen")))));
}

// For campaigns that started before this tool: adds an already played session
// and opens its recap for writing.
function openPastSessionModal() {
  const c = calendar();
  const next = Math.max(0, ...S.sessions.map((s) => s.number)) + 1;
  let start = null;
  let end = null;
  const number = h("input", { type: "number", class: "num-input", min: 1, value: next, title: t("Nummer") });
  const title = h("input", { type: "text", class: "title-input", placeholder: t("Titel der Session") });
  const playedOn = h("input", { type: "date" });
  const moveToday = h("input", { type: "checkbox" });
  const todayRow = h("label", { class: "fact check", hidden: true }, moveToday, t("Datum der Kampagne auf das Ende dieser Session setzen"));
  const updateToday = () => {
    const last = end || start;
    todayRow.hidden = !last || !cal.hasDates(c);
    moveToday.checked = !!last && (!S.campaign.today || cal.sortKey(c, last) > cal.sortKey(c, S.campaign.today));
  };
  const save = async () => {
    if (!title.value.trim()) return title.focus();
    const s = await api("POST", "/api/sessions", {
      campaign_id: S.campaign.id, title: title.value.trim(), number: Number(number.value) || null, status: "played",
      played_on: playedOn.value || null, game_start: start, game_end: end,
    });
    sessionChanged(s);
    if (moveToday.checked && !todayRow.hidden) {
      S.campaign = { ...S.campaign, ...(await api("PATCH", `/api/campaigns/${S.campaign.id}`, { today: end || start })) };
      renderHeader();
    }
    closeModal();
    S.sessionTab[s.id] = "recap";
    S.editNext = true;
    go(`#session/${s.id}`);
  };
  title.addEventListener("keydown", (e) => { if (e.key === "Enter") save(); });
  openModal(h("div", {},
    h("h2", {}, t("Rückblick nachtragen")),
    h("p", { class: "muted small" }, t("Für Sessions, die schon gespielt wurden, bevor die Kampagne hier geführt wurde. Die Session wird als gespielt angelegt und erscheint im Journal.")),
    h("div", { class: "title-row" }, number, title),
    h("label", { class: "fact" }, h("span", { class: "fact-label" }, t("Spielabend")), playedOn),
    h("label", { class: "fact" }, h("span", { class: "fact-label" }, t("Spielwelt von")), cal.dateInput(c, null, (d) => { start = d; updateToday(); })),
    h("label", { class: "fact" }, h("span", { class: "fact-label" }, "bis"), cal.dateInput(c, null, (d) => { end = d; updateToday(); })),
    todayRow,
    h("div", { class: "modal-actions" },
      h("button", { onclick: closeModal }, t("Abbrechen")),
      h("button", { class: "primary", onclick: save }, t("Anlegen und Rückblick schreiben")))));
  title.focus();
}

function openCreateLinkModal(name) {
  const buttons = Object.entries(TYPES).filter(([, t]) => !t.fromTracker).map(([type, t]) =>
    h("button", { onclick: async () => {
      closeModal();
      const e = await createEntry(type, name);
      S.editNext = true;
      go(`#entry/${e.id}`);
    } }, `${t.icon} ${t.one}`));
  openModal(h("div", {},
    h("h2", {}, t("„{name}“ gibt es noch nicht", { name })),
    h("p", { class: "muted" }, t("Als was soll der Eintrag angelegt werden?")),
    h("div", { class: "type-grid" }, buttons),
    h("div", { class: "modal-actions" }, h("button", { onclick: closeModal }, t("Abbrechen")))));
}

// ---------- search ----------

const searchInput = $("#search");
const searchResults = $("#search-results");
let searchTimer;
searchInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 200);
});
searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { searchResults.hidden = true; searchInput.blur(); }
  if (e.key === "Enter") searchResults.querySelector("a")?.click();
});
searchInput.addEventListener("blur", () => setTimeout(() => { searchResults.hidden = true; }, 150));
searchInput.addEventListener("focus", () => { if (searchResults.children.length) searchResults.hidden = false; });

async function runSearch() {
  const q = searchInput.value.trim();
  if (!S.campaign || q.length < 2) { searchResults.hidden = true; return; }
  const results = await api("GET", `/api/search?campaign_id=${S.campaign.id}&q=${encodeURIComponent(q)}`);
  searchResults.innerHTML = "";
  for (const r of results) {
    if (r.library) {
      // A monster or item of the library: its page, filtered to that name.
      const [topic, icon, where] = r.kind === "monster" ? ["bestiary", "🐉", t("Bestiarium")] : ["items", "⚔", t("Items")];
      searchResults.append(h("li", {}, h("a", { href: `#library/${topic}`, onclick: () => {
        searchResults.hidden = true;
        showInLibrary(topic, r.title);
      } }, h("span", {}, `${icon} ${r.title}`), h("span", { class: "muted small" }, where))));
      continue;
    }
    const href = refHref(r);
    const icon = refIcon(r);
    const title = r.kind === "session" ? `Session ${r.number}: ${r.title}` : r.title;
    searchResults.append(h("li", {}, h("a", { href, onclick: () => { searchResults.hidden = true; } },
      h("span", {}, `${icon} ${title}`), r.snippet ? h("span", { class: "muted small", html: highlight(r.snippet, q) }) : null)));
  }
  if (!results.length) searchResults.append(h("li", { class: "muted empty-li" }, t("Nichts gefunden.")));
  searchResults.hidden = false;
}

// The bestiary or the item list with its other filters cleared and the name in its own search
// (library.js listens to that field).
function showInLibrary(topic, name) {
  const [reset, input] = topic === "bestiary" ? ["#bestiary-filter-reset", "#bestiary-search"] : ["#item-filter-reset", "#item-search"];
  $(reset)?.click();
  const field = $(input);
  if (!field) return;
  field.value = name;
  field.dispatchEvent(new Event("input"));
}

function highlight(text, q) {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return esc(text);
  return esc(text.slice(0, i)) + `<mark>${esc(text.slice(i, i + q.length))}</mark>` + esc(text.slice(i + q.length));
}

// ---------- setup drawer ----------

function toggleSetup(open = $("#setup").hidden) {
  // Fresh each time: the campaigns (import target) are loaded after the first render.
  if (open) renderSetup();
  $("#setup").hidden = !open;
  $("#btn-setup").classList.toggle("on", open);
}

async function restoreBackup(e) {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  const ok = confirm(
    t("Sicherung „{name}\" wiederherstellen?\n\nAlle Kampagnen-Einträge, Sessions und Einstellungen werden durch den Stand der Sicherung ersetzt.", { name: file.name })
  );
  if (!ok) return;
  await flushSaves();
  const status = $("#backup-status");
  const before = status.textContent;
  status.textContent = t("Sicherung wird hochgeladen und wiederhergestellt …");
  let resp = await fetch("/api/backup/restore", { method: "POST", body: file });
  // 409: the backup comes from a newer Wyrmdesk; only on a second yes.
  if (resp.status === 409) {
    let detail = "";
    try { detail = (await resp.json()).detail || ""; } catch { /* not json */ }
    if (!confirm(`${detail}\n\n${t("Trotzdem wiederherstellen?")}`)) {
      status.textContent = before;
      return;
    }
    resp = await fetch("/api/backup/restore?force=1", { method: "POST", body: file });
  }
  if (!resp.ok) {
    let detail = resp.statusText;
    try { detail = (await resp.json()).detail || detail; } catch { /* not json */ }
    status.textContent = before;
    toast(detail, true);
    return;
  }
  alert(t("Wiederhergestellt. Die Seite wird neu geladen."));
  location.reload();
}

function renderSetup() {
  document.querySelectorAll('input[name="editor"]').forEach((r) => { r.checked = r.value === S.settings.editor; });
  $("#rot-label").textContent = `${S.settings.rotation}°`;
  $("#app-version").textContent = S.settings.version ? t("Wyrmdesk Version {v}", { v: S.settings.version }) : "";
  const sel = $("#char-import-campaign");
  sel.innerHTML = "";
  for (const c of S.campaigns) sel.append(h("option", { value: c.id }, c.name || `Kampagne ${c.id}`));
  if (S.campaign) sel.value = S.campaign.id;
  renderTemplates();
  renderStreamDeck();
}

// ---------- Stream Deck webhooks (main.py /api/remote/display…) ----------

function renderStreamDeck() {
  const sel = $("#sd-entry");
  const before = sel.value;
  sel.innerHTML = "";
  // What "📽 Auf Beamer zeigen" offers: handouts, and every entry with a picture.
  const shown = (S.entries || []).filter((e) => e.image || TYPES[e.type]?.handout);
  if (!shown.length) sel.append(h("option", { value: "" }, t("– keine Handouts oder Bilder –")));
  for (const [type, spec] of Object.entries(TYPES)) {
    const items = shown.filter((e) => e.type === type);
    if (!items.length) continue;
    const group = h("optgroup", { label: spec.label });
    for (const e of items) group.append(h("option", { value: e.id }, e.name));
    sel.append(group);
  }
  if ([...sel.options].some((o) => o.value === before)) sel.value = before;
  updateStreamDeckUrl();
}

function updateStreamDeckUrl() {
  const id = $("#sd-entry").value;
  const params = new URLSearchParams();
  if ($("#sd-text").value) params.set("text", $("#sd-text").value === "1" ? "true" : "false");
  if ($("#sd-toggle").checked) params.set("toggle", "true");
  const query = params.toString() ? `?${params}` : "";
  $("#sd-url").value = id ? `${location.origin}/api/remote/display/${id}${query}` : "";
  $("#sd-clear-url").value = `${location.origin}/api/remote/display-clear`;
}

async function copyField(input) {
  if (!input.value) return;
  input.select();
  // The clipboard API only works over https or on localhost; the LAN address falls back to execCommand.
  try {
    await navigator.clipboard.writeText(input.value);
  } catch {
    document.execCommand("copy");
  }
  toast(t("Adresse kopiert."));
}

// ---------- campaign templates (templates.py) ----------

const templateCounts = (n) => [n.entries && tn(n.entries, "{n} Eintrag", "{n} Einträge"), n.sessions && tn(n.sessions, "{n} Session", "{n} Sessions"),
  n.characters && tn(n.characters, "{n} Charakter", "{n} Charaktere"), n.encounters && tn(n.encounters, "{n} Encounter", "{n} Encounter"), n.scenes && tn(n.scenes, "{n} Karte", "{n} Karten")]
  .filter(Boolean).join(" · ") || t("leer");

async function renderTemplates() {
  const list = $("#template-list");
  const templates = await api("GET", "/api/templates");
  list.replaceChildren(...templates.map((tpl) => h("li", {},
    h("div", { class: "tpl-name" }, tpl.name),
    h("div", { class: "muted small" }, t("aus „{source}“, {date}", { source: tpl.source_name || "?", date: formatDay(tpl.created_at.slice(0, 10)) })),
    tpl.note ? h("div", { class: "small" }, tpl.note) : null,
    h("div", { class: "muted small" }, templateCounts(tpl.counts)),
    h("div", { class: "row" },
      h("button", { class: "small-btn", onclick: () => { toggleSetup(false); openWorldModal({ create: true, templateId: tpl.id }); } },
        t("Neue Kampagne daraus…")),
      h("button", { class: "small-btn danger", title: t("Vorlage löschen"), onclick: async () => {
        if (!confirm(t("Vorlage „{name}“ löschen?\n\nKampagnen, die daraus entstanden sind, bleiben.", { name: tpl.name }))) return;
        await api("DELETE", `/api/templates/${tpl.id}`);
        renderTemplates();
      } }, "🗑")))));
  if (!templates.length) list.append(h("li", { class: "muted small" }, t("Noch keine Vorlage.")));
}

async function saveTemplate() {
  if (!S.campaign) return toast(t("Zuerst oben eine Kampagne wählen."), true);
  await flushSaves();
  const name = prompt(t("Name der Vorlage aus „{name}“:", { name: S.campaign.name }), `${S.campaign.name} (${t("Vorlage {date}", { date: new Date().toLocaleDateString(UI_LOCALE) })})`)?.trim();
  if (!name) return;
  const t = await api("POST", `/api/campaigns/${S.campaign.id}/templates`, { name });
  toast(`Vorlage „${t.name}“ gesichert: ${templateCounts(t.counts)}.`);
  renderTemplates();
}

async function importCharacters(e) {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  if (!$("#char-import-campaign").value) return toast(t("Zuerst eine Kampagne wählen."), true);
  let chars;
  try {
    chars = JSON.parse(await file.text());
  } catch {
    toast(t("Das ist keine gültige JSON-Datei."), true);
    return;
  }
  importCharacterList(chars);
}

// A player's share link from the Charaktererstellung (…/teilen/<token>): its data comes from …/api/teilen/<token>,
// fetched by this page itself (that route allows it, CORS), so the Kampagnenbuch's server needs no way out.
async function importCharacterLink(e) {
  e.preventDefault();
  if (!$("#char-import-campaign").value) return toast(t("Zuerst eine Kampagne wählen."), true);
  let url;
  try {
    url = new URL(e.target.url.value.trim());
  } catch {
    return toast(t("Das ist kein gültiger Link."), true);
  }
  const m = url.pathname.match(/^(.*?)\/(?:api\/)?teilen\/([^/]+)\/?$/);
  if (!m || !/^https?:$/.test(url.protocol)) return toast(t("Das ist kein Teilen-Link aus der Charaktererstellung (…/teilen/…)."), true);
  let chars;
  try {
    const resp = await fetch(`${url.origin}${m[1]}/api/teilen/${m[2]}`, { cache: "no-store" });
    if (resp.status === 404) return toast(t("Dieser Link ist ungültig oder abgelaufen."), true);
    if (!resp.ok) throw new Error();
    chars = await resp.json();
  } catch {
    return toast(t("Der Charakter konnte nicht abgerufen werden. Link und Internetverbindung prüfen."), true);
  }
  e.target.reset();
  importCharacterList(chars);
}

async function importCharacterList(chars) {
  const campaignId = $("#char-import-campaign").value;
  if (!Array.isArray(chars)) {
    toast(t("Erwartet wird die Liste der Charaktere aus der Charaktererstellung."), true);
    return;
  }
  if (!chars.length) {
    toast(t("Die Datei enthält keine Charaktere. Die Charaktererstellung exportiert nur fertig gemeldete."), true);
    return;
  }
  const here = new Set((await api("GET", `/api/characters?campaign_id=${campaignId}`)).map((c) => c.name));
  const conflicts = [...new Set(chars.map((c) => (c.name || "").trim()).filter((n) => n && here.has(n)))];
  if (!conflicts.length) return sendCharacterImport(campaignId, chars, {});
  // Already in the campaign: the DM chooses per character (a re-export after changes in the Charaktererstellung).
  const choice = {};
  const rows = conflicts.map((name) => {
    choice[name] = "skip";
    const sel = h("select", { onchange: (ev) => { choice[name] = ev.target.value; } },
      h("option", { value: "skip" }, t("Überspringen")),
      h("option", { value: "replace" }, t("Charakterblatt ersetzen")),
      h("option", { value: "copy" }, t("Als Kopie anlegen")));
    return h("div", { class: "row" }, h("label", { style: "flex:1" }, name), sel);
  });
  openModal(h("div", {},
    h("h2", {}, t("Schon in der Kampagne")),
    h("p", { class: "muted small" }, t("„Charakterblatt ersetzen“ übernimmt Stufe, Werte, Merkmale und Ausrüstungsliste aus dem Export. TP, verbrauchte Ressourcen und Inventar aus dem Spiel bleiben, wie sie sind.")),
    ...rows,
    h("div", { class: "modal-actions" },
      h("button", { onclick: closeModal }, t("Abbrechen")),
      h("button", { class: "primary", onclick: () => { closeModal(); sendCharacterImport(campaignId, chars, choice); } },
        t("Importieren")))));
}

async function sendCharacterImport(campaignId, chars, onConflict) {
  const status = $("#char-import-status");
  status.textContent = t("Wird importiert …");
  let res;
  try {
    res = await api("POST", `/api/characters/import?campaign_id=${campaignId}`, { characters: chars, on_conflict: onConflict });
  } catch {
    status.textContent = t("Import fehlgeschlagen.");
    toast(t("Import fehlgeschlagen."), true);
    return;
  }
  const { imported, replaced, skipped, avatars, remapped, missing } = res;
  const counts = t("{imported} importiert, {replaced} ersetzt, {skipped} übersprungen.", { imported, replaced: replaced || 0, skipped });
  status.textContent = counts
    + (avatars ? ` ${t("{what} übernommen.", { what: tn(avatars, "{n} Portrait", "{n} Portraits") })}` : "")
    + (remapped ? ` ${t("{n} Verweise auf diese Bibliothek umgestellt.", { n: remapped })}` : "")
    + (missing && missing.length ? ` ${t("Nicht in der Bibliothek: {list}.", { list: missing.join(", ") })}` : "");
  // The line under the button is easy to miss: the result also pops up.
  const name = $("#char-import-campaign").selectedOptions[0]?.textContent || t("die Kampagne");
  toast(imported || replaced ? t("In „{name}“: {counts}", { name, counts }) : t("Nichts importiert ({counts})", { counts }), !(imported || replaced));
  if (S.campaign && Number(campaignId) === S.campaign.id) await openCampaign(S.campaign.id);
}

// The setup drawer's sections fold up; the open ones are remembered per browser (by heading).
const SETUP_OPEN_KEY = "setupOpenSections";

function wireSetupSections() {
  let open;
  try { open = new Set(JSON.parse(localStorageGet(SETUP_OPEN_KEY, "[]"))); } catch { open = new Set(); }
  document.querySelectorAll("#setup > section").forEach((sec) => {
    const head = sec.querySelector(":scope > h2");
    if (!head) return;
    const title = head.textContent.trim();
    sec.classList.toggle("collapsed", !open.has(title));
    head.tabIndex = 0;
    head.setAttribute("role", "button");
    const sync = () => head.setAttribute("aria-expanded", String(!sec.classList.contains("collapsed")));
    const toggle = () => {
      const collapsed = sec.classList.toggle("collapsed");
      collapsed ? open.delete(title) : open.add(title);
      localStorageSet(SETUP_OPEN_KEY, JSON.stringify([...open]));
      sync();
    };
    sync();
    head.addEventListener("click", toggle);
    head.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
    });
  });
}

function wireStatic() {
  wireSetupSections();
  document.querySelectorAll("#rail button").forEach((b) => b.addEventListener("click", () => {
    const topic = b.dataset.topic;
    setTopic(topic, { toggle: true });
    if (topic === "journal" || topic === "timeline") go(`#${topic}`);
  }));
  $("#campaign").addEventListener("change", async (e) => {
    if (e.target.value === "__new__") {
      e.target.value = S.campaign?.id ?? "";  // stays on the open one until the new one is made
      openWorldModal({ create: true });
      return;
    }
    await flushSaves();
    location.hash = "";
    await openCampaign(Number(e.target.value));
  });
  $("#today-btn").addEventListener("click", openTodayModal);
  $("#btn-setup").addEventListener("click", () => toggleSetup());
  $("#btn-setup-close").addEventListener("click", () => toggleSetup(false));
  $("#backup-restore").addEventListener("change", restoreBackup);
  $("#char-import").addEventListener("change", importCharacters);
  $("#char-import-link").addEventListener("submit", importCharacterLink);
  const trContent = async (body, what) => {
    const out = $("#tr-content-progress");
    const est = await api("POST", "/api/translate/content", { ...body, dry_run: true });
    if (!est.items) return (out.textContent = t("{what}: nichts mehr zu übersetzen.", { what }));
    if (!confirm(t("{what} übersetzen? {n} Texte, etwa {chars} Zeichen (der Gratis-Plan hat 500 000 im Monat).", { what, n: est.items, chars: est.chars_missing.toLocaleString(UI_LOCALE) }))) return;
    out.textContent = t("Wird übersetzt …");
    try {
      const res = await translateContent(body, (r) => {
        out.textContent = t("{done} von {n} Texten übersetzt, noch etwa {chars} Zeichen …", { done: r.done, n: est.items, chars: r.chars_missing.toLocaleString(UI_LOCALE) });
      });
      out.textContent = `${t("{n} Texte übersetzt.", { n: res.done })} ${res.message}`;
      if (body.campaign_id) await reloadIndex();
    } catch (err) {
      out.textContent = t("Fehler: {error}", { error: err.message });
    }
  };
  $("#btn-tr-campaign").addEventListener("click", () => {
    if (!S.campaign) return toast(t("Zuerst oben eine Kampagne wählen."), true);
    trContent({ campaign_id: S.campaign.id }, t("Die Kampagne „{name}“", { name: S.campaign.name }));
  });
  $("#btn-tr-monsters").addEventListener("click", () => trContent({ monsters: true }, t("Das Bestiarium")));
  $("#btn-book-import").addEventListener("click", () => {
    if (!S.campaign) return toast(t("Zuerst oben eine Kampagne wählen."), true);
    toggleSetup(false);
    openBookImport({ api, h, toast, campaign: S.campaign, openModal, closeModal, reload: () => openCampaign(S.campaign.id),
      translate: S.settings.deepl_configured ? translateContent : null });
  });
  $("#btn-world").addEventListener("click", () => { if (S.campaign) openWorldModal({ create: false }); });
  $("#btn-new-campaign").addEventListener("click", () => openWorldModal({ create: true }));
  $("#btn-save-template").addEventListener("click", saveTemplate);
  document.querySelectorAll('input[name="editor"]').forEach((r) => r.addEventListener("change", async () => {
    await flushSaves();
    S.settings = await api("PATCH", "/api/settings", { editor: r.value });
    route();
  }));
  const rotate = async (delta) => {
    S.settings = await api("PATCH", "/api/settings", { rotation: S.settings.rotation + delta });
    renderSetup();
  };
  $("#rot-left").addEventListener("click", () => rotate(-90));
  $("#rot-right").addEventListener("click", () => rotate(90));
  $("#btn-rename-campaign").addEventListener("click", async () => {
    if (!S.campaign) return;
    const name = prompt(t("Neuer Name der Kampagne:"), S.campaign.name)?.trim();
    if (!name || name === S.campaign.name) return;
    await api("PATCH", `/api/campaigns/${S.campaign.id}`, { name });
    const id = await loadCampaigns();
    await openCampaign(id);
  });
  $("#btn-delete-campaign").addEventListener("click", async () => {
    if (!S.campaign) return;
    if (!confirm(t("Kampagne „{name}“ wirklich löschen?\n\nAlle Einträge, Sessions, Charaktere und ihre Encounter im Combat Tracker werden unwiderruflich gelöscht.", { name: S.campaign.name }))) return;
    await api("DELETE", `/api/campaigns/${S.campaign.id}`);
    location.hash = "";
    const id = await loadCampaigns();
    await openCampaign(id);
  });
  $("#display-badge").addEventListener("click", () => api("DELETE", "/api/display"));
  ["#sd-entry", "#sd-text", "#sd-toggle"].forEach((s) => $(s).addEventListener("change", updateStreamDeckUrl));
  $("#sd-copy").addEventListener("click", () => copyField($("#sd-url")));
  $("#sd-clear-copy").addEventListener("click", () => copyField($("#sd-clear-url")));
  const playerUrl = `${location.protocol}//${location.hostname}:${Number(location.port || 80) + 1}/`;
  $("#player-link").href = playerUrl;
  $("#player-url").textContent = playerUrl;

  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      searchInput.focus();
      searchInput.select();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      flushSaves();
    } else if (e.key === "Escape") {
      if (!$("#modal-backdrop").hidden) closeModal();
      else if (!$("#setup").hidden) toggleSetup(false);
    }
  });
}

function connectSocket() {
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "display") {
      S.display = msg.state.handout;
      renderDisplayBadge();
    }
  });
  ws.addEventListener("close", () => setTimeout(connectSocket, 2000));
}

async function init() {
  wireStatic();
  S.settings = await api("GET", "/api/settings");
  renderSetup();
  const id = await loadCampaigns();
  connectSocket();
  await openCampaign(id);
  if (!S.topic) setTopic(libraryRoute() || "sessions");
}

init();
