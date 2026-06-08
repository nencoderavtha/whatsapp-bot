/**
 * founder-app.js — Agency / Founder panel JS.
 * Separate auth cookie ("founder-session"), separate routes (/api/founder/*).
 */

import { showToast, esc } from "./utils.js";

// ── API ──────────────────────────────────────────────────────────────────────
async function fApi(path, opts = {}) {
  const res = await fetch("/api/founder" + path, {
    credentials: "include",
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  if (res.status === 401) {
    showLogin();
    throw new Error("unauthorized");
  }
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(text);
  }
  return res.json();
}

// ── State ────────────────────────────────────────────────────────────────────
let restaurants = [];
let selectedId = null;
let editingPromptId = null;

// ── Auth ─────────────────────────────────────────────────────────────────────
async function login() {
  const password = document.getElementById("f-pw").value;
  try {
    const res = await fetch("/api/founder/auth/login", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (!res.ok) throw new Error("denied");
    document.getElementById("f-loginErr").classList.add("hidden");
    showApp();
  } catch {
    document.getElementById("f-loginErr").classList.remove("hidden");
  }
}

async function logout() {
  await fetch("/api/founder/auth/logout", { method: "POST", credentials: "include" }).catch(() => {});
  showLogin();
}

function showLogin() {
  document.getElementById("f-login").classList.remove("hidden");
  document.getElementById("f-app").classList.add("hidden");
}

// ── Boot ─────────────────────────────────────────────────────────────────────
fetch("/api/founder/auth/me", { credentials: "include" })
  .then(r => (r.ok ? showApp() : showLogin()))
  .catch(() => showLogin());

// ── App ───────────────────────────────────────────────────────────────────────
function showApp() {
  document.getElementById("f-login").classList.add("hidden");
  document.getElementById("f-app").classList.remove("hidden");
  loadRestaurants();
}

// ── Restaurant List ──────────────────────────────────────────────────────────
async function loadRestaurants() {
  try {
    restaurants = await fApi("/restaurants");
    renderRestaurantList();
    if (restaurants.length > 0 && !selectedId) {
      selectRestaurant(restaurants[0].id);
    }
  } catch (e) {
    showToast("Error", "Failed to load restaurants.");
  }
}

function renderRestaurantList() {
  const el = document.getElementById("f-restaurant-list");
  el.innerHTML = restaurants.map(r => `
    <div onclick="window.selectRestaurant(${r.id})"
      class="p-3.5 flex items-center gap-3 cursor-pointer hover:bg-slate-900/40 transition-all ${selectedId === r.id ? "bg-slate-900 border-l-2 border-rose-500" : ""}">
      <div class="w-8 h-8 rounded-full bg-rose-600/20 border border-rose-500/20 flex items-center justify-center text-sm font-bold text-rose-400">
        ${r.restaurantName[0].toUpperCase()}
      </div>
      <div class="flex-1 min-w-0">
        <div class="font-bold text-xs truncate text-slate-200">${esc(r.restaurantName)}</div>
        <div class="text-[10px] text-slate-400">${esc(r.restaurantCity)}</div>
      </div>
      <div class="flex flex-col items-end gap-1">
        <span class="text-[9px] px-1.5 py-0.5 rounded font-bold border ${r.isActive ? "bg-green-950 text-green-400 border-green-900/40" : "bg-slate-900 text-slate-500 border-slate-800"}">
          ${r.isActive ? "Active" : "Inactive"}
        </span>
        <span class="text-[9px] text-slate-500">${r._count.orders} orders</span>
      </div>
    </div>
  `).join("");
}

// ── Select & Load Restaurant ─────────────────────────────────────────────────
async function selectRestaurant(id) {
  selectedId = id;
  renderRestaurantList(); // update sidebar highlight
  const r = restaurants.find(x => x.id === id);
  if (!r) return;

  // Show loading state in all panels
  document.getElementById("f-panel-title").textContent = r.restaurantName;
  switchFTab("overview");
  await loadStats(id);
}

async function loadStats(id) {
  try {
    const stats = await fApi(`/restaurants/${id}/stats`);
    const r = restaurants.find(x => x.id === id);
    document.getElementById("f-stat-orders").textContent = stats.orderCount;
    document.getElementById("f-stat-customers").textContent = stats.customerCount;
    document.getElementById("f-stat-revenue").textContent = "₹" + stats.revenue.toLocaleString();
    document.getElementById("f-stat-status").textContent = r?.isActive ? (r.botPaused ? "Paused" : "Live") : "Inactive";
    document.getElementById("f-stat-status").className = r?.isActive && !r?.botPaused
      ? "text-2xl font-extrabold text-green-400"
      : "text-2xl font-extrabold text-amber-400";
  } catch (e) {}
}

// ── Tabs ─────────────────────────────────────────────────────────────────────
function switchFTab(name) {
  document.querySelectorAll(".f-tab-panel").forEach(p => p.classList.add("hidden"));
  const panel = document.getElementById("f-tab-" + name);
  if (panel) panel.classList.remove("hidden");

  document.querySelectorAll(".f-tab").forEach(b => {
    b.classList.toggle("bg-rose-500", b.dataset.ftab === name);
    b.classList.toggle("text-white", b.dataset.ftab === name);
    b.classList.toggle("text-slate-400", b.dataset.ftab !== name);
  });

  if (name === "config") loadConfig();
  if (name === "prompt") loadPrompt();
}

// ── Config Tab ────────────────────────────────────────────────────────────────
async function loadConfig() {
  if (!selectedId) return;
  try {
    const cfg = await fApi(`/restaurants/${selectedId}`);
    document.getElementById("f-cfg-name").value = cfg.restaurantName || "";
    document.getElementById("f-cfg-city").value = cfg.restaurantCity || "";
    document.getElementById("f-cfg-owners").value = cfg.ownerNumbers || "";
    document.getElementById("f-cfg-active").checked = !!cfg.isActive;
    document.getElementById("f-cfg-paused").checked = !!cfg.botPaused;
    document.getElementById("f-cfg-pauseMsg").value = cfg.pauseMessage || "";
    document.getElementById("f-cfg-upi").value = cfg.upiId || "";
    document.getElementById("f-cfg-methods").value = cfg.paymentMethods || "cash,upi";
    document.getElementById("f-cfg-requirePmt").checked = !!cfg.requiresPaymentBeforeOrder;
    document.getElementById("f-cfg-rzpEnabled").checked = !!cfg.razorpayEnabled;
    document.getElementById("f-cfg-rzpKeyId").value = cfg.razorpayKeyId || "";
  } catch (e) { showToast("Error", "Failed to load config."); }
}

async function saveConfig() {
  if (!selectedId) return;
  const body = {
    restaurantName: document.getElementById("f-cfg-name").value.trim(),
    restaurantCity: document.getElementById("f-cfg-city").value.trim(),
    ownerNumbers: document.getElementById("f-cfg-owners").value.trim(),
    isActive: document.getElementById("f-cfg-active").checked,
    botPaused: document.getElementById("f-cfg-paused").checked,
    pauseMessage: document.getElementById("f-cfg-pauseMsg").value.trim() || null,
    upiId: document.getElementById("f-cfg-upi").value.trim() || null,
    paymentMethods: document.getElementById("f-cfg-methods").value.trim(),
    requiresPaymentBeforeOrder: document.getElementById("f-cfg-requirePmt").checked,
    razorpayEnabled: document.getElementById("f-cfg-rzpEnabled").checked,
    razorpayKeyId: document.getElementById("f-cfg-rzpKeyId").value.trim() || null,
  };
  const secret = document.getElementById("f-cfg-rzpSecret").value.trim();
  const wh = document.getElementById("f-cfg-rzpWebhook").value.trim();
  if (secret) body.razorpayKeySecret = secret;
  if (wh) body.razorpayWebhookSecret = wh;
  const pw = document.getElementById("f-cfg-password").value.trim();
  if (pw) body.dashboardPassword = pw;

  try {
    await fApi(`/restaurants/${selectedId}/config`, { method: "PUT", body: JSON.stringify(body) });
    document.getElementById("f-cfg-rzpSecret").value = "";
    document.getElementById("f-cfg-rzpWebhook").value = "";
    document.getElementById("f-cfg-password").value = "";
    // Refresh local cache
    await loadRestaurants();
    showToast("Saved", "Restaurant config updated.");
  } catch (e) { showToast("Error", "Could not save config."); }
}

// ── Prompt Tab ────────────────────────────────────────────────────────────────
async function loadPrompt() {
  if (!selectedId) return;
  try {
    const prompt = await fApi(`/restaurants/${selectedId}/prompt`);
    document.getElementById("f-prompt-content").value = prompt.content || "";
    editingPromptId = selectedId;
  } catch (e) { showToast("Error", "Failed to load prompt."); }
}

async function savePrompt() {
  if (!selectedId) return;
  const content = document.getElementById("f-prompt-content").value;
  try {
    await fApi(`/restaurants/${selectedId}/prompt`, { method: "PUT", body: JSON.stringify({ content }) });
    showToast("Saved", "Prompt template updated.");
  } catch (e) { showToast("Error", "Could not save prompt."); }
}

// Copy prompt from restaurant 1 to current
async function copyPromptFrom1() {
  if (!selectedId || selectedId === 1) return;
  if (!confirm("Copy the prompt from Restaurant #1 to this restaurant? Current prompt will be overwritten.")) return;
  try {
    const src = await fApi("/restaurants/1/prompt");
    document.getElementById("f-prompt-content").value = src.content || "";
    showToast("Copied", "Prompt copied from Restaurant #1. Click Save to apply.");
  } catch (e) { showToast("Error", "Could not copy prompt."); }
}

// ── Onboard New Restaurant ────────────────────────────────────────────────────
async function onboardRestaurant() {
  const body = {
    restaurantName: document.getElementById("new-rname").value.trim(),
    restaurantCity: document.getElementById("new-rcity").value.trim(),
    ownerNumbers: document.getElementById("new-rowners").value.trim(),
    dashboardPassword: document.getElementById("new-rpw").value.trim() || "changeme",
  };
  if (!body.restaurantName) { showToast("Validation", "Restaurant name is required."); return; }
  try {
    const r = await fApi("/restaurants", { method: "POST", body: JSON.stringify(body) });
    document.getElementById("new-rname").value = "";
    document.getElementById("new-rcity").value = "";
    document.getElementById("new-rowners").value = "";
    document.getElementById("new-rpw").value = "";
    document.getElementById("onboard-modal").classList.add("hidden");
    showToast("Restaurant Created", `"${r.restaurantName}" (ID: ${r.id}) created. Start the bot from the control panel.`);
    await loadRestaurants();
    selectRestaurant(r.id);
  } catch (e) { showToast("Error", "Could not create restaurant."); }
}

// ── Bot Control ───────────────────────────────────────────────────────────────
async function startBot() {
  if (!selectedId) return;
  try {
    await fApi(`/restaurants/${selectedId}/bot/start`, { method: "POST" });
    showToast("Bot Started", "Bot session initiated.");
    loadStats(selectedId);
  } catch (e) { showToast("Error", e.message); }
}

async function stopBot() {
  if (!selectedId) return;
  await fApi(`/restaurants/${selectedId}/bot/stop`, { method: "POST" });
  showToast("Bot Stopped", "Session removed.");
}

async function toggleActive() {
  if (!selectedId) return;
  const r = restaurants.find(x => x.id === selectedId);
  try {
    await fApi(`/restaurants/${selectedId}/active`, { method: "PUT", body: JSON.stringify({ isActive: !r?.isActive }) });
    await loadRestaurants();
    loadStats(selectedId);
    showToast("Updated", "Restaurant active status toggled.");
  } catch (e) { showToast("Error", "Could not toggle."); }
}

// ── Expose to inline handlers ─────────────────────────────────────────────────
Object.assign(window, {
  login, logout, selectRestaurant, switchFTab, loadRestaurants,
  saveConfig, loadConfig, savePrompt, copyPromptFrom1,
  onboardRestaurant, startBot, stopBot, toggleActive,
});

document.querySelectorAll(".f-tab").forEach(b =>
  b.addEventListener("click", () => switchFTab(b.dataset.ftab))
);

document.getElementById("f-pw")?.addEventListener("keydown", e => { if (e.key === "Enter") login(); });
