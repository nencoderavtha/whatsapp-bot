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
import { createOrder } from "../services/order.js";
import { createPaymentLink } from "../services/razorpay.js";
import { orderStagedTemplate, paymentLinkTemplate, systemErrorTemplate, voiceNoteFallbackTemplate } from "../ai/templates.js";
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
            { id: "confirm_order_btn", title: "✅ Confirm Order" },
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
          const nameStr = customer?.name ? ` ${customer.name}` : "";
          const welcomeBody = `Namaskaram${nameStr} andi 🙏 Ee roju menu ready undi.`;

          await adapter.sendInteractiveButtons(
            msg.phone,
            welcomeBody,
            [
              { id: "view_menu", title: "📋 Menu" },
              { id: "location_info", title: "📍 Location & Hours" }
            ],
          );
          return;
        }

        const rawText = msg.text.trim();
        const lowerText = rawText.toLowerCase();
        const cleanText = lowerText.replace(/[^\w\s]/g, "").trim();

        // ── Direct Action 1: View Menu ───────────────────────────────────────
        if (
          rawText === "view_menu" ||
          cleanText === "menu" ||
          cleanText.includes("menu") ||
          /\bmenu\b/i.test(lowerText)
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
            create: { customerId: cust.id, lines: JSON.stringify(validLines), type: "pickup", expiresAt },
            update: { lines: JSON.stringify(validLines), expiresAt },
          });

          const stagedMsg = orderStagedTemplate(labels, total, existing?.type ?? "pickup");
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

          if (pending.type === "delivery" && !cust.address) {
            const serverUrl = process.env.SERVER_URL || "https://robe-sagging-envoy.ngrok-free.dev";
            const mapFormUrl = `${serverUrl}/address?phone=${encodeURIComponent(msg.phone)}`;

            try {
              await adapter.sendInteractiveLocationRequest(
                msg.phone,
                "📍 *Delivery Location Needed!*\n\nTap *📍 Share Location* to send your current GPS location, or tap the button below to pin on map & enter flat/house number."
              );
            } catch (e) {
              console.warn("[Location Request Failed, sending CTA URL]", e);
            }

            await adapter.sendInteractiveCtaUrl(
              msg.phone,
              "🗺️ Open Map & Address Form",
              "🗺️ Pin Location on Map",
              mapFormUrl,
            );
            return;
          }

          let lines: any[] = [];
          try { lines = JSON.parse(pending.lines); } catch {}
          const menuItems = await prisma.menuItem.findMany({
            where: { id: { in: lines.map((l) => l.menuItemId) } },
            include: { variants: true }
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

          const isDelivery = pending.type === "delivery";
          const deliveryFee = isDelivery ? 45 : 0;
          const grandTotal = subtotal + deliveryFee;

          const botConfig = await prisma.restaurantConfig.findUnique({ where: { id: 1 } });

          if (botConfig?.razorpayEnabled && botConfig.razorpayKeyId && botConfig.razorpayKeySecret) {
            const payRes = await createPaymentLink({
              restaurantId,
              customerId: cust.id,
              amount: grandTotal,
              customerPhone: msg.phone,
              restaurantName: botConfig.restaurantName,
            });

            if (payRes?.url) {
              const payMsg = paymentLinkTemplate(payRes.url, grandTotal);
              await adapter.sendText(msg.phone, payMsg);
              return;
            }
          }

          await adapter.sendInteractiveButtons(
            msg.phone,
            `₹${grandTotal} ela pay chestharu andi?`,
            [
              { id: "pay_method_upi", title: "📱 UPI" },
              { id: "pay_method_cash", title: "💵 Cash on Pickup" }
            ],
          );
          return;
        }

        // ── Direct Action 6: Add More Items Button ──────────────────────────────
        if (rawText === "add_more_items_btn") {
          const webMenuUrl = webMenuUrlFor(restaurantId, msg.phone);
          await sendMenuVisual(adapter, msg.phone, restaurantId, "Inka em kavali andi?", webMenuUrl);
          return;
        }

        // ── Direct Action 7: Cash / UPI Payment Method Button ──────────────────
        if (rawText === "pay_method_cash" || cleanText === "cash on pickup" || cleanText === "pay cash") {
          const cust = await getOrCreateCustomer(msg.phone, restaurantId);
          const pending = await prisma.pendingOrder.findFirst({
            where: { customerId: cust.id, expiresAt: { gt: new Date() } }
          });
          if (pending) {
            let lines: any[] = [];
            try { lines = JSON.parse(pending.lines); } catch {}
            const newOrder = await createOrder({
              customerId: cust.id,
              type: (pending.type as any) ?? "pickup",
              lines: lines,
              payment: { method: "cash", status: "pending" },
            });

            await prisma.pendingOrder.delete({ where: { id: pending.id } });

            await Promise.all([
              sendOrderReceipt(adapter, msg.phone, restaurantId, newOrder.id),
              notifyOwner(adapter, restaurantId, newOrder.id)
            ]);
          } else {
            await adapter.sendText(msg.phone, "No pending order found to complete.");
          }
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
