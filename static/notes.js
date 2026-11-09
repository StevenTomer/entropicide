"use strict";

// ---- notes and journals (the Notes and Journal pages) ---------------------------
// Notes hold formatted text (bold, italic, underline, fonts, headings, lists, links) with
// pictures placed anywhere in it, and other files beside it. Each has a title, a category
// (whose colour it shows in), tags, an area, links to tasks and projects, and can be pinned.
// A note in a journal is one of its entries, on its day. app.py keeps them; richtext.py
// cleans their HTML on the server, as cleanNoteHtml does here before saving.
// Loaded after app.js, whose state (S) and helpers this uses.

const NOTE_COLORS = [["", "None"], ["red", "Red"], ["orange", "Orange"], ["yellow", "Yellow"], ["green", "Green"],
  ["teal", "Teal"], ["blue", "Blue"], ["navy", "Navy"], ["purple", "Purple"], ["pink", "Pink"], ["brown", "Brown"],
  ["gray", "Gray"]];
const NOTE_SORTS = [["edited", "Last edited"], ["created", "Newest"], ["oldest", "Oldest"], ["title", "Title (A–Z)"],
  ["match", "Best match"]];
const NOTE_HAS = [["", "Any note"], ["pinned", "Pinned"], ["picture", "With pictures"], ["file", "With files"],
  ["link", "With web links"], ["task", "Linked to a task or project"]];

// The pages' choices, kept on this device.
const NV = {
  category: load("notesCategory", ""),  // "" every category, "none", or a category id
  show: load("notesShow", "notes"),      // notes | all (with journal entries) | entries
  has: load("notesHas", ""),
  sort: load("notesSort", "edited"),
  journal: Number(load("journal", "")) || null,
  order: load("journalOrder", "newest"),
};

function setNV(key, value, store) {
  NV[key] = value;
  save(store, value ?? "");
  renderList();
}

const noteById = (id) => S.data.notes.find((n) => n.id === id) || S.extraNotes.find((n) => n.id === id);
const categoryById = (id) => S.data.note_categories.find((c) => c.id === id);
const journalById = (id) => S.data.journals.find((j) => j.id === id);
const currentJournal = () => journalById(NV.journal) || S.data.journals[0] || null;
const noteLabel = (n) => n.title || noteText(n).split("\n")[0].slice(0, 80) ||
  (n.journal_id ? `Entry for ${fmtDate(n.entry_date)}` : "Untitled note");
const utcNow = () => new Date().toISOString().slice(0, 19).replace("T", " ");

function notesViewTitle() {
  return S.view === "journal" ? (S.data.journals.length > 1 ? "Journals" : currentJournal()?.name || "Journal") : "Notes";
}

// ---- formatted text (editor.js has the editor and cleaning; this is a note's words) ----

// A note's words without the formatting (for search and previews).
const noteText = (n) => textOf(n.body);

// ---- search: words (all of them), "a phrase", -word to leave out, and field:value ----

const fold = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const SEARCH_FIELDS = new Set(["tag", "cat", "category", "journal", "area", "is", "has", "before", "after", "on", "title"]);

function parseNoteSearch(q) {
  const terms = [];
  for (const m of String(q || "").matchAll(/(-)?(?:([a-z]+):)?(?:"([^"]*)"?|(\S+))/gi)) {
    let [, neg, field, quoted, word] = m;
    let text = quoted ?? word ?? "";
    field = field?.toLowerCase();
    if (field && !SEARCH_FIELDS.has(field)) { text = `${field}:${text}`; field = null; }  // a web address, say
    if (!field && text.length > 1 && text.startsWith("#")) { field = "tag"; text = text.slice(1); }
    if (!text) continue;
    terms.push({ neg: !!neg, field, text: fold(text) });
  }
  return terms;
}

// What a note has: pictures, files (not placed in the text), web links, links to tasks.
function noteHas(n, what) {
  if (what === "pinned") return n.pinned;
  if (["picture", "pictures", "image", "photo"].includes(what)) return pictureIds(n.body).length > 0 ||
    n.attachments.some((f) => IMAGE_TYPES.includes(f.mime));
  if (["file", "files", "attachment"].includes(what)) {
    const placed = new Set(placedIds(n.body));
    return n.attachments.some((f) => !placed.has(f.id));
  }
  if (["link", "links", "url"].includes(what)) return /<a href=/.test(n.body);
  if (["task", "tasks", "project"].includes(what)) return n.related.length > 0;
  return false;
}

// The day a note is on: a journal entry's day, else the day it was written (local).
const noteDay = (n) => n.entry_date || (n.created_at ? localStamp(n.created_at)[0] : today());

// How well n matches the search terms (higher is better), or -1 if it doesn't.
function noteScore(n, terms) {
  const title = fold(n.title), text = fold(noteText(n)), tags = n.tags.map(fold);
  const cat = fold(categoryById(n.category_id)?.name), journal = fold(journalById(n.journal_id)?.name);
  const area = fold(areaById(n.area_id)?.name);
  const others = fold([...n.attachments.map((f) => f.name),
    ...refs(n, "related").map((r) => refInfo(r).title)].join(" "));
  let score = 0;
  for (const t of terms) {
    let hit = false, s = 0;
    const v = t.text;
    if (t.field === "tag") { hit = tags.some((x) => x === v || x.startsWith(v)); s = 3; }
    else if (t.field === "cat" || t.field === "category") { hit = cat.includes(v) || (v === "none" && !n.category_id); s = 2; }
    else if (t.field === "journal") { hit = !!n.journal_id && journal.includes(v); s = 1; }
    else if (t.field === "area") { hit = area.includes(v); s = 1; }
    else if (t.field === "title") { hit = title.includes(v); s = 6; }
    else if (t.field === "is") hit = { pinned: n.pinned, journal: !!n.journal_id, entry: !!n.journal_id, note: !n.journal_id }[v] ?? false;
    else if (t.field === "has") hit = noteHas(n, v);
    else if (t.field === "before") hit = noteDay(n) < v;
    else if (t.field === "after") hit = noteDay(n) > v;
    else if (t.field === "on") hit = noteDay(n).startsWith(v);
    else {
      const inTitle = title.includes(v);
      let count = 0;
      for (let at = text.indexOf(v); at >= 0 && count < 5; at = text.indexOf(v, at + v.length)) {
        count += at === 0 || /\W/.test(text[at - 1]) ? 1.5 : 1;  // the start of a word counts for more
      }
      const inTags = tags.some((x) => x.includes(v)), inCat = cat.includes(v) || journal.includes(v);
      hit = inTitle || count > 0 || inTags || inCat || others.includes(v) || area.includes(v);
      s = (inTitle ? 6 + (title.startsWith(v) ? 2 : 0) : 0) + count + (inTags ? 3 : 0) + (inCat ? 2 : 0) + (hit ? 0.5 : 0);
    }
    if (t.neg ? hit : !hit) return -1;
    if (!t.neg) score += s;
  }
  return score;
}

const searchWords = (terms) => terms.filter((t) => !t.neg && (!t.field || t.field === "title")).map((t) => t.text);

// text, escaped, with the words searched for marked.
function markWords(text, words) {
  text = String(text ?? "");
  const folded = fold(text);
  const hay = folded.length === text.length ? folded : text.toLowerCase();
  const spans = [];
  for (const w of words) {
    if (!w) continue;
    for (let at = hay.indexOf(w); at >= 0; at = hay.indexOf(w, at + w.length)) spans.push([at, at + w.length]);
  }
  if (!spans.length) return h(text);
  spans.sort((a, b) => a[0] - b[0]);
  let out = "", pos = 0;
  for (const [a, b] of spans) {
    if (b <= pos) continue;
    const from = Math.max(a, pos);
    out += h(text.slice(pos, from)) + `<mark>${h(text.slice(from, b))}</mark>`;
    pos = b;
  }
  return out + h(text.slice(pos));
}

// A piece of the text around the first word found, with the words marked.
function snippet(text, words, size = 220) {
  const hay = fold(text);
  const at = Math.min(...words.map((w) => hay.indexOf(w)).filter((i) => i >= 0), Infinity);
  let start = at === Infinity ? 0 : Math.max(0, at - 70);
  if (start) start = text.lastIndexOf(" ", start) + 1 || start;
  const piece = text.slice(start, start + size);
  return (start ? "…" : "") + markWords(piece, words).replace(/\n+/g, " · ") + (start + size < text.length ? "…" : "");
}

// The notes the page shows, as [note, score], in order.
function shownNotes(terms) {
  const journalPage = S.view === "journal";
  const q = S.search.trim();
  const regex = q.length > 1 && q.startsWith("/") && searchTest();
  let list = S.data.notes.filter((n) => inArea(n.area_id) && [...S.tagFilter].every((t) => n.tags.includes(t)));
  if (journalPage) {
    const j = currentJournal();
    list = list.filter((n) => n.journal_id && n.journal_id === j?.id);
  } else {
    // Asking for journal entries in the search finds them whatever "Show" says.
    const asks = terms.some((t) => !t.neg && (t.field === "journal" || (t.field === "is" && ["journal", "entry"].includes(t.text))));
    if (NV.show === "notes" && !asks) list = list.filter((n) => !n.journal_id);
    else if (NV.show === "entries") list = list.filter((n) => n.journal_id);
    if (NV.category === "none") list = list.filter((n) => !n.category_id);
    else if (NV.category) list = list.filter((n) => n.category_id === Number(NV.category));
    if (NV.has) list = list.filter((n) => noteHas(n, NV.has));
  }
  let scored = regex ? list.filter((n) => regex(n.title, noteText(n))).map((n) => [n, 1])
    : list.map((n) => [n, terms.length ? noteScore(n, terms) : 0]).filter(([, s]) => s >= 0);
  const by = (f) => (a, b) => f(a[0], b[0]);
  const edited = (a, b) => (b.updated_at || "").localeCompare(a.updated_at || "") || b.id - a.id;
  if (journalPage) {
    const dir = NV.order === "oldest" ? -1 : 1;
    scored.sort(by((a, b) => dir * (noteDay(b).localeCompare(noteDay(a)) || (b.created_at || "").localeCompare(a.created_at || "") || b.id - a.id)));
  } else if (NV.sort === "created") scored.sort(by((a, b) => (b.created_at || "").localeCompare(a.created_at || "") || b.id - a.id));
  else if (NV.sort === "oldest") scored.sort(by((a, b) => (a.created_at || "").localeCompare(b.created_at || "") || a.id - b.id));
  else if (NV.sort === "title") scored.sort(by((a, b) => (!a.title - !b.title) || noteLabel(a).localeCompare(noteLabel(b), undefined, { sensitivity: "base" })));
  else if (NV.sort === "match" && terms.length) scored.sort((a, b) => b[1] - a[1] || edited(a[0], b[0]));
  else scored.sort(by(edited));
  return scored;
}

// ---- the pages ----

// "3:12 PM" today, else the day.
function stampLabel(stamp) {
  if (!stamp) return "";
  const [d, hm] = localStamp(stamp);
  return d === today() ? fmtTime(hm) : fmtDate(d);
}
function stampFull(stamp) {
  if (!stamp) return "";
  const [d, hm] = localStamp(stamp);
  return `${dayHeading(d)}, ${fmtTime(hm)}`;
}

function noteMeta(n, { date = true } = {}) {
  const cat = categoryById(n.category_id);
  const j = n.journal_id && S.view !== "journal" && journalById(n.journal_id);
  const placed = new Set(placedIds(n.body));
  const files = n.attachments.filter((f) => !placed.has(f.id)).length;
  const links = n.related.length;
  const area = n.area_id && areaById(n.area_id);
  const stamp = NV.sort === "created" || NV.sort === "oldest" ? n.created_at : n.updated_at;
  return [
    cat ? `<span class="note-cat" data-color="${h(cat.color)}">${h(cat.name)}</span>` : "",
    j ? `<span class="note-cat">📓 ${h(j.name)}</span>` : "",
    area && S.data.areas.length > 1 ? `<span>${h(area.name)}</span>` : "",
    ...n.tags.map((t) => `<span class="note-tag">#${h(t)}</span>`),
    files ? `<span title="${files} file${files > 1 ? "s" : ""}">📎 ${files}</span>` : "",
    links ? `<span title="Linked to ${links} task${links > 1 ? "s or projects" : " or project"}">🔗 ${links}</span>` : "",
    date && stamp ? `<span class="note-when" title="Written ${h(stampFull(n.created_at))}; last edited ${h(stampFull(n.updated_at))}">${
      stamp === n.created_at ? "" : "Edited "}${stampLabel(stamp)}</span>` : "",
  ].filter(Boolean).join("");
}

function noteCard(n, words) {
  const color = categoryById(n.category_id)?.color || "";
  const body = words.length ? `<p class="note-snippet">${snippet(noteText(n), words)}</p>`
    : `<div class="note-body${fontClass(n)}">${showBody(n.body)}</div>`;
  return `<article class="note-card${n.pinned ? " pinned" : ""}" data-note="${n.id}" data-color="${h(color)}" tabindex="0">
    <button type="button" class="icon note-pin${n.pinned ? " on" : ""}" title="${n.pinned ? "Unpin" : "Pin"}"
      aria-label="${n.pinned ? "Unpin" : "Pin"}" aria-pressed="${n.pinned}">📌</button>
    ${n.title ? `<h3 class="note-title">${markWords(n.title, words)}</h3>` : ""}
    ${body}
    <div class="note-meta">${noteMeta(n)}</div>
  </article>`;
}

function renderNoteTags(list) {
  const used = new Set(list.flatMap((n) => n.tags));
  for (const t of S.tagFilter) used.add(t);
  $("#tag-bar").innerHTML = [...used].sort().map((tag) =>
    `<button class="tag-chip ${S.tagFilter.has(tag) ? "on" : ""}" data-tag="${h(tag)}">${h(tag)}</button>`).join("");
}

const SEARCH_TIP = `<p class="muted small notes-tip">Find words anywhere (all of them), <code>"a phrase"</code>,
  <code>-word</code> to leave out, <code>#tag</code>, <code>cat:</code>, <code>journal:</code>, <code>area:</code>,
  <code>has:picture</code> / <code>file</code> / <code>link</code> / <code>task</code>, <code>is:pinned</code>,
  <code>before:</code> / <code>after:</code> / <code>on:2026-11</code>.</p>`;

function renderNotes(el) {
  const terms = parseNoteSearch(S.search.trim().startsWith("/") ? "" : S.search);
  const words = searchWords(terms);
  if (S.view === "journal") return renderJournal(el, terms, words);
  renderNoteTags(S.data.notes.filter((n) => NV.show === "all" || (NV.show === "entries") === !!n.journal_id));
  const shown = shownNotes(terms).map(([n]) => n);
  const cats = S.data.note_categories;
  let html = `<div class="notes-bar">
      <button type="button" class="primary new-note" title="New note (N)">+ New note</button>
      <div class="cat-chips" role="group" aria-label="Category">
        <button type="button" class="cat-chip${NV.category ? "" : " on"}" data-cat="">All</button>
        ${cats.map((c) => `<button type="button" class="cat-chip${NV.category === String(c.id) ? " on" : ""}" data-cat="${c.id}"
          data-color="${h(c.color)}">${h(c.name)}</button>`).join("")}
        ${cats.length ? `<button type="button" class="cat-chip${NV.category === "none" ? " on" : ""}" data-cat="none">No category</button>` : ""}
        <button type="button" class="link edit-cats">${cats.length ? "Edit categories" : "+ Category"}</button>
      </div>
      <div class="notes-opts">
        <select class="notes-show" aria-label="Show">${options([["notes", "Notes"], ["all", "Notes and journal entries"],
          ["entries", "Journal entries"]], NV.show)}</select>
        <select class="notes-has" aria-label="Only">${options(NOTE_HAS, NV.has)}</select>
        <select class="notes-sort" aria-label="Sort by">${options(NOTE_SORTS.map(([v, l]) => [v, "Sort: " + l]), NV.sort)}</select>
      </div>
    </div>` + (S.search.trim() ? SEARCH_TIP : "");
  if (!S.data.notes.some((n) => !n.journal_id) && !S.search && NV.show === "notes") {
    html += `<p class="empty">Keep ideas, lists, recipes, plans… anything worth writing down, with pictures and files.
      Give them categories (each in its own colour) and tags, pin the important ones, and link them to tasks.
      Press <kbd>N</kbd> or <em>+ New note</em> to start one.</p>`;
  } else if (!shown.length) {
    html += '<p class="empty">Nothing matches.</p>';
  } else {
    const pinned = words.length ? [] : shown.filter((n) => n.pinned);
    const rest = pinned.length ? shown.filter((n) => !n.pinned) : shown;
    if (pinned.length) html += `<h2 class="group">Pinned</h2><div class="note-grid">${pinned.map((n) => noteCard(n, words)).join("")}</div>` +
      (rest.length ? '<h2 class="group">Others</h2>' : "");
    html += `<div class="note-grid">${rest.map((n) => noteCard(n, words)).join("")}</div>`;
  }
  el.innerHTML = html;
}

function renderJournal(el, terms, words) {
  const j = currentJournal();
  renderNoteTags(S.data.notes.filter((n) => j && n.journal_id === j.id));
  let html = `<div class="notes-bar">
    <div class="cat-chips" role="group" aria-label="Journal">
      ${S.data.journals.map((x) => `<button type="button" class="cat-chip${x.id === j?.id ? " on" : ""}" data-journal="${x.id}">📓 ${h(x.name)}</button>`).join("")}
      <button type="button" class="link new-journal">+ New journal</button>
    </div>
    ${j ? `<button type="button" class="primary new-note" title="New entry (N)">+ New entry</button>
      <div class="notes-opts">
        <select class="journal-order" aria-label="Order">${options([["newest", "Newest first"], ["oldest", "Oldest first"]], NV.order)}</select>
        <button type="button" class="link rename-journal">Rename</button>
        <button type="button" class="link danger delete-journal">Delete journal</button>
      </div>` : ""}
  </div>` + (S.search.trim() ? SEARCH_TIP : "");
  if (!j) {
    el.innerHTML = html + `<p class="empty">A journal is a diary: an entry for each day you write, with pictures where you
      want them in it. You can keep more than one (a travel journal, say).<br><br>
      <button type="button" class="primary start-journal">Start a journal</button></p>`;
    return;
  }
  const shown = shownNotes(terms).map(([n]) => n);
  if (!shown.length) html += `<p class="empty">${S.search || S.tagFilter.size ? "Nothing matches." :
    "No entries yet. Press <kbd>N</kbd> or <em>+ New entry</em> to write today's."}</p>`;
  let month = null;
  for (const n of shown) {
    const day = noteDay(n);
    const m = new Date(day + "T12:00:00").toLocaleDateString(undefined, { month: "long", year: "numeric" });
    if (m !== month) html += `<h2 class="group journal-month">${h(month = m)}</h2>`;
    const color = categoryById(n.category_id)?.color || "";
    html += `<article class="journal-entry" data-note="${n.id}" data-color="${h(color)}" tabindex="0">
      <div class="entry-day">${h(dayHeading(day))}</div>
      ${n.title ? `<h3 class="note-title">${markWords(n.title, words)}</h3>` : ""}
      ${words.length ? `<p class="note-snippet">${snippet(noteText(n), words, 400)}</p>`
        : `<div class="note-body${fontClass(n)}">${showBody(n.body) || '<p class="muted">(empty)</p>'}</div>`}
      <div class="note-meta">${noteMeta(n, { date: false })}</div>
    </article>`;
  }
  el.innerHTML = html;
}

// Notes linked to a task or project (kind), for its editor.
function linkedNotes(x, kind) {
  if (x.deleted_at || x.id < 0) return "";
  const mine = S.data.notes.filter((n) => (n.related || []).some((r) => (r.id ?? r) === x.id));
  return `<div class="deps linked-notes"><span class="ln-label">Notes</span>
    ${mine.map((n) => `<button type="button" class="link open-note" data-note="${n.id}">📝 ${h(noteLabel(n))}</button>`).join("")}
    <button type="button" class="link new-linked-note" data-kind="${kind}" data-id="${x.id}">+ New note</button></div>`;
}

function trashedNotes() {
  if (!S.extraNotes.length) return "";
  return '<h2 class="group">Notes</h2>' + S.extraNotes.map((n) =>
    `<div class="trash-note" data-note="${n.id}"><span class="title">${n.journal_id ? "📓" : "📝"} ${h(noteLabel(n))}</span>
      <button class="link restore-note">Restore</button>
      <button class="link danger purge-note">Delete forever</button></div>`).join("");
}

function upsertNote(n) {
  const i = S.data.notes.findIndex((x) => x.id === n.id);
  if (n.deleted_at) { if (i >= 0) S.data.notes.splice(i, 1); }
  else if (i >= 0) S.data.notes[i] = n;
  else S.data.notes.push(n);
}

async function patchNote(id, changes) {
  const n = await api("PATCH", `/notes/${id}`, changes);
  if (n) upsertNote(n);
  if (ned.n?.id === id && n) for (const k of ["pinned", "updated_at", "deleted_at"]) ned.n[k] = n[k];
  renderList();
  return n;
}

async function trashNote(id) {
  await patchNote(id, { deleted: true });
  toast("Moved to trash.", async () => { await api("PATCH", `/notes/${id}`, { deleted: false }); await refresh(); });
}

// A note changed offline (app.js's changeOffline): its edit time, and its links as ids.
function noteChangedOffline(n, changes, stamp) {
  if (Object.keys(changes).some((k) => ["title", "body", "font", "category_id", "area_id", "journal_id", "entry_date",
    "tags", "related"].includes(k))) n.updated_at = stamp;
  if (changes.journal_id && !n.entry_date) n.entry_date = today();
  if ("journal_id" in changes && !changes.journal_id) n.entry_date = null;
}

// ---- the editor (a dialog over the page, saving as you type) ----

const ned = { n: null, dirty: new Set(), timer: 0, chain: Promise.resolve(), created: null };

// The note dialog's text, for the editor (editor.js).
const noteHost = {
  root: null, kind: "note",
  get item() { return ned.n; },
  changed: () => noteFieldChanged("body"),
  save: (options) => saveNote(options),
  uploaded(data) {
    const n = ned.n;
    if (!n) return;
    n.attachments = data.attachments;
    n.updated_at = data.updated_at;
    upsertNote(n);
    renderNoteDates();
  },
  filesChanged: () => renderNoteFiles(),
  close: () => closeNote(),
  setFont(value) {
    ned.n.font = value;
    editorBody().className = `ne-body note-body${fontClass(ned.n)}`;
    noteFieldChanged("font");
  },
};

function noteDialog() {
  let dlg = $("#note-dialog");
  if (!dlg) {
    dlg = document.createElement("dialog");
    dlg.id = "note-dialog";
    dlg.setAttribute("aria-label", "Note");
    document.body.append(dlg);
    bindNoteDialog(dlg);
  }
  return dlg;
}

function draftNote(extra = {}) {
  const journal = S.view === "journal" ? currentJournal() : null;
  const cat = S.view === "notes" && NV.category && NV.category !== "none" ? Number(NV.category) : null;
  return { id: null, title: "", body: "", font: "", category_id: cat, area_id: chosenArea(), journal_id: journal?.id ?? null,
    entry_date: journal ? today() : null, pinned: false, created_at: null, updated_at: null, deleted_at: null,
    tags: [...S.tagFilter], attachments: [], related: [], ...extra };
}

function newNote(extra) {
  openNote(draftNote(extra));
}

function openNoteById(id) {
  const n = noteById(id);
  if (!n) return toast("That note isn't there any more.");
  if (S.view !== "notes" && S.view !== "journal") {
    if (n.journal_id) { NV.journal = n.journal_id; save("journal", n.journal_id); }
    setView(n.journal_id ? "journal" : "notes");
  }
  openNote(n);
}

// After the Share menu put something in a note (app.py's share_to_note).
function openSharedNote(id) {
  const n = noteById(id);
  if (!n) return;
  if (n.journal_id) { NV.journal = n.journal_id; save("journal", n.journal_id); }
  setView(n.journal_id ? "journal" : "notes");
  openNote(n);
  toast(n.journal_id ? `Added to today's entry in “${journalById(n.journal_id)?.name || "your journal"}”.` : "Added to your notes.");
}

function openNote(n) {
  closeMenu();
  const dlg = noteDialog();
  if (dlg.open && ned.n) saveNote();
  ned.n = n;
  ned.dirty.clear();
  ned.created = n.id ? null : utcNow();
  dlg.innerHTML = editorHtml(n);
  noteHost.root = dlg;
  ed = noteHost;
  startEditor(noteHost, n.body);
  const body = $(".ne-body", dlg);
  renderNoteFiles();
  renderNoteDates();
  if (!dlg.open) {
    dlg.showModal();
    history.pushState({ note: true }, "");  // so Back closes the note, not the app
  }
  dlg.scrollTop = 0;
  if (!n.id) (n.journal_id ? body : $(".ne-title", dlg)).focus();
  else $(".ne-close", dlg).focus();
}

function editorHtml(n) {
  const cats = S.data.note_categories, color = categoryById(n.category_id)?.color || "";
  return `<div class="ne" data-color="${h(color)}">
    <div class="ne-head">
      <select class="ne-category" aria-label="Category">${options([["", "No category"], ...cats.map((c) => [c.id, c.name]),
        ["new", "New category…"]], n.category_id ?? "")}</select>
      <label class="check ne-entry" title="Put it in a journal, as the entry for a day"><input type="checkbox" class="ne-journal-on"
        ${n.journal_id ? "checked" : ""}> Journal entry</label>
      <span class="ne-journal-opts"${n.journal_id ? "" : " hidden"}>
        <select class="ne-journal" aria-label="Journal">${options([...S.data.journals.map((j) => [j.id, j.name]),
          ["new", "New journal…"]], n.journal_id ?? "")}</select>
        <input type="date" class="ne-date" value="${h(n.entry_date || today())}" aria-label="The entry's day">
      </span>
      <span class="ne-space"></span>
      <button type="button" class="icon ne-pin${n.pinned ? " on" : ""}" aria-pressed="${n.pinned}" title="${n.pinned ? "Unpin" : "Pin"}"
        aria-label="Pin">📌</button>
      <button type="button" class="icon ne-close" title="Close (Esc)" aria-label="Close">✕</button>
    </div>
    <input class="ne-title" placeholder="Title" value="${h(n.title)}" maxlength="500" aria-label="Title">
    ${editorTools({ font: n.font })}
    <div class="ne-body note-body${fontClass(n)}" contenteditable="true" role="textbox" aria-multiline="true"
      aria-label="Note" spellcheck="true"></div>
    <div class="ne-files attachments"></div>
    <div class="ne-more">
      <label>Tags <input class="ne-tags" value="${h(n.tags.join(", "))}" list="note-tag-list" placeholder="comma, separated" autocomplete="off"></label>
      <datalist id="note-tag-list">${S.data.tags.map((t) => `<option value="${h(t.name)}">`).join("")}</datalist>
      <label>Area <select class="ne-area">${options([["", "No area"], ...S.data.areas.map((a) => [a.id, a.name])], n.area_id ?? "")}</select></label>
      <div class="ne-links">${noteLinksField(n)}</div>
    </div>
    <div class="ne-foot">
      <span class="muted small ne-dates"></span>
      <button type="button" class="link ne-convert" data-to="task" title="The same note, as a task: its title, text, tags, files and links go with it">Make it a task</button>
      <button type="button" class="link ne-convert" data-to="project" title="The same note, as a project">Make it a project</button>
      <button type="button" class="link danger ne-delete">Move to trash</button>
      <button type="button" class="primary ne-done">Done</button>
    </div>
    ${editorImageBar("note")}
  </div>`;
}

function noteLinksField(n) {
  const saved = new Map(n.related.filter((r) => typeof r === "object").map((r) => [r.id, r]));
  const chips = refs(n, "related").map((ref) => {
    const r = refInfo(ref, saved.get(ref));
    return `<span class="dep-chip${r.open ? "" : " done"}" data-ref="${ref}">${
      r.open ? `<button type="button" class="link ne-open-link">${h(r.title)}</button>` : h(r.title)}
      <button type="button" class="icon ne-del-link" aria-label="Remove">✕</button></span>`;
  }).join("");
  return `<div class="deps"><label>Linked to <input class="ne-link-search" placeholder="Link a task or project…" autocomplete="off"></label>
    <div class="dep-chips">${chips}</div><div class="ne-link-results"></div></div>`;
}

function renderNoteDates() {
  const n = ned.n, el = $("#note-dialog .ne-dates");
  if (!n || !el) return;
  el.textContent = n.created_at ? `Written ${stampFull(n.created_at)}` +
    (n.updated_at && n.updated_at !== n.created_at ? ` · edited ${stampFull(n.updated_at)}` : "") : "Not saved yet";
}

// The note's files that aren't placed in its text: other files, and pictures taken out of it.
function renderNoteFiles() {
  const n = ned.n, dlg = $("#note-dialog");
  const placed = new Set(placedIds(editorText(noteHost)));
  const files = n.attachments.filter((f) => !placed.has(f.id));
  $(".ne-files", dlg).innerHTML = files.length ? `<div class="att-head">Files</div>` + files.map((f) =>
    fileRow(f, false).replace('<span class="muted small">', (IMAGE_TYPES.includes(f.mime)
      ? '<button type="button" class="link place-pic" title="Put it back in the text, where the cursor was">Put in the note</button> ' : "") +
      '<span class="muted small">')).join("") : "";
}

function noteFieldChanged(field) {
  ned.dirty.add(field);
  clearTimeout(ned.timer);
  ned.timer = setTimeout(saveNote, 800);
}

function noteChanges() {
  const dlg = $("#note-dialog"), n = ned.n, out = {};
  for (const f of ned.dirty) {
    if (f === "title") out.title = $(".ne-title", dlg).value;
    else if (f === "body") out.body = editorText(noteHost);
    else if (f === "tags") out.tags = [...new Set($(".ne-tags", dlg).value.split(",").map((t) => t.trim()).filter(Boolean))];
    else if (f === "related") out.related = n.related.map((r) => r.id ?? r);
    else out[f] = n[f];
  }
  ned.dirty.clear();
  return out;
}

// Saves what's changed in the open note (a new one once something's written, or force).
function saveNote({ force } = {}) {
  clearTimeout(ned.timer);
  const n = ned.n;
  if (!n) return ned.chain;
  const changes = noteChanges();
  ned.chain = ned.chain.then(async () => {
    let saved;
    if (!n.id) {
      const fresh = { title: n.title, body: n.body, font: n.font, category_id: n.category_id, area_id: n.area_id,
        journal_id: n.journal_id, entry_date: n.entry_date, pinned: n.pinned, tags: n.tags,
        related: n.related.map((r) => r.id ?? r),
        created_at: ned.created, ...changes };
      if (!force && !fresh.title?.trim() && !fresh.body) { ned.dirty = new Set([...ned.dirty, ...Object.keys(changes)]); return; }
      saved = await api("POST", "/notes", fresh);
    } else if (Object.keys(changes).length) {
      saved = await api("PATCH", `/notes/${n.id}`, changes);
    }
    if (!saved) return;
    // Take what the server says, except what's been changed again since (still to be sent).
    for (const [k, v] of Object.entries(saved)) if (!ned.dirty.has(k)) n[k] = v;
    upsertNote(n);
    if (ned.n === n) renderNoteDates();
    if (!$("#note-dialog").open || ned.n !== n) renderList();
  }).catch(() => { /* (shown by api) */ });
  return ned.chain;
}

// Changes sent from the outbox: a note made offline that's open has its real id now.
function noteEditorSaved(ids) {
  if (ned.n?.id < 0 && ids[ned.n.id]) ned.n.id = ids[ned.n.id];
}

function closeNote() {
  const dlg = $("#note-dialog");
  if (history.state?.note) history.back();  // which closes it (popstate, below)
  else if (dlg?.open) dlg.close();
}

async function setNoteJournal(on) {
  const n = ned.n, dlg = $("#note-dialog");
  if (on && !S.data.journals.length) {
    const j = await api("POST", "/journals", { name: "Journal" });
    S.data.journals.push(j);
  }
  n.journal_id = on ? (n.journal_id || currentJournal()?.id) : null;
  n.entry_date = on ? (n.entry_date || today()) : null;
  $(".ne-journal-opts", dlg).hidden = !on;
  $(".ne-journal", dlg).innerHTML = options([...S.data.journals.map((j) => [j.id, j.name]), ["new", "New journal…"]], n.journal_id ?? "");
  $(".ne-date", dlg).value = n.entry_date || today();
  noteFieldChanged("journal_id");
  noteFieldChanged("entry_date");
}

async function newCategory() {
  const name = prompt("Name of the new category")?.trim();
  if (!name) return null;
  const used = new Set(S.data.note_categories.map((c) => c.color));
  const color = NOTE_COLORS.map(([c]) => c).find((c) => c && !used.has(c)) || "";
  const c = await api("POST", "/note-categories", { name, color });
  S.data.note_categories.push(c);
  return c;
}

async function newJournal() {
  const name = prompt("Name of the new journal (e.g. Travel)")?.trim();
  if (!name) return null;
  const j = await api("POST", "/journals", { name });
  S.data.journals.push(j);
  return j;
}

// ---- events ----

function bindNoteDialog(dlg) {
  dlg.addEventListener("close", () => {
    chooseImage(null);
    saveNote().then(() => {
      if (!$("#note-dialog").open) { ned.n = null; if (ed === noteHost) ed = null; renderList(); }
    });
  });
  window.addEventListener("popstate", () => { if (dlg.open && !history.state?.note) dlg.close(); });
  dlg.addEventListener("cancel", (e) => {
    // Esc: closes the picture bar first, else the note (through history, like the ✕).
    e.preventDefault();
    if (noteHost.img) chooseImage(null); else closeNote();
  });
  dlg.addEventListener("click", (e) => { if (e.target === dlg) closeNote(); });  // the backdrop
  dlg.addEventListener("input", (e) => {
    const t = e.target;
    if (t.classList.contains("ne-title")) noteFieldChanged("title");
    else if (t.classList.contains("ne-tags")) noteFieldChanged("tags");
    else if (t.classList.contains("ne-link-search")) {
      const n = ned.n;
      $(".ne-link-results", dlg).innerHTML = refResults(refMatches(n, "note", t.value, new Set(refs(n, "related"))), "ne-add-link");
    }
  });
  dlg.addEventListener("change", async (e) => {
    const t = e.target, n = ned.n;
    if (t.classList.contains("ne-category")) {
      if (t.value === "new") {
        const c = await newCategory();
        t.innerHTML = options([["", "No category"], ...S.data.note_categories.map((x) => [x.id, x.name]), ["new", "New category…"]], c?.id ?? n.category_id ?? "");
      }
      n.category_id = t.value ? Number(t.value) : null;
      $(".ne", dlg).dataset.color = categoryById(n.category_id)?.color || "";
      noteFieldChanged("category_id");
    } else if (t.classList.contains("ne-journal-on")) {
      await setNoteJournal(t.checked);
    } else if (t.classList.contains("ne-journal")) {
      if (t.value === "new") {
        const j = await newJournal();
        t.innerHTML = options([...S.data.journals.map((x) => [x.id, x.name]), ["new", "New journal…"]], j?.id ?? n.journal_id ?? "");
      }
      n.journal_id = Number(t.value) || n.journal_id;
      noteFieldChanged("journal_id");
    } else if (t.classList.contains("ne-date")) {
      if (!t.value) return;
      n.entry_date = t.value;
      noteFieldChanged("entry_date");
    } else if (t.classList.contains("ne-area")) {
      n.area_id = t.value ? Number(t.value) : null;
      noteFieldChanged("area_id");
    }
  });
  dlg.addEventListener("click", async (e) => {
    const b = e.target.closest("button");
    const n = ned.n;
    if (!b) {
      if (e.target.closest(".att-view")) {
        e.preventDefault();
        openViewer(n.attachments, Number(e.target.closest("[data-file]").dataset.file));
      }
      return;
    }
    if (b.classList.contains("ne-close") || b.classList.contains("ne-done")) return closeNote();
    if (b.classList.contains("ne-pin")) {
      n.pinned = !n.pinned;
      b.classList.toggle("on", n.pinned);
      b.setAttribute("aria-pressed", n.pinned);
      b.title = n.pinned ? "Unpin" : "Pin";
      return noteFieldChanged("pinned");
    }
    if (b.classList.contains("ne-convert")) {
      await saveNote({ force: true });
      if (!n.id || n.id < 0) return toast("Wait until this note has been saved (when you're back online).");
      const id = n.id;
      closeNote();
      return setTimeout(() => convertTo(id, b.dataset.to), 50);
    }
    if (b.classList.contains("ne-delete")) {
      await saveNote();
      const id = n.id;
      ned.n = null;
      closeNote();
      if (id) trashNote(id);
      return;
    }
    if (b.classList.contains("del-file")) {
      const owner = await deleteAttachment(n, Number(b.closest("[data-file]").dataset.file));
      if (!owner) return;
      n.attachments = owner.attachments;
      return renderNoteFiles();
    }
    if (b.classList.contains("ne-add-link") || b.classList.contains("ne-del-link")) {
      const id = Number(b.dataset.ref || b.closest("[data-ref]").dataset.ref);
      if (b.classList.contains("ne-add-link")) {
        const p = projectById(id);
        n.related = [...n.related, { id, kind: p ? "project" : "task", title: p ? p.name : taskById(id)?.title }];
      } else n.related = n.related.filter((r) => (r.id ?? r) !== id);
      noteFieldChanged("related");
      $(".ne-links", dlg).innerHTML = noteLinksField(n);
      if (b.classList.contains("ne-add-link")) $(".ne-link-search", dlg).focus();
      return;
    }
    if (b.classList.contains("ne-open-link")) {
      const ref = b.closest("[data-ref]").dataset.ref;
      closeNote();
      return setTimeout(() => openRef(ref), 50);
    }
  });
  dlg.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); closeNote(); }
    else if (e.key === "Enter" && e.target.classList.contains("ne-title")) { e.preventDefault(); editorBody().focus(); }
  });
}

async function editCategories() {
  let dlg = $("#cat-dialog");
  if (!dlg) {
    dlg = document.createElement("dialog");
    dlg.id = "cat-dialog";
    document.body.append(dlg);
    dlg.addEventListener("change", async (e) => {
      const li = e.target.closest("[data-cat]");
      if (!li) return;
      const id = Number(li.dataset.cat);
      const changes = e.target.classList.contains("cat-name") ? { name: e.target.value } : { color: e.target.value };
      const c = await api("PATCH", `/note-categories/${id}`, changes);
      Object.assign(categoryById(id), c);
      if (changes.color !== undefined) li.dataset.color = c.color;
      renderList();
    });
    dlg.addEventListener("click", async (e) => {
      if (e.target.closest(".close-dlg")) return dlg.close();
      const del = e.target.closest(".del-cat");
      if (del) {
        const c = categoryById(Number(del.closest("[data-cat]").dataset.cat));
        if (!confirm(`Delete the category “${c.name}”? Its notes stay, without a category.`)) return;
        await api("DELETE", `/note-categories/${c.id}`);
        if (NV.category === String(c.id)) setNV("category", "", "notesCategory");
        await refresh();
        fillCategories(dlg);
      }
    });
    dlg.addEventListener("submit", async (e) => {
      e.preventDefault();
      const name = e.target.elements.name.value.trim();
      if (!name) return;
      const used = new Set(S.data.note_categories.map((c) => c.color));
      const color = NOTE_COLORS.map(([c]) => c).find((c) => c && !used.has(c)) || "";
      S.data.note_categories.push(await api("POST", "/note-categories", { name, color }));
      fillCategories(dlg);
      renderList();
      $("input[name=name]", dlg).focus();
    });
  }
  fillCategories(dlg);
  dlg.showModal();
}

function fillCategories(dlg) {
  dlg.innerHTML = `<div class="dlg-head"><h2>Categories</h2><button type="button" class="icon close-dlg" aria-label="Close">✕</button></div>
    <p class="muted small">Each note can be in one category; its colour shows on the note.</p>
    <ul class="plain cat-list">${S.data.note_categories.map((c) => `<li data-cat="${c.id}" data-color="${h(c.color)}">
      <input class="cat-name" value="${h(c.name)}" aria-label="Name">
      <span class="swatches" role="radiogroup" aria-label="Colour">${NOTE_COLORS.map(([v, label]) =>
        `<label class="swatch" data-color="${v}" title="${label}"><input type="radio" name="color-${c.id}" value="${v}"
          ${c.color === v ? "checked" : ""} aria-label="${label}"></label>`).join("")}</span>
      <button type="button" class="link danger del-cat">Delete</button></li>`).join("") || '<li class="muted">None yet.</li>'}</ul>
    <form class="inline"><input name="name" placeholder="New category" maxlength="100" required><button>Add</button></form>`;
}

async function taskToNote(t) {
  if (!t || !confirm(`Make “${t.title}” a note? Its notes, tags, files and links stay with it.`)) return;
  convertTo(t.id, "note");
}

// Settings → Sharing to Entropicide → Ask each time: what was shared is already an Inbox task
// (so closing this keeps it there); a note or journal entry takes it from there (app.py's
// task_to_note).
function askShared(taskId) {
  const t = taskById(taskId);
  if (!t) return;
  const files = t.attachments.length;
  const dlg = $("#proj-dialog");
  dlg.innerHTML = `<div class="dlg-head"><h2>Where should this go?</h2>
      <button type="button" class="icon close-dlg" aria-label="Close">✕</button></div>
    <p class="share-what"><strong>${h(t.title)}</strong>${files ? ` <span class="muted">· ${files} file${files > 1 ? "s" : ""}</span>` : ""}</p>
    <div class="share-choices">
      <button type="button" class="primary" data-to="inbox">📥 A task in the Inbox</button>
      <button type="button" data-to="note">📝 A new note</button>
      ${S.data.journals.map((j) => `<button type="button" data-to="journal" data-journal="${j.id}">📓 Today's entry in “${h(j.name)}”</button>`).join("")}
    </div>
    <p class="muted small">Closing this leaves it in the Inbox. To stop being asked, choose a place in Settings → Sharing to Entropicide.</p>`;
  dlg.onclick = async (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.classList.contains("close-dlg") || b.dataset.to === "inbox") {
      dlg.close();
      toast("Added to your Inbox.");
      return openTask(taskId);
    }
    if (!b.dataset.to) return;
    for (const x of dlg.querySelectorAll("button")) x.disabled = true;
    try {
      const journal = b.dataset.to === "journal" ? Number(b.dataset.journal) : null;
      const n = await api("POST", `/tasks/${taskId}/to-note?now=${nowStamp()}`, journal ? { journal_id: journal } : {});
      dlg.close();
      await refresh();
      openSharedNote(n.id);
    } catch {
      for (const x of dlg.querySelectorAll("button")) x.disabled = false;
    }
  };
  // (The dialog is shared with Convert to project: this handler goes with the question.)
  dlg.addEventListener("close", () => { dlg.onclick = null; }, { once: true });
  dlg.showModal();
}

function bindNotes() {
  const list = $("#list");
  list.addEventListener("click", async (e) => {
    const b = e.target.closest("button");
    // The Trash's notes (shown in any view that lists them).
    const trashed = e.target.closest(".trash-note");
    if (trashed && b) {
      const id = Number(trashed.dataset.note);
      if (b.classList.contains("restore-note")) await api("PATCH", `/notes/${id}`, { deleted: false });
      else if (b.classList.contains("purge-note")) {
        if (!confirm("Delete this note forever? It can't be undone.")) return;
        await api("DELETE", `/documents/${id}`);
      }
      return refresh();
    }
    if (S.view !== "notes" && S.view !== "journal") return;
    if (e.target.closest(".note-body a[href], .note-snippet a[href]")) return;  // a link in a note: just open it
    if (b?.classList.contains("new-note")) return newNote();
    if (b?.classList.contains("edit-cats")) return editCategories();
    if (b?.dataset.cat !== undefined) return setNV("category", b.dataset.cat, "notesCategory");
    if (b?.dataset.journal) return setNV("journal", Number(b.dataset.journal), "journal");
    if (b?.classList.contains("new-journal") || b?.classList.contains("start-journal")) {
      const j = b.classList.contains("start-journal") ? await api("POST", "/journals", { name: "Journal" }) : await newJournal();
      if (!j) return;
      if (!S.data.journals.some((x) => x.id === j.id)) S.data.journals.push(j);
      return setNV("journal", j.id, "journal");
    }
    if (b?.classList.contains("rename-journal")) {
      const j = currentJournal();
      const name = prompt("Rename the journal", j.name)?.trim();
      if (!name) return;
      Object.assign(j, await api("PATCH", `/journals/${j.id}`, { name }));
      return render();
    }
    if (b?.classList.contains("delete-journal")) {
      const j = currentJournal();
      const count = S.data.notes.filter((n) => n.journal_id === j.id).length;
      if (!confirm(`Delete the journal “${j.name}”?${count ? ` Its ${count} entr${count > 1 ? "ies go" : "y goes"} to the trash.` : ""}`)) return;
      await api("DELETE", `/journals/${j.id}`);
      NV.journal = null;
      await refresh();
      return toast(count ? "Deleted. Its entries are in the trash." : "Deleted.");
    }
    const card = e.target.closest("[data-note]");
    if (!card) return;
    const n = noteById(Number(card.dataset.note));
    if (!n) return;
    if (b?.classList.contains("note-pin")) return patchNote(n.id, { pinned: !n.pinned });
    const box = checkboxAt(e);
    if (box) return patchNote(n.id, { body: tickedBody(n.body, card, box) });
    if (e.target.closest("img[data-file]") && S.view === "journal") return openViewer(n.attachments, Number(e.target.closest("img").dataset.file));
    openNote(n);
  });
  list.addEventListener("keydown", (e) => {
    const card = e.target.closest?.("[data-note]");
    if (card && e.key === "Enter" && !e.target.closest("button")) { e.preventDefault(); openNote(noteById(Number(card.dataset.note))); }
  });
  list.addEventListener("change", (e) => {
    const t = e.target;
    if (t.classList.contains("notes-show")) setNV("show", t.value, "notesShow");
    else if (t.classList.contains("notes-has")) setNV("has", t.value, "notesHas");
    else if (t.classList.contains("notes-sort")) setNV("sort", t.value, "notesSort");
    else if (t.classList.contains("journal-order")) setNV("order", t.value, "journalOrder");
  });
  // Notes linked to the task or project open in the editor.
  $("#detail").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (b?.classList.contains("open-note")) openNoteById(Number(b.dataset.note));
    else if (b?.classList.contains("new-linked-note")) {
      const id = Number(b.dataset.id);
      const x = b.dataset.kind === "task" ? taskById(id) : projectById(id);
      newNote({ related: [{ id, kind: b.dataset.kind, title: x.title ?? x.name }],
        area_id: b.dataset.kind === "task" ? taskArea(x) : x.area_id });
    }
  });
}

bindNotes();
