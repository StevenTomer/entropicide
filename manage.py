"""Command-line user management and backups.

    python manage.py create-user USERNAME [--admin] [--name "Display Name"]
    python manage.py set-password USERNAME
    python manage.py list-users
    python manage.py backup              (entropicide-backup.timer runs this nightly)
    python manage.py list-backups
    python manage.py restore FILE        (stop entropicide.service first)
"""
import argparse
import getpass
import os
import sys

from werkzeug.security import generate_password_hash

import backup
import db

DATABASE = os.environ.get(
    "ENTROPICIDE_DATABASE", os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "entropicide.db"))
BACKUP_DIR = backup.default_dir(DATABASE)


def ask_password():
    while True:
        pw = getpass.getpass("Password: ")
        if len(pw) < 8:
            print("Must be at least 8 characters.")
        elif pw != getpass.getpass("Again: "):
            print("Didn't match.")
        else:
            return pw


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd", required=True)
    create = sub.add_parser("create-user")
    create.add_argument("username")
    create.add_argument("--admin", action="store_true")
    create.add_argument("--name", default="")
    setpw = sub.add_parser("set-password")
    setpw.add_argument("username")
    sub.add_parser("list-users")
    sub.add_parser("backup")
    sub.add_parser("list-backups")
    restore = sub.add_parser("restore")
    restore.add_argument("file")
    args = parser.parse_args()

    if args.cmd in ("backup", "list-backups", "restore"):
        return backups(args)
    db.init_db(DATABASE)
    conn = db.connect(DATABASE)
    if args.cmd == "create-user":
        if conn.execute("SELECT 1 FROM users WHERE username = ?", (args.username,)).fetchone():
            sys.exit(f"{args.username} already exists")
        conn.execute(
            "INSERT INTO users (username, display_name, password_hash, is_admin) VALUES (?, ?, ?, ?)",
            (args.username, args.name or args.username,
             generate_password_hash(ask_password()), int(args.admin)))
        print(f"Created {args.username}{' (admin)' if args.admin else ''}.")
    elif args.cmd == "set-password":
        if conn.execute("SELECT 1 FROM users WHERE username = ?", (args.username,)).fetchone() is None:
            sys.exit(f"no user {args.username}")
        conn.execute("UPDATE users SET password_hash = ? WHERE username = ?",
                     (generate_password_hash(ask_password()), args.username))
        print("Password updated.")
    else:
        for row in conn.execute("SELECT username, display_name, is_admin, disabled, last_login "
                                "FROM users ORDER BY username"):
            flags = ("admin " if row["is_admin"] else "") + ("disabled" if row["disabled"] else "")
            print(f"{row['username']:<20} {row['display_name']:<24} {flags:<16} "
                  f"last login: {row['last_login'] or 'never'}")
    conn.commit()
    conn.close()


def backups(args):
    try:
        if args.cmd == "backup":
            path, removed = backup.run(DATABASE, BACKUP_DIR)
            print(f"Backed up to {path} ({os.path.getsize(path) / 1e6:.1f} MB).")
            if removed:
                print("Removed old backups: " + ", ".join(removed))
        elif args.cmd == "list-backups":
            found = backup.backups(BACKUP_DIR)
            for day, path in found:
                print(f"{day}  {os.path.getsize(path) / 1e6:8.1f} MB  {path}")
            if not found:
                print(f"No backups in {BACKUP_DIR}.")
        else:
            if input(f"Replace everything in {DATABASE} with {args.file}? [y/N] ").lower() != "y":
                sys.exit("Cancelled.")
            safety = backup.restore(DATABASE, args.file, BACKUP_DIR)
            print(f"Restored. The data from just before is in {safety}.")
    except (backup.BackupError, OSError) as e:
        sys.exit(f"Backup failed: {e}" if args.cmd == "backup" else str(e))


if __name__ == "__main__":
    main()
