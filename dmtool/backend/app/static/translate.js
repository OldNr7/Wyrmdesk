// German translations of the library (translate.py): the "Deutsche Übersetzung" box in the setup
// drawer, and the ✎ buttons in the library to correct a translation by hand.
// Classic script after library.js and options.js, whose api(), escapeHtml() and loaders it uses.

// ---------- correcting one text ----------

// The German text with its English original folded away, plus a button to correct it. en is the
// exact original: it's the key the correction is stored under.
function trBlockHtml(en, de, render = optionTextHtml) {
  if (!en || !en.trim()) return "";
  return `<div class="tr-block" data-tr-src="${escapeHtml(en)}" data-tr-de="${escapeHtml(de || "")}">
    ${deTextHtml(en, de, render)}
    <button type="button" class="tr-edit ghost" title="${t("Deutsche Übersetzung von Hand korrigieren")}">✎ ${de ? t("Übersetzung korrigieren") : t("Übersetzung eintragen")}</button>
  </div>`;
}

// Under a spell or item sheet: one correction button per translated field.
function trFieldsHtml(fields) {
  const rows = fields.filter(([, en]) => en && en.trim());
  if (!rows.length) return "";
  return `<div class="tr-fields"><h4>${t("Deutsche Übersetzung")}</h4>${rows
    .map(([label, en, de]) => `<div class="tr-field"><div class="muted small">${escapeHtml(label)}</div>${trBlockHtml(en, de, mdLiteHtml)}</div>`)
    .join("")}</div>`;
}

async function trReload() {
  await Promise.all([loadCharOptions(), loadCustomSpells(), loadCustomItems()].map((p) => p.catch(() => {})));
}

document.addEventListener("click", async (e) => {
  const block = e.target.closest(".tr-block");
  if (!block) return;
  const src = block.dataset.trSrc;
  if (e.target.closest(".tr-edit")) {
    // Editing replaces the block by a textarea with the German text (or the English one to start from).
    block.dataset.trHtml = block.innerHTML;
    block.innerHTML = `
      <textarea class="tr-area" rows="${Math.min(14, Math.max(3, src.split("\n").length + 1))}">${escapeHtml(block.dataset.trDe || src)}</textarea>
      <div class="tr-actions">
        <button type="button" class="tr-save">${t("Speichern")}</button>
        <button type="button" class="tr-cancel ghost">${t("Abbrechen")}</button>
        ${block.dataset.trDe ? `<button type="button" class="tr-reset ghost" title="${t("Eigene Korrektur verwerfen")}">${t("Maschinelle Übersetzung")}</button>` : ""}
      </div>
      <details class="pc-orig"><summary>${t("Original (englisch)")}</summary><pre class="tr-src">${escapeHtml(src)}</pre></details>`;
    block.querySelector(".tr-area").focus();
    return;
  }
  if (e.target.closest(".tr-cancel")) {
    block.innerHTML = block.dataset.trHtml;
    return;
  }
  const save = e.target.closest(".tr-save");
  const reset = e.target.closest(".tr-reset");
  if (!save && !reset) return;
  const text_de = reset ? "" : block.querySelector(".tr-area").value;
  try {
    await api("/api/translate/manual", "PUT", { source: src, text_de });
    await trReload();
  } catch (err) {
    alert(t("Nicht gespeichert: {error}", { error: err.message }));
  }
});

// ---------- setup drawer: status and the translate button ----------

let trRunning = false;
let trStop = false;

function trStatusText(s) {
  if (!s.configured) {
    return t("Kein DeepL-Schlüssel eingerichtet. DEEPL_API_KEY in der Umgebung des Kampagnenbuchs setzen (z.B. in der .env) und neu starten.");
  }
  const pct = (part) => (part.texts ? Math.floor((part.done / part.texts) * 100) : 100);
  const parts = [
    t("Grundregeln, Zauber, Gegenstände: {pct} % übersetzt", { pct: pct(s.standard) }) + (s.standard.chars_missing ? ` ${t("(noch ~{n} Zeichen)", { n: s.standard.chars_missing.toLocaleString(UI_LOCALE) })}` : ""),
    t("Alles inkl. Zusatzbücher: {pct} %", { pct: pct(s.all) }) + (s.all.chars_missing ? ` ${t("(noch ~{n} Zeichen)", { n: s.all.chars_missing.toLocaleString(UI_LOCALE) })}` : ""),
  ];
  if (s.usage) {
    const left = Math.max(0, s.usage.limit - s.usage.count);
    parts.push(t("DeepL diesen Monat: {used} von {limit} Zeichen verbraucht, {left} übrig.", { used: s.usage.count.toLocaleString(UI_LOCALE), limit: s.usage.limit.toLocaleString(UI_LOCALE), left: left.toLocaleString(UI_LOCALE) }));
  } else if (s.usage_error) parts.push(s.usage_error);
  if (s.manual) parts.push(t("{n} Texte von Hand korrigiert.", { n: s.manual }));
  return parts.join("\n");
}

async function trRefreshStatus() {
  const el = document.getElementById("tr-status");
  if (!el) return;
  try {
    const s = await api("/api/translate/status?usage=true");
    el.textContent = trStatusText(s);
    document.getElementById("btn-tr-standard").disabled = !s.configured || trRunning;
    document.getElementById("btn-tr-all").disabled = !s.configured || trRunning;
    return s;
  } catch {
    el.textContent = t("Status nicht abrufbar.");
  }
}

async function trRun(scope) {
  if (trRunning) return;
  trRunning = true;
  trStop = false;
  const progress = document.getElementById("tr-progress");
  const stopBtn = document.getElementById("btn-tr-stop");
  stopBtn.hidden = false;
  document.getElementById("btn-tr-standard").disabled = true;
  document.getElementById("btn-tr-all").disabled = true;
  let chars = 0;
  let skipped = 0;
  let message = "";
  try {
    // Step by step, so the page shows progress and can stop between two steps.
    for (;;) {
      const s = await api(`/api/translate/run?scope=${scope}&max_chars=20000`, "POST");
      chars += s.translated_chars;
      skipped = Math.max(skipped, s.skipped_lines || 0);
      const part = scope === "all" ? s.all : s.standard;
      progress.textContent = t("Übersetzt: {chars} Zeichen · {done} von {n} Texten fertig", { chars: chars.toLocaleString(UI_LOCALE), done: part.done, n: part.texts });
      if (s.quota_exceeded) { message = t("Das DeepL-Kontingent für diesen Monat ist aufgebraucht. Nächsten Monat einfach weitermachen."); break; }
      if (!part.chars_missing || !s.translated_lines) { message = "Fertig."; break; }
      if (trStop) { message = "Angehalten."; break; }
    }
  } catch (err) {
    message = `Fehler: ${err.message}`;
  }
  if (skipped) message += ` ${t("{n} Zeilen hat DeepL abgelehnt; sie bleiben englisch und lassen sich mit ✎ von Hand übersetzen.", { n: skipped })}`;
  trRunning = false;
  stopBtn.hidden = true;
  progress.textContent = `${progress.textContent}\n${message} ${t("Die deutschen Texte sind ab sofort in der Bibliothek und im nächsten Export für die Charaktererstellung.")}`;
  await trRefreshStatus();
  await trReload();
}

document.getElementById("btn-tr-standard")?.addEventListener("click", () => trRun("standard"));
document.getElementById("btn-tr-all")?.addEventListener("click", () => {
  if (confirm(t("Auch alle Zusatzbücher übersetzen? Das sind deutlich mehr Zeichen und braucht das Gratis-Kontingent mehrerer Monate."))) trRun("all");
});
document.getElementById("btn-tr-stop")?.addEventListener("click", () => { trStop = true; });
// Status whenever the setup drawer opens.
document.getElementById("btn-setup")?.addEventListener("click", () => setTimeout(trRefreshStatus, 0));
