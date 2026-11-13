async function fetchState() {
  try {
    const resp = await fetch("api/display/state", { cache: "no-store" });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

const TYPE_ICONS = {
  aberration: "🐙",
  beast: "🐺",
  celestial: "👼",
  construct: "🤖",
  dragon: "🐉",
  elemental: "🔥",
  fey: "🧚",
  fiend: "😈",
  giant: "🧌",
  humanoid: "👤",
  monstrosity: "🦖",
  ooze: "🟢",
  plant: "🌿",
  undead: "💀",
};

function iconFor(kind, creatureType) {
  if (kind === "pc") return "🧑";
  const key = (creatureType || "").toLowerCase();
  for (const [type, icon] of Object.entries(TYPE_ICONS)) {
    if (key.includes(type)) return icon;
  }
  return "👹";
}

function render(data) {
  const row = document.getElementById("row");
  if (!data || !data.encounter_id || data.combatants.length === 0) {
    row.innerHTML = `<div class="empty">${t("Kein Encounter aktiv")}</div>`;
    return;
  }
  // Measure before the new tiles exist: a layout pass between creating them and setting
  // their fan classes would make the box-shadow transition run on every rebuild.
  const avail = availableWidth(row);
  row.innerHTML = "";
  for (const c of data.combatants) {
    // The slot holds the tile plus the status ring, which may stick out past the tile edge.
    const slot = document.createElement("div");
    slot.className = `slot ${c.is_boss ? "boss" : ""}`;
    const size = c.is_boss ? BOSS_TILE_SIZE : TILE_SIZE;

    const el = document.createElement("div");
    el.className = `combatant ${c.is_current ? "current" : ""} ${c.hp_critical ? "critical" : ""}`;
    el.innerHTML = c.avatar_path ? `<img src="${c.avatar_path}" />` : iconFor(c.kind, c.creature_type);

    // AC shield (bottom left) and HP heart (bottom right) on the portrait, PCs only.
    if (c.kind === "pc") {
      el.appendChild(badge("ac-shield", SHIELD_PATH, c.ac));
      el.appendChild(badge("hp-heart", HEART_PATH, Math.max(0, c.current_hp)));
    }

    if (c.dead) {
      const mark = document.createElement("div");
      mark.className = "dead-mark";
      mark.textContent = "✕";
      el.appendChild(mark);
    }
    slot.appendChild(el);

    // Temp HP: small pill below the tile, PCs only, only while it's actually above 0.
    if (c.kind === "pc" && c.temp_hp > 0) {
      const t = document.createElement("div");
      t.className = "temp-hp-badge";
      t.textContent = `+${c.temp_hp}`;
      slot.appendChild(t);
    }
    if (c.is_boss) slot.insertAdjacentHTML("beforeend", BOSS_FRAME_SVG);

    const statuses = c.status_effects || [];
    const angles = ringAngles(statuses.length, c.kind === "pc");
    statuses.forEach((tag, i) => slot.appendChild(statusToken(tag, angles[i], size)));

    row.appendChild(slot);
  }
  fanOut(row, data.combatants, avail);
}

function availableWidth(row) {
  const style = getComputedStyle(row);
  return row.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
}

// Single row, never wider than the row box (max 1080px). When the tiles don't fit, the
// combatants that are not on turn slide over each other like a fanned hand of cards;
// the current one keeps its full gap on both sides so it stays completely visible.
const ROW_GAP = 36;
const MIN_VISIBLE = 34;

function fanOut(row, combatants, avail) {
  const slots = [...row.children];
  const n = slots.length;
  if (n === 0) return;
  const widths = combatants.map((c) => (c.is_boss ? BOSS_TILE_SIZE : TILE_SIZE));
  const cur = combatants.findIndex((c) => c.is_current);
  const tiles = widths.reduce((a, b) => a + b, 0);

  // Gap i sits between slot i-1 and slot i; gaps touching the current slot stay fixed.
  const fixed = (i) => cur >= 0 && (i === cur || i === cur + 1);
  const gaps = Array(n).fill(ROW_GAP);
  gaps[0] = 0;
  const overflow = tiles + ROW_GAP * (n - 1) - avail;
  if (overflow > 0) {
    const flexible = [];
    for (let i = 1; i < n; i++) if (!fixed(i)) flexible.push(i);
    const minGap = MIN_VISIBLE - Math.min(...widths);
    let gap = flexible.length ? ROW_GAP - overflow / flexible.length : minGap - 1;
    if (gap >= minGap) {
      flexible.forEach((i) => (gaps[i] = gap));
    } else {
      // Too many even at maximum overlap: squeeze every gap, the current one included.
      gap = Math.max(minGap, (avail - tiles) / (n - 1));
      for (let i = 1; i < n; i++) gaps[i] = gap;
    }
  }

  slots.forEach((slot, i) => {
    slot.style.marginLeft = `${gaps[i]}px`;
    // Stack towards the current combatant: it is on top, neighbours get lower the further out.
    const dist = cur >= 0 ? Math.abs(i - cur) : n - i;
    slot.style.zIndex = String(n + 1 - dist);
    // Cast a shadow onto the lower card this one lies on (left of the current one: its left neighbour).
    if (i === cur) return;
    if (i < cur || cur < 0) {
      if (gaps[i] < 0) slot.classList.add("fan-l");
    } else if (i + 1 < n && gaps[i + 1] < 0) {
      slot.classList.add("fan-r");
    }
  });
}

// Status ring: icons sit on a circle around the tile centre, starting top centre, clockwise.
const TILE_SIZE = 110;
const RING_RADIUS = 60;
const TOKEN_SIZE = 22;
const RING_STEP = 30;
// Bosses get a 10% larger portrait and an ornate gold frame.
const BOSS_TILE_SIZE = 121;

// Gold filigree frame laid over the boss tile: double rim, a ruby-set diamond on each corner
// and small scrolls running off it along both edges. One corner is drawn, the others are rotations.
const BOSS_FRAME_SVG = `
  <svg class="boss-frame" viewBox="0 0 100 100" aria-hidden="true">
    <defs>
      <linearGradient id="bossGold" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#fbe9a0"/>
        <stop offset=".35" stop-color="#d4a937"/>
        <stop offset=".65" stop-color="#8f6716"/>
        <stop offset="1" stop-color="#f3d27a"/>
      </linearGradient>
      <g id="bossCorner">
        <path d="M14 3.2c3 3.2 7 3.6 11 1.6M3.2 14c3.2 3 3.6 7 1.6 11" stroke="url(#bossGold)" stroke-width="1.3" fill="none" stroke-linecap="round"/>
        <path d="M25 4.8c1.6-.8 3-.4 3.4 1M4.8 25c-.8 1.6-.4 3 1 3.4" stroke="url(#bossGold)" stroke-width="1" fill="none" stroke-linecap="round"/>
        <path d="M8 1 15 8 8 15 1 8Z" fill="url(#bossGold)" stroke="#5c4210" stroke-width=".6"/>
        <circle cx="8" cy="8" r="2.4" fill="#b0122b" stroke="#5c0a17" stroke-width=".5"/>
        <circle cx="7.3" cy="7.2" r=".7" fill="#fff" opacity=".7"/>
      </g>
    </defs>
    <rect x="2.5" y="2.5" width="95" height="95" rx="9" fill="none" stroke="url(#bossGold)" stroke-width="2.4"/>
    <rect x="6.5" y="6.5" width="87" height="87" rx="6" fill="none" stroke="url(#bossGold)" stroke-width="1"/>
    <use href="#bossCorner"/>
    <use href="#bossCorner" transform="rotate(90 50 50)"/>
    <use href="#bossCorner" transform="rotate(180 50 50)"/>
    <use href="#bossCorner" transform="rotate(270 50 50)"/>
  </svg>`;

// Clock positions next to the bottom corners, where PCs already show the AC shield and HP heart.
const PC_RESERVED_ANGLES = [120, 150, 210, 240];

function ringAngles(count, isPc) {
  const all = [];
  for (let a = 0; a < 360; a += RING_STEP) all.push(a);
  let angles = isPc ? all.filter((a) => !PC_RESERVED_ANGLES.includes(a)) : all;
  if (count > angles.length) angles = all;
  if (count > angles.length) angles = Array.from({ length: count }, (_, i) => (i * 360) / count);
  return angles.slice(0, count);
}

function statusToken(tag, angle, size = TILE_SIZE) {
  const rad = (angle * Math.PI) / 180;
  const radius = (RING_RADIUS * size) / TILE_SIZE;
  const cx = size / 2 + radius * Math.sin(rad);
  const cy = size / 2 - radius * Math.cos(rad);
  const t = document.createElement("div");
  const cond = conditionFor(tag);
  t.className = "status-token";
  t.title = conditionLabel(tag);
  t.style.left = `${cx - TOKEN_SIZE / 2}px`;
  t.style.top = `${cy - TOKEN_SIZE / 2}px`;
  if (cond) t.style.borderColor = cond.color;
  t.innerHTML = conditionIconSvg(tag);
  return t;
}

const SHIELD_PATH = "M12 1 L22 5 V13 C22 20 17 25 12 27 C7 25 2 20 2 13 V5 Z";
const HEART_PATH =
  "M12 26 C5 20.5 1 16 1 10.5 C1 6 4.3 2.5 8.3 2.5 C10.2 2.5 11.4 3.5 12 4.6 C12.6 3.5 13.8 2.5 15.7 2.5 C19.7 2.5 23 6 23 10.5 C23 16 19 20.5 12 26 Z";

function badge(className, path, value) {
  const b = document.createElement("div");
  const text = String(value);
  b.className = `badge ${className} ${text.length > 2 ? "long" : ""}`;
  b.innerHTML = `<svg viewBox="0 0 24 28" aria-hidden="true"><path d="${path}" /></svg><span>${text}</span>`;
  return b;
}

// Only rebuild when something actually changed (state or window width), so portraits and
// shadows stay put between polls instead of being recreated every 1.5 s.
let lastRenderKey = null;

async function tick() {
  const data = await fetchState();
  const key = `${window.innerWidth}|${JSON.stringify(data)}`;
  if (key === lastRenderKey) return;
  lastRenderKey = key;
  render(data);
}

tick();
setInterval(tick, 1500);
