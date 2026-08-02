import { api } from "./api.js";
import { esc } from "./utils.js";

export async function loadCustomers() {
  const cs = await api("/customers");
  const el = document.getElementById("customers");
  if (!cs.length) {
    el.innerHTML = '<div class="col-span-full py-16 text-center text-slate-500 text-sm">No registered customers.</div>';
    return;
  }
  el.innerHTML = cs.map(c => {
    const i = c.insights ?? {};
    // Allergies are pulled out of the notes so they cannot be skimmed past —
    // everything else on this card is commercial, this is the part that can
    // hurt someone.
    const otherNotes = (c.notes ?? "")
      .split("\n")
      .filter(l => l.trim() && !l.trim().startsWith("⚠️ ALLERGY"))
      .join("\n");

    const stat = (label, value) => `
      <div>
        <p class="text-[9px] uppercase tracking-wide text-slate-600">${label}</p>
        <p class="text-xs font-bold text-slate-300 mt-0.5">${value}</p>
      </div>`;

    return `
    <div class="glass rounded-2xl p-5 hover:border-slate-800 transition-all flex flex-col">
      <div class="flex items-center gap-3 mb-3 pb-3 border-b border-slate-900">
        <div class="w-8 h-8 rounded-full bg-slate-800 flex items-center justify-center font-bold text-xs text-slate-400 shrink-0">
          ${c.name ? c.name[0].toUpperCase() : "?"}
        </div>
        <div class="min-w-0">
          <h3 class="font-extrabold text-sm text-slate-200 truncate">${esc(c.name) || "(No Name)"}</h3>
          <p class="text-[10px] text-slate-500 font-mono mt-0.5">${c.phone}</p>
        </div>
        <div class="ml-auto flex flex-col items-end gap-1 shrink-0">
          ${i.isRepeat
            ? '<span class="text-[9px] bg-emerald-500/15 text-emerald-400 border border-emerald-500/25 px-2 py-0.5 rounded-full font-bold">REPEAT</span>'
            : (i.orders ? '' : '<span class="text-[9px] bg-slate-800 text-slate-400 border border-slate-700 px-2 py-0.5 rounded-full font-bold">NEW</span>')}
          ${c.humanRequestedAt
            ? '<span class="text-[9px] bg-amber-500/15 text-amber-400 border border-amber-500/25 px-2 py-0.5 rounded-full font-bold">NEEDS STAFF</span>'
            : ''}
        </div>
      </div>

      ${(i.allergies ?? []).length ? `
        <div class="bg-rose-950/30 border border-rose-800/40 p-2.5 rounded-lg mb-3">
          ${i.allergies.map(a => `<p class="text-[11px] text-rose-300 font-bold leading-relaxed">${esc(a)}</p>`).join("")}
        </div>` : ""}

      <div class="grid grid-cols-3 gap-3 mb-3">
        ${stat("Orders", i.orders ?? 0)}
        ${stat("Spent", `₹${(i.totalSpent ?? 0).toLocaleString()}`)}
        ${stat("Avg", `₹${(i.avgOrder ?? 0).toLocaleString()}`)}
      </div>

      ${i.favouriteDish ? `
        <p class="text-[11px] text-slate-400 mb-2">⭐ Usually orders <span class="text-slate-200 font-bold">${esc(i.favouriteDish.name)}</span> <span class="text-slate-600">(${i.favouriteDish.times}x)</span></p>` : ""}

      ${c.address ? `<p class="text-xs text-slate-400 leading-relaxed mb-2">📍 ${esc(c.address)}</p>` : ""}

      ${otherNotes ? `
        <div class="bg-amber-950/10 border border-amber-900/10 p-2 rounded-lg mb-2">
          <p class="text-[10px] text-amber-400 leading-relaxed whitespace-pre-wrap">📋 ${esc(otherNotes)}</p>
        </div>` : ""}

      <div class="mt-auto pt-3 flex items-center justify-between gap-2">
        <p class="text-[10px] text-slate-600">Joined ${new Date(c.createdAt).toLocaleDateString()}</p>
        <p class="text-[10px] text-slate-600">${i.lastOrderAt ? `Last order ${new Date(i.lastOrderAt).toLocaleDateString()}` : "Never ordered"}</p>
      </div>
    </div>`;
  }).join("");
}
