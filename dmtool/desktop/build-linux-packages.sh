#!/bin/sh
# Builds the Linux packages of the native app in a Docker container (Debian 12 base, so they run on
# distributions from about 2022 on, not only on the one they were built on):
#   dist/packages/wyrmdesk_<version>_amd64.deb        Debian, Ubuntu and relatives (apt installs WebKitGTK)
#   dist/packages/Wyrmdesk-<version>-x86_64.AppImage  any distribution with GTK 3 and WebKitGTK 4.1
# Needs only Docker. The version comes from VERSION (see LIESMICH.md, "Versionen und Releases").
set -eu
cd "$(dirname "$0")"
ctx=$(mktemp -d)
trap 'rm -rf "$ctx"' EXIT
cp linux/Dockerfile requirements.txt requirements-build.txt "$ctx/"
cp ../backend/requirements.txt "$ctx/requirements-backend.txt"
docker build -t wyrmdesk-linux-build "$ctx"
repo=$(cd ../.. && pwd)
docker run --rm --user "$(id -u):$(id -g)" -v "$repo:/src" wyrmdesk-linux-build sh /src/dmtool/desktop/linux/build-packages.sh
