"""Backups of the database.

Each backup is a consistent copy made with SQLite's online backup (safe while the app is
running), checked, then gzipped as entropicide-YYYY-MM-DD.db.gz. Old ones are thinned out: the
last 7 days, the last 4 Sundays and the last 12 firsts of the month are kept.
"""
import gzip
import os
import re
import shutil
import sqlite3
import tempfile
from datetime import date

# (todo-…: made before the app was renamed.)
NAME_RE = re.compile(r"(?:entropicide|todo)-(\d{4}-\d{2}-\d{2})\.db\.gz$")
KEEP_DAILY, KEEP_WEEKLY, KEEP_MONTHLY = 7, 4, 12


class BackupError(Exception):
    pass


def default_dir(db_path):
    """ENTROPICIDE_BACKUP_DIR, or a backups folder next to the data folder (/opt/entropicide/backups)."""
    return os.environ.get("ENTROPICIDE_BACKUP_DIR") or os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(db_path))), "backups")


def snapshot(db_path, out):
    """Write a gzipped, checked copy of the database at db_path to the open binary file out."""
    with tempfile.TemporaryDirectory() as tmp:
        copy = os.path.join(tmp, "entropicide.db")
        src = sqlite3.connect(db_path)
        dst = sqlite3.connect(copy)
        try:
            src.backup(dst)
            result = dst.execute("PRAGMA integrity_check").fetchone()[0]
        finally:
            dst.close()
            src.close()
        if result != "ok":
            raise BackupError(f"the copy failed its integrity check: {result}")
        with open(copy, "rb") as f, gzip.GzipFile(fileobj=out, mode="wb", mtime=0) as gz:
            shutil.copyfileobj(f, gz, 1024 * 1024)


def run(db_path, backup_dir, today=None):
    """Make today's backup (replacing one made earlier today) and thin out old ones.
    Returns (path of the new backup, names of the backups removed)."""
    today = today or date.today()
    os.makedirs(backup_dir, mode=0o700, exist_ok=True)
    path = os.path.join(backup_dir, f"entropicide-{today.isoformat()}.db.gz")
    fd, tmp = tempfile.mkstemp(dir=backup_dir, suffix=".partial")
    try:
        with os.fdopen(fd, "wb") as out:
            snapshot(db_path, out)
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)  # never leaves a half-written backup under a real name
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)
    return path, prune(backup_dir)


def backups(backup_dir):
    """[(date, path)] for each backup, newest first."""
    if not os.path.isdir(backup_dir):
        return []
    found = [(date.fromisoformat(m[1]), os.path.join(backup_dir, name))
             for name in os.listdir(backup_dir) if (m := NAME_RE.fullmatch(name))]
    return sorted(found, reverse=True)


def prune(backup_dir):
    found = backups(backup_dir)
    days = sorted({d for d, _ in found}, reverse=True)  # (a day can have an old todo- one too)
    keep = set(days[:KEEP_DAILY])
    keep |= set([d for d in days if d.weekday() == 6][:KEEP_WEEKLY])  # Sundays
    keep |= set([d for d in days if d.day == 1][:KEEP_MONTHLY])
    removed = []
    for d, path in found:
        if d not in keep:
            os.remove(path)
            removed.append(os.path.basename(path))
    return removed


def restore(db_path, backup_path, backup_dir):
    """Replace the database's contents with a backup's (.db.gz, or a plain .db). First backs up the current state
    (as entropicide-before-restore-….db.gz in backup_dir), so a restore can itself be undone."""
    with tempfile.TemporaryDirectory() as tmp:
        plain = os.path.join(tmp, "restore.db")
        try:
            with gzip.open(backup_path, "rb") as gz, open(plain, "wb") as f:
                shutil.copyfileobj(gz, f, 1024 * 1024)
        except gzip.BadGzipFile:
            shutil.copyfile(backup_path, plain)  # a plain .db copy will do too
        src = sqlite3.connect(plain)
        try:
            try:
                ok = src.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
            except sqlite3.DatabaseError:
                ok = False
            if not ok:
                raise BackupError(f"{backup_path} is damaged, or isn't a database")
            if not src.execute("SELECT name FROM sqlite_master WHERE name = 'tasks'").fetchone():
                raise BackupError(f"{backup_path} isn't an Entropicide database")
            safety = os.path.join(backup_dir, "entropicide-before-restore-"
                                  f"{date.today().isoformat()}-{os.getpid()}.db.gz")
            os.makedirs(backup_dir, mode=0o700, exist_ok=True)
            with open(safety, "wb") as out:
                snapshot(db_path, out)
            os.chmod(safety, 0o600)
            dst = sqlite3.connect(db_path)
            try:
                src.backup(dst)  # also through SQLite, so open connections see it properly
            finally:
                dst.close()
        finally:
            src.close()
    return safety
