"""Tasks, projects and notes as documents: older databases moved over intact, and the
shared parts (tags, files, Blocked by, Related to) working across kinds."""
import sqlite3

import db
from conftest import H, legacy_db, rows

OLD = """
    INSERT INTO users (id, username, password_hash) VALUES (1, 'ann', 'x');
    INSERT INTO areas (id, user_id, name) VALUES (1, 1, 'Home');
    INSERT INTO tags (id, user_id, name) VALUES (1, 1, 'red'), (2, 1, 'blue');
    INSERT INTO series (id, user_id, repeat, on_miss, base_start) VALUES (1, 1, 'weekly', 'replace', '2026-11-02');
    INSERT INTO projects (id, user_id, name, notes, state, priority, area_id) VALUES
        (1, 1, 'House', 'big', 'active', 2, 1), (2, 1, 'Garden', '', 'someday', 0, NULL);
    INSERT INTO tasks (id, user_id, title, notes, state, project_id, series_id, series_index, gcal_event_id) VALUES
        (5, 1, 'Paint', '[ ] sand', 'next', 1, NULL, NULL, 'ev5'),
        (9, 1, 'Water plants', '', 'next', NULL, 1, 0, NULL),
        (3, 1, 'Buy seeds', '', 'next', 2, NULL, NULL, NULL);
    INSERT INTO notes (id, user_id, title, body, journal_id, entry_date, pinned) VALUES
        (1, 1, 'Colours', '<p>sage</p><p><img data-file="3" data-size="m"></p>', NULL, NULL, 1);
    INSERT INTO task_tags VALUES (5, 1);
    INSERT INTO project_tags VALUES (1, 2);
    INSERT INTO note_tags VALUES (1, 1);
    INSERT INTO task_deps VALUES (5, 3);
    INSERT INTO project_deps (project_id, blocker_task_id) VALUES (2, 9);
    INSERT INTO project_deps (task_id, blocker_project_id) VALUES (9, 1);
    INSERT INTO task_links VALUES (3, 5);
    INSERT INTO project_links (project_id, task_id) VALUES (1, 9);
    INSERT INTO project_links (project_id, other_id) VALUES (1, 2);
    INSERT INTO note_links (note_id, task_id) VALUES (1, 5);
    INSERT INTO note_links (note_id, project_id) VALUES (1, 2);
    INSERT INTO blobs VALUES (1, 'a', 1, x'61'), (2, 'b', 1, x'62'), (3, 'c', 1, x'63');
    INSERT INTO attachments (id, user_id, task_id, name, mime, size, blob_id) VALUES (1, 1, 5, 'plan.txt', 'text/plain', 1, 1);
    INSERT INTO attachments (id, user_id, project_id, name, mime, size, blob_id) VALUES (2, 1, 1, 'deed.txt', 'text/plain', 1, 2);
    INSERT INTO attachments (id, user_id, note_id, name, mime, size, blob_id) VALUES (3, 1, 1, 'sage.png', 'image/png', 1, 3);
"""


def test_old_database_moves_to_documents(tmp_path):
    path = str(tmp_path / "old.db")
    legacy_db(path, OLD)
    db.init_db(path)
    db.init_db(path)  # (and starting again changes nothing)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    q = lambda sql, *a: [tuple(r) for r in conn.execute(sql, a)]  # noqa: E731
    assert q("PRAGMA integrity_check") == [("ok",)] and q("PRAGMA foreign_key_check") == []
    # Tasks keep their ids; projects (then notes) come after the highest task id, in order.
    assert q("SELECT id, kind, title FROM documents ORDER BY id") == [
        (3, "task", "Buy seeds"), (5, "task", "Paint"), (9, "task", "Water plants"),
        (10, "project", "House"), (11, "project", "Garden"), (12, "note", "Colours")]
    assert q("SELECT id, project_id, notes, series_id, gcal_event_id FROM tasks ORDER BY id") == [
        (3, 11, "", None, None), (5, 10, "<ul data-check><li>sand</li></ul>", None, "ev5"), (9, None, "", 1, None)]
    assert q("SELECT id, name, notes, state, priority, area_id FROM projects ORDER BY id") == [
        (10, "House", "<p>big</p>", "active", 2, 1), (11, "Garden", "", "someday", 0, None)]
    assert q("SELECT id, title, pinned, body FROM notes") == [
        (12, "Colours", 1, '<p>sage</p><p><img data-file="3" data-size="m"></p>')]
    # Tags, waits, links and files, each on the right document.
    assert q("SELECT document_id, tag_id FROM document_tags ORDER BY document_id") == [(5, 1), (10, 2), (12, 1)]
    assert q("SELECT document_id, blocker_id FROM document_deps ORDER BY document_id") == [(5, 3), (9, 10), (11, 9)]
    assert q("SELECT a, b FROM document_links ORDER BY a, b") == [(3, 5), (5, 12), (9, 10), (10, 11), (11, 12)]
    assert q("SELECT id, document_id FROM attachments ORDER BY id") == [(1, 5), (2, 10), (3, 12)]
    # Deleting a task through its view: its document, tags, files and links go, and its
    # calendar event is noted for removal.
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("DELETE FROM tasks WHERE id = 5")
    assert q("SELECT COUNT(*) FROM documents WHERE id = 5") == [(0,)]
    assert q("SELECT document_id FROM attachments ORDER BY id") == [(10,), (12,)]
    assert q("SELECT event_id FROM gcal_deletions") == [("ev5",)]
    assert q("SELECT COUNT(*) FROM document_links WHERE 5 IN (a, b)") == [(0,)]


def test_typed_notes_become_formatted_text(tmp_path):
    """Notes typed with a little Markdown become formatted text, once; notes' ☐ lines, checklists."""
    path = str(tmp_path / "old.db")
    legacy_db(path, """
        INSERT INTO users (id, username, password_hash) VALUES (1, 'ann', 'x');
        INSERT INTO tasks (id, user_id, title, notes) VALUES (1, 1, 'a', '# Plan' || char(10) || 'Buy **milk**'
            || char(10) || '[ ] sand' || char(10) || '- [x] prime' || char(10) || 'see https://e.com.');
        INSERT INTO notes (id, user_id, body) VALUES (1, 1, '<p>Hall</p><p>☐ test pot</p><p>☑ swatch</p>');
    """)
    db.init_db(path)
    conn = sqlite3.connect(path)
    assert conn.execute("SELECT notes FROM tasks").fetchone()[0] == (
        '<h1>Plan</h1><p>Buy <b>milk</b></p><ul data-check><li>sand</li><li data-done="1">prime</li></ul>'
        '<p>see <a href="https://e.com" target="_blank" rel="noopener noreferrer">https://e.com</a>.</p>')
    assert conn.execute("SELECT body FROM notes").fetchone()[0] == \
        '<p>Hall</p><ul data-check><li>test pot</li><li data-done="1">swatch</li></ul>'
    conn.execute("UPDATE documents SET body = '**not again**' WHERE kind = 'task'")
    conn.commit()
    db.init_db(path)
    assert conn.execute("SELECT notes FROM tasks").fetchone()[0] == "**not again**"


def test_broken_old_references_are_dropped(tmp_path):
    """Waits and links to something long gone (never shown) don't stop the move."""
    path = str(tmp_path / "old.db")
    legacy_db(path, """
        INSERT INTO users (id, username, password_hash) VALUES (1, 'ann', 'x');
        INSERT INTO tasks (id, user_id, title) VALUES (1, 1, 'a');
        PRAGMA foreign_keys = OFF;
        INSERT INTO task_deps VALUES (1, 99);
        INSERT INTO task_links VALUES (1, 98);
    """)
    db.init_db(path)
    conn = sqlite3.connect(path)
    assert conn.execute("SELECT COUNT(*) FROM document_deps").fetchone()[0] == 0
    assert conn.execute("SELECT title FROM tasks").fetchall() == [("a",)]


def test_new_database_has_documents(tmp_path):
    path = str(tmp_path / "new.db")
    db.init_db(path)
    conn = db.connect(path)
    uid = conn.execute("INSERT INTO users (username, password_hash) VALUES ('ann', 'x')").lastrowid
    p = db.insert(conn, "projects", {"user_id": uid, "name": "P"})
    t = db.insert(conn, "tasks", {"user_id": uid, "title": "T", "project_id": p})
    n = db.insert(conn, "notes", {"user_id": uid, "body": "<p>x</p>"})
    assert (t, n) == (p + 1, p + 2)  # one id space
    row = conn.execute("SELECT * FROM tasks WHERE id = ?", (t,)).fetchone()
    assert (row["state"], row["notes"], row["people"], row["project_id"]) == ("inbox", "", "[]", p)
    conn.execute("DELETE FROM projects WHERE id = ?", (p,))
    assert conn.execute("SELECT project_id FROM tasks WHERE id = ?", (t,)).fetchone()[0] is None


def test_converting_a_task_keeps_its_id(app, user_client):
    client = user_client("ann")
    add = lambda **t: client.post("/api/tasks", json=t, headers=H).get_json()["id"]  # noqa: E731
    first = add(title="First", state="next")
    t = add(title="Trip", notes="<ul data-check><li>tickets</li></ul>", tags=["fun"], blocked_by=[first])
    waiter = add(title="Pack", state="next", blocked_by=[t])
    p = client.post(f"/api/tasks/{t}/convert", json={"checklist": True}, headers=H).get_json()
    assert p["id"] == t and p["tags"] == ["fun"] and p["blocked_by"] == [first]
    waiting = next(x for x in client.get("/api/data").get_json()["tasks"] if x["id"] == waiter)
    assert waiting["blocked_by"] == [t]
    assert rows(app, "SELECT kind FROM documents WHERE id = ?", t) == [{"kind": "project"}]
    # A task becoming a note keeps its id too; a note waits on nothing, and nothing on it.
    n = add(title="Idea", tags=["fun"], blocked_by=[first])
    note = client.post(f"/api/tasks/{n}/to-note", json={}, headers=H).get_json()
    assert note["id"] == n and note["tags"] == ["fun"]
    assert rows(app, "SELECT * FROM document_deps WHERE document_id = ?", n) == []


def test_converting_between_every_kind(app, user_client):
    client = user_client("ann")
    note = client.post("/api/notes", json={"body": "<p>Fix the gate</p><p>it squeaks</p>", "tags": ["home"]},
                       headers=H).get_json()["id"]
    convert = lambda i, to: client.post(f"/api/documents/{i}/convert", json={"to": to}, headers=H)  # noqa: E731
    t = convert(note, "task").get_json()
    assert (t["id"], t["title"], t["state"], t["tags"]) == (note, "Fix the gate", "inbox", ["home"])
    assert t["notes"] == "<p>Fix the gate</p><p>it squeaks</p>"
    p = convert(note, "project").get_json()
    assert (p["id"], p["name"], p["state"]) == (note, "Fix the gate", "active")
    n = convert(note, "note").get_json()
    assert (n["id"], n["title"], n["tags"]) == (note, "Fix the gate", ["home"])
    assert convert(note, "note").status_code == 400 and convert(note, "box").status_code == 400
    # A project with something in it stays one.
    full = client.post("/api/projects", json={"name": "Garden"}, headers=H).get_json()["id"]
    client.post("/api/tasks", json={"title": "Dig", "project_id": full}, headers=H)
    assert "move its tasks" in convert(full, "task").get_json()["error"]
    assert user_client("bob").post(f"/api/documents/{note}/convert", json={"to": "task"}, headers=H).status_code == 404


def test_subprojects(app, user_client):
    client = user_client("ann")
    project = lambda **p: client.post("/api/projects", json=p, headers=H).get_json()["id"]  # noqa: E731
    add = lambda **t: client.post("/api/tasks", json=t, headers=H).get_json()["id"]  # noqa: E731
    patch = lambda i, **c: client.patch(f"/api/projects/{i}", json=c, headers=H)  # noqa: E731
    key = client.post("/api/devices", json={"kind": "api", "name": "t", "can_read": True}, headers=H).get_json()["key"]
    queue = lambda: [t["title"] for t in client.get("/api/read/queue", headers={"Authorization": "Bearer " + key}).get_json()["tasks"]]  # noqa: E731
    house = project(name="House", sequential=True)
    paint = project(name="Paint", parent_id=house, priority=1)
    floors = project(name="Floors", parent_id=house)
    add(title="Buy paint", state="next", project_id=paint)
    add(title="Sand floors", state="next", project_id=floors)
    plumber = add(title="Call the plumber", state="next", project_id=house)
    # A sequential project's steps (its tasks and subprojects, in one order: here Paint, Floors,
    # then the plumber, as they were added) go one at a time.
    assert queue() == ["Buy paint"]
    patch(paint, state="done")
    assert queue() == ["Sand floors"]
    # Dragged first on the project's page, the plumber comes before the floors.
    client.post("/api/reorder/tasks", json={"ids": [plumber, floors]}, headers=H)
    assert rows(app, "SELECT step FROM project_data WHERE id = ?", floors) == [{"step": 1.0}]
    assert queue() == ["Call the plumber"]
    client.patch(f"/api/tasks/{plumber}", json={"completed": True}, headers=H)
    assert queue() == ["Sand floors"]
    # A parent that's in Someday, or waiting, holds back everything under it.
    patch(house, state="someday")
    assert queue() == []
    patch(house, state="active", sequential=False)
    gate = add(title="Get the permit", state="next")
    patch(house, blocked_by=[gate])
    assert queue() == ["Get the permit"]
    # No loops: a project inside itself, or under one that waits on something inside it.
    assert patch(house, parent_id=floors).status_code == 400
    waiting = project(name="Later stuff")
    patch(waiting, blocked_by=[floors])
    assert patch(house, parent_id=waiting).status_code == 400
    assert patch(floors, parent_id=None).get_json()["parent_id"] is None
    # Nor a project put inside one it waits on (it couldn't start before that's done, which
    # can't be done before it is); nor a task moved into a project that waits on it.
    shed = project(name="Shed", blocked_by=[house])
    assert patch(shed, parent_id=house).status_code == 400
    assert rows(app, "SELECT parent_id FROM project_data WHERE id = ?", shed) == [{"parent_id": None}]
    assert client.patch(f"/api/tasks/{gate}", json={"project_id": house}, headers=H).status_code == 400


def test_subprojects_get_a_step_on_upgrade(tmp_path):
    """Databases from before subprojects had places among their parent's tasks get them."""
    path = str(tmp_path / "db.db")
    db.init_db(path)
    conn = db.connect(path)
    uid = conn.execute("INSERT INTO users (username, password_hash) VALUES ('ann', 'x')").lastrowid
    house = db.insert(conn, "projects", {"user_id": uid, "name": "House"})
    db.insert(conn, "tasks", {"user_id": uid, "title": "Paint", "project_id": house, "position": 7})
    shed = db.insert(conn, "projects", {"user_id": uid, "name": "Shed", "parent_id": house})
    conn.executescript("DROP VIEW tasks; DROP VIEW projects; DROP VIEW notes; ALTER TABLE project_data DROP COLUMN step;")
    conn.commit()
    conn.close()
    db.init_db(path)
    conn = db.connect(path)
    step = conn.execute("SELECT step FROM projects WHERE id = ?", (shed,)).fetchone()[0]
    assert 8 <= step < 8.001  # after its parent's tasks
    assert conn.execute("SELECT step FROM projects WHERE id = ?", (house,)).fetchone()[0] is None


def test_a_step_keeps_its_place_when_it_changes_kind(app, user_client):
    client = user_client("ann")
    house = client.post("/api/projects", json={"name": "House", "sequential": True}, headers=H).get_json()["id"]
    add = lambda t: client.post("/api/tasks", json={"title": t, "state": "next", "project_id": house}, headers=H).get_json()  # noqa: E731
    first, second = add("Fix the roof"), add("Paint")
    p = client.post(f"/api/tasks/{first['id']}/convert", json={}, headers=H).get_json()
    assert p["parent_id"] == house and p["step"] == first["position"] < second["position"]
    t = client.post(f"/api/documents/{p['id']}/convert", json={"to": "task"}, headers=H).get_json()
    assert t["project_id"] == house and t["position"] == first["position"]
    # Moved into a project, a project goes after what's there.
    other = client.post("/api/projects", json={"name": "Garage"}, headers=H).get_json()["id"]
    moved = client.patch(f"/api/projects/{other}", json={"parent_id": house}, headers=H).get_json()
    assert moved["step"] > second["position"]
    assert client.patch(f"/api/projects/{other}", json={"parent_id": None}, headers=H).get_json()["step"] is None


def test_a_project_goes_to_the_trash_with_everything_in_it(app, user_client):
    client = user_client("ann")
    project = lambda **p: client.post("/api/projects", json=p, headers=H).get_json()["id"]  # noqa: E731
    add = lambda **t: client.post("/api/tasks", json=t, headers=H).get_json()["id"]  # noqa: E731
    key = client.post("/api/devices", json={"kind": "api", "name": "t", "can_read": True}, headers=H).get_json()["key"]
    queue = lambda: [t["title"] for t in client.get("/api/read/queue", headers={"Authorization": "Bearer " + key}).get_json()["tasks"]]  # noqa: E731
    house = project(name="House")
    shed = project(name="Shed", parent_id=house)
    paint = add(title="Paint", state="next", project_id=house)
    add(title="Roof", state="next", project_id=shed)
    old = add(title="Old idea", state="next", project_id=house)
    client.patch(f"/api/tasks/{old}", json={"deleted": True}, headers=H)  # (trashed before the project)
    with app.app_context():
        conn = db.get_db()
        conn.execute("UPDATE documents SET deleted_at = '2026-01-01 00:00:00' WHERE id = ?", (old,))
        conn.commit()
    client.patch(f"/api/projects/{house}", json={"deleted": True}, headers=H)
    assert queue() == []
    data = client.get("/api/data").get_json()
    assert not data["tasks"] and not data["projects"]
    # The Trash lists the project (and the task trashed before it), not what went with it.
    trash = client.get("/api/trash").get_json()
    assert [(p["name"], p["inside"]) for p in trash["projects"]] == [("House", 3)]
    assert [t["title"] for t in trash["tasks"]] == ["Old idea"]
    # Back again, with what went with it; the task trashed before stays there.
    client.patch(f"/api/projects/{house}", json={"deleted": False}, headers=H)
    assert sorted(queue()) == ["Paint", "Roof"]
    assert [t["title"] for t in client.get("/api/trash").get_json()["tasks"]] == ["Old idea"]
    # Brought back on its own while its project is in the trash, a task is out of the project.
    client.patch(f"/api/projects/{house}", json={"deleted": True}, headers=H)
    client.patch(f"/api/tasks/{paint}", json={"deleted": False}, headers=H)
    assert rows(app, "SELECT project_id FROM tasks WHERE id = ?", paint) == [{"project_id": None}]
    # Deleted for good: everything in it goes too.
    assert client.delete(f"/api/documents/{house}", headers=H).status_code == 204
    assert rows(app, "SELECT title FROM documents ORDER BY id") == [{"title": "Paint"}]
    assert client.delete(f"/api/documents/{paint}", headers=H).status_code == 204
    assert user_client("bob").delete(f"/api/documents/{house}", headers=H).status_code == 404


def test_emptying_the_trash(app, user_client):
    client = user_client("ann")
    house = client.post("/api/projects", json={"name": "House"}, headers=H).get_json()["id"]
    client.post("/api/tasks", json={"title": "Paint", "project_id": house}, headers=H)
    keep = client.post("/api/tasks", json={"title": "Keep"}, headers=H).get_json()["id"]
    client.patch(f"/api/projects/{house}", json={"deleted": True}, headers=H)
    client.post("/api/trash/empty", headers=H)
    assert rows(app, "SELECT id FROM documents") == [{"id": keep}]


def test_items_left_in_trashed_projects_are_untangled(tmp_path):
    path = str(tmp_path / "db.db")
    db.init_db(path)
    conn = db.connect(path)
    uid = conn.execute("INSERT INTO users (username, password_hash) VALUES ('ann', 'x')").lastrowid
    house = db.insert(conn, "projects", {"user_id": uid, "name": "House", "deleted_at": "2026-11-01 00:00:00"})
    paint = db.insert(conn, "tasks", {"user_id": uid, "title": "Paint", "project_id": house})
    conn.execute("PRAGMA user_version = 2")
    conn.commit()
    conn.close()
    db.init_db(path)
    conn = db.connect(path)
    assert conn.execute("SELECT project_id, deleted_at FROM tasks WHERE id = ?", (paint,)).fetchone()[:] == (None, None)


def test_areas(app, user_client):
    client = user_client("ann")
    r = client.post("/api/areas", json={"name": "  Home  "}, headers=H)
    assert r.status_code == 201 and r.get_json()["name"] == "Home" and "user_id" not in r.get_json()
    area = r.get_json()["id"]
    assert client.post("/api/areas", json={"name": " "}, headers=H).status_code == 400
    assert client.patch(f"/api/areas/{area}", json={"name": "House"}, headers=H).get_json()["name"] == "House"
    t = client.post("/api/tasks", json={"title": "Sweep", "area_id": area}, headers=H).get_json()["id"]
    assert user_client("bob").delete(f"/api/areas/{area}", headers=H).status_code == 404
    assert client.delete(f"/api/areas/{area}", headers=H).status_code == 204
    assert rows(app, "SELECT area_id FROM tasks WHERE id = ?", t) == [{"area_id": None}]


def test_timelines(app, user_client):
    client = user_client("ann", settings='{"timezone": "UTC"}')
    add = lambda **t: client.post("/api/tasks", json=t, headers=H).get_json()["id"]  # noqa: E731
    house = client.post("/api/projects", json={"name": "House", "waypoint": True, "due_date": "2027-03-01"},
                        headers=H).get_json()["id"]
    roof = add(title="Fix the roof", due_date="2026-12-01", waypoint=True, project_id=house)
    add(title="Buy nails", due_date="2026-11-20", project_id=house)  # (not a waypoint)
    paint = add(title="Paint", start_date="2026-11-25", waypoint=True)
    client.patch(f"/api/tasks/{paint}", json={"completed": True}, headers=H)
    line = lambda q="": client.get("/api/timeline" + q).get_json()["items"]  # noqa: E731
    assert [(x["title"], x["when"]) for x in line()][-2:] == [("Fix the roof", "due"), ("House", "due")]
    assert [x["title"] for x in line() if x["when"] == "done"] == ["Paint"]
    assert [x["title"] for x in line(f"?project={house}")] == ["Fix the roof", "House"]
    assert [x["title"] for x in line(f"?project={house}&all=1")] == ["Buy nails", "Fix the roof", "House"]
    # Journals: their entries, at their moments; archived notes are still notes.
    j = client.post("/api/journals", json={"name": "Diary"}, headers=H).get_json()["id"]
    client.post("/api/notes", json={"journal_id": j, "entry_date": "2026-11-02", "entry_time": "08:00",
                                    "title": "Moved in", "waypoint": True}, headers=H)
    client.post("/api/notes", json={"journal_id": j, "entry_date": "2026-11-03", "title": "Tuesday"}, headers=H)
    assert [(x["title"], x["date"], x["time"]) for x in line(f"?journal={j}")] == [("Moved in", "2026-11-02", "08:00")]
    n = client.post("/api/notes", json={"title": "Idea", "waypoint": True}, headers=H).get_json()
    assert client.patch(f"/api/notes/{n['id']}", json={"archived": True}, headers=H).get_json()["archived_at"]
    assert [x["title"] for x in line("?notes=1")] == ["Idea"] and n["waypoint"] is True


def test_a_projects_completed_tasks_and_subprojects(app, user_client):
    client = user_client("ann")
    house = client.post("/api/projects", json={"name": "House"}, headers=H).get_json()["id"]
    add = lambda t: client.post("/api/tasks", json={"title": t, "state": "next", "project_id": house}, headers=H).get_json()["id"]  # noqa: E731
    paint, sweep = add("Paint"), add("Sweep")
    add("Still to do")
    shed = client.post("/api/projects", json={"name": "Shed", "parent_id": house}, headers=H).get_json()["id"]
    for t in (paint, sweep):
        client.patch(f"/api/tasks/{t}", json={"completed": True}, headers=H)
    client.patch(f"/api/projects/{shed}", json={"state": "done"}, headers=H)
    p = next(x for x in client.get("/api/data").get_json()["projects"] if x["id"] == house)
    assert p["done"] == 3
    done = client.get(f"/api/projects/{house}/completed").get_json()
    assert sorted(t["title"] for t in done["tasks"]) == ["Paint", "Sweep"] and [x["name"] for x in done["projects"]] == ["Shed"]
    assert user_client("bob").get(f"/api/projects/{house}/completed").status_code == 404


def test_weekly_review_of_projects(app, user_client):
    client = user_client("ann")
    project = lambda **p: client.post("/api/projects?now=2026-11-09T09:00", json=p, headers=H).get_json()  # noqa: E731
    house = project(name="House")
    assert house["review_due"] and house["stalled"]  # (never reviewed; nothing to do next)
    client.post("/api/tasks", json={"title": "Paint", "state": "next", "project_id": house["id"]}, headers=H)
    garden = project(name="Garden", review_every=14)
    client.post("/api/tasks", json={"title": "Some day: a pond", "state": "someday", "project_id": garden["id"]}, headers=H)
    data = lambda now: {p["name"]: p for p in client.get(f"/api/data?now={now}").get_json()["projects"]}  # noqa: E731
    assert not data("2026-11-09T09:00")["House"]["stalled"] and data("2026-11-09T09:00")["Garden"]["stalled"]
    # Reviewed: not due again until its interval has passed.
    for p in (house, garden):
        client.patch(f"/api/projects/{p['id']}?now=2026-11-09T09:00", json={"reviewed": True}, headers=H)
    assert not data("2026-11-15T09:00")["House"]["review_due"]
    assert data("2026-11-16T09:00")["House"]["review_due"] and not data("2026-11-16T09:00")["Garden"]["review_due"]
    assert data("2026-11-23T09:00")["Garden"]["review_due"]
    # Never reviewed, or not active: not due.
    client.patch(f"/api/projects/{house['id']}", json={"review_every": 0}, headers=H)
    client.patch(f"/api/projects/{garden['id']}", json={"state": "someday"}, headers=H)
    assert not any(p["review_due"] for p in data("2026-12-30T09:00").values())
    # When the whole review was last done.
    assert client.patch("/api/me/settings", json={"last_review": "2026-11-09"}, headers=H).get_json()["last_review"] == "2026-11-09"
    assert client.patch("/api/me/settings", json={"review_day": "9"}, headers=H).status_code == 400
