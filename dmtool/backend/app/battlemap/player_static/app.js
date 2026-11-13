import { FogMask, SightDim, TiledMap, connectSocket, drawGrid, drawTemplate, drawToken, keystoneMatrix } from "./shared/scene.js";

const stage = document.getElementById("stage");
const canvas = document.getElementById("view");
const ctx = canvas.getContext("2d");
const handlesEl = document.getElementById("handles");

const fog = new FogMask(() => (dirty = true));
const sightDim = new SightDim();
const mapTiles = new TiledMap(() => (dirty = true));
let state = null;
// Displayed view eases towards the target, so Stream Deck pans don't jump.
let view = null;
let dirty = true;

const socket = connectSocket(
  (msg) => {
    if (msg.type !== "state") return;
    state = msg.state;
    if (state.scene) {
      fog.update(state.scene);
      if (state.scene.sight.length) sightDim.update(state.scene, state.scene.sight);
      if (state.scene.map_url) mapTiles.use(state.scene.map_url, state.scene.map_w, state.scene.map_h, mapFactor(state.scene));
      const target = { x: state.scene.view_x, y: state.scene.view_y, zoom: state.scene.view_zoom, id: state.scene.id };
      if (!view || view.id !== target.id) view = { ...target };
    } else {
      view = null;
    }
    applyKeystone();
    applyBeamerImage();
    applyTrackerStrip();
    applyHandout();
    renderHandles();
    dirty = true;
  },
  () => reportScreen(),
);

// Map resolution the beamer needs: beamer pixels per map pixel with some room to zoom in,
// rounded up to a power of two so zooming doesn't rebuild the tiles at every step.
function mapFactor(scene) {
  const need = (state.ppi / scene.grid_size) * Math.max(1, scene.view_zoom) * 1.25;
  return Math.min(1, 2 ** Math.ceil(Math.log2(need)));
}

function reportScreen() {
  socket.send({ type: "screen", w: window.innerWidth, h: window.innerHeight });
}

function resize() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  applyKeystone();
  applyBeamerImage();
  applyTrackerStrip();
  applyHandout();
  renderHandles();
  reportScreen();
  dirty = true;
}
window.addEventListener("resize", resize);

// ---------- DM-chosen image instead of the battlemap ----------

const beamerImage = document.getElementById("beamer-image");

function applyBeamerImage() {
  const url = state && !state.blackout && !state.calibrate ? state.image_url : null;
  beamerImage.hidden = !url;
  document.body.classList.toggle("image-mode", !!url);
  if (!url) return;
  if (beamerImage.dataset.url !== url) {
    beamerImage.src = url;
    beamerImage.dataset.url = url;
  }
  beamerImage.style.width = `${window.innerWidth}px`;
  beamerImage.style.height = `${window.innerHeight}px`;
}

// ---------- tracker strip ----------

const strip = document.getElementById("tracker-strip");

// The tracker display is laid out for a landscape screen; give it the beamer height as its
// width and turn it -90°, so its top edge sits on the left beamer edge.
function applyTrackerStrip() {
  const url = state && !state.blackout && !state.calibrate ? state.tracker_strip_url : null;
  strip.hidden = !url;
  if (!url) return;
  // Only set src when it changes; reassigning would reload the frame on every state push.
  if (strip.dataset.url !== url) {
    strip.src = url;
    strip.dataset.url = url;
  }
  const h = window.innerHeight;
  strip.style.width = `${h}px`;
  strip.style.height = `${state.tracker_strip_px}px`;
  strip.style.transform = `translate(0px, ${h}px) rotate(-90deg)`;
}

// ---------- Kampagnenbuch handout ----------

// The Kampagnenbuch's handout display in overlay mode: transparent page, turned like the
// tracker strip so its top edge faces the left beamer edge. It reports whether a handout
// is up, and the map and strip blur behind it.
const HANDOUT_ROTATION = -90;
const handout = document.getElementById("handout");
let handoutUp = false;

function applyHandout() {
  const url = state && !state.blackout && !state.calibrate ? state.handout_url : null;
  handout.hidden = !url;
  document.body.classList.toggle("handout-shown", !!url && handoutUp);
  if (!url) return;
  if (handout.dataset.url !== url) {
    handout.src = url;
    handout.dataset.url = url;
  }
  handout.style.width = `${window.innerWidth}px`;
  handout.style.height = `${window.innerHeight}px`;
}

// The rotation goes out once per page load of the overlay, never in reply to its messages:
// the overlay answers every rotation with a "handout" report, so replying would ping-pong
// forever and keep the beamer browser busy and its memory churning.
handout.addEventListener("load", () => {
  handout.contentWindow?.postMessage({ type: "rotation", rotation: HANDOUT_ROTATION }, "*");
  applyHandout();
});
window.addEventListener("message", (ev) => {
  if (ev.source !== handout.contentWindow || ev.data?.type !== "handout") return;
  if (handoutUp === !!ev.data.shown) return;
  handoutUp = !!ev.data.shown;
  applyHandout();
});

// ---------- keystone ----------

const DEFAULT_CORNERS = [[0, 0], [1, 0], [1, 1], [0, 1]];

function corners() {
  return (state && state.keystone) || DEFAULT_CORNERS;
}

function applyKeystone() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const c = corners();
  const isDefault = c.every((p, i) => p[0] === DEFAULT_CORNERS[i][0] && p[1] === DEFAULT_CORNERS[i][1]);
  stage.style.transform = isDefault ? "none" : keystoneMatrix(w, h, c.map(([x, y]) => [x * w, y * h]));
}

// Corner handles only while calibrating; dragged on the beamer screen itself.
function renderHandles() {
  handlesEl.innerHTML = "";
  if (!state || !state.calibrate) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  corners().forEach((p, i) => {
    const el = document.createElement("div");
    el.className = "handle";
    el.style.left = `${p[0] * w}px`;
    el.style.top = `${p[1] * h}px`;
    el.addEventListener("pointerdown", (ev) => {
      el.setPointerCapture(ev.pointerId);
      const move = (e) => {
        const next = corners().map((q) => [...q]);
        next[i] = [Math.min(1.2, Math.max(-0.2, e.clientX / w)), Math.min(1.2, Math.max(-0.2, e.clientY / h))];
        state.keystone = next;
        el.style.left = `${next[i][0] * w}px`;
        el.style.top = `${next[i][1] * h}px`;
        applyKeystone();
      };
      const up = () => {
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", up);
        socket.send({ type: "keystone", corners: corners() });
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
    });
    handlesEl.appendChild(el);
  });
}

// ---------- rendering ----------

function render() {
  const w = canvas.width;
  const h = canvas.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, w, h);
  if (!state || state.blackout) return;
  if (state.calibrate) {
    renderCalibration(w, h);
    return;
  }
  const scene = state.scene;
  if (!scene || !scene.map_url || !view) return;

  const scale = (state.ppi / scene.grid_size) * view.zoom;
  const rot = (state.rotation * Math.PI) / 180;
  ctx.translate(w / 2, h / 2);
  ctx.rotate(rot);
  ctx.scale(scale, scale);
  ctx.translate(-view.x, -view.y);

  // Part of the map on screen, so only the tiles there are drawn.
  const ex = (Math.abs(Math.cos(rot)) * w + Math.abs(Math.sin(rot)) * h) / 2 / scale;
  const ey = (Math.abs(Math.sin(rot)) * w + Math.abs(Math.cos(rot)) * h) / 2 / scale;
  mapTiles.draw(ctx, [view.x - ex, view.y - ey, view.x + ex, view.y + ey]);
  if (scene.show_grid) drawGrid(ctx, scene, 1.5 / scale, "rgba(255,255,255,0.35)");
  for (const t of scene.tokens) {
    drawToken(ctx, t, scene.grid_size, { current: t.current, dead: t.dead, pxPerUnit: scale, onLoad: () => (dirty = true) });
  }
  for (const t of scene.templates || []) drawTemplate(ctx, t, scene.grid_size, 1 / scale);
  // Explored but currently unseen ground stays visible, only darker.
  if (scene.sight.length) sightDim.draw(ctx, scene, 0.55);
  if (scene.fog_enabled) fog.draw(ctx, scene, 1);
  if (!mapTiles.tiles.length) renderMapStatus(w, h, rot);
}

// Instead of a black screen while a big map loads, or when it failed.
function renderMapStatus(w, h, rot) {
  const text = {
    loading: t("Karte lädt … {n} %", { n: Math.round(mapTiles.progress * 100) }),
    decoding: t("Karte wird aufbereitet …"),
    error: t("Karte konnte nicht geladen werden, neuer Versuch folgt …"),
  }[mapTiles.status];
  if (!text) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.translate(w / 2, h / 2);
  ctx.rotate(rot);
  ctx.font = "20px 'Segoe UI', system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillStyle = mapTiles.status === "error" ? "#c0392b" : "#777";
  ctx.fillText(text, 0, 0);
}

// One-inch grid plus a 10 cm square: measure it on the table and adjust ppi in the DM view.
function renderCalibration(w, h) {
  const ppi = state.ppi;
  ctx.strokeStyle = "rgba(255,255,255,0.35)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = (w / 2) % ppi; x < w; x += ppi) { ctx.moveTo(x, 0); ctx.lineTo(x, h); }
  for (let y = (h / 2) % ppi; y < h; y += ppi) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
  ctx.stroke();

  const s = (ppi * 10) / 2.54;
  ctx.strokeStyle = "#e8c15a";
  ctx.lineWidth = 3;
  ctx.strokeRect(w / 2 - s / 2, h / 2 - s / 2, s, s);
  ctx.fillStyle = "#e8c15a";
  ctx.font = "bold 22px 'Segoe UI', system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("10 × 10 cm", w / 2, h / 2 + 8);
  ctx.font = "16px 'Segoe UI', system-ui, sans-serif";
  ctx.fillText("Rasterfelder = 1 Zoll (2,54 cm)", w / 2, h / 2 + s / 2 + 28);
  ctx.fillText(t("Ecken ziehen für Trapezkorrektur"), w / 2, h / 2 + s / 2 + 52);

  // Arrow pointing to the top of the map as it will be rotated on the table.
  ctx.save();
  ctx.translate(w / 2, h / 2 - s / 2 - 50);
  ctx.rotate((state.rotation * Math.PI) / 180);
  ctx.beginPath();
  ctx.moveTo(0, -24);
  ctx.lineTo(16, 8);
  ctx.lineTo(-16, 8);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function frame() {
  if (view && state && state.scene) {
    const s = state.scene;
    const k = 0.18;
    const dx = s.view_x - view.x;
    const dy = s.view_y - view.y;
    const dz = s.view_zoom - view.zoom;
    if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5 || Math.abs(dz) > 0.001) {
      view.x += dx * k;
      view.y += dy * k;
      view.zoom += dz * k;
      dirty = true;
    } else if (dx || dy || dz) {
      view.x = s.view_x;
      view.y = s.view_y;
      view.zoom = s.view_zoom;
      dirty = true;
    }
  }
  if (dirty) {
    dirty = false;
    render();
  }
  lastFrame = performance.now();
  requestAnimationFrame(frame);
}

// Safety nets for an unattended display: redraw now and then (a browser can drop the canvas
// contents under memory pressure), and render without animation frames when the browser
// pauses them because it thinks the window is covered.
let lastFrame = 0;
canvas.addEventListener("contextrestored", () => (dirty = true));
document.addEventListener("visibilitychange", () => (dirty = true));
setInterval(() => {
  if (performance.now() - lastFrame > 1000) render();
  else dirty = true;
}, 5000);

// ---------- fullscreen and cursor ----------

document.body.addEventListener("click", (ev) => {
  if (ev.target.classList.contains("handle")) return;
  if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
});
document.addEventListener("fullscreenchange", () => {
  document.body.classList.toggle("fullscreen", !!document.fullscreenElement);
});

let idleTimer;
document.addEventListener("pointermove", () => {
  document.body.classList.remove("idle");
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => document.body.classList.add("idle"), 2500);
});

resize();
requestAnimationFrame(frame);
