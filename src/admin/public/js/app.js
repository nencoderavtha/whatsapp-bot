/**
 * app.js — Main entry for the restaurant admin dashboard.
 * Bootstraps auth, SSE, tab routing, and wires all tab modules.
 */

import { api, login as apiLogin, logout as apiLogout, checkSession } from "./api.js";
import { showToast, playChime, isTabActive } from "./utils.js";
import { loadOrders, setOrderStatus, markPaid as orderMarkPaid } from "./orders.js";
import {
  loadChatThreads, selectConversation, appendChatMessage,
  loadCustomerProfile, saveCustProfile, getSelectedCustomerId,
} from "./livechat.js";
import {
  loadMenu, addCategory, delCategory, addItem, toggleAvail, delItem,
  openEditModal, closeEditModal, saveEditItem,
  addVariant, updateVariant, delVariant,
} from "./menu.js";
import { loadPayments } from "./payments.js";
import { loadCustomers } from "./customers.js";
import {
  loadSettings, saveRestaurantInfo, savePaymentConfig,
  saveRazorpay, savePause, getCachedConfig, setCachedConfig,
  togglePaymentExpand,
} from "./settings.js";

// ── Expose functions needed by inline HTML event handlers ──────────────────
// (inline onclick in dynamically-generated HTML can't use ES module scope)
Object.assign(window, {
  // orders — markPaid works for both orders and payments tabs (same API call)
  setOrderStatus, markPaid: orderMarkPaid, loadOrders, loadPayments,
  // livechat
  selectConversation, saveCustProfile,
  // menu
  addCategory, delCategory, addItem, toggleAvail, delItem,
  loadMenu, openEditModal, closeEditModal, saveEditItem,
  addVariant, updateVariant, delVariant,
  // payments (reuses same markPaid — both call same API)
  // settings
  saveRestaurantInfo, savePaymentConfig, saveRazorpay,
  savePause, togglePause, togglePauseFromSettings, togglePaymentExpand,
  // header
  openQRModal, closeQRModal, login, logout, resetWASession,
});

// ── State ──────────────────────────────────────────────────────────────────
let sseSource = null;
let currentQRString = null;
let currentPairingCode = null;

// ── Auth ───────────────────────────────────────────────────────────────────
async function login() {
  const password = document.getElementById("pw").value;
  try {
    await apiLogin(password);
    document.getElementById("loginErr").classList.add("hidden");
    showApp();
  } catch {
    document.getElementById("loginErr").classList.remove("hidden");
  }
}

async function logout() {
  await apiLogout();
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

function updateWAStatusUI({ connected, qr, pairingCode, provider }) {
  const el = document.getElementById("wa-status");
  const btn = document.getElementById("btn-link-wa");
  const btnReset = document.getElementById("btn-reset-session");
  currentQRString = qr || null;
  currentPairingCode = pairingCode || null;
  if (connected) {
    el.className = "text-[10px] text-green-400 font-bold uppercase tracking-widest -mt-1 flex items-center gap-1.5";
    el.innerHTML = `<span class="inline-block w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse"></span>WhatsApp Live`;
    btn.classList.add("hidden");
    btnReset?.classList.remove("hidden");
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

function openQRModal() {
  document.getElementById("qr-modal").classList.remove("hidden");
  renderLinkModal();
}
function closeQRModal() { document.getElementById("qr-modal").classList.add("hidden"); }

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
      updateWAStatusUI({ connected: true, qr: null, pairingCode: null });
      showToast("WhatsApp Connected", "Bot is now online.");
      break;
    case "whatsapp_disconnected":
      updateWAStatusUI({ connected: false, qr: null, pairingCode: null });
      break;
    case "order_created":
      playChime();
      showToast(`New Order #${data.id}`, `${data.customer?.name || data.customer?.phone} • ₹${data.total}`);
      if (isTabActive("orders")) loadOrders();
      break;
    case "order_updated":
      if (isTabActive("orders")) loadOrders();
      break;
    case "message_created":
      loadChatThreads();
      if (isTabActive("livechat") && getSelectedCustomerId() === data.customerId) appendChatMessage(data);
      break;
    case "customer_updated":
      if (isTabActive("customers")) loadCustomers();
      if (isTabActive("livechat")) {
        loadChatThreads();
        if (getSelectedCustomerId() === data.id) loadCustomerProfile(data);
      }
      break;
    case "menu_updated":
      if (isTabActive("menu")) loadMenu();
      break;
  }
}

// ── Bot Pause ──────────────────────────────────────────────────────────────
async function loadBotPauseHeader() {
  try {
    const cfg = await api("/config");
    setCachedConfig(cfg);
    updatePauseHeaderBtn(cfg.botPaused);
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

// ── Tab Navigation ─────────────────────────────────────────────────────────
const TAB_LOADERS = {
  orders:    loadOrders,
  livechat:  loadChatThreads,
  menu:      loadMenu,
  payments:  loadPayments,
  customers: loadCustomers,
  settings:  loadSettings,
};

function switchTab(name) {
  document.querySelectorAll(".tab-panel").forEach(p => p.classList.add("hidden"));
  document.getElementById("tab-" + name)?.classList.remove("hidden");
  document.querySelectorAll(".tab").forEach(b => {
    const active = b.dataset.tab === name;
    b.classList.toggle("bg-rose-500", active);
    b.classList.toggle("text-white", active);
    b.classList.toggle("text-slate-400", !active);
  });
  TAB_LOADERS[name]?.();
}

document.querySelectorAll(".tab").forEach(b =>
  b.addEventListener("click", () => switchTab(b.dataset.tab))
);

// ── Show App ───────────────────────────────────────────────────────────────
function showApp() {
  document.getElementById("login").classList.add("hidden");
  document.getElementById("app").classList.remove("hidden");
  const whUrl = document.getElementById("webhook-url-display");
  if (whUrl) whUrl.textContent = window.location.origin + "/webhook/razorpay";
  switchTab("orders");
  connectSSE();
  checkWAStatus();
  loadBotPauseHeader();
}

// ── Boot ───────────────────────────────────────────────────────────────────
document.getElementById("pw")?.addEventListener("keydown", e => { if (e.key === "Enter") login(); });

checkSession()
  .then(() => showApp())
  .catch(() => { /* stay on login screen */ });
