"use strict";

// ---- state ---------------------------------------------------------------

const BASE = window.ENTROPICIDE_BASE.replace(/\/$/, "");
// (STATES, the quick-add parser and the date helpers are in quickadd.js.)
const STATE_LABEL = Object.fromEntries(STATES);
// A task's day on the calendar: its due date, else its start date (as on Google Calendar).
const taskDay = (t) => t.due_date || t.start_date;
const CALENDAR_DAYS = 14;
// Reminders before the due date, in days (the server's REMIND_BEFORE_DAYS; they come at 9 am).
const REMIND_BEFORE = [[1, "1 day"], [2, "2 days"], [3, "3 days"], [7, "1 week"], [14, "2 weeks"], [30, "1 month"],
  [60, "2 months"], [90, "3 months"]];

// A repeating task's next copy, waiting for its start date (the Recurring list).
const isRecurringCopy = (t) => t.state === "scheduled" && t.series_id;
// Priority is a number, 0 by default; Focus and the Queue list higher numbers first.
const PRIORITY_VIEWS = ["focus", "next"];
// Projects whose subprojects are folded away on the Projects page (this device).
const foldedProjects = new Set((() => { try { return JSON.parse(load("projectsFolded", "[]")); } catch { return []; } })());
const byPriority = (list) => [...list].sort((a, b) => (b.priority || 0) - (a.priority || 0));  // stable: keeps drag order
const REPEATS = ["", "daily", "weekdays", "weekly", "monthly", "yearly"];

const S = {
  data: { tasks: [], projects: [], areas: [], tags: [], links: [], templates: [], user: {}, events: [], google: {},
    notes: [], note_categories: [], journals: [] },
  linkTarget: null,     // the folder new links go into (Links page), or null for the top level
  view: load("view", "focus"),
  // Areas shown (ids as strings, "none" for tasks without one); empty shows everything.
  areas: new Set((() => {
    try { return JSON.parse(load("areas", "null")) ?? [load("area", "")].filter(Boolean); } catch { return []; }
  })()),
  search: "",
  tagFilter: new Set(),
  selected: null,       // {kind: "task"|"project", id}
  picked: new Set(),    // ids of tasks selected together, for acting on all of them
  pickAnchor: null,     // where a Shift-click range starts
  cursor: null,         // the task the keyboard is on (↑/↓, j/k)
  navFocus: false,      // the keyboard is on the sidebar (h), where j/k change the list
  extra: [],            // logbook / trash rows, fetched per view
  extraProjects: [],
  extraNotes: [],       // notes in the trash (Trash)
};

// This device's settings, as "entropicide.<key>" (copied once from "todo.<key>", their
// names before the rename; app.html's head does that, before anything reads them).
function load(key, fallback) {
  try { return localStorage.getItem("entropicide." + key) ?? fallback; } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem("entropicide." + key, value); } catch { /* private mode */ }
}

// Text size is per device (kept in this browser), as a percentage of the browser's default.
// Everything in app.css is sized in rem, so the whole layout scales with it.
const TEXT_SIZES = [75, 85, 100, 115, 130, 150, 175, 200];

function textSize() {
  return Number(load("textSize", "100")) || 100;
}

function setTextSize(pct) {
  save("textSize", pct);
  document.documentElement.style.fontSize = pct === 100 ? "" : pct + "%";
}

function stepTextSize(step) {
  const now = textSize();
  const next = step > 0 ? TEXT_SIZES.find((p) => p > now) : TEXT_SIZES.findLast((p) => p < now);
  if (next) setTextSize(next);
}

// ---- utilities -----------------------------------------------------------

const $ = (sel, root = document) => root.querySelector(sel);
const h = (s) => String(s ?? "").replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Web addresses in text, bare (https://… or www.…) or named as [label](https://…).
const URL_RE = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|\b(?:https?:\/\/|www\.)[^\s<>"]+/gi;

// [{label, url, start, end}] for each link in text.
function findLinks(text) {
  const links = [];
  for (const m of String(text ?? "").matchAll(URL_RE)) {
    let raw = m[0], url = m[2], label = m[1];
    if (!url) {
      // Leave off sentence punctuation, and a ")" that closes a bracket around the link.
      raw = raw.replace(/[.,;:!?'*]+$/, "");
      if (raw.endsWith(")") && !raw.includes("(")) raw = raw.slice(0, -1);
      label = raw;
      url = /^www\./i.test(raw) ? "https://" + raw : raw;
    }
    links.push({ label, url, start: m.index, end: m.index + raw.length });
  }
  return links;
}

// Escaped text with its web addresses as links that open in a new tab. fmt turns the text
// between links into HTML (by default, just escaped).
function linkify(text, fmt = h) {
  text = String(text ?? "");
  let out = "", at = 0;
  for (const l of findLinks(text)) {
    out += fmt(text.slice(at, l.start)) +
      `<a href="${h(l.url)}" target="_blank" rel="noopener noreferrer">${h(l.label)}</a>`;
    at = l.end;
  }
  return out + fmt(text.slice(at));
}

// ---- Markdown -------------------------------------------------------------
// A small, safe subset for titles and notes: **bold**, *italic*, ~~struck~~, `code`, links;
// and in notes, # headings, - and 1. lists, > quotes, --- rules and ``` code blocks.
// Text is escaped first, so nothing typed can become HTML of its own.

// Emphasis needs a non-word character outside it, so snake_case and 2*3*4 stay as they are.
function emphasis(text) {
  return h(text)
    .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|\W)__(?=\S)(.+?)(?<=\S)__(?!\w)/g, "$1<strong>$2</strong>")
    .replace(/(^|[^\w*])\*(?=[^\s*])(.+?)(?<=[^\s*])\*(?![\w*])/g, "$1<em>$2</em>")
    .replace(/(^|\W)_(?=\S)(.+?)(?<=\S)_(?!\w)/g, "$1<em>$2</em>")
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, "<del>$1</del>");
}

// One line of Markdown: `code` is left as typed; the rest gets links and emphasis.
function mdInline(text) {
  return String(text ?? "").split(/(`[^`\n]+`)/).map((part, i) =>
    i % 2 ? `<code>${h(part.slice(1, -1))}</code>` : linkify(part, emphasis)).join("");
}

function fmtDate(iso) {
  if (!iso) return "";
  const t = today();
  if (iso === t) return "Today";
  if (iso === addDays(t, 1)) return "Tomorrow";
  if (iso === addDays(t, -1)) return "Yesterday";
  const d = new Date(iso + "T12:00:00");
  const opts = { month: "short", day: "numeric" };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString(undefined, opts);
}

// "Today", "Yesterday", "Tomorrow", else e.g. "Monday, Oct 26" (with the year if it isn't this one).
function dayHeading(day) {
  const near = fmtDate(day);
  if (["Today", "Yesterday", "Tomorrow"].includes(near)) return near;
  const d = new Date(day + "T12:00:00");
  const opts = { weekday: "long", month: "short", day: "numeric" };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString(undefined, opts);
}

// The server's UTC "YYYY-MM-DD HH:MM:SS" as local [date, HH:MM].
function localStamp(utc) {
  const d = new Date(utc.replace(" ", "T") + "Z");
  const iso = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString();
  return [iso.slice(0, 10), iso.slice(11, 16)];
}

function fmtTime(hhmm) {
  if (!hhmm) return "";
  const [hr, mi] = hhmm.split(":").map(Number);
  return new Date(2000, 0, 1, hr, mi).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}
function fmtWhen(day, hhmm) {
  return fmtDate(day) + (hhmm ? " " + fmtTime(hhmm) : "");
}

async function api(method, path, body, { quiet } = {}) {
  const queueable = method !== "GET" && OFFLINE_PATH.test(path);
  // Behind changes still waiting to be sent, a change has to wait its turn too.
  if (queueable && outbox.ops.length) {
    const result = queueChange(method, path, body);
    flushOutbox();
    return result;
  }
  let res;
  try {
    res = await send(method, path, body);
  } catch {
    res = null;  // no connection
  }
  // No connection, or the server is down behind Apache: keep task changes for later.
  if (!res || res.status >= 502) {
    if (queueable) return queueChange(method, path, body);
    const msg = "You're offline. This needs a connection.";
    if (!quiet) toast(msg);
    throw Object.assign(new Error(msg), { shown: true });
  }
  if (res.status === 401) { location.href = BASE + "/login"; throw new Error("logged out"); }
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).error || msg; } catch { /* not json */ }
    toast(msg);
    throw Object.assign(new Error(msg), { shown: true });
  }
  return res.status === 204 ? null : res.json();
}

function send(method, path, body) {
  return fetch(BASE + "/api" + path, {
    method,
    headers: { "Content-Type": "application/json", "X-Requested-With": "entropicide" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// ---- offline changes -----------------------------------------------------
// Task, project and note changes made without a connection wait in an outbox (kept in this
// browser) and are sent in order once the server answers again. Meanwhile they're applied
// to the tasks on screen, and again after a reload (the service worker keeps the last
// /api/data). Tasks, projects and notes created offline get negative ids until they're sent.

const OFFLINE_PATH = /^\/(tasks(\/bulk|\/-?\d+)?|projects(\/-?\d+)?|notes(\/-?\d+)?|reorder\/tasks)$/;
// Version 2: tasks, projects and notes share one set of ids (projects and notes were given new
// ones then, so older changes to them, or naming them, can't be sent).
const OUTBOX_VERSION = 2;
const outbox = loadOutbox();  // { uid, version, ops: [{ method, path, body, temp }], ids: {temp: real} }
let flushing = false;

function loadOutbox() {
  let box;
  try { box = { uid: null, ops: [], ids: {}, ...JSON.parse(load("outbox", "{}")) }; }
  catch { box = { uid: null, ops: [], ids: {} }; }
  if (box.ops.length && (box.version || 1) < OUTBOX_VERSION) {
    const ok = (o) => /^\/(tasks|reorder)/.test(o.path) && !/"(project_id|blocked_by_projects|related_projects)"/.test(JSON.stringify(o.body || {}));
    const dropped = box.ops.filter((o) => !ok(o)).length;
    box.ops = box.ops.filter(ok);
    if (dropped) setTimeout(() => toast(`${dropped} change${dropped > 1 ? "s" : ""} made offline before the update couldn't be sent.`), 1500);
  }
  box.version = OUTBOX_VERSION;
  return box;
}

function saveOutbox() {
  save("outbox", JSON.stringify(outbox));
  renderOffline();
}

function queueChange(method, path, body) {
  // Only the account that made the changes may send them.
  if (outbox.ops.length && outbox.uid !== S.data.user.id) {
    const msg = "Another account has offline changes waiting on this device.";
    toast(msg);
    throw Object.assign(new Error(msg), { shown: true });
  }
  outbox.uid = S.data.user.id;
  const op = { method, path, body: structuredClone(body) };
  if (method === "POST" && ["/tasks", "/projects", "/notes"].includes(path)) {
    op.temp = Math.min(-1, ...outbox.ops.map((o) => o.temp ?? 0), ...Object.keys(outbox.ids).map(Number)) - 1;
  }
  outbox.ops.push(op);
  saveOutbox();
  return applyOffline(op);
}

// What each kind starts with (besides what every one has; see applyOffline), as app.py makes
// it, for one made offline. A new field belongs here too.
const OFFLINE_NEW = {
  tasks: () => ({ project_id: null, title: "", notes: "", state: "inbox", focus: false, due_date: null, start_date: null,
    start_time: null, waiting_for: "", energy: null, minutes: null, priority: 0, series_id: null, series_index: null,
    missed: false, completed_at: null, repeat: null, on_miss: null, series_latest: null, blocked_by: [], people: [],
    spent: 0, remind_at: null, remind_before: null }),
  projects: () => ({ name: "", notes: "", sequential: false, state: "active", focus: false, due_date: null,
    completed_at: null, priority: 0, blocked_by: [], parent_id: null, step: null }),
  notes: () => ({ title: "", body: "", font: "", category_id: null, journal_id: null, entry_date: null, entry_time: null,
    pinned: false }),
};

// Changes op as the server would (near enough) on S.data, and returns what it would reply.
// The real versions replace these when the outbox has been sent and the data reloaded.
function applyOffline(op) {
  const { method, path, body } = op;
  const [, kind, rest] = path.split("/");
  if (path === "/reorder/tasks") {
    body.ids.forEach((id, i) => { const t = taskById(id), p = !t && projectById(id); if (t) t.position = i; else if (p) p.step = i; });
    S.data.tasks.sort((a, b) => a.position - b.position || a.id - b.id);
    return null;
  }
  if (path === "/tasks/bulk") return body.tasks.map(({ id, ...c }) => changeOffline("tasks", id, c));
  if (method === "POST" && OFFLINE_NEW[kind]) {
    // A new task, project or note: what the server would make, until it's sent.
    const list = S.data[kind], stamp = new Date().toISOString().slice(0, 19).replace("T", " ");
    const x = { id: op.temp, area_id: null, created_at: stamp, updated_at: stamp, deleted_at: null, tags: [],
      attachments: [], related: [], ...OFFLINE_NEW[kind](),
      ...(kind !== "notes" && { position: Math.max(0, ...list.map((y) => y.position)) + 1 }) };
    if (!list.some((y) => y.id === x.id)) list.push(x);
    return changeOffline(kind, x.id, body);
  }
  if (method === "DELETE") {
    S.extra = S.extra.filter((t) => t.id !== Number(rest));
    if (kind === "notes") S.extraNotes = S.extraNotes.filter((n) => n.id !== Number(rest));
    return null;
  }
  return changeOffline(kind, Number(rest), body);
}

const offlineGone = new Map();  // tasks/projects completed or trashed offline, for Undo

function changeOffline(kind, id, changes) {
  const list = { tasks: S.data.tasks, projects: S.data.projects, notes: S.data.notes }[kind];
  const key = kind + id;
  const extra = kind === "notes" ? S.extraNotes : S.extra;
  const x = list.find((y) => y.id === id) || extra.find((y) => y.id === id) || offlineGone.get(key);
  if (!x) return null;
  const stamp = new Date().toISOString().slice(0, 19).replace("T", " ");
  for (const [k, v] of Object.entries(changes)) {
    if (k === "completed") x.completed_at = v ? x.completed_at || stamp : null;
    else if (k === "deleted") x.deleted_at = v ? stamp : null;
    else if (k === "tags") {
      x.tags = [...v].sort();
      for (const name of v) if (!S.data.tags.some((t) => t.name === name)) S.data.tags.push({ id: null, name });
    }
    else if (k !== "defer" && k !== "on_miss") x[k] = v;
  }
  if (kind === "projects" && "state" in changes) x.completed_at = changes.state === "done" ? stamp : null;
  if (kind === "notes") noteChangedOffline(x, changes, stamp);
  // Like /api/data: only open tasks, and projects and notes not in the trash.
  const gone = kind === "tasks" ? x.completed_at || x.deleted_at : x.deleted_at;
  const i = list.indexOf(x);
  if (gone && i >= 0) { list.splice(i, 1); offlineGone.set(key, x); }
  else if (!gone && i < 0 && !extra.includes(x)) { list.push(x); offlineGone.delete(key); }
  return x;
}

// Puts the waiting changes back on freshly loaded data.
function replayOutbox() {
  if (!outbox.ops.length || outbox.uid !== S.data.user.id) return;
  offlineGone.clear();
  for (const op of outbox.ops) {
    try { applyOffline(withRealIds(op)); } catch { /* skip a change that no longer fits */ }
  }
}

// Swap the ids of things created offline for their real ones, once they're known.
function withRealIds(op) {
  const real = (id) => outbox.ids[id] ?? id;
  const fix = (v, k) => Array.isArray(v) ? v.map((x) => fix(x, k))
    : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([kk, vv]) => [kk, fix(vv, kk)]))
    : ["id", "ids", "project_id"].includes(k) && typeof v === "number" ? real(v) : v;
  return { ...op, path: op.path.replace(/-\d+$/, (m) => real(Number(m))), body: fix(op.body) };
}

// Sends the waiting changes, oldest first; stops (to try later) if the server can't be reached.
async function flushOutbox() {
  if (flushing || !outbox.ops.length || outbox.uid !== S.data?.user.id) return;
  flushing = true;
  let failed = 0;
  try {
    while (outbox.ops.length) {
      const op = withRealIds(outbox.ops[0]);
      let res;
      try { res = await send(op.method, op.path, op.body); } catch { return; }
      if (res.status >= 502) return;
      if (res.status === 401) { location.href = BASE + "/login"; return; }
      if (res.ok && op.temp) outbox.ids[op.temp] = (await res.json()).id;
      // Refused (e.g. the task was deleted on another device): drop it, and say so below.
      if (!res.ok) failed++;
      outbox.ops.shift();
      saveOutbox();
    }
    if (S.selected && outbox.ids[S.selected.id]) S.selected.id = outbox.ids[S.selected.id];
    noteEditorSaved(outbox.ids);
    S.picked = new Set([...S.picked].map((id) => outbox.ids[id] ?? id));
    outbox.ids = {};
    outbox.uid = null;
    saveOutbox();
    toast(failed ? `Back online. ${failed} change${failed > 1 ? "s" : ""} couldn't be saved.`
      : "Back online. Your changes are saved.");
    await refresh();
  } finally {
    flushing = false;
  }
}

function renderOffline() {
  const n = outbox.ops.length;
  const el = $("#offline");
  el.hidden = !n;
  el.textContent = `Offline · ${n} change${n > 1 ? "s" : ""} waiting`;
}

let toastTimer;
function toast(msg, undo) {
  const el = $("#toast");
  // An open modal dialog covers the page, so show the toast inside it.
  (document.querySelector("dialog[open]") || document.body).append(el);
  el.innerHTML = h(msg) + (undo ? ' <button class="link" id="undo">Undo</button>' : "");
  el.hidden = false;
  if (undo) $("#undo").onclick = () => { el.hidden = true; undo(); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 5000);
}

// ---- data access ---------------------------------------------------------

const projectById = (id) => S.data.projects.find((p) => p.id === id);
const areaById = (id) => S.data.areas.find((a) => a.id === id);
const taskById = (id) =>
  S.data.tasks.find((t) => t.id === id) || S.extra.find((t) => t.id === id);

function taskArea(t) {
  const p = t.project_id && projectById(t.project_id);
  return p ? p.area_id : t.area_id;
}

function inArea(areaId) {
  return !S.areas.size || S.areas.has(areaId == null ? "none" : String(areaId));
}

// The area new tasks and projects go in: the first one ticked in the filter (so they
// stay in view), or none when nothing (or only "No area") is ticked.
function chosenArea() {
  return S.data.areas.find((a) => S.areas.has(String(a.id)))?.id ?? null;
}

// A project and the projects it's part of, outward (itself first).
function projectChain(id) {
  const out = [];
  for (let p = projectById(id); p && !out.includes(p); p = projectById(p.parent_id)) out.push(p);
  return out;
}

// A task's projects (at every level) are all active (not Someday, Later or done).
function projectActive(t) {
  return projectChain(t.project_id).every((p) => p.state === "active");
}

// A project's steps: its tasks and subprojects, in their one order (a task's position, a
// subproject's step), as [{kind, x}]. tasks: which of its tasks to include (all, by default).
function projectSteps(p, tasks = S.data.tasks.filter((t) => t.project_id === p.id)) {
  const at = (s) => (s.kind === "task" ? s.x.position : s.x.step ?? Infinity);
  return [...tasks.map((x) => ({ kind: "task", x })), ...subprojects(p).map((x) => ({ kind: "project", x }))]
    .sort((a, b) => at(a) - at(b) || a.x.id - b.x.id);
}

// The steps of sequential projects that wait their turn: all but the first of each one's Queue
// tasks and active subprojects, in their order (a subproject with everything in it). (app.py's
// list_tasks agrees.)
function laterSteps() {
  const later = new Set();
  for (const p of S.data.projects) {
    if (!p.sequential) continue;
    projectSteps(p).filter((s) => (s.kind === "task" ? s.x.state === "next" : s.x.state === "active"))
      .slice(1).forEach((s) => later.add(s.x.id));
  }
  return later;
}

// The open item in the editor: a task or a project.
const selItem = () => S.selected && (S.selected.kind === "task" ? taskById(S.selected.id) : projectById(S.selected.id));
// A project that isn't done (only open tasks are loaded, but projects done lately are too).
const openProject = (id) => { const p = projectById(id); return p && p.state !== "done" ? p : null; };

// What a task or project (kind) is blocked by that isn't done yet, as [{kind, id, title}]:
// open tasks and projects, and what the projects it's in (at any depth) are waiting on too.
function waitingOn(x, kind = "task", seen = new Set()) {
  const out = [];
  for (const id of x.blocked_by || []) {
    const t = S.data.tasks.find((y) => y.id === id), p = !t && openProject(id);
    if (t) out.push({ kind: "task", id, title: t.title });
    else if (p) out.push({ kind: "project", id, title: p.name });
  }
  const up = projectById(kind === "task" ? x.project_id : x.parent_id);
  if (up && !seen.has(up.id)) out.push(...waitingOn(up, "project", seen.add(up.id)));
  return out;
}

// A sequential project only exposes its first Next action.
// Plus tasks waiting on others, or on projects, that aren't done yet (Blocked by), and the
// tasks of a project that's waiting.
function sequentialBlocked() {
  const blocked = new Set();
  const later = laterSteps();
  for (const t of S.data.tasks) {
    if (later.has(t.id) || waitingOn(t).length || projectChain(t.project_id).some((p) => later.has(p.id))) blocked.add(t.id);
  }
  return blocked;
}

function viewTasks(view) {
  const t0 = today();
  const blocked = sequentialBlocked();
  let list;
  if (view === "focus") {
    list = S.data.tasks.filter((t) =>
      ((t.focus && t.state !== "scheduled") || (t.due_date && t.due_date <= t0)) &&
      !["someday", "later"].includes(t.state) && projectActive(t) && !blocked.has(t.id));
    list = byPriority(list);
  } else if (view === "next") {
    list = byPriority(S.data.tasks.filter((t) => t.state === "next" && projectActive(t) && !blocked.has(t.id)));
  } else if (view.startsWith("state:")) {
    // Everything in a state, including blocked and inactive-project tasks (for All).
    list = S.data.tasks.filter((t) => t.state === view.slice(6) && !(t.state === "scheduled" && t.series_id));
    if (view === "state:scheduled") list = byStart(list);
  } else if (STATE_LABEL[view]) {
    list = S.data.tasks.filter((t) => t.state === view);
    // Upcoming copies of repeating tasks live in Recurring, not Scheduled.
    if (view === "scheduled") list = byStart(list.filter((t) => !t.series_id));
  } else if (view === "recurring") {
    list = byStart(S.data.tasks.filter(isRecurringCopy));
  } else if (view === "calendar") {
    const last = addDays(t0, CALENDAR_DAYS - 1);
    list = S.data.tasks.filter((t) => { const d = taskDay(t); return d && d >= t0 && d <= last; });
    list.sort((a, b) => taskDay(a).localeCompare(taskDay(b)) ||
      (a.due_date ? 1 : 0) - (b.due_date ? 1 : 0) || (a.start_time || "").localeCompare(b.start_time || ""));
  } else if (view === "all") {
    // Every open task, grouped in sidebar order; repeating tasks' next copies stay in Recurring.
    list = STATES.flatMap(([st]) => viewTasks(`state:${st}`)).filter((t) => !isRecurringCopy(t));
  } else if (view.startsWith("project:")) {
    const id = Number(view.slice(8));
    list = S.data.tasks.filter((t) => t.project_id === id);
  } else if (view === "logbook" || view === "trash") {
    list = S.extra;
  } else {
    list = [];
  }
  if (!view.startsWith("project:")) list = list.filter((t) => inArea(taskArea(t)));
  return list;
}

function byStart(list) {
  return [...list].sort((a, b) =>
    (a.start_date || "").localeCompare(b.start_date || "") ||
    (a.start_time || "").localeCompare(b.start_time || ""));
}

// The search box's test: plain words match anywhere, ignoring case; /pattern/ is a regular
// expression (the closing slash is optional while typing). It ignores case unless the
// pattern has a capital letter (as in Vim's smartcase), or flags say otherwise (/x/s).
// A broken pattern matches as plain text, and the box shows why. Null when the box is empty.
function searchTest() {
  const q = S.search.trim();
  const box = $("#search");
  box?.classList.remove("bad");
  box?.removeAttribute("title");
  if (!q) return null;
  const re = q.length > 1 && q.match(/^\/(.*?)(?:\/([dgimsuvy]*))?$/s);
  if (re) {
    try {
      const smart = /[A-Z]/.test(re[1].replace(/\\./g, "")) ? "" : "i";  // (not \S, \W…)
      const pattern = new RegExp(re[1], (re[2] || smart).replace(/[gy]/g, ""));
      return (...texts) => texts.some((text) => pattern.test(text));
    } catch (err) {
      box?.classList.add("bad");
      box?.setAttribute("title", err.message);
    }
  }
  const lower = q.toLowerCase();
  return (...texts) => texts.some((text) => text.toLowerCase().includes(lower));
}

// A task's tags, with its project's (which go with all of its tasks).
function taskTags(t) {
  const p = t.project_id && projectById(t.project_id);
  return p?.tags?.length ? [...new Set([...t.tags, ...p.tags])] : t.tags;
}

function filtered(list) {
  const q = S.search.trim();
  const regex = q.length > 1 && q.startsWith("/") && searchTest();
  const terms = regex ? [] : parseSearch(q, TASK_SEARCH_FIELDS);
  const blocked = terms.some((t) => t.field === "is" && t.text === "blocked") ? sequentialBlocked() : null;
  return list.filter((t) =>
    (regex ? regex(t.title, textOf(t.notes)) : taskMatches(t, terms, blocked)) &&
    [...S.tagFilter].every((tag) => taskTags(t).includes(tag)));
}

// ---- search: words (all of them), "a phrase", -word to leave out, and field:value ----
// The same for tasks (here) and notes (notes.js), each with its own fields; /pattern/ is
// a regular expression instead (searchTest).

const fold = (s) => String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

// The search box as terms: {neg, field (one of fields, or null), text (folded)}. #tag is tag:.
function parseSearch(q, fields) {
  const terms = [];
  for (const m of String(q || "").matchAll(/(-)?(?:([a-z]+):)?(?:"([^"]*)"?|(\S+))/gi)) {
    let [, neg, field, quoted, word] = m;
    let text = quoted ?? word ?? "";
    field = field?.toLowerCase();
    if (field && !fields.has(field)) { text = `${field}:${text}`; field = null; }  // a web address, say
    if (!field && text.length > 1 && text.startsWith("#")) { field = "tag"; text = text.slice(1); }
    if (!text) continue;
    terms.push({ neg: !!neg, field, text: fold(text) });
  }
  return terms;
}

// A day searched for (before:, after:, on:): YYYY-MM-DD, or a part of one (2026-11), or
// today, tomorrow or yesterday.
const searchDay = (v) => ({ today: today(), tomorrow: addDays(today(), 1), yesterday: addDays(today(), -1) })[v] ?? v;

const TASK_SEARCH_FIELDS = new Set(["tag", "title", "area", "project", "in", "is", "has", "before", "after", "on"]);
const TASK_SEARCH_TIP = `<p class="muted small notes-tip">Find words anywhere (all of them), <code>"a phrase"</code>,
  <code>-word</code> to leave out, <code>#tag</code>, <code>project:</code>, <code>area:</code>, <code>in:queue</code>,
  <code>is:focus</code> / <code>blocked</code> / <code>overdue</code> / <code>repeating</code>,
  <code>has:file</code> / <code>picture</code> / <code>link</code> / <code>checklist</code> / <code>reminder</code>,
  <code>before:</code> / <code>after:</code> / <code>on:today</code> (its due date, else its start).</p>`;

// What a task is (is:…). blocked: the set of blocked tasks (sequentialBlocked), if asked.
function taskIs(t, what, blocked) {
  const day = today();
  return {
    focus: t.focus, starred: t.focus, blocked: !!blocked?.has(t.id), waiting: t.state === "waiting",
    overdue: !!t.due_date && t.due_date < day, due: !!t.due_date && t.due_date <= day, today: t.due_date === day || t.start_date === day,
    repeating: !!t.series_id, scheduled: !!t.start_date && t.start_date > day, done: !!t.completed_at, open: !t.completed_at,
  }[what] ?? false;
}

// What a task has (has:…).
function taskHas(t, what) {
  const placed = new Set(placedIds(t.notes));
  if (["picture", "pictures", "image", "photo"].includes(what)) return pictureIds(t.notes).length > 0 ||
    t.attachments.some((f) => IMAGE_TYPES.includes(f.mime));
  if (["file", "files", "attachment"].includes(what)) return t.attachments.some((f) => !placed.has(f.id));
  if (["link", "links", "url"].includes(what)) return /<a href=/.test(t.notes);
  if (["notes", "text"].includes(what)) return !!textOf(t.notes);
  if (["checklist", "check"].includes(what)) return t.notes.includes("<ul data-check>");
  if (["reminder", "remind"].includes(what)) return !!t.remind_at;
  if (["people", "person", "contact"].includes(what)) return !!t.people?.length;
  if (["related", "relation"].includes(what)) return !!t.related?.length;
  if (["note", "notes-linked"].includes(what)) return S.data.notes.some((n) => refs(n, "related").includes(t.id));
  return false;
}

// Whether a task matches all the search terms.
function taskMatches(t, terms, blocked) {
  if (!terms.length) return true;
  const title = fold(t.title), text = fold(textOf(t.notes)), tags = taskTags(t).map(fold);
  const area = fold(areaById(taskArea(t))?.name), project = fold(projectChain(t.project_id).map((p) => p.name).join(" | "));
  const others = fold([t.waiting_for, ...t.attachments.map((f) => f.name), ...refs(t, "related").map((r) => refInfo(r).title),
    ...(t.people || []).map((id) => contactById(id)?.name || "")].join(" "));
  const days = [t.due_date, t.start_date].filter(Boolean), day = days[0] || "";
  return terms.every((term) => {
    const v = term.field && ["before", "after", "on"].includes(term.field) ? searchDay(term.text) : term.text;
    const hit = {
      tag: () => tags.some((x) => x === v || x.startsWith(v)),
      title: () => title.includes(v),
      area: () => area.includes(v) || (v === "none" && !taskArea(t)),
      project: () => project.includes(v) || (v === "none" && !t.project_id),
      in: () => fold(STATE_LABEL[t.state]).startsWith(v) || t.state.startsWith(v),
      is: () => taskIs(t, v, blocked),
      has: () => taskHas(t, v),
      before: () => !!day && day < v,
      after: () => !!day && day > v,
      on: () => days.some((d) => d.startsWith(v)),
    }[term.field]?.() ?? (title.includes(v) || text.includes(v) || tags.some((x) => x.includes(v)) ||
      area.includes(v) || project.includes(v) || others.includes(v));
    return term.neg ? !hit : hit;
  });
}

async function refresh() {
  S.data = await api("GET", "/data?now=" + nowStamp());
  replayOutbox();
  // (A project that's gone, or a view saved before projects were given new ids.)
  if (S.view.startsWith("project:") && !projectById(Number(S.view.slice(8)))) S.view = "projects";
  if (S.view === "logbook") S.extra = await api("GET", "/logbook");
  if (S.view === "trash") {
    const tr = await api("GET", "/trash");
    S.extra = tr.tasks;
    S.extraProjects = tr.projects;
    S.extraNotes = tr.notes || [];
  }
  render();
}

function replaceTask(task) {
  for (const arr of [S.data.tasks, S.extra]) {
    const i = arr.findIndex((t) => t.id === task.id);
    if (i >= 0) arr[i] = task;
  }
}

// Saving a task, project or note: where it's saved, how the reply takes its place, and the
// changes that alter which rows there are (so everything's reloaded after them).
const SAVING = {
  task: { path: "tasks", put: (x) => replaceTask(x), reload: ["completed", "deleted"] },
  project: { path: "projects", put: (x) => replaceProject(x), reload: ["deleted", "state"] },
  note: { path: "notes", put: (x) => upsertNote(x), reload: [] },
};

// Saves changes to a task, project or note (kind) and redraws: everything, reloaded, after a
// change that adds or removes rows; else the page, or with quiet just the sidebar's counts.
async function patchItem(kind, id, changes, { quiet } = {}) {
  const how = SAVING[kind];
  const x = await api("PATCH", `/${how.path}/${id}`, changes);
  if (x) how.put(x);
  if (how.reload.some((k) => k in changes)) await refresh();
  else if (!quiet) render();
  else renderNav();
  return x;
}

function patchTask(id, changes, options) { return patchItem("task", id, changes, options); }

function replaceProject(p) {
  const i = S.data.projects.findIndex((x) => x.id === p.id);
  if (i >= 0) S.data.projects[i] = p;
}

function patchProject(id, changes, options) { return patchItem("project", id, changes, options); }

// ---- rendering -----------------------------------------------------------

function render() {
  renderToolbar();
  renderAreas();
  renderNav();
  renderList();
  renderDetail();
}

function renderAreas() {
  $("#area-filter").hidden = S.data.areas.length === 0;
  for (const id of S.areas) if (id !== "none" && !areaById(Number(id))) S.areas.delete(id);
  const choices = [...S.data.areas.map((a) => [String(a.id), a.name]), ["none", "No area"]];
  const names = choices.filter(([id]) => S.areas.has(id)).map(([, name]) => name);
  $("#area-btn").textContent = !names.length ? "All areas" : names.length <= 2 ? names.join(" + ") : `${names.length} areas`;
  $("#area-menu").innerHTML = choices.map(([id, name]) =>
    `<label><input type="checkbox" value="${id}" ${S.areas.has(id) ? "checked" : ""}> ${h(name)}</label>`).join("") +
    `<button type="button" class="link area-all" ${S.areas.size ? "" : "disabled"}>Show all areas</button>`;
}

function setAreas(ids) {
  S.areas = new Set(ids);
  save("areas", JSON.stringify([...S.areas]));
  render();
}

function navItem(view, label, count, extraClass = "") {
  const active = S.view === view ? " active" : "";
  return `<a href="#" class="nav-item${active} ${extraClass}" data-view="${h(view)}"${["recurring", "all", "calendar", "links", "notes", "journal"].includes(view) ? "" : ` data-drop="${h(view)}"`}>
    <span class="nav-label">${label}</span>${count ? `<span class="count">${count}</span>` : ""}</a>`;
}

function renderNav() {
  const counts = {};
  for (const [s] of STATES) counts[s] = viewTasks(s).length;
  counts.focus = viewTasks("focus").length;
  counts.recurring = viewTasks("recurring").length;
  counts.all = viewTasks("all").length;
  // Projects have a page of their own (and Move to › Project); the sidebar just counts them.
  const projects = S.data.projects.filter((p) => p.state === "active" && inArea(p.area_id)).length;
  $("#nav").innerHTML =
    // Inbox, then Focus, then the other lists; the Calendar is an icon in the toolbar.
    STATES.map(([s, label]) => navItem(s, label, counts[s]) +
      (s === "inbox" ? navItem("focus", "★ Focus", counts.focus, "focus") : "") +
      (s === "scheduled" ? navItem("recurring", "Recurring", counts.recurring) : "")).join("") +
    navItem("all", "All", counts.all) +
    `<div class="nav-section">
       <a href="#" class="nav-item ${S.view === "projects" || S.view.startsWith("project:") ? "active" : ""}" data-view="projects">
         <span class="nav-label">Projects</span>${projects ? `<span class="count">${projects}</span>` : ""}</a>
       <button class="icon add-project" title="New project" aria-label="New project">+</button>
     </div>` +
    navItem("notes", "Notes", 0) +
    navItem("journal", "Journal", 0) +
    navItem("links", "Links", 0) +
    navItem("logbook", "Logbook", 0) +
    navItem("trash", "Trash", 0);
  markNav();
}

function viewTitle() {
  if (S.view === "focus") return "Focus";
  if (S.view === "projects") return "Projects";
  if (S.view === "recurring") return "Recurring";
  if (S.view === "all") return "All";
  if (S.view === "calendar") return "Calendar";
  if (S.view === "logbook") return "Logbook";
  if (S.view === "links") return "Links";
  if (S.view === "notes" || S.view === "journal") return notesViewTitle();
  if (S.view === "trash") return "Trash";
  if (S.view.startsWith("project:")) return projectById(Number(S.view.slice(8)))?.name ?? "Project";
  return STATE_LABEL[S.view] ?? "";
}

function taskRow(t, { showState }) {
  const p = t.project_id && projectById(t.project_id);
  const t0 = today();
  const meta = [];
  if (showState && t.state !== "next") meta.push(`<span class="badge">${STATE_LABEL[t.state]}</span>`);
  if (p && !S.view.startsWith("project:")) meta.push(`<span class="proj">${h(p.name)}</span>`);
  if (t.state === "scheduled" && t.start_date) meta.push(`<span class="start">Starts ${fmtWhen(t.start_date, t.start_time)}</span>`);
  if (t.waiting_for) meta.push(`<span class="waiting">⧗ ${h(t.waiting_for)}</span>`);
  if (t.due_date) {
    const cls = t.due_date < t0 ? "overdue" : t.due_date === t0 ? "due-today" : "";
    meta.push(`<span class="due ${cls}">Due ${fmtDate(t.due_date)}</span>`);
  }
  if (t.repeat) {
    const fromDone = t.repeat_from === "done";
    meta.push(`<span title="Repeats ${repeatLabel(t.repeat)}${fromDone ? " after it's done" : `; if missed: ${t.on_miss}`}">↻${
      S.view === "recurring" ? ` ${repeatLabel(t.repeat)}${fromDone ? " after done" : `, ${t.on_miss === "keep" ? "keeps missed" : "replaces missed"}`}` : ""}</span>`);
  }
  const waits = waitingOn(t);
  if (waits.length) {
    meta.push(`<span class="blocked" title="Waiting on: ${h(waits.map((b) => b.title).join(", "))}">🔒 after ${
      h(waits[0].title)}${waits.length > 1 ? ` +${waits.length - 1}` : ""}</span>`);
  }
  if (t.spent) meta.push(`<span title="Time spent (focus timer)">⏱ ${fmtSpent(t.spent)}</span>`);
  if (reminderPending(t)) meta.push(`<span class="remind-at" title="Reminder">⏰ ${fmtRemind(t)}</span>`);
  if (t.related?.length) meta.push(`<span class="related" title="Related: ${h(t.related.map((r) => r.title).join(", "))}">🔗 ${t.related.length}</span>`);
  if (t.attachments?.length) meta.push(`<span title="${h(t.attachments.map((f) => f.name).join(", "))}">📎 ${t.attachments.length}</span>`);
  if (t.minutes) meta.push(`<span>${t.minutes}m</span>`);
  if (t.energy) meta.push(`<span class="energy-${t.energy}">${t.energy}</span>`);
  for (const tag of t.tags) meta.push(`<span class="tag">${h(tag)}</span>`);
  for (const id of t.people || []) {
    const c = contactById(id);
    if (c) meta.push(`<span class="person">👤 ${h(c.name)}</span>`);
  }
  if (t.completed_at) {
    // The Logbook is grouped by day already, so there it shows the time.
    const [day, time] = localStamp(t.completed_at);
    const when = S.view === "logbook" ? (t.missed ? "" : fmtTime(time)) : fmtDate(day);
    meta.push(`<span${t.missed ? ' class="overdue"' : ""}>${t.missed ? "Missed" : "Done"} ${when}</span>`);
  }
  const sel = (S.selected?.kind === "task" && S.selected.id === t.id ? " selected" : "") +
    (S.picked.has(t.id) ? " picked" : "") + (menu.ids.includes(t.id) ? " menu-target" : "") +
    (S.cursor === t.id ? " cursor" : "");
  const done = t.completed_at ? " done" : "";
  return `<div class="row task${sel}${done}" data-task="${t.id}" draggable="true"${prioTint(t)}>
    <input type="checkbox" class="complete" aria-label="Complete" ${t.completed_at ? "checked" : ""}>
    <button class="star ${t.focus ? "on" : ""}" aria-label="Focus" title="Focus">★</button>
    ${areaIcon(taskArea(t))}
    <div class="row-body">
      <div class="title">${mdInline(t.title)}</div>
      ${meta.length ? `<div class="meta">${meta.join("")}</div>` : ""}
      ${notesBlock(t)}
    </div>
    ${t.completed_at || t.deleted_at ? "" : `<button type="button" class="prio-ctl"
      title="Priority ${t.priority}: hold and drag up to raise it, down to lower it" aria-label="Priority ${t.priority}">
      <span class="prio-grip" aria-hidden="true">↕</span>${prioNum(t.priority)}</button>`}
  </div>`;
}

const prioNum = (p, text = p || "") =>
  `<span class="prio-num ${p > 0 ? "up" : p < 0 ? "down" : ""}">${text}</span>`;

// Open tasks are tinted by priority: redder the higher, bluer the lower, none at 0. The
// tint deepens quickly over the first few steps, then levels off.
function prioTint(t) {
  if (!t.priority || t.completed_at || t.deleted_at) return "";
  const alpha = (0.55 * (1 - Math.exp(-Math.abs(t.priority) / 4))).toFixed(2);
  const rgb = t.priority > 0 ? "220 38 38" : "37 99 235";
  return ` style="--tint: rgb(${rgb} / ${alpha})"`;
}

// A task's text under it in the list (cut short when long). Its checklist items tick there.
function notesBlock(t) {
  if (!t.notes) return "";
  const locked = !!(t.completed_at || t.deleted_at);
  return `<div class="notes note-body row-text${locked ? " locked" : ""}">${showBody(t.notes)}</div>`;
}

// A click on a checklist box in a task's text shown in shown (a list row, or Focus): ticks it.
// True if it was one.
function tickTask(e, id, shown) {
  const t = taskById(id);
  if (!t || t.completed_at || t.deleted_at) return false;
  const html = tickFromClick(e, t.notes, shown);
  if (html === null) return false;
  $("#detail").dataset.key = "";
  patchTask(id, { notes: html });
  return true;
}

function areaIconUrl(a) {
  return `${BASE}/api/areas/${a.id}/icon.svg?v=${a.icon_version}`;
}

function areaIcon(areaId) {
  const a = areaId && areaById(areaId);
  if (a?.icon_version) return `<img class="area-icon" src="${areaIconUrl(a)}" alt="" title="${h(a.name)}">`;
  // Once any area has an icon, keep titles lined up on rows without one.
  return S.data.areas.some((x) => x.icon_version) ? '<span class="area-icon"></span>' : "";
}

function areaRow(a) {
  return `<span class="icon-slot">${a.icon_version ? `<img src="${areaIconUrl(a)}" alt="">` : ""}</span>
    <input value="${h(a.name)}" class="area-name" aria-label="Area name">
    <span class="area-actions">
      <label class="link-label">Upload…<input type="file" accept=".svg,image/svg+xml" class="icon-file" hidden></label>
      <button type="button" class="link icon-url">From URL…</button>
      ${a.icon_version ? '<button type="button" class="link icon-remove">Remove icon</button>' : ""}
      <button type="button" class="link danger del-area">Delete</button>
    </span>`;
}

async function setAreaIcon(li, body) {
  const id = Number(li.dataset.area);
  const area = areaById(id);
  if (body) Object.assign(area, await api("PUT", `/areas/${id}/icon`, body));
  else { await api("DELETE", `/areas/${id}/icon`); area.icon_version = null; }
  li.innerHTML = areaRow(area);
  toast(body ? "Icon saved." : "Icon removed.");
}

// depth: how far down a tree of subprojects it is (Projects page); null: shown on its own, so
// it says what it's part of.
function projectRow(p, depth = null, { draggable = false } = {}) {
  const [inside, subs] = projectInside(p);
  const n = inside.length, folded = foldedProjects.has(p.id), kids = subprojects(p).length;
  const area = p.area_id && areaById(p.area_id);
  const waits = waitingOn(p, "project");
  const parent = depth === null && !draggable && projectById(p.parent_id);  // (draggable: on its parent's page)
  const sel = (S.selected?.kind === "project" && S.selected.id === p.id ? " selected" : "") +
    (menu.project === p.id ? " menu-target" : "");
  return `<div class="row project${sel}${depth ? " sub" : ""}" data-project="${p.id}"${draggable ? ' draggable="true"' : ""}${prioTint(p)}>
    ${depth ? `<span class="indent" style="width: ${depth * 1.5}rem" aria-hidden="true"></span>` : ""}
    ${draggable ? '<span class="step-mark" title="A subproject: its tasks are a step of this project">▤</span>' : ""}
    ${depth !== null ? (kids ? `<button type="button" class="fold" aria-expanded="${!folded}" title="${folded ? "Show" : "Hide"} its subprojects">${folded ? "▸" : "▾"}</button>`
      : '<span class="fold"></span>') : ""}
    <button class="star ${p.focus ? "on" : ""}" aria-label="Focus" title="Focus">★</button>
    ${areaIcon(p.area_id)}
    <div class="row-body">
      <div class="title">${h(p.name)}</div>
      <div class="meta">
        ${depth && p.state !== "active" ? `<span class="badge">${PROJECT_STATES.find(([s]) => s === p.state)?.[1] || p.state}</span>` : ""}
        ${p.sequential ? '<span class="badge">Sequential</span>' : ""}
        ${parent ? `<span>in ${h(parent.name)}</span>` : ""}
        ${area ? `<span>${h(area.name)}</span>` : ""}
        <span>${n} open</span>
        ${subs.length ? `<span>${subs.length} subproject${subs.length > 1 ? "s" : ""}</span>` : ""}
        ${p.due_date ? `<span class="due">Due ${fmtDate(p.due_date)}</span>` : ""}
        ${waits.length ? `<span class="blocked" title="Waiting on: ${h(waits.map((b) => b.title).join(", "))}">🔒 after ${
          h(waits[0].title)}${waits.length > 1 ? ` +${waits.length - 1}` : ""}</span>` : ""}
        ${p.related?.length ? `<span class="related" title="Related: ${h(p.related.map((r) => r.title).join(", "))}">🔗 ${p.related.length}</span>` : ""}
        ${p.attachments?.length ? `<span title="${h(p.attachments.map((f) => f.name).join(", "))}">📎 ${p.attachments.length}</span>` : ""}
        ${(p.tags || []).map((tag) => `<span class="tag">${h(tag)}</span>`).join("")}
      </div>
    </div>
    ${p.state === "done" ? "" : `<button type="button" class="prio-ctl"
      title="Priority ${p.priority || 0}: hold and drag up to raise it, down to lower it" aria-label="Priority ${p.priority || 0}">
      <span class="prio-grip" aria-hidden="true">↕</span>${prioNum(p.priority || 0)}</button>`}
  </div>`;
}

function renderTagBar(list) {
  const used = new Set(list.flatMap(taskTags));
  for (const t of S.tagFilter) used.add(t);
  $("#tag-bar").innerHTML = [...used].sort().map((tag) =>
    `<button class="tag-chip ${S.tagFilter.has(tag) ? "on" : ""}" data-tag="${h(tag)}">${h(tag)}</button>`
  ).join("");
}

function renderList() {
  $("#view-title").textContent = viewTitle();
  document.title = viewTitle() + " · Entropicide";
  const el = $("#list");
  const readOnly = S.view === "logbook" || S.view === "trash";
  $("#quick-add").hidden = readOnly || ["projects", "links", "notes", "journal"].includes(S.view);
  if (S.view === "notes" || S.view === "journal") {
    $("#main").append($("#detail"));  // (as for links)
    renderNotes(el);
    renderSelectBar();
    return;
  }
  if (S.view === "links") {
    $("#main").append($("#detail"));  // out of the way of the links page, which redraws the list
    renderLinks(el);
    renderSelectBar();
    return;
  }

  if (S.view === "projects") {
    $("#tag-bar").innerHTML = "";
    const groups = [["active", "Active"], ["someday", "Someday"], ["later", "Later"], ["done", "Completed"]];
    // Subprojects show under their project (whatever their status), folded away if asked.
    const tree = (p, depth, seen) => projectRow(p, depth) + (foldedProjects.has(p.id) ? "" :
      projectSteps(p, []).map((st) => st.x).filter((q) => !seen.has(q.id) && seen.add(q.id)).map((q) => tree(q, depth + 1, seen)).join(""));
    fillList(el, (groups.map(([state, label]) => {
      const ps = byPriority(S.data.projects.filter((p) => p.state === state && inArea(p.area_id) && !projectById(p.parent_id)));
      if (!ps.length) return "";
      return `<h2 class="group">${label}</h2>` + ps.map((p) => tree(p, 0, new Set([p.id]))).join("");
    }).join("") || '<p class="empty">No projects yet. Use + in the sidebar to add one.</p>') +
      `<h2 class="group">Templates</h2>` + (S.data.templates.map(templateRow).join("") ||
        '<p class="empty small">None yet. Open a project, then <em>Save as template</em> in its details.</p>'));
    renderSelectBar();
    return;
  }

  const base = viewTasks(S.view);
  renderTagBar(base);
  const list = filtered(base);
  let html = "";

  if (S.view.startsWith("project:")) {
    const p = projectById(Number(S.view.slice(8)));
    if (!p) { setView("projects"); return; }
    const up = projectChain(p.parent_id).reverse();
    html += `<div class="project-head" data-project="${p.id}">
      ${up.length ? `<p class="muted small part-of">Part of ${up.map((q) => `<button type="button" class="link open-subproject" data-project="${q.id}">${h(q.name)}</button>`).join(" › ")}</p>` : ""}
      ${p.notes ? `<div class="project-notes notes note-body">${showBody(p.notes)}</div>` : ""}
      <button class="link edit-project">Edit project</button>
      ${p.state !== "done"
        ? '<button class="link complete-project">Mark project complete</button>'
        : '<button class="link reopen-project">Reopen project</button>'}
    </div>`;
  }

  if (S.view === "someday" || S.view === "later") {
    const ps = byPriority(S.data.projects.filter((p) => p.state === S.view && inArea(p.area_id)));
    if (ps.length) html += '<h2 class="group">Projects</h2>' + ps.map(projectRow).join("") +
      '<h2 class="group">Actions</h2>';
  }

  if (S.view === "trash") {
    if (S.extraProjects.length) {
      html += '<h2 class="group">Projects</h2>' + S.extraProjects.map((p) =>
        `<div class="row project trashed" data-project="${p.id}"><div class="row-body">
          <div class="title">${h(p.name)}</div>
          ${p.inside ? `<div class="meta"><span>with ${p.inside} thing${p.inside > 1 ? "s" : ""} in it, back with it when it's restored</span></div>` : ""}</div>
          <button class="link restore-project">Restore</button></div>`).join("");
    }
    html += trashedNotes();
    if (S.extra.length || S.extraProjects.length || S.extraNotes.length) {
      html += '<p><button class="link danger empty-trash">Empty trash</button></p>';
    }
  }

  const showState = S.view.startsWith("project:") || S.view === "focus";
  let subs = 0;
  if (S.view === "calendar") {
    html += calendarAgenda(list);
  } else if (S.view === "focus" && eventsLeftToday().length) {
    html += '<h2 class="group">Today\'s calendar</h2>' + eventsLeftToday().map(eventRow).join("") +
      (list.length ? '<h2 class="group">Tasks</h2>' : "");
    html += list.map((t) => taskRow(t, { showState })).join("");
  } else if (S.view === "logbook") {
    // Newest first, under a heading per day completed.
    let day = null;
    for (const t of list) {
      const d = localStamp(t.completed_at)[0];
      if (d !== day) html += `<h2 class="group">${h(dayHeading(day = d))}</h2>`;
      html += taskRow(t, { showState });
    }
  } else if (S.view === "all") {
    for (const [st, label] of STATES) {
      const rows = list.filter((t) => t.state === st);
      if (rows.length) html += `<h2 class="group">${label}</h2>` + rows.map((t) => taskRow(t, {})).join("");
    }
  } else if (S.view.startsWith("project:") && !S.search && !S.tagFilter.size) {
    // Its tasks and subprojects, in their one order (drag either to change it).
    const steps = projectSteps(projectById(Number(S.view.slice(8))), list);
    subs = steps.length - list.length;
    html += steps.map((st) => (st.kind === "task" ? taskRow(st.x, { showState }) : projectRow(st.x, null, { draggable: true }))).join("");
  } else {
    html += list.map((t) => taskRow(t, { showState })).join("");
  }
  if (!list.length && !subs && S.view !== "calendar" && !(S.view === "trash" && (S.extraProjects.length || S.extraNotes.length))) {
    html += `<p class="empty">${S.search || S.tagFilter.size ? "Nothing matches." :
      { focus: "Star tasks to put them here.",
        recurring: "Set a task's Repeat to see its next copy here." }[S.view] ?? "Nothing here."}</p>`;
  }
  if (S.search.trim() && !S.search.trim().startsWith("/")) html += TASK_SEARCH_TIP;
  fillList(el, html);
  renderSelectBar();
}

// The editor (#detail) opens in the list, right under its row. The list is redrawn around
// it rather than through it, so it never leaves the page and keeps whatever is focused
// (a half-typed note) as rows change around it.
function fillList(el, html) {
  const detail = $("#detail");
  const tmp = document.createElement("template");
  tmp.innerHTML = html;
  const sel = S.selected;
  const rowOf = (root, kind, id) => id != null && root.querySelector(kind === "task"
    ? `.row.task[data-task="${id}"]` : `.row.project[data-project="${id}"], .project-head[data-project="${id}"]`);
  // If its task has left the list (moved to another one, say), stay where it was: under
  // the row that was above it.
  let before = detail.parentNode === el ? detail.previousElementSibling : null;
  if (before && sel && before.dataset.task === String(sel.id)) before = before.previousElementSibling;
  const anchor = (sel && rowOf(tmp.content, sel.kind, sel.id)) ||
    (before?.dataset.task && rowOf(tmp.content, "task", before.dataset.task));
  for (const n of [...el.childNodes]) if (n !== detail) n.remove();
  if (detail.parentNode !== el) el.append(detail);
  const nodes = [...tmp.content.childNodes];
  let top = anchor;
  while (top && top.parentNode !== tmp.content) top = top.parentNode;
  const i = top ? nodes.indexOf(top) + 1 : 0;
  detail.before(...nodes.slice(0, i));
  detail.after(...nodes.slice(i));
}

// Shows the open editor with its row, scrolling the list as little as needed.
function revealDetail() {
  const detail = $("#detail"), list = $("#list");
  if (detail.hidden || detail.parentNode !== list) return;
  const row = detail.previousElementSibling;
  if (row && detail.offsetHeight + row.offsetHeight > list.clientHeight) row.scrollIntoView({ block: "start" });
  else detail.scrollIntoView({ block: "nearest" });
}

// ---- links ---------------------------------------------------------------

// Saved web links in a tree of folders (a folder is a link without a url).
// Starred links show in the toolbar above every list.
const linkById = (id) => S.data.links.find((l) => l.id === id);
const linkKids = (parent) => S.data.links.filter((l) => l.parent_id === parent);  // in position order
const closedFolders = new Set((() => { try { return JSON.parse(load("closedFolders", "[]")); } catch { return []; } })());
const saveClosed = () => save("closedFolders", JSON.stringify([...closedFolders]));

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

// Every link and folder in tree order: each folder's contents right after it.
function linkTree(parent = null, out = []) {
  for (const l of linkKids(parent)) {
    out.push(l);
    if (l.folder) linkTree(l.id, out);
  }
  return out;
}

function linkPath(l) {
  const names = [];
  for (let p = linkById(l.parent_id); p; p = linkById(p.parent_id)) names.unshift(p.name);
  return names.join(" › ");
}

function insideOf(l, folderId) {
  for (let p = l; p; p = linkById(p.parent_id)) if (p.id === folderId) return true;
  return false;
}

// Calendar icon from SVG Repo (svgrepo.com), in its own colours.
const CALENDAR_ICON = `<svg viewBox="0 0 64 64" width="18" height="18" aria-hidden="true">
  <g> <g> <g> <path fill="#506C7F" d="M50,2c-0.553,0-1,0.447-1,1v1v2v4c0,0.553,0.447,1,1,1s1-0.447,1-1V6V4V3C51,2.447,50.553,2,50,2z"/> <path fill="#506C7F" d="M14,2c-0.553,0-1,0.447-1,1v1v2v4c0,0.553,0.447,1,1,1s1-0.447,1-1V6V4V3C15,2.447,14.553,2,14,2z"/> </g> <path fill="#F9EBB2" d="M62,60c0,1.104-0.896,2-2,2H4c-1.104,0-2-0.896-2-2V17h60V60z"/> <path fill="#F76D57" d="M62,15H2V8c0-1.104,0.896-2,2-2h7v4c0,1.657,1.343,3,3,3s3-1.343,3-3V6h30v4c0,1.657,1.343,3,3,3 s3-1.343,3-3V6h7c1.104,0,2,0.896,2,2V15z"/> <g> <path fill="#394240" d="M11,54h6c0.553,0,1-0.447,1-1v-5c0-0.553-0.447-1-1-1h-6c-0.553,0-1,0.447-1,1v5 C10,53.553,10.447,54,11,54z M12,49h4v3h-4V49z"/> <path fill="#394240" d="M23,54h6c0.553,0,1-0.447,1-1v-5c0-0.553-0.447-1-1-1h-6c-0.553,0-1,0.447-1,1v5 C22,53.553,22.447,54,23,54z M24,49h4v3h-4V49z"/> <path fill="#394240" d="M35,54h6c0.553,0,1-0.447,1-1v-5c0-0.553-0.447-1-1-1h-6c-0.553,0-1,0.447-1,1v5 C34,53.553,34.447,54,35,54z M36,49h4v3h-4V49z"/> <path fill="#394240" d="M11,43h6c0.553,0,1-0.447,1-1v-5c0-0.553-0.447-1-1-1h-6c-0.553,0-1,0.447-1,1v5 C10,42.553,10.447,43,11,43z M12,38h4v3h-4V38z"/> <path fill="#394240" d="M23,43h6c0.553,0,1-0.447,1-1v-5c0-0.553-0.447-1-1-1h-6c-0.553,0-1,0.447-1,1v5 C22,42.553,22.447,43,23,43z M24,38h4v3h-4V38z"/> <path fill="#394240" d="M35,43h6c0.553,0,1-0.447,1-1v-5c0-0.553-0.447-1-1-1h-6c-0.553,0-1,0.447-1,1v5 C34,42.553,34.447,43,35,43z M36,38h4v3h-4V38z"/> <path fill="#394240" d="M47,43h6c0.553,0,1-0.447,1-1v-5c0-0.553-0.447-1-1-1h-6c-0.553,0-1,0.447-1,1v5 C46,42.553,46.447,43,47,43z M48,38h4v3h-4V38z"/> <path fill="#394240" d="M11,32h6c0.553,0,1-0.447,1-1v-5c0-0.553-0.447-1-1-1h-6c-0.553,0-1,0.447-1,1v5 C10,31.553,10.447,32,11,32z M12,27h4v3h-4V27z"/> <path fill="#394240" d="M23,32h6c0.553,0,1-0.447,1-1v-5c0-0.553-0.447-1-1-1h-6c-0.553,0-1,0.447-1,1v5 C22,31.553,22.447,32,23,32z M24,27h4v3h-4V27z"/> <path fill="#394240" d="M35,32h6c0.553,0,1-0.447,1-1v-5c0-0.553-0.447-1-1-1h-6c-0.553,0-1,0.447-1,1v5 C34,31.553,34.447,32,35,32z M36,27h4v3h-4V27z"/> <path fill="#394240" d="M47,32h6c0.553,0,1-0.447,1-1v-5c0-0.553-0.447-1-1-1h-6c-0.553,0-1,0.447-1,1v5 C46,31.553,46.447,32,47,32z M48,27h4v3h-4V27z"/> <path fill="#394240" d="M60,4h-7V3c0-1.657-1.343-3-3-3s-3,1.343-3,3v1H17V3c0-1.657-1.343-3-3-3s-3,1.343-3,3v1H4 C1.789,4,0,5.789,0,8v52c0,2.211,1.789,4,4,4h56c2.211,0,4-1.789,4-4V8C64,5.789,62.211,4,60,4z M49,3c0-0.553,0.447-1,1-1 s1,0.447,1,1v7c0,0.553-0.447,1-1,1s-1-0.447-1-1V3z M13,3c0-0.553,0.447-1,1-1s1,0.447,1,1v7c0,0.553-0.447,1-1,1s-1-0.447-1-1 V3z M62,60c0,1.104-0.896,2-2,2H4c-1.104,0-2-0.896-2-2V17h60V60z M62,15H2V8c0-1.104,0.896-2,2-2h7v4c0,1.657,1.343,3,3,3 s3-1.343,3-3V6h30v4c0,1.657,1.343,3,3,3s3-1.343,3-3V6h7c1.104,0,2,0.896,2,2V15z"/> </g> </g> <g> <rect x="12" y="27" fill="#B4CCB9" width="4" height="3"/> <rect x="24" y="27" fill="#B4CCB9" width="4" height="3"/> <rect x="36" y="27" fill="#B4CCB9" width="4" height="3"/> <rect x="48" y="27" fill="#B4CCB9" width="4" height="3"/> <rect x="12" y="38" fill="#B4CCB9" width="4" height="3"/> <rect x="24" y="38" fill="#B4CCB9" width="4" height="3"/> <rect x="36" y="38" fill="#B4CCB9" width="4" height="3"/> <rect x="48" y="38" fill="#B4CCB9" width="4" height="3"/> <rect x="12" y="49" fill="#B4CCB9" width="4" height="3"/> <rect x="24" y="49" fill="#B4CCB9" width="4" height="3"/> <rect x="36" y="49" fill="#B4CCB9" width="4" height="3"/> </g> </g>
</svg>`;

function linkIconUrl(l) {
  return `${BASE}/api/links/${l.id}/icon.svg?v=${l.icon_version}`;
}

function renderToolbar() {
  const el = $("#toolbar");
  const starred = linkTree().filter((l) => l.starred);
  const cal = S.data.google.connected;
  if (!cal && S.view === "calendar") S.view = "focus";
  el.hidden = !starred.length && !cal;
  el.innerHTML = (cal ? `<button type="button" class="tb-calendar${S.view === "calendar" ? " active" : ""}"
      title="Calendar: the next two weeks" aria-label="Calendar">${CALENDAR_ICON}</button>` : "") +
    starred.map((l) => l.icon_version
      ? `<a class="tb-icon" href="${h(l.url)}" target="_blank" rel="noopener noreferrer" title="${h(l.name)}">
          <img src="${linkIconUrl(l)}" alt="${h(l.name)}"></a>`
      : `<a href="${h(l.url)}" target="_blank" rel="noopener noreferrer" title="${h(l.url)}">${h(l.name)}</a>`).join("");
}

function linkRow(l, depth, withPath = false) {
  const pad = `style="padding-left:${(8 + depth * 22) / 16}rem"`;
  const actions = (extra = "") => `<span class="link-actions">${extra}
    <button type="button" class="icon edit-link" title="Edit" aria-label="Edit">✎</button>
    <button type="button" class="icon delete-link" title="Delete" aria-label="Delete">🗑</button></span>`;
  if (l.folder) {
    const open = !closedFolders.has(l.id);
    const n = linkKids(l.id).length;
    return `<div class="row link-row folder" data-link="${l.id}" draggable="true" ${pad}>
      <button type="button" class="icon fold" aria-expanded="${open}" aria-label="${open ? "Close" : "Open"} folder">${open ? "▾" : "▸"}</button>
      <span class="link-name">📁 ${h(l.name)}</span>${n ? `<span class="count">${n}</span>` : ""}
      ${actions('<button type="button" class="icon add-in" title="Add a link in this folder" aria-label="Add a link in this folder">+</button>')}
    </div>`;
  }
  const where = withPath ? [linkPath(l), hostOf(l.url)].filter(Boolean).join(" · ") : hostOf(l.url);
  return `<div class="row link-row" data-link="${l.id}" draggable="true" ${pad}>
    <button type="button" class="star ${l.starred ? "on" : ""}" title="${l.starred ? "In the toolbar" : "Add to the toolbar"}"
      aria-label="${l.starred ? "Remove from the toolbar" : "Add to the toolbar"}">★</button>
    ${l.icon_version ? `<img class="link-icon-img" src="${linkIconUrl(l)}" alt="">` : ""}
    <a class="link-name" href="${h(l.url)}" target="_blank" rel="noopener noreferrer" title="${h(l.url)}">${h(l.name)}</a>
    <span class="link-host">${h(where)}</span>
    ${actions()}
  </div>`;
}

function renderLinks(el) {
  $("#tag-bar").innerHTML = "";
  // Keep what's being typed in the add form across redraws.
  const prev = $("#link-add");
  const kept = prev && { url: prev.elements.url.value, name: prev.elements.name.value,
    focus: prev.contains(document.activeElement) && document.activeElement.name };
  if (S.linkTarget != null && !linkById(S.linkTarget)) S.linkTarget = null;
  const target = linkById(S.linkTarget);
  let html = `<form id="link-add" autocomplete="off">
      <input name="url" placeholder="Paste a web address" aria-label="Web address" required>
      <input name="name" placeholder="Name (optional)" aria-label="Name">
      <button class="primary">Add link</button>
      <button type="button" class="new-folder">New folder</button>
    </form>
    ${target ? `<p class="link-target">Adding to 📁 ${h(target.name)}
      <button type="button" class="link clear-target">Add at the top level instead</button></p>` : ""}`;
  const match = searchTest();
  if (match) {
    const hits = S.data.links.filter((l) => !l.folder && match(l.name, l.url));
    html += hits.map((l) => linkRow(l, 0, true)).join("") || '<p class="empty">Nothing matches.</p>';
  } else if (!S.data.links.length) {
    html += `<p class="empty">Save the pages you often need here, in folders if you like.
      Star a link to put it in the toolbar at the top of the page.</p>`;
  } else {
    const rows = [];
    const walk = (parent, depth) => {
      for (const l of linkKids(parent)) {
        rows.push(linkRow(l, depth));
        if (l.folder && !closedFolders.has(l.id)) walk(l.id, depth + 1);
      }
    };
    walk(null, 0);
    html += `<div class="link-tree">${rows.join("")}</div>
      <div class="link-end">Drop here to move to the top level</div>
      <p class="muted small">Drag to rearrange: onto a folder to put it inside, onto anything else to put it just above.</p>`;
  }
  el.innerHTML = html;
  if (kept) {
    const f = $("#link-add");
    f.elements.url.value = kept.url;
    f.elements.name.value = kept.name;
    if (kept.focus) f.elements[kept.focus].focus();
  }
}

async function linkChange(method, path, body) {
  const out = await api(method, path, body);
  await refresh();
  return out;
}

async function addLink(form) {
  const url = form.elements.url.value.trim();
  if (!url) return;
  await linkChange("POST", "/links", { url, name: form.elements.name.value.trim(), parent_id: S.linkTarget });
  form = $("#link-add");
  form.elements.url.value = form.elements.name.value = "";
  form.elements.url.focus();
}

async function newFolder() {
  const name = prompt("Folder name")?.trim();
  if (!name) return;
  const f = await linkChange("POST", "/links", { folder: true, name, parent_id: S.linkTarget });
  S.linkTarget = f.id;  // ready to add links into it
  render();
}

async function deleteLink(l) {
  const inside = linkTree(l.id).length;
  if (inside && !confirm(`Delete the folder “${l.name}” and the ${inside} item${inside > 1 ? "s" : ""} in it?`)) return;
  const siblings = linkKids(l.parent_id);
  const next = siblings[siblings.indexOf(l) + 1];
  await linkChange("DELETE", `/links/${l.id}`);
  if (inside) return toast("Folder deleted.");
  toast(`Deleted “${l.name}”.`, () => linkChange("POST", "/links", {
    folder: l.folder, name: l.name, url: l.url, starred: l.starred, parent_id: l.parent_id, before: next?.id ?? null }));
}

function openLinkDialog(l) {
  const dlg = $("#link-dialog");
  const f = dlg.querySelector("form");
  dlg.querySelector("h2").textContent = l.folder ? "Folder" : "Link";
  f.elements.name.value = l.name;
  f.elements.url.value = l.url || "";
  f.elements.url.required = !l.folder;
  f.elements.starred.checked = l.starred;
  showLinkIcon(l);
  dlg.querySelectorAll(".link-only").forEach((x) => { x.hidden = l.folder; });
  // Any folder except this one and those inside it.
  const folders = linkTree().filter((x) => x.folder && !insideOf(x, l.id));
  f.elements.parent.innerHTML = '<option value="">Top level</option>' + folders.map((x) =>
    `<option value="${x.id}">${" ".repeat(linkPath(x) ? linkPath(x).split(" › ").length : 0)}📁 ${h(x.name)}</option>`).join("");
  f.elements.parent.value = l.parent_id ?? "";
  dlg.dataset.link = l.id;
  dlg.returnValue = "";
  dlg.showModal();
}

function showLinkIcon(l) {
  const dlg = $("#link-dialog");
  dlg.querySelector(".link-icon .icon-slot").innerHTML = l.icon_version ? `<img src="${linkIconUrl(l)}" alt="">` : "";
  dlg.querySelector(".link-icon-remove").hidden = !l.icon_version;
}

// Icons save straight away (like areas' icons), not with the dialog's Save.
async function setLinkIcon(body) {
  const l = linkById(Number($("#link-dialog").dataset.link));
  if (!l) return;
  if (body) Object.assign(l, await api("PUT", `/links/${l.id}/icon`, body));
  else { await api("DELETE", `/links/${l.id}/icon`); l.icon_version = null; }
  showLinkIcon(l);
  render();
  toast(body ? "Icon saved." : "Icon removed.");
}

function bindLinks() {
  const dlg = $("#link-dialog");
  dlg.addEventListener("change", async (e) => {
    const file = e.target.classList.contains("link-icon-file") && e.target.files[0];
    if (!file) return;
    e.target.value = "";
    if (file.size > 200_000) return toast("That SVG is too big (200 KB at most).");
    await setLinkIcon({ svg: await file.text() });
  });
  dlg.addEventListener("click", async (e) => {
    if (e.target.closest(".link-icon-url")) {
      const url = prompt("Address of the SVG icon (https://…)");
      if (url?.trim()) await setLinkIcon({ url: url.trim() });
    } else if (e.target.closest(".link-icon-remove")) {
      await setLinkIcon(null);
    }
  });

  const list = $("#list");
  list.addEventListener("submit", (e) => {
    if (e.target.id !== "link-add") return;
    e.preventDefault();
    addLink(e.target);
  });
  list.addEventListener("click", (e) => {
    if (S.view !== "links") return;
    const b = e.target.closest("button");
    if (b?.classList.contains("new-folder")) return newFolder();
    if (b?.classList.contains("clear-target")) { S.linkTarget = null; return render(); }
    const row = e.target.closest(".link-row");
    if (!row) return;
    const l = linkById(Number(row.dataset.link));
    if (!l) return;
    if (b?.classList.contains("star")) return linkChange("PATCH", `/links/${l.id}`, { starred: !l.starred });
    if (b?.classList.contains("edit-link")) return openLinkDialog(l);
    if (b?.classList.contains("delete-link")) return deleteLink(l);
    if (b?.classList.contains("add-in")) {
      S.linkTarget = l.id;
      closedFolders.delete(l.id);
      saveClosed();
      render();
      return $("#link-add").elements.url.focus();
    }
    // Clicking a folder (its arrow or name) opens or closes it.
    if (l.folder && (!b || b.classList.contains("fold"))) {
      if (closedFolders.has(l.id)) closedFolders.delete(l.id); else closedFolders.add(l.id);
      saveClosed();
      renderList();
    }
  });

  $("#link-dialog").addEventListener("close", async () => {
    const dlg = $("#link-dialog");
    if (dlg.returnValue !== "ok") return;
    const l = linkById(Number(dlg.dataset.link));
    if (!l) return;
    const f = dlg.querySelector("form");
    const changes = { name: f.elements.name.value };
    if (!l.folder) Object.assign(changes, { url: f.elements.url.value, starred: f.elements.starred.checked });
    const parent = f.elements.parent.value ? Number(f.elements.parent.value) : null;
    if (parent !== l.parent_id) Object.assign(changes, { parent_id: parent, before: null });
    await linkChange("PATCH", `/links/${l.id}`, changes);
  });

  // Drag to rearrange: onto a folder to put it inside (its top edge: just above it),
  // onto a link to put it just above, onto the strip below the tree for the top level.
  let dragging = null;
  const dropSpot = (e) => {
    const end = e.target.closest(".link-end");
    if (end) return { el: end, parent_id: null, before: null };
    const row = e.target.closest(".link-row");
    const t = row && linkById(Number(row.dataset.link));
    if (!t || insideOf(t, dragging)) return null;
    const r = row.getBoundingClientRect();
    if (t.folder && e.clientY > r.top + r.height * 0.3) return { el: row, into: true, parent_id: t.id, before: null };
    return { el: row, parent_id: t.parent_id, before: t.id };
  };
  const clear = () => document.querySelectorAll(".link-row.drop-before, .link-row.drop-into, .link-end.drop-into")
    .forEach((x) => x.classList.remove("drop-before", "drop-into"));
  const endDrag = () => {
    dragging = null;
    clear();
    document.body.classList.remove("is-dragging-link");
    document.querySelectorAll(".link-row.dragging").forEach((x) => x.classList.remove("dragging"));
  };
  list.addEventListener("dragstart", (e) => {
    const row = e.target.closest(".link-row");
    if (!row || S.search) return;
    dragging = Number(row.dataset.link);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", linkById(dragging)?.url || linkById(dragging)?.name || "");
    row.classList.add("dragging");
    document.body.classList.add("is-dragging-link");
  });
  list.addEventListener("dragover", (e) => {
    if (dragging == null) return;
    const spot = dropSpot(e);
    clear();
    if (!spot) return;
    e.preventDefault();
    spot.el.classList.add(spot.into ? "drop-into" : "drop-before");
  });
  list.addEventListener("drop", (e) => {
    if (dragging == null) return;
    const spot = dropSpot(e);
    const id = dragging;
    endDrag();
    if (!spot || spot.before === id) return;
    e.preventDefault();
    if (spot.into) { closedFolders.delete(spot.parent_id); saveClosed(); }
    linkChange("PATCH", `/links/${id}`, { parent_id: spot.parent_id, before: spot.before });
  });
  document.addEventListener("dragend", endDrag);
}

// ---- calendar ------------------------------------------------------------

// Events from the user's Google calendars on a day (all-day ones span several).
function eventsOn(day) {
  return (S.data.events || []).filter((e) => e.date === day || (e.date < day && e.last_date >= day));
}

// Today's events that haven't ended yet (Focus): a timed one goes once its end time has
// passed (or its start time, without one); all-day ones stay all day.
function eventsLeftToday() {
  const now = nowStamp();
  return eventsOn(today()).filter((e) => !e.time ||
    `${e.last_date}T${e.end_time || (e.last_date === e.date ? e.time : "23:59")}` > now);
}

function eventRow(e) {
  const time = e.time ? fmtTime(e.time) + (e.end_time ? "–" + fmtTime(e.end_time) : "") : "All day";
  const tag = e.link ? "a" : "div";
  return `<${tag} class="row event" ${e.link ? `href="${h(e.link)}" target="_blank" rel="noopener"` : ""}
      title="Open in Google Calendar">
    <span class="ev-dot" style="background:${e.color || "var(--accent)"}"></span>
    <div class="row-body">
      <div class="title">${h(e.title)}</div>
      <div class="meta"><span>${time}</span>${e.calendar ? `<span>${h(e.calendar)}</span>` : ""}</div>
    </div></${tag}>`;
}

function calendarAgenda(tasks) {
  const t0 = today();
  let html = "";
  for (let i = 0; i < CALENDAR_DAYS; i++) {
    const day = addDays(t0, i);
    const evs = eventsOn(day);
    const ts = tasks.filter((t) => taskDay(t) === day);
    if (!evs.length && !ts.length && i > 0) continue;
    html += `<h2 class="group">${h(dayHeading(day))}</h2>` + evs.map(eventRow).join("") +
      ts.map((t) => taskRow(t, { showState: true })).join("") +
      (!evs.length && !ts.length ? '<p class="empty small">Nothing today.</p>' : "");
  }
  const g = S.data.google;
  html += `<p class="muted small cal-foot">Next ${CALENDAR_DAYS} days. Tasks show on their due date,
    else their start date${g.last_sync ? `; last synced with Google ${h(fmtAgo(g.last_sync))}` : ""}.</p>`;
  return html;
}

// "2026-10-26 18:03:00" (UTC) -> "3 minutes ago"
function fmtAgo(utc) {
  const mins = Math.round((Date.now() - Date.parse(utc.replace(" ", "T") + "Z")) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  return new Date(utc.replace(" ", "T") + "Z").toLocaleString();
}

function options(pairs, value) {
  return pairs.map(([v, label]) =>
    `<option value="${h(v)}" ${String(v) === String(value ?? "") ? "selected" : ""}>${h(label)}</option>`
  ).join("");
}

// "every:9" means every 9 days.
// "every:9" (days), "every:2w", "every:3m", "every:1y" → { n, unit } (unit d, w, m or y).
const EVERY_UNITS = { d: "day", w: "week", m: "month", y: "year" };
function parseEvery(repeat) {
  const m = /^every:(\d+)([wmy]?)$/.exec(repeat || "");
  return m && { n: Number(m[1]), unit: m[2] || "d" };
}
// "days:0,2,4" (Monday 0 … Sunday 6) → [0, 2, 4]: on those days of the week.
const WEEK = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
function parseDays(repeat) {
  const m = /^days:([0-6](,[0-6])*)$/.exec(repeat || "");
  return m && m[1].split(",").map(Number);
}
const daysValue = (days) => "days:" + [...new Set(days)].sort().join(",");
// "Mon, Wed and Fri" ("or", for the gap between copies).
const dayList = (days, and = "and") => days.map((d) => WEEK[d]).join(", ").replace(/, ([^,]+)$/, ` ${and} $1`);
// The day of the week of an ISO date, Monday 0.
const weekDay = (iso) => (new Date(iso + "T12:00:00").getDay() + 6) % 7;
// "nth:1:0" → { n: 1, day: 0 }: monthly, on the first Monday (n -1: the last).
const WEEK_LONG = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const NTHS = [[1, "first"], [2, "second"], [3, "third"], [4, "fourth"], [-1, "last"]];
function parseNth(repeat) {
  const m = /^nth:(-1|[1-4]):([0-6])$/.exec(repeat || "");
  return m && { n: Number(m[1]), day: Number(m[2]) };
}
const nthName = (n) => NTHS.find(([k]) => k === n)[1];
// The nth weekday of the month that an ISO date is (a fifth one: the last).
function nthOf(iso) {
  const n = Math.ceil(Number(iso.slice(8, 10)) / 7);
  return `nth:${n > 4 ? -1 : n}:${weekDay(iso)}`;
}

function repeatLabel(repeat) {
  const days = parseDays(repeat);
  if (days) return `every ${dayList(days)}`;
  const nth = parseNth(repeat);
  if (nth) return `every ${nthName(nth.n)} ${WEEK_LONG[nth.day]} of the month`;
  const e = parseEvery(repeat);
  if (!e) return repeat;
  return e.n === 1 ? `every ${EVERY_UNITS[e.unit]}` : `every ${e.n} ${EVERY_UNITS[e.unit]}s`;
}
// How far apart copies are: "a week", "2 weeks", "the next weekday".
function repeatGap(repeat) {
  const days = parseDays(repeat);
  if (days) return `the next ${dayList(days, "or")}`;
  const nth = parseNth(repeat);
  if (nth) return `the ${nthName(nth.n)} ${WEEK_LONG[nth.day]} of the next month`;
  const e = parseEvery(repeat);
  if (e) return e.n === 1 ? `a ${EVERY_UNITS[e.unit]}` : `${e.n} ${EVERY_UNITS[e.unit]}s`;
  return { daily: "a day", weekdays: "the next weekday", weekly: "a week", monthly: "a month", yearly: "a year" }[repeat] || repeat;
}

// "9", "9 days", "2 weeks", "3 mo", "1y" → a repeat value (bare numbers are days), or null.
function readEvery(text) {
  const m = /^\s*(\d{1,3})\s*(d|days?|w|wks?|weeks?|m|mo|mos|months?|y|yrs?|years?)?\s*$/i.exec(text || "");
  if (!m || +m[1] < 1) return null;
  return everyValue(+m[1], (m[2] || "d")[0].toLowerCase());
}

function repeatOptions(current) {
  return [...REPEATS.map((r) => [r, r || "Never"]),
    ...(parseEvery(current) || parseDays(current) || parseNth(current) ? [[current, repeatLabel(current)]] : []),
    ["days", "On certain days of the week…"],
    ["nth", "Monthly on a weekday (first Monday…)…"],
    ["every", "Custom: every N days, weeks, months…"]];
}

// Which weekday of the month an nth:… repeat is on: two menus (first … last, Monday … Sunday).
function nthPicker(repeat) {
  const nth = parseNth(repeat);
  return nth ? `<div class="two nth-pick">
    <label>On the <select class="nth-n">${options(NTHS, nth.n)}</select></label>
    <label>day <select class="nth-day">${options(WEEK_LONG.map((d, i) => [i, d]), nth.day)}</select></label>
  </div>` : "";
}

// The days of the week of a days:… repeat, as buttons to switch each on or off.
function weekDaysPicker(repeat) {
  const on = parseDays(repeat);
  return on ? `<div class="week-days" role="group" aria-label="Repeat on">${WEEK.map((d, i) =>
    `<button type="button" class="wd ${on.includes(i) ? "on" : ""}" data-wd="${i}" aria-pressed="${on.includes(i)}">${d}</button>`).join("")}</div>` : "";
}

function repeatNote(t) {
  if (t.completed_at) return "";
  if (t.repeat_from === "done") return `The next copy is made when you complete this one, ${repeatGap(t.repeat)} after that day.`;
  if (t.series_index === t.series_latest) {
    return "This is the newest copy. Changing its dates changes the schedule from here on.";
  }
  const next = S.data.tasks.find((x) => x.series_id === t.series_id && x.series_index > t.series_index);
  return "Changing dates here moves only this copy." + (next
    ? ` To change the schedule, edit the next one (starts ${fmtDate(next.start_date)}).` : "");
}

function renderDetail() {
  const el = $("#detail");
  const sel = S.selected;
  const item = sel && (sel.kind === "task" ? taskById(sel.id) : projectById(sel.id));
  if (!item) { el.hidden = true; S.selected = null; return; }
  el.hidden = false;
  if (el.dataset.key === `${sel.kind}:${sel.id}` && el.contains(document.activeElement)) {
    return; // don't clobber what the user is typing
  }
  el.dataset.key = `${sel.kind}:${sel.id}`;
  const areaOpts = [["", "No area"], ...S.data.areas.map((a) => [a.id, a.name])];

  if (sel.kind === "project") {
    const p = item;
    el.innerHTML = `
      <div class="detail-head"><span>Project</span><button class="icon close" aria-label="Close">✕</button></div>
      <input class="d-title" data-field="name" value="${h(p.name)}" aria-label="Name">
      <div class="d-cols"><div class="d-main">
      ${detailText(p, "project")}
      ${attachmentsSection(p, "project")}
      ${subprojectsField(p)}
      ${linkedNotes(p, "project")}
      </div><div class="d-side">
      <section class="d-group" aria-label="About the project">
        <label>Status <select data-field="state">${options(
          [["active", "Active"], ["someday", "Someday"], ["later", "Later"], ["done", "Completed"]], p.state)}</select></label>
        <label>Area <select data-field="area_id">${options(areaOpts, p.area_id)}</select></label>
        <label title="A project can be a part of a bigger one">Part of <select data-field="parent_id">${options(
          [["", "No project (top level)"], ...parentChoices(p).map((q) => [q.id, q.name])], p.parent_id ?? "")}</select></label>
        <label title="Its tasks show under these tags too">Tags <input data-field="tags" value="${h((p.tags || []).join(", "))}" list="tag-list" placeholder="comma, separated"></label>
        <datalist id="tag-list">${S.data.tags.map((x) => `<option value="${h(x.name)}">`).join("")}</datalist>
        <div class="two">
          <label>Due <input type="date" data-field="due_date" value="${h(p.due_date || "")}"></label>
          <label title="Higher comes first on the Projects page">Priority <input type="number" data-field="priority" step="1"
            min="-${PRIORITY_MAX}" max="${PRIORITY_MAX}" value="${p.priority || 0}"></label>
        </div>
        <label class="check"><input type="checkbox" data-field="sequential" ${p.sequential ? "checked" : ""}>
          Sequential (only the first action shows in Queue)</label>
        <label class="check"><input type="checkbox" data-field="focus" ${p.focus ? "checked" : ""}> Focus</label>
      </section>
      <section class="d-group" aria-label="Blocked by and related">
        ${blockersField(p, "project")}
        ${relatedField(p, "project")}
      </section>
      </div></div>
      <div class="detail-actions">
        <button class="open-project">Open</button>
        ${p.template_id && templateById(p.template_id)
          ? `<button class="update-template" title="Make the template match this project">Update template “${h(templateById(p.template_id).name)}”</button>` : ""}
        <button class="save-template">Save as ${p.template_id && templateById(p.template_id) ? "new " : ""}template</button>
        ${projectEmpty(p) ? '<button class="convert-to" data-to="task">Make it a task</button><button class="convert-to" data-to="note">Make it a note</button>' : ""}
        <button class="danger delete-project">Delete</button>
      </div>`;
    mountDetailText(el, "project", p.id);
    return;
  }

  const t = item;
  const projOpts = [["", "No project"], ...S.data.projects
    .filter((p) => p.state !== "done" || p.id === t.project_id).map((p) => [p.id, p.name])];
  // The rarer details fold away under More, open when any is set (or as last left on this device).
  const more = [t.priority ? `priority ${t.priority}` : "", t.minutes ? `${t.minutes}m` : "",
    t.energy ? `${t.energy} energy` : "", refs(t, "blocked_by").length ? `blocked by ${refs(t, "blocked_by").length}` : "",
    refs(t, "related").length ? `${refs(t, "related").length} related` : "",
    t.spent ? `${fmtSpent(t.spent)} spent` : ""].filter(Boolean);
  el.innerHTML = `
    <div class="detail-head"><span>${t.completed_at ? "Completed" : t.deleted_at ? "In trash" : "Task"}</span>
      <span><button class="icon d-star ${t.focus ? "on" : ""}" title="${t.focus ? "In Focus: click to take it out" : "Put it in Focus"} (S)"
        aria-pressed="${!!t.focus}">★ Focus</button>
      <button class="icon close" aria-label="Close">✕</button></span></div>
    <input class="d-title" data-field="title" value="${h(t.title)}" aria-label="Title">
    <div class="state-picker">${STATES.map(([s, label]) =>
      `<button data-state="${s}" class="${t.state === s ? "on" : ""}">${label}</button>`).join("")}</div>
    <div class="d-cols"><div class="d-main">
    ${t.state === "waiting" ? `<label>Waiting for <input data-field="waiting_for" value="${h(t.waiting_for)}" placeholder="Who or what"></label>` : ""}
    ${detailText(t, "task")}
    ${attachmentsSection(t, "task")}
    ${linkedNotes(t, "task")}
    </div><div class="d-side">
    <section class="d-group" aria-label="Where it belongs">
      <label>Project <select data-field="project_id">${options(projOpts, t.project_id)}</select></label>
      ${t.project_id ? "" : `<label>Area <select data-field="area_id">${options(areaOpts, t.area_id)}</select></label>`}
      <label>Tags <input data-field="tags" value="${h(t.tags.join(", "))}" list="tag-list" placeholder="comma, separated"></label>
      <datalist id="tag-list">${S.data.tags.map((x) => `<option value="${h(x.name)}">`).join("")}</datalist>
      ${peopleField(t)}
    </section>
    <section class="d-group" aria-label="When">
      <h3>When</h3>
      <div class="two">
        <label title="Not before: it waits in Scheduled until then">Starts <input type="date" data-field="start_date" value="${h(t.start_date || "")}"></label>
        <label>at <input type="time" data-field="start_time" value="${h(t.start_time || "")}" ${t.start_date ? "" : "disabled"}></label>
      </div>
      <label title="Must be done by: in Focus from that day, red once overdue">Due <input type="date" data-field="due_date" value="${h(t.due_date || "")}"></label>
      ${reminderField(t)}
      <label>Repeat <select data-field="repeat">${options(repeatOptions(t.repeat), t.repeat)}</select></label>
      ${weekDaysPicker(t.repeat)}${nthPicker(t.repeat)}
      ${t.repeat ? `<label>Counting from <select data-field="repeat_from">${options(
        [["calendar", "The calendar (on schedule)"], ["done", "When I complete it"]], t.repeat_from)}</select></label>
        ${t.repeat_from === "done" ? "" : `<label>If missed <select data-field="on_miss">${options(
        [["keep", "Keep it, alongside the new one"], ["replace", "Replace it with the new one"]], t.on_miss)}</select></label>`}
        <label class="check"><input type="checkbox" data-field="carry_files" ${t.carry_files ? "checked" : ""}>
          Give each new copy this task's files</label>
        <p class="muted small">${repeatNote(t)}</p>` : ""}
    </section>
    <details class="d-group d-more" ${more.length || load("editorMore", "") === "open" ? "open" : ""}>
      <summary><h3>More</h3> <span class="muted small">${h(more.join(" · ") || "priority, time, energy, blocked by, related")}</span></summary>
      <label>Priority <input type="number" data-field="priority" step="1" min="-${PRIORITY_MAX}" max="${PRIORITY_MAX}" value="${t.priority}"></label>
      <div class="two">
        <label>Time <select data-field="minutes">${options(
          [["", "—"], [5, "5m"], [15, "15m"], [30, "30m"], [60, "1h"], [120, "2h"], [240, "4h"]], t.minutes)}</select></label>
        <label>Energy <select data-field="energy">${options(
          [["", "—"], ["low", "Low"], ["medium", "Medium"], ["high", "High"]], t.energy)}</select></label>
      </div>
      ${blockersField(t, "task")}
      ${relatedField(t, "task")}
      ${t.spent ? `<p class="muted small spent">Time spent: ${fmtSpent(t.spent)} · <button type="button" class="link reset-spent">Reset</button></p>` : ""}
    </details>
    </div></div>
    <div class="detail-actions">
      ${t.deleted_at
        ? '<button class="restore-task">Restore</button><button class="danger purge-task">Delete forever</button>'
        : '<button class="start-timer" title="Work on this with a timer (T)">▶ Focus timer</button>' +
          (t.completed_at || t.series_id ? "" : '<button class="convert-task" title="Make it a project, with its checklist as tasks">Convert to project</button>' +
            '<button class="task-to-note" title="Make it a note, with its notes, tags and files">Make it a note</button>') +
          '<button class="danger delete-task">Move to trash</button>'}
    </div>
    <p class="muted small">Created ${fmtDate(utcToLocalInput(t.created_at).slice(0, 10))}</p>`;
  mountDetailText(el, "task", t.id);
}

// ---- a task's or project's text (the editor is editor.js's, as a note's is) ----------

function detailText(x, kind) {
  const locked = !!(x.completed_at || x.deleted_at);
  return `<div class="d-text${locked ? " locked" : ""}">
    ${locked ? "" : editorTools()}
    <div class="ne-body note-body" contenteditable="${!locked}" role="textbox" aria-multiline="true"
      aria-label="Notes" data-placeholder="Notes" spellcheck="true"></div>
    ${locked ? "" : editorImageBar(kind)}
  </div>`;
}

// The text's editor host (editor.js) for the task or project kind id in the details el.
function mountDetailText(el, kind, id) {
  const root = $(".d-text", el);
  const item = () => (kind === "task" ? taskById(id) : projectById(id));
  const host = {
    root, kind, timer: 0,
    get item() { return item(); },
    changed() { clearTimeout(host.timer); host.timer = setTimeout(() => host.save(), 700); },
    async save() {
      clearTimeout(host.timer);
      const x = item(), html = editorText(host);
      if (!x || html === x.notes) return;
      if (kind === "task") await patchTask(id, { notes: html }, { quiet: true });
      else await patchProject(id, { notes: html }, { quiet: true });
    },
    uploaded(data) { if (kind === "project") replaceProject(data); else replaceTask(data); },
    filesChanged() {
      const x = item(), section = $(".attachments", el);
      if (x && section?.isConnected) section.outerHTML = attachmentsSection(x, kind, placedIds(editorText(host)));
    },
    close() { S.selected = null; render(); },
  };
  root.host = host;
  startEditor(host, item().notes);
}

// Puts the cursor at the end of the open item's text (or its HTML box).
function focusNotes() {
  const root = $("#detail .d-text");
  if (!root?.host) return;
  const box = $(".ne-source", root);
  if (box?.cm) { box.cm.focus(); box.cm.setCursor(box.cm.lastLine(), box.cm.getLine(box.cm.lastLine()).length); return; }
  if (box && !box.hidden) { box.focus(); return; }
  const body = $(".ne-body", root);
  body.focus();
  const r = document.createRange();
  r.selectNodeContents(body);
  r.collapse(false);
  getSelection().removeAllRanges();
  getSelection().addRange(r);
}

// ---- actions -------------------------------------------------------------

function setView(view) {
  S.view = view;
  S.selected = null;  // (a different list: the open task's details close)
  S.picked.clear();
  save("view", view);
  S.tagFilter.clear();
  S.extra = [];
  S.extraProjects = [];
  S.extraNotes = [];
  document.body.classList.remove("nav-open");
  if (view === "logbook" || view === "trash") refresh(); else render();
}

function select(kind, id) {
  S.selected = { kind, id };
  $("#detail").dataset.key = "";
  render();
  revealDetail();
}

async function completeTask(id, done) {
  await patchTask(id, { completed: done });
  if (done) toast("Completed.", () => patchTask(id, { completed: false }));
}

async function trashTask(id) {
  await patchTask(id, { deleted: true });
  if (S.selected?.id === id) S.selected = null;
  render();
  toast("Moved to trash.", () => patchTask(id, { deleted: false }));
}

// ---- quick add (parseQuickAdd: quickadd.js) ----------------------------------

function renderQuickWhen() {
  const el = $("#quick-when");
  const parsed = parseQuickAdd($("#quick-add-input").value);
  const f = whenFields(parsed);
  const parts = [];
  if (f.start_date) {
    const past = `${f.start_date}T${f.start_time || "00:00"}` <= nowStamp();
    parts.push(`${past ? "Started" : "Starts"} ` +
      dayHeading(f.start_date) + (f.start_time ? " at " + fmtTime(f.start_time) : ""));
  }
  if (f.focus) parts.push("★ Today (Focus)");
  if (f.due_date) parts.push("Due " + dayHeading(f.due_date));
  if (parsed.repeat) parts.push("↻ " + repeatLabel(parsed.repeat));
  const people = parsed.people.map((id) => contactById(id).name);
  el.hidden = !parts.length && !people.length;
  el.textContent = [parts.length ? "📅 " + parts.join(" · ") : "", people.length ? "👤 " + people.join(", ") : ""]
    .filter(Boolean).join("  ");
}

async function quickAdd(text, { open = false } = {}) {
  const parsed = parseQuickAdd(text);
  if (!parsed.title) return;
  const task = { title: parsed.title, tags: parsed.tags };
  if (S.view.startsWith("project:")) {
    task.project_id = Number(S.view.slice(8));
    task.state = "next";
  } else if (STATE_LABEL[S.view]) {
    task.state = S.view;
  } else if (S.view === "focus") {
    task.state = "next";
    task.focus = true;
  } else if (S.view === "recurring") {
    task.state = "scheduled";
    task.repeat = "weekly";
  }
  if (parsed.state) task.state = parsed.state;
  if (parsed.focus) task.focus = true;
  if (parsed.priority) task.priority = parsed.priority;
  if (parsed.repeat) task.repeat = parsed.repeat;
  if (parsed.people.length) task.people = parsed.people;
  Object.assign(task, whenFields(parsed));
  if (task.state === "scheduled" && !task.start_date) task.start_date = addDays(today(), 1);
  // A task in a project takes the project's area.
  if (!task.project_id && (parsed.area_id || chosenArea())) task.area_id = parsed.area_id || chosenArea();
  const created = await api("POST", "/tasks", task);
  if (!taskById(created.id)) S.data.tasks.push(created);  // (offline, it's already there)
  if (parsed.tags.some((tag) => !S.data.tags.some((x) => x.name === tag))) await refresh();
  else render();
  // A new scheduled task opens straight away so its start date (or repeat) can be set.
  if (open || (created.state === "scheduled" && (!parsed.start_date || created.repeat))) {
    select("task", created.id);
    if (created.state !== "scheduled") focusNotes();
    else $(created.repeat ? '#detail select[data-field="repeat"]' : '#detail input[data-field="start_date"]').focus();
  }
}

async function newProject(parent = null) {
  if (S.data.templates?.length && !parent) return openNewProject();
  const name = prompt(parent ? `New subproject of “${parent.name}”` : "Project name");
  if (!name?.trim()) return;
  const p = await api("POST", "/projects", {
    name: name.trim(), area_id: parent ? parent.area_id : chosenArea(), parent_id: parent?.id ?? null,
  });
  if (!projectById(p.id)) S.data.projects.push(p);
  setView(`project:${p.id}`);
}

// ---- subprojects ----
// A project can be a part of another (parent_id), at any depth. app.py's check_parent refuses
// loops; projectChain (above) walks outward, these inward.

const subprojects = (p) => S.data.projects.filter((q) => q.parent_id === p.id && !q.deleted_at);

// Everything in a project, at any depth: [tasks, projects].
function projectInside(p, seen = new Set([p.id])) {
  const tasks = S.data.tasks.filter((t) => t.project_id === p.id), projects = [];
  for (const q of subprojects(p)) {
    if (seen.has(q.id)) continue;
    seen.add(q.id);
    const [ts, ps] = projectInside(q, seen);
    tasks.push(...ts);
    projects.push(q, ...ps);
  }
  return [tasks, projects];
}

const projectEmpty = (p) => !S.data.tasks.some((t) => t.project_id === p.id) && !subprojects(p).length && p.state !== "done";

// The projects p could be a part of: not itself, nor anything in it, nor finished ones.
function parentChoices(p) {
  const inside = new Set(projectInside(p)[1].map((q) => q.id));
  return S.data.projects.filter((q) => q.id !== p.id && !inside.has(q.id) && !q.deleted_at && (q.state !== "done" || q.id === p.parent_id));
}

function subprojectsField(p) {
  const subs = projectSteps(p, []).map((st) => st.x);
  return `<div class="deps subprojects"><span class="ln-label">Subprojects</span>
    ${subs.map((q) => `<button type="button" class="link open-subproject${q.state === "done" ? " done" : ""}" data-project="${q.id}">${h(q.name)}</button>`).join("")}
    <button type="button" class="link new-subproject">+ New subproject</button></div>`;
}

// Makes a task, project or note into another kind: the same item, so it keeps its title,
// text, tags, files and links (app.py's convert_document). Then opens it.
async function convertTo(id, to, options = {}) {
  const x = await api("POST", `/documents/${id}/convert`, { to, ...options });
  S.selected = null;
  await refresh();
  if (to === "note") { setView(x.journal_id ? "journal" : "notes"); openNote(noteById(id) || x); }
  else if (to === "project") { setView(`project:${id}`); select("project", id); }
  else openTask(id);
  toast(`It's a ${to} now.`);
}

// ---- project templates (and recurring projects) -----------------------------

const templateById = (id) => S.data.templates?.find((t) => t.id === id);
const offsetLabel = (n) => n == null ? "" : n === 0 ? "on the day" : `${Math.abs(n)} day${Math.abs(n) === 1 ? "" : "s"} ${n < 0 ? "before" : "after"}`;

function templateRow(tpl) {
  const n = tpl.data.tasks.length;
  return `<div class="row template" data-template="${tpl.id}">
    <span class="tpl-icon" aria-hidden="true">📋</span>
    <div class="row-body">
      <div class="title">${h(tpl.name)}</div>
      <div class="meta"><span>${n} task${n === 1 ? "" : "s"}</span>
        ${tpl.repeat ? `<span title="A new project is made ${tpl.lead_days} days before each date">↻ ${h(repeatLabel(tpl.repeat))}, next ${fmtDate(tpl.next_date)}</span>` : ""}</div>
    </div>
    <button type="button" class="link use-template">New project</button>
    <button type="button" class="link edit-template">Edit</button>
  </div>`;
}

async function saveAsTemplate(projectId, update) {
  const p = projectById(projectId);
  if (update) {
    await api("PATCH", `/templates/${p.template_id}`, { project_id: p.id });
    toast(`Template “${templateById(p.template_id).name}” now matches this project.`);
  } else {
    const name = prompt("Name the template", p.name.replace(/ \([^)]*\)$/, ""));
    if (!name?.trim()) return;
    await api("POST", "/templates", { project_id: p.id, name: name.trim() });
    toast(`Saved as the template “${name.trim()}”. Find it under Projects.`);
  }
  await refresh();
}

// New project: blank, or from a template (with the date its days count from).
function openNewProject(templateId = null) {
  const dlg = $("#proj-dialog");
  const tpls = S.data.templates || [];
  dlg.innerHTML = `<form method="dialog" class="stack new-project">
    <div class="dlg-head"><h2>New project</h2><button type="button" class="icon close-dlg" aria-label="Close">✕</button></div>
    ${tpls.length ? `<label>From <select name="template">${options([["", "Blank project"], ...tpls.map((t) => [t.id, `Template: ${t.name}`])], templateId ?? "")}</select></label>` : ""}
    <label>Name <input name="name" required></label>
    <label class="tpl-date" hidden>Dates count from <input type="date" name="date">
      <span class="muted small tpl-date-hint"></span></label>
    <div class="detail-actions"><button class="primary">Create</button></div>
  </form>`;
  const f = $("form", dlg);
  const sync = () => {
    const tpl = templateById(Number(f.template?.value));
    f.name.value = tpl ? tpl.data.project.name : f.name.dataset.typed ? f.name.value : "";
    const dated = tpl && (tpl.data.project.due != null || tpl.data.tasks.some((t) => t.start != null || t.due != null));
    $(".tpl-date", dlg).hidden = !dated;
    $(".tpl-date-hint", dlg).textContent = dated
      ? "The project's date, e.g. a trip's departure day: its tasks get their dates from it. Leave empty for none." : "";
  };
  f.template?.addEventListener("change", sync);
  f.name.addEventListener("input", () => { f.name.dataset.typed = "1"; });
  $(".close-dlg", dlg).onclick = () => dlg.close();
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = f.name.value.trim();
    if (!name) return;
    const tpl = f.template?.value;
    const p = tpl ? await api("POST", `/templates/${tpl}/use`, { name, date: f.date.value || null })
      : await api("POST", "/projects", { name, area_id: chosenArea() });
    dlg.close();
    await refresh();
    setView(`project:${p.id}`);
  });
  sync();
  dlg.showModal();
  (f.template && templateId == null ? f.template : f.name).focus();
}

// The template editor: its tasks' names and days, and its repeat.
function openTemplateEditor(id) {
  const tpl = structuredClone(templateById(id));
  const dlg = $("#tpl-dialog");
  const t0 = tpl.data.tasks;
  const draw = () => {
    const every = parseEvery(tpl.repeat);
    dlg.innerHTML = `<form method="dialog" class="stack tpl-form">
      <div class="dlg-head"><h2>Template</h2><button type="button" class="icon close-dlg" aria-label="Close">✕</button></div>
      <label>Template name <input name="tname" value="${h(tpl.name)}" required></label>
      <label>Project name <input name="pname" value="${h(tpl.data.project.name)}" required></label>
      <p class="muted small">Days count from the project's date (say, a trip's departure day): −14 is two weeks before,
        0 the day itself, 3 three days after. Leave empty for no date.</p>
      <table class="tpl-tasks">
        <thead><tr><th>Task</th><th title="Days from the project's date">Starts</th><th title="Days from the project's date">Due</th><th></th></tr></thead>
        <tbody>
          <tr class="tpl-project"><td><em>The project itself</em></td><td></td>
            <td><input type="number" class="off" data-i="p" data-k="due" value="${tpl.data.project.due ?? ""}" aria-label="Project due, days"></td><td></td></tr>
          ${t0.map((t, i) => `<tr data-i="${i}">
            <td><input class="ttitle" value="${h(t.title)}" aria-label="Task">
              ${t.after.length ? `<span class="muted small">after ${h(t.after.map((a) => t0[a]?.title).join(", "))}</span>` : ""}</td>
            <td><input type="number" class="off" data-k="start" value="${t.start ?? ""}" aria-label="Starts, days"></td>
            <td><input type="number" class="off" data-k="due" value="${t.due ?? ""}" aria-label="Due, days"></td>
            <td><button type="button" class="icon del-ttask" title="Remove" aria-label="Remove">✕</button></td></tr>`).join("")}
        </tbody>
      </table>
      <p><button type="button" class="link add-ttask">+ Add a task</button>
        <span class="muted small">· Notes, tags and the order tasks wait on each other come from the project it was saved from
          (to change those, make a project from it, edit that, then <em>Update template</em> in the project's details).</span></p>
      <h3>Repeat</h3>
      <label>Make a new project <select name="repeat">${options(
        [["", "Only when I ask"], ["weekly", "Every week"], ["monthly", "Every month"], ["yearly", "Every year"],
         ["every", "Every N days, weeks, months or years…"]], every ? "every" : tpl.repeat || "")}</select></label>
      <div class="tpl-repeat" ${tpl.repeat ? "" : "hidden"}>
        <label class="every-n" ${every ? "" : "hidden"}>Every <input type="number" name="every" min="1" max="999" value="${every?.n || 2}">
          <select name="unit" class="every-unit">${options(Object.entries(EVERY_UNITS).map(([u, w]) => [u, w + "s"]), every?.unit || "w")}</select></label>
        <label>Next date (the project's date) <input type="date" name="next" value="${h(tpl.next_date || "")}"></label>
        <label>Make it <input type="number" name="lead" min="0" max="365" value="${tpl.lead_days}"> days before that date</label>
      </div>
      <div class="detail-actions">
        <button class="primary">Save</button>
        <button type="button" class="use-now">New project now…</button>
        <button type="button" class="danger del-template">Delete template</button>
      </div>
    </form>`;
    const f = $("form", dlg);
    f.repeat.onchange = () => {
      $(".tpl-repeat", dlg).hidden = !f.repeat.value;
      $(".every-n", dlg).hidden = f.repeat.value !== "every";
    };
  };
  // Keep what's typed when rows are added or removed.
  const collect = () => {
    const f = $("form", dlg);
    tpl.name = f.tname.value;
    tpl.data.project.name = f.pname.value;
    const num = (v) => (v === "" ? null : Math.trunc(Number(v)));
    tpl.data.project.due = num($('input[data-i="p"]', dlg).value);
    for (const row of dlg.querySelectorAll("tbody tr[data-i]")) {
      const t = t0[row.dataset.i];
      t.title = $(".ttitle", row).value;
      t.start = num($('[data-k="start"]', row).value);
      t.due = num($('[data-k="due"]', row).value);
    }
  };
  dlg.onclick = async (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.classList.contains("close-dlg")) return dlg.close();
    if (b.classList.contains("add-ttask")) {
      collect();
      t0.push({ title: "", notes: "", state: "next", focus: false, priority: 0, tags: [], minutes: null,
        energy: null, start: null, start_time: null, due: null, after: [] });
      draw();
      dlg.querySelector("tbody tr:last-child .ttitle").focus();
    } else if (b.classList.contains("del-ttask")) {
      collect();
      const i = Number(b.closest("tr").dataset.i);
      t0.splice(i, 1);
      for (const t of t0) t.after = t.after.filter((a) => a !== i).map((a) => (a > i ? a - 1 : a));
      draw();
    } else if (b.classList.contains("use-now")) {
      dlg.close();
      openNewProject(id);
    } else if (b.classList.contains("del-template")) {
      if (!confirm(`Delete the template “${tpl.name}”? Projects made from it stay.`)) return;
      await api("DELETE", `/templates/${id}`);
      dlg.close();
      refresh();
    }
  };
  dlg.onsubmit = async (e) => {
    e.preventDefault();
    collect();
    const f = $("form", dlg);
    const repeat = f.repeat.value === "every" ? everyValue(Math.max(1, Math.min(999, Number(f.every.value) || 1)), f.unit.value) : f.repeat.value || null;
    if (repeat && !f.next.value) return toast("Choose the next date for the repeating project.");
    await api("PATCH", `/templates/${id}`, {
      name: tpl.name, data: tpl.data, repeat, next_date: repeat ? f.next.value : null,
      lead_days: Number(f.lead.value) || 0,
    });
    dlg.close();
    toast(repeat ? `Saved. The next project will be made ${f.lead.value || 0} days before ${fmtDate(f.next.value)}.` : "Template saved.");
    refresh();
  };
  draw();
  dlg.showModal();
}

// Dropping a task on a sidebar entry moves it there.
// What dropping a task on a sidebar item does to it (null: nothing).
function dropChanges(t, target) {
  if (target === "trash") return { deleted: true };
  if (target === "logbook") return { completed: true };
  if (target === "focus") return { focus: true };
  if (target.startsWith("project:")) {
    const changes = { project_id: Number(target.slice(8)) };
    if (t.state === "inbox") changes.state = "next";
    return changes;
  }
  if (STATE_LABEL[target]) {
    const changes = { state: target };
    if (target === "scheduled" && !t.start_date) changes.start_date = addDays(today(), 1);
    return changes;
  }
  return null;
}

async function dropOnNav(ts, target) {
  const n = ts.length;
  const where = target.startsWith("project:") ? projectById(Number(target.slice(8)))?.name : STATE_LABEL[target];
  const msg = target === "trash" ? (n > 1 ? `Moved ${n} tasks to trash.` : "Moved to trash.")
    : target === "logbook" ? (n > 1 ? `Completed ${n} tasks.` : "Completed.")
    : n > 1 ? `Moved ${n} tasks${where ? ` to ${where}` : ""}.` : null;
  if (target === "trash" && ts.some((t) => t.id === S.selected?.id)) S.selected = null;
  await changeTasks(ts, (t) => dropChanges(t, target), msg);
}

// Move the dragged tasks (keeping their order) to just before another, or to the end.
async function reorderTasks(draggedIds, beforeId) {
  if (draggedIds.includes(beforeId)) return;
  const project = S.view.startsWith("project:") && !S.search && !S.tagFilter.size && projectById(Number(S.view.slice(8)));
  if (!project) draggedIds = draggedIds.filter((id) => taskById(id));  // (subprojects move only on their project's page)
  if (!draggedIds.length) return;
  const ids = (project ? projectSteps(project, filtered(viewTasks(S.view))).map((st) => st.x.id)
    : filtered(viewTasks(S.view)).map((t) => t.id)).filter((id) => !draggedIds.includes(id));
  let at = beforeId == null ? ids.length : ids.indexOf(beforeId);
  if (at < 0) at = ids.length;
  // Where the list is sorted by priority, the dragged tasks take the priority of the spot
  // they're dropped on (the task below it, or above it at the end); otherwise they'd jump back.
  const ref = PRIORITY_VIEWS.includes(S.view) && taskById(ids[at] ?? ids[at - 1]);
  const repriced = ref ? tasksOf(draggedIds).filter((t) => t.priority !== ref.priority) : [];
  ids.splice(at, 0, ...draggedIds);
  ids.forEach((id, i) => { const t = taskById(id), p = !t && projectById(id); if (t) t.position = i; else if (p) p.step = i; });
  repriced.forEach((t) => { t.priority = ref.priority; });
  S.data.tasks.sort((a, b) => a.position - b.position || a.id - b.id);
  render();
  await api("POST", "/reorder/tasks", { ids });
  if (repriced.length) await bulkPatch(repriced.map((t) => ({ id: t.id, priority: ref.priority })));
}

// ---- several tasks at once -----------------------------------------------

const tasksOf = (ids) => ids.map(taskById).filter(Boolean);

// A field's value as it is now, to put back on Undo.
function currentValue(t, key) {
  if (key === "completed") return !!t.completed_at;
  if (key === "deleted") return !!t.deleted_at;
  return t[key];
}

// Change each task by change(t) (null: leave it) in one request; a message shows with Undo.
async function changeTasks(ts, change, message) {
  const items = ts.map((t) => [t, change(t)]).filter(([, c]) => c);
  if (!items.length) return;
  const undo = items.map(([t, c]) => {
    const back = { id: t.id };
    for (const k of Object.keys(c)) back[k] = k === "defer" ? true : currentValue(t, k);
    return back;
  });
  await bulkPatch(items.map(([t, c]) => ({ id: t.id, ...c })));
  if (message) toast(message, () => bulkPatch(undo));
}

// Copies of the tasks, each just after its original. One copy opens, to be changed.
async function duplicateTasks(ts) {
  const copies = [];
  for (const t of ts) copies.push(await api("POST", `/tasks/${t.id}/duplicate`));
  await refresh();
  if (copies.length === 1) {
    // Open the copy, in its own list if it isn't in this one (e.g. a filtered-out area).
    const id = copies[0].id;
    if (shownTaskIds().includes(id)) { S.cursor = id; select("task", id); } else openTask(id);
    $('#detail [data-field="title"]')?.select();
    toast("Duplicated.", () => bulkPatch([{ id, deleted: true }]));
  } else {
    clearPicked();
    toast(`Duplicated ${copies.length} tasks.`, () => bulkPatch(copies.map((c) => ({ id: c.id, deleted: true }))));
  }
}

// Convert to project: the task becomes a project of the same name (app.py's convert_task),
// its checklist lines its tasks if wanted. Says first what a project has no place for.
function openConvert(t) {
  if (!t) return;
  if (t.id < 0) return toast("Wait until this task has been saved (when you're back online).");
  const tpl = document.createElement("template");
  tpl.innerHTML = t.notes;
  const items = [...tpl.content.querySelectorAll("ul[data-check] > li")].filter((li) => li.textContent.trim()).length;
  const lost = [t.start_date && "its start date", reminderPending(t) && "its reminder", t.waiting_for && "who it's waiting for",
    t.minutes && "its time", t.energy && "its energy", t.people?.length && "its people", t.spent && "its time spent"].filter(Boolean);
  const dlg = $("#proj-dialog");
  dlg.innerHTML = `<form method="dialog" class="stack convert-project">
    <div class="dlg-head"><h2>Convert to project</h2><button type="button" class="icon close-dlg" aria-label="Close">✕</button></div>
    <p>“${h(t.title)}” becomes a project, with its notes, area, due date, priority, tags and files.
      What it's blocked by and related to go with it, and tasks waiting on it will wait on the project.</p>
    ${items ? `<label class="check"><input type="checkbox" name="checklist" checked>
      Make its ${items} checklist item${items > 1 ? "s" : ""} the project's tasks</label>` : ""}
    ${lost.length ? `<p class="muted small">A project has no place for ${h(lost.join(", ").replace(/, ([^,]*)$/, " or $1"))}, so ${lost.length > 1 ? "they go" : "it goes"}.</p>` : ""}
    <div class="detail-actions"><button class="primary">Convert</button></div>
  </form>`;
  const f = $("form", dlg);
  $(".close-dlg", dlg).onclick = () => dlg.close();
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    dlg.close();
    convertTo(t.id, "project", { checklist: !!f.checklist?.checked });
  });
  dlg.showModal();
  $("button.primary", dlg).focus();
}

async function bulkPatch(changes) {
  const tasks = await api("POST", "/tasks/bulk", { tasks: changes });
  tasks.forEach(replaceTask);
  // As in patchTask: these change which rows exist (and a deferral may already be due).
  if (changes.some((c) => "completed" in c || "deleted" in c || "defer" in c)) await refresh();
  else render();
}

// The task rows on screen, in order (not in the trash: those can only be restored).
function shownTaskIds() {
  if (S.view === "trash") return [];
  return [...document.querySelectorAll("#list .row.task")].map((r) => Number(r.dataset.task));
}

// Ctrl/⌘-click toggles one task; Shift-click adds the range from the last one clicked.
function pick(id, range = false) {
  // The task open in the editor counts as the first one picked.
  if (!S.picked.size && S.selected?.kind === "task") S.picked.add(S.selected.id);
  if (range && S.pickAnchor != null) {
    const ids = shownTaskIds();
    const [a, b] = [ids.indexOf(S.pickAnchor), ids.indexOf(id)].sort((x, y) => x - y);
    if (a >= 0) ids.slice(a, b + 1).forEach((x) => S.picked.add(x));
    else S.picked.add(id);
  } else if (S.picked.has(id)) {
    S.picked.delete(id);
  } else {
    S.picked.add(id);
  }
  S.pickAnchor = id;
  S.selected = null;
  render();
}

function selectAll() {
  shownTaskIds().forEach((id) => S.picked.add(id));
  if (!S.picked.size) return;
  S.selected = null;
  render();
}

function clearPicked() {
  S.picked.clear();
  S.pickAnchor = null;
  render();
}

// The picked tasks in the order they're shown.
function pickedIds() {
  return shownTaskIds().filter((id) => S.picked.has(id));
}

function renderSelectBar() {
  const bar = $("#select-bar");
  const shown = new Set(shownTaskIds());
  for (const id of S.picked) if (!shown.has(id)) S.picked.delete(id);
  bar.hidden = !S.picked.size;
  if (bar.hidden) return;
  const all = S.picked.size === shown.size;
  bar.innerHTML = `<span class="count">${S.picked.size} selected</span>
    ${all ? "" : '<button type="button" class="link" data-act="all">Select all</button>'}
    <button type="button" class="link" data-act="actions">Actions ▾</button>
    <button type="button" class="icon" data-act="clear" aria-label="Clear selection" title="Clear selection (Esc)">✕</button>`;
}

// ---- detail editing ------------------------------------------------------

let saveTimer;
function fieldValue(input) {
  if (input.type === "checkbox") return input.checked;
  const v = input.value;
  const f = input.dataset.field;
  if (f === "tags") return v.split(",").map((s) => s.trim()).filter(Boolean);
  if (["project_id", "parent_id", "area_id", "minutes"].includes(f)) return v === "" ? null : Number(v);
  if (f === "priority") return clampPriority(Number(v));
  if (f === "remind_at") return v ? localInputToUtc(v) : null;
  return v;
}

async function saveField(input, sel = S.selected) {
  if (!sel) return;
  const field = input.dataset.field;
  const value = fieldValue(input);
  if ((field === "title" || field === "name") && !value.trim()) return;
  if (sel.kind === "project") {
    await patchProject(sel.id, { [field]: value });
  } else {
    const typing = input.tagName === "TEXTAREA" || input.type === "text" || input.type === "";
    const task = await patchTask(sel.id, { [field]: value }, { quiet: typing });
    // Tags and repeat settings can create or remove other rows.
    if (["tags", "repeat", "on_miss", "repeat_from"].includes(field) ||
        (task.series_id && ["start_date", "due_date"].includes(field))) await refresh();
  }
}

function validDate(v) {
  const y = Number(v.slice(0, 4));
  return /^\d{4}-\d{2}-\d{2}$/.test(v) && y >= 1900 && y <= 2199;
}

function saveDate(input) {
  delete input.dataset.typed;
  const sel = S.selected;
  const item = sel && (sel.kind === "task" ? taskById(sel.id) : projectById(sel.id));
  if (!item) return;
  const saved = item[input.dataset.field] || "";
  if (input.value === saved) return;
  if (input.value && input.type === "date" && !validDate(input.value)) {
    input.value = saved;
    toast("That date doesn't look right.");
    return;
  }
  if (input.dataset.field === "start_date" && sel.kind === "task") return saveStart(item, input.value);
  // Dates don't change the panel's layout, so keep it (and the user's focus) as is.
  saveField(input);
}

// A start date in the future schedules the task (it waits in Scheduled); clearing it, or
// one that has come, puts a scheduled task in the Queue.
async function saveStart(t, start) {
  const changes = { start_date: start || null };
  if (!start) changes.start_time = null;
  const later = start && (start > today() || (start === today() && t.start_time && `${start}T${t.start_time}` > nowStamp()));
  if (later && t.state !== "scheduled") changes.state = "scheduled";
  else if (!later && t.state === "scheduled") changes.state = "next";
  $("#detail").dataset.key = "";  // (the status, and the time box, change)
  await patchTask(t.id, changes);
  if (t.series_id) await refresh();
}

// ---- dependencies ("Blocked by") ---------------------------------------------

// Blocked by and Related to are lists of tasks and projects, by id (tasks, projects and notes
// share one set of ids). refs(x, "blocked_by") or refs(x, "related"), for a task, project or note.
function refs(x, field) {
  return (x[field] || []).map((r) => (typeof r === "object" ? r.id : r));  // (related: {id, kind, title}; offline: ids)
}

// What an id names: {kind, title, open, done}. Only open tasks are loaded, so others are done.
function refInfo(id, saved) {
  const p = projectById(id);
  if (p || saved?.kind === "project") {
    return { kind: "project", title: "Project: " + (p?.name ?? saved?.title ?? "a finished one"),
      open: !!p && p.state !== "done" && !p.deleted_at };
  }
  const t = taskById(id);
  return { kind: "task", title: t?.title ?? saved?.title ?? "a finished task", open: !!t && !t.completed_at && !t.deleted_at };
}

// Tasks and projects matching q that x (kind "task", "project" or "note") could be linked to, as
// [{ref, title, where}]; not x itself, what's in skip (ids), or, for Blocked by, what holds it or what it holds.
function refMatches(x, kind, q, skip, blocking) {
  q = q.trim().toLowerCase();
  if (!q) return [];
  const fits = (text) => text.toLowerCase().includes(q);
  const mine = blocking ? projectFamily(x, kind) : new Set();
  const tasks = S.data.tasks.filter((t) => t.id !== x.id && !skip.has(t.id) && !mine.has(t.id) && fits(t.title))
    .map((t) => ({ ref: t.id, title: t.title, where: projectById(t.project_id)?.name || "" }));
  const projects = S.data.projects.filter((p) => p.id !== x.id && !skip.has(p.id) && !mine.has(p.id) &&
    p.state !== "done" && fits(p.name))
    .map((p) => ({ ref: p.id, title: p.name, where: "Project" }));
  return [...projects, ...tasks].slice(0, 8);
}

// What x can't wait on, as it would wait on itself: the projects it's in, and (a project)
// everything in it.
function projectFamily(x, kind) {
  const out = new Set();
  for (let p = projectById(kind === "task" ? x.project_id : x.parent_id); p && !out.has(p.id); p = projectById(p.parent_id)) out.add(p.id);
  if (kind === "project") {
    const inside = (id) => {
      for (const t of S.data.tasks) if (t.project_id === id) out.add(t.id);
      for (const q of S.data.projects) if (q.parent_id === id && !out.has(q.id)) { out.add(q.id); inside(q.id); }
    };
    inside(x.id);
  }
  return out;
}

function refResults(matches, cls) {
  return matches.map((m) => `<button type="button" class="link ${cls}" data-ref="${m.ref}">${h(m.title)}${
    m.where ? ` <span class="muted small">${h(m.where)}</span>` : ""}</button>`).join("");
}

// A list of linked tasks and projects (field: Blocked by, Related to, or a note's Linked to):
// a chip for each (an open one clicks through, a done one is struck through, ✕ takes it off)
// and a box to find more. Clicks: .ref-add, .ref-del and .ref-open, with data-ref the id; the
// box (.ref-search) fills .ref-results with refResults(…, "ref-add"). extra: HTML under it.
const REF_FIELDS = {
  blocked_by: ["Blocked by", "Wait for a task or project…"],
  related: ["Related to", "Link a task or project…"],
  linked: ["Linked to", "Link a task or project…"],
};
function refsField(x, field, extra = "") {
  const list = field === "blocked_by" ? "blocked_by" : "related";
  const saved = new Map((x[list] || []).filter((r) => typeof r === "object").map((r) => [r.id, r]));
  const chips = refs(x, list).map((ref) => {
    const s = saved.get(ref), r = refInfo(ref, s);
    return `<span class="dep-chip${r.open ? "" : " done"}" data-ref="${ref}" title="${s?.trashed ? "In the trash" : r.open ? "Open it" : "Done"}">${
      r.open ? `<button type="button" class="link ref-open">${h(r.title)}</button>` : h(r.title)}
      <button type="button" class="icon ref-del" aria-label="Remove">✕</button></span>`;
  }).join("");
  const [label, hint] = REF_FIELDS[field];
  return `<div class="deps" data-refs="${list}"><label>${label} <input class="ref-search" placeholder="${hint}" autocomplete="off"></label>
    <div class="dep-chips">${chips}</div><div class="ref-results"></div>${extra}</div>`;
}

function blockersField(x, kind) {
  if (x.completed_at || x.deleted_at) return "";
  const p = projectById(kind === "task" ? x.project_id : x.parent_id);
  const inherited = p ? waitingOn(p, "project") : [];
  return refsField(x, "blocked_by", inherited.length
    ? `<p class="muted small">Its project waits for ${h(inherited.map((b) => b.title).join(", "))}, so this does too.</p>` : "");
}

// "Related to": links both ways to other tasks and projects, to get from one to the other
// (app.py's document_links).
const relatedField = (x) => refsField(x, "related");

// Saves the open item's Blocked by or Related to (field) as the given ids.
async function setRefs(field, list) {
  const sel = S.selected;
  const changes = { [field]: list.map(Number) };
  $("#detail").dataset.key = "";
  if (sel.kind === "project") await patchProject(sel.id, changes);
  else await patchTask(sel.id, changes);
  // (Related: the other side's links changed too. A project's waits change its tasks' lists.)
  if (field === "related" || sel.kind === "project") await refresh();
}

function openRef(id) {
  id = Number(id);
  if (taskById(id)) return openTask(id);
  if (!projectById(id)) return toast("That isn't there any more.");
  setView(`project:${id}`);
  select("project", id);
}

// ---- people (Google Contacts) ---------------------------------------------------
// A task can name contacts from the read-only copy of the user's Google Contacts (@Mom in
// quick add, or People in the editor); the editor shows how to reach them.

const contactById = (id) => S.data.contacts?.find((c) => c.id === id);
const dialable = (number) => number.replace(/[^\d+*#,;]/g, "");

function peopleField(t) {
  if (!S.data.contacts?.length && !t.people?.length) return "";
  const remove = '<button type="button" class="icon del-person" aria-label="Remove">✕</button>';
  const cards = (t.people || []).map((id) => {
    const c = contactById(id);
    if (!c) return `<div class="person-card" data-person="${h(id)}"><div class="person-name">
      <span class="muted">Not in your Google Contacts now</span>${remove}</div></div>`;
    const lines = [
      ...c.phones.map((p) => `<a href="tel:${h(dialable(p.value))}">📞 ${h(p.value)}</a>${
        p.type ? ` <span class="muted small">${h(p.type)}</span>` : ""} · <a href="sms:${h(dialable(p.value))}">Text</a>`),
      ...c.emails.map((e) => `<a href="mailto:${h(e.value)}">✉ ${h(e.value)}</a>`),
      ...c.addresses.map((a) => `<a href="https://www.google.com/maps/search/?api=1&query=${
        h(encodeURIComponent(a.value))}" target="_blank" rel="noopener">📍 ${h(a.value.replace(/\s*\n\s*/g, ", "))}</a>`),
    ];
    return `<div class="person-card" data-person="${h(id)}"><div class="person-name"><strong>${h(c.name)}</strong>${remove}</div>
      ${lines.map((l) => `<div>${l}</div>`).join("") || '<div class="muted small">No phone, email or address</div>'}</div>`;
  }).join("");
  return `<div class="people"><label>People <input class="people-search" placeholder="Add a contact…" autocomplete="off"></label>
    <div class="people-results"></div>${cards}</div>`;
}

function peopleMatches(t, q) {
  q = q.trim().toLowerCase();
  if (!q) return [];
  const fits = (name) => name.toLowerCase().startsWith(q) || name.toLowerCase().split(/\s+/).some((w) => w.startsWith(q));
  return (S.data.contacts || []).filter((c) => !t.people?.includes(c.id) &&
    (fits(c.name) || c.nicknames.some(fits))).slice(0, 6);
}

async function setPeople(id, ids) {
  $("#detail").dataset.key = "";
  await patchTask(id, { people: ids });
}

// ---- focus timer -------------------------------------------------------------
// One task, full screen, with a countdown (or a stopwatch). The time is added to the
// task's "spent" when the session ends. The session is kept in this browser, so it
// survives a reload; Esc shrinks it to a small timer in the corner.

const TIMER_LENGTHS = [15, 25, 45, 60];
let timer = (() => { try { return JSON.parse(load("timer", "null")); } catch { return null; } })();
let timerTick = null, wakeLock = null;

function fmtSpent(sec) {
  const m = Math.round(sec / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}
const timerElapsed = () => timer ? timer.elapsed + (timer.runFrom ? Date.now() - timer.runFrom : 0) : 0;
const clock = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
const storeTimer = () => save("timer", JSON.stringify(timer));

function openTimer(id) {
  if (timer && timer.task !== id && !confirm("Stop the timer on the other task and start one here?")) return;
  if (timer && timer.task !== id) endTimer();
  if (!timer) timer = { task: id, length: null, elapsed: 0, runFrom: null, small: false, rang: false };
  timer.small = false;
  storeTimer();
  renderTimer();
}

function startTimer(minutes) {
  timer.length = minutes ? minutes * 60000 : null;
  timer.runFrom = Date.now();
  timer.rang = false;
  storeTimer();
  keepAwake();
  renderTimer();
}

function pauseTimer() {
  if (timer.runFrom) { timer.elapsed = timerElapsed(); timer.runFrom = null; }
  else timer.runFrom = Date.now();
  storeTimer();
  renderTimer();
}

// Ends the session: the time goes on the task (and, with done, the task is completed).
async function endTimer(done = false) {
  if (!timer) return;
  const { task } = timer, secs = Math.round(timerElapsed() / 1000);
  timer = null;
  save("timer", "null");
  clearInterval(timerTick);
  wakeLock?.release().catch(() => {});
  wakeLock = null;
  renderTimer();
  document.title = viewTitle() + " · Entropicide";
  const t = taskById(task);
  if (t && secs >= 5) await patchTask(task, { spent: (t.spent || 0) + secs }, { quiet: true });
  if (done && t && !t.completed_at) await completeTask(task, true);
  else if (secs >= 5) toast(`${fmtSpent(secs)} on “${t?.title ?? "the task"}”.`);
}

async function keepAwake() {
  try { wakeLock = await navigator.wakeLock?.request("screen"); } catch { /* not allowed now */ }
}

function timesUp() {
  timer.rang = true;
  storeTimer();
  // A soft three-note chime, a buzz, and a notification if the page isn't in view.
  try {
    const ctx = new AudioContext();
    [0, 0.25, 0.5].forEach((at, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = [660, 880, 990][i];
      g.gain.setValueAtTime(0.0001, ctx.currentTime + at);
      g.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + 0.4);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + at);
      o.stop(ctx.currentTime + at + 0.45);
    });
  } catch { /* no audio */ }
  navigator.vibrate?.([200, 100, 200]);
  if (document.hidden && "Notification" in window && Notification.permission === "granted") {
    navigator.serviceWorker?.ready.then((r) => r.showNotification("Time's up", {
      body: taskById(timer.task)?.title || "", tag: "timer", icon: BASE + "/static/icons/icon-192.png",
      data: { task: timer.task } }));
  }
}

function renderTimer() {
  const el = $("#timer"), pill = $("#timer-pill");
  clearInterval(timerTick);
  const t = timer && taskById(timer.task);
  if (timer && !t) { timer = null; save("timer", "null"); }  // its task is gone
  el.hidden = !timer || timer.small;
  pill.hidden = !timer || !timer.small;
  if (!timer) return;
  const draw = () => {
    const spent = timerElapsed();
    const left = timer.length ? timer.length - spent : null;
    if (left !== null && left <= 0 && timer.runFrom && !timer.rang) timesUp();
    const shown = left === null ? clock(spent) : left > 0 ? clock(left) : "0:00";
    document.title = `${shown} · ${t.title}`;
    const face = $("#timer .tm-clock");
    if (face) face.textContent = shown;
    const bar = $("#timer .tm-bar > div");
    if (bar) bar.style.width = timer.length ? `${Math.min(100, 100 * spent / timer.length)}%` : "0";
    pill.innerHTML = `<span>${timer.runFrom ? "⏱" : "⏸"} ${shown}</span> <span class="tm-pill-title">${h(t.title)}</span>`;
    if (left !== null && left <= 0 && !$("#timer .tm-up") && !timer.small) renderTimer();
  };
  if (timer.small) { draw(); timerTick = setInterval(draw, 1000); return; }
  const started = timer.runFrom || timer.elapsed;
  const up = timer.length && timerElapsed() >= timer.length;
  el.innerHTML = `<div class="tm-box" role="dialog" aria-label="Focus timer">
    <button type="button" class="icon tm-small" title="Shrink (Esc)" aria-label="Shrink">⌄</button>
    <div class="tm-proj muted">${h(projectById(t.project_id)?.name || STATE_LABEL[t.state] || "")}</div>
    <h2 class="tm-title">${mdInline(t.title)}</h2>
    ${!started ? `<p class="muted">How long?</p>
      <div class="tm-lengths">${TIMER_LENGTHS.map((m) => `<button type="button" class="tm-len" data-min="${m}">${m} min</button>`).join("")}
        <button type="button" class="tm-len" data-min="0">No limit</button></div>`
    : `<div class="tm-clock">0:00</div><div class="tm-bar"><div></div></div>
      ${up ? `<p class="tm-up">Time's up.</p>
        <div class="tm-actions"><button type="button" class="tm-more" data-min="5">+5 min</button>
          <button type="button" class="tm-again">Another ${Math.round(timer.length / 60000)} min</button>
          <button type="button" class="primary tm-done">Complete the task</button><button type="button" class="tm-stop">Stop</button></div>`
      : `<div class="tm-actions"><button type="button" class="tm-pause">${timer.runFrom ? "Pause" : "Resume"}</button>
          <button type="button" class="primary tm-done">✓ Done</button><button type="button" class="tm-stop">Stop</button></div>`}`}
    ${t.notes ? `<div class="notes note-body tm-notes">${showBody(t.notes)}</div>` : ""}
    ${t.spent ? `<p class="muted small">Spent before: ${fmtSpent(t.spent)}</p>` : ""}
  </div>`;
  draw();
  if (started) timerTick = setInterval(draw, 1000);
}

function bindTimer() {
  const el = $("#timer");
  el.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.classList.contains("tm-len")) startTimer(Number(b.dataset.min));
    else if (b.classList.contains("tm-pause")) pauseTimer();
    else if (b.classList.contains("tm-done")) endTimer(true);
    else if (b.classList.contains("tm-stop")) endTimer(false);
    else if (b.classList.contains("tm-small")) { timer.small = true; storeTimer(); renderTimer(); }
    else if (b.classList.contains("tm-more")) { timer.length = timerElapsed() + 5 * 60000; timer.rang = false; if (!timer.runFrom) timer.runFrom = Date.now(); storeTimer(); renderTimer(); }
    else if (b.classList.contains("tm-again")) { timer.length = timerElapsed() + timer.length; timer.rang = false; storeTimer(); renderTimer(); }
  });
  // Ticking a checklist item while focusing.
  el.addEventListener("change", (e) => {
  });
  el.addEventListener("click", (e) => {
    const shown = e.target.closest(".tm-notes");
    if (shown && tickTask(e, timer.task, shown)) setTimeout(renderTimer, 400);
  });
  $("#timer-pill").addEventListener("click", () => { timer.small = false; storeTimer(); renderTimer(); });
  document.addEventListener("keydown", (e) => {
    if (!timer || el.hidden) return;
    if (e.key === "Escape") { e.stopImmediatePropagation(); timer.small = true; storeTimer(); renderTimer(); }
    else if (e.key === " " && (timer.runFrom || timer.elapsed) && !e.target.closest("button, input, textarea")) { e.preventDefault(); pauseTimer(); }
  }, true);
  document.addEventListener("visibilitychange", () => { if (!document.hidden && timer?.runFrom) keepAwake(); });
}

// ---- reminders --------------------------------------------------------------
// Reminder times are stored in UTC ("YYYY-MM-DD HH:MM:SS") and shown in local time.

function utcToLocalInput(stamp) {
  if (!stamp) return "";
  const d = new Date(stamp.replace(" ", "T") + "Z");
  return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
const localInputToUtc = (v) => new Date(v).toISOString().slice(0, 19).replace("T", " ");
const reminderPending = (t) => t.remind_at && !t.completed_at && !t.deleted_at &&
  (!t.reminded_at || t.reminded_at < t.remind_at);
const fmtRemind = (t) => { const v = utcToLocalInput(t.remind_at); return fmtWhen(v.slice(0, 10), v.slice(11)); };

function reminderField(t) {
  if (t.completed_at || t.deleted_at) return "";
  // One reminder: at a time, or some days before the due date (moving with it).
  const mode = t.remind_before && t.due_date ? String(t.remind_before) : reminderPending(t) ? "time" : "";
  const before = t.due_date ? REMIND_BEFORE.map(([d, label]) => [d, `${label} before it's due`]) : [];
  return `<div class="remind">
    <label>Remind me <select class="remind-mode">${options([["", "—"], ["time", "At a time…"], ...before], mode)}${
      t.due_date ? "" : "<option disabled>Before it's due (set a due date first)</option>"}</select></label>
    <input type="datetime-local" data-field="remind_at" aria-label="Remind me at" ${mode === "time" ? "" : "hidden"}
      value="${utcToLocalInput(reminderPending(t) ? t.remind_at : "")}">
    ${mode !== "time" && reminderPending(t) ? `<p class="muted small remind-when">⏰ ${fmtRemind(t)}</p>` : ""}
    <div class="remind-quick">
      <button type="button" class="link snooze" data-until="1h">In 1 hour</button>
      <button type="button" class="link snooze" data-until="tonight">Tonight</button>
      <button type="button" class="link snooze" data-until="tomorrow">Tomorrow 9 am</button>
      ${reminderPending(t) ? '<button type="button" class="link danger clear-remind">Clear</button>' : ""}
    </div>
    ${S.data.user.push_devices ? "" : '<p class="muted small hint">Turn on notifications in Settings to get reminders.</p>'}
  </div>`;
}

async function remindMode(select) {
  if (select.value === "time") {
    const at = $('.remind input[data-field="remind_at"]', $("#detail"));
    at.hidden = false;
    at.focus();
    return;
  }
  $("#detail").dataset.key = "";
  await patchTask(S.selected.id, select.value ? { remind_before: Number(select.value) } : { remind_at: null, remind_before: null });
}

async function snoozeTask(id, until) {
  // plan: this is the reminder as set (later copies of a repeating task take it), not a snooze.
  replaceTask(await api("POST", `/tasks/${id}/snooze`, { until, plan: true }));
  if (taskById(id)?.series_id) await refresh();
  $("#detail").dataset.key = "";
  render();
  toast(`I'll remind you ${fmtRemind(taskById(id)).replace(/^(Today|Tomorrow)/, (w) => w.toLowerCase())}.`);
}

// ---- command palette (Ctrl/⌘+K) -----------------------------------------------
// One box to go anywhere (lists, projects, tags, areas, links, tasks) or run a command,
// including the right-click menu's actions on the selected task(s). Fuzzy matching;
// things used recently come first.

const PAL_LISTS = [["inbox", "Inbox"], ["focus", "Focus"], ["next", "Queue"], ["soon", "Soon"], ["later", "Later"],
  ["someday", "Someday"], ["waiting", "Waiting"], ["scheduled", "Scheduled"], ["recurring", "Recurring"],
  ["all", "All"], ["calendar", "Calendar"], ["projects", "Projects"], ["links", "Links"], ["logbook", "Logbook"], ["trash", "Trash"]];
const pal = { items: [], shown: [], pick: 0 };
const palRecent = () => { try { return JSON.parse(load("palRecent", "[]")); } catch { return []; } };

function paletteItems() {
  const items = [];
  const add = (kind, label, run, hint = "") => items.push({ kind, label, run, hint, key: `${kind}:${label}` });
  // What the selection (or the task under the cursor, or open) can have done to it.
  const ts = tasksOf(keyTargets());
  if (ts.length) {
    const on = ts.length > 1 ? `${ts.length} selected tasks` : `“${ts[0].title}”`;
    const flat = (list, path) => {
      for (const it of list) {
        if (it.sep || it.heading || it.note && !it.chips || it.stay || ["Open", "Select", "Tag", "Priority"].includes(it.label) && !path) continue;
        if (it.chips) flat(it.chips, path + it.label + " › ");
        else if (it.sub) flat(it.sub(), path + it.label + " › ");
        else if (it.run) add("Action", path + it.label, it.run, on);
      }
    };
    flat(menuItems(ts), "");
    add("Action", "Priority › Increase", () => bumpPriority(ts, 1), on);
    add("Action", "Priority › Decrease", () => bumpPriority(ts, -1), on);
    for (const tag of S.data.tags) {
      const has = ts.every((t) => t.tags.includes(tag.name));
      add("Action", `Tag › ${has ? "Remove" : "Add"} ${tag.name}`, () => changeTasks(ts, (t) => ({
        tags: has ? t.tags.filter((x) => x !== tag.name) : [...new Set([...t.tags, tag.name])] })), on);
    }
  }
  add("Command", "New task", () => {
    if (["links", "projects", "logbook", "trash", "calendar"].includes(S.view)) setView("inbox");
    $("#quick-add-input").focus();
  });
  add("Command", "New project", newProject);
  for (const tpl of S.data.templates) add("Command", `New project from “${tpl.name}”`, () => openNewProject(tpl.id), "template");
  for (const tpl of S.data.templates) add("Template", tpl.name, () => openTemplateEditor(tpl.id), "edit");
  add("Command", "Settings", openSettings);
  add("Command", "Help", () => { location.href = BASE + "/help"; });
  add("Command", "Show all areas", () => setAreas([]));
  add("Command", "Larger text", () => stepTextSize(1), "this device");
  add("Command", "Smaller text", () => stepTextSize(-1), "this device");
  add("Command", "Download my data", () => { location.href = BASE + "/api/export"; });
  for (const [view, label] of PAL_LISTS) add("List", label, () => setView(view));
  for (const p of S.data.projects) {
    add("Project", p.name, () => setView(`project:${p.id}`), p.state === "active" ? "" : p.state === "done" ? "completed" : p.state);
  }
  for (const a of S.data.areas) add("Area", a.name, () => setAreas([String(a.id)]), "show only");
  for (const tag of S.data.tags) add("Tag", "#" + tag.name, () => { setView("all"); S.tagFilter.add(tag.name); render(); });
  for (const l of S.data.links) if (!l.folder) add("Link", l.name, () => window.open(l.url, "_blank", "noopener"), hostOf(l.url));
  for (const t of S.data.tasks) {
    add("Task", t.title, () => openTask(t.id), [projectById(t.project_id)?.name, isRecurringCopy(t) ? "Recurring" : STATE_LABEL[t.state]].filter(Boolean).join(" · "));
  }
  return items;
}

// How well q matches text: every word of q must be found, best as a whole word or its start.
function fuzzyScore(q, text) {
  const t = text.toLowerCase();
  let total = 0;
  for (const w of q.toLowerCase().split(/\s+/).filter(Boolean)) {
    const at = t.indexOf(w);
    if (at >= 0) { total += 40 + (at === 0 ? 30 : /[^\p{L}\p{N}]/u.test(t[at - 1]) ? 20 : 0) + w.length; continue; }
    // Letters in order (e.g. "mtg" for "meeting"), better when together or at word starts.
    let from = 0, prev = -2, score = 0;
    for (const ch of w) {
      const j = t.indexOf(ch, from);
      if (j < 0) return 0;
      score += j === prev + 1 ? 3 : j === 0 || /[^\p{L}\p{N}]/u.test(t[j - 1]) ? 2 : 1;
      prev = j;
      from = j + 1;
    }
    total += score;
  }
  return total;
}

const KIND_RANK = { Action: 6, Command: 5, List: 4, Project: 4, Template: 3, Area: 3, Tag: 3, Link: 2, Task: 1 };

function filterPalette() {
  const q = $("#pal-input").value.trim();
  const recent = palRecent();
  const boost = (it) => { const i = recent.indexOf(it.key); return i < 0 ? 0 : 30 - i * 2; };
  pal.shown = q
    ? pal.items.map((it) => ({ it, s: fuzzyScore(q, `${it.label} ${it.kind}`) }))
      .filter((x) => x.s > 0).sort((a, b) => (b.s + boost(b.it) + KIND_RANK[b.it.kind]) - (a.s + boost(a.it) + KIND_RANK[a.it.kind]))
      .slice(0, 50).map((x) => x.it)
    // Nothing typed: what's been used recently, the selection's actions, then the lists.
    : [...recent.map((k) => pal.items.find((it) => it.key === k)).filter(Boolean),
      ...pal.items.filter((it) => it.kind === "Action" || it.kind === "List")]
      .filter((it, i, all) => all.indexOf(it) === i).slice(0, 50);
  pal.pick = 0;
  renderPalette();
}

function renderPalette() {
  $("#pal-list").innerHTML = pal.shown.map((it, i) => `<div role="option" class="pal-item${i === pal.pick ? " on" : ""}" data-i="${i}" aria-selected="${i === pal.pick}">
      <span class="pal-kind">${it.kind}</span><span class="pal-label">${h(it.label)}</span><span class="pal-hint">${h(it.hint)}</span></div>`).join("") ||
    '<p class="muted small">Nothing matches.</p>';
  $("#pal-list .on")?.scrollIntoView({ block: "nearest" });
}

function openPalette() {
  if ($("#palette").open) return;
  document.querySelector("dialog[open]")?.close();
  pal.items = paletteItems();
  $("#pal-input").value = "";
  $("#palette").showModal();
  $("#pal-input").focus();
  filterPalette();
}

function runPalette(i = pal.pick) {
  const it = pal.shown[i];
  if (!it) return;
  save("palRecent", JSON.stringify([it.key, ...palRecent().filter((k) => k !== it.key)].slice(0, 10)));
  $("#palette").close();
  it.run();
}

function bindPalette() {
  $("#palette-btn").addEventListener("click", openPalette);
  $("#pal-input").addEventListener("input", filterPalette);
  $("#pal-input").addEventListener("keydown", (e) => {
    const n = pal.shown.length;
    if (e.key === "ArrowDown" && n) { e.preventDefault(); pal.pick = (pal.pick + 1) % n; renderPalette(); }
    else if (e.key === "ArrowUp" && n) { e.preventDefault(); pal.pick = (pal.pick - 1 + n) % n; renderPalette(); }
    else if (e.key === "Enter") { e.preventDefault(); runPalette(); }
  });
  $("#pal-list").addEventListener("click", (e) => {
    const row = e.target.closest("[data-i]");
    if (row) runPalette(Number(row.dataset.i));
  });
  // A click outside the box (on the backdrop) closes it.
  $("#palette").addEventListener("click", (e) => { if (e.target.id === "palette") $("#palette").close(); });
}

// ---- keyboard: a cursor moves through the tasks shown ------------------------

const NAV_KEYS = { ArrowDown: 1, j: 1, ArrowUp: -1, k: -1 };

// The keyboard on the sidebar (h to go there, l to come back).
const navItems = () => [...document.querySelectorAll("#nav .nav-item[data-view]")];

function markNav() {
  for (const a of navItems()) a.classList.toggle("kb", !!S.navFocus && a.dataset.view === S.view);
  document.body.classList.toggle("nav-keys", !!S.navFocus);
  if (S.navFocus) document.querySelector("#nav .nav-item.kb")?.scrollIntoView({ block: "nearest" });
}

function enterNav() {
  S.navFocus = true;
  document.body.classList.add("nav-open");  // on a phone, the sidebar slides in
  markNav();
}

function leaveNav() {
  S.navFocus = false;
  document.body.classList.remove("nav-open");
  markNav();
  if (!shownTaskIds().includes(S.cursor) && shownTaskIds().length) moveCursor(1);
}

function moveNav(step) {
  const items = navItems();
  const at = items.findIndex((a) => a.dataset.view === S.view);
  const next = items[Math.max(0, Math.min(items.length - 1, at + step))];
  if (next && next.dataset.view !== S.view) {
    S.selected = null;  // an open task's details would be out of place in another list
    setView(next.dataset.view);
    document.body.classList.add("nav-open");
  }
  markNav();
}

// What x and s act on: the picked tasks, else the one under the cursor (or open).
function keyTargets() {
  if (S.picked.size) return pickedIds();
  const shown = shownTaskIds();
  if (shown.includes(S.cursor)) return [S.cursor];
  return S.selected?.kind === "task" && shown.includes(S.selected.id) ? [S.selected.id] : [];
}

function moveCursor(step) {
  const ids = shownTaskIds();
  const at = ids.indexOf(S.cursor ?? S.selected?.id);
  S.cursor = at < 0 ? ids[step > 0 ? 0 : ids.length - 1] : ids[Math.max(0, Math.min(ids.length - 1, at + step))];
  // An open editor follows the cursor.
  if (S.selected?.kind === "task") return select("task", S.cursor);
  for (const r of document.querySelectorAll("#list .row.task")) r.classList.toggle("cursor", Number(r.dataset.task) === S.cursor);
  document.querySelector("#list .row.task.cursor")?.scrollIntoView({ block: "nearest" });
}

// Opens a task in its list (from a notification, a share, or Settings).
function openTask(id) {
  const t = taskById(id);
  if (!t) return toast("That task isn't open any more: it may be done or in the trash.");
  if (!inArea(taskArea(t))) {
    // Its area is filtered out: show everything, so it can be seen.
    S.areas = new Set();
    save("areas", "[]");
    toast("Showing all areas, to show this task.");
  }
  setView(isRecurringCopy(t) ? "recurring" : t.state);
  S.cursor = id;
  select("task", id);
}

// ---- attachments ----------------------------------------------------------

const fileUrl = (f) => `${BASE}/api/attachments/${f.id}/${encodeURIComponent(f.name)}`;
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

function fmtSize(n) {
  return n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB`
    : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${+(n / 1073741824).toFixed(2)} GB`;
}

// Files on the open item, and, for a task, its project's (which go with all of its tasks).
function detailFiles() {
  const x = selItem();
  const p = S.selected?.kind === "task" && x?.project_id && projectById(x.project_id);
  return [...(x?.attachments || []), ...(p?.attachments || [])];
}

function fileRow(f, locked) {
  const view = viewable(f) ? " att-view" : "";
  return `<div class="att" data-file="${f.id}">
      ${IMAGE_TYPES.includes(f.mime) ? `<a class="att-view" href="${h(fileUrl(f))}" target="_blank" rel="noopener"><img class="att-thumb" src="${h(fileUrl(f))}" alt="" loading="lazy"></a>`
        : `<span class="att-icon">${f.mime === "application/pdf" ? "📄" : "📎"}</span>`}
      <a class="att-name${view}" href="${h(fileUrl(f))}" target="_blank" rel="noopener" title="${h(f.name)}">${h(f.name)}</a>
      <span class="muted small">${fmtSize(f.size)}</span>
      ${locked ? "" : `<button type="button" class="icon del-file" title="Delete" aria-label="Delete ${h(f.name)}">✕</button>`}
    </div>`;
}

function attachmentsSection(x, kind, placed = placedIds(x.notes)) {
  const inText = new Set(placed);
  const files = (x.attachments || []).filter((f) => !inText.has(f.id));
  const locked = x.deleted_at;
  const p = kind === "task" && x.project_id && projectById(x.project_id);
  const shared = p?.attachments || [];
  return `<div class="attachments">
    <div class="att-head">Attachments
      ${locked ? "" : `<button type="button" class="link add-files">+ Add files</button>
        <input type="file" class="file-input" multiple hidden>`}</div>
    ${files.map((f) => locked || !IMAGE_TYPES.includes(f.mime) ? fileRow(f, locked)
      : fileRow(f, locked).replace('<span class="muted small">', '<button type="button" class="link place-pic" ' +
        'title="Put it in the text, where the cursor was">Put in the text</button> <span class="muted small">')).join("")}
    ${locked ? "" : `<p class="muted small hint">${files.length ? "" : "None yet. "}Drop files here, or paste an image. Up to 25 MB each.${
      kind === "project" ? " They go with all of the project's tasks." : ""}</p>`}
    ${shared.length ? `<div class="att-head muted small">From the project “${h(p.name)}”</div>
      ${shared.map((f) => fileRow(f, true)).join("")}` : ""}
  </div>`;
}

// Uploads files to the task or project sel ({kind, id}).
// Uploads files (File or Blob, each with a name) to a task, project or note (kind, id): the
// server's reply (it, with "added", the new files' ids), or null after saying what went wrong.
// quiet: no "Uploading…" or "Added" messages.
async function uploadTo(kind, id, files, { quiet = false } = {}) {
  if (!files.length) return null;
  if (!id || id < 0) { toast(`Wait until this ${kind} has been saved (when you're back online), then add files.`); return null; }
  if (files.some((f) => f.size > 25 * 1048576)) { toast("Files can be up to 25 MB each."); return null; }
  const form = new FormData();
  for (const f of files) form.append("file", f, f.name || "pasted.png");
  if (!quiet) toast(files.length > 1 ? `Uploading ${files.length} files…` : `Uploading ${files[0].name || "the picture"}…`);
  let res;
  try {
    res = await fetch(`${BASE}/api/${kind}s/${id}/attachments`, { method: "POST", body: form, headers: { "X-Requested-With": "entropicide" } });
  } catch {
    toast("You're offline. Pictures and files need a connection.");
    return null;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { toast(data.error || "Couldn't upload that."); return null; }
  if (!quiet) {
    const pics = data.added.filter((x) => IMAGE_TYPES.includes(data.attachments.find((f) => f.id === x)?.mime)).length;
    toast(files.length > 1 ? `Added ${files.length} files.` : pics ? "Picture added." : "File added.");
  }
  return data;
}

// Deletes one of x's files (asking first, unless ask is false): the server's reply (x as it is
// now), or null.
async function deleteAttachment(x, fileId, { ask = true, quiet = false } = {}) {
  const f = x?.attachments.find((y) => y.id === fileId);
  if (!f || (ask && !confirm(`Delete ${f.name}?`))) return null;
  return api("DELETE", `/attachments/${fileId}`, undefined, { quiet }).catch(() => null);
}

// The attachments section's files, for the task or project sel ({kind, id}).
async function uploadFiles(sel, files) {
  const data = sel && await uploadTo(sel.kind, sel.id, files);
  if (!data) return;
  if (sel.kind === "project") replaceProject(data); else replaceTask(data);
  $("#detail").dataset.key = "";
  render();
}

async function deleteFile(fileId) {
  const owner = await deleteAttachment(selItem(), fileId);
  if (!owner) return;
  if (S.selected.kind === "project") replaceProject(owner); else replaceTask(owner);
  $("#detail").dataset.key = "";
  render();
}

// ---- file viewer ----
// Images, PDFs and text files open over the task instead of in a new tab (which, in the
// Android app, leaves the app). PDFs are drawn with pdf.js (static/vendor/pdfjs, 4.10.38),
// loaded the first time one is opened: Chrome on Android can't show a PDF in a page.
// ← / → (or a swipe) go between the task's files; Esc or the phone's Back closes.

const viewable = (f) => IMAGE_TYPES.includes(f.mime) || ["application/pdf", "text/plain"].includes(f.mime);
const viewer = { files: [], at: 0, zoom: 1, pdf: null, run: 0 };
let pdfjsLoading = null;

function loadPdfjs() {
  pdfjsLoading ||= import(BASE + "/static/vendor/pdfjs/pdf.min.mjs").then((lib) => {
    lib.GlobalWorkerOptions.workerSrc = BASE + "/static/vendor/pdfjs/pdf.worker.min.mjs";
    return lib;
  }).catch((err) => { pdfjsLoading = null; throw err; });
  return pdfjsLoading;
}

function openViewer(files, fileId) {
  viewer.files = files.filter(viewable);
  viewer.at = Math.max(0, viewer.files.findIndex((f) => f.id === fileId));
  if (!viewer.files.length) return;
  const dlg = $("#viewer");
  if (!dlg.open) {
    dlg.showModal();
    history.pushState({ viewer: true }, "");  // so Back closes the viewer, not the app
  }
  showViewerFile();
}

function closeViewer() {
  if (history.state?.viewer) history.back();  // which closes it (popstate, below)
  else $("#viewer").close();
}

function stepViewer(by) {
  const n = viewer.files.length;
  if (n < 2) return;
  viewer.at = (viewer.at + by + n) % n;
  showViewerFile();
}

function showViewerFile() {
  const f = viewer.files[viewer.at];
  const run = ++viewer.run;  // a newer file (or zoom) makes an older render stop
  viewer.pdf?.destroy();
  viewer.pdf = null;
  viewer.zoom = 1;
  const n = viewer.files.length;
  const dlg = $("#viewer");
  $(".viewer-name", dlg).textContent = f.name;
  $(".viewer-count", dlg).textContent = n > 1 ? `${viewer.at + 1} of ${n}` : "";
  for (const b of dlg.querySelectorAll(".viewer-step")) b.hidden = n < 2;
  for (const b of dlg.querySelectorAll(".viewer-zoom")) b.hidden = f.mime !== "application/pdf";
  const save = $(".viewer-save", dlg);
  save.href = fileUrl(f);
  save.download = f.name;
  const body = $(".viewer-body", dlg);
  body.className = "viewer-body";
  body.scrollTo(0, 0);
  if (IMAGE_TYPES.includes(f.mime)) {
    body.innerHTML = `<img src="${h(fileUrl(f))}" alt="${h(f.name)}" title="Click for full size">`;
  } else if (f.mime === "text/plain") {
    body.innerHTML = `<p class="muted">Loading…</p>`;
    fetch(fileUrl(f)).then((r) => r.ok ? r.text() : Promise.reject())
      .then((text) => { if (run === viewer.run) body.innerHTML = `<pre class="viewer-text">${h(text)}</pre>`; })
      .catch(() => { if (run === viewer.run) body.innerHTML = viewerFailed(f); });
  } else {
    body.innerHTML = `<p class="muted">Loading…</p>`;
    loadPdfjs()
      .then((lib) => lib.getDocument({ url: fileUrl(f), isEvalSupported: false }).promise)
      .then((pdf) => {
        if (run !== viewer.run) return pdf.destroy();
        viewer.pdf = pdf;
        return drawPdf(run);
      })
      .catch(() => { if (run === viewer.run) body.innerHTML = viewerFailed(f); });
  }
}

const viewerFailed = (f) => `<p class="muted">Couldn't show ${h(f.name)} here.
  <a href="${h(fileUrl(f))}" download="${h(f.name)}">Download it</a> instead.</p>`;

// Every page, as wide as the window (times the zoom), drawn sharp for the screen.
async function drawPdf(run) {
  const body = $("#viewer .viewer-body");
  body.classList.add("pdf");
  body.innerHTML = "";
  const width = (body.clientWidth - 16) * viewer.zoom;
  const ratio = window.devicePixelRatio || 1;
  for (let i = 1; i <= viewer.pdf.numPages; i++) {
    const page = await viewer.pdf.getPage(i);
    if (run !== viewer.run) return;
    const view = page.getViewport({ scale: width / page.getViewport({ scale: 1 }).width });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(view.width * ratio);
    canvas.height = Math.floor(view.height * ratio);
    canvas.style.width = `${Math.floor(view.width)}px`;
    canvas.setAttribute("aria-label", `Page ${i}`);
    body.append(canvas);
    await page.render({ canvasContext: canvas.getContext("2d"), viewport: view,
      transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0] }).promise;
  }
}

function zoomPdf(by) {
  if (!viewer.pdf) return;
  const body = $("#viewer .viewer-body");
  const where = body.scrollTop / Math.max(1, body.scrollHeight);  // keep the same spot in view
  viewer.zoom = Math.min(4, Math.max(0.5, viewer.zoom * by));
  const run = ++viewer.run;
  drawPdf(run).then(() => { if (run === viewer.run) body.scrollTop = where * body.scrollHeight; });
}

function bindViewer() {
  const dlg = $("#viewer");
  const body = $(".viewer-body", dlg);
  dlg.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (b?.classList.contains("viewer-close")) closeViewer();
    else if (b?.dataset.step) stepViewer(Number(b.dataset.step));
    else if (b?.dataset.zoom) zoomPdf(Number(b.dataset.zoom));
    else if (e.target.matches(".viewer-body img")) body.classList.toggle("full");
    else if (e.target === body) closeViewer();  // the dark space around a picture
  });
  // On the whole page, ahead of the app's keys: a button that was focused can be hidden by
  // the next file (zoom, for a picture), leaving the focus outside the viewer.
  document.addEventListener("keydown", (e) => {
    if (!dlg.open) return;
    e.stopPropagation();
    if (e.key === "Escape") { e.preventDefault(); closeViewer(); }  // just the viewer, not the task too
    else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      stepViewer(e.key === "ArrowLeft" ? -1 : 1);
    } else if ((e.key === "+" || e.key === "=" || e.key === "-") && viewer.pdf) {
      e.preventDefault();
      zoomPdf(e.key === "-" ? 1 / 1.25 : 1.25);
    }
  }, true);
  // Close through history too, so Back isn't left with a step that does nothing.
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); closeViewer(); });
  dlg.addEventListener("close", () => {
    viewer.run++;
    viewer.pdf?.destroy();
    viewer.pdf = null;
    body.innerHTML = "";
  });
  window.addEventListener("popstate", () => { if (dlg.open) dlg.close(); });
  // Swipe left/right between files (not while a picture is at full size, or a PDF zoomed in).
  let start = null;
  body.addEventListener("touchstart", (e) => {
    start = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
  }, { passive: true });
  body.addEventListener("touchend", (e) => {
    if (!start || body.classList.contains("full") || viewer.zoom > 1) return;
    const dx = e.changedTouches[0].clientX - start.x, dy = e.changedTouches[0].clientY - start.y;
    if (Math.abs(dx) > 60 && Math.abs(dx) > 2 * Math.abs(dy)) stepViewer(dx < 0 ? 1 : -1);
  });
}

// "Every N days…" asks for N; false if cancelled (the menu goes back to what it was).
function askEveryDays(select) {
  const t = S.selected?.kind === "task" && taskById(S.selected.id);
  const answer = prompt("Repeat every… (e.g. 9 days, 2 weeks, 3 months, 1 year)",
    parseEvery(t?.repeat) ? repeatLabel(t.repeat).replace(/^every /, "") : "2 weeks");
  const value = readEvery(String(answer ?? "").replace(/^(a|an)\b/i, "1"));
  if (!value) {
    select.value = t?.repeat || "";
    if (answer?.trim()) toast("Try e.g. 9 days, 2 weeks, 3 months or 1 year (up to 999).");
    return false;
  }
  if (![...select.options].some((o) => o.value === value)) select.add(new Option(repeatLabel(value), value), select.options.length - 1);
  select.value = value;
  return true;
}

function bindDetail() {
  const el = $("#detail");
  el.addEventListener("input", (e) => {
    if (e.target.matches(".people-search")) {
      const t = taskById(S.selected.id);
      $(".people-results", el).innerHTML = peopleMatches(t, e.target.value).map((c) =>
        `<button type="button" class="link add-person" data-person="${h(c.id)}">${h(c.name)}${
          c.nicknames.length ? ` <span class="muted small">${h(c.nicknames.join(", "))}</span>` : ""}</button>`).join("") ||
        (e.target.value.trim() ? '<span class="muted small">No contact matches.</span>' : "");
      return;
    }
    if (e.target.matches(".ref-search")) {
      const x = selItem(), box = e.target.closest("[data-refs]"), field = box.dataset.refs;
      const found = refMatches(x, S.selected.kind, e.target.value, new Set(refs(x, field)), field === "blocked_by");
      $(".ref-results", box).innerHTML = refResults(found, "ref-add") ||
        (e.target.value.trim() ? '<span class="muted small">No open task or project matches.</span>' : "");
      return;
    }
    const input = e.target.closest("[data-field]");
    if (!input || !["INPUT", "TEXTAREA"].includes(input.tagName) || input.type === "checkbox"
        || input.type === "date" || input.type === "time" || input.type === "datetime-local") return;
    clearTimeout(saveTimer);
    // Bind the save to this item now: the editor may be closed before it fires.
    const sel = S.selected;
    saveTimer = setTimeout(() => saveField(input, sel), 600);
  });
  // (toggle doesn't bubble)
  el.addEventListener("toggle", (e) => {
    if (e.target.matches(".d-more")) save("editorMore", e.target.open ? "open" : "");
  }, true);
  el.addEventListener("change", async (e) => {
    if (e.target.matches(".remind-mode")) {
      remindMode(e.target);
      return;
    }
    if (e.target.matches(".nth-n, .nth-day")) {
      $("#detail").dataset.key = "";
      await patchTask(S.selected.id, { repeat: `nth:${$(".nth-n", el).value}:${$(".nth-day", el).value}` });
      return refresh();
    }
    if (e.target.matches(".file-input")) {
      uploadFiles(S.selected, [...e.target.files]);
      return;
    }
    const input = e.target.closest("[data-field]");
    if (!input) return;
    clearTimeout(saveTimer);
    if (input.type === "date" || input.type === "time") {
      // Browsers report a "valid" date after each typed digit (year 0002...),
      // so typed dates wait for blur/Enter; picker choices save right away.
      if (!input.dataset.typed) saveDate(input);
      return;
    }
    if (input.dataset.field === "repeat" && input.value === "every" && !askEveryDays(input)) return;
    if (input.dataset.field === "repeat" && input.value === "nth") {
      // Starts as the weekday of the task's date (the 2nd Tuesday, say); the menus below change it.
      const t = taskById(S.selected.id);
      const value = nthOf(t.start_date || t.due_date || today());
      if (![...input.options].some((o) => o.value === value)) input.add(new Option(repeatLabel(value), value), input.options.length - 3);
      input.value = value;
    }
    if (input.dataset.field === "repeat" && input.value === "days") {
      // Starts as the day of the task's date (or today); the buttons below add the others.
      const t = taskById(S.selected.id);
      const value = daysValue([weekDay(t.start_date || t.due_date || today())]);
      if (![...input.options].some((o) => o.value === value)) input.add(new Option(repeatLabel(value), value), input.options.length - 2);
      input.value = value;
    }
    if (input.type === "datetime-local") {
      // Saved when complete; the panel is redrawn to offer Clear.
      if (input.value && !validDate(input.value.slice(0, 10))) return;
      await saveField(input);
      $("#detail").dataset.key = "";
      return render();
    }
    $("#detail").dataset.key = "";
    saveField(input);
    // A focused menu would swallow shortcuts like N, and letters typed later would change it.
    if (input.tagName === "SELECT") input.blur();
  });
  el.addEventListener("keydown", (e) => {
    const input = e.target.closest('input[type="date"], input[type="time"]');
    if (!input) return;
    if (e.key === "Enter") input.blur();
    else if (e.key.length === 1 || e.key === "Backspace" || e.key === "Delete") {
      input.dataset.typed = "1";
    }
  });
  el.addEventListener("focusout", (e) => {
    const input = e.target.closest('input[type="date"], input[type="time"]');
    if (input?.dataset.typed) saveDate(input);
  });
  // Files dropped on, or images pasted into, an open task are attached to it.
  const taskOpen = () => { const x = selItem(); return x && !x.deleted_at; };
  el.addEventListener("dragover", (e) => {
    if (!taskOpen() || !e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    el.classList.add("file-over");
  });
  el.addEventListener("dragleave", (e) => { if (!el.contains(e.relatedTarget)) el.classList.remove("file-over"); });
  el.addEventListener("drop", (e) => {
    el.classList.remove("file-over");
    if (!taskOpen() || !e.dataTransfer.files.length) return;
    e.preventDefault();
    uploadFiles(S.selected, [...e.dataTransfer.files]);
  });
  el.addEventListener("paste", (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (!taskOpen() || !files.length) return;
    e.preventDefault();
    uploadFiles(S.selected, files);
  });

  el.addEventListener("click", async (e) => {
    const view = e.target.closest("a.att-view");
    // (Ctrl/⌘/Shift-click still opens the file in a new tab or window.)
    if (view && !(e.ctrlKey || e.metaKey || e.shiftKey) && e.button === 0) {
      e.preventDefault();
      return openViewer(detailFiles(), Number(view.closest("[data-file]").dataset.file));
    }
    const b = e.target.closest("button");
    if (!b) return;
    const sel = S.selected;
    if (b.dataset.wd) {
      const days = parseDays(taskById(sel.id).repeat) || [];
      const d = Number(b.dataset.wd);
      const next = days.includes(d) ? days.filter((x) => x !== d) : [...days, d];
      if (!next.length) return toast("Pick at least one day (or set Repeat to Never).");
      $("#detail").dataset.key = "";
      await patchTask(sel.id, { repeat: daysValue(next) });
      await refresh();
    }
    else if (b.classList.contains("d-star")) {
      $("#detail").dataset.key = "";
      await patchTask(sel.id, { focus: !taskById(sel.id).focus });
    }
    else if (b.dataset.until) snoozeTask(sel.id, b.dataset.until);
    else if (b.matches(".ref-add, .ref-del")) {
      const field = b.closest("[data-refs]").dataset.refs, id = Number(b.dataset.ref || b.closest("[data-ref]").dataset.ref);
      const now = refs(selItem(), field);
      setRefs(field, b.classList.contains("ref-add") ? [...now, id] : now.filter((r) => r !== id));
    }
    else if (b.classList.contains("ref-open")) openRef(b.closest("[data-ref]").dataset.ref);
    else if (b.classList.contains("add-person")) setPeople(sel.id, [...(taskById(sel.id).people || []), b.dataset.person]);
    else if (b.classList.contains("del-person")) {
      const gone = b.closest("[data-person]").dataset.person;
      setPeople(sel.id, taskById(sel.id).people.filter((id) => id !== gone));
    }
    else if (b.classList.contains("convert-task")) openConvert(taskById(sel.id));
    else if (b.classList.contains("task-to-note")) taskToNote(taskById(sel.id));
    else if (b.classList.contains("save-template")) saveAsTemplate(sel.id, false);
    else if (b.classList.contains("reset-spent")) { $("#detail").dataset.key = ""; await patchTask(sel.id, { spent: 0 }); }
    else if (b.classList.contains("start-timer")) openTimer(sel.id);
    else if (b.classList.contains("update-template")) saveAsTemplate(sel.id, true);
    else if (b.classList.contains("clear-remind")) { $("#detail").dataset.key = ""; await patchTask(sel.id, { remind_at: null, remind_before: null }); }
    else if (b.classList.contains("add-files")) $(".file-input", el).click();
    else if (b.classList.contains("place-pic") && $(".d-text", el)?.host && !b.closest(".d-text")) {
      const host = $(".d-text", el).host;
      ed = host;
      if (host.source) setSource(host, false);
      insertPictures([Number(b.closest("[data-file]").dataset.file)]);
      host.changed();
      host.filesChanged();
    }
    else if (b.classList.contains("del-file")) deleteFile(Number(b.closest("[data-file]").dataset.file));
    else if (b.classList.contains("close")) { S.selected = null; render(); }
    else if (b.dataset.state) {
      const changes = { state: b.dataset.state };
      const t = taskById(sel.id);
      if (b.dataset.state === "scheduled" && !t.start_date) changes.start_date = addDays(today(), 1);
      $("#detail").dataset.key = "";
      await patchTask(sel.id, changes);
    }
    else if (b.classList.contains("delete-task")) await trashTask(sel.id);
    else if (b.classList.contains("restore-task")) {
      await patchTask(sel.id, { deleted: false }); S.selected = null; render();
    }
    else if (b.classList.contains("purge-task")) {
      if (!confirm("Delete this task forever?")) return;
      await api("DELETE", `/documents/${sel.id}`); S.selected = null; await refresh();
    }
    else if (b.classList.contains("open-project")) setView(`project:${sel.id}`);
    else if (b.classList.contains("open-subproject")) { setView(`project:${b.dataset.project}`); select("project", Number(b.dataset.project)); }
    else if (b.classList.contains("new-subproject")) newProject(projectById(sel.id));
    else if (b.classList.contains("convert-to")) convertTo(sel.id, b.dataset.to);
    else if (b.classList.contains("delete-project")) {
      if (!confirm("Move this project and everything in it to the trash?")) return;
      const id = sel.id;
      S.selected = null;
      if (S.view === `project:${id}`) S.view = "projects";
      await patchProject(id, { deleted: true });
      toast("Project moved to trash.", () => patchProject(id, { deleted: false }));
    }
  });
}

// ---- settings dialog -----------------------------------------------------

async function openSettings() {
  const dlg = $("#dialog");
  const me = S.data.user;
  const users = me.is_admin ? await api("GET", "/admin/users") : [];
  // A toast shown inside the dialog would be wiped out by the redraw: lift it out, then back.
  const note = $("#toast");
  document.body.append(note);
  dlg.innerHTML = `
    <form method="dialog" class="dlg-head"><h2>Settings</h2><button class="icon" aria-label="Close">✕</button></form>

    <section>
      <h3>Areas</h3>
      <p class="muted small">Areas (like Work or Home) let you filter the whole app from the sidebar.
        An area's icon (an SVG) shows before each of its tasks.</p>
      <ul class="plain areas">${S.data.areas.map((a) => `<li data-area="${a.id}">${areaRow(a)}</li>`).join("")}</ul>
      <form class="inline add-area"><input name="name" placeholder="New area" required><button>Add</button></form>
    </section>

    <section>
      <h3>Tags</h3>
      <p class="muted small">Rename a tag to an existing name to merge them.</p>
      <ul class="plain">${S.data.tags.map((t) => `<li data-tag-id="${t.id}">
        <input value="${h(t.name)}" class="tag-name" aria-label="Tag name">
        <button class="link danger del-tag">Delete</button></li>`).join("") || '<li class="muted">No tags yet.</li>'}</ul>
    </section>

    <section>
      <h3>Defer options</h3>
      <p class="muted small">The choices in a task's Defer menu, separated by commas: m (minutes), h (hours),
        d (days), w (weeks) or mo (months). Minutes and hours defer to an exact time; days, weeks and
        months to the start of that day. Custom… is always added.</p>
      <form class="inline defer-opts">
        <input name="defer" value="${h(me.settings.defer_options.join(", "))}" aria-label="Defer options">
        <button>Save</button>
      </form>
    </section>

    <section>
      <h3>Notes editor</h3>
      <p class="muted small">For this device only. <em>Vim</em> edits the text of tasks, projects and notes as its HTML,
        with Vim keys (normal, insert and visual modes, motions, <code>:w</code> to save, <code>:q</code> to close,
        <code>:check</code> to tick a checklist item); good with a keyboard, not on a phone.</p>
      <label class="check"><select class="notes-editor" aria-label="Notes editor">${options(
        [["plain", "Plain"], ["vim", "Vim"]], notesEditor())}</select></label>
    </section>

    <section>
      <h3>Text size</h3>
      <p class="muted small">For this device only, so a tablet can use larger text than a laptop.</p>
      <div class="inline text-size">
        <button type="button" class="ts-down" aria-label="Smaller text" ${textSize() <= TEXT_SIZES[0] ? "disabled" : ""}>A−</button>
        <strong class="ts-value">${textSize()}%</strong>
        <button type="button" class="ts-up" aria-label="Larger text" ${textSize() >= TEXT_SIZES.at(-1) ? "disabled" : ""}>A+</button>
        <button type="button" class="link ts-reset" ${textSize() === 100 ? "hidden" : ""}>Reset</button>
      </div>
    </section>

    ${googleSection()}

    <section>
      <h3>Phone app</h3>
      <p class="muted small">Install Entropicide on an Android phone or tablet (or add it to an iPhone's home screen).</p>
      <p><a href="${BASE}/install" target="_blank" rel="noopener">Install the app</a></p>
    </section>

    <section>
      <h3>Sharing to Entropicide</h3>
      <p class="muted small">In the installed app, Entropicide is in the phone's Share menu: share a photo, a page or
        some text from another app. Pictures shared to a note or journal are placed in its text.</p>
      <label>Put what's shared <select class="share-to">${options([["ask", "Ask each time"], ["inbox", "In the Inbox, as a task"],
        ["note", "In Notes, as a new note"],
        ...S.data.journals.map((j) => [`journal:${j.id}`, `In the journal “${j.name}”, as a new entry`])],
        me.settings.share_to)}</select></label>
    </section>

    <section>
      <h3>Your data</h3>
      <p class="muted small">Everything of yours (tasks, including completed and trashed ones, projects, areas,
        tags, links and attachments) in a zip: data.json, a tasks.csv for spreadsheets, and the files.</p>
      <p><a href="${BASE}/api/export" download>Download everything (.zip)</a></p>
    </section>

    <section class="notify">
      <h3>Notifications</h3>
      <p class="muted small">Reminders on your phone or computer: a task's <em>Remind me</em> time, when a timed
        task starts, and a morning summary. Turn them on on each device you want them on.</p>
      <p class="push-state muted small">Checking…</p>
      <p class="push-buttons"><button type="button" class="push-toggle" hidden></button>
        <button type="button" class="link push-test" hidden>Send a test</button></p>
      <label class="check"><input type="checkbox" class="notify-starts" ${me.settings.notify_starts ? "checked" : ""}>
        When a timed task starts</label>
      <label class="check"><input type="checkbox" class="digest-on" ${me.settings.digest_time ? "checked" : ""}>
        A morning summary of what's due, at
        <input type="time" class="digest-time" value="${h(me.settings.digest_time || "08:00")}" aria-label="Summary time"></label>
      <label class="check"><input type="checkbox" class="quiet-on" ${me.settings.quiet_hours ? "checked" : ""}>
        Quiet hours: none from
        <input type="time" class="quiet-from" value="${h(me.settings.quiet_hours.split("-")[0] || "22:00")}" aria-label="Quiet from">
        to <input type="time" class="quiet-to" value="${h(me.settings.quiet_hours.split("-")[1] || "07:00")}" aria-label="Quiet until">;
        they arrive when they end</label>
    </section>

    <section class="storage">
      <h3>Attachments</h3>
      <p class="storage-state muted small">Checking…</p>
      <div class="storage-bar" hidden><div></div></div>
      <ul class="plain storage-list"></ul>
    </section>

    ${me.is_admin ? `<section class="backups">
      <h3>Backups</h3>
      <p class="muted small">The server backs up the whole database every night, keeping the last 7 days,
        4 Sundays and 12 month-starts. They're on the same disk as the app, so keep a copy elsewhere too:
        download one now and then.</p>
      <p class="backup-status muted small">Checking…</p>
      <p><a href="${BASE}/api/admin/backup" download>Download a full backup now (.db.gz)</a></p>
    </section>` : ""}

    <section class="devices">
      <h3>Add from the phone</h3>
      <p class="muted small">Connect the Android app to add tasks from its notification (reply in place, like
        a text message) or its <b>Add task</b> Quick Settings tile, without leaving the app you're in.</p>
      <div class="device-state small">…</div>
    </section>

    <section class="api-keys">
      <h3>Add from other apps</h3>
      <p class="muted small">Give another app or gadget a key of its own to add tasks: an Alexa skill, Home
        Assistant, a phone shortcut, a script. It sends the text of the task, read just like quick add.
        A key can also be allowed to read your lists (Focus, Queue, …), to say or show what's due, and
        to complete tasks.
        <a href="${BASE}/help#add-api" target="_blank" rel="noopener">How</a></p>
      <div class="api-key-state small">…</div>
    </section>

    <section>
      <h3>Troubleshooting</h3>
      <p class="app-version small">Android app: …</p>
      <p class="muted small"><a href="${BASE}/debug" target="_blank" rel="noopener">App log</a>: every use
        of the Share menu and every launch of the Android app, with what arrived and what happened.</p>
    </section>

    <section>
      <h3>Change password</h3>
      <form class="stack change-pw">
        <input type="password" name="current" placeholder="Current password" autocomplete="current-password" required>
        <input type="password" name="new" placeholder="New password (8+ characters)" autocomplete="new-password" minlength="8" required>
        <button>Change password</button>
      </form>
    </section>

    ${me.is_admin ? `<section>
      <h3>Users</h3>
      <table class="users">
        <thead><tr><th>User</th><th>Admin</th><th>Active</th><th>Last sign-in</th><th></th></tr></thead>
        <tbody>${users.map((u) => `<tr data-user="${u.id}">
          <td><strong>${h(u.username)}</strong><br><span class="muted small">${h(u.display_name)}</span></td>
          <td><input type="checkbox" class="u-admin" ${u.is_admin ? "checked" : ""} ${u.id === me.id ? "disabled" : ""}></td>
          <td><input type="checkbox" class="u-active" ${u.disabled ? "" : "checked"} ${u.id === me.id ? "disabled" : ""}></td>
          <td class="small">${u.last_login ? h(u.last_login.slice(0, 16)) : "never"}</td>
          <td><button class="link u-reset">Reset password</button>
              ${u.id === me.id ? "" : '<button class="link danger u-delete">Delete</button>'}</td>
        </tr>`).join("")}</tbody>
      </table>
      <form class="stack add-user">
        <h4>Add a user</h4>
        <input name="username" placeholder="Username" autocapitalize="none" required>
        <input name="display_name" placeholder="Display name (optional)">
        <input name="password" type="password" placeholder="Temporary password (8+ characters)" autocomplete="new-password" minlength="8" required>
        <label class="check"><input type="checkbox" name="is_admin"> Admin (can manage users)</label>
        <button>Add user</button>
      </form>
    </section>` : ""}`;
  if (!dlg.open) dlg.showModal();
  if (!note.hidden) dlg.append(note);
  if (S.data.google.connected) fillCalendarChoice();
  if (me.is_admin) fillBackupStatus();
  fillAppVersion();
  fillDevices();
  fillApiKeys();
  fillPushState();
  fillStorage();
}

// ---- notifications (Settings) ----

const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

function deviceName() {
  const ua = navigator.userAgent;
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iPhone/iPad" : /Windows/.test(ua) ? "Windows"
    : /Mac/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "";
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome"
    : /Safari\//.test(ua) ? "Safari" : "browser";
  return [browser, os].filter(Boolean).join(" on ");
}

function keyBytes(b64) {
  const raw = atob(b64.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((b64.length + 3) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function fillPushState() {
  const state = $("#dialog .push-state"), toggle = $("#dialog .push-toggle"), test = $("#dialog .push-test");
  if (!state) return;
  if (!pushSupported()) {
    state.textContent = /iPhone|iPad/.test(navigator.userAgent)
      ? "On an iPhone or iPad, add Entropicide to the Home Screen first (Share → Add to Home Screen), then open it from there."
      : "This browser can't show notifications.";
    return;
  }
  try {
    const reg = await navigator.serviceWorker.ready;
    const [sub, status] = await Promise.all([reg.pushManager.getSubscription(), api("GET", "/push", undefined, { quiet: true })]);
    const here = !!sub && status.devices.some((d) => d.endpoint === sub.endpoint);
    const n = status.devices.length;
    S.data.user.push_devices = n;
    state.textContent = (here ? "On for this device." : Notification.permission === "denied"
      ? "Blocked for this site in this browser's settings; allow notifications there first." : "Off for this device.") +
      (n && !(here && n === 1) ? ` On for ${n} device${n > 1 ? "s" : ""} in all.` : "");
    toggle.hidden = Notification.permission === "denied" && !here;
    toggle.textContent = here ? "Turn off for this device" : "Turn on for this device";
    toggle.dataset.on = here ? "1" : "";
    test.hidden = !n;
  } catch {
    state.textContent = "You're offline, or notifications couldn't be checked.";
  }
}

async function togglePush(on) {
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (on) {
    if (await Notification.requestPermission() !== "granted") return fillPushState();
    if (!sub) {
      const { key } = await api("GET", "/push");
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
    }
    await api("POST", "/push/subscribe", { ...sub.toJSON(), device: deviceName() });
    toast("Notifications are on for this device.");
  } else if (sub) {
    await api("POST", "/push/unsubscribe", { endpoint: sub.endpoint });
    await sub.unsubscribe();
  }
  fillPushState();
}

// ---- attachments' storage (Settings) ----

async function fillStorage() {
  const state = $("#dialog .storage-state");
  if (!state) return;
  try {
    const { used, limit, largest } = await api("GET", "/storage", undefined, { quiet: true });
    state.textContent = `Using ${fmtSize(used)} of ${fmtSize(limit)} (${(100 * used / limit).toFixed(used && used < limit / 1000 ? 2 : 0)}%).` +
      (largest.length ? " The largest:" : " No attachments yet.");
    const bar = $("#dialog .storage-bar");
    bar.hidden = false;
    bar.firstElementChild.style.width = `${Math.max(used ? 0.5 : 0, Math.min(100, 100 * used / limit))}%`;
    $("#dialog .storage-list").innerHTML = largest.map((f) => `<li class="storage-file">
      <a href="${h(fileUrl(f))}" target="_blank" rel="noopener">${h(f.name)}</a>
      <span class="muted small">${fmtSize(f.size)}</span>
      <button type="button" class="link open-task" ${f.project_id ? `data-project="${f.project_id}" title="Open the project"`
        : f.note_id ? `data-note="${f.note_id}" title="Open the note"` : `data-task="${f.task_id}" title="Open the task"`}>${h(f.title)}${
        f.deleted_at ? " (in trash)" : f.completed_at ? " (done)" : ""}</button></li>`).join("");
  } catch {
    state.textContent = "Couldn't check (you may be offline).";
  }
}

async function fillBackupStatus() {
  const el = $("#dialog .backup-status");
  try {
    const { dir, backups } = await api("GET", "/admin/backups", undefined, { quiet: true });
    const last = backups[0];
    el.textContent = last
      ? `Last backup: ${dayHeading(last.date)} (${fmtSize(last.size)}). ${backups.length} kept in ${dir}.`
      : `No backups yet in ${dir}. The first is made when the app is installed, then nightly.`;
    el.classList.toggle("error", !last || last.date < addDays(today(), -2));
  } catch {
    el.textContent = "Couldn't check the backups.";
  }
}

async function fillCalendarChoice() {
  const sel = $("#dialog .g-calendar");
  if (!sel) return;  // (Google sign-in since turned off on the server)
  const g = S.data.google;
  let cals;
  try { cals = await api("GET", "/google/calendars"); } catch { sel.innerHTML = "<option>Couldn't load calendars</option>"; return; }
  const current = !g.calendar_chosen ? "" : g.calendar_owned ? "new" : g.calendar_id;
  sel.innerHTML = (g.calendar_chosen ? "" : '<option value="" selected disabled>Choose…</option>') +
    options([["new", "A new “Entropicide” calendar"], ...cals.map((c) => [c.id, c.name])], current);
  sel.dataset.current = current;
}

function googleSection() {
  const g = S.data.google;
  let body;
  if (!g.available) {
    body = `<p class="muted small">Not set up on this server yet.${S.data.user.is_admin
      ? " See “Google Calendar” in the README for the one-time setup." : ""}</p>`;
  } else if (!g.connected) {
    body = `<p class="muted small">Puts tasks that have a start or due date on a Google calendar of your
      choice and keeps the two in step: move, rename or delete a task's event there and the task follows.
      Your calendars' events show in Focus and in a Calendar list. Your contacts (read only) can be named
      in tasks, with @Mom, to call, text, email or find them from there.</p>
      <button class="primary g-connect">Connect Google Calendar</button>`;
  } else {
    const where = !g.calendar_chosen ? ""
      : g.calendar_owned
      ? `Tasks go on a “Entropicide” calendar the app made; events you add to it in Google become tasks.
         Disconnecting deletes that calendar.`
      : `Tasks are added to “${h(g.calendar_name)}” next to its own events, so anyone it's shared with sees
         them. Only the tasks' events sync back; its other events show in Focus and Calendar but don't
         become tasks. Disconnecting removes just the tasks' events.`;
    body = `<p>Connected as <strong>${h(g.email || "your Google account")}</strong>.
      <span class="muted small">${g.last_sync ? "Last synced " + h(fmtAgo(g.last_sync)) + "." : "Not synced yet."}</span></p>
      ${g.error ? `<p class="error small">${h(g.error)}</p>` : ""}
      <label class="g-cal-label${g.calendar_chosen ? "" : " needs-choice"}">Tasks go on
        <select class="g-calendar"><option>Loading calendars…</option></select></label>
      ${g.calendar_chosen ? "" : '<p class="error small">Choose a calendar to start syncing your tasks.</p>'}
      <p class="muted small">${where} Syncs every minute and shortly after each change. Deleting a task's
        event in Google moves the task to the Trash.</p>
      <p class="muted small">${g.contacts
        ? `Contacts: ${S.data.contacts.length} copied from Google, read only (refreshed every hour, and
           by Sync now), to name in tasks with @: @Mom. Disconnecting deletes the copy.`
        : "To name your Google Contacts in tasks (@Mom), click Reconnect and tick the box for Google Contacts."}</p>
      ${g.contacts_error ? `<p class="error small">${h(g.contacts_error)}</p>` : ""}
      <div class="inline">
        ${g.error?.includes("Reconnect") || !g.contacts || g.contacts_error?.includes("Reconnect")
          ? '<button class="primary g-connect">Reconnect</button>' : ""}
        <button class="g-sync">Sync now</button>
        <button class="link danger g-disconnect">Disconnect</button>
      </div>`;
  }
  return `<section class="google"><h3>Google Calendar</h3>${body}</section>`;
}

function bindSettings() {
  const dlg = $("#dialog");
  dlg.addEventListener("close", () => refresh());
  dlg.addEventListener("submit", async (e) => {
    const f = e.target;
    if (f.method === "dialog") return;
    e.preventDefault();
    const data = Object.fromEntries(new FormData(f));
    if (f.classList.contains("defer-opts")) {
      const opts = data.defer.split(",").map((s) => s.trim()).filter(Boolean);
      S.data.user.settings = await api("PATCH", "/me/settings", { defer_options: opts });
      f.defer.value = S.data.user.settings.defer_options.join(", ");
      toast("Defer options saved.");
    } else if (f.classList.contains("add-area")) {
      await api("POST", "/areas", data);
      S.data = await api("GET", "/data?now=" + nowStamp());
      openSettings();
    } else if (f.classList.contains("change-pw")) {
      await api("POST", "/me/password", data);
      f.reset();
      toast("Password changed.");
    } else if (f.classList.contains("add-user")) {
      data.is_admin = f.is_admin.checked;
      await api("POST", "/admin/users", data);
      toast(`Added ${data.username}.`);
      openSettings();
    }
  });
  dlg.addEventListener("change", async (e) => {
    const t = e.target;
    if (t.classList.contains("notes-editor")) {
      save("notesEditor", t.value);
      if (t.value === "vim") loadVim().catch(() => toast("Couldn't load the Vim editor. Are you offline?"));
      $("#detail").dataset.key = "";
      toast(t.value === "vim" ? "Text opens as HTML, with Vim keys, on this device." : "Text uses the plain editor on this device.");
      return;
    }
    if (t.classList.contains("share-to")) {
      S.data.user.settings = await api("PATCH", "/me/settings", { share_to: t.value });
      toast("Saved.");
      return;
    }
    if (t.classList.contains("notify-starts")) {
      S.data.user.settings = await api("PATCH", "/me/settings", { notify_starts: t.checked });
      return;
    }
    if (t.matches(".quiet-on, .quiet-from, .quiet-to")) {
      const on = $("#dialog .quiet-on").checked, from = $("#dialog .quiet-from").value, to = $("#dialog .quiet-to").value;
      if (on && (!from || !to || from === to)) return toast("Quiet hours need two different times.");
      S.data.user.settings = await api("PATCH", "/me/settings", { quiet_hours: on ? `${from}-${to}` : "" });
      return;
    }
    if (t.classList.contains("digest-on") || t.classList.contains("digest-time")) {
      const on = $("#dialog .digest-on").checked, at = $("#dialog .digest-time").value;
      S.data.user.settings = await api("PATCH", "/me/settings", { digest_time: on && at ? at : "" });
      return;
    }
    if (t.classList.contains("g-calendar")) {
      const name = t.selectedOptions[0].textContent;
      if (t.dataset.current && !confirm(`Move your tasks' events to ${name}?`)) {
        t.value = t.dataset.current;
        return;
      }
      t.disabled = true;
      try {
        await api("POST", "/google/calendar", { id: t.value });
        S.data = await api("GET", "/data?now=" + nowStamp());
        toast(S.data.google.error ? "Sync failed." : `Your tasks are now on ${name}.`);
      } finally {
        openSettings();
      }
      return;
    }
    const area = t.closest("[data-area]");
    const tag = t.closest("[data-tag-id]");
    const user = t.closest("[data-user]");
    if (t.classList.contains("icon-file") && t.files[0]) {
      const file = t.files[0];
      if (file.size > 200_000) return toast("That SVG is too big (200 KB at most).");
      await setAreaIcon(area, { svg: await file.text() });
    } else if (t.classList.contains("area-name") && t.value.trim()) {
      await api("PATCH", `/areas/${area.dataset.area}`, { name: t.value });
    } else if (t.classList.contains("tag-name") && t.value.trim()) {
      await api("PATCH", `/tags/${tag.dataset.tagId}`, { name: t.value });
    } else if (t.classList.contains("u-admin")) {
      await api("PATCH", `/admin/users/${user.dataset.user}`, { is_admin: t.checked });
    } else if (t.classList.contains("u-active")) {
      await api("PATCH", `/admin/users/${user.dataset.user}`, { disabled: !t.checked });
    }
  });
  dlg.addEventListener("click", async (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    const area = b.closest("[data-area]");
    const tag = b.closest("[data-tag-id]");
    const user = b.closest("[data-user]");
    if (b.closest(".text-size")) {
      if (b.classList.contains("ts-reset")) setTextSize(100);
      else stepTextSize(b.classList.contains("ts-up") ? 1 : -1);
      const pct = textSize();
      $("#dialog .ts-value").textContent = pct + "%";
      $("#dialog .ts-down").disabled = pct <= TEXT_SIZES[0];
      $("#dialog .ts-up").disabled = pct >= TEXT_SIZES.at(-1);
      $("#dialog .ts-reset").hidden = pct === 100;
    } else if (b.classList.contains("push-toggle")) {
      b.disabled = true;
      try { await togglePush(!b.dataset.on); } finally { b.disabled = false; }
    } else if (b.classList.contains("push-test")) {
      const { sent } = await api("POST", "/push/test");
      toast(sent ? `Sent to ${sent} device${sent > 1 ? "s" : ""}.` : "No device could be reached.");
      fillPushState();
    } else if (b.classList.contains("open-task")) {
      $("#dialog").close();
      if (b.dataset.project) openRef(b.dataset.project);
      else if (b.dataset.note) openNoteById(Number(b.dataset.note));
      else openTask(Number(b.dataset.task));
    } else if (b.classList.contains("g-connect")) {
      location.href = BASE + "/google/connect";
    } else if (b.classList.contains("g-sync")) {
      b.disabled = true;
      b.textContent = "Syncing…";
      try {
        S.data.google = { ...S.data.google, ...await api("POST", "/google/sync") };
        S.data = await api("GET", "/data?now=" + nowStamp());
        toast(S.data.google.error ? "Sync failed." : "Synced with Google.");
      } finally {
        openSettings();
      }
    } else if (b.classList.contains("g-disconnect")) {
      if (!confirm("Disconnect Google Calendar? The Entropicide calendar is removed from Google; your tasks stay here.")) return;
      await api("POST", "/google/disconnect");
      S.data = await api("GET", "/data?now=" + nowStamp());
      if (S.view === "calendar") setView("focus");
      toast("Google Calendar disconnected.");
      openSettings();
    } else if (b.classList.contains("icon-url")) {
      const url = prompt("Address of the SVG icon (https://…)");
      if (url?.trim()) await setAreaIcon(area, { url: url.trim() });
    } else if (b.classList.contains("icon-remove")) {
      await setAreaIcon(area, null);
    } else if (b.classList.contains("del-area")) {
      if (!confirm("Delete this area? Its tasks and projects are kept.")) return;
      await api("DELETE", `/areas/${area.dataset.area}`);
      area.remove();
    } else if (b.classList.contains("del-tag")) {
      await api("DELETE", `/tags/${tag.dataset.tagId}`);
      tag.remove();
    } else if (b.classList.contains("u-reset")) {
      const pw = prompt("New password (8+ characters)");
      if (!pw) return;
      await api("PATCH", `/admin/users/${user.dataset.user}`, { password: pw });
      toast("Password reset.");
    } else if (b.classList.contains("u-delete")) {
      if (!confirm("Delete this user and all of their tasks? This can't be undone.")) return;
      await api("DELETE", `/admin/users/${user.dataset.user}`);
      user.remove();
    }
  });
}

// ---- quick-add completion ------------------------------------------------

// Suggestions for the "!word" or "#tag" being typed at the cursor.
const suggest = { items: [], pick: 0, start: 0 };

function bangWords() {
  return [...STATES.map(([, label]) => [label.toLowerCase(), `move to ${label}`]), ["focus", "star it"]];
}

function updateSuggest() {
  const input = $("#quick-add-input");
  const before = input.value.slice(0, input.selectionStart);
  const m = /(^|\s)([!#+@])([^\s!#+@]*)$/.exec(before);
  suggest.items = [];
  if (m && input.selectionStart === input.selectionEnd) {
    const [, , sigil, typed] = m;
    const pool = sigil === "!" ? bangWords()
      : sigil === "+" ? S.data.areas.map((a) => [a.name.replace(/\s+/g, ""), "area"])
      : sigil === "@" ? (S.data.contacts || []).flatMap((c) => [c.name, ...c.nicknames].map((name) =>
        [name.replace(/\s+/g, ""), name === c.name ? "contact" : c.name, name]))
      : S.data.tags.map((t) => [t.name, "tag"]);
    // (A contact also comes up by a later word of its name: @smi for Bob Smith.)
    const fits = (w, full = w) => [w, ...full.split(/\s+/).slice(1)].some((x) => x.toLowerCase().startsWith(typed.toLowerCase()));
    suggest.items = pool
      .filter(([w, , full]) => fits(w, full) && w !== typed)
      .slice(0, 8)
      .map(([w, hint]) => ({ text: sigil + w, hint }));
    suggest.start = before.length - typed.length - 1;
  }
  suggest.pick = 0;
  renderSuggest();
}

function renderSuggest() {
  const el = $("#suggest");
  el.hidden = !suggest.items.length;
  el.innerHTML = suggest.items.map((it, i) =>
    `<div role="option" data-i="${i}" class="${i === suggest.pick ? "on" : ""}" aria-selected="${i === suggest.pick}">
      <span>${h(it.text)}</span><span class="ctx-hint">${h(it.hint)}</span></div>`).join("");
}

function acceptSuggest(i = suggest.pick) {
  const input = $("#quick-add-input");
  const item = suggest.items[i];
  if (!item) return;
  const end = input.selectionStart;
  const after = input.value.slice(end).replace(/^\S*/, "");  // replace the rest of the word too
  input.value = input.value.slice(0, suggest.start) + item.text + " " + after.replace(/^\s+/, "");
  const caret = suggest.start + item.text.length + 1;
  input.setSelectionRange(caret, caret);
  suggest.items = [];
  renderSuggest();
}

function bindSuggest() {
  const input = $("#quick-add-input");
  input.addEventListener("input", updateSuggest);
  input.addEventListener("input", renderQuickWhen);
  input.addEventListener("click", updateSuggest);
  input.addEventListener("blur", () => { suggest.items = []; renderSuggest(); });
  input.addEventListener("keydown", (e) => {
    if (!suggest.items.length) return;
    const n = suggest.items.length;
    if (e.key === "Tab" && !e.shiftKey) { e.preventDefault(); acceptSuggest(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); suggest.pick = (suggest.pick + 1) % n; renderSuggest(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); suggest.pick = (suggest.pick - 1 + n) % n; renderSuggest(); }
    else if (e.key === "Escape") {
      e.stopPropagation();  // close the suggestions, not leave the bar
      suggest.items = [];
      renderSuggest();
    }
  });
  // mousedown, not click: keep the cursor in the bar (also works for taps).
  $("#suggest").addEventListener("mousedown", (e) => {
    const opt = e.target.closest("[data-i]");
    if (!opt) return;
    e.preventDefault();
    acceptSuggest(Number(opt.dataset.i));
  });
}

// ---- context menu --------------------------------------------------------

const DEFER_UNITS = { m: ["minute", 60e3], h: ["hour", 3600e3], d: ["day"], w: ["week"], mo: ["month"] };
// ids: the tasks the menu acts on; project: or the project's id, for a project's menu.
const menu = { ids: [], project: null, items: [], x: 0, y: 0, openedAt: 0 };

function parseDefer(opt) {
  const m = /^(\d+)(mo|m|h|d|w)$/.exec(opt);
  return m && { n: Number(m[1]), unit: m[2] };
}

function deferLabel({ n, unit }) {
  return `${n} ${DEFER_UNITS[unit][0]}${n === 1 ? "" : "s"}`;
}

// Minutes and hours defer to an exact time; days, weeks and months to the start of that day.
function deferTarget({ n, unit }) {
  if (unit === "m" || unit === "h") {
    const t = new Date(Date.now() + n * DEFER_UNITS[unit][1]);
    const iso = new Date(t.getTime() - t.getTimezoneOffset() * 60000).toISOString();
    return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
  }
  if (unit === "d" || unit === "w") return { date: addDays(today(), unit === "d" ? n : 7 * n), time: null };
  const d = new Date(today() + "T12:00:00");
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
  return { date: d.toISOString().slice(0, 10), time: null };
}

async function deferTasks(ts, { date, time }) {
  const n = ts.length;
  await changeTasks(ts, () => ({ state: "scheduled", start_date: date, start_time: time, defer: true }),
    `Deferred ${n > 1 ? `${n} tasks ` : ""}until ${fmtWhen(date, time)}.`);
}

function openDeferDialog(ts) {
  const dlg = $("#defer-dialog");
  const f = dlg.querySelector("form");
  const t = ts[0];
  const scheduled = ts.length === 1 && t.state === "scheduled";
  f.date.value = scheduled && t.start_date ? t.start_date : addDays(today(), 1);
  f.time.value = scheduled ? t.start_time || "" : "";
  dlg.dataset.tasks = ts.map((x) => x.id).join(",");
  dlg.returnValue = "";
  dlg.showModal();
}

// Menu items act on every task given; "current" marks a choice they all have already.
// Move to and Area are a row of buttons each ("chips"), one click from the menu.
function moveItem(ts) {
  const all = (f) => ts.every(f);
  const chips = STATES.map(([s]) => s).filter((s) => s !== "scheduled").map((s) => ({
    label: STATE_LABEL[s], current: all((t) => t.state === s), run: () => dropOnNav(ts, s),
  }));
  if (S.data.projects.some((p) => p.state === "active") || ts.some((t) => t.project_id)) {
    chips.push({ label: "Project", sub: () => projectItems(ts) });
  }
  return { label: "Move to", chips };
}

function projectItems(ts) {
  const projects = S.data.projects.filter((p) => p.state === "active").map((p) => ({
    label: p.name, current: ts.every((t) => t.project_id === p.id), run: () => dropOnNav(ts, `project:${p.id}`),
  }));
  if (ts.some((t) => t.project_id)) {
    projects.push({ label: "No project", run: () => changeTasks(ts, (t) => t.project_id ? { project_id: null } : null,
      ts.length > 1 ? `Took ${ts.length} tasks out of their projects.` : null) });
  }
  return projects;
}

function areaItem(ts) {
  // A task in a project takes the project's area.
  const free = ts.filter((t) => !t.project_id);
  if (!free.length) {
    return { label: "Area", note: ts.length > 1 ? "These get their areas from their projects"
      : `From its project, “${projectById(ts[0].project_id)?.name}”` };
  }
  if (!S.data.areas.length) return { label: "Area", note: "No areas yet. Add them in Settings." };
  const n = free.length;
  const set = (area_id, name) => changeTasks(free, () => ({ area_id }),
    n > 1 ? `Moved ${n} tasks to ${name}.` : null);
  return {
    label: "Area",
    note: n < ts.length ? `${ts.length - n} in projects keep their project's area` : "",
    chips: [
      { label: "None", current: free.every((t) => !t.area_id), run: () => set(null, "no area") },
      ...S.data.areas.map((a) => ({
        label: a.name, icon: a.icon_version && areaIconUrl(a), current: free.every((t) => t.area_id === a.id),
        run: () => set(a.id, a.name),
      })),
    ],
  };
}

// Tag items toggle and keep the submenu open, so several can be set in a row.
// A tag is ticked when every task has it; choosing it then takes it off them all.
// The Tag submenu for items (the tasks picked, or a project): each tag toggles on all of them,
// and the menu stays open. change(fn) saves fn(item) ({tags}) for each; reopen(at) shows the
// menu again, as things are now, with the focus at that row.
function tagMenu(items, change, reopen) {
  const has = (x) => x.tags || [];
  return [
    ...S.data.tags.map((tag, i) => {
      const on = items.every((x) => has(x).includes(tag.name));
      return { label: tag.name, toggle: true, checked: on, stay: true, run: async () => {
        await change((x) => ({ tags: on ? has(x).filter((y) => y !== tag.name) : [...new Set([...has(x), tag.name])] }));
        reopen(i + 2);  // +2: after Back and the divider
      } };
    }),
    ...(S.data.tags.length ? [{ sep: true }] : []),
    { label: "New tag…", run: async () => {
      const name = prompt("New tag")?.trim().replace(/^#/, "");
      if (!name) return;
      await change((x) => ({ tags: [...new Set([...has(x), name])] }));
      await refresh();  // picks up the new tag in the tag list
    } },
  ];
}

// The Priority submenu: bump(by) raises or lowers them, bump(0, 0) resets; reopen as above.
function priorityMenu(items, bump, reopen) {
  return [
    { label: "Increase", hint: items.length === 1 ? `now ${items[0].priority || 0}` : "", stay: true,
      run: async () => { await bump(1); reopen(2); } },
    { label: "Decrease", stay: true, run: async () => { await bump(-1); reopen(3); } },
    ...(items.some((x) => x.priority) ? [{ label: "Reset to 0", run: () => bump(0, 0) }] : []),
  ];
}

function tagItems(ts) {
  return tagMenu(ts, (fn) => changeTasks(ts, fn), (at) => {
    const fresh = tasksOf(ts.map((t) => t.id));
    showSub(menuItems(fresh), tagItems(fresh), at);
  });
}

// Raise or lower each task's priority by step (or set it to an exact number).
function bumpPriority(ts, step, exact) {
  return changeTasks(ts, (t) => {
    const p = exact ?? clampPriority(t.priority + step);
    return p === t.priority ? null : { priority: p };
  });
}

// A row's ↕: press and drag up to raise the priority, down to lower it, a step every
// PRIO_STEP pixels; it's set on release. Nothing is saved (or the list re-sorted) until then,
// so the row stays put under the pointer. On a picked task, it moves all the picked ones.
const PRIO_STEP = 12;
let prioDrag = null;

function bindPriorityDrag(list) {
  const bubble = $("#prio-bubble");
  const show = () => {
    const { ctl, ts, step, x, y } = prioDrag;
    const one = ts.length === 1;
    const p = one ? clampPriority(ts[0].priority + step) : step;
    const text = one ? String(p) : step > 0 ? `+${step}` : String(step);
    ctl.querySelector(".prio-num").outerHTML = prioNum(p, one ? p || "" : step ? text : "");
    bubble.textContent = one ? `Priority ${text}` : `${ts.length} tasks: ${step ? text : "±0"}`;
    bubble.style.left = x + "px";
    bubble.style.top = y + "px";
  };
  const end = (e) => {
    if (!prioDrag || e.pointerId !== prioDrag.pointer) return;
    const { ctl, ts, step, before } = prioDrag;
    const isProject = prioDrag.project;
    prioDrag = null;
    ctl.classList.remove("active");
    bubble.hidden = true;
    if (e.type === "pointerup" && step && isProject) {
      const p = ts[0];
      patchProject(p.id, { priority: clampPriority((p.priority || 0) + step) });
    } else if (e.type === "pointerup" && step) bumpPriority(ts, step);
    else ctl.querySelector(".prio-num").outerHTML = before;
  };
  list.addEventListener("pointerdown", (e) => {
    const ctl = e.target.closest(".prio-ctl");
    if (!ctl || e.button || prioDrag) return;
    e.preventDefault();
    // A project's row (on the Projects page) works the same way, for just that project.
    const projectRow = ctl.closest(".row.project");
    const id = Number(projectRow ? projectRow.dataset.project : ctl.closest(".row.task").dataset.task);
    ctl.setPointerCapture(e.pointerId);
    ctl.classList.add("active");
    prioDrag = { ctl, pointer: e.pointerId, project: !!projectRow,
      ts: projectRow ? [projectById(id)] : tasksOf(S.picked.has(id) ? pickedIds() : [id]), startY: e.clientY,
      step: 0, x: e.clientX, y: e.clientY, before: ctl.querySelector(".prio-num").outerHTML };
    bubble.hidden = false;
    show();
  });
  list.addEventListener("pointermove", (e) => {
    if (!prioDrag || e.pointerId !== prioDrag.pointer) return;
    const step = Math.round((prioDrag.startY - e.clientY) / PRIO_STEP);
    if (step !== prioDrag.step) navigator.vibrate?.(5);
    Object.assign(prioDrag, { step, x: e.clientX, y: e.clientY });
    show();
  });
  list.addEventListener("pointerup", end);
  list.addEventListener("pointercancel", end);
}

// These stay open, so the priority can be stepped several times.
function priorityItems(ts) {
  return priorityMenu(ts, (by, to) => bumpPriority(ts, by, to), (at) => {
    const fresh = tasksOf(ts.map((t) => t.id));
    showSub(menuItems(fresh), priorityItems(fresh), at);
  });
}

function deferItems(ts) {
  const opts = S.data.user.settings.defer_options.map(parseDefer).filter(Boolean);
  return [
    ...opts.map((o) => {
      const when = deferTarget(o);
      return { label: deferLabel(o), hint: fmtWhen(when.date, when.time), run: () => deferTasks(ts, when) };
    }),
    { sep: true },
    { label: "Custom…", run: () => openDeferDialog(ts) },
  ];
}

function menuItems(ts) {
  const n = ts.length;
  const one = n === 1 && ts[0];
  const head = one ? [{ label: "Open", run: () => select("task", one.id) }] : [{ heading: `${n} tasks` }];
  const picking = [
    ...(one && S.view !== "trash" ? [{ label: "Select", run: () => pick(one.id) }] : []),
    ...(S.picked.size < shownTaskIds().length ? [{ label: "Select all", run: selectAll }] : []),
    ...(n > 1 ? [{ label: "Clear selection", run: clearPicked }] : []),
  ];
  if (ts.every((t) => t.completed_at)) {
    return [...head, { label: "Mark not done", run: () => changeTasks(ts, () => ({ completed: false }),
      n > 1 ? `Marked ${n} tasks not done.` : null) },
      ...(picking.length ? [{ sep: true }, ...picking] : [])];
  }
  const star = !ts.every((t) => t.focus);
  return [
    ...(one ? [] : head),
    moveItem(ts),
    areaItem(ts),
    { sep: true },
    { label: "Priority", sub: () => priorityItems(ts) },
    { label: "Tag", sub: () => tagItems(ts) },
    { label: "Defer", sub: () => deferItems(ts) },
    { sep: true },
    ...(one ? head : []),
    ...(one ? [{ label: "Focus timer", run: () => openTimer(one.id) }] : []),
    { label: star ? "Star" : "Unstar", run: () => changeTasks(ts, () => ({ focus: star })) },
    { label: "Complete", run: () => dropOnNav(ts, "logbook") },
    { label: "Duplicate", run: () => duplicateTasks(ts) },
    ...(one && !one.series_id ? [{ label: "Convert to project…", run: () => openConvert(one) },
      { label: "Make it a note…", run: () => taskToNote(one) }] : []),
    { sep: true },
    ...picking,
    ...(picking.length ? [{ sep: true }] : []),
    { label: "Move to trash", danger: true, run: () => dropOnNav(ts, "trash") },
  ];
}

// The menu for a row acts on every picked task if the row is one of them, else just on it.
function menuIdsFor(taskId) {
  if (S.picked.has(taskId)) return pickedIds();
  if (S.picked.size) clearPicked();
  return [taskId];
}

function openMenu(ids, x, y) {
  const ts = tasksOf(ids).filter((t) => !t.deleted_at);
  if (!ts.length) return false;
  // Android fires both our long-press timer and a contextmenu event.
  if (menu.ids.join() === ids.join() && Date.now() - menu.openedAt < 800) return true;
  Object.assign(menu, { ids: ts.map((t) => t.id), project: null, x, y, openedAt: Date.now() });
  showItems(menuItems(ts));
  markMenuTarget();
  return true;
}

// Highlight in place: redrawing the list would swap out the row under a finger mid-press.
function markMenuTarget() {
  document.querySelectorAll(".menu-target").forEach((r) => r.classList.remove("menu-target"));
  for (const id of menu.ids) document.querySelector(`.row.task[data-task="${id}"]`)?.classList.add("menu-target");
  if (menu.project) document.querySelector(`.row.project[data-project="${menu.project}"]`)?.classList.add("menu-target");
}

// ---- a project's menu (right-click, or press and hold, a project's row) ----

const PROJECT_STATES = [["active", "Active"], ["someday", "Someday"], ["later", "Later"], ["done", "Completed"]];

function openProjectMenu(id, x, y) {
  const p = projectById(id);
  if (!p || p.deleted_at) return false;
  if (menu.project === id && Date.now() - menu.openedAt < 800) return true;  // (as in openMenu)
  Object.assign(menu, { ids: [], project: id, x, y, openedAt: Date.now() });
  showItems(projectMenuItems(p));
  markMenuTarget();
  return true;
}

// Changes a project, with Undo when a message is given.
async function changeProject(p, changes, message) {
  const back = Object.fromEntries(Object.keys(changes).map((k) => [k, p[k]]));
  await patchProject(p.id, changes);
  if (message) toast(message, () => patchProject(p.id, back));
}

function projectMenuItems(p) {
  const reopen = (items, at) => { const fresh = projectById(p.id); if (fresh) showSub(projectMenuItems(fresh), items(fresh), at); };
  return [
    { label: "Status", chips: PROJECT_STATES.map(([state, name]) => ({
      label: name, current: p.state === state,
      run: () => changeProject(p, { state }, `“${p.name}” ${{ active: "is active", someday: "is in Someday", later: "is in Later",
        done: "is completed" }[state]} now.`),
    })) },
    S.data.areas.length ? { label: "Area", chips: [
      { label: "None", current: !p.area_id, run: () => changeProject(p, { area_id: null }) },
      ...S.data.areas.map((a) => ({ label: a.name, icon: a.icon_version && areaIconUrl(a), current: p.area_id === a.id,
        run: () => changeProject(p, { area_id: a.id }) })),
    ] } : { label: "Area", note: "No areas yet. Add them in Settings." },
    { sep: true },
    { label: "Priority", sub: () => projectPriorityItems(p, reopen) },
    { label: "Tag", sub: () => projectTagItems(p, reopen) },
    { sep: true },
    { label: "Open", run: () => setView(`project:${p.id}`) },
    { label: "Details", run: () => { setView(`project:${p.id}`); select("project", p.id); } },
    { label: "New subproject…", run: () => newProject(p) },
    { label: "Move into", sub: () => [
      ...(p.parent_id ? [{ label: "No project (top level)", run: () => changeProject(p, { parent_id: null }, `“${p.name}” is a project of its own now.`) }] : []),
      ...byPriority(parentChoices(p).filter((q) => q.id !== p.parent_id && q.state !== "done")).map((q) => ({
        label: q.name, run: () => changeProject(p, { parent_id: q.id }, `“${p.name}” is part of “${q.name}” now.`) })),
    ] },
    { label: p.focus ? "Unstar" : "Star", run: () => changeProject(p, { focus: !p.focus }) },
    { label: "Sequential", toggle: true, checked: p.sequential, run: () => changeProject(p, { sequential: !p.sequential }) },
    ...(projectEmpty(p) ? [{ sep: true }, { label: "Make it a task", run: () => convertTo(p.id, "task") },
      { label: "Make it a note", run: () => convertTo(p.id, "note") }] : []),
    { sep: true },
    { label: "Move to trash", danger: true, run: async () => {
      if (!confirm(`Move “${p.name}” and everything in it to the trash?`)) return;
      if (S.selected?.kind === "project" && S.selected.id === p.id) S.selected = null;
      await changeProject(p, { deleted: true });
      toast("Project moved to trash.", () => patchProject(p.id, { deleted: false }));
    } },
  ];
}

function projectPriorityItems(p, reopen) {
  return priorityMenu([p], (by, to) => patchProject(p.id, { priority: clampPriority(to ?? (p.priority || 0) + by) }),
    (at) => reopen((fresh) => projectPriorityItems(fresh, reopen), at));
}

function projectTagItems(p, reopen) {
  return tagMenu([p], (fn) => patchProject(p.id, fn(p)), (at) => reopen((fresh) => projectTagItems(fresh, reopen), at));
}

function showSub(parent, items, focusAt) {
  showItems([{ label: "Back", back: true, stay: true, run: () => showItems(parent) }, { sep: true }, ...items], focusAt);
}

function showItems(items, focusAt) {
  const el = $("#ctx");
  menu.items = items;
  el.innerHTML = items.map((it, i) => {
    if (it.sep) return "<hr>";
    if (it.heading) return `<div class="ctx-heading">${h(it.heading)}</div>`;
    if (it.chips || it.note && it.label) {
      return `<div class="ctx-row"><div class="ctx-row-label">${h(it.label)}</div>
        ${it.note ? `<div class="ctx-row-note">${h(it.note)}</div>` : ""}
        ${it.chips ? `<div class="ctx-chips">${it.chips.map((c, j) => `<button type="button" role="menuitem" data-i="${i}" data-c="${j}"${c.current ? ' class="current" aria-current="true"' : ""}>${c.icon ? `<img class="ctx-icon" src="${c.icon}" alt="">` : ""}${h(c.label)}${c.sub ? " ›" : ""}</button>`).join("")}</div>` : ""}</div>`;
    }
    if (it.note) return `<div class="ctx-note">${h(it.note)}</div>`;
    const lead = it.toggle ? `<span class="ctx-check">${it.checked ? "✓" : ""}</span>`
      : it.icon ? `<img class="ctx-icon" src="${it.icon}" alt="">` : "";
    return `<button type="button" role="menuitem${it.toggle ? "checkbox" : ""}" data-i="${i}"${it.danger ? ' class="danger"' : ""}${it.current ? " disabled" : ""}${it.toggle ? ` aria-checked="${!!it.checked}"` : ""}>
      <span class="ctx-label">${lead}${it.back ? "‹ " : ""}${h(it.label)}${it.current ? " ✓" : ""}</span>
      ${it.hint ? `<span class="ctx-hint">${h(it.hint)}</span>` : it.sub ? '<span class="ctx-hint">›</span>' : ""}</button>`;
  }).join("");
  el.hidden = false;
  const r = el.getBoundingClientRect();
  el.style.left = Math.max(8, Math.min(menu.x, innerWidth - r.width - 8)) + "px";
  el.style.top = Math.max(8, Math.min(menu.y, innerHeight - r.height - 8)) + "px";
  (el.querySelector(`button[data-i="${focusAt}"]`) || el.querySelector("button:not([disabled])"))?.focus({ preventScroll: true });
}

function closeMenu() {
  if (!menu.ids.length && !menu.project) return;
  $("#ctx").hidden = true;
  menu.ids = [];
  menu.project = null;
  markMenuTarget();
}

function bindMenu() {
  const el = $("#ctx");
  el.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-i]");
    if (!b) return;
    const row = menu.items[Number(b.dataset.i)];
    const it = b.dataset.c ? row.chips[Number(b.dataset.c)] : row;
    if (it.current) return;
    if (it.sub) {
      showSub(menu.items, it.sub());
    } else if (it.stay) {
      it.run();
    } else {
      closeMenu();
      it.run();
    }
  });
  el.addEventListener("keydown", (e) => {
    e.stopPropagation();  // keep app shortcuts out of the menu
    const buttons = [...el.querySelectorAll("button:not([disabled])")];
    const i = buttons.indexOf(document.activeElement);
    const chip = document.activeElement.dataset.c;
    if (e.key === "Escape") closeMenu();
    // Left and right move along a row of buttons.
    else if (chip && e.key === "ArrowRight") document.activeElement.nextElementSibling?.focus();
    else if (chip && e.key === "ArrowLeft" && chip !== "0") document.activeElement.previousElementSibling?.focus();
    else if (e.key === "ArrowDown") { e.preventDefault(); buttons[(i + 1) % buttons.length]?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); buttons[(i - 1 + buttons.length) % buttons.length]?.focus(); }
    else if (e.key === "ArrowRight" && menu.items[Number(document.activeElement.dataset.i)]?.sub) document.activeElement.click();
    else if (e.key === "ArrowLeft" && menu.items[0]?.back) el.querySelector("button[data-i='0']").click();
  });
  document.addEventListener("pointerdown", (e) => { if (!el.contains(e.target)) closeMenu(); }, true);
  window.addEventListener("resize", closeMenu);
  $("#list").addEventListener("scroll", closeMenu);

  const list = $("#list");
  // A project's row (not one in the trash) has its own menu.
  const projectRow = (e) => e.target.closest(".row.project:not(.trashed)");
  list.addEventListener("contextmenu", (e) => {
    const row = e.target.closest(".row.task");
    if (row && openMenu(menuIdsFor(Number(row.dataset.task)), e.clientX, e.clientY)) e.preventDefault();
    const p = projectRow(e);
    if (p && openProjectMenu(Number(p.dataset.project), e.clientX, e.clientY)) e.preventDefault();
  });
  // Press-and-hold on touch screens (iOS has no contextmenu event).
  let press = null;
  const cancel = () => { if (press) clearTimeout(press.timer); press = null; };
  list.addEventListener("touchstart", (e) => {
    const row = e.target.closest(".row.task") || projectRow(e);
    if (!row || e.touches.length > 1 || e.target.closest(".prio-ctl")) return cancel();
    const { clientX: x, clientY: y } = e.touches[0];
    press = { x, y, fired: false };
    press.timer = setTimeout(() => {
      press.fired = row.dataset.project ? openProjectMenu(Number(row.dataset.project), x, y)
        : openMenu(menuIdsFor(Number(row.dataset.task)), x, y);
      if (press.fired) navigator.vibrate?.(10);
    }, 500);
  }, { passive: true });
  // Listen on the document: the touch keeps its original target even if that row is redrawn.
  document.addEventListener("touchmove", (e) => {
    const t = e.touches[0];
    if (press && !press.fired && Math.hypot(t.clientX - press.x, t.clientY - press.y) > 10) cancel();
  }, { passive: true });
  document.addEventListener("touchend", (e) => {
    if (press?.fired) e.preventDefault();  // don't let the hold also count as a tap
    cancel();
  });
  document.addEventListener("touchcancel", cancel);

  $("#defer-dialog").addEventListener("close", () => {
    const dlg = $("#defer-dialog");
    if (dlg.returnValue !== "ok") return;
    const f = dlg.querySelector("form");
    if (!validDate(f.date.value)) return toast("That date doesn't look right.");
    deferTasks(tasksOf(dlg.dataset.tasks.split(",").map(Number)), { date: f.date.value, time: f.time.value || null });
  });

  // Bring deferred tasks back when their time comes, even if the page stays open.
  setInterval(() => {
    if (document.hidden) return;
    const [d, tm] = nowStamp().split("T");
    if (S.data.tasks.some((t) => t.state === "scheduled" && t.start_date &&
        (t.start_date < d || (t.start_date === d && (!t.start_time || t.start_time <= tm))))) refresh();
  }, 30000);
}

// ---- events --------------------------------------------------------------

function bind() {
  $("#nav").addEventListener("click", (e) => {
    if (e.target.closest(".add-project")) { e.preventDefault(); newProject(); return; }
    const a = e.target.closest("[data-view]");
    if (!a) return;
    e.preventDefault();
    setView(a.dataset.view);
  });

  // Area filter: a list of checkboxes under a button; no boxes ticked shows every area.
  const areaMenu = $("#area-menu");
  const showAreaMenu = (open) => {
    areaMenu.hidden = !open;
    $("#area-btn").setAttribute("aria-expanded", open);
  };
  $("#area-btn").addEventListener("click", () => showAreaMenu(areaMenu.hidden));
  areaMenu.addEventListener("change", (e) => {
    const ids = new Set(S.areas);
    if (e.target.checked) ids.add(e.target.value); else ids.delete(e.target.value);
    setAreas(ids);
  });
  areaMenu.addEventListener("click", (e) => {
    if (e.target.closest(".area-all")) { setAreas([]); showAreaMenu(false); }
  });
  document.addEventListener("pointerdown", (e) => {
    if (!areaMenu.hidden && !e.target.closest("#area-filter")) showAreaMenu(false);
  });
  areaMenu.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.stopPropagation(); showAreaMenu(false); $("#area-btn").focus(); }
  });

  $("#search").addEventListener("input", (e) => { S.search = e.target.value; renderList(); });

  // Starting a new task closes the editor, so it can't be mistaken for the new one.
  $("#quick-add-input").addEventListener("focus", () => {
    closeMenu();
    if (S.selected) { S.selected = null; render(); }
  });
  const addFromBar = async (open) => {
    const input = $("#quick-add-input");
    const text = input.value;
    input.value = "";
    renderQuickWhen();
    await quickAdd(text, { open });
  };
  $("#quick-add").addEventListener("submit", (e) => { e.preventDefault(); addFromBar(false); });
  // Ctrl+Enter (⌘+Enter on a Mac) adds the task and opens it for editing.
  $("#quick-add-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); addFromBar(true); }
  });
  if (matchMedia("(pointer: coarse)").matches) {
    $("#quick-add-input").placeholder = "Add a task… (#tag, !next, !someday)";  // no keyboard tips on touch screens
  } else if (/Mac/.test(navigator.platform)) {
    $("#quick-add-input").placeholder = $("#quick-add-input").placeholder.replace("Ctrl+", "⌘+");
  }

  $("#tag-bar").addEventListener("click", (e) => {
    const b = e.target.closest("[data-tag]");
    if (!b) return;
    const tag = b.dataset.tag;
    if (S.tagFilter.has(tag)) S.tagFilter.delete(tag); else S.tagFilter.add(tag);
    renderList();
  });

  $("#list").addEventListener("click", async (e) => {
    if (e.target.closest("#detail")) return;  // the open editor handles its own clicks
    if (e.target.closest("a[target]")) return;  // a link in a task: just open it
    const row = e.target.closest(".row");
    const b = e.target.closest("button");
    if (b?.classList.contains("empty-trash")) {
      if (!confirm("Permanently delete everything in the trash?")) return;
      await api("POST", "/trash/empty");
      return refresh();
    }
    if (b?.classList.contains("edit-project")) {
      return select("project", Number(b.closest("[data-project]").dataset.project));
    }
    if (b?.classList.contains("open-subproject")) return setView(`project:${b.dataset.project}`);
    if (b?.classList.contains("complete-project") || b?.classList.contains("reopen-project")) {
      const id = Number(b.closest("[data-project]").dataset.project);
      const done = b.classList.contains("complete-project");
      await patchProject(id, { state: done ? "done" : "active" });
      if (done) toast("Project completed.", () => patchProject(id, { state: "active" }));
      return;
    }
    if (row?.dataset.template) {
      const id = Number(row.dataset.template);
      return b?.classList.contains("use-template") ? openNewProject(id) : openTemplateEditor(id);
    }
    if (!row) {
      // A click on empty space in the list closes the editor and clears a selection.
      if (!b && (S.selected || S.picked.size)) { S.selected = null; S.picked.clear(); render(); }
      return;
    }
    if (row.dataset.task) {
      const id = Number(row.dataset.task);
      const text = e.target.closest(".row-text");
      if (text && tickTask(e, id, text)) return;
      if (e.target.classList.contains("complete")) return completeTask(id, e.target.checked);
      if (b?.classList.contains("star")) return patchTask(id, { focus: !taskById(id).focus });
      if (b?.classList.contains("prio-ctl")) return;  // dragged, not clicked (bindPriorityDrag)
      // While some tasks are picked, a plain click (or tap) picks too.
      if (S.view !== "trash" && (e.ctrlKey || e.metaKey || e.shiftKey || S.picked.size)) {
        return pick(id, e.shiftKey);
      }
      S.pickAnchor = id;
      S.cursor = id;
      // Clicking the open task's row again closes it.
      if (S.selected?.kind === "task" && S.selected.id === id && !b) { S.selected = null; render(); }
      else if (S.view !== "trash" || !b) select("task", id);
    } else if (row.dataset.project) {
      const id = Number(row.dataset.project);
      if (b?.classList.contains("restore-project")) return patchProject(id, { deleted: false });
      if (b?.classList.contains("star")) {
        return patchProject(id, { focus: !projectById(id).focus });
      }
      if (b?.classList.contains("prio-ctl")) return;  // dragged, not clicked (bindPriorityDrag)
      if (b?.classList.contains("fold")) {
        if (foldedProjects.has(id)) foldedProjects.delete(id); else foldedProjects.add(id);
        save("projectsFolded", JSON.stringify([...foldedProjects]));
        return render();
      }
      if (S.view !== "trash") setView(`project:${id}`);
    }
  });

  // Drag and drop: reorder within the list, or drop onto the sidebar.
  // Dragging a picked task takes all the picked ones along.
  let dragIds = null;
  const list = $("#list");
  // Shift-click picks a range; don't let it select the text in between too.
  list.addEventListener("mousedown", (e) => {
    if (e.shiftKey && e.target.closest(".row.task")) e.preventDefault();
  });
  bindPriorityDrag(list);
  list.addEventListener("dragstart", (e) => {
    if (prioDrag) return e.preventDefault();
    const row = e.target.closest(".row.task, .row.project[draggable]");
    if (!row) return;
    const id = Number(row.dataset.task || row.dataset.project);
    dragIds = row.dataset.task && S.picked.has(id) ? pickedIds() : [id];
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", dragIds.join(","));
    if (dragIds.length > 1) {
      const badge = $("#drag-count");
      badge.textContent = `${dragIds.length} tasks`;
      e.dataTransfer.setDragImage(badge, -10, -10);
    }
    for (const x of dragIds) list.querySelector(`.row.task[data-task="${x}"], .row.project[data-project="${x}"]`)?.classList.add("dragging");
    document.body.classList.add("is-dragging");
  });
  // Also run on drop: redrawing the list removes the dragged row, and then its dragend
  // never reaches the document.
  const endDrag = () => {
    dragIds = null;
    document.body.classList.remove("is-dragging");
    document.querySelectorAll(".dragging, .drop-before, .drop-target")
      .forEach((x) => x.classList.remove("dragging", "drop-before", "drop-target"));
  };
  document.addEventListener("dragend", endDrag);
  const canReorder = () => !["scheduled", "recurring", "all", "calendar", "logbook", "trash"].includes(S.view);
  list.addEventListener("dragover", (e) => {
    if (!dragIds || !canReorder()) return;
    e.preventDefault();
    list.querySelectorAll(".drop-before").forEach((x) => x.classList.remove("drop-before"));
    e.target.closest(".row.task, .row.project[draggable]")?.classList.add("drop-before");
  });
  list.addEventListener("drop", (e) => {
    if (!dragIds || !canReorder()) return;
    e.preventDefault();
    const target = e.target.closest(".row.task, .row.project[draggable]");
    const ids = dragIds;
    endDrag();
    reorderTasks(ids, target ? Number(target.dataset.task || target.dataset.project) : null);
  });
  const nav = $("#nav");
  nav.addEventListener("dragover", (e) => {
    const target = e.target.closest("[data-drop]");
    if (!dragIds || !target) return;
    e.preventDefault();
    nav.querySelectorAll(".drop-target").forEach((x) => x.classList.remove("drop-target"));
    target.classList.add("drop-target");
  });
  nav.addEventListener("drop", (e) => {
    const target = e.target.closest("[data-drop]");
    if (!dragIds || !target) return;
    e.preventDefault();
    const ts = tasksOf(dragIds);
    endDrag();
    if (ts.length) dropOnNav(ts, target.dataset.drop);
  });

  $("#select-bar").addEventListener("click", (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "all") selectAll();
    else if (act === "clear") clearPicked();
    else if (act === "actions") {
      const r = e.target.closest("button").getBoundingClientRect();
      openMenu(pickedIds(), r.left, r.bottom + 4);
    }
  });

  $("#menu-btn").addEventListener("click", () => document.body.classList.toggle("nav-open"));
  $("#main").addEventListener("click", (e) => {
    if (!e.target.closest("#menu-btn")) document.body.classList.remove("nav-open");
  });
  $("#settings-btn").addEventListener("click", openSettings);

  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      // Anywhere, even while typing.
      e.preventDefault();
      openPalette();
      return;
    }
    if (e.target.closest(".CodeMirror")) return;  // Vim has its own Esc and keys
    const typing = e.target.closest("input, textarea, select, [contenteditable]");
    if (e.key === "Escape") {
      if (typing) e.target.blur();
      else if (S.navFocus) leaveNav();
      else if (S.picked.size) clearPicked();
      else if (S.selected) { S.selected = null; render(); }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a" && !typing &&
        !document.querySelector("dialog[open]") && shownTaskIds().length) {
      e.preventDefault();
      selectAll();
      return;
    }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (document.querySelector("dialog[open]")) return;
    // h / l (or ← / →) move between the lists on the left and the tasks; on the left,
    // j / k (or ↓ / ↑) go from list to list, showing each.
    if (S.navFocus) {
      if (NAV_KEYS[e.key]) { e.preventDefault(); return moveNav(NAV_KEYS[e.key]); }
      if (["l", "ArrowRight", "Enter"].includes(e.key)) { e.preventDefault(); return leaveNav(); }
      if (["h", "ArrowLeft", "x", "s", "t"].includes(e.key)) { e.preventDefault(); return; }
    } else if (e.key === "h" || e.key === "ArrowLeft") {
      e.preventDefault();
      return enterNav();
    }
    if (e.key === "n" || e.key === "q") {
      e.preventDefault();
      // On Links, N adds a link; other lists without a quick-add bar hand off to the Inbox.
      if (S.view === "links") return $("#link-add")?.elements.url.focus();
      if (S.view === "notes" || S.view === "journal") return newNote();
      focusQuickAdd();
    }
    else if (e.key === "/") { e.preventDefault(); $("#search").focus(); }
    else if (e.key === "?") { e.preventDefault(); location.href = BASE + "/help"; }
    else if (NAV_KEYS[e.key] && shownTaskIds().length) { e.preventDefault(); moveCursor(NAV_KEYS[e.key]); }
    else if (e.key === "Enter" && shownTaskIds().length && !e.target.closest("button, a")) {
      e.preventDefault();
      if (!shownTaskIds().includes(S.cursor)) return moveCursor(1);
      if (S.selected?.kind === "task" && S.selected.id === S.cursor) { S.selected = null; render(); }
      else { select("task", S.cursor); focusNotes(); }
    }
    else if (e.key === "t" && keyTargets().length === 1) { e.preventDefault(); openTimer(keyTargets()[0]); }
    else if ((e.key === "x" || e.key === "s") && S.view !== "trash" && keyTargets().length) {
      e.preventDefault();
      const ts = tasksOf(keyTargets());
      if (e.key === "s") {
        const star = !ts.every((t) => t.focus);
        changeTasks(ts, () => ({ focus: star }), ts.length > 1 ? `${star ? "Starred" : "Unstarred"} ${ts.length} tasks.` : null);
      } else {
        // The cursor moves on to the next task, as this one leaves the list.
        const ids = shownTaskIds(), at = ids.indexOf(S.cursor), going = ts.map((t) => t.id);
        if (at >= 0 && going.includes(S.cursor)) {
          S.cursor = ids.slice(at + 1).find((id) => !going.includes(id)) ??
            ids.slice(0, at).reverse().find((id) => !going.includes(id)) ?? null;
        }
        if (ts.length === 1 && !ts[0].completed_at) completeTask(ts[0].id, true);
        else dropOnNav(ts, "logbook");
      }
    }
    else if (["+", "=", "-"].includes(e.key) && (S.picked.size || S.selected?.kind === "task")) {
      // Raise/lower the priority of the picked tasks, or of the one open in the editor.
      e.preventDefault();
      const ids = S.picked.size ? pickedIds() : [S.selected.id];
      bumpPriority(tasksOf(ids), e.key === "-" ? -1 : 1);
    }
  });

  // Pick up scheduled items whose day has come, and edits from other devices.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && !$("#detail").contains(document.activeElement)) refresh();
  });

  bindDetail();
  bindViewer();
  bindSettings();
  bindMenu();
  bindSuggest();
  bindLinks();
  bindPalette();
  bindTimer();
  document.addEventListener("mousedown", () => { if (S.navFocus) { S.navFocus = false; markNav(); } }, true);
  $("#toolbar").addEventListener("click", (e) => {
    if (e.target.closest(".tb-calendar")) setView(S.view === "calendar" ? "focus" : "calendar");
  });
}

// API errors are already shown in a toast; callers just stop at them.
window.addEventListener("unhandledrejection", (e) => { if (e.reason?.shown) e.preventDefault(); });

bind();
// (Once editor.js and notes.js have run too: drawing the lists uses them.)
document.addEventListener("DOMContentLoaded", () => refresh().then(afterLoad));
// Makes the app installable, and able to open offline (static/sw.js).
navigator.serviceWorker?.register(BASE + "/sw.js").catch(() => {});

// Android app versions: 1.0.7 is code 1000007 (android/build.mjs). Builds before numbering
// had smaller codes (or none: 0).
const versionName = (code) => code >= 1e6
  ? `${Math.floor(code / 1e6)}.${Math.floor(code / 1e3) % 1000}.${code % 1000}` : "an early build";

function runningAppVersion() {
  try { const v = sessionStorage.getItem("appVersion"); return v === null ? null : Number(v); } catch { return null; }
}

// Settings → Add from the phone: phones connected to add tasks on their own (app.py,
// /api/app/add), and a button that connects this one. The key goes to the app in an intent:
// link naming its package, so only this app can receive it (android/build.mjs, PairActivity).
const PAIRING_VERSION = 1000004;  // 1.0.4, the first app connected through entropicide:// links

async function fillDevices() {
  const el = $(".device-state");
  if (!el) return;
  let list = [];
  try { list = (await api("GET", "/devices", undefined, { quiet: true })).filter((d) => d.kind === "phone"); } catch {}
  const mine = runningAppVersion();
  const when = (at) => at ? fmtDate(utcToLocalInput(at).slice(0, 10)).replace(/^(Today|Yesterday)$/, (w) => w.toLowerCase()) : "never";
  el.innerHTML = `${list.length ? `<ul class="device-list">${list.map((d) => `<li data-device="${d.id}">
      ${h(d.name)}: connected ${h(when(d.created_at))}, last used ${h(when(d.used_at))}
      <button type="button" class="link disconnect">Disconnect</button></li>`).join("")}</ul>` : ""}
    ${mine === null ? `<p class="muted">To connect a phone, open these Settings in its Android app.</p>`
      : mine < PAIRING_VERSION ? `<p class="muted">This app is too old to connect:
        <a href="${BASE}/install/entropicide.apk">update it</a> (1.0.4 or later) first.</p>`
      : `<p><button type="button" class="connect">${list.length ? "Connect this phone again" : "Connect this phone"}</button></p>`}`;
  $(".connect", el)?.addEventListener("click", async () => {
    const { key } = await api("POST", "/devices", { name: "Android app" });
    location.href = `intent://pair?key=${encodeURIComponent(key)}&user=${encodeURIComponent(S.data.user.username)}#Intent;scheme=entropicide;package=${window.ENTROPICIDE_ANDROID_PACKAGE};end`;
    setTimeout(fillDevices, 1500);
  });
  for (const b of el.querySelectorAll(".disconnect")) b.addEventListener("click", async () => {
    if (!confirm("Disconnect that phone? Its notification and tile stop adding tasks until it's connected again.")) return;
    await api("DELETE", `/devices/${b.closest("[data-device]").dataset.device}`);
    fillDevices();
  });
}

// Settings → Add from other apps: keys for POST /api/add (docs/api.md). A new key is shown
// once, here; only its hash is kept.
async function fillApiKeys(made) {
  const el = $(".api-key-state");
  if (!el) return;
  let list = [];
  try { list = (await api("GET", "/devices", undefined, { quiet: true })).filter((d) => d.kind === "api"); } catch {}
  const when = (at) => at ? fmtDate(utcToLocalInput(at).slice(0, 10)).replace(/^(Today|Yesterday)$/, (w) => w.toLowerCase()) : "never";
  const url = new URL(BASE + "/api/add", location.href).href;
  el.innerHTML = `${list.length ? `<ul class="device-list">${list.map((d) => `<li data-device="${d.id}">
      ${h(d.name)} (${["adds", d.can_read && "reads", d.can_complete && "completes"].filter(Boolean).join(", ")}): made ${h(when(d.created_at))}, last used ${h(when(d.used_at))}
      <button type="button" class="link disconnect">Revoke</button></li>`).join("")}</ul>` : ""}
    ${made ? `<div class="new-key"><p>The key for <b>${h(made.name)}</b>. Copy it now: it isn't shown again.</p>
      <input readonly class="key-value" value="${h(made.key)}" aria-label="New key">
      <p class="muted">Send tasks to <code>${h(url)}</code> with the header
        <code>Authorization: Bearer</code> and the key. Try it:</p>
      <pre class="key-example">curl -d "Buy milk tomorrow #errand" -H "Authorization: Bearer ${h(made.key)}" ${h(url)}</pre>
      ${made.can_read ? `<p class="muted">And read a list (focus, queue, inbox, soon, later, someday, waiting, scheduled):</p>
      <pre class="key-example">curl -H "Authorization: Bearer ${h(made.key)}" ${h(url.replace(/add$/, "read/focus"))}</pre>` : ""}
      ${made.can_complete ? `<p class="muted">And complete a task (by what it's called, or its id):</p>
      <pre class="key-example">curl -d "buy milk" -H "Authorization: Bearer ${h(made.key)}" ${h(url.replace(/add$/, "complete"))}</pre>` : ""}</div>` : ""}
    <form class="new-api-key"><div class="inline"><input name="name" placeholder="What it's for (e.g. Alexa)" maxlength="100" required>
      <button>Make a key</button></div>
      <label class="check"><input type="checkbox" name="can_read"> Can also read my lists (for “what's due today?”)</label>
      <label class="check"><input type="checkbox" name="can_complete"> Can also complete tasks (for “I finished …”)</label></form>`;
  $(".key-value", el)?.select();
  $(".new-api-key", el).addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = e.target.elements.name.value.trim();
    const can_read = e.target.elements.can_read.checked;
    const can_complete = e.target.elements.can_complete.checked;
    const { key } = await api("POST", "/devices", { name, kind: "api", can_read, can_complete });
    fillApiKeys({ name, key, can_read, can_complete });
  });
  for (const b of el.querySelectorAll(".disconnect")) b.addEventListener("click", async () => {
    if (!confirm("Revoke that key? Whatever uses it can't add tasks any more.")) return;
    await api("DELETE", `/devices/${b.closest("[data-device]").dataset.device}`);
    fillApiKeys();
  });
}

// Settings → Troubleshooting: which Android app this is, and whether there's a newer one.
async function fillAppVersion() {
  const el = $(".app-version");
  if (!el) return;
  const mine = runningAppVersion();
  let latest = {};
  try { latest = await (await fetch(BASE + "/install/version", { cache: "no-store" })).json(); } catch {}
  const newest = latest.code ? versionName(latest.code) : null;
  if (mine === null) {
    el.innerHTML = `Not the Android app: this is the browser.${newest ? ` The latest Android app is <b>${h(newest)}</b>.` : ""}`;
  } else if (newest && latest.code > mine) {
    el.innerHTML = `Android app <b>${h(versionName(mine))}</b>. <b>${h(newest)}</b> is available:
      <a href="${BASE}/install/entropicide.apk">update</a>.`;
  } else {
    el.innerHTML = `Android app <b>${h(versionName(mine))}</b> (the latest).`;
  }
}

// The Android app opens SITE_PATH/?app=<its version code>; builds before that didn't say, but
// Chrome gives them away with an android-app:// referrer (version 0). When the server has a
// newer APK, offer it. (Per tab, so Chrome itself on the same phone isn't nagged.)
async function checkAppUpdate(params) {
  let mine;
  try {
    if (params.get("app")) sessionStorage.setItem("appVersion", params.get("app"));
    else if (document.referrer.startsWith("android-app://") && !sessionStorage.getItem("appVersion")) {
      sessionStorage.setItem("appVersion", "0");
    }
    mine = sessionStorage.getItem("appVersion");
  } catch { return; }
  if (params.has("app")) {
    const rest = new URLSearchParams(location.search);
    rest.delete("app");
    const q = rest.toString();
    history.replaceState(null, "", location.pathname + (q ? "?" + q : ""));
  }
  if (mine === null) return;
  let latest;
  try {
    latest = await (await fetch(BASE + "/install/version", { cache: "no-store" })).json();
  } catch { return; }
  let skipped = null;
  try { skipped = localStorage.getItem("appUpdateSkipped"); } catch {}
  if (!latest.code || latest.code <= Number(mine) || skipped === String(latest.code)) return;
  const bar = document.createElement("div");
  bar.id = "app-update";
  bar.innerHTML = `<span>A new version of the Entropicide app is ready.</span>
    <a class="primary" href="${BASE}/install/entropicide.apk">Update</a>
    <button class="link">Later</button>`;
  bar.querySelector("a").onclick = () => {
    bar.querySelector("span").textContent = "Downloading… then open it from the notification and tap Update.";
  };
  bar.querySelector("button").onclick = () => {
    try { localStorage.setItem("appUpdateSkipped", String(latest.code)); } catch {}
    bar.remove();
  };
  document.body.append(bar);
}

function focusQuickAdd() {
  if ($("#quick-add").hidden) setView("inbox");
  $("#quick-add-input").focus();
}

async function afterLoad() {
  if (timer) { if (timer.runFrom) keepAwake(); renderTimer(); }
  // Opened from a notification (?task=) or the Share menu (?shared=); or, with the app
  // already open, a notification tapped (a message from the service worker).
  const params = new URLSearchParams(location.search);
  checkAppUpdate(params);
  const opened = Number(params.get("task") || params.get("shared"));
  if (opened && params.has("ask")) {
    history.replaceState(null, "", location.pathname);
    askShared(opened);
  } else if (opened) {
    history.replaceState(null, "", location.pathname);
    if (params.get("shared")) toast("Added to your Inbox.");
    openTask(opened);
  }
  if (params.get("shared_note")) {
    history.replaceState(null, "", location.pathname);
    openSharedNote(Number(params.get("shared_note")));
  }
  // The installed app's New task shortcut (the manifest's shortcuts).
  if (params.has("new")) {
    history.replaceState(null, "", location.pathname);
    focusQuickAdd();
  }
  // The Android app asking to be connected (its notification or tile, before it has a key).
  if (params.has("connect")) {
    history.replaceState(null, "", location.pathname);
    openSettings().then(() => $("#dialog section.devices").scrollIntoView());
  }
  navigator.serviceWorker?.addEventListener("message", async (e) => {
    if (e.data?.refresh) return refresh();  // a notification's Done or Snooze
    if (!e.data?.openTask) return;
    await refresh();
    openTask(e.data.openTask);
  });
  // Send any changes made offline: now, when the connection comes back, and every 30 s.
  renderOffline();
  flushOutbox();
  window.addEventListener("online", flushOutbox);
  setInterval(flushOutbox, 30000);
  // Coming back from Google's sign-in page.
  const result = new URLSearchParams(location.search).get("google");
  if (result) {
    history.replaceState(null, "", location.pathname);
    toast({ connected: "Google Calendar connected. Choose the calendar your tasks should go on.",
            cancelled: "Google Calendar wasn't connected.",
            expired: "That took too long. Try connecting again.",
            failed: "Google sign-in failed. Try again.",
            noscope: "Not connected: Google Calendar access wasn't allowed. Connect again and tick the Google Calendar box on Google's page." }[result] || "");
    if (result === "connected") openSettings().then(() => $("#dialog section.google").scrollIntoView());
  }
  // Sync needs the user's time zone, which only the browser knows.
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (tz && S.data.user.settings?.timezone !== tz) {
    S.data.user.settings = await api("PATCH", "/me/settings", { timezone: tz }, { quiet: true })
      .catch(() => S.data.user.settings);
  }
  // With Google connected, changes can arrive at any time: pick them up while idle.
  setInterval(() => {
    if (!S.data.google.connected || document.hidden || document.querySelector("dialog[open]") ||
        $("#detail").contains(document.activeElement) || document.body.classList.contains("is-dragging") ||
        menu.ids.length || menu.project) return;
    refresh();
  }, 60000);
}
