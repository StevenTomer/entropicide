"""Notes and journals: formatted text (kept to a safe set of HTML), categories, tags, areas,
links to tasks, pinning, files and pictures, journals, the trash, sharing to them, and
making a task into a note."""
import io
import json
import re
import sqlite3
import zipfile

import db
import richtext
from conftest import H, legacy_db, rows


def note(client, **n):
    r = client.post("/api/notes", json=n, headers=H)
    assert r.status_code == 201, r.get_json()
    return r.get_json()


def data(client):
    return client.get("/api/data").get_json()


def test_formatted_text_is_cleaned():
    clean = richtext.clean
    assert clean('<p>Hi <b>there</b> <strong>you</strong> <i>x</i><em>y</em> <u>u</u></p>') == \
        "<p>Hi <b>there</b> <b>you</b> <i>x</i><i>y</i> <u>u</u></p>"
    # Scripts, handlers, styles and unknown tags go; their text stays (except scripts').
    assert clean('<p onclick="x()">a<script>alert(1)</script><blink>b</blink></p><style>p{}</style>') == "<p>ab</p>"
    assert clean('<a href="javascript:alert(1)">bad</a> <a href="https://e.com/?a=1&b=2" onclick="x">ok</a>') == \
        'bad <a href="https://e.com/?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">ok</a>'
    # The note's own pictures only, by id.
    assert clean('<img src="https://evil/x.png"><img data-file="12" data-size="s" onerror="x"><img data-file="x">') == \
        '<img data-file="12" data-size="s">'
    # How a picture was edited (crop, turn: only on a copy, with its original) and shows.
    assert clean('<img data-file="13" data-size="m" data-orig="12" data-crop="100,0,250,50" data-rotate="90" '
                 'data-opacity="40" data-behind="1" style="opacity:.4">') == \
        '<img data-file="13" data-size="m" data-orig="12" data-crop="100,0,250,50" data-rotate="90" ' \
        'data-opacity="40" data-behind="1">'
    assert clean('<img data-file="13" data-crop="1,2,3,4" data-rotate="90" data-orig="x" data-opacity="100" '
                 'data-behind="yes">') == '<img data-file="13">'
    assert clean('<img data-file="13" data-orig="12" data-crop="2000,0,0,0" data-rotate="45" data-opacity="3">') == \
        '<img data-file="13" data-orig="12">'
    # Checklists, and ticked items.
    assert clean('<ul data-check="" class="x"><li data-done="1">a</li><li data-done="yes">b</li></ul><ul data-done="1">'
                 '<li>c</li></ul>') == '<ul data-check><li data-done="1">a</li><li>b</li></ul><ul><li>c</li></ul>'
    assert richtext.from_text("[ ] a\n- [x] b\nc") == '<ul data-check><li>a</li><li data-done="1">b</li></ul><p>c</p>'
    assert richtext.plain('<p>List</p><ul data-check><li>a</li><li data-done="1">b</li></ul><ul><li>c</li></ul>') == \
        "List\n[ ] a\n[x] b\nc"
    # Fonts by name; inline styles become tags.
    assert clean('<font face="serif">a</font><font face="Comic Sans MS">b</font><font face="x">c</font>') == \
        '<font face="serif">a</font><font face="hand">b</font>c'
    assert clean('<span style="font-weight: 700; font-style: italic">a</span>') == "<b><i>a</i></b>"
    # Untidy HTML is closed; an empty editor is empty.
    assert clean("<p><b>a</p>") == "<p><b>a</b></p>"
    assert clean("<div><br></div>") == ""
    assert richtext.from_text("Hi <you>\n[ ] milk\nsee https://e.com.") == \
        '<p>Hi &lt;you&gt;</p><ul data-check><li>milk</li></ul><p>see <a href="https://e.com" target="_blank" ' \
        'rel="noopener noreferrer">https://e.com</a>.</p>'


def test_notes(app, user_client):
    client = user_client("ann")
    home = client.post("/api/areas", json={"name": "Home"}, headers=H).get_json()["id"]
    cat = client.post("/api/note-categories", json={"name": "Recipes", "color": "green"}, headers=H).get_json()
    assert (cat["name"], cat["color"]) == ("Recipes", "green")
    assert client.post("/api/note-categories", json={"name": "X", "color": "plaid"}, headers=H).status_code == 400
    task = client.post("/api/tasks", json={"title": "Buy flour", "state": "next"}, headers=H).get_json()["id"]
    n = note(client, title="Bread", body="<p>Mix <b>well</b><script>x</script></p>", font="serif",
             category_id=cat["id"], area_id=home, tags=["baking"], related=[task], pinned=True)
    assert (n["title"], n["body"], n["font"], n["pinned"], n["tags"]) == \
        ("Bread", "<p>Mix <b>well</b></p>", "serif", True, ["baking"])
    assert [t["title"] for t in n["related"]] == ["Buy flour"] and n["created_at"] and n["journal_id"] is None
    # Pinning doesn't count as an edit; changing the words does.
    stamp = "2000-01-01 00:00:00"
    conn = sqlite3.connect(app.config["DATABASE"])
    conn.execute("UPDATE notes SET updated_at = ?", (stamp,))
    conn.commit()
    conn.close()
    assert client.patch(f"/api/notes/{n['id']}", json={"pinned": False}, headers=H).get_json()["updated_at"] == stamp
    assert client.patch(f"/api/notes/{n['id']}", json={"title": "Rye"}, headers=H).get_json()["updated_at"] > stamp
    assert client.patch(f"/api/notes/{n['id']}", json={"font": "comic"}, headers=H).status_code == 400
    # It's in /api/data, with the categories; other people can't see or change it.
    d = data(client)
    assert [x["title"] for x in d["notes"]] == ["Rye"] and d["note_categories"][0]["name"] == "Recipes"
    bob = user_client("bob")
    assert data(bob)["notes"] == []
    assert bob.patch(f"/api/notes/{n['id']}", json={"title": "x"}, headers=H).status_code == 404
    # Deleting the category leaves the note without one.
    client.delete(f"/api/note-categories/{cat['id']}", headers=H)
    assert data(client)["notes"][0]["category_id"] is None
    # Renaming a tag onto another merges them on notes too.
    client.post("/api/tasks", json={"title": "x", "tags": ["bake"]}, headers=H)
    tags = {t["name"]: t["id"] for t in data(client)["tags"]}
    client.patch(f"/api/tags/{tags['baking']}", json={"name": "bake"}, headers=H)
    assert data(client)["notes"][0]["tags"] == ["bake"]
    # The trash.
    client.patch(f"/api/notes/{n['id']}", json={"deleted": True}, headers=H)
    assert data(client)["notes"] == []
    assert [x["title"] for x in client.get("/api/trash").get_json()["notes"]] == ["Rye"]
    client.post("/api/trash/empty", headers=H)
    assert rows(app, "SELECT COUNT(*) AS n FROM notes") == [{"n": 0}]


def test_note_files_and_pictures(app, user_client):
    client = user_client("ann")
    n = note(client, title="Trip")
    r = client.post(f"/api/notes/{n['id']}/attachments", headers=H, content_type="multipart/form-data",
                    data={"file": [(io.BytesIO(b"\x89PNG..."), "view.png"), (io.BytesIO(b"pdf"), "tickets.pdf")]})
    assert r.status_code == 201
    got = r.get_json()
    assert [f["name"] for f in got["attachments"]] == ["view.png", "tickets.pdf"] and len(got["added"]) == 2
    pic = got["added"][0]
    body = f'<p>Before</p><p><img data-file="{pic}" data-size="m"></p>'
    assert client.patch(f"/api/notes/{n['id']}", json={"body": body}, headers=H).get_json()["body"] == body
    assert client.get(f"/api/attachments/{pic}").get_data() == b"\x89PNG..."
    assert client.get("/api/storage").get_json()["largest"][0]["note_id"] == n["id"]
    assert client.delete(f"/api/attachments/{pic}", headers=H).get_json()["id"] == n["id"]
    # Files go with the note.
    client.delete(f"/api/notes/{n['id']}", headers=H)
    assert rows(app, "SELECT COUNT(*) AS n FROM blobs") == [{"n": 0}]


def test_journals(app, user_client):
    client = user_client("ann")
    diary = client.post("/api/journals", json={"name": "Diary"}, headers=H).get_json()
    trips = client.post("/api/journals", json={"name": "Travel"}, headers=H).get_json()
    assert [j["name"] for j in data(client)["journals"]] == ["Diary", "Travel"]
    # An entry is on a day: today (the device's) unless given.
    e = client.post("/api/notes?today=2026-11-07", json={"journal_id": diary["id"], "body": "<p>Rain</p>"},
                    headers=H).get_json()
    assert (e["journal_id"], e["entry_date"]) == (diary["id"], "2026-11-07")
    e2 = note(client, journal_id=trips["id"], entry_date="2026-08-01", title="Rome")
    assert e2["entry_date"] == "2026-08-01"
    # Out of its journal, it's a note, with no day.
    assert client.patch(f"/api/notes/{e2['id']}", json={"journal_id": None}, headers=H).get_json()["entry_date"] is None
    assert client.patch("/api/journals/%d" % diary["id"], json={"name": "Days"}, headers=H).get_json()["name"] == "Days"
    # Deleting a journal puts its entries in the trash.
    client.delete(f"/api/journals/{diary['id']}", headers=H)
    assert [n["title"] for n in data(client)["notes"]] == ["Rome"]
    assert client.get("/api/trash").get_json()["notes"][0]["body"] == "<p>Rain</p>"


def share(client, **form):
    return client.post("/share", data=form, content_type="multipart/form-data")


def test_sharing_to_notes_and_journals(app, user_client):
    client = user_client("ann")
    assert client.patch("/api/me/settings", json={"share_to": "journal:999"}, headers=H).status_code == 404
    assert client.patch("/api/me/settings", json={"share_to": "nowhere"}, headers=H).status_code == 400
    client.patch("/api/me/settings", json={"share_to": "note"}, headers=H)
    r = share(client, text="Look at this", files=(io.BytesIO(b"jpeg"), "photo.jpg"))
    assert r.status_code == 302 and "shared_note=" in r.headers["Location"]
    n = data(client)["notes"][0]
    pic = n["attachments"][0]["id"]
    assert n["body"] == f'<p>Look at this</p><p><img data-file="{pic}" data-size="l"></p>'
    # To a journal: a new entry each time, at the moment it was shared.
    j = client.post("/api/journals", json={"name": "Diary"}, headers=H).get_json()["id"]
    client.patch("/api/me/settings", json={"share_to": f"journal:{j}"}, headers=H)
    share(client, files=(io.BytesIO(b"one"), "a.jpg"))
    share(client, files=(io.BytesIO(b"two"), "b.png"), title="Lunch")
    entries = sorted((x for x in data(client)["notes"] if x["journal_id"] == j), key=lambda x: x["id"])
    assert [(len(e["attachments"]), e["title"]) for e in entries] == [(1, ""), (1, "Lunch")]
    assert all(e["entry_date"] and re.fullmatch(r"\d\d:\d\d", e["entry_time"]) for e in entries)
    # Inbox is still the default for everyone else.
    other = user_client("bob")
    assert "shared=" in share(other, text="Call Jo").headers["Location"]


def test_task_to_note(app, user_client):
    client = user_client("ann")
    house = client.post("/api/projects", json={"name": "House"}, headers=H).get_json()["id"]
    t = client.post("/api/tasks", json={"title": "Paint colours", "notes": "<p>Hall: sage</p><ul data-check><li>test pot</li></ul>",
                                        "tags": ["paint"], "project_id": house}, headers=H).get_json()["id"]
    client.post(f"/api/tasks/{t}/attachments", data={"file": (io.BytesIO(b"img"), "swatch.png")},
                headers=H, content_type="multipart/form-data")
    r = client.post(f"/api/tasks/{t}/to-note", headers=H)
    assert r.status_code == 201
    n = r.get_json()
    pic = n["attachments"][0]["id"]
    assert n["title"] == "Paint colours" and n["tags"] == ["paint"]
    assert n["body"] == f'<p>Hall: sage</p><ul data-check><li>test pot</li></ul><p><img data-file="{pic}" data-size="l"></p>'
    assert [(p["title"], p["kind"]) for p in n["related"]] == [("House", "project")]
    assert not any(x["id"] == t for x in data(client)["tasks"])
    # A task that becomes a project keeps its notes, linked to the project.
    t2 = client.post("/api/tasks", json={"title": "Garden"}, headers=H).get_json()["id"]
    client.patch(f"/api/notes/{n['id']}", json={"related": [t2] + [x["id"] for x in n["related"]]}, headers=H)
    p = client.post(f"/api/tasks/{t2}/convert", json={}, headers=H).get_json()
    linked = data(client)["notes"][0]
    assert [x["title"] for x in linked["related"]] == ["Garden", "House"]
    assert p["name"] == "Garden"


def test_export_has_notes(app, user_client):
    client = user_client("ann")
    note(client, title="Keep me", body="<p>a <b>b</b></p>")
    z = zipfile.ZipFile(io.BytesIO(client.get("/api/export").get_data()))
    out = json.loads(z.read("data.json"))
    assert out["notes"][0]["text"] == "a b" and out["notes"][0]["title"] == "Keep me"


def test_attachments_table_gets_notes(tmp_path):
    """A database from before notes had files keeps its attachments (now on the project's document)."""
    path = str(tmp_path / "old.db")
    legacy_db(path, """
        DROP TABLE attachments;
        CREATE TABLE attachments (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, task_id INTEGER,
            project_id INTEGER, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL,
            blob_id INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')),
            CHECK ((task_id IS NULL) != (project_id IS NULL)));
        INSERT INTO users (id, username, password_hash) VALUES (1, 'ann', 'x');
        INSERT INTO projects (id, user_id, name) VALUES (2, 1, 'p');
        INSERT INTO blobs VALUES (1, 'abc', 3, x'616263');
        INSERT INTO attachments (id, user_id, project_id, name, mime, size, blob_id) VALUES (7, 1, 2, 'a.txt', 'text/plain', 3, 1);
    """)
    db.init_db(path)
    conn = sqlite3.connect(path)
    assert conn.execute("SELECT a.id, d.kind, d.title FROM attachments a JOIN documents d ON d.id = a.document_id"
                        ).fetchall() == [(7, "project", "p")]


def test_sharing_asks_each_time(app, user_client):
    client = user_client("ann")
    client.patch("/api/me/settings", json={"share_to": "ask"}, headers=H)
    # Kept as an Inbox task until answered, and the app is told to ask.
    r = share(client, files=(io.BytesIO(b"jpeg"), "IMG_1.jpg"))
    loc = r.headers["Location"]
    assert "shared=" in loc and "ask=1" in loc
    task = data(client)["tasks"][0]
    assert task["state"] == "inbox" and task["title"] == "IMG_1.jpg"
    # Into a journal, as an entry at that moment: the picture goes in the text, without the
    # file name as a title.
    j = client.post("/api/journals", json={"name": "Diary"}, headers=H).get_json()["id"]
    n = client.post(f"/api/tasks/{task['id']}/to-note?now=2026-11-07T10:30", json={"journal_id": j}, headers=H).get_json()
    pic = n["attachments"][0]["id"]
    assert (n["id"], n["journal_id"], n["entry_date"], n["entry_time"], n["title"]) == (task["id"], j, "2026-11-07", "10:30", "")
    assert n["body"] == f'<p><img data-file="{pic}" data-size="l"></p>'
    assert data(client)["tasks"] == []
    # Another the same day is an entry of its own.
    share(client, title="Lunch spot", text="Great tacos")
    t2 = data(client)["tasks"][0]["id"]
    n2 = client.post(f"/api/tasks/{t2}/to-note?now=2026-11-07T13:05", json={"journal_id": j}, headers=H).get_json()
    assert n2["id"] != n["id"] and (n2["title"], n2["entry_time"]) == ("Lunch spot", "13:05")
    assert n2["body"] == "<p>Great tacos</p>"
    # Someone else's journal can't be used.
    other = user_client("bob")
    t3 = other.post("/api/tasks", json={"title": "x"}, headers=H).get_json()["id"]
    assert other.post(f"/api/tasks/{t3}/to-note", json={"journal_id": j}, headers=H).status_code == 404


def test_entries_are_at_a_point_in_time(app, user_client):
    client = user_client("ann")
    j = client.post("/api/journals", json={"name": "Diary"}, headers=H).get_json()["id"]
    new = lambda **n: client.post("/api/notes?now=2026-11-07T09:15", json=n, headers=H).get_json()  # noqa: E731
    a, b = new(journal_id=j, body="<p>Coffee</p>"), new(journal_id=j, body="<p>Rain</p>", entry_time="16:40")
    assert (a["entry_date"], a["entry_time"]) == ("2026-11-07", "09:15")  # (now, unless given)
    assert (b["entry_date"], b["entry_time"]) == ("2026-11-07", "16:40")  # (two on one day)
    assert client.patch(f"/api/notes/{a['id']}", json={"entry_time": "9am"}, headers=H).status_code == 400
    out = client.patch(f"/api/notes/{a['id']}", json={"journal_id": None}, headers=H).get_json()
    assert (out["entry_date"], out["entry_time"]) == (None, None)


def test_older_entries_get_their_times(tmp_path):
    path = str(tmp_path / "db.db")
    db.init_db(path)
    conn = db.connect(path)
    uid = conn.execute("INSERT INTO users (username, password_hash, settings) VALUES ('ann', 'x', ?)",
                       ('{"timezone": "America/Denver"}',)).lastrowid
    j = conn.execute("INSERT INTO journals (user_id, name) VALUES (?, 'Diary')", (uid,)).lastrowid
    on_day = db.insert(conn, "notes", {"user_id": uid, "journal_id": j, "entry_date": "2026-11-07",
                                       "created_at": "2026-11-07 22:30:00"})  # 15:30 in Denver
    later = db.insert(conn, "notes", {"user_id": uid, "journal_id": j, "entry_date": "2026-11-01",
                                      "created_at": "2026-11-07 22:30:00"})  # written days after
    conn.executescript("DROP VIEW tasks; DROP VIEW projects; DROP VIEW notes; ALTER TABLE note_data DROP COLUMN entry_time;")
    conn.commit()
    conn.close()
    db.init_db(path)
    conn = db.connect(path)
    times = dict(conn.execute("SELECT id, entry_time FROM notes").fetchall())
    assert times == {on_day: "15:30", later: None}
