"""Projects with tags, files, priority, Blocked by and Related to; and Convert to project."""
import io
import sqlite3

import db
from conftest import H, legacy_db, rows


def helpers(client):
    add = lambda **t: client.post("/api/tasks", json=t, headers=H).get_json()  # noqa: E731
    project = lambda **p: client.post("/api/projects", json=p, headers=H).get_json()  # noqa: E731
    patch = lambda kind, i, **c: client.patch(f"/api/{kind}/{i}", json=c, headers=H)  # noqa: E731
    return add, project, patch


def data(client):
    d = client.get("/api/data").get_json()
    return {t["id"]: t for t in d["tasks"]}, {p["id"]: p for p in d["projects"]}


def test_project_tags_priority_and_related(app, user_client):
    client = user_client("ann")
    add, project, patch = helpers(client)
    house = project(name="House", tags=["home"], priority=3)
    assert house["tags"] == ["home"] and house["priority"] == 3
    garden = project(name="Garden")["id"]
    seeds = add(title="Buy seeds", state="next")["id"]
    p = patch("projects", house["id"], tags=["home", "weekend"], related=[seeds, garden]).get_json()
    assert p["tags"] == ["home", "weekend"]
    assert [(r["title"], r["kind"]) for r in p["related"]] == [("Buy seeds", "task"), ("Garden", "project")]
    tasks, projects = data(client)
    assert [r["title"] for r in tasks[seeds]["related"]] == ["House"]
    assert [r["title"] for r in projects[garden]["related"]] == ["House"]
    assert patch("projects", house["id"], related=[house["id"]]).status_code == 400
    assert patch("projects", house["id"], priority=500).status_code == 400
    # Renaming a tag onto another merges them on projects too.
    tags = {t["name"]: t["id"] for t in client.get("/api/data").get_json()["tags"]}
    client.patch(f"/api/tags/{tags['weekend']}", json={"name": "home"}, headers=H)
    assert data(client)[1][house["id"]]["tags"] == ["home"]


def test_project_blocked_by_holds_back_its_tasks(app, user_client):
    client = user_client("ann")
    add, project, patch = helpers(client)
    permit = add(title="Get the permit", state="next")["id"]
    build = project(name="Build the shed")["id"]
    walls = add(title="Put up walls", state="next", project_id=build)["id"]
    paint = add(title="Paint the shed", state="next")["id"]
    assert patch("projects", build, blocked_by=[permit]).get_json()["blocked_by"] == [permit]
    assert patch("tasks", paint, blocked_by=[build]).get_json()["blocked_by"] == [build]
    queue = lambda: client.get("/api/read/queue", headers={"Authorization": "Bearer " + key}).get_json()  # noqa: E731
    key = client.post("/api/devices", json={"kind": "api", "name": "t", "can_read": True}, headers=H).get_json()["key"]
    assert [t["title"] for t in queue()["tasks"]] == ["Get the permit"]
    patch("tasks", permit, completed=True)
    assert [t["title"] for t in queue()["tasks"]] == ["Put up walls"]
    patch("projects", build, state="done")
    assert [t["title"] for t in queue()["tasks"]] == ["Paint the shed"]  # (a done project's tasks leave the Queue)
    # Waits that could never end are refused.
    assert patch("projects", build, blocked_by=[walls]).status_code == 400          # its own task
    assert patch("tasks", walls, blocked_by=[build]).status_code == 400    # its own project
    other = project(name="Other")["id"]
    patch("projects", other, blocked_by_projects=[build])  # (as older apps sent projects)
    assert data(client)[1][other]["blocked_by"] == [build]
    assert patch("projects", build, blocked_by=[other]).status_code == 400  # a loop
    assert patch("tasks", walls, blocked_by=[other]).status_code == 400     # a loop through its project


def test_project_attachments(app, user_client):
    client = user_client("ann")
    _, project, _ = helpers(client)
    pid = project(name="Trip")["id"]
    r = client.post(f"/api/projects/{pid}/attachments", data={"file": (io.BytesIO(b"tickets"), "tickets.txt")},
                    headers=H, content_type="multipart/form-data")
    assert r.status_code == 201
    f = r.get_json()["attachments"][0]
    assert f["name"] == "tickets.txt"
    assert client.get(f"/api/attachments/{f['id']}").get_data() == b"tickets"
    assert client.get("/api/storage").get_json()["largest"][0]["project_id"] == pid
    assert client.delete(f"/api/attachments/{f['id']}", headers=H).get_json()["attachments"] == []
    assert rows(app, "SELECT COUNT(*) AS n FROM blobs") == [{"n": 0}]


def test_drawings_are_shown_sandboxed(user_client):
    """Drawings are SVG files: shown as pictures, but never able to run anything."""
    client = user_client("ann")
    _, project, _ = helpers(client)
    pid = project(name="Shed")["id"]
    svg = b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><path d="M0 0L9 9"/></svg>'
    r = client.post(f"/api/projects/{pid}/attachments", data={"file": (io.BytesIO(svg), "Sketch.sketch.svg")},
                    headers=H, content_type="multipart/form-data")
    f = r.get_json()["attachments"][0]
    assert f["mime"] == "image/svg+xml"
    got = client.get(f"/api/attachments/{f['id']}")
    assert got.mimetype == "image/svg+xml" and "attachment" not in got.headers.get("Content-Disposition", "")
    assert got.headers["Content-Security-Policy"].startswith("sandbox; default-src 'none'")
    assert got.headers["X-Content-Type-Options"] == "nosniff"


def test_convert_task_to_project(app, user_client):
    client = user_client("ann")
    add, project, patch = helpers(client)
    house = project(name="House")["id"]
    plan = add(title="Plan the party", state="someday", due_date="2026-12-20", project_id=house, focus=True,
               tags=["fun"], priority=2, notes="<p>For Sam's birthday</p><ul data-check><li>Book the hall</li><li data-done=\"1\">Pick a date</li>"
                     "<li>Invite everyone</li></ul>")["id"]
    client.post(f"/api/tasks/{plan}/attachments", data={"file": (io.BytesIO(b"list"), "guests.txt")},
                headers=H, content_type="multipart/form-data")
    budget = add(title="Set a budget", state="next")["id"]
    cake = add(title="Order the cake", state="next")["id"]
    friend = add(title="Ask Jo", state="next")["id"]
    patch("tasks", plan, blocked_by=[budget], related=[friend])
    patch("tasks", cake, blocked_by=[plan])
    r = client.post(f"/api/tasks/{plan}/convert", json={"checklist": True}, headers=H)
    assert r.status_code == 201
    p = r.get_json()
    assert (p["name"], p["state"], p["due_date"], p["focus"], p["priority"], p["tags"]) == \
        ("Plan the party", "someday", "2026-12-20", True, 2, ["fun"])
    assert p["notes"] == "<p>For Sam's birthday</p>"
    assert [f["name"] for f in p["attachments"]] == ["guests.txt"]
    assert p["blocked_by"] == [budget]
    assert [r["title"] for r in p["related"]] == ["Ask Jo"] and p["parent_id"] == house  # (a subproject of House)
    tasks, _ = data(client)
    assert plan not in tasks
    assert tasks[cake]["blocked_by"] == [p["id"]] == [plan]  # (the same document)
    mine = rows(app, "SELECT title, completed_at IS NOT NULL AS done FROM tasks WHERE project_id = ? "
                     "ORDER BY position", p["id"])
    assert mine == [{"title": "Book the hall", "done": 0}, {"title": "Pick a date", "done": 1},
                    {"title": "Invite everyone", "done": 0}]
    # Without checklist: the notes stay as they were, and no tasks are made.
    one = add(title="Paint", notes="<ul data-check><li>sand</li></ul>")["id"]
    p2 = client.post(f"/api/tasks/{one}/convert", json={}, headers=H).get_json()
    assert p2["notes"] == "<ul data-check><li>sand</li></ul>" and not rows(app, "SELECT id FROM tasks WHERE project_id = ?", p2["id"])
    # A repeating task can't be.
    daily = add(title="Walk", repeat="daily", start_date="2026-11-06")["id"]
    assert client.post(f"/api/tasks/{daily}/convert", json={}, headers=H).status_code == 400


def test_attachments_table_upgrades(tmp_path):
    """A database from before projects had files keeps its attachments."""
    path = str(tmp_path / "old.db")
    legacy_db(path, """
        DROP TABLE attachments;
        CREATE TABLE attachments (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, task_id INTEGER NOT NULL,
            name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, blob_id INTEGER NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now')));
        INSERT INTO users (id, username, password_hash) VALUES (1, 'ann', 'x');
        INSERT INTO tasks (id, user_id, title) VALUES (1, 1, 'a');
        INSERT INTO blobs VALUES (1, 'abc', 3, x'616263');
        INSERT INTO attachments (id, user_id, task_id, name, mime, size, blob_id) VALUES (7, 1, 1, 'a.txt', 'text/plain', 3, 1);
    """)
    db.init_db(path)
    conn = sqlite3.connect(path)
    conn.execute("PRAGMA foreign_keys = ON")
    assert conn.execute("SELECT id, document_id, name FROM attachments").fetchall() == [(7, 1, "a.txt")]
    conn.execute("DELETE FROM attachments")  # the trigger that drops unused files still works
    assert conn.execute("SELECT COUNT(*) FROM blobs").fetchone()[0] == 0
