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
# The UI language's server side (i18n.py) is the same in both services.
if [ "$1" = "--copy" ]; then
  cp charcreator/backend/app/i18n.py dmtool/backend/app/i18n.py && echo "kopiert: i18n.py"
elif ! cmp -s charcreator/backend/app/i18n.py dmtool/backend/app/i18n.py; then
  echo "unterschiedlich: i18n.py"
  status=1
fi
# The placeholder pictures per class (sheet without portrait; the Kampagnenbuch sets them on a character import).
psrc=$src/class-portraits
pdst=$dst/class-portraits
if [ "$1" = "--copy" ]; then
  mkdir -p "$pdst" && rm -f "$pdst"/*.svg && cp "$psrc"/*.svg "$pdst"/ && echo "kopiert: class-portraits"
elif ! diff -rq "$psrc" "$pdst" >/dev/null 2>&1; then
  echo "unterschiedlich: class-portraits"
  status=1
fi
[ "$status" = 0 ] && [ "$1" != "--copy" ] && echo "Charakterblatt: beide Kopien gleich."
exit $status
