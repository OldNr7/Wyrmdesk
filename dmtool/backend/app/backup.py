"""Backup as one zip (database plus image folders) and restore from it.

Restoring copies the database in place with SQLite's backup API, so open connections
never see a half-written file. Images from the zip are added next to the ones already
there; nothing is deleted. The database as it was before the restore is kept as
before-restore.db next to it, in case the wrong file was picked.
"""
import asyncio
import logging
import os
import shutil
import sqlite3
import tempfile
import time
import zipfile
from datetime import datetime
from pathlib import Path
from uuid import uuid4

from fastapi import HTTPException, Request
from .i18n import t as _t


def _copy_db(src_path: Path, dest_path: Path) -> None:
    src, dest = sqlite3.connect(src_path), sqlite3.connect(dest_path)
    try:
        with dest:
            src.backup(dest)
    finally:
        dest.close()
        src.close()


def make_zip(db_path: Path, db_name: str, folders: dict[str, Path]) -> Path:
    """Zip of the database (as db_name) and every file in folders (as <prefix>/<name>)."""
    tmp = Path(tempfile.gettempdir())
    db_copy = tmp / f"backup-{uuid4().hex}.db"
    _copy_db(db_path, db_copy)
    zip_path = tmp / f"backup-{uuid4().hex}.zip"
    try:
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
            z.write(db_copy, db_name)
            for prefix, folder in folders.items():
                for f in sorted(folder.iterdir()):
                    if f.is_file():
                        # Images are compressed already; storing them keeps big maps fast.
                        z.write(f, f"{prefix}/{f.name}", compress_type=zipfile.ZIP_STORED)
    finally:
        db_copy.unlink(missing_ok=True)
    return zip_path


async def restore_zip(request: Request, db_path: Path, db_name: str, folders: dict[str, Path],
                      required_table: str) -> dict:
    """Replace the database with the one in the uploaded zip and add its images."""
    tmp = Path(tempfile.mkdtemp(prefix="restore-"))
    try:
        upload = tmp / "upload.zip"
        # Streamed to disk: a battlemap backup with its maps can be hundreds of megabytes.
        with upload.open("wb") as out:
            async for chunk in request.stream():
                out.write(chunk)
        try:
            z = zipfile.ZipFile(upload)
        except zipfile.BadZipFile:
            raise HTTPException(400, _t("Das ist keine ZIP-Sicherung."))
        with z:
            if db_name not in z.namelist():
                raise HTTPException(400, _t("In der ZIP-Datei fehlt {name}. Ist es eine Sicherung dieses Tools?", name=db_name))
            new_db = tmp / "restore.db"
            with z.open(db_name) as src, new_db.open("wb") as out:
                shutil.copyfileobj(src, out)
            try:
                conn = sqlite3.connect(new_db)
                try:
                    ok = conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
                    has_table = conn.execute(
                        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (required_table,)
                    ).fetchone() is not None
                finally:
                    conn.close()
            except sqlite3.DatabaseError:
                ok = has_table = False
            if not ok or not has_table:
                raise HTTPException(400, _t("Die Datenbank in der Sicherung ist beschädigt oder gehört zu einem anderen Tool."))

            images = 0
            for info in z.infolist():
                prefix, _, name = info.filename.partition("/")
                # Only plain file names inside the known folders; never paths that climb out.
                if prefix not in folders or not name or name != Path(name).name or name.startswith("."):
                    continue
                with z.open(info) as src, (folders[prefix] / name).open("wb") as out:
                    shutil.copyfileobj(src, out)
                images += 1

        _copy_db(db_path, db_path.parent / "before-restore.db")
        _copy_db(new_db, db_path)
        return {"ok": True, "images": images}
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ---------- automatic backups ----------
# With BACKUP_DIR set, each tool writes a zip like the one above there on its own:
# at start and then hourly, but only when something changed since the newest one and
# that one is at least AUTO_MIN_HOURS old. The newest AUTO_KEEP are kept.

AUTO_CHECK_SECONDS = 3600
AUTO_MIN_HOURS = 12
AUTO_KEEP = 14

log = logging.getLogger("uvicorn.error")


def _last_change(db_path: Path, folders: dict[str, Path]) -> float:
    paths = [db_path, *folders.values()]
    for folder in folders.values():
        paths += [f for f in folder.iterdir() if f.is_file()]
    return max(p.stat().st_mtime for p in paths if p.exists())


def auto_backup(db_path: Path, db_name: str, folders: dict[str, Path], backup_dir: Path, prefix: str) -> Path | None:
    backup_dir.mkdir(parents=True, exist_ok=True)
    existing = sorted(backup_dir.glob(f"{prefix}-auto-*.zip"))
    if existing:
        newest = existing[-1].stat().st_mtime
        if _last_change(db_path, folders) <= newest or time.time() - newest < AUTO_MIN_HOURS * 3600:
            return None
    dest = backup_dir / f"{prefix}-auto-{datetime.now().strftime('%Y-%m-%d_%H%M%S')}.zip"
    part = dest.with_suffix(".part")
    # Moved in under a temporary name, so a half-copied file never counts as a backup.
    shutil.move(make_zip(db_path, db_name, folders), part)
    part.rename(dest)
    for old in existing[: max(0, len(existing) + 1 - AUTO_KEEP)]:
        old.unlink(missing_ok=True)
    return dest


async def auto_backup_forever(db_path: Path, db_name: str, folders: dict[str, Path], prefix: str) -> None:
    backup_dir = os.environ.get("BACKUP_DIR")
    if not backup_dir:
        return
    while True:
        try:
            dest = await asyncio.to_thread(auto_backup, db_path, db_name, folders, Path(backup_dir), prefix)
            if dest:
                log.info("Automatische Sicherung: %s", dest.name)
        except Exception:
            log.exception("Automatische Sicherung fehlgeschlagen")
        await asyncio.sleep(AUTO_CHECK_SECONDS)
