#!/bin/sh
# Runs INSIDE the build container (started by ../build-linux-packages.sh, repository at /src):
# builds the app folder with PyInstaller, then wraps it as .deb and as AppImage.
set -eu
cd /src/dmtool/desktop
VERSION=$(cat ../backend/app/VERSION)
OUT=dist/packages
export HOME=/tmp

pyinstaller wyrmdesk.spec --noconfirm --workpath build/linux-pkg --distpath dist/linux-pkg
APP=dist/linux-pkg/wyrmdesk

# GTK, GLib and WebKitGTK must come from the user's system (see wyrmdesk.spec): stop if any slipped in.
if ls "$APP/_internal" | grep -E '^lib(gtk|gdk|glib|gobject|gio-|pango|cairo|harfbuzz|webkit|javascriptcore|soup)'; then
  echo "Fehler: GTK-Bibliotheken im Paket, siehe oben." >&2
  exit 1
fi

rm -rf build/pkgroot
mkdir -p "$OUT"

# .deb: the app under /opt/wyrmdesk, a command, a menu entry and the icon.
R=build/pkgroot/deb
mkdir -p "$R/DEBIAN" "$R/opt" "$R/usr/bin" "$R/usr/share/applications" "$R/usr/share/icons/hicolor/256x256/apps"
cp -a "$APP" "$R/opt/wyrmdesk"
ln -s /opt/wyrmdesk/wyrmdesk "$R/usr/bin/wyrmdesk"
cp linux/wyrmdesk.desktop "$R/usr/share/applications/wyrmdesk.desktop"
cp ../backend/app/shared_static/brand/wyrmdesk-256.png "$R/usr/share/icons/hicolor/256x256/apps/wyrmdesk.png"
SIZE=$(du -sk "$R" | cut -f1)
sed -e "s/@VERSION@/$VERSION/" -e "s/@SIZE@/$SIZE/" linux/control > "$R/DEBIAN/control"
dpkg-deb --root-owner-group --build "$R" "$OUT/wyrmdesk_${VERSION}_amd64.deb"

# AppImage: one file to download and start.
A=build/pkgroot/Wyrmdesk.AppDir
mkdir -p "$A/usr"
cp -a "$APP" "$A/usr/wyrmdesk"
cp linux/AppRun "$A/AppRun"
cp linux/wyrmdesk.desktop "$A/wyrmdesk.desktop"
cp ../backend/app/shared_static/brand/wyrmdesk-256.png "$A/wyrmdesk.png"
APPIMAGE_EXTRACT_AND_RUN=1 ARCH=x86_64 appimagetool --no-appstream \
  --runtime-file /usr/local/share/runtime-x86_64 "$A" "$OUT/Wyrmdesk-${VERSION}-x86_64.AppImage"

rm -rf build/pkgroot
ls -la "$OUT"
