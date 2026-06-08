import { api } from "./api.js";
import { showToast, badge, pmtBadge } from "./utils.js";

const STATUSES = ["pending", "confirmed", "preparing", "ready", "delivered", "cancelled"];

export async function loadOrders() {
  const filter = document.getElementById("order-filter")?.value ?? "";
  const orders = await api("/orders" + (filter ? "?status=" + filter : ""));
  const el = document.getElementById("orders");
  if (!orders.length) {
    el.innerHTML = '<div class="col-span-full py-16 text-center text-slate-500">No orders found.</div>';
    return;
  }
  el.innerHTML = orders.map(renderOrder).join("");
}

function renderOrder(o) {
  const pmt = o.payment;
  const pmtBadgeHtml = pmt
    ? `<span class="text-[10px] px-1.5 py-0.5 rounded-full font-bold ${pmtBadge(pmt.status)}">${pmt.status}</span>`
    : "";
  const markPaidBtn = pmt && pmt.status !== "paid"
    ? `<button onclick="window.markPaid(${o.id})" class="text-[10px] text-green-400 border border-green-500/30 px-2 py-1 rounded-lg hover:bg-green-950 transition-all">✓ Mark Paid</button>`
    : "";
  return `
    <div class="glass rounded-2xl p-5 hover:border-slate-800 transition-all flex flex-col">
      <div class="flex items-center gap-2 mb-3 flex-wrap">
        <span class="font-extrabold text-slate-300 text-sm">#${o.id}</span>
        <span class="text-[10px] uppercase font-bold px-2 py-0.5 rounded-full ${badge(o.status)}">${o.status}</span>
        <span class="text-[10px] text-slate-500 uppercase font-bold">${o.type}</span>
        ${pmtBadgeHtml}
        <span class="ml-auto text-[10px] text-slate-500">${new Date(o.createdAt).toLocaleTimeString()}</span>
      </div>
      <div class="text-xs text-slate-300 mb-4 bg-slate-950/40 p-3 rounded-xl border border-slate-900">
        <div class="font-bold text-slate-200">${o.customer?.name || "(Unknown)"}</div>
        <div class="font-mono text-slate-400">${o.customer?.phone || ""}</div>
        ${o.customer?.address ? `<div class="mt-1 text-slate-400 border-t border-slate-900 pt-1">${o.customer.address}</div>` : ""}
      </div>
      <ul class="text-xs space-y-1.5 mb-4 flex-grow border-b border-slate-900 pb-3">
        ${o.items.map(i => `
          <li class="flex items-start justify-between gap-2">
            <span class="text-slate-400"><strong class="text-slate-200">${i.qty}×</strong> ${i.nameSnap}${i.variantSnap ? " (" + i.variantSnap + ")" : ""}</span>
            <span class="font-mono text-slate-500 flex-shrink-0">₹${i.priceSnap}</span>
            ${i.note ? `<div class="text-[10px] text-amber-500 pl-4 w-full italic">Note: ${i.note}</div>` : ""}
          </li>`).join("")}
      </ul>
      ${o.note ? `<p class="text-xs text-amber-500 bg-amber-950/20 p-2.5 rounded-lg border border-amber-900/20 mb-4">📝 ${o.note}</p>` : ""}
      <div class="flex items-center justify-between mt-auto gap-2 flex-wrap">
        <div>
          <span class="text-xs text-slate-500">Total</span>
          <div class="font-extrabold text-base text-rose-500">₹${o.total}</div>
        </div>
        <div class="flex items-center gap-2">
          ${markPaidBtn}
          <select onchange="window.setOrderStatus(${o.id}, this.value)"
            class="bg-slate-900 border border-slate-800 rounded-lg text-xs font-semibold px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-rose-500">
            ${STATUSES.map(s => `<option ${s === o.status ? "selected" : ""}>${s}</option>`).join("")}
          </select>
        </div>
      </div>
    </div>`;
}

export async function setOrderStatus(id, status) {
  await api(`/orders/${id}/status`, { method: "PUT", body: JSON.stringify({ status }) });
  loadOrders();
}

export async function markPaid(orderId) {
  try {
    await api(`/orders/${orderId}/payment`, { method: "PUT", body: JSON.stringify({ status: "paid" }) });
    showToast("Marked as Paid", `Order #${orderId} payment updated.`);
    loadOrders();
  } catch (e) {
    showToast("Error", "Could not update payment status.");
  }
}
