"""Adding tasks with a key: the Android app's notification and tile, and other apps (/api/add);
the server reading what was typed like quick add (quickadd_server.js, which needs Node.js)."""
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


def api_key(client, name="Alexa"):
    r = client.post("/api/devices", json={"name": name, "kind": "api"}, headers=H)
    assert r.status_code == 201
    return {"Authorization": "Bearer " + r.get_json()["key"]}


@needs_node
@pytest.mark.parametrize("send", [
    lambda c, k: c.post("/api/add", json={"text": "Buy milk tomorrow #errand", "notes": "2%"}, headers=k),
    lambda c, k: c.post("/api/add", data={"text": "Buy milk tomorrow #errand", "notes": "2%"}, headers=k),
    lambda c, k: c.post("/api/add", data="Buy milk tomorrow #errand\n2%", headers=k | {"Content-Type": "text/plain"}),
    # what curl -d "…" sends: a form that's just the text
    lambda c, k: c.post("/api/add", data="Buy milk tomorrow #errand\n2%",
                        headers=k | {"Content-Type": "application/x-www-form-urlencoded"}),
])
def test_other_apps_add_with_a_key(app, user_client, send):
    client = user_client("bea")
    key = api_key(client)
    # Any way it's sent, with no X-Requested-With (the key is all it goes by).
    r = send(app.test_client(), key)
    assert r.status_code == 201, r.get_json()
    assert r.get_json()["title"] == "Buy milk" and "#errand" in r.get_json()["summary"]
    task = next(t for t in tasks(client) if t["title"] == "Buy milk")
    assert task["tags"] == ["errand"] and task["notes"] == "2%" and task["state"] == "scheduled"
    keys = client.get("/api/devices").get_json()
    assert [(d["name"], d["kind"], bool(d["used_at"])) for d in keys] == [("Alexa", "api", True)]


def test_api_keys_can_be_revoked(app, user_client):
    client = user_client("bea")
    key = api_key(client)
    client.delete(f"/api/devices/{client.get('/api/devices').get_json()[0]['id']}", headers=H)
    r = app.test_client().post("/api/add", json={"text": "x"}, headers=key)
    assert r.status_code == 401 and "Settings" in r.get_json()["error"]
    # A signed-in browser's cookie is no use without a key (and other API writes still need the header).
    assert client.post("/api/add", json={"text": "x"}).status_code == 401
    assert client.post("/api/tasks", json={"title": "x"}).status_code == 403


def test_reading_needs_a_key_that_may_read(app, user_client):
    client = user_client("bea")
    adds_only = api_key(client)
    assert app.test_client().get("/api/read/focus").status_code == 401
    assert app.test_client().get("/api/read/focus", headers=adds_only).status_code == 403
    assert client.get("/api/read/focus").status_code == 401  # (a signed-in cookie isn't a key)
    reads = {"Authorization": "Bearer " + client.post(
        "/api/devices", json={"name": "Alexa", "kind": "api", "can_read": True}, headers=H).get_json()["key"]}
    assert app.test_client().get("/api/read/nonsense", headers=reads).status_code == 404
    r = app.test_client().get("/api/read/focus", headers=reads)
    assert r.status_code == 200 and r.get_json() == {"list": "Focus", "count": 0, "tasks": [], "summary": "Nothing in Focus."}
    # Phone keys can't be made readers.
    client.post("/api/devices", json={"name": "Phone", "can_read": True}, headers=H)
    assert [d["can_read"] for d in client.get("/api/devices").get_json()] == [0, 1, 0]


def test_reading_lists_as_the_app_shows_them(app, user_client):
    client = user_client("bea")
    reads = {"Authorization": "Bearer " + client.post(
        "/api/devices", json={"name": "Alexa", "kind": "api", "can_read": True}, headers=H).get_json()["key"]}
    home = client.post("/api/areas", json={"name": "Home"}, headers=H).get_json()["id"]
    add = lambda **t: client.post("/api/tasks", json=t, headers=H).get_json()["id"]  # noqa: E731
    add(title="Pay **rent**", state="next", due_date="2000-01-01", area_id=home)
    add(title="Call Mom", state="next", focus=True, priority=2)
    add(title="Someday starred", state="someday", focus=True)
    first = add(title="Fix tap", state="next", focus=True)
    add(title="Buy washer", state="next", focus=True, blocked_by=[first])
    proj = client.post("/api/projects", json={"name": "Move", "sequential": True}, headers=H).get_json()["id"]
    add(title="Pack", state="next", project_id=proj)
    add(title="Unpack", state="next", project_id=proj)
    read = lambda path: app.test_client().get(path, headers=reads).get_json()  # noqa: E731
    focus = read("/api/read/focus")
    assert [t["title"] for t in focus["tasks"]] == ["Call Mom", "Pay **rent**", "Fix tap"]
    assert focus["tasks"][1]["overdue"] and focus["tasks"][1]["area"] == "Home"
    assert focus["summary"] == "Focus has 3 tasks: Call Mom; Pay rent, overdue; and Fix tap."
    assert [t["title"] for t in read("/api/read/queue")["tasks"]] == ["Call Mom", "Pay **rent**", "Fix tap", "Pack"]
    assert [t["title"] for t in read("/api/read/focus?area=home")["tasks"]] == ["Pay **rent**"]
    short = read("/api/read/queue?limit=1&say=2")
    assert short["count"] == 4 and len(short["tasks"]) == 1
    assert short["summary"] == "Queue has 4 tasks: Call Mom; Pay rent, overdue; and 2 more."


def completer(client):
    return {"Authorization": "Bearer " + client.post(
        "/api/devices", json={"name": "Alexa", "kind": "api", "can_complete": True}, headers=H).get_json()["key"]}


def test_completing_needs_a_key_that_may(app, user_client):
    client = user_client("bea")
    assert app.test_client().post("/api/complete", json={"text": "x"}).status_code == 401
    assert app.test_client().post("/api/complete", json={"text": "x"}, headers=api_key(client)).status_code == 403
    assert client.post("/api/complete", json={"text": "x"}).status_code == 401


def test_completing_what_was_said(app, user_client):
    client = user_client("bea")
    key = completer(client)
    add = lambda **t: client.post("/api/tasks", json=t, headers=H).get_json()["id"]  # noqa: E731
    dentist = add(title="Call dentist", state="next")
    add(title="Call dentist's office about the bill", state="later")
    add(title="Buy milk", state="next")
    add(title="Buy bread", state="next")
    add(title="Renew **passport**", state="next")
    done = lambda **body: app.test_client().post("/api/complete", json=body, headers=key)  # noqa: E731
    # "Check" finds without completing; little words don't matter; a current task beats a later one.
    r = done(text="call the dentist", check=True)
    assert r.status_code == 200 and r.get_json() == {"task": {"id": dentist, "title": "Call dentist"},
                                                     "summary": "Complete Call dentist?"}
    assert any(t["id"] == dentist for t in tasks(client))
    # Several: asks which.
    r = done(text="buy")
    assert r.status_code == 409 and r.get_json()["summary"] == "Which one: Buy milk, or Buy bread?"
    assert len(r.get_json()["matches"]) == 2
    # Misheard a little: the nearest by spelling.
    r = done(text="renew pasport")
    assert r.status_code == 200 and r.get_json()["summary"] == "Done: Renew passport."
    assert done(text="walk the llama").status_code == 404
    # By id, and undo.
    r = done(id=dentist)
    assert r.get_json()["summary"] == "Done: Call dentist." and not any(t["id"] == dentist for t in tasks(client))
    assert done(id=dentist).get_json()["summary"] == "Call dentist was already done."
    assert done(id=dentist, undo=True).get_json()["summary"] == "OK, Call dentist is back on your list."
    assert any(t["id"] == dentist for t in tasks(client))
    # Any way it's sent, like adding: curl -d "buy milk"
    r = app.test_client().post("/api/complete", data="buy milk", headers=key | {"Content-Type": "application/x-www-form-urlencoded"})
    assert r.get_json()["summary"] == "Done: Buy milk."


def test_completing_a_repeating_task_takes_the_oldest_copy(app, user_client):
    client = user_client("bea")
    key = completer(client)
    client.post("/api/tasks", json={"title": "Water plants", "state": "next", "start_date": "2026-01-05",
                                    "repeat": "weekly", "on_miss": "keep"}, headers=H)
    copies = sorted((t["start_date"], t["id"]) for t in tasks(client) if t["title"] == "Water plants")
    assert len(copies) > 1
    r = app.test_client().post("/api/complete", json={"text": "water the plants"}, headers=key)
    assert r.status_code == 200 and r.get_json()["task"]["id"] == copies[0][1]
