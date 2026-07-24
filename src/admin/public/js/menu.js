import { api } from "./api.js";
import { showToast, esc } from "./utils.js";

let editingItemId = null;

export async function loadMenu() {
  const [cats, menu, cfg] = await Promise.all([api("/categories"), api("/menu"), api("/config")]);
  const catSel = document.getElementById("itCat");
  catSel.innerHTML = cats.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join("");

  renderPublishBar(cfg);

  const el = document.getElementById("menu");
  if (!menu.length) {
    el.innerHTML = '<div class="p-8 text-center text-slate-500 text-xs">No menu items.</div>';
    return;
  }

  el.innerHTML = menu.map(cat => `
    <div class="glass rounded-2xl p-5 border border-slate-900">
      <div class="flex items-center justify-between mb-4 border-b border-slate-900 pb-2.5">
        <h3 class="font-bold text-sm text-slate-200">${esc(cat.name)}</h3>
        <button onclick="window.delCategory(${cat.id})" class="text-[10px] text-rose-500 font-bold uppercase hover:underline">Delete Category</button>
      </div>
      <ul class="divide-y divide-slate-900/60">
        ${cat.items.map(item => renderItem(item)).join("")}
      </ul>
    </div>
  `).join("");
}

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

function stockBadge(stockCount) {
  if (stockCount === null || stockCount === undefined) return "";
  const cls = stockCount === 0
    ? "bg-red-950 text-red-400 border-red-900/40"
    : "bg-amber-950 text-amber-400 border-amber-900/40";
  const label = stockCount === 0 ? "Sold Out" : `Stock: ${stockCount}`;
  return `<span class="text-[9px] px-1.5 py-0.5 rounded font-bold border ${cls}">${label}</span>`;
}

function renderItem(i) {
  const itemJson = esc(JSON.stringify(i));
  return `
    <li class="py-3.5 flex items-start gap-3 flex-wrap">
      ${i.imageUrl ? `<img src="${esc(i.imageUrl)}" class="w-12 h-12 rounded-lg object-cover border border-slate-800 flex-shrink-0" />` : ""}
      <div class="flex-grow min-w-0">
        <div class="flex items-center gap-2 flex-wrap">
          <span class="text-xs font-semibold ${i.available ? "text-slate-100" : "line-through text-slate-500"}">${esc(i.name)}</span>
          ${i.isVeg ? '<span class="text-[9px] bg-green-950 text-green-400 font-bold border border-green-900/40 px-1 rounded">Veg</span>' : ""}
          ${i.spiceLevel ? `<span class="text-[9px] bg-rose-950 text-rose-400 font-bold border border-rose-900/40 px-1 rounded">${esc(i.spiceLevel)}</span>` : ""}
          ${stockBadge(i.stockCount)}
        </div>
        ${i.description ? `<p class="text-[10px] text-slate-400 mt-0.5">${esc(i.description)}</p>` : ""}
      </div>
      <div class="font-mono text-xs text-slate-400 flex-shrink-0">₹${i.price}</div>
      <div class="flex items-center gap-3 flex-shrink-0">
        <label class="text-[10px] uppercase font-bold text-slate-400 flex items-center gap-1.5 cursor-pointer">
          <input type="checkbox" ${i.available ? "checked" : ""}
            onchange="window.toggleAvail(${i.id}, this.checked)"
            class="rounded border-slate-800 bg-slate-900" /> Avail
        </label>
        <button onclick="window.openEditModal(${itemJson})"
          class="text-[10px] text-blue-400 font-bold uppercase hover:underline">Edit</button>
        <button onclick="window.delItem(${i.id})"
          class="text-[10px] text-slate-500 hover:text-rose-500 font-bold uppercase">Delete</button>
      </div>
    </li>`;
}

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

export async function addItem() {
  const stockVal = document.getElementById("itStock").value;
  const body = {
    name: document.getElementById("itName").value.trim(),
    price: document.getElementById("itPrice").value,
    categoryId: document.getElementById("itCat").value,
    description: document.getElementById("itDesc").value.trim() || null,
    spiceLevel: document.getElementById("itSpice").value.trim() || null,
    pieceInfo: document.getElementById("itPieceInfo").value.trim() || null,
    imageUrl: document.getElementById("itImageUrl").value.trim() || null,
    isVeg: document.getElementById("itVeg").checked,
    stockCount: stockVal === "" ? null : Number(stockVal),
  };
  if (!body.name || !body.price || !body.categoryId) {
    showToast("Validation", "Name, price, and category are required.");
    return;
  }
  await api("/items", { method: "POST", body: JSON.stringify(body) });
  ["itName", "itPrice", "itDesc", "itSpice", "itPieceInfo", "itImageUrl", "itStock"].forEach(id => (document.getElementById(id).value = ""));
  document.getElementById("itVeg").checked = false;
  loadMenu();
}

export async function toggleAvail(id, available) {
  await api("/items/" + id, { method: "PUT", body: JSON.stringify({ available }) });
}

export async function delItem(id) {
  if (!confirm("Delete this dish?")) return;
  try {
    await api("/items/" + id, { method: "DELETE" });
    loadMenu();
  } catch (e) {
    let msg = e?.message ?? "Delete failed";
    try { msg = JSON.parse(msg).error ?? msg; } catch {}
    showToast("Cannot Delete", msg);
  }
}

// ── Edit Item Modal ────────────────────────────────────────────────────────

export function openEditModal(item) {
  editingItemId = item.id;
  document.getElementById("edit-id").value = item.id;
  document.getElementById("edit-name").value = item.name;
  document.getElementById("edit-price").value = item.price;
  document.getElementById("edit-stock").value = item.stockCount ?? "";
  document.getElementById("edit-desc").value = item.description || "";
  document.getElementById("edit-spice").value = item.spiceLevel || "";
  document.getElementById("edit-pieceinfo").value = item.pieceInfo || "";
  document.getElementById("edit-imageurl").value = item.imageUrl || "";
  document.getElementById("edit-veg").checked = item.isVeg;
  document.getElementById("edit-modal").classList.remove("hidden");
  loadVariants(item.id);
}

export function closeEditModal() {
  document.getElementById("edit-modal").classList.add("hidden");
  editingItemId = null;
}

export async function saveEditItem() {
  const id = document.getElementById("edit-id").value;
  const stockVal = document.getElementById("edit-stock").value;
  const body = {
    name: document.getElementById("edit-name").value.trim(),
    price: document.getElementById("edit-price").value,
    description: document.getElementById("edit-desc").value.trim() || null,
    spiceLevel: document.getElementById("edit-spice").value.trim() || null,
    pieceInfo: document.getElementById("edit-pieceinfo").value.trim() || null,
    imageUrl: document.getElementById("edit-imageurl").value.trim() || null,
    isVeg: document.getElementById("edit-veg").checked,
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
