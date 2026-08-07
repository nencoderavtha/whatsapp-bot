import { api } from "./api.js";
import { showToast, badge, pmtBadge, esc } from "./utils.js";

// Friendly labels for the status badge / progress bar — the backend keeps its
// original status strings ("ready" etc.) for backward compatibility with the
// AI/notification code; only the display text changes.
const STATUS_STEPS = ["pending", "confirmed", "preparing", "ready", "delivered"];
const STEP_LABELS = { pending: "Pending", confirmed: "Confirmed", preparing: "Preparing", ready: "Dispatched", delivered: "Delivered" };
const STATUS_LABELS = {
  pending: "Pending", confirmed: "Preparing", preparing: "Preparing",
  ready: "Dispatched", delivered: "Delivered", rejected: "Rejected", cancelled: "Cancelled",
};

let timeInterval = null;
// Customer for whichever order is currently open in the detail modal — lets
// the "Open Chat" button jump straight to that customer's thread without a
// round-trip fetch (openOrderDetail already has the full order+customer).
let currentDetailCustomer = null;

// ── Search / filter / sort state ────────────────────────────────────────────
let currentSearch = "";
let currentFilter = "all"; // all | today | preparing | ready | delivered | rejected | refunded
let currentSort = "newest"; // newest | oldest | highest | lowest
let searchDebounceTimer = null;
let rejectingOrderId = null;

function buildQuery() {
  const params = new URLSearchParams();
  if (currentSearch) params.set("search", currentSearch);
  if (currentSort && currentSort !== "newest") params.set("sort", currentSort);
  if (currentFilter === "today") params.set("dateFilter", "today");
  else if (currentFilter === "preparing") params.set("status", "preparing");
  else if (currentFilter === "ready") params.set("status", "ready");
  else if (currentFilter === "delivered") params.set("status", "delivered");
  else if (currentFilter === "rejected" || currentFilter === "refunded") params.set("status", "rejected");
  return params.toString();
}

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

function typeLabel(type) {
  // Client wording: only "delivery" is called Delivery — pickup/dine-in are "Walk-in".
  return type === "delivery" ? "Delivery" : "Walk-in";
}

// ── Render helpers ────────────────────────────────────────────────────────

function renderProgress(status) {
  if (status === "cancelled" || status === "rejected") {
    const label = status === "rejected" ? "Rejected" : "Cancelled";
    return `<div class="flex items-center gap-1.5 mb-3">
      <span class="inline-flex items-center gap-1 text-[10px] font-bold text-rose-400 bg-rose-950/40 px-2.5 py-1 rounded-full border border-rose-500/20">✗ ${label}</span>
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
    return `<span class="text-[9px] font-semibold ${active ? "text-slate-400" : "text-slate-700"}">${STEP_LABELS[step] || step}</span>`;
  }).join("");

  return `
    <div class="flex items-center mb-1">${dots}</div>
    <div class="flex justify-between mb-3">${labels}</div>`;
}

function renderRefundLine(o) {
  if (o.status !== "rejected" || !o.refundStatus || o.refundStatus === "none") return "";
  const map = {
    pending: { label: "Refund Pending", cls: "text-amber-400" },
    success: { label: "Refund Success", cls: "text-green-400" },
    failed:  { label: "Refund Failed", cls: "text-red-400" },
  };
  const info = map[o.refundStatus];
  if (!info) return "";
  return `<div class="mb-2 text-[11px] font-bold ${info.cls}">💳 ${info.label}</div>`;
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

  // Tracking link/courier ID is intentionally not shown on the compact card
  // — "View Full Details" (renderOrderDetailContent) has the live trackingUrl.
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
        finishing — otherwise one is booked automatically on <em>Dispatch</em>.
      </p>
    </div>`;
}

// ── Action buttons per order state ─────────────────────────────────────────

function actionBar(...buttons) {
  const html = buttons.filter(Boolean).join("");
  if (!html) return "";
  return `<div class="flex items-center gap-2 pt-3 border-t border-slate-900/60 mt-2">${html}</div>`;
}

function payButton(o) {
  const pmt = o.payment;
  if (!pmt || pmt.status === "paid") return "";
  return `<button onclick="window.markPaid(${o.id})"
    class="h-10 px-3 text-[11px] font-bold text-emerald-400 border border-emerald-500/30 rounded-xl hover:bg-emerald-950/60 transition-all"
    title="Mark as paid">💰</button>`;
}

function acceptButton(o) {
  return `<button id="action-btn-${o.id}" onclick="window.setOrderStatus(${o.id}, 'confirmed')"
    class="flex-1 h-10 px-3 text-[12px] font-bold rounded-xl transition-all flex items-center justify-center gap-1.5 bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 text-white">
    ✓ Accept
  </button>`;
}

function dispatchButton(o) {
  // "ready" is the existing backend status for the dispatched stage — reused
  // as-is (auto-dispatch + AI notification code already key off "ready").
  return `<button id="action-btn-${o.id}" onclick="window.setOrderStatus(${o.id}, 'ready')"
    class="flex-1 h-10 px-3 text-[12px] font-bold rounded-xl transition-all flex items-center justify-center gap-1.5 bg-amber-500 hover:bg-amber-400 active:bg-amber-600 text-white">
    🔔 Dispatch
  </button>`;
}

function rejectButton(o) {
  return `<button onclick="window.openRejectModal(${o.id})"
    class="h-10 px-4 text-[12px] font-bold rounded-xl border border-rose-500/30 text-rose-400 hover:bg-rose-950/60 transition-all">
    ✕ Reject
  </button>`;
}

// Note: no trackDeliveryButton on the compact card by design — the tracking
// link only appears in "View Full Details" (renderOrderDetailContent below).

function callRiderButton(o) {
  return `<button onclick="window.dispatchOrderDelivery(${o.id}, 'shiprocket')"
    class="h-10 px-3 text-[12px] font-bold rounded-xl transition-all flex items-center justify-center gap-1.5 bg-rose-600 hover:bg-rose-500 text-white">
    🛵 Call Rider
  </button>`;
}

function markDeliveredButton(o) {
  // Walk-in (pickup/dine-in) orders have no courier/webhook to auto-complete
  // them — staff need a manual way to close these out once handed over.
  return `<button id="action-btn-${o.id}" onclick="window.setOrderStatus(${o.id}, 'delivered')"
    class="flex-1 h-10 px-3 text-[12px] font-bold rounded-xl transition-all flex items-center justify-center gap-1.5 bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 text-white">
    ✓ Mark Picked Up
  </button>`;
}

function renderActions(o) {
  if (["delivered", "cancelled", "rejected"].includes(o.status)) return "";
  if (o.status === "pending") return actionBar(acceptButton(o), rejectButton(o), payButton(o));
  if (o.status === "confirmed" || o.status === "preparing") return actionBar(dispatchButton(o), rejectButton(o), payButton(o));
  if (o.status === "ready") {
    // Delivery orders: manual re-dispatch (tracking link lives in View Full
    // Details, not the compact card). Walk-in orders (pickup/dine-in): no
    // courier involved, so give staff a manual complete action instead —
    // otherwise these orders get stuck at "Dispatched" forever.
    return o.type === "delivery"
      ? actionBar(callRiderButton(o), payButton(o))
      : actionBar(markDeliveredButton(o), payButton(o));
  }
  return "";
}

// ── Order card ───────────────────────────────────────────────────────────

function renderOrder(o) {
  const isDone  = ["delivered", "cancelled", "rejected"].includes(o.status);
  const age     = ageMins(o.createdAt);
  const urgency = !isDone && age > 30
    ? "border-rose-500/40"
    : !isDone && age > 15
      ? "border-amber-500/25"
      : "border-slate-900";
  const pmt = o.payment;

  const typeClr = o.type === "delivery"
    ? "text-blue-400 bg-blue-500/10 border-blue-500/20"
    : "text-purple-400 bg-purple-500/10 border-purple-500/20";

  const itemCount = o.items ? o.items.reduce((acc, i) => acc + i.qty, 0) : 0;

  const badges = o.couponCode || o.loyaltyPointsApplied > 0
    ? `<div class="flex items-center gap-1.5 flex-wrap mb-2">
        ${o.couponCode ? `<span class="text-[9px] font-bold px-2 py-0.5 rounded-full bg-purple-500/10 text-purple-400 border border-purple-500/20">🏷️ ${esc(o.couponCode)}</span>` : ""}
        ${o.loyaltyPointsApplied > 0 ? `<span class="text-[9px] font-bold px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20">⭐ ${o.loyaltyPointsApplied} pts applied</span>` : ""}
      </div>`
    : "";

  return `
    <div id="order-card-${o.id}" class="glass rounded-2xl p-4 flex flex-col border ${urgency} ${isDone ? "opacity-55" : ""} transition-all shadow-xl">

      <!-- Header: Order ID, Type, Status, Payment, Age -->
      <div class="flex items-start justify-between gap-2 mb-2">
        <div class="flex items-center gap-2 flex-wrap min-w-0">
          <span class="font-black text-slate-100 tracking-tight text-base">#${o.tokenNumber ?? o.id}</span>
          <span class="text-[10px] font-bold px-2 py-0.5 rounded-full border ${typeClr} uppercase tracking-wide">${typeLabel(o.type)}</span>
          <span class="text-[10px] font-bold px-2 py-0.5 rounded-full border ${badge(o.status)}">${STATUS_LABELS[o.status] || o.status}</span>
          ${pmt ? `<span class="text-[10px] px-1.5 py-0.5 rounded-full font-bold border ${pmtBadge(pmt.status)}">${pmt.status}${pmt.method ? " · " + esc(pmt.method) : ""}</span>` : ""}
        </div>
        <span class="order-time text-[10px] text-slate-500 flex-shrink-0 font-mono" data-time="${o.createdAt}">${timeAgo(o.createdAt)}</span>
      </div>

      ${renderProgress(o.status)}
      ${renderRefundLine(o)}

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

      ${badges}

      <!-- View Full Details (fetches GET /api/orders/:id lazily) -->
      <button onclick="window.openOrderDetail(${o.id})"
        class="w-full text-left cursor-pointer text-[11px] font-bold text-slate-400 hover:text-slate-200 transition-colors py-1.5 flex items-center justify-between border-t border-b border-slate-900/60 my-1">
        <span class="flex items-center gap-1">📋 View Full Details</span>
        <span class="text-[9px] font-mono text-slate-500">▸</span>
      </button>

      <div class="pt-1 space-y-2">
        <!-- Address is intentionally not shown on the compact card — open
             "View Full Details" for it (renderOrderDetailContent). -->
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

        <div class="flex justify-between text-[10px] text-slate-500 px-1">
          <span>Subtotal ₹${o.subtotal}</span>
          ${o.type === "delivery" ? `<span>Delivery ₹${o.deliveryFee}</span>` : ""}
        </div>

        ${o.note ? `<p class="text-[11px] text-amber-400 bg-amber-950/20 px-2.5 py-2 rounded-lg border border-amber-900/30">📝 ${esc(o.note)}</p>` : ""}
      </div>

      ${renderActions(o)}
    </div>`;
}

// ── Order detail modal (fed by GET /api/orders/:id, fetched lazily) ────────

function renderOrderDetailContent(o) {
  const phone = o.customer?.phone || "";
  const dispatch = o.deliveryDispatch;
  const trackingUrl = dispatch?.trackingUrl && dispatch.trackingUrl.startsWith("https://") ? dispatch.trackingUrl : null;

  return `
    <div class="space-y-5">
      <div class="flex items-center justify-between gap-2">
        <h3 class="text-lg font-bold">Order #${o.tokenNumber ?? o.id}</h3>
        <span class="text-[10px] font-bold px-2 py-0.5 rounded-full border ${badge(o.status)}">${STATUS_LABELS[o.status] || o.status}</span>
      </div>

      <section>
        <h4 class="text-[11px] font-bold uppercase text-slate-500 mb-2">Customer Information</h4>
        <div class="bg-slate-950/40 rounded-xl p-3 border border-slate-900 space-y-1 text-xs text-slate-300">
          <div><span class="text-slate-500">Name: </span>${esc(o.customer?.name || "Customer")}</div>
          <div><span class="text-slate-500">Phone: </span><span class="font-mono">${esc(phone)}</span></div>
          ${(o.deliveryAddress || o.customer?.address) ? `<div><span class="text-slate-500">Address: </span>${esc(o.deliveryAddress || o.customer.address)}</div>` : ""}
        </div>
      </section>

      <section>
        <h4 class="text-[11px] font-bold uppercase text-slate-500 mb-2">Ordered Items</h4>
        <ul class="bg-slate-950/40 rounded-xl p-3 border border-slate-900 space-y-2 text-xs">
          ${o.items.map(i => `
            <li>
              <div class="flex justify-between gap-2">
                <span class="text-slate-200"><span class="font-bold">${i.qty}×</span> ${esc(i.nameSnap)}${i.variantSnap ? `<span class="text-slate-500"> (${esc(i.variantSnap)})</span>` : ""}</span>
                <span class="font-mono text-slate-400">₹${i.priceSnap * i.qty}</span>
              </div>
              ${i.note ? `<div class="text-[10px] text-amber-400/80 italic">↳ ${esc(i.note)}</div>` : ""}
            </li>`).join("")}
        </ul>
      </section>

      <section>
        <h4 class="text-[11px] font-bold uppercase text-slate-500 mb-2">Price Breakdown</h4>
        <div class="bg-slate-950/40 rounded-xl p-3 border border-slate-900 space-y-1.5 text-xs">
          <div class="flex justify-between text-slate-300"><span>Subtotal</span><span class="font-mono">₹${o.subtotal}</span></div>
          ${o.deliveryFee ? `<div class="flex justify-between text-slate-300"><span>Delivery Fee</span><span class="font-mono">₹${o.deliveryFee}</span></div>` : ""}
          ${o.discountTotal ? `<div class="flex justify-between text-green-400"><span>Discount</span><span class="font-mono">-₹${o.discountTotal}</span></div>` : ""}
          ${o.couponCode ? `<div class="flex justify-between text-purple-400"><span>Coupon (${esc(o.couponCode)})</span><span class="font-mono">Applied</span></div>` : ""}
          ${o.loyaltyPointsApplied > 0 ? `<div class="flex justify-between text-amber-400"><span>Loyalty Points (${o.loyaltyPointsApplied} pts)</span><span class="font-mono">-₹${o.loyaltyDiscount}</span></div>` : ""}
          <div class="flex justify-between text-slate-100 font-bold pt-1.5 border-t border-slate-800"><span>Total</span><span class="font-mono">₹${o.total}</span></div>
        </div>
      </section>

      <section>
        <h4 class="text-[11px] font-bold uppercase text-slate-500 mb-2">Payment</h4>
        <div class="bg-slate-950/40 rounded-xl p-3 border border-slate-900 space-y-1.5 text-xs text-slate-300">
          <div><span class="text-slate-500">Status: </span><span class="px-1.5 py-0.5 rounded-full font-bold border ${pmtBadge(o.payment?.status)}">${esc(o.payment?.status || "—")}</span></div>
          <div><span class="text-slate-500">Method: </span>${esc(o.payment?.method || "—")}</div>
          ${o.payment?.reference ? `<div><span class="text-slate-500">Reference: </span><span class="font-mono">${esc(o.payment.reference)}</span></div>` : ""}
        </div>
      </section>

      ${o.type === "delivery" ? `
      <section>
        <h4 class="text-[11px] font-bold uppercase text-slate-500 mb-2">Delivery Information</h4>
        <div class="bg-slate-950/40 rounded-xl p-3 border border-slate-900 space-y-1 text-xs text-slate-300">
          <div><span class="text-slate-500">Provider: </span>${esc(dispatch?.providerCode || "—")}</div>
          ${trackingUrl ? `<div><a href="${esc(trackingUrl)}" target="_blank" rel="noopener" class="text-rose-400 underline font-bold">🔗 Track Delivery</a></div>` : ""}
          ${dispatch?.riderName ? `<div><span class="text-slate-500">Rider: </span>${esc(dispatch.riderName)}</div>` : ""}
          ${dispatch?.riderPhone ? `<div><span class="text-slate-500">Rider Phone: </span><span class="font-mono">${esc(dispatch.riderPhone)}</span></div>` : ""}
          ${dispatch?.riderVehicleNumber ? `<div><span class="text-slate-500">Vehicle: </span>${esc(dispatch.riderVehicleNumber)}</div>` : ""}
        </div>
      </section>` : ""}

      ${o.rejectionReason ? `<div class="text-xs text-rose-400 bg-rose-950/20 border border-rose-900/30 rounded-xl p-3">Rejection reason: ${esc(o.rejectionReason)}</div>` : ""}

      ${o.customer?.id
        ? `<button onclick="window.openChatFromOrder()"
            class="block w-full text-center py-3.5 gradient-btn text-white rounded-xl text-sm font-bold">💬 Open Chat</button>`
        : `<p class="text-center text-xs text-slate-500 py-3">No conversation available for this order.</p>`}
    </div>`;
}

export async function openOrderDetail(id) {
  const modal = document.getElementById("order-detail-modal");
  const body = document.getElementById("order-detail-body");
  if (!modal || !body) return;
  modal.classList.remove("hidden");
  body.innerHTML = `<div class="text-center text-slate-500 text-sm py-12">Loading…</div>`;
  try {
    const order = await api(`/orders/${id}`);
    currentDetailCustomer = order.customer || null;
    body.innerHTML = renderOrderDetailContent(order);
  } catch (e) {
    currentDetailCustomer = null;
    body.innerHTML = `<div class="text-center text-rose-400 text-sm py-12">Failed to load order details.</div>`;
  }
}

export function closeOrderDetailModal() {
  document.getElementById("order-detail-modal")?.classList.add("hidden");
}

// Orders → View Full Details → Open Chat: jump straight to this order's
// customer thread on the Chats tab instead of redirecting out to WhatsApp.
// Passes the already-fetched customer as a hint so the thread (name/phone/
// handoff state) renders immediately even if the Chats tab has never loaded
// this session — see selectConversation() in livechat.js for why that matters.
export function openChatFromOrder() {
  if (!currentDetailCustomer?.id) {
    showToast("No Conversation", "This order has no linked customer conversation.");
    return;
  }
  const customer = currentDetailCustomer;
  closeOrderDetailModal();
  window.jumpToChat?.(customer.id, customer);
}

// ── Reject modal ────────────────────────────────────────────────────────────

export function openRejectModal(id) {
  rejectingOrderId = id;
  const modal = document.getElementById("reject-modal");
  if (!modal) return;
  modal.querySelectorAll('input[name="reject-reason"]').forEach(r => { r.checked = false; });
  const otherText = document.getElementById("reject-other-text");
  if (otherText) otherText.value = "";
  document.getElementById("reject-other-wrap")?.classList.add("hidden");
  modal.classList.remove("hidden");
}

export function closeRejectModal() {
  document.getElementById("reject-modal")?.classList.add("hidden");
  rejectingOrderId = null;
}

export function onRejectReasonChange(value) {
  document.getElementById("reject-other-wrap")?.classList.toggle("hidden", value !== "Other");
}

export async function confirmReject() {
  if (!rejectingOrderId) return;
  const checked = document.querySelector('input[name="reject-reason"]:checked');
  if (!checked) { showToast("Validation", "Select a reason."); return; }

  let reason = checked.value;
  if (reason === "Other") {
    reason = document.getElementById("reject-other-text")?.value.trim() ?? "";
    if (!reason) { showToast("Validation", "Enter a reason."); return; }
  }

  const id = rejectingOrderId;
  const btn = document.getElementById("reject-confirm-btn");
  if (btn) { btn.disabled = true; btn.textContent = "Rejecting…"; }

  try {
    const updated = await api(`/orders/${id}/reject`, { method: "POST", body: JSON.stringify({ reason }) });
    closeRejectModal();
    const refundNote =
      updated.refundStatus === "success" ? " — refund issued." :
      updated.refundStatus === "failed"  ? " — refund failed, handle manually." :
      updated.refundStatus === "pending" ? " — refund pending." : "";
    showToast("Order Rejected", `Order #${id} rejected${refundNote}`);

    const card = document.getElementById(`order-card-${id}`);
    if (card) {
      const tmp = document.createElement("div");
      tmp.innerHTML = renderOrder(updated);
      card.replaceWith(tmp.firstElementChild);
    } else {
      loadOrders();
    }
    api("/orders?status=pending").then(p => setPendingBadge(p.length)).catch(() => {});
  } catch (e) {
    showToast("Error", "Could not reject order.");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Confirm Reject"; }
  }
}

// ── Main load ────────────────────────────────────────────────────────────

export async function loadOrders() {
  const el = document.getElementById("orders");
  if (!el) return;

  if (el.dataset.loaded !== "true") showSkeletons(el);

  try {
    const qs = buildQuery();
    let orders = await api("/orders" + (qs ? "?" + qs : ""));

    // There is no backend query param for refundStatus. Refunds only ever
    // happen as a side effect of rejecting a paid order, so the "Refunded"
    // pill fetches the rejected-orders page and filters client-side for a
    // successful refund rather than adding a one-off backend filter.
    if (currentFilter === "refunded") {
      orders = orders.filter(o => o.refundStatus === "success");
    }

    el.dataset.loaded = "true";

    if (!orders.length) {
      el.innerHTML = `<div class="col-span-full py-24 text-center">
        <div class="text-5xl mb-4 opacity-20">🍽️</div>
        <p class="text-slate-400 font-semibold">No orders found</p>
        <p class="text-slate-600 text-xs mt-1.5">Try a different filter or search term</p>
      </div>`;
    } else {
      el.innerHTML = orders.map(renderOrder).join("");
      startTimeUpdates();
    }

    // Pending badge always reflects the true global count, independent of
    // whatever filter/search/sort is currently applied to the visible list.
    api("/orders?status=pending").then(p => setPendingBadge(p.length)).catch(() => {});
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

// ── Search / filter / sort controls ─────────────────────────────────────────

export function onOrderSearchInput(value) {
  currentSearch = value.trim();
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => loadOrders(), 300);
}

export function setOrderFilter(val) {
  currentFilter = val;
  document.querySelectorAll(".order-filter-btn").forEach(btn => {
    const active = btn.dataset.val === val;
    btn.classList.toggle("bg-slate-700", active);
    btn.classList.toggle("text-white", active);
    btn.classList.toggle("shadow-inner", active);
  });
  loadOrders();
}

export function setOrderSort(val) {
  currentSort = val;
  loadOrders();
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
