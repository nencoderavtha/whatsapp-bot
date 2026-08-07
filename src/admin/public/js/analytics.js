// analytics.js — Owner-only "Restaurant Analytics" dashboard rendered at the
// top of the Orders tab. Fully self-contained: builds its own DOM inside the
// static #orders-analytics container (see index.html) on first call, then
// re-renders in place on every subsequent range change.
//
// Backed by GET /api/analytics/orders?range=...&from=...&to=... (owner-only
// on the backend — this module mirrors that gate on the frontend, but the
// backend's requireOwner check is the real boundary; see loadOrdersAnalytics()).
//
// ── Exports (for app.js to import + call once, alongside loadOrders(), when
// the Orders tab opens) ──────────────────────────────────────────────────
//   loadOrdersAnalytics
// ─────────────────────────────────────────────────────────────────────────

import { api } from "./api.js";
import { esc } from "./utils.js";
import { getRole } from "./app.js";

// ── Fixed color assignments — reusing this app's existing status-color
// convention (see badge() in utils.js / STATUS_LABELS in orders.js) rather
// than inventing a new palette. Never remapped between renders. ───────────
const SPLIT_COLORS = { food: "#1d4ed8", delivery: "#64748b", refund: "#f43f5e" };
const LINE_COLOR = "#1d4ed8";  // revenue trend — navy blue, matching the reference dashboard's primary line
const BAR_COLOR = "#dbeafe";   // orders-by-hour — pale blue for every hour except the peak
const BAR_COLOR_PEAK = "#1e3a8a"; // the single busiest bucket, called out like the reference design

// KPI card accents — icon-chip background + bottom accent bar. Reuses the
// same Tailwind chip idiom as the rest of this app (bg-COLOR-950/40 +
// text-COLOR-400 — see utils.js's badge()/pmtBadge()), which theme-light.css
// already flattens to a pastel chip in light mode, so no per-theme branching
// is needed here.
const ACCENT = {
  rose:    { chip: "bg-rose-950/40 text-rose-400",    bar: "#f43f5e" },
  amber:   { chip: "bg-amber-950/40 text-amber-400",  bar: "#f59e0b" },
  emerald: { chip: "bg-emerald-950/40 text-emerald-400", bar: "#10b981" },
  blue:    { chip: "bg-blue-950/40 text-blue-400",    bar: "#3b82f6" },
  indigo:  { chip: "bg-indigo-950/40 text-indigo-400", bar: "#6366f1" },
  purple:  { chip: "bg-purple-950/40 text-purple-400", bar: "#a855f7" },
  slate:   { chip: "bg-slate-800 text-slate-400",     bar: "#64748b" },
};

// ── Formatting helpers ──────────────────────────────────────────────────
const NF = new Intl.NumberFormat("en-IN");
function money(n) {
  const v = Math.round(Number(n) || 0);
  return (v < 0 ? "-₹" : "₹") + NF.format(Math.abs(v)); // net earnings can go negative
}
function num(n) { return NF.format(Math.round(Number(n) || 0)); }
function mins(n) { return `${Math.round(n)} min`; }

// Rounds a chart-axis ceiling up to a "nice" number (1/2/5 × 10^n).
function niceCeil(n) {
  if (!n || n <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(n)));
  const frac = n / exp;
  const niceFrac = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10;
  return niceFrac * exp;
}

// ── State ────────────────────────────────────────────────────────────────
let scaffolded = false;
let firstLoadDone = false;
let currentRange = "today";
let currentFrom = "";
let currentTo = "";
let fetchSeq = 0;

// ── Entry point ──────────────────────────────────────────────────────────
export async function loadOrdersAnalytics() {
  const container = document.getElementById("orders-analytics");
  if (!container) return;

  const isEmployee = getRole() === "employee";
  container.classList.toggle("hidden", isEmployee);
  // Defense in depth: the backend route is separately requireOwner-gated —
  // never even call the API for an employee session, mirroring the pattern
  // used throughout this app (see menu.js's loadMenu()).
  if (isEmployee) return;

  ensureScaffold(container);
  await fetchAndRender();
}

// ── Scaffold (built once, filled in on every render) ────────────────────
function ensureScaffold(container) {
  if (scaffolded) return;
  container.innerHTML = SCAFFOLD_HTML;
  scaffolded = true;

  document.getElementById("analytics-range-select")?.addEventListener("change", onRangeChange);
  document.getElementById("analytics-apply-custom")?.addEventListener("click", onApplyCustomRange);
}

function onRangeChange(e) {
  const val = e.target.value;
  currentRange = val;
  const customWrap = document.getElementById("analytics-custom-range");
  customWrap?.classList.toggle("hidden", val !== "custom");
  if (val === "custom") {
    // Wait for both dates + Apply — unless they're already filled in from a
    // previous custom selection this session, in which case re-fetch now.
    const from = document.getElementById("analytics-from")?.value;
    const to = document.getElementById("analytics-to")?.value;
    if (from && to) { currentFrom = from; currentTo = to; fetchAndRender(); }
    return;
  }
  fetchAndRender();
}

function onApplyCustomRange() {
  const fromInput = document.getElementById("analytics-from");
  const toInput = document.getElementById("analytics-to");
  const from = fromInput?.value;
  let to = toInput?.value;
  if (!from || !to) return;
  if (to < from) { to = from; if (toInput) toInput.value = to; }
  currentFrom = from;
  currentTo = to;
  fetchAndRender();
}

// ── Fetch + render (skeleton on first load only; dim-in-place on re-fetch) ─
async function fetchAndRender() {
  const skeleton = document.getElementById("analytics-skeleton");
  const content = document.getElementById("analytics-content");
  const seq = ++fetchSeq;
  hideTooltip();

  if (!firstLoadDone) {
    skeleton?.classList.remove("hidden");
    content?.classList.add("hidden");
  } else {
    content?.classList.add("opacity-50", "pointer-events-none");
  }

  try {
    const params = new URLSearchParams({ range: currentRange });
    if (currentRange === "custom") {
      if (currentFrom) params.set("from", currentFrom);
      if (currentTo) params.set("to", currentTo);
    }
    const data = await api(`/analytics/orders?${params.toString()}`);
    if (seq !== fetchSeq) return; // a newer request superseded this one

    // Unhide BEFORE rendering: the fixed-height chart containers (below) size
    // their SVG viewBox off each container's actual rendered pixel dimensions
    // so charts fill their box without letterboxing or aspect-ratio distortion
    // — that measurement reads 0 while `#analytics-content` is still
    // `display:none`. Flipping visibility first (still within this same
    // synchronous tick, so nothing empty ever actually paints) makes the
    // measurement real before renderAll() reads it.
    skeleton?.classList.add("hidden");
    content?.classList.remove("hidden", "opacity-50", "pointer-events-none");
    renderAll(data);
    firstLoadDone = true;
  } catch (e) {
    if (seq !== fetchSeq) return;
    if (!firstLoadDone) {
      skeleton?.classList.add("hidden");
      content?.classList.remove("hidden");
      const kpis = document.getElementById("analytics-kpis");
      if (kpis) kpis.innerHTML = `<div class="text-center text-slate-500 text-xs py-10">Failed to load analytics.</div>`;
    } else {
      content?.classList.remove("opacity-50", "pointer-events-none");
    }
  }
}

function renderAll(data) {
  renderHeader(data.range);
  renderKpis(data);
  renderRevenueTrendChart(data.charts.revenueTrend);
  renderOrderStatusBars(data.orders);
  renderRevenueSplitDonut(data.charts.revenueSplit);
  financialSummaryInto("analytics-financial-summary", data.cashflow);
  renderOrdersByHourChart(data.charts.ordersByHour);
}

// ── Header ───────────────────────────────────────────────────────────────
function headerTitle(range) {
  switch (range?.key) {
    case "today": return "Today's Restaurant Analytics";
    case "yesterday": return "Yesterday's Restaurant Analytics";
    case "last7": return "Last 7 Days — Restaurant Analytics";
    case "month": return "This Month's Restaurant Analytics";
    case "custom": return "Custom Range — Restaurant Analytics";
    default: return `${range?.label || "Restaurant"} Analytics`;
  }
}

function renderHeader(range) {
  const titleEl = document.getElementById("analytics-title");
  const subEl = document.getElementById("analytics-subtitle");
  if (titleEl) titleEl.textContent = headerTitle(range);
  if (subEl) {
    try {
      const fromD = new Date(range.from);
      const toD = new Date(range.to);
      const fmt = (d) => d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
      subEl.textContent = fromD.toDateString() === toD.toDateString() ? fmt(fromD) : `${fmt(fromD)} – ${fmt(toD)}`;
    } catch (e) {
      subEl.textContent = range?.label || "";
    }
  }
  const sel = document.getElementById("analytics-range-select");
  if (sel && sel.value !== currentRange) sel.value = currentRange;
}

// ── KPI tiles ────────────────────────────────────────────────────────────
// TODO: KPI tiles ship without a period-over-period delta/trend-arrow badge.
// A naive delta would need a second backend fetch (the same-length immediately
// preceding period) that isn't in the current /api/analytics/orders contract —
// out of scope for this pass rather than fabricating a fake percentage.
// `icon` is a Material Symbols glyph name (e.g. "receipt_long"), matching the
// reference design's icon set instead of this app's usual emoji shorthand —
// scoped to this dashboard only (see the .material-symbols-outlined face
// loaded in index.html's <head>, and the icon() helper below).
//
// `pct`, when provided, renders a REAL proportional fill (e.g. this tile's
// count ÷ its section's shared total) instead of the flat accent stripe —
// only wired up where that proportion is mathematically meaningful (see
// renderKpis()); never a fabricated/illustrative percentage.
function kpiTile(iconName, label, value, opts = {}) {
  const { sub = "", big = false, muted = false, valueColor = "", accent = "slate", pct = null } = opts;
  const a = ACCENT[accent] || ACCENT.slate;
  const valCls = muted ? "text-slate-600" : (valueColor || "text-slate-100");
  const barInner = pct != null
    ? `<div class="h-full rounded-full transition-all" style="background:${a.bar};width:${Math.max(0, Math.min(100, pct))}%"></div>`
    : `<div class="h-full rounded-full" style="background:${a.bar};opacity:${muted ? 0 : 0.55};width:100%"></div>`;
  return `
    <div class="analytics-card relative overflow-hidden p-3 flex flex-col gap-1.5 min-w-0 hover:-translate-y-0.5 hover:shadow-md transition-all duration-200">
      <div class="absolute right-0 top-0 w-10 h-10 rounded-bl-full opacity-[0.12]" style="background:${a.bar}"></div>
      <div class="flex items-start justify-between gap-2 z-10">
        <span class="font-label-caps text-[9px] font-bold uppercase text-slate-500 leading-snug pt-0.5">${esc(label)}</span>
        <span class="w-6 h-6 rounded-lg flex items-center justify-center flex-shrink-0 ${a.chip}">${icon(iconName, "text-[13px]")}</span>
      </div>
      <div class="${big ? "text-xl md:text-2xl" : "text-base md:text-lg"} font-bold ${valCls} leading-tight truncate z-10">${esc(String(value))}</div>
      ${sub ? `<div class="text-[9px] text-slate-500 leading-snug truncate -mt-0.5 z-10">${esc(sub)}</div>` : ""}
      <div class="mt-0.5 h-1 w-full rounded-full bg-slate-800 overflow-hidden z-10">${barInner}</div>
    </div>`;
}

// Material Symbols Outlined glyph, sized/colored via classes (the icon font
// itself is loaded once in index.html's <head>, scoped to this dashboard).
function icon(name, cls = "") {
  return `<span class="material-symbols-outlined ${cls}">${name}</span>`;
}

// Reduced to the 4 hero KPIs (Total Orders / Total Revenue / Avg Order Value
// / Completion Rate) matching the reference dashboard's top row exactly — the
// wider KPI catalog (Cash Flow breakdown, Customer/Operational/Product
// metrics, Quick Insights) from the earlier pass is no longer rendered here.
// It's still all present in the API response (data.customers, data.operational,
// data.products, data.insights, the full data.cashflow) if a future pass wants
// a "detailed view" toggle — nothing was removed from the backend/contract,
// only from what this compact layout displays.
//
// completionRate is a real ratio of two numbers already in the payload
// (orders.completed ÷ orders.total) — not a separately-tracked backend field,
// computed here the same honest way the proportional KPI bars are.
function renderKpis(d) {
  const o = d.orders, r = d.revenue;
  const completionRate = o.total > 0 ? (o.completed / o.total) * 100 : 0;

  const el = document.getElementById("analytics-kpis");
  if (!el) return;
  el.innerHTML = [
    kpiTile("receipt_long", "Total Orders", num(o.total), { accent: "blue", pct: 100, big: true }),
    kpiTile("account_balance_wallet", "Total Revenue", money(r.totalRevenue), { accent: "blue", pct: 100, big: true }),
    kpiTile("insights", "Avg Order Value", money(r.avgOrderValue), { accent: "slate", pct: 100, big: true }),
    kpiTile("task_alt", "Completion Rate", completionRate.toFixed(1) + "%", { accent: "emerald", pct: completionRate, big: true }),
  ].join("");
}

// ── Financial Summary — matches the reference panel's own shape: plain
// Inflow/Outflow rows, Net Earnings called out in a highlighted box below.
// Real numbers only (cf.inflow.total, cf.outflow.total, cf.netEarnings) —
// renders into the card the scaffold already provides (see SCAFFOLD_HTML),
// same pattern every other chart panel here uses.
function financialSummaryInto(containerId, cf) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const positive = cf.netEarnings >= 0;
  el.innerHTML = `
    <div class="space-y-2.5">
      <div class="flex justify-between items-center">
        <span class="text-slate-400 text-xs">Money Inflow</span>
        <span class="text-slate-100 text-sm font-semibold">${esc(money(cf.inflow.total))}</span>
      </div>
      <div class="text-[10px] text-slate-600 -mt-1.5">Online ${esc(money(cf.inflow.online))} · Cash ${esc(money(cf.inflow.cash))}</div>
      <div class="flex justify-between items-center pt-1">
        <span class="text-slate-400 text-xs">Money Outflow</span>
        <span class="text-slate-100 text-sm font-semibold">${esc(money(cf.outflow.total))}</span>
      </div>
      <div class="text-[10px] text-slate-600 -mt-1.5">Refunds ${esc(money(cf.outflow.refunds))}</div>
    </div>
    <div class="pt-3 mt-3 border-t border-slate-800 ${positive ? "bg-blue-950/30" : "bg-rose-950/30"} p-3 rounded-lg">
      <div class="flex justify-between items-end">
        <div>
          <span class="block font-label-caps text-[9px] uppercase font-bold tracking-wider mb-1 ${positive ? "text-blue-400" : "text-rose-400"}">Net Earnings</span>
          <span class="text-xl font-bold ${positive ? "text-blue-400" : "text-rose-400"}">${esc(money(cf.netEarnings))}</span>
        </div>
        <div class="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${positive ? "bg-blue-500/15" : "bg-rose-500/15"}">
          ${icon("account_balance", `text-[16px] ${positive ? "text-blue-400" : "text-rose-400"}`)}
        </div>
      </div>
    </div>`;
}

// ── Shared tooltip (one reusable element, moved on pointermove) ─────────
function showTooltip(x, y, html) {
  const tip = document.getElementById("analytics-tooltip");
  if (!tip) return;
  tip.innerHTML = html;
  tip.classList.remove("hidden");
  placeTooltip(tip, x, y);
}
function placeTooltip(tip, x, y) {
  const vw = window.innerWidth, vh = window.innerHeight;
  const w = tip.offsetWidth || 160, h = tip.offsetHeight || 40;
  tip.style.left = Math.min(x + 14, vw - w - 8) + "px";
  tip.style.top = Math.max(8, Math.min(y - h - 10, vh - h - 8)) + "px";
}
function hideTooltip() {
  document.getElementById("analytics-tooltip")?.classList.add("hidden");
}

function emptyChartMsg(msg) {
  return `<div class="h-[180px] flex items-center justify-center text-slate-600 text-xs text-center px-6">${esc(msg)}</div>`;
}

// Reads a chart container's actual rendered pixel size so its SVG's viewBox
// can be set to that exact box — meaning the chart fills its (CSS-fixed-
// height, fluid-width) container edge-to-edge with no letterboxing and no
// non-uniform-scale distortion, at whatever width the responsive grid gives
// it. Falls back to a sane default if the container isn't laid out yet
// (e.g. still `display:none` — see the ordering note in fetchAndRender()).
function measureBox(el, fallbackW, fallbackH) {
  const w = el.clientWidth, h = el.clientHeight;
  return { W: w > 0 ? w : fallbackW, H: h > 0 ? h : fallbackH };
}

// ── SVG path helpers ─────────────────────────────────────────────────────
// Bar/column mark: rounded data-end, square baseline (see this project's
// charting standard — mark specs, item 2).
function roundedTopRectPath(x, yTop, w, yBottom, r) {
  r = Math.max(0, Math.min(r, w / 2, yBottom - yTop));
  if (r <= 0.5) return `M${x},${yBottom} L${x},${yTop} L${x + w},${yTop} L${x + w},${yBottom} Z`;
  return [
    `M${x},${yBottom}`, `L${x},${yTop + r}`, `Q${x},${yTop} ${x + r},${yTop}`,
    `L${x + w - r},${yTop}`, `Q${x + w},${yTop} ${x + w},${yTop + r}`, `L${x + w},${yBottom}`, "Z",
  ].join(" ");
}
// Horizontal bar mark: square at the baseline (left), rounded at the data-end (right).
// Catmull-Rom → cubic-Bezier smoothing through the real data points (every
// point plotted is still an exact value — this only curves the connectors
// between them, the standard "smooth line" chart treatment).
function smoothLinePath(points) {
  if (points.length < 2) return "";
  if (points.length === 2) return `M${points[0][0].toFixed(1)},${points[0][1].toFixed(1)} L${points[1][0].toFixed(1)},${points[1][1].toFixed(1)}`;
  let d = `M${points[0][0].toFixed(1)},${points[0][1].toFixed(1)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] || points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] || p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}
function polarToCartesian(cx, cy, r, angle) {
  return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
}
function donutArcPath(cx, cy, rOuter, rInner, startAngle, endAngle) {
  const so = polarToCartesian(cx, cy, rOuter, startAngle);
  const eo = polarToCartesian(cx, cy, rOuter, endAngle);
  const si = polarToCartesian(cx, cy, rInner, endAngle);
  const ei = polarToCartesian(cx, cy, rInner, startAngle);
  const large = endAngle - startAngle > Math.PI ? 1 : 0;
  return [
    `M${so.x.toFixed(2)},${so.y.toFixed(2)}`,
    `A${rOuter},${rOuter} 0 ${large} 1 ${eo.x.toFixed(2)},${eo.y.toFixed(2)}`,
    `L${si.x.toFixed(2)},${si.y.toFixed(2)}`,
    `A${rInner},${rInner} 0 ${large} 0 ${ei.x.toFixed(2)},${ei.y.toFixed(2)}`,
    "Z",
  ].join(" ");
}

// ── Chart: Revenue Trend (line + area wash + crosshair) ──────────────────
function renderRevenueTrendChart(chart) {
  const wrap = document.getElementById("chart-revenue-trend");
  if (!wrap) return;
  const buckets = chart?.buckets || [];
  if (!buckets.length) { wrap.innerHTML = emptyChartMsg("No revenue data for this range yet."); return; }

  const { W, H } = measureBox(wrap, 560, 140);
  const padL = 46, padR = 12, padT = 12, padB = 20;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const n = buckets.length;
  const values = buckets.map((b) => Number(b.revenue) || 0);
  const maxY = niceCeil(Math.max(...values, 0));
  const xStep = n > 1 ? plotW / (n - 1) : 0;
  const xAt = (i) => padL + (n > 1 ? i * xStep : plotW / 2);
  const baseline = padT + plotH;
  const yAt = (v) => padT + plotH - (v / maxY) * plotH;

  const points = values.map((v, i) => [xAt(i), yAt(v)]);
  const linePath = smoothLinePath(points);
  const areaPath = `${linePath} L${points[n - 1][0].toFixed(1)},${baseline} L${points[0][0].toFixed(1)},${baseline} Z`;

  const gridVals = [0, maxY / 2, maxY];
  const gridLines = gridVals.map((v) => `<line x1="${padL}" y1="${yAt(v).toFixed(1)}" x2="${W - padR}" y2="${yAt(v).toFixed(1)}" stroke="#334155" stroke-opacity="0.35" stroke-width="1"/>`).join("");
  const yLabels = gridVals.map((v) => `<text x="${padL - 8}" y="${(yAt(v) + 3).toFixed(1)}" text-anchor="end" class="fill-slate-500" font-size="9">${esc(money(v))}</text>`).join("");

  const labelEvery = Math.max(1, Math.ceil(n / 6));
  const xLabels = buckets.map((b, i) => (i % labelEvery === 0 || i === n - 1)
    ? `<text x="${xAt(i).toFixed(1)}" y="${H - 8}" text-anchor="middle" class="fill-slate-500" font-size="9">${esc(b.label)}</text>` : "").join("");

  const gradId = "revGrad" + Math.random().toString(36).slice(2, 8);

  wrap.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" class="w-full h-full touch-none select-none" role="img" aria-label="Revenue trend line chart">
      <defs>
        <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${LINE_COLOR}" stop-opacity="0.18"/>
          <stop offset="100%" stop-color="${LINE_COLOR}" stop-opacity="0"/>
        </linearGradient>
      </defs>
      ${gridLines}${yLabels}
      <path d="${areaPath}" fill="url(#${gradId})" stroke="none"/>
      <path d="${linePath}" fill="none" stroke="${LINE_COLOR}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      ${xLabels}
      <line id="revcross" x1="0" y1="${padT}" x2="0" y2="${baseline}" stroke="#94a3b8" stroke-width="1" stroke-dasharray="2,2" class="hidden"/>
      <circle id="revdot" r="4" fill="${LINE_COLOR}" class="analytics-dot-ring hidden" stroke-width="2"/>
      <rect x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" fill="transparent" data-hitrect="1"/>
    </svg>`;

  const svg = wrap.querySelector("svg");
  const hitRect = svg.querySelector("[data-hitrect]");
  const crossLine = svg.querySelector("#revcross");
  const dot = svg.querySelector("#revdot");

  function handleMove(evt) {
    const rect = svg.getBoundingClientRect();
    const scaleX = W / rect.width;
    const localX = (evt.clientX - rect.left) * scaleX;
    let idx = n > 1 ? Math.round((localX - padL) / xStep) : 0;
    idx = Math.max(0, Math.min(n - 1, idx));
    const [px, py] = points[idx];
    crossLine.setAttribute("x1", px); crossLine.setAttribute("x2", px);
    crossLine.classList.remove("hidden");
    dot.setAttribute("cx", px); dot.setAttribute("cy", py);
    dot.classList.remove("hidden");
    const b = buckets[idx];
    showTooltip(evt.clientX, evt.clientY, `<div class="font-bold text-slate-100">${esc(money(b.revenue))}</div><div class="text-slate-400">${esc(b.label)}</div>`);
  }
  hitRect.addEventListener("pointermove", handleMove);
  hitRect.addEventListener("pointerleave", () => { crossLine.classList.add("hidden"); dot.classList.add("hidden"); hideTooltip(); });
}

// ── Chart: Orders by Hour (single-series bars) ────────────────────────────
function renderOrdersByHourChart(chart) {
  const wrap = document.getElementById("chart-orders-by-hour");
  if (!wrap) return;
  const buckets = chart?.buckets || [];
  if (!buckets.length) { wrap.innerHTML = emptyChartMsg("No orders in this range yet."); return; }

  const { W, H } = measureBox(wrap, 900, 100);
  const padL = 34, padR = 8, padT = 10, padB = 16;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const n = buckets.length;
  const values = buckets.map((b) => Number(b.orders) || 0);
  const maxY = niceCeil(Math.max(...values, 0));
  const slot = plotW / n;
  const barW = Math.min(24, slot * 0.6);
  const baseline = padT + plotH;
  const yAt = (v) => padT + plotH - (v / maxY) * plotH;

  const gridVals = [0, maxY / 2, maxY];
  const gridLines = gridVals.map((v) => `<line x1="${padL}" y1="${yAt(v).toFixed(1)}" x2="${W - padR}" y2="${yAt(v).toFixed(1)}" stroke="#334155" stroke-opacity="0.35" stroke-width="1"/>`).join("");
  const yLabels = gridVals.map((v) => `<text x="${padL - 8}" y="${(yAt(v) + 3).toFixed(1)}" text-anchor="end" class="fill-slate-500" font-size="9">${esc(num(v))}</text>`).join("");

  // Highlight the single busiest bucket — matches the reference design's
  // "Peak: 12pm-1pm" callout, and reuses the same max-bucket the backend's
  // insights.peakHour is already derived from (no new/fabricated data).
  const maxV = Math.max(...values);
  const peakIdx = maxV > 0 ? values.indexOf(maxV) : -1;
  const peakLabelEl = document.getElementById("chart-orders-peak-label");
  if (peakLabelEl) {
    peakLabelEl.textContent = peakIdx >= 0
      ? `${chart.granularity === "day" ? "Busiest day" : "Peak"}: ${buckets[peakIdx].label}`
      : "";
  }

  const labelEvery = Math.max(1, Math.ceil(n / 6));
  let bars = "", hits = "", xLabels = "";
  buckets.forEach((b, i) => {
    const cx = padL + slot * i + slot / 2;
    const x = cx - barW / 2;
    const v = values[i];
    const yTop = yAt(v);
    const r = Math.min(4, barW / 2, baseline - yTop);
    const d = v > 0 ? roundedTopRectPath(x, yTop, barW, baseline, r) : "";
    if (d) bars += `<path d="${d}" fill="${i === peakIdx ? BAR_COLOR_PEAK : BAR_COLOR}" data-idx="${i}" class="analytics-bar"/>`;
    hits += `<rect x="${(x - 2).toFixed(1)}" y="${padT}" width="${(barW + 4).toFixed(1)}" height="${plotH}" fill="transparent" data-hit="${i}"/>`;
    if (i % labelEvery === 0 || i === n - 1) xLabels += `<text x="${cx.toFixed(1)}" y="${H - 8}" text-anchor="middle" class="fill-slate-500" font-size="9">${esc(b.label)}</text>`;
  });

  wrap.innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="w-full h-full touch-none select-none" role="img" aria-label="Orders by hour bar chart">${gridLines}${yLabels}${bars}${xLabels}${hits}</svg>`;

  const svg = wrap.querySelector("svg");
  svg.querySelectorAll("[data-hit]").forEach((el) => {
    const idx = Number(el.dataset.hit);
    el.addEventListener("pointermove", (evt) => {
      const b = buckets[idx];
      showTooltip(evt.clientX, evt.clientY, `<div class="font-bold text-slate-100">${esc(num(b.orders))} orders</div><div class="text-slate-400">${esc(b.label)} · ${esc(money(b.revenue))}</div>`);
      svg.querySelectorAll(".analytics-bar").forEach((p) => p.setAttribute("opacity", p.dataset.idx === String(idx) ? "1" : "0.55"));
    });
    el.addEventListener("pointerleave", () => { hideTooltip(); svg.querySelectorAll(".analytics-bar").forEach((p) => p.setAttribute("opacity", "1")); });
  });
}

// ── Chart: Order Status Breakdown (4-category bar-with-label, matching the
// reference design's "Order Status Breakdown" panel) ─────────────────────
// "Ongoing" = orders.active (pending+confirmed+preparing+ready — orders still
// in flight); "Cancelled" here folds together orders.cancelled + orders.
// rejected into one bucket to match the reference's exact 4-category shape
// (the full 7-way breakdown by individual status still exists in data.charts.
// orderStatus for anyone consuming the raw API). All four numbers are real,
// already-fetched counts — nothing computed beyond a sum of two existing ones.
function renderOrderStatusBars(o) {
  const wrap = document.getElementById("chart-order-status-bars");
  if (!wrap) return;

  const cats = [
    { key: "total", label: "Total", value: o.total, color: "#dce3f0", hoverColor: "#c0c7d3" },
    { key: "completed", label: "Completed", value: o.completed, color: "#d8e2ff", hoverColor: "#afc6ff" },
    { key: "cancelled", label: "Cancelled", value: o.cancelled + o.rejected, color: "#ffdad6", hoverColor: "#f4b8b3" },
    { key: "ongoing", label: "Ongoing", value: o.active, color: "#545b66", hoverColor: "#3c444e" },
  ];
  const max = niceCeil(Math.max(...cats.map((c) => c.value), 1));

  wrap.innerHTML = `
    <div class="flex items-end justify-around gap-3 h-[95px]">
      ${cats.map((c) => {
        const h = Math.max(3, (c.value / max) * 100);
        return `
          <div class="flex flex-col items-center justify-end h-full flex-1 group" data-key="${c.key}">
            <div class="w-full text-center text-[10px] font-semibold text-slate-400 mb-1 opacity-0 group-hover:opacity-100 transition-opacity">${num(c.value)}</div>
            <div class="order-status-bar relative w-full max-w-[56px] rounded-t transition-colors cursor-pointer" style="height:${h}%;background:${c.color}" data-hover="${c.hoverColor}" data-base="${c.color}"></div>
          </div>`;
      }).join("")}
    </div>
    <div class="flex items-start justify-around gap-3 mt-1.5">
      ${cats.map((c) => `
        <div class="flex-1 flex flex-col items-center">
          <span class="font-label-caps text-[9px] font-bold uppercase text-slate-500">${esc(c.label)}</span>
          <span class="text-[9px] font-medium text-slate-500">${num(c.value)}</span>
        </div>`).join("")}
    </div>`;

  wrap.querySelectorAll(".order-status-bar").forEach((bar, i) => {
    const c = cats[i];
    bar.addEventListener("pointerenter", (evt) => {
      bar.style.background = bar.dataset.hover;
      showTooltip(evt.clientX, evt.clientY, `<div class="font-bold text-slate-100">${esc(num(c.value))}</div><div class="text-slate-400">${esc(c.label)}</div>`);
    });
    bar.addEventListener("pointermove", (evt) => showTooltip(evt.clientX, evt.clientY, `<div class="font-bold text-slate-100">${esc(num(c.value))}</div><div class="text-slate-400">${esc(c.label)}</div>`));
    bar.addEventListener("pointerleave", () => { bar.style.background = bar.dataset.base; hideTooltip(); });
  });
}

// ── Generic donut renderer (order-status + revenue-split reuse this) ─────
function renderDonut(containerId, segments, opts = {}) {
  const wrap = document.getElementById(containerId);
  if (!wrap) return;
  const total = segments.reduce((s, x) => s + (x.value || 0), 0);
  const size = 200, cx = size / 2, cy = size / 2, rOuter = 88, rInner = 60;
  const gapRad = 2 / rOuter; // ~2px surface gap between adjacent arcs, in radians

  let arcs = "";
  if (total <= 0) {
    arcs = `<circle cx="${cx}" cy="${cy}" r="${(rOuter + rInner) / 2}" fill="none" stroke="#334155" stroke-width="${rOuter - rInner}"/>`;
  } else {
    let angle = -Math.PI / 2;
    segments.forEach((seg) => {
      const frac = (seg.value || 0) / total;
      const sweep = frac * Math.PI * 2;
      if (sweep > 0) {
        const start = angle + gapRad / 2;
        const end = angle + sweep - gapRad / 2;
        if (end > start) arcs += `<path d="${donutArcPath(cx, cy, rOuter, rInner, start, end)}" fill="${seg.color}" data-key="${esc(seg.key)}"/>`;
      }
      angle += sweep;
    });
  }

  const centerLabel = opts.centerValue != null ? `
    <text x="${cx}" y="${cy - 5}" text-anchor="middle" class="fill-slate-100" font-size="22" font-weight="800">${esc(opts.centerValue)}</text>
    <text x="${cx}" y="${cy + 15}" text-anchor="middle" class="fill-slate-500" font-size="9.5" letter-spacing="0.5">${esc((opts.centerLabel || "").toUpperCase())}</text>` : "";

  const legend = segments.map((seg) => {
    const p = total > 0 ? Math.round((seg.value / total) * 100) : 0;
    return `
      <div class="flex items-center gap-2.5 text-[11px] py-1">
        <span class="w-2.5 h-2.5 rounded-[3px] flex-shrink-0" style="background:${seg.color}"></span>
        <span class="text-slate-400 flex-1 truncate">${esc(seg.label)}</span>
        <span class="text-slate-600 text-[10px]">${esc(seg.valueDisplay)}</span>
        <span class="font-bold w-9 text-right" style="color:${seg.color}">${p}%</span>
      </div>`;
  }).join("");

  wrap.innerHTML = `
    <div class="flex flex-col sm:flex-row items-center gap-5">
      <svg viewBox="0 0 ${size} ${size}" class="w-32 h-32 flex-shrink-0 touch-none select-none" role="img" aria-label="${esc(opts.ariaLabel || "chart")}">${arcs}${centerLabel}</svg>
      <div class="flex-1 w-full space-y-0.5">${legend}</div>
    </div>`;

  wrap.querySelectorAll("path[data-key]").forEach((path) => {
    const seg = segments.find((s) => s.key === path.dataset.key);
    if (!seg) return;
    path.addEventListener("pointermove", (evt) => {
      const p = total > 0 ? Math.round((seg.value / total) * 100) : 0;
      showTooltip(evt.clientX, evt.clientY, `<div class="font-bold text-slate-100">${esc(seg.valueDisplay)}</div><div class="text-slate-400">${esc(seg.label)} · ${p}%</div>`);
      path.setAttribute("opacity", "0.82");
    });
    path.addEventListener("pointerleave", () => { hideTooltip(); path.setAttribute("opacity", "1"); });
  });
}

function renderRevenueSplitDonut(split) {
  const s = split || { total: 0, food: 0, delivery: 0, refund: 0 };
  const segments = [
    { key: "food", label: "Food", value: s.food || 0, color: SPLIT_COLORS.food, valueDisplay: money(s.food) },
    { key: "delivery", label: "Delivery", value: s.delivery || 0, color: SPLIT_COLORS.delivery, valueDisplay: money(s.delivery) },
    { key: "refund", label: "Refunds", value: s.refund || 0, color: SPLIT_COLORS.refund, valueDisplay: money(s.refund) },
  ];
  renderDonut("chart-revenue-split", segments, { centerValue: money(s.total), centerLabel: "Total Revenue", ariaLabel: "Revenue split" });
}

// ── Scaffold markup (injected once into #orders-analytics) ──────────────
const SCAFFOLD_HTML = `
  <div class="flex items-center justify-between gap-3 flex-wrap mb-3.5">
    <div>
      <h2 id="analytics-title" class="font-headline text-base md:text-lg font-bold tracking-tight">Today's Restaurant Analytics</h2>
      <p id="analytics-subtitle" class="text-[11px] text-slate-500 mt-0.5">Live snapshot of orders, revenue &amp; performance</p>
    </div>
    <div class="flex items-center gap-2 flex-wrap">
      <div class="relative">
        <select id="analytics-range-select"
          class="appearance-none bg-slate-900 border border-slate-800 rounded pl-3.5 pr-8 py-2 text-[11px] font-semibold text-slate-300 shadow-sm hover:border-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500/30 cursor-pointer">
          <option value="today">Today</option>
          <option value="yesterday">Yesterday</option>
          <option value="last7">Last 7 Days</option>
          <option value="month">This Month</option>
          <option value="custom">Custom Range</option>
        </select>
        <span class="material-symbols-outlined absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 text-[16px] pointer-events-none">expand_more</span>
      </div>
      <div id="analytics-custom-range" class="hidden flex items-center gap-1.5 flex-wrap">
        <input type="date" id="analytics-from" class="analytics-date-input bg-slate-900 border border-slate-800 rounded px-2.5 py-2 text-[11px] text-slate-200 shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30" />
        <span class="text-slate-600 text-[11px]">to</span>
        <input type="date" id="analytics-to" class="analytics-date-input bg-slate-900 border border-slate-800 rounded px-2.5 py-2 text-[11px] text-slate-200 shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30" />
        <button id="analytics-apply-custom" class="gradient-btn text-white rounded px-3.5 py-2 text-[11px] font-bold">Apply</button>
      </div>
    </div>
  </div>

  <div id="analytics-skeleton" class="space-y-4 animate-pulse">
    <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
      ${Array.from({ length: 4 }, () => '<div class="h-[92px] bg-slate-900 border border-slate-800 rounded"></div>').join("")}
    </div>
    <div class="grid xl:grid-cols-3 gap-4">
      <div class="h-[260px] bg-slate-900 border border-slate-800 rounded xl:col-span-2"></div>
      <div class="h-[260px] bg-slate-900 border border-slate-800 rounded"></div>
    </div>
  </div>

  <!-- Layout mirrors the reference dashboard exactly: 4 hero KPIs, then a
       2/3 + 1/3 grid (Revenue Trend + Order Status Breakdown on the left,
       Revenue Split + Financial Summary stacked on the right), then Orders
       by Hour full-width below both — Live Orders (outside this component,
       see index.html's #tab-orders) renders under all of it, unchanged. -->
  <div id="analytics-content" class="hidden transition-opacity duration-200">
    <div id="analytics-kpis" class="grid grid-cols-2 md:grid-cols-4 gap-2.5 mb-3"></div>

    <div class="grid grid-cols-1 xl:grid-cols-3 gap-3 mb-3">
      <div class="xl:col-span-2 flex flex-col gap-3">
        <div class="analytics-card p-3 md:p-3.5">
          <h3 class="font-headline text-xs font-semibold text-slate-200 mb-2 flex items-center gap-1.5"><span class="material-symbols-outlined text-blue-400 text-[15px]">trending_up</span> Revenue &amp; Sales Trends</h3>
          <div id="chart-revenue-trend" class="h-[140px]"></div>
        </div>
        <div class="analytics-card p-3 md:p-3.5">
          <h3 class="font-headline text-xs font-semibold text-slate-200 mb-2 flex items-center gap-1.5"><span class="material-symbols-outlined text-blue-400 text-[15px]">bar_chart</span> Order Status Breakdown</h3>
          <div id="chart-order-status-bars"></div>
        </div>
      </div>
      <div class="xl:col-span-1 flex flex-col gap-3">
        <div class="analytics-card p-3 md:p-3.5">
          <h3 class="font-headline text-xs font-semibold text-slate-200 mb-2 flex items-center gap-1.5"><span class="material-symbols-outlined text-blue-400 text-[15px]">pie_chart</span> Revenue Split</h3>
          <div id="chart-revenue-split"></div>
        </div>
        <div class="analytics-card p-3 md:p-3.5 flex-1 flex flex-col">
          <h3 class="font-headline text-xs font-semibold text-slate-200 mb-2 flex items-center gap-1.5"><span class="material-symbols-outlined text-blue-400 text-[15px]">account_balance</span> Financial Summary</h3>
          <div id="analytics-financial-summary" class="flex-1"></div>
        </div>
      </div>
    </div>

    <div class="analytics-card p-3 md:p-3.5">
      <h3 class="font-headline text-xs font-semibold text-slate-200 mb-2 flex items-center justify-between gap-1.5">
        <span class="flex items-center gap-1.5"><span class="material-symbols-outlined text-blue-400 text-[15px]">schedule</span> Orders by Hour</span>
        <span id="chart-orders-peak-label" class="text-[10px] font-medium text-slate-500"></span>
      </h3>
      <div id="chart-orders-by-hour" class="h-[100px]"></div>
    </div>
  </div>

  <div id="analytics-tooltip" class="hidden fixed z-[70] pointer-events-none bg-slate-900 border border-slate-700 rounded shadow-2xl px-3 py-2 text-[11px] leading-snug max-w-[220px]"></div>
`;
