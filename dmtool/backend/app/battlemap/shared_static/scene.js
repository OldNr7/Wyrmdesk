// Drawing shared by the DM view and the player display: map, grid, fog and tokens.
// Everything is in map image pixels; callers set up the camera transform first.

const imageCache = new Map();

export function loadImage(url, onLoad) {
  if (!url) return null;
  let entry = imageCache.get(url);
  if (!entry) {
    const img = new Image();
    entry = { img, ready: false };
    img.onload = () => { entry.ready = true; onLoad && onLoad(); };
    img.src = url;
    imageCache.set(url, entry);
  }
  return entry.ready ? entry.img : null;
}

// ---------- fog of war ----------

// Mask resolution cap: fog edges don't need full map resolution, and big maps would eat memory.
const FOG_MAX_DIM = 2048;

export class FogMask {
  // onChange: called when a fog image finished loading and the mask changed with it.
  constructor(onChange) {
    this.canvas = document.createElement("canvas");
    this.onChange = onChange;
    this.key = null;
    this.ops = [];
    this.base = null; // the loaded fog image (older ops flattened by the server), if any
    this.waiting = null; // newest scene while its fog image is still loading
  }

  // Rebuilds only what changed: appended ops are drawn on top, anything else redraws from scratch.
  update(scene) {
    const sceneKey = `${scene.id}:${scene.map_w}x${scene.map_h}`;
    const key = `${sceneKey}:${scene.fog_base_url}`;
    const base = scene.fog_base_url ? this.loadBase(scene.fog_base_url) : null;
    if (scene.fog_base_url && !base) {
      // Until the image is there: same scene keeps its current mask (it only got compacted),
      // another scene starts fully covered, so the beamer never shows too much.
      this.waiting = scene;
      if (!this.key || !this.key.startsWith(`${sceneKey}:`)) this.reset(scene, sceneKey, null);
      return;
    }
    this.waiting = null;
    const ops = scene.fog_ops;
    const appended = key === this.key && ops.length >= this.ops.length &&
      JSON.stringify(ops.slice(0, this.ops.length)) === JSON.stringify(this.ops);
    if (!appended) this.reset(scene, key, base);
    const ctx = this.canvas.getContext("2d");
    for (const op of ops.slice(this.ops.length)) applyFogOp(ctx, op, this.scale);
    this.ops = ops.map((o) => o);
  }

  reset(scene, key, base) {
    this.key = key;
    this.base = base;
    this.scale = Math.min(1, FOG_MAX_DIM / Math.max(scene.map_w, scene.map_h, 1));
    this.canvas.width = Math.max(1, Math.round(scene.map_w * this.scale));
    this.canvas.height = Math.max(1, Math.round(scene.map_h * this.scale));
    this.paintBase(this.canvas, base);
    this.ops = [];
  }

  paintBase(canvas, base) {
    const ctx = canvas.getContext("2d");
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (base) {
      ctx.globalCompositeOperation = "copy";
      ctx.drawImage(base, 0, 0, canvas.width, canvas.height);
      ctx.globalCompositeOperation = "source-over";
    }
  }

  // Not the shared image cache: that keeps every image, and each compaction makes a new one.
  // Only the current fog image is held, so memory stays flat on a display running all evening.
  loadBase(url) {
    if (this.baseUrl === url) return this.baseImg;
    this.baseUrl = url;
    this.baseImg = null;
    const img = new Image();
    img.onload = () => {
      if (this.baseUrl !== url) return;
      this.baseImg = img;
      if (!this.waiting) return;
      this.update(this.waiting);
      this.onChange && this.onChange();
    };
    img.onerror = () => console.error("Fog-Bild konnte nicht geladen werden:", url);
    img.src = url;
    return null;
  }

  // PNG of the fog image plus the first `count` ops, for the server to replace them with.
  // Only valid while the mask is built (not waiting) for that scene.
  async flatten(count) {
    const canvas = document.createElement("canvas");
    canvas.width = this.canvas.width;
    canvas.height = this.canvas.height;
    this.paintBase(canvas, this.base);
    const ctx = canvas.getContext("2d");
    for (const op of this.ops.slice(0, count)) applyFogOp(ctx, op, this.scale);
    return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  }

  draw(ctx, scene, alpha) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.drawImage(this.canvas, 0, 0, scene.map_w, scene.map_h);
    ctx.restore();
  }
}

// Dims explored ground that no vision token sees right now; clear inside the sight polygons.
export class SightDim {
  constructor() {
    this.canvas = document.createElement("canvas");
    this.key = null;
  }

  update(scene, polys) {
    const key = `${scene.id}:${scene.map_w}x${scene.map_h}:${JSON.stringify(polys)}`;
    if (key === this.key) return;
    this.key = key;
    const scale = Math.min(1, FOG_MAX_DIM / Math.max(scene.map_w, scene.map_h, 1));
    this.canvas.width = Math.max(1, Math.round(scene.map_w * scale));
    this.canvas.height = Math.max(1, Math.round(scene.map_h * scale));
    const ctx = this.canvas.getContext("2d");
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    for (const points of polys) applyFogOp(ctx, { mode: "reveal", shape: "poly", points }, scale);
  }

  draw(ctx, scene, alpha) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.drawImage(this.canvas, 0, 0, scene.map_w, scene.map_h);
    ctx.restore();
  }
}

export function applyFogOp(ctx, op, scale) {
  ctx.save();
  ctx.scale(scale, scale);
  ctx.globalCompositeOperation = op.mode === "reveal" ? "destination-out" : "source-over";
  ctx.fillStyle = ctx.strokeStyle = "#000";
  const p = op.points;
  if (op.shape === "all") {
    ctx.fillRect(0, 0, ctx.canvas.width / scale, ctx.canvas.height / scale);
  } else if (op.shape === "rect" && p.length === 2) {
    ctx.fillRect(Math.min(p[0][0], p[1][0]), Math.min(p[0][1], p[1][1]),
      Math.abs(p[1][0] - p[0][0]), Math.abs(p[1][1] - p[0][1]));
  } else if (op.shape === "poly" && p.length >= 3) {
    ctx.beginPath();
    ctx.moveTo(p[0][0], p[0][1]);
    for (const q of p.slice(1)) ctx.lineTo(q[0], q[1]);
    ctx.closePath();
    ctx.fill();
  } else if (op.shape === "brush" && p.length >= 1) {
    ctx.lineCap = ctx.lineJoin = "round";
    ctx.lineWidth = op.radius * 2;
    ctx.beginPath();
    ctx.moveTo(p[0][0], p[0][1]);
    // A single click still leaves a dot.
    ctx.lineTo(p[0][0] + 0.01, p[0][1]);
    for (const q of p.slice(1)) ctx.lineTo(q[0], q[1]);
    ctx.stroke();
  }
  ctx.restore();
}

// ---------- map and grid ----------

export function drawMap(ctx, scene, onLoad) {
  const img = loadImage(scene.map_url, onLoad);
  if (img) ctx.drawImage(img, 0, 0, scene.map_w, scene.map_h);
}

// The map for the beamer: decoded off the main thread, scaled to the resolution actually shown
// and cut into tiles small enough for any graphics chip; only tiles in view are drawn.
// Big maps (9000 px and more) otherwise take long to show up and stutter while panning.
const TILE_PX = 2048;
const RETRY_MS = 5000;

export class TiledMap {
  constructor(onChange) {
    this.onChange = onChange;
    this.url = null;
    this.factor = 0;
    this.tiles = [];
    this.tilesUrl = null;
    this.status = "idle"; // loading | decoding | ready | error
    this.progress = 0;
    this.run = 0;
  }

  // factor: stored pixels per map pixel (1 = full resolution).
  use(url, w, h, factor) {
    if (url === this.url && factor === this.factor) return;
    Object.assign(this, { url, w, h, factor });
    this.load();
  }

  async load() {
    const run = ++this.run;
    const current = () => run === this.run;
    if (this.tilesUrl !== this.url) this.clear();
    this.status = "loading";
    this.progress = 0;
    this.onChange();
    // Decoded bitmaps are big (a 9000 px map is 180 MB); release them on every way out.
    let full = null;
    const tiles = [];
    try {
      const blob = await fetchWithProgress(this.url, (p) => {
        if (current()) { this.progress = p; this.onChange(); }
      });
      if (!current()) return;
      this.status = "decoding";
      this.onChange();
      const sw = Math.max(1, Math.round(this.w * this.factor));
      const sh = Math.max(1, Math.round(this.h * this.factor));
      full = await createImageBitmap(blob, this.factor < 1 ? { resizeWidth: sw, resizeHeight: sh, resizeQuality: "high" } : {});
      const kx = this.w / full.width;
      const ky = this.h / full.height;
      for (let y = 0; y < full.height; y += TILE_PX) {
        for (let x = 0; x < full.width; x += TILE_PX) {
          const tw = Math.min(TILE_PX, full.width - x);
          const th = Math.min(TILE_PX, full.height - y);
          if (!current()) throw new Error("superseded");
          const bmp = await createImageBitmap(full, x, y, tw, th);
          tiles.push({ bmp, x: x * kx, y: y * ky, w: tw * kx, h: th * ky });
        }
      }
      full.close();
      full = null;
      if (!current()) throw new Error("superseded");
      this.clear();
      Object.assign(this, { tiles, tilesUrl: this.url, status: "ready" });
    } catch (err) {
      if (full) full.close();
      tiles.forEach((t) => t.bmp.close());
      if (!current()) return;
      this.status = "error";
      console.error("Karte konnte nicht geladen werden:", err);
      setTimeout(() => current() && this.load(), RETRY_MS);
    }
    this.onChange();
  }

  clear() {
    this.tiles.forEach((t) => t.bmp.close());
    this.tiles = [];
    this.tilesUrl = null;
  }

  // view: [x0, y0, x1, y1] in map pixels.
  draw(ctx, view) {
    for (const t of this.tiles) {
      if (t.x > view[2] || t.y > view[3] || t.x + t.w < view[0] || t.y + t.h < view[1]) continue;
      ctx.drawImage(t.bmp, t.x, t.y, t.w, t.h);
    }
  }
}

async function fetchWithProgress(url, onProgress) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const total = Number(resp.headers.get("Content-Length")) || 0;
  if (!total || !resp.body) return resp.blob();
  const reader = resp.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress(loaded / total);
  }
  return new Blob(chunks, { type: resp.headers.get("Content-Type") || "" });
}

export function drawGrid(ctx, scene, lineWidth, color) {
  const g = scene.grid_size;
  if (!(g > 2)) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.beginPath();
  const x0 = scene.grid_ox - Math.ceil(scene.grid_ox / g) * g;
  const y0 = scene.grid_oy - Math.ceil(scene.grid_oy / g) * g;
  for (let x = x0; x <= scene.map_w; x += g) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, scene.map_h);
  }
  for (let y = y0; y <= scene.map_h; y += g) {
    ctx.moveTo(0, y);
    ctx.lineTo(scene.map_w, y);
  }
  ctx.stroke();
  ctx.restore();
}

// ---------- tokens ----------

// opts: { current, dead, selected, ghost (hidden on beamer, DM only), label, pxPerUnit, onLoad }
const TOKEN_ROTATION = -Math.PI / 2;

export function drawToken(ctx, t, gridSize, opts = {}) {
  const r = (t.size * gridSize) / 2;
  const px = opts.pxPerUnit || 1;
  ctx.save();
  // Portraits and initials face the left map edge, where the players' side of the table is.
  ctx.translate(t.x, t.y);
  ctx.rotate(TOKEN_ROTATION);
  ctx.translate(-t.x, -t.y);
  if (opts.ghost) ctx.globalAlpha = 0.45;

  if (opts.current) {
    ctx.beginPath();
    ctx.arc(t.x, t.y, r + 6 / px, 0, Math.PI * 2);
    ctx.lineWidth = 6 / px;
    ctx.strokeStyle = "#e8c15a";
    ctx.shadowColor = "#e8c15a";
    ctx.shadowBlur = 18;
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  ctx.beginPath();
  ctx.arc(t.x, t.y, r * 0.92, 0, Math.PI * 2);
  ctx.fillStyle = t.color;
  ctx.fill();

  const img = loadImage(t.image, opts.onLoad);
  if (img) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(t.x, t.y, r * 0.82, 0, Math.PI * 2);
    ctx.clip();
    const s = Math.max((r * 1.64) / img.width, (r * 1.64) / img.height);
    ctx.drawImage(img, t.x - (img.width * s) / 2, t.y - (img.height * s) / 2, img.width * s, img.height * s);
    ctx.restore();
  } else if (opts.label) {
    ctx.fillStyle = "#fff";
    ctx.font = `bold ${r * 0.9}px "Segoe UI", system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(opts.label.slice(0, 2).toUpperCase(), t.x, t.y + r * 0.05);
  }

  if (opts.dead) {
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.beginPath();
    ctx.arc(t.x, t.y, r * 0.92, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#c0392b";
    ctx.lineWidth = r * 0.18;
    ctx.lineCap = "round";
    const d = r * 0.5;
    ctx.beginPath();
    ctx.moveTo(t.x - d, t.y - d);
    ctx.lineTo(t.x + d, t.y + d);
    ctx.moveTo(t.x + d, t.y - d);
    ctx.lineTo(t.x - d, t.y + d);
    ctx.stroke();
  }

  if (opts.selected) {
    ctx.beginPath();
    ctx.arc(t.x, t.y, r, 0, Math.PI * 2);
    ctx.lineWidth = 3 / px;
    ctx.setLineDash([8 / px, 6 / px]);
    ctx.strokeStyle = "#fff";
    ctx.stroke();
  }
  ctx.restore();
}

// ---------- spell areas ----------

// One grid cell is 5 ft, as in D&D; template sizes are stored in feet.
export const feetToPx = (feet, gridSize) => (feet * gridSize) / 5;

// Outline of a spell area. Cones are quarter circles and lines run from their start point,
// both turned by `angle` around (x, y); circles and squares are centred on (x, y).
export function templatePath(t, gridSize) {
  const path = new Path2D();
  const len = feetToPx(t.size, gridSize);
  const a = t.angle || 0;
  if (t.shape === "cone") {
    path.moveTo(t.x, t.y);
    path.arc(t.x, t.y, len, a - Math.PI / 4, a + Math.PI / 4);
    path.closePath();
  } else if (t.shape === "circle") {
    path.arc(t.x, t.y, len, 0, Math.PI * 2);
  } else if (t.shape === "square") {
    path.rect(t.x - len / 2, t.y - len / 2, len, len);
  } else if (t.shape === "line") {
    const hw = feetToPx(t.width || 5, gridSize) / 2;
    const [cos, sin] = [Math.cos(a), Math.sin(a)];
    const pts = [[0, -hw], [len, -hw], [len, hw], [0, hw]].map(([u, v]) => [t.x + u * cos - v * sin, t.y + u * sin + v * cos]);
    pts.forEach(([x, y], i) => (i ? path.lineTo(x, y) : path.moveTo(x, y)));
    path.closePath();
  }
  return path;
}

// Red, see-through fill with a crisp outline; px is one screen pixel in map units.
export function drawTemplate(ctx, t, gridSize, px) {
  const path = templatePath(t, gridSize);
  ctx.save();
  ctx.fillStyle = "rgba(231,40,40,0.28)";
  ctx.fill(path);
  ctx.lineJoin = "round";
  ctx.lineWidth = 2.5 * px;
  ctx.strokeStyle = "#ff2d2d";
  ctx.stroke(path);
  if (t.shape === "cone" || t.shape === "line") {
    // Point of origin, where the area turns.
    ctx.beginPath();
    ctx.arc(t.x, t.y, 4 * px, 0, Math.PI * 2);
    ctx.fillStyle = "#ff2d2d";
    ctx.fill();
  }
  ctx.restore();
}

// ---------- keystone ----------

// CSS matrix3d that maps the rectangle (0,0)-(w,h) onto the quad `dst` (tl, tr, br, bl in px).
export function keystoneMatrix(w, h, dst) {
  const src = [[0, 0], [w, 0], [w, h], [0, h]];
  const H = solveHomography(src, dst);
  if (!H) return "none";
  const [a, b, c, d, e, f, g, hh] = H;
  // Column-major 4x4 with the homography in the x/y/w rows.
  return `matrix3d(${a},${d},0,${g},${b},${e},0,${hh},0,0,1,0,${c},${f},0,1)`;
}

function solveHomography(src, dst) {
  const A = [];
  const B = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    B.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    B.push(v);
  }
  // Gaussian elimination with partial pivoting.
  const n = 8;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(A[r][col]) > Math.abs(A[pivot][col])) pivot = r;
    if (Math.abs(A[pivot][col]) < 1e-12) return null;
    [A[col], A[pivot]] = [A[pivot], A[col]];
    [B[col], B[pivot]] = [B[pivot], B[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = A[r][col] / A[col][col];
      for (let k = col; k < n; k++) A[r][k] -= factor * A[col][k];
      B[r] -= factor * B[col];
    }
  }
  return B.map((b, i) => b / A[i][i]);
}

// Opens a WebSocket that reconnects on its own; the display runs unattended all evening.
export function connectSocket(onMessage, onOpen) {
  let ws;
  const open = () => {
    // Next to the page: /map/ws, /beamer/ws, or /ws at the root of the old ports.
    const url = new URL("ws", location.href);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(url);
    ws.onmessage = (ev) => onMessage(JSON.parse(ev.data));
    ws.onopen = () => onOpen && onOpen(ws);
    ws.onclose = () => setTimeout(open, 1500);
  };
  open();
  return { send: (msg) => ws && ws.readyState === 1 && ws.send(JSON.stringify(msg)) };
}
