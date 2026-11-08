"""Related to: tasks linked both ways, which changes nothing about either."""
from conftest import H, rows


def test_related_tasks_link_both_ways(app, user_client):
    client = user_client("ann")
    add = lambda **t: client.post("/api/tasks", json=t, headers=H).get_json()  # noqa: E731
    paint = add(title="Paint the bedroom", state="next")["id"]
    colours = add(title="Choose colours", state="next")["id"]
    quote = add(title="Get a quote", state="next", related=[paint])
    assert [r["title"] for r in quote["related"]] == ["Paint the bedroom"]
    r = client.patch(f"/api/tasks/{paint}", json={"related": [colours, quote["id"], colours]}, headers=H)
    assert [x["title"] for x in r.get_json()["related"]] == ["Choose colours", "Get a quote"]
    data = {t["id"]: t for t in client.get("/api/data").get_json()["tasks"]}
    assert [x["id"] for x in data[colours]["related"]] == [paint]
    assert all(t["state"] == "next" for t in data.values())  # nothing hidden or moved
    # Done and trashed ones stay, marked.
    client.patch(f"/api/tasks/{colours}", json={"completed": True}, headers=H)
    paint_now = client.patch(f"/api/tasks/{paint}", json={}, headers=H).get_json()
    assert [(x["title"], x["done"]) for x in paint_now["related"]] == [("Choose colours", True), ("Get a quote", False)]
    # Taking one off takes it off both.
    client.patch(f"/api/tasks/{paint}", json={"related": [colours]}, headers=H)
    assert rows(app, "SELECT a, b FROM document_links ORDER BY a") == [{"a": min(paint, colours), "b": max(paint, colours)}]
    assert client.patch(f"/api/tasks/{paint}", json={"related": [paint]}, headers=H).status_code == 400


def test_copies_keep_their_links(app, user_client):
    client = user_client("ann")
    add = lambda **t: client.post("/api/tasks", json=t, headers=H).get_json()["id"]  # noqa: E731
    bins = add(title="Bin bags", state="next")
    water = add(title="Take bins out", state="next", start_date="2026-01-05", repeat="weekly", related=[bins])
    copies = [t for t in client.get("/api/data").get_json()["tasks"] if t["title"] == "Take bins out"]
    assert len(copies) > 1 and all([r["id"] for r in t["related"]] == [bins] for t in copies)
    dup = client.post(f"/api/tasks/{water}/duplicate", headers=H).get_json()
    assert [r["id"] for r in dup["related"]] == [bins]
    # Deleting a task forever removes its links.
    assert client.delete(f"/api/tasks/{bins}", headers=H).status_code == 204
    assert rows(app, "SELECT * FROM document_links WHERE a = ? OR b = ?", bins, bins) == []
