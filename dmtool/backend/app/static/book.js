// Adventure chapters from D&D Beyond into the open campaign (book_import.py): paste what the
// "📋 DDB kopieren" bookmarklet copied, or pick the saved page ("Webseite, komplett") together with
// the map files from its "_files" folder. The preview lists every heading with what it becomes.
// With ctx.intro ({id, title}) a book's introduction ("Campaign Overview") goes into that entry, the
// campaign's Kapitel "Kapitel 0: Einleitung".

const USES = [
  ["session", t("📅 Session (geplant)")], ["location", t("📑 Kapitel-Abschnitt")], ["place", t("🏰 Ort")], ["npc", "👤 NPC"], ["faction", t("⚑ Fraktion")], ["item", t("💎 Gegenstand")],
  ["quest", t("❗ Quest")], ["handout", t("📽 Handout")], ["merge", t("↳ Text im Eintrag darüber")], ["skip", t("– weglassen")],
];
// Only for a heading with a stat block or a magic item (the appendices): into the library, for all campaigns.
const LIBRARY_USES = { monster: t("🐉 Monster ins Bestiarium"), library_item: t("📚 Gegenstand in die Bibliothek") };
// Rows that become something of their own (with a name and a target); the session is one too.
const ENTRY_USES = new Set(["session", "location", "place", "npc", "faction", "item", "quest", "handout", ...Object.keys(LIBRARY_USES)]);

const usesFor = (r) => [
  ...(r.monster ? [["monster", LIBRARY_USES.monster]] : []),
  ...(r.item ? [["library_item", LIBRARY_USES.library_item]] : []),
  ...USES,
];

// One line under the heading: what the stat block or the item holds.
function libraryInfo(h, r, images) {
  const picNote = (file) => (file ? (images.has(file) ? t(" · 🖼 mit Bild") : ` · ${t("Bild {file} nicht gewählt", { file })}`) : "");
  if (r.monster) {
    const m = r.monster;
    const bits = [m.creature_type, m.challenge_rating != null && `HG ${m.challenge_rating}`, `RK ${m.ac}`, `TP ${m.max_hp}`];
    return h("div", { class: "small muted" }, "🐉 " + bits.filter(Boolean).join(" · ") + picNote(m.image_file));
  }
  if (r.item) {
    const it = r.item;
    const bits = [it.item_type, it.rarity, it.requires_attunement && "Einstimmung"];
    return h("div", { class: "small muted" }, "📚 " + bits.filter(Boolean).join(" · ") + picNote(it.image_file));
  }
  return null;
}

// ctx: { api(method, url, body), h, toast, campaign, openModal, closeModal, reload, intro? }
export function openBookImport(ctx) {
  const { h, api, toast, intro } = ctx;
  let page = null;
  let images = new Map(); // file name -> File (map images picked with the saved page)
  const status = h("span", { class: "muted small" });
  const translateBox = h("input", { type: "checkbox" });
  const paste = h("textarea", { rows: 2, placeholder: t("Hier einfügen (Strg+V)") });
  const files = h("input", { type: "file", multiple: true, accept: ".html,.htm,text/html,image/*" });
  const results = h("div", { class: "book-results" });

  const read = async () => {
    let html = paste.value.trim();
    images = new Map();
    for (const f of files.files) {
      if (/\.html?$/i.test(f.name)) html = (html ? html + "\n" : "") + (await f.text());
      else images.set(f.name, f);
    }
    if (!html) return toast(t("Erst das Kapitel einfügen oder die gespeicherte Seite wählen."), true);
    status.textContent = t("Wird gelesen …");
    try {
      page = await api("POST", "/api/book/parse", { campaign_id: ctx.campaign.id, html, intro_entry_id: intro?.id ?? null });
    } catch {
      status.textContent = "";
      return;
    }
    status.textContent = `${page.title || page.chapter || t("Kapitel")}: ${tn(page.rows.length, "{n} Überschrift", "{n} Überschriften")}`;
    render();
  };

  const targetOptions = (r) => {
    if (r.use in LIBRARY_USES) {
      const where = r.use === "monster" ? t("im Bestiarium") : t("in der Bibliothek");
      return [h("option", { value: "" }, t("neu anlegen")),
        ...(r.library ? [h("option", { value: String(r.library.id), selected: r.library.id === r.target_id },
          `„${r.library.name}“ ${where} ersetzen`)] : [])];
    }
    const same = r.use === "session" ? page.sessions : page.entries.filter((e) => e.type === r.use);
    return [h("option", { value: "" }, t("neu anlegen")),
      ...same.map((e) => h("option", { value: String(e.id), selected: e.id === r.target_id }, `in „${e.name}“`))];
  };

  const render = () => {
    const body = h("tbody");
    page.rows.forEach((r) => {
      // The introduction's heading always goes into its chapter.
      const use = r.use === "intro" ? h("span", {}, t("📑 dieses Kapitel"))
        : h("select", { onchange: (ev) => { r.use = ev.target.value; r.target_id = null; render(); } },
          usesFor(r).map(([v, l]) => h("option", { value: v, selected: v === r.use }, l)));
      const isEntry = ENTRY_USES.has(r.use);
      const name = isEntry ? h("input", { type: "text", value: r.name, oninput: (ev) => { r.name = ev.target.value; } }) : "";
      const target = isEntry
        ? h("select", { onchange: (ev) => { r.target_id = ev.target.value ? Number(ev.target.value) : null; } }, targetOptions(r))
        : h("span", { class: "muted small" }, r.use === "merge" ? t("als Zwischentitel") : r.use === "intro" ? t("in „{title}“", { title: intro.title }) : "");
      const maps = r.maps.map((m) => h("div", { class: "small " + (images.has(m.file) ? "" : "muted") },
        images.has(m.file) ? `🗺 ${t("Karte „{title}“ wird Handout und Bild", { title: m.title })}` : `🗺 ${t("Karte „{title}“: Datei {file} nicht gewählt", { title: m.title, file: m.file })}`));
      // An introduction's pictures: in the text where they stand, or the faction's picture.
      for (const i of r.pictures || []) {
        const p = page.pictures[i];
        const what = p.title ? t("Bild „{title}“", { title: p.title }) : t("Bild");
        const own = i === r.picture && isEntry && r.use !== "session" && r.use !== "location";
        maps.push(h("div", { class: "small " + (images.has(p.file) ? "" : "muted") },
          !images.has(p.file) ? `🖼 ${t("{what}: Datei {file} nicht gewählt", { what, file: p.file })}` : own ? `🖼 ${t("{what} wird Bild des Eintrags", { what })}` : `🖼 ${t("{what} im Text", { what })}`));
      }
      body.append(h("tr", { class: `lvl${r.level}${isEntry ? "" : " book-text"}` },
        h("td", { class: "book-title", style: `padding-left:${(r.level - 1) * 18 + 4}px` },
          h("span", {}, r.title), r.imported_id ? h("span", { class: "badge" }, t("schon importiert"))
            : r.library ? h("span", { class: "badge" }, r.monster ? t("schon im Bestiarium") : t("schon in der Bibliothek")) : null,
          libraryInfo(h, r, images), ...maps),
        h("td", {}, use), h("td", {}, name), h("td", {}, target)));
    });
    const explain = intro
      ? h("p", { class: "muted small" }, t("Der Text kommt in die Beschreibung von „{title}“, mit den Überschriften ", { title: intro.title }),
        t("des Buchs als Zwischentitel, darunter Verweise auf die Fraktionen und NPCs, die du hier als eigene Einträge anlegst. "),
        t("Vorgeschlagen sind die Fraktionen und Verbündeten unter „Campaign Villains/Allies“; jede Zeile lässt sich ändern. "),
        t("Bilder stehen im Text an ihrer Stelle; das Wappen direkt unter einer Fraktion wird ihr Bild. Steht schon etwas "),
        t("in der Beschreibung, kommt der Buchtext darunter."))
      : null;
    results.replaceChildren(
      explain || h("p", { class: "muted small" }, t("Das Kapitel wird eine geplante Session: ihre Vorbereitung bekommt den Einstiegstext und "),
        t("Verweise auf alle Abschnitte, Orte, NPCs, Quests und Karten des Kapitels. Alles bleibt für die Spieler unbekannt, bis du es "),
        t("freigibst. In einen vorhandenen Eintrag kommt der Buchtext unter deinen eigenen; Bild und „Liegt in“ nur, wenn er "),
        t("noch keine hat. Werteblöcke und magische Gegenstände (die Anhänge) gehen ins Bestiarium und in die Bibliothek, für "),
        t("alle Kampagnen; was dort schon so heisst, bleibt, ausser du wählst „ersetzen“.")),
      h("div", { class: "book-table-wrap" }, h("table", { class: "book-table" },
        h("thead", {}, h("tr", {}, h("th", {}, t("Im Buch")), h("th", {}, "wird"), h("th", {}, t("Name")), h("th", {}, t("Ziel")))), body)),
      h("div", { class: "modal-actions" },
        ctx.translate ? h("label", { class: "muted small", style: "margin-right:auto" }, translateBox,
          t(" danach auf Deutsch übersetzen (DeepL, Original bleibt erhalten)")) : null,
        h("button", { onclick: ctx.closeModal }, t("Abbrechen")),
        h("button", { class: "primary", onclick: doImport }, t("Importieren"))));
  };

  const doImport = async (ev) => {
    const btn = ev.target;
    const entryRows = page.rows.filter((r) => ENTRY_USES.has(r.use));
    if (entryRows.some((r) => !r.name.trim())) return toast(t("Jeder Eintrag braucht einen Namen."), true);
    btn.disabled = true;
    try {
      // The maps that came with the saved page: uploaded once each, then named in their row.
      const urls = new Map();
      for (const r of page.rows) {
        for (const m of r.maps) {
          const f = images.get(m.file);
          if (!f) continue;
          if (!urls.has(m.file)) {
            const resp = await fetch(`/api/uploads?filename=${encodeURIComponent(f.name)}`, { method: "POST", body: f });
            if (!resp.ok) throw new Error(t("Karte {name} nicht hochgeladen", { name: f.name }));
            urls.set(m.file, (await resp.json()).url);
          }
          m.url = urls.get(m.file);
        }
      }
      // An introduction's pictures, likewise.
      for (const p of page.pictures || []) {
        const f = images.get(p.file);
        if (!f) continue;
        if (!urls.has(p.file)) {
          const resp = await fetch(`/api/uploads?filename=${encodeURIComponent(f.name)}`, { method: "POST", body: f });
          if (!resp.ok) throw new Error(t("Bild {name} nicht hochgeladen", { name: f.name }));
          urls.set(p.file, (await resp.json()).url);
        }
        p.url = urls.get(p.file);
      }
      for (const r of page.rows) {
        // A creature's or an item's picture from the saved page.
        const file = r.use === "monster" ? r.monster?.image_file : r.use === "library_item" ? r.item?.image_file : null;
        const pic = file && images.get(file);
        if (pic) {
          const resp = await fetch(`/api/uploads?filename=${encodeURIComponent(pic.name)}`, { method: "POST", body: pic });
          if (!resp.ok) throw new Error(t("Bild {name} nicht hochgeladen", { name: pic.name }));
          r.image_url = (await resp.json()).url;
        }
      }
      const res = await api("POST", "/api/book/import", {
        campaign_id: ctx.campaign.id, chapter: page.chapter, book: page.book, rows: page.rows, pictures: page.pictures || [],
      });
      let note = "";
      if (translateBox.checked && ctx.translate) {
        btn.textContent = t("Wird übersetzt …");
        const tr = await ctx.translate({ entry_ids: res.ids, session_ids: res.sessions, monster_ids: res.monsters },
          (r) => { btn.textContent = t("Übersetzt: {n} Texte …", { n: r.done }); });
        note = ` ${t("{n} auf Deutsch übersetzt.", { n: tr.done })} ${tr.message}`;
      }
      ctx.closeModal();
      const parts = [res.imported && t("{n} Einträge importiert oder ergänzt", { n: res.imported }), res.sessions.length && tn(res.sessions.length, "{n} Session", "{n} Sessions"),
        res.monsters.length && t("{n} Monster ins Bestiarium", { n: res.monsters.length }), res.items.length && t("{n} Gegenstände in die Bibliothek", { n: res.items.length })];
      toast((parts.filter(Boolean).join(", ") || t("Nichts importiert")) + "." + note);
      await ctx.reload();
    } catch (err) {
      btn.disabled = false;
      toast(err.message || t("Import fehlgeschlagen."), true);
    }
  };

  const help = intro
    ? h("p", { class: "muted small" }, t("Auf D&D Beyond angemeldet die Einleitung des Buchs öffnen (z.B. "),
      h("code", {}, "dndbeyond.com/sources/dnd/tod/campaign-overview"), t(") und mit dem Lesezeichen „📋 DDB kopieren“ "),
      t("kopieren, oder die Seite mit Strg+S als „Webseite, komplett“ speichern und hier die .html-Datei zusammen mit den "),
      t("Bildern aus dem Ordner „…_files“ wählen (nur so kommen die Bilder mit)."))
    : null;
  ctx.openModal(h("div", {},
    h("h2", {}, intro ? t("Einleitung von D&D Beyond → {title}", { title: intro.title }) : t("Kapitel von D&D Beyond → {name}", { name: ctx.campaign.name })),
    help || h("p", { class: "muted small" }, t("Auf D&D Beyond angemeldet eine Kapitelseite des Buchs öffnen (z.B. "),
      h("code", {}, "dndbeyond.com/sources/dnd/lmop/goblin-arrows"), t("), das Lesezeichen „📋 DDB kopieren“ anklicken "),
      t("(aus Bibliothek → Unterklassen → D&D Beyond-Import) und hier einfügen. Die Anhänge (z.B. "),
      h("code", {}, "…/lmop/appendix-b-monsters"), t(") bringen Monster und magische Gegenstände. Karten und Monsterbilder "),
      t("kommen nur mit der gespeicherten Seite: Strg+S „Webseite, komplett“, dann die .html-Datei und die Bilder aus dem "),
      t("Ordner „…_files“ zusammen wählen.")),
    h("div", { class: "row" }, paste),
    h("div", { class: "row" }, files, h("button", { onclick: read }, t("Lesen")), status),
    results), { wide: true });
}
