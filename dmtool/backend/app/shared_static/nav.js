// Switch between the three parts of the Kampagnenbuch from their headers:
// "Kampagnenbuch | Kampf | Karte", the current one marked. Loaded as a plain script by the
// Kampagnenbuch (/shared/nav.js), the tracker and the battlemap (kb/shared/nav.js). At the old
// addresses (ports 8420/8430) the links go to the Kampagnenbuch's port.
(() => {
  const PARTS = [
    ["", "📖", t("Kampagnenbuch")],
    ["tracker/", "⚔", t("Kampf")],
    ["map/", "🗺", t("Karte")],
  ];
  const onKb = location.port === "8440" || !["8420", "8421", "8430", "8431"].includes(location.port);
  const base = onKb ? "/" : `${location.protocol}//${location.hostname}:8440/`;
  const path = location.pathname;
  const current = !onKb
    ? (location.port === "8430" ? "map/" : "tracker/")
    : path.startsWith("/tracker/") ? "tracker/" : path.startsWith("/map/") ? "map/" : "";

  const style = document.createElement("style");
  style.textContent = `
    .kb-nav { display: inline-flex; gap: 2px; margin: 0 6px; padding: 2px; border-radius: 7px;
      background: rgba(0, 0, 0, 0.18); flex-shrink: 0; }
    .kb-nav a { padding: 3px 10px; border-radius: 5px; font-size: 13px; line-height: 1.5; white-space: nowrap;
      color: var(--leather-text, #f3dca0); text-decoration: none; opacity: 0.8; }
    .kb-nav a:hover { opacity: 1; background: rgba(255, 255, 255, 0.08); text-decoration: none; }
    .kb-nav a.on { opacity: 1; background: var(--panel, #fffdf8); color: var(--heading, #5c2e1a); font-weight: 600; }
    /* Keep the switcher in place when moving between the parts: the titles in front of it get one
       width, and each link reserves room for its bold (current) label so marking it shifts nothing. */
    header h1 { width: 172px; overflow: hidden; text-overflow: ellipsis; }
    .kb-nav a { text-align: center; }
    .kb-nav a span { display: inline-flex; flex-direction: column; }
    .kb-nav a span::after { content: attr(data-label); font-weight: 600; height: 0; overflow: hidden; visibility: hidden; }
    /* The campaign dropdown, same size in all three parts. */
    header #campaign, header #campaign-select { width: 220px; max-width: 220px; font-size: 14px; }
    @media (max-width: 900px) { .kb-nav a span { display: none; } header h1 { width: auto; } }`;
  document.head.append(style);

  const nav = document.createElement("nav");
  nav.className = "kb-nav";
  nav.setAttribute("aria-label", t("Bereiche"));
  for (const [href, icon, label] of PARTS) {
    const a = document.createElement("a");
    a.href = base + href;
    a.innerHTML = `${icon} <span data-label="${label}">${label}</span>`;
    a.title = label;
    if (href === current) {
      a.className = "on";
      a.setAttribute("aria-current", "page");
    }
    nav.append(a);
  }
  const place = () => {
    const h1 = document.querySelector("header h1");
    if (h1) h1.after(nav);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", place);
  else place();
})();
