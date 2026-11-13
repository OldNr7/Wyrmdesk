"""UI language: the default is UI_LANG (de, the default, or en); every browser can pick another one
with the switch in the page header (cookie ui_lang), see shared_static/i18n.js.

German is written in the code and is its own key; the other languages' texts are in
  lang/<lang>.json                  this service's pages and messages
  shared_static/lang/<lang>.json    the files shared with the Kampagnenbuch (tools/check-shared.sh)

Every page loads ui-lang.js first (setup): the language of this request, its texts and the code of
i18n.js in one. Server messages (t) follow the language of the request as well.
"""
import json
import os
from contextvars import ContextVar
from pathlib import Path

APP_DIR = Path(__file__).parent
UI_LANG = (os.environ.get("UI_LANG") or "de").strip().lower()
COOKIE = "ui_lang"
NAMES = {"de": "Deutsch", "en": "English"}


def _load(lang: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for path in (APP_DIR / "shared_static" / "lang" / f"{lang}.json", APP_DIR / "lang" / f"{lang}.json"):
        if path.exists():
            out.update(json.loads(path.read_text(encoding="utf-8")))
    return out


# German needs no dictionary; every language with a lang file can be chosen.
LANGS = ["de"] + sorted({p.stem for p in [*APP_DIR.glob("lang/*.json"), *APP_DIR.glob("shared_static/lang/*.json")]} - {"de"})
if UI_LANG not in LANGS:
    UI_LANG = "de"
DICTS = {lang: _load(lang) for lang in LANGS if lang != "de"}
_current: ContextVar[str] = ContextVar("ui_lang", default=UI_LANG)


def lang() -> str:
    """The language of the current request (cookie), else UI_LANG."""
    return _current.get()


def t(text: str, **values) -> str:
    out = DICTS.get(lang(), {}).get(text) or text
    return out.format(**values) if values else out


def ui_lang_js() -> str:
    """The script ui-lang.js: the language, for a language other than German its texts, then i18n.js."""
    current = lang()
    js = (f"window.UI_LANG = {json.dumps(current)};\n"
          f"window.UI_LANGS = {json.dumps({k: NAMES.get(k, k) for k in LANGS}, ensure_ascii=False)};\n")
    if current in DICTS:
        js += f"window.UI_DICT = {json.dumps(DICTS[current], ensure_ascii=False)};\n"
    return js + (APP_DIR / "shared_static" / "i18n.js").read_text(encoding="utf-8")


def setup(app) -> None:
    """GET ui-lang.js on this app (pages load it relative to themselves, before any other script), and
    the language of each request from the cookie."""
    from fastapi import Request
    from fastapi.responses import Response

    @app.middleware("http")
    async def request_lang(request: Request, call_next):
        chosen = request.cookies.get(COOKIE)
        token = _current.set(chosen if chosen in LANGS else UI_LANG)
        try:
            return await call_next(request)
        finally:
            _current.reset(token)

    @app.get("/ui-lang.js", include_in_schema=False)
    def ui_lang():
        return Response(ui_lang_js(), media_type="text/javascript; charset=utf-8")
