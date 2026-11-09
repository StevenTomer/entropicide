"use strict";

// ---- inventory -------------------------------------------------------------------
// The Inventory page: an inventory's things, by place (or A–Z), and the counter across its top.
// Things used up (soup, batteries) are counted down and up; below their minimum the server
// adds a "Buy …" task to the inventory's shopping project. Things kept (shears, a ladder) have
// a place, and can be lent. Adding 12 cans of soup: type 12, scan its barcode, done. A barcode
// the inventory doesn't know asks once what it is. Scanning uses the camera, with the
// browser's own barcode reader or (where there's none) vendor/barcode; a USB or Bluetooth
// scanner just types into the box. QR labels for places open that place (#location:<id>).
// Loads after app.js and uses its globals.

const IV = {
  inv: Number(load("inventory", "")) || null,
  mode: "add",                                   // add | use
  filter: load("inventoryFilter", ""),           // "" all | low | kept | lent
  layout: load("inventoryLayout", "places"),     // places | names
  place: null,                                   // a place to show alone (from a label)
  pending: null,                                 // a barcode or name not known yet: {code, name, delta}
  choices: null,                                 // things a name matched, to choose from
};
const VENDOR_URL = `${BASE}/static/vendor`;

const inventoryById = (id) => (S.data.inventories || []).find((i) => i.id === id);
const itemById = (id) => (S.data.items || []).find((i) => i.id === id);
const locationById = (id) => (S.data.locations || []).find((l) => l.id === id);
const currentInventory = () => inventoryById(IV.inv) || (S.data.inventories || [])[0] || null;
const invItems = (inv) => (S.data.items || []).filter((i) => i.inventory_id === inv.id);
const isLow = (it) => it.used_up && it.keep_at_least != null && it.quantity < it.keep_at_least;
const fmtQty = (n) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));
const qtyText = (it) => `${fmtQty(it.quantity)}${it.unit ? ` ${it.unit}` : ""}`;

// A place and those it's in: "Basement › Shelf 2 › Blue bin".
function placePath(id) {
  const out = [];
  for (let l = locationById(id); l && !out.includes(l); l = locationById(l.parent_id)) out.push(l);
  return out.reverse().map((l) => l.name).join(" › ");
}

// An inventory's places as a tree, flattened: [[id, name indented]].
function placeOptions(inv) {
  const out = [], places = (S.data.locations || []).filter((l) => l.inventory_id === inv.id);
  const walk = (parent, depth) => {
    for (const l of places.filter((x) => (x.parent_id ?? null) === parent)) {
      out.push([l.id, `${"   ".repeat(depth)}${l.name}`]);
      walk(l.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

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
  <form class="iv-counter" autocomplete="off">
    <span class="iv-mode" role="group" aria-label="Add or use">
      <button type="button" class="${IV.mode === "add" ? "on" : ""}" data-mode="add" title="Scanning adds to what there is">＋ Add</button>
      <button type="button" class="${IV.mode === "use" ? "on" : ""}" data-mode="use" title="Scanning takes from what there is">− Use</button>
    </span>
    <input type="number" class="iv-count" value="1" min="0" step="any" inputmode="decimal" aria-label="How many">
    <input class="iv-code" placeholder="Scan or type a barcode, or a name, and press Enter" aria-label="Barcode or name">
    <button type="button" class="iv-scan" title="Scan barcodes with the camera">📷 Scan</button>
  </form>
  ${pendingHtml(inv)}
  <div class="iv-filters">
    ${[["", `All · ${items.length}`], ["low", `Low · ${low}`], ["kept", "Kept"], ["lent", `Lent · ${lent}`]]
      .map(([f, label]) => `<button type="button" class="cat-chip${IV.filter === f ? " on" : ""}" data-filter="${f}">${label}</button>`).join("")}
    <select class="iv-layout" aria-label="Order">${options([["places", "By place"], ["names", "A–Z"]], IV.layout)}</select>
    ${IV.place ? `<button type="button" class="link iv-all-places">All places (now: ${h(placePath(IV.place))}) ✕</button>` : ""}
  </div>`;
  if (!shown.length) {
    html += `<p class="empty">${items.length ? "Nothing here matches." : "Nothing in it yet. Type how many, then scan a barcode (or type a name) above."}</p>`;
  } else if (IV.layout === "places") {
    const byPlace = new Map();
    for (const it of shown) {
      const key = it.location_id && locationById(it.location_id) ? placePath(it.location_id) : "";
      if (!byPlace.has(key)) byPlace.set(key, []);
      byPlace.get(key).push(it);
    }
    for (const key of [...byPlace.keys()].sort((a, b) => (a === "") - (b === "") || a.localeCompare(b))) {
      html += `<h2 class="group">${h(key || "No place")}</h2>` + byPlace.get(key).map((it) => itemRow(it, false)).join("");
    }
  } else {
    html += shown.map((it) => itemRow(it, true)).join("");
  }
  el.innerHTML = html;
  if (!IV.pending) $(".iv-code", el)?.focus({ preventScroll: true });
}

// What the page shows: the filter, a place (and what's in it), and the search box.
function shownItems(inv, items) {
  const q = S.search.trim().toLowerCase();
  const inPlace = IV.place && new Set([IV.place, ...(S.data.locations || []).filter((l) => placePath(l.id).startsWith(placePath(IV.place) + " ›")).map((l) => l.id)]);
  return items.filter((it) =>
    (!IV.filter || (IV.filter === "low" ? isLow(it) : IV.filter === "kept" ? !it.used_up : !!it.lent_to)) &&
    (!inPlace || inPlace.has(it.location_id)) &&
    (!q || [it.name, ...it.codes, ...it.tags, placePath(it.location_id), it.lent_to || ""].some((t) => t.toLowerCase().includes(q))));
}

function itemRow(it, withPlace) {
  const pic = it.attachments.find((f) => IMAGE_TYPES.includes(f.mime));
  const meta = [
    withPlace && it.location_id ? `<span>${h(placePath(it.location_id))}</span>` : "",
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
    ${pic ? `<img class="iv-thumb" src="${h(fileUrl(pic))}" alt="" loading="lazy">` : '<span class="iv-thumb"></span>'}
    <div class="row-body"><button type="button" class="link iv-open">${h(it.name)}</button>${meta ? `<div class="meta">${meta}</div>` : ""}</div>
    ${count}
  </div>`;
}

// A barcode (or name) not known yet: what is it?
function pendingHtml(inv) {
  if (IV.choices) {
    return `<div class="iv-ask">Which one? ${IV.choices.map((it) => `<button type="button" class="iv-choose" data-item="${it.id}">${h(it.name)}</button>`).join(" ")}
      <button type="button" class="link iv-cancel">Cancel</button></div>`;
  }
  const p = IV.pending;
  if (!p) return "";
  const last = Number(load(`inventoryPlace${inv.id}`, "")) || "";
  return `<form class="iv-ask iv-new-item" autocomplete="off">
    <span>${p.code ? `New barcode <code>${h(p.code)}</code>: what is it?` : "Something new:"}</span>
    <input name="name" value="${h(p.name || "")}" placeholder="Name (e.g. Tomato soup)" required aria-label="Name">
    <input name="unit" placeholder="Unit (cans)" class="iv-unit" aria-label="Unit">
    <select name="location_id" aria-label="Place">${options([["", "No place"], ...placeOptions(inv)], last)}</select>
    <label class="check"><input type="checkbox" name="used_up" ${inv.kind === "home" ? "" : "checked"}> Used up</label>
    <button class="primary">${p.delta < 0 ? "Save" : `Add ${fmtQty(Math.abs(p.delta))}`}</button>
    <button type="button" class="link iv-cancel">Cancel</button>
  </form>`;
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

// The counter: count some of an item (found by code, id or name) in or out.
async function countIn(found, delta, extra = {}) {
  const inv = currentInventory();
  const r = await api("POST", "/items/count", { inventory_id: inv.id, delta, ...found, ...extra });
  if (!r) return null;
  if (r.unknown !== undefined && !r.item) {
    IV.pending = { code: r.unknown, name: found.name || "", delta };
    renderList();
    if (r.unknown && S.data.user.settings?.look_up_codes) {
      const named = await api("GET", `/codes/${encodeURIComponent(r.unknown)}`, undefined, { quiet: true }).catch(() => null);
      const box = $(".iv-new-item input[name=name]");
      if (named?.name && box && !box.value) box.value = named.name;
    }
    $(".iv-new-item input[name=name]")?.focus();
    return r;
  }
  if (r.kept) {
    toast(`“${r.item.name}” is kept, not used up: nothing taken. Open it to lend it or move it.`);
    openItem(r.item.id);
    return r;
  }
  const wasLow = isLow(itemById(r.item.id) || r.item);
  replaceItem(r.item);
  IV.pending = IV.choices = null;
  if (wasLow !== isLow(r.item) || r.made) await refresh(); else renderList();  // (a "Buy …" task came or went)
  const said = r.made ? `Added “${r.item.name}”: ${qtyText(r.item)}` : `${r.item.name}: ${fmtQty(r.before)} → ${qtyText(r.item)}`;
  toast(said, r.made ? null : () => countIn({ item_id: r.item.id }, r.before - r.after));
  return r;
}

// What's typed (or scanned) into the box: a barcode, else a name.
async function counterEntry(text) {
  const inv = currentInventory();
  const n = Number($(".iv-count")?.value);
  const delta = (Number.isFinite(n) && n > 0 ? n : 1) * (IV.mode === "use" ? -1 : 1);
  text = text.trim();
  if (!text) return;
  const resetCount = () => { const c = $(".iv-count"); if (c) c.value = "1"; };
  if (/^\d{6,14}$/.test(text) || invItems(inv).some((it) => it.codes.includes(text))) {
    const r = await countIn({ code: text }, delta);
    if (r && !r.unknown) resetCount();
    return r;
  }
  const words = text.toLowerCase();
  const exact = invItems(inv).filter((it) => it.name.toLowerCase() === words);
  const matches = exact.length ? exact : invItems(inv).filter((it) => it.name.toLowerCase().includes(words));
  if (matches.length === 1) { resetCount(); return countIn({ item_id: matches[0].id }, delta); }
  if (matches.length > 1) { IV.choices = matches.slice(0, 12); IV.choiceDelta = delta; renderList(); return null; }
  IV.pending = { code: "", name: text, delta };
  renderList();
  $(".iv-new-item input[name=name]")?.focus();
  return null;
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

// The counter's Scan: each barcode counted in (or out) as it's read.
function scanToCount() {
  openScanner(async (code) => {
    const place = code.match(/#location:(\d+)/);
    if (place) { showPlace(Number(place[1])); return "stop"; }
    const r = await counterEntry(code);
    if (r?.unknown !== undefined && !r.item) return "stop";  // (it asks what it is)
    if (r?.item && !r.kept) return r.made ? `Added ${r.item.name}` : `${r.item.name}: ${fmtQty(r.before)} → ${qtyText(r.item)}`;
    return r?.kept ? "stop" : "";
  }, IV.mode === "use" ? "Scan what's used" : "Scan what's added");
}

// ---- an item's details ----

function openItem(id) {
  const it = itemById(id);
  if (!it) return;
  const inv = inventoryById(it.inventory_id) || currentInventory();
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
  const pics = it.attachments.filter((f) => IMAGE_TYPES.includes(f.mime));
  const files = it.attachments.filter((f) => !IMAGE_TYPES.includes(f.mime));
  dlg.innerHTML = `<form method="dialog" class="dlg-head"><input class="ii-name" data-f="name" value="${h(it.name)}" aria-label="Name">
      <button class="icon" aria-label="Close">✕</button></form>
    <label class="check"><input type="checkbox" data-f="used_up" ${it.used_up ? "checked" : ""}> Used up, and bought again (else it's kept)</label>
    <div class="two">
      <label>${it.used_up ? "How many left" : "How many"} <input type="number" data-f="quantity" min="0" step="any" value="${fmtQty(it.quantity)}"></label>
      <label>Unit <input data-f="unit" value="${h(it.unit)}" placeholder="cans, lb, rolls"></label>
    </div>
    ${it.used_up ? `<div class="two">
      <label title="Below this, “Buy …” goes on the shopping list">Keep at least <input type="number" data-f="keep_at_least" min="0" step="any" value="${it.keep_at_least ?? ""}" placeholder="none"></label>
      <label title="How many to buy back up to (else the minimum)">Buy back up to <input type="number" data-f="restock_to" min="0" step="any" value="${it.restock_to ?? ""}" placeholder="the minimum"></label>
    </div>` : ""}
    <label>Place <select data-f="location_id">${options([["", "No place"], ...placeOptions(inv), ["new", "New place…"]], it.location_id ?? "")}</select></label>
    <div class="ii-codes"><span>Barcodes</span> ${it.codes.map((c) => `<span class="ii-code"><code>${h(c)}</code><button type="button" class="link ii-code-del" data-code="${h(c)}" aria-label="Remove">✕</button></span>`).join("") || '<span class="muted">none</span>'}
      <button type="button" class="link ii-code-scan">+ Scan one</button> <button type="button" class="link ii-code-type">+ Type one</button></div>
    <label>Tags <input data-f="tags" value="${h(it.tags.join(", "))}" placeholder="comma, separated"></label>
    ${it.used_up ? "" : `<div class="ii-lend">${it.lent_to
      ? `Lent to <b>${h(it.lent_to)}</b>${it.lent_on ? ` on ${h(fmtDate(it.lent_on))}` : ""}. <button type="button" class="ii-returned">It's back</button>`
      : `<button type="button" class="ii-lend-btn">Lend it…</button>`}</div>`}
    <div class="ii-pics">${pics.map((f) => `<img src="${h(fileUrl(f))}" alt="" data-file="${f.id}">`).join("")}
      <label class="link ii-add-pic">+ Photo<input type="file" accept="image/*" capture="environment" hidden></label></div>
    ${files.length ? `<p class="small">${files.map((f) => `<a href="${h(fileUrl(f))}" target="_blank" rel="noopener">📎 ${h(f.name)}</a>`).join(" ")}</p>` : ""}
    <label class="link ii-add-file small">+ Attach a receipt or manual<input type="file" hidden></label>
    <p class="ii-foot"><button type="button" class="danger ii-delete">Move to trash</button></p>`;
  dlg.classList.toggle("read-only", !canChange(it));
  if (!canChange(it)) for (const c of dlg.querySelectorAll("input, select, .ii-foot button, .ii-lend button")) c.disabled = true;
  if (!dlg.open) dlg.showModal();
}

async function saveItem(id, changes) {
  const it = await api("PATCH", `/items/${id}`, changes);
  if (!it) return null;
  const was = itemById(id);
  replaceItem(it);
  if (["used_up", "keep_at_least", "restock_to", "quantity", "lent_to", "deleted"].some((k) => k in changes) &&
      (isLow(was || it) !== isLow(it) || "lent_to" in changes || "used_up" in changes)) await refresh();
  if ($("#item-dialog")?.open && Number($("#item-dialog").dataset.item) === id && !("name" in changes) && !("tags" in changes)) openItem(id);
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
    const name = prompt("Name the new place (e.g. Basement shelf)")?.trim();
    if (!name) { t.value = it.location_id ?? ""; return; }
    const l = await api("POST", "/locations", { inventory_id: it.inventory_id, name });
    if (!l) return;
    S.data.locations.push(l);
    return saveItem(id, { location_id: l.id });
  }
  const value = t.type === "checkbox" ? t.checked : f === "tags" ? t.value.split(",").map((x) => x.trim()).filter(Boolean)
    : ["quantity", "keep_at_least", "restock_to"].includes(f) ? (t.value === "" ? null : Number(t.value))
    : f === "location_id" ? (t.value ? Number(t.value) : null) : t.value;
  if (f === "location_id" && value) save(`inventoryPlace${it.inventory_id}`, String(value));
  return saveItem(id, { [f]: value });
}

async function itemClicked(e) {
  const b = e.target.closest("button"), id = Number($("#item-dialog").dataset.item), it = itemById(id);
  if (!b || !it) return;
  if (b.classList.contains("ii-code-del")) return saveItem(id, { codes: it.codes.filter((c) => c !== b.dataset.code) });
  if (b.classList.contains("ii-code-type")) {
    const code = prompt("The barcode's number")?.trim();
    if (code) saveItem(id, { codes: [...it.codes, code] });
    return;
  }
  if (b.classList.contains("ii-code-scan")) {
    return openScanner(async (code) => { await saveItem(id, { codes: [...(itemById(id)?.codes || []), code] }); return "stop"; }, `A barcode for ${it.name}`);
  }
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
      <ul class="plain iv-place-list">${placeOptions(inv).map(([id, name]) => {
        const l = locationById(id);
        return `<li data-place="${id}"><span class="iv-indent">${h(name.match(/^ */)[0])}</span>
          <input class="pl-name" value="${h(l.name)}" aria-label="Name">
          <select class="pl-parent" aria-label="Inside">${options([["", "(top)"], ...placeOptions(inv).filter(([x]) => x !== id)
            .map(([x, n]) => [x, `in ${n.trim()}`])], l.parent_id ?? "")}</select>
          <button type="button" class="link pl-label">Label</button>
          <button type="button" class="link danger pl-del">Delete</button></li>`;
      }).join("") || '<li class="muted">No places yet.</li>'}</ul>
      <form class="inline pl-add"><input name="name" placeholder="New place" required>
        <select name="parent" aria-label="Inside">${options([["", "(top)"], ...placeOptions(inv).map(([x, n]) => [x, `in ${n.trim()}`])], "")}</select>
        <button>Add</button></form>
      ${places.length ? '<p><button type="button" class="pl-all-labels">Print labels for every place</button></p>' : ""}`;
  };
  draw();
  dlg.onsubmit = async (e) => {
    if (!e.target.matches(".pl-add")) return;
    e.preventDefault();
    const l = await api("POST", "/locations", { inventory_id: inv.id, name: e.target.elements.name.value.trim(),
      parent_id: Number(e.target.elements.parent.value) || null });
    if (l) { S.data.locations.push(l); draw(); }
  };
  dlg.onchange = async (e) => {
    const li = e.target.closest("[data-place]");
    if (!li) return;
    const id = Number(li.dataset.place), changes = e.target.matches(".pl-name") ? { name: e.target.value } : { parent_id: Number(e.target.value) || null };
    const l = await api("PATCH", `/locations/${id}`, changes);
    if (l) { Object.assign(locationById(id), l); draw(); }
    else draw();
  };
  dlg.onclick = async (e) => {
    const b = e.target.closest("button"), id = Number(b?.closest("[data-place]")?.dataset.place);
    if (b?.matches(".pl-label")) printLabels([id]);
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
    if (b.dataset.inventory) { IV.inv = Number(b.dataset.inventory); IV.place = null; IV.pending = IV.choices = null; save("inventory", b.dataset.inventory); return renderList(); }
    if (b.classList.contains("iv-new")) {
      return newInventory(confirm("Is it for things used up and bought again (food storage, supplies)?\n\nOK: yes. Cancel: things kept (a home inventory).") ? "stock" : "home");
    }
    if (b.dataset.mode) { IV.mode = b.dataset.mode; return renderList(); }
    if (b.dataset.filter !== undefined && b.closest(".iv-filters")) { IV.filter = b.dataset.filter; save("inventoryFilter", IV.filter); return renderList(); }
    if (b.classList.contains("iv-all-places")) { IV.place = null; return renderList(); }
    if (b.classList.contains("iv-scan")) return scanToCount();
    if (b.classList.contains("iv-cancel")) { IV.pending = IV.choices = null; return renderList(); }
    if (b.classList.contains("iv-choose")) return countIn({ item_id: Number(b.dataset.item) }, IV.choiceDelta || 1);
    if (b.classList.contains("iv-places")) return openPlaces();
    if (b.classList.contains("iv-labels")) return printLabels(placeOptions(inv).map(([x]) => x));
    if (b.classList.contains("iv-rename")) {
      const name = prompt("Rename the inventory", inv.name)?.trim();
      if (name && await api("PATCH", `/inventories/${inv.id}`, { name })) await refresh();
      return;
    }
    if (b.classList.contains("iv-delete")) {
      const n = invItems(inv).length;
      if (!confirm(`Delete “${inv.name}”${n ? `, and the ${n} thing${n > 1 ? "s" : ""} in it, for good` : ""}? This can't be undone.`)) return;
      await api("DELETE", `/inventories/${inv.id}`);
      IV.inv = null;
      return refresh();
    }
    if (row && b.classList.contains("iv-open")) return openItem(Number(row.dataset.item));
    if (row && (b.classList.contains("iv-minus") || b.classList.contains("iv-plus"))) {
      return countIn({ item_id: Number(row.dataset.item) }, b.classList.contains("iv-plus") ? 1 : -1);
    }
  });
  list.addEventListener("submit", async (e) => {
    if (S.view !== "inventory") return;
    e.preventDefault();
    const f = e.target;
    if (f.matches(".iv-counter")) {
      const box = $(".iv-code", f), text = box.value;
      box.value = "";
      await counterEntry(text);
    } else if (f.matches(".iv-new-item")) {
      const p = IV.pending, el = f.elements;
      if (el.location_id.value) save(`inventoryPlace${currentInventory().id}`, el.location_id.value);
      await countIn({ ...(p.code ? { code: p.code } : {}), name: el.name.value.trim() }, Math.abs(p.delta),
        { unit: el.unit.value.trim(), location_id: Number(el.location_id.value) || null, used_up: el.used_up.checked });
      const c = $(".iv-count"); if (c) c.value = "1";
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
  const got = prompt(`How many ${it.unit || ""} of “${it.name}” did you get?`.replace("  ", " "), fmtQty(need));
  const n = Number(got);
  if (got !== null && n > 0) {
    const r = await api("POST", "/items/count", { inventory_id: it.inventory_id, item_id: it.id, delta: n });
    if (r?.item) replaceItem(r.item);
  }
}
