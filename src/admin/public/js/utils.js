// Shared UI helpers

export function showToast(title, body, duration = 5000) {
  const id = "t_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7);
  const html = `
    <div id="${id}" class="glass shadow-2xl rounded-2xl p-4 border border-rose-500/25 flex items-start gap-3 toast-enter pointer-events-auto">
      <div class="text-xl">🔔</div>
      <div class="flex-1">
        <h4 class="font-bold text-xs text-rose-400">${title}</h4>
        <p class="text-[11px] text-slate-300 mt-1">${body}</p>
      </div>
      <button onclick="document.getElementById('${id}').remove()" class="text-slate-500 hover:text-slate-200 text-xs">✕</button>
    </div>`;
  document.getElementById("toast-container").insertAdjacentHTML("beforeend", html);
  setTimeout(() => {
    const el = document.getElementById(id);
    if (!el) return;
    el.style.transition = "all .3s";
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 300);
  }, duration);
}

export function playChime() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const now = ctx.currentTime;
    [[587.33, 880, 0.2, 0.6, "sine"], [1174.66, 1760, 0.1, 0.5, "triangle"]].forEach(([f1, f2, g, dur, type]) => {
      const o = ctx.createOscillator(), gn = ctx.createGain();
      o.type = type;
      o.frequency.setValueAtTime(f1, now);
      o.frequency.exponentialRampToValueAtTime(f2, now + 0.15);
      gn.gain.setValueAtTime(g, now);
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
