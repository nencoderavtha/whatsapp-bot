import { api } from "./api.js";
import { showToast, esc } from "./utils.js";
import { getRole } from "./app.js";

// ── Exports (for app.js to import + re-expose on window for inline onclick/
// onchange/oninput handlers in the dynamically-generated HTML below) ────────
//   loadMenu, onMenuSearchInput, addCategory, delCategory,
//   openAddItemModal, closeAddItemModal, saveAddItem,
//   openEditModal, closeEditModal, saveEditItem,
//   toggleItemAvailability,
//   promptDeleteItem, closeDeleteConfirmModal, confirmDeleteItem,
//   onImageFileSelected, removeImage,
//   loadVariants, addVariant, updateVariant, delVariant,
//   togglePublish
// ─────────────────────────────────────────────────────────────────────────

let editingItemId = null;
let pendingDeleteId = null;
let categoriesCache = [];

const GRID_CLS = "grid grid-cols-1 min-[480px]:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4";
const PLACEHOLDER_HTML = '<span class="text-3xl">🍽️</span>';

// ── Load + render ────────────────────────────────────────────────────────

export async function loadMenu() {
  const isEmployee = getRole() === "employee";
  // Add/Edit/Delete controls are owner-only — hide the whole panel/button for
  // employees rather than merely disabling it.
  document.getElementById("menu-owner-controls")?.classList.toggle("hidden", isEmployee);
  document.getElementById("menu-add-btn")?.classList.toggle("hidden", isEmployee);

  showSkeleton();

  try {
    if (isEmployee) {
      const menu = await api("/menu");
      renderMenuGrid(menu, true);
    } else {
      const [cats, menu, cfg] = await Promise.all([api("/categories"), api("/menu"), api("/config")]);
      categoriesCache = cats;
      populateCategorySelect("add-cat", cats);
      populateCategorySelect("edit-cat", cats);
      renderPublishBar(cfg);
      renderMenuGrid(menu, false);
    }
  } catch (e) {
    hideSkeleton();
    document.getElementById("menu").innerHTML = '<div class="p-8 text-center text-slate-500 text-xs">Failed to load menu.</div>';
  }
}

function showSkeleton() {
  document.getElementById("menu-skeleton")?.classList.remove("hidden");
  document.getElementById("menu-empty")?.classList.add("hidden");
  const el = document.getElementById("menu");
  if (el) el.innerHTML = "";
}

function hideSkeleton() {
  document.getElementById("menu-skeleton")?.classList.add("hidden");
}

function renderMenuGrid(menu, isEmployee) {
  hideSkeleton();
  const el = document.getElementById("menu");
  const emptyEl = document.getElementById("menu-empty");
  const totalItems = menu.reduce((sum, cat) => sum + cat.items.length, 0);

  if (!totalItems) {
    el.innerHTML = "";
    emptyEl?.classList.remove("hidden");
    return;
  }
  emptyEl?.classList.add("hidden");

  el.innerHTML = menu.map(cat => categorySection(cat, isEmployee)).join("");

  // Re-apply an active search filter after a re-render (e.g. after save/delete).
  const searchVal = document.getElementById("menu-search")?.value || "";
  if (searchVal) onMenuSearchInput(searchVal);
}

function categorySection(cat, isEmployee) {
  const cards = cat.items.map(i => itemCard(i, isEmployee)).join("");
  const deleteBtn = isEmployee ? "" : `<button onclick="window.delCategory(${cat.id})" class="text-[10px] text-slate-600 hover:text-rose-500 font-bold uppercase tracking-wide transition-colors">Delete Category</button>`;
  return `
    <div class="menu-cat-section" data-cat-name="${esc(cat.name.toLowerCase())}">
      <div class="flex items-center justify-between mb-3">
        <h3 class="font-bold text-sm text-slate-300">${esc(cat.name)}</h3>
        ${deleteBtn}
      </div>
      <div class="${GRID_CLS}">
        ${cards || '<p class="text-xs text-slate-600 italic col-span-full">No items in this category yet.</p>'}
      </div>
    </div>`;
}

function cardImageHtml(item) {
  return item.imageUrl
    ? `<img src="${esc(item.imageUrl)}" alt="${esc(item.name)}" class="w-full h-full object-cover" loading="lazy" />`
    : `<div class="w-full h-full flex items-center justify-center text-4xl bg-slate-900 text-slate-700">🍽️</div>`;
}

function itemCard(item, isEmployee) {
  const itemJson = esc(JSON.stringify(item));
  const overlay = item.available ? "" : unavailableOverlayHtml();
  const editBtn = isEmployee
    ? ""
    : `<button onclick="window.openEditModal(${itemJson})" class="text-[11px] font-bold text-blue-400 hover:text-blue-300 uppercase tracking-wide">Edit</button>`;

  return `
    <div class="menu-item-card group glass rounded-2xl border border-slate-900 overflow-hidden shadow-lg hover:shadow-xl hover:-translate-y-0.5 hover:scale-[1.02] transition-all duration-200" data-item-id="${item.id}" data-item-name="${esc(item.name.toLowerCase())}">
      <div class="card-image-wrap aspect-square w-full overflow-hidden bg-slate-900 relative">
        ${cardImageHtml(item)}
        ${overlay}
      </div>
      <div class="p-3 flex flex-col gap-2">
        <p class="item-card-name text-xs font-semibold text-slate-200 truncate" title="${esc(item.name)}">${esc(item.name)}</p>
        <div class="flex items-center justify-between gap-2 min-h-[22px]">
          ${editBtn}
          <label class="relative inline-flex items-center cursor-pointer flex-shrink-0 ml-auto" title="Toggle availability">
            <input type="checkbox" class="sr-only peer" ${item.available ? "checked" : ""}
              onchange="window.toggleItemAvailability(${item.id}, this.checked, this)" />
            <div class="w-9 h-5 bg-slate-800 peer-checked:bg-green-600 rounded-full transition-colors"></div>
            <div class="absolute left-0.5 top-0.5 w-4 h-4 bg-white rounded-full transition-transform peer-checked:translate-x-4"></div>
          </label>
        </div>
      </div>
    </div>`;
}

function unavailableOverlayHtml() {
  return '<div class="unavailable-overlay absolute inset-0 bg-slate-950/60 flex items-center justify-center"><span class="text-[10px] font-bold uppercase tracking-wide text-slate-300 bg-slate-950/80 px-2 py-1 rounded">Unavailable</span></div>';
}

// Sync one already-rendered card's visible fields (image, name, availability)
// from a fresh item payload — used by the SSE "menu_updated" handler so that
// another admin session's edit (or this session's own availability-toggle
// echo) updates in place instead of forcing a full loadMenu() reload, which
// is what caused the whole grid to blank-and-rebuild ("blink") on every
// toggle click. Returns false if the card isn't currently rendered (e.g.
// hidden behind an active search filter, or a stale/empty grid) so the
// caller can fall back to a full reload only when it actually needs to.
export function patchMenuItemCard(item) {
  const card = document.querySelector(`.menu-item-card[data-item-id="${item.id}"]`);
  if (!card) return false;

  card.dataset.itemName = item.name.toLowerCase();
  const nameEl = card.querySelector(".item-card-name");
  if (nameEl) { nameEl.textContent = item.name; nameEl.title = item.name; }

  const imgWrap = card.querySelector(".card-image-wrap");
  const currentSrc = imgWrap?.querySelector("img")?.getAttribute("src") || null;
  if (imgWrap && (item.imageUrl || null) !== currentSrc) {
    const overlay = imgWrap.querySelector(".unavailable-overlay");
    imgWrap.innerHTML = cardImageHtml(item) + (overlay ? overlay.outerHTML : "");
  }

  const checkbox = card.querySelector('input[type="checkbox"]');
  if (checkbox) checkbox.checked = !!item.available;
  updateCardAvailabilityUI(card, !!item.available);
  return true;
}

// ── Search ───────────────────────────────────────────────────────────────

export function onMenuSearchInput(value) {
  const q = String(value || "").trim().toLowerCase();
  document.querySelectorAll(".menu-cat-section").forEach(section => {
    const catName = section.dataset.catName || "";
    const catMatches = !q || catName.includes(q);
    let anyVisible = false;
    section.querySelectorAll(".menu-item-card").forEach(card => {
      const itemName = card.dataset.itemName || "";
      const visible = !q || catMatches || itemName.includes(q);
      card.classList.toggle("hidden", !visible);
      if (visible) anyVisible = true;
    });
    section.classList.toggle("hidden", !anyVisible);
  });
}

// ── Availability toggle (both roles) ────────────────────────────────────

export async function toggleItemAvailability(id, available, checkboxEl) {
  const card = checkboxEl?.closest(".menu-item-card");
  updateCardAvailabilityUI(card, available);
  try {
    await api(`/items/${id}/availability`, { method: "PUT", body: JSON.stringify({ available }) });
    showToast(available ? "Available" : "Unavailable", `Item marked ${available ? "available" : "unavailable"}.`);
  } catch (e) {
    if (checkboxEl) checkboxEl.checked = !available;
    updateCardAvailabilityUI(card, !available);
    showToast("Error", "Could not update availability.");
  }
}

function updateCardAvailabilityUI(card, available) {
  if (!card) return;
  const existing = card.querySelector(".unavailable-overlay");
  if (available) {
    existing?.remove();
  } else if (!existing) {
    card.querySelector(".card-image-wrap")?.insertAdjacentHTML("beforeend", unavailableOverlayHtml());
  }
}

// ── Publish bar (unchanged behavior) ────────────────────────────────────

function renderPublishBar(cfg) {
  const el = document.getElementById("daily-publish-bar");
  if (el) el.innerHTML = "";
}

export async function togglePublish(published) {
  try {
    await api("/daily-menu/publish", { method: "PUT", body: JSON.stringify({ published }) });
    showToast(published ? "Published" : "Unpublished", published ? "Bot is now taking orders from today's menu." : "Bot will no longer take orders.");
    loadMenu();
  } catch (e) {
    showToast("Error", "Could not update publish state.");
  }
}

// ── Categories ───────────────────────────────────────────────────────────

export async function addCategory() {
  const name = document.getElementById("catName").value.trim();
  if (!name) return;
  await api("/categories", { method: "POST", body: JSON.stringify({ name }) });
  document.getElementById("catName").value = "";
  loadMenu();
}

export async function delCategory(id) {
  if (!confirm("Delete this category and ALL its dishes?")) return;
  try {
    await api("/categories/" + id, { method: "DELETE" });
    loadMenu();
  } catch (e) {
    let msg = e?.message ?? "Delete failed";
    try { msg = JSON.parse(msg).error ?? msg; } catch {}
    showToast("Cannot Delete", msg);
  }
}

function populateCategorySelect(selectId, cats) {
  const sel = document.getElementById(selectId);
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = cats.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join("");
  if (current && cats.some(c => String(c.id) === current)) sel.value = current;
}

// ── Add Item Modal ───────────────────────────────────────────────────────

export function openAddItemModal() {
  resetAddForm();
  document.getElementById("add-item-modal")?.classList.remove("hidden");
}

export function closeAddItemModal() {
  document.getElementById("add-item-modal")?.classList.add("hidden");
}

function resetAddForm() {
  ["add-name", "add-price", "add-desc", "add-spice", "add-pieceinfo", "add-stock"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  const veg = document.getElementById("add-veg");
  if (veg) veg.checked = false;
  const avail = document.getElementById("add-available");
  if (avail) avail.checked = true;
  const urlEl = document.getElementById("add-img-url");
  if (urlEl) urlEl.value = "";
  setPreview("add", null);
  document.getElementById("add-img-remove-btn")?.classList.add("hidden");
  if (categoriesCache.length) {
    const catSel = document.getElementById("add-cat");
    if (catSel) catSel.value = categoriesCache[0].id;
  }
}

export async function saveAddItem() {
  const name = document.getElementById("add-name").value.trim();
  const price = document.getElementById("add-price").value;
  const categoryId = document.getElementById("add-cat").value;
  if (!name || !price || !categoryId) {
    showToast("Validation", "Name, price, and category are required.");
    return;
  }
  const stockVal = document.getElementById("add-stock").value;
  const body = {
    name,
    price,
    categoryId,
    description: document.getElementById("add-desc").value.trim() || null,
    spiceLevel: document.getElementById("add-spice").value.trim() || null,
    pieceInfo: document.getElementById("add-pieceinfo").value.trim() || null,
    imageUrl: document.getElementById("add-img-url").value.trim() || null,
    isVeg: document.getElementById("add-veg").checked,
    available: document.getElementById("add-available").checked,
    stockCount: stockVal === "" ? null : Number(stockVal),
  };
  try {
    await api("/items", { method: "POST", body: JSON.stringify(body) });
    showToast("Added", "Dish added to the menu.");
    closeAddItemModal();
    loadMenu();
  } catch (e) {
    showToast("Error", "Could not add dish.");
  }
}

// ── Edit Item Modal ──────────────────────────────────────────────────────

export function openEditModal(item) {
  editingItemId = item.id;
  document.getElementById("edit-id").value = item.id;
  document.getElementById("edit-name").value = item.name;
  document.getElementById("edit-price").value = item.price;
  document.getElementById("edit-stock").value = item.stockCount ?? "";
  document.getElementById("edit-desc").value = item.description || "";
  document.getElementById("edit-spice").value = item.spiceLevel || "";
  document.getElementById("edit-pieceinfo").value = item.pieceInfo || "";
  document.getElementById("edit-veg").checked = !!item.isVeg;
  document.getElementById("edit-available").checked = !!item.available;
  const catSel = document.getElementById("edit-cat");
  if (catSel && item.categoryId != null) catSel.value = item.categoryId;
  const urlEl = document.getElementById("edit-img-url");
  if (urlEl) urlEl.value = item.imageUrl || "";
  setPreview("edit", item.imageUrl || null);
  document.getElementById("edit-img-remove-btn")?.classList.toggle("hidden", !item.imageUrl);
  document.getElementById("edit-modal").classList.remove("hidden");
  loadVariants(item.id);
}

export function closeEditModal() {
  document.getElementById("edit-modal").classList.add("hidden");
  editingItemId = null;
}

export async function saveEditItem() {
  const id = document.getElementById("edit-id").value;
  const name = document.getElementById("edit-name").value.trim();
  const price = document.getElementById("edit-price").value;
  const categoryId = document.getElementById("edit-cat").value;
  if (!name || !price || !categoryId) {
    showToast("Validation", "Name, price, and category are required.");
    return;
  }
  const stockVal = document.getElementById("edit-stock").value;
  const body = {
    name,
    price,
    categoryId,
    description: document.getElementById("edit-desc").value.trim() || null,
    spiceLevel: document.getElementById("edit-spice").value.trim() || null,
    pieceInfo: document.getElementById("edit-pieceinfo").value.trim() || null,
    imageUrl: document.getElementById("edit-img-url").value.trim() || null,
    isVeg: document.getElementById("edit-veg").checked,
    available: document.getElementById("edit-available").checked,
    stockCount: stockVal === "" ? null : Number(stockVal),
  };
  try {
    await api("/items/" + id, { method: "PUT", body: JSON.stringify(body) });
    showToast("Updated", "Dish details saved.");
    closeEditModal();
    loadMenu();
  } catch (e) {
    showToast("Error", "Could not save dish.");
  }
}

// ── Delete Item (confirm modal) ─────────────────────────────────────────

export function promptDeleteItem(id, name) {
  pendingDeleteId = id;
  const textEl = document.getElementById("delete-confirm-text");
  if (textEl) textEl.textContent = `Delete "${name}"? This action cannot be undone.`;
  document.getElementById("delete-confirm-modal")?.classList.remove("hidden");
}

export function closeDeleteConfirmModal() {
  document.getElementById("delete-confirm-modal")?.classList.add("hidden");
  pendingDeleteId = null;
}

export async function confirmDeleteItem() {
  if (pendingDeleteId == null) return;
  const id = pendingDeleteId;
  try {
    await api("/items/" + id, { method: "DELETE" });
    showToast("Deleted", "Dish removed from the menu.");
    closeDeleteConfirmModal();
    closeEditModal();
    loadMenu();
  } catch (e) {
    let msg = e?.message ?? "Delete failed";
    try { msg = JSON.parse(msg).error ?? msg; } catch {}
    closeDeleteConfirmModal();
    showToast("Cannot Delete", msg);
  }
}

// ── Image upload widget (shared by Add + Edit modals via an id prefix) ─────
// prefix "add" -> #add-img-preview / #add-img-input / #add-img-url / #add-img-remove-btn
// prefix "edit" -> #edit-img-preview / #edit-img-input / #edit-img-url / #edit-img-remove-btn

function setPreview(prefix, url) {
  const el = document.getElementById(`${prefix}-img-preview`);
  if (!el) return;
  el.innerHTML = url ? `<img src="${esc(url)}" class="w-full h-full object-cover" />` : PLACEHOLDER_HTML;
}

function compressImageFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const maxDim = 800;
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          if (width >= height) {
            height = Math.round(height * (maxDim / width));
            width = maxDim;
          } else {
            width = Math.round(width * (maxDim / height));
            height = maxDim;
          }
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", 0.82));
      };
      img.onerror = () => reject(new Error("Could not read image"));
      img.src = reader.result;
    };
    reader.onerror = () => reject(new Error("Could not read file"));
    reader.readAsDataURL(file);
  });
}

export async function onImageFileSelected(prefix, inputEl) {
  const file = inputEl.files?.[0];
  if (!file) return;

  // Instant local preview while we compress + upload in the background.
  const localUrl = URL.createObjectURL(file);
  setPreview(prefix, localUrl);

  try {
    const dataUrl = await compressImageFile(file);
    const res = await api("/upload/image", { method: "POST", body: JSON.stringify({ dataUrl }) });
    const urlEl = document.getElementById(`${prefix}-img-url`);
    if (urlEl) urlEl.value = res.url;
    setPreview(prefix, res.url);
    document.getElementById(`${prefix}-img-remove-btn`)?.classList.remove("hidden");
    showToast("Image Uploaded", "Photo attached to this item.");
  } catch (e) {
    const urlEl = document.getElementById(`${prefix}-img-url`);
    setPreview(prefix, urlEl?.value || null);
    showToast("Upload Failed", "Could not upload image. Try a smaller photo.");
  } finally {
    URL.revokeObjectURL(localUrl);
    inputEl.value = "";
  }
}

export function removeImage(prefix) {
  const urlEl = document.getElementById(`${prefix}-img-url`);
  if (urlEl) urlEl.value = "";
  setPreview(prefix, null);
  document.getElementById(`${prefix}-img-remove-btn`)?.classList.add("hidden");
}

// ── Variants ───────────────────────────────────────────────────────────────

export async function loadVariants(itemId) {
  const el = document.getElementById("edit-variants");
  el.innerHTML = '<div class="text-xs text-slate-500">Loading...</div>';
  try {
    const variants = await api("/items/" + itemId + "/variants");
    if (!variants.length) {
      el.innerHTML = '<div class="text-xs text-slate-500 italic">No variants — item uses base price</div>';
      return;
    }
    el.innerHTML = variants.map(v => `
      <div class="flex items-center gap-2">
        <input value="${esc(v.name)}" onchange="window.updateVariant(${v.id}, 'name', this.value)"
          class="flex-1 bg-slate-900 border border-slate-800 rounded-lg px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-rose-500" />
        <input value="${v.price}" type="number" onchange="window.updateVariant(${v.id}, 'price', this.value)"
          class="w-20 bg-slate-900 border border-slate-800 rounded-lg px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-rose-500" />
        <label class="flex items-center gap-1 text-[10px] text-slate-400 cursor-pointer">
          <input type="checkbox" ${v.available ? "checked" : ""}
            onchange="window.updateVariant(${v.id}, 'available', this.checked)"
            class="rounded border-slate-800 bg-slate-900" /> Avail
        </label>
        <button onclick="window.delVariant(${v.id})" class="text-[10px] text-rose-500 font-bold">✕</button>
      </div>`).join("");
  } catch (e) {
    el.innerHTML = '<div class="text-xs text-rose-400">Failed to load variants</div>';
  }
}

export async function addVariant() {
  if (!editingItemId) return;
  const name = document.getElementById("var-name").value.trim();
  const price = document.getElementById("var-price").value;
  if (!name || !price) return;
  try {
    await api("/items/" + editingItemId + "/variants", {
      method: "POST",
      body: JSON.stringify({ name, price: Number(price) }),
    });
    document.getElementById("var-name").value = "";
    document.getElementById("var-price").value = "";
    loadVariants(editingItemId);
  } catch (e) {
    showToast("Error", "Could not add variant.");
  }
}

export async function updateVariant(id, field, value) {
  const body = { [field]: field === "price" ? Number(value) : field === "available" ? !!value : value };
  await api("/variants/" + id, { method: "PUT", body: JSON.stringify(body) }).catch(() => {});
}

export async function delVariant(id) {
  await api("/variants/" + id, { method: "DELETE" });
  if (editingItemId) loadVariants(editingItemId);
}
