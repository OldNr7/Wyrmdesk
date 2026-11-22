# PyInstaller spec for the native Wyrmdesk (Kampagnenbuch) app. Bundles dmtool/backend/app
# unmodified, plus its static asset directories (not auto-discovered by PyInstaller's import
# analysis, since FastAPI's StaticFiles loads them by path, not by import).
#
#   pyinstaller wyrmdesk.spec --noconfirm
#
# uvicorn[standard] auto-selects its event loop/HTTP protocol implementation at runtime
# (uvicorn/loops/auto.py, uvicorn/protocols/*/auto.py), which PyInstaller's static analysis can
# miss. collect_submodules("uvicorn") below covers the common case; if the frozen build still fails
# with ModuleNotFoundError on startup (run it with console=True to see the traceback), add the
# missing dotted module name to hiddenimports and rebuild.
import os
import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_submodules

backend = "../backend"
# One version for all of Wyrmdesk: the copy next to the app code (tools/check-shared.sh keeps it
# equal to VERSION in the repository root).
VERSION = Path(backend, "app", "VERSION").read_text(encoding="utf-8").strip()


def windows_version_info():
    """The version in the .exe's file properties (Windows only; PyInstaller ignores it elsewhere)."""
    from PyInstaller.utils.win32.versioninfo import (FixedFileInfo, StringFileInfo, StringStruct, StringTable,
                                                     VarFileInfo, VarStruct, VSVersionInfo)
    nums = tuple((list(map(int, VERSION.split("-")[0].split("."))) + [0, 0, 0, 0])[:4])
    return VSVersionInfo(
        ffi=FixedFileInfo(filevers=nums, prodvers=nums),
        kids=[
            StringFileInfo([StringTable("040704B0", [
                StringStruct("ProductName", "Wyrmdesk"),
                StringStruct("FileDescription", "Wyrmdesk"),
                StringStruct("FileVersion", VERSION),
                StringStruct("ProductVersion", VERSION),
                StringStruct("OriginalFilename", "wyrmdesk.exe"),
            ])]),
            VarFileInfo([VarStruct("Translation", [0x0407, 1200])]),
        ],
    )


datas = [
    (f"{backend}/app/static", "app/static"),
    (f"{backend}/app/player_static", "app/player_static"),
    (f"{backend}/app/spieler_static", "app/spieler_static"),
    (f"{backend}/app/handbuch_static", "app/handbuch_static"),
    (f"{backend}/app/shared_static", "app/shared_static"),
    (f"{backend}/app/lang", "app/lang"),
    (f"{backend}/app/schema.sql", "app"),
    (f"{backend}/app/VERSION", "app"),
    (f"{backend}/app/battlemap/static", "app/battlemap/static"),
    (f"{backend}/app/battlemap/player_static", "app/battlemap/player_static"),
    (f"{backend}/app/battlemap/shared_static", "app/battlemap/shared_static"),
    (f"{backend}/app/battlemap/schema.sql", "app/battlemap"),
    (f"{backend}/app/combat/static", "app/combat/static"),
    (f"{backend}/app/combat/display_static", "app/combat/display_static"),
    (f"{backend}/app/combat/shared_static", "app/combat/shared_static"),
    (f"{backend}/app/combat/schema.sql", "app/combat"),
]

hiddenimports = collect_submodules("uvicorn") + collect_submodules("websockets")

a = Analysis(
    ["launcher.py"],
    pathex=[backend, "."],
    datas=datas,
    hiddenimports=hiddenimports,
    # Linux: PyInstaller's GTK hook otherwise copies every installed icon theme and translation
    # (hundreds of MB). GTK's own dialogs (save as) need only Adwaita; the app speaks de/en.
    hooksconfig={"gi": {"icons": ["Adwaita"], "themes": ["Adwaita"], "languages": ["de", "en"]}},
)
# Linux: GTK, GLib, WebKitGTK and what they pull in come from the system the app runs on. Bundled
# copies from the build machine would meet the system's WebKitGTK (which can't be bundled: it starts
# helper processes from fixed paths) and clash with it. So leave them out, with their data (typelibs,
# icons, schemas); launcher.py undoes the paths PyInstaller's GTK runtime hooks set. Kept: libgirepository-1.0,
# which the bundled PyGObject needs; newer distributions only install girepository-2.0. It runs on the
# system's GLib and reads the system's typelibs.
if sys.platform.startswith("linux"):
    SYSTEM_LIBS = (
        "libgtk-3", "libgdk-3", "libgdk_pixbuf", "libglib-2", "libgobject-2", "libgio-2", "libgmodule-2",
        "libgthread-2", "libpango", "libcairo", "libharfbuzz", "libatk", "libatspi",
        "libepoxy", "libfontconfig", "libfreetype", "libpixman", "libpng16", "libX", "libxcb", "libwayland",
        "libxkbcommon", "libfribidi", "libthai", "libdatrie", "libgraphite2", "libjpeg", "libtiff", "libwebp",
        "libsharpyuv", "librsvg", "libsoup", "libjavascriptcore", "libwebkit", "libdbus", "libsystemd",
        "libmount", "libblkid", "libselinux", "libpcre2", "libbrotli", "libexpat", "libgcrypt", "libgpg-error",
        "libglycin", "libheif", "liblzma", "libzstd", "libcloudproviders", "libtinysparql", "libsecret",
        "libgnutls", "libnettle", "libhogweed", "libgmp", "libp11-kit", "libtasn1", "libidn2", "libunistring",
        "libcolord", "liblcms2", "libdeflate", "libjbig", "libLerc", "libxml2", "libicu", "libstdc++", "libgcc_s",
    )
    SYSTEM_DATA = ("gi_typelibs/", "share/", "lib/gdk-pixbuf", "lib/girepository", "gio_modules/", "etc/")
    a.binaries = [b for b in a.binaries if not b[0].startswith(SYSTEM_LIBS)]
    a.datas = [d for d in a.datas if not d[0].startswith(SYSTEM_DATA)]

pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="wyrmdesk",
    icon="wyrmdesk.ico",
    version=windows_version_info() if sys.platform == "win32" else None,  # Windows: the .exe and its windows (made in the website's logo/build.py)
    # Windows: no console window next to the app (its output goes to wyrmdesk.log, see launcher.py);
    # WYRMDESK_CONSOLE=1 at build time keeps it, to watch a build that fails on start.
    console=sys.platform != "win32" or os.environ.get("WYRMDESK_CONSOLE") == "1",
)
coll = COLLECT(exe, a.binaries, a.datas, name="wyrmdesk")
