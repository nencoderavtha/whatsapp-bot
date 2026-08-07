import { api } from "./api.js";
import { showToast, playChime } from "./utils.js";
import { getRole } from "./app.js";

let cachedCfg = {};

export function getCachedConfig() { return cachedCfg; }
export function setCachedConfig(cfg) { cachedCfg = cfg; }

// ── Client-side preferences: theme (both roles) + notification sound ───────
// (employee-only) — saved to localStorage only, no backend call, applied
// immediately. Owners keep the full settings tab unchanged (below).
const THEME_KEY = "dashboardTheme"; // "light" | "dark" (legacy: "system", resolved on read)
const SOUND_KEY = "notifSound";
const VOLUME_KEY = "notifVolume";

// Two-state theme model: "dark" | "light". Toggles a `.light` class on
// <html> — the default (no class) is dark, matching the app's original look.
// Actual re-theming lives in css/theme-light.css, which overrides the same
// hardcoded Tailwind utility classes every render template already emits.
function applyTheme(theme) {
  const root = document.documentElement;
  root.classList.toggle("light", theme === "light");
}

// Legacy "system" value may still be sitting in some user's localStorage
// from the old three-way stub. Resolve it once into a concrete dark/light
// choice and persist that, so every user lands on the two-state model.
function resolveLegacyTheme(value) {
  if (value === "system") {
    const resolved = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    localStorage.setItem(THEME_KEY, resolved);
    return resolved;
  }
  return value;
}

// Called once at app boot (before auth resolves) so the saved theme applies
// immediately on load, not just after opening the Settings tab.
export function applySavedTheme() {
  applyTheme(resolveLegacyTheme(localStorage.getItem(THEME_KEY) || "dark"));
}

export function saveEmployeeTheme(value) {
  localStorage.setItem(THEME_KEY, value);
  applyTheme(value);
  const radio = document.querySelector(`input[name="theme"][value="${value}"]`);
  if (radio) radio.checked = true;
}

// Reflect the currently-saved theme on the Appearance radios — runs for
// both roles since the Appearance card is now shared. Safe to call whether
// or not the settings tab (and thus the radios) is currently in the DOM.
function initThemeControl() {
  const theme = resolveLegacyTheme(localStorage.getItem(THEME_KEY) || "dark");
  const radio = document.querySelector(`input[name="theme"][value="${theme}"]`);
  if (radio) radio.checked = true;
}

export function saveEmployeeSound(value) {
  localStorage.setItem(SOUND_KEY, value);
}

export function saveEmployeeVolume(value) {
  localStorage.setItem(VOLUME_KEY, value);
}

export function testNotifSound() {
  playChime();
}

function initEmployeeSettings() {
  const sound = localStorage.getItem(SOUND_KEY) || "classic";
  const volume = localStorage.getItem(VOLUME_KEY) ?? "0.6";

  const soundSel = document.getElementById("emp-sound");
  const volumeInput = document.getElementById("emp-volume");
  if (soundSel) soundSel.value = sound;
  if (volumeInput) volumeInput.value = volume;
}

export async function loadSettings() {
  const isEmployee = getRole() === "employee";
  document.getElementById("settings-owner")?.classList.toggle("hidden", isEmployee);
  document.getElementById("settings-employee")?.classList.toggle("hidden", !isEmployee);

  // Appearance card is shared by both roles — reflect the saved theme on
  // its radios every time the Settings tab loads.
  initThemeControl();

  if (isEmployee) {
    initEmployeeSettings();
    return;
  }

  try {
    cachedCfg = await api("/config");
    populateConfig(cachedCfg);
  } catch (e) {
    showToast("Error", "Failed to load settings.");
  }
}

// Live preview of the brand-color swatch — no save needed, purely visual.
export function previewBrandColor(value) {
  const swatch = document.getElementById("cfg-brandColor-swatch");
  if (swatch) swatch.style.background = value;
}

export function togglePaymentExpand(sectionId, show) {
  const el = document.getElementById(sectionId);
  if (el) el.classList.toggle("hidden", !show);
}

function populateConfig(cfg) {
  document.getElementById("cfg-name").value = cfg.restaurantName || "";
  document.getElementById("cfg-city").value = cfg.restaurantCity || "";
  const personaEl = document.getElementById("cfg-persona");
  if (personaEl) personaEl.value = cfg.personaName || "";
  document.getElementById("cfg-owners").value = cfg.ownerNumbers || "";
  document.getElementById("cfg-wa-phone").value = cfg.whatsappPhone || "";
  document.getElementById("cfg-requirePayment").checked = !!cfg.requiresPaymentBeforeOrder;
  document.getElementById("cfg-pauseMessage").value = cfg.pauseMessage || "";
  // Welcome message / public menu branding
  const welcomeLogoEl = document.getElementById("cfg-welcomeLogoUrl");
  if (welcomeLogoEl) welcomeLogoEl.value = cfg.welcomeLogoUrl || "";
  const welcomeTaglineEl = document.getElementById("cfg-welcomeTagline");
  if (welcomeTaglineEl) welcomeTaglineEl.value = cfg.welcomeTagline || "";
  const openingHoursEl = document.getElementById("cfg-openingHoursText");
  if (openingHoursEl) openingHoursEl.value = cfg.openingHoursText || "";
  const brandColorEl = document.getElementById("cfg-brandColor");
  if (brandColorEl) {
    const color = cfg.brandColor || "#e11d48";
    brandColorEl.value = color;
    previewBrandColor(color);
  }
  // Cloud API — phoneNumberId is pre-filled; token is never pre-filled (treat as secret)
  const cloudPhoneEl = document.getElementById("cfg-cloud-phone-id");
  if (cloudPhoneEl) cloudPhoneEl.value = cfg.cloudPhoneNumberId || "";

  // Notification center settings
  const notifEnabledEl = document.getElementById("cfg-notifications-enabled");
  if (notifEnabledEl) notifEnabledEl.checked = cfg.notificationsEnabled !== false; // defaults true
  const emergencyContactsEl = document.getElementById("cfg-emergency-contacts");
  if (emergencyContactsEl) emergencyContactsEl.value = cfg.emergencyContacts || "";
  const notifChannels = (cfg.notificationChannels || "whatsapp").split(",").map(s => s.trim());
  const notifWhatsappEl = document.getElementById("cfg-notif-channel-whatsapp");
  if (notifWhatsappEl) notifWhatsappEl.checked = notifChannels.includes("whatsapp");
  // sms/email/push checkboxes stay disabled (non-functional stubs) — reflect
  // stored state if present, but the user can never check them from this UI.
  const notifSmsEl = document.getElementById("cfg-notif-channel-sms");
  if (notifSmsEl) notifSmsEl.checked = notifChannels.includes("sms");
  const notifEmailEl = document.getElementById("cfg-notif-channel-email");
  if (notifEmailEl) notifEmailEl.checked = notifChannels.includes("email");
  const notifPushEl = document.getElementById("cfg-notif-channel-push");
  if (notifPushEl) notifPushEl.checked = notifChannels.includes("push");
  const criticalOnlyEl = document.getElementById("cfg-critical-only-mode");
  if (criticalOnlyEl) criticalOnlyEl.checked = !!cfg.criticalOnlyMode;

  // Payment method checkboxes + expand/collapse inline sections
  const methods = (cfg.paymentMethods || "cash").split(",").map(s => s.trim());
  ["cash", "upi", "card", "online"].forEach(m => {
    const el = document.getElementById(`pm-${m}`);
    if (el) el.checked = methods.includes(m);
  });
  togglePaymentExpand("upi-expand", methods.includes("upi"));
  togglePaymentExpand("online-expand", methods.includes("online"));

  // Populate expandable fields
  const upiEl = document.getElementById("cfg-upi");
  if (upiEl) upiEl.value = cfg.upiId || "";
  const rzpEnabledEl = document.getElementById("cfg-rzpEnabled");
  if (rzpEnabledEl) rzpEnabledEl.checked = !!cfg.razorpayEnabled;
  const rzpKeyIdEl = document.getElementById("cfg-rzpKeyId");
  if (rzpKeyIdEl) rzpKeyIdEl.value = cfg.razorpayKeyId || "";
  // Never pre-fill secrets (rzpKeySecret, rzpWebhook)

  const name = cfg.restaurantName || "Restaurant";
  const headerEl = document.getElementById("restaurant-name");
  if (headerEl) headerEl.textContent = name;
  document.title = name + " — Admin";
}

export async function saveRestaurantInfo() {
  const pw = document.getElementById("cfg-password").value.trim();
  const empPw = document.getElementById("cfg-employee-password")?.value.trim() || "";
  const cloudPhoneId = document.getElementById("cfg-cloud-phone-id")?.value.trim() || null;
  const cloudToken = document.getElementById("cfg-cloud-token")?.value.trim() || null;
  const body = {
    restaurantName: document.getElementById("cfg-name").value.trim(),
    restaurantCity: document.getElementById("cfg-city").value.trim(),
    personaName: document.getElementById("cfg-persona")?.value.trim() || null,
    ownerNumbers: document.getElementById("cfg-owners").value.trim(),
    whatsappPhone: document.getElementById("cfg-wa-phone").value.replace(/\D/g, "") || null,
    cloudPhoneNumberId: cloudPhoneId,
    welcomeLogoUrl: document.getElementById("cfg-welcomeLogoUrl")?.value.trim() || null,
    welcomeTagline: document.getElementById("cfg-welcomeTagline")?.value.trim() || null,
    openingHoursText: document.getElementById("cfg-openingHoursText")?.value.trim() || null,
    brandColor: document.getElementById("cfg-brandColor")?.value.trim() || null,
    notificationsEnabled: !!document.getElementById("cfg-notifications-enabled")?.checked,
    emergencyContacts: document.getElementById("cfg-emergency-contacts")?.value.trim() || null,
    // Only WhatsApp is ever togglable here — sms/email/push checkboxes are
    // disabled stubs in the UI, so this can never include them.
    notificationChannels: document.getElementById("cfg-notif-channel-whatsapp")?.checked ? "whatsapp" : "",
    criticalOnlyMode: !!document.getElementById("cfg-critical-only-mode")?.checked,
    ...(pw ? { dashboardPassword: pw } : {}),
    ...(empPw ? { employeePassword: empPw } : {}),
    ...(cloudToken ? { cloudToken } : {}),
  };
  try {
    const result = await api("/config", { method: "PUT", body: JSON.stringify(body) });
    document.getElementById("cfg-password").value = "";
    const empPwEl = document.getElementById("cfg-employee-password");
    if (empPwEl) empPwEl.value = "";
    const tokenEl = document.getElementById("cfg-cloud-token");
    if (tokenEl) tokenEl.value = "";
    if (result.sessionReset) {
      showToast("WhatsApp number changed", "Session resetting — scan the new QR or enter the pairing code.");
      setTimeout(() => window.openQRModal?.(), 1200);
    } else {
      showToast("Saved", "Settings updated.");
    }
  } catch (e) {
    showToast("Error", "Could not save.");
  }
}

export async function savePaymentConfig() {
  const upiChecked = !!document.getElementById("pm-upi")?.checked;
  const onlineChecked = !!document.getElementById("pm-online")?.checked;
  const upiId = document.getElementById("cfg-upi")?.value.trim() || "";
  const requiresPayment = !!document.getElementById("cfg-requirePayment").checked;

  if (upiChecked && !upiId) {
    showToast("Validation Error", "UPI ID is required when UPI payment method is selected.");
    document.getElementById("cfg-upi")?.focus();
    return;
  }

  if (requiresPayment) {
    const rzpEnabled = !!document.getElementById("cfg-rzpEnabled")?.checked;
    const rzpKeyId   = document.getElementById("cfg-rzpKeyId")?.value.trim() || "";
    const rzpSecret  = document.getElementById("cfg-rzpKeySecret")?.value.trim() || "";
    // Secret is never pre-filled (security) — treat as saved if keyId already exists in DB
    const secretProvided = !!rzpSecret || !!cachedCfg.razorpayKeyId;
    const razorpayReady = !!(onlineChecked && rzpEnabled && rzpKeyId && secretProvided);
    const upiReady = upiChecked && !!upiId;
    if (!razorpayReady && !upiReady) {
      showToast(
        "Validation Error",
        "Require payment is on — select UPI (with a UPI ID) or Online (with Razorpay enabled + Key ID + Secret)."
      );
      return;
    }
  }

  const selected = ["cash", "upi", "card", "online"].filter(m => document.getElementById(`pm-${m}`)?.checked);
  const body = {
    upiId: upiId || null,
    paymentMethods: selected.length ? selected.join(",") : "cash",
    requiresPaymentBeforeOrder: requiresPayment,
  };

  // Save Razorpay fields together when online is enabled
  if (onlineChecked) {
    body.razorpayEnabled = !!document.getElementById("cfg-rzpEnabled")?.checked;
    const rzpKeyId = document.getElementById("cfg-rzpKeyId")?.value.trim();
    if (rzpKeyId) body.razorpayKeyId = rzpKeyId;
    const rzpSecret = document.getElementById("cfg-rzpKeySecret")?.value.trim();
    if (rzpSecret) body.razorpayKeySecret = rzpSecret;
    const rzpWebhook = document.getElementById("cfg-rzpWebhook")?.value.trim();
    if (rzpWebhook) body.razorpayWebhookSecret = rzpWebhook;
  }

  try {
    await api("/config", { method: "PUT", body: JSON.stringify(body) });
    if (document.getElementById("cfg-rzpKeySecret")) document.getElementById("cfg-rzpKeySecret").value = "";
    if (document.getElementById("cfg-rzpWebhook")) document.getElementById("cfg-rzpWebhook").value = "";
    showToast("Saved", "Payment config updated.");
  } catch (e) {
    showToast("Error", "Could not save.");
  }
}

export async function saveRazorpay() {
  const body = {
    razorpayEnabled: document.getElementById("cfg-rzpEnabled").checked,
    razorpayKeyId: document.getElementById("cfg-rzpKeyId").value.trim() || null,
  };
  const secret = document.getElementById("cfg-rzpKeySecret").value.trim();
  const wh = document.getElementById("cfg-rzpWebhook").value.trim();
  if (secret) body.razorpayKeySecret = secret;
  if (wh) body.razorpayWebhookSecret = wh;
  try {
    await api("/config", { method: "PUT", body: JSON.stringify(body) });
    document.getElementById("cfg-rzpKeySecret").value = "";
    document.getElementById("cfg-rzpWebhook").value = "";
    showToast("Saved", "Razorpay settings updated.");
  } catch (e) {
    showToast("Error", "Could not save.");
  }
}

export async function savePause() {
  try {
    const message = document.getElementById("cfg-pauseMessage").value.trim() || null;
    await api("/config", { method: "PUT", body: JSON.stringify({ pauseMessage: message }) });
    showToast("Saved", "Pause message updated.");
  } catch (e) {
    showToast("Error", "Could not save.");
  }
}
