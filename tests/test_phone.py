"""Adding tasks from the Android app's notification and tile: connecting a phone, and the
server reading what was typed like quick add (quickadd_server.js, which needs Node.js)."""
import shutil

import pytest

from conftest import H, entropicide, rows

needs_node = pytest.mark.skipif(not shutil.which("node"), reason="needs Node.js")


@pytest.fixture
def phone(app, user_client):
    """(the user's client, headers that add as their connected phone)."""
    client = user_client("ann")
    key = client.post("/api/devices", json={"name": "Android app"}, headers=H).get_json()["key"]
    return client, H | {"Authorization": "Bearer " + key}


def tasks(client):
    return client.get("/api/data").get_json()["tasks"]


def test_connecting_a_phone(app, user_client):
    client = user_client("ann")
    assert client.post("/api/devices", json={}).status_code == 403  # needs the header
    r = client.post("/api/devices", json={"name": "Android app"}, headers=H)
    assert r.status_code == 201 and len(r.get_json()["key"]) > 30
    assert [d["name"] for d in client.get("/api/devices").get_json()] == ["Android app"]
    assert user_client("bob").get("/api/devices").get_json() == []


def test_keys_are_checked(app, phone):
    anon = app.test_client()
    assert anon.post("/api/app/add", json={"text": "x"}, headers=H | {"Authorization": "Bearer nope"}).status_code == 401
    assert anon.post("/api/app/add", json={"text": "x"}, headers=H).status_code == 401
    assert anon.post("/api/app/add", json={"text": "  "}, headers=phone[1]).status_code == 400


def test_disconnecting(app, phone):
    client, headers = phone
    device = client.get("/api/devices").get_json()[0]["id"]
    client.delete(f"/api/devices/{device}", headers=H)
    assert app.test_client().post("/api/app/add", json={"text": "x"}, headers=headers).status_code == 401


@needs_node
def test_typed_text_is_read_like_quick_add(app, phone):
    client, headers = phone
    with app.app_context():
        conn = entropicide.db.get_db()
        uid = conn.execute("SELECT id FROM users WHERE username = 'ann'").fetchone()[0]
        conn.execute("INSERT INTO areas (user_id, name) VALUES (?, 'Home')", (uid,))
        conn.commit()
    r = app.test_client().post("/api/app/add?now=2026-11-01T09:30", headers=headers,
                               json={"text": "Call dentist tomorrow 3pm #phone !next !2 +home\nask about Tuesday"})
    assert r.status_code == 201
    assert r.get_json()["summary"] == "Call dentist · Queue · Mon Nov 2, 3:00 PM · #phone"
    task = next(t for t in tasks(client) if t["title"] == "Call dentist")
    assert (task["state"], task["priority"], task["start_date"], task["start_time"]) == ("next", 2, "2026-11-02", "15:00")
    assert task["tags"] == ["phone"] and task["notes"] == "ask about Tuesday" and task["area_id"]


@needs_node
def test_dates_are_from_when_it_was_typed(app, phone):
    client, headers = phone
    app.test_client().post("/api/app/add?now=2026-12-30T23:50", json={"text": "Call mum tomorrow 9am"}, headers=headers)
    task = next(t for t in tasks(client) if t["title"] == "Call mum")
    assert task["start_date"] == "2026-12-31"


def test_added_as_typed_without_node(app, phone, monkeypatch):
    monkeypatch.setattr(entropicide, "QUICKADD_JS", "/nonexistent.js")
    r = app.test_client().post("/api/app/add", json={"text": "Buy eggs #shop"}, headers=phone[1])
    assert r.status_code == 201 and r.get_json()["title"] == "Buy eggs #shop"


def test_adds_are_logged(app, phone):
    app.test_client().post("/api/app/add", json={"text": "Logged"}, headers=phone[1])
    assert any("Added task" in r["detail"] for r in rows(app, "SELECT detail FROM app_log WHERE kind = 'app-add'"))
