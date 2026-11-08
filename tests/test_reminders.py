"""Reminders: quiet hours hold them until they end; ones before a due date follow it."""
import json
from datetime import datetime
from zoneinfo import ZoneInfo

import pytest

from conftest import H, entropicide

DENVER = ZoneInfo("America/Denver")


def local(stamp):
    return datetime.fromisoformat(stamp).replace(tzinfo=DENVER)


@pytest.mark.parametrize("now, quiet, expected", [
    ("2026-11-01T23:00", "22:00-07:00", ("2026-11-01T22:00", "2026-11-02T07:00")),
    ("2026-11-02T06:59", "22:00-07:00", ("2026-11-01T22:00", "2026-11-02T07:00")),
    ("2026-11-02T13:00", "13:00-14:00", ("2026-11-02T13:00", "2026-11-02T14:00")),
])
def test_quiet_spell(now, quiet, expected):
    assert entropicide.quiet_spell(local(now), quiet) == tuple(map(local, expected))


def test_no_quiet_hours():
    assert entropicide.quiet_spell(local("2026-11-02T13:00"), "") is None


def test_held_until_quiet_hours_end(app, make_user, monkeypatch):
    sent = []
    monkeypatch.setattr(entropicide, "notify", lambda uid, message: sent.append(message["title"]) or 1)
    user = make_user("ann", settings=json.dumps({"timezone": "America/Denver", "quiet_hours": "22:00-07:00",
                                                 "digest_time": ""}))
    utc = lambda stamp: entropicide.utc_stamp(local(stamp))  # noqa: E731
    with app.app_context():
        conn = entropicide.db.get_db()
        conn.execute("INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, 'https://x', 'k', 'a')",
                     (user["id"],))
        entropicide.db.insert(conn, "tasks", {"user_id": user["id"], "title": "Night reminder", "state": "inbox",
                                              "remind_at": utc("2026-11-02T01:00"), "position": 1})
        entropicide.db.insert(conn, "tasks", {"user_id": user["id"], "title": "Late start", "state": "next",
                                              "start_date": "2026-11-01", "start_time": "23:30", "position": 2})
        conn.commit()
        for t in ("2026-11-01T23:45", "2026-11-02T03:00", "2026-11-02T06:59"):
            entropicide.send_reminders(local(t))
        assert sent == []
        entropicide.send_reminders(local("2026-11-02T07:01"))
        assert sorted(sent) == ["Now: Late start", "⏰ Night reminder"]
        entropicide.send_reminders(local("2026-11-02T07:05"))
        assert len(sent) == 2


def test_quiet_hours_setting(user_client):
    client = user_client("ann")
    assert client.patch("/api/me/settings", json={"quiet_hours": "22:00-22:00"}, headers=H).status_code == 400
    assert client.patch("/api/me/settings", json={"quiet_hours": "25:00-07:00"}, headers=H).status_code == 400
    assert client.patch("/api/me/settings", json={"quiet_hours": "21:30-06:45"}, headers=H).get_json()["quiet_hours"] == "21:30-06:45"



def test_reminder_before_due_follows_it(user_client):
    client = user_client("ann", settings=json.dumps({"timezone": "America/Denver"}))
    utc = lambda stamp: entropicide.utc_stamp(local(stamp))  # noqa: E731
    assert client.post("/api/tasks", json={"title": "No due", "remind_before": 7}, headers=H).status_code == 400
    task = client.post("/api/tasks", json={"title": "Passport", "due_date": "2026-12-01", "remind_before": 30},
                       headers=H).get_json()
    assert task["remind_at"] == utc("2026-11-01T09:00") and task["remind_before"] == 30
    patch = lambda changes: client.patch(f"/api/tasks/{task['id']}", json=changes, headers=H)  # noqa: E731
    assert patch({"remind_before": 5}).status_code == 400
    assert patch({"due_date": "2026-12-10"}).get_json()["remind_at"] == utc("2026-11-10T09:00")
    # Set at a time instead: no longer counted from the due date, but moves with it.
    t = patch({"remind_at": utc("2026-11-20T15:30")}).get_json()
    assert t["remind_before"] is None
    assert patch({"due_date": "2026-12-13"}).get_json()["remind_at"] == utc("2026-11-23T15:30")
    # Without a due date, a reminder before it stays at its time.
    patch({"remind_before": 7})
    t = patch({"due_date": None}).get_json()
    assert t["remind_at"] == utc("2026-12-06T09:00") and t["remind_before"] is None


def test_reminder_before_due_says_when(app, make_user, monkeypatch):
    sent = []
    monkeypatch.setattr(entropicide, "notify", lambda uid, message: sent.append(message["title"]) or 1)
    user = make_user("ann", settings=json.dumps({"timezone": "America/Denver", "digest_time": ""}))
    with app.app_context():
        conn = entropicide.db.get_db()
        conn.execute("INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, 'https://x', 'k', 'a')",
                     (user["id"],))
        entropicide.db.insert(conn, "tasks", {"user_id": user["id"], "title": "Renew passport", "state": "later",
                                              "due_date": "2026-12-01", "remind_before": 30, "position": 1,
                                              "remind_at": entropicide.utc_stamp(local("2026-11-01T09:00"))})
        conn.commit()
        entropicide.send_reminders(local("2026-11-01T08:59"))
        assert sent == []
        entropicide.send_reminders(local("2026-11-01T09:01"))
        assert sent == ["⏰ Due in 30 days: Renew passport"]
