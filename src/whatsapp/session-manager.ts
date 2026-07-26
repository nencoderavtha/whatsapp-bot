import { prisma } from "../db.js";
import { CloudAdapter } from "./cloud.js";
import { VOICE_NOTE_SENTINEL, type WhatsAppAdapter, type InboundMessage } from "./adapter.js";
import { handleIncoming } from "../ai/agent.js";
import { getOrder } from "../services/order.js";
import { config } from "../config.js";
import { notifyAdminOfEvent } from "../services/events.js";
import { orderConfirmationMsg, ownerNewOrderMsg } from "../services/notifications.js";
import { menuAsInteractiveListSections, menuAsInteractiveCarouselCards } from "../services/menu.js";
import { getOrCreateCustomer } from "../services/customer.js";
import { createPaymentLink } from "../services/razorpay.js";
import {
  orderStagedTemplate,
  systemErrorTemplate,
  voiceNoteFallbackTemplate,
  finalBillTemplate,
  paymentUnavailableTemplate,
} from "../ai/templates.js";
import { DeliveryOrchestrator } from "../services/delivery/orchestrator.js";
import { ownerHandoffMsg } from "../services/notifications.js";
import { logMessage } from "../services/customer.js";



/**
 * Show the menu visually — a real-photo carousel when today's items have photos
 * on file (lets customers see the dish while picking), falling back to the
 * plain text list for any day where photos aren't uploaded yet.
 */
/** Build the public web-menu URL from the auto-detected runtime server URL or fallback config. */
function webMenuUrlFor(restaurantId: number, phone: string): string {
  const base = botSessionManager.getPublicServerUrl().replace(/\/+$/, "");
  return `${base}/menu?r=${restaurantId}&phone=${encodeURIComponent(phone)}`;
}

/**
 * Show the menu (carousel or list), then — after a short pause — the web
 * menu link as a tappable "Full Menu" CTA button. Sending the link immediately
 * after the carousel can still let it arrive first in the chat, since Meta
 * takes a moment to process the carousel's images; the delay keeps the visible
 * order carousel-then-link.
 */
async function sendMenuVisual(
  adapter: CloudAdapter,
  phone: string,
  restaurantId: number,
  bodyText: string,
  webMenuUrl?: string,
): Promise<void> {
  const cards = await menuAsInteractiveCarouselCards(restaurantId);
  let sentCarousel = false;
  // Meta requires 2-10 cards for a carousel — fall back to the list otherwise.
  if (cards.length >= 2) {
    await adapter.sendInteractiveCarousel(phone, bodyText, cards);
    sentCarousel = true;
  } else {
    const sections = await menuAsInteractiveListSections(restaurantId);
    if (sections.length > 0) {
      await adapter.sendInteractiveList(phone, bodyText, "📋 Menu", sections);
      sentCarousel = true;
    }
  }
  if (webMenuUrl) {
    if (sentCarousel) await new Promise((r) => setTimeout(r, 1500));
    await adapter.sendInteractiveCtaUrl(phone, "Full menu photos tho web lo chudandi 👇", "📋 Full Menu", webMenuUrl);
  }
}

function splitBubbles(text: string): string[] {
  const lower = text.toLowerCase();
  if (lower.includes("total: ₹") || lower.includes("order breakdown") || lower.includes("here's your order") || lower.includes("order summary")) {
    return [text];
  }
  const parts = text.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts.slice(0, 8) : [text];
}

async function sendHumanly(adapter: CloudAdapter, phone: string, bubbles: string[], restaurantId: number) {
  for (const bubble of bubbles) {
    const lower = bubble.toLowerCase();

    // 1. Intercept full menu requests/greetings → native WhatsApp menu carousel (real photos)
    const isGreetingOrMenu =
      bubble.includes("Here's our menu:") ||
      bubble.includes("Here's our current menu") ||
      bubble.includes("Special Menu:") ||
      bubble.includes("I can help you order anything from") ||
      bubble.match(/here'?s?\s+(the|our)\s+(full\s+)?menu/i) !== null ||
      bubble.match(/take\s+a\s+look\s+at\s+(our|the)\s+menu/i) !== null ||
      (bubble.includes("Biryani") && bubble.includes("Annam") && bubble.includes("₹"));

    if (isGreetingOrMenu) {
      try {
        const webMenuUrl = webMenuUrlFor(restaurantId, phone);
        await sendMenuVisual(adapter, phone, restaurantId, "Ee roju menu idi andi 👇", webMenuUrl);
        continue;
      } catch (err) {
        console.error("[Cloud] Failed to build menu view:", err);
      }
    }

    // 2. Intercept cart staged summary → native WhatsApp interactive buttons (Confirm Order / Add More)
    const isCartSummary =
      (lower.includes("total: ₹") || lower.includes("here's your order") || lower.includes("order summary") || lower.includes("order breakdown")) &&
      !lower.includes("payment details") &&
      !lower.includes("order #");

    if (isCartSummary) {
      try {
        await adapter.sendInteractiveButtons(
          phone,
          bubble,
          [
            { id: "confirm_order_btn", title: "✅ Confirm & Pay" },
            { id: "add_more_items_btn", title: "➕ Add More Items" }
          ],
          "🛒 Order Summary",
          "Tap button to confirm or message to add items"
        );
        continue;
      } catch (err) {
        console.error("[Cloud] Cart summary buttons failed:", err);
      }
    }

    // 3. Intercept payment option requests -> multiple payment method buttons
    const isPaymentPrompt =
      lower.includes("how would you like to pay") ||
      lower.includes("choose your payment method") ||
      lower.includes("select a payment option");

    if (isPaymentPrompt) {
      try {
        const botCfg = await prisma.restaurantConfig.findUnique({ where: { id: 1 } });
        const methods = (botCfg?.paymentMethods ?? "cash,upi").split(",").map(s => s.trim().toLowerCase());

          const buttons: { id: string; title: string }[] = [];
          if (methods.includes("upi") && botCfg?.upiId) {
            buttons.push({ id: "pay_method_upi", title: "📱 Instant UPI" });
          }
          if (methods.includes("razorpay") && botCfg?.razorpayEnabled) {
            buttons.push({ id: "pay_method_razorpay", title: "💳 Pay Online" });
          }
          if (methods.includes("cash")) {
            buttons.push({ id: "pay_method_cash", title: "💵 Pay on Delivery" });
          }

          if (buttons.length > 0) {
            await adapter.sendInteractiveButtons(
              phone,
              `${bubble}\n\nPlease select your preferred payment method below:`,
              buttons.slice(0, 3),
              "💳 Select Payment Method",
              "Safe & Secure Payment Options"
            );
            continue;
          }
        } catch (err) {
          console.error("[Kapso] Payment buttons failed:", err);
        }
      }

      // 4. Intercept UPI payment links → native WhatsApp button message (no browser redirect)
      if (bubble.includes("upi://pay?")) {
        const upiMatch = bubble.match(/(upi:\/\/pay\?[^\s\n]+)/);
        if (upiMatch) {
          const upiLink = upiMatch[0];
          try {
            const urlObj = new URL(upiLink);
            const pa = urlObj.searchParams.get("pa") ?? "";
            const pn = urlObj.searchParams.get("pn") ?? "";
            const am = urlObj.searchParams.get("am") ?? "";
            const tn = urlObj.searchParams.get("tn") ?? "";

            const orderMatch = bubble.match(/[Oo]rder\s*#?(\d+)/);
            const orderId = orderMatch ? parseInt(orderMatch[1], 10) : 0;

            await adapter.sendPaymentDetails(phone, pa, pn, am, tn, orderId);
            continue;
          } catch (err) {
            console.error("Failed to parse UPI link for Kapso payment card:", err);
          }
        }
      }

      // 5. Intercept Razorpay links → interactive button (open in browser via CTA URL)
      if (bubble.includes("https://") && (bubble.includes("rzp.io") || bubble.includes("razorpay"))) {
        const rzpMatch = bubble.match(/(https:\/\/[^\s\n]+)/);
        if (rzpMatch) {
          const rzpUrl = rzpMatch[0];
          const amountMatch = bubble.match(/₹\d+/);
          const amountText = amountMatch ? ` ${amountMatch[0]}` : "";
          await adapter.sendInteractiveCtaUrl(
            phone,
            `Payment${amountText} — kinda button tap chesi pay cheyandi andi. Pay ayyaka order confirm avutundi.`,
            "💳 Pay",
            rzpUrl
          );
          continue;
        }
      }

      // 6. Intercept delivery address requests → native WhatsApp address collection sheet or saved address buttons
      const isAddressRequest =
        bubble.toLowerCase().includes("delivery address") ||
        bubble.toLowerCase().includes("provide your address") ||
        bubble.toLowerCase().includes("share your address") ||
        bubble.toLowerCase().includes("address details") ||
        bubble.toLowerCase().includes("where should we deliver");

      if (isAddressRequest) {
        try {
          const customer = await prisma.customer.findFirst({
            where: { phone },
            select: { name: true, address: true }
          });

          if (customer?.address) {
            await adapter.sendInteractiveButtons(
              phone,
              `🏠 We have your saved delivery address:\n*${customer.address}*\n\nWould you like to use this address or enter a new one?`,
              [
                { id: "use_saved_address", title: "🏠 Use Saved Address" },
                { id: "change_address", title: "✏️ Enter New Address" }
              ],
              "📍 Delivery Address",
              "Fast & Reliable Delivery"
            );
            continue;
          } else {
            await adapter.sendInteractiveAddress(
              phone,
              "🏠 Please tap below to enter your delivery address details securely.",
              { name: customer?.name ?? undefined }
            );
            continue;
          }
        } catch (err) {
          console.error("[Cloud] Failed to send address collection card:", err);
        }
      }

      // 7. General URL Interceptor → Convert ALL web links (menu, tracking, pay, general URLs)
      // into native Interactive CTA URL Buttons so they open directly inside WhatsApp's In-App Browser
      const urlMatch = bubble.match(/(https?:\/\/[^\s\n]+)/i);
      if (urlMatch) {
        const rawUrl = urlMatch[0];
        let cleanBody = bubble.replace(rawUrl, "").trim();
        if (!cleanBody) cleanBody = "Tap below to view inside WhatsApp 👇";

        let buttonTitle = "🌐 Open Link";
        if (rawUrl.includes("/menu")) buttonTitle = "📋 Full Menu";
        else if (rawUrl.includes("/pay") || rawUrl.includes("rzp.io") || rawUrl.includes("razorpay")) buttonTitle = "💳 Pay Online";
        else if (rawUrl.includes("track") || rawUrl.includes("order")) buttonTitle = "📍 Track Order";

        await adapter.sendInteractiveCtaUrl(phone, cleanBody, buttonTitle, rawUrl);
        continue;
      }

    await adapter.sendText(phone, bubble);
  }
}

async function notifyOwner(adapter: CloudAdapter, _restaurantId: number, orderId: number) {
  const [cfg, order] = await Promise.all([
    prisma.restaurantConfig.findUnique({ where: { id: 1 } }),
    getOrder(orderId),
  ]);
  if (!order) return;

  const ownerNumbers = (cfg?.ownerNumbers ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const text = ownerNewOrderMsg(order);

  for (const num of ownerNumbers) {
    try {
      await adapter.sendText(num, text);
    } catch (e) {
      console.error("[Owner Notify] Send failed:", e);
    }
  }
}

async function notifyOwnerOfHandoff(
  adapter: CloudAdapter,
  _restaurantId: number,
  customer: { name?: string | null; phone: string },
  lastMessage: string,
) {
  const cfg = await prisma.restaurantConfig.findUnique({ where: { id: 1 } });
  const ownerNumbers = (cfg?.ownerNumbers ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const text = ownerHandoffMsg(customer, lastMessage);
  for (const num of ownerNumbers) {
    try {
      await adapter.sendText(num, text);
    } catch (e) {
      console.error("[Owner Handoff] Send failed:", e);
    }
  }
}

async function sendOrderReceipt(adapter: CloudAdapter, phone: string, _restaurantId: number, orderId: number) {
  try {
    const [order, cfg] = await Promise.all([
      getOrder(orderId),
      prisma.restaurantConfig.findUnique({ where: { id: 1 } }),
    ]);
    if (!order || !cfg) return;
    await adapter.sendText(phone, orderConfirmationMsg(order, cfg.restaurantName));
  } catch (e) {
    console.error("[Receipt Send] Failed:", e);
  }
}

/** Restaurant pickup pincode, used as the origin for delivery quotes. */
const PICKUP_PINCODE = Number(process.env.PICKUP_PINCODE ?? 500033);
/** Used only when the provider quote fails — never leave a customer without a bill. */
const FALLBACK_DELIVERY_FEE = 45;

const deliveryOrchestrator = new DeliveryOrchestrator();

/**
 * Distinct delivery addresses this customer has used, newest first — their
 * current one plus anything from past orders. Recomputed on demand so the
 * `use_addr_<n>` buttons stay stateless across restarts.
 */
async function savedAddressesFor(
  customerId: number,
  currentAddress?: string | null,
): Promise<string[]> {
  const prevOrders = await prisma.order.findMany({
    where: { customerId, deliveryAddress: { not: null } },
    orderBy: { createdAt: "desc" },
    take: 5,
  });

  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of [currentAddress, ...prevOrders.map((o) => o.deliveryAddress)]) {
    const addr = (candidate ?? "").trim();
    if (!addr || seen.has(addr)) continue;
    seen.add(addr);
    out.push(addr);
  }
  return out;
}

/** Ask the customer to drop a pin, falling back to the map form CTA. */
async function sendPinLocationPrompt(adapter: CloudAdapter, phone: string): Promise<void> {
  const base = botSessionManager.getPublicServerUrl().replace(/\/+$/, "");
  const mapFormUrl = `${base}/address?phone=${encodeURIComponent(phone)}`;

  try {
    await adapter.sendInteractiveLocationRequest(
      phone,
      "📍 Delivery address kavali andi. Mee location share cheyandi, leda kinda button tap chesi map lo pin drop cheyandi.",
    );
  } catch (e) {
    console.warn("[Location Request Failed, sending CTA URL]", e);
  }

  await adapter.sendInteractiveCtaUrl(
    phone,
    "Ee link lo mee location pin drop cheyandi 👇",
    "📍 Drop Location on Maps",
    mapFormUrl,
  );
}

/** The address form appends the pincode as "... - 500081". */
function pincodeFromAddress(address?: string | null): number | null {
  const m = address?.match(/(\d{6})\s*$/) ?? address?.match(/\b(\d{6})\b/);
  return m ? Number(m[1]) : null;
}

async function notifyOwnerOfPaymentIssue(
  adapter: CloudAdapter,
  phone: string,
  amount: number,
) {
  const cfg = await prisma.restaurantConfig.findUnique({ where: { id: 1 } });
  const ownerNumbers = (cfg?.ownerNumbers ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const text = `⚠️ *Payment link failed!*\n\n👤 Customer: ${phone}\n💰 Amount: ₹${amount}\n\nRazorpay did not return a link. Please contact the customer.`;
  for (const num of ownerNumbers) {
    try {
      await adapter.sendText(num, text);
    } catch (e) {
      console.error("[Owner Payment Alert] Failed:", e);
    }
  }
}

/**
 * Cart is confirmed and a delivery address is known: quote the delivery fee,
 * show the final bill, then send the Razorpay link as a tappable CTA button.
 *
 * Every order is a delivery order and payment is Razorpay only, so a failure
 * here escalates to the owner rather than falling back to a cash option the
 * restaurant has no way to collect on.
 */
async function proceedToBilling(
  adapter: CloudAdapter,
  phone: string,
  restaurantId: number,
  customerId: number,
  address: string,
): Promise<void> {
  const pending = await prisma.pendingOrder.findFirst({
    where: { customerId, expiresAt: { gt: new Date() } },
  });
  if (!pending || !pending.lines || pending.lines === "[]") {
    await adapter.sendText(phone, "Cart empty andi. *📋 Menu* tap cheyandi.");
    return;
  }

  let lines: any[] = [];
  try { lines = JSON.parse(pending.lines); } catch {}

  const menuItems = await prisma.menuItem.findMany({
    where: { id: { in: lines.map((l) => l.menuItemId) } },
    include: { variants: true },
  });
  const byId = new Map(menuItems.map((m) => [m.id, m]));
  let subtotal = 0;
  for (const l of lines) {
    const mi = byId.get(l.menuItemId);
    if (!mi) continue;
    let p = mi.price;
    if (l.variantId) {
      const v = mi.variants.find((v) => v.id === l.variantId);
      if (v) p = v.price;
    }
    subtotal += p * l.qty;
  }

  // Live quote rather than a flat rate, so the fee matches the actual distance.
  let deliveryFee = FALLBACK_DELIVERY_FEE;
  try {
    const quotes = await deliveryOrchestrator.getAllQuotes({
      pickupPincode: PICKUP_PINCODE,
      deliveryPincode: pincodeFromAddress(address) ?? PICKUP_PINCODE,
    });
    if (quotes?.cheapest?.quotedFee != null) {
      deliveryFee = Math.round(quotes.cheapest.quotedFee);
    }
  } catch (e) {
    console.warn("[Delivery quote failed — using flat fee]", e);
  }

  const grandTotal = subtotal + deliveryFee;

  // Persist the quoted fee so the payment webhook builds the order with the same
  // number the customer was billed, instead of re-quoting and drifting.
  await prisma.pendingOrder.update({
    where: { id: pending.id },
    data: { deliveryFee, type: "delivery" },
  });

  await adapter.sendText(phone, finalBillTemplate(subtotal, deliveryFee));

  const cfg = await prisma.restaurantConfig.findUnique({ where: { id: 1 } });

  let payUrl: string | null = null;
  if (cfg?.razorpayEnabled && cfg.razorpayKeyId && cfg.razorpayKeySecret) {
    try {
      const payRes = await createPaymentLink({
        restaurantId,
        customerId,
        amount: grandTotal,
        customerPhone: phone,
        restaurantName: cfg.restaurantName,
      });
      payUrl = payRes?.url ?? null;
    } catch (e) {
      console.error("[Razorpay link generation failed]", e);
    }
  }

  if (!payUrl) {
    await adapter.sendText(phone, paymentUnavailableTemplate());
    await notifyOwnerOfPaymentIssue(adapter, phone, grandTotal);
    return;
  }

  await adapter.sendInteractiveCtaUrl(
    phone,
    "Pay ayyaka order confirm avutundi.",
    `💳 Pay ₹${grandTotal}`,
    payUrl,
  );
}

export class BotSessionManager {
  private sessions = new Map<number, CloudAdapter>();
  // Cloud API only: phoneNumberId → restaurantId for fast webhook routing
  private phoneIdMap = new Map<string, number>();
  private runtimeServerUrl?: string;

  /** Update runtime server URL dynamically from incoming webhook request headers */
  setRuntimeHost(protocol: string, host: string) {
    if (host && !host.includes("localhost")) {
      const proto = protocol.split(",")[0].trim();
      this.runtimeServerUrl = `${proto}://${host}`;
    }
  }

  getPublicServerUrl(): string {
    return (
      this.runtimeServerUrl ||
      config.serverUrl ||
      `http://localhost:${config.adminPort}`
    );
  }

  /** Start sessions for all active restaurants. */
  async startAll() {
    const restaurants = await prisma.restaurantConfig.findMany({ where: { isActive: true } });
    console.log(`🚀 Starting ${restaurants.length} bot session(s) [provider: Meta Cloud API]...`);
    for (const r of restaurants) {
      await this.startSession(r.id, r.restaurantName).catch((e) =>
        console.error(`Failed to start session for restaurant ${r.id}:`, e),
      );
    }
  }

  /** Start (or restart) a single restaurant's WhatsApp session. */
  async startSession(restaurantId: number, restaurantName: string) {
    if (this.sessions.has(restaurantId)) {
      console.log(`[r${restaurantId}] Session already running — skipping.`);
      return;
    }

    const botCfg = await prisma.restaurantConfig.findUnique({
      where: { id: restaurantId },
      select: { whatsappPhone: true, cloudPhoneNumberId: true, cloudToken: true },
    });

    const phoneNumberId = botCfg?.cloudPhoneNumberId || config.cloud.phoneNumberId;
    const token = botCfg?.cloudToken || config.cloud.token;
    if (!phoneNumberId || !token) {
      console.warn(`[r${restaurantId}] Cloud API not configured (missing phoneNumberId or token) — skipping.`);
      return;
    }
    const adapter = new CloudAdapter(phoneNumberId, token);
    this.phoneIdMap.set(phoneNumberId, restaurantId);

    adapter.onMessage(async (msg) => {
      console.log(`[${restaurantName}] 💬 ${msg.phone}: ${msg.text}`);
      try {
        const cfg = await prisma.restaurantConfig.findUnique({
          where: { id: restaurantId },
          select: {
            restaurantName: true,
            restaurantCity: true,
            botPaused: true,
            pauseMessage: true,
          },
        });
        if (cfg?.botPaused) {
          const pauseMsg = cfg.pauseMessage ?? "Sorry, we're temporarily unavailable. We'll be back shortly! 🙏";
          await sendHumanly(adapter, msg.phone, [pauseMsg], restaurantId);
          return;
        }

        const rName = cfg?.restaurantName ?? restaurantName ?? "our restaurant";

        const customer = await getOrCreateCustomer(msg.phone, msg.name);

        // ── Human handoff active: AI is paused for this customer ────────────────
        // Staff reply from the dashboard until they hit "Resume AI". We still log
        // the inbound message so it shows live in the dashboard chat.
        if (customer?.humanRequestedAt) {
          await logMessage(customer.id, "user", msg.text);
          return;
        }

        // ── Voice note (no speech-to-text yet) — ask for text or a call instead ──
        if (msg.text === VOICE_NOTE_SENTINEL) {
          await adapter.sendText(msg.phone, voiceNoteFallbackTemplate());
          return;
        }

        const isGreeting = ["hi", "hello", "hey", "namaste", "start", "yo", "hola", "namaskar"].includes(msg.text.trim().toLowerCase());

        if (isGreeting) {
          // Greet and let the customer choose. This used to push a hero image and
          // then the full menu 1.2s later, so the welcome was buried and nobody
          // got a say in what they saw next.
          const nameStr = customer?.name ? `${customer.name} garu` : "andi";
          const greetingName = cfg?.restaurantName ?? "Godavari Ruchulu";

          await adapter.sendInteractiveButtons(
            msg.phone,
            `Namaskaram ${nameStr} 🙏\n\n${greetingName} ki welcome. Ee roju menu ready undi.`,
            [
              { id: "view_menu", title: "📋 Menu" },
              { id: "location_info", title: "📍 Location & Hours" },
            ],
          );
          return;
        }

        const rawText = msg.text.trim();
        const lowerText = rawText.toLowerCase();
        const cleanText = lowerText.replace(/[^\w\s]/g, "").trim();

        // ── Direct Action 1: View Menu ───────────────────────────────────────
        // Item button ids look like "menu_item_22" / "menu_item_22_v_3", which the
        // substring check below would otherwise treat as "show me the menu" — the
        // add-to-cart handler further down never got reached, so every tap on an
        // item just reopened the menu.
        const isMenuItemButton = /^menu_item_\d+(?:_v_\d+)?$/.test(rawText);
        if (
          !isMenuItemButton &&
          (rawText === "view_menu" ||
            cleanText === "menu" ||
            cleanText.includes("menu") ||
            /\bmenu\b/i.test(lowerText))
        ) {
          const webMenuUrl = webMenuUrlFor(restaurantId, msg.phone);

          await sendMenuVisual(adapter, msg.phone, restaurantId, "Ee roju menu idi andi 👇", webMenuUrl);
          return;
        }

        // ── Direct Action 2: Location & Hours ────────────────────────────────
        if (rawText === "location_info" || lowerText === "location & hours" || lowerText.includes("location") || lowerText.includes("opening hours")) {
          const city = cfg?.restaurantCity ?? "Hyderabad";
          const locationMsg = `*${rName}*, ${city}\nEvening service 7:30 PM nunchi andi.`;
          await adapter.sendText(msg.phone, locationMsg);
          return;
        }

        // ── Direct Action 3: Dish photo request (e.g. "chepala pulusu photo pampandi") ──
        const photoKeywords = ["photo", "pic ", "pics", "picture", "image", "chupinchu", "chupincharu", "choodali", "chudali"];
        if (photoKeywords.some((k) => lowerText.includes(k))) {
          const items = await prisma.menuItem.findMany({
            where: { available: true, imageUrl: { not: null } },
            select: { name: true, imageUrl: true },
          });
          const matched = items.find((item) => {
            const nameWords = item.name.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
            const hits = nameWords.filter((w) => lowerText.includes(w)).length;
            return hits >= Math.min(2, nameWords.length);
          });
          if (matched?.imageUrl) {
            await adapter.sendImage(msg.phone, matched.imageUrl, matched.name);
            return;
          }
          // No confident dish match or no photo on file — fall through to the normal reply.
        }

        // ── Direct Action 4: Item Selection (carousel/list "Add" or variant pick) ──
        // Formats: menu_item_<id>  OR  menu_item_<id>_v_<variantId>
        const itemMatch = rawText.match(/^menu_item_(\d+)(?:_v_(\d+))?$/);
        if (itemMatch) {
          const itemId = parseInt(itemMatch[1], 10);
          const pickedVariantId = itemMatch[2] ? parseInt(itemMatch[2], 10) : undefined;
          const cust = await getOrCreateCustomer(msg.phone, restaurantId);

          const item = await prisma.menuItem.findUnique({
            where: { id: itemId },
            include: { variants: { where: { available: true }, orderBy: { sortOrder: "asc" } } },
          });
          if (!item || !item.available) {
            await adapter.sendText(msg.phone, "Aa item ee roju ledu andi.");
            return;
          }

          // Item has an Annam/Bagara (or other) variant choice but none picked → ask which one.
          if (item.variants.length > 0 && !pickedVariantId) {
            await adapter.sendInteractiveButtons(
              msg.phone,
              `*${item.name}* — bagara tho aa, annam tho aa andi?`,
              item.variants.slice(0, 3).map((v) => ({
                id: `menu_item_${item.id}_v_${v.id}`,
                title: `${v.name} ₹${v.price}`.slice(0, 20),
              })),
            );
            return;
          }

          // Load the current cart by the unique customerId (NOT filtered by expiry —
          // a stale/expired row still occupies the unique slot, so we must upsert it).
          const existing = await prisma.pendingOrder.findUnique({ where: { customerId: cust.id } });
          let currentLines: any[] = [];
          if (existing && existing.expiresAt > new Date() && existing.lines) {
            try { currentLines = JSON.parse(existing.lines); } catch {}
          }

          const idx = currentLines.findIndex(
            (l) => l.menuItemId === itemId && (l.variantId ?? null) === (pickedVariantId ?? null),
          );
          if (idx >= 0) currentLines[idx].qty += 1;
          else currentLines.push({ menuItemId: itemId, qty: 1, ...(pickedVariantId ? { variantId: pickedVariantId } : {}) });

          const menuItems = await prisma.menuItem.findMany({
            where: { id: { in: currentLines.map((l) => l.menuItemId) } },
            include: { variants: true },
          });
          const byId = new Map(menuItems.map((m) => [m.id, m]));

          let total = 0;
          const labels: string[] = [];
          const validLines: any[] = [];
          for (const l of currentLines) {
            const mi = byId.get(l.menuItemId);
            if (!mi || !mi.available) continue;
            let price = mi.price;
            let variantName: string | undefined;
            if (l.variantId) {
              const v = mi.variants.find((v) => v.id === l.variantId);
              if (v) { price = v.price; variantName = v.name; }
            }
            validLines.push(l);
            const label = variantName ? `${l.qty}x ${mi.name} (${variantName})` : `${l.qty}x ${mi.name}`;
            labels.push(`${label} ₹${price * l.qty}`);
            total += price * l.qty;
          }

          const CART_TTL_MS = 2 * 60 * 60 * 1000;
          const expiresAt = new Date(Date.now() + CART_TTL_MS);
          await prisma.pendingOrder.upsert({
            where: { customerId: cust.id },
            create: { customerId: cust.id, lines: JSON.stringify(validLines), type: "delivery", expiresAt },
            update: { lines: JSON.stringify(validLines), expiresAt },
          });

          const stagedMsg = orderStagedTemplate(labels, total, "delivery");
          await adapter.sendInteractiveButtons(
            msg.phone,
            stagedMsg,
            [
              { id: "confirm_order_btn", title: "✅ Confirm Order" },
              { id: "add_more_items_btn", title: "➕ Add More Items" }
            ],
            "🛒 Order Summary",
            "Tap button to confirm or message to add items"
          );
          return;
        }

        // ── Direct Action 4b: Use Saved Address vs Pin New Location ──────────────
        if (rawText === "use_saved_address_btn" || cleanText.includes("use saved address")) {
          const cust = await getOrCreateCustomer(msg.phone, restaurantId);
          const saved = (await savedAddressesFor(cust.id, cust.address))[0];
          if (saved) {
            await prisma.customer.update({
              where: { id: cust.id },
              data: { address: saved },
            });
            await proceedToBilling(adapter, msg.phone, restaurantId, cust.id, saved);
            return;
          }
          await sendPinLocationPrompt(adapter, msg.phone);
          return;
        }

        if (rawText === "pin_new_location_btn" || cleanText.includes("pin new location")) {
          await sendPinLocationPrompt(adapter, msg.phone);
          return;
        }

        // ── Direct Action 5: Confirm Order Button ──────────────────────────────
        if (rawText === "confirm_order_btn" || cleanText === "confirm order") {
          const cust = await getOrCreateCustomer(msg.phone, restaurantId);
          const pending = await prisma.pendingOrder.findFirst({
            where: { customerId: cust.id, expiresAt: { gt: new Date() } }
          });

          if (!pending || !pending.lines || pending.lines === "[]") {
            await adapter.sendText(msg.phone, "Cart empty andi. *📋 Menu* tap cheyandi.");
            return;
          }

          // Every order is a delivery order and the location is never assumed —
          // each order re-offers the known addresses or a fresh pin, because
          // customers order to home, office and elsewhere on different days.
          const savedAddresses = await savedAddressesFor(cust.id, cust.address);

          if (savedAddresses.length > 0) {
            // WhatsApp allows at most three reply buttons, so offer the two most
            // recent addresses plus the escape hatch to pin a new one.
            const shortlist = savedAddresses.slice(0, 2);
            const body = shortlist.map((a, i) => `${i + 1}. ${a}`).join("\n\n");
            await adapter.sendInteractiveButtons(
              msg.phone,
              `Ekkada deliver cheyyamantaru andi?\n\n${body}`,
              [
                ...shortlist.map((addr, i) => ({
                  id: `use_addr_${i}`,
                  title: `📍 ${addr.slice(0, 18)}`,
                })),
                { id: "pin_new_location_btn", title: "🗺️ New Address" },
              ],
              "📦 Delivery Location",
            );
            return;
          }

          await sendPinLocationPrompt(adapter, msg.phone);
          return;
        }

        // ── Direct Action 5b: Customer picked one of their saved addresses ─────
        const savedAddrChoice = rawText.match(/^use_addr_(\d+)$/);
        if (savedAddrChoice) {
          const cust = await getOrCreateCustomer(msg.phone, restaurantId);
          const list = await savedAddressesFor(cust.id, cust.address);
          const chosen = list[Number(savedAddrChoice[1])];

          if (!chosen) {
            await sendPinLocationPrompt(adapter, msg.phone);
            return;
          }

          await prisma.customer.update({
            where: { id: cust.id },
            data: { address: chosen },
          });
          await proceedToBilling(adapter, msg.phone, restaurantId, cust.id, chosen);
          return;

        }

        // ── Direct Action 6: Add More Items Button ──────────────────────────────
        if (rawText === "add_more_items_btn") {
          const webMenuUrl = webMenuUrlFor(restaurantId, msg.phone);
          await sendMenuVisual(adapter, msg.phone, restaurantId, "Inka em kavali andi?", webMenuUrl);
          return;
        }

        // Cash / pay-on-delivery is deliberately gone: every order is prepaid via
        // Razorpay, so an order must never be created before the webhook fires.
        if (
          rawText === "pay_method_cash" ||
          rawText === "pay_method_upi" ||
          cleanText === "cash on pickup" ||
          cleanText === "pay cash"
        ) {
          await adapter.sendText(
            msg.phone,
            "Payment antha online ne andi 🙏 Pai lo unna *Pay* button tap cheyandi.",
          );
          return;
        }

        const { reply, placedOrderId, humanHandoffRequested } = await handleIncoming(msg.phone, msg.text, restaurantId);
        console.log(`[${restaurantName}] 🤖 ${reply.replace(/\n+/g, " / ")}`);
        await sendHumanly(adapter, msg.phone, splitBubbles(reply), restaurantId);
        if (placedOrderId) {
          // Send formatted receipt to customer + notify owner in parallel
          await Promise.all([
            sendOrderReceipt(adapter, msg.phone, restaurantId, placedOrderId),
            notifyOwner(adapter, restaurantId, placedOrderId),
          ]);
        }
        if (humanHandoffRequested) {
          await notifyOwnerOfHandoff(adapter, restaurantId, { name: customer?.name ?? null, phone: msg.phone }, msg.text);
        }
      } catch (e) {
        console.error(`[${restaurantName}] Handler error:`, e);
        await adapter.sendText(msg.phone, systemErrorTemplate());
      }
    });

    await adapter.start();
    this.sessions.set(restaurantId, adapter);
    console.log(`✅ Bot session started: ${restaurantName} (restaurant ${restaurantId})`);

    // Cloud/Kapso API is always connected — signal the dashboard immediately.
    if (config.whatsappProvider === "cloud" || config.whatsappProvider === "kapso") {
      await notifyAdminOfEvent("whatsapp_connected", {});
    }
  }

  /** Stop a session (e.g. when a restaurant is deactivated). */
  stopSession(restaurantId: number) {
    // Clean up Cloud phone ID mapping
    for (const [phoneId, rId] of this.phoneIdMap.entries()) {
      if (rId === restaurantId) this.phoneIdMap.delete(phoneId);
    }
    this.sessions.delete(restaurantId);
    console.log(`🛑 Session removed for restaurant ${restaurantId}`);
  }

  /**
   * Route an inbound Cloud webhook message to the correct restaurant's handler.
   * Called by the admin server's POST /webhook route.
   */
  async routeCloudMessage(phoneNumberId: string, msg: InboundMessage): Promise<void> {
    let restaurantId = this.phoneIdMap.get(phoneNumberId);
    if (restaurantId === undefined) {
      restaurantId = Array.from(this.sessions.keys())[0];
    }
    if (restaurantId === undefined) {
      console.warn(`[Cloud] No active session found to handle incoming message`);
      return;
    }
    const adapter = this.sessions.get(restaurantId);
    if (adapter && "ingest" in adapter) {
      await (adapter as CloudAdapter).ingest(msg);
    }
  }

  getSession(restaurantId: number): CloudAdapter | undefined {
    return this.sessions.get(restaurantId);
  }

  isRunning(restaurantId: number) {
    return this.sessions.has(restaurantId);
  }

  get count() {
    return this.sessions.size;
  }
}

// Singleton shared between bot and admin webhook handler (same process via index.ts).
export const botSessionManager = new BotSessionManager();
