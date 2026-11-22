"""Native app shell for the Kampagnenbuch (dmtool): runs the exact same backend as the Docker image
(dmtool/backend/app, untouched) locally, then shows it in two windows instead of a browser - one for
the Spielleiter (Kampagnenbuch, Tracker, Battlemap, all under one origin: see app/run.py's
_mount_parts), one for the Beamer, which gets dragged onto the projector/second screen by hand and
fullscreened there. The Spieler view stays a plain web page on the LAN (app/public.py's /spieler/
mount, port 8441) - nothing native involved there, nothing to open here.

No Docker, no separate Python install needed once packaged with PyInstaller (see wyrmdesk.spec).
"""
import asyncio
import html
import os
import socket
import sys
import threading
import time
import traceback
from pathlib import Path

# Dev mode only: make `app` (dmtool/backend/app) importable. Frozen (PyInstaller) builds already have
# it bundled via the spec file's Analysis(pathex=...), set at build time, not at run time.
if not getattr(sys, "frozen", False):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

# Linux build (PyInstaller): GTK, GLib and WebKitGTK are the system's (wyrmdesk.spec leaves them
# out), but PyInstaller's GTK runtime hooks point GTK at the bundle. Undo that before gi is imported.
if getattr(sys, "frozen", False) and sys.platform.startswith("linux"):
    for _var in ("GI_TYPELIB_PATH", "GTK_DATA_PREFIX", "GTK_EXE_PREFIX", "GTK_PATH", "PANGO_LIBDIR",
                 "PANGO_SYSCONFDIR", "GDK_PIXBUF_MODULE_FILE", "GIO_MODULE_DIR"):
        os.environ.pop(_var, None)
    _bundled = os.path.join(sys._MEIPASS, "share")
    os.environ["XDG_DATA_DIRS"] = os.pathsep.join(
        p for p in os.environ.get("XDG_DATA_DIRS", "").split(os.pathsep) if p and p.rstrip("/") != _bundled
    ) or "/usr/local/share:/usr/share"

from appdata import GM_PORT, PUBLIC_PORT, configure_env, data_dir  # noqa: E402 - before any `app.*` import

configure_env(data_dir())

# Windows build without a console window (wyrmdesk.spec): stdout/stderr are None there, which uvicorn's
# logging can't handle. The output goes to wyrmdesk.log in the data folder instead; the one of the run
# before stays as wyrmdesk.log.1 (what to ask for in a bug report).
if sys.stdout is None or sys.stderr is None:
    _log = data_dir() / "wyrmdesk.log"
    try:
        _log.replace(_log.with_name("wyrmdesk.log.1"))
    except OSError:
        pass
    sys.stdout = sys.stderr = open(_log, "w", encoding="utf-8", buffering=1)

import app.run  # noqa: E402
import webview  # noqa: E402
from app.i18n import t as _t  # noqa: E402

# Window/taskbar icon on Linux (GTK/Qt); on Windows it comes from the .exe (icon in wyrmdesk.spec).
ICON = str(Path(app.run.__file__).parent / "shared_static" / "brand" / "wyrmdesk-256.png")

GM_URL = f"http://127.0.0.1:{GM_PORT}/"
BEAMER_URL = f"http://127.0.0.1:{PUBLIC_PORT}/beamer/"
STARTUP_TIMEOUT = 30.0
# Linux: GTK (WebKitGTK) right away; pywebview would try Qt first and log a traceback when it's missing.
GUI = "gtk" if sys.platform.startswith("linux") else None


def _linux_desktop_entry() -> None:
    """Linux: give the windows the Wyrmdesk icon in title bar and taskbar.

    Under Wayland (KDE, GNOME) the window manager ignores the icon set on the window (ICON above); it
    looks up the window's app id in a .desktop file instead. So: name the program "wyrmdesk" (GTK's
    app id) and keep a hidden wyrmdesk.desktop plus the icon in the user's data folders. Rewritten
    only when its content changes (another install path, a new icon)."""
    if not sys.platform.startswith("linux"):
        return
    try:
        from gi.repository import GLib
        GLib.set_prgname("wyrmdesk")
        GLib.set_application_name("Wyrmdesk")
    except Exception:  # no GTK (e.g. Qt): the window icon has to do
        return
    share = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share")
    user_entry = share / "applications" / "wyrmdesk.desktop"
    if getattr(sys, "frozen", False) and Path("/usr/share/applications/wyrmdesk.desktop").exists():
        # Installed as .deb: its menu entry does the job. A hidden one of ours from an earlier dev
        # run or AppImage would hide that entry from the menu (same name), so it goes.
        try:
            if user_entry.exists() and b"NoDisplay=true" in user_entry.read_bytes():
                user_entry.unlink()
        except OSError:
            pass
        return
    if os.environ.get("APPIMAGE"):  # set by the AppImage runtime: the file the user started
        exec_line = f'"{os.environ["APPIMAGE"]}"'
    elif getattr(sys, "frozen", False):
        exec_line = f'"{sys.executable}"'
    else:
        exec_line = f'"{sys.executable}" "{Path(__file__).resolve()}"'
    files = {
        share / "icons" / "hicolor" / "256x256" / "apps" / "wyrmdesk.png": Path(ICON).read_bytes(),
        user_entry: (
            "[Desktop Entry]\nType=Application\nName=Wyrmdesk\nComment=Kampagnenbuch, Combat Tracker, Battlemap\n"
            f"Exec={exec_line}\nIcon=wyrmdesk\nStartupWMClass=wyrmdesk\nTerminal=false\n"
            "Categories=Game;RolePlaying;\nNoDisplay=true\n").encode(),
    }
    for path, content in files.items():
        try:
            if not path.exists() or path.read_bytes() != content:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(content)
        except OSError:
            pass  # read-only home or the like: only the icon is missing


_backend_error: list[str] = []


def _run_backend() -> None:
    try:
        asyncio.run(app.run.main())
    except BaseException:  # uvicorn ends a failed bind with SystemExit
        _backend_error.append(traceback.format_exc())


def _port_taken(port: int) -> bool:
    """Something answers there already (Docker stack, a second copy of this app …), or it can't be bound."""
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.5):
            return True
    except OSError:
        pass
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        # Like uvicorn: closed connections of the last run (TIME_WAIT, about a minute after quitting)
        # don't count as taken, a listening server still does. Not on Windows, where this flag would
        # let the bind take over a port in use.
        if sys.platform != "win32":
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind(("0.0.0.0", port))
        except OSError:
            return True
    return False


def _wait_for(port: int, thread: threading.Thread, deadline: float) -> bool:
    while time.monotonic() < deadline and thread.is_alive():
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                return True
        except OSError:
            time.sleep(0.3)
    return False


class _Fullscreen:
    """Borderless fullscreen for an app window, called from the page (window.pywebview.api).

    In a browser the beamer's click -> requestFullscreen() covers the whole screen; in the app window
    it would only fill the window, title bar and frame stay. FULLSCREEN_JS passes it on to the window,
    plus F11 like in a browser, and Escape to leave."""

    def __init__(self) -> None:
        self._window = None
        self._on = False

    def set(self, on: bool) -> None:
        if bool(on) != self._on and self._window:
            self._on = bool(on)
            self._window.toggle_fullscreen()

    def toggle(self) -> None:
        self.set(not self._on)

    def is_on(self) -> bool:
        return self._on


FULLSCREEN_JS = """
(() => {
  if (window.__wyrmdeskFullscreen) return;
  window.__wyrmdeskFullscreen = true;
  const api = () => window.pywebview && window.pywebview.api;
  document.addEventListener("fullscreenchange", () => api() && api().set(!!document.fullscreenElement));
  document.addEventListener("keydown", async (e) => {
    if (e.key === "F11") { e.preventDefault(); api() && api().toggle(); }
    else if (e.key === "Escape" && !document.fullscreenElement && api() && await api().is_on()) api().set(false);
  });
})();
"""


def _app_window(title: str, url: str, width: int, height: int):
    """A window of the app with F11/borderless fullscreen (see _Fullscreen)."""
    fs = _Fullscreen()
    window = webview.create_window(title, url, width=width, height=height, js_api=fs)
    fs._window = window
    window.events.loaded += lambda: window.evaluate_js(FULLSCREEN_JS)
    return window


def _show_error(message: str, details: str = "") -> None:
    title = _t("Wyrmdesk konnte nicht starten.")
    body = f"<h2>{html.escape(title)}</h2><p>{html.escape(message)}</p>"
    if details:
        body += f"<pre>{html.escape(details)}</pre>"
    page = ("<html><body style='font-family:sans-serif;margin:2em'>"
            "<style>pre{white-space:pre-wrap;font-size:12px;background:#eee;padding:1em}</style>"
            f"{body}</body></html>")
    webview.create_window("Wyrmdesk", html=page, width=800, height=500)
    webview.start(icon=ICON, gui=GUI)
    sys.exit(1)


def main() -> None:
    _linux_desktop_entry()
    taken = [p for p in (GM_PORT, PUBLIC_PORT) if _port_taken(p)]
    if taken:
        # The text as one literal inside _t(…), so tools/check-i18n.py finds it.
        _show_error(_t("Port {ports} ist schon belegt. Läuft Wyrmdesk bereits, als App oder im Docker-Stack (docker compose down)? Erst beenden, dann neu starten.",
                       ports=", ".join(map(str, taken))))

    backend = threading.Thread(target=_run_backend, daemon=True)
    backend.start()
    deadline = time.monotonic() + STARTUP_TIMEOUT
    if not (_wait_for(GM_PORT, backend, deadline) and _wait_for(PUBLIC_PORT, backend, deadline)):
        backend.join(timeout=1)
        _show_error(_t("Der Server ist nicht hochgefahren."),
                    "".join(_backend_error) or _t("Keine Antwort nach {n} Sekunden.", n=int(STARTUP_TIMEOUT)))

    gm = _app_window("Wyrmdesk – Spielleiter", GM_URL, 1400, 900)
    _app_window("Wyrmdesk – Beamer", BEAMER_URL, 1280, 720)
    # Closing the GM window ends the session - the Beamer window and the backend thread go with it.
    gm.events.closing += lambda: os._exit(0)
    # pywebview cancels every download by default; the app has some (Sicherung, Bibliothek-Export): they get a "Speichern unter" dialog now.
    webview.settings["ALLOW_DOWNLOADS"] = True
    # WYRMDESK_DEBUG=1: right-click -> "Untersuchen"/"Inspect" opens the web inspector in each window.
    # private_mode=False: start()'s default (private browsing) makes WebKitGTK drop localStorage
    # entirely (not just its persistence) - the app relies on it (e.g. the selected campaign).
    webview.start(debug=bool(os.environ.get("WYRMDESK_DEBUG")), private_mode=False, icon=ICON, gui=GUI)
    os._exit(0)  # the Beamer window was closed last instead


if __name__ == "__main__":
    main()
