import { api } from "./api.js";
import { esc } from "./utils.js";

export async function loadCustomers() {
  const cs = await api("/customers");
  const el = document.getElementById("customers");
  if (!cs.length) {
    el.innerHTML = '<div class="col-span-full py-16 text-center text-slate-500 text-sm">No registered customers.</div>';
    return;
  }
  el.innerHTML = cs.map(c => `
    <div class="glass rounded-2xl p-5 hover:border-slate-800 transition-all flex flex-col">
      <div class="flex items-center gap-3 mb-3 pb-3 border-b border-slate-900">
        <div class="w-8 h-8 rounded-full bg-slate-800 flex items-center justify-center font-bold text-xs text-slate-400">
          ${c.name ? c.name[0].toUpperCase() : "?"}
        </div>
        <div>
          <h3 class="font-extrabold text-sm text-slate-200">${esc(c.name) || "(No Name)"}</h3>
          <p class="text-[10px] text-slate-500 font-mono mt-0.5">${c.phone}</p>
        </div>
        <span class="ml-auto text-[10px] bg-slate-900 border border-slate-800 text-slate-400 px-2.5 py-1 rounded-full font-bold">
          ${c._count.orders} orders
        </span>
      </div>
      ${c.address ? `<p class="text-xs text-slate-400 leading-relaxed mb-2">📍 ${esc(c.address)}</p>` : ""}
      ${c.notes ? `
        <div class="bg-amber-950/10 border border-amber-900/10 p-2 rounded-lg">
          <p class="text-[10px] text-amber-400 leading-relaxed">📋 ${esc(c.notes)}</p>
        </div>` : ""}
      <div class="mt-auto pt-3">
        <p class="text-[10px] text-slate-600">Joined ${new Date(c.createdAt).toLocaleDateString()}</p>
      </div>
    </div>
  `).join("");
}
