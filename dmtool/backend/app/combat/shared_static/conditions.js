// D&D 5e conditions plus common table extras (bleeding, burning, concentration).
// Shared by the DM view (port 8000) and the player display (port 8001), both serve it under /shared/.
// Keys are what gets stored in combatants.status_effects; icons are 24x24 inline SVG.

const CONDITIONS = [
  {
    key: "bleeding",
    label: t("Blutend"),
    color: "#e74c3c",
    svg: '<path d="M12 3C12 3 5.5 10.5 5.5 14.5a6.5 6.5 0 0 0 13 0C18.5 10.5 12 3 12 3Z" fill="#e74c3c"/><ellipse cx="9.6" cy="15" rx="1.3" ry="2" fill="#fff" opacity=".55"/>',
  },
  {
    key: "burning",
    label: t("Brennend"),
    color: "#e67e22",
    svg: '<path d="M12 2c1 4 5 6 5 11.5a5 5 0 0 1-10 0c0-3 2-4.5 2.5-7 1 1.5 1.5 2.5 2 3 .5-2.5.8-5 .5-7.5Z" fill="#e67e22"/><path d="M12 11c.8 2 2.5 2.8 2.5 5a2.5 2.5 0 0 1-5 0c0-1.7 1.5-2.5 2.5-5Z" fill="#f9d342"/>',
  },
  {
    key: "poisoned",
    label: t("Vergiftet"),
    color: "#2ecc71",
    svg: '<path d="M12 3C12 3 5.5 10.5 5.5 14.5a6.5 6.5 0 0 0 13 0C18.5 10.5 12 3 12 3Z" fill="#27ae60"/><ellipse cx="9.6" cy="15" rx="1.3" ry="2" fill="#fff" opacity=".55"/>',
  },
  {
    key: "blinded",
    label: t("Blind"),
    color: "#bdc3c7",
    svg: '<path d="M2.5 12C5 7.5 8.5 5.5 12 5.5s7 2 9.5 6.5c-2.5 4.5-6 6.5-9.5 6.5s-7-2-9.5-6.5Z" fill="#ecf0f1"/><circle cx="12" cy="12" r="3" fill="#34495e"/><path d="M4.5 19.5 19.5 4.5" stroke="#e74c3c" stroke-width="2.5" stroke-linecap="round"/>',
  },
  {
    key: "charmed",
    label: t("Bezaubert"),
    color: "#ff7eb6",
    svg: '<path d="M12 20C6 15.5 3 12.5 3 9c0-2.5 2-4.5 4.5-4.5 1.8 0 3.4 1 4.5 2.5 1.1-1.5 2.7-2.5 4.5-2.5C19 4.5 21 6.5 21 9c0 3.5-3 6.5-9 11Z" fill="#ff7eb6"/><path d="M8 8.5a2 2 0 0 1 2-1.5" stroke="#fff" stroke-width="1.5" stroke-linecap="round" fill="none"/>',
  },
  {
    key: "deafened",
    label: t("Taub"),
    color: "#f0c9a0",
    svg: '<path d="M8 10a4.5 4.5 0 1 1 8.5 1.5c0 2.5-2.5 3-3 5.5a2.7 2.7 0 0 1-5 1" stroke="#f0c9a0" stroke-width="2.2" fill="none" stroke-linecap="round"/><path d="M11 10.5a1.8 1.8 0 1 1 2.5 1.5" stroke="#f0c9a0" stroke-width="1.8" fill="none" stroke-linecap="round"/><path d="M4.5 19.5 19.5 4.5" stroke="#e74c3c" stroke-width="2.5" stroke-linecap="round"/>',
  },
  {
    key: "exhaustion",
    label: t("Erschöpft"),
    color: "#f1c40f",
    svg: '<rect x="3" y="7" width="16" height="10" rx="2" stroke="#f1c40f" stroke-width="2" fill="none"/><rect x="19.5" y="10" width="2" height="4" rx=".6" fill="#f1c40f"/><rect x="5.3" y="9.3" width="3.6" height="5.4" rx=".6" fill="#e74c3c"/>',
  },
  {
    key: "frightened",
    label: t("Verängstigt"),
    color: "#a569bd",
    svg: '<path d="M6 20v-9a6 6 0 0 1 12 0v9l-2-1.7-2 1.7-2-1.7-2 1.7-2-1.7Z" fill="#ecf0f1"/><ellipse cx="10" cy="11" rx="1.2" ry="1.8" fill="#6c3483"/><ellipse cx="14" cy="11" rx="1.2" ry="1.8" fill="#6c3483"/><circle cx="12" cy="15" r="1.2" fill="#6c3483"/>',
  },
  {
    key: "grappled",
    label: t("Gepackt"),
    color: "#e0ac69",
    svg: '<g fill="#e0ac69"><rect x="6.2" y="5" width="2.6" height="9" rx="1.3"/><rect x="9.2" y="3.5" width="2.6" height="10" rx="1.3"/><rect x="12.2" y="4" width="2.6" height="10" rx="1.3"/><rect x="15.2" y="5.5" width="2.6" height="9" rx="1.3"/><path d="M6.2 11h11.6v4c0 3.5-2.3 6-5.8 6s-5.8-2.5-5.8-6Z"/><path d="M6.5 14.5 3.6 11.6a1.4 1.4 0 0 1 1.9-2l3 2.6Z"/></g>',
  },
  {
    key: "incapacitated",
    label: t("Kampfunfähig"),
    color: "#e74c3c",
    svg: '<circle cx="12" cy="12" r="8" stroke="#e74c3c" stroke-width="2.5" fill="none"/><path d="M6.5 17.5 17.5 6.5" stroke="#e74c3c" stroke-width="2.5" stroke-linecap="round"/>',
  },
  {
    key: "invisible",
    label: t("Unsichtbar"),
    color: "#a9e5ff",
    svg: '<g stroke="#a9e5ff" stroke-width="2" fill="none" stroke-dasharray="2.2 2" stroke-linecap="round"><circle cx="12" cy="8" r="3.5"/><path d="M5 20c0-4.5 3-7 7-7s7 2.5 7 7"/></g>',
  },
  {
    key: "paralyzed",
    label: t("Gelähmt"),
    color: "#5dade2",
    svg: '<path d="M13.5 2 5 13.5h6L9.5 22 19 9.5h-6Z" fill="#5dade2"/>',
  },
  {
    key: "petrified",
    label: t("Versteinert"),
    color: "#95a5a6",
    svg: '<path d="m4 17 2.5-8L11 5.5l5.5 1.5 3.5 5.5-1.5 6L10 20Z" fill="#95a5a6" stroke="#626f70" stroke-width="1.2" stroke-linejoin="round"/><path d="m11 9 1.5 3-2 2.5 1 3" stroke="#626f70" stroke-width="1.2" fill="none" stroke-linecap="round"/>',
  },
  {
    key: "prone",
    label: t("Liegend"),
    color: "#d4a373",
    svg: '<g stroke="#d4a373" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v10"/><path d="m7.5 10 4.5 4.5 4.5-4.5"/><path d="M4 20h16"/></g>',
  },
  {
    key: "restrained",
    label: t("Festgesetzt"),
    color: "#bdc3c7",
    svg: '<g stroke="#bdc3c7" stroke-width="2.2" fill="none"><rect x="3" y="12.5" width="11" height="6" rx="3" transform="rotate(-45 8.5 15.5)"/><rect x="10" y="5.5" width="11" height="6" rx="3" transform="rotate(-45 15.5 8.5)"/></g>',
  },
  {
    key: "stunned",
    label: t("Betäubt"),
    color: "#f1c40f",
    svg: '<path d="m12 2.5 2.6 6.3 6.8.5-5.2 4.3 1.7 6.6L12 16.6l-5.9 3.6 1.7-6.6-5.2-4.3 6.8-.5Z" fill="#f1c40f"/>',
  },
  {
    key: "unconscious",
    label: t("Bewusstlos"),
    color: "#aed6f1",
    svg: '<g fill="#aed6f1" font-family="Segoe UI, system-ui, sans-serif" font-weight="800"><text x="3" y="19" font-size="14">Z</text><text x="13.5" y="12" font-size="9.5">z</text></g>',
  },
  {
    key: "concentration",
    label: t("Konzentration"),
    color: "#9b59b6",
    svg: '<path d="M12 2.5 19 10l-7 11.5L5 10Z" fill="#9b59b6"/><path d="M12 5.5 16 10l-4 8-4-8Z" fill="#c39bd3"/>',
  },
];

const CONDITION_BY_KEY = {};
for (const c of CONDITIONS) {
  CONDITION_BY_KEY[c.key] = c;
  CONDITION_BY_KEY[c.label.toLowerCase()] = c;
}

// Status tags typed in freely before the dropdown existed ("prone", "Vergiftet", ...) still resolve.
function conditionFor(tag) {
  return CONDITION_BY_KEY[String(tag || "").trim().toLowerCase()] || null;
}

function conditionIconSvg(tag) {
  const c = conditionFor(tag);
  if (c) return `<svg viewBox="0 0 24 24" aria-hidden="true">${c.svg}</svg>`;
  // Unknown free-text tag: neutral token with its first letter.
  const letter = String(tag || "?").trim().charAt(0).toUpperCase().replace(/[&<>"']/, "") || "?";
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><text x="12" y="16.5" text-anchor="middle" font-size="13" font-weight="800" font-family="Segoe UI, system-ui, sans-serif" fill="#ecf0f1">${letter}</text></svg>`;
}

function conditionLabel(tag) {
  const c = conditionFor(tag);
  return c ? c.label : String(tag);
}
