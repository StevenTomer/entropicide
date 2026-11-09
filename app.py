import calendar
import csv
import difflib
import hashlib
import html
import io
import json
import mimetypes
import os
import re
import secrets
import shutil
import subprocess
import threading
import tempfile
import time
import urllib.parse
import zipfile
from datetime import date, datetime, timedelta
from functools import wraps
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from flask import (Flask, Response, abort, g, jsonify, redirect, render_template,
                   request, send_file, send_from_directory, session, url_for)
from flask.sessions import SecureCookieSessionInterface
from itsdangerous import BadSignature
from werkzeug.exceptions import RequestEntityTooLarge
from werkzeug.middleware.proxy_fix import ProxyFix
from werkzeug.security import check_password_hash, generate_password_hash

import backup
import db
import push
import gcal
import icons
import richtext

TASK_STATES = {"inbox", "next", "soon", "waiting", "scheduled", "someday", "later"}
PROJECT_STATES = {"active", "someday", "later", "done"}
REPEATS = set(db.DEFAULT_ON_MISS)
# every N days (every:9), weeks (every:2w), months (every:3m) or years (every:1y); N up to 999
EVERY_RE = re.compile(r"every:([1-9][0-9]{0,2})([wmy]?)")
# on certain days of the week, Monday 0 to Sunday 6, in order: days:0,2,4 is Mon, Wed and Fri
DAYS_RE = re.compile(r"days:[0-6](,[0-6]){0,6}")


def week_days(repeat):
    """The days of the week of a days:… repeat (Monday 0), or None for other repeats."""
    if not DAYS_RE.fullmatch(str(repeat or "")):
        return None
    days = [int(d) for d in repeat[5:].split(",")]
    return days if days == sorted(set(days)) else None


# monthly, on the nth (1 to 4, or -1 for the last) given day of the week (Monday 0):
# nth:1:0 is the first Monday of each month, nth:-1:4 the last Friday
NTH_RE = re.compile(r"nth:(-1|[1-4]):([0-6])")


def valid_repeat(repeat):
    return (repeat in REPEATS | {None} or bool(EVERY_RE.fullmatch(str(repeat)))
            or week_days(repeat) is not None or bool(NTH_RE.fullmatch(str(repeat))))


def nth_weekday(year, month, nth, weekday):
    """The nth (or, for -1, the last) weekday (Monday 0) of a month."""
    if nth > 0:
        first = date(year, month, 1)
        return first + timedelta(days=(weekday - first.weekday()) % 7 + 7 * (nth - 1))
    last = date(year, month, calendar.monthrange(year, month)[1])
    return last - timedelta(days=(last.weekday() - weekday) % 7)
ON_MISS = {"keep", "replace"}
ENERGIES = {"low", "medium", "high"}
PRIORITY_MAX = 99
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
# Defer menu entries: a count and a unit (minutes, hours, days, weeks, months).
DEFER_RE = re.compile(r"^([1-9]\d{0,2})(m|h|d|w|mo)$")
# timezone: the user's (IANA name, set by their browser); Google sync works in it.
DEFAULT_SETTINGS = {"defer_options": ["1h", "2h", "6h", "24h", "3d", "1w"], "timezone": "",
                    # Notifications: when a task's start time comes, and a morning summary
                    # of what's due ("" for none).
                    "notify_starts": True, "digest_time": "08:00",
                    # No notifications in these hours ("22:00-07:00"; "" for none): they're
                    # sent when they end.
                    "quiet_hours": "",
                    # Where the phone's Share menu puts things: inbox (a task), note,
                    # journal:<id> (a new entry in that journal), or ask (each time)
                    "share_to": "inbox"}
# Reminders before a due date: the days a task can choose, and the time of day they come.
REMIND_BEFORE_DAYS = (1, 2, 3, 7, 14, 30, 60, 90)
REMIND_BEFORE_TIME = "09:00"
STAMP_RE = re.compile(r"^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$")
MIN_PASSWORD = 8
MAX_CATCH_UP = 400  # occurrences one series may generate per page load

# Site settings: where the app is served, its Android app, who runs it. Each comes from the
# environment as ENTROPICIDE_<NAME> (as in Docker), else deploy/site.conf (see site.conf.example).
SITE = {}
try:
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "deploy", "site.conf")) as f:
        SITE = dict(m.groups() for line in f if (m := re.match(r"\s*([A-Z_]+)=(.*?)\s*$", line)))
except OSError:
    pass


def setting(name, default=""):
    return os.environ.get("ENTROPICIDE_" + name) or SITE.get(name) or default


def secret_key(db_path):
    """ENTROPICIDE_SECRET_KEY, else one made once and kept next to the database, so restarts
    don't sign everyone out."""
    if os.environ.get("ENTROPICIDE_SECRET_KEY"):
        return os.environ["ENTROPICIDE_SECRET_KEY"]
    path = os.path.join(os.path.dirname(os.path.abspath(db_path)), "secret_key")
    try:
        with open(path) as f:
            return f.read().strip()
    except FileNotFoundError:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        key = secrets.token_hex(32)
        with open(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as f:
            f.write(key)
        return key


app = Flask(__name__)
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)
DATABASE = os.environ.get("ENTROPICIDE_DATABASE", os.path.join(app.root_path, "data", "entropicide.db"))
app.config.update(
    SECRET_KEY=secret_key(DATABASE),
    DATABASE=DATABASE,
    SESSION_COOKIE_NAME="entropicide_session",
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=os.environ.get("ENTROPICIDE_SECURE_COOKIES", "1") == "1",
    PERMANENT_SESSION_LIFETIME=timedelta(days=30),
    MAX_CONTENT_LENGTH=26 * 1024 * 1024,  # attachments are up to 25 MB
)
app.teardown_appcontext(db.close_db)
db.init_db(app.config["DATABASE"])


class SessionInterface(SecureCookieSessionInterface):
    """Flask's signed-cookie sessions, which also read the cookie's name from before the
    rename (todo_session), so nobody is signed out by it; the next response sets the new one."""
    OLD_NAME = "todo_session"

    def open_session(self, app, request):
        if app.config["SESSION_COOKIE_NAME"] not in request.cookies and self.OLD_NAME in request.cookies:
            serializer = self.get_signing_serializer(app)
            try:
                data = serializer.loads(request.cookies[self.OLD_NAME],
                                        max_age=int(app.permanent_session_lifetime.total_seconds()))
            except BadSignature:
                return self.session_class()
            session = self.session_class(data)
            session.modified = True  # (saves it under the new name)
            return session
        return super().open_session(app, request)

    def save_session(self, app, session, response):
        super().save_session(app, session, response)
        if self.OLD_NAME in request.cookies:
            response.delete_cookie(self.OLD_NAME, path=self.get_cookie_path(app),
                                   domain=self.get_cookie_domain(app))


app.session_interface = SessionInterface()


# --- auth -----------------------------------------------------------------

# Failed logins per (ip, username), and per ip across usernames (someone trying many);
# one gunicorn worker so in-memory is fine.
_failures = {}
MAX_FAILURES = 5
MAX_FAILURES_PER_IP = 20
LOCKOUT_SECONDS = 15 * 60


def _too_many_failures(key, limit=MAX_FAILURES):
    now = time.time()
    recent = [t for t in _failures.get(key, []) if now - t < LOCKOUT_SECONDS]
    _failures[key] = recent
    return len(recent) >= limit


def _session_stamp(user):
    # Changes whenever the password changes, which signs out other sessions.
    return user["password_hash"][-12:]


@app.before_request
def load_user():
    g.user = None
    uid = session.get("uid")
    if uid is None:
        return
    user = db.get_db().execute(
        "SELECT * FROM users WHERE id = ?", (uid,)).fetchone()
    if user and not user["disabled"] and session.get("stamp") == _session_stamp(user):
        g.user = user
    else:
        session.clear()


# The header the app's own requests carry ("todo": pages and phone apps from before the rename).
REQUESTED_WITH = {"entropicide", "todo"}


KEY_ONLY = {"/api/add", "/api/complete", "/api/app/crash"}


@app.before_request
def csrf_check():
    # API writes must carry a custom header, which a cross-site form can't send. (Not those in
    # KEY_ONLY, which go by their key alone, never the signed-in user's cookie.)
    if (request.path.startswith("/api/") and request.method != "GET" and request.path not in KEY_ONLY
            and request.headers.get("X-Requested-With") not in REQUESTED_WITH):
        abort(403)


def login_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if g.user is None:
            if request.path.startswith("/api/"):
                return jsonify(error="not logged in"), 401
            return redirect(url_for("login"))
        return view(*args, **kwargs)
    return wrapped


def admin_required(view):
    @wraps(view)
    @login_required
    def wrapped(*args, **kwargs):
        if not g.user["is_admin"]:
            abort(403)
        return view(*args, **kwargs)
    return wrapped


@app.route("/login", methods=["GET", "POST"])
def login():
    error = None
    if request.method == "POST":
        if request.form.get("csrf") != session.get("login_csrf"):
            error = "Your session expired. Please try again."
        else:
            username = request.form.get("username", "").strip()
            password = request.form.get("password", "")
            key = (request.remote_addr, username.lower())
            ip_key = (request.remote_addr, None)
            if _too_many_failures(key) or _too_many_failures(ip_key, MAX_FAILURES_PER_IP):
                error = "Too many failed attempts. Try again in 15 minutes."
            else:
                user = db.get_db().execute(
                    "SELECT * FROM users WHERE username = ?", (username,)).fetchone()
                if (user and not user["disabled"]
                        and check_password_hash(user["password_hash"], password)):
                    _failures.pop(key, None)
                    session.clear()
                    session.permanent = True
                    session["uid"] = user["id"]
                    session["stamp"] = _session_stamp(user)
                    conn = db.get_db()
                    conn.execute("UPDATE users SET last_login = datetime('now') WHERE id = ?",
                                 (user["id"],))
                    conn.commit()
                    return redirect(url_for("index"))
                _failures.setdefault(key, []).append(time.time())
                _failures.setdefault(ip_key, []).append(time.time())
                error = "Wrong username or password."
    session["login_csrf"] = secrets.token_urlsafe(16)
    return render_template("login.html", error=error, csrf=session["login_csrf"])


@app.route("/logout", methods=["POST"])
def logout():
    session.clear()
    return redirect(url_for("login"))


@app.get("/privacy")
def privacy():
    return render_template("privacy.html")


# --- installable app --------------------------------------------------------

APP_NAME = "Entropicide"


@app.context_processor
def site_settings():
    # The phone-connect link names the Android app's package (app.js, fillDevices); the
    # privacy page names who runs the site.
    return {"android_package": setting("ANDROID_PACKAGE"), "operator": setting("OPERATOR"),
            "contact": setting("CONTACT")}
# The Android app (android/build.mjs) puts entropicide.apk and assetlinks.json here.
APK_DIR = setting("APK_DIR", os.path.join(os.path.dirname(os.path.abspath(__file__)), "apk"))
APK_NAME = "entropicide.apk"


@app.get("/manifest.webmanifest")
def web_manifest():
    home = url_for("index")
    icon = lambda name: url_for("static", filename="icons/" + name)
    return jsonify(
        # Lets the installed app take things from the phone's Share menu (see share()).
        share_target={"action": url_for("share"), "method": "POST", "enctype": "multipart/form-data",
                      "params": {"title": "title", "text": "text", "url": "url",
                                 "files": [{"name": "files", "accept": ["*/*"]}]}},
        # Right-click the taskbar or dock icon (long-press on Android) → New task (app.js afterLoad).
        shortcuts=[{"name": "New task", "url": url_for("index", new=1),
                    "icons": [{"src": icon("icon-192.png"), "sizes": "192x192", "type": "image/png"}]}],
        id=home, start_url=home, scope=home, name=APP_NAME, short_name=APP_NAME,
        description="From chaos to clarity: tasks, GTD style", display="standalone",
        background_color="#ffffff", theme_color="#0866a8",
        icons=[
            {"src": icon("icon-192.png"), "sizes": "192x192", "type": "image/png"},
            {"src": icon("icon-512.png"), "sizes": "512x512", "type": "image/png"},
            {"src": icon("maskable-512.png"), "sizes": "512x512", "type": "image/png",
             "purpose": "maskable"},
        ],
    ), 200, {"Content-Type": "application/manifest+json"}


@app.get("/sw.js")
def service_worker():
    # Served from the app's root rather than /static so that it covers every page.
    res = send_from_directory(app.static_folder, "sw.js", max_age=0)
    res.headers["Cache-Control"] = "no-cache"
    return res


@app.get("/help")
def help_page():
    return render_template("help.html")


def apk_version():
    """The APK on offer: {"code": …, "name": …} from apk/version.json (android/build.mjs)."""
    try:
        with open(os.path.join(APK_DIR, "version.json")) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


@app.get("/install")
def install():
    path = os.path.join(APK_DIR, APK_NAME)
    apk = None
    if os.path.isfile(path):
        st = os.stat(path)
        apk = {"size_mb": f"{st.st_size / 1e6:.1f}",
               "built": datetime.fromtimestamp(st.st_mtime).strftime("%-d %b %Y"),
               "version": (apk_version() or {}).get("name")}
    return render_template("install.html", apk=apk)


def version_name(code):
    """1000007 → "1.0.7" (android/build.mjs); older builds had no version, or a smaller code."""
    try:
        code = int(code)
    except (TypeError, ValueError):
        return "an early build (no version)"
    if code < 1_000_000:
        return f"an early build ({code})"
    return f"{code // 1_000_000}.{code // 1000 % 1000}.{code % 1000}"


@app.get("/install/version")
def install_version():
    # The Android app compares this with its own version, to offer updates.
    res = jsonify(apk_version() or {})
    res.headers["Cache-Control"] = "no-cache"
    return res


@app.get("/install/entropicide.apk")
def install_apk():
    return send_from_directory(APK_DIR, APK_NAME, max_age=0, as_attachment=True,
                               mimetype="application/vnd.android.package-archive")


@app.get("/install/todo.apk")  # its name before Entropicide, in older pages and apps
def install_apk_old_name():
    return install_apk()


@app.get("/assetlinks.json")
def asset_links():
    # The web server serves this as https://SITE_HOST/.well-known/assetlinks.json. It tells
    # Chrome the Android app is ours, so the app opens full screen with no address bar.
    return send_from_directory(APK_DIR, "assetlinks.json", max_age=300,
                               mimetype="application/json")


@app.route("/")
def index():
    # The Android app opens SITE_PATH/?app=<version>; older builds are known by Chrome's referrer.
    if request.args.get("app") or request.referrer and request.referrer.startswith("android-app://"):
        app_log("launch", **request_info(), app_version=version_name(request.args.get("app")))
    if g.user is None:
        return redirect(url_for("login"))
    return render_template("app.html", user=g.user)


# --- troubleshooting log (shares and app launches) ------------------------

APP_LOG_KEEP = 300


def request_info():
    h = request.headers
    return {"method": request.method, "url": request.full_path.rstrip("?"),
            "referrer": h.get("Referer", ""), "agent": h.get("User-Agent", ""),
            "content_type": h.get("Content-Type", ""), "length": request.content_length,
            "signed_in": g.get("user") is not None}


def app_log(kind, **detail):
    """Notes a share attempt or an app launch for SITE_PATH/debug. Never fails the request."""
    try:
        conn = db.get_db()
        conn.execute("INSERT INTO app_log (user_id, kind, detail) VALUES (?, ?, ?)",
                     (g.user["id"] if g.get("user") else None, kind, json.dumps(detail)))
        conn.execute("DELETE FROM app_log WHERE id <= (SELECT MAX(id) FROM app_log) - ?",
                     (APP_LOG_KEEP,))
        conn.commit()
    except Exception:
        app.logger.exception("app_log")


def without_content(detail):
    """An App log entry from someone else (as an admin sees it): what happened, but not what
    they shared or typed, or their files' names."""
    detail = dict(detail)
    if isinstance(detail.get("fields"), dict):
        detail["fields"] = {k: f"({len(str(v))} characters)" for k, v in detail["fields"].items()}
    if isinstance(detail.get("files"), list):
        detail["files"] = [{k: v for k, v in f.items() if k != "name"} for f in detail["files"] if isinstance(f, dict)]
    if "text" in detail:
        detail["text"] = f"({len(str(detail['text']))} characters)"
    if "url" in detail and detail.get("method") == "POST":
        detail["url"] = str(detail["url"]).split("?")[0]
    return detail


@app.get("/debug")
@login_required
def debug_page():
    # Your own entries; admins also see everyone's, and shares that arrived signed out.
    tz = ZoneInfo(user_tz(g.user))
    mine = "" if g.user["is_admin"] else "WHERE user_id = ? "
    rows = db.get_db().execute(
        "SELECT app_log.*, users.username FROM app_log LEFT JOIN users ON users.id = user_id "
        + mine + "ORDER BY app_log.id DESC LIMIT 100", () if g.user["is_admin"] else (g.user["id"],)).fetchall()
    entries = []
    for r in rows:
        at = datetime.fromisoformat(r["at"]).replace(tzinfo=ZoneInfo("UTC")).astimezone(tz)
        detail = json.loads(r["detail"])
        if r["user_id"] != g.user["id"]:
            detail = without_content(detail)
        entries.append({"at": at.strftime("%a %-d %b %H:%M:%S"), "kind": r["kind"],
                        "user": r["username"] or "(not signed in)", "detail": detail})
    return render_template("debug.html", entries=entries, apk=apk_version(), admin=g.user["is_admin"])


# --- helpers --------------------------------------------------------------

def body():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        abort(400)
    return data


def bad(message):
    return jsonify(error=message), 400


def owned(table, row_id):
    row = db.get_db().execute(
        f"SELECT * FROM {table} WHERE id = ? AND user_id = ?",
        (row_id, g.user["id"])).fetchone()
    if row is None:
        abort(404)
    return row


def next_position(table, where="", params=()):
    row = db.get_db().execute(
        f"SELECT COALESCE(MAX(position), 0) + 1 FROM {table} WHERE user_id = ? {where}",
        (g.user["id"], *params)).fetchone()
    return row[0]


def task_dict(row, series):
    d = dict(row)
    d["focus"] = bool(d["focus"])
    d["missed"] = bool(d["missed"])
    d["people"] = json.loads(d["people"])
    s = series.get(row["series_id"])
    d["repeat"] = s["repeat"] if s else None
    d["on_miss"] = s["on_miss"] if s else None
    d["carry_files"] = bool(s["carry_files"]) if s else False
    d["repeat_from"] = ("done" if s["from_done"] else "calendar") if s else None
    d["series_latest"] = s["latest"] if s else None
    return d


# --- what documents share: tags, files, Blocked by, Related to ------------------
# Tasks, projects and notes are documents (db.py), so these work the same for each.

def marks_for(ids):
    return ",".join("?" * len(ids))


def tags_for(ids):
    """{document id: [tag names]}."""
    if not ids:
        return {}
    out = {}
    for r in db.get_db().execute(
            f"SELECT dt.document_id, t.name FROM document_tags dt JOIN tags t ON t.id = dt.tag_id "
            f"WHERE dt.document_id IN ({marks_for(ids)}) ORDER BY t.name", ids):
        out.setdefault(r["document_id"], []).append(r["name"])
    return out


def attachments_for(ids):
    """{document id: [attachment info]} (without the files themselves)."""
    if not ids:
        return {}
    out = {}
    for r in db.get_db().execute(
            f"SELECT id, document_id, name, mime, size, created_at FROM attachments "
            f"WHERE document_id IN ({marks_for(ids)}) ORDER BY id", ids):
        out.setdefault(r["document_id"], []).append(
            {"id": r["id"], "name": r["name"], "mime": r["mime"], "size": r["size"],
             "created_at": r["created_at"]})
    return out


def blockers_for(ids):
    """{document id: [ids of the tasks and projects it's blocked by]}."""
    if not ids:
        return {}
    out = {}
    for r in db.get_db().execute(f"SELECT document_id, blocker_id FROM document_deps "
                                 f"WHERE document_id IN ({marks_for(ids)}) ORDER BY blocker_id", ids):
        out.setdefault(r["document_id"], []).append(r["blocker_id"])
    return out


def kind_of(doc_id):
    row = db.get_db().execute("SELECT kind FROM documents WHERE id = ?", (doc_id,)).fetchone()
    return row and row[0]


def project_chain(project_id):
    """A project and the projects it's part of, outward (subproject first)."""
    conn, out = db.get_db(), []
    while project_id and project_id not in out:
        out.append(project_id)
        row = conn.execute("SELECT parent_id FROM project_data WHERE id = ?", (project_id,)).fetchone()
        project_id = row and row[0]
    return out


def project_contents(project_id):
    """Everything in a project, at any depth: its tasks, its subprojects and theirs (ids)."""
    conn, out, pending = db.get_db(), set(), [project_id]
    while pending:
        p = pending.pop()
        for r in conn.execute("SELECT id FROM task_data WHERE project_id = ? UNION ALL "
                              "SELECT id FROM project_data WHERE parent_id = ?", (p, p)):
            if r[0] not in out:
                out.add(r[0])
                pending.append(r[0])
    return out


def waits_on(doc_id):
    """What a task or project can't be done before: what it's blocked by, and what the
    projects it's in (at any depth) are blocked by; for a project, also what's in it."""
    conn = db.get_db()
    kind = kind_of(doc_id)
    if kind == "task":
        row = conn.execute("SELECT project_id FROM task_data WHERE id = ?", (doc_id,)).fetchone()
        around = project_chain(row and row[0])
    else:
        row = conn.execute("SELECT parent_id FROM project_data WHERE id = ?", (doc_id,)).fetchone()
        around = project_chain(row and row[0])
    out = [r[0] for x in [doc_id, *around]
           for r in conn.execute("SELECT blocker_id FROM document_deps WHERE document_id = ?", (x,))]
    if kind == "project":
        out += [r[0] for r in conn.execute(
            "SELECT t.id FROM task_data t JOIN documents d ON d.id = t.id WHERE t.project_id = ? AND d.deleted_at IS NULL "
            "UNION ALL SELECT p.id FROM project_data p JOIN documents d ON d.id = p.id WHERE p.parent_id = ? "
            "AND d.deleted_at IS NULL", (doc_id, doc_id))]
    return out


def checked_ids(ids, kinds, what, limit=50):
    """ids (from the API) as a list of the user's documents of one of kinds; ValueError if not."""
    if not isinstance(ids, list) or len(ids) > limit:
        raise ValueError(f"{what} must be a list of ids")
    out = []
    for i in dict.fromkeys(int(x) for x in ids):
        row = db.get_db().execute("SELECT kind FROM documents WHERE id = ? AND user_id = ?",
                                  (i, g.user["id"])).fetchone()
        if not row or row[0] not in kinds:
            raise ValueError(f"No such {' or '.join(kinds)}.")
        out.append(i)
    return out


def given_ids(data, field):
    """The ids the API data gives for field ("blocked_by" or "related": tasks and projects,
    by id), or None if it doesn't. (Older apps sent projects apart, in field + "_projects".)"""
    if field not in data and field + "_projects" not in data:
        return None
    ids = [data.get(field) or [], data.get(field + "_projects") or []]
    if not all(isinstance(x, list) for x in ids):
        raise ValueError(f"{field} must be a list of ids")
    return [x["id"] if isinstance(x, dict) else x for x in ids[0] + ids[1]]


def set_blockers(kind, item_id, ids):
    """Replace what a task or project (kind "task" or "project") is blocked by: ids, tasks and
    projects (None leaves them). ValueError for one that isn't the user's, the item itself, or
    a wait that could never end (one that, in turn, waits on this, or a project and something
    in it); the change is then not to be committed."""
    if ids is None:
        return
    conn = db.get_db()
    blockers = checked_ids(ids, ("task", "project"), "blocked by")
    inside = project_contents(item_id) if kind == "project" else set()
    for b in blockers:
        if b == item_id:
            raise ValueError(f"A {kind} can't wait on itself.")
        if b in inside:
            raise ValueError("A project can't wait on something in it.")
    conn.execute("DELETE FROM document_deps WHERE document_id = ?", (item_id,))
    conn.executemany("INSERT INTO document_deps (document_id, blocker_id) VALUES (?, ?)",
                     [(item_id, b) for b in blockers])
    check_no_loops(item_id)  # (one that, through what it waits on, waits on this; the caller undoes it)


def links_for(ids):
    """{document id: [{id, kind, title, done, trashed}]}: the tasks and projects each is related
    (or, a note, linked) to, by title. (Notes linked to it are in the notes' own lists.)"""
    if not ids:
        return {}
    marks = marks_for(ids)
    out = {}
    for r in db.get_db().execute(
            f"SELECT l.mine, d.id, d.kind, d.title, d.deleted_at, t.completed_at, p.state FROM "
            f"(SELECT a AS mine, b AS other FROM document_links WHERE a IN ({marks}) "
            f"UNION ALL SELECT b, a FROM document_links WHERE b IN ({marks})) l "
            "JOIN documents d ON d.id = l.other LEFT JOIN task_data t ON t.id = d.id "
            "LEFT JOIN project_data p ON p.id = d.id WHERE d.kind != 'note' ORDER BY d.title COLLATE NOCASE", ids * 2):
        out.setdefault(r["mine"], []).append({
            "id": r["id"], "kind": r["kind"], "title": r["title"], "trashed": bool(r["deleted_at"]),
            "done": r["state"] == "done" if r["kind"] == "project" else bool(r["completed_at"])})
    return out


def set_related(kind, item_id, ids):
    """Replace the tasks and projects (ids; None leaves them) related to (or, for a note,
    linked to) a task, project or note. Links go both ways; links with notes are the notes'."""
    if ids is None:
        return
    conn = db.get_db()
    others = checked_ids(ids, ("task", "project"), "related")
    if item_id in others:
        raise ValueError(f"A {kind} can't be related to itself.")
    conn.execute("DELETE FROM document_links WHERE (a = ? AND b IN (SELECT id FROM documents WHERE kind != 'note')) "
                 "OR (b = ? AND a IN (SELECT id FROM documents WHERE kind != 'note'))", (item_id, item_id))
    conn.executemany("INSERT OR IGNORE INTO document_links (a, b) VALUES (?, ?)",
                     [(min(item_id, o), max(item_id, o)) for o in others])


def link(a, b):
    """Relate two documents (if they aren't already)."""
    if a != b:
        db.get_db().execute("INSERT OR IGNORE INTO document_links (a, b) VALUES (?, ?)", (min(a, b), max(a, b)))


def copy_links(from_id, to_id):
    """Give document to_id the same links as from_id."""
    db.get_db().execute(
        "INSERT OR IGNORE INTO document_links (a, b) SELECT MIN(?, other), MAX(?, other) FROM "
        "(SELECT b AS other FROM document_links WHERE a = ? UNION SELECT a FROM document_links WHERE b = ?) "
        "WHERE other != ?", (to_id, to_id, from_id, from_id, to_id))


def copy_shared(from_id, to_id, deps=True, files=True):
    """Give document to_id the same tags and links as from_id; with deps, the same Blocked by;
    with files, the same files (stored once)."""
    conn = db.get_db()
    conn.execute("INSERT OR IGNORE INTO document_tags SELECT ?, tag_id FROM document_tags WHERE document_id = ?",
                 (to_id, from_id))
    copy_links(from_id, to_id)
    if deps:
        conn.execute("INSERT OR IGNORE INTO document_deps SELECT ?, blocker_id FROM document_deps "
                     "WHERE document_id = ? AND blocker_id != ?", (to_id, from_id, to_id))
    if files:
        copy_files(from_id, to_id)


# What a copy of a task takes from it (Duplicate, and each new copy of a repeating task); the
# rest (when it was done, reminders sent, time spent, its calendar event) starts afresh.
TASK_COPY = ("project_id", "area_id", "title", "notes", "state", "focus", "due_date", "start_date", "start_time",
             "waiting_for", "energy", "minutes", "priority", "remind_before", "people", "position")


def copy_task(t, changes, deps=True, files=True):
    """A new task like t (row from tasks): its details as in TASK_COPY, with changes, and its
    tags and links (and with deps its Blocked by, with files its files). Returns its id."""
    new = db.insert(db.get_db(), "tasks", {"user_id": t["user_id"], **{c: t[c] for c in TASK_COPY}} | changes)
    copy_shared(t["id"], new, deps=deps, files=files)
    return new


def copy_files(from_id, to_id):
    db.get_db().execute(
        "INSERT INTO attachments (user_id, document_id, name, mime, size, blob_id, created_at) "
        "SELECT user_id, ?, name, mime, size, blob_id, created_at FROM attachments WHERE document_id = ? ORDER BY id",
        (to_id, from_id))


def with_shared(rows, kind, shape):
    """Tasks, projects or notes (rows from kind's view) as the API sends them: shape(row) (a
    dict, with what the kind has of its own), and what every document has: its tags, files and
    what it's related (linked) to, and for tasks and projects what it's blocked by."""
    ids = [r["id"] for r in rows]
    tags, files, links = tags_for(ids), attachments_for(ids), links_for(ids)
    blockers = blockers_for(ids) if kind != "note" else None
    out = []
    for row in rows:
        d = shape(row)
        d.pop("user_id", None)
        d["waypoint"] = bool(d.get("waypoint"))
        d |= {"tags": tags.get(d["id"], []), "attachments": files.get(d["id"], []), "related": links.get(d["id"], [])}
        if blockers is not None:
            d["blocked_by"] = blockers.get(d["id"], [])
        out.append(d)
    return out


def tasks_json(rows):
    ids = list({r["series_id"] for r in rows if r["series_id"]})
    series = {}
    if ids:
        series = {s["id"]: s for s in db.get_db().execute(
            f"SELECT * FROM series WHERE id IN ({marks_for(ids)})", ids)}
    return with_shared(rows, "task", lambda r: task_dict(r, series))


def project_dict(row):
    return projects_json([row])[0]


# --- timelines --------------------------------------------------------------------
# A timeline is a line through today: what's done (or written) behind it, what's coming (due,
# else starting) ahead. It shows waypoints (the ⚑ flag), or with ?all=1 everything dated.

@app.get("/api/timeline")
@login_required
def timeline():
    """Waypoints on a line in time, as [{id, kind, title, date, time, when, done, waypoint,
    project_id}] in order: of all tasks and projects (default), ?project=<id> (what's in it, at
    any depth, and it), ?journal=<id> (its entries) or ?notes=1 (notes, not entries). ?all=1:
    everything dated, not just waypoints."""
    conn, uid = db.get_db(), g.user["id"]
    tz = ZoneInfo(user_tz(g.user))
    local = lambda stamp: datetime.fromisoformat(stamp.replace(" ", "T") + "+00:00").astimezone(tz)  # noqa: E731
    flagged = "" if request.args.get("all") else " AND waypoint = 1"
    items = []

    def add(row, kind, date, time_, when, done):
        items.append({"id": row["id"], "kind": kind, "title": row["title"] if kind != "project" else row["name"],
                      "date": date, "time": time_, "when": when, "done": done, "waypoint": bool(row["waypoint"]),
                      "project_id": row["project_id"] if kind == "task" else row["parent_id"] if kind == "project" else None})

    if request.args.get("journal") or request.args.get("notes"):
        if request.args.get("journal"):
            owned("journals", request.args.get("journal", type=int))
            rows = conn.execute(f"SELECT * FROM notes WHERE user_id = ? AND journal_id = ? AND deleted_at IS NULL{flagged}",
                                (uid, request.args.get("journal", type=int))).fetchall()
        else:
            rows = conn.execute(f"SELECT * FROM notes WHERE user_id = ? AND journal_id IS NULL AND deleted_at IS NULL{flagged}",
                                (uid,)).fetchall()
        for n in rows:
            if n["entry_date"]:
                add(n, "note", n["entry_date"], n["entry_time"], "entry", True)
            else:
                at = local(n["created_at"])
                add(n, "note", at.date().isoformat(), at.strftime("%H:%M"), "written", True)
    else:
        inside = None
        if request.args.get("project"):
            pid = owned("projects", request.args.get("project", type=int))["id"]
            inside = project_contents(pid) | {pid}
        keep = lambda r: inside is None or r["id"] in inside  # noqa: E731
        for t in conn.execute(f"SELECT * FROM tasks WHERE user_id = ? AND deleted_at IS NULL AND missed = 0{flagged}",
                              (uid,)).fetchall():
            if not keep(t):
                continue
            if t["completed_at"]:
                at = local(t["completed_at"])
                add(t, "task", at.date().isoformat(), at.strftime("%H:%M"), "done", True)
            elif t["due_date"]:
                add(t, "task", t["due_date"], None, "due", False)
            elif t["start_date"]:
                add(t, "task", t["start_date"], t["start_time"], "start", False)
        for p in conn.execute(f"SELECT * FROM projects WHERE user_id = ? AND deleted_at IS NULL{flagged}", (uid,)).fetchall():
            if not keep(p):
                continue
            if p["completed_at"] and p["state"] == "done":
                at = local(p["completed_at"])
                add(p, "project", at.date().isoformat(), at.strftime("%H:%M"), "done", True)
            elif p["due_date"]:
                add(p, "project", p["due_date"], None, "due", False)
    items.sort(key=lambda x: (x["date"], x["time"] or "", x["id"]))
    return jsonify(items=items[-2000:], today=datetime.now(tz).date().isoformat())


def document_json(doc_id):
    """A task, project or note as the API sends it."""
    kind = kind_of(doc_id)
    if kind == "project":
        return project_dict(owned("projects", doc_id))
    if kind == "note":
        return note_dict(doc_id)
    return tasks_json([owned("tasks", doc_id)])[0]


def projects_json(rows):
    """Projects as the API sends them: with their tags, files, what they're blocked by and
    what they're related to."""
    return with_shared(rows, "project", lambda r: dict(r) | {"focus": bool(r["focus"]), "sequential": bool(r["sequential"])})


def clean_date(value):
    if value in (None, ""):
        return None
    if not isinstance(value, str) or not DATE_RE.match(value):
        raise ValueError("dates must be YYYY-MM-DD")
    if not 1900 <= date.fromisoformat(value).year <= 2199:
        raise ValueError("date is out of range")
    return value


def client_today():
    return client_now()[0]


def client_now():
    """(date, HH:MM) on the user's device, sent as ?now=YYYY-MM-DDTHH:MM (or ?today=)."""
    day, _, hhmm = request.args.get("now", "").partition("T")
    day = day or request.args.get("today", "")
    try:
        day = clean_date(day)
    except ValueError:
        day = None
    if not day:
        return date.today().isoformat(), time.strftime("%H:%M")
    return day, hhmm if TIME_RE.match(hhmm) else "23:59"


def user_settings(user):
    try:
        saved = json.loads(user["settings"] or "{}")
    except ValueError:
        saved = {}
    return DEFAULT_SETTINGS | {k: v for k, v in saved.items() if k in DEFAULT_SETTINGS}


def set_tags(item_id, names):
    """Replace a task's, project's or note's tags, making new ones as needed."""
    conn = db.get_db()
    conn.execute("DELETE FROM document_tags WHERE document_id = ?", (item_id,))
    for name in {n.strip()[:100] for n in names if isinstance(n, str) and n.strip()}:
        conn.execute("INSERT OR IGNORE INTO tags (user_id, name) VALUES (?, ?)",
                     (g.user["id"], name))
        tag = conn.execute("SELECT id FROM tags WHERE user_id = ? AND name = ?",
                           (g.user["id"], name)).fetchone()
        conn.execute("INSERT OR IGNORE INTO document_tags VALUES (?, ?)", (item_id, tag["id"]))


def check_ref(table, value):
    if value in (None, ""):
        return None
    owned(table, int(value))
    return int(value)


PERSON_RE = re.compile(r"people/\w{1,100}")


def shared_fields(kind, key, value, out):
    """Validates into out the fields every kind has alike (as its view names them): its title
    (a note's may be empty), formatted text, area and the trash; and for tasks and projects,
    Focus, priority and the due date. False if key isn't one of them."""
    title, text = {"task": ("title", "notes"), "project": ("name", "notes"), "note": ("title", "body")}[kind]
    if key == title:
        value = str(value or "").strip()[:500]
        if not value and kind != "note":
            raise ValueError(f"{title} is required")
        out[key] = value
    elif key == text:
        out[key] = richtext.clean(value)
    elif key == "area_id":
        out[key] = check_ref("areas", value)
    elif key == "deleted":
        out["deleted_at"] = utcnow() if value else None
    elif key == "waypoint":
        out[key] = 1 if value else 0
    elif kind == "note":
        return False
    elif key == "focus":
        out[key] = 1 if value else 0
    elif key == "priority":
        value = int(value or 0)
        if not -PRIORITY_MAX <= value <= PRIORITY_MAX:
            raise ValueError(f"priority must be between -{PRIORITY_MAX} and {PRIORITY_MAX}")
        out[key] = value
    elif key == "due_date":
        out[key] = clean_date(value)
    else:
        return False
    return True


def task_fields(data):
    """Validate the editable task fields present in data."""
    out = {}
    for key, value in data.items():
        if shared_fields("task", key, value, out):
            continue
        if key == "waiting_for":
            out[key] = str(value or "")[:20000]
        elif key == "state":
            if value not in TASK_STATES:
                raise ValueError("bad state")
            out[key] = value
        elif key == "start_date":
            out[key] = clean_date(value)
        elif key == "remind_before":
            if value not in (None, "") and int(value) not in REMIND_BEFORE_DAYS:
                raise ValueError("remind_before must be one of " + ", ".join(map(str, REMIND_BEFORE_DAYS)))
            out[key] = int(value) if value not in (None, "") else None
        elif key == "start_time":
            if value not in (None, "") and not TIME_RE.match(str(value)):
                raise ValueError("times must be HH:MM")
            out[key] = value or None
        elif key == "energy":
            if value not in ENERGIES and value not in (None, ""):
                raise ValueError("bad energy")
            out[key] = value or None
        elif key == "minutes":
            out[key] = int(value) if value not in (None, "") else None
        elif key == "project_id":
            out[key] = check_ref("projects", value)
        elif key == "position":
            out[key] = float(value)
        elif key == "spent":
            out[key] = max(0, min(10_000_000, int(value or 0)))
        elif key == "people":
            # Contacts (their ids); unchecked against the copy, which may be refreshing or gone.
            if not isinstance(value, list) or len(value) > 20 or not all(
                    isinstance(x, str) and PERSON_RE.fullmatch(x) for x in value):
                raise ValueError("people must be a list of contact ids")
            out[key] = json.dumps(list(dict.fromkeys(value)))
        elif key == "remind_at":
            # When to send a reminder, in UTC ("YYYY-MM-DD HH:MM:SS"), or none.
            if value in (None, ""):
                out[key] = None
            elif not STAMP_RE.match(str(value)):
                raise ValueError("remind_at must be a UTC date and time")
            else:
                out[key] = datetime.fromisoformat(str(value).replace(" ", "T")).strftime("%Y-%m-%d %H:%M:%S")
            out["reminded_at"] = None  # a new time means a new reminder
            out["remind_plan"] = out[key]
    if out.get("state") == "scheduled" and "start_date" in out and not out["start_date"]:
        raise ValueError("scheduled tasks need a start date")
    return out


def add_months(d, months):
    m = d.month - 1 + months
    y, m = d.year + m // 12, m % 12 + 1
    return d.replace(year=y, month=m, day=min(d.day, calendar.monthrange(y, m)[1]))


def shift(d, repeat, n):
    """The date n repeats after d."""
    if repeat == "daily":
        return d + timedelta(days=n)
    if every := EVERY_RE.fullmatch(repeat):
        k, unit = n * int(every[1]), every[2]
        return (d + timedelta(weeks=k) if unit == "w" else add_months(d, k) if unit == "m"
                else add_months(d, 12 * k) if unit == "y" else d + timedelta(days=k))
    if repeat == "weekly":
        return d + timedelta(weeks=n)
    if repeat == "monthly":
        return add_months(d, n)
    if repeat == "yearly":
        return add_months(d, 12 * n)
    if nth := NTH_RE.fullmatch(repeat):
        if n == 0:
            return d
        month = add_months(d.replace(day=1), n)
        return nth_weekday(month.year, month.month, int(nth[1]), int(nth[2]))
    if days := week_days(repeat):
        step = timedelta(days=1 if n >= 0 else -1)
        for _ in range(abs(n)):
            d += step
            while d.weekday() not in days:
                d += step
        return d
    for _ in range(n):  # weekdays
        d += timedelta(days=1)
        while d.weekday() >= 5:
            d += timedelta(days=1)
    return d


def occurrence_dates(s, n):
    """(start, due) of occurrence n of series s, as ISO strings or None.

    Without a base start date, an occurrence starts the day after the previous
    one was due, so e.g. a daily chore appears each morning.
    """
    k = n - s["base_index"]

    def at(base, steps):
        return shift(date.fromisoformat(base), s["repeat"], steps)

    due = at(s["base_due"], k).isoformat() if s["base_due"] else None
    if s["base_start"]:
        start = at(s["base_start"], k).isoformat()
    elif k > 0:
        start = (at(s["base_due"], k - 1) + timedelta(days=1)).isoformat()
    else:
        start = None
    return start, due


def utcnow():
    return time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime())


def base_dates(task, today):
    start = task["start_date"]
    if not start and not task["due_date"]:
        start = today
    return start, task["due_date"]


def start_series(task, repeat, on_miss, today):
    conn = db.get_db()
    cur = conn.execute(
        "INSERT INTO series (user_id, repeat, on_miss, base_start, base_due) VALUES (?, ?, ?, ?, ?)",
        (g.user["id"], repeat, on_miss, *base_dates(task, today)))
    conn.execute("UPDATE tasks SET series_id = ?, series_index = 0 WHERE id = ?",
                 (cur.lastrowid, task["id"]))


def rebase_series(task, repeat, today):
    """Restart a series' schedule from this occurrence's dates."""
    conn = db.get_db()
    s = conn.execute("SELECT * FROM series WHERE id = ?", (task["series_id"],)).fetchone()
    index = task["series_index"]
    if index != s["latest"]:
        # Upcoming copies made from the old schedule are superseded.
        conn.execute("DELETE FROM tasks WHERE series_id = ? AND series_index > ? "
                     "AND completed_at IS NULL AND deleted_at IS NULL AND start_date > ?",
                     (s["id"], index, today))
        index = s["latest"] + 1
        conn.execute("UPDATE tasks SET series_index = ? WHERE id = ?", (index, task["id"]))
    conn.execute("UPDATE series SET repeat = ?, base_start = ?, base_due = ?, base_index = ?, "
                 "latest = ? WHERE id = ?",
                 (repeat, *base_dates(task, today), index, index, s["id"]))


def end_series(series_id, today, keep_id=None):
    """Stop repeating: drop copies that haven't started yet and detach the rest."""
    conn = db.get_db()
    conn.execute("DELETE FROM tasks WHERE series_id = ? AND id IS NOT ? AND completed_at IS NULL "
                 "AND deleted_at IS NULL AND start_date > ?", (series_id, keep_id, today))
    conn.execute("UPDATE tasks SET series_id = NULL, series_index = NULL WHERE series_id = ?",
                 (series_id,))
    conn.execute("DELETE FROM series WHERE id = ?", (series_id,))


def carried_reminder(template, start, due):
    """A later copy's reminder: the template copy's (as set, not snoozed), at the same
    distance from its start (or due) date, in the user's local time. None if there's none."""
    if template["remind_before"] and due:
        return remind_before_due(due, template["remind_before"])
    plan = template["remind_plan"]
    anchor, new_anchor = template["start_date"] or template["due_date"], start or due
    if not plan or not anchor or not new_anchor:
        return None
    tz = ZoneInfo(user_tz(g.user))
    local = datetime.fromisoformat(plan.replace(" ", "T")).replace(tzinfo=ZoneInfo("UTC")).astimezone(tz)
    offset = local.replace(tzinfo=None) - datetime.fromisoformat(anchor)
    return utc_stamp((datetime.fromisoformat(new_anchor) + offset).replace(tzinfo=tz))


def remind_before_due(due, days):
    """The UTC stamp for a reminder days before the due date, at REMIND_BEFORE_TIME local time."""
    day = date.fromisoformat(due) - timedelta(days=days)
    at = datetime.fromisoformat(f"{day.isoformat()}T{REMIND_BEFORE_TIME}")
    return utc_stamp(at.replace(tzinfo=ZoneInfo(user_tz(g.user))))


def shift_stamp(stamp, days):
    """A UTC stamp moved by whole days, keeping its local time of day."""
    tz = ZoneInfo(user_tz(g.user))
    local = datetime.fromisoformat(stamp.replace(" ", "T")).replace(tzinfo=ZoneInfo("UTC")).astimezone(tz)
    return utc_stamp((local.replace(tzinfo=None) + timedelta(days=days)).replace(tzinfo=tz))


NO_TASK = {"remind_before": None, "due_date": None, "remind_plan": None, "remind_at": None}


def reminder_follows(task, fields):
    """The reminder's part of a change to a task (NO_TASK for a new one): one set as days
    before the due date is worked out from it, and one set at a time moves with the due date,
    by as many days."""
    if "remind_at" in fields and "remind_before" not in fields:
        fields["remind_before"] = None  # set at a time now
    before = fields.get("remind_before", task["remind_before"])
    old_due, due = task["due_date"], fields.get("due_date", task["due_date"])
    if before and ("remind_before" in fields or "due_date" in fields):
        if not due and "remind_before" in fields:
            raise ValueError("a reminder before the due date needs a due date")
        if due:
            at = remind_before_due(due, before)
            fields.update(remind_at=at, remind_plan=at, reminded_at=None)
        else:
            fields["remind_before"] = None  # the due date is gone: it stays at its time
    elif ("due_date" in fields and "remind_at" not in fields and task["remind_plan"]
          and old_due and due and due != old_due):
        days = (date.fromisoformat(due) - date.fromisoformat(old_due)).days
        fields["remind_plan"] = shift_stamp(task["remind_plan"], days)
        if task["remind_at"]:
            fields["remind_at"] = shift_stamp(task["remind_at"], days)
            if fields["remind_at"] > utcnow():
                fields["reminded_at"] = None  # (moved to the future: it comes again)


def copy_occurrence(s, template, index, start, due, today):
    """A series' next copy, made from its newest one (so edits carry forward), with fresh
    checklists; returns its id."""
    remind = carried_reminder(template, start, due)
    # (Its files too only if the series carries them; what it waited on, the first copy did.)
    return copy_task(template, {
        "notes": richtext.uncheck(template["notes"]), "state": "scheduled" if start and start > today else "next",
        "due_date": due, "start_date": start, "start_time": None, "series_id": s["id"], "series_index": index,
        "remind_at": remind, "remind_plan": remind}, deps=False, files=bool(s["carry_files"]))


def next_after_done(s, task, today):
    """For a series counted from completion: task (its newest copy) was just completed, so
    make the next copy, one repeat on from today, keeping the copy's gap from start to due."""
    conn = db.get_db()
    if task["series_index"] != s["latest"] or conn.execute(
            "SELECT 1 FROM tasks WHERE series_id = ? AND id != ? AND completed_at IS NULL "
            "AND deleted_at IS NULL", (s["id"], task["id"])).fetchone():
        return  # an older copy, or there's already one waiting
    start = shift(date.fromisoformat(today), s["repeat"], 1)
    due = None
    if task["due_date"]:
        gap = (date.fromisoformat(task["due_date"]) - date.fromisoformat(task["start_date"])).days \
            if task["start_date"] else 0
        due = (start + timedelta(days=gap)).isoformat()
    copy_occurrence(s, task, s["latest"] + 1, start.isoformat(), due, today)
    conn.execute("UPDATE series SET latest = latest + 1 WHERE id = ?", (s["id"],))


def set_repeat_from(task_id, done, today):
    """Count a task's series from completion (done) or from the calendar."""
    conn = db.get_db()
    task = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
    s = task["series_id"] and conn.execute("SELECT * FROM series WHERE id = ?", (task["series_id"],)).fetchone()
    if not s or bool(s["from_done"]) == done:
        return
    if done:
        # Copies already made ahead on the calendar's schedule aren't wanted now.
        conn.execute("DELETE FROM tasks WHERE series_id = ? AND id != ? AND completed_at IS NULL "
                     "AND deleted_at IS NULL AND start_date > ?", (s["id"], task_id, today))
        conn.execute("UPDATE series SET from_done = 1, latest = (SELECT MAX(series_index) FROM tasks "
                     "WHERE series_id = ?) WHERE id = ?", (s["id"], s["id"]))
    else:
        conn.execute("UPDATE series SET from_done = 0 WHERE id = ?", (s["id"],))
        rebase_series(conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone(), s["repeat"], today)


def run_series(uid, today):
    """Create each series' occurrences on schedule, and close out replaced ones.

    As soon as an occurrence's start date arrives, the following one is created
    (in Scheduled), whether or not anything was completed.
    """
    conn = db.get_db()
    # Series counted from completion get their copies in apply_task_update instead.
    for s in conn.execute("SELECT * FROM series WHERE user_id = ? AND from_done = 0", (uid,)).fetchall():
        latest = s["latest"]
        for _ in range(MAX_CATCH_UP):
            start, _due = occurrence_dates(s, latest)
            if start and start > today:
                break
            # New copies take their details from the newest one, so edits carry forward.
            template = conn.execute(
                "SELECT * FROM tasks WHERE series_id = ? AND deleted_at IS NULL "
                "ORDER BY series_index DESC LIMIT 1", (s["id"],)).fetchone()
            if template is None:
                # Every copy has been trashed or deleted: the series is over.
                end_series(s["id"], today)
                break
            latest += 1
            start, due = occurrence_dates(s, latest)
            copy_occurrence(s, template, latest, start, due, today)
        conn.execute("UPDATE series SET latest = ? WHERE id = ?", (latest, s["id"]))
        if s["on_miss"] == "replace":
            begun = conn.execute(
                "SELECT id FROM tasks WHERE series_id = ? AND completed_at IS NULL "
                "AND deleted_at IS NULL AND (start_date IS NULL OR start_date <= ?) "
                "ORDER BY series_index", (s["id"], today)).fetchall()
            for r in begun[:-1]:
                conn.execute("UPDATE tasks SET completed_at = ?, missed = 1 WHERE id = ?",
                             (utcnow(), r["id"]))


def repeat_args(data):
    repeat = data.get("repeat") or None
    on_miss = data.get("on_miss") or None
    if not valid_repeat(repeat):
        raise ValueError("bad repeat")
    if on_miss not in ON_MISS | {None}:
        raise ValueError("bad on_miss")
    return repeat, on_miss


# --- data API -------------------------------------------------------------

def catch_up(uid, today, now):
    """Bring the user's lists up to date (today, now: their local date and HH:MM): make due
    repeat copies and recurring projects, and move scheduled tasks that have started to the Queue."""
    conn = db.get_db()
    # Locked so two tabs loading at once can't both create the same occurrence.
    conn.execute("BEGIN IMMEDIATE")
    run_series(uid, today)
    run_templates(uid, today)
    # Scheduled items whose start date has arrived join the Queue (state "next").
    conn.execute("UPDATE tasks SET state = 'next' WHERE user_id = ? AND state = 'scheduled' "
                 "AND completed_at IS NULL AND (start_date < ? OR (start_date = ? AND "
                 "(start_time IS NULL OR start_time <= ?)))", (uid, today, today, now))
    conn.commit()


@app.get("/api/data")
@login_required
def all_data():
    uid = g.user["id"]
    today, now = client_now()
    conn = db.get_db()
    catch_up(uid, today, now)
    tasks = conn.execute(
        "SELECT * FROM tasks WHERE user_id = ? AND completed_at IS NULL AND deleted_at IS NULL "
        "ORDER BY position, id", (uid,)).fetchall()
    projects = conn.execute(
        "SELECT * FROM projects WHERE user_id = ? AND deleted_at IS NULL "
        "AND (state != 'done' OR completed_at > datetime('now', '-30 days')) "
        "ORDER BY position, id", (uid,)).fetchall()
    areas = conn.execute("SELECT id, name, position, icon_version FROM areas WHERE user_id = ? "
                         "ORDER BY position, id", (uid,)).fetchall()
    tags = conn.execute("SELECT id, name FROM tags WHERE user_id = ? ORDER BY name",
                        (uid,)).fetchall()
    acct = google_account(uid)
    return jsonify(
        google=google_status(uid) | {"available": gcal.configured()},
        events=json.loads(acct["events_json"]) if acct else [],
        contacts=contacts_json(uid),
        user={"id": uid, "username": g.user["username"],
              "push_devices": conn.execute("SELECT COUNT(*) FROM push_subscriptions WHERE user_id = ?",
                                           (uid,)).fetchone()[0],
              "display_name": g.user["display_name"], "is_admin": bool(g.user["is_admin"]),
              "settings": user_settings(g.user)},
        tasks=tasks_json(tasks),
        projects=projects_json(projects),
        areas=[dict(a) for a in areas],
        tags=[dict(t) for t in tags],
        templates=[template_dict(r) for r in conn.execute(
            "SELECT * FROM templates WHERE user_id = ? ORDER BY name COLLATE NOCASE", (uid,))],
        links=[link_dict(r) for r in conn.execute(
            "SELECT * FROM links WHERE user_id = ? ORDER BY position, id", (uid,))],
        notes=notes_json(conn.execute("SELECT * FROM notes WHERE user_id = ? AND deleted_at IS NULL ORDER BY id",
                                      (uid,)).fetchall()),
        note_categories=[dict(r) for r in conn.execute(
            "SELECT id, name, color, position FROM note_categories WHERE user_id = ? ORDER BY position, id", (uid,))],
        journals=[dict(r) for r in conn.execute(
            "SELECT id, name, position, created_at FROM journals WHERE user_id = ? ORDER BY position, id", (uid,))],
    )


@app.post("/api/tasks")
@login_required
def create_task():
    try:
        task_id = insert_task(body(), client_today())
    except (ValueError, TypeError) as e:
        db.get_db().rollback()
        return bad(str(e))
    return jsonify(tasks_json([owned("tasks", task_id)])[0]), 201


def insert_task(data, today):
    """Create a task for g.user from API-style data; returns its id."""
    data.setdefault("state", "inbox")
    fields = task_fields(data)
    reminder_follows(NO_TASK, fields)
    repeat, on_miss = repeat_args(data)
    if "title" not in fields:
        raise ValueError("title is required")
    fields.setdefault("position", next_position("tasks"))
    fields["user_id"] = g.user["id"]
    conn = db.get_db()
    task_id = db.insert(conn, "tasks", fields)
    if isinstance(data.get("tags"), list):
        set_tags(task_id, data["tags"])
    set_blockers("task", task_id, given_ids(data, "blocked_by"))
    set_related("task", task_id, given_ids(data, "related"))
    if repeat:
        start_series(owned("tasks", task_id), repeat,
                     on_miss or db.default_on_miss(repeat), today)
        if data.get("repeat_from") == "done":
            set_repeat_from(task_id, True, today)
    conn.commit()
    return task_id


@app.patch("/api/tasks/<int:task_id>")
@login_required
def update_task(task_id):
    task = owned("tasks", task_id)
    try:
        apply_task_update(task, body(), client_today())
    except (ValueError, TypeError) as e:
        db.get_db().rollback()
        return bad(str(e))
    return jsonify(tasks_json([owned("tasks", task_id)])[0])


@app.post("/api/tasks/<int:task_id>/duplicate")
@login_required
def duplicate_task(task_id):
    """A copy of a task, just after it: same details, tags, blockers, related tasks and files
    (stored once), but no reminder or time spent. A repeating task's copy repeats the same way,
    as a schedule of its own."""
    t = owned("tasks", task_id)
    if t["deleted_at"]:
        return bad("Restore it from the trash first.")
    conn = db.get_db()
    nxt = conn.execute("SELECT MIN(position) FROM tasks WHERE user_id = ? AND position > ?",
                       (g.user["id"], t["position"])).fetchone()[0]
    new = copy_task(t, {
        "position": (t["position"] + nxt) / 2 if nxt is not None else t["position"] + 1, "remind_before": None,
        # a copy of a done task starts again, open
        "state": "next" if t["completed_at"] and t["state"] == "scheduled" else t["state"]})
    s = t["series_id"] and conn.execute("SELECT * FROM series WHERE id = ?", (t["series_id"],)).fetchone()
    if s and not t["completed_at"]:
        start_series(owned("tasks", new), s["repeat"], s["on_miss"], client_today())
        conn.execute("UPDATE series SET from_done = ?, carry_files = ? WHERE id = "
                     "(SELECT series_id FROM tasks WHERE id = ?)", (s["from_done"], s["carry_files"], new))
    conn.commit()
    return jsonify(tasks_json([owned("tasks", new)])[0]), 201


@app.post("/api/documents/<int:doc_id>/convert")
@login_required
def convert_document(doc_id):
    """Make a task, project or note into another kind: {"to": "task" | "project" | "note"}.
    It stays the same document, so it keeps its id, title, text, area, tags, files and links
    (and, between tasks and projects, what it's blocked by and what waits on it); what only
    the old kind had goes. The reply is it, as the new kind."""
    data = body()
    to, kind = data.get("to"), kind_of(doc_id)
    if not kind or not db.get_db().execute("SELECT 1 FROM documents WHERE id = ? AND user_id = ?",
                                           (doc_id, g.user["id"])).fetchone():
        abort(404)
    if to not in db.KINDS or to == kind:
        return bad("Convert it to a task, a project or a note.")
    try:
        if kind == "task" and to == "project":
            task_to_project(owned("tasks", doc_id), bool(data.get("checklist")))
        elif kind == "task":
            t = owned("tasks", doc_id)
            check_task_can_change(t, "a note")
            note_from_task(t)
        else:
            from_kind = owned(db.KINDS[kind]["view"], doc_id)
            if from_kind["deleted_at"]:
                raise ValueError("Restore it from the trash first.")
            if kind == "project":
                if project_contents(doc_id):
                    raise ValueError("Only an empty project can be changed: move its tasks and subprojects out first.")
                if from_kind["state"] == "done":
                    raise ValueError("Reopen the project first.")
                held = from_kind["state"] if from_kind["state"] in ("someday", "later") else None
                fields = {"area_id": from_kind["area_id"], "focus": from_kind["focus"], "due_date": from_kind["due_date"],
                          "priority": from_kind["priority"]}
                if to == "task":
                    become(from_kind, "task", fields | {"state": held or "next", "project_id": from_kind["parent_id"],
                                                        "position": from_kind["step"] if from_kind["parent_id"] and
                                                        from_kind["step"] is not None else next_position("tasks")})
                else:
                    become(from_kind, "note", {"area_id": from_kind["area_id"], "updated_at": utcnow()})
            else:  # a note
                title = from_kind["title"] or richtext.plain(from_kind["body"]).split("\n")[0][:500] or "Untitled"
                if to == "task":
                    become(from_kind, "task", {"title": title, "notes": from_kind["body"], "state": "inbox",
                                               "position": next_position("tasks")})
                else:
                    become(from_kind, "project", {"name": title, "notes": from_kind["body"],
                                                  "position": next_position("projects")})
    except ValueError as e:
        db.get_db().rollback()
        return bad(str(e))
    db.get_db().commit()
    return jsonify(document_json(doc_id)), 201


def check_task_can_change(t, into):
    if t["deleted_at"] or t["completed_at"]:
        raise ValueError(f"Only an open task can become {into}.")
    if t["series_id"]:
        raise ValueError(f"A repeating task can't become {into}. Stop it repeating first.")


@app.post("/api/tasks/<int:task_id>/convert")
@login_required
def convert_task(task_id):
    """Make a task into a project (what older apps call; /api/documents/<id>/convert does it
    now): {"checklist": true} makes its checklist the project's tasks."""
    try:
        task_to_project(owned("tasks", task_id), bool(body().get("checklist")))
    except ValueError as e:
        db.get_db().rollback()
        return bad(str(e))
    db.get_db().commit()
    return jsonify(project_dict(owned("projects", task_id))), 201


def task_to_project(t, checklist):
    """A task as a project (not committed): with checklist, its text's checklist items become
    the project's tasks (ticked ones done). The project takes its name, notes, area, due date,
    Focus, priority, and Someday or Later; in a project, it's a subproject of that one."""
    check_task_can_change(t, "a project")
    conn = db.get_db()
    notes, items = t["notes"], []
    if checklist:
        items, notes = richtext.take_checklists(t["notes"])
        items = [(words[:500], done) for words, done in items]
    parent = t["project_id"] and owned("projects", t["project_id"])
    state = t["state"] if t["state"] in ("someday", "later") else "active"
    become(t, "project", {"notes": notes, "area_id": parent["area_id"] if parent else t["area_id"],
                          "state": state, "focus": t["focus"], "due_date": t["due_date"], "parent_id": t["project_id"],
                          "step": t["position"] if t["project_id"] else None,
                          "priority": t["priority"], "position": next_position("projects")})
    first = next_position("tasks")
    for i, (title, done) in enumerate(items):
        db.insert(conn, "tasks", {"user_id": g.user["id"], "project_id": t["id"], "title": title, "state": "next",
                                  "position": first + i, "completed_at": utcnow() if done else None})


def become(row, kind, fields):
    """Make a task, project or note (row, from its view) into another kind (not committed):
    the same document, with kind's own row in place of the old one. fields: the new kind's
    view columns (the document's, like notes or title, may be among them)."""
    conn = db.get_db()
    old = kind_of(row["id"])
    if old == "task" and row["gcal_event_id"]:  # its calendar event goes, as for a deleted task
        conn.execute("INSERT INTO gcal_deletions (user_id, event_id) VALUES (?, ?)", (row["user_id"], row["gcal_event_id"]))
    if "note" in (old, kind):  # (only tasks and projects wait, or are waited on)
        conn.execute("DELETE FROM document_deps WHERE document_id = ? OR blocker_id = ?", (row["id"], row["id"]))
    conn.execute(f"DELETE FROM {db.KINDS[old]['table']} WHERE id = ?", (row["id"],))
    k = db.KINDS[kind]
    own = {"id": row["id"]} | {c: v for c, v in fields.items() if c in dict(k["columns"])}
    conn.execute(f"INSERT INTO {k['table']} ({', '.join(own)}) VALUES ({', '.join('?' * len(own))})", tuple(own.values()))
    shared = {k["document"][c]: v for c, v in fields.items() if c in k["document"]}
    conn.execute(f"UPDATE documents SET kind = ?{''.join(f', {c} = ?' for c in shared)} WHERE id = ?",
                 (kind, *shared.values(), row["id"]))


@app.post("/api/tasks/bulk")
@login_required
def update_tasks():
    """Change several tasks at once: {"tasks": [{"id": 1, ...changes}, ...]}."""
    items = body().get("tasks")
    if not isinstance(items, list) or not items or len(items) > 1000:
        return bad("Send a list of task changes.")
    if not all(isinstance(x, dict) and isinstance(x.get("id"), int) for x in items):
        return bad("Each change needs a task id.")
    tasks = [owned("tasks", x["id"]) for x in items]
    today = client_today()
    for task, data in zip(tasks, items):
        try:
            apply_task_update(task, {k: v for k, v in data.items() if k != "id"}, today)
        except (ValueError, TypeError) as e:
            db.get_db().rollback()
            return bad(str(e))
    return jsonify(tasks_json([owned("tasks", x["id"]) for x in items]))


def apply_task_update(task, data, today):
    """Apply API-style changes to one of g.user's tasks (from the app or from Google)."""
    task_id = task["id"]
    was_done = task["completed_at"]
    fields = task_fields(data)
    reminder_follows(task, fields)
    repeat, on_miss = repeat_args(data)
    conn = db.get_db()
    if "completed" in data:
        if data["completed"] and not task["completed_at"]:
            fields["completed_at"] = utcnow()
        elif not data["completed"]:
            fields["completed_at"] = None
            if task["missed"]:
                # Reopening a replaced copy makes it a one-off; the series has moved on.
                fields.update(missed=0, series_id=None, series_index=None)
    if fields:
        sets = ", ".join(f"{k} = ?" for k in fields)
        conn.execute(f"UPDATE tasks SET {sets}, updated_at = datetime('now') WHERE id = ?",
                     (*fields.values(), task_id))
    if "deleted_at" in fields:
        trashed(task_id, fields["deleted_at"], task["deleted_at"])
    if isinstance(data.get("tags"), list):
        set_tags(task_id, data["tags"])

    task = owned("tasks", task_id)
    series = task["series_id"] and conn.execute(
        "SELECT * FROM series WHERE id = ?", (task["series_id"],)).fetchone()
    if "repeat" in data:
        if repeat and not series:
            start_series(task, repeat, on_miss or db.default_on_miss(repeat), today)
        elif series and not repeat:
            end_series(series["id"], today, keep_id=task_id)
        elif series and repeat != series["repeat"]:
            rebase_series(task, repeat, today)
    elif (series and ("start_date" in fields or "due_date" in fields)
          and task["series_index"] == series["latest"] and not data.get("defer")):
        # Editing the newest copy's dates changes the schedule from here on;
        # editing an older copy, or deferring any copy, only moves that one.
        rebase_series(task, series["repeat"], today)
    if on_miss:
        conn.execute("UPDATE series SET on_miss = ? WHERE id = "
                     "(SELECT series_id FROM tasks WHERE id = ?)", (on_miss, task_id))
    set_blockers("task", task_id, given_ids(data, "blocked_by"))
    set_related("task", task_id, given_ids(data, "related"))
    if "project_id" in fields:
        check_no_loops(task_id)
    if data.get("repeat_from") in ("done", "calendar"):
        set_repeat_from(task_id, data["repeat_from"] == "done", today)
    task = owned("tasks", task_id)
    s = task["series_id"] and conn.execute("SELECT * FROM series WHERE id = ?", (task["series_id"],)).fetchone()
    if s and s["from_done"] and "completed" in data:
        if data["completed"] and not was_done:
            next_after_done(s, task, today)
        elif not data["completed"] and was_done:
            # Undone: take back the copy its completion made, if it hasn't been touched.
            conn.execute("DELETE FROM tasks WHERE series_id = ? AND series_index = ? AND completed_at IS NULL "
                         "AND deleted_at IS NULL AND updated_at = created_at", (s["id"], task["series_index"] + 1))
            conn.execute("UPDATE series SET latest = (SELECT MAX(series_index) FROM tasks WHERE series_id = ?) "
                         "WHERE id = ?", (s["id"], s["id"]))
    if ("remind_at" in data or "remind_before" in data) and task["series_id"]:
        # Later copies already made take the new reminder too (or lose it, if cleared).
        for later in conn.execute("SELECT * FROM tasks WHERE series_id = ? AND series_index > ? AND "
                                  "completed_at IS NULL AND deleted_at IS NULL",
                                  (task["series_id"], task["series_index"])).fetchall():
            remind = carried_reminder(task, later["start_date"], later["due_date"])
            conn.execute("UPDATE tasks SET remind_at = ?, remind_plan = ?, reminded_at = NULL, remind_before = ? "
                         "WHERE id = ?", (remind, remind, task["remind_before"], later["id"]))
    if "carry_files" in data:
        conn.execute("UPDATE series SET carry_files = ? WHERE id = "
                     "(SELECT series_id FROM tasks WHERE id = ?)", (1 if data["carry_files"] else 0, task_id))
    conn.commit()


# --- project templates (and recurring projects) -------------------------------
#
# A template is a project's outline as JSON:
#   {"project": {"name", "notes", "area_id", "sequential", "due"},
#    "tasks": [{"title", "notes", "state", "focus", "priority", "tags", "minutes", "energy",
#               "start", "start_time", "due", "after"}]}
# "start" and "due" are days from the project's date (negative: before it), or null; "after"
# lists the tasks (by position in the list) it's blocked by. A template with a repeat makes
# a new project on schedule (run_templates).

OFFSET_MAX = 3650
TEMPLATE_STATES = TASK_STATES - {"scheduled"}  # scheduling comes from the dates


def clean_offset(v):
    if v in (None, ""):
        return None
    v = int(v)
    if not -OFFSET_MAX <= v <= OFFSET_MAX:
        raise ValueError("days must be within 10 years")
    return v


def clean_template(data):
    """Validate a template's JSON (raises ValueError)."""
    if not isinstance(data, dict):
        raise ValueError("bad template")
    p = data.get("project") or {}
    tasks = data.get("tasks") or []
    if not isinstance(tasks, list) or len(tasks) > 300:
        raise ValueError("a template can have up to 300 tasks")
    area = p.get("area_id")
    out = {"project": {"name": str(p.get("name") or "").strip()[:500] or "Project",
                       "notes": richtext.clean(p.get("notes")),
                       "area_id": int(area) if area not in (None, "") else None,
                       "sequential": bool(p.get("sequential")),
                       "due": clean_offset(p.get("due"))},
           "tasks": []}
    for t in tasks:
        title = str(t.get("title") or "").strip()[:500]
        if not title:
            continue
        state = t.get("state") if t.get("state") in TEMPLATE_STATES else "next"
        after = [int(i) for i in (t.get("after") or []) if str(i).isdigit()]
        out["tasks"].append({
            "title": title, "notes": richtext.clean(t.get("notes")), "state": state,
            "focus": bool(t.get("focus")), "priority": max(-PRIORITY_MAX, min(PRIORITY_MAX, int(t.get("priority") or 0))),
            "tags": [str(x)[:100] for x in (t.get("tags") or []) if str(x).strip()][:30],
            "minutes": int(t["minutes"]) if t.get("minutes") not in (None, "") else None,
            "energy": t.get("energy") if t.get("energy") in ENERGIES else None,
            "start": clean_offset(t.get("start")),
            "start_time": t.get("start_time") if t.get("start_time") and TIME_RE.match(str(t["start_time"])) else None,
            "due": clean_offset(t.get("due")),
            "after": after})
    n = len(out["tasks"])
    for i, t in enumerate(out["tasks"]):
        t["after"] = sorted({a for a in t["after"] if 0 <= a < n and a != i})
    # No loops among the tasks' "after"s.
    state = {}
    def visit(i):
        if state.get(i) == 1:
            raise ValueError("the template's tasks wait on each other in a loop")
        if state.get(i) != 2:
            state[i] = 1
            for a in out["tasks"][i]["after"]:
                visit(a)
            state[i] = 2
    for i in range(n):
        visit(i)
    return out


def template_from_project(project_id):
    """A template's JSON from a project and its tasks (not the trashed ones), with dates
    counted from the project's due date, or else its earliest task date."""
    conn = db.get_db()
    p = owned("projects", project_id)
    rows = conn.execute("SELECT * FROM tasks WHERE project_id = ? AND deleted_at IS NULL "
                        "ORDER BY position, id", (project_id,)).fetchall()
    tasks = tasks_json(rows)
    dates = [d for t in tasks for d in (t["start_date"], t["due_date"]) if d]
    anchor = p["due_date"] or (min(dates) if dates else None)
    days = lambda d: (date.fromisoformat(d) - date.fromisoformat(anchor)).days if d and anchor else None  # noqa: E731
    index = {t["id"]: i for i, t in enumerate(tasks)}
    return clean_template({
        "project": {"name": p["name"], "notes": p["notes"], "area_id": p["area_id"],
                    "sequential": p["sequential"], "due": days(p["due_date"])},
        "tasks": [{"title": t["title"], "notes": richtext.uncheck(t["notes"]),
                   "state": "next" if t["state"] in ("inbox", "scheduled") else t["state"],
                   "focus": t["focus"], "priority": t["priority"], "tags": t["tags"],
                   "minutes": t["minutes"], "energy": t["energy"],
                   "start": days(t["start_date"]), "start_time": t["start_time"],
                   "due": days(t["due_date"]),
                   "after": [index[b] for b in t["blocked_by"] if b in index]} for t in tasks]})


def template_dict(row):
    d = {k: row[k] for k in ("id", "name", "repeat", "next_date", "lead_days")}
    d["data"] = json.loads(row["data"])
    return d


def make_project(tpl, anchor, name, today):
    """A new project (with its tasks) from a template row; anchor is the date the template's
    days count from (None: leave dates out). Returns the project's id."""
    data = json.loads(tpl["data"])
    conn = db.get_db()
    p = data["project"]
    on = lambda off: (date.fromisoformat(anchor) + timedelta(days=off)).isoformat() \
        if anchor and off is not None else None  # noqa: E731
    area = p["area_id"] if p["area_id"] and conn.execute(
        "SELECT 1 FROM areas WHERE id = ? AND user_id = ?", (p["area_id"], g.user["id"])).fetchone() else None
    project_id = db.insert(conn, "projects", {
        "user_id": g.user["id"], "name": name[:500], "notes": p["notes"], "area_id": area,
        "sequential": int(p["sequential"]), "due_date": on(p["due"]), "template_id": tpl["id"],
        "position": next_position("projects")})
    ids = []
    for t in data["tasks"]:
        start = on(t["start"])
        task = {"title": t["title"], "notes": t["notes"], "focus": t["focus"],
                "priority": t["priority"], "tags": t["tags"], "minutes": t["minutes"],
                "energy": t["energy"], "due_date": on(t["due"]), "project_id": project_id,
                # A task that can't start yet waits in Scheduled until its day.
                "state": "scheduled" if start and start > today else t["state"]}
        if task["state"] == "scheduled":
            task.update(start_date=start, start_time=t["start_time"])
        ids.append(insert_task(task, today))
    for t, task_id in zip(data["tasks"], ids):
        if t["after"]:
            set_blockers("task", task_id, [ids[i] for i in t["after"]])
    return project_id


def instance_name(name, anchor):
    d = date.fromisoformat(anchor)
    return f"{name} ({d.strftime('%b')} {d.day}{'' if d.year == date.today().year else f', {d.year}'})"


def run_templates(uid, today):
    """Make each recurring template's project when it's due (lead_days before its date). After
    a long gap only the latest is made, not every one that was missed."""
    conn = db.get_db()
    for tpl in conn.execute("SELECT * FROM templates WHERE user_id = ? AND repeat IS NOT NULL "
                            "AND next_date IS NOT NULL", (uid,)).fetchall():
        base = date.fromisoformat(tpl["next_date"])
        lead = timedelta(days=tpl["lead_days"])
        n = 0
        while n < MAX_CATCH_UP and shift(base, tpl["repeat"], n) - lead <= date.fromisoformat(today):
            n += 1
        if not n:
            continue
        anchor = shift(base, tpl["repeat"], n - 1).isoformat()
        make_project(tpl, anchor, instance_name(json.loads(tpl["data"])["project"]["name"], anchor), today)
        conn.execute("UPDATE templates SET next_date = ? WHERE id = ?",
                     (shift(base, tpl["repeat"], n).isoformat(), tpl["id"]))


def template_settings(data, fields):
    """Repeat settings from API data into fields (raises ValueError)."""
    if "name" in data:
        fields["name"] = str(data["name"]).strip()[:200] or "Template"
    if "repeat" in data:
        repeat = data["repeat"] or None
        if not valid_repeat(repeat):
            raise ValueError("bad repeat")
        fields["repeat"] = repeat
    if "next_date" in data:
        fields["next_date"] = clean_date(data["next_date"])
    if "lead_days" in data:
        lead = int(data["lead_days"] or 0)
        if not 0 <= lead <= 365:
            raise ValueError("make it between 0 and 365 days ahead")
        fields["lead_days"] = lead
    if fields.get("repeat") and not fields.get("next_date", True):
        raise ValueError("a repeating template needs the next date")


@app.post("/api/templates")
@login_required
def create_template():
    """From a project ({"project_id"}), or from JSON ({"name", "data"})."""
    data = body()
    try:
        tpl = template_from_project(int(data["project_id"])) if data.get("project_id") \
            else clean_template(data.get("data"))
        fields = {"name": data.get("name") or tpl["project"]["name"]}
        template_settings(data | {"name": fields["name"]}, fields)
    except (ValueError, TypeError, KeyError) as e:
        return bad(str(e))
    conn = db.get_db()
    cur = conn.execute("INSERT INTO templates (user_id, name, data, repeat, next_date, lead_days) "
                       "VALUES (?, ?, ?, ?, ?, ?)", (g.user["id"], fields["name"], json.dumps(tpl),
                                                     fields.get("repeat"), fields.get("next_date"),
                                                     fields.get("lead_days", 7)))
    if data.get("project_id"):
        conn.execute("UPDATE projects SET template_id = ? WHERE id = ?", (cur.lastrowid, int(data["project_id"])))
    conn.commit()
    return jsonify(template_dict(owned("templates", cur.lastrowid))), 201


@app.patch("/api/templates/<int:template_id>")
@login_required
def update_template(template_id):
    """Rename, change the tasks ({"data"}), take them again from a project ({"project_id"}),
    or set the repeat."""
    row = owned("templates", template_id)
    data = body()
    fields = {}
    try:
        if data.get("project_id"):
            fields["data"] = json.dumps(template_from_project(int(data["project_id"])))
        elif "data" in data:
            fields["data"] = json.dumps(clean_template(data["data"]))
        template_settings(data, fields)
        if (fields.get("repeat", row["repeat"]) and not fields.get("next_date", row["next_date"])):
            raise ValueError("a repeating template needs the next date")
    except (ValueError, TypeError) as e:
        return bad(str(e))
    if fields:
        conn = db.get_db()
        conn.execute(f"UPDATE templates SET {', '.join(f'{k} = ?' for k in fields)} WHERE id = ?",
                     (*fields.values(), template_id))
        conn.commit()
    return jsonify(template_dict(owned("templates", template_id)))


@app.delete("/api/templates/<int:template_id>")
@login_required
def delete_template(template_id):
    owned("templates", template_id)
    conn = db.get_db()
    conn.execute("DELETE FROM templates WHERE id = ?", (template_id,))
    conn.commit()
    return "", 204


@app.post("/api/templates/<int:template_id>/use")
@login_required
def use_template(template_id):
    """A new project from the template: {"name", "date"} (the date its days count from)."""
    tpl = owned("templates", template_id)
    data = body()
    try:
        anchor = clean_date(data.get("date"))
        name = str(data.get("name") or "").strip() or json.loads(tpl["data"])["project"]["name"]
        project_id = make_project(tpl, anchor, name, client_today())
    except (ValueError, TypeError) as e:
        return bad(str(e))
    db.get_db().commit()
    return jsonify(project_dict(owned("projects", project_id))), 201


# --- attachments ------------------------------------------------------------

ATTACHMENT_MAX = 25 * 1024 * 1024
USER_FILES_MAX = 1024 * 1024 * 1024
# Shown in the browser; anything else is downloaded, so a file can't run as part of the site.
IMAGE_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp"}
INLINE_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf",
                "text/plain"}


def storage_used(uid):
    """Bytes of attachments a user has, counting a file shared by several tasks once."""
    return db.get_db().execute(
        "SELECT COALESCE(SUM(size), 0) FROM blobs WHERE id IN "
        "(SELECT blob_id FROM attachments WHERE user_id = ?)", (uid,)).fetchone()[0]


def attachment_data(file_id):
    return db.get_db().execute("SELECT b.data FROM attachments a JOIN blobs b ON b.id = a.blob_id "
                               "WHERE a.id = ?", (file_id,)).fetchone()[0]


@app.get("/api/storage")
@login_required
def storage():
    """How much of the attachment allowance is used, and the biggest files."""
    largest = db.get_db().execute(
        "SELECT a.id, a.name, a.size, CASE d.kind WHEN 'task' THEN d.id END AS task_id, "
        "CASE d.kind WHEN 'project' THEN d.id END AS project_id, CASE d.kind WHEN 'note' THEN d.id END AS note_id, "
        "COALESCE(NULLIF(d.title, ''), 'Untitled note') AS title, "
        "COALESCE(t.completed_at, p.completed_at) AS completed_at, d.deleted_at "
        "FROM attachments a JOIN documents d ON d.id = a.document_id LEFT JOIN task_data t ON t.id = d.id "
        "LEFT JOIN project_data p ON p.id = d.id "
        "WHERE a.user_id = ? "
        "GROUP BY a.blob_id ORDER BY a.size DESC, a.id LIMIT 8", (g.user["id"],)).fetchall()
    return jsonify(used=storage_used(g.user["id"]), limit=USER_FILES_MAX,
                   largest=[dict(r) for r in largest])


@app.post("/api/tasks/<int:task_id>/attachments")
@login_required
def add_attachments(task_id):
    owned("tasks", task_id)
    return attach(task_id, "task")


@app.post("/api/projects/<int:project_id>/attachments")
@login_required
def add_project_attachments(project_id):
    """Files on a project, which go with all of its tasks."""
    owned("projects", project_id)
    return attach(project_id, "project")


@app.post("/api/notes/<int:note_id>/attachments")
@login_required
def add_note_attachments(note_id):
    owned("notes", note_id)
    return attach(note_id, "note")


def attach(doc_id, kind):
    """The uploaded files on a task, project or note. The reply is it, with "added": the new
    files' ids (pictures to place in its text)."""
    files = request.files.getlist("file")
    if not files:
        return bad("Choose a file.")
    conn = db.get_db()
    before = conn.execute("SELECT COALESCE(MAX(id), 0) FROM attachments").fetchone()[0]
    try:
        save_files(doc_id, files, kind)
    except ValueError as e:
        conn.rollback()
        return bad(str(e))
    added = [r[0] for r in conn.execute("SELECT id FROM attachments WHERE document_id = ? AND id > ? ORDER BY id",
                                        (doc_id, before))]
    conn.commit()
    return jsonify(document_json(doc_id) | {"added": added}), 201


def save_files(item_id, files, kind="task"):
    """Attach uploaded files to one of g.user's tasks, projects or notes (kind; not
    committed). ValueError if one is too big, or they'd take the user over their allowance."""
    conn = db.get_db()
    used = storage_used(g.user["id"])
    for f in files:
        data = f.read(ATTACHMENT_MAX + 1)
        name = re.sub(r"[\x00-\x1f/\\]+", "_", os.path.basename(f.filename or "")).strip() or "file"
        if len(data) > ATTACHMENT_MAX:
            raise ValueError(f"{name} is over 25 MB.")
        used += len(data)
        if used > USER_FILES_MAX:
            raise ValueError("That would take your attachments over 1 GB. Delete some first.")
        mime = (mimetypes.guess_type(name)[0] or f.mimetype or "application/octet-stream")[:100]
        conn.execute("INSERT INTO attachments (user_id, document_id, name, mime, size, blob_id) "
                     "VALUES (?, ?, ?, ?, ?, ?)",
                     (g.user["id"], item_id, name[:200], mime, len(data), db.put_blob(conn, data)))
    if kind in ("task", "note"):
        conn.execute("UPDATE documents SET updated_at = datetime('now') WHERE id = ?", (item_id,))


@app.route("/share", methods=["GET", "POST"])
def share():
    """The phone's Share menu (the web manifest's share_target): what's shared becomes an
    Inbox task, with any files attached. Every attempt is noted in SITE_PATH/debug."""
    info = request_info()
    try:
        form = request.form if request.method == "POST" else request.args
        files = request.files.getlist("files")
    except RequestEntityTooLarge:
        app_log("share", **info, result="Too large: over 25 MB in all")
        raise
    info["fields"] = {k: v[:300] for k, v in form.items()}
    info["files"] = [{"field": k, "name": f.filename, "type": f.mimetype, "size": file_size(f)}
                     for k, f in request.files.items(multi=True)]
    if g.user is None:
        app_log("share", **info, result="Not signed in: sent to the login page, so the share was lost")
        return redirect(url_for("login"))
    # Some apps share a file without a name: name it after its type.
    for i, f in enumerate(files):
        if not f.filename and file_size(f):
            f.filename = f"shared-{i + 1}{mimetypes.guess_extension(f.mimetype or '') or ''}"
    files = [f for f in files if f.filename]
    title, text, link = (str(form.get(k, "")).strip() for k in ("title", "text", "url"))
    # Apps put a shared link in "url" or somewhere in "text"; keep each piece once.
    if not link and (found := re.search(r"https?://\S+", text)):
        link = found[0]
    if link:
        text = text.replace(link, "").strip()
    first = (text.split("\n")[0] if text else "").strip()
    name = title or first or (urllib.parse.urlsplit(link).netloc.removeprefix("www.") if link else "") \
        or (files[0].filename if files else "") or "Shared"
    notes = "\n\n".join(x for x in (text if text != name else "", link) if x)
    where = user_settings(g.user)["share_to"]
    try:
        if where in ("inbox", "ask"):
            task_id = insert_task({"title": name[:500], "notes": richtext.from_text(notes), "state": "inbox"}, client_today())
            if files:
                save_files(task_id, files)
        else:
            note_id = share_to_note(where, title, text, link, files)
    except ValueError as e:
        db.get_db().rollback()
        app_log("share", **info, result=f"Refused: {e}")
        return render_template("message.html", title="Couldn't add that", message=str(e)), 400
    db.get_db().commit()
    if where not in ("inbox", "ask"):
        app_log("share", **info, result=f"Added to note {note_id} ({len(files)} file(s))")
        return redirect(url_for("index", shared_note=note_id))
    app_log("share", **info, result=f"Added task {task_id} ({len(files)} file(s))")
    # "Ask each time": it's an Inbox task until the app's question moves it (notes.js askShared).
    return redirect(url_for("index", shared=task_id, **({"ask": 1} if where == "ask" else {})))


def share_to_note(where, title, text, link, files):
    """What was shared, as a new note (where "note"), or a new entry in a journal, now
    ("journal:<id>"; a journal since deleted makes a note instead). Pictures are placed in the
    text, after any words. Returns the note's id; not committed."""
    conn = db.get_db()
    journal = where.startswith("journal:") and conn.execute(
        "SELECT id FROM journals WHERE id = ? AND user_id = ?", (int(where[8:] or 0), g.user["id"])).fetchone()
    words = richtext.from_text("\n\n".join(x for x in (text, link) if x))
    note_id = db.insert(conn, "notes", {"user_id": g.user["id"], "title": title[:500], "body": words}
                        | (entry_now(journal["id"]) if journal else {}))
    if files:
        before = conn.execute("SELECT COALESCE(MAX(id), 0) FROM attachments").fetchone()[0]
        save_files(note_id, files, "note")
        place_pictures(note_id, {r[0] for r in conn.execute(
            "SELECT id FROM attachments WHERE document_id = ? AND id > ?", (note_id, before))})
    return note_id


# --- adding tasks with a key: the Android app, and anything else -----------------
# The app's Add task notification (reply in place, like a text message) and Quick Settings
# tile post to /api/app/add directly, without Chrome or its cookies: Settings → Add from the
# phone gives the app a key of its own (handed over in an intent: link, so only this app can
# receive it). Settings → Add from other apps makes keys for anything else (an Alexa skill,
# Home Assistant, a phone shortcut, a script), which post to /api/add; see docs/api.md.

def device_hash(key):
    return hashlib.sha256(key.encode()).hexdigest()


@app.get("/api/devices")
@login_required
def list_devices():
    rows = db.get_db().execute("SELECT id, name, kind, can_read, can_complete, created_at, used_at FROM devices "
                               "WHERE user_id = ? ORDER BY id", (g.user["id"],)).fetchall()
    return jsonify([dict(r) for r in rows])


@app.post("/api/devices")
@login_required
def add_device():
    key = secrets.token_urlsafe(32)
    kind = "api" if body().get("kind") == "api" else "phone"
    name = str(body().get("name") or "").strip()[:100] or ("Android app" if kind == "phone" else "API key")
    can_read = int(kind == "api" and bool(body().get("can_read")))
    can_complete = int(kind == "api" and bool(body().get("can_complete")))
    conn = db.get_db()
    cur = conn.execute("INSERT INTO devices (user_id, key_hash, name, kind, can_read, can_complete) "
                       "VALUES (?, ?, ?, ?, ?, ?)", (g.user["id"], device_hash(key), name, kind, can_read, can_complete))
    conn.commit()
    return jsonify(id=cur.lastrowid, key=key), 201


@app.delete("/api/devices/<int:device_id>")
@login_required
def delete_device(device_id):
    conn = db.get_db()
    conn.execute("DELETE FROM devices WHERE id = ? AND user_id = ?", (device_id, g.user["id"]))
    conn.commit()
    return "", 204


QUICKADD_JS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "quickadd_server.js")


def read_quick_add(text, lang, now=""):
    """Quick add's fields for text typed on the phone (#tags, !lists, dates…), read by the
    browser's own code (quickadd_server.js), or None if Node.js couldn't run it."""
    areas = [dict(r) for r in db.get_db().execute(
        "SELECT id, name FROM areas WHERE user_id = ?", (g.user["id"],)).fetchall()]
    try:
        done = subprocess.run([shutil.which("node") or "/usr/bin/node", QUICKADD_JS],
                              input=json.dumps({"text": text, "lang": lang, "areas": areas,
                                                "contacts": contacts_json(g.user["id"]),
                                                "now": now}),
                              capture_output=True, text=True, timeout=10,
                              env={"TZ": user_tz(g.user), "PATH": "/usr/bin:/bin"})
        fields = json.loads(done.stdout) if done.returncode == 0 else None
    except (OSError, ValueError, subprocess.TimeoutExpired):
        fields = None
    if not isinstance(fields, dict) or not str(fields.get("title", "")).strip():
        app.logger.warning("Reading a phone add failed; adding it as typed")
        return None
    return fields


def added_summary(task):
    """"Call dentist · Queue · Mon Nov 2, 3:00 PM · #phone", for the phone's notification."""
    bits = [task["title"]]
    if task.get("state", "inbox") != "inbox":
        bits.append({"next": "Queue"}.get(task["state"], task["state"].capitalize()))
    if task.get("focus"):
        bits.append("★ today")
    if task.get("start_date"):
        day = date.fromisoformat(task["start_date"]).strftime("%a %b %-d")
        if task.get("start_time"):
            hh, mm = map(int, task["start_time"].split(":"))
            day += f", {hh % 12 or 12}:{mm:02d} {'AM' if hh < 12 else 'PM'}"
        bits.append(day)
    if task.get("due_date"):
        bits.append("due " + date.fromisoformat(task["due_date"]).strftime("%a %b %-d"))
    if task.get("repeat"):
        bits.append("↻")
    bits += ["#" + t for t in task.get("tags") or []]
    return " · ".join(bits)


def key_device():
    """The phone or app whose key (Authorization: Bearer …) this request carries, or None;
    sets g.user to its user."""
    key = request.headers.get("Authorization", "").removeprefix("Bearer ").strip()
    conn = db.get_db()
    device = conn.execute(
        "SELECT d.id, d.user_id, d.name, d.can_read, d.can_complete FROM devices d JOIN users u ON u.id = d.user_id "
        "WHERE d.key_hash = ? AND NOT u.disabled", (device_hash(key),)).fetchone() if key else None
    if device:
        g.user = conn.execute("SELECT * FROM users WHERE id = ?", (device["user_id"],)).fetchone()
    return device


# What a key may do besides adding tasks, and what to say to one that can't.
KEY_CAN = {
    "can_read": "This key can add tasks but not read them. In Settings → Add from other apps, make a new key "
                "with “Can also read my lists” ticked.",
    "can_complete": "This key can't complete tasks. In Settings → Add from other apps, make a new key with "
                    "“Can also complete tasks” ticked.",
}


def require_key(may=None, log=None):
    """For routes another app (or the phone) calls with a key instead of signing in: 401
    without one that works, 403 if it isn't allowed may (a KEY_CAN); else g.device is it and
    g.user its user. log: the app_log kind to note a refusal under."""
    def wrap(fn):
        @wraps(fn)
        def checked(*args, **kwargs):
            g.device = key_device()
            if g.device is None:
                if log:
                    app_log(log, **request_info(), result="Refused: no key, or one that was disconnected")
                return jsonify(error=f"Not connected any more. In {APP_NAME}, open Settings → Add from the phone "
                                     "(or Add from other apps) and connect it again."), 401
            if may and not g.device[may]:
                return jsonify(error=KEY_CAN[may]), 403
            return fn(*args, **kwargs)
        return checked
    return wrap


def add_request():
    """What /api/add was sent: JSON, a form, or plain text (just the task)."""
    if request.is_json:
        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            abort(400)
        return data
    if request.mimetype == "multipart/form-data":
        return request.form.to_dict()
    raw = request.get_data(as_text=True)
    if request.mimetype == "application/x-www-form-urlencoded":
        # text=…&notes=…, or just the task as it is (what curl -d "Buy milk" sends)
        fields = urllib.parse.parse_qs(raw, keep_blank_values=True)
        if "text" in fields:
            return {k: v[0] for k, v in fields.items()}
    return {"text": raw}


@app.post("/api/add")
@app.post("/api/app/add")  # (the Android app's address for it)
@require_key(log="app-add")
def app_add():
    """Add a task with a key from Settings (the Android app's, or one made for another app):
    Authorization: Bearer KEY, and "text" read like quick add (#tags, !lists, dates, @people;
    see read_quick_add), its first line the task and any more lines notes. Optional: "notes",
    "lang" (for 11/5-style dates) and "now" (when it was typed: YYYY-MM-DDTHH:MM, the user's
    time). Answers 201 with the task's id, title and a one-line summary to show or say."""
    info = request_info()
    conn = db.get_db()
    device = g.device
    data = add_request()
    text = str(data.get("text", "")).strip()
    if not text:
        return bad("Type a task first.")
    first, _, notes = text.partition("\n")
    notes = "\n\n".join(n for n in (notes.strip(), str(data.get("notes") or "").strip()) if n)
    task = read_quick_add(first.strip(), str(data.get("lang", ""))[:20],
                          str(data.get("now") or request.args.get("now", ""))) or {"title": first.strip()}
    task |= {"title": task["title"][:500], "notes": richtext.from_text(notes[:20000])}
    task.setdefault("state", "inbox")
    try:
        task_id = insert_task(dict(task), client_today())
    except (ValueError, TypeError) as e:
        db.get_db().rollback()
        app_log("app-add", **info, result=f"Refused: {e}")
        return bad(str(e))
    conn.execute("UPDATE devices SET used_at = datetime('now') WHERE id = ?", (device["id"],))
    conn.commit()
    app_log("app-add", **info, via=device["name"], text=text[:300], result=f"Added task {task_id}")
    return jsonify(id=task_id, title=task["title"], summary=added_summary(task)), 201


# Lists another app can read with a key that may (GET /api/read/<list>), as the sidebar
# names them; "next" is the Queue's own name.
READ_LISTS = {"focus": "Focus", "queue": "Queue", "next": "Queue", "inbox": "Inbox", "soon": "Soon",
              "later": "Later", "someday": "Someday", "waiting": "Waiting", "scheduled": "Scheduled"}


@app.post("/api/app/crash")
@require_key()
def app_crash():
    """The Android app saying why it crashed (or what it caught): {"report": the error, with
    the app's version and the phone}. Goes to the app log (Settings → Troubleshooting)."""
    report = str((request.get_json(silent=True) or {}).get("report") or "")[:8000]
    if not report:
        return bad("Say what happened.")
    app_log("app-crash", **request_info(), via=g.device["name"], report=report)
    return "", 204


@app.get("/api/read/<name>")
@require_key("can_read")
def read_list(name):
    """One of the user's lists, for another app with a key that may read (Settings → Add from
    other apps): the tasks as the sidebar list shows them (Focus and the Queue skip blocked
    tasks and inactive projects, highest priority first), and "summary", a sentence to show
    or say. ?area=Name keeps to one area; ?limit=N (default 50) caps the tasks sent and
    ?say=N (default 5) how many the summary names. See docs/api.md."""
    device = g.device
    if name.lower() not in READ_LISTS:
        return jsonify(error="No such list. Choose from: " + ", ".join(sorted(set(READ_LISTS) - {"next"}))), 404
    name = name.lower()
    uid = g.user["id"]
    local = datetime.now(ZoneInfo(user_tz(g.user)))
    today = local.date().isoformat()
    catch_up(uid, today, local.strftime("%H:%M"))
    conn = db.get_db()
    conn.execute("UPDATE devices SET used_at = datetime('now') WHERE id = ?", (device["id"],))
    conn.commit()
    tasks = tasks_json(conn.execute(
        "SELECT * FROM tasks WHERE user_id = ? AND completed_at IS NULL AND deleted_at IS NULL "
        "ORDER BY position, id", (uid,)).fetchall())
    projects = {p["id"]: p for p in projects_json(conn.execute(
        "SELECT * FROM projects WHERE user_id = ? AND deleted_at IS NULL", (uid,)).fetchall())}
    areas = {a["id"]: a["name"] for a in conn.execute("SELECT id, name FROM areas WHERE user_id = ?", (uid,))}
    area_of = lambda t: projects[t["project_id"]]["area_id"] if t["project_id"] in projects else t["area_id"]  # noqa: E731
    shown = list_tasks(name, tasks, projects, today)
    if request.args.get("area"):
        want = request.args["area"].strip().lower()
        ids = [i for i, n in areas.items() if n.lower() == want]
        if not ids:
            return jsonify(error="No such area: " + request.args["area"]), 404
        shown = [t for t in shown if area_of(t) == ids[0]]
    limit = max(1, min(200, request.args.get("limit", 50, type=int)))
    say = max(1, min(20, request.args.get("say", 5, type=int)))
    contacts = {c["id"]: c["name"] for c in conn.execute("SELECT id, name FROM contacts WHERE user_id = ?", (uid,))}
    out = [{"id": t["id"], "title": t["title"], "list": "Queue" if t["state"] == "next" else t["state"].capitalize(),
            "focus": t["focus"], "priority": t["priority"], "due_date": t["due_date"],
            "overdue": bool(t["due_date"] and t["due_date"] < today),
            "start_date": t["start_date"], "start_time": t["start_time"],
            "project": projects[t["project_id"]]["name"] if t["project_id"] in projects else None,
            "area": areas.get(area_of(t)), "tags": t["tags"],
            "people": [contacts[p] for p in t["people"] if p in contacts]} for t in shown]
    return jsonify(list=READ_LISTS[name], count=len(out), tasks=out[:limit],
                   summary=spoken_list(READ_LISTS[name], out, today, say))


# Words left out when matching what was said to a task's title ("call the dentist" is "Call dentist").
FILLER = {"the", "a", "an", "my", "to", "for", "of", "on", "about", "with", "and", "at", "in"}


def words(text):
    return re.findall(r"[\w']+", re.sub(r"[*_~`]+", "", text.lower()))


@app.post("/api/complete")
@require_key("can_complete")
def complete_by_key():
    """Complete a task for another app with a key that may (Settings → Add from other apps):
    {"text": what was said} finds the open task it means, {"id": N} names one. "check": true
    only finds it (to ask "Complete Call the dentist?" first); "undo": true (with "id") puts a
    completed task back. Answers {"task": {id, title}, "summary": a sentence to say}, or 404
    (nothing like it) or 409 (several: "matches", to ask which). See docs/api.md."""
    info = request_info()
    device = g.device
    data = add_request()
    uid = g.user["id"]
    conn = db.get_db()
    local = datetime.now(ZoneInfo(user_tz(g.user)))
    today = local.date().isoformat()
    catch_up(uid, today, local.strftime("%H:%M"))
    if data.get("id") not in (None, ""):
        try:
            task = conn.execute("SELECT * FROM tasks WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
                                (int(data["id"]), uid)).fetchone()
        except (TypeError, ValueError):
            task = None
        if task is None:
            return jsonify(error="No such task.", summary="I couldn't find that task."), 404
        if data.get("undo"):
            if task["completed_at"]:
                apply_task_update(task, {"completed": False}, today)
                app_log("app-complete", **info, via=device["name"], result=f"Undid task {task['id']}")
            return jsonify(task={"id": task["id"], "title": task["title"]},
                           summary=f"OK, {said_title(task)} is back on your list.")
        if task["completed_at"]:
            return jsonify(task={"id": task["id"], "title": task["title"]},
                           summary=f"{said_title(task)} was already done.")
    else:
        text = str(data.get("text", "")).strip()
        if not words(text):
            return bad("Say which task.")
        found = match_task(uid, text, today)
        if not found:
            return jsonify(error="No open task matches.", summary=f"I couldn't find a task like {text}."), 404
        if len(found) > 1:
            names = [said_title(t) for t in found[:3]]
            return jsonify(error="More than one task matches.",
                           matches=[{"id": t["id"], "title": t["title"]} for t in found[:10]],
                           summary="Which one: " + ", ".join(names[:-1]) + ", or " + names[-1] + "?"), 409
        task = found[0]
    if data.get("check"):
        return jsonify(task={"id": task["id"], "title": task["title"]}, summary=f"Complete {said_title(task)}?")
    apply_task_update(task, {"completed": True}, today)
    conn.execute("UPDATE devices SET used_at = datetime('now') WHERE id = ?", (device["id"],))
    conn.commit()
    app_log("app-complete", **info, via=device["name"], text=str(data.get("text", ""))[:300],
            result=f"Completed task {task['id']}")
    return jsonify(task={"id": task["id"], "title": task["title"]}, summary=f"Done: {said_title(task)}.")


def said_title(task):
    return re.sub(r"[*_~`]+", "", task["title"]).strip()


def match_task(uid, text, today):
    """The open tasks text (as said aloud) most likely means, best first: one title that's
    the same (ignoring case, punctuation and little words), else those with all its words
    (or their starts), else the nearest by spelling. Copies of one repeating task count as one
    (the oldest that's started), and tasks that are current (Focus, Queue, Inbox, Soon,
    Waiting) beat ones that are scheduled or put off."""
    rows = db.get_db().execute(
        "SELECT * FROM tasks WHERE user_id = ? AND completed_at IS NULL AND deleted_at IS NULL "
        "ORDER BY position, id", (uid,)).fetchall()
    said = [w for w in words(text) if w not in FILLER] or words(text)
    key = lambda t: [w for w in words(t["title"]) if w not in FILLER] or words(t["title"])  # noqa: E731
    found = [t for t in rows if key(t) == said]
    if not found:
        found = [t for t in rows if all(any(w.startswith(s) for w in key(t)) for s in said)]
    if not found:
        close = sorted(((difflib.SequenceMatcher(None, " ".join(said), " ".join(key(t))).ratio(), t) for t in rows),
                       key=lambda x: -x[0])
        if close and close[0][0] >= 0.75:
            best = close[0][0]
            found = [t for score, t in close if score >= best - 0.05]
    # One per repeating series (its oldest open copy), and current tasks first.
    seen, out = set(), []
    current = lambda t: t["state"] not in ("scheduled", "someday", "later")  # noqa: E731
    for t in sorted(found, key=lambda t: (not current(t), t["start_date"] or "", t["due_date"] or "9999", t["id"])):
        if t["series_id"] and t["series_id"] in seen:
            continue
        seen.add(t["series_id"])
        out.append(t)
    if len(out) > 1 and current(out[0]) and not current(out[1]):
        out = [t for t in out if current(t)]
    if len(out) > 1 and len({said_title(t).lower() for t in out}) == 1:
        out = out[:1]  # the same title more than once (e.g. one put off): the most current
    return out


def list_tasks(name, tasks, projects, today):
    """A list's tasks, as the browser's viewTasks (app.js) works them out."""
    def chain(project_id):  # the task's project and those it's part of, outward
        out = []
        while project_id in projects and project_id not in out:
            out.append(project_id)
            project_id = projects[project_id]["parent_id"]
        return out
    def active(t):
        return all(projects[p]["state"] == "active" for p in chain(t["project_id"]))
    # Blocked: waiting on an open task or project (or in a project that is, at any level), in a
    # subproject waiting its turn in a sequential project, or not the first Next action of a
    # sequential project. (app.js's sequentialBlocked agrees.)
    open_ids = {t["id"] for t in tasks}
    open_projects = {i for i, p in projects.items() if p["state"] != "done"}
    waits = lambda x: any(b in open_ids or b in open_projects for b in x["blocked_by"])  # noqa: E731
    # A sequential project's steps (its Queue tasks and active subprojects, in their shared
    # order) go one at a time: all but the first wait, a subproject with everything in it.
    held, later = set(), set()
    for p in projects.values():
        if p["sequential"]:
            steps = sorted([(t["position"], t["id"]) for t in tasks if t["project_id"] == p["id"] and t["state"] == "next"]
                           + [(q["step"] if q["step"] is not None else float("inf"), q["id"])
                              for q in projects.values() if q["parent_id"] == p["id"] and q["state"] == "active"])
            later |= {i for _, i in steps[1:]}
    held = {i for i in later if i in projects}
    blocked = {t["id"] for t in tasks
               if t["id"] in later or waits(t) or any(waits(projects[p]) or p in held for p in chain(t["project_id"]))}
    by_priority = lambda ts: sorted(ts, key=lambda t: -t["priority"])  # noqa: E731 (stable: keeps their order)
    if name == "focus":
        return by_priority([t for t in tasks if ((t["focus"] and t["state"] != "scheduled")
                                                 or (t["due_date"] and t["due_date"] <= today))
                            and t["state"] not in ("someday", "later") and active(t) and t["id"] not in blocked])
    if name in ("queue", "next"):
        return by_priority([t for t in tasks if t["state"] == "next" and active(t) and t["id"] not in blocked])
    shown = [t for t in tasks if t["state"] == name]
    if name == "scheduled":  # (upcoming copies of repeating tasks are in Recurring)
        shown = sorted((t for t in shown if not t["series_id"]),
                       key=lambda t: (t["start_date"] or "", t["start_time"] or ""))
    return shown


def spoken_list(name, tasks, today, say):
    """"Focus has 3 tasks: Pay rent, overdue; Call Mom, due today; and Buy milk." """
    if not tasks:
        return f"Nothing in {name}."
    def said(t):
        title = re.sub(r"[*_~`]+", "", t["title"]).strip()
        if t["overdue"]:
            return title + ", overdue"
        if t["due_date"] == today:
            return title + ", due today"
        return title
    named = [said(t) for t in tasks[:say]]
    more = len(tasks) - len(named)
    head = f"{name} has {len(tasks)} task{'s' * (len(tasks) != 1)}: "
    if more:
        return head + "; ".join(named) + f"; and {more} more."
    if len(named) == 1:
        return head + named[0] + "."
    return head + "; ".join(named[:-1]) + "; and " + named[-1] + "."


def file_size(f):
    f.stream.seek(0, os.SEEK_END)
    size = f.stream.tell()
    f.stream.seek(0)
    return size


@app.get("/api/attachments/<int:file_id>")
@app.get("/api/attachments/<int:file_id>/<path:_name>")  # the name, for the browser's sake
@login_required
def get_attachment(file_id, _name=None):
    row = owned("attachments", file_id)
    inline = row["mime"] in INLINE_TYPES
    res = send_file(io.BytesIO(attachment_data(file_id)),
                    mimetype=row["mime"] if inline else "application/octet-stream",
                    as_attachment=not inline, download_name=row["name"], etag=False,
                    max_age=86400)
    res.headers["X-Content-Type-Options"] = "nosniff"
    # (Chrome won't show a PDF in a sandbox; PDFs can't reach the site's cookies anyway.)
    if row["mime"] != "application/pdf":
        res.headers["Content-Security-Policy"] = "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'"
    return res


@app.delete("/api/attachments/<int:file_id>")
@login_required
def delete_attachment(file_id):
    row = owned("attachments", file_id)
    conn = db.get_db()
    conn.execute("DELETE FROM attachments WHERE id = ?", (file_id,))
    conn.commit()
    return jsonify(document_json(row["document_id"]))


@app.errorhandler(413)
def too_large(_e):
    if request.path.startswith("/api/"):
        return jsonify(error="That's over 25 MB."), 413
    return "Too large", 413


# --- the trash: the same for tasks, projects and notes --------------------------
# A project goes to the trash with everything in it (its tasks and subprojects, at any depth),
# comes back with what went with it, and is deleted for good with all of it.

def trashed(doc_id, deleted_at, was):
    """After a task, project or note went to the trash (deleted_at) or came back (deleted_at
    None; was: when it had gone): what's in a project goes too, or comes back if it went with
    it; and something brought back out of a project that's still in the trash is taken out of
    it, to be on its own. Not committed."""
    conn = db.get_db()
    inside = list(project_contents(doc_id)) if kind_of(doc_id) == "project" else []
    if inside and deleted_at:
        conn.execute(f"UPDATE documents SET deleted_at = ? WHERE deleted_at IS NULL AND id IN ({marks_for(inside)})",
                     (deleted_at, *inside))
    elif inside and was:
        conn.execute(f"UPDATE documents SET deleted_at = NULL WHERE deleted_at = ? AND id IN ({marks_for(inside)})",
                     (was, *inside))
    if not deleted_at:
        gone = "(SELECT id FROM documents WHERE deleted_at IS NOT NULL)"
        conn.execute(f"UPDATE task_data SET project_id = NULL WHERE id = ? AND project_id IN {gone}", (doc_id,))
        conn.execute(f"UPDATE project_data SET parent_id = NULL, step = NULL WHERE id = ? AND parent_id IN {gone}", (doc_id,))


def purge(doc_id):
    """Delete a task, project or note for good, and everything in a project. Not committed."""
    conn = db.get_db()
    for i in [doc_id, *(project_contents(doc_id) if kind_of(doc_id) == "project" else ())]:
        # (through its view, so a task's calendar event is noted for removal)
        conn.execute(f"DELETE FROM {db.KINDS[kind_of(i)]['view']} WHERE id = ?", (i,))


@app.delete("/api/documents/<int:doc_id>")
@login_required
def purge_document(doc_id):
    owned("documents", doc_id)
    purge(doc_id)
    db.get_db().commit()
    return "", 204


# (What older apps call.)
app.add_url_rule("/api/tasks/<int:doc_id>", "purge_task", purge_document, methods=["DELETE"])
app.add_url_rule("/api/projects/<int:doc_id>", "purge_project", purge_document, methods=["DELETE"])
app.add_url_rule("/api/notes/<int:doc_id>", "purge_note", purge_document, methods=["DELETE"])


@app.post("/api/trash/empty")
@login_required
def empty_trash():
    conn = db.get_db()
    for r in conn.execute("SELECT id FROM documents WHERE user_id = ? AND deleted_at IS NOT NULL", (g.user["id"],)).fetchall():
        if kind_of(r["id"]):  # (not one already gone with its project)
            purge(r["id"])
    conn.commit()
    return "", 204


@app.get("/api/logbook")
@login_required
def logbook():
    rows = db.get_db().execute(
        "SELECT * FROM tasks WHERE user_id = ? AND completed_at IS NOT NULL "
        "AND deleted_at IS NULL ORDER BY completed_at DESC LIMIT 500",
        (g.user["id"],)).fetchall()
    return jsonify(tasks_json(rows))


@app.get("/api/trash")
@login_required
def trash():
    conn = db.get_db()
    # What went to the trash with its project (at the same moment) is listed with it, as it
    # comes back with it; something trashed on its own before is listed apart.
    went_with = "IN (SELECT o.id FROM documents o WHERE o.deleted_at = {}.deleted_at)"
    rows = conn.execute(
        "SELECT * FROM tasks WHERE user_id = ? AND deleted_at IS NOT NULL "
        f"AND (project_id IS NULL OR project_id NOT {went_with.format('tasks')}) ORDER BY deleted_at DESC",
        (g.user["id"],)).fetchall()
    projects = conn.execute(
        "SELECT * FROM projects WHERE user_id = ? AND deleted_at IS NOT NULL "
        f"AND (parent_id IS NULL OR parent_id NOT {went_with.format('projects')}) ORDER BY deleted_at DESC",
        (g.user["id"],)).fetchall()
    with_it = lambda p: conn.execute(  # noqa: E731
        f"SELECT COUNT(*) FROM documents WHERE deleted_at = ? AND id IN ({marks_for(list(project_contents(p['id'])) or [0])})",
        (p["deleted_at"], *(project_contents(p["id"]) or [0]))).fetchone()[0]
    notes = conn.execute("SELECT * FROM notes WHERE user_id = ? AND deleted_at IS NOT NULL "
                         "ORDER BY deleted_at DESC", (g.user["id"],)).fetchall()
    return jsonify(tasks=tasks_json(rows), notes=notes_json(notes),
                   projects=[p | {"inside": with_it(p)} for p in projects_json(projects)])


# --- notes and journals --------------------------------------------------------
# The Notes page: notes of formatted text (HTML cleaned by richtext.py) with pictures placed
# in them and other files, in categories (each with a colour), with tags, an area, and links
# to tasks and projects. A note in a journal is one of its entries, at a point in time (its entry date and time).

# The colours a category can have (notes.js NOTE_COLORS draws them).
NOTE_COLORS = {"", "red", "orange", "yellow", "green", "teal", "blue", "navy", "purple", "pink", "brown", "gray"}
# Changes that make a note "edited" (pinning or trashing it doesn't).
NOTE_EDITS = ("title", "body", "font", "category_id", "area_id", "journal_id", "entry_date", "entry_time",
              "tags", "related", "related_projects")  # (related_projects: from older apps)


def notes_json(rows):
    """Notes as the API sends them: with their tags, files, and the tasks and projects they're
    linked to (related, shaped like a task's)."""
    return with_shared(rows, "note", lambda r: dict(r) | {"pinned": bool(r["pinned"])})


def note_dict(note_id):
    return notes_json([owned("notes", note_id)])[0]


def note_fields(data):
    """Validate the editable note fields present in data."""
    out = {}
    for key, value in data.items():
        if shared_fields("note", key, value, out):
            continue
        if key == "font":
            if value not in ("", None, *richtext.FONTS):
                raise ValueError("Unknown font.")
            out[key] = value or ""
        elif key == "category_id":
            out[key] = check_ref("note_categories", value)
        elif key == "journal_id":
            out[key] = check_ref("journals", value)
        elif key == "entry_date":
            out[key] = clean_date(value)
        elif key == "entry_time":
            if value not in (None, "") and not TIME_RE.match(str(value)):
                raise ValueError("times must be HH:MM")
            out[key] = value or None
        elif key == "pinned":
            out[key] = 1 if value else 0
        elif key == "archived":
            out["archived_at"] = utcnow() if value else None
    return out


def write_note(data, note=None, today=None):
    """Create a note for g.user from API-style data (note=None), or change note (a row);
    returns its id. Not committed."""
    fields = note_fields(data)
    old = note or {}
    journal = fields.get("journal_id", old.get("journal_id"))
    # An entry is at a point in time: now unless given. A note taken out of its journal has none.
    if journal and not fields.get("entry_date", old.get("entry_date")):
        day, hhmm = client_now()
        fields["entry_date"] = today or day
        fields.setdefault("entry_time", None if today else hhmm)
    if not journal and old.get("entry_date"):
        fields["entry_date"] = fields["entry_time"] = None
    conn = db.get_db()
    if note is None:
        fields["user_id"] = g.user["id"]
        # Made offline: when it was written (sent with it), if that's believable.
        made = str(data.get("created_at") or "")
        if STAMP_RE.match(made) and made.replace("T", " ") <= utcnow():
            fields["created_at"] = fields["updated_at"] = made.replace("T", " ")[:19]
        note_id = db.insert(conn, "notes", fields)
    else:
        note_id = note["id"]
        if any(k in data for k in NOTE_EDITS):
            fields["updated_at"] = utcnow()
        if fields:
            conn.execute(f"UPDATE notes SET {', '.join(f'{k} = ?' for k in fields)} WHERE id = ?",
                         (*fields.values(), note_id))
    if isinstance(data.get("tags"), list):
        set_tags(note_id, data["tags"])
    set_related("note", note_id, given_ids(data, "related"))
    return note_id


@app.post("/api/notes")
@login_required
def create_note():
    try:
        note_id = write_note(body())
    except (ValueError, TypeError) as e:
        db.get_db().rollback()
        return bad(str(e))
    db.get_db().commit()
    return jsonify(note_dict(note_id)), 201


@app.patch("/api/notes/<int:note_id>")
@login_required
def update_note(note_id):
    note = dict(owned("notes", note_id))
    try:
        write_note(body(), note)
    except (ValueError, TypeError) as e:
        db.get_db().rollback()
        return bad(str(e))
    db.get_db().commit()
    return jsonify(note_dict(note_id))


def category_fields(data, table):
    out = {}
    if "name" in data:
        name = str(data["name"] or "").strip()[:200 if table == "areas" else 100]
        if not name:
            raise ValueError("Give it a name.")
        out["name"] = name
    if table == "note_categories" and "color" in data:
        if data["color"] not in NOTE_COLORS:
            raise ValueError("Unknown colour.")
        out["color"] = data["color"]
    return out


def named_list_routes(table, path):
    """Add, rename (and recolour) and delete for areas, note categories and journals. (Areas'
    icons have routes of their own.)"""
    shown = lambda row: {k: row[k] for k in row.keys() if k not in ("user_id", "icon_svg")}  # noqa: E731
    def create():
        try:
            fields = category_fields(body(), table)
        except ValueError as e:
            return bad(str(e))
        if "name" not in fields:
            return bad("Give it a name.")
        fields |= {"user_id": g.user["id"], "position": next_position(table)}
        conn = db.get_db()
        cur = conn.execute(f"INSERT INTO {table} ({', '.join(fields)}) VALUES ({', '.join('?' * len(fields))})",
                           tuple(fields.values()))
        conn.commit()
        return jsonify(shown(conn.execute(f"SELECT * FROM {table} WHERE id = ?", (cur.lastrowid,)).fetchone())), 201

    def update(item_id):
        owned(table, item_id)
        try:
            fields = category_fields(body(), table)
        except ValueError as e:
            return bad(str(e))
        conn = db.get_db()
        if fields:
            conn.execute(f"UPDATE {table} SET {', '.join(f'{k} = ?' for k in fields)} WHERE id = ?",
                         (*fields.values(), item_id))
            conn.commit()
        return jsonify(shown(owned(table, item_id)))

    def delete(item_id):
        owned(table, item_id)
        conn = db.get_db()
        # A journal's entries go to the trash with it (restored, they're notes); a
        # category's notes just lose it.
        if table == "journals":
            conn.execute("UPDATE notes SET deleted_at = ? WHERE journal_id = ? AND deleted_at IS NULL",
                         (utcnow(), item_id))
        conn.execute(f"DELETE FROM {table} WHERE id = ?", (item_id,))
        conn.commit()
        return "", 204

    for fn, rule, methods in ((create, f"/api/{path}", ["POST"]), (update, f"/api/{path}/<int:item_id>", ["PATCH"]),
                              (delete, f"/api/{path}/<int:item_id>", ["DELETE"])):
        app.add_url_rule(rule, f"{table}_{fn.__name__}", login_required(fn), methods=methods)


named_list_routes("areas", "areas")
named_list_routes("note_categories", "note-categories")
named_list_routes("journals", "journals")


def note_from_task(t, journal_id=None):
    """Task t as a note: its title, notes (as text), area, tags, files (pictures placed at the
    end of the text) and links, as the same document; with journal_id, as a new entry in that
    journal, now. Returns the note's id; not committed."""
    conn = db.get_db()
    project = t["project_id"] and owned("projects", t["project_id"])
    area = project["area_id"] if project else t["area_id"]
    # Something shared with no words is named after its file (app.py's share): no title for that.
    title = "" if t["title"] == "Shared" or conn.execute(
        "SELECT 1 FROM attachments WHERE document_id = ? AND name = ?", (t["id"], t["title"])).fetchone() else t["title"]
    words = t["notes"]  # (formatted text already, as a note's is)
    files = {r[0] for r in conn.execute("SELECT id FROM attachments WHERE document_id = ?", (t["id"],))}
    note_id = t["id"]
    become(t, "note", {"title": title, "body": words, "area_id": area, "updated_at": utcnow()}
           | (entry_now(journal_id) if journal_id else {}))
    place_pictures(note_id, files)
    if project:  # linked to its project
        link(note_id, project["id"])
    return note_id


def place_pictures(note_id, ids=None):
    """Put a note's pictures (those with ids, else all of them) at the end of its text."""
    conn = db.get_db()
    pics = conn.execute("SELECT id, mime FROM attachments WHERE document_id = ? ORDER BY id", (note_id,)).fetchall()
    add = "".join(richtext.image(p["id"]) for p in pics
                  if p["mime"] in IMAGE_TYPES and (ids is None or p["id"] in ids))
    if add:
        conn.execute("UPDATE notes SET body = body || ? WHERE id = ?", (add, note_id))


@app.post("/api/tasks/<int:task_id>/to-note")
@login_required
def task_to_note(task_id):
    """Make a task into a note, or, with {"journal_id": id}, a new entry in that journal (see
    note_from_task)."""
    t = owned("tasks", task_id)
    data = request.get_json(silent=True) or {}
    journal = data.get("journal_id") and owned("journals", int(data["journal_id"]))
    try:
        check_task_can_change(t, "a note")
    except ValueError as e:
        return bad(str(e))
    note_id = note_from_task(t, journal["id"] if journal else None)
    db.get_db().commit()
    return jsonify(note_dict(note_id)), 201


def entry_now(journal_id):
    """The fields that make a note an entry in a journal, at this moment: the time on the
    user's device if the request says (?now=), else in their time zone."""
    if request.args.get("now"):
        day, hhmm = client_now()
    else:
        local = datetime.now(ZoneInfo(user_tz(g.user)))
        day, hhmm = local.date().isoformat(), local.strftime("%H:%M")
    return {"journal_id": journal_id, "entry_date": day, "entry_time": hhmm}


# --- links -----------------------------------------------------------------

def link_dict(row):
    return {"id": row["id"], "parent_id": row["parent_id"], "name": row["name"],
            "url": row["url"], "starred": bool(row["starred"]), "folder": row["url"] is None,
            "icon_version": row["icon_version"]}


def clean_url(value):
    """A web address, with https:// added if it has no scheme; nothing else is allowed."""
    url = str(value or "").strip()
    if not url:
        raise ValueError("Enter a web address.")
    if not re.match(r"^[a-z][a-z0-9+.-]*:", url, re.I):
        url = "https://" + url
    parts = urllib.parse.urlsplit(url)
    if parts.scheme.lower() not in ("http", "https") or not parts.hostname:
        raise ValueError("Links must be web addresses (http:// or https://).")
    return url[:2000]


def link_parent(value, moving_id=None):
    """Check that value is one of the user's folders, and not the item itself or inside it."""
    if value in (None, ""):
        return None
    folder = owned("links", int(value))
    if folder["url"] is not None:
        raise ValueError("Links can only go inside folders.")
    conn = db.get_db()
    at = folder
    while at is not None:
        if at["id"] == moving_id:
            raise ValueError("A folder can't go inside itself.")
        at = at["parent_id"] and conn.execute("SELECT * FROM links WHERE id = ?",
                                              (at["parent_id"],)).fetchone()
    return folder["id"]


def place_link(link_id, parent_id, before_id):
    """Put a link at the end of its folder, or just before a sibling, renumbering the folder."""
    conn = db.get_db()
    siblings = [r["id"] for r in conn.execute(
        "SELECT id FROM links WHERE user_id = ? AND parent_id IS ? AND id != ? "
        "ORDER BY position, id", (g.user["id"], parent_id, link_id))]
    at = siblings.index(before_id) if before_id in siblings else len(siblings)
    siblings.insert(at, link_id)
    conn.executemany("UPDATE links SET position = ? WHERE id = ?",
                     [(i, x) for i, x in enumerate(siblings)])


@app.post("/api/links")
@login_required
def create_link():
    """Body: {"name", "url", "parent_id", "starred", "before"}; no url makes a folder."""
    data = body()
    try:
        folder = bool(data.get("folder"))
        url = None if folder else clean_url(data.get("url"))
        name = str(data.get("name") or "").strip()[:200]
        if not name:
            if folder:
                raise ValueError("Give the folder a name.")
            name = urllib.parse.urlsplit(url).hostname.removeprefix("www.")
        parent = link_parent(data.get("parent_id"))
    except (ValueError, TypeError) as e:
        return bad(str(e))
    conn = db.get_db()
    cur = conn.execute("INSERT INTO links (user_id, parent_id, name, url, starred) "
                       "VALUES (?, ?, ?, ?, ?)",
                       (g.user["id"], parent, name, url, 1 if data.get("starred") and url else 0))
    place_link(cur.lastrowid, parent, data.get("before"))
    conn.commit()
    return jsonify(link_dict(owned("links", cur.lastrowid))), 201


@app.patch("/api/links/<int:link_id>")
@login_required
def update_link(link_id):
    """Change name, url, starred; or move with parent_id and/or "before" (a sibling id, or null for the end)."""
    link = owned("links", link_id)
    data = body()
    fields = {}
    try:
        if "name" in data:
            fields["name"] = str(data["name"] or "").strip()[:200]
            if not fields["name"]:
                raise ValueError("A name is needed.")
        if "url" in data and link["url"] is not None:
            fields["url"] = clean_url(data["url"])
        if "starred" in data and link["url"] is not None:
            fields["starred"] = 1 if data["starred"] else 0
        if "parent_id" in data:
            fields["parent_id"] = link_parent(data["parent_id"], moving_id=link_id)
    except (ValueError, TypeError) as e:
        return bad(str(e))
    conn = db.get_db()
    if fields:
        conn.execute(f"UPDATE links SET {', '.join(f'{k} = ?' for k in fields)} WHERE id = ?",
                     (*fields.values(), link_id))
    if "parent_id" in data or "before" in data:
        place_link(link_id, fields.get("parent_id", link["parent_id"]), data.get("before"))
    conn.commit()
    return jsonify(link_dict(owned("links", link_id)))


@app.delete("/api/links/<int:link_id>")
@login_required
def delete_link(link_id):
    owned("links", link_id)
    conn = db.get_db()
    conn.execute("DELETE FROM links WHERE id = ?", (link_id,))
    conn.commit()
    return "", 204


@app.post("/api/reorder/<kind>")
@login_required
def reorder(kind):
    table = {"tasks": "tasks", "projects": "projects", "areas": "areas"}.get(kind)
    ids = body().get("ids")
    if table is None or not isinstance(ids, list):
        abort(400)
    conn = db.get_db()
    for pos, row_id in enumerate(ids):
        # (A project's page orders its tasks and subprojects together: a subproject's place
        # there is its step.)
        sub = kind == "tasks" and kind_of(int(row_id)) == "project"
        conn.execute(f"UPDATE {'projects SET step' if sub else table + ' SET position'} = ? WHERE id = ? AND user_id = ?",
                     (pos, int(row_id), g.user["id"]))
    conn.commit()
    return "", 204


def project_fields(data):
    """Validate the editable project fields present in data."""
    out = {}
    for key, value in data.items():
        if shared_fields("project", key, value, out):
            continue
        if key == "sequential":
            out[key] = 1 if value else 0
        elif key == "state":
            if value not in PROJECT_STATES:
                raise ValueError("bad state")
            out[key] = value
            out["completed_at"] = utcnow() if value == "done" else None
        elif key == "parent_id":
            out[key] = check_ref("projects", value)
        elif key == "step":
            out[key] = None if value in (None, "") else float(value)
    return out


def check_no_loops(doc_id):
    """ValueError if a task or project (as it is now, before committing), or anything it's in
    or holds, would have to be finished before it can be: a wait that could never end. (A
    project can't be done before what's in it, which can't start before what the project and
    those it's in are blocked by.)"""
    conn = db.get_db()
    if kind_of(doc_id) == "project":
        row = conn.execute("SELECT parent_id FROM project_data WHERE id = ?", (doc_id,)).fetchone()
        mine = {doc_id} | project_contents(doc_id)
    else:
        row = conn.execute("SELECT project_id FROM task_data WHERE id = ?", (doc_id,)).fetchone()
        mine = {doc_id}
    for node in mine | set(project_chain(row and row[0])):
        seen, pending = set(), list(waits_on(node))
        while pending:
            x = pending.pop()
            if x == node:
                raise ValueError("That would make them wait on each other in a loop, so neither could finish.")
            if x not in seen:
                seen.add(x)
                pending += waits_on(x)


def last_step(project_id):
    """A place after everything now in a project (its tasks and subprojects), for a new step."""
    row = db.get_db().execute(
        "SELECT MAX(x) FROM (SELECT position AS x FROM task_data WHERE project_id = ? "
        "UNION ALL SELECT step FROM project_data WHERE parent_id = ?)", (project_id, project_id)).fetchone()
    return max(row[0] + 1 if row[0] is not None else 0, next_position("tasks"))


def place_in_parent(fields, old_parent=None):
    """A project moved into another (or out) takes its place at the end of it (or none)."""
    if "parent_id" in fields and fields["parent_id"] != old_parent and "step" not in fields:
        fields["step"] = last_step(fields["parent_id"]) if fields["parent_id"] else None


def check_parent(project_id, parent_id):
    """ValueError if a project can't be part of parent_id: itself, or something in it."""
    if parent_id and (parent_id == project_id or parent_id in project_contents(project_id)):
        raise ValueError("A project can't be part of itself, or of one of its own subprojects.")


@app.post("/api/projects")
@login_required
def create_project():
    try:
        fields = project_fields(body())
    except (ValueError, TypeError) as e:
        return bad(str(e))
    if "name" not in fields:
        return bad("name is required")
    fields.setdefault("position", next_position("projects"))
    fields["user_id"] = g.user["id"]
    place_in_parent(fields)
    conn = db.get_db()
    project_id = db.insert(conn, "projects", fields)
    try:
        project_links_and_tags(project_id, body())
    except (ValueError, TypeError) as e:
        conn.rollback()
        return bad(str(e))
    conn.commit()
    return jsonify(project_dict(owned("projects", project_id))), 201


def project_links_and_tags(project_id, data):
    """A project's tags, what it's blocked by and what it's related to, from API-style data."""
    if isinstance(data.get("tags"), list):
        set_tags(project_id, data["tags"])
    set_blockers("project", project_id, given_ids(data, "blocked_by"))
    set_related("project", project_id, given_ids(data, "related"))


@app.patch("/api/projects/<int:project_id>")
@login_required
def update_project(project_id):
    old = owned("projects", project_id)
    conn = db.get_db()
    try:
        data = body()
        fields = project_fields(data)
        check_parent(project_id, fields.get("parent_id"))
        place_in_parent(fields, old["parent_id"])
        if fields:
            sets = ", ".join(f"{k} = ?" for k in fields)
            conn.execute(f"UPDATE projects SET {sets} WHERE id = ?", (*fields.values(), project_id))
        if "deleted_at" in fields:
            trashed(project_id, fields["deleted_at"], old["deleted_at"])
        project_links_and_tags(project_id, data)
        if "parent_id" in fields:
            check_no_loops(project_id)
    except (ValueError, TypeError) as e:
        conn.rollback()
        return bad(str(e))
    conn.commit()
    return jsonify(project_dict(owned("projects", project_id)))


# Areas and links can have an SVG icon: uploaded, or downloaded from a URL, then cleaned.

def set_icon(table, row_id):
    """Body: {"svg": "<svg…>"} for an upload, or {"url": "https://…"} to download one."""
    owned(table, row_id)
    data = body()
    try:
        if isinstance(data.get("svg"), str):
            svg = data["svg"]
        elif isinstance(data.get("url"), str) and data["url"].strip():
            svg = icons.fetch_svg(data["url"].strip())
        else:
            return bad("Choose an SVG file or give a URL.")
        svg = icons.clean_svg(svg)
    except icons.IconError as e:
        return bad(str(e))
    version = hashlib.sha256(svg.encode()).hexdigest()[:12]
    conn = db.get_db()
    conn.execute(f"UPDATE {table} SET icon_svg = ?, icon_version = ? WHERE id = ?",
                 (svg, version, row_id))
    conn.commit()
    return jsonify(id=row_id, icon_version=version)


def remove_icon(table, row_id):
    owned(table, row_id)
    conn = db.get_db()
    conn.execute(f"UPDATE {table} SET icon_svg = NULL, icon_version = NULL WHERE id = ?", (row_id,))
    conn.commit()
    return "", 204


def serve_icon(table, row_id):
    row = owned(table, row_id)
    if not row["icon_svg"]:
        abort(404)
    # URLs carry ?v=<version>, so a changed icon gets a new URL and can be cached hard.
    return Response(row["icon_svg"], headers=icons.SERVE_HEADERS | {
        "Cache-Control": "private, max-age=31536000, immutable"})


@app.put("/api/areas/<int:area_id>/icon")
@login_required
def set_area_icon(area_id):
    return set_icon("areas", area_id)


@app.delete("/api/areas/<int:area_id>/icon")
@login_required
def remove_area_icon(area_id):
    return remove_icon("areas", area_id)


@app.get("/api/areas/<int:area_id>/icon.svg")
@login_required
def area_icon(area_id):
    return serve_icon("areas", area_id)


@app.put("/api/links/<int:link_id>/icon")
@login_required
def set_link_icon(link_id):
    return set_icon("links", link_id)


@app.delete("/api/links/<int:link_id>/icon")
@login_required
def remove_link_icon(link_id):
    return remove_icon("links", link_id)


@app.get("/api/links/<int:link_id>/icon.svg")
@login_required
def link_icon(link_id):
    return serve_icon("links", link_id)


@app.patch("/api/tags/<int:tag_id>")
@login_required
def rename_tag(tag_id):
    owned("tags", tag_id)
    name = str(body().get("name", "")).strip()
    if not name:
        return bad("name is required")
    conn = db.get_db()
    existing = conn.execute("SELECT id FROM tags WHERE user_id = ? AND name = ? AND id != ?",
                            (g.user["id"], name, tag_id)).fetchone()
    if existing:
        # Renaming onto an existing tag merges the two.
        conn.execute("INSERT OR IGNORE INTO document_tags SELECT document_id, ? FROM document_tags "
                     "WHERE tag_id = ?", (existing["id"], tag_id))
        conn.execute("DELETE FROM tags WHERE id = ?", (tag_id,))
    else:
        conn.execute("UPDATE tags SET name = ? WHERE id = ?", (name, tag_id))
    conn.commit()
    return "", 204


@app.delete("/api/tags/<int:tag_id>")
@login_required
def delete_tag(tag_id):
    owned("tags", tag_id)
    conn = db.get_db()
    conn.execute("DELETE FROM tags WHERE id = ?", (tag_id,))
    conn.commit()
    return "", 204


@app.patch("/api/me/settings")
@login_required
def update_settings():
    data = body()
    settings = user_settings(g.user)
    if "defer_options" in data:
        opts = data["defer_options"]
        if not isinstance(opts, list) or not 1 <= len(opts) <= 12:
            return bad("Give between 1 and 12 defer options.")
        opts = [str(o).strip().lower().replace(" ", "") for o in opts]
        if bad_opts := [o for o in opts if not DEFER_RE.match(o)]:
            return bad(f"Not understood: {', '.join(bad_opts)}. Use e.g. 30m, 2h, 3d, 1w, 1mo.")
        settings["defer_options"] = opts
    if "timezone" in data:
        try:
            ZoneInfo(str(data["timezone"]))
        except (ZoneInfoNotFoundError, ValueError):
            return bad("Unknown time zone.")
        settings["timezone"] = str(data["timezone"])
    if "notify_starts" in data:
        settings["notify_starts"] = bool(data["notify_starts"])
    if "quiet_hours" in data:
        quiet = str(data["quiet_hours"] or "")
        start, _, end = quiet.partition("-")
        if quiet and not (TIME_RE.match(start) and TIME_RE.match(end) and start != end):
            return bad("Quiet hours must be two different times, HH:MM-HH:MM.")
        settings["quiet_hours"] = quiet
    if "digest_time" in data:
        if data["digest_time"] not in ("", None) and not TIME_RE.match(str(data["digest_time"])):
            return bad("The summary time must be HH:MM.")
        settings["digest_time"] = data["digest_time"] or ""
    if "share_to" in data:
        where = str(data["share_to"] or "inbox")
        if where.startswith("journal:"):
            owned("journals", int(where[8:]) if where[8:].isdigit() else 0)
        elif where not in ("inbox", "note", "ask"):
            return bad("Shares go to inbox, note, ask, or journal:<id>.")
        settings["share_to"] = where
    conn = db.get_db()
    conn.execute("UPDATE users SET settings = ? WHERE id = ?", (json.dumps(settings), g.user["id"]))
    conn.commit()
    return jsonify(settings)


@app.post("/api/me/password")
@login_required
def change_password():
    data = body()
    if not check_password_hash(g.user["password_hash"], data.get("current", "")):
        return bad("Current password is wrong.")
    new = data.get("new", "")
    if len(new) < MIN_PASSWORD:
        return bad(f"New password must be at least {MIN_PASSWORD} characters.")
    pw_hash = generate_password_hash(new)
    conn = db.get_db()
    conn.execute("UPDATE users SET password_hash = ? WHERE id = ?", (pw_hash, g.user["id"]))
    conn.commit()
    session["stamp"] = pw_hash[-12:]
    return "", 204


# --- admin API ------------------------------------------------------------

def user_dict(row):
    return {k: row[k] for k in ("id", "username", "display_name", "created_at", "last_login")} | {
        "is_admin": bool(row["is_admin"]), "disabled": bool(row["disabled"])}


@app.get("/api/admin/users")
@admin_required
def list_users():
    rows = db.get_db().execute("SELECT * FROM users ORDER BY username").fetchall()
    return jsonify([user_dict(r) for r in rows])


@app.post("/api/admin/users")
@admin_required
def create_user():
    data = body()
    username = str(data.get("username", "")).strip()
    password = data.get("password", "")
    if not re.fullmatch(r"[A-Za-z0-9_.@-]{2,64}", username):
        return bad("Username may use letters, digits and _ . @ - (2-64 characters).")
    if len(password) < MIN_PASSWORD:
        return bad(f"Password must be at least {MIN_PASSWORD} characters.")
    conn = db.get_db()
    try:
        cur = conn.execute(
            "INSERT INTO users (username, display_name, password_hash, is_admin) "
            "VALUES (?, ?, ?, ?)",
            (username, str(data.get("display_name", "")).strip() or username,
             generate_password_hash(password), 1 if data.get("is_admin") else 0))
    except db.sqlite3.IntegrityError:
        return bad("That username is taken.")
    conn.commit()
    row = conn.execute("SELECT * FROM users WHERE id = ?", (cur.lastrowid,)).fetchone()
    return jsonify(user_dict(row)), 201


@app.patch("/api/admin/users/<int:user_id>")
@admin_required
def update_user(user_id):
    data = body()
    conn = db.get_db()
    if conn.execute("SELECT 1 FROM users WHERE id = ?", (user_id,)).fetchone() is None:
        abort(404)
    if user_id == g.user["id"] and (data.get("disabled") or data.get("is_admin") is False):
        return bad("You can't disable or demote yourself.")
    if "display_name" in data:
        conn.execute("UPDATE users SET display_name = ? WHERE id = ?",
                     (str(data["display_name"]).strip(), user_id))
    if "is_admin" in data:
        conn.execute("UPDATE users SET is_admin = ? WHERE id = ?",
                     (1 if data["is_admin"] else 0, user_id))
    if "disabled" in data:
        conn.execute("UPDATE users SET disabled = ? WHERE id = ?",
                     (1 if data["disabled"] else 0, user_id))
    if data.get("password"):
        if len(data["password"]) < MIN_PASSWORD:
            return bad(f"Password must be at least {MIN_PASSWORD} characters.")
        conn.execute("UPDATE users SET password_hash = ? WHERE id = ?",
                     (generate_password_hash(data["password"]), user_id))
    conn.commit()
    row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    return jsonify(user_dict(row))


# --- your data, and backups --------------------------------------------------

def zip_name(name, taken):
    """A safe, unique file name inside the export zip."""
    name = re.sub(r'[\x00-\x1f/\\:*?"<>|]+', "_", name).strip(". ") or "file"
    stem, ext = os.path.splitext(name)
    n, out = 1, name
    while out.lower() in taken:
        n += 1
        out = f"{stem} ({n}){ext}"
    taken.add(out.lower())
    return out


@app.get("/api/export")
@login_required
def export_data():
    """Everything of the signed-in user's, as a zip: data.json (all of it), tasks.csv (for a
    spreadsheet) and their attachments."""
    uid = g.user["id"]
    conn = db.get_db()
    rows = lambda sql: [dict(r) for r in conn.execute(sql, (uid,))]  # noqa: E731
    tasks = tasks_json(conn.execute("SELECT * FROM tasks WHERE user_id = ? ORDER BY id", (uid,)).fetchall())
    projects = {p["id"]: p for p in projects_json(conn.execute(
        "SELECT * FROM projects WHERE user_id = ? ORDER BY id", (uid,)).fetchall())}
    areas = {a["id"]: a for a in rows("SELECT id, name, position, icon_svg FROM areas WHERE user_id = ? ORDER BY position, id")}
    stamp = datetime.now().strftime("%Y-%m-%d")
    spool = tempfile.SpooledTemporaryFile(max_size=32 * 1024 * 1024)
    with zipfile.ZipFile(spool, "w", zipfile.ZIP_DEFLATED) as z:
        notes = notes_json(conn.execute("SELECT * FROM notes WHERE user_id = ? ORDER BY id", (uid,)).fetchall())
        # Each one's files in a folder of its own: attachments/<task id>, project-<id>, note-<id>.
        for folder, items in (("{}", tasks), ("project-{}", projects.values()), ("note-{}", notes)):
            for x in items:
                taken = set()
                for f in x["attachments"]:
                    f["file"] = f"attachments/{folder.format(x['id'])}/" + zip_name(f["name"], taken)
                    data = attachment_data(f["id"])
                    # Already-compressed files (photos, PDFs…) are stored as they are.
                    z.writestr(zipfile.ZipInfo(f["file"], time.localtime()[:6]), data,
                               zipfile.ZIP_STORED if len(data) > 1024 * 1024 else zipfile.ZIP_DEFLATED)
        z.writestr("data.json", json.dumps({
            "exported_at": utcnow(), "app": f"{APP_NAME} ({PUBLIC_URL})",
            "user": {"username": g.user["username"], "display_name": g.user["display_name"],
                     "settings": user_settings(g.user)},
            "areas": list(areas.values()),
            "tags": rows("SELECT id, name FROM tags WHERE user_id = ? ORDER BY name"),
            "projects": list(projects.values()),
            "tasks": tasks,
            "series": rows("SELECT * FROM series WHERE user_id = ? ORDER BY id"),
            "templates": [template_dict(r) for r in conn.execute(
                "SELECT * FROM templates WHERE user_id = ? ORDER BY id", (uid,))],
            "links": [{k: v for k, v in d.items() if k != "user_id"}
                      for d in rows("SELECT * FROM links WHERE user_id = ? ORDER BY position, id")],
            "notes": [n | {"text": richtext.plain(n["body"])} for n in notes],
            "note_categories": rows("SELECT id, name, color, position FROM note_categories WHERE user_id = ? ORDER BY position, id"),
            "journals": rows("SELECT id, name, position, created_at FROM journals WHERE user_id = ? ORDER BY position, id"),
        }, indent=1, default=str))
        out = io.StringIO()
        w = csv.writer(out)
        w.writerow(["id", "title", "list", "starred", "priority", "project", "area", "tags",
                    "starts", "start time", "due", "repeat", "waiting for", "notes",
                    "attachments", "created", "completed", "deleted"])
        labels = {"next": "Queue"}
        for t in tasks:
            p = projects.get(t["project_id"])
            area = areas.get(p["area_id"] if p else t["area_id"])
            w.writerow([t["id"], t["title"], labels.get(t["state"], t["state"].title()),
                        "yes" if t["focus"] else "", t["priority"], p["name"] if p else "",
                        area["name"] if area else "", ", ".join(t["tags"]), t["start_date"] or "",
                        t["start_time"] or "", t["due_date"] or "", t["repeat"] or "",
                        t["waiting_for"], richtext.plain(t["notes"]), ", ".join(f["file"] for f in t["attachments"]),
                        t["created_at"], t["completed_at"] or "", t["deleted_at"] or ""])
        z.writestr("tasks.csv", "\ufeff" + out.getvalue())  # the mark tells Excel it's UTF-8
        z.writestr("README.txt", f"""Your {APP_NAME} data, exported {stamp}.

data.json    everything: tasks (open, completed and in the trash), projects, areas,
             tags, repeating schedules (series), links, and notes and journal entries
             (their formatted text as HTML in "body", and as plain text in "text")
tasks.csv    your tasks, for a spreadsheet
attachments/ the files attached to tasks, in a folder per task id (and to projects, in
             project-<id>, and notes, in note-<id>)
""")
    spool.seek(0)
    return send_file(spool, mimetype="application/zip", as_attachment=True,
                     download_name=f"entropicide-export-{g.user['username']}-{stamp}.zip", max_age=0)


def backup_dir():
    return backup.default_dir(app.config["DATABASE"])


@app.get("/api/admin/backups")
@admin_required
def list_backups():
    found = backup.backups(backup_dir())
    return jsonify(dir=backup_dir(), backups=[
        {"date": d.isoformat(), "size": os.path.getsize(p)} for d, p in found])


@app.get("/api/admin/backup")
@admin_required
def download_backup():
    """A fresh backup of the whole database (every user), for keeping on another machine."""
    spool = tempfile.SpooledTemporaryFile(max_size=64 * 1024 * 1024)
    try:
        backup.snapshot(app.config["DATABASE"], spool)
    except backup.BackupError as e:
        return bad(str(e))
    spool.seek(0)
    return send_file(spool, mimetype="application/gzip", as_attachment=True, max_age=0,
                     download_name=f"entropicide-{date.today().isoformat()}.db.gz")


@app.delete("/api/admin/users/<int:user_id>")
@admin_required
def delete_user(user_id):
    if user_id == g.user["id"]:
        return bad("You can't delete yourself.")
    google_forget(user_id)
    conn = db.get_db()
    conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
    conn.commit()
    return "", 204


# --- reminders (push notifications) ----------------------------------------
#
# Each device that turns notifications on (Settings) subscribes with the browser's push
# service. A background thread checks every minute for reminders that are due: a task's
# "Remind me" time (or a snoozed one), a timed task's start, and the morning summary.

REMINDER_SECONDS = int(os.environ.get("ENTROPICIDE_REMINDER_SECONDS", "60"))
START_GRACE = timedelta(hours=6)   # starts older than this when first seen aren't announced
_reminder_thread = None


def data_dir():
    return os.path.dirname(os.path.abspath(app.config["DATABASE"]))


def utc_stamp(dt):
    return dt.astimezone(ZoneInfo("UTC")).strftime("%Y-%m-%d %H:%M:%S")


def snooze_until(choice, tz):
    """UTC stamp for a snooze: "1h", "tonight" (7 pm, or an hour if it's later) or "tomorrow" (9 am)."""
    now = datetime.now(ZoneInfo(tz))
    if choice == "1h":
        when = now + timedelta(hours=1)
    elif choice == "tonight":
        evening = now.replace(hour=19, minute=0, second=0, microsecond=0)
        when = evening if evening - now >= timedelta(minutes=30) else now + timedelta(hours=1)
    elif choice == "tomorrow":
        when = (now + timedelta(days=1)).replace(hour=9, minute=0, second=0, microsecond=0)
    else:
        raise ValueError("snooze for 1h, tonight or tomorrow")
    return utc_stamp(when)


@app.post("/api/tasks/<int:task_id>/snooze")
@login_required
def snooze_task(task_id):
    owned("tasks", task_id)
    try:
        when = snooze_until(body().get("until"), user_tz(g.user))
    except ValueError as e:
        return bad(str(e))
    conn = db.get_db()
    conn.execute("UPDATE tasks SET remind_at = ?, reminded_at = NULL, updated_at = datetime('now') "
                 "WHERE id = ?", (when, task_id))
    if body().get("plan"):
        # Set from the editor's quick buttons: the reminder as meant, so later copies take it.
        apply_task_update(owned("tasks", task_id), {"remind_at": when}, client_today())
    conn.commit()
    return jsonify(tasks_json([owned("tasks", task_id)])[0])


@app.get("/api/push")
@login_required
def push_status():
    devices = db.get_db().execute("SELECT endpoint, device, created_at FROM push_subscriptions "
                                  "WHERE user_id = ? ORDER BY id", (g.user["id"],)).fetchall()
    return jsonify(key=push.public_key(data_dir()), devices=[dict(d) for d in devices])


@app.post("/api/push/subscribe")
@login_required
def push_subscribe():
    data = body()
    keys = data.get("keys") or {}
    endpoint = str(data.get("endpoint", ""))
    if not endpoint.startswith("https://") or not keys.get("p256dh") or not keys.get("auth"):
        return bad("That isn't a push subscription.")
    conn = db.get_db()
    # One row per browser; it now belongs to whoever subscribed it last.
    conn.execute("DELETE FROM push_subscriptions WHERE endpoint = ?", (endpoint,))
    conn.execute("INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, device) "
                 "VALUES (?, ?, ?, ?, ?)", (g.user["id"], endpoint[:1000], str(keys["p256dh"])[:200],
                                            str(keys["auth"])[:100], str(data.get("device", ""))[:100]))
    conn.commit()
    return push_status()


@app.post("/api/push/unsubscribe")
@login_required
def push_unsubscribe():
    conn = db.get_db()
    conn.execute("DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?",
                 (g.user["id"], str(body().get("endpoint", ""))))
    conn.commit()
    return push_status()


@app.post("/api/push/test")
@login_required
def push_test():
    sent = notify(g.user["id"], {"title": "Notifications are working",
                                 "body": "Reminders will show up like this.", "tag": "test"})
    return jsonify(sent=sent)


def notify(uid, message):
    """Send to each of a user's devices; returns how many it reached."""
    conn = db.get_db()
    sent = 0
    for sub in conn.execute("SELECT * FROM push_subscriptions WHERE user_id = ?", (uid,)).fetchall():
        try:
            # The push services' contact for the sender: the site (they want just its origin).
            push.send(data_dir(), sub, message, "https://" + urllib.parse.urlsplit(PUBLIC_URL).netloc)
            sent += 1
        except push.Gone:
            conn.execute("DELETE FROM push_subscriptions WHERE id = ?", (sub["id"],))
            conn.commit()
        except Exception:
            app.logger.exception("Push to user %s failed", uid)
    return sent


def task_message(t, title_prefix=""):
    bits = []
    if t["due_date"]:
        bits.append("Due " + t["due_date"])
    if words := richtext.plain(t["notes"]):
        bits.append(words.split("\n")[0][:120])
    return {"title": title_prefix + t["title"], "body": " · ".join(bits), "tag": f"task-{t['id']}",
            "task": t["id"], "snooze": True}


def quiet_spell(local, quiet):
    """The quiet hours ("22:00-07:00") that local time is in, or that most recently began
    before it, as (start, end) datetimes; None when there are none."""
    if not quiet:
        return None
    start_hm, _, end_hm = quiet.partition("-")
    for back in range(3):  # the spell starting today, yesterday or the day before
        day = local.date() - timedelta(days=back)
        at = lambda hm, d: datetime(d.year, d.month, d.day, int(hm[:2]), int(hm[3:]), tzinfo=local.tzinfo)  # noqa: E731
        start = at(start_hm, day)
        if start <= local:
            end = at(end_hm, day if end_hm > start_hm else day + timedelta(days=1))
            return start, end
    return None


def send_reminders(now=None):
    """Send whatever reminders are due now (one pass of the reminder thread)."""
    now = now or datetime.now(ZoneInfo("UTC"))
    conn = db.get_db()
    now_s = utc_stamp(now)
    users = conn.execute("SELECT * FROM users WHERE disabled = 0 AND id IN "
                         "(SELECT user_id FROM push_subscriptions)").fetchall()
    for user in users:
        uid, settings = user["id"], user_settings(user)
        tz = ZoneInfo(user_tz(user))
        local = now.astimezone(tz)
        local_s = local.strftime("%Y-%m-%d %H:%M")
        open_tasks = "user_id = ? AND completed_at IS NULL AND deleted_at IS NULL"
        # Quiet hours: everything waits. Reminders stay due, and starts from the quiet hours
        # are still sent when they end (below), so they all arrive then.
        spell = quiet_spell(local, settings["quiet_hours"])
        if spell and local < spell[1]:
            continue
        # "Remind me" times, including snoozes.
        for t in conn.execute(f"SELECT * FROM tasks WHERE {open_tasks} AND remind_at <= ? AND "
                              "(reminded_at IS NULL OR reminded_at < remind_at)", (uid, now_s)).fetchall():
            conn.execute("UPDATE tasks SET reminded_at = ? WHERE id = ?", (now_s, t["id"]))
            conn.commit()
            days = t["remind_before"] and t["due_date"] and (date.fromisoformat(t["due_date"]) - local.date()).days
            when = ("Due today: " if days == 0 else "Due tomorrow: " if days == 1
                    else f"Due in {days} days: " if days and days > 1 else "")
            notify(uid, task_message(t, "⏰ " + when))
        # Timed starts.
        if settings["notify_starts"]:
            earliest = local - START_GRACE
            if spell and local - spell[1] < timedelta(hours=3):
                earliest = min(earliest, spell[0])
            earliest = earliest.strftime("%Y-%m-%d %H:%M")
            for t in conn.execute(
                    f"SELECT *, start_date || ' ' || start_time AS starts FROM tasks WHERE {open_tasks} "
                    "AND start_time IS NOT NULL AND start_date IS NOT NULL "
                    "AND start_date || ' ' || start_time <= ? AND state NOT IN ('someday', 'later') "
                    "AND start_notified IS NOT start_date || ' ' || start_time", (uid, local_s)).fetchall():
                conn.execute("UPDATE tasks SET start_notified = ? WHERE id = ?", (t["starts"], t["id"]))
                conn.commit()
                if t["starts"] >= earliest:
                    notify(uid, task_message(t, "Now: "))
        # The morning summary, once a day, at (or within 3 hours after) the chosen time.
        digest = settings["digest_time"]
        today = local.date().isoformat()
        if (digest and user["digest_sent"] != today and digest <= local.strftime("%H:%M")
                and local - local.replace(hour=int(digest[:2]), minute=int(digest[3:])) < timedelta(hours=3)):
            conn.execute("UPDATE users SET digest_sent = ? WHERE id = ?", (today, uid))
            conn.commit()
            due = conn.execute(f"SELECT title, due_date FROM tasks WHERE {open_tasks} AND due_date <= ? "
                               "ORDER BY due_date, priority DESC", (uid, today)).fetchall()
            starred = conn.execute(f"SELECT COUNT(*) FROM tasks WHERE {open_tasks} AND focus = 1 "
                                   "AND state NOT IN ('someday', 'later', 'scheduled')", (uid,)).fetchone()[0]
            if due or starred:
                late = sum(1 for d in due if d["due_date"] < today)
                head = ("" if not due else f"{late} overdue" if late == len(due)
                        else f"{len(due)} due ({late} overdue)" if late else f"{len(due)} due today")
                head += (" · " if head and starred else "") + (f"{starred} starred" if starred else "")
                notify(uid, {"title": "Today: " + head, "tag": "digest",
                             "body": ", ".join(d["title"] for d in due[:5]) + (" …" if len(due) > 5 else "")})


@app.before_request
def start_reminder_thread():
    global _reminder_thread
    if _reminder_thread is None and REMINDER_SECONDS > 0:
        _reminder_thread = threading.Thread(target=_reminder_loop, name="reminders", daemon=True)
        _reminder_thread.start()


def _reminder_loop():
    while True:
        time.sleep(REMINDER_SECONDS)
        with app.app_context():
            try:
                send_reminders()
            except Exception:
                app.logger.exception("Sending reminders failed")
            finally:
                db.close_db()


# --- Google Calendar --------------------------------------------------------
#
# Tasks with a start or due date are mirrored to a calendar in the user's Google account
# (an "Entropicide" calendar the app makes, or one of their own such as a shared family calendar),
# and changes made there (moving, renaming, deleting events) come back.
# A background thread syncs every minute, and soon after any change in the app.

SYNC_SECONDS = int(os.environ.get("ENTROPICIDE_GOOGLE_SYNC_SECONDS", "60"))
OTHER_EVENTS_SECONDS = 300   # how often other calendars' events are re-read
CONTACTS_SECONDS = 3600      # and contacts
EVENT_DAYS = 30              # how far ahead they're read
PUBLIC_URL = setting("PUBLIC_URL") or "https://{}/{}".format(
    setting("SITE_HOST", "localhost"), (setting("SITE_PATH", "/").strip("/") + "/").lstrip("/"))
_sync_wake = threading.Event()
_sync_lock = threading.Lock()   # one sync at a time: the thread, "Sync now", disconnect
_sync_thread = None


def server_tz():
    try:
        return os.path.realpath("/etc/localtime").split("zoneinfo/", 1)[1]
    except IndexError:
        return "UTC"


def user_tz(user):
    return user_settings(user)["timezone"] or server_tz()


def google_redirect_uri():
    return os.environ.get("ENTROPICIDE_GOOGLE_REDIRECT_URI") or url_for("google_callback", _external=True)


@app.get("/google/connect")
@login_required
def google_connect():
    if not gcal.configured():
        abort(404)
    session["google_state"] = secrets.token_urlsafe(24)
    return redirect(gcal.auth_url(google_redirect_uri(), session["google_state"]))


@app.get("/google/callback")
@login_required
def google_callback():
    state = session.pop("google_state", None)
    back = url_for("index")
    if not state or not secrets.compare_digest(request.args.get("state", ""), state):
        return redirect(back + "?google=expired")
    if "code" not in request.args:
        return redirect(back + "?google=cancelled")
    try:
        tokens = gcal.exchange_code(request.args["code"], google_redirect_uri())
    except gcal.GoogleError as e:
        app.logger.warning("Google sign-in failed: %s", e)
        return redirect(back + "?google=failed")
    if not tokens.get("refresh_token"):
        return redirect(back + "?google=failed")
    if not gcal.has_calendar_access(tokens):
        try:
            gcal.revoke(tokens["refresh_token"])
        except gcal.GoogleError:
            pass
        return redirect(back + "?google=noscope")
    uid = g.user["id"]
    conn = db.get_db()
    old = conn.execute("SELECT * FROM google_accounts WHERE user_id = ?", (uid,)).fetchone()
    if old and old["email"] != tokens["email"]:
        google_forget(uid, remote=False)  # a different Google account: start over
        old = None
    conn.execute(
        "INSERT INTO google_accounts (user_id, email, refresh_token, access_token, access_expires, "
        "calendar_id, sync_token, scopes) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET "
        "refresh_token = excluded.refresh_token, access_token = excluded.access_token, "
        "access_expires = excluded.access_expires, scopes = excluded.scopes, last_error = NULL, "
        "contacts_fetched = 0",
        (uid, tokens["email"], tokens["refresh_token"], tokens.get("access_token"),
         time.time() + int(tokens.get("expires_in", 0)), None, None, tokens.get("scope", "")))
    conn.commit()
    _sync_wake.set()
    return redirect(back + "?google=connected")


@app.post("/api/google/sync")
@login_required
def google_sync_now():
    sync_user(g.user["id"], fetch_events=True)
    return jsonify(google_status(g.user["id"]))


@app.post("/api/google/disconnect")
@login_required
def google_disconnect():
    google_forget(g.user["id"])
    return "", 204


@app.get("/api/google/calendars")
@login_required
def google_calendars():
    """Calendars the user could put tasks on."""
    acct = google_account(g.user["id"])
    if not acct:
        abort(404)
    try:
        cals = gcal.writable_calendars(_access_token(acct))
    except gcal.GoogleError as e:
        return bad(str(e))
    return jsonify([{"id": cid, "name": name} for cid, name in cals])


@app.post("/api/google/calendar")
@login_required
def google_choose_calendar():
    """Body: {"id": "<calendar id>"} for one of the user's calendars, or {"id": "new"}."""
    uid = g.user["id"]
    acct = google_account(uid)
    choice = body().get("id")
    if not acct or not isinstance(choice, str):
        abort(400)
    with _sync_lock:
        try:
            token = _access_token(acct)
            name = None
            if choice != "new":
                name = dict(gcal.writable_calendars(token)).get(choice)
                if name is None:
                    return bad("You can't add events to that calendar.")
            if choice != acct["calendar_id"]:
                _clear_calendar(acct, token)  # take the tasks off the old one
                conn = db.get_db()
                conn.execute("UPDATE google_accounts SET calendar_id = ?, calendar_name = ?, "
                             "owns_calendar = ?, sync_token = NULL WHERE user_id = ?",
                             (None if choice == "new" else choice, name,
                              1 if choice == "new" else 0, uid))
                conn.commit()
        except gcal.GoogleError as e:
            return bad(str(e))
    sync_user(uid, fetch_events=True)
    return jsonify(google_status(uid))


def google_account(uid):
    return db.get_db().execute("SELECT * FROM google_accounts WHERE user_id = ?",
                               (uid,)).fetchone()


def google_status(uid):
    acct = google_account(uid)
    return {"connected": acct is not None, "email": acct and acct["email"],
            "last_sync": acct and acct["last_sync"], "error": acct and acct["last_error"],
            "calendar_chosen": bool(acct and acct["owns_calendar"] is not None),
            "calendar_name": acct and (gcal.CALENDAR_NAME if acct["owns_calendar"]
                                       else acct["calendar_name"]),
            "calendar_id": acct and acct["calendar_id"],
            "calendar_owned": bool(acct and acct["owns_calendar"]),
            "contacts": bool(acct and gcal.has_contacts_access(acct["scopes"])),
            "contacts_error": acct and acct["contacts_error"]}


def contacts_json(uid):
    return [{"id": r["id"], "name": r["name"]} | json.loads(r["info"]) for r in db.get_db().execute(
        "SELECT * FROM contacts WHERE user_id = ? ORDER BY name COLLATE NOCASE", (uid,))]


def _clear_calendar(acct, token):
    """Take the app's events off the user's current calendar (deleting it if the app made it)."""
    conn = db.get_db()
    uid = acct["user_id"]
    cal = acct["calendar_id"]
    if cal and acct["owns_calendar"]:
        try:
            gcal.delete_calendar(token, cal)
        except gcal.GoogleError as e:
            if e.status not in (404, 410):
                raise
    elif cal:
        # Someone else's calendar (e.g. the family's): remove only the events the app added.
        ids = [r[0] for r in conn.execute(
            "SELECT gcal_event_id FROM tasks WHERE user_id = ? AND gcal_event_id IS NOT NULL "
            "UNION SELECT event_id FROM gcal_deletions WHERE user_id = ?", (uid, uid))]
        for event_id in ids:
            gcal.delete_event(token, cal, event_id)
    conn.execute("UPDATE tasks SET gcal_event_id = NULL, gcal_pushed = NULL WHERE user_id = ?",
                 (uid,))
    conn.execute("DELETE FROM gcal_deletions WHERE user_id = ?", (uid,))
    conn.commit()


def google_forget(uid, remote=True):
    """Disconnect: take the tasks off Google's calendar (if remote) and forget the account."""
    conn = db.get_db()
    with _sync_lock:
        acct = google_account(uid)
        if acct and remote:
            try:
                token = _access_token(acct)
                _clear_calendar(acct, token)
                gcal.revoke(acct["refresh_token"])
            except gcal.GoogleError as e:
                app.logger.info("Google cleanup for user %s: %s", uid, e)
        conn.execute("UPDATE tasks SET gcal_event_id = NULL, gcal_pushed = NULL WHERE user_id = ?",
                     (uid,))
        conn.execute("DELETE FROM gcal_deletions WHERE user_id = ?", (uid,))
        conn.execute("DELETE FROM contacts WHERE user_id = ?", (uid,))
        conn.execute("DELETE FROM google_accounts WHERE user_id = ?", (uid,))
        conn.commit()


@app.before_request
def start_sync_thread():
    global _sync_thread
    if _sync_thread is None and gcal.configured() and SYNC_SECONDS > 0:
        _sync_thread = threading.Thread(target=_sync_loop, name="google-sync", daemon=True)
        _sync_thread.start()


@app.after_request
def security_headers(response):
    # No framing (clickjacking), no guessing content types, no full URLs sent to other sites.
    # (Attachments and area icons set stricter policies of their own.)
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "same-origin")
    return response


@app.after_request
def wake_sync(response):
    if (request.path.startswith("/api/") and not request.path.startswith("/api/google/")
            and request.method != "GET" and response.status_code < 400):
        _sync_wake.set()
    return response


def _sync_loop():
    while True:
        if _sync_wake.wait(SYNC_SECONDS):
            time.sleep(3)  # let a burst of edits (typing, drags) settle first
        _sync_wake.clear()
        with app.app_context():
            for row in db.get_db().execute("SELECT user_id FROM google_accounts").fetchall():
                try:
                    sync_user(row["user_id"])
                except Exception:
                    app.logger.exception("Google sync failed for user %s", row["user_id"])


def sync_user(uid, fetch_events=False):
    """One round of two-way sync for a user: Google's changes first, then the app's."""
    conn = db.get_db()
    with _sync_lock:
        user = conn.execute("SELECT * FROM users WHERE id = ? AND disabled = 0", (uid,)).fetchone()
        acct = conn.execute("SELECT * FROM google_accounts WHERE user_id = ?", (uid,)).fetchone()
        if not user or not acct:
            return
        saved_user = g.get("user")
        g.user = user
        tz = user_tz(user)
        today = datetime.now(ZoneInfo(tz)).date().isoformat()
        error = None
        try:
            # Make due repeat copies even if nobody has the app open, so they reach the calendar.
            conn.execute("BEGIN IMMEDIATE")
            run_series(uid, today)
            conn.commit()
            token = _access_token(acct)
            owned = acct["owns_calendar"]
            cal = acct["calendar_id"]
            if cal is None and owned:
                cal = _create_calendar(uid, token, tz)
            if cal:  # until the user picks a calendar, only their events are read
                try:
                    _pull(uid, token, cal, owned, tz, today)
                except gcal.GoogleError as e:
                    if e.status != 404:
                        raise
                    conn.execute("UPDATE tasks SET gcal_event_id = NULL, gcal_pushed = NULL "
                                 "WHERE user_id = ?", (uid,))
                    conn.execute("DELETE FROM gcal_deletions WHERE user_id = ?", (uid,))
                    if not owned:
                        conn.execute("UPDATE google_accounts SET calendar_id = NULL, "
                                     "owns_calendar = NULL WHERE user_id = ?", (uid,))
                        conn.commit()
                        raise gcal.GoogleError(f"The calendar “{acct['calendar_name']}” is gone "
                                               "from Google. Choose another in Settings.")
                    # The app's calendar was deleted in Google: make a new one and refill it.
                    cal = _create_calendar(uid, token, tz)
                    _pull(uid, token, cal, owned, tz, today)
                _push(uid, token, cal, tz)
            if fetch_events or time.time() - acct["events_fetched"] > OTHER_EVENTS_SECONDS:
                _fetch_events(uid, token, cal if owned else None, tz, today)
            acct = conn.execute("SELECT * FROM google_accounts WHERE user_id = ?", (uid,)).fetchone()
            if fetch_events or time.time() - acct["contacts_fetched"] > CONTACTS_SECONDS:
                _fetch_contacts(uid, token, acct["scopes"])
        except gcal.GoogleError as e:
            conn.rollback()
            error = str(e)
        finally:
            g.user = saved_user
        conn.execute("UPDATE google_accounts SET last_error = ?, "
                     "last_sync = CASE WHEN ? IS NULL THEN ? ELSE last_sync END WHERE user_id = ?",
                     (error, error, utcnow(), uid))
        conn.commit()


def _access_token(acct):
    if acct["access_token"] and acct["access_expires"] > time.time() + 60:
        return acct["access_token"]
    tokens = gcal.refresh(acct["refresh_token"])
    conn = db.get_db()
    conn.execute("UPDATE google_accounts SET access_token = ?, access_expires = ?, "
                 "scopes = COALESCE(?, scopes) WHERE user_id = ?",
                 (tokens["access_token"], time.time() + int(tokens.get("expires_in", 3600)),
                  tokens.get("scope"), acct["user_id"]))
    conn.commit()
    return tokens["access_token"]


def _fetch_contacts(uid, token, scopes):
    """Replace the user's copy of their Google Contacts (or drop it, without access)."""
    conn = db.get_db()
    people, error = [], None
    if gcal.has_contacts_access(scopes):
        try:
            people = gcal.list_contacts(token)
        except gcal.GoogleError as e:
            people, error = None, gcal.NO_CONTACTS_ACCESS if e.status == 403 and isinstance(
                e, gcal.AuthRevoked) else str(e)
    if people is not None:
        conn.execute("DELETE FROM contacts WHERE user_id = ?", (uid,))
        conn.executemany("INSERT OR IGNORE INTO contacts (user_id, id, name, info) VALUES (?, ?, ?, ?)",
                         [(uid, p["id"], p["name"], json.dumps(p["info"])) for p in people])
    conn.execute("UPDATE google_accounts SET contacts_fetched = ?, contacts_error = ? WHERE user_id = ?",
                 (time.time(), error, uid))
    conn.commit()


def _create_calendar(uid, token, tz):
    cal = gcal.create_calendar(token, tz)["id"]
    conn = db.get_db()
    conn.execute("UPDATE google_accounts SET calendar_id = ?, calendar_name = ?, owns_calendar = 1, "
                 "sync_token = NULL WHERE user_id = ?", (cal, gcal.CALENDAR_NAME, uid))
    conn.commit()
    return cal


def _pull(uid, token, cal, owned, tz, today):
    """Apply changes made to the tasks' calendar in Google since the last sync."""
    conn = db.get_db()
    sync_token = conn.execute("SELECT sync_token FROM google_accounts WHERE user_id = ?",
                              (uid,)).fetchone()[0]
    events, page = [], None
    while True:
        params = {"maxResults": 250}
        params |= {"syncToken": sync_token} if sync_token else {"showDeleted": "true"}
        if page:
            params["pageToken"] = page
        try:
            res = gcal.list_events(token, cal, params)
        except gcal.GoogleError as e:
            if e.status == 410 and sync_token:  # Google expired the feed position: reread it all
                sync_token, events, page = None, [], None
                continue
            raise
        events += res.get("items", [])
        page = res.get("nextPageToken")
        if not page:
            break
    for event in events:
        _apply_event(uid, event, token, cal, owned, tz, today)
    conn.execute("UPDATE google_accounts SET sync_token = ? WHERE user_id = ?",
                 (res.get("nextSyncToken"), uid))
    conn.commit()


def _apply_event(uid, event, token, cal, owned, tz, today):
    conn = db.get_db()
    task = conn.execute("SELECT * FROM tasks WHERE user_id = ? AND gcal_event_id = ?",
                        (uid, event["id"])).fetchone()
    if event.get("status") == "cancelled":
        if task and not task["completed_at"] and not task["deleted_at"]:
            # Deleted in Google: the task goes to the Trash (where it can be restored).
            apply_task_update(task, {"deleted": True}, today)
            conn.execute("UPDATE tasks SET gcal_event_id = NULL, gcal_pushed = NULL WHERE id = ?",
                         (task["id"],))
            conn.commit()
        return
    if event.get("recurrence") or event.get("recurringEventId"):
        return  # repeating events made in Google aren't turned into tasks
    when = gcal.event_when(event.get("start"), tz)
    if when is None:
        return
    day, hhmm = when

    if task is None:
        mark = event.get("extendedProperties", {}).get("private", {}).get("todo_task")
        if mark and mark.isdigit():
            # Made by this app for a task that has since lost track of it.
            orphan = conn.execute("SELECT * FROM tasks WHERE id = ? AND user_id = ? "
                                  "AND gcal_event_id IS NULL", (int(mark), uid)).fetchone()
            if orphan and gcal.snapshot(orphan):
                conn.execute("UPDATE tasks SET gcal_event_id = ?, gcal_pushed = NULL WHERE id = ?",
                             (event["id"], orphan["id"]))
                conn.commit()
            else:
                gcal.delete_event(token, cal, event["id"])
            return
        if not owned:
            return  # the calendar's own events (e.g. the family's) aren't tasks
        # An event added to the app's own calendar in Google becomes a task.
        title, notes = gcal.event_title(event, "start"), gcal.event_notes(event)
        task_id = insert_task({"title": title, "notes": richtext.from_text(notes), "start_date": day,
                               "start_time": hhmm,
                               "state": "scheduled" if day > today else "next"}, today)
        pushed = {"kind": "start", "title": title, "date": day, "time": hhmm, "notes": richtext.plain(richtext.from_text(notes))}
        conn.execute("UPDATE tasks SET gcal_event_id = ?, gcal_pushed = ? WHERE id = ?",
                     (event["id"], json.dumps(pushed), task_id))
        conn.commit()
        return

    pushed = json.loads(task["gcal_pushed"] or "null")
    if not pushed:
        return  # not sent yet; the push that follows decides
    # Three-way merge: take each of Google's changes unless the app changed that field too.
    changes, now = {}, dict(pushed)
    title = gcal.event_title(event, pushed["kind"])
    if title != pushed["title"] and task["title"] == pushed["title"]:
        changes["title"] = now["title"] = title
    if pushed["kind"] == "due":
        if day != pushed["date"] and task["due_date"] == pushed["date"]:
            changes["due_date"] = now["date"] = day
    elif ((day, hhmm) != (pushed["date"], pushed["time"])
          and (task["start_date"], task["start_time"]) == (pushed["date"], pushed["time"])):
        changes.update(start_date=day, start_time=hhmm)
        now.update(date=day, time=hhmm)
        if day > today and task["state"] in ("inbox", "next", "soon"):
            changes["state"] = "scheduled"
    if not changes:
        return
    apply_task_update(task, changes, today)
    conn.execute("UPDATE tasks SET gcal_pushed = ? WHERE id = ?", (json.dumps(now), task["id"]))
    conn.commit()


def _push(uid, token, cal, tz):
    """Send the app's changes to the user's chosen calendar."""
    conn = db.get_db()
    for row in conn.execute("SELECT rowid, event_id FROM gcal_deletions WHERE user_id = ?",
                            (uid,)).fetchall():
        gcal.delete_event(token, cal, row["event_id"])
        conn.execute("DELETE FROM gcal_deletions WHERE rowid = ?", (row["rowid"],))
        conn.commit()
    tasks = conn.execute(
        "SELECT * FROM tasks WHERE user_id = ? AND (gcal_event_id IS NOT NULL OR "
        "(completed_at IS NULL AND deleted_at IS NULL AND "
        "(due_date IS NOT NULL OR start_date IS NOT NULL)))", (uid,)).fetchall()
    for task in tasks:
        snap = gcal.snapshot(task)
        pushed = json.loads(task["gcal_pushed"] or "null")
        if snap == pushed and (snap is None or task["gcal_event_id"]):
            continue
        if snap is None:  # done, trashed, or no longer dated
            gcal.delete_event(token, cal, task["gcal_event_id"])
            conn.execute("UPDATE tasks SET gcal_event_id = NULL, gcal_pushed = NULL "
                         "WHERE id = ? AND gcal_event_id = ?", (task["id"], task["gcal_event_id"]))
            conn.commit()
            continue
        link = PUBLIC_URL
        event = None
        if task["gcal_event_id"]:
            try:
                event = gcal.patch_event(token, cal, task["gcal_event_id"],
                                         gcal.event_body(snap, task["id"], tz, link, patch=True))
            except gcal.GoogleError as e:
                if e.status not in (404, 410):
                    raise
        if event is None:
            event = gcal.insert_event(token, cal, gcal.event_body(snap, task["id"], tz, link))
        # What was sent, not the row as it is now: an edit made meanwhile goes next round.
        conn.execute("UPDATE tasks SET gcal_event_id = ?, gcal_pushed = ? WHERE id = ?",
                     (event["id"], json.dumps(snap), task["id"]))
        conn.commit()


def _fetch_events(uid, token, skip_cal, tz, today):
    """Cache the coming weeks' events from the user's calendars (but not the tasks' own events)."""
    zone = ZoneInfo(tz)
    start = datetime.combine(date.fromisoformat(today) - timedelta(days=1), datetime.min.time(), zone)
    end = start + timedelta(days=EVENT_DAYS + 1)
    out = []
    for c in gcal.list_calendars(token):
        if c["id"] == skip_cal or not c.get("selected") or c.get("hidden"):
            continue
        try:
            res = gcal.list_events(token, c["id"], {
                "timeMin": start.isoformat(), "timeMax": end.isoformat(), "singleEvents": "true",
                "orderBy": "startTime", "maxResults": 250})
        except gcal.GoogleError as e:
            app.logger.info("Skipping calendar %s: %s", c.get("summary"), e)
            continue
        color = c.get("backgroundColor", "")
        for ev in res.get("items", []):
            begins = gcal.event_when(ev.get("start"), tz)
            ends = gcal.event_when(ev.get("end"), tz)
            if ev.get("status") == "cancelled" or not begins or gcal.is_ours(ev):
                continue
            last_day = ends[0] if ends else begins[0]
            if ends and ends[1] is None:  # all-day events end the morning after their last day
                last_day = (date.fromisoformat(ends[0]) - timedelta(days=1)).isoformat()
            out.append({
                "id": ev.get("id"), "title": (ev.get("summary") or "(busy)")[:300],
                "calendar": (c.get("summaryOverride") or c.get("summary") or "")[:100],
                "color": color if re.fullmatch(r"#[0-9a-fA-F]{6}", color) else "",
                "date": begins[0], "time": begins[1], "last_date": max(last_day, begins[0]),
                "end_time": ends[1] if ends else None,
                "link": ev["htmlLink"] if str(ev.get("htmlLink", "")).startswith("https://") else "",
            })
    out.sort(key=lambda e: (e["date"], e["time"] or ""))
    conn = db.get_db()
    conn.execute("UPDATE google_accounts SET events_json = ?, events_fetched = ? WHERE user_id = ?",
                 (json.dumps(out[:2000]), time.time(), uid))
    conn.commit()
