"""Settings kept with the account (so every device agrees)."""
from conftest import H


def test_focus_shrunk_events(user_client):
    """Focus's calendar events made small: kept as event|day, gone once the day's past."""
    ann = user_client("ann")
    keep = ann.patch("/api/me/settings?now=2026-11-10T09:00", json={"focus_shrunk": [
        "abc123|2026-11-10", "abc123|2026-11-10", "def|2026-11-11", "old|2026-11-01", "no day"]}, headers=H)
    assert keep.get_json()["focus_shrunk"] == ["abc123|2026-11-10", "def|2026-11-11"]
    assert ann.get("/api/data").get_json()["user"]["settings"]["focus_shrunk"] == ["abc123|2026-11-10", "def|2026-11-11"]
    assert ann.patch("/api/me/settings", json={"focus_shrunk": "abc"}, headers=H).status_code == 400
