// UI language. German is written directly in the code and is its own key: t("Speichern") gives
// "Speichern" in German and the entry of lang/en.json in English. The language is set in one place,
// UI_LANG in the .env (de or en). Pages load ui-lang.js (i18n.py), which is this file with the
// language and its texts in front:
//   window.UI_LANG = "en"; window.UI_DICT = {...};   (UI_DICT only for a language other than German)
//
//   t("Stufe {n} erreicht.", { n: 3 })   placeholders in braces, the values are inserted as they are
//                                        (escape them first where the result goes into HTML)
//   tn(n, "{n} Fertigkeit", "{n} Fertigkeiten")   a counted word: the first for n = 1, the second otherwise
//   localized(en, de)                    content that exists in both (desc / desc_de): the one of the UI
//
// Static HTML needs no markup: on load every text node and placeholder/title/aria-label/alt whose
// text is a key gets translated. Keys are compared trimmed, the surrounding whitespace stays.
// tools/check-i18n.py lists the t("…") strings and HTML texts without an English entry.
(function () {
  const lang = window.UI_LANG || "de";
  const dict = (lang !== "de" && window.UI_DICT) || {};
  const LOCALES = { de: "de-CH", en: "en-US" };

  function t(text, vars) {
    let out = (Object.prototype.hasOwnProperty.call(dict, text) && dict[text]) || text;
    if (vars) out = out.replace(/\{(\w+)\}/g, (m, k) => (k in vars && vars[k] != null ? String(vars[k]) : m));
    return out;
  }

  const ATTRS = ["placeholder", "title", "aria-label", "alt"];

  function translateText(s) {
    const key = s.trim();
    if (!key || !Object.prototype.hasOwnProperty.call(dict, key) || !dict[key]) return null;
    return s.replace(key, dict[key]);
  }

  // Translates static markup in place; a no-op in German.
  function translatePage(root) {
    if (lang === "de" || !root) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentNode && /^(SCRIPT|STYLE)$/.test(n.parentNode.nodeName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const out = translateText(n.nodeValue);
      if (out !== null) n.nodeValue = out;
    }
    const sel = ATTRS.map((a) => `[${a}]`).join(",");
    const els = root.querySelectorAll ? [...(root.matches && root.matches(sel) ? [root] : []), ...root.querySelectorAll(sel)] : [];
    for (const el of els) {
      for (const a of ATTRS) {
        const v = el.getAttribute(a);
        const out = v == null ? null : translateText(v);
        if (out !== null) el.setAttribute(a, out);
      }
    }
  }

  window.t = t;
  // Marks a German text that is kept as it is (a key, stored data) and translated where it is shown,
  // with t(value); tools/check-i18n.py finds it like t("…").
  window.tk = (text) => text;
  // The same German word with two meanings ("Laden": loading a weapon, a shop): the entry "Ort|Laden".
  window.tc = (ctx, text, vars) => {
    const key = `${ctx}|${text}`;
    return Object.prototype.hasOwnProperty.call(dict, key) && dict[key] ? t(key, vars) : t(text, vars);
  };
  window.UI_DE = lang === "de";
  // Where German has one form for both ("{n} Zauber"), the entry holds both: "{n} spell|{n} spells".
  window.tn = (n, one, many, vars) => {
    const forms = t(n === 1 ? one : many, { n, ...vars }).split("|");
    return forms[n === 1 || forms.length === 1 ? 0 : 1];
  };
  window.translatePage = translatePage;
  window.UI_LOCALE = LOCALES[lang] || lang;
  window.localized = (en, de) => (lang === "de" ? de || en : en || de);

  document.documentElement.lang = lang;
  // Parts that only make sense in German (the DeepL translation of the library) carry data-only-de.
  if (lang !== "de") document.querySelectorAll("[data-only-de]").forEach((el) => { el.hidden = true; });
  if (lang !== "de") {
    document.title = t(document.title);
    translatePage(document.body);
  }

  // The language switch at the end of the page header: the choice is kept per browser in the cookie
  // ui_lang (the server reads it too, for its messages); without one UI_LANG applies. Pages without a
  // header (beamer, displays) have none; data-no-lang-switch on <body> leaves it out as well.
  function langSwitch() {
    const langs = window.UI_LANGS || {};
    if (Object.keys(langs).length < 2) return null;
    const sel = document.createElement("select");
    sel.className = "ui-lang-switch";
    sel.title = t("Sprache");
    sel.setAttribute("aria-label", t("Sprache"));
    for (const [k, name] of Object.entries(langs)) sel.add(new Option(name, k, false, k === lang));
    sel.addEventListener("change", () => {
      document.cookie = `ui_lang=${encodeURIComponent(sel.value)}; path=/; max-age=31536000; SameSite=Lax`;
      location.reload();
    });
    return sel;
  }
  window.uiLangSwitch = langSwitch;
  const placeSwitch = () => {
    const header = document.querySelector("header");
    if (!header || document.body.hasAttribute("data-no-lang-switch") || header.querySelector(".ui-lang-switch")) return;
    const sel = langSwitch();
    if (!sel) return;
    const style = document.createElement("style");
    style.textContent = ".ui-lang-switch { margin-left: 8px; font-size: 12px; padding: 1px 2px; max-width: 7em; flex-shrink: 0; }";
    document.head.append(style);
    header.append(sel);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", placeSwitch);
  else placeSwitch();
})();
