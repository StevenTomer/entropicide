"""Shared fixtures: the app with a fresh database per test, users, and signed-in clients.

Run the tests from the project folder:  venv/bin/pip install -r requirements-dev.txt
                                        venv/bin/python -m pytest
"""
import os
import re
import sys
import tempfile

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
# Before the app is imported: a throwaway database, no background threads, plain-HTTP cookies.
_tmp = tempfile.mkdtemp()
os.environ.update(ENTROPICIDE_DATABASE=os.path.join(_tmp, "import.db"), ENTROPICIDE_SECRET_KEY="test",
                  ENTROPICIDE_SECURE_COOKIES="0", ENTROPICIDE_REMINDER_SECONDS="0",
                  ENTROPICIDE_GOOGLE_SYNC_SECONDS="0")

import app as entropicide  # noqa: E402
import db  # noqa: E402
from werkzeug.security import generate_password_hash  # noqa: E402

# The header the app's own requests carry (a cross-site form can't).
H = {"X-Requested-With": "entropicide"}


@pytest.fixture
def app(tmp_path, monkeypatch):
    path = str(tmp_path / "test.db")
    db.init_db(path)
    monkeypatch.setitem(entropicide.app.config, "DATABASE", path)
    monkeypatch.setattr(entropicide, "APK_DIR", str(tmp_path))
    entropicide._failures.clear()
    return entropicide.app


@pytest.fixture
def make_user(app):
    def make(username, admin=False, settings="{}"):
        with app.app_context():
            conn = db.get_db()
            conn.execute("INSERT INTO users (username, display_name, password_hash, is_admin, settings) "
                         "VALUES (?, ?, ?, ?, ?)", (username, username.title(),
                                                    generate_password_hash("password1"), int(admin), settings))
            conn.commit()
            return conn.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
    return make


def sign_in(client, username, password="password1"):
    page = client.get("/login").get_data(as_text=True)
    token = re.search(r'name="csrf" value="([^"]+)"', page)[1]
    return client.post("/login", data={"csrf": token, "username": username, "password": password})


@pytest.fixture
def user_client(app, make_user):
    """A signed-in client for a new user (an admin if asked): user_client("ann", admin=True)."""
    def make(username, admin=False, settings="{}"):
        make_user(username, admin, settings)
        client = app.test_client()
        sign_in(client, username)
        return client
    return make


def rows(app, sql, *args):
    with app.app_context():
        return [dict(r) for r in db.get_db().execute(sql, args).fetchall()]
