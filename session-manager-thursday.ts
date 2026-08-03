import { prisma } from "../db.js";
import { BaileysAdapter } from "./baileys.js";
import { CloudAdapter } from "./cloud.js";
import { KapsoAdapter } from "./kapso.js";
import type { WhatsAppAdapter, InboundMessage } from "./adapter.js";
import { handleIncoming } from "../ai/agent.js";
import { getOrder } from "../services/order.js";
import { config } from "../config.js";
import { notifyAdminOfEvent } from "../services/events.js";
import { orderConfirmationMsg, ownerNewOrderMsg } from "../services/notifications.js";
import { menuAsInteractiveListSections, menuAsInteractiveListSectionsForFilter } from "../services/menu.js";
import { getOrCreateCustomer } from "../services/customer.js";
import { createOrder } from "../services/order.js";
import { createPaymentLink } from "../services/razorpay.js";
import { orderStagedTemplate, paymentLinkTemplate } from "../ai/templates.js";

/** Both Cloud and Kapso adapters speak Meta's native interactive message types; only Baileys falls back to plain text. */
function isRichAdapter(adapter: WhatsAppAdapter): adapter is KapsoAdapter | CloudAdapter {
  return adapter instanceof KapsoAdapter || adapter instanceof CloudAdapter;
}

function splitBubbles(text: string): string[] {
  const lower = text.toLowerCase();
  if (lower.includes("total: Γé╣") || lower.includes("order breakdown") || lower.includes("here's your order") || lower.includes("order summary")) {
    return [text];
  }
  const parts = text.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts.slice(0, 8) : [text];
}

async function sendHumanly(adapter: WhatsAppAdapter, phone: string, bubbles: string[], restaurantId: number) {
  for (const bubble of bubbles) {
    if ((config.whatsappProvider === "kapso" || config.whatsappProvider === "cloud") && isRichAdapter(adapter)) {
      const lower = bubble.toLowerCase();

      // 1. Intercept category/filter requests -> native WhatsApp interactive list select modal (NO plain text list dumps!)
      const categoryMatch = lower.match(/\b(starter|starters|appetizer|appetizers|biryani|biryanis|dessert|desserts|drink|drinks|beverage|beverages|veg|vegetarian|non-veg|nonveg|curry|curries|bread|breads|tandoori|sweet|sweets)\b/i);
      const isCategoryFilter = categoryMatch !== null && (
        lower.includes("starters") || lower.includes("starter") || lower.includes("biryani") ||
        lower.includes("dessert") || lower.includes("drinks") || lower.includes("beverage") ||
        lower.includes("veg") || lower.includes("curry") || lower.includes("sweets")
      ) && !bubble.includes("Order #") && !lower.includes("here's our menu") && !lower.includes("full menu") && !lower.includes("mood for");

      if (isCategoryFilter) {
        try {
          const filterTerm = categoryMatch[1].toLowerCase();
          const filterSections = await menuAsInteractiveListSectionsForFilter(restaurantId, filterTerm);
          if (filterSections.length > 0) {
            const capTag = filterTerm.charAt(0).toUpperCase() + filterTerm.slice(1);
            await adapter.sendInteractiveList(
              phone,
              `Here are our fresh *${capTag}* selections! Tap below to open the menu & pick yours ≡ƒæç`,
              `≡ƒôï Select ${capTag}`,
              filterSections,
              `Γ£¿ ${capTag} Menu`,
              "Tap any item to order ΓÇó Authentic Pure Ghee"
            );
            continue;
          }
        } catch (err) {
          console.error("[Kapso] Category filter list failed:", err);
        }
      }

      // 2. Intercept full menu requests/greetings ΓåÆ native WhatsApp interactive list
      const isGreetingOrMenu =
        bubble.includes("Here's our menu:") ||
        bubble.includes("Here's our current menu") ||
        bubble.includes("I can help you order anything from") ||
        bubble.match(/here'?s?\s+(the|our)\s+(full\s+)?menu/i) !== null ||
        bubble.match(/take\s+a\s+look\s+at\s+(our|the)\s+menu/i) !== null;

      if (isGreetingOrMenu) {
        try {
          const sections = await menuAsInteractiveListSections(restaurantId);

          if (sections.length > 0) {
            let intro = "Welcome! ≡ƒÖÅ Browse our full menu and tap any item to add it to your order.";
            await adapter.sendInteractiveList(
              phone,
              intro,
              "≡ƒôï View Menu Modal",
              sections,
              "≡ƒôû Restaurant Menu",
              "Tap an item to order ΓÇó Prices shown per item",
            );

            // Plain-text link (not a cta_url button) so WhatsApp opens it in its own in-app browser
            // instead of handing off to the phone's external browser app.
            const webMenuUrl = `${config.serverUrl}/menu.html?r=${restaurantId}&phone=${phone}`;
            await adapter.sendText(
              phone,
              `Explore our interactive web menu with search, filters, and multi-select ordering: ≡ƒîÉ≡ƒæç\n${webMenuUrl}`
            );
            continue;
          }
        } catch (err) {
          console.error("[Kapso] Failed to build interactive list for menu:", err);
        }
      }

      // 2.5 Intercept cart staged summary ΓåÆ native WhatsApp interactive buttons (Confirm Order / Add More)
      const isCartSummary =
        (lower.includes("total: Γé╣") || lower.includes("here's your order") || lower.includes("order summary") || lower.includes("order breakdown")) &&
        !lower.includes("payment details") &&
        !lower.includes("order #");

      if (isCartSummary && isRichAdapter(adapter)) {
        try {
          await adapter.sendInteractiveButtons(
            phone,
            bubble,
            [
              { id: "confirm_order_btn", title: "Γ£à Confirm Order" },
              { id: "add_more_items_btn", title: "Γ₧ò Add More Items" }
            ],
            "≡ƒ¢Æ Order Summary",
            "Tap button to confirm or message to add items"
          );
          continue;
        } catch (err) {
          console.error("[Kapso] Cart summary buttons failed:", err);
        }
      }

      // 3. Intercept payment option requests -> multiple payment method buttons
      const isPaymentPrompt =
        lower.includes("how would you like to pay") ||
        lower.includes("choose your payment method") ||
        lower.includes("select a payment option");

      if (isPaymentPrompt) {
        try {
          const botCfg = await prisma.botConfig.findUnique({ where: { id: restaurantId } });
          const methods = (botCfg?.paymentMethods ?? "cash,upi").split(",").map(s => s.trim().toLowerCase());

          const buttons: { id: string; title: string }[] = [];
          if (methods.includes("upi") && botCfg?.upiId) {
            buttons.push({ id: "pay_method_upi", title: "≡ƒô▒ Instant UPI" });
          }
          if (methods.includes("razorpay") && botCfg?.razorpayEnabled) {
            buttons.push({ id: "pay_method_razorpay", title: "≡ƒÆ│ Pay Online" });
          }
          if (methods.includes("cash")) {
            buttons.push({ id: "pay_method_cash", title: "≡ƒÆ╡ Pay on Delivery" });
          }

          if (buttons.length > 0) {
            await adapter.sendInteractiveButtons(
              phone,
              `${bubble}\n\nPlease select your preferred payment method below:`,
              buttons.slice(0, 3),
              "≡ƒÆ│ Select Payment Method",
              "Safe & Secure Payment Options"
            );
            continue;
          }
        } catch (err) {
          console.error("[Kapso] Payment buttons failed:", err);
        }
      }

      // 4. Intercept UPI payment links ΓåÆ native WhatsApp button message (no browser redirect)
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

      // 5. Intercept Razorpay links ΓåÆ interactive button (open in browser via CTA URL)
      if (bubble.includes("https://") && (bubble.includes("rzp.io") || bubble.includes("razorpay"))) {
        const rzpMatch = bubble.match(/(https:\/\/[^\s\n]+)/);
        if (rzpMatch) {
          const rzpUrl = rzpMatch[0];
          const amountMatch = bubble.match(/Γé╣\d+/);
          const amountText = amountMatch ? ` of ${amountMatch[0]}` : "";
          await adapter.sendInteractiveCtaUrl(
            phone,
            `Tap the button below to pay${amountText} online (UPI, Card, Netbanking) via Razorpay. ≡ƒÆ│Γ£¿`,
            "Pay Online ≡ƒÆ│",
            rzpUrl
          );
          continue;
        }
      }

      // 6. Intercept delivery address requests ΓåÆ native WhatsApp address collection sheet or saved address buttons
      const isAddressRequest =
        bubble.toLowerCase().includes("delivery address") ||
        bubble.toLowerCase().includes("provide your address") ||
        bubble.toLowerCase().includes("share your address") ||
        bubble.toLowerCase().includes("address details") ||
        bubble.toLowerCase().includes("where should we deliver");

      if (isAddressRequest && isRichAdapter(adapter)) {
        try {
          const customer = await prisma.customer.findFirst({
            where: { phone, restaurantId },
            select: { name: true, address: true }
          });

          if (customer?.address) {
            await adapter.sendInteractiveButtons(
              phone,
              `≡ƒÅá We have your saved delivery address:\n*${customer.address}*\n\nWould you like to use this address or enter a new one?`,
              [
                { id: "use_saved_address", title: "≡ƒÅá Use Saved Address" },
                { id: "change_address", title: "Γ£Å∩╕Å Enter New Address" }
              ],
              "≡ƒôì Delivery Address",
              "Fast & Reliable Delivery"
            );
            continue;
          } else {
            await adapter.sendInteractiveAddress(
              phone,
              "≡ƒÅá Please tap below to enter your delivery address details securely.",
              { name: customer?.name ?? undefined }
            );
            continue;
          }
        } catch (err) {
          console.error("[Kapso] Failed to send address collection card:", err);
        }
      }

      // 7. Intercept recommendation requests ΓåÆ native WhatsApp horizontal carousel cards
      const isSpecialsRequest =
        bubble.toLowerCase().includes("recommend") ||
        bubble.toLowerCase().includes("suggest") ||
        bubble.toLowerCase().includes("specials") ||
        bubble.toLowerCase().includes("famous") ||
        bubble.match(/what'?s\s+good/i) !== null ||
        bubble.match(/special\s+items/i) !== null;

      if (isSpecialsRequest && isRichAdapter(adapter)) {
        try {
          const specials = [
            {
              title: "Mutton Biryani",
              desc: "Traditional military-style spiced mutton biryani (Γé╣290)",
              imageUrl: "https://images.unsplash.com/photo-1633945274405-b6c8069047b0?q=80&w=600",
              buttonId: "Order Mutton Biryani",
              buttonTitle: "Order Mutton"
            },
            {
              title: "Chicken Biryani",
              desc: "Fragrant basmati rice layered with spiced chicken (Γé╣220)",
              imageUrl: "https://images.unsplash.com/photo-1563379091339-03b21ab4a4f8?q=80&w=600",
              buttonId: "Order Chicken Biryani",
              buttonTitle: "Order Chicken"
            },
            {
              title: "Mutton Curry",
              desc: "Andhra-style hot and spicy mutton gravy (Γé╣280)",
              imageUrl: "https://images.unsplash.com/photo-1606471679093-4b65662ff143?q=80&w=600",
              buttonId: "Order Mutton Curry",
              buttonTitle: "Order Curry"
            }
          ];

          await adapter.sendInteractiveCarousel(
            phone,
            "Here are our premium chef special recommendations: ≡ƒîƒ",
            specials
          );
          continue;
        } catch (err) {
          console.error("[Kapso] Failed to send specials carousel:", err);
        }
      }
    }

    await adapter.sendText(phone, bubble);
  }
}

async function notifyOwner(adapter: WhatsAppAdapter, restaurantId: number, orderId: number) {
  const [cfg, order] = await Promise.all([
    prisma.botConfig.findUnique({ where: { id: restaurantId } }),
    getOrder(orderId),
  ]);
  if (!order) return;

  const ownerNumbers = (cfg?.ownerNumbers ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const text = ownerNewOrderMsg(order);

  for (const num of ownerNumbers) {
    try {
      await adapter.sendText(num, text);
    } catch (e) {
      console.error(`[r${restaurantId}] Owner notify failed:`, e);
    }
  }
}

async function sendOrderReceipt(adapter: WhatsAppAdapter, phone: string, restaurantId: number, orderId: number) {
  try {
    const [order, cfg] = await Promise.all([
      getOrder(orderId),
      prisma.botConfig.findUnique({ where: { id: restaurantId } }),
    ]);
    if (!order || !cfg) return;
    await adapter.sendText(phone, orderConfirmationMsg(order, cfg.restaurantName));
  } catch (e) {
    console.error(`[r${restaurantId}] Receipt send failed:`, e);
  }
}

export class BotSessionManager {
  private sessions = new Map<number, WhatsAppAdapter>();
  // Cloud API only: phoneNumberId ΓåÆ restaurantId for fast webhook routing
  private phoneIdMap = new Map<string, number>();

  /** Start sessions for all active restaurants. */
  async startAll() {
    const restaurants = await prisma.botConfig.findMany({ where: { isActive: true } });
    console.log(`≡ƒÜÇ Starting ${restaurants.length} bot session(s) [provider: ${config.whatsappProvider}]...`);
    for (const r of restaurants) {
      await this.startSession(r.id, r.restaurantName).catch((e) =>
        console.error(`Failed to start session for restaurant ${r.id}:`, e),
      );
    }
  }

  /** Start (or restart) a single restaurant's WhatsApp session. */
  async startSession(restaurantId: number, restaurantName: string) {
    if (this.sessions.has(restaurantId)) {
      console.log(`[r${restaurantId}] Session already running ΓÇö skipping.`);
      return;
    }

    const botCfg = await prisma.botConfig.findUnique({
      where: { id: restaurantId },
      select: { whatsappPhone: true, cloudPhoneNumberId: true, cloudToken: true },
    });

    let adapter: WhatsAppAdapter;

    if (config.whatsappProvider === "kapso") {
      const phoneNumberId = botCfg?.cloudPhoneNumberId ?? config.kapso.phoneNumberId;
      const apiKey = botCfg?.cloudToken ?? config.kapso.apiKey;
      if (!phoneNumberId || !apiKey) {
        console.warn(`[r${restaurantId}] Kapso not configured (missing phoneNumberId or apiKey) ΓÇö skipping.`);
        return;
      }
      adapter = new KapsoAdapter(phoneNumberId, apiKey);
      this.phoneIdMap.set(phoneNumberId, restaurantId);
    } else if (config.whatsappProvider === "cloud") {
      const phoneNumberId = botCfg?.cloudPhoneNumberId ?? config.cloud.phoneNumberId;
      const token = botCfg?.cloudToken ?? config.cloud.token;
      if (!phoneNumberId || !token) {
        console.warn(`[r${restaurantId}] Cloud API not configured (missing phoneNumberId or token) ΓÇö skipping.`);
        return;
      }
      adapter = new CloudAdapter(phoneNumberId, token);
      this.phoneIdMap.set(phoneNumberId, restaurantId);
    } else {
      const authDir = `sessions/restaurant-${restaurantId}`;
      const onLoggedOut = async () => {
        this.stopSession(restaurantId);
        const { rm } = await import("node:fs/promises");
        await rm(authDir, { recursive: true, force: true }).catch(() => {});
        const cfg = await prisma.botConfig.findUnique({ where: { id: restaurantId } });
        if (cfg) await this.startSession(restaurantId, cfg.restaurantName).catch(console.error);
      };
      adapter = new BaileysAdapter(authDir, restaurantId, botCfg?.whatsappPhone ?? undefined, onLoggedOut);
    }

    adapter.onMessage(async (msg) => {
      console.log(`[${restaurantName}] ≡ƒÆ¼ ${msg.phone}: ${msg.text}`);
      try {
        const cfg = await prisma.botConfig.findUnique({
          where: { id: restaurantId },
          select: { restaurantName: true, restaurantCity: true, botPaused: true, pauseMessage: true },
        });
        if (cfg?.botPaused) {
          const pauseMsg = cfg.pauseMessage ?? "Sorry, we're temporarily unavailable. We'll be back shortly! ≡ƒÖÅ";
          await sendHumanly(adapter, msg.phone, [pauseMsg], restaurantId);
          return;
        }

        const rName = cfg?.restaurantName ?? restaurantName ?? "our restaurant";

        const customer = await prisma.customer.findFirst({
          where: { phone: msg.phone, restaurantId },
          include: { orders: true }
        });

        const isGreeting = ["hi", "hello", "hey", "namaste", "start", "yo", "hola", "namaskar"].includes(msg.text.trim().toLowerCase());

        if (isGreeting && isRichAdapter(adapter)) {
          const isReturning = customer && (customer.name || customer.orders.length > 0);
          const nameStr = customer?.name ? ` ${customer.name}` : "";
          const welcomeBody = isReturning
            ? `Welcome back to *${rName}*${nameStr}! ≡ƒÿè Great to see you again. What would you like to order today?`
            : `Welcome to *${rName}*! ≡ƒî╢∩╕ÅΓ£¿ Authentic delicacies cooked fresh. What can we serve you today?`;

          await adapter.sendInteractiveButtons(
            msg.phone,
            welcomeBody,
            [
              { id: "view_menu", title: "≡ƒôï View Menu" },
              { id: "reserve_table", title: "≡ƒì╜∩╕Å Reserve Table" },
              { id: "location_info", title: "≡ƒôì Location & Hours" }
            ],
            { type: "image", imageUrl: "https://images.unsplash.com/photo-1555396273-367ea4eb4db5?q=80&w=800" },
            `${rName} ΓÇó Fresh & Authentic`
          );
          return;
        }

        const rawText = msg.text.trim();
        const lowerText = rawText.toLowerCase();
        const cleanText = lowerText.replace(/[^\w\s]/g, "").trim();

        // ΓöÇΓöÇ Direct Action 1: View Menu ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
        if (
          rawText === "view_menu" ||
          cleanText === "view menu" ||
          cleanText === "menu" ||
          cleanText.includes("view menu") ||
          cleanText.includes("show menu") ||
          cleanText.includes("full menu")
        ) {
          const listSections = await menuAsInteractiveListSections(restaurantId);
          const domain = process.env.PUBLIC_DOMAIN || "robe-sagging-envoy.ngrok-free.dev";
          const webMenuUrl = `https://${domain}/menu?r=${restaurantId}&phone=${encodeURIComponent(msg.phone)}`;

          if (isRichAdapter(adapter)) {
            await adapter.sendInteractiveList(
              msg.phone,
              `Here is a preview of our popular items at *${rName}*: ≡ƒôï\n\nTap the button below to open our full visual web menu with photos, custom sizes & fast ordering! ≡ƒì╜∩╕ÅΓ£¿`,
              "≡ƒôï View Menu",
              listSections,
              "≡ƒôï Restaurant Menu",
              `${rName} ΓÇó Fresh & Authentic`
            );
            // Plain-text link opens in WhatsApp's in-app browser instead of escaping to an external one.
            await adapter.sendText(
              msg.phone,
              `Tap below to browse the full visual menu with images & instant cart builder: ≡ƒô▓\n${webMenuUrl}`
            );
          } else {
            await adapter.sendText(msg.phone, `Here is our full web menu:\n${webMenuUrl}`);
          }
          return;
        }

        // ΓöÇΓöÇ Direct Action 2: Reserve Table ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
        if (rawText === "reserve_table" || lowerText === "reserve table" || lowerText.includes("table reservation") || lowerText.includes("book table")) {
          const reserveMsg = `≡ƒì╜∩╕Å *Table Reservation at ${rName}*\n\nPlease reply with:\n1∩╕ÅΓâú *Number of guests*\n2∩╕ÅΓâú *Date & Preferred Time*\n\nOur team will confirm your table reservation immediately! ≡ƒÑé`;
          await adapter.sendText(msg.phone, reserveMsg);
          return;
        }

        // ΓöÇΓöÇ Direct Action 3: Location & Hours ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
        if (rawText === "location_info" || lowerText === "location & hours" || lowerText.includes("location") || lowerText.includes("opening hours")) {
          const city = cfg?.restaurantCity ?? "Hyderabad";
          const locationMsg = `≡ƒôì *${rName}*\n≡ƒÅó *Location:* ${city}\nΓÅ░ *Operating Hours:* 11:00 AM ΓÇô 11:00 PM (Mon ΓÇô Sun)\n≡ƒ¢╡ *Delivery & Pickup:* Active\n\nFeel free to ask for directions or place an order anytime! ≡ƒÿè`;
          await adapter.sendText(msg.phone, locationMsg);
          return;
        }

        // ΓöÇΓöÇ Direct Action 4: Item Selection from WhatsApp List Modal ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
        if (rawText.startsWith("menu_item_")) {
          const itemId = parseInt(rawText.replace("menu_item_", ""), 10);
          if (!isNaN(itemId)) {
            const cust = await getOrCreateCustomer(msg.phone, restaurantId);
            const pending = await prisma.pendingOrder.findFirst({
              where: { customerId: cust.id, restaurantId, expiresAt: { gt: new Date() } }
            });
            let currentLines: any[] = [];
            if (pending?.lines) {
              try { currentLines = JSON.parse(pending.lines); } catch {}
            }

            const existingIdx = currentLines.findIndex((l) => l.menuItemId === itemId && !l.variantId);
            if (existingIdx >= 0) {
              currentLines[existingIdx].qty += 1;
            } else {
              currentLines.push({ menuItemId: itemId, qty: 1 });
            }

            const menuItems = await prisma.menuItem.findMany({
              where: { id: { in: currentLines.map((l) => l.menuItemId) } },
              include: { variants: true }
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
              labels.push(`${label} Γé╣${price * l.qty}`);
              total += price * l.qty;
            }

            const CART_TTL_MS = 2 * 60 * 60 * 1000;
            if (pending) {
              await prisma.pendingOrder.update({
                where: { id: pending.id },
                data: { lines: JSON.stringify(validLines), expiresAt: new Date(Date.now() + CART_TTL_MS) }
              });
            } else {
              await prisma.pendingOrder.create({
                data: { customerId: cust.id, restaurantId, lines: JSON.stringify(validLines), type: "pickup", expiresAt: new Date(Date.now() + CART_TTL_MS) }
              });
            }

            const stagedMsg = orderStagedTemplate(labels, total, pending?.type ?? "pickup");
            if (isRichAdapter(adapter)) {
              await adapter.sendInteractiveButtons(
                msg.phone,
                stagedMsg,
                [
                  { id: "confirm_order_btn", title: "Γ£à Confirm Order" },
                  { id: "add_more_items_btn", title: "Γ₧ò Add More Items" }
                ],
                "≡ƒ¢Æ Order Summary",
                "Tap button to confirm or message to add items"
              );
            } else {
              await adapter.sendText(msg.phone, stagedMsg);
            }
            return;
          }
        }

        // ΓöÇΓöÇ Direct Action 5: Confirm Order Button ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
        if (rawText === "confirm_order_btn" || cleanText === "confirm order") {
          const cust = await getOrCreateCustomer(msg.phone, restaurantId);
          const pending = await prisma.pendingOrder.findFirst({
            where: { customerId: cust.id, restaurantId, expiresAt: { gt: new Date() } }
          });

          if (!pending || !pending.lines || pending.lines === "[]") {
            await adapter.sendText(msg.phone, "Your cart is currently empty! Tap *≡ƒôï View Menu* to select items. ≡ƒÿè");
            return;
          }

          let lines: any[] = [];
          try { lines = JSON.parse(pending.lines); } catch {}
          const menuItems = await prisma.menuItem.findMany({
            where: { id: { in: lines.map((l) => l.menuItemId) } },
            include: { variants: true }
          });
          const byId = new Map(menuItems.map((m) => [m.id, m]));
          let total = 0;
          for (const l of lines) {
            const mi = byId.get(l.menuItemId);
            if (!mi) continue;
            let p = mi.price;
            if (l.variantId) {
              const v = mi.variants.find((v) => v.id === l.variantId);
              if (v) p = v.price;
            }
            total += p * l.qty;
          }

          const botConfig = await prisma.botConfig.findUnique({ where: { id: restaurantId } });

          if (botConfig?.razorpayEnabled && botConfig.razorpayKeyId && botConfig.razorpayKeySecret) {
            const payRes = await createPaymentLink({
              restaurantId,
              customerId: cust.id,
              amount: total,
              customerPhone: msg.phone,
              restaurantName: botConfig.restaurantName,
            });

            if (payRes?.url) {
              const payMsg = paymentLinkTemplate(payRes.url, total);
              await adapter.sendText(msg.phone, payMsg);
              return;
            }
          }

          if (isRichAdapter(adapter)) {
            await adapter.sendInteractiveButtons(
              msg.phone,
              `≡ƒÆ│ *Choose Payment Method for Γé╣${total}:*`,
              [
                { id: "pay_method_upi", title: "≡ƒô▒ Pay via UPI" },
                { id: "pay_method_cash", title: "≡ƒÆ╡ Cash on Pickup" }
              ],
              "≡ƒÆ│ Payment Selection",
              "Tap a payment method to complete order"
            );
          } else {
            await adapter.sendText(msg.phone, `Please pay Γé╣${total} via UPI or Cash on Pickup.`);
          }
          return;
        }

        // ΓöÇΓöÇ Direct Action 6: Add More Items Button ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
        if (rawText === "add_more_items_btn") {
          const listSections = await menuAsInteractiveListSections(restaurantId);
          const domain = process.env.PUBLIC_DOMAIN || "robe-sagging-envoy.ngrok-free.dev";
          const webMenuUrl = `https://${domain}/menu?r=${restaurantId}&phone=${encodeURIComponent(msg.phone)}`;

          if (isRichAdapter(adapter)) {
            await adapter.sendInteractiveList(
              msg.phone,
              `What else would you like to add? ≡ƒ¢Æ\n\nPick from popular categories below or open our full web menu:`,
              "≡ƒôï Add More Items",
              listSections,
              "≡ƒôï Restaurant Menu",
              `${rName} ΓÇó Fresh & Authentic`
            );
            // Plain-text link opens in WhatsApp's in-app browser instead of escaping to an external one.
            await adapter.sendText(msg.phone, `Tap below to open full visual menu: ≡ƒô▓\n${webMenuUrl}`);
          } else {
            await adapter.sendText(msg.phone, `Here is our full web menu:\n${webMenuUrl}`);
          }
          return;
        }

        // ΓöÇΓöÇ Direct Action 7: Cash / UPI Payment Method Button ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
        if (rawText === "pay_method_cash" || cleanText === "cash on pickup" || cleanText === "pay cash") {
          const cust = await getOrCreateCustomer(msg.phone, restaurantId);
          const pending = await prisma.pendingOrder.findFirst({
            where: { customerId: cust.id, restaurantId, expiresAt: { gt: new Date() } }
          });
          if (pending) {
            let lines: any[] = [];
            try { lines = JSON.parse(pending.lines); } catch {}
            const newOrder = await createOrder({
              restaurantId,
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

        const { reply, placedOrderId } = await handleIncoming(msg.phone, msg.text, restaurantId);
        console.log(`[${restaurantName}] ≡ƒñû ${reply.replace(/\n+/g, " / ")}`);
        await sendHumanly(adapter, msg.phone, splitBubbles(reply), restaurantId);
        if (placedOrderId) {
          // Send formatted receipt to customer + notify owner in parallel
          await Promise.all([
            sendOrderReceipt(adapter, msg.phone, restaurantId, placedOrderId),
            notifyOwner(adapter, restaurantId, placedOrderId),
          ]);
        }
      } catch (e) {
        console.error(`[${restaurantName}] Handler error:`, e);
        await adapter.sendText(msg.phone, "Sorry, please try again in a moment.");
      }
    });

    await adapter.start();
    this.sessions.set(restaurantId, adapter);
    console.log(`Γ£à Bot session started: ${restaurantName} (restaurant ${restaurantId})`);

    // Cloud/Kapso API is always connected ΓÇö signal the dashboard immediately.
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
    console.log(`≡ƒ¢æ Session removed for restaurant ${restaurantId}`);
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

  /**
   * Clear the Baileys session files and restart ΓÇö forces a fresh QR code.
   * Use when session keys are corrupted (Bad MAC / key counter errors).
   */
  async resetSession(restaurantId: number): Promise<void> {
    const existing = this.sessions.get(restaurantId);
    if (existing instanceof BaileysAdapter) {
      await existing.stop(true); // stop + delete session files
    }
    this.stopSession(restaurantId);

    const cfg = await prisma.botConfig.findUnique({ where: { id: restaurantId } });
    if (!cfg) throw new Error(`Restaurant ${restaurantId} not found`);
    await this.startSession(restaurantId, cfg.restaurantName);
  }

  getSession(restaurantId: number): WhatsAppAdapter | undefined {
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
