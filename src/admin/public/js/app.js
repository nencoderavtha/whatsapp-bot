/**
 * app.js — Main entry for the restaurant admin dashboard.
 * Bootstraps auth, SSE, tab routing, and wires all tab modules.
 */

import { api, login as apiLogin, logout as apiLogout, checkSession } from "./api.js";
import { showToast, playChime, isTabActive } from "./utils.js";
import {
  loadOrders, setOrderStatus, markPaid as orderMarkPaid, setOrderFilter, setOrderSort,
  onOrderSearchInput, openRejectModal, closeRejectModal, onRejectReasonChange, confirmReject,
  openOrderDetail, closeOrderDetailModal, openChatFromOrder,
} from "./orders.js";
import { loadOrdersAnalytics } from "./analytics.js";
import {
  loadChatThreads, selectConversation, appendChatMessage,
  loadCustomerProfile, saveCustProfile, getSelectedCustomerId, showChatThreads,
  sendStaffReply, resumeAI,
} from "./livechat.js";
import { loadActivity, prependActivity } from "./activity.js";
import {
  loadMenu, onMenuSearchInput, addCategory, delCategory,
  openAddItemModal, closeAddItemModal, saveAddItem,
  openEditModal, closeEditModal, saveEditItem, toggleItemAvailability,
  promptDeleteItem, closeDeleteConfirmModal, confirmDeleteItem,
  onImageFileSelected, removeImage,
  loadVariants, addVariant, updateVariant, delVariant, togglePublish,
  patchMenuItemCard,
} from "./menu.js";
import { loadPayments } from "./payments.js";
import { loadCustomers } from "./customers.js";
import {
  loadSettings, saveRestaurantInfo, savePaymentConfig,
  saveRazorpay, savePause, getCachedConfig, setCachedConfig,
  togglePaymentExpand, applySavedTheme, previewBrandColor,
  saveEmployeeTheme, saveEmployeeSound, saveEmployeeVolume, testNotifSound,
} from "./settings.js";
import {
  initNotifications, toggleNotifPanel, closeNotifPanel,
  ackNotificationRow, notifJumpToOrder, notifJumpToChat, handleNotificationCreated,
} from "./notifications.js";

// ── Expose functions needed by inline HTML event handlers ──────────────────
// (inline onclick in dynamically-generated HTML can't use ES module scope)
Object.assign(window, {
  // orders — markPaid works for both orders and payments tabs (same API call)
  setOrderStatus, markPaid: orderMarkPaid, loadOrders, loadPayments, setOrderFilter, setOrderSort,
  onOrderSearchInput, openRejectModal, closeRejectModal, onRejectReasonChange, confirmReject,
  openOrderDetail, closeOrderDetailModal, openChatFromOrder,
  // livechat
  selectConversation, saveCustProfile, showChatThreads, sendStaffReply, resumeAI,
  // menu
  loadMenu, onMenuSearchInput, addCategory, delCategory,
  openAddItemModal, closeAddItemModal, saveAddItem,
  openEditModal, closeEditModal, saveEditItem, toggleItemAvailability,
  promptDeleteItem, closeDeleteConfirmModal, confirmDeleteItem,
  onImageFileSelected, removeImage,
  loadVariants, addVariant, updateVariant, delVariant, togglePublish,
  // payments (reuses same markPaid — both call same API)
  // settings
  saveRestaurantInfo, savePaymentConfig, saveRazorpay,
  savePause, togglePause, togglePauseFromSettings, togglePaymentExpand,
  previewBrandColor,
  saveEmployeeTheme, saveEmployeeSound, saveEmployeeVolume, testNotifSound,
  // activity
  loadActivity, jumpToChat,
  // header
  openQRModal, closeQRModal, login, logout, resetWASession,
  // notification center — switchTab exposed so notifications.js can jump tabs
  // without importing app.js (which would create a circular import)
  switchTab, toggleNotifPanel, closeNotifPanel,
  ackNotificationRow, notifJumpToOrder, notifJumpToChat,
});

// ── State ──────────────────────────────────────────────────────────────────
let sseSource = null;
let currentQRString = null;
let currentPairingCode = null;

// Role from the JWT (via GET /api/auth/me → meHandler), "owner" until known.
// Used only to shape the UI (which tabs/controls render); it is NOT the
// access-control boundary — see applyRoleVisibility() below.
let currentRole = "owner";
export function getRole() { return currentRole; }

// Apply any saved theme preference immediately — pure client preference,
// no backend/auth involved, so this can run before login resolves.
applySavedTheme();

// ── Auth ───────────────────────────────────────────────────────────────────
async function login() {
  const username = document.getElementById("un")?.value?.trim() ?? "";
  const password = document.getElementById("pw")?.value ?? "";
  const btn = document.querySelector("#login button");

  if (btn) {
    btn.disabled = true;
    btn.textContent = "Entering...";
  }

  try {
    await apiLogin(username, password);
    // loginHandler's response has no `role` field — re-hit /api/auth/me (the
    // same endpoint checkSession() calls) to learn the role for this session.
    const me = await checkSession();
    currentRole = me.role === "employee" ? "employee" : "owner";
    document.getElementById("loginErr")?.classList.add("hidden");
    showApp();
  } catch (err) {
    console.error("[Login Failed]", err);
    document.getElementById("loginErr")?.classList.remove("hidden");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Enter Dashboard";
    }
  }
}

async function logout() {
  await apiLogout();
  currentRole = "owner";
  document.getElementById("app").classList.add("hidden");
  document.getElementById("login").classList.remove("hidden");
  document.getElementById("pw").value = "";
  if (sseSource) { sseSource.close(); sseSource = null; }
}

window.addEventListener("auth:unauthorized", logout);

// ── WhatsApp Status ────────────────────────────────────────────────────────
async function checkWAStatus() {
  try {
    const state = await api("/qr");
    currentQRString = state.qr || null;
    currentPairingCode = state.pairingCode || null;
    updateWAStatusUI(state);
    updateProviderUI(state.provider || "baileys");
  } catch (e) {}
}

function updateProviderUI(provider) {
  const isCloud = provider === "cloud";
  // Cloud API fields in settings
  document.getElementById("cloud-phone-section")?.classList.toggle("hidden", !isCloud);
  document.getElementById("cloud-token-section")?.classList.toggle("hidden", !isCloud);
  // Baileys-only pairing code field
  document.getElementById("baileys-phone-section")?.classList.toggle("hidden", isCloud);
  // Never show QR link button for Cloud (always connected via webhook)
  if (isCloud) document.getElementById("btn-link-wa")?.classList.add("hidden");
}

function updateWAStatusUI({ connected, qr, pairingCode, provider, connectedPhone }) {
  const el = document.getElementById("wa-status");
  const btn = document.getElementById("btn-link-wa");
  const btnReset = document.getElementById("btn-reset-session");
  currentQRString = qr || null;
  currentPairingCode = pairingCode || null;
  if (connected) {
    el.className = "text-[10px] text-green-400 font-bold uppercase tracking-widest -mt-1 flex items-center gap-1.5";
    const phoneLabel = connectedPhone ? ` <span class="font-mono normal-case tracking-normal opacity-80">+${connectedPhone}</span>` : "";
    el.innerHTML = `<span class="inline-block w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse"></span>WhatsApp Live${phoneLabel}`;
    btn.classList.add("hidden");
    // Reset is owner-only regardless of connection state — never let a
    // connected-status push re-reveal it for an employee session (defense
    // in depth; the real boundary is requireOwner on POST /session/reset).
    btnReset?.classList.toggle("hidden", currentRole === "employee");
    closeQRModal();
  } else if (provider === "cloud") {
    // Cloud is configured but session hasn't started yet
    el.className = "text-[10px] text-sky-400 font-bold uppercase tracking-widest -mt-1 flex items-center gap-1.5";
    el.innerHTML = `<span class="inline-block w-1.5 h-1.5 rounded-full bg-sky-500 animate-pulse"></span>Cloud API`;
    btn.classList.add("hidden");
  } else {
    el.className = "text-[10px] text-amber-500 font-bold uppercase tracking-widest -mt-1 flex items-center gap-1.5";
    el.innerHTML = `<span class="inline-block w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse"></span>Disconnected`;
    btn.classList.remove("hidden");
    btnReset?.classList.add("hidden");
    const modal = document.getElementById("qr-modal");
    if (!modal.classList.contains("hidden")) renderLinkModal();
  }
}

async function resetWASession() {
  // Defense in depth — the real boundary is requireOwner on POST /session/reset.
  // The button itself is hidden for employees (see applyRoleVisibility and
  // updateWAStatusUI), but guard the handler too in case it's ever invoked
  // directly (e.g. stale DOM, dev tools).
  if (currentRole === "employee") {
    showToast("Not allowed", "Only the owner can reset the WhatsApp session.");
    return;
  }
  if (!confirm("This will clear the WhatsApp session and show a new QR code to re-link. Continue?")) return;
  try {
    await api("/session/reset", { method: "POST" });
    showToast("Session Reset", "Scan the new QR code to reconnect WhatsApp.");
    setTimeout(() => openQRModal(), 1500);
  } catch (e) {
    showToast("Error", "Could not reset session.");
  }
}

// ── Link Modal (QR or Pairing Code) ───────────────────────────────────────
function renderLinkModal() {
  const c    = document.getElementById("qr-container");
  const load = document.getElementById("qr-loading");
  const st   = document.getElementById("qr-status-text");
  const ttl  = document.getElementById("qr-modal-title");
  const sub  = document.getElementById("qr-modal-subtitle");

  // Clear previous content
  c.querySelectorAll("img, .pairing-block").forEach(n => n.remove());

  if (currentPairingCode) {
    load.classList.add("hidden");
    const div = document.createElement("div");
    div.className = "pairing-block flex flex-col items-center justify-center py-6";
    div.innerHTML = `
      <p class="text-slate-500 text-[11px] mb-3 font-semibold uppercase tracking-wider">Enter this code in WhatsApp</p>
      <div class="font-mono text-3xl font-black tracking-[0.25em] text-slate-900 bg-slate-50 px-6 py-4 rounded-2xl border-2 border-slate-200 select-all">${currentPairingCode}</div>
      <p class="text-[10px] text-slate-400 mt-3">Code expires in a few minutes — refresh if it stops working</p>`;
    c.appendChild(div);
    if (ttl) ttl.textContent = "Link via Phone Number";
    if (sub) sub.textContent = "WhatsApp → Linked Devices → Link with phone number";
    st.className = "text-xs font-semibold text-amber-500 mt-2 animate-pulse";
    st.textContent = "Waiting for you to enter the code…";
  } else if (currentQRString) {
    load.classList.add("hidden");
    const img = Object.assign(document.createElement("img"), {
      src: "https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=" + encodeURIComponent(currentQRString),
      alt: "QR",
      className: "w-48 h-48 mx-auto rounded-lg",
    });
    c.appendChild(img);
    if (ttl) ttl.textContent = "Scan QR to Link WhatsApp";
    if (sub) sub.textContent = "Open WhatsApp → Linked Devices → Link a Device → scan";
    st.className = "text-xs font-semibold text-amber-500 mt-2 animate-pulse";
    st.textContent = "Ready to scan!";
  } else {
    load.classList.remove("hidden");
    if (ttl) ttl.textContent = "Link WhatsApp Bot";
    if (sub) sub.textContent = "QR code or pairing code will appear here";
    st.className = "text-xs font-semibold text-slate-400 mt-2";
    st.textContent = "Waiting for server…";
  }
}

let qrPollInterval = null;

function openQRModal() {
  document.getElementById("qr-modal").classList.remove("hidden");
  renderLinkModal();
  // Poll as fallback in case SSE events were missed (e.g. Railway proxy dropped connection)
  if (!qrPollInterval) {
    qrPollInterval = setInterval(async () => {
      if (document.getElementById("qr-modal").classList.contains("hidden")) {
        clearInterval(qrPollInterval); qrPollInterval = null; return;
      }
      if (currentPairingCode || currentQRString) return; // already have a code
      await checkWAStatus();
      renderLinkModal();
    }, 5000);
  }
}
function closeQRModal() {
  document.getElementById("qr-modal").classList.add("hidden");
  if (qrPollInterval) { clearInterval(qrPollInterval); qrPollInterval = null; }
}

// ── SSE ────────────────────────────────────────────────────────────────────
function connectSSE() {
  if (sseSource) sseSource.close();
  sseSource = new EventSource("/api/events", { withCredentials: true });
  sseSource.onerror = () => { sseSource.close(); setTimeout(connectSSE, 2500); };
  sseSource.onmessage = (e) => {
    try { const { type, data } = JSON.parse(e.data); handleSSE(type, data); } catch (err) {}
  };
}

function handleSSE(type, data) {
  switch (type) {
    case "qr_received":
      updateWAStatusUI({ connected: false, qr: data.qr, pairingCode: null });
      break;
    case "pairing_code":
      currentPairingCode = data.code;
      currentQRString = null;
      updateWAStatusUI({ connected: false, qr: null, pairingCode: data.code });
      // Auto-open the modal so the owner sees the code immediately
      document.getElementById("qr-modal").classList.remove("hidden");
      renderLinkModal();
      showToast("Pairing Code Ready", `Code: ${data.code} — enter it in WhatsApp Linked Devices`);
      break;
    case "whatsapp_connected":
      updateWAStatusUI({ connected: true, qr: null, pairingCode: null, connectedPhone: data.phone });
      showToast("WhatsApp Connected", data.phone ? `Bot online as +${data.phone}` : "Bot is now online.");
      break;
    case "whatsapp_disconnected":
      updateWAStatusUI({ connected: false, qr: null, pairingCode: null });
      break;
    case "order_created":
      playChime();
      showToast(`New Order #${data.id}`, `${data.customer?.name || data.customer?.phone} • ₹${data.total}`);
      if (isTabActive("orders")) { loadOrders(); loadOrdersAnalytics(); }
      break;
    case "order_updated":
      if (isTabActive("orders")) { loadOrders(); loadOrdersAnalytics(); }
      break;
    case "message_created":
      // Only refresh the list while it's on screen — switching to the tab
      // reloads it anyway, and this fires on every message in every thread.
      if (isTabActive("livechat")) {
        loadChatThreads();
        if (getSelectedCustomerId() === data.customerId) appendChatMessage(data);
      }
      break;
    case "customer_updated":
      if (isTabActive("customers")) loadCustomers();
      if (isTabActive("livechat")) {
        loadChatThreads();
        if (getSelectedCustomerId() === data.id) loadCustomerProfile(data);
      }
      break;
    case "menu_updated":
      if (!isTabActive("menu")) break;
      // "item_updated" (full edit, or the availability-toggle route) patches
      // just that one card in place — this is what previously triggered a
      // full loadMenu() reload (skeleton + re-render of the whole grid) on
      // every single availability toggle, including the echo of the very
      // toggle this tab just made. Structural changes (add/delete/category/
      // variant) still need a full reload since the grid layout itself changes.
      if (data.type === "item_updated" && data.item && patchMenuItemCard(data.item)) break;
      loadMenu();
      break;
    case "activity_logged":
      if (isTabActive("activity")) prependActivity(data);
      break;
    case "notification_created":
      handleNotificationCreated(data);
      break;
  }
}

// ── Bot Pause ──────────────────────────────────────────────────────────────
async function loadBotPauseHeader() {
  try {
    const cfg = await api("/config");
    setCachedConfig(cfg);
    updatePauseHeaderBtn(cfg.botPaused);
    const name = cfg.restaurantName || "Restaurant";
    const headerEl = document.getElementById("restaurant-name");
    if (headerEl) headerEl.textContent = name;
    const loginEl = document.getElementById("login-restaurant-name");
    if (loginEl) loginEl.textContent = name;
    document.title = name + " — Admin";
  } catch (e) {}
}

function updatePauseHeaderBtn(paused) {
  const btn = document.getElementById("btn-pause");
  btn.classList.remove("hidden");
  if (paused) {
    btn.className = "text-xs px-3 py-1.5 rounded-xl font-bold border transition-all bg-red-950 text-red-400 border-red-500/30 hover:bg-red-900/40";
    btn.textContent = "⏸ Bot Paused";
  } else {
    btn.className = "text-xs px-3 py-1.5 rounded-xl font-bold border transition-all bg-green-950 text-green-400 border-green-500/30 hover:bg-green-900/40";
    btn.textContent = "▶ Bot Running";
  }
}

async function togglePause() {
  try {
    const cfg = getCachedConfig();
    const result = await api("/bot/pause", {
      method: "PUT",
      body: JSON.stringify({ paused: !cfg.botPaused }),
    });
    setCachedConfig({ ...cfg, botPaused: result.botPaused });
    updatePauseHeaderBtn(result.botPaused);
    showToast(
      result.botPaused ? "Bot Paused" : "Bot Resumed",
      result.botPaused ? "Bot will send pause message to customers." : "Bot is now accepting messages."
    );
    // sync settings tab if open
    if (isTabActive("settings")) {
      const btn = document.getElementById("pause-toggle-btn");
      if (btn) {
        updateSettingsPauseBtn(result.botPaused);
      }
    }
  } catch (e) {
    showToast("Error", "Could not toggle bot.");
  }
}

async function togglePauseFromSettings() { await togglePause(); }

function updateSettingsPauseBtn(paused) {
  const btn = document.getElementById("pause-toggle-btn");
  if (!btn) return;
  if (paused) {
    btn.className = "px-5 py-2 rounded-xl text-xs font-bold border transition-all bg-green-950 text-green-400 border-green-500/30 hover:bg-green-900/40";
    btn.textContent = "▶ Resume Bot";
  } else {
    btn.className = "px-5 py-2 rounded-xl text-xs font-bold border transition-all bg-red-950 text-red-400 border-red-500/30 hover:bg-red-900/40";
    btn.textContent = "⏸ Pause Bot";
  }
}

// ── Orders tab: list + analytics are fetched independently (owner-only
// analytics dashboard must never block or trigger a reload of the Orders
// list, and vice versa — see loadOrdersAnalytics()'s own role gate for why
// this is a safe no-op call on an employee session).
function loadOrdersTab() {
  loadOrders();
  loadOrdersAnalytics();
}

// ── Tab Navigation ─────────────────────────────────────────────────────────
const TAB_LOADERS = {
  orders:    loadOrdersTab,
  livechat:  loadChatThreads,
  menu:      loadMenu,
  payments:  loadPayments,
  customers: loadCustomers,
  activity:  loadActivity,
  settings:  loadSettings,
};

// Jump to a customer's chat thread from elsewhere in the app (Activity row,
// notification, Orders → Open Chat). `customerHint` is an optional customer
// object used to render the thread immediately even if the Chats tab's own
// thread-list cache hasn't loaded yet this session — see selectConversation().
function jumpToChat(customerId, customerHint) {
  switchTab("livechat");
  selectConversation(customerId, customerHint);
}

function switchTab(name) {
  document.querySelectorAll(".tab-panel").forEach(p => p.classList.add("hidden"));
  document.getElementById("tab-" + name)?.classList.remove("hidden");

  // Desktop top nav
  document.querySelectorAll(".tab").forEach(b => {
    const active = b.dataset.tab === name;
    b.classList.toggle("bg-rose-500", active);
    b.classList.toggle("text-white", active);
    b.classList.toggle("text-slate-400", !active);
  });

  // Mobile bottom nav
  document.querySelectorAll(".mob-tab").forEach(b => {
    const active = b.dataset.tab === name;
    b.classList.toggle("text-rose-400", active);
    b.classList.toggle("text-slate-500", !active);
  });

  TAB_LOADERS[name]?.();
}

document.querySelectorAll(".tab, .mob-tab").forEach(b =>
  b.addEventListener("click", () => switchTab(b.dataset.tab))
);

// ── Role-based UI visibility ───────────────────────────────────────────────
// Cosmetic only: this just hides nav entries so employees don't hit dead
// ends. The real access boundary is server-side — every owner-only route is
// already guarded by requireOwner (src/admin/auth.ts); an employee session
// hitting those endpoints directly still gets a 403 regardless of what the
// UI shows.
const OWNER_ONLY_TABS = ["payments", "customers", "activity"];

function applyRoleVisibility() {
  const isEmployee = currentRole === "employee";
  document.querySelectorAll(".tab, .mob-tab").forEach(b => {
    if (OWNER_ONLY_TABS.includes(b.dataset.tab)) b.classList.toggle("hidden", isEmployee);
  });
  // Reset Bot/Session is owner-only — must never appear for an employee,
  // independent of WhatsApp connection state. updateWAStatusUI() also
  // guards this so a later status push can't un-hide it.
  if (isEmployee) {
    document.getElementById("btn-reset-session")?.classList.add("hidden");
  }
  // Defensive: if an employee session somehow has an owner-only tab active
  // (e.g. stale state from a role change mid-session), bounce back to Orders.
  if (isEmployee && OWNER_ONLY_TABS.some(t => isTabActive(t))) {
    switchTab("orders");
  }
}

// ── Show App ───────────────────────────────────────────────────────────────
function showApp() {
  document.getElementById("login").classList.add("hidden");
  document.getElementById("app").classList.remove("hidden");
  const whUrl = document.getElementById("webhook-url-display");
  if (whUrl) whUrl.textContent = window.location.origin + "/webhook/razorpay";
  applyRoleVisibility();
  switchTab("orders");
  connectSSE();
  checkWAStatus();
  loadBotPauseHeader();
  initNotifications();
}

// ── Boot ───────────────────────────────────────────────────────────────────
document.getElementById("un")?.addEventListener("keydown", e => { if (e.key === "Enter") document.getElementById("pw")?.focus(); });
document.getElementById("pw")?.addEventListener("keydown", e => { if (e.key === "Enter") login(); });

checkSession()
  .then((data) => {
    currentRole = data.role === "employee" ? "employee" : "owner";
    showApp();
  })
  .catch(() => { /* stay on login screen */ });
