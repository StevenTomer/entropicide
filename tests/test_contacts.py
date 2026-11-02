"""People in tasks, from a read-only copy of the user's Google Contacts."""
import json
import shutil

import pytest

import gcal
from conftest import H, entropicide, rows

CONTACTS = [
    {"id": "people/c1", "name": "Jane Tomer", "info": {"nicknames": ["Mom"], "phones": [{"value": "(555) 123-4567", "type": "Mobile"}],
                                                      "emails": [], "addresses": []}},
    {"id": "people/c2", "name": "Bob Smith", "info": {"nicknames": [], "phones": [], "emails": [{"value": "bob@example.com", "type": ""}],
                                                     "addresses": []}},
]


@pytest.fixture
def connected(app, user_client, monkeypatch):
    """A user connected to Google with Contacts allowed (Google itself faked)."""
    client = user_client("ann")
    with app.app_context():
        conn = entropicide.db.get_db()
        uid = conn.execute("SELECT id FROM users WHERE username = 'ann'").fetchone()[0]
        conn.execute("INSERT INTO google_accounts (user_id, email, refresh_token, access_token, access_expires, scopes) "
                     "VALUES (?, 'ann@example.com', 'r', 'a', 9e12, ?)", (uid, gcal.SCOPES))
        conn.commit()
    monkeypatch.setattr(gcal, "list_contacts", lambda token: CONTACTS)
    monkeypatch.setattr(gcal, "list_calendars", lambda token: [])
    monkeypatch.setattr(entropicide, "_fetch_events", lambda *a: None)
    return client, uid


def sync(app, uid):
    with app.test_request_context():
        entropicide.sync_user(uid, fetch_events=True)


def test_contacts_are_copied_and_shown(app, connected):
    client, uid = connected
    sync(app, uid)
    data = client.get("/api/data", headers=H).get_json()
    assert [c["name"] for c in data["contacts"]] == ["Bob Smith", "Jane Tomer"]
    assert data["contacts"][1]["nicknames"] == ["Mom"] and data["google"]["contacts"] is True


def test_without_contacts_access_the_copy_goes(app, connected):
    client, uid = connected
    sync(app, uid)
    with app.app_context():
        conn = entropicide.db.get_db()
        conn.execute("UPDATE google_accounts SET scopes = ?", (gcal.CALENDAR_SCOPE,))
        conn.commit()
    sync(app, uid)
    data = client.get("/api/data", headers=H).get_json()
    assert data["contacts"] == [] and data["google"]["contacts"] is False


def test_tasks_name_people(app, connected):
    client, uid = connected
    task = client.post("/api/tasks", json={"title": "Call Mom", "people": ["people/c1"]}, headers=H).get_json()
    assert task["people"] == ["people/c1"]
    task = client.patch(f"/api/tasks/{task['id']}", json={"people": ["people/c1", "people/c2", "people/c1"]}, headers=H).get_json()
    assert task["people"] == ["people/c1", "people/c2"]
    assert client.patch(f"/api/tasks/{task['id']}", json={"people": ["nope"]}, headers=H).status_code == 400
    copy = client.post(f"/api/tasks/{task['id']}/duplicate", headers=H).get_json()
    assert copy["people"] == ["people/c1", "people/c2"]


def test_disconnect_deletes_the_copy_but_not_the_links(app, connected, monkeypatch):
    client, uid = connected
    sync(app, uid)
    task = client.post("/api/tasks", json={"title": "Call Mom", "people": ["people/c1"]}, headers=H).get_json()
    monkeypatch.setattr(gcal, "revoke", lambda token: None)
    client.post("/api/google/disconnect", headers=H)
    assert rows(app, "SELECT * FROM contacts") == []
    assert next(t for t in client.get("/api/data", headers=H).get_json()["tasks"] if t["id"] == task["id"])["people"] == ["people/c1"]


@pytest.mark.skipif(not shutil.which("node"), reason="needs Node.js")
def test_phone_adds_read_at_names(app, connected):
    client, uid = connected
    sync(app, uid)
    with app.test_request_context():
        entropicide.g.user = entropicide.db.get_db().execute("SELECT * FROM users WHERE id = ?", (uid,)).fetchone()
        assert entropicide.read_quick_add("Call @mom, then @bob", "en-US")["people"] == ["people/c1", "people/c2"]
        fields = entropicide.read_quick_add("Lunch with @BobSmith and @nobody", "en-US")
    assert fields["title"] == "Lunch with Bob Smith and @nobody" and fields["people"] == ["people/c2"]
