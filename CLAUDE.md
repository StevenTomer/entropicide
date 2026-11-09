# CLAUDE.md

Entropicide: a self-hosted GTD task manager (Flask + SQLite, plain-JS browser app, no build
step). README.md covers running and deploying it; CONTRIBUTING.md the house style. This file
is what's worth knowing before changing it.

## Commands

```sh
venv/bin/python -m pytest -q                          # all tests, ~15s; needs node on PATH
venv/bin/python -m pytest tests/test_repeats.py -q    # one file
ENTROPICIDE_SECURE_COOKIES=0 venv/bin/gunicorn --bind 127.0.0.1:5003 app:app   # dev server
venv/bin/python manage.py create-user me --admin      # uses ./data/entropicide.db
```

`data/` is the real local database: don't delete or reset it. Tests use their own temp DB.

## Layout

- `app.py`: every route, plus repeats, reminders (`_reminder_loop`), the key-based API
  (`/api/add`, `/api/read/<name>`, `/api/complete`), export, admin, Google OAuth and sync loop.
- `db.py`: `SCHEMA` (new tables, `CREATE ... IF NOT EXISTS`) and `migrate()` (changes to
  existing tables). Every schema change must upgrade existing databases in place
  (`tests/legacy_schema.sql` is the database from before documents, for upgrade tests).
- `gcal.py` Google Calendar + Contacts, `push.py` web push, `backup.py`, `icons.py` (SVG
  cleaning), `manage.py` CLI.
- `static/app.js`: the browser app, sectioned by `// ---- name ----` comments; global
  state is `S`. `static/quickadd.js`: quick-add parser, loaded before app.js. `static/editor.js`:
  the formatted-text editor (toolbar, checklists, pictures, the HTML box and Vim) used by both
  task/project details and the note dialog, and `cleanNoteHtml`. `static/notes.js`: the Notes and
  Journal pages and the note dialog. `static/draw.js`: drawings (✎), Sketch (perfect-freehand) and
  Diagram (Excalidraw, a prebuilt bundle in `static/vendor/excalidraw/`, loaded only when used; its
  README says how to rebuild it), saved as SVG files placed as pictures. These load after app.js
  and use its globals.
- `richtext.py`: the HTML any text may hold (editor.js `cleanNoteHtml` mirrors it); the
  server's copy is the one that counts. `from_markdown` converted the old typed notes once.
- `templates/help.html`: the in-app Help page; every user-visible feature belongs there.
- `alexa/`, `android/`, `deploy/`, `docker/`: integrations and deployment (see `docs/`).

## Things that are easy to get wrong

- **One gunicorn worker.** Reminders, Google sync and sign-in throttling run as threads in the
  process. Don't add anything that assumes several workers or processes.
- **quickadd.js runs on the server too**: `quickadd_server.js` runs it in Node's `vm` for
  phone/API adds, with only a stub `S` and `navigator`. Keep it free of DOM and app.js
  dependencies; changes to it affect `/api/add` (tested in `tests/test_phone.py`).
- **Documents:** tasks, projects and notes are rows of `documents` (title, body, area, dates,
  trash) plus `task_data` / `project_data` / `note_data`, under one id space. The code reads and
  writes the views `tasks`, `projects`, `notes` (made in db.py `_views`, with INSTEAD OF
  triggers), so most SQL looks as it did. **New rows must go through `db.insert(conn, view,
  fields)`** (an insert straight into a view raises). Tags, files, links and Blocked by are
  shared (`document_tags`, `attachments.document_id`, `document_links`, `document_deps`).
  Changing kind keeps the id: `become()` in app.py swaps the `*_data` row. Trash and delete
  through `trashed()` / `purge()`, which take a project's contents along. What every kind has is
  validated in `shared_fields` and sent by `with_shared`; copies of a task go through `copy_task`
  (`TASK_COPY` lists what a copy takes). `documents.waypoint` (⚑) puts one on timelines (`/api/timeline`,
  app.js `renderTimeline`); a note's `archived_at` keeps it off the Notes page but searchable. Projects'
  `review_every` / `last_reviewed` drive the weekly review (`review_due`, `stalled` in
  `projects_json`; app.js `reviewHtml`).
- **Text is HTML everywhere**: a task's `notes`, a project's `notes` and a note's `body` are
  cleaned HTML (checklists are `<ul data-check><li data-done="1">`). Anything plain that comes
  in (`/api/add`, sharing, Google) goes through `richtext.from_text`; anything going out as
  plain text (Google, exports, notifications) through `richtext.plain`. Uploads in the browser go
  through `uploadTo()` and file deletes through `deleteAttachment()` (app.js).
- **Offline outbox** (app.js, "offline changes"): task/project changes made offline are
  queued and replayed, and `applyOffline` mirrors server behaviour on `S.data`. New task or
  project fields/endpoints must work through it; offline-created items have negative ids.
  `OFFLINE_PATH` lists which API paths are queued; `OUTBOX_VERSION` drops changes queued
  before an incompatible change of ids; a new field's starting value goes in `OFFLINE_NEW`.
- **CSRF:** non-GET `/api/` requests need `X-Requested-With: entropicide` (tests use `H` from
  `conftest.py`), except `/api/add` and `/api/complete`, which authenticate by key only.
- **Repeats** are encoded strings validated by `valid_repeat`: `daily|weekdays|weekly|monthly|
  yearly`, `every:N[wmy]`, `days:0,2,4` (Mon=0), `nth:(-1|1-4):D`. Server (app.py) and browser
  (app.js `repeatLabel`, `parseEvery`…, quickadd.js) both understand them; change both.
- **Projects take the task states** (or `done`; `active` is the old name for `next`). Moving one
  further off (`db.STATE_RANK`) moves what's in it along (app.py `carry_state`, `join_project`,
  `schedule_project`; app.js mirrors them for offline changes), but nothing holds tasks back by
  their project's state: each can be moved nearer by hand. `PRAGMA user_version` 4 moved the tasks
  of Someday/Later projects when this came in.
- **Task states** are `inbox next soon waiting scheduled someday later`; `next` is shown to
  users as "Queue". Focus is a flag, not a state.
- **Old "Todo" name:** the app was renamed. Compatibility shims (the `todo` header value,
  `/install/todo.apk`, `todo.*` localStorage keys copied in app.html, `deploy/install.sh`
  moving `/opt/todo`) are deliberate; keep them.
- **Blocked by / Related to / subprojects:** `blocked_by` and `related` are plain ids of tasks
  and projects (ids are unique across kinds; `related` items carry their `kind`). Projects nest
  (`parent_id`); a subproject's `step` orders it among its parent's tasks (comparable with their
  `position`). A project that's blocked, completed, or (in a sequential parent) not yet the
  first step holds back everything in it; `waits_on` / `check_no_loops` refuse
  waits that could never end. Server (`list_tasks`) and browser (`waitingOn`, `projectActive`,
  `laterSteps`, `sequentialBlocked`) must agree on what's blocked.
- **Groups and sharing:** `user_groups`, `group_members` (role owner/editor/viewer) and
  `group_invites`; a document (or journal) with `group_id` is its group's members' too. Queries
  for what a user sees use `MINE` (two user-id parameters) or `visible()`; `owned()` on tasks,
  projects, notes and journals means "may see", and for any non-GET "may change" (viewers get
  403); `documents` (purge) stays the maker's alone. What's in a project or journal is shared as
  that is (`follow_container`, `set_group`; `unshare_group` when a group ends). Star, area, order,
  pin and category of someone else's shared document are per person (`document_person`,
  `keep_personal`, overlaid in `with_shared`, which also sends `by`). Tasks have `assigned_to`
  (others' assigned tasks stay out of my lists; reminders go to the assignee). Triggers keep
  `user_groups.changed_at`; the browser polls `/api/changes` (app.js `checkShared`). Inventories
  are next (IDEAS.md).
- Attachments are blobs in the database (deduplicated by sha256), so the DB file is the
  whole backup. Each is on one document; a picture placed in a text is `<img data-file="id">`,
  and the browser adds the `src` (`showBody`).

## Style

- Comments say *why*, in plain sentences; names spelled out. No frameworks, no new
  dependencies without good reason (server: Flask + stdlib; browser: vanilla JS).
- User-facing text is plain, friendly English.
- Server behaviour changes get tests in `tests/` (fixtures: `user_client`, `make_user`,
  `rows`, `H` in `conftest.py`).
- User-visible changes get a line under **Unreleased** in `CHANGELOG.md`, and usually updates
  to `templates/help.html` and `docs/features.md`. Android app changes bump
  `android/version.txt`.
- Commit messages: a plain-English summary title, then a short body of what changed for the
  user.
- `IDEAS.md` is a private, gitignored backlog; don't publish it.
