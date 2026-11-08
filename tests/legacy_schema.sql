-- The database as it was before documents (db.py at the commit before they came), for
-- testing that older databases are brought up to date. Don't change it.

CREATE TABLE users (
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
, digest_sent TEXT);

CREATE TABLE areas (
    id       INTEGER PRIMARY KEY,
    user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name     TEXT NOT NULL,
    position REAL NOT NULL DEFAULT 0,
    -- cleaned SVG shown before tasks in this area; version changes with it (for caching)
    icon_svg     TEXT,
    icon_version TEXT
);

CREATE TABLE links (
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

CREATE TABLE projects (
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
    -- higher comes first on the Projects page, as for tasks; 0 by default, may be negative
    priority     INTEGER NOT NULL DEFAULT 0,
    position     REAL NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT,
    deleted_at   TEXT
, template_id INTEGER REFERENCES templates(id) ON DELETE SET NULL);

CREATE TABLE tasks (
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
, remind_at TEXT, remind_plan TEXT, reminded_at TEXT, start_notified TEXT, remind_before INTEGER, people TEXT NOT NULL DEFAULT '[]', spent INTEGER NOT NULL DEFAULT 0);

CREATE TABLE series (
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
, carry_files INTEGER NOT NULL DEFAULT 0, from_done INTEGER NOT NULL DEFAULT 0);

CREATE TABLE google_accounts (
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

CREATE TABLE contacts (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    id      TEXT NOT NULL,  -- Google's resource name, people/c…
    name    TEXT NOT NULL,
    info    TEXT NOT NULL,  -- JSON: nicknames, phones, emails, addresses
    PRIMARY KEY (user_id, id)
);

CREATE TABLE gcal_deletions (
    user_id  INTEGER NOT NULL,
    event_id TEXT NOT NULL
);

CREATE TABLE tags (
    id      INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name    TEXT NOT NULL,
    UNIQUE (user_id, name)
);

CREATE TABLE task_tags (
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    tag_id  INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (task_id, tag_id)
);

CREATE TABLE blobs (
    id     INTEGER PRIMARY KEY,
    sha256 TEXT NOT NULL UNIQUE,
    size   INTEGER NOT NULL,
    data   BLOB NOT NULL
);

CREATE TABLE attachments (
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
);

CREATE TABLE task_deps (
    task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    blocker_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    PRIMARY KEY (task_id, blocker_id)
);

CREATE TABLE task_links (
    a INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    b INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    PRIMARY KEY (a, b),
    CHECK (a < b)
);

CREATE TABLE project_tags (
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    tag_id     INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (project_id, tag_id)
);

CREATE TABLE project_deps (
    task_id            INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
    project_id         INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    blocker_task_id    INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
    blocker_project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    CHECK ((task_id IS NULL) != (project_id IS NULL)),
    CHECK ((blocker_task_id IS NULL) != (blocker_project_id IS NULL)),
    CHECK (project_id IS NOT NULL OR blocker_project_id IS NOT NULL)
);

CREATE TABLE project_links (
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    task_id    INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
    other_id   INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    CHECK ((task_id IS NULL) != (other_id IS NULL)),
    CHECK (other_id IS NULL OR project_id < other_id)
);

CREATE TABLE note_categories (
    id       INTEGER PRIMARY KEY,
    user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name     TEXT NOT NULL,
    -- a colour name from the browser's palette (notes.js NOTE_COLORS), '' for none
    color    TEXT NOT NULL DEFAULT '',
    position REAL NOT NULL DEFAULT 0
);

CREATE TABLE journals (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    position   REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE notes (
    id          INTEGER PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title       TEXT NOT NULL DEFAULT '',
    body        TEXT NOT NULL DEFAULT '',
    font        TEXT NOT NULL DEFAULT '',
    category_id INTEGER REFERENCES note_categories(id) ON DELETE SET NULL,
    area_id     INTEGER REFERENCES areas(id) ON DELETE SET NULL,
    journal_id  INTEGER REFERENCES journals(id) ON DELETE SET NULL,
    entry_date  TEXT,
    pinned      INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    -- when its words, files or settings last changed (not pinning or trashing it)
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at  TEXT
);

CREATE TABLE note_tags (
    note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    tag_id  INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (note_id, tag_id)
);

CREATE TABLE note_links (
    note_id    INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    task_id    INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
    project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    CHECK ((task_id IS NULL) != (project_id IS NULL))
);

CREATE TABLE templates (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    data       TEXT NOT NULL,
    repeat     TEXT,
    next_date  TEXT,
    lead_days  INTEGER NOT NULL DEFAULT 7,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE push_subscriptions (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint   TEXT NOT NULL UNIQUE,
    p256dh     TEXT NOT NULL,
    auth       TEXT NOT NULL,
    device     TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE devices (
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

CREATE TABLE app_log (
    id      INTEGER PRIMARY KEY,
    at      TEXT NOT NULL DEFAULT (datetime('now')),
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    kind    TEXT NOT NULL,
    detail  TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX links_user ON links(user_id, parent_id);

CREATE INDEX attachments_task ON attachments(task_id);

CREATE INDEX attachments_project ON attachments(project_id) WHERE project_id IS NOT NULL;

CREATE INDEX attachments_note ON attachments(note_id) WHERE note_id IS NOT NULL;

CREATE INDEX notes_user ON notes(user_id, deleted_at);

CREATE INDEX note_links_note ON note_links(note_id);

CREATE INDEX note_links_task ON note_links(task_id);

CREATE INDEX note_links_project ON note_links(project_id);

CREATE INDEX project_deps_task ON project_deps(task_id);

CREATE INDEX project_deps_project ON project_deps(project_id);

CREATE INDEX project_deps_blocker_task ON project_deps(blocker_task_id);

CREATE INDEX project_deps_blocker_project ON project_deps(blocker_project_id);

CREATE INDEX project_links_project ON project_links(project_id);

CREATE INDEX project_links_task ON project_links(task_id);

CREATE INDEX project_links_other ON project_links(other_id);

CREATE INDEX task_deps_blocker ON task_deps(blocker_id);

CREATE INDEX task_links_b ON task_links(b);

CREATE INDEX attachments_blob ON attachments(blob_id);

CREATE INDEX tasks_user ON tasks(user_id, completed_at, deleted_at);

CREATE UNIQUE INDEX tasks_series ON tasks(series_id, series_index)
    WHERE series_id IS NOT NULL;

CREATE INDEX tasks_gcal ON tasks(gcal_event_id) WHERE gcal_event_id IS NOT NULL;

CREATE TRIGGER attachments_blob_gone AFTER DELETE ON attachments
BEGIN
    DELETE FROM blobs WHERE id = old.blob_id
        AND NOT EXISTS (SELECT 1 FROM attachments WHERE blob_id = old.blob_id);
END;

CREATE TRIGGER tasks_gcal_deleted AFTER DELETE ON tasks
WHEN old.gcal_event_id IS NOT NULL
BEGIN
    INSERT INTO gcal_deletions (user_id, event_id) VALUES (old.user_id, old.gcal_event_id);
END;
