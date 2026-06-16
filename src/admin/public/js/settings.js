import { api } from "./api.js";
import { showToast } from "./utils.js";

let cachedCfg = {};

export function getCachedConfig() { return cachedCfg; }
export function setCachedConfig(cfg) { cachedCfg = cfg; }

export async function loadSettings() {
  try {
    cachedCfg = await api("/config");
    populateConfig(cachedCfg);
  } catch (e) {
    showToast("Error", "Failed to load settings.");
  }
}

export function togglePaymentExpand(sectionId, show) {
  const el = document.getElementById(sectionId);
  if (el) el.classList.toggle("hidden", !show);
}

function populateConfig(cfg) {
  document.getElementById("cfg-name").value = cfg.restaurantName || "";
  document.getElementById("cfg-city").value = cfg.restaurantCity || "";
  document.getElementById("cfg-owners").value = cfg.ownerNumbers || "";
  document.getElementById("cfg-wa-phone").value = cfg.whatsappPhone || "";
  document.getElementById("cfg-requirePayment").checked = !!cfg.requiresPaymentBeforeOrder;
  document.getElementById("cfg-pauseMessage").value = cfg.pauseMessage || "";
  // Cloud API — phoneNumberId is pre-filled; token is never pre-filled (treat as secret)
  const cloudPhoneEl = document.getElementById("cfg-cloud-phone-id");
  if (cloudPhoneEl) cloudPhoneEl.value = cfg.cloudPhoneNumberId || "";

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
  const cloudPhoneId = document.getElementById("cfg-cloud-phone-id")?.value.trim() || null;
  const cloudToken = document.getElementById("cfg-cloud-token")?.value.trim() || null;
  const body = {
    restaurantName: document.getElementById("cfg-name").value.trim(),
    restaurantCity: document.getElementById("cfg-city").value.trim(),
    ownerNumbers: document.getElementById("cfg-owners").value.trim(),
    whatsappPhone: document.getElementById("cfg-wa-phone").value.replace(/\D/g, "") || null,
    cloudPhoneNumberId: cloudPhoneId,
    ...(pw ? { dashboardPassword: pw } : {}),
    ...(cloudToken ? { cloudToken } : {}),
  };
  try {
    const result = await api("/config", { method: "PUT", body: JSON.stringify(body) });
    document.getElementById("cfg-password").value = "";
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
