// Markdown rendering with [[wiki links]], shared by the DM view and the handout display.
// Needs vendor/marked.min.js loaded as a classic script (global `marked`).

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// resolve(name) -> true if an entry with that name exists; null renders links as plain text.
export function createRenderer(resolve) {
  const md = new window.marked.Marked({ gfm: true, breaks: true });
  md.use({
    extensions: [{
      name: "wiki",
      level: "inline",
      start(src) {
        const i = src.indexOf("[[");
        return i < 0 ? undefined : i;
      },
      tokenizer(src) {
        const m = /^\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/.exec(src);
        if (m) return { type: "wiki", raw: m[0], target: m[1].trim(), label: (m[2] || m[1]).trim() };
      },
      renderer(tok) {
        if (!resolve) return `<span class="wl">${escapeHtml(tok.label)}</span>`;
        const missing = resolve(tok.target) ? "" : " missing";
        return `<a class="wl${missing}" href="#" data-name="${escapeHtml(tok.target)}">${escapeHtml(tok.label)}</a>`;
      },
    }],
  });
  return (text) => md.parse(text || "");
}
