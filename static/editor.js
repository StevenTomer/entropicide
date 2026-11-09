"use strict";

// ---- formatted text, and its editor ----------------------------------------------
// Tasks, projects and notes all have formatted text: bold, italic, underline, fonts,
// headings, lists, checklists, quotes, links and pictures placed anywhere in it. It's kept
// as HTML, cleaned here (cleanNoteHtml) and again on the server (richtext.py, which counts).
// The editor is the same wherever it is: in the note dialog (notes.js) and in a task's or
// project's details (app.js). Each is a "host" (see bindEditor); ed is the one in use.
// On devices set to Vim (Settings → Notes editor), the text is edited as its HTML instead.
// Loaded after app.js, whose helpers this uses, and before notes.js.

const NOTE_FONTS = [["", "Default font"], ["sans", "Sans"], ["serif", "Serif"], ["mono", "Monospace"],
  ["hand", "Handwriting"], ["round", "Rounded"], ["narrow", "Narrow"]];

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
// Sizes words can be (richtext.SIZES, and 3, the normal size).
const FONT_SIZES = [["2", "Small"], ["3", "Normal size"], ["4", "Large"], ["5", "Larger"], ["6", "Huge"]];

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
    if (tag === "ul" && node.hasAttribute("data-check")) opens.push(["ul", " data-check"]);  // a checklist
    else if (tag === "li" && node.getAttribute("data-done") === "1") opens.push(["li", ' data-done="1"']);
    else if (NOTE_BLOCKS.has(tag)) opens.push([tag, ""]);
    else if (tag === "a") {
      const href = (node.getAttribute("href") || "").trim();
      if (/^(https?:\/\/|mailto:)[^\s"'<>]+$/i.test(href)) opens.push(["a", ` href="${h(href)}" target="_blank" rel="noopener noreferrer"`]);
    } else if (tag === "font") {
      const f = node.getAttribute("face") || "", size = node.getAttribute("size");
      const face = FONT_NAMES.includes(f) ? f : fontFromFamily(f);
      const sized = FONT_SIZES.some(([v]) => v === size && v !== "3");
      if (face || sized) opens.push(["font", (face ? ` face="${face}"` : "") + (sized ? ` size="${size}"` : "")]);
    } else if (NOTE_INLINE[tag]) opens.push([NOTE_INLINE[tag], ""]);
    opens.push(...styleTags(node.getAttribute("style")));
    const inner = [...(tag === "template" ? [] : node.childNodes)].map(walk).join("");
    return opens.map(([n, a]) => `<${n}${a}>`).join("") + inner + opens.map(([n]) => `</${n}>`).reverse().join("");
  };
  const out = [...tpl.content.childNodes].map(walk).join("").replaceAll("<p></p>", "");  // (they show nothing)
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

// Formatted text's words, without the formatting (for search), worked out once per text.
const textsOf = new Map();
function textOf(html) {
  html = String(html || "");
  if (!html) return "";
  let text = textsOf.get(html);
  if (text === undefined) {
    const tpl = document.createElement("template");
    tpl.innerHTML = html.replace(/<br>|<\/(p|div|li|h[1-3]|blockquote|pre)>/g, "$&\n");
    text = tpl.content.textContent.replace(/[ \t\u00a0]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    if (textsOf.size > 2000) textsOf.clear();
    textsOf.set(html, text);
  }
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

// ---- the editor in use ----
// A host is { root (holding .ne-tools, .ne-body and .ne-imgbar), kind ("task", "project" or
// "note"), item (what it's the text of: its id and attachments), changed() (the text changed:
// save soon), save({force}) (now; a promise), uploaded(reply) (the server's reply after files
// changed), filesChanged() (redraw the files that aren't in the text), close(), and for a note
// setFont(value) }. The editor keeps range (where the cursor was), img (the chosen picture) and
// source (editing the HTML) on it.

let ed = null;

// The text being edited, cleaned: from the HTML box when that's open.
function editorText(host) {
  const box = host.source && $(".ne-source", host.root);
  // (without the line breaks and indents htmlLines added between blocks)
  if (box) return cleanNoteHtml((box.cm ? box.cm.getValue() : box.value).replace(/>\s*\n\s*</g, "><"));
  return cleanNoteHtml($(".ne-body", host.root).innerHTML);
}

// The formatting toolbar; font: with the font list (a note's).
function editorTools({ font = null } = {}) {
  return `<div class="ne-tools" role="toolbar" aria-label="Formatting">
      ${font === null ? "" : `<select class="ne-font" aria-label="Font" title="Font: of the words selected, or of the whole note">${options(NOTE_FONTS, font)}</select>`}
      <select class="ne-size" aria-label="Size" title="Size: of the words selected, or of what you type next">${options(FONT_SIZES, "3")}</select>
      <button type="button" data-cmd="bold" title="Bold (Ctrl+B)" aria-label="Bold"><b>B</b></button>
      <button type="button" data-cmd="italic" title="Italic (Ctrl+I)" aria-label="Italic"><i>I</i></button>
      <button type="button" data-cmd="underline" title="Underline (Ctrl+U)" aria-label="Underline"><u>U</u></button>
      <button type="button" data-cmd="strikeThrough" title="Strike through" aria-label="Strike through"><s>S</s></button>
      <button type="button" data-cmd="heading" title="Heading" aria-label="Heading">H</button>
      <button type="button" data-cmd="insertUnorderedList" title="Bulleted list" aria-label="Bulleted list">•</button>
      <button type="button" data-cmd="insertOrderedList" title="Numbered list" aria-label="Numbered list">1.</button>
      <button type="button" data-cmd="checklist" title="Checklist" aria-label="Checklist">☐</button>
      <button type="button" data-cmd="quote" title="Quote" aria-label="Quote">❝</button>
      <button type="button" data-cmd="link" title="Link to a web page" aria-label="Link">🔗</button>
      <button type="button" data-cmd="picture" title="Add a picture where the cursor is" aria-label="Add a picture">🖼</button>
      <button type="button" data-cmd="draw" title="Draw: a sketch or a diagram, where the cursor is" aria-label="Draw">✎</button>
      <button type="button" data-cmd="attach" title="Attach a file" aria-label="Attach a file">📎</button>
      <button type="button" data-cmd="removeFormat" title="Clear the formatting of the words selected" aria-label="Clear formatting">T̸</button>
      <button type="button" data-cmd="source" class="ne-source-cmd" title="Edit it as HTML (and back)" aria-label="Edit as HTML">&lt;/&gt;</button>
      <input type="file" class="ne-pic-input" accept="image/*" multiple hidden>
      <input type="file" class="ne-file-input" multiple hidden>
    </div>`;
}

function editorImageBar(kind) {
  return `<div class="ne-imgbar" role="toolbar" aria-label="Picture" hidden>
      <button type="button" data-size="s" title="Small">S</button><button type="button" data-size="m" title="Medium">M</button><button
        type="button" data-size="l" title="As wide as the text">L</button>
      <button type="button" data-move="-1" title="Move up" aria-label="Move up">↑</button><button type="button" data-move="1"
        title="Move down" aria-label="Move down">↓</button>
      <button type="button" class="pic-draw" title="Carry on drawing it" hidden>Edit drawing</button>
      <button type="button" class="pic-crop" title="Crop or turn it">Crop</button><button type="button" data-turn="90"
        title="Turn it a quarter to the right" aria-label="Turn right">⟳</button>
      <button type="button" class="pic-behind" title="Put it behind the text, like paper with a picture on it">Behind text</button>
      <label class="pic-fade" title="How see-through it is"><span aria-hidden="true">◐</span><input type="range" class="pic-opacity"
        min="10" max="100" step="5" aria-label="Opacity"></label>
      <button type="button" class="pic-view" title="View it full size">View</button>
      <button type="button" class="pic-remove" title="Take it out of the text (it stays with the ${kind}'s files)">Remove</button>
    </div>`;
}

// Fills a host's text box with html and wires it up (once per root). Vim devices start in the
// HTML box.
function startEditor(host, html) {
  const body = $(".ne-body", host.root);
  body.innerHTML = showBody(html) || "<p><br></p>";
  host.source = false;
  host.range = host.img = null;
  if (!host.root.editorBound) { bindEditor(host.root, () => host); host.root.editorBound = true; }
  fitBehindPictures(body);
  if (notesEditor() === "vim" && body.isContentEditable) setSource(host, true);
}

// What a click on a checklist item's box (in the text, or shown read-only) does: ticks it
// in html (where shown, a copy of it, holds item); null if e wasn't on a box.
function tickFromClick(e, html, shown) {
  const box = checkboxAt(e);
  return box && shown.contains(box) ? tickedBody(html, shown, box) : null;
}

// The events every editor shares. host(): the root's host.
function bindEditor(root, host) {
  const use = () => { ed = host(); };
  root.addEventListener("pointerdown", use, true);
  root.addEventListener("focusin", use, true);
  // Toolbar buttons mustn't take the focus (and the selection) from the text.
  root.addEventListener("mousedown", (e) => { if (e.target.closest(".ne-tools button, .ne-imgbar button")) e.preventDefault(); });
  root.addEventListener("click", (e) => {
    use();
    const b = e.target.closest("button"), body = editorBody();
    const box = checkboxAt(e);
    if (box && body?.contains(box) && body.isContentEditable) {
      if (box.dataset.done === "1") delete box.dataset.done; else box.dataset.done = "1";
      return ed.changed();
    }
    if (!b) {
      if (!pictureAt(e) && !e.target.closest(".ne-imgbar")) chooseImage(null);
      // A link in the text opens with Ctrl (⌘) held, as in other editors.
      const a = e.target.closest(".ne-body a[href]");
      if (a && (e.ctrlKey || e.metaKey)) window.open(a.href, "_blank", "noopener");
      return;
    }
    if (b.dataset.cmd && b.closest(".ne-tools")) return runCommand(b.dataset.cmd);
    const img = ed.img;
    if (b.closest(".ne-imgbar") && img) {
      if (b.dataset.size) {
        img.dataset.size = b.dataset.size;
        ed.changed();
        fitBehindPictures();
        return requestAnimationFrame(placeImageBar);
      }
      if (b.dataset.move) return moveImage(img, Number(b.dataset.move));
      if (b.dataset.turn) return editPicture(img, (pictureTurn(img) + 90) % 360, turnCrop(pictureCrop(img), 90));
      if (b.classList.contains("pic-crop")) return openPictureEditor(img);
      if (b.classList.contains("pic-draw")) return editDrawing(img);
      if (b.classList.contains("pic-behind")) {
        if (img.dataset.behind !== "1") {
          img.dataset.behind = "1";
          if (!img.dataset.opacity) setPictureOpacity(img, 40);  // faded, so the words can be read over it
        } else delete img.dataset.behind;
        ed.changed();
        fitBehindPictures();
        return requestAnimationFrame(placeImageBar);
      }
      if (b.classList.contains("pic-view")) return openViewer(ed.item.attachments, Number(img.dataset.file));
      if (b.classList.contains("pic-remove")) return removePicture(img);
    }
    if (b.classList.contains("place-pic")) {
      insertPictures([Number(b.closest("[data-file]").dataset.file)]);
      ed.changed();
      return ed.filesChanged();
    }
  });
  root.addEventListener("input", (e) => {
    const t = e.target;
    if (t.closest(".ne-body")) { use(); ed.changed(); chooseImage(null); fitBehindPictures(); }
    else if (t.classList.contains("ne-source")) { use(); ed.changed(); }
    else if (t.classList.contains("pic-opacity") && ed?.img) { setPictureOpacity(ed.img, Number(t.value)); ed.changed(); }
  });
  root.addEventListener("change", (e) => {
    const t = e.target;
    if (t.classList.contains("ne-pic-input") || t.classList.contains("ne-file-input")) {
      use();
      const files = [...t.files];
      t.value = "";
      addFiles(files, { place: t.classList.contains("ne-pic-input") });
    } else if (t.classList.contains("ne-font")) {
      use();
      setFont(t.value);
    } else if (t.classList.contains("ne-size")) {
      use();
      setSize(t.value);
    }
  });
  root.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey && checklistAt(getSelection().anchorNode)) {
      // A new item (the browser copies the one it was split from) starts unticked.
      setTimeout(() => {
        const node = getSelection().anchorNode, el = node && (node.nodeType === 1 ? node : node.parentNode);
        el?.closest?.("ul[data-check] > li")?.removeAttribute("data-done");
      });
    }
    if ((e.key === "Delete" || e.key === "Backspace") && ed?.img && root.contains(ed.img) && !e.target.closest("input, select, textarea")) {
      e.preventDefault();
      e.stopPropagation();
      removePicture(ed.img);
    }
  });
  // Pasting: pictures are uploaded and placed; formatted text keeps what the text can hold.
  root.addEventListener("paste", (e) => {
    if (!e.target.closest(".ne-body")) return;
    use();
    e.stopPropagation();  // (not as attachments too, as the details would)
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); return addFiles(files, { range: ed.range }); }
    const html = e.clipboardData?.getData("text/html");
    if (html) {
      e.preventDefault();
      document.execCommand("insertHTML", false, cleanNoteHtml(html.replace(/^[\s\S]*<!--StartFragment-->|<!--EndFragment-->[\s\S]*$/g, "")));
      ed.changed();
    }
  });
  root.addEventListener("dragover", (e) => { if (e.dataTransfer?.types.includes("Files")) e.preventDefault(); });
  root.addEventListener("drop", (e) => {
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return;
    const inText = e.target.closest(".ne-body");
    if (!inText && !root.matches("dialog")) return;  // (in a task's details, files dropped elsewhere are attachments)
    use();
    e.preventDefault();
    e.stopPropagation();
    addFiles(files, { place: !!inText || files.every((f) => IMAGE_TYPES.includes(f.type)),
      range: inText ? caretRangeAt(e.clientX, e.clientY) : null });
  });
  bindPictureDrag(root);
}

// Keep where the cursor is in the text, for the toolbar and for pictures added; the picture
// bar follows its picture.
document.addEventListener("selectionchange", () => {
  if (!ed?.root.isConnected) return;
  const sel = getSelection();
  if (sel.rangeCount && editorBody()?.contains(sel.anchorNode)) {
    ed.range = sel.getRangeAt(0).cloneRange();
    markTools();
  }
});
document.addEventListener("scroll", () => { if (ed?.img) placeImageBar(); }, true);
window.addEventListener("resize", () => { if (ed?.img) placeImageBar(); });

// Takes a picture out of the text; it stays with the files (an edited copy goes, as its
// original stays).
function removePicture(img) {
  const host = ed, block = img.parentNode, copy = img.dataset.orig && Number(img.dataset.file);
  img.remove();
  if (copy) host.save().then(() => { ed = host; dropPictureCopy(copy); });
  if (block !== editorBody() && !block.textContent.trim() && !block.querySelector("img")) block.remove();
  chooseImage(null);
  host.changed();
  host.filesChanged();
}

// ---- editing the HTML (and Vim) ----
// The text as its HTML, one block (paragraph, heading, list item) to a line, in a plain box,
// or on Vim devices in CodeMirror with its Vim keymap (static/vendor/codemirror, loaded the
// first time). Either way it's cleaned like the formatted text when it's saved.

const notesEditor = () => load("notesEditor", "plain");
let vimLoading = null;

// HTML laid out for editing: each block on its own line, list items indented.
function htmlLines(html) {
  return String(html || "")
    .replace(/(<(?:p|h[1-3]|blockquote|pre|div)\b)/g, "\n$1")
    .replace(/(<\/?(?:ul|ol)\b[^>]*>)/g, "\n$1")
    .replace(/(<li\b)/g, "\n  $1")
    .replace(/(<hr>)/g, "\n$1\n")
    .replace(/\n{2,}/g, "\n").trim();
}

async function setSource(host, on) {
  const body = $(".ne-body", host.root);
  let box = $(".ne-source", host.root);
  if (on) {
    chooseImage(null);
    if (!box) {
      box = document.createElement("textarea");
      box.className = "ne-source";
      box.spellcheck = false;
      box.setAttribute("aria-label", "The text, as HTML");
      body.after(box);
    }
    box.value = htmlLines(cleanNoteHtml(body.innerHTML));
    box.rows = Math.min(30, Math.max(6, box.value.split("\n").length + 1));
    body.hidden = true;
    box.hidden = false;
    host.source = true;
    $(".ne-source-cmd", host.root)?.classList.add("on");
    if (notesEditor() === "vim") await vimOn(box, host);
    else box.focus();
  } else if (box) {
    const html = editorText(host);
    box.cm?.toTextArea();
    box.cm = null;
    box.nextElementSibling?.classList.contains("vim-mode") && box.nextElementSibling.remove();
    box.hidden = true;
    body.hidden = false;
    body.innerHTML = showBody(html) || "<p><br></p>";
    host.source = false;
    $(".ne-source-cmd", host.root)?.classList.remove("on");
    fitBehindPictures(body);
    host.filesChanged();
  }
}

function loadVim() {
  vimLoading ||= new Promise((ok, fail) => {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = BASE + "/static/vendor/codemirror/codemirror-vim.css";
    document.head.append(css);
    const js = document.createElement("script");
    js.src = BASE + "/static/vendor/codemirror/codemirror-vim.js";
    js.onload = () => { defineHtmlMode(); defineVimCommands(); ok(); };
    js.onerror = () => { vimLoading = null; fail(); };
    document.head.append(js);
  });
  return vimLoading;
}

async function vimOn(box, host) {
  try { await loadVim(); } catch { box.focus(); return; }  // offline before it was ever loaded: the plain box stays
  if (!box.isConnected || box.cm || box.hidden) return;
  const cm = window.CodeMirror.fromTextArea(box, {
    keyMap: "vim", mode: "notehtml", lineWrapping: true, viewportMargin: Infinity, showCursorWhenSelecting: true,
  });
  box.cm = cm;
  cm.host = host;
  const mode = document.createElement("div");
  mode.className = "vim-mode muted small";
  cm.getWrapperElement().after(mode);
  cm.on("vim-mode-change", (e) => {
    mode.textContent = e.mode === "insert" ? "-- INSERT --" : e.mode === "replace" ? "-- REPLACE --"
      : e.mode === "visual" ? (e.subMode === "linewise" ? "-- VISUAL LINE --" : e.subMode === "blockwise" ? "-- VISUAL BLOCK --" : "-- VISUAL --") : "";
  });
  cm.on("change", () => { cm.save(); ed = host; host.changed(); });
  cm.on("focus", () => { ed = host; });
  cm.focus();
}

// Colours for the HTML: tags, their attributes and values, and &entities;.
function defineHtmlMode() {
  window.CodeMirror.defineMode("notehtml", () => ({
    startState: () => ({ inTag: false }),
    token(stream, state) {
      if (state.inTag) {
        if (stream.eatSpace()) return null;
        if (stream.match(/^\/?>/)) { state.inTag = false; return "tag bracket"; }
        if (stream.match(/^"[^"]*"?/)) return "string";
        if (stream.match(/^[\w-]+/)) return "attribute";
        stream.next();
        return null;
      }
      if (stream.match(/^<\/?[\w]+/)) { state.inTag = true; return "tag"; }
      if (stream.match(/^&\w+;/)) return "atom";
      stream.next();
      while (!stream.eol() && stream.peek() !== "<" && stream.peek() !== "&") stream.next();
      return null;
    },
  }));
}

// :w saves now; :q (and :wq, :x) save and close; :check ticks (or unticks) the checklist item
// on the cursor's line; :item starts a new checklist item under it.
function defineVimCommands() {
  const Vim = window.CodeMirror.Vim;
  const write = async (cm) => { cm.save(); await cm.host.save(); };
  const quit = async (cm) => { await write(cm); cm.host.close(); };
  Vim.defineEx("write", "w", (cm) => { write(cm).then(() => toast("Saved.")); });
  Vim.defineEx("quit", "q", quit);
  Vim.defineEx("wq", "wq", quit);
  Vim.defineEx("xit", "x", quit);
  Vim.defineEx("check", "check", (cm) => {
    const n = cm.getCursor().line, line = cm.getLine(n);
    const next = line.includes('<li data-done="1">') ? line.replace('<li data-done="1">', "<li>") : line.replace(/<li>/, '<li data-done="1">');
    if (next !== line) cm.replaceRange(next, { line: n, ch: 0 }, { line: n, ch: line.length });
    else toast("No checklist item on this line.");
  });
  Vim.defineEx("item", "item", (cm) => {
    const n = cm.getCursor().line, line = cm.getLine(n);
    const indent = line.match(/^\s*/)[0];
    cm.replaceRange(`\n${indent}<li></li>`, { line: n, ch: line.length });
    cm.setCursor({ line: n + 1, ch: indent.length + 4 });
    Vim.handleKey(cm, "i");
  });
}

// ---- formatting ----

function editorBody() { return ed && $(".ne-body", ed.root); }

// Puts the cursor back where it was in the text (a button or list took the focus).
function restoreRange() {
  const body = editorBody();
  body.focus();
  if (ed.range && body.contains(ed.range.startContainer)) {
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(ed.range);
  }
}

function blockOf(node) {
  const body = editorBody();
  while (node && node !== body && !(node.nodeType === 1 && NOTE_BLOCKS.has(node.tagName.toLowerCase()) && node.tagName !== "LI")) node = node.parentNode;
  return node && node !== body ? node : null;
}

function runCommand(cmd) {
  if (cmd === "picture") return $(".ne-pic-input", ed.root).click();
  if (cmd === "draw") return openDrawMenu($('.ne-tools [data-cmd="draw"]', ed.root));
  if (cmd === "attach") return $(".ne-file-input", ed.root).click();
  if (cmd === "source") return setSource(ed, !ed.source);
  restoreRange();
  document.execCommand("styleWithCSS", false, false);
  if (cmd === "checklist") {
    toggleChecklist();
  } else if (cmd === "heading" || cmd === "quote") {
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
  ed.changed();
  markTools();
}

// The toolbar shows what's on where the cursor is.
function markTools() {
  if (!ed?.root.isConnected) return;
  for (const b of ed.root.querySelectorAll(".ne-tools [data-cmd]")) {
    const cmd = b.dataset.cmd;
    let on = false;
    try {
      if (["bold", "italic", "underline", "strikeThrough", "insertUnorderedList", "insertOrderedList"].includes(cmd)) on = document.queryCommandState(cmd);
    } catch { /* (not while the selection is elsewhere) */ }
    if (cmd === "checklist") on = !!checklistAt(getSelection().anchorNode);
    if (cmd === "heading" || cmd === "quote") on = blockOf(getSelection().anchorNode)?.tagName === (cmd === "heading" ? "H2" : "BLOCKQUOTE");
    b.classList.toggle("on", !!on);
  }
  const anchor = getSelection().anchorNode;
  const size = $(".ne-size", ed.root);
  const sized = anchor && editorBody().contains(anchor) && (anchor.nodeType === 1 ? anchor : anchor.parentNode).closest?.("font[size]");
  if (size) size.value = sized && editorBody().contains(sized) && FONT_SIZES.some(([v]) => v === sized.getAttribute("size"))
    ? sized.getAttribute("size") : "3";
  const font = $(".ne-font", ed.root);
  if (!font) return;
  const face = anchor && editorBody().contains(anchor) && (anchor.nodeType === 1 ? anchor : anchor.parentNode).closest?.("font[face]");
  font.value = (face && editorBody().contains(face) ? face.getAttribute("face") : ed.item.font) || "";
  if (!FONT_NAMES.includes(font.value)) font.value = "";
}

// ---- checklists: <ul data-check>, an item ticked with data-done="1" ----

function checklistAt(node) {
  const el = node && (node.nodeType === 1 ? node : node.parentNode);
  const ul = el?.closest?.("ul");
  return ul?.hasAttribute("data-check") && editorBody().contains(ul) ? ul : null;
}

// A click on a checklist item's box (drawn just left of the item): the item.
function checkboxAt(e) {
  const li = e.target.closest?.("ul[data-check] > li");
  return li && e.clientX < li.getBoundingClientRect().left + 2 ? li : null;
}

// html with one checklist item ticked or unticked: the one that's item among those shown in shown.
function tickedBody(html, shown, item) {
  const at = [...shown.querySelectorAll("ul[data-check] > li")].indexOf(item);
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  const li = tpl.content.querySelectorAll("ul[data-check] > li")[at];
  if (!li) return html;
  if (li.getAttribute("data-done") === "1") li.removeAttribute("data-done"); else li.setAttribute("data-done", "1");
  return cleanNoteHtml(tpl.innerHTML);
}

// The checklist button: lines become a checklist; in one, it goes back to plain lines.
function toggleChecklist() {
  const anchor = getSelection().anchorNode, list = checklistAt(anchor);
  if (list) {
    document.execCommand("insertUnorderedList");  // (takes the lines out of the list)
    return;
  }
  const el = anchor && (anchor.nodeType === 1 ? anchor : anchor.parentNode);
  if (!el?.closest?.("ul")) document.execCommand("insertUnorderedList");
  const ul = getSelection().anchorNode && (getSelection().anchorNode.nodeType === 1
    ? getSelection().anchorNode : getSelection().anchorNode.parentNode).closest?.("ul");
  if (ul && editorBody().contains(ul)) ul.setAttribute("data-check", "");
}

// The words selected in a size, or what's typed next if none are (the browser's editor carries
// it on as you type). Normal (3) is dropped when it's saved, leaving the text's own size.
function setSize(value) {
  restoreRange();
  document.execCommand("styleWithCSS", false, false);
  document.execCommand("fontSize", false, value);
  ed.changed();
  markTools();
}

function setFont(value) {
  const body = editorBody();
  const r = ed.range;
  if (r && !r.collapsed && body.contains(r.commonAncestorContainer)) {
    // The words selected: in that font ("default" is dropped when it's saved, leaving the note's).
    restoreRange();
    document.execCommand("styleWithCSS", false, false);
    document.execCommand("fontName", false, value || "default");
    ed.changed();
  } else {
    ed.setFont?.(value);  // (a note's own font)
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

// Uploads files to what the editor's for; pictures are placed in the text (at range, else where
// the cursor was) when place is set, and the rest listed with its files.
async function addFiles(files, { place = true, range = null } = {}) {
  files = [...files];
  if (!files.length) return;
  const host = ed;
  await host.save({ force: true });
  const data = await uploadTo(host.kind, host.item.id, files);
  if (!data) return;
  host.uploaded(data);
  const pics = data.added.filter((id) => IMAGE_TYPES.includes(data.attachments.find((f) => f.id === id)?.mime));
  if (place && pics.length && host.root.isConnected && !host.source) {
    ed = host;
    insertPictures(pics, range);
    host.changed();
    host.save();
  }
  if (host.root.isConnected) host.filesChanged();
}

function insertPictures(ids, range) {
  const body = editorBody();
  const html = ids.map((id) => `<img data-file="${id}" data-size="l" src="${picSrc(id)}" alt="">`).join("");
  const r = [range, ed.range].find((x) => x && body.contains(x.startContainer));
  if (!r) return body.insertAdjacentHTML("beforeend", `<p>${html}</p><p><br></p>`);
  body.focus();
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
  document.execCommand("insertHTML", false, html);
}

function chooseImage(img) {
  if (!ed) return;
  for (const x of ed.root.querySelectorAll(".ne-body img.chosen")) x.classList.remove("chosen");
  ed.img = img;
  const bar = $(".ne-imgbar", ed.root);
  if (!img) { bar.hidden = true; return; }
  img.classList.add("chosen");
  bar.hidden = false;
  placeImageBar();
}

function placeImageBar() {
  const bar = ed && $(".ne-imgbar", ed.root), img = ed?.img;
  if (!bar) return;
  if (!img || !ed.root.contains(img)) { bar.hidden = true; return; }
  const r = img.getBoundingClientRect();
  for (const b of bar.querySelectorAll("[data-size]")) b.classList.toggle("on", (img.dataset.size || "l") === b.dataset.size);
  $(".pic-behind", bar).classList.toggle("on", img.dataset.behind === "1");
  // A drawing is drawn on again rather than cropped or turned (it isn't a photo).
  const drawing = !!drawingKind(noteFile(img.dataset.file));
  $(".pic-draw", bar).hidden = !drawing;
  for (const x of bar.querySelectorAll(".pic-crop, [data-turn]")) x.hidden = drawing;
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
  ed.changed();
  placeImageBar();
}

// Dragging a picture to anywhere in the text: with a mouse, just drag it; on a touch screen,
// hold it a moment first (a plain swipe still scrolls).
function bindPictureDrag(root) {
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
    root.append(drag.ghost, caret);
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
  root.addEventListener("pointerdown", (e) => {
    const img = pictureAt(e);
    if (!img || e.button > 0) return;
    chooseImage(img);
    drag = { img, x: e.clientX, y: e.clientY, touch: e.pointerType !== "mouse", on: false };
    if (drag.touch) drag.hold = setTimeout(begin, 350);
    else e.preventDefault();  // no native drag, or selecting
  });
  root.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const far = Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 6;
    if (!drag.on && far) { if (drag.touch) return stop(); begin(); }
    move(e.clientX, e.clientY);
  });
  // While dragging on a touch screen, the page mustn't scroll instead.
  root.addEventListener("touchmove", (e) => { if (drag?.on) e.preventDefault(); }, { passive: false });
  root.addEventListener("contextmenu", (e) => { if (pictureAt(e)) e.preventDefault(); });
  root.addEventListener("dragstart", (e) => { if (e.target.closest?.(".ne-body img")) e.preventDefault(); });
  const drop = () => {
    if (drag?.on && drag.to) {
      drag.to.insertNode(drag.img);
      ed.changed();
      const img = drag.img;
      stop();
      chooseImage(img);
      return;
    }
    stop();
  };
  root.addEventListener("pointerup", drop);
  root.addEventListener("pointercancel", (e) => { if (!drag?.on) stop(); else drop(e); });
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

const noteFile = (id) => ed?.item?.attachments.find((f) => f.id === Number(id));

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
  const host = ed, n = host?.item;
  if (!n || filesInText().has(id) || !n.attachments.some((f) => f.id === id)) return;
  const owner = await deleteAttachment(n, id, { ask: false, quiet: true });
  if (!owner) return;
  host.uploaded(owner);
  if (host.root.isConnected) host.filesChanged();
}

async function editPicture(img, turn, crop) {
  const host = ed, n = host.item, before = Number(img.dataset.file), origId = Number(img.dataset.orig || img.dataset.file);
  const original = noteFile(origId);
  if (!original || !EDITABLE_PICTURES.includes(original.mime)) return toast("Only JPEG, PNG and WebP pictures can be cropped or turned.");
  if (host.picBusy) return;
  const whole = !turn && !crop.l && !crop.t && !crop.r && !crop.b;
  let id = origId;
  if (!whole) {
    await host.save({ force: true });
    if (!n.id || n.id < 0) return toast(`Wait until this ${host.kind} has been saved (when you're back online), then edit its pictures.`);
    host.picBusy = true;
    try {
      const blob = await drawPicture(await loadPicture(picSrc(origId)), turn, crop, original.mime).catch(() => null);
      if (!blob) return toast("Couldn't edit that picture (it may be too big for this device).");
      const ext = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }[blob.type] || "png";
      const file = new File([blob], `${original.name.replace(/\.[^.]+$/, "")} (edited).${ext}`, { type: blob.type });
      const data = await uploadTo(host.kind, n.id, [file], { quiet: true });
      if (!data) return;
      host.uploaded(data);
      id = data.added[0];
    } finally {
      host.picBusy = false;
    }
  }
  if (!host.root.contains(img)) return;
  ed = host;
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
  host.changed();
  host.filesChanged();
  await host.save();
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
  Object.assign(pe, { img, host: ed, picture, turn: pictureTurn(img), crop: pictureCrop(img), drag: null });
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
      if (!same) { ed = pe.host; editPicture(pe.img, pe.turn, c); }
    }
  });
  window.addEventListener("resize", () => { if (dlg.open) drawPictureEditor(); });
}

