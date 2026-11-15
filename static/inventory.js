"use strict";

// ---- inventory -------------------------------------------------------------------
// The Inventory page: an inventory's things, by place (or category, or A–Z), with − / + on
// each. What a thing *is* (its name, barcodes, picture, link) is a product, in a catalog of
// one's own (S.data.products); an item is a product in one inventory: how many, where, the
// minimum, who has it. Two wizards, each a dialog of its own:
// - Add to inventory / Use (openCountWizard): scan (or type), change the count, done. That's
//   all it asks, but for a place the first time a product comes into an inventory.
// - Add a product (openProductWizard): once for each product. Its barcode is looked up online
//   (the name, brand, picture and Walmart page filled in), then its category, unit, and used
//   up or kept. A barcode Add to inventory doesn't know comes here, and goes back after.
// Each wizard keeps what's typed in a draft (localStorage) as it's typed, so nothing redrawing
// the page (or the app reloading) can blank it.
// Things used up (soup, batteries) are counted down and up; below their minimum the server
// adds a "Buy …" task to the inventory's shopping project. Things kept (shears, a ladder) have
// a place, and can be lent. Scanning uses the camera, with the browser's own barcode reader or
// (where there's none) vendor/barcode; a USB or Bluetooth scanner just types into the box. QR
// labels for places open that place (#location:<id>). Loads after app.js and uses its globals.

const IV = {
  inv: Number(load("inventory", "")) || null,
  filter: load("inventoryFilter", ""),           // "" all | low | kept | lent
  layout: load("inventoryLayout", "places"),     // places | categories | names
  place: null,                                   // a place to show alone (from a label)
  resumed: false,                                // an unfinished wizard reopened (once a load)
};
const VENDOR_URL = `${BASE}/static/vendor`;

const inventoryById = (id) => (S.data.inventories || []).find((i) => i.id === id);
const itemById = (id) => (S.data.items || []).find((i) => i.id === id);
const productById = (id) => (S.data.products || []).find((p) => p.id === id);
const locationById = (id) => (S.data.locations || []).find((l) => l.id === id);
const currentInventory = () => inventoryById(IV.inv) || (S.data.inventories || [])[0] || null;
const invItems = (inv) => (S.data.items || []).filter((i) => i.inventory_id === inv.id);
const itemHere = (inv, productId) => invItems(inv).find((i) => i.product_id === productId);
const isLow = (it) => it.used_up && it.keep_at_least != null && it.quantity < it.keep_at_least;
const fmtQty = (n) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));
const shownUnit = (unit) => (unit && unit !== "each" ? unit : "");  // ("3", not "3 each")
const qtyText = (it) => `${fmtQty(it.quantity)}${shownUnit(it.unit) ? ` ${it.unit}` : ""}`;
const looksLikeCode = (text) => /^\d{6,14}$/.test(text);
const fullName = (p) => (p.brand ? `${p.brand} ${p.name}` : p.name);

// A thing's picture: its product's, else (from before products) a photo on the item.
function pictureOf(it) {
  const p = it.product_id && productById(it.product_id);
  if (p?.image) return p.image;
  const pic = (it.attachments || []).find((f) => IMAGE_TYPES.includes(f.mime));
  return pic ? fileUrl(pic) : "";
}

// A place and those it's in: "Basement › Shelf 2 › Blue bin".
function placePath(id) {
  const out = [];
  for (let l = locationById(id); l && !out.includes(l); l = locationById(l.parent_id)) out.push(l);
  return out.reverse().map((l) => l.name).join(" › ");
}

// An inventory's places as a tree, flattened in order: [[id, name drawn as a branch, depth]].
// (Spaces that don't collapse, so a list of choices shows the tree too.)
function placeOptions(inv) {
  const out = [], places = (S.data.locations || []).filter((l) => l.inventory_id === inv.id);
  const walk = (parent, depth) => {
    for (const l of places.filter((x) => (x.parent_id ?? null) === parent).sort((a, b) => a.name.localeCompare(b.name))) {
      out.push([l.id, `${"    ".repeat(depth)}${depth ? "└ " : ""}${l.name}`, depth]);
      walk(l.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

// Categories to choose from: those already used, and (food storage) some to start with.
const STOCK_CATEGORIES = ["Baking", "Breakfast", "Canned goods", "Cleaning", "Condiments", "Dairy", "Drinks", "Frozen",
  "Fruit", "Grains and pasta", "Meat", "Medicine", "Paper products", "Personal care", "Pet supplies", "Snacks",
  "Spices", "Vegetables"];
function categoryList(inv) {
  const own = (S.data.products || []).map((p) => p.category).filter(Boolean);
  return [...new Set([...own, ...(inv?.kind === "home" ? [] : STOCK_CATEGORIES)])].sort((a, b) => a.localeCompare(b));
}

// Units to choose from: the usual ones, and any others already used.
const UNITS = ["each", "cans", "boxes", "bags", "bottles", "jars", "packs", "rolls", "cases", "lb", "oz", "gal"];
const unitList = () => [...new Set([...UNITS, ...(S.data.products || []).map((p) => p.unit).filter(Boolean)])];

// Chips to pick one of (and a box for anything else): data-pick names what they set.
function pickChips(field, choices, value, other = "Other…") {
  const known = choices.includes(value);
  return `<div class="iv-chips" data-pick="${field}">${choices.map((c) =>
    `<button type="button" class="cat-chip${c === value ? " on" : ""}" data-value="${h(c)}">${h(c)}</button>`).join("")}
    <input class="iv-chip-other" data-w="${field}" value="${known ? "" : h(value || "")}" placeholder="${h(other)}" aria-label="${h(other)}"></div>`;
}

// A wizard's draft, kept as it's typed (so a reload doesn't lose it).
const loadDraft = (name) => { try { return JSON.parse(load(name, "null")); } catch { return null; } };
const saveDraft = (name, value) => save(name, value ? JSON.stringify(value) : "null");

function renderInventory(el) {
  const inv = currentInventory();
  const all = S.data.inventories || [];
  if (!inv) {
    el.innerHTML = `<p class="empty">An inventory keeps track of what you have and where it is.<br><br>
      <b>Food storage</b> (a pantry, a store room): things used up and bought again. Count them in and out by
      scanning their barcodes, and when one runs low, “Buy …” goes on a shopping list.<br>
      <b>Home</b>: things you keep, and where they are (and who you lent them to).<br><br>
      <button type="button" class="primary iv-start" data-kind="stock">Start food storage</button>
      <button type="button" class="iv-start" data-kind="home">Start a home inventory</button></p>`;
    return;
  }
  IV.inv = inv.id;
  const items = invItems(inv);
  const mine = inv.user_id == null || inv.user_id === S.data.user.id;
  const low = items.filter(isLow).length, lent = items.filter((i) => i.lent_to).length;
  const shown = shownItems(inv, items);
  let html = `<div class="notes-bar">
    <div class="cat-chips" role="group" aria-label="Inventory">
      ${all.map((x) => `<button type="button" class="cat-chip${x.id === inv.id ? " on" : ""}" data-inventory="${x.id}">${x.kind === "home" ? "🏠" : "🥫"} ${h(x.name)}</button>`).join("")}
      <button type="button" class="link iv-new">+ New inventory</button>
    </div>
    <div class="notes-opts">
      ${inventoryShareField(inv)}
      <button type="button" class="link iv-places">Places…</button>
      <button type="button" class="link iv-labels" title="QR labels for the places: scanning one shows what's there">Labels</button>
      <button type="button" class="link iv-rename">Rename</button>
      ${mine ? '<button type="button" class="link danger iv-delete">Delete</button>' : ""}
    </div>
  </div>
  <div class="iv-actions">
    <button type="button" class="primary iv-add" title="Scan (or type) what's come in">＋ Add to inventory</button>
    <button type="button" class="iv-use" title="Scan (or type) what's been used">− Use</button>
    <button type="button" class="link iv-products">Products (${(S.data.products || []).length})</button>
  </div>
  <div class="iv-filters">
    ${[["", `All · ${items.length}`], ["low", `Low · ${low}`], ["kept", "Kept"], ["lent", `Lent · ${lent}`]]
      .map(([f, label]) => `<button type="button" class="cat-chip${IV.filter === f ? " on" : ""}" data-filter="${f}">${label}</button>`).join("")}
    <select class="iv-layout" aria-label="Order">${options([["places", "By place"], ["categories", "By category"], ["names", "A–Z"]], IV.layout)}</select>
    ${IV.place ? `<button type="button" class="link iv-all-places">All places (now: ${h(placePath(IV.place))}) ✕</button>` : ""}
  </div>`;
  if (!shown.length) {
    html += `<p class="empty">${items.length ? "Nothing here matches." : "Nothing in it yet. Press <b>＋ Add to inventory</b>, then scan a barcode (or type a name)."}</p>`;
  } else if (IV.layout === "places" || IV.layout === "categories") {
    const byPlace = IV.layout === "places", groups = new Map();
    for (const it of shown) {
      const key = byPlace ? (it.location_id && locationById(it.location_id) ? placePath(it.location_id) : "") : it.category;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(it);
    }
    for (const key of [...groups.keys()].sort((a, b) => (a === "") - (b === "") || a.localeCompare(b))) {
      html += `<h2 class="group">${h(key || (byPlace ? "No place" : "No category"))}</h2>` +
        groups.get(key).map((it) => itemRow(it, !byPlace)).join("");
    }
  } else {
    html += shown.map((it) => itemRow(it, true)).join("");
  }
  el.innerHTML = html;
  if (!IV.resumed) {
    IV.resumed = true;
    if (loadDraft("productDraft")) openProductWizard();
    else if (loadDraft("countDraft")) openCountWizard();
  }
}

// What the page shows: the filter, a place (and what's in it), and the search box.
function shownItems(inv, items) {
  const q = S.search.trim().toLowerCase();
  const inPlace = IV.place && new Set([IV.place, ...(S.data.locations || []).filter((l) => placePath(l.id).startsWith(placePath(IV.place) + " ›")).map((l) => l.id)]);
  return items.filter((it) =>
    (!IV.filter || (IV.filter === "low" ? isLow(it) : IV.filter === "kept" ? !it.used_up : !!it.lent_to)) &&
    (!inPlace || inPlace.has(it.location_id)) &&
    (!q || [it.name, it.brand, it.category, it.store, ...it.codes, ...it.tags, placePath(it.location_id), it.lent_to || ""]
      .some((t) => (t || "").toLowerCase().includes(q))));
}

function itemRow(it, withPlace) {
  const pic = pictureOf(it);
  const meta = [
    it.brand ? `<span class="iv-brand">${h(it.brand)}</span>` : "",
    withPlace && it.location_id ? `<span>${h(placePath(it.location_id))}</span>` : "",
    !withPlace && it.category && IV.layout !== "categories" ? `<span>${h(it.category)}</span>` : "",
    it.lent_to ? `<span class="iv-lent">Lent to ${h(it.lent_to)}${it.lent_on ? `, ${h(fmtDate(it.lent_on))}` : ""}</span>` : "",
    isLow(it) ? `<span class="iv-low">Low: keep ${fmtQty(it.keep_at_least)}</span>` : "",
    it.group_id ? sharedMeta(it, "item") : "",
    ...it.tags.map((t) => `<span class="tag">${h(t)}</span>`),
  ].filter(Boolean).join("");
  const count = it.used_up
    ? `<span class="iv-count-ctl"><button type="button" class="iv-minus" aria-label="One less">−</button>
        <span class="iv-qty${it.quantity === 0 ? " out" : ""}">${h(qtyText(it))}</span>
        <button type="button" class="iv-plus" aria-label="One more">+</button></span>`
    : it.quantity !== 1 ? `<span class="iv-qty">× ${fmtQty(it.quantity)}</span>` : "";
  return `<div class="iv-row${isLow(it) ? " low" : ""}" data-item="${it.id}">
    ${pic ? `<img class="iv-thumb" src="${h(pic)}" alt="" loading="lazy">` : '<span class="iv-thumb"></span>'}
    <div class="row-body"><button type="button" class="link iv-open">${h(it.name)}</button>${meta ? `<div class="meta">${meta}</div>` : ""}</div>
    ${count}
  </div>`;
}

function inventoryShareField(inv) {
  if (!myGroups().length && !inv.group_id) return "";
  if (inv.user_id != null && inv.user_id !== S.data.user.id) {
    return `<span class="muted small">👥 ${h(groupById(inv.group_id)?.name || "Shared")} · ${h(personName(inv.user_id))}'s</span>`;
  }
  return `<select class="iv-share" aria-label="Shared with" title="Who else sees it, and counts in it">${options(
    [["", "Only me"], ...myGroups().filter((g) => g.role !== "viewer" || g.id === inv.group_id).map((g) => [g.id, `👥 ${g.name}`])], inv.group_id ?? "")}</select>`;
}

function replaceItem(it) {
  const i = S.data.items.findIndex((x) => x.id === it.id);
  if (it.deleted_at) { if (i >= 0) S.data.items.splice(i, 1); }
  else if (i >= 0) S.data.items[i] = it;
  else S.data.items.push(it);
}

function replaceProduct(p) {
  S.data.products = S.data.products || [];
  const i = S.data.products.findIndex((x) => x.id === p.id);
  if (i >= 0) S.data.products[i] = p; else S.data.products.push(p);
  S.data.products.sort((a, b) => a.name.localeCompare(b.name));
}

// Counts some of an item (found by item_id or product_id) in or out of an inventory. Returns
// the server's answer, after updating what's on screen; says what happened unless quiet.
async function countIn(found, delta, extra = {}, { quiet = false, inv = currentInventory() } = {}) {
  const r = await api("POST", "/items/count", { inventory_id: inv.id, delta, ...found, ...extra });
  if (!r || r.unknown !== undefined || r.kept) return r;
  const wasLow = isLow(itemById(r.item.id) || r.item);
  replaceItem(r.item);
  if (wasLow !== isLow(r.item) || r.made) await refresh(); else renderList();  // (a "Buy …" task came or went)
  if (!quiet) toast(countSaid(r), r.made ? null : () => countIn({ item_id: r.item.id }, r.before - r.after));
  return r;
}
const countSaid = (r) => (r.made ? `${r.item.name}: ${qtyText(r.item)}, new here` : `${r.item.name}: ${fmtQty(r.before)} → ${qtyText(r.item)}`);

// The products a barcode, or some typed words, could mean. A code: the one with it (one in
// this inventory first). Words: names (and brands) with them in, those in this inventory first.
function productsFor(inv, text) {
  const all = S.data.products || [], here = (p) => (itemHere(inv, p.id) ? 0 : 1);
  if (all.some((p) => p.codes.includes(text))) return all.filter((p) => p.codes.includes(text)).sort((a, b) => here(a) - here(b)).slice(0, 1);
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return all.filter((p) => words.every((w) => fullName(p).toLowerCase().includes(w)))
    .sort((a, b) => here(a) - here(b) || a.name.localeCompare(b.name)).slice(0, 12);
}

// ---- the scanner ----
// The camera, reading barcodes continuously (so can after can can be scanned), with the
// browser's own reader, else the vendored one (its engine loaded from here, never a CDN).

const BARCODE_FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39", "itf", "qr_code"];
let barcodeReader = null;

async function makeBarcodeReader() {
  if (barcodeReader) return barcodeReader;
  if ("BarcodeDetector" in window) {
    try {
      const have = await window.BarcodeDetector.getSupportedFormats();
      const formats = BARCODE_FORMATS.filter((f) => have.includes(f));
      if (formats.length) return (barcodeReader = new window.BarcodeDetector({ formats }));
    } catch { /* (then the vendored one) */ }
  }
  const lib = await import(`${VENDOR_URL}/barcode/barcode.js`);
  lib.prepareZXingModule({ overrides: { locateFile: (path) => `${VENDOR_URL}/barcode/${path}` }, fireImmediately: true });
  return (barcodeReader = new lib.BarcodeDetector({ formats: BARCODE_FORMATS }));
}

// Opens the camera; each barcode read goes to onCode (the same one again only after a pause).
// onCode returning "stop" closes it.
async function openScanner(onCode, title = "Scan") {
  const dlg = document.createElement("dialog");
  dlg.className = "iv-scanner";
  dlg.innerHTML = `<div class="draw-head"><b>${h(title)}</b><span class="iv-scan-said muted">Point the camera at a barcode.</span>
    <span class="draw-end"><button type="button" class="primary iv-scan-done">Done</button></span></div>
    <video playsinline muted></video>`;
  document.body.append(dlg);
  dlg.showModal();
  let stream = null, stopped = false, last = "", lastAt = 0;
  const close = () => {
    stopped = true;
    stream?.getTracks().forEach((t) => t.stop());
    if (dlg.open) dlg.close();
    dlg.remove();
  };
  dlg.addEventListener("close", close);
  $(".iv-scan-done", dlg).addEventListener("click", close);
  try {
    const reader = await makeBarcodeReader();
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
    const video = $("video", dlg);
    video.srcObject = stream;
    await video.play();
    const tick = async () => {
      if (stopped) return;
      try {
        const found = await reader.detect(video);
        const code = found[0]?.rawValue;
        if (code && (code !== last || Date.now() - lastAt > 2500)) {
          last = code; lastAt = Date.now();
          navigator.vibrate?.(60);
          const said = await onCode(code);
          if (said === "stop") return close();
          if (typeof said === "string") $(".iv-scan-said", dlg).textContent = said;
        }
      } catch { /* (a frame it couldn't read) */ }
      setTimeout(tick, 200);
    };
    tick();
  } catch (err) {
    $(".iv-scan-said", dlg).textContent = err?.name === "NotAllowedError"
      ? "The camera isn't allowed: allow it for this site, then try again." : "Couldn't open the camera, or read barcodes, here.";
  }
}

// Scans one barcode: resolves to it, or null if the camera was closed first.
function scanOne(title) {
  return new Promise((done) => {
    let got = null;
    openScanner(async (code) => { got = code; return "stop"; }, title);
    const watch = setInterval(() => { if (!$("dialog.iv-scanner")) { clearInterval(watch); done(got); } }, 150);
  });
}

// ---- a wizard's dialog ----
// One dialog for each wizard, drawn from its state by draw(); typing into a [data-w] box sets
// that in the state (and its draft) without redrawing, so nothing typed is ever lost.

function wizardDialog(id, title) {
  let dlg = document.getElementById(id);
  if (!dlg) {
    dlg = document.createElement("dialog");
    dlg.id = id;
    dlg.className = "iv-wizard";
    document.body.append(dlg);
  }
  dlg.dataset.title = title;
  return dlg;
}

// ---- Add to inventory / Use ----

const CW = { state: null };  // { mode: add|use, inv, step: scan|count|kept, product, n, location, camera, said, undo }

function openCountWizard(mode) {
  const draft = loadDraft("countDraft");
  const inv = currentInventory();
  if (!inv) return;
  CW.state = mode ? { mode, inv: inv.id, step: "scan", n: 1, location: Number(load(`inventoryPlace${inv.id}`, "")) || null }
    : { ...draft, product: draft?.product ?? null };
  if (!CW.state.mode) return;
  delete CW.state.closing;
  saveDraft("countDraft", CW.state);
  const dlg = wizardDialog("count-wizard", "");
  dlg.onclick = countWizardClicked;
  dlg.oninput = countWizardTyped;
  dlg.onsubmit = countWizardSubmitted;
  dlg.onclose = () => { if (CW.state?.closing !== false) { CW.state = null; saveDraft("countDraft", null); } };
  drawCountWizard();
  if (!dlg.open) dlg.showModal();
  $(".cw-code", dlg)?.focus();
}

function drawCountWizard() {
  const s = CW.state, dlg = $("#count-wizard"), inv = inventoryById(s.inv) || currentInventory();
  if (!dlg || !inv) return;
  const adding = s.mode === "add";
  const head = `<form method="dialog" class="dlg-head"><h2>${adding ? "＋ Add to" : "− Use from"} ${h(inv.name)}</h2>
      <span class="iv-mode" role="group" aria-label="Add or use">
        <button type="button" class="${adding ? "on" : ""}" data-mode="add">＋ Add</button>
        <button type="button" class="${adding ? "" : "on"}" data-mode="use">− Use</button></span>
      <button class="icon" aria-label="Close">✕</button></form>`;
  const said = s.said ? `<p class="cw-said">${h(s.said)}${s.undo ? ' <button type="button" class="link cw-undo">Undo</button>' : ""}</p>` : "";
  if (s.step === "scan") {
    const typed = s.typed || "";
    const matches = typed && !looksLikeCode(typed) ? productsFor(inv, typed) : [];
    dlg.innerHTML = `${head}${said}
      <form class="cw-find" autocomplete="off">
        <input class="cw-code" data-w="typed" value="${h(typed)}" placeholder="Scan or type a barcode, or a name" aria-label="Barcode or name" enterkeyhint="go">
        <button type="button" class="primary cw-scan">📷 Scan</button>
      </form>
      <div class="cw-matches">${matchesHtml(inv, typed, matches)}</div>
      <p class="muted small">A barcode scanner (USB or Bluetooth) types into the box: just scan.</p>`;
    return;
  }
  const p = productById(s.product), it = p && itemHere(inv, p.id);
  if (!p) { s.step = "scan"; return drawCountWizard(); }
  const pic = p.image ? `<img class="cw-pic" src="${h(p.image)}" alt="">` : '<span class="cw-pic"></span>';
  const now = it ? `Now: <b>${h(qtyText(it))}</b>${it.location_id ? ` · ${h(placePath(it.location_id))}` : ""}`
    : `Not in ${h(inv.name)} yet.`;
  if (s.step === "kept") {
    dlg.innerHTML = `${head}<div class="cw-product">${pic}<div><b>${h(fullName(p))}</b><p class="muted">${now}</p></div></div>
      <p>It's kept, not used up, so there's nothing to take. To lend it or move it, open it.</p>
      <p class="cw-buttons"><button type="button" class="cw-open">Open it</button> <button type="button" class="primary cw-next">Scan another</button></p>`;
    return;
  }
  const unit = shownUnit(p.unit);
  dlg.innerHTML = `${head}
    <div class="cw-product">${pic}<div><b>${h(fullName(p))}</b>${p.size ? ` <span class="muted">${h(p.size)}</span>` : ""}<p class="muted">${now}</p></div></div>
    <form class="cw-count" autocomplete="off">
      <div class="cw-stepper">
        <button type="button" class="cw-less" aria-label="One less">−</button>
        <input type="number" class="cw-n" data-w="n" value="${fmtQty(s.n)}" min="0" step="any" inputmode="decimal" aria-label="How many">
        <button type="button" class="cw-more" aria-label="One more">+</button>
      </div>
      <p class="cw-unit muted">${h(unit)} ${adding ? "to add" : "used"}</p>
      ${it ? "" : `<label>Where it goes <select class="cw-place" data-w="location">${options([["", "No place"], ...placeOptions(inv)], s.location ?? "")}</select></label>`}
      <p class="cw-buttons"><button type="button" class="link cw-back">← Something else</button>
        <button class="primary cw-done">${adding ? `Add ${fmtQty(s.n)}` : `Use ${fmtQty(s.n)}`}</button></p>
    </form>`;
  $(".cw-n", dlg)?.select();
}

function matchesHtml(inv, typed, matches) {
  if (!typed || looksLikeCode(typed)) return "";
  return matches.map((p) => `<button type="button" class="cw-match" data-product="${p.id}">
      ${p.image ? `<img src="${h(p.image)}" alt="">` : "<span></span>"}${h(fullName(p))}${itemHere(inv, p.id) ? "" : ' <span class="muted small">(new here)</span>'}</button>`).join("") +
    `<button type="button" class="link cw-new-product">+ “${h(typed)}” is a new product…</button>`;
}

function countWizardTyped(e) {
  const t = e.target, s = CW.state;
  if (!t.dataset.w || !s) return;
  s[t.dataset.w] = t.dataset.w === "n" ? Number(t.value) || 0 : t.dataset.w === "location" ? Number(t.value) || null : t.value;
  saveDraft("countDraft", s);
  if (t.dataset.w === "typed") {
    const inv = inventoryById(s.inv);
    $(".cw-matches").innerHTML = matchesHtml(inv, t.value.trim(), looksLikeCode(t.value.trim()) ? [] : productsFor(inv, t.value.trim()));
  }
  if (t.dataset.w === "n") { const b = $(".cw-done"); if (b) b.textContent = `${s.mode === "add" ? "Add" : "Use"} ${fmtQty(s.n)}`; }
}

// A barcode (or name, chosen) found: what it is, and how many.
function countProduct(p) {
  const s = CW.state, inv = inventoryById(s.inv);
  const it = itemHere(inv, p.id);
  Object.assign(s, { product: p.id, typed: "", n: 1, said: s.said, step: it && !it.used_up && s.mode === "use" ? "kept" : "count" });
  saveDraft("countDraft", s);
  drawCountWizard();
}

async function countWizardEntry(text) {
  const s = CW.state, inv = inventoryById(s.inv);
  text = text.trim();
  if (!text) return;
  const place = text.match(/#location:(\d+)/);
  if (place) { $("#count-wizard").close(); return showPlace(Number(place[1])); }
  const found = productsFor(inv, text);
  if (looksLikeCode(text) || (S.data.products || []).some((p) => p.codes.includes(text))) {
    if (found.length) return countProduct(found[0]);
    return newProductFromCount({ code: text });  // (a barcode nothing has: what is it?)
  }
  if (found.length === 1) return countProduct(found[0]);
  if (!found.length) return newProductFromCount({ name: text });
  s.typed = text;
  drawCountWizard();
}

// Off to Add a product, to come back here with it.
function newProductFromCount(start) {
  const s = CW.state;
  s.closing = false;
  saveDraft("countDraft", s);
  $("#count-wizard").close();
  openProductWizard({ ...start, back: true });
}

async function countWizardSubmitted(e) {
  if (e.target.method === "dialog") return;  // (✕)
  e.preventDefault();
  const s = CW.state;
  if (e.target.matches(".cw-find")) {
    const box = $(".cw-code"), text = box.value;
    box.value = s.typed = "";
    return countWizardEntry(text);
  }
  if (!e.target.matches(".cw-count")) return;
  const inv = inventoryById(s.inv), p = productById(s.product), n = Number(s.n);
  if (!p || !(n > 0)) return toast("How many? (More than none.)");
  if (s.location) save(`inventoryPlace${inv.id}`, String(s.location));
  const r = await countIn({ product_id: p.id }, s.mode === "use" ? -n : n, itemHere(inv, p.id) ? {} : { location_id: s.location || null },
    { quiet: true, inv });
  if (!r) return;
  if (r.kept) { s.step = "kept"; return drawCountWizard(); }
  Object.assign(s, { step: "scan", product: null, n: 1, said: countSaid(r), undo: r.made ? null : { item: r.item.id, delta: r.before - r.after } });
  saveDraft("countDraft", s);
  drawCountWizard();
  if (s.camera) scanForCount(); else $(".cw-code")?.focus();
}

async function scanForCount() {
  const s = CW.state;
  s.camera = true;
  const code = await scanOne(s.mode === "use" ? "Scan what's used" : "Scan what's come in");
  if (!CW.state) return;
  if (!code) { s.camera = false; return $(".cw-code")?.focus(); }
  countWizardEntry(code);
}

async function countWizardClicked(e) {
  const b = e.target.closest("button"), s = CW.state;
  if (!b || !s) return;
  if (b.dataset.mode) { s.mode = b.dataset.mode; saveDraft("countDraft", s); return drawCountWizard(); }
  if (b.classList.contains("cw-scan")) return scanForCount();
  if (b.classList.contains("cw-match")) return countProduct(productById(Number(b.dataset.product)));
  if (b.classList.contains("cw-new-product")) return newProductFromCount({ name: s.typed || "" });
  if (b.classList.contains("cw-less") || b.classList.contains("cw-more")) {
    s.n = Math.max(1, (Number(s.n) || 0) + (b.classList.contains("cw-more") ? 1 : -1));
    $(".cw-n").value = fmtQty(s.n);
    return countWizardTyped({ target: $(".cw-n") });
  }
  if (b.classList.contains("cw-back") || b.classList.contains("cw-next")) {
    Object.assign(s, { step: "scan", product: null, n: 1 });
    saveDraft("countDraft", s);
    drawCountWizard();
    return s.camera && b.classList.contains("cw-next") ? scanForCount() : $(".cw-code")?.focus();
  }
  if (b.classList.contains("cw-open")) { const it = itemHere(inventoryById(s.inv), s.product); $("#count-wizard").close(); return it && openItem(it.id); }
  if (b.classList.contains("cw-undo") && s.undo) {
    const r = await countIn({ item_id: s.undo.item }, s.undo.delta, {}, { quiet: true, inv: inventoryById(s.inv) });
    Object.assign(s, { said: r?.item ? `Undone: ${r.item.name} is ${qtyText(r.item)} again.` : s.said, undo: null });
    saveDraft("countDraft", s);
    drawCountWizard();
  }
}

// ---- Add a product ----
// Steps: 1 its barcode; 2 what it is (looked up: name, brand, size, picture, Walmart page);
// 3 its category, unit, and used up or kept. The lookup's picture is a token the server
// fetches when the product's saved; a photo taken here is uploaded then.

const PW = { state: null, photo: null };  // state: the draft; photo: a File taken (not kept in the draft)

function openProductWizard(start = null) {
  const inv = currentInventory();
  const fresh = start && { step: start.code || start.name || start.link ? 2 : 1, code: start.code || "", name: start.name || "",
    brand: "", size: "", category: "", unit: "", used_up: inv?.kind !== "home", url: "", picture: "", image: "",
    back: !!start.back, looked: false };
  PW.state = fresh || loadDraft("productDraft");
  if (!PW.state) return;
  PW.photo = null;
  saveDraft("productDraft", PW.state);
  const dlg = wizardDialog("product-wizard", "Add a product");
  dlg.onclick = productWizardClicked;
  dlg.oninput = productWizardTyped;
  dlg.onchange = productWizardChanged;
  dlg.onsubmit = (e) => { if (e.target.matches(".pw-body")) { e.preventDefault(); productWizardNext(); } };
  dlg.onclose = () => {
    const s = PW.state;
    if (s?.saving) return;
    PW.state = null;
    saveDraft("productDraft", null);
    if (s?.back) openCountWizard();  // (back to counting, with nothing new)
  };
  drawProductWizard();
  if (!dlg.open) dlg.showModal();
  if (start?.link) lookUpLink(start.link);
  else if (fresh?.code && !fresh.looked) lookUpCode();
  else $("#product-wizard [data-w]")?.focus();
}

function drawProductWizard() {
  const s = PW.state, dlg = $("#product-wizard"), inv = currentInventory();
  if (!dlg || !s) return;
  const steps = ["Barcode", "What it is", "Details"].map((t, i) =>
    `<span class="${i + 1 === s.step ? "on" : i + 1 < s.step ? "done" : ""}">${i + 1}. ${t}</span>`).join("");
  const head = `<form method="dialog" class="dlg-head"><h2>Add a product</h2><button class="icon" aria-label="Close">✕</button></form>
    <div class="pw-steps">${steps}</div>`;
  let body = "";
  if (s.step === 1) {
    body = `<p>Scan its barcode, or type the number under it.</p>
      <div class="pw-row"><input data-w="code" value="${h(s.code)}" placeholder="Barcode (UPC)" inputmode="numeric" aria-label="Barcode" enterkeyhint="next">
        <button type="button" class="pw-scan">📷 Scan</button></div>
      <p class="pw-buttons"><button type="button" class="link pw-no-code">It has no barcode</button>
        <button class="primary">Next →</button></p>`;
  } else if (s.step === 2) {
    const pic = PW.photo ? URL.createObjectURL(PW.photo) : s.picture;
    body = `${s.looking ? '<p class="pw-looking">Looking it up…</p>' : s.found ? `<p class="muted small">Found at ${h(s.found)}.</p>` : s.looked ? '<p class="muted small">Not found online: type what it is.</p>' : ""}
      ${s.warning ? `<p class="pw-warning">${h(s.warning)}</p>` : ""}
      <div class="pw-what">
        <div class="pw-pic">${pic ? `<img src="${h(pic)}" alt="">` : '<span class="muted small">No picture</span>'}
          <label class="link small">${pic ? "Change" : "+ Photo"}<input type="file" class="pw-photo" accept="image/*" capture="environment" hidden></label></div>
        <div class="pw-fields">
          <label>Name <input data-w="name" value="${h(s.name)}" placeholder="Tomato soup" required></label>
          <label>Brand <input data-w="brand" value="${h(s.brand)}" placeholder="Campbell's"></label>
          <label>Size <input data-w="size" value="${h(s.size)}" placeholder="10.75 oz"></label>
        </div>
      </div>
      <label>Its page at a shop <input data-w="url" class="pw-url" value="${h(s.url)}" type="url" placeholder="Paste a Walmart link (it fills in the rest)"></label>
      ${!s.url && s.find_url ? `<p class="small"><a href="${h(s.find_url)}" target="_blank" rel="noopener noreferrer" class="pw-find">Find it on Walmart ↗</a>
        <span class="muted">(Walmart's pages for this barcode): open the product, then copy its link and paste it above${/Android/.test(navigator.userAgent) ? ", or Share it to Entropicide" : ""}.</span></p>` : ""}
      <p class="pw-buttons"><button type="button" class="link pw-back">← Back</button> <button class="primary">Next →</button></p>`;
  } else {
    body = `<p class="pw-summary"><b>${h(s.brand ? `${s.brand} ${s.name}` : s.name)}</b>${s.size ? ` <span class="muted">${h(s.size)}</span>` : ""}</p>
      <h3>Category</h3>${pickChips("category", categoryList(inv), s.category, "Another category")}
      <h3>Counted in</h3>${pickChips("unit", unitList(), s.unit, "Other unit")}
      <h3>It's</h3><div class="iv-chips" data-pick="used_up">
        <button type="button" class="cat-chip${s.used_up ? " on" : ""}" data-value="1">Used up, and bought again</button>
        <button type="button" class="cat-chip${s.used_up ? "" : " on"}" data-value="">Kept (a tool, a ladder)</button></div>
      <p class="pw-buttons"><button type="button" class="link pw-back">← Back</button>
        <button class="primary pw-save">${s.back ? "Save, and count it" : "Save"}</button></p>`;
  }
  dlg.innerHTML = head + `<form class="pw-body" autocomplete="off">${body}</form>`;
}

function productWizardTyped(e) {
  const t = e.target, s = PW.state;
  if (!t.dataset.w || !s) return;
  s[t.dataset.w] = t.value;
  if (t.classList.contains("iv-chip-other")) t.closest(".iv-chips").querySelectorAll(".cat-chip").forEach((c) => c.classList.remove("on"));
  saveDraft("productDraft", s);
}

async function productWizardChanged(e) {
  const t = e.target;
  if (t.classList.contains("pw-photo") && t.files[0]) { PW.photo = t.files[0]; PW.state.image = ""; drawProductWizard(); }
  // A Walmart link pasted: what it says fills in the rest.
  if (t.classList.contains("pw-url") && /walmart\.com\/ip\//i.test(t.value)) lookUpLink(t.value.trim());
}

// The lookup's answer, into the draft: what's not been typed yet (a found page's picture
// over none).
function takeLookup(r) {
  const s = PW.state;
  if (!s || !r) return;
  for (const k of ["name", "brand", "size", "url"]) if (r[k] && !s[k]) s[k] = r[k];
  if (r.image && !PW.photo && (!s.image || r.found_by?.[0] === "Walmart")) { s.image = r.image; s.picture = r.picture; }
  Object.assign(s, { found: (r.found_by || []).join(", "), warning: r.warning || "", find_url: r.find_url || "", looked: true, looking: false });
  saveDraft("productDraft", s);
}

async function lookUpCode() {
  const s = PW.state;
  s.looking = true;
  drawProductWizard();
  const r = await api("GET", `/codes/${encodeURIComponent(s.code)}`, undefined, { quiet: true }).catch(() => null);
  if (PW.state !== s) return;
  s.looking = false;
  takeLookup(r || { found_by: [] });
  drawProductWizard();
  $("#product-wizard [data-w=name]")?.focus();
}

async function lookUpLink(link) {
  const s = PW.state;
  Object.assign(s, { url: link, looking: true, step: Math.max(s.step, 2) });
  drawProductWizard();
  const r = await api("POST", "/codes/from-link", { url: link, code: s.code }, { quiet: true }).catch(() => null);
  if (PW.state !== s) return;
  s.looking = false;
  if (r) { for (const k of ["name", "brand", "size"]) if (r[k]) s[k] = r[k]; if (r.url) s.url = r.url; }
  takeLookup(r || {});
  drawProductWizard();
}

async function productWizardNext() {
  const s = PW.state;
  if (s.step === 1) {
    s.code = (s.code || "").replace(/\s+/g, "");
    if (!s.code) return toast("Scan or type its barcode (or: It has no barcode).");
    const known = (S.data.products || []).find((p) => p.codes.includes(s.code));
    if (known) { toast(`That barcode is ${known.name} already.`); return productSaved(known); }
    s.step = 2;
    saveDraft("productDraft", s);
    return lookUpCode();
  }
  if (s.step === 2) {
    if (!s.name.trim()) { toast("What is it called?"); return $("#product-wizard [data-w=name]")?.focus(); }
    s.step = 3;
    if (!s.category) s.category = "";
    saveDraft("productDraft", s);
    return drawProductWizard();
  }
  s.saving = true;
  try {
    let p = await api("POST", "/products", { name: s.name, brand: s.brand, size: s.size, category: s.category, unit: s.unit,
      used_up: !!s.used_up, url: s.url, codes: s.code ? [s.code] : [], image_lookup: PW.photo ? undefined : s.image || undefined });
    if (!p) return;
    if (PW.photo) p = (await uploadProductPicture(p.id, PW.photo)) || p;
    replaceProduct(p);
    productSaved(p);
  } finally { s.saving = false; }
}

// Saved (or found already): back to counting it, or just closed.
function productSaved(p) {
  const back = PW.state?.back;
  PW.state.saving = true;
  PW.state = null;
  saveDraft("productDraft", null);
  $("#product-wizard")?.close();
  renderList();
  if (back) {
    openCountWizard();
    if (CW.state) countProduct(p);
  } else toast(`${p.name} is in your products. ＋ Add to inventory counts some in.`);
}

async function productWizardClicked(e) {
  const b = e.target.closest("button"), s = PW.state;
  if (!b || !s) return;
  const chips = b.closest("[data-pick]");
  if (chips && b.dataset.value !== undefined) {
    const f = chips.dataset.pick;
    s[f] = f === "used_up" ? !!b.dataset.value : b.dataset.value;
    saveDraft("productDraft", s);
    chips.querySelectorAll(".cat-chip").forEach((c) => c.classList.toggle("on", c === b));
    const other = $(".iv-chip-other", chips);
    if (other) other.value = "";
    return;
  }
  if (b.classList.contains("pw-scan")) {
    const code = await scanOne("Scan its barcode");
    if (code && PW.state === s) { s.code = code; productWizardNext(); }
    return;
  }
  if (b.classList.contains("pw-no-code")) { s.code = ""; s.step = 2; saveDraft("productDraft", s); drawProductWizard(); return $("#product-wizard [data-w=name]")?.focus(); }
  if (b.classList.contains("pw-back")) { s.step -= 1; saveDraft("productDraft", s); drawProductWizard(); }
}

async function uploadProductPicture(id, file) {
  const form = new FormData();
  form.append("file", file, file.name || "photo.jpg");
  const res = await fetch(`${BASE}/api/products/${id}/image`, { method: "POST", body: form, headers: { "X-Requested-With": "entropicide" } })
    .catch(() => null);
  if (!res?.ok) { toast((await res?.json().catch(() => null))?.error || "Couldn't save the picture."); return null; }
  return res.json();
}

// A link shared (or opened) to Add a product: into the one being added, else a new one.
function productFromLink(link) {
  if (PW.state || loadDraft("productDraft")) {
    if (!PW.state) openProductWizard();
    return lookUpLink(link);
  }
  openProductWizard({ link });
}

// ---- products: the catalog ----

function openProducts() {
  const dlg = $("#dialog"), inv = currentInventory();
  let q = "";
  const draw = () => {
    const all = (S.data.products || []).filter((p) => !q || [fullName(p), p.category, ...p.codes].some((t) => (t || "").toLowerCase().includes(q)));
    const where = (p) => (S.data.items || []).filter((i) => i.product_id === p.id).map((i) => inventoryById(i.inventory_id)?.name).filter(Boolean);
    $(".pr-list", dlg).innerHTML = all.map((p) => `<li><button type="button" class="pr-open" data-product="${p.id}">
        ${p.image ? `<img src="${h(p.image)}" alt="" loading="lazy">` : "<span></span>"}
        <span class="pr-name">${h(fullName(p))}${p.size ? ` <span class="muted small">${h(p.size)}</span>` : ""}
          <span class="muted small">${h([p.category, where(p).join(", ") || "in no inventory", p.codes.length ? `${p.codes.length} barcode${p.codes.length > 1 ? "s" : ""}` : "no barcode"].filter(Boolean).join(" · "))}</span></span>
      </button></li>`).join("") || `<li class="muted">${q ? "None match." : "No products yet."}</li>`;
  };
  dlg.innerHTML = `<form method="dialog" class="dlg-head"><h2>Products</h2><button class="icon" aria-label="Close">✕</button></form>
    <p class="muted small">What things are: names, barcodes, pictures and links, for all your inventories. How many of each there are is in each inventory.</p>
    <div class="pw-row"><input class="pr-search" placeholder="Search products" aria-label="Search products">
      <button type="button" class="primary pr-add">+ Add a product</button></div>
    <ul class="plain pr-list"></ul>`;
  draw();
  dlg.oninput = (e) => { if (e.target.matches(".pr-search")) { q = e.target.value.trim().toLowerCase(); draw(); } };
  dlg.onclick = (e) => {
    const b = e.target.closest("button");
    if (b?.matches(".pr-add")) { dlg.close(); openProductWizard({}); }
    else if (b?.matches(".pr-open")) openProduct(Number(b.dataset.product), inv);
  };
  dlg.addEventListener("close", () => { dlg.oninput = dlg.onclick = null; }, { once: true });
  if (!dlg.open) dlg.showModal();
}

// A product, all on one page, to change (each change saved as it's made).
function openProduct(id, inv = currentInventory()) {
  const p = productById(id);
  if (!p) return;
  let dlg = $("#product-dialog");
  if (!dlg) {
    dlg = document.createElement("dialog");
    dlg.id = "product-dialog";
    dlg.className = "iv-wizard";
    document.body.append(dlg);
  }
  dlg.dataset.product = id;
  const may = p.user_id === S.data.user.id || invItemsOf(p).some((i) => canChange(i));
  dlg.innerHTML = `<form method="dialog" class="dlg-head"><h2>${h(p.name)}</h2><button class="icon" aria-label="Close">✕</button></form>
    <div class="pw-what">
      <div class="pw-pic">${p.image ? `<img src="${h(p.image)}" alt="">` : '<span class="muted small">No picture</span>'}
        <label class="link small">${p.image ? "Change" : "+ Photo"}<input type="file" class="pd-photo" accept="image/*" capture="environment" hidden></label></div>
      <div class="pw-fields">
        <label>Name <input data-f="name" value="${h(p.name)}" required></label>
        <label>Brand <input data-f="brand" value="${h(p.brand)}"></label>
        <label>Size <input data-f="size" value="${h(p.size)}"></label>
      </div>
    </div>
    <label>Its page at a shop <input data-f="url" type="url" value="${h(p.url || "")}" placeholder="https://www.walmart.com/ip/…"></label>
    ${p.url ? `<p class="small"><a href="${h(p.url)}" target="_blank" rel="noopener noreferrer">Open its page ↗</a></p>` : ""}
    <h3>Category</h3>${pickChips("category", categoryList(inv), p.category, "Another category").replaceAll("data-w=", "data-f=")}
    <h3>Counted in</h3>${pickChips("unit", unitList(), p.unit, "Other unit").replaceAll("data-w=", "data-f=")}
    <label class="check"><input type="checkbox" data-f="used_up" ${p.used_up ? "checked" : ""}> Used up, and bought again (else it's kept)</label>
    <div class="ii-codes"><span>Barcodes</span> ${p.codes.map((c) => `<span class="ii-code"><code>${h(c)}</code><button type="button" class="link pd-code-del" data-code="${h(c)}" aria-label="Remove">✕</button></span>`).join("") || '<span class="muted">none</span>'}
      <button type="button" class="link pd-code-scan">+ Scan one</button> <button type="button" class="link pd-code-type">+ Type one</button></div>
    <p class="ii-foot">${invItemsOf(p).length ? "" : '<button type="button" class="danger pd-delete">Delete it</button>'}</p>`;
  if (!may) for (const c of dlg.querySelectorAll("input, button:not(.icon)")) c.disabled = true;
  const saveProduct = async (changes) => {
    const r = await api("PATCH", `/products/${id}`, changes);
    if (!r) return;
    replaceProduct(r);
    // (Its items say what it says: fetch them again when that's changed.)
    if (["name", "brand", "category", "unit", "used_up", "url"].some((k) => k in changes)) await refresh();
    if (!("name" in changes || "brand" in changes || "size" in changes || "url" in changes) || "url" in changes) openProduct(id, inv);
  };
  dlg.onchange = async (e) => {
    const t = e.target;
    if (t.classList.contains("pd-photo") && t.files[0]) {
      const r = await uploadProductPicture(id, t.files[0]);
      if (r) { replaceProduct(r); renderList(); openProduct(id, inv); }
      return;
    }
    if (t.dataset.f) saveProduct({ [t.dataset.f]: t.type === "checkbox" ? t.checked : t.value });
  };
  dlg.onclick = async (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    const chips = b.closest("[data-pick]");
    if (chips && b.dataset.value !== undefined) return saveProduct({ [chips.dataset.pick]: b.dataset.value });
    if (b.classList.contains("pd-code-del")) return saveProduct({ codes: p.codes.filter((c) => c !== b.dataset.code) });
    if (b.classList.contains("pd-code-type")) {
      const code = prompt("The barcode's number")?.trim();
      if (code) saveProduct({ codes: [...p.codes, code] });
      return;
    }
    if (b.classList.contains("pd-code-scan")) {
      const code = await scanOne(`A barcode for ${p.name}`);
      if (code) saveProduct({ codes: [...p.codes, code] });
      return;
    }
    if (b.classList.contains("pd-delete")) {
      if (!confirm(`Delete “${p.name}” from your products?`)) return;
      if (await api("DELETE", `/products/${id}`)) {
        S.data.products = S.data.products.filter((x) => x.id !== id);
        dlg.close();
        if ($("#dialog")?.open) openProducts();
      }
    }
  };
  dlg.onclose = () => renderList();
  if (!dlg.open) dlg.showModal();
}
const invItemsOf = (p) => (S.data.items || []).filter((i) => i.product_id === p.id);

// ---- an item's details ----
// How many there are, where, the minimum, and lending; what it *is* is its product's (Edit
// product). Receipts and manuals only for things kept (food doesn't come with a manual).

function openItem(id) {
  const it = itemById(id);
  if (!it) return;
  const inv = inventoryById(it.inventory_id) || currentInventory();
  const p = it.product_id && productById(it.product_id);
  let dlg = $("#item-dialog");
  if (!dlg) {
    dlg = document.createElement("dialog");
    dlg.id = "item-dialog";
    dlg.className = "item-dialog";
    document.body.append(dlg);
    dlg.addEventListener("change", itemChanged);
    dlg.addEventListener("click", itemClicked);
    dlg.addEventListener("close", () => renderList());
  }
  dlg.dataset.item = id;
  // (A message shown inside the dialog is kept out of the way of the redraw, and put back.)
  const note = $("#toast"), noteInside = note && dlg.contains(note);
  if (noteInside) document.body.append(note);
  const pic = pictureOf(it);
  const files = (it.attachments || []).filter((f) => !IMAGE_TYPES.includes(f.mime) || !it.used_up);
  dlg.innerHTML = `<form method="dialog" class="dlg-head">
      ${pic ? `<img class="ii-pic" src="${h(pic)}" alt="">` : ""}
      <div class="ii-title"><b>${h(it.name)}</b>${it.brand ? `<span class="muted">${h(it.brand)}${p?.size ? ` · ${h(p.size)}` : ""}</span>` : ""}</div>
      <button class="icon" aria-label="Close">✕</button></form>
    <p class="small">${p ? '<button type="button" class="link ii-product">Edit product (name, picture, barcodes, unit) …</button>' : ""}
      ${it.url ? ` · <a href="${h(it.url)}" target="_blank" rel="noopener noreferrer">Its page ↗</a>` : ""}</p>
    <div class="two">
      <label>${it.used_up ? "How many left" : "How many"}${shownUnit(it.unit) ? ` (${h(it.unit)})` : ""} <input type="number" data-f="quantity" min="0" step="any" value="${fmtQty(it.quantity)}"></label>
      <label>Place <select data-f="location_id">${options([["", "No place"], ...placeOptions(inv), ["new", "New place…"]], it.location_id ?? "")}</select></label>
    </div>
    ${it.location_id && placePath(it.location_id).includes("›") ? `<p class="muted small ii-path">${h(placePath(it.location_id))}</p>` : ""}
    ${it.used_up ? `<div class="two">
      <label title="Below this, “Buy …” goes on the shopping list">Keep at least <input type="number" data-f="keep_at_least" min="0" step="any" value="${it.keep_at_least ?? ""}" placeholder="none"></label>
      <label title="How many to buy back up to (else the minimum)">Buy back up to <input type="number" data-f="restock_to" min="0" step="any" value="${it.restock_to ?? ""}" placeholder="the minimum"></label>
    </div>` : `<div class="ii-lend">${it.lent_to
      ? `Lent to <b>${h(it.lent_to)}</b>${it.lent_on ? ` on ${h(fmtDate(it.lent_on))}` : ""}. <button type="button" class="ii-returned">It's back</button>`
      : `<button type="button" class="ii-lend-btn">Lend it…</button>`}</div>`}
    <label>Tags <input data-f="tags" value="${h(it.tags.join(", "))}" placeholder="comma, separated"></label>
    ${it.used_up ? "" : `<div class="ii-files">${files.map((f) => `<a href="${h(fileUrl(f))}" target="_blank" rel="noopener">📎 ${h(f.name)}</a>`).join(" ")}
      <label class="link small">+ A receipt, manual or photo<input type="file" hidden></label></div>`}
    <p class="ii-foot"><button type="button" class="danger ii-delete">Move to trash</button></p>`;
  if (noteInside) dlg.append(note);
  dlg.classList.toggle("read-only", !canChange(it));
  if (!canChange(it)) for (const c of dlg.querySelectorAll("input, select, .ii-foot button, .ii-lend button")) c.disabled = true;
  if (!dlg.open) dlg.showModal();
}

async function saveItem(id, changes) {
  const it = await api("PATCH", `/items/${id}`, changes);
  if (!it) return null;
  const was = itemById(id);
  replaceItem(it);
  if (["keep_at_least", "restock_to", "quantity", "lent_to", "deleted"].some((k) => k in changes) &&
      (isLow(was || it) !== isLow(it) || "lent_to" in changes)) await refresh();
  if ($("#item-dialog")?.open && Number($("#item-dialog").dataset.item) === id && !("tags" in changes)) openItem(id);
  return it;
}

async function itemChanged(e) {
  const t = e.target, id = Number($("#item-dialog").dataset.item), it = itemById(id);
  if (t.type === "file") {
    const files = [...t.files];
    t.value = "";
    const data = await uploadTo("item", id, files);
    if (data) { replaceItem(data); openItem(id); }
    return;
  }
  const f = t.dataset.f;
  if (!f) return;
  if (f === "location_id" && t.value === "new") {
    t.value = it.location_id ?? "";
    const l = await newPlace(inventoryById(it.inventory_id), it.location_id);
    return l ? saveItem(id, { location_id: l.id }) : null;
  }
  const value = f === "tags" ? t.value.split(",").map((x) => x.trim()).filter(Boolean)
    : ["quantity", "keep_at_least", "restock_to"].includes(f) ? (t.value === "" ? null : Number(t.value))
    : f === "location_id" ? (t.value ? Number(t.value) : null) : t.value;
  if (f === "location_id" && value) save(`inventoryPlace${it.inventory_id}`, String(value));
  return saveItem(id, { [f]: value });
}

async function itemClicked(e) {
  const b = e.target.closest("button"), id = Number($("#item-dialog").dataset.item), it = itemById(id);
  if (!b || !it) return;
  if (b.classList.contains("ii-product")) { $("#item-dialog").close(); return openProduct(it.product_id, inventoryById(it.inventory_id)); }
  if (b.classList.contains("ii-lend-btn")) {
    const who = prompt(`Lend “${it.name}” to whom?`)?.trim();
    if (who) { await saveItem(id, { lent_to: who }); toast(`Lent to ${who}: “Get ${it.name} back from ${who}” is in Waiting.`); }
    return;
  }
  if (b.classList.contains("ii-returned")) return saveItem(id, { lent_to: null });
  if (b.classList.contains("ii-delete")) {
    await saveItem(id, { deleted: true });
    $("#item-dialog").close();
    toast("Moved to trash.", async () => { await api("PATCH", `/items/${id}`, { deleted: false }); await refresh(); });
  }
}

// ---- places, and their labels ----

function openPlaces() {
  const inv = currentInventory();
  const dlg = $("#dialog");
  const draw = () => {
    const places = (S.data.locations || []).filter((l) => l.inventory_id === inv.id);
    dlg.innerHTML = `<form method="dialog" class="dlg-head"><h2>Places in ${h(inv.name)}</h2><button class="icon" aria-label="Close">✕</button></form>
      <p class="muted small">Where things are, inside one another: a room, a shelf in it, a bin on the shelf. Each can have a QR
        label (<em>Label</em>): scanning it with a phone shows what's there.</p>
      <ul class="plain iv-place-list">${placeOptions(inv).map(([id, , depth]) => {
        const l = locationById(id), count = invItems(inv).filter((i) => i.location_id === id).length;
        return `<li data-place="${id}" style="--depth: ${depth}">
          <span class="pl-branch" aria-hidden="true">${depth ? "└" : "▪"}</span>
          <input class="pl-name" value="${h(l.name)}" aria-label="Name">
          <span class="muted small">${count || ""}</span>
          <button type="button" class="link pl-inside" title="A place inside this one">+ Inside</button>
          <select class="pl-parent" aria-label="Move it into" title="Move it into another place">${options([["", "Move into…"], ["top", "(the top)"],
            ...placeOptions(inv).filter(([x]) => x !== id && !placePath(x).startsWith(placePath(id) + " ›")).map(([x, n]) => [x, n])], "")}</select>
          <button type="button" class="link pl-label">Label</button>
          <button type="button" class="link danger pl-del">Delete</button></li>`;
      }).join("") || '<li class="muted">No places yet. Start with the rooms (Storage room, Master bedroom), then add what\'s inside each.</li>'}</ul>
      <form class="inline pl-add"><input name="name" placeholder="New place at the top (a room)" required><button>Add</button></form>
      ${places.length ? '<p><button type="button" class="pl-all-labels">Print labels for every place</button></p>' : ""}`;
  };
  draw();
  dlg.onsubmit = async (e) => {
    if (!e.target.matches(".pl-add")) return;
    e.preventDefault();
    const l = await api("POST", "/locations", { inventory_id: inv.id, name: e.target.elements.name.value.trim() });
    if (l) { S.data.locations.push(l); draw(); }
  };
  dlg.onchange = async (e) => {
    const li = e.target.closest("[data-place]");
    if (!li) return;
    if (e.target.matches(".pl-parent") && !e.target.value) return;
    const id = Number(li.dataset.place), changes = e.target.matches(".pl-name") ? { name: e.target.value } : { parent_id: Number(e.target.value) || null };
    const l = await api("PATCH", `/locations/${id}`, changes);
    if (l) { Object.assign(locationById(id), l); draw(); }
    else draw();
  };
  dlg.onclick = async (e) => {
    const b = e.target.closest("button"), id = Number(b?.closest("[data-place]")?.dataset.place);
    if (b?.matches(".pl-inside")) {
      const name = prompt(`A place inside “${locationById(id).name}” (e.g. Shelf 1, Drawer 6)`)?.trim();
      if (!name) return;
      const l = await api("POST", "/locations", { inventory_id: inv.id, name, parent_id: id });
      if (l) { S.data.locations.push(l); draw(); }
    } else if (b?.matches(".pl-label")) printLabels([id]);
    else if (b?.matches(".pl-all-labels")) printLabels(placeOptions(inv).map(([x]) => x));
    else if (b?.matches(".pl-del")) {
      if (!confirm(`Delete “${locationById(id).name}”, and the places in it? What's there stays, with no place.`)) return;
      await api("DELETE", `/locations/${id}`);
      await refresh();
      draw();
    }
  };
  dlg.addEventListener("close", () => { dlg.onsubmit = dlg.onchange = dlg.onclick = null; renderList(); }, { once: true });
  if (!dlg.open) dlg.showModal();
}

// A new place, from an item's details: its name, and where it is (inside the item's place, to
// begin with). Resolves to it, or null.
function newPlace(inv, inside) {
  return new Promise((done) => {
    const dlg = document.createElement("dialog");
    dlg.className = "iv-new-place";
    dlg.innerHTML = `<form method="dialog" class="stack"><h3>A new place</h3>
      <label>Name <input name="name" required placeholder="Shelf 1, Drawer 6, Blue bin"></label>
      <label>Inside <select name="parent">${options([["", "Nothing: it's a room, or the like"], ...placeOptions(inv)], inside ?? "")}</select></label>
      <p><button class="primary" value="add">Add</button> <button value="" formnovalidate>Cancel</button></p></form>`;
    document.body.append(dlg);
    dlg.addEventListener("close", async () => {
      const f = $("form", dlg).elements;
      let l = null;
      if (dlg.returnValue === "add" && f.name.value.trim()) {
        l = await api("POST", "/locations", { inventory_id: inv.id, name: f.name.value.trim(), parent_id: Number(f.parent.value) || null }).catch(() => null);
        if (l) S.data.locations.push(l);
      }
      dlg.remove();
      done(l);
    });
    dlg.showModal();
  });
}

// A sheet of QR labels, one for each place: its name, and an address that opens it here.
async function printLabels(ids) {
  if (!ids.length) return toast("Add some places first (Places…).");
  const { default: qrcode } = await import(`${VENDOR_URL}/qrcode/qrcode.mjs`);
  const label = (id) => {
    const qr = qrcode(0, "M");
    qr.addData(new URL(`${BASE}/#location:${id}`, location.href).href);
    qr.make();
    return `<div class="label">${qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true })}<div class="name">${h(placePath(id))}</div></div>`;
  };
  const w = window.open("", "_blank");
  if (!w) return toast("Allow pop-ups for this site to print labels.");
  w.document.write(`<!doctype html><meta charset="utf-8"><title>Labels · ${h(currentInventory()?.name || "")}</title>
    <style>body{font:14px system-ui,sans-serif;margin:12mm}.sheet{display:grid;grid-template-columns:repeat(auto-fill,52mm);gap:6mm}
    .label{border:1px dashed #bbb;border-radius:3mm;padding:3mm;text-align:center;break-inside:avoid}.label svg{width:40mm;height:40mm}
    .name{font-weight:600;margin-top:1mm}@media print{.hint{display:none}.label{border-color:#ddd}}</style>
    <p class="hint">Print this page (Ctrl+P), cut the labels out, and stick each on its place. Scanning one with a phone's camera opens it in Entropicide.</p>
    <div class="sheet">${ids.map(label).join("")}</div>`);
  w.document.close();
}

// A place, alone (a label scanned, or #location:<id> opened).
function showPlace(id) {
  const l = locationById(id);
  if (!l) return toast("That place isn't in any inventory you can see.");
  IV.inv = l.inventory_id;
  save("inventory", String(l.inventory_id));
  IV.place = id;
  IV.filter = "";
  if (S.view !== "inventory") setView("inventory"); else renderList();
}

// Opened from a label: #location:<id>.
function openFromLabel() {
  const m = location.hash.match(/^#location:(\d+)$/);
  if (!m) return;
  history.replaceState(null, "", location.pathname + location.search);
  showPlace(Number(m[1]));
}
window.addEventListener("hashchange", openFromLabel);

// ---- the page's events ----

async function newInventory(kind) {
  const name = prompt(kind === "home" ? "Name it (e.g. House)" : "Name it (e.g. Pantry, Food storage)")?.trim();
  if (!name) return;
  const inv = await api("POST", "/inventories", { name, kind });
  if (!inv) return;
  IV.inv = inv.id;
  save("inventory", String(inv.id));
  IV.filter = kind === "home" ? "" : IV.filter;
  await refresh();
}

function bindInventory() {
  const list = $("#list");
  list.addEventListener("click", async (e) => {
    if (S.view !== "inventory") return;
    const b = e.target.closest("button");
    if (!b) return;
    const row = b.closest("[data-item]"), inv = currentInventory();
    if (b.classList.contains("iv-start")) return newInventory(b.dataset.kind);
    if (b.dataset.inventory) { IV.inv = Number(b.dataset.inventory); IV.place = null; save("inventory", b.dataset.inventory); return renderList(); }
    if (b.classList.contains("iv-new")) {
      return newInventory(confirm("Is it for things used up and bought again (food storage, supplies)?\n\nOK: yes. Cancel: things kept (a home inventory).") ? "stock" : "home");
    }
    if (b.classList.contains("iv-add")) return openCountWizard("add");
    if (b.classList.contains("iv-use")) return openCountWizard("use");
    if (b.classList.contains("iv-products")) return openProducts();
    if (b.dataset.filter !== undefined && b.closest(".iv-filters")) { IV.filter = b.dataset.filter; save("inventoryFilter", IV.filter); return renderList(); }
    if (b.classList.contains("iv-all-places")) { IV.place = null; return renderList(); }
    if (b.classList.contains("iv-places")) return openPlaces();
    if (b.classList.contains("iv-labels")) return printLabels(placeOptions(inv).map(([x]) => x));
    if (b.classList.contains("iv-rename")) {
      const name = prompt("Rename the inventory", inv.name)?.trim();
      if (name && await api("PATCH", `/inventories/${inv.id}`, { name })) await refresh();
      return;
    }
    if (b.classList.contains("iv-delete")) {
      const n = invItems(inv).length;
      if (!confirm(`Delete “${inv.name}”${n ? `, and the ${n} thing${n > 1 ? "s" : ""} in it, for good` : ""}? This can't be undone. (Your products stay.)`)) return;
      await api("DELETE", `/inventories/${inv.id}`);
      IV.inv = null;
      return refresh();
    }
    if (row && b.classList.contains("iv-open")) return openItem(Number(row.dataset.item));
    if (row && (b.classList.contains("iv-minus") || b.classList.contains("iv-plus"))) {
      return countIn({ item_id: Number(row.dataset.item) }, b.classList.contains("iv-plus") ? 1 : -1);
    }
  });
  list.addEventListener("change", async (e) => {
    if (S.view !== "inventory") return;
    const t = e.target, inv = currentInventory();
    if (t.matches(".iv-layout")) { IV.layout = t.value; save("inventoryLayout", t.value); renderList(); }
    else if (t.matches(".iv-share")) {
      if (await api("PATCH", `/inventories/${inv.id}`, { group_id: t.value ? Number(t.value) : null })) {
        await refresh();
        toast(t.value ? "Shared: everyone in the group sees it, and counts in it." : "It's yours alone again.");
      } else renderList();
    }
  });
}
document.addEventListener("DOMContentLoaded", bindInventory);

// Ticking off a "Buy …" task from an inventory: how many were bought go in.
async function boughtFor(taskId) {
  const it = (S.data.items || []).find((i) => i.buy_task_id === taskId);
  if (!it) return;
  const need = Math.max((it.restock_to ?? it.keep_at_least ?? 1) - it.quantity, 1);
  const got = prompt(`How many ${shownUnit(it.unit)} of “${it.name}” did you get?`.replace("  ", " "), fmtQty(need));
  const n = Number(got);
  if (got !== null && n > 0) {
    const r = await api("POST", "/items/count", { inventory_id: it.inventory_id, item_id: it.id, delta: n });
    if (r?.item) replaceItem(r.item);
  }
}
