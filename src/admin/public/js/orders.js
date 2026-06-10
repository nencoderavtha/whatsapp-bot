import { api } from "./api.js";
import { showToast, badge, pmtBadge, esc } from "./utils.js";

// Status flow: each active state knows what button to show
const FLOW = {
  pending:   { next: "confirmed",  label: "Accept Order",  icon: "✓",  cls: "bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 text-white" },
  confirmed: { next: "preparing",  label: "Start Cooking", icon: "🍳", cls: "bg-blue-600 hover:bg-blue-500 active:bg-blue-700 text-white" },
  preparing: { next: "ready",      label: "Mark Ready",    icon: "🔔", cls: "bg-amber-500 hover:bg-amber-400 active:bg-amber-600 text-white" },
  ready:     { next: "delivered",  label: "Delivered",     icon: "✓",  cls: "bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 text-white" },
};

const STATUS_STEPS = ["pending", "confirmed", "preparing", "ready", "delivered"];
let timeInterval = null;

// ── Skeleton ───────────────────────────────────────────────────────────────

function showSkeletons(el, n = 4) {
  el.innerHTML = Array.from({ length: n }, () => `
    <div class="glass rounded-2xl p-4 animate-pulse space-y-3 border border-slate-900">
      <div class="flex gap-2 items-center">
        <div class="h-4 w-8 bg-slate-800 rounded-full"></div>
        <div class="h-4 w-16 bg-slate-800 rounded-full"></div>
        <div class="h-3 w-20 bg-slate-800 rounded-full ml-auto"></div>
      </div>
      <div class="flex items-center gap-1 py-1">
        <div class="w-2 h-2 rounded-full bg-slate-800"></div>
        <div class="flex-1 h-0.5 bg-slate-800"></div>
        <div class="w-2 h-2 rounded-full bg-slate-800"></div>
        <div class="flex-1 h-0.5 bg-slate-800"></div>
        <div class="w-2 h-2 rounded-full bg-slate-800"></div>
        <div class="flex-1 h-0.5 bg-slate-800"></div>
        <div class="w-2 h-2 rounded-full bg-slate-800"></div>
        <div class="flex-1 h-0.5 bg-slate-800"></div>
        <div class="w-2 h-2 rounded-full bg-slate-800"></div>
      </div>
      <div class="bg-slate-900 rounded-xl p-3 space-y-1.5">
        <div class="h-3 w-28 bg-slate-800 rounded"></div>
        <div class="h-3 w-20 bg-slate-800 rounded"></div>
      </div>
      <div class="space-y-1.5">
        <div class="h-3 w-full bg-slate-800 rounded"></div>
        <div class="h-3 w-3/4 bg-slate-800 rounded"></div>
      </div>
      <div class="flex gap-2 pt-1">
        <div class="flex-1 h-10 bg-slate-800 rounded-xl"></div>
        <div class="w-10 h-10 bg-slate-800 rounded-xl"></div>
      </div>
    </div>`).join("");
}

// ── Time helpers ──────────────────────────────────────────────────────────

function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ago`;
}

function ageMins(dateStr) {
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 60000);
}

// ── Render helpers ────────────────────────────────────────────────────────

function renderProgress(status) {
  if (status === "cancelled") {
    return `<div class="flex items-center gap-1.5 mb-3">
      <span class="inline-flex items-center gap-1 text-[10px] font-bold text-rose-400 bg-rose-950/40 px-2.5 py-1 rounded-full border border-rose-500/20">✗ Cancelled</span>
    </div>`;
  }
  const idx = STATUS_STEPS.indexOf(status);
  const dots = STATUS_STEPS.map((step, i) => {
    const done = i < idx;
    const cur  = i === idx;
    const dot  = cur
      ? `<span class="w-2.5 h-2.5 rounded-full bg-rose-500 ring-2 ring-rose-500/30 ring-offset-[1.5px] ring-offset-slate-900 flex-shrink-0" title="${step}"></span>`
      : done
        ? `<span class="w-2 h-2 rounded-full bg-rose-400 flex-shrink-0" title="${step}"></span>`
        : `<span class="w-2 h-2 rounded-full bg-slate-700 flex-shrink-0" title="${step}"></span>`;
    const line = i < STATUS_STEPS.length - 1
      ? `<span class="flex-1 h-px ${i < idx ? "bg-rose-500/50" : "bg-slate-800"}"></span>`
      : "";
    return dot + line;
  }).join("");

  const labels = STATUS_STEPS.map((step, i) => {
    const active = i <= idx;
    return `<span class="text-[9px] font-semibold ${active ? "text-slate-400" : "text-slate-700"} capitalize">${step}</span>`;
  }).join("");

  return `
    <div class="flex items-center mb-1">${dots}</div>
    <div class="flex justify-between mb-3">${labels}</div>`;
}

function renderActions(o) {
  if (["delivered", "cancelled"].includes(o.status)) return "";
  const flow = FLOW[o.status];
  if (!flow) return "";
  const pmt = o.payment;
  const needsPay = pmt && pmt.status !== "paid";
  const spinner = `<svg class="animate-spin w-3.5 h-3.5 flex-shrink-0" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>`;

  return `
    <div class="flex items-center gap-2 pt-3 border-t border-slate-900/60 mt-3">
      <button id="action-btn-${o.id}"
        onclick="window.setOrderStatus(${o.id}, '${flow.next}')"
        class="flex-1 h-10 px-3 text-[12px] font-bold rounded-xl transition-all flex items-center justify-center gap-1.5 ${flow.cls}">
        ${flow.icon} ${flow.label}
      </button>
      ${needsPay
        ? `<button onclick="window.markPaid(${o.id})"
            class="h-10 px-3 text-[11px] font-bold text-emerald-400 border border-emerald-500/30 rounded-xl hover:bg-emerald-950/60 transition-all"
            title="Mark as paid">💰</button>`
        : ""}
      <button id="cancel-btn-${o.id}"
        onclick="window.setOrderStatus(${o.id}, 'cancelled')"
        class="h-10 w-10 text-xs font-bold text-rose-400 border border-rose-500/20 rounded-xl hover:bg-rose-950/60 transition-all flex items-center justify-center flex-shrink-0"
        title="Cancel order">✕</button>
    </div>`;
}

function renderOrder(o) {
  const isDone  = ["delivered", "cancelled"].includes(o.status);
  const age     = ageMins(o.createdAt);
  const urgency = !isDone && age > 30
    ? "border-rose-500/40"
    : !isDone && age > 15
      ? "border-amber-500/25"
      : "border-slate-900";
  const pmt = o.payment;

  const typeClr = o.type === "delivery"
    ? "text-blue-400 bg-blue-500/10 border-blue-500/20"
    : o.type === "dine-in"
      ? "text-purple-400 bg-purple-500/10 border-purple-500/20"
      : "text-slate-400 bg-slate-800/50 border-slate-700/30";

  return `
    <div id="order-card-${o.id}" class="glass rounded-2xl p-4 flex flex-col border ${urgency} ${isDone ? "opacity-55" : ""} transition-all">

      <div class="flex items-start justify-between gap-2 mb-2">
        <div class="flex items-center gap-2 flex-wrap min-w-0">
          <span class="font-black text-slate-100 tracking-tight">#${o.id}</span>
          <span class="text-[10px] font-bold px-2 py-0.5 rounded-full border ${typeClr} uppercase tracking-wide">${o.type}</span>
          ${pmt ? `<span class="text-[10px] px-1.5 py-0.5 rounded-full font-bold border ${pmtBadge(pmt.status)}">${pmt.status}</span>` : ""}
        </div>
        <span class="order-time text-[10px] text-slate-500 flex-shrink-0 font-mono" data-time="${o.createdAt}">${timeAgo(o.createdAt)}</span>
      </div>

      ${renderProgress(o.status)}

      <div class="bg-slate-950/50 rounded-xl px-3 py-2.5 mb-3 border border-slate-900/80">
        <div class="font-bold text-sm text-slate-200 truncate">${esc(o.customer?.name || "Unknown")}</div>
        <div class="font-mono text-[11px] text-slate-500 mt-0.5">${esc(o.customer?.phone || "")}</div>
        ${o.customer?.address ? `<div class="text-[11px] text-slate-400 mt-1.5 pt-1.5 border-t border-slate-900 flex gap-1.5"><span class="opacity-60">📍</span>${esc(o.customer.address)}</div>` : ""}
      </div>

      <ul class="space-y-1 mb-2 flex-grow text-xs">
        ${o.items.map(i => `
          <li class="flex items-baseline justify-between gap-2">
            <span class="text-slate-300 min-w-0 truncate">
              <span class="font-bold text-white">${i.qty}×</span> ${esc(i.nameSnap)}${i.variantSnap ? `<span class="text-slate-500"> (${esc(i.variantSnap)})</span>` : ""}
            </span>
            <span class="font-mono text-slate-500 flex-shrink-0 text-[11px]">₹${i.priceSnap * i.qty}</span>
          </li>
          ${i.note ? `<li class="text-[10px] text-amber-400/80 italic pl-3 truncate">↳ ${esc(i.note)}</li>` : ""}`
        ).join("")}
      </ul>

      ${o.note ? `<p class="text-[11px] text-amber-400 bg-amber-950/20 px-2.5 py-2 rounded-lg border border-amber-900/30 mb-2 truncate">📝 ${esc(o.note)}</p>` : ""}

      <div class="flex items-end justify-between mt-auto">
        <div>
          <p class="text-[10px] text-slate-600 uppercase tracking-wider font-semibold">Total</p>
          <p class="font-black text-xl text-rose-400 leading-tight">₹${o.total}</p>
        </div>
        ${isDone ? `<span class="text-[11px] font-bold pb-0.5 ${o.status === "delivered" ? "text-emerald-500" : "text-rose-400"}">
          ${o.status === "delivered" ? "✓ Delivered" : "✗ Cancelled"}
        </span>` : ""}
      </div>

      ${renderActions(o)}
    </div>`;
}

// ── Main load ────────────────────────────────────────────────────────────

export async function loadOrders() {
  const filter = document.getElementById("order-filter")?.value ?? "";
  const el = document.getElementById("orders");
  if (!el) return;

  if (el.dataset.loaded !== "true") showSkeletons(el);

  try {
    const orders = await api("/orders" + (filter ? "?status=" + filter : ""));
    el.dataset.loaded = "true";
    setPendingBadge(orders.filter(o => o.status === "pending").length);

    if (!orders.length) {
      el.innerHTML = `<div class="col-span-full py-24 text-center">
        <div class="text-5xl mb-4 opacity-20">🍽️</div>
        <p class="text-slate-400 font-semibold">No orders yet</p>
        <p class="text-slate-600 text-xs mt-1.5">Orders from WhatsApp will appear here in real time</p>
      </div>`;
      return;
    }

    el.innerHTML = orders.map(renderOrder).join("");
    startTimeUpdates();
  } catch {
    el.innerHTML = `<div class="col-span-full py-16 text-center text-rose-400 text-sm">
      Failed to load orders.
      <button onclick="window.loadOrders()" class="underline ml-1 hover:text-rose-300 transition-colors">Retry</button>
    </div>`;
  }
}

function setPendingBadge(count) {
  ["orders-pending-badge", "mob-orders-badge"].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = count;
    el.classList.toggle("hidden", count === 0);
  });
}

function startTimeUpdates() {
  if (timeInterval) clearInterval(timeInterval);
  timeInterval = setInterval(() => {
    document.querySelectorAll(".order-time[data-time]").forEach(el => {
      el.textContent = timeAgo(el.dataset.time);
    });
  }, 30_000);
}

// ── Status actions with in-place re-render ────────────────────────────────

export async function setOrderStatus(id, status) {
  const card      = document.getElementById(`order-card-${id}`);
  const actionBtn = document.getElementById(`action-btn-${id}`);

  if (card) card.querySelectorAll("button").forEach(b => { b.disabled = true; });
  if (actionBtn) {
    actionBtn.innerHTML = `<svg class="animate-spin w-3.5 h-3.5 flex-shrink-0" fill="none" viewBox="0 0 24 24">
      <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
      <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
    </svg> Updating…`;
  }

  try {
    const updated = await api(`/orders/${id}/status`, { method: "PUT", body: JSON.stringify({ status }) });
    if (card) {
      const tmp = document.createElement("div");
      tmp.innerHTML = renderOrder(updated);
      card.replaceWith(tmp.firstElementChild);
    }
    // Refresh pending badge count async without blocking
    api("/orders?status=pending").then(p => setPendingBadge(p.length)).catch(() => {});
  } catch {
    showToast("Error", "Could not update order status.");
    await loadOrders();
  }
}

export async function markPaid(orderId) {
  const card = document.getElementById(`order-card-${orderId}`);
  if (card) card.querySelectorAll("button").forEach(b => { b.disabled = true; });
  try {
    await api(`/orders/${orderId}/payment`, { method: "PUT", body: JSON.stringify({ status: "paid" }) });
    showToast("Payment Received", `Order #${orderId} marked as paid.`);
    await loadOrders();
  } catch {
    showToast("Error", "Could not update payment status.");
    if (card) card.querySelectorAll("button").forEach(b => { b.disabled = false; });
  }
}
