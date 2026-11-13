"""Admin-only access (campaign management, content upload, character export).

Players never see this: they only ever use their campaign's token link (see player.py).
One shared password for the DM, checked with HTTP Basic Auth (the reverse proxy in front
of this terminates TLS, so the password isn't sent in the clear on the wire).

Where the password comes from, first match wins:
  ADMIN_PASSWORD_FILE   a file holding it (Docker secrets)
  ADMIN_PASSWORD        the password itself (.env next to compose.yaml)
  admin-password        next to the database: created with a random password on the first start
                        without one of the above, and announced once in the log
"""
import os
import secrets
import sys
from pathlib import Path

from fastapi import Depends, HTTPException
from fastapi.security import HTTPBasic, HTTPBasicCredentials

from .db import DB_PATH
from .i18n import t

PASSWORD_FILE = DB_PATH.parent / "admin-password"


def _log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def _load_password() -> str:
    if path := os.environ.get("ADMIN_PASSWORD_FILE"):
        pw = Path(path).read_text(encoding="utf-8").strip()
        if not pw:
            raise RuntimeError(f"ADMIN_PASSWORD_FILE ({path}) ist leer.")
        return pw
    if pw := os.environ.get("ADMIN_PASSWORD", "").strip():
        return pw
    if PASSWORD_FILE.exists() and (pw := PASSWORD_FILE.read_text(encoding="utf-8").strip()):
        _log(f"Admin-Passwort aus {PASSWORD_FILE} (ADMIN_PASSWORD ist nicht gesetzt).")
        return pw
    pw = secrets.token_urlsafe(18)
    PASSWORD_FILE.parent.mkdir(parents=True, exist_ok=True)
    PASSWORD_FILE.write_text(pw + "\n", encoding="utf-8")
    try:
        PASSWORD_FILE.chmod(0o600)
    except OSError:
        pass
    _log("=" * 64)
    _log("ADMIN_PASSWORD ist nicht gesetzt, ein zufälliges Admin-Passwort wurde erzeugt:")
    _log(f"    {pw}")
    _log(f"Gespeichert in {PASSWORD_FILE}. Eigenes Passwort: ADMIN_PASSWORD in der .env setzen.")
    _log("=" * 64)
    return pw


ADMIN_PASSWORD = _load_password()

_security = HTTPBasic()


def require_admin(credentials: HTTPBasicCredentials = Depends(_security)) -> None:
    if not secrets.compare_digest(credentials.password.encode(), ADMIN_PASSWORD.encode()):
        raise HTTPException(401, t("Falsches Passwort."), headers={"WWW-Authenticate": "Basic"})
