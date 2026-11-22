#!/bin/sh
# Builds the native Linux executable of the Kampagnenbuch (Combat Tracker, Battlemap) with
# PyInstaller. Needs a venv with ../backend/requirements.txt, requirements.txt and
# requirements-build.txt installed (PyInstaller only bundles what's importable, it installs
# nothing itself - see README.md).
# Output: dist/wyrmdesk/
cd "$(dirname "$0")" || exit 1
pyinstaller wyrmdesk.spec --noconfirm
