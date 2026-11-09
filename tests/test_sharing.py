"""Sharing with a group: projects (and what's in them), journals (and their entries), single
notes and tasks; who sees and changes what; what's each person's own; assignees; clashes."""
import io

import pytest

from conftest import H, entropicide, rows


@pytest.fixture
def family(user_client):
    """Ann's Family: Bob an editor, Cat a viewer. Dan isn't in it."""
    ann, bob, cat, dan = (user_client(n) for n in ("ann", "bob", "cat", "dan"))
    gid = ann.post("/api/groups", json={"name": "Family"}, headers=H).get_json()["groups"][0]["id"]
    for who, role in (("bob", "editor"), ("cat", "viewer")):
        ann.post(f"/api/groups/{gid}/invites", json={"username": who, "role": role}, headers=H)
    for client in (bob, cat):
        client.post(f"/api/invites/{client.get('/api/groups').get_json()['invites'][0]['id']}/accept", headers=H)
    return gid, ann, bob, cat, dan


def data(client):
    d = client.get("/api/data").get_json()
    return {t["title"]: t for t in d["tasks"]}, {p["name"]: p for p in d["projects"]}, {n["title"]: n for n in d["notes"]}, d


def ids(app):
    return {r["username"]: r["id"] for r in rows(app, "SELECT id, username FROM users")}


def test_a_shared_project_and_whats_in_it(app, family):
    gid, ann, bob, cat, dan = family
    people = ids(app)
    house = ann.post("/api/projects", json={"name": "House"}, headers=H).get_json()["id"]
    paint = ann.post("/api/tasks", json={"title": "Paint", "state": "next", "project_id": house}, headers=H).get_json()["id"]
    assert "Paint" not in data(bob)[0]
    assert ann.patch(f"/api/projects/{house}", json={"group_id": gid}, headers=H).status_code == 200
    # Everyone in the group sees it and what's in it; Dan doesn't, nor can he reach it.
    for client in (bob, cat):
        tasks, projects, _, d = data(client)
        assert projects["House"]["group_id"] == gid and tasks["Paint"]["by"] == people["ann"]
        assert {g["name"] for g in d["groups"]} == {"Family"} and d["people"][str(people["ann"])] == "Ann"
    assert "Paint" not in data(dan)[0]
    assert dan.patch(f"/api/tasks/{paint}", json={"title": "Mine"}, headers=H).status_code == 404
    # Bob (an editor) changes it and adds to it; what he adds is shared too.
    assert bob.patch(f"/api/tasks/{paint}", json={"title": "Paint the hall"}, headers=H).status_code == 200
    bob.post("/api/tasks", json={"title": "Buy brushes", "state": "next", "project_id": house}, headers=H)
    tasks = data(ann)[0]
    assert tasks["Buy brushes"]["group_id"] == gid and tasks["Buy brushes"]["by"] == people["bob"]
    # Cat (a viewer) only looks.
    r = cat.patch(f"/api/tasks/{paint}", json={"title": "Nope"}, headers=H)
    assert r.status_code == 403 and "viewer" in r.get_json()["error"]
    assert cat.post("/api/tasks", json={"title": "Sneak", "project_id": house}, headers=H).status_code == 403
    # Only whoever made it can stop sharing it.
    assert bob.patch(f"/api/projects/{house}", json={"group_id": None}, headers=H).status_code == 400
    # Something in it is shared as it is.
    assert ann.patch(f"/api/tasks/{paint}", json={"group_id": None}, headers=H).status_code == 400


def test_whats_each_persons_own(app, family):
    gid, ann, bob, cat, dan = family
    house = ann.post("/api/projects", json={"name": "House", "group_id": gid}, headers=H).get_json()["id"]
    paint = ann.post("/api/tasks", json={"title": "Paint", "state": "next", "project_id": house}, headers=H).get_json()["id"]
    area = bob.post("/api/areas", json={"name": "Home"}, headers=H).get_json()["id"]
    bob.patch(f"/api/tasks/{paint}", json={"focus": True, "area_id": area}, headers=H)
    assert (data(bob)[0]["Paint"]["focus"], data(bob)[0]["Paint"]["area_id"]) == (True, area)
    assert (data(ann)[0]["Paint"]["focus"], data(ann)[0]["Paint"]["area_id"]) == (False, None)
    # Bob's order of the Queue is his.
    sweep = ann.post("/api/tasks", json={"title": "Sweep", "state": "next", "project_id": house}, headers=H).get_json()["id"]
    bob.post("/api/reorder/tasks", json={"ids": [sweep, paint]}, headers=H)
    order = lambda c: [t["title"] for t in sorted(data(c)[3]["tasks"], key=lambda t: t["position"])]  # noqa: E731
    assert order(bob) == ["Sweep", "Paint"] and order(ann) == ["Paint", "Sweep"]


def test_assigning_a_task(app, family, monkeypatch):
    gid, ann, bob, cat, dan = family
    sent = []
    monkeypatch.setattr(entropicide, "notify", lambda uid, message: sent.append((uid, message["title"])) or 1)
    people = ids(app)
    task = ann.post("/api/tasks", json={"title": "Walk the dog", "state": "next", "group_id": gid}, headers=H).get_json()
    assert task["group_id"] == gid and task["assigned_to"] is None
    assert ann.patch(f"/api/tasks/{task['id']}", json={"assigned_to": people["dan"]}, headers=H).status_code == 400
    ann.patch(f"/api/tasks/{task['id']}", json={"assigned_to": people["cat"]}, headers=H)
    assert sent[-1] == (people["cat"], "Ann gave you a task")
    # It's in Cat's lists, not Ann's (from other apps too); Cat, a viewer, can still tick it off.
    key = lambda c: c.post("/api/devices", json={"name": "k", "kind": "api", "can_read": True}, headers=H).get_json()["key"]  # noqa: E731
    queue = lambda c: [t["title"] for t in c.get("/api/read/queue", headers={"Authorization": f"Bearer {key(c)}"}).get_json()["tasks"]]  # noqa: E731
    assert queue(cat) == ["Walk the dog"] and queue(ann) == []
    assert cat.patch(f"/api/tasks/{task['id']}", json={"title": "Run"}, headers=H).status_code == 403
    assert cat.patch(f"/api/tasks/{task['id']}", json={"completed": True}, headers=H).status_code == 200
    # Unless the group says viewers can't.
    other = ann.post("/api/tasks", json={"title": "Feed the cat", "state": "next", "group_id": gid, "assigned_to": people["cat"]},
                     headers=H).get_json()["id"]
    ann.patch(f"/api/groups/{gid}", json={"viewers_complete": False}, headers=H)
    assert cat.patch(f"/api/tasks/{other}", json={"completed": True}, headers=H).status_code == 403


def test_taking_something_out_of_whats_shared(app, family):
    gid, ann, bob, cat, dan = family
    house = ann.post("/api/projects", json={"name": "House", "group_id": gid}, headers=H).get_json()["id"]
    paint = bob.post("/api/tasks", json={"title": "Paint", "state": "next", "project_id": house}, headers=H).get_json()["id"]
    sweep = ann.post("/api/tasks", json={"title": "Sweep", "state": "next", "project_id": house}, headers=H).get_json()["id"]
    # Bob takes Ann's task out of the project: it's his, and private.
    bob.patch(f"/api/tasks/{sweep}", json={"project_id": None}, headers=H)
    assert "Sweep" not in data(ann)[0] and data(bob)[0]["Sweep"]["group_id"] is None
    # Ending the group: what was in Ann's project (Bob's Paint too) stays together, Ann's.
    ann.delete(f"/api/groups/{gid}", headers=H)
    assert data(ann)[0]["Paint"]["group_id"] is None and "Paint" not in data(bob)[0]
    assert rows(app, "SELECT user_id FROM documents WHERE id = ?", paint) == rows(app, "SELECT id AS user_id FROM users WHERE username = 'ann'")


def test_shared_journals_and_notes(app, family):
    gid, ann, bob, cat, dan = family
    people = ids(app)
    journal = ann.post("/api/journals", json={"name": "Our trip"}, headers=H).get_json()["id"]
    ann.post("/api/notes", json={"title": "Day one", "body": "<p>Rain</p>", "journal_id": journal}, headers=H)
    assert bob.patch(f"/api/journals/{journal}", json={"group_id": gid}, headers=H).status_code == 404
    assert ann.patch(f"/api/journals/{journal}", json={"group_id": gid}, headers=H).status_code == 200
    # Its entries are shared, and so are new ones, whoever writes them.
    bob.post("/api/notes", json={"title": "Day two", "body": "<p>Sun</p>", "journal_id": journal}, headers=H)
    notes = data(cat)[2]
    assert notes["Day one"]["by"] == people["ann"] and notes["Day two"]["by"] == people["bob"]
    assert [j["name"] for j in data(cat)[3]["journals"]] == ["Our trip"]
    assert bob.delete(f"/api/journals/{journal}", headers=H).status_code == 403
    # A single note; its files are for the group to see too.
    note = ann.post("/api/notes", json={"title": "Wifi", "body": "<p>hunter2</p>", "group_id": gid}, headers=H).get_json()["id"]
    f = ann.post(f"/api/notes/{note}/attachments", data={"file": (io.BytesIO(b"pic"), "router.png")},
                 headers=H, content_type="multipart/form-data").get_json()["attachments"][0]["id"]
    assert bob.get(f"/api/attachments/{f}").get_data() == b"pic"
    assert dan.get(f"/api/attachments/{f}").status_code == 404
    assert cat.delete(f"/api/attachments/{f}", headers=H).status_code == 403
    # Pinned is one's own.
    bob.patch(f"/api/notes/{note}", json={"pinned": True}, headers=H)
    assert data(bob)[2]["Wifi"]["pinned"] and not data(ann)[2]["Wifi"]["pinned"]


def test_a_clash_keeps_both(app, family):
    gid, ann, bob, cat, dan = family
    note = ann.post("/api/notes", json={"title": "List", "body": "<p>eggs</p>", "group_id": gid}, headers=H).get_json()
    with app.app_context():  # (as if written a while ago)
        entropicide.db.get_db().execute("UPDATE documents SET updated_at = '2026-01-01 00:00:00' WHERE id = ?", (note["id"],))
        entropicide.db.get_db().commit()
    base = "2026-01-01 00:00:00"
    r = ann.patch(f"/api/notes/{note['id']}", json={"body": "<p>eggs, milk</p>", "base": base}, headers=H).get_json()
    assert "clash" not in r
    # Bob began from the old version: his is saved, and Ann's kept beside it.
    r = bob.patch(f"/api/notes/{note['id']}", json={"body": "<p>eggs, bread</p>", "base": base}, headers=H).get_json()
    assert r["body"] == "<p>eggs, bread</p>" and r["clash"]
    notes = data(ann)[2]
    assert notes["List (the other version)"]["body"] == "<p>eggs, milk</p>" and notes["List (the other version)"]["group_id"] == gid


def test_changes_are_noticed(app, family):
    gid, ann, bob, cat, dan = family
    stamp = lambda c: c.get("/api/changes").get_json()["stamp"]  # noqa: E731
    before = stamp(bob)
    ann.post("/api/tasks", json={"title": "Private", "state": "next"}, headers=H)
    assert stamp(bob) == before
    task = ann.post("/api/tasks", json={"title": "Shared", "state": "next", "group_id": gid}, headers=H).get_json()["id"]
    after = stamp(bob)
    assert after != before
    ann.patch(f"/api/tasks/{task}", json={"state": "soon"}, headers=H)
    assert stamp(bob) != after
