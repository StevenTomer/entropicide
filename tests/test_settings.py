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


def test_other_devices_see_shrunk_events(user_client):
    """GET /api/changes, which open apps check every 30 seconds, says which are shrunk now."""
    ann = user_client("ann")
    assert ann.get("/api/changes").get_json()["focus_shrunk"] == []
    ann.patch("/api/me/settings", json={"focus_shrunk": ["abc|2099-01-01"]}, headers=H)
    assert ann.get("/api/changes").get_json()["focus_shrunk"] == ["abc|2099-01-01"]


def test_weather(user_client, monkeypatch):
    """Focus's weather: none until there's a place; then now and tomorrow, asked once a while."""
    from conftest import entropicide
    entropicide._weather_cache.clear()
    asked = []

    def fake(url, timeout=6):
        asked.append(url)
        return {"current": {"temperature_2m": 63.4, "weather_code": 3, "is_day": 1},
                "daily": {"weather_code": [3, 71], "temperature_2m_max": [66.2, 35.0], "temperature_2m_min": [40.1, 28.6],
                          "precipitation_probability_max": [10, 70], "snowfall_sum": [0, 2.1]}}
    monkeypatch.setattr(entropicide, "outside_json", fake)
    ann = user_client("ann")
    assert ann.get("/api/weather").get_json() == {"place": None}
    assert ann.patch("/api/me/settings", json={"weather_place": {"name": "Denver", "lat": 200, "lon": 0}}, headers=H).status_code == 400
    ann.patch("/api/me/settings", json={"weather_place": {"name": "Denver, Colorado", "lat": 39.7392, "lon": -104.9847}}, headers=H)
    w = ann.get("/api/weather").get_json()
    assert (w["now"], w["tomorrow"], w["units"]) == ({"temp": 63, "code": 3, "is_day": True},
                                                     {"code": 71, "high": 35, "low": 29, "chance": 70, "falls": "snow"}, "fahrenheit")
    assert (w["today"]["chance"], w["today"]["falls"]) == (10, "rain")
    assert "latitude=39.739" in asked[0] and "temperature_unit=fahrenheit" in asked[0]
    ann.get("/api/weather")
    assert len(asked) == 1  # (kept a while)
    ann.patch("/api/me/settings", json={"weather_units": "celsius"}, headers=H)
    ann.get("/api/weather")
    assert len(asked) == 2 and "temperature_unit=celsius" in asked[1]
