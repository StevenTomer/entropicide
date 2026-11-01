"""Backups, and what's carried over from before the app was renamed (Todo → Entropicide)."""
import gzip
import os
import sqlite3

import backup
from conftest import H, entropicide


def test_backup_and_restore(app, user_client, tmp_path):
    client = user_client("ann")
    client.post("/api/tasks", json={"title": "original"}, headers=H)
    path, _ = backup.run(app.config["DATABASE"], str(tmp_path / "b"))
    assert os.path.basename(path).startswith("entropicide-") and os.stat(path).st_mode & 0o777 == 0o600
    with gzip.open(path) as f, open(tmp_path / "copy.db", "wb") as out:
        out.write(f.read())
    titles = [r[0] for r in sqlite3.connect(tmp_path / "copy.db").execute("SELECT title FROM tasks")]
    assert titles == ["original"]


def test_old_backup_names_are_kept_and_listed(tmp_path):
    for name in ["todo-2026-10-30.db.gz", "todo-2026-10-31.db.gz", "todo-2026-11-01.db.gz",
                 "entropicide-2026-11-01.db.gz"]:
        (tmp_path / name).touch()
    assert len(backup.backups(str(tmp_path))) == 4
    backup.prune(str(tmp_path))
    assert len(os.listdir(tmp_path)) == 4


def test_old_sign_in_cookie_still_works(app, make_user):
    user = make_user("ann")
    with app.test_request_context():
        old = app.session_interface.get_signing_serializer(app).dumps(
            {"uid": user["id"], "stamp": entropicide._session_stamp(user), "_permanent": True})
    client = app.test_client()
    client.set_cookie("todo_session", old, path="/")
    r = client.get("/api/data")
    assert r.status_code == 200
    cookies = r.headers.getlist("Set-Cookie")
    assert any(c.startswith("entropicide_session=") for c in cookies)
    assert any(c.startswith("todo_session=;") for c in cookies)  # removed
    assert client.get("/api/data").status_code == 200


def test_bad_old_cookie(app):
    client = app.test_client()
    client.set_cookie("todo_session", "garbage", path="/")
    assert client.get("/api/data").status_code == 401


def test_old_and_new_header(user_client):
    client = user_client("ann")
    assert client.post("/api/tasks", json={"title": "a"}, headers={"X-Requested-With": "todo"}).status_code == 201
    assert client.post("/api/tasks", json={"title": "b"}, headers=H).status_code == 201
    assert client.post("/api/tasks", json={"title": "c"}).status_code == 403
