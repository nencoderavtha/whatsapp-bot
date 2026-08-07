// Shared UI helpers

/**
 * `opts` accepts either a plain number (legacy `duration` param, unchanged
 * behavior for every existing caller) or an options object:
 *   { duration, persistent, onAcknowledge }
 * `persistent: true` renders an "Acknowledge" button instead of auto-dismissing
 * — used for critical notifications that must stay visible until the user
 * explicitly clears them. `onAcknowledge` runs when that button is clicked
 * (e.g. to POST /api/notifications/:id/ack) before the toast is removed.
 */
export function showToast(title, body, opts = 5000) {
  const options = typeof opts === "number" ? { duration: opts } : (opts || {});
  const persistent = !!options.persistent;
  const duration = options.duration ?? 5000;
  const id = "t_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7);
  const ackBtn = persistent
    ? `<button data-toast-ack="${id}" class="text-[10px] font-bold px-2.5 py-1 rounded-lg bg-red-500/20 text-red-300 border border-red-500/30 hover:bg-red-500/30 transition-all mt-2">Acknowledge</button>`
    : "";
  const html = `
    <div id="${id}" class="glass shadow-2xl rounded-2xl p-4 border ${persistent ? "border-red-500/40" : "border-rose-500/25"} flex items-start gap-3 toast-enter pointer-events-auto">
      <div class="text-xl">${persistent ? "🚨" : "🔔"}</div>
      <div class="flex-1">
        <h4 class="font-bold text-xs ${persistent ? "text-red-400" : "text-rose-400"}">${title}</h4>
        <p class="text-[11px] text-slate-300 mt-1">${body}</p>
        ${ackBtn}
      </div>
      <button onclick="document.getElementById('${id}').remove()" class="text-slate-500 hover:text-slate-200 text-xs">✕</button>
    </div>`;
  document.getElementById("toast-container").insertAdjacentHTML("beforeend", html);

  if (persistent) {
    document.querySelector(`[data-toast-ack="${id}"]`)?.addEventListener("click", async () => {
      try { await options.onAcknowledge?.(); } catch (e) {}
      document.getElementById(id)?.remove();
    });
    return; // no auto-dismiss — stays until acknowledged or manually closed
  }

  setTimeout(() => {
    const el = document.getElementById(id);
    if (!el) return;
    el.style.transition = "all .3s";
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 300);
  }, duration);
}

// Notification sound presets — selectable from Settings (employee audio prefs).
// Keyed by the value stored in localStorage under "notifSound".
const SOUND_PRESETS = {
  classic: [[587.33, 880, 0.2, 0.6, "sine"], [1174.66, 1760, 0.1, 0.5, "triangle"]],
  bell:    [[659.25, 987.77, 0.24, 0.9, "sine"]],
  chime:   [[1046.5, 1568, 0.16, 0.45, "triangle"], [1568, 2093, 0.09, 0.35, "sine"]],
};

export function playChime() {
  const sound = localStorage.getItem("notifSound") || "classic";
  if (sound === "silent") return;
  const volume = Number(localStorage.getItem("notifVolume") ?? 0.6);
  const preset = SOUND_PRESETS[sound] || SOUND_PRESETS.classic;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const now = ctx.currentTime;
    preset.forEach(([f1, f2, g, dur, type]) => {
      const o = ctx.createOscillator(), gn = ctx.createGain();
      o.type = type;
      o.frequency.setValueAtTime(f1, now);
      o.frequency.exponentialRampToValueAtTime(f2, now + 0.15);
      gn.gain.setValueAtTime(g * volume, now);
      gn.gain.exponentialRampToValueAtTime(0.001, now + dur);
      o.connect(gn); gn.connect(ctx.destination);
      o.start(now); o.stop(now + dur);
    });
  } catch (e) {}
}

export function badge(s) {
  return ({
    pending: "bg-amber-500/10 text-amber-500 border border-amber-500/20",
    confirmed: "bg-blue-500/10 text-blue-400 border border-blue-500/20",
    preparing: "bg-indigo-500/10 text-indigo-400 border border-indigo-500/20",
    ready: "bg-green-500/10 text-green-400 border border-green-500/20",
    delivered: "bg-slate-500/10 text-slate-400 border border-slate-500/20",
    cancelled: "bg-rose-500/10 text-rose-400 border border-rose-500/20",
    rejected: "bg-rose-500/10 text-rose-400 border border-rose-500/20",
  })[s] || "bg-slate-500/10 text-slate-400";
}

export function pmtBadge(s) {
  return ({
    paid: "bg-green-500/10 text-green-400 border border-green-500/20",
    pending: "bg-amber-500/10 text-amber-500 border border-amber-500/20",
    failed: "bg-rose-500/10 text-rose-400 border border-rose-500/20",
    refunded: "bg-slate-500/10 text-slate-400 border border-slate-500/20",
  })[s] || "bg-slate-500/10 text-slate-400";
}

export function esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function isTabActive(id) {
  const el = document.getElementById("tab-" + id);
  return el && !el.classList.contains("hidden");
}
