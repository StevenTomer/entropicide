"""Reminders: quiet hours hold them until they end."""
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
        conn.execute("INSERT INTO tasks (user_id, title, state, remind_at, position) VALUES (?, 'Night reminder', 'inbox', ?, 1)",
                     (user["id"], utc("2026-11-02T01:00")))
        conn.execute("INSERT INTO tasks (user_id, title, state, start_date, start_time, position) "
                     "VALUES (?, 'Late start', 'next', '2026-11-01', '23:30', 2)", (user["id"],))
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
