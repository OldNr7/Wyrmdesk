# Build environment for the Linux packages (.deb, AppImage) of the native app; used by
# ../build-linux-packages.sh. Debian 12 as the base keeps the packages runnable on distributions
# from about 2022 on (glibc 2.36); the official Python image adds Python 3.12 on top (numpy needs it).
# GTK, GLib and WebKitGTK are NOT bundled: the app uses the ones of the system it runs on
# (see wyrmdesk.spec), here they are only needed to build PyGObject and to let PyInstaller analyse.
FROM python:3.12-slim-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
        gcc pkg-config libgirepository1.0-dev libcairo2-dev gir1.2-gtk-3.0 gir1.2-webkit2-4.1 \
        binutils file dpkg-dev curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# appimagetool and the AppImage runtime, pinned (official releases of the AppImage project).
RUN curl -fsSL -o /usr/local/bin/appimagetool \
        https://github.com/AppImage/appimagetool/releases/download/1.9.1/appimagetool-x86_64.AppImage \
    && curl -fsSL -o /usr/local/share/runtime-x86_64 \
        https://github.com/AppImage/type2-runtime/releases/download/20251108/runtime-x86_64 \
    && chmod +x /usr/local/bin/appimagetool

COPY requirements-backend.txt requirements.txt requirements-build.txt /tmp/req/
# PyGObject 3.50 is the last one for libgirepository-1.0 (Debian 12 has no girepository-2.0).
RUN pip install --no-cache-dir -r /tmp/req/requirements-backend.txt -r /tmp/req/requirements.txt \
        -r /tmp/req/requirements-build.txt "PyGObject==3.50.0" "pycairo==1.27.0"
