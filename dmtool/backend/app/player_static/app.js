import { createRenderer } from "/shared/markdown.js";

// Players see link labels only, never which entries exist.
const render = createRenderer(null);
const $ = (id) => document.getElementById(id);

// ?overlay=1: embedded in the battlemap beamer view. Transparent page, turned like the
// map, and the battlemap is told when a handout is up so it can blur the map.
const overlay = new URLSearchParams(location.search).has("overlay");
document.documentElement.classList.toggle("overlay", overlay);
let lastState = null;
let overlayRotation = 0;

if (overlay) {
  window.addEventListener("message", (ev) => {
    if (ev.source !== window.parent || ev.data?.type !== "rotation") return;
    overlayRotation = ev.data.rotation || 0;
    if (lastState) apply(lastState);
  });
}

function apply(state) {
  lastState = state;
  if (overlay) window.parent.postMessage({ type: "handout", shown: !!state.handout }, "*");
  const rotation = overlay ? overlayRotation : state.rotation || 0;
  document.body.classList.toggle("sideways", rotation % 180 !== 0);
  $("stage").style.transform = `translate(-50%, -50%) rotate(${rotation}deg)`;

  const h = state.handout;
  $("handout").hidden = !h;
  if (!h) return;
  $("title").textContent = h.title || "";
  const img = $("image");
  img.hidden = !h.image;
  if (h.image && img.getAttribute("src") !== h.image) img.src = h.image;
  const text = $("text");
  text.hidden = !h.text;
  text.innerHTML = h.text ? render(h.text) : "";
  $("frame").classList.toggle("both", !!h.image && !!h.text);
}

function connect() {
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "state") apply(msg.state);
  });
  ws.addEventListener("close", () => setTimeout(connect, 2000));
}

$("fs-hint").addEventListener("click", () => document.documentElement.requestFullscreen?.());
document.addEventListener("fullscreenchange", () => document.body.classList.toggle("fullscreen", !!document.fullscreenElement));
connect();
