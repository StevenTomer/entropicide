// ---- drawings -----------------------------------------------------------------
// ✎ in the editor's toolbar draws a picture into the text: a Sketch (pen strokes, drawn with
// perfect-freehand) or a Diagram (Excalidraw: shapes, arrows, text). Either is saved as an SVG
// file of the task, project or note, placed like any picture (<img data-file>), and keeps what
// made it inside it (a sketch's strokes in a <desc>, a diagram's scene the way Excalidraw embeds
// it), so "Edit drawing" on the picture opens it again to carry on. Saving an edit uploads a new
// file and drops the old one (dropPictureCopy, in editor.js). Loads after editor.js.

const SKETCH_COLOURS = ["#1f2933", "#d64545", "#2f6fdb", "#2e9d5b", "#e8891c", "#8a4fd6"];
const SKETCH_SIZES = [["Fine", 3], ["Medium", 7], ["Thick", 14]];
const VENDOR = `${BASE}/static/vendor`;

// Which kind of drawing a file is, by its name (what saveDrawing calls it), or null.
function drawingKind(file) {
  return /\.sketch\.svg$/i.test(file?.name || "") ? "sketch" : /\.excalidraw\.svg$/i.test(file?.name || "") ? "diagram" : null;
}

// The ✎ button: which kind to draw.
function openDrawMenu(button) {
  closeDrawMenu();
  const menu = document.createElement("div");
  menu.className = "draw-menu";
  menu.innerHTML = `<button type="button" data-draw="sketch"><b>Sketch</b><span>Pen and ink, by hand</span></button>
    <button type="button" data-draw="diagram"><b>Diagram</b><span>Shapes, arrows and words</span></button>`;
  // Inside the dialog it's in, if it's in one: an open dialog is drawn above everything else
  // on the page, which would hide the menu behind it.
  (button.closest("dialog") || document.body).append(menu);
  const r = button.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(r.left, innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${Math.min(r.bottom + 4, innerHeight - menu.offsetHeight - 8)}px`;
  const host = ed;
  menu.addEventListener("click", (e) => {
    const b = e.target.closest("[data-draw]");
    if (!b) return;
    closeDrawMenu();
    ed = host;
    (b.dataset.draw === "sketch" ? openSketch : openDiagram)(null);
  });
  setTimeout(() => document.addEventListener("pointerdown", closeDrawMenuOutside, true));
}
function closeDrawMenuOutside(e) { if (!e.target.closest(".draw-menu")) closeDrawMenu(); }
function closeDrawMenu() {
  document.querySelector(".draw-menu")?.remove();
  document.removeEventListener("pointerdown", closeDrawMenuOutside, true);
}

// "Edit drawing" on a chosen picture.
function editDrawing(img) {
  const kind = drawingKind(noteFile(img.dataset.file));
  if (kind) (kind === "sketch" ? openSketch : openDiagram)(img);
}

// Saves svg (text) as a file of what the editor's for, in place of img's picture (editing one),
// else placed where the cursor was, and closes dlg (first: while it's open, the text behind it
// can't take the picture). Returns false when it couldn't (dlg stays open, the drawing kept).
async function saveDrawing(host, svg, name, img, range, dlg) {
  await host.save({ force: true });
  const n = host.item;
  if (!n.id || n.id < 0) { toast(`Wait until this ${host.kind} has been saved (when you're back online), then draw.`); return false; }
  const data = await uploadTo(host.kind, n.id, [new File([svg], name, { type: "image/svg+xml" })], { quiet: true });
  if (!data) return false;
  host.uploaded(data);
  const id = data.added[0];
  dlg.close();
  ed = host;
  if (img && host.root.contains(img)) {
    const before = Number(img.dataset.file);
    img.dataset.file = id;
    img.src = picSrc(id);
    img.addEventListener("load", () => { fitBehindPictures(); placeImageBar(); }, { once: true });
    host.changed();
    host.filesChanged();
    await host.save();
    dropPictureCopy(before);
  } else if (host.root.isConnected && !host.source) {
    insertPictures([id], range);
    host.changed();
    host.filesChanged();
    await host.save();
  }
  return true;
}

// A full-window dialog for drawing; done(save) runs when it's closed (save: Save was pressed).
function drawDialog(cls, title, inner) {
  const dlg = document.createElement("dialog");
  dlg.className = `draw-dlg ${cls}`;
  dlg.innerHTML = `<div class="draw-head"><b>${h(title)}</b><span class="draw-tools">${inner}</span>
    <span class="draw-end"><button type="button" class="draw-cancel">Cancel</button><button type="button" class="primary draw-save">Save</button></span></div>
    <div class="draw-area"></div>`;
  document.body.append(dlg);
  dlg.showModal();
  dlg.addEventListener("close", () => dlg.remove());
  return dlg;
}

// ---- sketches ----

async function openSketch(img) {
  const host = ed, range = host.range;
  const { getStroke } = await import(`${VENDOR}/perfect-freehand/perfect-freehand.mjs`);
  let strokes = [];
  if (img) {
    try {
      const doc = new DOMParser().parseFromString(await (await fetch(picSrc(img.dataset.file))).text(), "image/svg+xml");
      strokes = JSON.parse(doc.querySelector("desc#entropicide-sketch")?.textContent || "[]");
    } catch { return toast("Couldn't open that drawing."); }
  }
  const dlg = drawDialog("sketch", img ? "Edit sketch" : "Sketch", `
    ${SKETCH_COLOURS.map((c, i) => `<button type="button" class="sk-colour${i ? "" : " on"}" data-colour="${c}" style="--c:${c}" aria-label="Colour ${c}"></button>`).join("")}
    <select class="sk-size" aria-label="Pen size">${options(SKETCH_SIZES.map(([l, s]) => [String(s), l]), "7")}</select>
    <button type="button" class="sk-erase" title="Eraser: rub out whole strokes">Eraser</button>
    <button type="button" class="sk-undo" title="Undo (Ctrl+Z)" aria-label="Undo">↶</button>
    <button type="button" class="sk-redo" title="Redo (Ctrl+Y)" aria-label="Redo">↷</button>
    <button type="button" class="sk-clear" title="Start again">Clear</button>`);
  const area = $(".draw-area", dlg);
  area.innerHTML = '<svg class="sk-paper" xmlns="http://www.w3.org/2000/svg"><g class="sk-ink"></g></svg>';
  const svg = $("svg", area), ink = $(".sk-ink", svg);
  const pen = { colour: SKETCH_COLOURS[0], size: 7, erase: false };
  const done = [], undone = [];  // what undo and redo bring back: copies of strokes
  const keep = () => { done.push(JSON.stringify(strokes)); undone.length = 0; };
  const outline = (st) => {
    const pts = getStroke(st.p, { size: st.s, thinning: 0.6, smoothing: 0.5, streamline: 0.4, simulatePressure: !st.pen });
    if (!pts.length) return "";
    // A closed outline, smoothed through the midpoints (perfect-freehand's own recipe).
    const d = pts.reduce((acc, [x0, y0], i, arr) => {
      const [x1, y1] = arr[(i + 1) % arr.length];
      acc.push(x0.toFixed(1), y0.toFixed(1), ((x0 + x1) / 2).toFixed(1), ((y0 + y1) / 2).toFixed(1));
      return acc;
    }, ["M", ...pts[0].map((v) => v.toFixed(1)), "Q"]);
    return d.join(" ") + " Z";
  };
  const pathOf = (st, i) => `<path data-i="${i}" fill="${h(st.c)}" d="${outline(st)}"/>`;
  // The paper is the dialog's area, grown to take in what's already drawn.
  const fit = () => {
    const w = area.clientWidth, hgt = area.clientHeight;
    let maxX = w, maxY = hgt;
    for (const st of strokes) for (const [x, y] of st.p) { maxX = Math.max(maxX, x + 20); maxY = Math.max(maxY, y + 20); }
    svg.setAttribute("viewBox", `0 0 ${maxX} ${maxY}`);
  };
  const draw = () => { ink.innerHTML = strokes.map(pathOf).join(""); };
  fit();
  draw();
  const at = (e) => {
    const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(svg.getScreenCTM().inverse());
    return [Math.round(pt.x * 10) / 10, Math.round(pt.y * 10) / 10, e.pointerType === "pen" ? Math.round(e.pressure * 100) / 100 : 0.5];
  };
  const eraseAt = (e) => {
    const hit = document.elementsFromPoint(e.clientX, e.clientY).find((el) => el.closest?.(".sk-ink") && el.dataset.i);
    if (!hit) return;
    strokes.splice(Number(hit.dataset.i), 1);
    draw();
  };
  let current = null;
  svg.addEventListener("pointerdown", (e) => {
    if (e.button > 0) return;
    svg.setPointerCapture(e.pointerId);
    keep();
    if (pen.erase) { current = "erase"; return eraseAt(e); }
    current = { c: pen.colour, s: pen.size, p: [at(e)], ...(e.pointerType === "pen" ? { pen: 1 } : {}) };
    strokes.push(current);
    ink.insertAdjacentHTML("beforeend", pathOf(current, strokes.length - 1));
  });
  svg.addEventListener("pointermove", (e) => {
    if (!current) return;
    if (current === "erase") return eraseAt(e);
    for (const ev of e.getCoalescedEvents?.() || [e]) current.p.push(at(ev));
    ink.lastElementChild.setAttribute("d", outline(current));
  });
  const end = () => {
    if (current && current !== "erase" && done.length && done.at(-1) === JSON.stringify(strokes)) done.pop();
    current = null;
  };
  svg.addEventListener("pointerup", end);
  svg.addEventListener("pointercancel", end);
  const step = (from, to) => {
    if (!from.length) return;
    to.push(JSON.stringify(strokes));
    strokes = JSON.parse(from.pop());
    draw();
  };
  dlg.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.target.closest("select")) return;
    if (e.key.toLowerCase() === "z" && !e.shiftKey) { e.preventDefault(); step(done, undone); }
    else if (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey)) { e.preventDefault(); step(undone, done); }
  });
  dlg.addEventListener("change", (e) => { if (e.target.matches(".sk-size")) pen.size = Number(e.target.value); });
  const original = JSON.stringify(strokes);
  dlg.addEventListener("cancel", (e) => {  // Escape: don't lose a drawing to a slip of the finger
    if (JSON.stringify(strokes) !== original && !confirm("Close without saving the drawing?")) e.preventDefault();
  });
  dlg.addEventListener("click", async (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.colour) {
      pen.colour = b.dataset.colour;
      pen.erase = false;
      for (const x of dlg.querySelectorAll(".sk-colour, .sk-erase")) x.classList.toggle("on", x === b);
    } else if (b.classList.contains("sk-erase")) {
      pen.erase = !pen.erase;
      b.classList.toggle("on", pen.erase);
      for (const x of dlg.querySelectorAll(".sk-colour")) x.classList.toggle("on", !pen.erase && x.dataset.colour === pen.colour);
    } else if (b.classList.contains("sk-undo")) step(done, undone);
    else if (b.classList.contains("sk-redo")) step(undone, done);
    else if (b.classList.contains("sk-clear")) { if (strokes.length) { keep(); strokes = []; draw(); } }
    else if (b.classList.contains("draw-cancel")) {
      if (JSON.stringify(strokes) === original || confirm("Close without saving the drawing?")) dlg.close();
    } else if (b.classList.contains("draw-save")) {
      if (!strokes.length) return img ? toast("Clear it and Remove the picture instead, to take it out.") : dlg.close();
      if (JSON.stringify(strokes) === original) return dlg.close();
      b.disabled = true;
      const name = img ? noteFile(img.dataset.file).name : "Sketch.sketch.svg";
      if (!await saveDrawing(host, sketchSvg(strokes, outline), name, img, range, dlg)) b.disabled = false;
    }
  });
}

// A sketch as an SVG file: on white paper cut to what's drawn (with a margin), keeping its
// strokes (in the paper's own coordinates) so it can be edited again.
function sketchSvg(strokes, outline) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const st of strokes) for (const [x, y] of st.p) {
    x0 = Math.min(x0, x - st.s); y0 = Math.min(y0, y - st.s); x1 = Math.max(x1, x + st.s); y1 = Math.max(y1, y + st.s);
  }
  const m = 16;
  x0 = Math.floor(x0 - m); y0 = Math.floor(y0 - m);
  const w = Math.ceil(x1 + m - x0), hgt = Math.ceil(y1 + m - y0);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x0} ${y0} ${w} ${hgt}" width="${w}" height="${hgt}">` +
    `<desc id="entropicide-sketch">${h(JSON.stringify(strokes))}</desc>` +
    `<rect x="${x0}" y="${y0}" width="${w}" height="${hgt}" fill="#fff"/>` +
    strokes.map((st) => `<path fill="${h(st.c)}" d="${outline(st)}"/>`).join("") + "</svg>";
}

// ---- diagrams ----

let excalidraw = null;  // the loaded module (it's big, so only once it's wanted)

async function loadExcalidraw() {
  if (excalidraw) return excalidraw;
  window.EXCALIDRAW_ASSET_PATH = `${VENDOR}/excalidraw/`;  // (where it finds its fonts)
  if (!document.querySelector("link.excalidraw-css")) {
    document.head.insertAdjacentHTML("beforeend", `<link rel="stylesheet" class="excalidraw-css" href="${VENDOR}/excalidraw/excalidraw.css">`);
  }
  excalidraw = await import(`${VENDOR}/excalidraw/excalidraw.js`);
  return excalidraw;
}

async function openDiagram(img) {
  const host = ed, range = host.range;
  toast("Opening the diagram editor…");
  let X, initial = null;
  try {
    X = await loadExcalidraw();
    if (img) initial = await X.loadFromBlob(await (await fetch(picSrc(img.dataset.file))).blob(), null, null);
  } catch {
    return toast(img ? "Couldn't open that diagram." : "Couldn't load the diagram editor (are you offline?).");
  }
  const dlg = drawDialog("diagram", img ? "Edit diagram" : "Diagram", "");
  const area = $(".draw-area", dlg);
  const dark = document.documentElement.dataset.theme === "dark" ||
    (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
  let api = null;
  const root = X.createRoot(area);
  root.render(X.React.createElement(X.Excalidraw, {
    excalidrawAPI: (a) => { api = a; },
    initialData: initial ? { elements: initial.elements, appState: { ...initial.appState, collaborators: new Map() }, files: initial.files }
      : { appState: { viewBackgroundColor: "#ffffff", currentItemFontFamily: 1 } },
    theme: dark ? "dark" : "light",
    UIOptions: { canvasActions: { loadScene: false, saveToActiveFile: false, export: false, saveAsImage: false, toggleTheme: false } },
  }));
  dlg.addEventListener("close", () => root.unmount());
  let saved = null;  // what was there to begin with, to know whether anything changed
  const sceneKey = () => JSON.stringify((api?.getSceneElements() || []).map((el) => [el.id, el.version]));
  setTimeout(() => { saved = sceneKey(); }, 500);
  dlg.addEventListener("cancel", (e) => {
    // Escape belongs to Excalidraw (it ends what it's doing), not to the dialog.
    e.preventDefault();
  });
  dlg.addEventListener("click", async (e) => {
    const b = e.target.closest(".draw-head button");
    if (!b) return;
    if (b.classList.contains("draw-cancel")) {
      if (sceneKey() === saved || confirm("Close without saving the diagram?")) dlg.close();
    } else if (b.classList.contains("draw-save")) {
      const elements = api.getSceneElements();
      if (!elements.length) return img ? toast("Remove the picture instead, to take it out.") : dlg.close();
      if (sceneKey() === saved) return dlg.close();
      b.disabled = true;
      try {
        const out = await X.exportToSvg({
          elements, files: api.getFiles(),
          appState: { ...api.getAppState(), exportEmbedScene: true, exportBackground: true, exportWithDarkMode: false, viewBackgroundColor: "#ffffff" },
        });
        const svg = new XMLSerializer().serializeToString(out);
        if (!await saveDrawing(host, svg, img ? noteFile(img.dataset.file).name : "Diagram.excalidraw.svg", img, range, dlg)) b.disabled = false;
      } catch {
        b.disabled = false;
        toast("Couldn't save the diagram.");
      }
    }
  });
}
