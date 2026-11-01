import hashlib
import os
import sqlite3

from flask import g, current_app

ATTACHMENTS = """CREATE TABLE IF NOT EXISTS attachments (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    mime       TEXT NOT NULL,
    size       INTEGER NOT NULL,
    blob_id    INTEGER NOT NULL REFERENCES blobs(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);"""

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

CREATE TABLE IF NOT EXISTS projects (
    id           INTEGER PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    area_id      INTEGER REFERENCES areas(id) ON DELETE SET NULL,
    name         TEXT NOT NULL,
    notes        TEXT NOT NULL DEFAULT '',
    sequential   INTEGER NOT NULL DEFAULT 0,
    -- active | someday | later | done
    state        TEXT NOT NULL DEFAULT 'active',
    focus        INTEGER NOT NULL DEFAULT 0,
    due_date     TEXT,
    position     REAL NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT,
    deleted_at   TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
    id           INTEGER PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id   INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    area_id      INTEGER REFERENCES areas(id) ON DELETE SET NULL,
    title        TEXT NOT NULL,
    notes        TEXT NOT NULL DEFAULT '',
    -- inbox | next | soon | waiting | scheduled | someday | later
    state        TEXT NOT NULL DEFAULT 'inbox',
    focus        INTEGER NOT NULL DEFAULT 0,
    due_date     TEXT,
    start_date   TEXT,
    -- optional HH:MM (user's local time) on start_date; set by short deferrals
    start_time   TEXT,
    waiting_for  TEXT NOT NULL DEFAULT '',
    energy       TEXT,
    minutes      INTEGER,
    -- higher comes first in Focus and the Queue; 0 by default, may be negative
    priority     INTEGER NOT NULL DEFAULT 0,
    -- Repeating tasks: one row per occurrence, numbered within the series.
    series_id    INTEGER REFERENCES series(id) ON DELETE SET NULL,
    series_index INTEGER,
    -- Closed because a newer occurrence replaced it, rather than done.
    missed       INTEGER NOT NULL DEFAULT 0,
    -- Google Calendar: the task's event, and what was last sent to it (JSON, see gcal.snapshot)
    gcal_event_id TEXT,
    gcal_pushed   TEXT,
    position     REAL NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT,
    deleted_at   TEXT
);

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
    connected_at   TEXT NOT NULL DEFAULT (datetime('now'))
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

CREATE TABLE IF NOT EXISTS task_tags (
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    tag_id  INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (task_id, tag_id)
);

-- Files attached to tasks. Kept in the database (not as loose files) so they go when
-- their task or user does, and a backup of the database includes them. A file's bytes are
-- stored once (blobs) however many tasks have it, e.g. every copy of a repeating task;
-- the attachments_blob_gone trigger drops them when the last attachment goes.
CREATE TABLE IF NOT EXISTS blobs (
    id     INTEGER PRIMARY KEY,
    sha256 TEXT NOT NULL UNIQUE,
    size   INTEGER NOT NULL,
    data   BLOB NOT NULL
);
{ATTACHMENTS}

-- "Blocked by": task_id can't start until blocker_id is done (or trashed).
CREATE TABLE IF NOT EXISTS task_deps (
    task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    blocker_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    PRIMARY KEY (task_id, blocker_id)
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

SCHEMA = SCHEMA.replace("{ATTACHMENTS}", ATTACHMENTS)

INDEXES = """
CREATE INDEX IF NOT EXISTS links_user ON links(user_id, parent_id);
CREATE INDEX IF NOT EXISTS attachments_task ON attachments(task_id);
CREATE INDEX IF NOT EXISTS task_deps_blocker ON task_deps(blocker_id);
CREATE INDEX IF NOT EXISTS attachments_blob ON attachments(blob_id);
CREATE TRIGGER IF NOT EXISTS attachments_blob_gone AFTER DELETE ON attachments
BEGIN
    DELETE FROM blobs WHERE id = old.blob_id
        AND NOT EXISTS (SELECT 1 FROM attachments WHERE blob_id = old.blob_id);
END;
CREATE INDEX IF NOT EXISTS tasks_user ON tasks(user_id, completed_at, deleted_at);
CREATE UNIQUE INDEX IF NOT EXISTS tasks_series ON tasks(series_id, series_index)
    WHERE series_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS tasks_gcal ON tasks(gcal_event_id) WHERE gcal_event_id IS NOT NULL;
CREATE TRIGGER IF NOT EXISTS tasks_gcal_deleted AFTER DELETE ON tasks
WHEN old.gcal_event_id IS NOT NULL
BEGIN
    INSERT INTO gcal_deletions (user_id, event_id) VALUES (old.user_id, old.gcal_event_id);
END;
"""

DEFAULT_ON_MISS = {"daily": "replace", "weekdays": "replace", "weekly": "replace",
                   "monthly": "keep", "yearly": "keep"}


def default_on_miss(repeat):
    """Frequent repeats replace a missed copy; monthly and yearly ones (and every N months
    or years) keep it."""
    if repeat and repeat.startswith("every:") and repeat[-1] in "my":
        return "keep"
    return DEFAULT_ON_MISS.get(repeat, "replace")


def put_blob(conn, data):
    """Store a file's bytes (once, however often they're attached); returns the blob id."""
    sha = hashlib.sha256(data).hexdigest()
    conn.execute("INSERT OR IGNORE INTO blobs (sha256, size, data) VALUES (?, ?, ?)",
                 (sha, len(data), data))
    return conn.execute("SELECT id FROM blobs WHERE sha256 = ?", (sha,)).fetchone()[0]


def migrate(conn):
    if "template_id" not in {r["name"] for r in conn.execute("PRAGMA table_info(projects)")}:
        # The template a project was made from (or saved as), to update it from the project.
        conn.execute("ALTER TABLE projects ADD COLUMN template_id INTEGER "
                     "REFERENCES templates(id) ON DELETE SET NULL")
    series_cols = {r["name"] for r in conn.execute("PRAGMA table_info(series)")}
    if "carry_files" not in series_cols:
        # Whether new copies of a repeating task get the newest copy's attachments.
        conn.execute("ALTER TABLE series ADD COLUMN carry_files INTEGER NOT NULL DEFAULT 0")
    if "from_done" not in series_cols:
        # 1: each copy is made when the last one is completed, counted from that day
        # (rather than on the calendar's schedule).
        conn.execute("ALTER TABLE series ADD COLUMN from_done INTEGER NOT NULL DEFAULT 0")
    if "data" in {r["name"] for r in conn.execute("PRAGMA table_info(attachments)")}:
        # Attachments first kept their bytes in the row itself.
        conn.execute("ALTER TABLE attachments RENAME TO attachments_old")
        conn.execute(ATTACHMENTS)
        for r in conn.execute("SELECT * FROM attachments_old").fetchall():
            conn.execute("INSERT INTO attachments (id, user_id, task_id, name, mime, size, blob_id, "
                         "created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                         (r["id"], r["user_id"], r["task_id"], r["name"], r["mime"], r["size"],
                          put_blob(conn, r["data"]), r["created_at"]))
        conn.execute("DROP TABLE attachments_old")
    area_cols = {r["name"] for r in conn.execute("PRAGMA table_info(areas)")}
    for name in ("icon_svg", "icon_version"):
        if name not in area_cols:
            conn.execute(f"ALTER TABLE areas ADD COLUMN {name} TEXT")
    google_cols = {r["name"] for r in conn.execute("PRAGMA table_info(google_accounts)")}
    for name in ("calendar_name TEXT", "owns_calendar INTEGER"):
        if name.split()[0] not in google_cols:
            conn.execute(f"ALTER TABLE google_accounts ADD COLUMN {name}")
    # Connections from before the calendar could be chosen used the app's own.
    conn.execute("UPDATE google_accounts SET owns_calendar = 1, calendar_name = 'Todo' "
                 "WHERE calendar_id IS NOT NULL AND owns_calendar IS NULL")
    user_cols = {r["name"] for r in conn.execute("PRAGMA table_info(users)")}
    if "settings" not in user_cols:
        conn.execute("ALTER TABLE users ADD COLUMN settings TEXT NOT NULL DEFAULT '{}'")
    if "digest_sent" not in user_cols:
        # The day (user's local date) the morning summary was last sent.
        conn.execute("ALTER TABLE users ADD COLUMN digest_sent TEXT")
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
                      # When the thing it's about expires (a passport, a warranty), and the
                      # notice last sent about it ("date:days before").
                      ("expires_on", "TEXT"),
                      ("expiry_notified", "TEXT"),
                      # Seconds spent on it with the focus timer.
                      ("spent", "INTEGER NOT NULL DEFAULT 0")):
        if name not in cols:
            conn.execute(f"ALTER TABLE tasks ADD COLUMN {name} {ddl}")
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
    conn.executescript(INDEXES)
    conn.commit()
    conn.close()
