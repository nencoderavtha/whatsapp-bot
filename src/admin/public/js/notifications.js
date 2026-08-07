// Notification Center — bell/badge, dropdown panel, and critical-alert toasts.
// Backed by src/services/notification-center.ts + GET/POST /api/notifications*
// (see src/admin/server.ts). Open to both owner and employee roles.

import { api } from "./api.js";
import { showToast, esc } from "./utils.js";

const SEVERITY_META = {
  info:     { icon: "ℹ️", cls: "text-blue-400 bg-blue-500/10 border-blue-500/20" },
  warning:  { icon: "⚠️", cls: "text-amber-400 bg-amber-500/10 border-amber-500/20" },
  critical: { icon: "🚨", cls: "text-red-400 bg-red-500/10 border-red-500/20" },
};

// Same relative-time formatting as orders.js's timeAgo() — kept in sync by
// hand since neither module exports it.
function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ago`;
}

let notifications = []; // last 100, newest first — mirrors GET /api/notifications
let unreadCount = 0;

// ── Badge ──────────────────────────────────────────────────────────────────

function setUnreadCount(count) {
  unreadCount = Math.max(0, count);
  const badge = document.getElementById("notif-bell-badge");
  if (!badge) return;
  badge.textContent = unreadCount > 99 ? "99+" : String(unreadCount);
  badge.classList.toggle("hidden", unreadCount === 0);
}

// Called once at app boot (see showApp() in app.js) to seed the badge.
export async function initNotifications() {
  try {
    const { count } = await api("/notifications/unread-count");
    setUnreadCount(count);
  } catch (e) {}
}

// ── Panel open/close ─────────────────────────────────────────────────────

function isPanelOpen() {
  const overlay = document.getElementById("notif-panel-overlay");
  return !!overlay && !overlay.classList.contains("hidden");
}

export async function toggleNotifPanel() {
  const overlay = document.getElementById("notif-panel-overlay");
  if (!overlay) return;
  if (overlay.classList.contains("hidden")) {
    overlay.classList.remove("hidden");
    await loadNotificationsPanel();
  } else {
    closeNotifPanel();
  }
}

export function closeNotifPanel() {
  document.getElementById("notif-panel-overlay")?.classList.add("hidden");
}

// ── List rendering ─────────────────────────────────────────────────────────

export async function loadNotificationsPanel() {
  const el = document.getElementById("notif-list");
  if (!el) return;
  el.innerHTML = `<div class="py-10 text-center text-slate-500 text-xs">Loading…</div>`;
  try {
    notifications = await api("/notifications"); // newest first, max 100
    renderNotifList();
  } catch (e) {
    el.innerHTML = `<div class="py-10 text-center text-rose-400 text-xs">Failed to load notifications.</div>`;
  }
}

function renderNotifList() {
  const el = document.getElementById("notif-list");
  if (!el) return;
  if (!notifications.length) {
    el.innerHTML = `<div class="py-14 text-center px-4">
      <div class="text-4xl mb-3 opacity-20">🔔</div>
      <p class="text-slate-400 font-semibold text-sm">No notifications yet</p>
      <p class="text-slate-600 text-xs mt-1.5">Order and alert updates will show up here</p>
    </div>`;
    return;
  }
  el.innerHTML = notifications.map(renderNotifRow).join("");
}

function renderNotifRow(n) {
  const meta = SEVERITY_META[n.severity] || SEVERITY_META.info;
  const unread = !n.acknowledgedAt;

  let jumpBtn = "";
  if (n.orderId) {
    jumpBtn = `<button onclick="event.stopPropagation(); window.notifJumpToOrder(${n.id}, ${n.orderId})"
      class="text-[10px] font-bold text-rose-400 hover:text-rose-300 transition-colors">View Order →</button>`;
  } else if (n.customerId) {
    jumpBtn = `<button onclick="event.stopPropagation(); window.notifJumpToChat(${n.id}, ${n.customerId})"
      class="text-[10px] font-bold text-rose-400 hover:text-rose-300 transition-colors">Open Chat →</button>`;
  }

  return `
    <div id="notif-row-${n.id}" onclick="window.ackNotificationRow(${n.id})"
      class="px-4 py-3 flex gap-2.5 cursor-pointer hover:bg-slate-800/40 transition-colors ${unread ? "" : "opacity-55"}">
      <div class="text-base flex-shrink-0 leading-none mt-0.5">${meta.icon}</div>
      <div class="flex-1 min-w-0">
        <div class="flex items-center justify-between gap-2">
          <h4 class="font-bold text-xs ${unread ? "text-slate-100" : "text-slate-400"} truncate">${esc(n.title)}</h4>
          ${unread ? `<span class="w-1.5 h-1.5 rounded-full bg-rose-500 flex-shrink-0" title="Unread"></span>` : ""}
        </div>
        <p class="text-[11px] text-slate-400 mt-1 leading-snug">${esc(n.message)}</p>
        <div class="flex items-center justify-between gap-2 mt-1.5">
          <span class="text-[10px] text-slate-600 font-mono">${timeAgo(n.createdAt)}</span>
          ${jumpBtn}
        </div>
      </div>
    </div>`;
}

// ── Acknowledge ──────────────────────────────────────────────────────────

export async function ackNotificationRow(id) {
  const existing = notifications.find((x) => x.id === id);
  if (existing && existing.acknowledgedAt) return; // already read, nothing to do

  try {
    const updated = await api(`/notifications/${id}/ack`, { method: "POST" });
    const idx = notifications.findIndex((x) => x.id === id);
    if (idx !== -1) notifications[idx] = updated;
    setUnreadCount(unreadCount - 1);
    if (isPanelOpen()) renderNotifList();
  } catch (e) {}
}

// ── Quick actions — reuse the Orders/Chats tabs' own jump-to logic ─────────

export async function notifJumpToOrder(id, orderId) {
  await ackNotificationRow(id);
  closeNotifPanel();
  window.switchTab?.("orders");
  window.openOrderDetail?.(orderId);
}

export async function notifJumpToChat(id, customerId) {
  await ackNotificationRow(id);
  closeNotifPanel();
  window.jumpToChat?.(customerId); // already switches to Chats + selects the thread
}

// ── SSE hook (see handleSSE()'s "notification_created" case in app.js) ────

export function handleNotificationCreated(data) {
  setUnreadCount(unreadCount + 1);

  notifications.unshift(data);
  if (notifications.length > 100) notifications.length = 100;
  if (isPanelOpen()) renderNotifList();

  const meta = SEVERITY_META[data.severity] || SEVERITY_META.info;
  const title = `${meta.icon} ${esc(data.title)}`;
  const body = esc(data.message);

  if (data.severity === "critical") {
    // Stays on screen until the user explicitly acknowledges it.
    showToast(title, body, {
      persistent: true,
      onAcknowledge: () => ackNotificationRow(data.id),
    });
  } else {
    showToast(title, body);
  }
}
