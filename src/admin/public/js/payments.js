import { api } from "./api.js";
import { showToast, pmtBadge } from "./utils.js";

export async function loadPayments() {
  const payments = await api("/payments");
  const tbody = document.getElementById("payments-tbody");
  const empty = document.getElementById("payments-empty");
  if (!payments.length) {
    tbody.innerHTML = "";
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");
  tbody.innerHTML = payments.map(p => {
    const order = p.order;
    const cust = order?.customer;
    return `
      <tr class="hover:bg-slate-900/30 transition-all">
        <td class="px-4 py-3 font-mono text-slate-300">${order ? "#" + order.id : "—"}</td>
        <td class="px-4 py-3 text-slate-300">${cust?.name || cust?.phone || "—"}</td>
        <td class="px-4 py-3 font-mono text-slate-200 font-bold">₹${p.amount}</td>
        <td class="px-4 py-3 text-slate-400">${p.method || "—"}</td>
        <td class="px-4 py-3">
          <span class="px-2 py-0.5 rounded-full text-[10px] font-bold ${pmtBadge(p.status)}">${p.status}</span>
        </td>
        <td class="px-4 py-3 text-slate-400 text-[11px]">${new Date(p.createdAt).toLocaleString()}</td>
        <td class="px-4 py-3 flex items-center gap-2">
          ${p.status !== "paid" && order
            ? `<button onclick="window.markPaid(${order.id})" class="text-[10px] text-green-400 border border-green-500/30 px-2 py-1 rounded-lg hover:bg-green-950 transition-all">✓ Mark Paid</button>`
            : ""}
          ${p.reference ? `<span class="text-[10px] text-slate-500 font-mono">${p.reference}</span>` : ""}
        </td>
      </tr>`;
  }).join("");
}

export async function markPaid(orderId) {
  try {
    await api(`/orders/${orderId}/payment`, { method: "PUT", body: JSON.stringify({ status: "paid" }) });
    showToast("Marked as Paid", `Order #${orderId} payment updated.`);
    loadPayments();
  } catch (e) {
    showToast("Error", "Could not update payment status.");
  }
}
