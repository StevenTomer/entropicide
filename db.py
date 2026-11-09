import hashlib
import os
import re
import sqlite3

from flask import g, current_app

# Each attachment is on one document: a task, a project (whose files go with all of its tasks)
# or a note (where a picture may also be placed in the text: <img data-file="id">).
ATTACHMENTS = """CREATE TABLE IF NOT EXISTS attachments (
    id          INTEGER PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    mime        TEXT NOT NULL,
    size        INTEGER NOT NULL,
    blob_id     INTEGER NOT NULL REFERENCES blobs(id),
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);"""

# Attachments before documents (for upgrading older databases, in migrate()).
LEGACY_ATTACHMENTS = """CREATE TABLE IF NOT EXISTS attachments (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    task_id    INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
    project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    note_id    INTEGER REFERENCES notes(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    mime       TEXT NOT NULL,
    size       INTEGER NOT NULL,
    blob_id    INTEGER NOT NULL REFERENCES blobs(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK ((task_id IS NOT NULL) + (project_id IS NOT NULL) + (note_id IS NOT NULL) = 1)
);"""

# Each kind of document: its view, its own table, the view's columns that are the document's
# (view column: documents column), and its own columns (name, DDL).
KINDS = {
    "task": {
        "view": "tasks", "table": "task_data",
        "document": {"title": "title", "notes": "body", "area_id": "area_id", "created_at": "created_at",
                     "updated_at": "updated_at", "deleted_at": "deleted_at"},
        "columns": [
            ("project_id", "INTEGER REFERENCES project_data(id) ON DELETE SET NULL"),
            # inbox | next | soon | waiting | scheduled | someday | later
            ("state", "TEXT NOT NULL DEFAULT 'inbox'"),
            ("focus", "INTEGER NOT NULL DEFAULT 0"),
            ("due_date", "TEXT"),
            ("start_date", "TEXT"),
            # optional HH:MM (user's local time) on start_date; set by short deferrals
            ("start_time", "TEXT"),
            ("waiting_for", "TEXT NOT NULL DEFAULT ''"),
            ("energy", "TEXT"),
            ("minutes", "INTEGER"),
            # higher comes first in Focus and the Queue; 0 by default, may be negative
            ("priority", "INTEGER NOT NULL DEFAULT 0"),
            # Repeating tasks: one row per occurrence, numbered within the series.
            ("series_id", "INTEGER REFERENCES series(id) ON DELETE SET NULL"),
            ("series_index", "INTEGER"),
            # Closed because a newer occurrence replaced it, rather than done.
            ("missed", "INTEGER NOT NULL DEFAULT 0"),
            # Google Calendar: the task's event, and what was last sent to it (JSON, see gcal.snapshot)
            ("gcal_event_id", "TEXT"),
            ("gcal_pushed", "TEXT"),
            ("position", "REAL NOT NULL DEFAULT 0"),
            ("completed_at", "TEXT"),
            # Reminders (UTC): when to remind (maybe a snooze of remind_plan, the reminder as set,
            # which a repeating task's later copies take), when last reminded, and the start
            # ("date time") last announced; remind_before: set as days before the due date.
            ("remind_at", "TEXT"),
            ("remind_plan", "TEXT"),
            ("reminded_at", "TEXT"),
            ("start_notified", "TEXT"),
            ("remind_before", "INTEGER"),
            # The contacts it's about: a JSON list of contacts.id.
            ("people", "TEXT NOT NULL DEFAULT '[]'"),
            # Seconds spent on it with the focus timer.
            ("spent", "INTEGER NOT NULL DEFAULT 0"),
        ],
    },
    "project": {
        "view": "projects", "table": "project_data",
        "document": {"name": "title", "notes": "body", "area_id": "area_id", "created_at": "created_at",
                     "updated_at": "updated_at", "deleted_at": "deleted_at"},
        "columns": [
            # the project it's a part of (a subproject), if any
            ("parent_id", "INTEGER REFERENCES project_data(id) ON DELETE SET NULL"),
            # a subproject's place among its parent's steps: in the same order as the parent's
            # tasks' positions, so the two can be ordered together (and, in a sequential parent,
            # taken one at a time)
            ("step", "REAL"),
            ("sequential", "INTEGER NOT NULL DEFAULT 0"),
            # active | someday | later | done
            ("state", "TEXT NOT NULL DEFAULT 'active'"),
            ("focus", "INTEGER NOT NULL DEFAULT 0"),
            ("due_date", "TEXT"),
            # higher comes first on the Projects page, as for tasks; 0 by default, may be negative
            ("priority", "INTEGER NOT NULL DEFAULT 0"),
            ("position", "REAL NOT NULL DEFAULT 0"),
            ("completed_at", "TEXT"),
            # The template it was made from (or saved as), to update it from the project.
            ("template_id", "INTEGER REFERENCES templates(id) ON DELETE SET NULL"),
        ],
    },
    "note": {
        "view": "notes", "table": "note_data",
        "document": {"title": "title", "body": "body", "font": "font", "area_id": "area_id",
                     "created_at": "created_at", "updated_at": "updated_at", "deleted_at": "deleted_at"},
        "columns": [
            ("category_id", "INTEGER REFERENCES note_categories(id) ON DELETE SET NULL"),
            ("journal_id", "INTEGER REFERENCES journals(id) ON DELETE SET NULL"),
            # A journal entry is a note at a point in time: the day, and (HH:MM, the user's
            # local time) the time, if it has one. Any number of entries can be on a day.
            ("entry_date", "TEXT"),
            ("entry_time", "TEXT"),
            ("pinned", "INTEGER NOT NULL DEFAULT 0"),
        ],
    },
}
VIEW_KINDS = {k["view"]: kind for kind, k in KINDS.items()}

# What a new document takes for a documents column its insert leaves out (fmt: the value given).
DOCUMENT_DEFAULTS = {"title": "coalesce({}, '')", "body": "coalesce({}, '')", "font": "coalesce({}, '')",
                     "area_id": "{}", "deleted_at": "{}", "created_at": "coalesce({}, created_at)",
                     "updated_at": "coalesce({}, NEW.created_at, updated_at)"}


def _kind_tables():
    return "\n".join(
        f"CREATE TABLE IF NOT EXISTS {k['table']} (\n    id INTEGER PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,\n"
        + ",\n".join(f"    {name} {ddl}" for name, ddl in k["columns"]) + "\n);\n" for k in KINDS.values())


def _given_or_default(column, ddl):
    """A trigger's value for a column: what the insert gave, else the column's default."""
    m = re.search(r"DEFAULT (\S+)", ddl)
    return f"coalesce(NEW.{column}, {m[1]})" if m else f"NEW.{column}"


def _views():
    """Each kind's view, joining documents and its own table, with triggers so it takes inserts
    (through insert()), updates and deletes like a table. Remade at each start."""
    out = []
    for kind, k in KINDS.items():
        view, table, doc, own = k["view"], k["table"], k["document"], [c for c, _ in k["columns"]]
        out.append(f"DROP VIEW IF EXISTS {view};")
        out.append(f"CREATE VIEW {view} AS SELECT d.id, d.user_id, "
                   + ", ".join(f"d.{d_col} AS {v}" for v, d_col in doc.items()) + ", "
                   + ", ".join(f"x.{c}" for c in own) + f" FROM documents d JOIN {table} x ON x.id = d.id;")
        out.append(
            f"CREATE TRIGGER {view}_insert INSTEAD OF INSERT ON {view} BEGIN\n"
            f"    SELECT RAISE(ABORT, 'make a {kind} with db.insert') WHERE NEW.id IS NULL\n"
            f"        OR NOT EXISTS (SELECT 1 FROM documents WHERE id = NEW.id);\n"
            f"    UPDATE documents SET kind = '{kind}', "
            + ", ".join(f"{d_col} = " + DOCUMENT_DEFAULTS[d_col].format(f"NEW.{v}") for v, d_col in doc.items())
            + " WHERE id = NEW.id;\n"
            f"    INSERT INTO {table} (id, {', '.join(own)}) VALUES (NEW.id, "
            + ", ".join(_given_or_default(c, ddl) for c, ddl in k["columns"]) + ");\nEND;")
        out.append(
            f"CREATE TRIGGER {view}_update INSTEAD OF UPDATE ON {view} BEGIN\n"
            f"    UPDATE documents SET " + ", ".join(f"{d_col} = NEW.{v}" for v, d_col in doc.items())
            + " WHERE id = OLD.id;\n"
            f"    UPDATE {table} SET " + ", ".join(f"{c} = NEW.{c}" for c in own) + " WHERE id = OLD.id;\nEND;")
        # Deleting one deletes the document (and with it its tags, files, links and waits). A
        # task's calendar event is noted, for sync to remove from Google.
        gone = ("    INSERT INTO gcal_deletions (user_id, event_id) SELECT OLD.user_id, OLD.gcal_event_id "
                "WHERE OLD.gcal_event_id IS NOT NULL;\n") if kind == "task" else ""
        out.append(f"CREATE TRIGGER {view}_delete INSTEAD OF DELETE ON {view} BEGIN\n{gone}"
                   f"    DELETE FROM documents WHERE id = OLD.id;\nEND;")
    return "\n".join(out)


def insert(conn, view, fields):
    """Make a task, project or note (view: tasks, projects or notes; fields: its columns, with
    user_id) and return its id. Its document row is made first, for the id (an insert into a
    view doesn't give one back), and the view's trigger fills it in."""
    doc_id = conn.execute("INSERT INTO documents (user_id, kind) VALUES (?, ?)",
                          (fields["user_id"], VIEW_KINDS[view])).lastrowid
    fields = {**fields, "id": doc_id}
    conn.execute(f"INSERT INTO {view} ({', '.join(fields)}) VALUES ({', '.join('?' * len(fields))})",
                 tuple(fields.values()))
    return doc_id


SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name  TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    is_admin      INTEGER NOT NULL DEFAULT 0,
    disabled      INTEGER NOT NULL DEFAULT 0,
    -- per-user preferences, JSON
    settings      TEXT NOT NULL DEFAULT '{}',
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    last_login    TEXT
);

CREATE TABLE IF NOT EXISTS areas (
    id       INTEGER PRIMARY KEY,
    user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name     TEXT NOT NULL,
    position REAL NOT NULL DEFAULT 0,
    -- cleaned SVG shown before tasks in this area; version changes with it (for caching)
    icon_svg     TEXT,
    icon_version TEXT
);

-- Saved web links, in folders. A folder is a row without a url.
CREATE TABLE IF NOT EXISTS links (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- the folder it's in; NULL at the top level. Deleting a folder deletes what's in it.
    parent_id  INTEGER REFERENCES links(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    url        TEXT,
    -- starred links show in the toolbar, as just their icon if they have one
    starred    INTEGER NOT NULL DEFAULT 0,
    -- cleaned SVG; version changes with it (for caching), as for areas
    icon_svg     TEXT,
    icon_version TEXT,
    position   REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Tasks, projects and notes are all documents: what they have in common (a title, text,
-- an area, tags, files, links, the trash) is here, and what each kind has of its own is in
-- task_data, project_data or note_data, under the same id. Converting one kind to another
-- swaps that second row, so the id (and its tags, files and links) stays. The code mostly
-- uses the views tasks, projects and notes (VIEWS, below), which join the two and take
-- updates and deletes like tables; a new one is made with insert().
CREATE TABLE IF NOT EXISTS documents (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL CHECK (kind IN ('task', 'project', 'note')),
    title      TEXT NOT NULL DEFAULT '',
    -- a task's or project's notes (as typed), or a note's formatted text (HTML, richtext.py)
    body       TEXT NOT NULL DEFAULT '',
    -- the typeface (richtext.FONTS, '' for the app's own)
    font       TEXT NOT NULL DEFAULT '',
    area_id    INTEGER REFERENCES areas(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at TEXT
);

{KIND_TABLES}

-- A repeating task's schedule. Occurrence n falls (n - base_index) repeats
-- after the base dates, counted in calendar units so dates never drift.
CREATE TABLE IF NOT EXISTS series (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- daily | weekdays | weekly | monthly | yearly | every:N (days) | every:Nw | every:Nm | every:Ny
    repeat     TEXT NOT NULL,
    -- keep | replace: what happens to an unfinished occurrence when the next begins
    on_miss    TEXT NOT NULL,
    base_start TEXT,
    base_due   TEXT,
    base_index INTEGER NOT NULL DEFAULT 0,
    -- index of the newest occurrence generated so far
    latest     INTEGER NOT NULL DEFAULT 0
);

-- A user's connection to Google Calendar.
CREATE TABLE IF NOT EXISTS google_accounts (
    user_id        INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    email          TEXT NOT NULL DEFAULT '',
    refresh_token  TEXT NOT NULL,
    access_token   TEXT,
    access_expires REAL NOT NULL DEFAULT 0,
    -- the calendar tasks go on, and where its change feed was last read up to.
    -- owns_calendar: 1 = a "Todo" calendar the app made, 0 = one of the user's own
    -- (e.g. a shared family calendar), NULL = not chosen yet.
    calendar_id    TEXT,
    calendar_name  TEXT,
    owns_calendar  INTEGER,
    sync_token     TEXT,
    -- upcoming events from the user's other calendars, JSON, refreshed every few minutes
    events_json    TEXT NOT NULL DEFAULT '[]',
    events_fetched REAL NOT NULL DEFAULT 0,
    last_sync      TEXT,
    last_error     TEXT,
    connected_at   TEXT NOT NULL DEFAULT (datetime('now')),
    -- what Google allowed (space-separated scopes, from its latest token); contacts are read
    -- only if Contacts is among them, every hour or so
    scopes           TEXT,
    contacts_fetched REAL NOT NULL DEFAULT 0,
    contacts_error   TEXT
);

-- A read-only copy of the user's Google Contacts, replaced on each refresh and deleted on
-- Disconnect. Tasks name them in tasks.people.
CREATE TABLE IF NOT EXISTS contacts (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    id      TEXT NOT NULL,  -- Google's resource name, people/c…
    name    TEXT NOT NULL,
    info    TEXT NOT NULL,  -- JSON: nicknames, phones, emails, addresses
    PRIMARY KEY (user_id, id)
);

-- Events whose tasks were deleted outright; sync removes them from Google.
CREATE TABLE IF NOT EXISTS gcal_deletions (
    user_id  INTEGER NOT NULL,
    event_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tags (
    id      INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name    TEXT NOT NULL,
    UNIQUE (user_id, name)
);

CREATE TABLE IF NOT EXISTS document_tags (
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    tag_id      INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (document_id, tag_id)
);

-- Files attached to documents. Kept in the database (not as loose files) so they go when
-- their document or user does, and a backup of the database includes them. A file's bytes are
-- stored once (blobs) however many tasks have it, e.g. every copy of a repeating task;
-- the attachments_blob_gone trigger drops them when the last attachment goes.
CREATE TABLE IF NOT EXISTS blobs (
    id     INTEGER PRIMARY KEY,
    sha256 TEXT NOT NULL UNIQUE,
    size   INTEGER NOT NULL,
    data   BLOB NOT NULL
);
{ATTACHMENTS}

-- "Blocked by": a task or project (document_id) can't start until blocker_id, a task or
-- project, is done (or trashed). A waiting project holds back all its tasks.
CREATE TABLE IF NOT EXISTS document_deps (
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    blocker_id  INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    PRIMARY KEY (document_id, blocker_id),
    CHECK (document_id != blocker_id)
);

-- "Related to" (and a note's "Linked to"): two documents linked both ways (stored once, with
-- a < b), for getting from one to the other; it changes nothing about either.
CREATE TABLE IF NOT EXISTS document_links (
    a INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    b INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    PRIMARY KEY (a, b),
    CHECK (a < b)
);

-- Notes are grouped in categories; a note in a journal is one of its entries, at its entry_date (and entry_time).
CREATE TABLE IF NOT EXISTS note_categories (
    id       INTEGER PRIMARY KEY,
    user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name     TEXT NOT NULL,
    -- a colour name from the browser's palette (notes.js NOTE_COLORS), '' for none
    color    TEXT NOT NULL DEFAULT '',
    position REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS journals (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    position   REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Project templates: a project and its tasks as JSON (see app.py's template_data), with
-- dates as days from the project's date. With a repeat, a new project is made from it on
-- schedule: for next_date, lead_days before it.
CREATE TABLE IF NOT EXISTS templates (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    data       TEXT NOT NULL,
    repeat     TEXT,
    next_date  TEXT,
    lead_days  INTEGER NOT NULL DEFAULT 7,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Browsers (one per device) that get this user's push notifications (reminders).
CREATE TABLE IF NOT EXISTS push_subscriptions (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint   TEXT NOT NULL UNIQUE,
    p256dh     TEXT NOT NULL,
    auth       TEXT NOT NULL,
    device     TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Phones whose Android app adds tasks on its own (the Add task notification and tile),
-- each with its own key; only the key's hash is kept.
CREATE TABLE IF NOT EXISTS devices (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key_hash   TEXT NOT NULL UNIQUE,
    name       TEXT NOT NULL DEFAULT '',
    -- phone: the Android app; api: a key made in Settings for anything else (POST /api/add)
    kind       TEXT NOT NULL DEFAULT 'phone',
    -- an api key that may also read the user's lists (GET /api/read/…), and complete tasks
    -- (POST /api/complete)
    can_read     INTEGER NOT NULL DEFAULT 0,
    can_complete INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    used_at    TEXT
);

-- Recent share attempts and Android app launches, for troubleshooting (SITE_PATH/debug).
-- Only the newest few hundred are kept.
CREATE TABLE IF NOT EXISTS app_log (
    id      INTEGER PRIMARY KEY,
    at      TEXT NOT NULL DEFAULT (datetime('now')),
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    kind    TEXT NOT NULL,
    detail  TEXT NOT NULL DEFAULT '{}'
);
"""

SCHEMA = SCHEMA.replace("{ATTACHMENTS}", ATTACHMENTS).replace("{KIND_TABLES}", _kind_tables())
VIEWS = _views()

INDEXES = """
CREATE INDEX IF NOT EXISTS links_user ON links(user_id, parent_id);
CREATE INDEX IF NOT EXISTS documents_user ON documents(user_id, kind, deleted_at);
CREATE INDEX IF NOT EXISTS document_tags_tag ON document_tags(tag_id);
CREATE INDEX IF NOT EXISTS document_deps_blocker ON document_deps(blocker_id);
CREATE INDEX IF NOT EXISTS document_links_b ON document_links(b);
CREATE INDEX IF NOT EXISTS attachments_document ON attachments(document_id);
CREATE INDEX IF NOT EXISTS attachments_blob ON attachments(blob_id);
CREATE TRIGGER IF NOT EXISTS attachments_blob_gone AFTER DELETE ON attachments
BEGIN
    DELETE FROM blobs WHERE id = old.blob_id
        AND NOT EXISTS (SELECT 1 FROM attachments WHERE blob_id = old.blob_id);
END;
CREATE INDEX IF NOT EXISTS task_data_project ON task_data(project_id);
CREATE INDEX IF NOT EXISTS task_data_completed ON task_data(completed_at);
CREATE UNIQUE INDEX IF NOT EXISTS task_data_series ON task_data(series_id, series_index)
    WHERE series_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS task_data_gcal ON task_data(gcal_event_id) WHERE gcal_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS project_data_parent ON project_data(parent_id);
CREATE INDEX IF NOT EXISTS note_data_journal ON note_data(journal_id);
"""

DEFAULT_ON_MISS = {"daily": "replace", "weekdays": "replace", "weekly": "replace",
                   "monthly": "keep", "yearly": "keep"}


def default_on_miss(repeat):
    """Frequent repeats replace a missed copy; monthly and yearly ones (every N months or
    years, and the nth weekday of the month, too) keep it."""
    if repeat and ((repeat.startswith("every:") and repeat[-1] in "my") or repeat.startswith("nth:")):
        return "keep"
    return DEFAULT_ON_MISS.get(repeat, "replace")


def put_blob(conn, data):
    """Store a file's bytes (once, however often they're attached); returns the blob id."""
    sha = hashlib.sha256(data).hexdigest()
    conn.execute("INSERT OR IGNORE INTO blobs (sha256, size, data) VALUES (?, ?, ?)",
                 (sha, len(data), data))
    return conn.execute("SELECT id FROM blobs WHERE sha256 = ?", (sha,)).fetchone()[0]


def _is_table(conn, name):
    return conn.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (name,)).fetchone() is not None


def migrate(conn):
    # Before documents, tasks, projects and notes were tables of their own: bring those up to
    # date first, then turn them into documents (to_documents).
    legacy = _is_table(conn, "tasks")
    if legacy:
        _upgrade_legacy(conn)
    series_cols = {r["name"] for r in conn.execute("PRAGMA table_info(series)")}
    if "carry_files" not in series_cols:
        # Whether new copies of a repeating task get the newest copy's attachments.
        conn.execute("ALTER TABLE series ADD COLUMN carry_files INTEGER NOT NULL DEFAULT 0")
    if "from_done" not in series_cols:
        # 1: each copy is made when the last one is completed, counted from that day
        # (rather than on the calendar's schedule).
        conn.execute("ALTER TABLE series ADD COLUMN from_done INTEGER NOT NULL DEFAULT 0")
    area_cols = {r["name"] for r in conn.execute("PRAGMA table_info(areas)")}
    for name in ("icon_svg", "icon_version"):
        if name not in area_cols:
            conn.execute(f"ALTER TABLE areas ADD COLUMN {name} TEXT")
    google_cols = {r["name"] for r in conn.execute("PRAGMA table_info(google_accounts)")}
    for name in ("calendar_name TEXT", "owns_calendar INTEGER", "scopes TEXT",
                 "contacts_fetched REAL NOT NULL DEFAULT 0", "contacts_error TEXT"):
        if name.split()[0] not in google_cols:
            conn.execute(f"ALTER TABLE google_accounts ADD COLUMN {name}")
    # Connections from before the calendar could be chosen used the app's own.
    conn.execute("UPDATE google_accounts SET owns_calendar = 1, calendar_name = 'Todo' "
                 "WHERE calendar_id IS NOT NULL AND owns_calendar IS NULL")
    device_cols = {r["name"] for r in conn.execute("PRAGMA table_info(devices)")}
    for name, ddl in (("kind", "TEXT NOT NULL DEFAULT 'phone'"), ("can_read", "INTEGER NOT NULL DEFAULT 0"),
                      ("can_complete", "INTEGER NOT NULL DEFAULT 0")):
        if name not in device_cols:
            conn.execute(f"ALTER TABLE devices ADD COLUMN {name} {ddl}")
    user_cols = {r["name"] for r in conn.execute("PRAGMA table_info(users)")}
    if "settings" not in user_cols:
        conn.execute("ALTER TABLE users ADD COLUMN settings TEXT NOT NULL DEFAULT '{}'")
    if "digest_sent" not in user_cols:
        # The day (user's local date) the morning summary was last sent.
        conn.execute("ALTER TABLE users ADD COLUMN digest_sent TEXT")
    if legacy:
        to_documents(conn)
        entry_times(conn)
    elif "entry_time" not in {r["name"] for r in conn.execute("PRAGMA table_info(note_data)")}:
        # Entries get a time: when they were written, in the user's time, if that was on their day.
        conn.execute("ALTER TABLE note_data ADD COLUMN entry_time TEXT")
        entry_times(conn)
    if not legacy and "step" not in {r["name"] for r in conn.execute("PRAGMA table_info(project_data)")}:
        # Subprojects take a place among their parent's tasks (after them, to begin with).
        conn.execute("ALTER TABLE project_data ADD COLUMN step REAL")
        conn.execute("UPDATE project_data SET step = (SELECT COALESCE(MAX(t.position), 0) + 1 FROM task_data t "
                     "WHERE t.project_id = project_data.parent_id) + id / 1e9 WHERE parent_id IS NOT NULL")


def entry_times(conn):
    """Journal entries from before entries had times: the time each was written, in its user's
    time zone (Settings), when that was on the entry's day."""
    import json
    from datetime import datetime
    from zoneinfo import ZoneInfo
    for r in conn.execute("SELECT d.id, d.created_at, n.entry_date, u.settings FROM note_data n JOIN documents d ON d.id = n.id "
                          "JOIN users u ON u.id = d.user_id WHERE n.journal_id IS NOT NULL AND n.entry_time IS NULL").fetchall():
        try:
            tz = ZoneInfo(json.loads(r["settings"] or "{}").get("timezone") or "UTC")
            local = datetime.fromisoformat(r["created_at"].replace(" ", "T") + "+00:00").astimezone(tz)
        except (ValueError, KeyError):
            continue
        if local.date().isoformat() == r["entry_date"]:
            conn.execute("UPDATE note_data SET entry_time = ? WHERE id = ?", (local.strftime("%H:%M"), r["id"]))


def _upgrade_legacy(conn):
    """Changes made to the tables tasks, projects and attachments while they were tables."""
    project_cols = {r["name"] for r in conn.execute("PRAGMA table_info(projects)")}
    if "template_id" not in project_cols:
        # The template a project was made from (or saved as), to update it from the project.
        conn.execute("ALTER TABLE projects ADD COLUMN template_id INTEGER "
                     "REFERENCES templates(id) ON DELETE SET NULL")
    if "priority" not in project_cols:
        conn.execute("ALTER TABLE projects ADD COLUMN priority INTEGER NOT NULL DEFAULT 0")
    if "data" in {r["name"] for r in conn.execute("PRAGMA table_info(attachments)")}:
        # Attachments first kept their bytes in the row itself.
        conn.execute("ALTER TABLE attachments RENAME TO attachments_old")
        conn.execute(LEGACY_ATTACHMENTS)
        for r in conn.execute("SELECT * FROM attachments_old").fetchall():
            conn.execute("INSERT INTO attachments (id, user_id, task_id, name, mime, size, blob_id, "
                         "created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                         (r["id"], r["user_id"], r["task_id"], r["name"], r["mime"], r["size"],
                          put_blob(conn, r["data"]), r["created_at"]))
        conn.execute("DROP TABLE attachments_old")
    elif not {"project_id", "note_id"} <= (cols := {r["name"] for r in conn.execute("PRAGMA table_info(attachments)")}):
        # Attachments were on tasks only, then on tasks and projects; notes have them too now.
        keep = ", ".join(c for c in ("id", "user_id", "task_id", "project_id", "name", "mime", "size",
                                     "blob_id", "created_at") if c in cols)
        conn.execute("ALTER TABLE attachments RENAME TO attachments_old")
        conn.execute(LEGACY_ATTACHMENTS)
        conn.execute(f"INSERT INTO attachments ({keep}) SELECT {keep} FROM attachments_old")
        conn.execute("DROP TABLE attachments_old")
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(tasks)")}
    for name, ddl in (("series_id", "INTEGER REFERENCES series(id) ON DELETE SET NULL"),
                      ("series_index", "INTEGER"),
                      ("missed", "INTEGER NOT NULL DEFAULT 0"),
                      ("start_time", "TEXT"),
                      ("gcal_event_id", "TEXT"),
                      ("gcal_pushed", "TEXT"),
                      ("priority", "INTEGER NOT NULL DEFAULT 0"),
                      # Reminders (UTC): when to remind, when last reminded, and the start
                      # ("date time") last announced.
                      ("remind_at", "TEXT"),
                      # The reminder as set (remind_at may be a snooze of it); it's what a
                      # repeating task's later copies take, at the same distance from their dates.
                      ("remind_plan", "TEXT"),
                      ("reminded_at", "TEXT"),
                      ("start_notified", "TEXT"),
                      # A reminder set as days before the due date (remind_at follows it); none
                      # for one set at a time.
                      ("remind_before", "INTEGER"),
                      # The contacts it's about: a JSON list of contacts.id.
                      ("people", "TEXT NOT NULL DEFAULT '[]'"),
                      # Seconds spent on it with the focus timer.
                      ("spent", "INTEGER NOT NULL DEFAULT 0")):
        if name not in cols:
            conn.execute(f"ALTER TABLE tasks ADD COLUMN {name} {ddl}")
    for name in ("expires_on", "expiry_notified"):  # (expiry dates, since removed)
        if name in cols:
            conn.execute(f"ALTER TABLE tasks DROP COLUMN {name}")
    if "repeat" in cols:
        # Before series existed, each open task carried its own repeat setting.
        for t in conn.execute("SELECT * FROM tasks WHERE repeat IS NOT NULL "
                              "AND completed_at IS NULL AND deleted_at IS NULL").fetchall():
            base_start = t["start_date"]
            if not base_start and not t["due_date"]:
                base_start = conn.execute("SELECT date('now', 'localtime')").fetchone()[0]
            cur = conn.execute(
                "INSERT INTO series (user_id, repeat, on_miss, base_start, base_due) "
                "VALUES (?, ?, ?, ?, ?)",
                (t["user_id"], t["repeat"], DEFAULT_ON_MISS[t["repeat"]], base_start,
                 t["due_date"]))
            conn.execute("UPDATE tasks SET series_id = ?, series_index = 0 WHERE id = ?",
                         (cur.lastrowid, t["id"]))
        conn.execute("UPDATE tasks SET repeat = NULL")


# The tables documents replaced.
LEGACY_TABLES = ("task_tags", "project_tags", "note_tags", "task_deps", "project_deps", "task_links",
                 "project_links", "note_links", "attachments", "notes", "tasks", "projects")


def to_documents(conn):
    """Move tasks, projects and notes (separate tables until now) into documents and their
    kinds' tables, with their tags, waits, links and files in the shared tables. Tasks keep
    their ids; projects, then notes, get new ones after them (the same order, moved up). All
    in one transaction, which is undone if anything doesn't line up."""
    has = lambda name: _is_table(conn, name)  # noqa: E731
    columns = lambda name: {r["name"] for r in conn.execute(f"PRAGMA table_info({name})")}  # noqa: E731
    conn.commit()
    conn.execute("PRAGMA foreign_keys = OFF")  # (the old tables go; nothing must cascade from them)
    conn.execute("BEGIN")
    try:
        p = conn.execute("SELECT COALESCE(MAX(id), 0) FROM tasks").fetchone()[0]
        n = p + (conn.execute("SELECT COALESCE(MAX(id), 0) FROM projects").fetchone()[0] if has("projects") else 0)
        own = lambda kind: [c for c, _ in KINDS[kind]["columns"]]  # noqa: E731

        conn.execute("INSERT INTO documents (id, user_id, kind, title, body, area_id, created_at, updated_at, deleted_at) "
                     "SELECT id, user_id, 'task', title, notes, area_id, created_at, updated_at, deleted_at FROM tasks")
        conn.execute(f"INSERT INTO task_data (id, {', '.join(own('task'))}) SELECT id, "
                     + ", ".join(f"project_id + {p}" if c == "project_id" else c for c in own("task")) + " FROM tasks")
        if has("projects"):  # (a project that's gone: no project, as its foreign key would have made it)
            conn.execute(f"UPDATE task_data SET project_id = NULL WHERE project_id - {p} NOT IN (SELECT id FROM projects)")
        if has("projects"):
            conn.execute(f"INSERT INTO documents (id, user_id, kind, title, body, area_id, created_at, updated_at, "
                         f"deleted_at) SELECT id + {p}, user_id, 'project', name, notes, area_id, created_at, created_at, "
                         "deleted_at FROM projects")
            had = columns("projects")  # (columns that came after: empty)
            conn.execute(f"INSERT INTO project_data (id, {', '.join(own('project'))}) SELECT id + {p}, "
                         + ", ".join(c if c in had else "NULL" for c in own("project")) + " FROM projects")
        if has("notes"):
            conn.execute(f"INSERT INTO documents (id, user_id, kind, title, body, font, area_id, created_at, updated_at, "
                         f"deleted_at) SELECT id + {n}, user_id, 'note', title, body, font, area_id, created_at, updated_at, "
                         "deleted_at FROM notes")
            had = columns("notes")
            conn.execute(f"INSERT INTO note_data (id, {', '.join(own('note'))}) SELECT id + {n}, "
                         + ", ".join(c if c in had else "NULL" for c in own("note")) + " FROM notes")

        # Tags, waits ("Blocked by") and links ("Related to", a note's "Linked to").
        for table, owner in (("task_tags", "task_id"), ("project_tags", f"project_id + {p}"),
                             ("note_tags", f"note_id + {n}")):
            if has(table):
                conn.execute(f"INSERT OR IGNORE INTO document_tags SELECT {owner}, tag_id FROM {table}")
        if has("task_deps"):
            conn.execute("INSERT OR IGNORE INTO document_deps SELECT task_id, blocker_id FROM task_deps")
        if has("project_deps"):
            conn.execute(f"INSERT OR IGNORE INTO document_deps SELECT COALESCE(task_id, project_id + {p}), "
                         f"COALESCE(blocker_task_id, blocker_project_id + {p}) FROM project_deps")
        link = "INSERT OR IGNORE INTO document_links SELECT MIN(x, y), MAX(x, y) FROM ({})"
        if has("task_links"):
            conn.execute(link.format("SELECT a AS x, b AS y FROM task_links"))
        if has("project_links"):
            conn.execute(link.format(f"SELECT project_id + {p} AS x, COALESCE(task_id, other_id + {p}) AS y "
                                     "FROM project_links"))
        if has("note_links"):
            conn.execute(link.format(f"SELECT note_id + {n} AS x, COALESCE(task_id, project_id + {p}) AS y "
                                     "FROM note_links"))

        # (Any that pointed at something long gone were never shown; they go.)
        for table, cols in (("document_tags", ("document_id",)), ("document_deps", ("document_id", "blocker_id")),
                            ("document_links", ("a", "b"))):
            conn.execute(f"DELETE FROM {table} WHERE " + " OR ".join(
                f"{c} NOT IN (SELECT id FROM documents)" for c in cols))

        # Files: each on its document.
        cols = columns("attachments")
        owner = "COALESCE(" + ", ".join(
            [c for c, ok in (("task_id", True), (f"project_id + {p}", "project_id" in cols),
                             (f"note_id + {n}", "note_id" in cols)) if ok]) + ")"
        conn.execute(ATTACHMENTS.replace("attachments (", "attachments_new (", 1))
        conn.execute(f"INSERT INTO attachments_new (id, user_id, document_id, name, mime, size, blob_id, created_at) "
                     f"SELECT id, user_id, {owner}, name, mime, size, blob_id, created_at FROM attachments")

        for table in LEGACY_TABLES:
            if has(table):
                conn.execute(f"DROP TABLE {table}")
        conn.execute("ALTER TABLE attachments_new RENAME TO attachments")
        problems = conn.execute("PRAGMA foreign_key_check").fetchall()
        if problems:
            raise RuntimeError(f"Moving to documents left {len(problems)} broken references, e.g. "
                               f"{tuple(problems[0])}; nothing was changed.")
        conn.commit()
    except BaseException:
        conn.rollback()
        raise
    finally:
        conn.execute("PRAGMA foreign_keys = ON")


# PRAGMA user_version 2: tasks' and projects' notes are formatted text (HTML) like a note's.
TEXT_VERSION = 2


def format_text(conn):
    """Once: tasks' and projects' notes (typed with a little Markdown until now) become
    formatted text, and the ☐/☑ lines notes were given for checklists become real ones."""
    if conn.execute("PRAGMA user_version").fetchone()[0] >= TEXT_VERSION:
        return
    import richtext
    for r in conn.execute("SELECT id, kind, body FROM documents").fetchall():
        if r["kind"] == "note":
            body = re.sub(r"<p>(?:\s*[-*]\s*)?([☐☑])\s?(.*?)</p>",
                          lambda m: "<ul data-check><li" + (' data-done="1"' if m[1] == "☑" else "") + f">{m[2] or '<br>'}</li></ul>",
                          r["body"]).replace("</ul><ul data-check>", "")
        else:
            body = richtext.from_markdown(r["body"]) if r["body"].strip() else ""
        if body != r["body"]:
            conn.execute("UPDATE documents SET body = ? WHERE id = ?", (body, r["id"]))
    conn.execute(f"PRAGMA user_version = {TEXT_VERSION}")
    conn.commit()


def untangle_trash(conn):
    """Once (PRAGMA user_version 3): until now a project went to the trash without what was in
    it, which stayed in the lists. Anything like that is taken out of the project, so it stays
    where it's been seen; from now on a project's contents go to the trash with it."""
    if conn.execute("PRAGMA user_version").fetchone()[0] >= 3:
        return
    gone = "(SELECT id FROM documents WHERE kind = 'project' AND deleted_at IS NOT NULL)"
    live = "(SELECT id FROM documents WHERE deleted_at IS NULL)"
    conn.execute(f"UPDATE task_data SET project_id = NULL WHERE project_id IN {gone} AND id IN {live}")
    conn.execute(f"UPDATE project_data SET parent_id = NULL, step = NULL WHERE parent_id IN {gone} AND id IN {live}")
    conn.execute("PRAGMA user_version = 3")
    conn.commit()


def connect(path):
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


def get_db():
    if "db" not in g:
        g.db = connect(current_app.config["DATABASE"])
    return g.db


def close_db(_exc=None):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db(path):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    conn = connect(path)
    conn.executescript(SCHEMA)
    migrate(conn)
    conn.executescript(VIEWS)
    conn.executescript(INDEXES)
    format_text(conn)
    untangle_trash(conn)
    conn.commit()
    conn.close()
