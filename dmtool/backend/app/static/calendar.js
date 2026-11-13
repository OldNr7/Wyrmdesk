// Game world calendars. A date is {y, m, d} with m indexing calendar.months;
// a one-day "month" is a festival day (Harptos: Midwinter, Shieldmeet, ...).
// Campaigns without a calendar use free text dates, {text}.

const HARPTOS_MONTHS = [
  ["Hammer", 30], ["Midwinter", 1], ["Alturiak", 30], ["Ches", 30], ["Tarsakh", 30], ["Greengrass", 1],
  ["Mirtul", 30], ["Kythorn", 30], ["Flamerule", 30], ["Midsummer", 1], ["Shieldmeet", 1, true],
  ["Eleasis", 30], ["Eleint", 30], ["Highharvestide", 1], ["Marpenoth", 30], ["Uktar", 30],
  ["Feast of the Moon", 1], ["Nightal", 30],
];

export const WORLDS = {
  harptos: { label: t("Forgotten Realms"), hint: t("Kalender von Harptos, Jahre in DR") },
  custom: { label: t("Eigene Welt"), hint: t("Eigene Monate und Zeitrechnung") },
  none: { label: t("Ohne Kalender"), hint: t("Freie Datumsangaben, sortiert nach Eingabe") },
};

export function harptos() {
  return {
    type: "harptos",
    era: "DR",
    months: HARPTOS_MONTHS.map(([name, days, leap]) => ({ name, days, ...(leap ? { leap: true } : {}) })),
  };
}

export function customTemplate() {
  return {
    type: "custom",
    era: "",
    months: Array.from({ length: 12 }, (_, i) => ({ name: `Monat ${i + 1}`, days: 30 })),
  };
}

// "Name = Tage" per line, used by the calendar editor.
export function monthsToText(months) {
  return months.map((m) => `${m.name} = ${m.days}`).join("\n");
}

export function monthsFromText(text) {
  return text.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
    const m = /^(.*?)\s*=\s*(\d+)\s*$/.exec(line);
    return m ? { name: m[1], days: Math.max(1, parseInt(m[2], 10)) } : { name: line, days: 30 };
  });
}

export function hasDates(cal) {
  return !!cal && cal.type !== "none" && cal.months?.length > 0;
}

function isLeapYear(cal, y) {
  return cal.type === "harptos" ? y % 4 === 0 : false;
}

function monthExists(cal, m, y) {
  const month = cal.months[m];
  return month && (!month.leap || isLeapYear(cal, y));
}

export function formatDate(cal, date) {
  if (!date) return "";
  if (!hasDates(cal)) return date.text || "";
  if (date.y == null) return "";
  const month = cal.months[date.m];
  if (!month) return `${date.y}`;
  const era = cal.era ? ` ${cal.era}` : "";
  if (month.days === 1) return `${month.name} ${date.y}${era}`;
  return `${date.d}. ${month.name} ${date.y}${era}`;
}

export function formatRange(cal, a, b) {
  const fa = formatDate(cal, a);
  const fb = formatDate(cal, b);
  if (hasDates(cal) && a?.y != null && b?.y != null && a.y === b.y && a.m === b.m && a.d !== b.d) {
    return `${a.d}.–${fb}`; // 15.–17. Mirtul 1492 DR
  }
  if (fa && fb && fa !== fb) return `${fa} – ${fb}`;
  return fa || fb;
}

// Orders dates on the timeline; free text dates sort by creation instead.
export function sortKey(cal, date) {
  if (!hasDates(cal) || !date || date.y == null) return 0;
  let day = 0;
  for (let i = 0; i < date.m; i++) day += cal.months[i]?.days || 0;
  return date.y * 1000 + day + (date.d || 1);
}

// Day after `date`, for "next day" buttons.
export function nextDay(cal, date) {
  if (!hasDates(cal) || !date || date.y == null) return date;
  let { y, m, d } = date;
  d += 1;
  while (d > (cal.months[m]?.days || 1) || !monthExists(cal, m, y)) {
    d = 1;
    m += 1;
    if (m >= cal.months.length) { m = 0; y += 1; }
  }
  return { y, m, d };
}

// A small date picker matching the campaign's calendar. Calls onChange(date) on every change.
export function dateInput(cal, value, onChange, { allowEmpty = true } = {}) {
  const wrap = document.createElement("span");
  wrap.className = "date-input";
  if (!hasDates(cal)) {
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = t("z. B. Frühling, Jahr 3");
    input.value = value?.text || "";
    input.addEventListener("change", () => onChange(input.value.trim() ? { text: input.value.trim() } : null));
    wrap.append(input);
    return wrap;
  }
  const day = document.createElement("input");
  day.type = "number";
  day.min = 1;
  day.className = "d";
  const month = document.createElement("select");
  const year = document.createElement("input");
  year.type = "number";
  year.className = "y";
  year.placeholder = t("Jahr");
  const era = document.createElement("span");
  era.className = "muted";
  era.textContent = cal.era || "";

  function fillMonths() {
    const y = parseInt(year.value, 10);
    const keep = month.value;
    month.innerHTML = allowEmpty ? `<option value="">–</option>` : "";
    cal.months.forEach((mo, i) => {
      if (mo.leap && !isNaN(y) && !isLeapYear(cal, y)) return;
      const opt = document.createElement("option");
      opt.value = i;
      opt.textContent = mo.name;
      month.append(opt);
    });
    month.value = keep;
  }
  function sync() {
    const mo = cal.months[month.value];
    day.hidden = !mo || mo.days === 1;
    if (mo) day.max = mo.days;
  }
  function emit() {
    sync();
    const y = parseInt(year.value, 10);
    if (month.value === "" || isNaN(y)) {
      if (allowEmpty && month.value === "" && year.value === "") onChange(null);
      return;
    }
    const mo = cal.months[month.value];
    const d = mo.days === 1 ? 1 : Math.min(Math.max(parseInt(day.value, 10) || 1, 1), mo.days);
    day.value = d;
    onChange({ y, m: Number(month.value), d });
  }

  if (value && value.y != null) {
    year.value = value.y;
    day.value = value.d;
  }
  fillMonths();
  if (value && value.y != null) month.value = value.m;
  sync();
  day.addEventListener("change", emit);
  month.addEventListener("change", emit);
  year.addEventListener("change", () => { fillMonths(); emit(); });
  wrap.append(day, month, year, era);
  return wrap;
}
