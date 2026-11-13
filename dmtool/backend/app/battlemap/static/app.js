import { FogMask, SightDim, connectSocket, drawGrid, drawMap, drawTemplate, drawToken, feetToPx, templatePath } from "./shared/scene.js";

const $ = (id) => document.getElementById(id);
const canvas = $("map");
const ctx = canvas.getContext("2d");

// ---------- state ----------

let settings = null;
let scenes = [];
let beamerImages = [];
let scene = null; // scene being edited (not necessarily the one on the beamer)
let trackerState = { configured: false, ok: false, combatants: [] };
let selectedTokenId = null;
let tool = "select";

// DM camera: map point at screen centre and screen px per map px.
const cam = { x: 0, y: 0, scale: 1 };
const fog = new FogMask(() => (dirty = true));
// Fog ops pile up (every step of a vision token adds one) and travel with every scene update.
// Past FOG_COMPACT_AT this view flattens all but the newest FOG_KEEP into an image on the server;
// those few stay undoable.
const FOG_COMPACT_AT = 120;
const FOG_KEEP = 20;
let fogCompacting = false;
const sightDim = new SightDim();
let dirty = true;
let showWalls = false;
try { showWalls = localStorage.getItem("battlemap.showWalls") === "1"; } catch {}

// In-progress gesture (drag, brush stroke, polygon).
let gesture = null;
let poly = null; // { points, mode: "reveal" | "area" }
let hover = null;

const DEFAULT_SCREEN = { w: 1920, h: 1080 };

// ---------- api ----------

async function api(method, url, body, raw = false) {
  // Guards against the swapped argument order used by library.js/combat's api(path, method, body):
  // a call copied from there would otherwise send a request with the URL as its HTTP method.
  if (!/^(GET|POST|PUT|PATCH|DELETE)$/.test(method)) {
    throw new Error(`api(): "${method}" ist keine HTTP-Methode – Reihenfolge ist api(method, url, body, raw)`);
  }
  const opts = { method, headers: {} };
  if (body !== undefined) {
    if (raw) {
      opts.body = body;
    } else {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
  }
  const resp = await fetch(url, opts);
  if (!resp.ok) {
    const text = await resp.text();
    let detail = text;
    try { detail = JSON.parse(text).detail; } catch {}
    alert(`Fehler: ${detail}`);
    throw new Error(detail);
  }
  return resp.json();
}

// ---------- live updates ----------

connectSocket((msg) => {
  if (msg.type === "settings") {
    settings = msg.settings;
    renderSettings();
  } else if (msg.type === "scenes") {
    scenes = msg.scenes;
    renderSceneList();
    loadCampaigns();  // another campaign may have been chosen elsewhere (Kampagnenbuch, tracker)
    if (!scene) {
      // Start on the scene the beamer shows, so the DM sees what the table sees.
      const id = (settings && settings.active_scene_id) || (scenes[0] && scenes[0].id);
      if (id) openScene(id);
    }
  } else if (msg.type === "scene") {
    if (scene && msg.scene.id === scene.id) setScene(msg.scene, false);
  } else if (msg.type === "beamer-images") {
    beamerImages = msg.images;
    renderBeamerImages();
  } else if (msg.type === "tracker") {
    trackerState = msg.tracker;
    renderTracker();
    renderTokens();
    renderSettings();
  }
  dirty = true;
});

async function compactFog() {
  if (fogCompacting || !scene || scene.fog_ops.length <= FOG_COMPACT_AT || fog.waiting) return;
  fogCompacting = true;
  const s = scene;
  const count = s.fog_ops.length - FOG_KEEP;
  try {
    const png = await fog.flatten(count);
    const base = s.fog_base_url ? s.fog_base_url.split("/").pop() : "";
    // A 409 means the fog changed meanwhile (or another DM view was faster): the next update retries.
    await fetch(`api/scenes/${s.id}/fog/compact?count=${count}&base=${encodeURIComponent(base)}`,
      { method: "POST", body: png });
  } catch (err) {
    console.error("Fog konnte nicht zusammengefasst werden:", err);
  } finally {
    fogCompacting = false;
  }
}

async function openScene(id) {
  const s = await api("GET", `api/scenes/${id}`);
  setScene(s, true);
}

function setScene(s, fit) {
  const previous = scene;
  scene = s;
  fog.update(scene);
  compactFog();
  if (sightActive()) sightDim.update(scene, scene.vision_polys.map((p) => p.points));
  if (fit || !previous || previous.id !== s.id || previous.map_url !== s.map_url) fitCamera();
  if (selectedTokenId && !scene.tokens.some((t) => t.id === selectedTokenId)) selectedTokenId = null;
  if (selectedTemplateId && !scene.templates.some((t) => t.id === selectedTemplateId)) selectedTemplateId = null;
  document.body.classList.toggle("no-scene", !scene);
  renderSceneList();
  renderSceneFields();
  renderAreas();
  renderTokens();
  renderTemplateEditor();
  renderSettings();
  dirty = true;
}

// ---------- coordinates ----------

function resize() {
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.round(rect.width * devicePixelRatio);
  canvas.height = Math.round(rect.height * devicePixelRatio);
  // Resizing clears the canvas; redraw right away so opening a panel doesn't flash an empty map.
  render();
}
new ResizeObserver(resize).observe(canvas);

function fitCamera() {
  if (!scene || !scene.map_w) return;
  const rect = canvas.getBoundingClientRect();
  cam.scale = Math.min(rect.width / scene.map_w, rect.height / scene.map_h) * 0.95;
  cam.x = scene.map_w / 2;
  cam.y = scene.map_h / 2;
}

function toMap(ev) {
  const rect = canvas.getBoundingClientRect();
  return [
    cam.x + (ev.clientX - rect.left - rect.width / 2) / cam.scale,
    cam.y + (ev.clientY - rect.top - rect.height / 2) / cam.scale,
  ];
}

function snapToGrid(x, y, size) {
  const g = scene.grid_size;
  // Odd-sized creatures sit in a cell centre, even-sized ones on a grid intersection.
  const off = size % 2 === 1 || size < 1 ? 0.5 : 0;
  const sx = scene.grid_ox + (Math.round((x - scene.grid_ox) / g - off) + off) * g;
  const sy = scene.grid_oy + (Math.round((y - scene.grid_oy) / g - off) + off) * g;
  return [sx, sy];
}

// Beamer footprint on the map: the player screen, scaled to 1 inch per cell, rotated for the table.
function beamerFrame() {
  if (!scene || !settings) return null;
  const screen = settings.player_screen || DEFAULT_SCREEN;
  const scale = (settings.ppi / scene.grid_size) * scene.view_zoom;
  const rot = (-settings.rotation * Math.PI) / 180;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const hw = screen.w / 2 / scale;
  const hh = screen.h / 2 / scale;
  const toMapPt = ([x, y]) => [scene.view_x + x * cos - y * sin, scene.view_y + x * sin + y * cos];
  const pts = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(toMapPt);
  // Part of the beamer image covered by the tracker strip along its left edge.
  let strip = null;
  if (settings.tracker_strip && trackerState.display_url) {
    const sw = Math.min(settings.tracker_strip_px / scale, hw * 2);
    strip = [[-hw, -hh], [-hw + sw, -hh], [-hw + sw, hh], [-hw, hh]].map(toMapPt);
  }
  return { pts, strip, hw, hh, cos, sin };
}

function insideFrame(p) {
  const f = beamerFrame();
  if (!f) return false;
  const dx = p[0] - scene.view_x;
  const dy = p[1] - scene.view_y;
  // Undo the frame rotation.
  const x = dx * f.cos + dy * f.sin;
  const y = -dx * f.sin + dy * f.cos;
  return Math.abs(x) <= f.hw && Math.abs(y) <= f.hh;
}

function tokenAt(p) {
  if (!scene) return null;
  for (let i = scene.tokens.length - 1; i >= 0; i--) {
    const t = scene.tokens[i];
    if (Math.hypot(p[0] - t.x, p[1] - t.y) <= (t.size * scene.grid_size) / 2) return t;
  }
  return null;
}

// ---------- rendering ----------

function trackerStatus(t) {
  if (t.combatant_id == null) return {};
  const c = trackerState.combatants.find((c) => c.id === t.combatant_id);
  if (!c) return {};
  return { current: c.id === trackerState.current_combatant_id, dead: c.current_hp <= 0, hidden: !!c.is_hidden, c };
}

function render() {
  const w = canvas.width;
  const h = canvas.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (!scene || !scene.map_url) return;

  const s = cam.scale * devicePixelRatio;
  ctx.translate(w / 2, h / 2);
  ctx.scale(s, s);
  ctx.translate(-cam.x, -cam.y);
  const px = 1 / s; // one screen pixel in map units

  drawMap(ctx, scene, () => (dirty = true));
  drawGrid(ctx, scene, px, scene.show_grid ? "rgba(255,255,255,0.45)" : "rgba(255,255,255,0.18)");

  for (const t of scene.tokens) {
    if (t.vision) continue;
    const st = trackerStatus(t);
    drawToken(ctx, t, scene.grid_size, {
      current: st.current, dead: st.dead, selected: t.id === selectedTokenId,
      ghost: !t.on_player || st.hidden, label: t.name, pxPerUnit: s, onLoad: () => (dirty = true),
    });
  }

  if (sightActive()) sightDim.draw(ctx, scene, 0.25);
  if (scene.fog_enabled) fog.draw(ctx, scene, 0.5);
  if (wallsVisible()) drawWalls(px);
  for (const t of scene.tokens) if (t.vision) drawViewer(t, px);
  // Spell areas above the fog, so the DM can always grab them; faint when kept off the beamer.
  for (const t of scene.templates) {
    ctx.save();
    if (t.on_player === false) ctx.globalAlpha = 0.45;
    drawTemplate(ctx, t, scene.grid_size, px);
    ctx.restore();
  }
  // Spell names, so lasting effects (Fog Cloud, Spike Growth) stay identifiable.
  for (const t of scene.templates) {
    if (t.label && t.id !== selectedTemplateId) label(t.label, ...templateLabelPoint(t), px, "#ff6b6b");
  }
  drawTurnNumbers();

  // Areas with their Stream Deck numbers.
  scene.areas.forEach((a, i) => {
    ctx.beginPath();
    a.points.forEach(([x, y], j) => (j ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.lineWidth = 2 * px;
    ctx.setLineDash([6 * px, 4 * px]);
    ctx.strokeStyle = "#8e44ad";
    ctx.stroke();
    ctx.setLineDash([]);
    const cx = a.points.reduce((sum, p) => sum + p[0], 0) / a.points.length;
    const cy = a.points.reduce((sum, p) => sum + p[1], 0) / a.points.length;
    label(`${i + 1}`, cx, cy, px, "#8e44ad");
  });

  // Beamer frame with an arrow towards the top of the beamer image.
  const f = beamerFrame();
  if (f && f.strip) {
    ctx.beginPath();
    f.strip.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.fillStyle = "rgba(18,14,10,0.6)";
    ctx.fill();
    const cx = f.strip.reduce((sum, p) => sum + p[0], 0) / 4;
    const cy = f.strip.reduce((sum, p) => sum + p[1], 0) / 4;
    label("Tracker", cx, cy, px, "#a8977a");
  }
  if (f) {
    ctx.beginPath();
    f.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.lineWidth = 3 * px;
    ctx.strokeStyle = settings.active_scene_id === scene.id ? "#e8c15a" : "rgba(232,193,90,0.35)";
    ctx.stroke();
    const mx = (f.pts[0][0] + f.pts[1][0]) / 2;
    const my = (f.pts[0][1] + f.pts[1][1]) / 2;
    label("Beamer ▲", mx, my, px, ctx.strokeStyle);
  }

  drawGesturePreview(px);
}

// ---------- walls and sight ----------

const WALL_TOOLS = ["wall", "door", "wall-erase", "viewer"];

function sightActive() {
  return !!(scene && scene.vision_enabled && scene.vision_polys.length);
}

function wallsVisible() {
  return showWalls || WALL_TOOLS.includes(tool);
}

function drawWalls(px) {
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineWidth = 3 * px;
  ctx.strokeStyle = "#e67e22";
  ctx.beginPath();
  for (const w of scene.walls) {
    if (w.kind !== "wall") continue;
    ctx.moveTo(w.a[0], w.a[1]);
    ctx.lineTo(w.b[0], w.b[1]);
  }
  ctx.stroke();
  for (const w of scene.walls) {
    if (w.kind !== "door") continue;
    ctx.beginPath();
    ctx.moveTo(w.a[0], w.a[1]);
    ctx.lineTo(w.b[0], w.b[1]);
    ctx.lineWidth = 5 * px;
    ctx.setLineDash(w.open ? [6 * px, 6 * px] : []);
    ctx.strokeStyle = w.open ? "#27ae60" : "#3498db";
    ctx.stroke();
    ctx.setLineDash([]);
    // Handle in the middle: click it with the select tool to open or close.
    const [mx, my] = doorCenter(w);
    ctx.fillStyle = w.open ? "#27ae60" : "#3498db";
    ctx.fillRect(mx - 6 * px, my - 6 * px, 12 * px, 12 * px);
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1.5 * px;
    ctx.strokeRect(mx - 6 * px, my - 6 * px, 12 * px, 12 * px);
  }
  ctx.restore();
}

function drawViewer(t, px) {
  const r = Math.max(scene.grid_size * 0.4, 14 * px);
  ctx.save();
  ctx.beginPath();
  ctx.arc(t.x, t.y, r, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(142,68,173,0.85)";
  ctx.fill();
  ctx.lineWidth = (t.id === selectedTokenId ? 3 : 1.5) * px;
  ctx.strokeStyle = "#fff";
  ctx.stroke();
  ctx.font = `${r * 1.1}px "Segoe UI Emoji", system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("👁", t.x, t.y + r * 0.05);
  ctx.restore();
}

const doorCenter = (w) => [(w.a[0] + w.b[0]) / 2, (w.a[1] + w.b[1]) / 2];

function doorAt(p) {
  const tol = 10 / cam.scale;
  return scene.walls.find((w) => w.kind === "door" && Math.hypot(p[0] - doorCenter(w)[0], p[1] - doorCenter(w)[1]) <= tol);
}

function wallAt(p) {
  const tol = 8 / cam.scale;
  let best = null;
  let bestDist = tol;
  for (const w of scene.walls) {
    const [ax, ay] = w.a;
    const dx = w.b[0] - ax;
    const dy = w.b[1] - ay;
    const len2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / len2));
    const d = Math.hypot(p[0] - (ax + t * dx), p[1] - (ay + t * dy));
    if (d < bestDist) { best = w; bestDist = d; }
  }
  return best;
}

// Snap to an existing wall end (or the start of the line being drawn) so rooms close cleanly.
function snapWallPoint(p) {
  const tol = 10 / cam.scale;
  const candidates = scene.walls.flatMap((w) => [w.a, w.b]);
  if (poly && poly.points.length) candidates.push(poly.points[0]);
  let best = p;
  let bestDist = tol;
  for (const c of candidates) {
    const d = Math.hypot(p[0] - c[0], p[1] - c[1]);
    if (d < bestDist) { best = [c[0], c[1]]; bestDist = d; }
  }
  return best;
}

function viewerAt(p) {
  const r = Math.max(scene.grid_size * 0.4, 14 / cam.scale);
  return scene.tokens.find((t) => t.vision && Math.hypot(p[0] - t.x, p[1] - t.y) <= r);
}

function label(text, x, y, px, color) {
  ctx.save();
  ctx.font = `bold ${13 * px}px "Segoe UI", system-ui, sans-serif`;
  const w = ctx.measureText(text).width + 10 * px;
  ctx.fillStyle = "rgba(0,0,0,0.7)";
  ctx.fillRect(x - w / 2, y - 10 * px, w, 20 * px);
  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x, y);
  ctx.restore();
}

// DM view only: each linked token's place in the tracker's turn order, as listed in the
// Tracker panel. Drawn above the fog and sized to the map grid, so it zooms with the tokens.
const TURN_BADGE_CELLS = 0.22; // badge diameter, a bit under a quarter of a grid cell

function drawTurnNumbers() {
  const order = new Map(trackerState.combatants.map((c, i) => [c.id, i + 1]));
  const br = (TURN_BADGE_CELLS * scene.grid_size) / 2;
  for (const t of scene.tokens) {
    const n = t.vision ? undefined : order.get(t.combatant_id);
    if (n === undefined) continue;
    const r = (t.size * scene.grid_size) / 2;
    const x = t.x + r * 0.71;
    const y = t.y - r * 0.71;
    const current = t.combatant_id === trackerState.current_combatant_id;
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, br, 0, Math.PI * 2);
    ctx.fillStyle = current ? "#e8c15a" : "rgba(28,23,18,0.9)";
    ctx.fill();
    ctx.lineWidth = br * 0.15;
    ctx.strokeStyle = current ? "#1c1712" : "#e8c15a";
    ctx.stroke();
    ctx.fillStyle = current ? "#1c1712" : "#fff";
    ctx.font = `bold ${br * (n > 9 ? 1.0 : 1.2)}px "Segoe UI", system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(n), x, y + br * 0.05);
    ctx.restore();
  }
}

function drawGesturePreview(px) {
  ctx.save();
  ctx.lineWidth = 2 * px;
  if (gesture && (gesture.kind === "rect" || gesture.kind === "measure")) {
    const [a, b] = [gesture.start, gesture.end];
    ctx.strokeStyle = gesture.kind === "measure" ? "#5dade2" : gesture.mode === "reveal" ? "#27ae60" : "#c0392b";
    ctx.setLineDash([6 * px, 4 * px]);
    ctx.strokeRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
  }
  if (gesture && gesture.kind === "brush") {
    ctx.strokeStyle = gesture.mode === "reveal" ? "rgba(39,174,96,0.5)" : "rgba(192,57,43,0.5)";
    ctx.lineWidth = gesture.radius * 2;
    ctx.lineCap = ctx.lineJoin = "round";
    ctx.beginPath();
    gesture.points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.stroke();
  }
  if (poly && poly.points.length) {
    ctx.strokeStyle = { area: "#8e44ad", wall: "#e67e22", door: "#3498db" }[poly.mode] || "#27ae60";
    ctx.beginPath();
    poly.points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    if (hover) ctx.lineTo(hover[0], hover[1]);
    ctx.stroke();
    ctx.fillStyle = ctx.strokeStyle;
    for (const [x, y] of poly.points) ctx.fillRect(x - 3 * px, y - 3 * px, 6 * px, 6 * px);
  }
  if (hover && tool.endsWith("brush") && !gesture) {
    ctx.strokeStyle = "rgba(255,255,255,0.6)";
    ctx.beginPath();
    ctx.arc(hover[0], hover[1], brushRadius(), 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
  if (gesture && gesture.kind === "tpl-new") {
    drawTemplate(ctx, gesture.tpl, scene.grid_size, px);
    drawTemplateSelection(gesture.tpl, px);
  } else if (selectedTemplate()) {
    drawTemplateSelection(selectedTemplate(), px);
  }
}

// Dashed outline, size label and, for cones and lines, the turning handle at the far end.
function drawTemplateSelection(t, px) {
  ctx.save();
  ctx.lineWidth = 1.5 * px;
  ctx.setLineDash([6 * px, 4 * px]);
  ctx.strokeStyle = "#fff";
  ctx.stroke(templatePath(t, scene.grid_size));
  const h = templateHandle(t);
  if (h) {
    ctx.beginPath();
    ctx.moveTo(t.x, t.y);
    ctx.lineTo(h[0], h[1]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(h[0], h[1], 8 * px, 0, Math.PI * 2);
    ctx.fillStyle = "#ff2d2d";
    ctx.fill();
    ctx.lineWidth = 2 * px;
    ctx.stroke();
  }
  ctx.restore();
  label(`${t.label ? `${t.label} · ` : ""}${t.size} ft · ${feetToMeters(t.size)} m`, ...templateLabelPoint(t), px, "#ff6b6b");
}

// Halfway along a cone or line, the centre of anything else.
function templateLabelPoint(t) {
  if (!turns(t)) return [t.x, t.y];
  const len = feetToPx(t.size, scene.grid_size) / 2;
  return [t.x + Math.cos(t.angle) * len, t.y + Math.sin(t.angle) * len];
}

function frame() {
  if (dirty) {
    dirty = false;
    render();
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---------- tools ----------

const TOOL_HINTS = {
  select: t("Ziehen: Token bewegen · im gelben Rahmen: Beamer-Ausschnitt verschieben · sonst: Karte verschieben · Mausrad: Zoom"),
  token: t("Klicken: Token setzen"),
  "reveal-rect": t("Rechteck ziehen zum Aufdecken"),
  "hide-rect": t("Rechteck ziehen zum Verdecken"),
  "reveal-brush": t("Malen zum Aufdecken"),
  "hide-brush": t("Malen zum Verdecken"),
  "reveal-poly": t("Punkte klicken, Doppelklick oder Enter schliesst, Esc bricht ab"),
  area: t("Raum umranden: Punkte klicken, Doppelklick oder Enter schliesst"),
  measure: t("Rechteck über die eingestellte Anzahl Felder ziehen, möglichst genau an den Linien"),
  viewer: t("Klicken: Sichtpunkt setzen · bestehenden Sichtpunkt ziehen zum Verschieben"),
  wall: t("Wand: Punkte klicken, Doppelklick oder Enter beendet, Esc bricht ab · rastet an Wandenden ein"),
  door: t("Tür: Anfang und Ende der Türöffnung klicken"),
  "wall-erase": t("Wand oder Tür anklicken zum Löschen"),
  "tpl-cone": t("Klicken setzt die Spitze, ziehen richtet aus · roter Griff: drehen · Shift: 15°-Schritte"),
  "tpl-circle": t("Klicken setzt den Mittelpunkt · Bereich ziehen zum Verschieben"),
  "tpl-square": t("Klicken setzt den Mittelpunkt · Bereich ziehen zum Verschieben"),
  "tpl-line": t("Klicken setzt den Anfang, ziehen richtet aus · roter Griff: drehen · Shift: 15°-Schritte"),
};

function setTool(name) {
  tool = name;
  spellLabel = null;
  poly = null;
  gesture = null;
  document.querySelectorAll("[data-tool]").forEach((b) => b.classList.toggle("active", b.dataset.tool === name));
  $("tool-hint").textContent = TOOL_HINTS[name] || "";
  renderTemplateEditor();
  dirty = true;
}
document.querySelectorAll("[data-tool]").forEach((b) => b.addEventListener("click", () => setTool(b.dataset.tool)));

function brushRadius() {
  return (Number($("brush-size").value) * (scene ? scene.grid_size : 70)) / 2;
}
$("brush-size").addEventListener("input", () => {
  const v = Number($("brush-size").value);
  $("brush-size-label").textContent = `${v} ${v === 1 ? t("Feld") : t("Felder")}`;
});

canvas.addEventListener("pointerdown", (ev) => {
  if (!scene || !scene.map_url) return;
  canvas.setPointerCapture(ev.pointerId);
  const p = toMap(ev);
  const panButton = ev.button === 1 || ev.button === 2;

  if (panButton) {
    gesture = { kind: "pan", last: [ev.clientX, ev.clientY] };
    return;
  }
  if (ev.button !== 0) return;

  // The turning handle of the selected spell area wins over whatever lies below it.
  const handle = (tool === "select" || TPL_SHAPES[tool]) && handleAt(p);
  if (handle) {
    gesture = { kind: "tpl-rotate", tpl: handle };
  } else if (tool === "select") {
    const door = wallsVisible() || scene.walls.length ? doorAt(p) : null;
    const t = tokenAt(p);
    const tpl = t ? null : templateAt(p);
    if (door && (showWalls || !t)) {
      api("POST", `api/scenes/${scene.id}/walls/${door.id}/toggle`);
    } else if (t) {
      selectToken(t.id);
      gesture = { kind: "token", token: t, offset: [t.x - p[0], t.y - p[1]] };
    } else if (tpl) {
      startTemplateMove(tpl, p);
    } else if (insideFrame(p)) {
      selectTemplate(null);
      gesture = { kind: "view", offset: [scene.view_x - p[0], scene.view_y - p[1]] };
    } else {
      selectToken(null);
      selectTemplate(null);
      gesture = { kind: "pan", last: [ev.clientX, ev.clientY] };
    }
  } else if (TPL_SHAPES[tool]) {
    const tpl = templateAt(p);
    if (tpl) {
      startTemplateMove(tpl, p);
    } else {
      const shape = TPL_SHAPES[tool];
      const t = { shape, x: p[0], y: p[1], angle: tplAngle, width: 5, on_player: true, label: spellLabel, ...tplDefaults[shape] };
      if (!ev.shiftKey) snapTemplate(t);
      selectTemplate(null);
      gesture = { kind: "tpl-new", tpl: t };
    }
  } else if (tool === "token") {
    createToken(p);
  } else if (tool === "viewer") {
    const v = viewerAt(p);
    if (v) {
      selectToken(v.id);
      gesture = { kind: "token", token: v, offset: [v.x - p[0], v.y - p[1]] };
    } else {
      const [x, y] = snapToGrid(p[0], p[1], 1);
      api("POST", `api/scenes/${scene.id}/tokens`, { name: t("Sichtpunkt"), x, y, color: "#8e44ad", vision: true });
    }
  } else if (tool === "wall" || tool === "door") {
    if (!poly) poly = { mode: tool, points: [] };
    poly.points.push(snapWallPoint(p));
    if (tool === "door" && poly.points.length === 2) closePoly();
  } else if (tool === "wall-erase") {
    const w = wallAt(p);
    if (w) api("DELETE", `api/scenes/${scene.id}/walls/${w.id}`);
  } else if (tool === "reveal-rect" || tool === "hide-rect") {
    gesture = { kind: "rect", mode: tool.startsWith("reveal") ? "reveal" : "hide", start: p, end: p };
  } else if (tool === "measure") {
    gesture = { kind: "measure", start: p, end: p };
  } else if (tool === "reveal-brush" || tool === "hide-brush") {
    gesture = { kind: "brush", mode: tool.startsWith("reveal") ? "reveal" : "hide", radius: brushRadius(), points: [p] };
  } else if (tool === "reveal-poly" || tool === "area") {
    if (!poly) poly = { mode: tool === "area" ? "area" : "reveal", points: [] };
    poly.points.push(p);
  }
  dirty = true;
});

canvas.addEventListener("pointermove", (ev) => {
  const p = toMap(ev);
  hover = p;
  if (tool.endsWith("brush") || poly) dirty = true;
  if (!gesture) return;
  if (gesture.kind === "pan") {
    cam.x -= (ev.clientX - gesture.last[0]) / cam.scale;
    cam.y -= (ev.clientY - gesture.last[1]) / cam.scale;
    gesture.last = [ev.clientX, ev.clientY];
  } else if (gesture.kind === "token") {
    gesture.token.x = p[0] + gesture.offset[0];
    gesture.token.y = p[1] + gesture.offset[1];
    gesture.moved = true;
  } else if (gesture.kind === "view") {
    scene.view_x = Math.min(Math.max(p[0] + gesture.offset[0], 0), scene.map_w);
    scene.view_y = Math.min(Math.max(p[1] + gesture.offset[1], 0), scene.map_h);
    gesture.moved = true;
  } else if (gesture.kind === "rect" || gesture.kind === "measure") {
    gesture.end = p;
  } else if (gesture.kind === "tpl-new") {
    const t = gesture.tpl;
    // Cones and lines are aimed from where they were set; circles and squares follow the pointer.
    if (turns(t)) {
      if (Math.hypot(p[0] - t.x, p[1] - t.y) > 4 / cam.scale) aimTemplate(t, p, ev.shiftKey);
    } else {
      [t.x, t.y] = p;
      if (!ev.shiftKey) snapTemplate(t);
    }
  } else if (gesture.kind === "tpl-move") {
    const t = gesture.tpl;
    t.x = p[0] + gesture.offset[0];
    t.y = p[1] + gesture.offset[1];
    if (!ev.shiftKey) snapTemplate(t);
    gesture.moved = true;
  } else if (gesture.kind === "tpl-rotate") {
    aimTemplate(gesture.tpl, p, ev.shiftKey);
    gesture.moved = true;
  } else if (gesture.kind === "brush") {
    const last = gesture.points[gesture.points.length - 1];
    // Thin out points; a quarter brush radius is plenty for a smooth stroke.
    if (Math.hypot(p[0] - last[0], p[1] - last[1]) > gesture.radius / 4) gesture.points.push(p);
  }
  dirty = true;
});

canvas.addEventListener("pointerup", async (ev) => {
  const g = gesture;
  gesture = null;
  dirty = true;
  if (!g || !scene) return;
  if (g.kind === "token" && g.moved) {
    const t = g.token;
    if (!ev.shiftKey) [t.x, t.y] = snapToGrid(t.x, t.y, t.size);
    await api("PATCH", `api/tokens/${t.id}`, { x: t.x, y: t.y });
  } else if (g.kind === "view" && g.moved) {
    await api("PATCH", `api/scenes/${scene.id}`, { view_x: scene.view_x, view_y: scene.view_y });
  } else if (g.kind === "rect") {
    if (Math.abs(g.end[0] - g.start[0]) < 2 || Math.abs(g.end[1] - g.start[1]) < 2) return;
    await addFog({ mode: g.mode, shape: "rect", points: [g.start, g.end] });
  } else if (g.kind === "brush") {
    await addFog({ mode: g.mode, shape: "brush", points: g.points.map(roundPt), radius: g.radius });
  } else if (g.kind === "measure") {
    applyMeasure(g.start, g.end);
  } else if (g.kind === "tpl-new") {
    const t = roundTemplate(g.tpl);
    if (turns(t)) tplAngle = t.angle;
    // Keep it on screen until the server's scene update arrives.
    scene.templates.push(t);
    const created = await api("POST", `api/scenes/${scene.id}/templates`, t);
    selectTemplate(created.id);
  } else if ((g.kind === "tpl-move" || g.kind === "tpl-rotate") && g.moved) {
    const t = roundTemplate(g.tpl);
    await api("PATCH", `api/scenes/${scene.id}/templates/${t.id}`, { x: t.x, y: t.y, angle: t.angle });
  }
});

canvas.addEventListener("dblclick", () => closePoly());
canvas.addEventListener("contextmenu", (ev) => ev.preventDefault());
canvas.addEventListener("pointerleave", () => { hover = null; dirty = true; });

canvas.addEventListener("wheel", (ev) => {
  ev.preventDefault();
  if (!scene) return;
  const before = toMap(ev);
  cam.scale *= Math.exp(-ev.deltaY * 0.0015);
  cam.scale = Math.min(Math.max(cam.scale, 0.02), 20);
  const after = toMap(ev);
  // Keep the point under the cursor fixed.
  cam.x += before[0] - after[0];
  cam.y += before[1] - after[1];
  dirty = true;
}, { passive: false });

const roundPt = ([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10];

async function addFog(op) {
  await api("POST", `api/scenes/${scene.id}/fog`, { radius: 0, ...op });
}

async function closePoly() {
  if (!poly) return;
  // The double click also landed two clicks on the same spot; drop the duplicates.
  const pts = poly.points.filter((p, i, arr) => i === 0 || Math.hypot(p[0] - arr[i - 1][0], p[1] - arr[i - 1][1]) > 1);
  const mode = poly.mode;
  poly = null;
  dirty = true;
  if (mode === "wall" || mode === "door") {
    if (pts.length < 2) return;
    const segments = pts.slice(1).map((b, i) => ({ a: roundPt(pts[i]), b: roundPt(b), kind: mode }));
    await api("POST", `api/scenes/${scene.id}/walls`, { segments });
    return;
  }
  if (pts.length < 3) return;
  if (mode === "area") {
    const name = prompt(t("Name des Bereichs:"), `Bereich ${scene.areas.length + 1}`);
    if (name === null) return;
    await api("POST", `api/scenes/${scene.id}/areas`, { name: name || `Bereich ${scene.areas.length + 1}`, points: pts.map(roundPt) });
  } else {
    await addFog({ mode: "reveal", shape: "poly", points: pts.map(roundPt) });
  }
}

async function applyMeasure(a, b) {
  const n = Math.max(1, Number($("measure-cells").value) || 1);
  const w = Math.abs(b[0] - a[0]);
  const h = Math.abs(b[1] - a[1]);
  if (w < 5 || h < 5) return;
  const size = (w + h) / 2 / n;
  const x0 = Math.min(a[0], b[0]);
  const y0 = Math.min(a[1], b[1]);
  await api("PATCH", `api/scenes/${scene.id}`, {
    grid_size: Math.round(size * 100) / 100,
    grid_ox: Math.round((x0 % size) * 100) / 100,
    grid_oy: Math.round((y0 % size) * 100) / 100,
  });
}

async function createToken(p) {
  const [x, y] = snapToGrid(p[0], p[1], 1);
  const n = scene.tokens.length + 1;
  const t = await api("POST", `api/scenes/${scene.id}/tokens`, { name: `Token ${n}`, x, y });
  selectToken(t.id);
}

document.addEventListener("keydown", (ev) => {
  if (ev.target.matches("input, select, textarea")) return;
  if (ev.key === "Escape") { poly = null; gesture = null; dirty = true; }
  else if (ev.key === "Enter") closePoly();
  else if ((ev.key === "Delete" || ev.key === "Backspace") && selectedTemplateId) $("tpl-delete").click();
  else if ((ev.key === "Delete" || ev.key === "Backspace") && selectedTokenId) $("tok-delete").click();
  else if (ev.key === "z" && (ev.ctrlKey || ev.metaKey)) $("btn-fog-undo").click();
  else if (ev.key.toLowerCase() === "b") $("btn-blackout").click();
  else if (ev.key.toLowerCase() === "n" && trackerState.encounter) $(ev.shiftKey ? "btn-turn-prev" : "btn-turn-next").click();
  else {
    const map = { v: "select", t: "token", r: "reveal-rect", p: "reveal-brush", o: "reveal-poly", a: "area", m: "measure",
      s: "viewer", w: "wall", d: "door", x: "wall-erase" };
    const name = map[ev.key.toLowerCase()];
    if (name && scene) setTool(ev.shiftKey && (name === "reveal-rect" || name === "reveal-brush") ? name.replace("reveal", "hide") : name);
  }
});

// ---------- campaign: the Kampagnenbuch's choice, the same in all three parts ----------

let currentCampaignId = null;

async function loadCampaigns() {
  let res;
  try {
    res = await api("GET", "api/campaigns");
  } catch {
    return;
  }
  currentCampaignId = res.current;
  const sel = $("campaign-select");
  sel.innerHTML = "";
  for (const c of res.campaigns) {
    const o = document.createElement("option");
    o.value = c.id;
    o.textContent = c.name || `Kampagne ${c.id}`;
    sel.append(o);
  }
  sel.value = res.current ?? "";
}

$("campaign-select").addEventListener("change", async (ev) => {
  // The scene list follows over the WebSocket; the open scene stays until another one is chosen.
  await api("PUT", "api/campaign", { campaign_id: Number(ev.target.value) });
  currentCampaignId = Number(ev.target.value);
});

// ---------- scenes panel ----------

function renderSceneList() {
  const ul = $("scene-list");
  ul.innerHTML = "";
  let unassignedHead = false;
  for (const s of scenes) {
    if (s.campaign_id == null && !unassignedHead) {
      unassignedHead = true;
      const head = document.createElement("li");
      head.className = "scene-group-head";
      head.textContent = t("Ohne Kampagne");
      head.title = t("Aus der Zeit vor der Zuordnung; erscheinen in jeder Kampagne, bis du sie einer zuordnest.");
      ul.appendChild(head);
    }
    const li = document.createElement("li");
    li.classList.toggle("selected", scene && scene.id === s.id);
    const live = settings && settings.active_scene_id === s.id;
    li.innerHTML = `<span class="name"></span>${live ? `<span class="live">${t("● Beamer")}</span>` : `<button title="${t("Auf Beamer zeigen")}">▶</button>`}<button title="${t("Umbenennen")}">✎</button><button class="danger" title="${t("Löschen")}">✕</button>`;
    li.querySelector(".name").textContent = s.name;
    li.addEventListener("click", () => openScene(s.id));
    if (s.campaign_id == null && currentCampaignId != null) {
      const assign = document.createElement("button");
      assign.textContent = "→";
      assign.title = t("Der Kampagne „{name}“ zuordnen", { name: $("campaign-select").selectedOptions[0]?.textContent || "" });
      assign.addEventListener("click", (ev) => {
        ev.stopPropagation();
        api("PATCH", `api/scenes/${s.id}`, { campaign_id: currentCampaignId });
      });
      li.querySelector(".name").after(assign);
    }
    const buttons = [...li.querySelectorAll("button")].filter((b) => b.textContent !== "→");
    if (!live) {
      const show = buttons.shift();
      show.addEventListener("click", (ev) => {
        ev.stopPropagation();
        patchSettings({ active_scene_id: s.id });
      });
    }
    const [rename, del] = buttons;
    rename.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      const name = prompt(t("Neuer Name:"), s.name);
      if (name) await api("PATCH", `api/scenes/${s.id}`, { name });
    });
    del.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      if (!confirm(t("Szene „{name}\" mit Karte, Fog und Tokens löschen?", { name: s.name }))) return;
      await api("DELETE", `api/scenes/${s.id}`);
      if (scene && scene.id === s.id) {
        scene = null;
        document.body.classList.add("no-scene");
        dirty = true;
      }
    });
    ul.appendChild(li);
  }
  $("scene-title").textContent = scene ? scene.name : t("Keine Szene gewählt");
}

function imageSize(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => { resolve([img.naturalWidth, img.naturalHeight]); URL.revokeObjectURL(img.src); };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

$("new-scene-file").addEventListener("change", async (ev) => {
  const file = ev.target.files[0];
  ev.target.value = "";
  if (!file) return;
  const name = prompt(t("Name der Szene:"), file.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " "));
  if (name === null) return;
  const [w, h] = await imageSize(file);
  const s = await api("POST", "api/scenes", { name: name || file.name });
  await api("POST", `api/scenes/${s.id}/map?filename=${encodeURIComponent(file.name)}&width=${w}&height=${h}`, file, true);
  await openScene(s.id);
  setTool("measure");
});

$("new-scene-uvtt").addEventListener("change", async (ev) => {
  const file = ev.target.files[0];
  ev.target.value = "";
  if (!file) return;
  const hint = $("tool-hint");
  hint.textContent = `Importiere ${file.name} …`;
  try {
    const res = await api("POST", `api/scenes/import-uvtt?filename=${encodeURIComponent(file.name)}`, file, true);
    await openScene(res.id);
    alert(t("Importiert: {walls} Wandstücke, {doors} Türen.\nUnter „Sicht\" einen Sichtpunkt setzen.", { walls: res.walls, doors: res.doors }));
  } finally {
    setTool(tool);
  }
});

// ---------- scene fields ----------

function renderSceneFields() {
  if (!scene) return;
  for (const [id, key] of [["grid-size", "grid_size"], ["grid-ox", "grid_ox"], ["grid-oy", "grid_oy"]]) {
    if (document.activeElement !== $(id)) $(id).value = scene[key];
  }
  $("show-grid").checked = !!scene.show_grid;
  $("fog-enabled").checked = !!scene.fog_enabled;
  $("vision-enabled").checked = !!scene.vision_enabled;
  $("show-walls").checked = showWalls;
  const doors = scene.walls.filter((w) => w.kind === "door").length;
  const viewers = scene.tokens.filter((t) => t.vision).length;
  $("wall-info").textContent = `${tn(scene.walls.length - doors, "{n} Wandstück", "{n} Wandstücke")} · ${tn(doors, "{n} Tür", "{n} Türen")} · ${tn(viewers, "{n} Sichtpunkt", "{n} Sichtpunkte")}`
    + (scene.vision_enabled && !viewers ? t(" · Sichtpunkt setzen, damit die Sicht wirkt") : "");
  $("zoom-label").textContent = `${Math.round(scene.view_zoom * 100)}%`;
}

for (const [id, key] of [["grid-size", "grid_size"], ["grid-ox", "grid_ox"], ["grid-oy", "grid_oy"]]) {
  $(id).addEventListener("change", () => {
    const v = Number($(id).value);
    if (Number.isFinite(v)) api("PATCH", `api/scenes/${scene.id}`, { [key]: v });
  });
}
$("show-grid").addEventListener("change", () => api("PATCH", `api/scenes/${scene.id}`, { show_grid: $("show-grid").checked }));
$("vision-enabled").addEventListener("change", () => api("PATCH", `api/scenes/${scene.id}`, { vision_enabled: $("vision-enabled").checked }));
$("show-walls").addEventListener("change", () => {
  showWalls = $("show-walls").checked;
  try { localStorage.setItem("battlemap.showWalls", showWalls ? "1" : "0"); } catch {}
  dirty = true;
});
$("btn-clear-walls").addEventListener("click", () => {
  if (confirm(t("Alle Wände und Türen dieser Szene löschen?"))) api("DELETE", `api/scenes/${scene.id}/walls`);
});
$("fog-enabled").addEventListener("change", () => api("PATCH", `api/scenes/${scene.id}`, { fog_enabled: $("fog-enabled").checked }));

$("btn-fog-undo").addEventListener("click", () => scene && api("POST", `api/scenes/${scene.id}/fog/undo`));
$("btn-reveal-all").addEventListener("click", () => addFog({ mode: "reveal", shape: "all", points: [] }));
$("btn-hide-all").addEventListener("click", () => {
  if (confirm(t("Ganze Karte wieder verdecken?"))) addFog({ mode: "hide", shape: "all", points: [] });
});

// ---------- areas ----------

function renderAreas() {
  const ul = $("area-list");
  ul.innerHTML = "";
  if (!scene) return;
  $("area-empty").hidden = scene.areas.length > 0;
  scene.areas.forEach((a, i) => {
    const li = document.createElement("li");
    li.innerHTML = `<span class="num">${i + 1}</span><span class="name"></span><button>${t("Aufdecken")}</button><button class="danger" title="${t("Bereich löschen")}">✕</button>`;
    li.querySelector(".name").textContent = a.name;
    const [reveal, del] = li.querySelectorAll("button");
    reveal.addEventListener("click", () => api("POST", `api/scenes/${scene.id}/areas/${a.id}/reveal`));
    del.addEventListener("click", () => {
      if (confirm(t("Bereich „{name}\" löschen? Bereits aufgedeckter Fog bleibt.", { name: a.name }))) api("DELETE", `api/scenes/${scene.id}/areas/${a.id}`);
    });
    li.addEventListener("click", (ev) => {
      if (ev.target.tagName === "BUTTON") return;
      const xs = a.points.map((p) => p[0]);
      const ys = a.points.map((p) => p[1]);
      cam.x = (Math.min(...xs) + Math.max(...xs)) / 2;
      cam.y = (Math.min(...ys) + Math.max(...ys)) / 2;
      dirty = true;
    });
    ul.appendChild(li);
  });
}

// ---------- spell areas ----------

const TPL_SHAPES = { "tpl-cone": "cone", "tpl-circle": "circle", "tpl-square": "square", "tpl-line": "line" };
const TPL_NAMES = { cone: t("Viertelkreis"), circle: t("Kreis"), square: t("Quadrat"), line: t("Linie") };
const TPL_SIZE_LABELS = { cone: t("Länge"), circle: t("Radius"), square: t("Seite"), line: t("Länge") };
// Sizes in feet for the next new area of each shape; edited in the panel while nothing is selected.
const tplDefaults = { cone: { size: 15 }, circle: { size: 20 }, square: { size: 10 }, line: { size: 30, width: 5 } };
// New cones and lines point where the last one was aimed.
let tplAngle = 0;
// Name of the spell picked in the search; new areas carry it until another tool is chosen.
let spellLabel = null;
let selectedTemplateId = null;
const hitCtx = document.createElement("canvas").getContext("2d");

// German rule books count 1.5 m per 5 ft square.
const feetToMeters = (feet) => String(Math.round(feet * 3) / 10).replace(".", ",");
const turns = (t) => t.shape === "cone" || t.shape === "line";

function selectedTemplate() {
  return scene && scene.templates.find((t) => t.id === selectedTemplateId);
}

function selectTemplate(id) {
  selectedTemplateId = id;
  if (id && selectedTokenId) {
    selectedTokenId = null;
    renderTokens();
  }
  renderTemplateEditor();
  dirty = true;
}

// Far end of a cone or line, where it is grabbed to turn around its tip or start.
function templateHandle(t) {
  if (!turns(t)) return null;
  const len = feetToPx(t.size, scene.grid_size);
  return [t.x + Math.cos(t.angle) * len, t.y + Math.sin(t.angle) * len];
}

function handleAt(p) {
  const t = selectedTemplate();
  const h = t && templateHandle(t);
  return h && Math.hypot(p[0] - h[0], p[1] - h[1]) <= 12 / cam.scale ? t : null;
}

function templateAt(p) {
  for (let i = scene.templates.length - 1; i >= 0; i--) {
    const t = scene.templates[i];
    if (hitCtx.isPointInPath(templatePath(t, scene.grid_size), p[0], p[1])) return t;
  }
  return null;
}

function startTemplateMove(t, p) {
  selectTemplate(t.id);
  gesture = { kind: "tpl-move", tpl: t, offset: [t.x - p[0], t.y - p[1]] };
}

// Spell areas snap to a half-cell lattice: cell corners, edge midpoints and cell centres.
function snapTemplate(t) {
  const h = scene.grid_size / 2;
  t.x = scene.grid_ox + Math.round((t.x - scene.grid_ox) / h) * h;
  t.y = scene.grid_oy + Math.round((t.y - scene.grid_oy) / h) * h;
}

function aimTemplate(t, p, steps) {
  let a = Math.atan2(p[1] - t.y, p[0] - t.x);
  if (steps) a = Math.round(a / (Math.PI / 12)) * (Math.PI / 12);
  t.angle = a;
}

function roundTemplate(t) {
  const [x, y] = roundPt([t.x, t.y]);
  return { ...t, x, y, angle: Math.round(t.angle * 10000) / 10000 };
}

function renderTemplateEditor() {
  const tpl = selectedTemplate();
  const shape = tpl ? tpl.shape : TPL_SHAPES[tool] || "cone";
  const values = tpl || tplDefaults[shape];
  $("tpl-size-label").textContent = TPL_SIZE_LABELS[shape];
  if (document.activeElement !== $("tpl-size")) $("tpl-size").value = values.size;
  if (document.activeElement !== $("tpl-width")) $("tpl-width").value = values.width || 5;
  // A label in a .row is display:flex, which would override the hidden attribute.
  $("tpl-width-wrap").style.display = shape === "line" ? "" : "none";
  const cells = Math.round((values.size / 5) * 10) / 10;
  const name = tpl ? tpl.label : spellLabel;
  $("tpl-info").textContent = `${tpl ? t("Ausgewählt") : spellLabel ? t("Bereit, auf die Karte klicken") : t("Neu")}: `
    + `${name ? `${name}, ` : ""}${TPL_NAMES[shape]}, ${TPL_SIZE_LABELS[shape]} `
    + `${feetToMeters(values.size)} m = ${String(cells).replace(".", ",")} ${cells === 1 ? t("Feld") : t("Felder")}`;
  $("tpl-editor").hidden = !tpl;
  if (tpl) $("tpl-on-player").checked = tpl.on_player !== false;
}

function changeTemplateSize(key) {
  const v = Number($(`tpl-${key}`).value);
  const t = selectedTemplate();
  if (v > 0 && v <= 1000) {
    if (t) {
      api("PATCH", `api/scenes/${scene.id}/templates/${t.id}`, { [key]: v });
    } else {
      tplDefaults[TPL_SHAPES[tool] || "cone"][key] = v;
    }
  }
  renderTemplateEditor();
}
$("tpl-size").addEventListener("change", () => changeTemplateSize("size"));
$("tpl-width").addEventListener("change", () => changeTemplateSize("width"));
$("tpl-on-player").addEventListener("change", () => {
  const t = selectedTemplate();
  if (t) api("PATCH", `api/scenes/${scene.id}/templates/${t.id}`, { on_player: $("tpl-on-player").checked });
});
$("tpl-delete").addEventListener("click", () => {
  const t = selectedTemplate();
  if (!t) return;
  selectTemplate(null);
  api("DELETE", `api/scenes/${scene.id}/templates/${t.id}`);
});
// Spell search in the combat tracker's library; picking a spell readies its area for placing.
let spellQuery = 0;
let spellTimer;

async function searchSpells() {
  const q = $("spell-search").value.trim();
  const ul = $("spell-results");
  const query = ++spellQuery;
  if (q.length < 2) {
    ul.innerHTML = "";
    return;
  }
  let results;
  try {
    const resp = await fetch(`api/spells?q=${encodeURIComponent(q)}`);
    const body = await resp.json();
    if (!resp.ok) throw new Error(body.detail);
    results = body;
  } catch (err) {
    if (query === spellQuery) ul.innerHTML = `<li class="no-area muted small">${t("Zauber-Bibliothek nicht erreichbar: {error}", { error: err.message })}</li>`;
    return;
  }
  // An older, slower search must not overwrite the answer to what is typed now.
  if (query !== spellQuery) return;
  ul.innerHTML = results.length ? "" : `<li class="no-area muted small">${t("Kein Zauber gefunden.")}</li>`;
  for (const s of results) {
    const li = document.createElement("li");
    li.innerHTML = '<span class="name"></span><span class="muted small"></span>';
    li.querySelector(".name").textContent = s.name;
    const a = s.area;
    const level = s.level === 0 ? t("Zaubertrick") : s.level != null ? `Grad ${s.level}` : "";
    const area = a
      ? `${TPL_NAMES[a.shape]}, ${TPL_SIZE_LABELS[a.shape]} ${a.size} ft${a.shape === "line" ? ` × ${a.width} ft` : ""} · ${feetToMeters(a.size)} m`
      : t("keine Fläche im Text");
    li.querySelector(".small").textContent = [level, area].filter(Boolean).join(" · ");
    li.title = a ? t("Aus dem Text: „{text}\"", { text: a.text }) : t("Die Beschreibung nennt keine Fläche.");
    li.classList.toggle("no-area", !a);
    if (a) li.addEventListener("click", () => pickSpell(s));
    ul.appendChild(li);
  }
}

function pickSpell(s) {
  const a = s.area;
  tplDefaults[a.shape] = a.shape === "line" ? { size: a.size, width: a.width } : { size: a.size };
  selectTemplate(null);
  setTool(`tpl-${a.shape}`);
  spellLabel = s.name;
  renderTemplateEditor();
  $("spell-results").querySelectorAll("li").forEach((li) => li.classList.toggle("selected", li.querySelector(".name")?.textContent === s.name));
}

$("spell-search").addEventListener("input", () => {
  clearTimeout(spellTimer);
  spellTimer = setTimeout(searchSpells, 250);
});
$("spell-search").addEventListener("keydown", (ev) => {
  // Enter takes the first spell with an area.
  if (ev.key === "Enter") $("spell-results").querySelector("li:not(.no-area)")?.click();
});

$("btn-tpl-clear").addEventListener("click", () => {
  if (scene && scene.templates.length && confirm(t("Alle Zauberbereiche dieser Szene entfernen?"))) {
    selectTemplate(null);
    api("DELETE", `api/scenes/${scene.id}/templates`);
  }
});

// ---------- tokens ----------

function selectToken(id) {
  selectedTokenId = id;
  if (id && selectedTemplateId) {
    selectedTemplateId = null;
    renderTemplateEditor();
  }
  renderTokens();
  dirty = true;
}

function renderTokens() {
  const ul = $("token-list");
  ul.innerHTML = "";
  if (!scene) return;
  for (const tok of scene.tokens) {
    const st = trackerStatus(tok);
    const li = document.createElement("li");
    li.classList.toggle("selected", tok.id === selectedTokenId);
    li.classList.toggle("current", !!st.current);
    li.classList.toggle("dead", !!st.dead);
    li.innerHTML = `<span class="dot"></span><span class="name"></span><span class="muted small"></span>`;
    li.querySelector(".dot").style.background = tok.color;
    li.querySelector(".name").textContent = tok.name;
    li.querySelector(".small").textContent = tok.vision ? t("nur DM") : !tok.on_player ? t("Miniatur") : st.hidden ? t("versteckt") : "";
    li.addEventListener("click", () => {
      selectToken(tok.id);
      cam.x = tok.x;
      cam.y = tok.y;
    });
    ul.appendChild(li);
  }
  renderTokenEditor();
}

function selectedToken() {
  return scene && scene.tokens.find((t) => t.id === selectedTokenId);
}

function renderTokenEditor() {
  const tok = selectedToken();
  $("token-editor").hidden = !tok;
  if (!tok) return;
  if (document.activeElement !== $("tok-name")) $("tok-name").value = tok.name;
  $("tok-size").value = String(tok.size);
  $("tok-color").value = tok.color;
  $("tok-on-player").checked = !!tok.on_player;
  const sel = $("tok-combatant");
  sel.innerHTML = `<option value="">${t("– nicht verknüpft –")}</option>`;
  const options = [...trackerState.combatants];
  // Keep a stale link visible even when that encounter is no longer on the tracker display.
  if (tok.combatant_id != null && !options.some((c) => c.id === tok.combatant_id)) {
    options.push({ id: tok.combatant_id, name: `#${tok.combatant_id} ${t("(anderer Encounter)")}` });
  }
  for (const c of options) {
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = c.name;
    sel.appendChild(opt);
  }
  sel.value = tok.combatant_id == null ? "" : String(tok.combatant_id);
}

function patchToken(fields) {
  const t = selectedToken();
  if (t) api("PATCH", `api/tokens/${t.id}`, fields);
}

$("tok-name").addEventListener("change", () => patchToken({ name: $("tok-name").value }));
$("tok-size").addEventListener("change", () => {
  const t = selectedToken();
  const size = Number($("tok-size").value);
  const [x, y] = snapToGrid(t.x, t.y, size);
  patchToken({ size, x, y });
});
$("tok-color").addEventListener("change", () => patchToken({ color: $("tok-color").value }));
$("tok-on-player").addEventListener("change", () => patchToken({ on_player: $("tok-on-player").checked }));
$("tok-combatant").addEventListener("change", () => {
  const id = $("tok-combatant").value;
  const c = trackerState.combatants.find((c) => String(c.id) === id);
  const fields = { combatant_id: id ? Number(id) : null };
  const t = selectedToken();
  // Take over name and portrait from the tracker if the token has none of its own yet.
  if (c && /^Token \d+$/.test(t.name)) fields.name = c.name;
  if (c && c.avatar && !t.image) fields.image = c.avatar;
  patchToken(fields);
});
$("tok-image").addEventListener("change", async (ev) => {
  const file = ev.target.files[0];
  ev.target.value = "";
  if (!file) return;
  const res = await api("POST", `api/token-images?filename=${encodeURIComponent(file.name)}`, file, true);
  patchToken({ image: res.url });
});
$("tok-image-clear").addEventListener("click", () => patchToken({ image: null }));
$("tok-delete").addEventListener("click", async () => {
  const t = selectedToken();
  if (!t) return;
  selectedTokenId = null;
  await api("DELETE", `api/tokens/${t.id}`);
});
$("btn-tokens-from-tracker").addEventListener("click", async () => {
  const res = await api("POST", `api/scenes/${scene.id}/tokens/from-tracker`);
  if (res.added === 0) alert(t("Alle Kämpfer des Tracker-Encounters haben schon einen Token."));
});
$("btn-tokens-clear").addEventListener("click", async () => {
  if (!scene || !confirm(t("Alle Tokens dieser Szene entfernen? Sichtpunkte bleiben."))) return;
  selectedTokenId = null;
  await api("DELETE", `api/scenes/${scene.id}/tokens`);
});

// ---------- beamer and table setup ----------

function renderSettings() {
  if (!settings) return;
  const live = scene && settings.active_scene_id === scene.id;
  $("btn-show-scene").textContent = live ? t("✓ Läuft auf dem Beamer") : t("Diese Szene auf Beamer zeigen");
  $("btn-show-scene").classList.toggle("primary", !live);
  const active = scenes.find((s) => s.id === settings.active_scene_id);
  $("beamer-scene").textContent = live ? "" : t("Auf dem Beamer: {name}", { name: active ? active.name : t("nichts") });
  $("btn-blackout").classList.toggle("on", settings.blackout);
  $("btn-calibrate").classList.toggle("on", settings.calibrate);
  $("rot-label").textContent = `${settings.rotation}°`;
  if (document.activeElement !== $("ppi")) $("ppi").value = settings.ppi;
  $("strip-enabled").checked = settings.tracker_strip;
  if (document.activeElement !== $("strip-px")) $("strip-px").value = settings.tracker_strip_px;
  $("strip-info").textContent = trackerState.display_url
    ? `Quelle: ${trackerState.display_url}`
    : t("TRACKER_DISPLAY_URL ist nicht gesetzt.");
  $("handout-enabled").checked = settings.handout_overlay;
  renderSceneList();
  renderBeamerImages();
  dirty = true;
}

const patchSettings = (fields) => api("PATCH", "api/settings", fields);

// ---------- beamer image instead of battlemap ----------

function renderBeamerImages() {
  if (!settings) return;
  $("btn-show-battlemap").hidden = settings.active_beamer_image_id == null;
  const ul = $("beamer-image-list");
  ul.innerHTML = "";
  for (const img of beamerImages) {
    const active = settings.active_beamer_image_id === img.id;
    const li = document.createElement("li");
    li.classList.toggle("selected", active);
    li.innerHTML = `<img class="thumb" src="${img.url}" alt="" />` +
      `<span class="name"></span>${active ? `<span class="live">${t("● Beamer")}</span>` : `<button title="${t("Auf Beamer zeigen")}">▶</button>`}` +
      `<button title="${t("Umbenennen")}">✎</button><button class="danger" title="${t("Löschen")}">✕</button>`;
    li.querySelector(".name").textContent = img.name;
    const buttons = [...li.querySelectorAll("button")];
    if (!active) {
      const show = buttons.shift();
      show.addEventListener("click", () => patchSettings({ active_beamer_image_id: img.id }));
    }
    const [rename, del] = buttons;
    rename.addEventListener("click", async () => {
      const name = prompt(t("Neuer Name:"), img.name);
      if (name) await api("PATCH", `api/beamer-images/${img.id}`, { name });
    });
    del.addEventListener("click", async () => {
      if (!confirm(t("Bild „{name}\" löschen?", { name: img.name }))) return;
      await api("DELETE", `api/beamer-images/${img.id}`);
    });
    ul.appendChild(li);
  }
}

$("btn-show-battlemap").addEventListener("click", () => patchSettings({ active_beamer_image_id: null }));

$("new-beamer-images").addEventListener("change", async (ev) => {
  const files = [...ev.target.files];
  ev.target.value = "";
  for (const file of files) {
    const name = file.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ");
    await api("POST", `api/beamer-images?filename=${encodeURIComponent(file.name)}&name=${encodeURIComponent(name)}`,
      file, true);
  }
});

$("btn-show-scene").addEventListener("click", () => scene && patchSettings({ active_scene_id: scene.id }));
$("btn-blackout").addEventListener("click", () => patchSettings({ blackout: !settings.blackout }));
$("btn-calibrate").addEventListener("click", () => patchSettings({ calibrate: !settings.calibrate }));
$("btn-reset-keystone").addEventListener("click", () => patchSettings({ reset_keystone: true }));
$("rot-left").addEventListener("click", () => patchSettings({ rotation: settings.rotation - 90 }));
$("rot-right").addEventListener("click", () => patchSettings({ rotation: settings.rotation + 90 }));
$("ppi").addEventListener("change", () => {
  const v = Number($("ppi").value);
  if (v >= 5) patchSettings({ ppi: v });
});
$("strip-enabled").addEventListener("change", () => patchSettings({ tracker_strip: $("strip-enabled").checked }));
$("handout-enabled").addEventListener("change", () => patchSettings({ handout_overlay: $("handout-enabled").checked }));
$("strip-px").addEventListener("change", () => {
  const v = Math.round(Number($("strip-px").value));
  if (v >= 60 && v <= 600) patchSettings({ tracker_strip_px: v });
});
$("ppi-down").addEventListener("click", () => patchSettings({ ppi: Math.round((settings.ppi - 0.5) * 10) / 10 }));
$("ppi-up").addEventListener("click", () => patchSettings({ ppi: Math.round((settings.ppi + 0.5) * 10) / 10 }));

const setZoom = (z) => api("PATCH", `api/scenes/${scene.id}`, { view_zoom: Math.round(z * 1000) / 1000 });
$("zoom-in").addEventListener("click", () => setZoom(scene.view_zoom * 1.25));
$("zoom-out").addEventListener("click", () => setZoom(scene.view_zoom * 0.8));
$("zoom-reset").addEventListener("click", () => setZoom(1));
$("btn-center-view").addEventListener("click", () => api("PATCH", `api/scenes/${scene.id}`, { view_x: cam.x, view_y: cam.y }));

// ---------- tracker ----------

function renderTracker() {
  const badge = $("tracker-badge");
  const tr = trackerState;
  badge.className = `badge ${tr.configured ? (tr.ok ? "ok" : "err") : ""}`;
  badge.textContent = !tr.configured ? t("Tracker: aus") : !tr.ok ? t("Tracker: nicht erreichbar") : tr.encounter ? `⚔ ${tr.encounter} · ${t("Runde {n}", { n: tr.round })}` : t("Tracker: kein Encounter");
  $("tracker-info").textContent = !tr.configured
    ? t("TRACKER_URL ist nicht gesetzt.")
    : !tr.ok ? t("Der Combat Tracker antwortet nicht.") : tr.encounter ? tr.encounter : t("Im Tracker einen Encounter in die Anzeige übernehmen.");
  $("tracker-round").textContent = tr.encounter ? `Runde ${tr.round}` : "";
  $("tracker-controls").hidden = !tr.encounter;
  // .row sets display:flex, which would override the hidden attribute.
  $("tracker-encounter-row").style.display = tr.configured && tr.ok ? "" : "none";
  // A switch made in the tracker itself, or an encounter created there, needs a fresh list.
  if (tr.ok && (trackerEncounters === null || tr.encounter_id !== listedEncounterId)) loadTrackerEncounters();
  renderEncounterSelect();
  renderCombatants();
}

// Campaigns with their encounters, as the tracker lists them; null until loaded.
let trackerEncounters = null;
let listedEncounterId = null;
let encountersLoading = false;

async function loadTrackerEncounters() {
  if (encountersLoading) return;
  encountersLoading = true;
  listedEncounterId = trackerState.encounter_id;
  try {
    const resp = await fetch("api/tracker/encounters", { cache: "no-store" });
    if (resp.ok) trackerEncounters = await resp.json();
  } catch {
    // Keep the old list; the badge already says when the tracker is unreachable.
  } finally {
    encountersLoading = false;
  }
  renderEncounterSelect();
}

function renderEncounterSelect() {
  const sel = $("tracker-encounter");
  if (document.activeElement === sel) return;
  const current = trackerState.encounter_id;
  sel.innerHTML = "";
  if (current == null) sel.appendChild(new Option(t("– Encounter wählen –"), ""));
  const campaigns = (trackerEncounters || []).filter((c) => c.encounters.length);
  for (const camp of campaigns) {
    // Only group by campaign when there is more than one.
    const parent = campaigns.length > 1 ? sel.appendChild(Object.assign(document.createElement("optgroup"), { label: camp.name })) : sel;
    for (const e of camp.encounters) parent.appendChild(new Option(e.name, e.id));
  }
  if (current != null && ![...sel.options].some((o) => Number(o.value) === current)) {
    sel.prepend(new Option(trackerState.encounter || `Encounter ${current}`, current));
  }
  sel.value = current == null ? "" : String(current);
}

$("tracker-encounter").addEventListener("change", async () => {
  const sel = $("tracker-encounter");
  const id = Number(sel.value);
  sel.blur();
  if (!id || id === trackerState.encounter_id) return;
  try {
    await api("PUT", "api/tracker/encounter", { encounter_id: id });
  } catch {
    renderEncounterSelect();
  }
});
$("btn-encounters-reload").addEventListener("click", loadTrackerEncounters);
document.querySelector('button[data-panel="tracker"]').addEventListener("click", loadTrackerEncounters);

// Combatant whose editor (HP, temp HP, conditions) is unfolded.
let openCombatantId = null;
// Re-rendering would wipe what is being typed into the HP field; catch up on blur instead.
let combatantRenderPending = false;
// Turn the list last scrolled to.
let shownTurnId = null;

const conditions = () => (typeof CONDITIONS !== "undefined" ? CONDITIONS : []);
const conditionKey = (tag) => (typeof conditionFor === "function" ? conditionFor(tag)?.key : null) || tag;
const conditionName = (tag) => (typeof conditionLabel === "function" ? conditionLabel(tag) : tag);
function conditionIcon(tag) {
  if (typeof conditionIconSvg === "function") return conditionIconSvg(tag);
  const span = document.createElement("span");
  span.textContent = String(tag).charAt(0).toUpperCase();
  return span.outerHTML;
}

function patchCombatant(id, body) {
  return api("PATCH", `api/tracker/combatants/${id}`, body);
}

function renderCombatants() {
  const ul = $("tracker-list");
  if (ul.contains(document.activeElement) && document.activeElement.matches("input")) {
    combatantRenderPending = true;
    return;
  }
  combatantRenderPending = false;
  const tr = trackerState;
  ul.innerHTML = "";
  for (const c of tr.combatants) {
    const li = document.createElement("li");
    const open = c.id === openCombatantId;
    li.className = "combatant";
    li.classList.toggle("current", c.id === tr.current_combatant_id);
    li.classList.toggle("dead", c.current_hp <= 0);
    li.classList.toggle("hidden-monster", !!c.is_hidden);
    li.classList.toggle("open", open);
    const token = scene && scene.tokens.find((tok) => tok.combatant_id === c.id);
    const hpPct = c.max_hp > 0 ? Math.max(0, Math.min(100, (c.current_hp / c.max_hp) * 100)) : 0;
    li.innerHTML = `
      <div class="c-head">
        <input type="number" class="c-init" title="${t("Initiative")}" placeholder="–" />
        <span class="c-name"></span>
        <span class="c-hp"></span>
      </div>
      <div class="c-bar ${hpPct <= 25 ? "critical" : hpPct <= 50 ? "low" : ""}"><div style="width:${hpPct}%"></div></div>
      <div class="c-tags"></div>`;
    const init = li.querySelector(".c-init");
    init.value = c.initiative ?? "";
    init.addEventListener("click", (ev) => ev.stopPropagation());
    init.addEventListener("change", () => {
      const v = parseInt(init.value, 10);
      if (Number.isNaN(v)) init.value = c.initiative ?? "";
      else patchCombatant(c.id, { initiative: v });
    });
    init.addEventListener("blur", () => combatantRenderPending && setTimeout(renderCombatants));
    const noToken = scene && !token;
    li.querySelector(".c-name").textContent = `${c.is_boss ? "👑 " : ""}${c.is_hidden ? "👁‍🗨 " : ""}${c.name}${noToken ? " ·" : ""}`;
    li.querySelector(".c-name").title = noToken ? t("Kein Token auf dieser Karte") : "";
    li.querySelector(".c-hp").textContent = `${c.current_hp}/${c.max_hp}${c.temp_hp > 0 ? ` +${c.temp_hp}` : ""}${c.ac != null ? ` · RK ${c.ac}` : ""}`;

    // Active conditions as icons; click removes, like in the tracker.
    const tags = li.querySelector(".c-tags");
    for (const tag of c.status_effects) {
      const s = document.createElement("span");
      s.className = "c-tag";
      s.innerHTML = conditionIcon(tag);
      s.title = t("{name}, klicken zum Entfernen", { name: conditionName(tag) });
      s.addEventListener("click", (ev) => {
        ev.stopPropagation();
        patchCombatant(c.id, { status_effects: c.status_effects.filter((x) => x !== tag) });
      });
      tags.appendChild(s);
    }

    li.querySelector(".c-head").addEventListener("click", () => {
      openCombatantId = open ? null : c.id;
      if (!open && token) {
        selectToken(token.id);
        cam.x = token.x;
        cam.y = token.y;
        dirty = true;
      }
      renderCombatants();
    });
    if (open) li.appendChild(combatantEditor(c));
    ul.appendChild(li);
  }
  // Follow the turn, so whoever acts is always in view.
  if (tr.current_combatant_id !== shownTurnId) {
    shownTurnId = tr.current_combatant_id;
    ul.querySelector(".combatant.current")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}

function combatantEditor(c) {
  const box = document.createElement("div");
  box.className = "c-editor";
  box.innerHTML = `
    <div class="c-row">
      <span class="c-label">TP</span>
      <button data-hp="-5">−5</button><button data-hp="-1">−1</button>
      <input type="number" class="c-amount" min="0" placeholder="${t("Wert")}" title="${t("Enter = Schaden")}" />
      <button data-hp="1">+1</button><button data-hp="5">+5</button>
    </div>
    <div class="c-row">
      <span class="c-label"></span>
      <button class="c-damage danger">${t("Schaden")}</button>
      <button class="c-heal">${t("Heilen")}</button>
    </div>
    <div class="c-row">
      <span class="c-label">${t("Temp")}</span>
      <button data-temp="-5">−5</button><button data-temp="-1">−1</button>
      <span class="c-temp"></span>
      <button data-temp="1">+1</button><button data-temp="5">+5</button>
    </div>
    <div class="c-row c-flags">
      <label><input type="checkbox" data-flag="is_hidden" /> ${t("Für Spieler verborgen")}</label>
      <label><input type="checkbox" data-flag="is_boss" /> ${t("Boss")}</label>
    </div>
    <div class="c-conditions"></div>`;
  box.querySelector(".c-temp").textContent = c.temp_hp || 0;
  box.querySelectorAll("[data-hp]").forEach((b) => b.addEventListener("click", () => patchCombatant(c.id, { hp_delta: Number(b.dataset.hp) })));
  box.querySelectorAll("[data-temp]").forEach((b) => b.addEventListener("click", () => patchCombatant(c.id, { temp_hp_delta: Number(b.dataset.temp) })));

  const amount = box.querySelector(".c-amount");
  const applyAmount = (sign) => {
    const v = parseInt(amount.value, 10);
    if (!(v > 0)) return;
    amount.value = "";
    amount.blur();
    patchCombatant(c.id, { hp_delta: sign * v });
  };
  box.querySelector(".c-damage").addEventListener("click", () => applyAmount(-1));
  box.querySelector(".c-heal").addEventListener("click", () => applyAmount(1));
  amount.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") applyAmount(ev.shiftKey ? 1 : -1);
  });
  amount.addEventListener("blur", () => combatantRenderPending && setTimeout(renderCombatants));

  box.querySelectorAll("[data-flag]").forEach((cb) => {
    cb.checked = !!c[cb.dataset.flag];
    cb.addEventListener("change", () => patchCombatant(c.id, { [cb.dataset.flag]: cb.checked }));
  });

  const active = new Set(c.status_effects.map(conditionKey));
  const grid = box.querySelector(".c-conditions");
  for (const cond of conditions()) {
    const b = document.createElement("button");
    b.className = "c-cond";
    b.classList.toggle("on", active.has(cond.key));
    b.innerHTML = conditionIcon(cond.key);
    b.title = cond.label;
    b.addEventListener("click", () => {
      // Drop every tag for this condition (also old free-text spellings), keep the rest in order.
      const others = c.status_effects.filter((x) => conditionKey(x) !== cond.key);
      patchCombatant(c.id, { status_effects: active.has(cond.key) ? others : [...others, cond.key] });
    });
    grid.appendChild(b);
  }
  if (!grid.children.length) grid.innerHTML = `<span class="muted small">${t("Zustände nicht geladen (Tracker nicht erreichbar).")}</span>`;
  return box;
}

$("btn-turn-next").addEventListener("click", () => api("POST", "api/tracker/turn/next"));
$("btn-turn-prev").addEventListener("click", () => api("POST", "api/tracker/turn/prev"));
$("btn-roll-init").addEventListener("click", () => api("POST", "api/tracker/turn/roll-initiative"));
$("btn-tracker-reset").addEventListener("click", () => {
  if (confirm(t("Runde und Zugreihenfolge zurücksetzen?"))) api("POST", "api/tracker/reset");
});

// ---------- stream deck ----------

function renderRemoteList() {
  const base = new URL("api/remote", location.href).href;
  const entries = [
    [t("Blackout an/aus"), "/blackout"],
    [t("Nächste Szene"), "/scene/next"],
    [t("Vorherige Szene"), "/scene/prev"],
    [t("Bereich 1 aufdecken (Nummer anpassen)"), "/area/1"],
    [t("Fog rückgängig"), "/fog/undo"],
    [t("Fog an/aus"), "/fog/toggle"],
    [t("Sichtlinien an/aus"), "/vision/toggle"],
    [t("Raster an/aus"), "/grid/toggle"],
    [t("Ausschnitt hoch / runter / links / rechts"), "/move/up?cells=5"],
    [t("Zoom rein / raus / 1:1"), "/zoom/in"],
    [t("Aktiven Kämpfer zentrieren"), "/center-current"],
    [t("Tracker: nächster Zug"), "/turn/next"],
    [t("Tracker: vorheriger Zug"), "/turn/prev"],
    [t("Tracker-Anzeige an/aus"), "/tracker-strip"],
    [t("Kalibrieren an/aus"), "/calibrate"],
  ];
  const ul = $("remote-list");
  for (const [label, path] of entries) {
    const li = document.createElement("li");
    li.innerHTML = `<div></div><code title="${t("Klicken zum Kopieren")}"></code>`;
    li.querySelector("div").textContent = label;
    li.querySelector("code").textContent = base + path;
    li.querySelector("code").addEventListener("click", () => navigator.clipboard && navigator.clipboard.writeText(base + path));
    ul.appendChild(li);
  }
}

// ---------- menus ----------

const PANEL_KEY = "battlemap.panel";

// Only one topic panel is open at a time; clicking the open topic again closes it.
function openPanel(name) {
  const panel = $("panel");
  panel.hidden = !name;
  document.querySelectorAll("#rail [data-panel]").forEach((b) => b.classList.toggle("open", b.dataset.panel === name));
  panel.querySelectorAll("section[data-panel]").forEach((s) => s.classList.toggle("shown", s.dataset.panel === name));
  try { localStorage.setItem(PANEL_KEY, name || ""); } catch {}
}

document.querySelectorAll("#rail [data-panel]").forEach((b) => {
  b.addEventListener("click", () => openPanel(b.classList.contains("open") ? null : b.dataset.panel));
});

function toggleSetup(open) {
  $("setup").hidden = !open;
  $("btn-setup").classList.toggle("on", open);
}
$("btn-setup").addEventListener("click", () => toggleSetup($("setup").hidden));
$("btn-setup-close").addEventListener("click", () => toggleSetup(false));
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && !$("setup").hidden) toggleSetup(false);
});
// Measuring happens on the map, which the drawer partly covers.
document.querySelector('#setup [data-tool="measure"]').addEventListener("click", () => toggleSetup(false));

// ---------- init ----------

// Inside the Kampagnenbuch (/map/) the beamer is on its public port under /beamer/.
$("player-link").href = location.pathname.startsWith("/map/")
  ? `${location.protocol}//${location.hostname}:8441/beamer/`
  : `${location.protocol}//${location.hostname}:${Number(location.port || 80) + 1}/`;
document.body.classList.add("no-scene");
renderRemoteList();
renderTracker();
setTool("select");
let savedPanel = "scenes";
try { savedPanel = localStorage.getItem(PANEL_KEY) ?? "scenes"; } catch {}
openPanel(savedPanel || null);

// The Kampagnenbuch's Einrichtung, also from the old address (port 8420/8430).
for (const a of document.querySelectorAll("[data-kb-link]")) {
  if (!["8440", ""].includes(location.port) && !location.pathname.startsWith("/tracker/") && !location.pathname.startsWith("/map/")) {
    a.href = `${location.protocol}//${location.hostname}:8440/`;
  }
}

loadCampaigns();
