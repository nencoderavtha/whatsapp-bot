import { api } from "./api.js";
import { showToast, badge, pmtBadge, esc } from "./utils.js";

// Status flow: each active state knows what button to show.
// "Mark Ready" also books a courier server-side, so there is no separate
// dispatch step to remember; "Call Rider Now" is there to book one earlier.
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

function renderDeliverySection(o) {
  if (o.type !== "delivery") return "";

  const dispatch = o.deliveryDispatch;
  const status = dispatch ? dispatch.status : "NOT_SCHEDULED";
  const providerCode = dispatch ? (dispatch.providerCode || "shiprocket") : "";
  const providerName = providerCode ? "Shiprocket Quick" : "None";
  const fee = o.deliveryFee || (dispatch ? dispatch.deliveryFee : 45);

  const statusLabels = {
    PENDING_KITCHEN: "Cooking in Kitchen",
    SEARCHING_RIDER: "Searching for Rider",
    COURIER_ASSIGNED: "Courier Assigned",
    RIDER_ASSIGNED: "Courier Assigned",
    PICKED_UP: "Parcel Picked Up",
    IN_TRANSIT: "Out for Delivery",
    DELIVERED: "Delivered",
    CANCELLED: "Dispatch Cancelled",
    NOT_SCHEDULED: "Cooking in Kitchen",
  };

  const statusBadges = {
    PENDING_KITCHEN: "bg-amber-950/70 text-amber-400 border-amber-500/30",
    SEARCHING_RIDER: "bg-amber-950/70 text-amber-400 border-amber-500/30",
    COURIER_ASSIGNED: "bg-blue-950/70 text-blue-400 border-blue-500/30",
    RIDER_ASSIGNED: "bg-blue-950/70 text-blue-400 border-blue-500/30",
    PICKED_UP: "bg-indigo-950/70 text-indigo-400 border-indigo-500/30",
    IN_TRANSIT: "bg-purple-950/70 text-purple-400 border-purple-500/30",
    DELIVERED: "bg-emerald-950/70 text-emerald-400 border-emerald-500/30",
    CANCELLED: "bg-rose-950/70 text-rose-400 border-rose-500/30",
    NOT_SCHEDULED: "bg-amber-950/70 text-amber-400 border-amber-500/30",
  };

  const badgeCls = statusBadges[status] || "bg-blue-950/70 text-blue-400 border-blue-500/30";
  const displayStatus = statusLabels[status] || status;

  const riderInfo = dispatch && dispatch.riderName
    ? `<div class="text-[11px] text-slate-200 mt-1 font-medium flex items-center gap-1">👤 Rider: ${esc(dispatch.riderName)} ${dispatch.riderPhone ? `<a href="tel:${esc(dispatch.riderPhone)}" class="text-rose-400 underline font-mono">(${esc(dispatch.riderPhone)})</a>` : ""}</div>`
    : "";

  const trackId = dispatch?.externalDeliveryId && dispatch.externalDeliveryId !== "NOT_DISPATCHED_YET" ? dispatch.externalDeliveryId : null;
  const trackingUrl = trackId
    ? `https://shiprocket.co/tracking/${esc(trackId.replace("SR-", ""))}`
    : "";

  const trackingLink = trackingUrl
    ? `<a href="${trackingUrl}" target="_blank" class="text-[11px] text-rose-400 hover:underline flex items-center gap-1 mt-1 font-mono font-bold">🔗 Track Delivery Courier (${esc(trackId)})</a>`
    : "";

  const isDispatchActive = dispatch && !["NOT_SCHEDULED", "PENDING_KITCHEN", "CANCELLED"].includes(status);

  if (isDispatchActive) {
    return `
      <div class="bg-slate-900/90 rounded-xl p-3 mb-2 border border-blue-500/30 space-y-1.5">
        <div class="flex items-center justify-between gap-2">
          <div class="flex items-center gap-1.5">
            <span class="text-xs">🛵</span>
            <span class="font-bold text-xs text-white">${esc(providerName)}</span>
            <span class="text-[10px] font-mono text-slate-400">(+₹${fee} delivery)</span>
          </div>
          <span class="text-[9px] font-bold px-2 py-0.5 rounded-full border ${badgeCls}">${displayStatus}</span>
        </div>
        ${riderInfo}
        ${trackingLink}
      </div>`;
  }

  return `
    <div class="bg-slate-900/60 rounded-xl p-3 mb-2 border border-slate-800 space-y-1">
      <div class="flex items-center justify-between gap-2">
        <div class="flex items-center gap-1.5">
          <span class="text-xs">🛵</span>
          <span class="font-bold text-xs text-slate-300">Delivery (+₹${fee})</span>
        </div>
        <span class="text-[9px] font-bold px-2 py-0.5 rounded-full border ${badgeCls}">🍳 Cooking in Kitchen</span>
      </div>
      <div class="flex gap-2 pt-1">
        <button onclick="window.dispatchOrderDelivery(${o.id}, 'shiprocket')" class="flex-1 text-[11px] font-bold bg-rose-600 hover:bg-rose-500 text-white px-3 py-1.5 rounded-xl transition-all flex items-center justify-center gap-1.5 shadow-md">
          🛵 Call Rider Now
        </button>
      </div>
      <p class="text-[10px] text-slate-500 leading-snug">
        A rider takes ~10 min to reach the kitchen. Call one while the food is
        finishing — otherwise one is booked automatically on <em>Mark Ready</em>.
      </p>
    </div>`;
}

function renderActions(o) {
  if (["delivered", "cancelled"].includes(o.status)) return "";
  const flow = FLOW[o.status];
  if (!flow) return "";
  const pmt = o.payment;
  const needsPay = pmt && pmt.status !== "paid";

  // Once a courier holds a delivery order, its progress belongs to the rider,
  // not the counter. Marking it delivered by hand would tell the customer their
  // food arrived while it is still on a bike. The rider's own updates arrive on
  // the provider webhook; the override below exists only for when they don't.
  const courierOwnsIt =
    o.type === "delivery" && o.status === "ready" && o.deliveryDispatch;

  const primary = courierOwnsIt
    ? `<div class="flex-1 h-10 px-3 text-[11px] font-semibold rounded-xl bg-slate-900 border border-slate-800 text-slate-400 flex items-center justify-center gap-1.5">
         🛵 Rider updates this order
       </div>
       <button onclick="window.setOrderStatus(${o.id}, 'delivered')"
         class="h-10 px-2.5 text-[10px] font-bold text-slate-400 border border-slate-700 rounded-xl hover:bg-slate-800 transition-all flex-shrink-0"
         title="Override: mark delivered manually if the rider update never arrives">Override</button>`
    : `<button id="action-btn-${o.id}"
        onclick="window.setOrderStatus(${o.id}, '${flow.next}')"
        class="flex-1 h-10 px-3 text-[12px] font-bold rounded-xl transition-all flex items-center justify-center gap-1.5 ${flow.cls}">
        ${flow.icon} ${flow.label}
      </button>`;

  return `
    <div class="flex items-center gap-2 pt-3 border-t border-slate-900/60 mt-2">
      ${primary}
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

  const itemCount = o.items ? o.items.reduce((acc, i) => acc + i.qty, 0) : 0;

  return `
    <div id="order-card-${o.id}" class="glass rounded-2xl p-4 flex flex-col border ${urgency} ${isDone ? "opacity-55" : ""} transition-all shadow-xl">

      <!-- Header: Order ID, Type, Payment, Age -->
      <div class="flex items-start justify-between gap-2 mb-2">
        <div class="flex items-center gap-2 flex-wrap min-w-0">
          <span class="font-black text-slate-100 tracking-tight text-base">#${o.id}</span>
          <span class="text-[10px] font-bold px-2 py-0.5 rounded-full border ${typeClr} uppercase tracking-wide">${o.type}</span>
          ${pmt ? `<span class="text-[10px] px-1.5 py-0.5 rounded-full font-bold border ${pmtBadge(pmt.status)}">${pmt.status}</span>` : ""}
        </div>
        <span class="order-time text-[10px] text-slate-500 flex-shrink-0 font-mono" data-time="${o.createdAt}">${timeAgo(o.createdAt)}</span>
      </div>

      ${renderProgress(o.status)}

      <!-- Customer Summary Header -->
      <div class="bg-slate-950/60 rounded-xl px-3 py-2 mb-2 border border-slate-900/80 flex items-center justify-between">
        <div>
          <div class="font-bold text-xs text-slate-200">${esc(o.customer?.name || "Customer")}</div>
          <div class="font-mono text-[10px] text-slate-500">${esc(o.customer?.phone || "")}</div>
        </div>
        <div class="text-right">
          <div class="font-black text-base text-rose-400">₹${o.total}</div>
          <div class="text-[9px] text-slate-500 font-medium">${itemCount} items</div>
        </div>
      </div>

      <!-- Expandable Details Dropdown -->
      <details class="mb-2 group">
        <summary class="cursor-pointer text-[11px] font-bold text-slate-400 hover:text-slate-200 transition-colors py-1.5 flex items-center justify-between border-t border-b border-slate-900/60 my-1">
          <span class="flex items-center gap-1">📋 View Items, Address & Tracking</span>
          <span class="text-[9px] font-mono text-slate-500 group-open:rotate-180 transition-transform">▼</span>
        </summary>

        <div class="pt-2 space-y-2">
          ${o.deliveryAddress || o.customer?.address ? `<div class="text-[11px] text-slate-300 bg-slate-950/40 p-2 rounded-lg border border-slate-900"><span class="opacity-60">📍 Address: </span>${esc(o.deliveryAddress || o.customer.address)}</div>` : ""}

          ${renderDeliverySection(o)}

          <ul class="space-y-1 text-xs bg-slate-950/40 p-2.5 rounded-xl border border-slate-900">
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

          ${o.note ? `<p class="text-[11px] text-amber-400 bg-amber-950/20 px-2.5 py-2 rounded-lg border border-amber-900/30">📝 ${esc(o.note)}</p>` : ""}
        </div>
      </details>

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

export async function dispatchOrderDelivery(orderId, providerCode = "shiprocket") {
  const card = document.getElementById(`order-card-${orderId}`);
  if (card) card.querySelectorAll("button").forEach(b => { b.disabled = true; });
  try {
    await api(`/orders/${orderId}/dispatch`, {
      method: "POST",
      body: JSON.stringify({ providerCode }),
    });
    showToast("Delivery Dispatched", `Dispatched Order #${orderId} via ${providerCode.toUpperCase()}`);
    await loadOrders();
  } catch (err) {
    showToast("Dispatch Error", "Could not dispatch delivery order.");
    if (card) card.querySelectorAll("button").forEach(b => { b.disabled = false; });
  }
}

window.dispatchOrderDelivery = dispatchOrderDelivery;

export function setOrderFilter(val) {
  const sel = document.getElementById("order-filter");
  if (sel) sel.value = val;

  document.querySelectorAll(".order-filter-btn").forEach(btn => {
    const active = btn.dataset.val === val;
    btn.classList.toggle("bg-slate-700", active);
    btn.classList.toggle("text-white", active);
    btn.classList.toggle("shadow-inner", active);
  });

  loadOrders();
}
