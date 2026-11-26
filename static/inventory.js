"use strict";

// ---- inventory -------------------------------------------------------------------
// The Inventory page: an inventory's things, by place (or category, or A–Z), with − / + on
// each. What a thing *is* (its name, barcodes, picture, link) is a product, in a catalog of
// one's own (S.data.products); an item is a product in one inventory: how many, where, the
// minimum, who has it. Two wizards, each a dialog of its own:
// - Add to inventory / Use (openCounter): the camera opens at once, and each barcode read
//   counts one in (or out) straight away, can after can; a box takes a typed barcode or name.
// - Add a product (openProductWizard): once for each product. Its barcode is looked up online
//   (the name, brand, picture and Walmart page filled in), then its category, unit, and used
//   up or kept. A barcode Add to inventory doesn't know comes here, and goes back after.
// Add a product keeps what's typed in a draft (localStorage) as it's typed, so nothing
// redrawing the page (or the app reloading) can blank it.
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
  selecting: false,                              // choosing things (press and hold one), to move or delete them
  sel: new Set(),                                // the ids chosen
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
// A barcode, typed (or typed by a USB scanner): a UPC or EAN (6–14 digits), or another kind
// (Code 39, Code 128, a part number: "TOOL-0042"): no spaces, and at least three digits. (Anything
// the camera reads is one, whatever it looks like.)
const looksLikeCode = (text) => /^\d{6,14}$/.test(text) || (/^\S{4,200}$/.test(text) && (text.match(/\d/g) || []).length >= 3);
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

// Names in the order people expect: numbers by their value (Shelf 2 before Shelf 10), and
// ignoring case and accents.
const natural = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });

// An inventory's places as a tree, flattened in order: [[id, its whole path, depth]]. The whole
// path ("Basement › Shelf unit 2 › Shelf 1"), as there can be many a Shelf 1, and a phone's list
// of choices (or a choice made) shows no indenting.
function placeOptions(inv) {
  const out = [], places = (S.data.locations || []).filter((l) => l.inventory_id === inv.id);
  const walk = (parent, depth) => {
    for (const l of places.filter((x) => (x.parent_id ?? null) === parent).sort((a, b) => natural(a.name, b.name))) {
      out.push([l.id, placePath(l.id), depth]);
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
  return [...new Set([...own, ...(inv?.kind === "home" ? [] : STOCK_CATEGORIES)])].sort(natural);
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
  const shown = shownItems(inv, items).sort((a, b) => natural(a.name, b.name));
  let html = `<div class="notes-bar">
    <div class="cat-chips" role="group" aria-label="Inventory">
      ${all.map((x) => `<button type="button" class="cat-chip${x.id === inv.id ? " on" : ""}" data-inventory="${x.id}">${x.icon ? ownIcon(x.icon, "inventories", x.id) : x.kind === "home" ? "🏠" : "🥫"} ${h(x.name)}</button>`).join("")}
      <button type="button" class="link iv-new">+ New inventory</button>
    </div>
    <div class="notes-opts">
      ${inventoryShareField(inv)}
      <button type="button" class="link iv-places">Places…</button>
      <button type="button" class="link iv-labels" title="QR labels for the places: scanning one shows what's there">Labels</button>
      <button type="button" class="link iv-icon" title="An icon of its own">${inv.icon ? `${ownIcon(inv.icon, "inventories", inv.id)} Icon` : "Icon…"}</button>
      ${shortcutButton(`inventory:${inv.id}`)}
      <button type="button" class="link iv-rename">Rename</button>
      ${mine ? '<button type="button" class="link danger iv-delete">Delete</button>' : ""}
    </div>
  </div>
  ${IV.selecting ? selectBar(shown) : `<div class="iv-actions">
    <button type="button" class="primary iv-add" title="Scan (or type) what's come in">＋ Add</button>
    <button type="button" class="iv-use" title="Scan (or type) what's been used">− Use</button>
    <button type="button" class="iv-look" title="Scan (or type) something to see how many there are, and where (nothing's counted)">🔍 Look up</button>
    <span class="iv-actions-end"><button type="button" class="link iv-select" title="Or press and hold one">Select</button>
      <button type="button" class="link iv-products">Products (${(S.data.products || []).length})</button></span>
  </div>`}
  <div class="iv-filters">
    ${[["", `All · ${items.length}`], ["low", `Low · ${low}`], ["kept", "Kept"], ["lent", `Lent · ${lent}`]]
      .map(([f, label]) => `<button type="button" class="cat-chip${IV.filter === f ? " on" : ""}" data-filter="${f}">${label}</button>`).join("")}
    <span class="iv-place-filter-wrap"><button type="button" class="cat-chip iv-place-filter${IV.place ? " on" : ""}" title="Only what's in a place">📍 ${IV.place ? placeLabel(IV.place) : "A place…"}</button>${IV.place
      ? '<button type="button" class="icon iv-all-places" title="Every place" aria-label="Every place">✕</button>'
      : '<button type="button" class="icon iv-place-scan" title="Scan a place\'s QR label to see what\'s there" aria-label="Scan a place\'s label">📷</button>'}</span>
    <select class="iv-layout" aria-label="Order">${options([["places", "By place"], ["categories", "By category"], ["names", "A–Z"]], IV.layout)}</select>
  </div>`;
  // Groups (by place, category, or first letter), each with a heading; with many things, a bar
  // of them along the top, to jump to one.
  const groups = new Map();
  if (shown.length) {
    const key = IV.layout === "places" ? (it) => (it.location_id && locationById(it.location_id) ? placePath(it.location_id) : "")
      : IV.layout === "categories" ? (it) => it.category
      : (it) => (/[a-z]/i.test(it.name[0] || "") ? it.name[0].toUpperCase() : "#");
    for (const it of shown) {
      const k = key(it);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(it);
    }
  }
  const keys = [...groups.keys()].sort((a, b) => (a === "") - (b === "") || natural(a, b));
  const groupName = (k) => k || (IV.layout === "places" ? "No place" : "No category");
  const headed = IV.layout !== "names" || shown.length > JUMP_FROM;
  if (shown.length > JUMP_FROM && keys.length > 1) {
    html += `<nav class="iv-jump" aria-label="Jump to"><button type="button" class="icon" data-iv-jump="top" title="Back to the top" aria-label="Back to the top">↑</button>
      ${keys.map((k, i) => `<button type="button" class="cat-chip" data-iv-jump="${i}" title="${h(groupName(k))}">${h(IV.layout === "places" && k ? k.split(" › ").slice(-2).join(" › ") : groupName(k))}</button>`).join("")}</nav>`;
  }
  if (!shown.length) {
    html += `<p class="empty">${items.length ? "Nothing here matches." : "Nothing in it yet. Press <b>＋ Add</b>, then scan a barcode (or type a name)."}</p>`;
  } else if (!headed) {
    html += shown.map((it) => itemRow(it, true)).join("");
  } else {
    keys.forEach((k, i) => {
      html += `<h2 class="group" id="ivg-${i}">${h(groupName(k))}</h2>` + groups.get(k).map((it) => itemRow(it, IV.layout !== "places")).join("");
    });
  }
  el.innerHTML = html;
  if (!IV.resumed) {
    IV.resumed = true;
    if (loadDraft("productDraft")) openProductWizard();
  }
}

// More things than this, and the page has a bar to jump along it (and A–Z has letters).
const JUMP_FROM = 12;

// Choosing things, to move or delete them together: how many, and what to do.
function selectBar(shown) {
  const n = IV.sel.size;
  return `<div class="iv-selbar"><b>${n} chosen</b>
    <button type="button" class="link iv-sel-all">All ${shown.length}</button>
    <button type="button" class="link iv-sel-none">None</button>
    <span class="iv-actions-end"><button type="button" class="iv-sel-move"${n ? "" : " disabled"}>Move…</button>
      <button type="button" class="danger iv-sel-delete"${n ? "" : " disabled"}>Delete…</button>
      <button type="button" class="iv-sel-done">Done</button></span></div>`;
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
  const chosen = IV.selecting && IV.sel.has(it.id);
  return `<div class="iv-row${isLow(it) ? " low" : ""}${chosen ? " chosen" : ""}" data-item="${it.id}">
    ${IV.selecting ? `<input type="checkbox" class="iv-check" ${chosen ? "checked" : ""} aria-label="Choose ${h(it.name)}">` : ""}
    ${pic ? `<img class="iv-thumb" src="${h(pic)}" alt="" loading="lazy">` : '<span class="iv-thumb"></span>'}
    <div class="row-body"><button type="button" class="link iv-open">${h(it.name)}</button>${meta ? `<div class="meta">${meta}</div>` : ""}</div>
    ${IV.selecting ? "" : count}
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
  S.data.products.sort((a, b) => natural(a.name, b.name));
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
    .sort((a, b) => here(a) - here(b) || natural(a.name, b.name)).slice(0, 12);
}

// ---- the scanner ----
// The camera, reading barcodes continuously (so can after can can be scanned), with the
// browser's own reader, else the vendored one (its engine loaded from here, never a CDN).

// Every kind it can read: product barcodes (UPC, EAN), and the others on tools, parts and
// labels (Code 128, 39 and 93, ITF, Codabar; QR, Data Matrix, PDF417, Aztec).
const BARCODE_FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39", "code_93", "itf", "codabar",
  "qr_code", "data_matrix", "pdf417", "aztec"];
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

// 📷 beside a choice of place: scanning a place's QR label (Labels, on the inventory) chooses
// it, as if picked from the list (so it saves the same way).
const scanPlaceButton = (inv) => `<button type="button" class="icon scan-place" data-inv="${inv.id}"
  title="Scan the place's QR label" aria-label="Scan the place's label">📷</button>`;

// A place, for a button: where it is (muted), then itself. "Garage › Shelf unit 2 › **Shelf 1**".
function placeLabel(id) {
  const path = id ? placePath(id) : "";
  if (!path) return '<span class="muted">No place</span>';
  const parts = path.split(" › ");
  return (parts.length > 1 ? `<span class="muted">${h(parts.slice(0, -1).join(" › "))} › </span>` : "") + `<b>${h(parts.at(-1))}</b>`;
}

// A place to choose, in a form: a button showing the whole path, which opens pickPlace, and 📷
// to scan its label. The choice is in a hidden input (attrs: its data-f or class), which says
// "change" as a select would.
const placeField = (inv, value, attrs) => `<span class="place-pick" data-inv="${inv.id}">
  <input type="hidden" ${attrs} value="${value ?? ""}">
  <button type="button" class="place-choose">${placeLabel(value)}</button>${scanPlaceButton(inv)}</span>`;

function setPlacePick(pick, id) {
  const input = $("input[type=hidden]", pick);
  input.value = id ?? "";
  $(".place-choose", pick).innerHTML = placeLabel(id);
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

// Chooses a place in an inventory: its tree (indented, with how many things are in each), a
// box to find one by name, No place, a new one, or its label scanned. Resolves to its id, null
// for no place, or undefined if nothing was chosen.
function pickPlace(inv, current = null, { title = "Choose a place", none = true, add = true } = {}) {
  return new Promise((done) => {
    const dlg = document.createElement("dialog");
    dlg.className = "place-picker";
    let result;
    const count = (id) => invItems(inv).filter((i) => i.location_id === id).length;
    const row = ([id, , depth], q) => {
      const l = locationById(id), n = count(id);
      return `<li><button type="button" class="pp-place${id === current ? " on" : ""}" data-id="${id}" style="--depth: ${q ? 0 : depth}">
        ${q ? placeLabel(id) : `${depth ? '<span class="pp-branch">└</span>' : ""}${h(l.name)}`}${n ? `<span class="pp-n">${n}</span>` : ""}</button></li>`;
    };
    const draw = (q = "") => {
      const words = q.toLowerCase().split(/\s+/).filter(Boolean);
      const places = placeOptions(inv).filter(([id]) => words.every((w) => placePath(id).toLowerCase().includes(w)));
      $(".pp-list", dlg).innerHTML = (none && !q ? `<li><button type="button" class="pp-place${current == null ? " on" : ""}" data-id="">No place</button></li>` : "") +
        (places.map((x) => row(x, q)).join("") || '<li class="muted">No place is called that.</li>');
    };
    dlg.innerHTML = `<form method="dialog" class="dlg-head"><h2>${h(title)}</h2><button class="icon" aria-label="Close">✕</button></form>
      <div class="pw-row"><input class="pp-find" placeholder="Find a place" aria-label="Find a place" autocomplete="off">
        <button type="button" class="pp-scan">📷 Scan label</button></div>
      <ul class="plain pp-list"></ul>
      ${add ? '<p><button type="button" class="link pp-new">+ A new place…</button></p>' : ""}`;
    document.body.append(dlg);
    draw();
    const finish = (id) => { result = id; dlg.close(); };
    dlg.addEventListener("input", (e) => { if (e.target.matches(".pp-find")) draw(e.target.value); });
    dlg.addEventListener("click", async (e) => {
      const b = e.target.closest("button");
      if (b?.matches(".pp-place")) return finish(b.dataset.id ? Number(b.dataset.id) : null);
      if (b?.matches(".pp-new")) { const l = await newPlace(inv, current); if (l) finish(l.id); return; }
      if (b?.matches(".pp-scan")) {
        openScanner((code) => {
          const m = code.match(/#location:(\d+)/), l = m && locationById(Number(m[1]));
          if (!l || l.inventory_id !== inv.id) return m ? "That's a place in another inventory." : "That isn't a place's label: scan the QR code on the shelf or bin.";
          finish(l.id);
          return "stop";
        }, "Scan the place's label");
      }
    });
    dlg.addEventListener("close", () => { dlg.remove(); done(result); });
    dlg.showModal();
    // (The chosen place in view, in a long list.)
    $(".pp-place.on", dlg)?.scrollIntoView({ block: "center" });
  });
}

document.addEventListener("click", async (e) => {
  const b = e.target.closest(".scan-place, .place-choose");
  const pick = b?.closest(".place-pick");
  if (!pick) return;
  e.preventDefault();
  const inv = inventoryById(Number(pick.dataset.inv)), input = $("input[type=hidden]", pick);
  const current = input.value ? Number(input.value) : null;
  if (b.matches(".place-choose")) {
    const id = await pickPlace(inv, current, { title: "Where it goes" });
    if (id !== undefined && id !== current) setPlacePick(pick, id);
    return;
  }
  openScanner((code) => {
    const m = code.match(/#location:(\d+)/), l = m && locationById(Number(m[1]));
    if (!l || l.inventory_id !== inv.id) return m ? "That's a place in another inventory." : "That isn't a place's label: scan the QR code on the shelf or bin.";
    setPlacePick(pick, l.id);
    toast(`Place: ${placePath(l.id)}`);
    return "stop";
  }, "Scan the place's label");
});

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

// Takes a photo with the camera, here (resolves to it as a JPEG file, or null if cancelled).
// Here, not in the phone's camera app: while that's open, Android may close this page to save
// memory, and the photo would have nowhere to come back to. "From gallery" chooses one taken
// already; its file box is in this dialog, which nothing redraws.
function takePhoto(title = "Take a photo") {
  return new Promise((done) => {
    const dlg = document.createElement("dialog");
    dlg.className = "iv-scanner iv-photo";
    dlg.innerHTML = `<div class="draw-head"><b>${h(title)}</b><span class="iv-scan-said muted">Opening the camera…</span>
      <span class="draw-end"><button type="button" class="ph-cancel">Cancel</button></span></div>
      <video playsinline muted></video>
      <div class="ph-buttons"><label class="ph-gallery">From gallery<input type="file" accept="image/*" hidden></label>
        <button type="button" class="primary ph-take" disabled>📷 Take photo</button></div>`;
    document.body.append(dlg);
    let stream = null, result = null;
    const finish = (file) => { result = file; if (dlg.open) dlg.close(); };
    dlg.addEventListener("close", () => { stream?.getTracks().forEach((t) => t.stop()); dlg.remove(); done(result); });
    $(".ph-cancel", dlg).onclick = () => finish(null);
    $("input[type=file]", dlg).onchange = (e) => finish(e.target.files[0] || null);
    const video = $("video", dlg);
    $(".ph-take", dlg).onclick = () => {
      // (At most 1600 pixels across: plenty for a product, and quick to upload.)
      const scale = Math.min(1, 1600 / Math.max(video.videoWidth, video.videoHeight));
      const canvas = Object.assign(document.createElement("canvas"),
        { width: Math.round(video.videoWidth * scale), height: Math.round(video.videoHeight * scale) });
      canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => finish(blob ? new File([blob], "photo.jpg", { type: "image/jpeg" }) : null), "image/jpeg", 0.85);
    };
    dlg.showModal();
    navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment", width: { ideal: 1920 } }, audio: false })
      .then(async (cam) => {
        stream = cam;
        if (!dlg.isConnected) return cam.getTracks().forEach((t) => t.stop());
        video.srcObject = cam;
        await video.play();
        $(".iv-scan-said", dlg).textContent = "";
        $(".ph-take", dlg).disabled = false;
      })
      .catch((err) => {
        $(".iv-scan-said", dlg).textContent = err?.name === "NotAllowedError"
          ? "The camera isn't allowed: allow it for this site, or choose one from the gallery." : "No camera here: choose a picture from the gallery.";
      });
  });
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

// ---- Add to inventory / Use: the counter ----
// One screen, the camera open from the start: each barcode read counts one in, or (Use) one
// out, at once, and it keeps reading, so can after can needs no taps. The
// same barcode counts again once it's been out of sight a moment (so a can held still counts
// once). A box below takes a typed barcode or name (and a USB or Bluetooth scanner, which
// types). A barcode nothing has pauses it for Add a product, and comes back to count it.
// Something new to this inventory goes in the place chosen in Add a product, else the place
// last used (its details can move it).

const CT = { open: null };  // the counter, while it's open: { mode, inv, dlg, stream, stopped, busy, last, lastSeen, undo }
const SAME_CODE_GAP = 800;  // ms a barcode must be out of sight to count again

// A beep for each count (Web Audio, so nothing to download): high for one added, lower for one
// used, rising for something new here, a low buzz for nothing counted. 🔇 on the counter turns
// it off on this device. The sound has to be started from a tap, so openCounter (opened by
// one) wakes it.
let beeper = null;
const beepsOn = () => load("inventoryBeep", "1") === "1";
function wakeBeeper() {
  try {
    beeper = beeper || new (window.AudioContext || window.webkitAudioContext)();
    if (beeper.state === "suspended") beeper.resume();
  } catch { beeper = null; }
}
function beep(kind) {
  if (!beeper || !beepsOn()) return;
  const notes = { add: [[1320, 0, 0.09]], use: [[740, 0, 0.11]], new: [[880, 0, 0.08], [1320, 0.1, 0.1]],
    bad: [[200, 0, 0.25]] }[kind] || [];
  const now = beeper.currentTime;
  for (const [freq, at, long] of notes) {
    const tone = beeper.createOscillator(), loud = beeper.createGain();
    tone.type = kind === "bad" ? "square" : "sine";
    tone.frequency.value = freq;
    // (A quick rise and fall, so it doesn't click.)
    loud.gain.setValueAtTime(0.0001, now + at);
    loud.gain.exponentialRampToValueAtTime(0.3, now + at + 0.01);
    loud.gain.exponentialRampToValueAtTime(0.0001, now + at + long);
    tone.connect(loud).connect(beeper.destination);
    tone.start(now + at);
    tone.stop(now + at + long + 0.02);
  }
}

function openCounter(mode, then = null, place = undefined, qty = 1) {
  const inv = currentInventory();
  if (!inv) return;
  const saved = loadDraft("countDraft");
  mode = mode || saved?.mode || "add";
  saveDraft("countDraft", null);
  closeCounter();
  wakeBeeper();
  const dlg = document.createElement("dialog");
  dlg.className = "iv-counter";
  document.body.append(dlg);
  // (Back from Add a product, its barcode may well still be in front of the camera: it's been
  // counted, so it counts again only once it's been out of sight.)
  const c = CT.open = { mode, inv: inv.id, dlg, stream: null, stopped: false, busy: false,
    last: saved?.code || "", lastSeen: saved?.code ? Date.now() + 1500 : 0, undo: null, said: "", saidKind: "" };
  drawCounter();
  dlg.addEventListener("close", () => { if (CT.open === c) closeCounter(); });
  dlg.addEventListener("click", counterClicked);
  dlg.addEventListener("input", counterTyped);
  dlg.addEventListener("submit", counterSubmitted);
  dlg.showModal();
  startCamera(c);
  if (then) counterCount(then, place, qty);
}

function closeCounter() {
  const c = CT.open;
  if (!c) return;
  CT.open = null;
  c.stopped = true;
  c.stream?.getTracks().forEach((t) => t.stop());
  if (c.dlg.open) c.dlg.close();
  c.dlg.remove();
  renderList();
}

// What each of the counter's modes says. Look up counts nothing: a scan opens what it is.
const COUNTER_MODES = {
  add: { button: "＋ Add", title: "Adding to", go: "Add", hint: "Scan barcodes: each one adds one." },
  use: { button: "− Use", title: "Using from", go: "Use", hint: "Scan barcodes: each one takes one away." },
  look: { button: "🔍 Look up", title: "Looking up in", go: "Look up", hint: "Scan a barcode to see what it is, and how many there are (nothing's counted)." },
};

function drawCounter() {
  const c = CT.open, inv = inventoryById(c.inv);
  const adding = c.mode === "add", m = COUNTER_MODES[c.mode];
  c.dlg.classList.toggle("use", c.mode === "use");
  c.dlg.classList.toggle("look", c.mode === "look");
  c.dlg.innerHTML = `<div class="ct-head">
      <span class="iv-mode" role="group" aria-label="Add, use or look up">
        ${Object.entries(COUNTER_MODES).map(([k, x]) => `<button type="button" class="${c.mode === k ? "on" : ""}" data-mode="${k}">${x.button}</button>`).join("")}</span>
      <b class="ct-title">${m.title} ${h(inv.name)}</b>
      <button type="button" class="icon ct-sound" aria-label="${beepsOn() ? "Turn the beep off" : "Turn the beep on"}" title="Beep on each scan">${beepsOn() ? "🔊" : "🔇"}</button>
      <button type="button" class="primary ct-done">Done</button></div>
    <div class="ct-camera"><video playsinline muted></video><p class="ct-camera-said">Opening the camera…</p></div>
    <div class="ct-panel">
      <p class="ct-said ${c.saidKind}">${c.said ? h(c.said) : counterHint(c)}
        ${counterLinks(c.undo)}</p>
      <form class="ct-type" autocomplete="off">
        <input class="ct-code" placeholder="Or type a barcode or a name" aria-label="Barcode or name" enterkeyhint="go">
        <button>${m.go}</button>
      </form>
      <div class="ct-matches"></div>
      ${adding ? '<p class="ct-no-code-p"><button type="button" class="ct-no-code">Something new with no barcode…</button></p>' : ""}
    </div>`;
}

// After a count: Undo, and Go to item (its details, the scanner closed).
const counterLinks = (undo) => (undo ? ` <button type="button" class="link ct-undo">Undo</button>
  <button type="button" class="link ct-goto" data-item="${undo.item}">Go to item</button>` : "");

const counterHint = (c) => COUNTER_MODES[c.mode].hint;

// What happened, at the bottom (and a buzz): kind "good", "new" or "bad".
function counterSay(text, kind = "good", undo = null, sound = true) {
  const c = CT.open;
  if (!c) return;
  Object.assign(c, { said: text, saidKind: kind, undo });
  const p = $(".ct-said", c.dlg);
  p.className = `ct-said ${kind} flash`;
  p.innerHTML = h(text) + counterLinks(undo);
  navigator.vibrate?.(kind === "bad" ? [60, 60, 60] : 60);
  if (sound) beep(kind === "good" ? (c.mode === "use" ? "use" : "add") : kind);
}

async function startCamera(c) {
  const said = $(".ct-camera-said", c.dlg);
  try {
    const reader = await makeBarcodeReader();
    c.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
    if (c.stopped) return c.stream.getTracks().forEach((t) => t.stop());
    const video = $("video", c.dlg);
    video.srcObject = c.stream;
    await video.play();
    said.hidden = true;
    const tick = async () => {
      if (c.stopped) return;
      try {
        const found = await reader.detect(video);
        const code = found[0]?.rawValue;
        if (code) {
          const again = code === c.last && Date.now() - c.lastSeen < SAME_CODE_GAP;
          c.lastSeen = Date.now();
          if (!again && !c.busy) { c.last = code; await counterEntry(code, true); }
        }
      } catch { /* (a frame it couldn't read) */ }
      setTimeout(tick, 150);
    };
    tick();
  } catch (err) {
    c.dlg.classList.add("no-camera");
    said.textContent = err?.name === "NotAllowedError"
      ? "The camera isn't allowed here: allow it for this site, or type below." : "No camera here: type a barcode or name below (a barcode scanner types there too).";
    $(".ct-code", c.dlg)?.focus();
  }
}

// A barcode read or typed, or a name typed: count it, else find it, else make it.
async function counterEntry(text, scanned = false) {
  const c = CT.open, inv = c && inventoryById(c.inv);
  text = (text || "").trim();
  if (!c || !text) return;
  const place = text.match(/#location:(\d+)/);
  if (place) { closeCounter(); return showPlace(Number(place[1])); }
  const found = productsFor(inv, text);
  const isCode = scanned || looksLikeCode(text) || (S.data.products || []).some((p) => p.codes.includes(text));
  $(".ct-matches", c.dlg).innerHTML = "";
  if (isCode && !found.length && c.mode === "look") return counterSay("Nothing has that barcode yet (switch to Add to add it).", "bad");
  if (isCode) return found.length ? counterCount(found[0]) : counterNewProduct({ code: text });
  if (found.length === 1) return counterCount(found[0]);
  $(".ct-matches", c.dlg).innerHTML = matchesHtml(inv, text, found);
}

function matchesHtml(inv, typed, matches) {
  if (!typed || looksLikeCode(typed)) return "";
  return matches.map((p) => `<button type="button" class="ct-match" data-product="${p.id}">
      ${p.image ? `<img src="${h(p.image)}" alt="">` : "<span></span>"}${h(fullName(p))}${itemHere(inv, p.id) ? "" : ' <span class="muted small">(new here)</span>'}</button>`).join("") +
    `<button type="button" class="link ct-new-product" data-name="${h(typed)}">+ “${h(typed)}” is a new product…</button>`;
}

// Counts one of a product in or out; something new here goes in place (else the last used).
async function counterCount(p, place = undefined, qty = 1) {
  const c = CT.open, inv = c && inventoryById(c.inv);
  if (!c || c.busy) return;
  c.busy = true;
  try {
    const here = itemHere(inv, p.id);
    if (c.mode === "look") {
      // (Looking up: what it is, and how many there are. Here, its details; else the product.)
      beep("add");
      closeCounter();
      if (here) return openItem(here.id);
      toast(`${p.name} isn't in ${inv.name}.`);
      return openProduct(p.id, inv);
    }
    if (here && !here.used_up && c.mode === "use") return counterSay(`${p.name} is kept, not used up: nothing taken.`, "bad");
    if (place === undefined) place = Number(load(`inventoryPlace${inv.id}`, "")) || null;
    const r = await countIn({ product_id: p.id }, (c.mode === "use" ? -1 : 1) * (qty > 0 ? qty : 1), here ? {} : { location_id: place },
      { quiet: true, inv }).catch(() => null);
    if (!r?.item) return r?.kept ? counterSay(`${p.name} is kept, not used up: nothing taken.`, "bad") : null;
    const where = r.made && r.item.location_id ? ` (in ${placePath(r.item.location_id)})` : "";
    counterSay(r.made ? `＋ ${r.item.name}: ${qtyText(r.item)}, new here${where}` : `${c.mode === "use" ? "−" : "＋"} ${countSaid(r)}`,
      r.made ? "new" : "good", { item: r.item.id, delta: r.before - r.after, made: r.made });
  } finally { c.busy = false; }
}

// Off to Add a product (the camera paused), to come back and count it.
function counterNewProduct(start) {
  const c = CT.open;
  saveDraft("countDraft", { mode: c.mode, code: start.code || "" });
  closeCounter();
  openProductWizard({ ...start, back: true });
}

async function counterSubmitted(e) {
  if (!e.target.matches(".ct-type")) return;
  e.preventDefault();
  const box = $(".ct-code", e.target), text = box.value;
  box.value = "";
  await counterEntry(text);
}

function counterTyped(e) {
  const c = CT.open, t = e.target;
  if (!c) return;
  if (t.matches(".ct-code")) {
    const text = t.value.trim(), inv = inventoryById(c.inv);
    $(".ct-matches", c.dlg).innerHTML = text && !looksLikeCode(text) ? matchesHtml(inv, text, productsFor(inv, text)) : "";
  }
}

async function counterClicked(e) {
  const c = CT.open, b = e.target.closest("button");
  if (!c || !b) return;
  if (b.classList.contains("ct-done")) return closeCounter();
  if (b.classList.contains("ct-sound")) {
    save("inventoryBeep", beepsOn() ? "0" : "1");
    b.textContent = beepsOn() ? "🔊" : "🔇";
    b.setAttribute("aria-label", beepsOn() ? "Turn the beep off" : "Turn the beep on");
    wakeBeeper();
    return beep("add");  // (a sample, when it's turned on)
  }
  if (b.dataset.mode) {
    // (Only what says add, use or look up changes: the camera keeps running.)
    c.mode = b.dataset.mode;
    const m = COUNTER_MODES[c.mode];
    c.dlg.classList.toggle("use", c.mode === "use");
    c.dlg.classList.toggle("look", c.mode === "look");
    c.dlg.querySelectorAll("[data-mode]").forEach((x) => x.classList.toggle("on", x.dataset.mode === c.mode));
    $(".ct-title", c.dlg).textContent = `${m.title} ${inventoryById(c.inv).name}`;
    $(".ct-type button", c.dlg).textContent = m.go;
    const noCode = $(".ct-no-code-p", c.dlg);
    if (noCode) noCode.hidden = c.mode !== "add";
    if (!c.said) $(".ct-said", c.dlg).textContent = counterHint(c);
    return;
  }
  if (b.classList.contains("ct-match")) { $(".ct-code", c.dlg).value = ""; $(".ct-matches", c.dlg).innerHTML = ""; return counterCount(productById(Number(b.dataset.product))); }
  if (b.classList.contains("ct-new-product")) return counterNewProduct({ name: b.dataset.name || "" });
  // (No barcode: straight to what it is, with whatever's typed as its name.)
  if (b.classList.contains("ct-no-code")) return counterNewProduct({ name: $(".ct-code", c.dlg)?.value.trim() || "", noCode: true });
  if (b.classList.contains("ct-goto")) {
    const id = Number(b.dataset.item);
    closeCounter();
    if (S.view !== "inventory") setView("inventory");
    return openItem(id);
  }
  if (b.classList.contains("ct-undo") && c.undo) {
    const u = c.undo;
    c.undo = null;
    if (u.made) {
      // (Something new here: taken out again, as it was.)
      await saveItem(u.item, { deleted: true });
      return counterSay("Undone: taken out again.", "good", null, false);
    }
    const r = await countIn({ item_id: u.item }, u.delta, {}, { quiet: true, inv: inventoryById(c.inv) }).catch(() => null);
    if (r?.item) counterSay(`Undone: ${r.item.name} is ${qtyText(r.item)} again.`, "good", null, false);
  }
}

// ---- Add a product ----
// Steps: 1 its barcode; 2 what it is (looked up: name, brand, size, picture, Walmart page);
// 3 its category, unit, and used up or kept. The lookup's picture is a token the server
// fetches when the product's saved; a photo taken here is uploaded then.

const PW = { state: null, photo: null };  // state: the draft; photo: a File taken (not kept in the draft)

function openProductWizard(start = null) {
  const inv = currentInventory();
  const fresh = start && { step: start.code || start.name || start.link || start.noCode ? 2 : 1, code: start.code || "", name: start.name || "",
    brand: "", size: "", category: "", unit: "", used_up: inv?.kind !== "home", url: "", picture: "", image: "",
    back: !!start.back, looked: false, location: inv ? Number(load(`inventoryPlace${inv.id}`, "")) || null : null };
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
    if (s?.back) openCounter();  // (back to counting, with nothing new)
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
  // (Next is at the top, out from under a phone's keyboard; it submits the form below, so a
  // required name is still asked for.)
  const head = `<form method="dialog" class="dlg-head"><h2>Add a product</h2><button class="icon" aria-label="Close">✕</button></form>
    <div class="pw-top"><div class="pw-steps">${steps}</div>${s.step < 3 ? '<button class="primary pw-next" form="pw-form">Next →</button>' : ""}</div>`;
  let body = "";
  if (s.step === 1) {
    body = `<p>Scan its barcode, or type the number under it.</p>
      <div class="pw-row"><input data-w="code" value="${h(s.code)}" placeholder="Barcode (UPC, or any other kind)" aria-label="Barcode" autocapitalize="characters" enterkeyhint="next">
        <button type="button" class="pw-scan">📷 Scan</button></div>
      <p class="pw-buttons"><button type="button" class="pw-no-code">It has no barcode</button></p>`;
  } else if (s.step === 2) {
    const pic = PW.photo ? URL.createObjectURL(PW.photo) : s.picture;
    body = `${s.looking ? '<p class="pw-looking">Looking it up…</p>' : s.found ? `<p class="muted small">Found at ${h(s.found)}.</p>` : s.looked ? '<p class="muted small">Not found online: type what it is.</p>' : ""}
      ${s.warning ? `<p class="pw-warning">${h(s.warning)}</p>` : ""}
      <div class="pw-what">
        <div class="pw-pic">${pic ? `<img src="${h(pic)}" alt="">` : '<span class="muted small">No picture</span>'}
          <button type="button" class="link small pw-photo">${pic ? "Change" : "+ Photo"}</button></div>
        <div class="pw-fields">
          <label>Name <input data-w="name" value="${h(s.name)}" placeholder="Tomato soup" required></label>
          <label>Brand <input data-w="brand" value="${h(s.brand)}" placeholder="Campbell's"></label>
          <label>Size <input data-w="size" value="${h(s.size)}" placeholder="10.75 oz"></label>
        </div>
      </div>
      <label>Its page at a shop <input data-w="url" class="pw-url" value="${h(s.url)}" type="url" placeholder="Paste a Walmart link (it fills in the rest)"></label>
      ${!s.url && s.find_url ? `<p class="small"><a href="${h(s.find_url)}" target="_blank" rel="noopener noreferrer" class="pw-find">Find it on Walmart ↗</a>
        <span class="muted">(Walmart's pages for this barcode): open the product, then copy its link and paste it above${/Android/.test(navigator.userAgent) ? ", or Share it to Entropicide" : ""}.</span></p>` : ""}
      <p class="pw-buttons"><button type="button" class="link pw-back">← Back</button></p>`;
  } else {
    body = `<p class="pw-summary"><b>${h(s.brand ? `${s.brand} ${s.name}` : s.name)}</b>${s.size ? ` <span class="muted">${h(s.size)}</span>` : ""}</p>
      <h3>Category</h3>${pickChips("category", categoryList(inv), s.category, "Another category")}
      <h3>Counted in</h3>${pickChips("unit", unitList(), s.unit, "Other unit")}
      <h3>It's</h3><div class="iv-chips" data-pick="used_up">
        <button type="button" class="cat-chip${s.used_up ? " on" : ""}" data-value="1">Used up, and bought again</button>
        <button type="button" class="cat-chip${s.used_up ? "" : " on"}" data-value="">Kept (a tool, a ladder)</button></div>
      ${s.back && inv && placeOptions(inv).length ? `<h3>Where it goes in ${h(inv.name)}</h3>
        ${placeField(inv, s.location, 'class="pw-place"')}` : ""}
      <p class="pw-buttons"><button type="button" class="link pw-back">← Back</button>
        ${s.back ? `<span class="pw-add"><button class="primary pw-save">Save, and add</button>
          <span class="pw-stepper"><button type="button" class="pw-qty-less" aria-label="One fewer">−</button>
          <input type="number" class="pw-qty" data-w="qty" min="1" step="any" value="${h(s.qty || 1)}" inputmode="decimal" aria-label="How many to add">
          <button type="button" class="pw-qty-more" aria-label="One more">+</button></span></span>`
          : '<button class="primary pw-save">Save</button>'}</p>`;
  }
  dlg.innerHTML = head + `<form class="pw-body" id="pw-form" autocomplete="off">${body}</form>`;
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
  if (t.classList.contains("pw-place")) {
    PW.state.location = Number(t.value) || null;
    if (PW.state.location) save(`inventoryPlace${currentInventory().id}`, t.value);
    return saveDraft("productDraft", PW.state);
  }
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
  // (Only a UPC or EAN can be looked up: another kind of barcode is just yours, so it goes straight
  // to typing what it is.)
  const r = /^\d{6,14}$/.test(s.code)
    ? await api("GET", `/codes/${encodeURIComponent(s.code)}`, undefined, { quiet: true }).catch(() => null) : null;
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

// Saved (or found already): back to counting it (as many as were said), or just closed.
function productSaved(p) {
  const back = PW.state?.back, place = PW.state?.location ?? null;
  const qty = Number($("#product-wizard .pw-qty")?.value || PW.state?.qty) || 1;
  PW.state.saving = true;
  PW.state = null;
  saveDraft("productDraft", null);
  $("#product-wizard")?.close();
  renderList();
  if (back) openCounter(null, p, place, qty);  // (and they're counted, as the scan that found it would have)
  else toast(`${p.name} is in your products. ＋ Add to inventory counts some in.`);
}

async function productWizardClicked(e) {
  const b = e.target.closest("button"), s = PW.state;
  if (!b || !s) return;
  if (b.classList.contains("pw-qty-less") || b.classList.contains("pw-qty-more")) {
    s.qty = Math.max(1, (Number(s.qty) || 1) + (b.classList.contains("pw-qty-more") ? 1 : -1));
    $("#product-wizard .pw-qty").value = fmtQty(s.qty);
    return saveDraft("productDraft", s);
  }
  if (b.classList.contains("pw-photo")) {
    const file = await takePhoto(`A picture of ${s.name || "it"}`);
    if (file && PW.state === s) { PW.photo = file; s.image = ""; drawProductWizard(); }
    return;
  }
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
        <button type="button" class="link small pd-photo">${p.image ? "Change" : "+ Photo"}</button></div>
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
    if (t.dataset.f) saveProduct({ [t.dataset.f]: t.type === "checkbox" ? t.checked : t.value });
  };
  dlg.onclick = async (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    const chips = b.closest("[data-pick]");
    if (chips && b.dataset.value !== undefined) return saveProduct({ [chips.dataset.pick]: b.dataset.value });
    if (b.classList.contains("pd-photo")) {
      const file = await takePhoto(`A picture of ${p.name}`);
      const r = file && await uploadProductPicture(id, file);
      if (r) { replaceProduct(r); renderList(); openProduct(id, inv); }
      return;
    }
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
      <label>${it.used_up ? "How many left" : "How many"}${shownUnit(it.unit) ? ` (${h(it.unit)})` : ""}
        <span class="ii-stepper"><button type="button" class="ii-less" aria-label="One less">−</button>
        <input type="number" data-f="quantity" min="0" step="any" inputmode="decimal" value="${fmtQty(it.quantity)}">
        <button type="button" class="ii-more" aria-label="One more">+</button></span></label>
      <label>Place ${placeField(inv, it.location_id, 'data-f="location_id"')}</label>
    </div>
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
  const value = f === "tags" ? t.value.split(",").map((x) => x.trim()).filter(Boolean)
    : ["quantity", "keep_at_least", "restock_to"].includes(f) ? (t.value === "" ? null : Number(t.value))
    : f === "location_id" ? (t.value ? Number(t.value) : null) : t.value;
  if (f === "location_id" && value) save(`inventoryPlace${it.inventory_id}`, String(value));
  return saveItem(id, { [f]: value });
}

async function itemClicked(e) {
  const b = e.target.closest("button"), id = Number($("#item-dialog").dataset.item), it = itemById(id);
  if (!b || !it) return;
  if (b.classList.contains("ii-less") || b.classList.contains("ii-more")) {
    return saveItem(id, { quantity: Math.max(0, it.quantity + (b.classList.contains("ii-more") ? 1 : -1)) });
  }
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
  // Press and hold a thing (or right-click it): choosing begins, with it chosen.
  // held: a hold just began choosing, so the click that ends it isn't a tap. (The list is
  // redrawn by then, so that click may never come: held is let go of soon after, and at the
  // next press, so it can't swallow a later tap.)
  let hold = null, held = false;
  const stopHold = () => { clearTimeout(hold); hold = null; };
  list.addEventListener("pointerdown", (e) => {
    held = false;
    const row = S.view === "inventory" && !IV.selecting && e.target.closest(".iv-row");
    if (!row || e.button > 0) return;
    const x = e.clientX, y = e.clientY;
    hold = setTimeout(() => { held = true; navigator.vibrate?.(30); startChoosing(Number(row.dataset.item)); }, 500);
    const moved = (m) => { if (Math.abs(m.clientX - x) + Math.abs(m.clientY - y) > 10) stopHold(); };
    list.addEventListener("pointermove", moved);
    window.addEventListener("pointerup", () => {
      stopHold();
      list.removeEventListener("pointermove", moved);
      if (held) setTimeout(() => { held = false; }, 400);
    }, { once: true });
  });
  list.addEventListener("pointercancel", stopHold);
  list.addEventListener("contextmenu", (e) => {
    const row = S.view === "inventory" && e.target.closest(".iv-row");
    if (!row) return;
    e.preventDefault();
    if (!IV.selecting && !held) startChoosing(Number(row.dataset.item));
  });
  list.addEventListener("click", async (e) => {
    if (S.view !== "inventory") return;
    // (The click that ends a press and hold isn't a tap on the thing.)
    if (held) { held = false; e.preventDefault(); return; }
    if (IV.selecting) {
      const row = e.target.closest(".iv-row");
      if (row) {
        e.preventDefault();
        const id = Number(row.dataset.item);
        if (IV.sel.has(id)) IV.sel.delete(id); else IV.sel.add(id);
        return renderList();
      }
    }
    const b = e.target.closest("button");
    if (!b) return;
    const row = b.closest("[data-item]"), inv = currentInventory();
    if (b.dataset.ivJump !== undefined) {
      const to = b.dataset.ivJump === "top" ? $(".notes-bar", list) : document.getElementById(`ivg-${b.dataset.ivJump}`);
      return to?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    if (b.classList.contains("iv-select")) return startChoosing();
    if (b.classList.contains("iv-sel-done")) { IV.selecting = false; IV.sel.clear(); return renderList(); }
    if (b.classList.contains("iv-sel-none")) { IV.sel.clear(); return renderList(); }
    if (b.classList.contains("iv-sel-all")) { for (const it of shownItems(inv, invItems(inv))) IV.sel.add(it.id); return renderList(); }
    if (b.classList.contains("iv-sel-move")) return moveChosen(inv);
    if (b.classList.contains("iv-sel-delete")) return deleteChosen();
    if (b.classList.contains("iv-look")) return openCounter("look");
    if (b.classList.contains("iv-place-filter")) {
      const id = await pickPlace(inv, IV.place, { title: "Show only what's in", none: false, add: false });
      if (id) { IV.place = id; renderList(); }
      return;
    }
    if (b.classList.contains("iv-place-scan")) {
      return openScanner((code) => {
        const m = code.match(/#location:(\d+)/), l = m && locationById(Number(m[1]));
        if (!l) return m ? "That place isn't in an inventory you can see." : "That isn't a place's label: scan the QR code on the shelf or bin.";
        showPlace(l.id);
        return "stop";
      }, "Scan a place's label");
    }
    if (b.classList.contains("iv-start")) return newInventory(b.dataset.kind);
    if (b.dataset.inventory) { IV.inv = Number(b.dataset.inventory); IV.place = null; IV.selecting = false; IV.sel.clear(); save("inventory", b.dataset.inventory); return renderList(); }
    if (b.classList.contains("iv-new")) {
      return newInventory(confirm("Is it for things used up and bought again (food storage, supplies)?\n\nOK: yes. Cancel: things kept (a home inventory).") ? "stock" : "home");
    }
    if (b.classList.contains("iv-add")) return openCounter("add");
    if (b.classList.contains("iv-use")) return openCounter("use");
    if (b.classList.contains("iv-products")) return openProducts();
    if (b.dataset.filter !== undefined && b.closest(".iv-filters")) { IV.filter = b.dataset.filter; save("inventoryFilter", IV.filter); return renderList(); }
    if (b.classList.contains("iv-all-places")) { IV.place = null; return renderList(); }
    if (b.classList.contains("iv-places")) return openPlaces();
    if (b.classList.contains("iv-labels")) return printLabels(placeOptions(inv).map(([x]) => x));
    if (b.classList.contains("iv-icon")) return chooseIcon("inventories", inv);
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

// ---- choosing several, to move or delete them ----

function startChoosing(id = null) {
  IV.selecting = true;
  IV.sel.clear();
  if (id) IV.sel.add(id);
  renderList();
}

async function changeChosen(changes) {
  const r = await api("POST", "/items/bulk", { ids: [...IV.sel], changes });
  if (!r) return null;
  await refresh();
  return r;
}

async function moveChosen(inv) {
  const n = IV.sel.size;
  const id = await pickPlace(inv, null, { title: `Move ${n} thing${n > 1 ? "s" : ""} to` });
  if (id === undefined) return;
  if (!(await changeChosen({ location_id: id }))) return;
  IV.selecting = false;
  IV.sel.clear();
  renderList();
  toast(`Moved ${n} to ${id ? placePath(id) : "no place"}.`);
}

async function deleteChosen() {
  const ids = [...IV.sel], n = ids.length;
  if (!confirm(`Move ${n} thing${n > 1 ? "s" : ""} to the trash? (The Trash can bring them back.)`)) return;
  if (!(await changeChosen({ deleted: true }))) return;
  IV.selecting = false;
  IV.sel.clear();
  renderList();
  toast(`${n} moved to the trash.`, async () => { await api("POST", "/items/bulk", { ids, changes: { deleted: false } }); await refresh(); });
}

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
