// Text editor in two flavours: "rich" (formatting toolbar, what you see is what you get)
// and "markdown" (plain text). Both store Markdown, so switching never loses anything.
// Typing [[ suggests entries to link.

const turndown = new window.TurndownService({
  headingStyle: "atx", bulletListMarker: "-", codeBlockStyle: "fenced", emDelimiter: "*", br: "",
});
turndown.addRule("wiki", {
  filter: (node) => node.nodeName === "A" && node.classList.contains("wl"),
  replacement: (_content, node) => {
    const target = node.dataset.name || node.textContent;
    const label = node.textContent;
    return label === target ? `[[${target}]]` : `[[${target}|${label}]]`;
  },
});

export function htmlToMarkdown(html) {
  // Turndown escapes brackets; [[links]] typed by hand should stay links.
  return turndown.turndown(html)
    .replace(/\\\[\\\[/g, "[[").replace(/\\\]\\\]/g, "]]")
    .replace(/ /g, " ")
    // "-   item" -> "- item", easier to read in the Markdown editor.
    .replace(/^(\s*)([-*]|\d+\.) {2,}/gm, "$1$2 ")
    .trim();
}

const LINK_TRIGGER = /\[\[([^[\]\n]*)$/;

function button(label, title, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.innerHTML = label;
  b.title = title;
  b.addEventListener("mousedown", (e) => e.preventDefault()); // keep the text selection
  b.addEventListener("click", onClick);
  return b;
}

// Suggestion list for [[links]]; items are {name, hint}.
function createSuggest(container, onPick) {
  const list = document.createElement("ul");
  list.className = "suggest";
  list.hidden = true;
  container.append(list);
  let items = [];
  let index = 0;
  function draw() {
    list.innerHTML = "";
    items.forEach((it, i) => {
      const li = document.createElement("li");
      li.className = i === index ? "on" : "";
      li.innerHTML = `<span></span><span class="muted small"></span>`;
      li.firstChild.textContent = it.name;
      li.lastChild.textContent = it.hint || "";
      li.addEventListener("mousedown", (e) => { e.preventDefault(); onPick(it); });
      list.append(li);
    });
  }
  return {
    get visible() { return !list.hidden; },
    show(newItems, x, y) {
      items = newItems;
      index = 0;
      list.style.left = `${x}px`;
      list.style.top = `${y}px`;
      list.hidden = items.length === 0;
      draw();
    },
    hide() { list.hidden = true; },
    key(e) {
      if (list.hidden) return false;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        index = (index + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        draw();
      } else if (e.key === "Enter" || e.key === "Tab") {
        onPick(items[index]);
      } else if (e.key === "Escape") {
        list.hidden = true;
      } else {
        return false;
      }
      e.preventDefault();
      return true;
    },
  };
}

function suggestionsFor(suggest, typed) {
  const items = suggest(typed);
  if (typed.trim() && !items.some((it) => it.name.toLowerCase() === typed.trim().toLowerCase())) {
    items.push({ name: typed.trim(), hint: t("neu verknüpfen") });
  }
  return items;
}

function imageFiles(dataTransfer) {
  return [...(dataTransfer?.files || [])].filter((f) => f.type.startsWith("image/"));
}

export function createEditor({ mode, value, render, onChange, suggest, upload, placeholder = "" }) {
  const wrap = document.createElement("div");
  wrap.className = `editor ${mode}`;
  const toolbar = document.createElement("div");
  toolbar.className = "editor-toolbar";
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = "image/*";
  fileInput.hidden = true;
  wrap.append(toolbar, fileInput);
  return mode === "markdown"
    ? markdownEditor({ wrap, toolbar, fileInput, value, onChange, suggest, upload, placeholder })
    : richEditor({ wrap, toolbar, fileInput, value, render, onChange, suggest, upload, placeholder });
}

function richEditor({ wrap, toolbar, fileInput, value, render, onChange, suggest, upload, placeholder }) {
  const area = document.createElement("div");
  area.className = "prose editable";
  area.contentEditable = "true";
  area.dataset.placeholder = placeholder;
  area.innerHTML = value ? render(value) : "";
  const lockLinks = () => area.querySelectorAll("a.wl").forEach((a) => { a.contentEditable = "false"; });
  lockLinks();
  wrap.append(area);
  document.execCommand("defaultParagraphSeparator", false, "p");

  const changed = () => onChange(htmlToMarkdown(area.innerHTML));
  const exec = (cmd, arg) => { area.focus(); document.execCommand(cmd, false, arg); changed(); };
  const block = (tag) => {
    const current = document.queryCommandValue("formatBlock").toLowerCase();
    exec("formatBlock", current === tag ? "p" : tag);
  };
  let linkRange = null;
  const sug = createSuggest(wrap, (item) => insertLink(item.name));

  function insertLink(name) {
    sug.hide();
    if (!linkRange) return;
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(linkRange);
    linkRange.deleteContents();
    const a = document.createElement("a");
    a.className = "wl";
    a.href = "#";
    a.dataset.name = name;
    a.textContent = name;
    a.contentEditable = "false";
    const space = document.createTextNode(" ");
    linkRange.insertNode(space);
    linkRange.insertNode(a);
    const after = document.createRange();
    after.setStartAfter(space);
    sel.removeAllRanges();
    sel.addRange(after);
    linkRange = null;
    changed();
  }

  function checkTrigger() {
    const sel = getSelection();
    const node = sel.anchorNode;
    if (!sel.isCollapsed || !node || node.nodeType !== 3 || !area.contains(node)) return sug.hide();
    const m = LINK_TRIGGER.exec(node.data.slice(0, sel.anchorOffset));
    if (!m) return sug.hide();
    linkRange = document.createRange();
    linkRange.setStart(node, sel.anchorOffset - m[0].length);
    linkRange.setEnd(node, sel.anchorOffset);
    const r = linkRange.getBoundingClientRect();
    const w = wrap.getBoundingClientRect();
    sug.show(suggestionsFor(suggest, m[1]), r.left - w.left, r.bottom - w.top + 4);
  }

  async function insertImages(files) {
    for (const f of files) {
      const url = await upload(f);
      exec("insertImage", url);
    }
  }

  toolbar.append(
    button(`<b>${t("F")}</b>`, t("Fett (Strg+B)"), () => exec("bold")),
    button(`<i>${tc("Editor", "K")}</i>`, t("Kursiv (Strg+I)"), () => exec("italic")),
    button(t("Ü1"), t("Überschrift"), () => block("h2")),
    button(t("Ü2"), t("Zwischentitel"), () => block("h3")),
    button(t("• Liste"), t("Aufzählung"), () => exec("insertUnorderedList")),
    button(t("1. Liste"), t("Nummerierte Liste"), () => exec("insertOrderedList")),
    button("❝", t("Zitat, Vorlesetext"), () => block("blockquote")),
    button("[[ ]]", t("Mit Eintrag verknüpfen (oder [[ tippen)"), () => {
      area.focus();
      document.execCommand("insertText", false, "[[");
      checkTrigger();
    }),
    button("🖼", t("Bild einfügen"), () => fileInput.click()),
  );
  fileInput.addEventListener("change", () => { insertImages([...fileInput.files]); fileInput.value = ""; });
  area.addEventListener("input", () => { changed(); checkTrigger(); });
  area.addEventListener("keydown", (e) => { sug.key(e); });
  area.addEventListener("blur", () => sug.hide());
  area.addEventListener("paste", (e) => {
    const files = imageFiles(e.clipboardData);
    if (files.length) {
      e.preventDefault();
      insertImages(files);
      return;
    }
    // Pasted web pages bring their own styles; keep only the text structure.
    const html = e.clipboardData.getData("text/html");
    if (html) {
      e.preventDefault();
      document.execCommand("insertHTML", false, render(htmlToMarkdown(html)));
      lockLinks();
      changed();
    }
  });
  area.addEventListener("drop", (e) => {
    const files = imageFiles(e.dataTransfer);
    if (files.length) { e.preventDefault(); insertImages(files); }
  });
  area.addEventListener("click", (e) => { if (e.target.closest("a")) e.preventDefault(); });

  return { el: wrap, value: () => htmlToMarkdown(area.innerHTML), focus: () => area.focus() };
}

function markdownEditor({ wrap, toolbar, fileInput, value, onChange, suggest, upload, placeholder }) {
  const ta = document.createElement("textarea");
  ta.className = "md-text";
  ta.placeholder = placeholder;
  ta.value = value || "";
  ta.spellcheck = true;
  wrap.append(ta);
  const grow = () => { ta.style.height = "auto"; ta.style.height = `${Math.max(ta.scrollHeight + 2, 90)}px`; };
  const changed = () => { grow(); onChange(ta.value); };
  requestAnimationFrame(grow);

  function replace(start, end, text, selStart = start + text.length, selEnd = selStart) {
    ta.focus();
    ta.setRangeText(text, start, end);
    ta.setSelectionRange(selStart, selEnd);
    changed();
  }
  function wrapSel(mark) {
    const { selectionStart: s, selectionEnd: e, value: v } = ta;
    const inner = v.slice(s, e) || t("Text");
    replace(s, e, mark + inner + mark, s + mark.length, s + mark.length + inner.length);
  }
  function prefixLines(prefix) {
    const v = ta.value;
    const s = v.lastIndexOf("\n", ta.selectionStart - 1) + 1;
    let e = v.indexOf("\n", ta.selectionEnd);
    if (e < 0) e = v.length;
    const lines = v.slice(s, e).split("\n");
    const numbered = prefix === "1. ";
    const done = lines.every((l, i) => l.startsWith(numbered ? `${i + 1}. ` : prefix));
    const out = lines.map((l, i) => {
      const p = numbered ? `${i + 1}. ` : prefix;
      return done ? l.slice(p.length) : p + l;
    }).join("\n");
    replace(s, e, out, s, s + out.length);
  }

  let linkStart = -1;
  const sug = createSuggest(wrap, (item) => {
    sug.hide();
    if (linkStart < 0) return;
    replace(linkStart, ta.selectionStart, `[[${item.name}]]`);
    linkStart = -1;
  });
  function checkTrigger() {
    if (ta.selectionStart !== ta.selectionEnd) return sug.hide();
    const m = LINK_TRIGGER.exec(ta.value.slice(0, ta.selectionStart));
    if (!m) return sug.hide();
    linkStart = ta.selectionStart - m[0].length;
    sug.show(suggestionsFor(suggest, m[1]), 8, ta.offsetTop + ta.offsetHeight + 4);
  }

  async function insertImages(files) {
    for (const f of files) {
      const url = await upload(f);
      replace(ta.selectionStart, ta.selectionEnd, `![](${url})\n`);
    }
  }

  toolbar.append(
    button(`<b>${t("F")}</b>`, t("Fett: **Text**"), () => wrapSel("**")),
    button(`<i>${tc("Editor", "K")}</i>`, t("Kursiv: *Text*"), () => wrapSel("*")),
    button(t("Ü1"), t("Überschrift: ## "), () => prefixLines("## ")),
    button(t("Ü2"), t("Zwischentitel: ### "), () => prefixLines("### ")),
    button(t("• Liste"), t("Aufzählung: - "), () => prefixLines("- ")),
    button(t("1. Liste"), t("Nummerierte Liste: 1. "), () => prefixLines("1. ")),
    button("❝", t("Zitat, Vorlesetext: > "), () => prefixLines("> ")),
    button("[[ ]]", t("Mit Eintrag verknüpfen: [[Name]]"), () => {
      replace(ta.selectionStart, ta.selectionEnd, "[[");
      checkTrigger();
    }),
    button("🖼", t("Bild einfügen"), () => fileInput.click()),
  );
  fileInput.addEventListener("change", () => { insertImages([...fileInput.files]); fileInput.value = ""; });
  ta.addEventListener("input", () => { changed(); checkTrigger(); });
  ta.addEventListener("keydown", (e) => { sug.key(e); });
  ta.addEventListener("blur", () => sug.hide());
  ta.addEventListener("paste", (e) => {
    const files = imageFiles(e.clipboardData);
    if (files.length) { e.preventDefault(); insertImages(files); }
  });
  ta.addEventListener("drop", (e) => {
    const files = imageFiles(e.dataTransfer);
    if (files.length) { e.preventDefault(); insertImages(files); }
  });

  return { el: wrap, value: () => ta.value, focus: () => ta.focus() };
}
