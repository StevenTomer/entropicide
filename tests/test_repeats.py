"""Repeats on certain days of the week (days:0,2,4 is Mon, Wed and Fri)."""
from datetime import date

import pytest

from conftest import H, entropicide


@pytest.mark.parametrize("start, n, expected", [
    ("2026-11-02", 1, "2026-11-04"),   # Mon → Wed
    ("2026-11-04", 1, "2026-11-06"),   # Wed → Fri
    ("2026-11-06", 1, "2026-11-09"),   # Fri → next Mon
    ("2026-11-02", 3, "2026-11-09"),
    ("2026-11-03", 1, "2026-11-04"),   # from a Tuesday (not one of them): the next one
    ("2026-11-09", -1, "2026-11-06"),
])
def test_shift_on_week_days(start, n, expected):
    assert entropicide.shift(date.fromisoformat(start), "days:0,2,4", n) == date.fromisoformat(expected)


@pytest.mark.parametrize("repeat, ok", [
    ("days:0,2,4", True), ("days:6", True), ("days:0,1,2,3,4,5,6", True),
    ("days:2,0", False), ("days:0,0", False), ("days:7", False), ("days:", False),
])
def test_valid_week_days(repeat, ok):
    assert entropicide.valid_repeat(repeat) is ok


def test_next_copy_on_the_next_day(user_client):
    client = user_client("ann")
    task = client.post("/api/tasks", json={"title": "Gym", "state": "scheduled", "start_date": "2030-01-07",
                                           "repeat": "days:0,2,4"}, headers=H)
    assert task.status_code == 201, task.get_json()
    assert client.post("/api/tasks", json={"title": "Bad", "repeat": "days:9"}, headers=H).status_code == 400
    copies = sorted((t["start_date"], t["repeat"]) for t in client.get("/api/data", headers=H).get_json()["tasks"]
                    if t["title"] == "Gym")
    assert copies[0] == ("2030-01-07", "days:0,2,4")  # a Monday; the next copies are Wed, Fri…
    assert all(date.fromisoformat(d).weekday() in (0, 2, 4) for d, _ in copies)


@pytest.mark.parametrize("repeat, start, n, expected", [
    ("nth:1:0", "2026-11-02", 1, "2026-12-07"),    # first Monday
    ("nth:1:0", "2026-11-02", 2, "2027-01-04"),
    ("nth:2:1", "2026-11-10", 1, "2026-12-08"),    # second Tuesday
    ("nth:-1:4", "2026-11-27", 1, "2026-12-25"),   # last Friday
    ("nth:-1:4", "2026-11-27", 3, "2027-02-26"),
    ("nth:4:3", "2026-11-26", 12, "2027-11-25"),   # fourth Thursday (Thanksgiving)
    ("nth:1:0", "2026-11-02", -1, "2026-10-05"),
    ("nth:1:0", "2026-11-02", 0, "2026-11-02"),
])
def test_shift_nth_weekday(repeat, start, n, expected):
    assert entropicide.shift(date.fromisoformat(start), repeat, n) == date.fromisoformat(expected)


@pytest.mark.parametrize("repeat, ok", [("nth:1:0", True), ("nth:-1:6", True), ("nth:5:0", False), ("nth:0:0", False),
                                         ("nth:1:7", False)])
def test_valid_nth(repeat, ok):
    assert entropicide.valid_repeat(repeat) is ok


def test_nth_keeps_missed_copies():
    assert entropicide.db.default_on_miss("nth:1:0") == "keep"
