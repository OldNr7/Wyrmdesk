#!/bin/sh
# The character sheet (with levelup.js, the UI language i18n.js and its texts lang/) exists twice: in the Charaktererstellung (the copy that is worked on) and in the
# Kampagnenbuch, and so do the placeholder pictures per class. Both must be the same; this reports
# any difference.
#   sh tools/check-shared.sh          check
#   sh tools/check-shared.sh --copy   copy the Charaktererstellung version over the Kampagnenbuch one
cd "$(dirname "$0")/.." || exit 1
src=charcreator/backend/app/shared_static
dst=dmtool/backend/app/shared_static
status=0
for f in charsheet.js charsheet.css charsheet-rules.js levelup.js i18n.js lang/en.json; do
  if [ "$1" = "--copy" ]; then
    mkdir -p "$(dirname "$dst/$f")" && cp "$src/$f" "$dst/$f" && echo "kopiert: $f"
  elif ! cmp -s "$src/$f" "$dst/$f"; then
    echo "unterschiedlich: $f"
    status=1
  fi
done
# The UI language's server side (i18n.py) and the version reader (version.py) are the same in both services.
for f in i18n.py version.py; do
  if [ "$1" = "--copy" ]; then
    cp "charcreator/backend/app/$f" "dmtool/backend/app/$f" && echo "kopiert: $f"
  elif ! cmp -s "charcreator/backend/app/$f" "dmtool/backend/app/$f"; then
    echo "unterschiedlich: $f"
    status=1
  fi
done
# The version: VERSION in the repository root is the one that is changed; each service gets a copy
# (its Docker build only sees its own backend folder).
for d in charcreator dmtool; do
  if [ "$1" = "--copy" ]; then
    cp VERSION "$d/backend/app/VERSION" && echo "kopiert: VERSION nach $d"
  elif ! cmp -s VERSION "$d/backend/app/VERSION"; then
    echo "unterschiedlich: VERSION ($d)"
    status=1
  fi
done
# The placeholder pictures per class (sheet without portrait; the Kampagnenbuch sets them on a character import)
# and the Wyrmdesk logo (favicons, header, app icon; made in the website's logo/build.py).
for d in class-portraits brand; do
  if [ "$1" = "--copy" ]; then
    mkdir -p "$dst/$d" && rm -f "$dst/$d"/* && cp "$src/$d"/* "$dst/$d"/ && echo "kopiert: $d"
  elif ! diff -rq "$src/$d" "$dst/$d" >/dev/null 2>&1; then
    echo "unterschiedlich: $d"
    status=1
  fi
done
[ "$status" = 0 ] && [ "$1" != "--copy" ] && echo "Charakterblatt: beide Kopien gleich."
exit $status
