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
const NOTE_FONTS = [["", "Default font"], ["sans", "Sans"], ["serif", "Serif"], ["mono", "Monospace"],
  ["hand", "Handwriting"], ["round", "Rounded"], ["narrow", "Narrow"]];
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

// ---- formatted text ----

const NOTE_BLOCKS = new Set(["p", "div", "h1", "h2", "h3", "blockquote", "ul", "ol", "li", "pre"]);
const NOTE_INLINE = { b: "b", strong: "b", i: "i", em: "i", u: "u", ins: "u", s: "s", strike: "s", del: "s",
  code: "code", sub: "sub", sup: "sup" };
const NOTE_SKIP = new Set(["script", "style", "template", "head", "title", "iframe", "object", "embed", "svg", "math",
  "noscript", "select", "textarea", "button", "meta", "link", "input"]);
const NOTE_RENAME = { h4: "h3", h5: "h3", h6: "h3", section: "div", article: "div", header: "div", footer: "div",
  main: "div", figure: "div", figcaption: "div", table: "div", tbody: "div", thead: "div", tr: "div", dl: "div",
  dt: "div", dd: "div" };
const FONT_NAMES = NOTE_FONTS.map(([v]) => v).filter(Boolean);

// One of NOTE_FONTS for a CSS font-family list, if it's clearly one of them (richtext.font_from_family).
function fontFromFamily(family) {
  family = String(family || "").toLowerCase();
  if (/monospace|courier|mono/.test(family)) return "mono";
  if (/cursive|comic|hand|script/.test(family)) return "hand";
  if (/narrow|condensed/.test(family)) return "narrow";
  if (/rounded/.test(family)) return "round";
  if ((family.includes("serif") && !family.includes("sans")) || /georgia|times/.test(family)) return "serif";
  return null;
}

function styleTags(style) {
  style = String(style || "").toLowerCase();
  const out = [];
  if (/font-weight\s*:\s*(bold|[6-9]00)/.test(style)) out.push(["b", ""]);
  if (/font-style\s*:\s*italic/.test(style)) out.push(["i", ""]);
  if (/text-decoration[^;]*underline/.test(style)) out.push(["u", ""]);
  if (/text-decoration[^;]*line-through/.test(style)) out.push(["s", ""]);
  const family = style.match(/font-family\s*:\s*([^;]+)/);
  const face = family && fontFromFamily(family[1]);
  if (face) out.push(["font", ` face="${face}"`]);
  return out;
}

// HTML (from the editor, or pasted from anywhere) reduced to what a note may hold; the same
// set as richtext.py, which cleans it again on the server.
function cleanNoteHtml(html) {
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  const walk = (node) => {
    if (node.nodeType === Node.TEXT_NODE) return h(node.nodeValue);
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const raw = node.tagName.toLowerCase();
    const tag = NOTE_RENAME[raw] || raw;
    if (NOTE_SKIP.has(tag)) return "";
    if (tag === "br") return "<br>";
    if (tag === "hr") return "<hr>";
    if (tag === "img") {
      return /^\d+$/.test(node.getAttribute("data-file") || "") ? `<img ${imageAttrs((a) => node.getAttribute(a))}>` : "";
    }
    const opens = [];
    if (NOTE_BLOCKS.has(tag)) opens.push([tag, ""]);
    else if (tag === "a") {
      const href = (node.getAttribute("href") || "").trim();
      if (/^(https?:\/\/|mailto:)[^\s"'<>]+$/i.test(href)) opens.push(["a", ` href="${h(href)}" target="_blank" rel="noopener noreferrer"`]);
    } else if (tag === "font") {
      const f = node.getAttribute("face") || "";
      const face = FONT_NAMES.includes(f) ? f : fontFromFamily(f);
      if (face) opens.push(["font", ` face="${face}"`]);
    } else if (NOTE_INLINE[tag]) opens.push([NOTE_INLINE[tag], ""]);
    opens.push(...styleTags(node.getAttribute("style")));
    const inner = [...(tag === "template" ? [] : node.childNodes)].map(walk).join("");
    return opens.map(([n, a]) => `<${n}${a}>`).join("") + inner + opens.map(([n]) => `</${n}>`).reverse().join("");
  };
  const out = [...tpl.content.childNodes].map(walk).join("");
  return out.replace(/<br>|<\/?p>|<\/?div>|\s|&nbsp;| /g, "") ? out : "";
}

// A placed picture's attributes as they're kept (richtext.image_attrs, which this mirrors): its
// file and size; for a cropped or turned copy, the original and how it was edited; and opacity
// and being behind the text, which are only how it shows.
function imageAttrs(get) {
  let out = `data-file="${Number(get("data-file"))}"`;
  const size = get("data-size"), orig = get("data-orig") || "", crop = get("data-crop") || "";
  const turn = get("data-rotate"), opacity = get("data-opacity") || "";
  if (["s", "m", "l"].includes(size)) out += ` data-size="${size}"`;
  if (/^\d+$/.test(orig)) {
    out += ` data-orig="${Number(orig)}"`;
    if (/^\d{1,4}(,\d{1,4}){3}$/.test(crop) && crop.split(",").every((x) => Number(x) <= 1000)) {
      out += ` data-crop="${crop.split(",").map(Number).join(",")}"`;
    }
    if (["90", "180", "270"].includes(turn)) out += ` data-rotate="${turn}"`;
  }
  if (/^\d+$/.test(opacity) && Number(opacity) >= 5 && Number(opacity) < 100) out += ` data-opacity="${Number(opacity)}"`;
  if (get("data-behind") === "1") out += ' data-behind="1"';
  return out;
}

// A note's words without the formatting (for search and previews), worked out once per version.
const noteTexts = new Map();
function noteText(n) {
  const hit = noteTexts.get(n.id);
  if (hit && hit.body === n.body) return hit.text;
  const tpl = document.createElement("template");
  tpl.innerHTML = String(n.body || "").replace(/<br>|<\/(p|div|li|h[1-3]|blockquote|pre)>/g, "$&\n");
  const text = tpl.content.textContent.replace(/[ \t ]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  noteTexts.set(n.id, { body: n.body, text });
  return text;
}

const pictureIds = (html) => [...String(html || "").matchAll(/<img data-file="(\d+)"/g)].map((m) => Number(m[1]));
// The files the text uses: its pictures, and the originals of pictures that were cropped or turned.
const placedIds = (html) => [...pictureIds(html),
  ...[...String(html || "").matchAll(/<img [^>]*data-orig="(\d+)"/g)].map((m) => Number(m[1]))];
const picSrc = (id) => `${BASE}/api/attachments/${id}`;
// Stored HTML as shown: pictures get their address (only their id is kept).
const showBody = (html) => String(html || "").replace(/<img data-file="(\d+)"([^>]*)>/g, (_, id, rest) => {
  const opacity = rest.match(/data-opacity="(\d+)"/);
  return `<img data-file="${id}"${rest} src="${picSrc(id)}" alt="" loading="lazy"${opacity ? ` style="opacity:${opacity[1] / 100}"` : ""}>`;
});
const fontClass = (n) => (n.font ? ` font-${n.font}` : "");

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
  if (["task", "tasks", "project"].includes(what)) return !!(n.related.length || n.related_projects.length);
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
  const links = n.related.length + n.related_projects.length;
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
  const field = kind === "task" ? "related" : "related_projects";
  const mine = S.data.notes.filter((n) => (n[field] || []).some((r) => (r.id ?? r) === x.id));
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
    "tags", "related", "related_projects"].includes(k))) n.updated_at = stamp;
  if (changes.journal_id && !n.entry_date) n.entry_date = today();
  if ("journal_id" in changes && !changes.journal_id) n.entry_date = null;
}

// ---- the editor (a dialog over the page, saving as you type) ----

const ned = { n: null, dirty: new Set(), timer: 0, chain: Promise.resolve(), range: null, created: null, img: null };

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
    tags: [...S.tagFilter], attachments: [], related: [], related_projects: [], ...extra };
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
  ned.range = null;
  dlg.innerHTML = editorHtml(n);
  const body = $(".ne-body", dlg);
  body.innerHTML = showBody(n.body) || "<p><br></p>";
  fitBehindPictures();
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
    <div class="ne-tools" role="toolbar" aria-label="Formatting">
      <select class="ne-font" aria-label="Font" title="Font: of the words selected, or of the whole note">${options(NOTE_FONTS, n.font)}</select>
      <button type="button" data-cmd="bold" title="Bold (Ctrl+B)" aria-label="Bold"><b>B</b></button>
      <button type="button" data-cmd="italic" title="Italic (Ctrl+I)" aria-label="Italic"><i>I</i></button>
      <button type="button" data-cmd="underline" title="Underline (Ctrl+U)" aria-label="Underline"><u>U</u></button>
      <button type="button" data-cmd="strikeThrough" title="Strike through" aria-label="Strike through"><s>S</s></button>
      <button type="button" data-cmd="heading" title="Heading" aria-label="Heading">H</button>
      <button type="button" data-cmd="insertUnorderedList" title="Bulleted list" aria-label="Bulleted list">•</button>
      <button type="button" data-cmd="insertOrderedList" title="Numbered list" aria-label="Numbered list">1.</button>
      <button type="button" data-cmd="quote" title="Quote" aria-label="Quote">❝</button>
      <button type="button" data-cmd="link" title="Link to a web page" aria-label="Link">🔗</button>
      <button type="button" data-cmd="picture" title="Add a picture where the cursor is" aria-label="Add a picture">🖼</button>
      <button type="button" data-cmd="attach" title="Attach a file" aria-label="Attach a file">📎</button>
      <button type="button" data-cmd="removeFormat" title="Clear the formatting of the words selected" aria-label="Clear formatting">T̸</button>
      <input type="file" class="ne-pic-input" accept="image/*" multiple hidden>
      <input type="file" class="ne-file-input" multiple hidden>
    </div>
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
      <button type="button" class="link danger ne-delete">Move to trash</button>
      <button type="button" class="primary ne-done">Done</button>
    </div>
    <div class="ne-imgbar" role="toolbar" aria-label="Picture" hidden>
      <button type="button" data-size="s" title="Small">S</button><button type="button" data-size="m" title="Medium">M</button><button
        type="button" data-size="l" title="As wide as the note">L</button>
      <button type="button" data-move="-1" title="Move up" aria-label="Move up">↑</button><button type="button" data-move="1"
        title="Move down" aria-label="Move down">↓</button>
      <button type="button" class="pic-crop" title="Crop or turn it">Crop</button><button type="button" data-turn="90"
        title="Turn it a quarter to the right" aria-label="Turn right">⟳</button>
      <button type="button" class="pic-behind" title="Put it behind the text, like paper with a picture on it">Behind text</button>
      <label class="pic-fade" title="How see-through it is"><span aria-hidden="true">◐</span><input type="range" class="pic-opacity"
        min="10" max="100" step="5" aria-label="Opacity"></label>
      <button type="button" class="pic-view" title="View it full size">View</button>
      <button type="button" class="pic-remove" title="Take it out of the text (it stays with the note's files)">Remove</button>
    </div>
  </div>`;
}

function noteLinksField(n) {
  const saved = new Map([...n.related.map((r) => [`task:${r.id ?? r}`, r]), ...n.related_projects.map((r) => [`project:${r.id ?? r}`, r])]);
  const chips = refs(n, "related").map((ref) => {
    const s = saved.get(ref), r = refInfo(ref, typeof s === "object" ? s : null);
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
  const placed = new Set(placedIds($(".ne-body", dlg).innerHTML));
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
    else if (f === "body") out.body = cleanNoteHtml($(".ne-body", dlg).innerHTML);
    else if (f === "tags") out.tags = [...new Set($(".ne-tags", dlg).value.split(",").map((t) => t.trim()).filter(Boolean))];
    else if (f === "related" || f === "related_projects") out[f] = n[f].map((r) => r.id ?? r);
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
        related: n.related.map((r) => r.id ?? r), related_projects: n.related_projects.map((r) => r.id ?? r),
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

// ---- formatting ----

function editorBody() { return $("#note-dialog .ne-body"); }

// Puts the cursor back where it was in the text (a button or list took the focus).
function restoreRange() {
  const body = editorBody();
  body.focus();
  if (ned.range && body.contains(ned.range.startContainer)) {
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(ned.range);
  }
}

function blockOf(node) {
  const body = editorBody();
  while (node && node !== body && !(node.nodeType === 1 && NOTE_BLOCKS.has(node.tagName.toLowerCase()) && node.tagName !== "LI")) node = node.parentNode;
  return node && node !== body ? node : null;
}

function runCommand(cmd) {
  const dlg = $("#note-dialog");
  if (cmd === "picture") return $(".ne-pic-input", dlg).click();
  if (cmd === "attach") return $(".ne-file-input", dlg).click();
  restoreRange();
  document.execCommand("styleWithCSS", false, false);
  if (cmd === "heading" || cmd === "quote") {
    const tag = cmd === "heading" ? "H2" : "BLOCKQUOTE";
    const block = blockOf(getSelection().anchorNode);
    document.execCommand("formatBlock", false, block?.tagName === tag ? "p" : tag.toLowerCase());
  } else if (cmd === "link") {
    const sel = getSelection();
    const picked = sel.toString().trim();
    let url = prompt("Web address to link to", /^(https?:\/\/|www\.)\S+$/i.test(picked) ? picked : "https://")?.trim();
    if (!url || url === "https://") return;
    if (!/^(https?:\/\/|mailto:)/i.test(url)) url = (url.includes("@") && !url.includes("/") ? "mailto:" : "https://") + url;
    restoreRange();
    if (picked) document.execCommand("createLink", false, url);
    else document.execCommand("insertHTML", false, `<a href="${h(url)}" target="_blank" rel="noopener noreferrer">${h(url)}</a>&nbsp;`);
  } else if (cmd === "removeFormat") {
    document.execCommand("removeFormat");
    document.execCommand("unlink");
  } else {
    document.execCommand(cmd);
  }
  noteFieldChanged("body");
  markTools();
}

// The toolbar shows what's on where the cursor is.
function markTools() {
  const dlg = $("#note-dialog");
  if (!dlg?.open) return;
  for (const b of dlg.querySelectorAll(".ne-tools [data-cmd]")) {
    const cmd = b.dataset.cmd;
    let on = false;
    try {
      if (["bold", "italic", "underline", "strikeThrough", "insertUnorderedList", "insertOrderedList"].includes(cmd)) on = document.queryCommandState(cmd);
    } catch { /* (not while the selection is elsewhere) */ }
    if (cmd === "heading" || cmd === "quote") on = blockOf(getSelection().anchorNode)?.tagName === (cmd === "heading" ? "H2" : "BLOCKQUOTE");
    b.classList.toggle("on", !!on);
  }
  const anchor = getSelection().anchorNode;
  const face = anchor && editorBody().contains(anchor) && (anchor.nodeType === 1 ? anchor : anchor.parentNode).closest?.("font[face]");
  $(".ne-font", dlg).value = (face && editorBody().contains(face) ? face.getAttribute("face") : ned.n.font) || "";
  if (!FONT_NAMES.includes($(".ne-font", dlg).value)) $(".ne-font", dlg).value = "";
}

function setFont(value) {
  const body = editorBody();
  const r = ned.range;
  if (r && !r.collapsed && body.contains(r.commonAncestorContainer)) {
    // The words selected: in that font ("default" is dropped when it's saved, leaving the note's).
    restoreRange();
    document.execCommand("styleWithCSS", false, false);
    document.execCommand("fontName", false, value || "default");
    noteFieldChanged("body");
  } else {
    ned.n.font = value;
    body.className = `ne-body note-body${fontClass(ned.n)}`;
    noteFieldChanged("font");
  }
}

// ---- pictures and files ----

function caretRangeAt(x, y) {
  if (document.caretPositionFromPoint) {
    const p = document.caretPositionFromPoint(x, y);
    if (!p) return null;
    const r = document.createRange();
    r.setStart(p.offsetNode, p.offset);
    r.collapse(true);
    return r;
  }
  return document.caretRangeFromPoint?.(x, y) || null;
}

// Uploads files to the open note; pictures are placed in the text (at range, else where the
// cursor was) when place is set, and the rest listed under it.
async function addNoteFiles(files, { place = true, range = null } = {}) {
  files = [...files];
  if (!files.length) return;
  if (files.some((f) => f.size > 25 * 1048576)) return toast("Files can be up to 25 MB each.");
  const n = ned.n;
  await saveNote({ force: true });
  if (!n.id || n.id < 0) return toast("Wait until this note has been saved (when you're back online), then add files.");
  const form = new FormData();
  for (const f of files) form.append("file", f, f.name || "pasted.png");
  toast(files.length > 1 ? `Uploading ${files.length} files…` : `Uploading ${files[0].name || "the picture"}…`);
  let res;
  try {
    res = await fetch(`${BASE}/api/notes/${n.id}/attachments`, { method: "POST", body: form, headers: { "X-Requested-With": "entropicide" } });
  } catch {
    return toast("You're offline. Pictures and files need a connection.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return toast(data.error || "Couldn't upload that.");
  n.attachments = data.attachments;
  n.updated_at = data.updated_at;
  upsertNote(n);
  const pics = data.added.filter((id) => IMAGE_TYPES.includes(data.attachments.find((f) => f.id === id)?.mime));
  if (place && pics.length && ned.n === n) {
    insertPictures(pics, range);
    noteFieldChanged("body");
    saveNote();
  }
  if (ned.n === n) { renderNoteFiles(); renderNoteDates(); }
  toast(files.length > 1 ? `Added ${files.length} files.` : pics.length ? "Picture added." : "File added.");
}

function insertPictures(ids, range) {
  const body = editorBody();
  const html = ids.map((id) => `<img data-file="${id}" data-size="l" src="${picSrc(id)}" alt="">`).join("");
  const r = [range, ned.range].find((x) => x && body.contains(x.startContainer));
  if (!r) return body.insertAdjacentHTML("beforeend", `<p>${html}</p><p><br></p>`);
  body.focus();
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
  document.execCommand("insertHTML", false, html);
}

function chooseImage(img) {
  const dlg = $("#note-dialog");
  for (const x of dlg.querySelectorAll(".ne-body img.chosen")) x.classList.remove("chosen");
  ned.img = img;
  const bar = $(".ne-imgbar", dlg);
  if (!img) { bar.hidden = true; return; }
  img.classList.add("chosen");
  bar.hidden = false;
  placeImageBar();
}

function placeImageBar() {
  const dlg = $("#note-dialog"), bar = $(".ne-imgbar", dlg), img = ned.img;
  if (!img || !dlg.contains(img)) { bar.hidden = true; return; }
  const r = img.getBoundingClientRect();
  for (const b of bar.querySelectorAll("[data-size]")) b.classList.toggle("on", (img.dataset.size || "l") === b.dataset.size);
  $(".pic-behind", bar).classList.toggle("on", img.dataset.behind === "1");
  $(".pic-opacity", bar).value = img.dataset.opacity || 100;
  bar.style.left = `${Math.max(8, Math.min(r.left + 6, innerWidth - bar.offsetWidth - 8))}px`;
  bar.style.top = `${Math.max(8, Math.min(r.top + 6, innerHeight - bar.offsetHeight - 8))}px`;
}

// Moves a picture up or down past the paragraph (or picture) next to it.
function moveImage(img, dir) {
  const body = editorBody();
  let block = img;
  while (block.parentNode !== body) block = block.parentNode;
  const alone = block !== img && !block.textContent.trim() && block.querySelectorAll("img").length === 1;
  const sibling = (node) => {
    let s = dir < 0 ? node.previousSibling : node.nextSibling;
    while (s && s.nodeType === 3 && !s.nodeValue.trim()) s = dir < 0 ? s.previousSibling : s.nextSibling;
    return s;
  };
  if (alone) {
    const s = sibling(block);
    if (!s) return;
    if (dir < 0) s.before(block); else s.after(block);
  } else {
    const p = document.createElement("p");
    p.append(img);
    if (dir < 0) block.before(p); else block.after(p);
  }
  img.scrollIntoView({ block: "nearest" });
  noteFieldChanged("body");
  placeImageBar();
}

// Dragging a picture to anywhere in the text: with a mouse, just drag it; on a touch screen,
// hold it a moment first (a plain swipe still scrolls).
function bindPictureDrag(dlg) {
  let drag = null;
  const caret = document.createElement("div");
  caret.className = "pic-caret";
  caret.hidden = true;
  const stop = () => {
    clearTimeout(drag?.hold);
    drag?.ghost?.remove();
    drag?.img.classList.remove("moving");
    caret.hidden = true;
    drag = null;
  };
  const target = (x, y) => {
    const body = editorBody();
    const r = caretRangeAt(x, y);
    if (!r || !body.contains(r.startContainer) || drag.img.contains(r.startContainer)) return null;
    return r;
  };
  const begin = () => {
    drag.on = true;
    drag.img.classList.add("moving");
    drag.ghost = drag.img.cloneNode();
    drag.ghost.className = "pic-ghost";
    $(".ne", dlg).append(drag.ghost, caret);
    navigator.vibrate?.(20);
  };
  const move = (x, y) => {
    if (!drag?.on) return;
    drag.ghost.style.left = `${x - 30}px`;
    drag.ghost.style.top = `${y - 30}px`;
    drag.to = target(x, y);
    const rect = drag.to && (drag.to.getClientRects()[0] || drag.to.startContainer.getBoundingClientRect?.());
    caret.hidden = !rect;
    if (rect) Object.assign(caret.style, { left: `${rect.left}px`, top: `${rect.top}px`, height: `${Math.max(16, rect.height)}px` });
  };
  dlg.addEventListener("pointerdown", (e) => {
    const img = pictureAt(e);
    if (!img || e.button > 0) return;
    chooseImage(img);
    drag = { img, x: e.clientX, y: e.clientY, touch: e.pointerType !== "mouse", on: false };
    if (drag.touch) drag.hold = setTimeout(begin, 350);
    else e.preventDefault();  // no native drag, or selecting
  });
  dlg.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const far = Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 6;
    if (!drag.on && far) { if (drag.touch) return stop(); begin(); }
    move(e.clientX, e.clientY);
  });
  // While dragging on a touch screen, the page mustn't scroll instead.
  dlg.addEventListener("touchmove", (e) => { if (drag?.on) e.preventDefault(); }, { passive: false });
  dlg.addEventListener("contextmenu", (e) => { if (pictureAt(e)) e.preventDefault(); });
  dlg.addEventListener("dragstart", (e) => { if (e.target.closest?.(".ne-body img")) e.preventDefault(); });
  const drop = () => {
    if (drag?.on && drag.to) {
      drag.to.insertNode(drag.img);
      noteFieldChanged("body");
      const img = drag.img;
      stop();
      chooseImage(img);
      return;
    }
    stop();
  };
  dlg.addEventListener("pointerup", drop);
  dlg.addEventListener("pointercancel", (e) => { if (!drag?.on) stop(); else drop(e); });
}

// ---- editing a picture: crop, turn, opacity, behind the text ----

// Cropping and turning are drawn in the browser into a new copy of the picture, which takes its
// place in the text; the original stays with the note (out of its file list) so the crop can be
// changed or undone later. Opacity and being behind the text are only how it shows.
const EDITABLE_PICTURES = ["image/jpeg", "image/png", "image/webp"];
const pictureTurn = (img) => Number(img.dataset.rotate || 0);
const pictureCrop = (img) => {
  const [l, t, r, b] = (img.dataset.crop || "0,0,0,0").split(",").map((x) => Number(x) / 1000);
  return { l, t, r, b };
};
// The same crop on the picture turned by a quarter right (90) or left (270).
const turnCrop = (c, by) => (by === 90 ? { l: c.b, t: c.l, r: c.t, b: c.r } : { l: c.t, t: c.r, r: c.b, b: c.l });

function setPictureOpacity(img, percent) {
  if (percent >= 100) { delete img.dataset.opacity; img.style.opacity = ""; }
  else { img.dataset.opacity = percent; img.style.opacity = percent / 100; }
}

// Pictures behind the text take no room, so the text is made at least as tall as they are (in
// the editor, and wherever a note is shown, as its pictures load).
document.addEventListener("load", (e) => {
  if (e.target.dataset?.behind) fitBehindPictures(e.target.closest(".note-body"));
}, true);

function fitBehindPictures(body = editorBody()) {
  if (!body) return;
  let need = 0;
  for (const img of body.querySelectorAll("img[data-behind]")) need = Math.max(need, img.offsetTop + img.offsetHeight);
  body.style.minHeight = need ? `${need}px` : "";
}

// The picture under the pointer: one in the text, or one behind it (where there are no words
// over it; on the words, a click is for the words).
function pictureAt(e) {
  const img = e.target.closest?.(".ne-body img");
  if (img) return img;
  const body = e.target.closest?.(".ne-body");
  if (!body) return null;
  const { clientX: x, clientY: y } = e;
  const under = [...body.querySelectorAll("img[data-behind]")].reverse().find((p) => {
    const r = p.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  });
  return under && !onWords(x, y) ? under : null;
}

function onWords(x, y) {
  const r = caretRangeAt(x, y), node = r?.startContainer;
  if (!node || node.nodeType !== Node.TEXT_NODE) return false;
  for (const at of [r.startOffset - 1, r.startOffset]) {
    if (at < 0 || at >= node.length) continue;
    const letter = document.createRange();
    letter.setStart(node, at);
    letter.setEnd(node, at + 1);
    for (const b of letter.getClientRects()) {
      if (x >= b.left - 2 && x <= b.right + 2 && y >= b.top - 2 && y <= b.bottom + 2) return true;
    }
  }
  return false;
}

const noteFile = (id) => ned.n?.attachments.find((f) => f.id === Number(id));

function loadPicture(src) {
  return new Promise((done, fail) => {
    const img = new Image();
    img.onload = () => done(img);
    img.onerror = fail;
    img.src = src;
  });
}

// The original turned (by 0, 90, 180 or 270 degrees, to the right) and then cropped, as a file.
function drawPicture(original, turn, crop, mime) {
  const w = original.naturalWidth, h = original.naturalHeight, sideways = turn % 180 !== 0;
  const width = sideways ? h : w, height = sideways ? w : h;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * (1 - crop.l - crop.r)));
  canvas.height = Math.max(1, Math.round(height * (1 - crop.t - crop.b)));
  const ctx = canvas.getContext("2d");
  ctx.translate(-Math.round(width * crop.l), -Math.round(height * crop.t));
  ctx.translate(width / 2, height / 2);
  ctx.rotate((turn * Math.PI) / 180);
  ctx.drawImage(original, -w / 2, -h / 2);
  return new Promise((done) => canvas.toBlob(done, mime, 0.92));
}

// The text uses these files (as pictures, or the originals of edited ones), not counting skip.
function filesInText(skip) {
  return new Set([...editorBody().querySelectorAll("img")].filter((x) => x !== skip)
    .flatMap((x) => [x.dataset.file, x.dataset.orig]).filter(Boolean).map(Number));
}

// An edited copy that's no longer used (it was edited again, put back as it was, or taken out of
// the text) is deleted; it can always be made again from the original.
async function dropPictureCopy(id) {
  const n = ned.n;
  if (!n || filesInText().has(id) || !n.attachments.some((f) => f.id === id)) return;
  try {
    n.attachments = (await api("DELETE", `/attachments/${id}`, undefined, { quiet: true })).attachments;
  } catch { return; }
  if (ned.n === n) renderNoteFiles();
}

async function editPicture(img, turn, crop) {
  const n = ned.n, before = Number(img.dataset.file), origId = Number(img.dataset.orig || img.dataset.file);
  const original = noteFile(origId);
  if (!original || !EDITABLE_PICTURES.includes(original.mime)) return toast("Only JPEG, PNG and WebP pictures can be cropped or turned.");
  if (ned.picBusy) return;
  const whole = !turn && !crop.l && !crop.t && !crop.r && !crop.b;
  let id = origId;
  if (!whole) {
    await saveNote({ force: true });
    if (!n.id || n.id < 0) return toast("Wait until this note has been saved (when you're back online), then edit its pictures.");
    ned.picBusy = true;
    try {
      const blob = await drawPicture(await loadPicture(picSrc(origId)), turn, crop, original.mime).catch(() => null);
      if (!blob) return toast("Couldn't edit that picture (it may be too big for this device).");
      const ext = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }[blob.type] || "png";
      const form = new FormData();
      form.append("file", blob, `${original.name.replace(/\.[^.]+$/, "")} (edited).${ext}`);
      let res;
      try {
        res = await fetch(`${BASE}/api/notes/${n.id}/attachments`, { method: "POST", body: form, headers: { "X-Requested-With": "entropicide" } });
      } catch {
        return toast("You're offline. Editing a picture needs a connection.");
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return toast(data.error || "Couldn't save the edited picture.");
      n.attachments = data.attachments;
      n.updated_at = data.updated_at;
      upsertNote(n);
      id = data.added[0];
    } finally {
      ned.picBusy = false;
    }
  }
  if (ned.n !== n || !editorBody().contains(img)) return;
  img.dataset.file = id;
  if (whole) {
    for (const k of ["orig", "crop", "rotate"]) delete img.dataset[k];
  } else {
    img.dataset.orig = origId;
    if (crop.l || crop.t || crop.r || crop.b) img.dataset.crop = [crop.l, crop.t, crop.r, crop.b].map((x) => Math.round(x * 1000)).join(",");
    else delete img.dataset.crop;
    if (turn) img.dataset.rotate = turn; else delete img.dataset.rotate;
  }
  img.src = picSrc(id);
  img.addEventListener("load", () => { fitBehindPictures(); placeImageBar(); }, { once: true });
  noteFieldChanged("body");
  renderNoteFiles();
  await saveNote();
  if (before !== origId && before !== id) dropPictureCopy(before);
}

// The crop window: the whole original, turned, with a box to drag over the part to keep.
const pe = { img: null, picture: null, turn: 0, crop: null, drag: null };

async function openPictureEditor(img) {
  const original = noteFile(img.dataset.orig || img.dataset.file);
  if (!original || !EDITABLE_PICTURES.includes(original.mime)) return toast("Only JPEG, PNG and WebP pictures can be cropped or turned.");
  let picture;
  try { picture = await loadPicture(picSrc(original.id)); } catch { return toast("Couldn't load that picture."); }
  let dlg = $("#pic-dialog");
  if (!dlg) {
    dlg = document.createElement("dialog");
    dlg.id = "pic-dialog";
    dlg.setAttribute("aria-label", "Crop or turn the picture");
    dlg.innerHTML = `<div class="pe-stage"><div class="pe-frame"><canvas></canvas><div class="pe-box">${
      ["nw", "n", "ne", "e", "se", "s", "sw", "w"].map((x) => `<span class="pe-handle" data-h="${x}"></span>`).join("")}</div></div></div>
      <div class="pe-bar">
        <button type="button" data-turn="270" title="Turn left" aria-label="Turn left">⟲</button><button type="button" data-turn="90"
          title="Turn right" aria-label="Turn right">⟳</button>
        <button type="button" class="link pe-reset" title="The picture as it was added">Original</button>
        <span class="ne-space"></span>
        <button type="button" class="pe-cancel">Cancel</button><button type="button" class="primary pe-save">Save</button>
      </div>`;
    document.body.append(dlg);
    bindPictureEditor(dlg);
  }
  Object.assign(pe, { img, picture, turn: pictureTurn(img), crop: pictureCrop(img), drag: null });
  dlg.showModal();
  drawPictureEditor();
}

function drawPictureEditor() {
  const dlg = $("#pic-dialog"), canvas = $("canvas", dlg), p = pe.picture;
  const sideways = pe.turn % 180 !== 0, w = sideways ? p.naturalHeight : p.naturalWidth, h = sideways ? p.naturalWidth : p.naturalHeight;
  const scale = Math.min((Math.min(innerWidth, 900) - 72) / w, (innerHeight - 170) / h, 1);
  const cssW = Math.max(1, Math.round(w * scale)), cssH = Math.max(1, Math.round(h * scale)), dpr = devicePixelRatio || 1;
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  const ctx = canvas.getContext("2d");
  ctx.scale(scale * dpr, scale * dpr);
  ctx.translate(w / 2, h / 2);
  ctx.rotate((pe.turn * Math.PI) / 180);
  ctx.drawImage(p, -p.naturalWidth / 2, -p.naturalHeight / 2);
  placeCropBox();
}

function placeCropBox() {
  const c = pe.crop;
  Object.assign($("#pic-dialog .pe-box").style, { left: `${c.l * 100}%`, top: `${c.t * 100}%`,
    width: `${(1 - c.l - c.r) * 100}%`, height: `${(1 - c.t - c.b) * 100}%` });
}

function bindPictureEditor(dlg) {
  const stage = $(".pe-stage", dlg), least = 0.05;
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  stage.addEventListener("pointerdown", (e) => {
    const handle = e.target.dataset.h || (e.target.closest(".pe-box") ? "move" : null);
    if (!handle) return;
    e.preventDefault();
    stage.setPointerCapture(e.pointerId);
    const r = $("canvas", stage).getBoundingClientRect();
    pe.drag = { handle, x: e.clientX, y: e.clientY, crop: { ...pe.crop }, w: r.width, h: r.height };
  });
  stage.addEventListener("pointermove", (e) => {
    const d = pe.drag;
    if (!d) return;
    const dx = (e.clientX - d.x) / d.w, dy = (e.clientY - d.y) / d.h, c = { ...d.crop };
    if (d.handle === "move") {
      const mx = clamp(dx, -c.l, c.r), my = clamp(dy, -c.t, c.b);
      Object.assign(c, { l: c.l + mx, r: c.r - mx, t: c.t + my, b: c.b - my });
    } else {
      if (d.handle.includes("w")) c.l = clamp(d.crop.l + dx, 0, 1 - c.r - least);
      if (d.handle.includes("e")) c.r = clamp(d.crop.r - dx, 0, 1 - c.l - least);
      if (d.handle.includes("n")) c.t = clamp(d.crop.t + dy, 0, 1 - c.b - least);
      if (d.handle.includes("s")) c.b = clamp(d.crop.b - dy, 0, 1 - c.t - least);
    }
    pe.crop = c;
    placeCropBox();
  });
  const stop = () => { pe.drag = null; };
  stage.addEventListener("pointerup", stop);
  stage.addEventListener("pointercancel", stop);
  dlg.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (e.target === dlg || b?.classList.contains("pe-cancel")) return dlg.close();
    if (!b) return;
    if (b.dataset.turn) {
      const by = Number(b.dataset.turn);
      pe.turn = (pe.turn + by) % 360;
      pe.crop = turnCrop(pe.crop, by);
      return drawPictureEditor();
    }
    if (b.classList.contains("pe-reset")) {
      pe.turn = 0;
      pe.crop = { l: 0, t: 0, r: 0, b: 0 };
      return drawPictureEditor();
    }
    if (b.classList.contains("pe-save")) {
      dlg.close();
      // (thousandths, as it's kept, so an unchanged crop isn't made again)
      const c = Object.fromEntries(Object.entries(pe.crop).map(([k, v]) => [k, Math.round(v * 1000) / 1000]));
      const same = pe.turn === pictureTurn(pe.img) && ["l", "t", "r", "b"].every((k) => c[k] === pictureCrop(pe.img)[k]);
      if (!same) editPicture(pe.img, pe.turn, c);
    }
  });
  window.addEventListener("resize", () => { if (dlg.open) drawPictureEditor(); });
}


// ---- events ----

function bindNoteDialog(dlg) {
  dlg.addEventListener("close", () => {
    chooseImage(null);
    saveNote().then(() => {
      if (!$("#note-dialog").open) { ned.n = null; renderList(); }
    });
  });
  window.addEventListener("popstate", () => { if (dlg.open && !history.state?.note) dlg.close(); });
  dlg.addEventListener("cancel", (e) => {
    // Esc: closes the picture bar first, else the note (through history, like the ✕).
    e.preventDefault();
    if (ned.img) chooseImage(null); else closeNote();
  });
  dlg.addEventListener("click", (e) => { if (e.target === dlg) closeNote(); });  // the backdrop
  dlg.addEventListener("input", (e) => {
    const t = e.target;
    if (t.classList.contains("ne-title")) noteFieldChanged("title");
    else if (t.closest(".ne-body")) { noteFieldChanged("body"); chooseImage(null); fitBehindPictures(); }
    else if (t.classList.contains("pic-opacity") && ned.img) { setPictureOpacity(ned.img, Number(t.value)); noteFieldChanged("body"); }
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
    } else if (t.classList.contains("ne-font")) {
      setFont(t.value);
    } else if (t.classList.contains("ne-pic-input") || t.classList.contains("ne-file-input")) {
      const files = [...t.files];
      t.value = "";
      addNoteFiles(files, { place: t.classList.contains("ne-pic-input") });
    }
  });
  // Toolbar buttons mustn't take the focus (and the selection) from the text.
  dlg.addEventListener("mousedown", (e) => { if (e.target.closest(".ne-tools button, .ne-imgbar button")) e.preventDefault(); });
  dlg.addEventListener("click", async (e) => {
    const b = e.target.closest("button");
    const n = ned.n;
    if (!b) {
      if (!pictureAt(e) && !e.target.closest(".ne-imgbar")) chooseImage(null);
      // A link in the text opens with Ctrl (⌘) held, as in other editors.
      const a = e.target.closest(".ne-body a[href]");
      if (a && (e.ctrlKey || e.metaKey)) window.open(a.href, "_blank", "noopener");
      if (e.target.closest(".att-view")) {
        e.preventDefault();
        openViewer(n.attachments, Number(e.target.closest("[data-file]").dataset.file));
      }
      return;
    }
    if (b.dataset.cmd) return runCommand(b.dataset.cmd);
    if (b.classList.contains("ne-close") || b.classList.contains("ne-done")) return closeNote();
    if (b.classList.contains("ne-pin")) {
      n.pinned = !n.pinned;
      b.classList.toggle("on", n.pinned);
      b.setAttribute("aria-pressed", n.pinned);
      b.title = n.pinned ? "Unpin" : "Pin";
      return noteFieldChanged("pinned");
    }
    if (b.classList.contains("ne-delete")) {
      await saveNote();
      const id = n.id;
      ned.n = null;
      closeNote();
      if (id) trashNote(id);
      return;
    }
    if (b.dataset.size && ned.img) {
      ned.img.dataset.size = b.dataset.size;
      noteFieldChanged("body");
      fitBehindPictures();
      return requestAnimationFrame(placeImageBar);
    }
    if (b.dataset.move && ned.img) return moveImage(ned.img, Number(b.dataset.move));
    if (b.dataset.turn && ned.img) {
      const img = ned.img;
      return editPicture(img, (pictureTurn(img) + 90) % 360, turnCrop(pictureCrop(img), 90));
    }
    if (b.classList.contains("pic-crop") && ned.img) return openPictureEditor(ned.img);
    if (b.classList.contains("pic-behind") && ned.img) {
      const img = ned.img, behind = img.dataset.behind !== "1";
      if (behind) {
        img.dataset.behind = "1";
        if (!img.dataset.opacity) setPictureOpacity(img, 40);  // faded, so the words can be read over it
      } else delete img.dataset.behind;
      noteFieldChanged("body");
      fitBehindPictures();
      return requestAnimationFrame(placeImageBar);
    }
    if (b.classList.contains("pic-view") && ned.img) return openViewer(n.attachments, Number(ned.img.dataset.file));
    if (b.classList.contains("pic-remove") && ned.img) {
      const block = ned.img.parentNode, copy = ned.img.dataset.orig && Number(ned.img.dataset.file);
      ned.img.remove();
      if (copy) saveNote().then(() => dropPictureCopy(copy));  // the original stays with the files
      if (block !== editorBody() && !block.textContent.trim() && !block.querySelector("img")) block.remove();
      chooseImage(null);
      noteFieldChanged("body");
      return renderNoteFiles();
    }
    if (b.classList.contains("place-pic")) {
      insertPictures([Number(b.closest("[data-file]").dataset.file)]);
      noteFieldChanged("body");
      return renderNoteFiles();
    }
    if (b.classList.contains("del-file")) {
      const id = Number(b.closest("[data-file]").dataset.file);
      const f = n.attachments.find((x) => x.id === id);
      if (!f || !confirm(`Delete ${f.name}?`)) return;
      const owner = await api("DELETE", `/attachments/${id}`);
      n.attachments = owner.attachments;
      return renderNoteFiles();
    }
    if (b.classList.contains("ne-add-link") || b.classList.contains("ne-del-link")) {
      const ref = b.dataset.ref || b.closest("[data-ref]").dataset.ref;
      const [kind, raw] = ref.split(":"), id = Number(raw);
      const field = kind === "task" ? "related" : "related_projects";
      if (b.classList.contains("ne-add-link")) {
        n[field] = [...n[field], kind === "task" ? { id, title: taskById(id)?.title } : { id, name: projectById(id)?.name }];
      } else n[field] = n[field].filter((r) => (r.id ?? r) !== id);
      noteFieldChanged(field);
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
  // Keep where the cursor is in the text, for the toolbar and for pictures added.
  document.addEventListener("selectionchange", () => {
    if (!dlg.open) return;
    const sel = getSelection();
    if (sel.rangeCount && editorBody()?.contains(sel.anchorNode)) {
      ned.range = sel.getRangeAt(0).cloneRange();
      markTools();
    }
  });
  dlg.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); closeNote(); }
    else if (e.key === "Enter" && e.target.classList.contains("ne-title")) { e.preventDefault(); editorBody().focus(); }
    else if ((e.key === "Delete" || e.key === "Backspace") && ned.img && !e.target.closest("input, select")) {
      e.preventDefault();
      dlg.querySelector(".pic-remove").click();
    }
  });
  // Pasting: pictures are uploaded and placed; formatted text keeps what a note can hold.
  dlg.addEventListener("paste", (e) => {
    if (!e.target.closest(".ne-body")) return;
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); return addNoteFiles(files, { range: ned.range }); }
    const html = e.clipboardData?.getData("text/html");
    if (html) {
      e.preventDefault();
      document.execCommand("insertHTML", false, cleanNoteHtml(html.replace(/^[\s\S]*<!--StartFragment-->|<!--EndFragment-->[\s\S]*$/g, "")));
      noteFieldChanged("body");
    }
  });
  dlg.addEventListener("dragover", (e) => { if (e.dataTransfer?.types.includes("Files")) e.preventDefault(); });
  dlg.addEventListener("drop", (e) => {
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return;
    e.preventDefault();
    const inText = e.target.closest(".ne-body");
    addNoteFiles(files, { place: !!inText || files.every((f) => IMAGE_TYPES.includes(f.type)),
      range: inText ? caretRangeAt(e.clientX, e.clientY) : null });
  });
  dlg.addEventListener("scroll", placeImageBar, true);
  window.addEventListener("resize", () => { if (dlg.open) placeImageBar(); });
  bindPictureDrag(dlg);
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
  if (!t || !confirm(`Make “${t.title}” a note? The task goes; its notes, tags, files and links go with the note.`)) return;
  const n = await api("POST", `/tasks/${t.id}/to-note`);
  S.selected = null;
  await refresh();
  setView("notes");
  toast("It's a note now.");
  openNote(noteById(n.id) || n);
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
        await api("DELETE", `/notes/${id}`);
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
      newNote(b.dataset.kind === "task" ? { related: [{ id, title: x.title }], area_id: taskArea(x) }
        : { related_projects: [{ id, name: x.name }], area_id: x.area_id });
    }
  });
}

bindNotes();
