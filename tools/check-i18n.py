# UI texts without a translation. German is written in the code and is its own key (see
# shared_static/i18n.js); this finds every t("…") in the JS/Python of a service and the texts of its
# static HTML pages, and checks them against lang/<lang>.json and shared_static/lang/<lang>.json.
#
#   python tools/check-i18n.py               report missing (and unused) entries, exit 1 if any are missing
#   python tools/check-i18n.py --add         also add the missing ones with an empty value, to fill in
#   python tools/check-i18n.py --lang fr     another language than en
#
# Only literal strings are found: t(variable) is translated at runtime but not checked here. Keys of
# the files shared with the Kampagnenbuch (SHARED_FILES, see check-shared.sh) belong in
# shared_static/lang, all others in the service's own lang/. An empty value counts as missing and
# shows the German text. In Python the function is imported as _t (a loop variable t would hide it).
import json
import re
import sys
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SERVICES = {"charcreator": ROOT / "charcreator/backend/app", "dmtool": ROOT / "dmtool/backend/app"}
SHARED_FILES = {"charsheet.js", "charsheet-rules.js", "levelup.js", "i18n.js"}
# handbuch_static: the handbook has its own page per language (de/, en/), not t() texts.
SKIP_DIRS = {"vendor", "__pycache__", "lang", "handbuch_static"}

CALL = re.compile(r'(?<![\w.$])(?:window\.)?(?:t|tk|_t|calT)\(\s*"((?:[^"\\]|\\.)*)"')
# tn(n, "{n} Fertigkeit", "{n} Fertigkeiten"): both forms.
CALL_N = re.compile(r'(?<![\w.$])(?:window\.)?tn\([^,]+,\s*"((?:[^"\\]|\\.)*)",\s*"((?:[^"\\]|\\.)*)"')
# tc("Ort", "Laden"): a word with two meanings, key "Ort|Laden".
CALL_C = re.compile(r'(?<![\w.$])tc\(\s*"([^"]+)",\s*"((?:[^"\\]|\\.)*)"')
HTML_ATTRS = {"placeholder", "title", "aria-label", "alt"}
LETTER = re.compile(r"[A-Za-zÄÖÜäöüß]")


class HtmlTexts(HTMLParser):
    def __init__(self):
        super().__init__()
        self.keys, self.skip = [], 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style"):
            self.skip += 1
        for name, value in attrs:
            if name in HTML_ATTRS and value and LETTER.search(value):
                self.keys.append(value.strip())

    def handle_endtag(self, tag):
        if tag in ("script", "style"):
            self.skip -= 1

    def handle_data(self, data):
        if not self.skip and LETTER.search(data):
            self.keys.append(data.strip())


def keys_of(path: Path) -> list[str]:
    text = path.read_text(encoding="utf-8")
    if path.suffix == ".html":
        p = HtmlTexts()
        p.feed(text)
        return p.keys
    # Whole-line comments hold examples, not texts.
    text = "\n".join(l for l in text.split("\n") if not l.lstrip().startswith(("//", "#")))
    found = CALL.findall(text) + [m for pair in CALL_N.findall(text) for m in pair]
    found += [f"{c}|{m}" for c, m in CALL_C.findall(text)]
    return [json.loads(f'"{m}"') for m in found]


def scan(app: Path) -> tuple[dict[str, set], dict[str, set]]:
    """Keys of the shared files and of the service's own, each with the files using it."""
    shared, own = {}, {}
    for path in sorted(app.rglob("*")):
        if path.suffix not in (".js", ".py", ".html") or SKIP_DIRS & set(path.relative_to(app).parts):
            continue
        target = shared if path.name in SHARED_FILES else own
        for k in keys_of(path):
            target.setdefault(k, set()).add(str(path.relative_to(app)))
    # The native app's launcher uses the Kampagnenbuch's texts (lang/en.json there).
    if app == SERVICES["dmtool"]:
        for path in sorted((ROOT / "dmtool/desktop").glob("*.py")):
            for k in keys_of(path):
                own.setdefault(k, set()).add(str(path.relative_to(ROOT)))
    return shared, own


def load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}


def save(path: Path, d: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes((json.dumps(d, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    lang = sys.argv[sys.argv.index("--lang") + 1] if "--lang" in sys.argv else "en"
    add = "--add" in sys.argv
    status = 0
    for name, app in SERVICES.items():
        shared_keys, own_keys = scan(app)
        files = {"shared": app / "shared_static/lang" / f"{lang}.json", "own": app / "lang" / f"{lang}.json"}
        dicts = {k: load(p) for k, p in files.items()}
        merged = {**dicts["shared"], **dicts["own"]}
        # The Kampagnenbuch loads the shared dictionary only: texts of the shared files must be in there.
        for part, keys, have in (("shared", shared_keys, dicts["shared"]), ("own", own_keys, merged)):
            missing = [k for k in keys if not have.get(k)]
            if missing:
                status = 1
                print(f"{name}: {len(missing)} ohne Übersetzung ({files[part].relative_to(ROOT)})")
                for k in missing:
                    print(f"  {k!r}  [{', '.join(sorted(keys[k]))}]")
                if add:
                    for k in missing:
                        dicts[part].setdefault(k, "")
                    save(files[part], dicts[part])
        used = set(shared_keys) | set(own_keys)
        for part, keys in (("shared", set(shared_keys)), ("own", used)):
            unused = [k for k in dicts[part] if k not in keys]
            if unused:
                print(f"{name}: {len(unused)} nicht (mehr) verwendet in {files[part].relative_to(ROOT)}")
                for k in unused:
                    print(f"  {k!r}")
        double = [k for k in dicts["own"] if k in dicts["shared"]]
        if double:
            print(f"{name}: {len(double)} doppelt (schon in {files['shared'].relative_to(ROOT)}): {', '.join(map(repr, double))}")
        if not status:
            print(f"{name}: alle {len(used)} Texte übersetzt ({lang}).")
    return status


if __name__ == "__main__":
    sys.exit(main())
