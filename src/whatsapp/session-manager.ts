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
import {
  renderWelcome,
  renderCartSummary,
  renderAddressPicker,
  renderAddressPinPrompt,
  renderDeliveryQuote,
  renderPaymentLink,
  renderCurrentAddress,
} from "./renderers.js";
import { getCached } from "../services/cache.js";
import { send, applyCartEdit, isLocked, clearFinishedCart } from "./stage.js";
import { ownerHandoffMsg } from "../services/notifications.js";
import { logMessage } from "../services/customer.js";
import { getExactServiceDeliveryFee, UnserviceableLocationError } from "../services/delivery-fee.js";
import { DEFAULT_RESTAURANT_ID } from "../tenancy.js";
import { logger, runWithContext } from '../services/logger.js';



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
  // Photo carousel first, text list as the fallback. The carousel was dropped
  // while resolving a merge conflict about address routing rather than by
  // decision — the giveaway was menuAsInteractiveCarouselCards staying imported
  // with nothing calling it. Customers pick a dish far better from a photo.
  let sent = false;

  try {
    const cards = await menuAsInteractiveCarouselCards(restaurantId);
    // Meta requires at least two cards for a carousel.
    if (cards.length >= 2) {
      await adapter.sendInteractiveCarousel(phone, bodyText, cards);
      sent = true;
    }
  } catch (e: any) {
    logger.warn("[Carousel Failed, falling back to list]", e?.response?.data || e?.message || e);
  }

  if (!sent) {
    const sections = await menuAsInteractiveListSections(restaurantId);
    if (sections.length > 0) {
      try {
        await adapter.sendInteractiveList(phone, bodyText, "📋 View Today's Menu", sections);
        sent = true;
      } catch (e: any) {
        logger.warn("[Interactive List Failed]", e.response?.data || e.message || e);
      }
    }
  }

  if (webMenuUrl) {
    // Give Meta a moment to process the carousel images, otherwise the link can
    // arrive above them in the chat.
    if (sent) await new Promise((r) => setTimeout(r, 1200));
    await adapter.sendInteractiveCtaUrl(phone, "Full menu photos & details web lo chudandi 👇", "📋 Full Web Menu", webMenuUrl);
  }
}

async function sendDeliveryLocationOptions(
  adapter: CloudAdapter,
  phone: string,
  cust: any,
  addressList: string[],
  mapFormUrl: string,
): Promise<void> {
  if (cust.address) {
    await adapter.sendInteractiveButtons(
      phone,
      `📍 *Delivery Location Preview:*\n🏠 *${cust.address}*\n\nTap *📍 Deliver Here* below to use this address for your order:`,
      [{ id: "confirm_delivery_addr_btn", title: "📍 Deliver Here" }],
      "📦 Delivery Location",
    );
  }

  if (addressList.length > 0) {
    const rows = addressList.map((addr, idx) => ({
      id: `saved_addr_${idx}`,
      title: addr.length > 24 ? addr.slice(0, 21) + "…" : addr,
      description: addr.length > 72 ? addr.slice(0, 69) + "…" : addr,
    }));

    rows.push({
      id: "pin_new_location_btn",
      title: "🗺️ Pin New Location",
      description: "Open Google Maps to pin a new delivery location",
    });

    try {
      await adapter.sendInteractiveList(
        phone,
        "📍 *Saved Delivery Locations*\n\nTap below to choose another saved address from your previous orders:",
        "📍 Select Address",
        [{ title: "Saved Delivery Locations", rows }],
        "📦 Saved Addresses",
      );
    } catch (e) {
      logger.warn("[Interactive Address List Failed]", e);
    }
  }

  await adapter.sendInteractiveCtaUrl(
    phone,
    "📍 Tap below to open Google Maps & pin a new delivery address 👇",
    "🗺️ Pin Location on Map",
    mapFormUrl,
  );
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
        logger.error("[Cloud] Failed to build menu view:", err);
      }
    }

    // 2. Intercept cart staged summary → native WhatsApp interactive buttons (Confirm Order / Add More)
    // Match against text with WhatsApp markup stripped. Bolding the total as
    // "*Items Total:* ₹350" put an asterisk between the colon and the ₹, which
    // silently stopped this matching and took the Confirm / Add More buttons
    // with it — a formatting change should not be able to remove a button.
    const plain = lower.replace(/[*_~`]/g, "");
    const isCartSummary =
      (plain.includes("total: ₹") || plain.includes("here's your order") || plain.includes("order summary") || plain.includes("order breakdown")) &&
      !plain.includes("payment details") &&
      !plain.includes("order #");

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
        logger.error("[Cloud] Cart summary buttons failed:", err);
      }
    }

    // The payment-method picker that lived here is gone. It offered Cash on
    // Delivery and UPI buttons, which the handler now refuses outright with
    // "payment antha online ne andi" — the bot was presenting choices it would
    // not honour. Payment is Razorpay only, sent as a CTA button by
    // proceedToBilling once the final bill is agreed.

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
            logger.error("Failed to parse UPI link for Kapso payment card:", err);
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

      // The address interceptor that lived here is gone. It fired whenever the
      // model's prose happened to contain "delivery address" and replaced it
      // with a fourth address template, in English, whose button ids
      // (use_saved_address / change_address) did not match the handlers, which
      // check use_saved_address_btn. Taps therefore fell through to the agent,
      // which turned them back into prose containing "delivery address", which
      // re-fired this interceptor — the loop customers were stuck in.
      //
      // Address intents are now handled deterministically from stored state in
      // the message handler, using the shared address renderers.

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
    prisma.restaurantConfig.findUnique({ where: { id: DEFAULT_RESTAURANT_ID } }),
    getOrder(orderId),
  ]);
  if (!order) return;

  const ownerNumbers = (cfg?.ownerNumbers ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const text = ownerNewOrderMsg(order);

  for (const num of ownerNumbers) {
    try {
      await adapter.sendText(num, text);
    } catch (e) {
      logger.error("[Owner Notify] Send failed:", e);
    }
  }
}

async function notifyOwnerOfHandoff(
  adapter: CloudAdapter,
  _restaurantId: number,
  customer: { name?: string | null; phone: string },
  lastMessage: string,
) {
  const cfg = await prisma.restaurantConfig.findUnique({ where: { id: DEFAULT_RESTAURANT_ID } });
  const ownerNumbers = (cfg?.ownerNumbers ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const text = ownerHandoffMsg(customer, lastMessage);
  for (const num of ownerNumbers) {
    try {
      await adapter.sendText(num, text);
    } catch (e) {
      logger.error("[Owner Handoff] Send failed:", e);
    }
  }
}

async function sendOrderReceipt(adapter: CloudAdapter, phone: string, _restaurantId: number, orderId: number) {
  try {
    const [order, cfg] = await Promise.all([
      getOrder(orderId),
      prisma.restaurantConfig.findUnique({ where: { id: DEFAULT_RESTAURANT_ID } }),
    ]);
    if (!order || !cfg) return;
    await adapter.sendText(phone, orderConfirmationMsg(order, cfg.restaurantName));
  } catch (e) {
    logger.error("[Receipt Send] Failed:", e);
  }
}

/**
 * Restaurant pickup pincode — Madhapur. Only used as a fallback origin when
 * RestaurantConfig has no usable address; the address is preferred because a
 * pincode geocodes to the area centroid rather than the kitchen.
 */
const PICKUP_PINCODE = Number(process.env.PICKUP_PINCODE ?? 500081);
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
    logger.warn("[Location Request Failed, sending CTA URL]", e);
  }

  await adapter.sendInteractiveCtaUrl(
    phone,
    "Ee link lo mee location pin drop cheyandi 👇",
    "📍 Drop Location on Maps",
    mapFormUrl,
  );
}

/**
 * Show a WhatsApp interactive LIST popup with saved addresses so the full
 * address text is visible (description supports ~72 chars). Much better than
 * buttons which truncate at 20 characters and make the address unreadable
 * for both the customer and for Borzo quote lookups.
 */
async function sendAddressPickerList(
  adapter: CloudAdapter,
  phone: string,
  savedAddresses: string[],
): Promise<void> {
  // Show up to 5 saved addresses plus "📍 New Address" at the bottom
  const shortlist = savedAddresses.slice(0, 5);

  const rows = shortlist.map((addr, i) => {
    // title: short label (max 24 chars), description: full address (max 72 chars)
    const title = addr.length <= 24 ? addr : addr.slice(0, 21) + "...";
    return {
      id: `use_addr_${i}`,
      title,
      description: addr.slice(0, 72),
    };
  });

  // Always add "New Address" as the last option
  rows.push({
    id: "pin_new_location_btn",
    title: "📍 New Address",
    description: "Drop a pin on Google Maps",
  });

  await adapter.sendInteractiveList(
    phone,
    "Ekkada deliver cheyyamantaru andi? Kinda list lo select cheyandi 👇",
    "📍 Select Address",
    [{ title: "Delivery Addresses", rows }],
    "📦 Delivery Location",
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
  const cfg = await prisma.restaurantConfig.findUnique({ where: { id: DEFAULT_RESTAURANT_ID } });
  const ownerNumbers = (cfg?.ownerNumbers ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const text = `⚠️ *Payment link failed!*\n\n👤 Customer: ${phone}\n💰 Amount: ₹${amount}\n\nRazorpay did not return a link. Please contact the customer.`;
  for (const num of ownerNumbers) {
    try {
      await adapter.sendText(num, text);
    } catch (e) {
      logger.error("[Owner Payment Alert] Failed:", e);
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
  const itemLabels: string[] = [];
  for (const l of lines) {
    const mi = byId.get(l.menuItemId);
    if (!mi) continue;
    let p = mi.price;
    let variantName: string | undefined;
    if (l.variantId) {
      const v = mi.variants.find((v) => v.id === l.variantId);
      if (v) { p = v.price; variantName = v.name; }
    }
    subtotal += p * l.qty;
    itemLabels.push(
      `${l.qty}x ${mi.name}${variantName ? ` (${variantName})` : ""} ₹${p * l.qty}`,
    );
  }

  // Live quote rather than a flat rate, so the fee matches the actual distance.
  // Send the pinned address and coordinates, not just a pincode — Borzo geocodes
  // whatever it is given, and a bare pincode resolves to the area centroid, which
  // under-quotes the real route and leaves the restaurant covering the shortfall.
  const restaurant = await prisma.restaurantConfig.findUnique({ where: { id: DEFAULT_RESTAURANT_ID } });
  const customerRow = await prisma.customer.findUnique({ where: { id: customerId } });
  const ownerPhone = (restaurant?.ownerNumbers ?? "").split(",").map((s) => s.trim()).filter(Boolean)[0];

  // Don't route the rider off the schema's placeholder address — it names a
  // different suburb than the kitchen, so quoting from it would be worse than
  // falling back to the pickup pincode.
  const PLACEHOLDER_ADDRESS = "Plot 12, Main Road, Gachibowli, Hyderabad";
  const pickupAddress =
    restaurant?.restaurantAddress && restaurant.restaurantAddress !== PLACEHOLDER_ADDRESS
      ? restaurant.restaurantAddress
      : undefined;

  let deliveryFee = FALLBACK_DELIVERY_FEE;
  try {
    const quotes = await deliveryOrchestrator.getAllQuotes({
      pickupPincode: PICKUP_PINCODE,
      deliveryPincode: pincodeFromAddress(address) ?? PICKUP_PINCODE,
      pickupAddress,
      pickupLat: restaurant?.restaurantLat ?? undefined,
      pickupLng: restaurant?.restaurantLng ?? undefined,
      pickupPhone: ownerPhone,
      deliveryAddress: address,
      deliveryLat: customerRow?.deliveryLat ?? undefined,
      deliveryLng: customerRow?.deliveryLng ?? undefined,
      deliveryPhone: phone,
    });
    if (quotes?.cheapest?.quotedFee != null) {
      deliveryFee = Math.round(quotes.cheapest.quotedFee);
    }
  } catch (e) {
    logger.warn("[Delivery quote failed — using flat fee]", e);
  }

  const grandTotal = subtotal + deliveryFee;

  // Persist the quoted fee so the payment webhook builds the order with the same
  // number the customer was billed, instead of re-quoting and drifting.
  await prisma.pendingOrder.update({
    where: { id: pending.id },
    data: { deliveryFee, type: "delivery", stage: "QUOTE_GENERATED" },
  });

  await send(
    adapter,
    phone,
    renderDeliveryQuote({ items: itemLabels, subtotal, deliveryFee, address }),
  );

  const cfg = await prisma.restaurantConfig.findUnique({ where: { id: DEFAULT_RESTAURANT_ID } });

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
      logger.error("[Razorpay link generation failed]", e);
    }
  }

  if (!payUrl) {
    await adapter.sendText(phone, paymentUnavailableTemplate());
    await notifyOwnerOfPaymentIssue(adapter, phone, grandTotal);
    return;
  }

  // Record the link against the cart so a later edit can void it, and mark the
  // stage so routing knows the customer is holding a payable link.
  await prisma.pendingOrder.update({
    where: { id: pending.id },
    data: { razorpayLinkUrl: payUrl, stage: "AWAITING_PAYMENT" },
  });

  await send(adapter, phone, renderPaymentLink(payUrl, grandTotal));
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
    logger.info(`🚀 Starting ${restaurants.length} bot session(s) [provider: Meta Cloud API]...`);
    for (const r of restaurants) {
      await this.startSession(r.id, r.restaurantName).catch((e) =>
        logger.error(`Failed to start session for restaurant ${r.id}:`, e),
      );
    }
  }

  /** Start (or restart) a single restaurant's WhatsApp session. */
  async startSession(restaurantId: number, restaurantName: string, customAdapter?: CloudAdapter) {
    if (this.sessions.has(restaurantId)) {
      logger.info(`[r${restaurantId}] Session already running — skipping.`);
      return;
    }

    const botCfg = await prisma.restaurantConfig.findUnique({
      where: { id: restaurantId },
      select: { whatsappPhone: true, cloudPhoneNumberId: true, cloudToken: true },
    });

    const phoneNumberId = botCfg?.cloudPhoneNumberId || config.cloud.phoneNumberId;
    const token = botCfg?.cloudToken || config.cloud.token;
    if (!phoneNumberId || !token) {
      logger.warn(`[r${restaurantId}] Cloud API not configured (missing phoneNumberId or token) — skipping.`);
      return;
    }
    const adapter = customAdapter || new CloudAdapter(phoneNumberId, token);
    this.phoneIdMap.set(phoneNumberId, restaurantId);

    adapter.onMessage(async (msg) => {
      runWithContext({ restaurantId, phone: msg.phone }, async () => {
        logger.info(`[${restaurantName}] 💬 ${msg.phone}: ${msg.text}`);
        try {
          // The database lives in ap-northeast-2 while this runs in asia-south1, so
          // every query costs a cross-region round trip. This row changes only when
          // the owner edits the dashboard, and getCached already invalidates on
          // config_updated, so reading it per message was pure latency.
          const cfg = await getCached(
            restaurantId,
            "sessionConfig",
            () =>
              prisma.restaurantConfig.findUnique({
                where: { id: restaurantId },
                select: {
                  restaurantName: true,
                  restaurantCity: true,
                  botPaused: true,
                  pauseMessage: true,
                },
              }),
            30_000,
          );
          if (cfg?.botPaused) {
            const pauseMsg = cfg.pauseMessage ?? "Sorry, we're temporarily unavailable. We'll be back shortly! 🙏";
            await sendHumanly(adapter, msg.phone, [pauseMsg], restaurantId);
            return;
          }

          const rName = cfg?.restaurantName ?? restaurantName ?? "our restaurant";

          // Greet before touching the database. WhatsApp already gives us the
          // customer's profile name, and the restaurant name is cached, so the
          // welcome needs nothing else — it goes out while the customer row is
          // still being fetched instead of after it.
          const isGreeting = ["hi", "hello", "hey", "namaste", "start", "yo", "hola", "namaskar"]
            .includes(msg.text.trim().toLowerCase());

          if (isGreeting) {
            const greetName = msg.name?.trim() ? `${msg.name.trim()} garu` : "andi";
            await send(adapter, msg.phone, renderWelcome(greetName, rName));
            // Keep the profile/history write off the critical path, and retire any
            // finished or expired cart so a greeting genuinely starts a new order.
            void getOrCreateCustomer(msg.phone, msg.name)
              .then(async (c) => {
                await clearFinishedCart(c.id);
                await logMessage(c.id, "user", msg.text);
              })
              .catch((e) => logger.error("[Greeting] background persist failed:", e));
            return;
          }

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
          if (
            rawText !== "pin_new_location_btn" &&
            (rawText === "location_info" || lowerText === "location & hours" || lowerText.includes("where are you located") || lowerText.includes("restaurant location") || lowerText.includes("opening hours") || lowerText.includes("your location"))
          ) {
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

            // A settled or expired cart is retired here rather than refusing the
            // tap. PendingOrder is unique per customer, so a completed order left
            // the row at ORDER_PLACED and locked the customer out of ever ordering
            // again — adding an item is a clear signal they want a new order.
            if (existing && (isLocked(existing.stage) || existing.expiresAt <= new Date())) {
              await clearFinishedCart(cust.id);
              currentLines = [];
              validLines.length = 0;
              validLines.push({ menuItemId: itemId, qty: 1, ...(pickedVariantId ? { variantId: pickedVariantId } : {}) });
            }

            const CART_TTL_MS = 2 * 60 * 60 * 1000;
            const expiresAt = new Date(Date.now() + CART_TTL_MS);
            await prisma.pendingOrder.upsert({
              where: { customerId: cust.id },
              create: { customerId: cust.id, lines: JSON.stringify(validLines), type: "delivery", expiresAt },
              update: { lines: JSON.stringify(validLines), expiresAt },
            });

            // Rewind the stage and void any outstanding payment link — the cart the
            // customer is holding a link for no longer exists. Keeps the address.
            await applyCartEdit(cust.id, adapter, msg.phone);

            const cart = await prisma.pendingOrder.findUnique({ where: { customerId: cust.id } });
            await send(
              adapter,
              msg.phone,
              renderCartSummary({
                items: labels,
                subtotal: total,
                stage: cart?.stage ?? "BUILDING_CART",
              }),
            );
            return;
          }

          // ── Direct Action 4b: Use Saved Address vs Pin New Location ──────────────
          // Both id spellings are accepted — older messages in customers' chat
          // history still carry "use_saved_address", and a stale button must not
          // fall through to the model.
          if (
            rawText.startsWith("saved_addr_") ||
            rawText === "use_saved_address_btn" ||
            rawText.includes("use_saved_address") ||
            cleanText.includes("use saved address") ||
            cleanText.includes("saved address") ||
            cleanText === "use saved address"
          ) {
            const cust = await getOrCreateCustomer(msg.phone, restaurantId);
            const prevOrders = await prisma.order.findMany({
              where: { customerId: cust.id, deliveryAddress: { not: null } },
              orderBy: { createdAt: "desc" },
              take: 10,
            });

            const addressesSet = new Set<string>();
            if (cust.address) addressesSet.add(cust.address);
            for (const o of prevOrders) {
              if (o.deliveryAddress) addressesSet.add(o.deliveryAddress);
            }
            const addressList = Array.from(addressesSet);

            // If specific row selected from list:
            if (rawText.startsWith("saved_addr_")) {
              const idx = parseInt(rawText.replace("saved_addr_", ""), 10);
              const selectedAddr = addressList[idx];
              if (selectedAddr) {
                await prisma.customer.update({
                  where: { id: cust.id },
                  data: { address: selectedAddr },
                });

                const pending = await prisma.pendingOrder.findFirst({
                  where: { customerId: cust.id, expiresAt: { gt: new Date() } }
                });

                let subtotal = 0;
                const labels: string[] = [];
                if (pending && pending.lines) {
                  let lines: any[] = [];
                  try { lines = JSON.parse(pending.lines); } catch {}
                  const menuItems = await prisma.menuItem.findMany({
                    where: { id: { in: lines.map((l) => l.menuItemId) } },
                    include: { variants: true }
                  });
                  const byId = new Map(menuItems.map((m) => [m.id, m]));
                  for (const l of lines) {
                    const mi = byId.get(l.menuItemId);
                    if (!mi) continue;
                    let p = mi.price;
                    let vName: string | undefined;
                    if (l.variantId) {
                      const v = mi.variants.find((v) => v.id === l.variantId);
                      if (v) { p = v.price; vName = v.name; }
                    }
                    const label = vName ? `${l.qty}x ${mi.name} (${vName})` : `${l.qty}x ${mi.name}`;
                    labels.push(`${label} ₹${p * l.qty}`);
                    subtotal += p * l.qty;
                  }
                }

                let deliveryFee = 45;
                try {
                  deliveryFee = await getExactServiceDeliveryFee(selectedAddr);
                } catch (err) {
                  await adapter.sendInteractiveButtons(
                    msg.phone,
                    `❌ *Delivery Location Not Serviceable*\n\nSorry, this delivery location is currently not serviceable by our delivery partners. Please pick another location or pin a location nearby!`,
                    [
                      { id: "pin_new_location_btn", title: "🗺️ Pin New Location" },
                      { id: "use_saved_address_btn", title: "📍 Select Address" }
                    ],
                    "📦 Delivery Location",
                  );
                  return;
                }

                const botConfig = await prisma.restaurantConfig.findUnique({ where: { id: DEFAULT_RESTAURANT_ID } });
                const grandTotal = subtotal + deliveryFee;
                const summaryMsg = orderStagedTemplate(labels, subtotal, "delivery", pending?.note ?? undefined, deliveryFee, selectedAddr);
                let payUrl: string | null = null;
                if (botConfig?.razorpayEnabled && botConfig.razorpayKeyId && botConfig.razorpayKeySecret) {
                  const payRes = await createPaymentLink({
                    restaurantId,
                    customerId: cust.id,
                    amount: grandTotal,
                    customerPhone: msg.phone,
                    restaurantName: botConfig.restaurantName,
                  });
                  if (payRes?.url) payUrl = payRes.url;
                }

                if (payUrl) {
                  await adapter.sendInteractiveCtaUrl(
                    msg.phone,
                    summaryMsg,
                    `💳 Confirm & Pay ₹${grandTotal}`,
                    payUrl,
                  );
                } else {
                  await adapter.sendInteractiveButtons(
                    msg.phone,
                    summaryMsg,
                    [
                      { id: "confirm_order_btn", title: "✅ Confirm & Pay" },
                      { id: "add_more_items_btn", title: "➕ Add More Items" },
                    ],
                    "🛒 Order Summary",
                  );
                }
                return;
              }
            }

            // Otherwise open the Interactive List Modal Sheet of all saved addresses
            if (addressList.length > 0) {
              const rows = addressList.map((addr, idx) => ({
                id: `saved_addr_${idx}`,
                title: addr.length > 24 ? addr.slice(0, 21) + "…" : addr,
                description: addr.length > 72 ? addr.slice(0, 69) + "…" : addr,
              }));

              rows.push({
                id: "pin_new_location_btn",
                title: "🗺️ Pin New Location",
                description: "Open Google Maps to pin a new delivery location",
              });

              await adapter.sendInteractiveList(
                msg.phone,
                "📍 *Select Delivery Address*\n\nSelect a saved location from your previous orders or pin a new map location below:",
                "📍 Select Address",
                [{ title: "Saved Delivery Locations", rows }],
                "📦 Delivery Location",
              );
              return;
            }
            await sendPinLocationPrompt(adapter, msg.phone);
            return;
          }

          if (rawText === "pin_new_location_btn" || cleanText.includes("pin new location")) {
            await sendPinLocationPrompt(adapter, msg.phone);
            return;
          }

          // ── Direct Action 4d: Order Type Selection (Pickup vs Delivery) ───────
          if (rawText === "order_type_pickup" || cleanText === "pickup" || cleanText === "takeaway") {
            const cust = await getOrCreateCustomer(msg.phone, restaurantId);
            const pending = await prisma.pendingOrder.findFirst({
              where: { customerId: cust.id, expiresAt: { gt: new Date() } }
            });

            if (pending) {
              await prisma.pendingOrder.update({
                where: { id: pending.id },
                data: { type: "pickup" }
              });

              let lines: any[] = [];
              try { lines = JSON.parse(pending.lines); } catch {}
              const menuItems = await prisma.menuItem.findMany({
                where: { id: { in: lines.map((l) => l.menuItemId) } },
                include: { variants: true }
              });
              const byId = new Map(menuItems.map((m) => [m.id, m]));
              let subtotal = 0;
              const labels: string[] = [];
              for (const l of lines) {
                const mi = byId.get(l.menuItemId);
                if (!mi) continue;
                let p = mi.price;
                let vName: string | undefined;
                if (l.variantId) {
                  const v = mi.variants.find((v) => v.id === l.variantId);
                  if (v) { p = v.price; vName = v.name; }
                }
                const label = vName ? `${l.qty}x ${mi.name} (${vName})` : `${l.qty}x ${mi.name}`;
                labels.push(`${label} ₹${p * l.qty}`);
                subtotal += p * l.qty;
              }

              const botConfig = await prisma.restaurantConfig.findUnique({ where: { id: DEFAULT_RESTAURANT_ID } });
              const summaryMsg = orderStagedTemplate(labels, subtotal, "pickup", pending?.note ?? undefined);

              let payUrl: string | null = null;
              if (botConfig?.razorpayEnabled && botConfig.razorpayKeyId && botConfig.razorpayKeySecret) {
                const payRes = await createPaymentLink({
                  restaurantId,
                  customerId: cust.id,
                  amount: subtotal,
                  customerPhone: msg.phone,
                  restaurantName: botConfig.restaurantName,
                });
                if (payRes?.url) payUrl = payRes.url;
              }

              if (payUrl) {
                await adapter.sendInteractiveCtaUrl(
                  msg.phone,
                  summaryMsg,
                  `💳 Confirm & Pay ₹${subtotal}`,
                  payUrl,
                );
              } else {
                await adapter.sendInteractiveButtons(
                  msg.phone,
                  summaryMsg,
                  [
                    { id: "confirm_order_btn", title: "✅ Confirm & Pay" },
                    { id: "add_more_items_btn", title: "➕ Add More Items" }
                  ],
                  "🛒 Order Summary",
                );
              }
              return;
            }
          }

          if (rawText === "order_type_delivery" || cleanText === "delivery") {
            const cust = await getOrCreateCustomer(msg.phone, restaurantId);
            const pending = await prisma.pendingOrder.findFirst({
              where: { customerId: cust.id, expiresAt: { gt: new Date() } }
            });

            if (pending) {
              await prisma.pendingOrder.update({
                where: { id: pending.id },
                data: { type: "delivery" }
              });

              const serverUrl = process.env.SERVER_URL || "https://robe-sagging-envoy.ngrok-free.dev";
              const mapFormUrl = `${serverUrl}/address?phone=${encodeURIComponent(msg.phone)}`;

              // Collect saved addresses
              const prevOrders = await prisma.order.findMany({
                where: { customerId: cust.id, deliveryAddress: { not: null } },
                orderBy: { createdAt: "desc" },
                take: 10,
              });
              const addressesSet = new Set<string>();
              if (cust.address) addressesSet.add(cust.address);
              for (const o of prevOrders) {
                if (o.deliveryAddress) addressesSet.add(o.deliveryAddress);
              }
              const addressList = Array.from(addressesSet);

              if (addressList.length > 0) {
                // Directly open interactive list — no intermediate step
                const rows = addressList.map((addr, idx) => ({
                  id: `saved_addr_${idx}`,
                  title: addr.length > 24 ? addr.slice(0, 21) + "…" : addr,
                  description: addr.length > 72 ? addr.slice(0, 69) + "…" : addr,
                }));
                rows.push({
                  id: "pin_new_location_btn",
                  title: "🗺️ Pin on Map",
                  description: "Open Google Maps to pin a new address",
                });
                await adapter.sendInteractiveList(
                  msg.phone,
                  "📦 *Delivery Location*\n\nSelect a saved address or pin a new location on the map:",
                  "📍 Choose Address",
                  [{ title: "Saved Addresses", rows }],
                  "📦 Delivery Location",
                );
              } else {
                // No saved addresses — directly open the map link
                await adapter.sendInteractiveCtaUrl(
                  msg.phone,
                  "📦 *Delivery Location Required*\n\nTap below to open Google Maps and pin your delivery address 👇",
                  "🗺️ Pin Location on Map",
                  mapFormUrl,
                );
              }
              return;
            }
          }

          if (rawText === "pin_new_location_btn" || cleanText.includes("pin new location") || cleanText.includes("enter new address")) {
            const serverUrl = process.env.SERVER_URL || "https://robe-sagging-envoy.ngrok-free.dev";
            const mapFormUrl = `${serverUrl}/address?phone=${encodeURIComponent(msg.phone)}`;

            await adapter.sendInteractiveCtaUrl(
              msg.phone,
              "📍 Tap the button below to open Google Maps & pin your delivery address 👇",
              "🗺️ Pin Location on Map",
              mapFormUrl,
            );
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

            // This cart already has a location chosen for it, so go straight to the
            // bill. Re-asking after every cart edit made the journey restart under
            // the customer: pick address, edit cart, pick the same address again.
            // A new order starts at BUILDING_CART, so it still gets the picker.
            if (pending.stage !== "BUILDING_CART" && cust.address) {
              await proceedToBilling(adapter, msg.phone, restaurantId, cust.id, cust.address);
              return;
            }

            // Location is never assumed for a fresh order — customers order to home,
            // office and elsewhere on different days.
            const savedAddresses = await savedAddressesFor(cust.id, cust.address);

            if (savedAddresses.length > 0) {
              await sendAddressPickerList(adapter, msg.phone, savedAddresses);
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
            await prisma.pendingOrder.updateMany({
              where: { customerId: cust.id },
              data: { stage: "ADDRESS_SELECTED" },
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
          // Nothing emits these any more, but old buttons live on in customers'
          // chat history and a stale tap must not reach the model.
          if (
            rawText === "pay_method_cash" ||
            rawText === "pay_method_upi" ||
            rawText === "pay_method_razorpay" ||
            cleanText === "cash on pickup" ||
            cleanText === "pay cash"
          ) {
            await adapter.sendText(
              msg.phone,
              "Payment antha online ne andi 🙏 Pai lo unna *Pay* button tap cheyandi.",
            );
            return;
          }

          // The flat/door follow-up that used to live here is gone. The map form
          // already requires flat, building and landmark and posts them composed
          // into the address, so this only made the customer type it all twice —
          // and it appended whatever they said next to their saved address, which
          // is how one record ended up as "<address> — already add chesa".

          // ── Direct Action: "which address?" ───────────────────────────────────
          // Answered from stored state. Left to the model this replied "meeru inka
          // delivery address set cheyaledu" while an address was on file and a
          // payment link had already been issued, then offered a change_address
          // button it had invented, which called save_customer_info with an empty
          // address and tried to wipe the record.
          const asksAddress =
            rawText === "change_address" ||
            /\b(address|adress)\b/i.test(cleanText) ||
            cleanText.includes("ekkada deliver") ||
            cleanText.includes("ey address");

          if (asksAddress) {
            const cust = await getOrCreateCustomer(msg.phone, restaurantId);

            if (rawText === "change_address") {
              const saved = await savedAddressesFor(cust.id, cust.address);
              if (saved.length > 0) await sendAddressPickerList(adapter, msg.phone, saved);
              else await sendPinLocationPrompt(adapter, msg.phone);
              return;
            }

            if (cust.address) {
              await send(adapter, msg.phone, renderCurrentAddress(cust.address));
              return;
            }

            await sendPinLocationPrompt(adapter, msg.phone);
            return;
          }

          // ── Direct Action: Text-based order confirmation ──────────────────────
          // If the customer types "confirm", "yes", "haan" etc. AND has a staged
          // cart, route through the same address → billing flow as the ✅ button.
          const confirmWords = ["confirm", "yes", "haan", "ha", "sure", "ok", "okay", "avunu", "sare", "confirm order"];
          if (confirmWords.includes(cleanText)) {
            const cust = await getOrCreateCustomer(msg.phone, restaurantId);
            const pending = await prisma.pendingOrder.findFirst({
              where: { customerId: cust.id, expiresAt: { gt: new Date() } }
            });
            if (pending && pending.lines && pending.lines !== "[]") {
              // Same flow as confirm_order_btn — show saved addresses or pin prompt
              const savedAddresses = await savedAddressesFor(cust.id, cust.address);

              if (savedAddresses.length > 0) {
                await sendAddressPickerList(adapter, msg.phone, savedAddresses);
                return;
              }

              await sendPinLocationPrompt(adapter, msg.phone);
              return;
            }
          }

          const { reply, mediaReply, placedOrderId, humanHandoffRequested } = await handleIncoming(msg.phone, msg.text, restaurantId);

          // An empty reply means this message was folded into a turn already in
          // flight for the same customer — that turn answers all of them at once,
          // so there is nothing to send here.
          if (!reply && !mediaReply) return;

          logger.info(`[${restaurantName}] 🤖 ${reply.replace(/\n+/g, " / ")}`);

          if (mediaReply) {
            await adapter.sendImage(msg.phone, mediaReply.imageUrl, mediaReply.caption);
          }

          // If the reply is a cart-staged message, send it with Delivery/Pickup buttons instead of plain text
          if (reply.includes("🛒 *Your Cart:*") && reply.includes("How would you like your order?")) {
            await adapter.sendInteractiveButtons(
              msg.phone,
              reply,
              [
                { id: "order_type_delivery", title: "🛵 Delivery" },
                { id: "order_type_pickup", title: "🛍️ Pickup" },
                { id: "add_more_items_btn", title: "➕ Add More" },
              ],
              "🛒 Your Cart",
              "Choose order type to continue",
            );
          } else {
            await sendHumanly(adapter, msg.phone, splitBubbles(reply), restaurantId);
          }
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
          logger.error(`[${restaurantName}] Handler error:`, e);
          await adapter.sendText(msg.phone, systemErrorTemplate());
        }
      });
    });

    await adapter.start();
    this.sessions.set(restaurantId, adapter);
    logger.info(`✅ Bot session started: ${restaurantName} (restaurant ${restaurantId})`);

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
    logger.info(`🛑 Session removed for restaurant ${restaurantId}`);
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
      logger.warn(`[Cloud] No active session found to handle incoming message`);
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
