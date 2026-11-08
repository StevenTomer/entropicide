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
    add(title="Call the plumber", state="next", project_id=house)
    # A sequential project's subprojects go one at a time (highest priority first).
    assert queue() == ["Buy paint", "Call the plumber"]
    patch(paint, state="done")
    assert queue() == ["Sand floors", "Call the plumber"]
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
