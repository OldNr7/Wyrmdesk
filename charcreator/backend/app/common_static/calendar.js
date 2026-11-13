// A small month-grid calendar for the Termine (session date poll) feature, shared by the
// admin and player pages. No dependencies; keeps no state of its own beyond the DOM it wrote,
// so the caller just calls renderMonthCalendar() again (e.g. with fresh marks) to update it.

// Month and weekday names in the UI language (UI_LOCALE from /shared/i18n.js).
const CAL_LOCALE = window.UI_LOCALE || "de-CH";
const CAL_MONTH_TITLE = new Intl.DateTimeFormat(CAL_LOCALE, { month: "long", year: "numeric" });
const CAL_DATE_LABEL = new Intl.DateTimeFormat(CAL_LOCALE, { weekday: "short", day: "numeric", month: "long", year: "numeric" });
// Monday first; 2024-01-01 was a Monday.
const CAL_WEEKDAYS = [0, 1, 2, 3, 4, 5, 6].map((i) =>
  new Intl.DateTimeFormat(CAL_LOCALE, { weekday: "short" }).format(new Date(2024, 0, 1 + i)).replace(/\.$/, ""));
const calT = (text) => (window.t ? window.t(text) : text);

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Local, so this module never depends on (or clashes with) a page's own escapeHtml.
function calEscapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

// "Fr., 20. November 2026" ("Fri, November 20, 2026") - wherever a proposed date is shown to DM or players.
function formatDateLabel(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return CAL_DATE_LABEL.format(new Date(y, m - 1, d));
}

const CAL_MAX_AVATARS = 4;

/**
 * Renders a month into `container` and wires navigation and day clicks.
 *   year, month: the month to show (month is 0-based, as in Date).
 *   marks: { "YYYY-MM-DD": "yes" | "maybe" | "no" | "open" } - tints that day's cell when it
 *     has no avatars to show (e.g. no one has answered it yet).
 *   avatars: { "YYYY-MM-DD": [{ url, initial, mark }] } - optional; everyone who answered that
 *     day, each shown as their picture (or, without url, their initial letter) ringed in their
 *     own answer's color, instead of the plain tinted square. Over four, the rest collapse into
 *     a "+N" marker.
 *   onPick(dateIso, cellEl): called when a day is clicked (every day, not just marked ones).
 *   onNavigate(year, month): called after the user moves to another month, so the caller can
 *     re-render with that month (keeps the marks data and click handling in one place).
 */
function renderMonthCalendar(container, { year, month, marks = {}, avatars = {}, onPick, onNavigate, today = new Date() }) {
  const first = new Date(year, month, 1);
  const startWeekday = (first.getDay() + 6) % 7; // Monday = 0
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayIso = isoDate(today);

  let html = `<div class="cal-head">
    <button type="button" class="cal-nav" data-cal-nav="-1" aria-label="${calT("Vorheriger Monat")}">‹</button>
    <span class="cal-title">${CAL_MONTH_TITLE.format(new Date(year, month, 1))}</span>
    <button type="button" class="cal-nav" data-cal-nav="1" aria-label="${calT("Nächster Monat")}">›</button>
  </div>
  <div class="cal-grid">
    ${CAL_WEEKDAYS.map((d) => `<div class="cal-dow">${d}</div>`).join("")}`;

  // Each day sits in a `.cal-cell` that is only there to stay square (via a padding-top trick);
  // `.cal-day` itself is absolutely positioned to fill it. A plain `aspect-ratio` on the grid
  // item would do this more simply, but grid columns size unevenly when only some of them (here:
  // the Sunday column, with 5 weeks' worth of items instead of 6) hold aspect-ratio children.
  for (let i = 0; i < startWeekday; i++) html += `<div class="cal-cell"><div class="cal-day empty"></div></div>`;
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = isoDate(new Date(year, month, d));
    const mark = marks[iso];
    const classes = ["cal-day"];
    if (mark) classes.push(`mark-${mark}`);
    if (iso === todayIso) classes.push("today");
    const list = avatars[iso];
    let inner = `${d}`;
    if (list && list.length) {
      classes.push("has-avatar");
      const shown = list.slice(0, list.length > CAL_MAX_AVATARS ? CAL_MAX_AVATARS - 1 : CAL_MAX_AVATARS);
      const overflow = list.length - shown.length;
      const pics = shown.map((a) => {
        const ring = `avatar-ring-${a.mark}`;
        return a.url
          ? `<img class="cal-avatar ${ring}" src="${calEscapeHtml(a.url)}" alt="">`
          : `<span class="cal-avatar cal-avatar-fallback ${ring}">${calEscapeHtml(a.initial || "?")}</span>`;
      }).join("") + (overflow > 0 ? `<span class="cal-avatar cal-avatar-more">+${overflow}</span>` : "");
      const stackClass = shown.length + (overflow > 0 ? 1 : 0) === 1 ? "cal-avatar-stack single" : "cal-avatar-stack";
      inner = `<div class="${stackClass}">${pics}</div><span class="cal-daynum">${d}</span>`;
    }
    html += `<div class="cal-cell"><div class="${classes.join(" ")}" data-date="${iso}">${inner}</div></div>`;
  }
  html += `</div>`;
  container.innerHTML = html;

  container.querySelectorAll("[data-cal-nav]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const next = new Date(year, month + Number(btn.dataset.calNav), 1);
      if (onNavigate) onNavigate(next.getFullYear(), next.getMonth());
    });
  });
  if (onPick) {
    container.querySelectorAll(".cal-day[data-date]").forEach((cell) => {
      cell.addEventListener("click", () => onPick(cell.dataset.date, cell));
    });
  }
}
