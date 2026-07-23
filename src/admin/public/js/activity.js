import { api } from "./api.js";
import { esc } from "./utils.js";

let rows = [];
let lastOpenHandoffs = 0;

const TYPE_META = {
  response_time:    { label: "Response",  cls: "bg-slate-800 text-slate-300 border-slate-700", icon: "⚡" },
  tool_error:       { label: "Tool Error", cls: "bg-red-950 text-red-400 border-red-500/30", icon: "🛠️" },
  fallback:         { label: "Fallback",  cls: "bg-amber-950 text-amber-400 border-amber-500/30", icon: "↩️" },
  human_handoff:    { label: "Handoff",   cls: "bg-violet-950 text-violet-300 border-violet-500/30", icon: "🙋" },
  handoff_resolved: { label: "Resumed",   cls: "bg-emerald-950 text-emerald-400 border-emerald-500/30", icon: "✅" },
};

function isToday(iso) {
  const d = new Date(iso);
  const n = new Date();
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
}

function renderStats(openHandoffs) {
  const today = rows.filter(r => isToday(r.createdAt));
  const rts = today
    .filter(r => r.type === "response_time")
    .map(r => { try { return JSON.parse(r.meta || "{}").elapsedMs; } catch { return null; } })
    .filter(v => typeof v === "number");
  const avg = rts.length ? Math.round(rts.reduce((a, b) => a + b, 0) / rts.length) : null;
  const errors = today.filter(r => r.type === "tool_error").length;

  const stat = (label, value, cls) => `
    <div class="glass rounded-2xl p-4 border border-slate-900 flex-1 min-w-[130px]">
      <div class="text-[10px] font-bold text-slate-500 uppercase mb-1">${label}</div>
      <div class="text-xl font-bold ${cls}">${value}</div>
    </div>`;

  return `
    <div class="flex gap-3 flex-wrap mb-4 flex-shrink-0">
      ${stat("Avg Response (today)", avg === null ? "—" : `${avg}ms`, "text-slate-100")}
      ${stat("Tool Errors (today)", errors, errors ? "text-red-400" : "text-slate-100")}
      ${stat("Open Handoffs", openHandoffs, openHandoffs ? "text-violet-300" : "text-slate-100")}
    </div>`;
}

function rowHtml(r) {
  const meta = TYPE_META[r.type] || { label: r.type, cls: "bg-slate-800 text-slate-300 border-slate-700", icon: "•" };
  const time = new Date(r.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const jump = r.customerId
    ? `<button onclick="window.jumpToChat(${r.customerId})" class="text-[10px] text-rose-400 hover:text-rose-300 font-semibold ml-2 flex-shrink-0">Jump to chat →</button>`
    : "";
  return `
    <div class="flex items-start gap-2.5 px-3.5 py-2.5 border-b border-slate-900/60">
      <span class="text-[10px] font-bold px-2 py-0.5 rounded-full border ${meta.cls} flex-shrink-0 mt-0.5">${meta.icon} ${meta.label}</span>
      <div class="flex-1 min-w-0">
        <p class="text-xs text-slate-200 break-words">${esc(r.message)}</p>
        <p class="text-[10px] text-slate-500 mt-0.5">${time}</p>
      </div>
      ${jump}
    </div>`;
}

function render(openHandoffs) {
  const list = document.getElementById("activity-list");
  const stats = document.getElementById("activity-stats");
  if (stats) stats.innerHTML = renderStats(openHandoffs);
  if (!list) return;
  list.innerHTML = rows.length
    ? rows.map(rowHtml).join("")
    : '<div class="p-8 text-center text-slate-500 text-xs">No activity yet. Tool errors, fallbacks, response times, and handoffs will show here.</div>';
}

export async function loadActivity() {
  try {
    const [activity, customers] = await Promise.all([
      api("/activity"),
      api("/customers"),
    ]);
    rows = activity;
    lastOpenHandoffs = customers.filter(c => c.humanRequestedAt).length;
    render(lastOpenHandoffs);
  } catch (e) {
    const list = document.getElementById("activity-list");
    if (list) list.innerHTML = '<div class="p-8 text-center text-rose-400 text-xs">Failed to load activity.</div>';
  }
}

// Called from the SSE handler when a new activity_logged event arrives.
export function prependActivity(row) {
  rows.unshift(row);
  if (rows.length > 100) rows.pop();
  // Handoff open/resolve events change the open count — nudge it locally.
  if (row.type === "human_handoff") lastOpenHandoffs++;
  else if (row.type === "handoff_resolved") lastOpenHandoffs = Math.max(0, lastOpenHandoffs - 1);
  render(lastOpenHandoffs);
}
