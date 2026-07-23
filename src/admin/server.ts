import express from "express";
import type { Request, Response, NextFunction } from "express";
import cookieParser from "cookie-parser";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { config } from "../config.js";
import { prisma } from "../db.js";
import { getMenu } from "../services/menu.js";
import { listOrders, setOrderStatus, setPaymentStatus } from "../services/order.js";
import { eventBus, notifyAdminOfEvent, whatsappState } from "../services/events.js";
import { loginHandler, logoutHandler, meHandler, authMiddleware, founderLoginHandler, founderLogoutHandler, founderMiddleware } from "./auth.js";
import { createOrder } from "../services/order.js";
import { verifyWebhookSignature } from "../services/razorpay.js";
import { botSessionManager } from "../whatsapp/session-manager.js";
import { VOICE_NOTE_SENTINEL, type InboundMessage } from "../whatsapp/adapter.js";
import { KapsoAdapter } from "../whatsapp/kapso.js";
import { orderConfirmationMsg, ownerNewOrderMsg, orderStatusMsg } from "../services/notifications.js";
import { getOrCreateCustomer, logMessage } from "../services/customer.js";
import { orderStagedTemplate } from "../ai/templates.js";
import { logActivity } from "../services/activity.js";
import { fetchMetaMedia } from "../whatsapp/media.js";
import { transcribeAudio } from "../services/transcription.js";

/** Wraps an async Express handler so DB errors call next(err) instead of becoming unhandled rejections. */
function asyncRoute(fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

process.env.IS_ADMIN_SERVER = "true";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function generateUsername(restaurantName: string, id: number): string {
  const slug = restaurantName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 20);
  return (slug || "restaurant") + "-" + id;
}

/** Auto-assign loginUsername to any restaurant that doesn't have one. */
async function ensureLoginUsernames(): Promise<void> {
  const rows = await prisma.botConfig.findMany({ where: { loginUsername: null } });
  for (const r of rows) {
    const username = generateUsername(r.restaurantName, r.id);
    await prisma.botConfig.update({ where: { id: r.id }, data: { loginUsername: username } });
    console.log(`[startup] Assigned loginUsername="${username}" to restaurant ${r.id}`);
  }
}

export function buildAdminApp() {
  const app = express();
  app.use(cookieParser());

  // ── Razorpay webhook — must receive raw body before express.json() parses it ──
  app.post(
    "/webhook/razorpay",
    express.raw({ type: "application/json" }),
    async (req, res) => {
      const rawBody = (req.body as Buffer).toString();
      const signature = req.header("x-razorpay-signature") ?? "";

      let event: any;
      try { event = JSON.parse(rawBody); } catch {
        res.status(400).json({ error: "invalid json" });
        return;
      }

      // Only process the payment_link.paid event
      if (event.event !== "payment_link.paid") {
        res.json({ ok: true });
        return;
      }

      const notes = event.payload?.payment_link?.entity?.notes ?? {};
      const restaurantId = parseInt(notes.restaurantId ?? "0");
      const customerId   = parseInt(notes.customerId   ?? "0");
      if (!restaurantId || !customerId) {
        res.status(400).json({ error: "missing restaurantId/customerId in notes" });
        return;
      }

      const valid = await verifyWebhookSignature(rawBody, signature, restaurantId);
      if (!valid) {
        res.status(400).json({ error: "invalid signature" });
        return;
      }

      // Find the pending order for this customer
      const pendingRow = await prisma.pendingOrder.findUnique({ where: { customerId } });
      if (!pendingRow || pendingRow.restaurantId !== restaurantId) {
        res.json({ ok: true }); // no matching cart — nothing to do
        return;
      }

      // Idempotent — already confirmed
      if (pendingRow.confirmedOrderId) {
        res.json({ ok: true });
        return;
      }

      const cart: { lines: any[]; type: string; note?: string } = {
        lines: JSON.parse(pendingRow.lines),
        type: pendingRow.type,
        note: pendingRow.note ?? undefined,
      };

      const paymentEntity = event.payload?.payment?.entity;
      const linkEntity    = event.payload?.payment_link?.entity;

      // Create the confirmed order with payment already marked as paid
      const order = await createOrder({
        customerId,
        restaurantId,
        type: cart.type,
        note: cart.note,
        lines: cart.lines,
        payment: {
          method:    paymentEntity?.method ?? "online",
          reference: paymentEntity?.id ?? linkEntity?.id,
          status:    "paid",
          paidAt:    new Date(),
        },
      });

      // Stamp the pending order as confirmed
      await prisma.pendingOrder.update({
        where: { customerId },
        data: { confirmedOrderId: order.id },
      });

      // Send WhatsApp confirmation to customer + owner automatically
      const [customer, cfg] = await Promise.all([
        prisma.customer.findUnique({ where: { id: customerId } }),
        prisma.botConfig.findUnique({ where: { id: restaurantId } }),
      ]);
      const session = botSessionManager.getSession(restaurantId);
      if (customer && session) {
        const restaurantName = cfg?.restaurantName ?? "Restaurant";
        const fullOrder = { ...order, customer };
        try {
          // Full itemized receipt to customer
          await session.sendText(customer.phone, orderConfirmationMsg(fullOrder, restaurantName));
        } catch (e) {
          console.error(`[r${restaurantId}] Customer receipt failed:`, e);
        }
        // Notify owner(s)
        const ownerNumbers = (cfg?.ownerNumbers ?? "").split(",").map((s: string) => s.trim()).filter(Boolean);
        const ownerMsg = ownerNewOrderMsg(fullOrder);
        for (const num of ownerNumbers) {
          session.sendText(num, ownerMsg).catch((e: any) =>
            console.error(`[r${restaurantId}] Owner notify failed for ${num}:`, e)
          );
        }
      }

      await notifyAdminOfEvent("order_created", order);
      res.json({ ok: true });
    },
  );

  app.use(express.json());
  app.use(express.static(path.join(__dirname, "public")));

  // Serve Web Menu page
  app.get("/menu", (_req, res) => {
    res.sendFile(path.join(__dirname, "public", "menu.html"));
  });

  // ── Public Menu API for Web Page (unauthenticated) ─────────────────────
  app.get("/public/api/menu/:restaurantId", asyncRoute(async (req, res) => {
    const restaurantId = Number(req.params.restaurantId);
    const restaurant = await prisma.botConfig.findUnique({
      where: { id: restaurantId },
      select: { id: true, restaurantName: true, restaurantCity: true, whatsappPhone: true },
    });
    if (!restaurant) {
      res.status(404).json({ error: "Restaurant not found" });
      return;
    }
    const categories = await getMenu(restaurantId);
    res.json({ restaurant, categories });
  }));

  // ── Public Menu API: Place order from Web Menu ─────────────────────────
  app.post("/public/api/menu/order", asyncRoute(async (req, res) => {
    const restaurantId = Number(req.body.restaurantId);
    const phone = req.body.phone;
    const items = req.body.items; // Array of { menuItemId, variantId, qty }

    if (!restaurantId || !phone || !Array.isArray(items) || items.length === 0) {
      res.status(400).json({ error: "Missing required fields" });
      return;
    }

    // 1. Get or create customer
    const customer = await getOrCreateCustomer(phone, restaurantId);

    // 2. Clear old session messages & pending orders so we start completely clean
    await prisma.$transaction([
      prisma.message.deleteMany({ where: { customerId: customer.id } }),
      prisma.pendingOrder.deleteMany({ where: { customerId: customer.id } }),
    ]);

    // 3. Process items, fetch from DB to calculate totals and item summary labels
    const rawLines = items.map((l: any) => ({
      menuItemId: Number(l.menuItemId),
      variantId: l.variantId ? Number(l.variantId) : undefined,
      qty: Math.max(1, Number(l.qty ?? 1)),
    }));

    const menuItems = await prisma.menuItem.findMany({
      where: { id: { in: rawLines.map((l) => l.menuItemId) } },
      include: { variants: true },
    });
    const byId = new Map(menuItems.map((m) => [m.id, m]));

    const validLines: any[] = [];
    const labels: string[] = [];
    let total = 0;

    for (const l of rawLines) {
      const mi = byId.get(l.menuItemId);
      if (!mi || !mi.available) continue;

      let price = mi.price;
      let variantName: string | undefined;

      if (l.variantId) {
        const variant = mi.variants.find((v) => v.id === l.variantId);
        if (!variant) continue;
        price = variant.price;
        variantName = variant.name;
      }

      validLines.push({
        menuItemId: mi.id,
        variantId: l.variantId,
        qty: l.qty,
      });

      const label = variantName
        ? `${l.qty}x ${mi.name} (${variantName})`
        : `${l.qty}x ${mi.name}`;
      labels.push(`${label} ₹${price * l.qty}`);
      total += price * l.qty;
    }

    if (validLines.length === 0) {
      res.status(400).json({ error: "No valid available items selected" });
      return;
    }

    // 4. Persist the cart in database
    const CART_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
    const cartData = {
      lines: JSON.stringify(validLines),
      type: "pickup", // default to pickup
      expiresAt: new Date(Date.now() + CART_TTL_MS),
    };
    await prisma.pendingOrder.create({
      data: {
        customerId: customer.id,
        restaurantId,
        ...cartData,
      },
    });

    // 5. Send order staged summary into the WhatsApp chat automatically!
    const session = botSessionManager.getSession(restaurantId);
    if (session) {
      const promptText = `I selected some items from the web menu: ${validLines.map(v => `${v.qty}x ${byId.get(v.menuItemId)?.name}`).join(", ")}`;
      // Log the user's action
      await logMessage(customer.id, restaurantId, "user", promptText);

      // Format staged order message
      const stagedMsg = orderStagedTemplate(labels, total, "pickup");
      if (session instanceof KapsoAdapter) {
        await session.sendInteractiveButtons(
          phone,
          stagedMsg,
          [
            { id: "confirm_order_btn", title: "✅ Confirm Order" },
            { id: "add_more_items_btn", title: "➕ Add More Items" }
          ],
          "🛒 Order Summary",
          "Tap button to confirm or message to add items"
        );
      } else {
        await session.sendText(phone, stagedMsg);
      }

      // Log assistant reply
      await logMessage(customer.id, restaurantId, "assistant", stagedMsg);
    }

    res.json({ ok: true });
  }));

  // ── WhatsApp webhook (Kapso v2 + Meta Cloud API fallback) ─────────────────
  // GET: verification handshake — used by both Meta and Kapso
  app.get("/webhook", (req, res) => {
    const mode      = req.query["hub.mode"];
    const token     = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (token === config.cloud.verifyToken) {
      // Meta format: mode must be "subscribe"
      if (mode === "subscribe") {
        res.status(200).send(challenge);
      } else {
        // Kapso may just GET with verify_token — return 200 ok
        res.status(200).send(challenge ?? "ok");
      }
    } else {
      res.sendStatus(403);
    }
  });

  // POST: inbound events from Kapso v2 or raw Meta Cloud API
  app.post("/webhook", async (req, res) => {
    res.sendStatus(200); // always ack immediately — Kapso/Meta requires < 5s

    try {
      const body = req.body;
      console.log("📩 [Webhook Received]:", JSON.stringify(body));

      // 1. Kapso v2 Buffered Batch Format: { batch: true, data: [{ message, conversation, phone_number_id }, ...] }
      if (body?.batch && Array.isArray(body?.data)) {
        for (const item of body.data) {
          const msg = item.message;
          const phoneNumberId = item.phone_number_id ?? body.phone_number_id;
          if (!msg || !phoneNumberId) continue;

          // Only process inbound messages (skip status updates / echoes)
          if (msg.kapso?.direction === "outbound") continue;

          let text = "";
          switch (msg.type) {
            case "text":
              text = msg.text?.body ?? "";
              break;
            case "interactive":
              if (msg.interactive?.type === "address") {
                const addr = msg.interactive.address;
                const parts = [];
                if (addr.name) parts.push(`Name: ${addr.name}`);
                if (addr.phone_number) parts.push(`Phone: ${addr.phone_number}`);
                const street = addr.street_house || addr.address || addr.full_address || "";
                if (street) parts.push(`Address: ${street}`);
                if (addr.city) parts.push(`City: ${addr.city}`);
                if (addr.postal_code) parts.push(`PIN: ${addr.postal_code}`);
                text = parts.join(", ");
              } else {
                // Use .id (routing key), not .title (display text) — see note below.
                text = msg.interactive?.button_reply?.id
                  ?? msg.interactive?.list_reply?.id
                  ?? msg.interactive?.nfm_reply?.body
                  ?? "";
              }
              break;
            case "location":
              text = `Location: ${msg.location?.latitude}, ${msg.location?.longitude} (${msg.location?.address || msg.location?.name || "Shared Location"})`;
              break;
            case "audio":
              text = msg.kapso?.transcript?.text ?? "";
              break;
            case "button":
              text = msg.button?.text ?? "";
              break;
            default:
              text = msg.kapso?.content ?? "";
          }

          if (!text.trim()) continue;

          const phone = msg.from ?? item.conversation?.phone_number ?? "";
          if (!phone) continue;

          const name = item.conversation?.kapso?.contact_name ?? undefined;

          const inbound: InboundMessage = { phone, text: text.trim(), name };
          await botSessionManager.routeCloudMessage(phoneNumberId, inbound);
        }
        return;
      }

      // 2. Kapso v2 Single Message Format: { message: {...}, conversation: {...}, phone_number_id: "..." }
      if (body?.message && (body?.phone_number_id || body?.conversation?.phone_number_id)) {
        const msg = body.message;
        const phoneNumberId = body.phone_number_id ?? body.conversation?.phone_number_id;

        if (msg.kapso?.direction !== "outbound") {
          let text = "";
          switch (msg.type) {
            case "text":
              text = msg.text?.body ?? "";
              break;
            case "interactive":
              if (msg.interactive?.type === "address") {
                const addr = msg.interactive.address;
                const parts = [];
                if (addr.name) parts.push(`Name: ${addr.name}`);
                if (addr.phone_number) parts.push(`Phone: ${addr.phone_number}`);
                const street = addr.street_house || addr.address || addr.full_address || "";
                if (street) parts.push(`Address: ${street}`);
                if (addr.city) parts.push(`City: ${addr.city}`);
                if (addr.postal_code) parts.push(`PIN: ${addr.postal_code}`);
                text = parts.join(", ");
              } else {
                // Use .id (routing key), not .title (display text) — see note below.
                text = msg.interactive?.button_reply?.id
                  ?? msg.interactive?.list_reply?.id
                  ?? msg.interactive?.nfm_reply?.body
                  ?? "";
              }
              break;
            case "location":
              text = `Location: ${msg.location?.latitude}, ${msg.location?.longitude} (${msg.location?.address || msg.location?.name || "Shared Location"})`;
              break;
            case "audio":
              text = msg.kapso?.transcript?.text ?? "";
              break;
            case "button":
              text = msg.button?.text ?? "";
              break;
            default:
              text = msg.kapso?.content ?? "";
          }

          if (text.trim()) {
            const phone = msg.from ?? body.conversation?.phone_number ?? "";
            if (phone) {
              const name = body.conversation?.kapso?.contact_name ?? undefined;
              const inbound: InboundMessage = { phone, text: text.trim(), name };
              await botSessionManager.routeCloudMessage(phoneNumberId, inbound);
            }
          }
        }
        return;
      }

      // 3. Legacy Meta Cloud API format (fallback)
      const entry = body?.entry?.[0]?.changes?.[0]?.value;
      const msg = entry?.messages?.[0];
      if (msg) {
        const phoneNumberId = entry?.metadata?.phone_number_id;
        if (phoneNumberId) {
          // IMPORTANT: use the button/list reply .id (e.g. "menu_item_42"), not
          // .title (e.g. "Add") — the id is what drives direct-action routing
          // in session-manager.ts and agent.ts's natural-language transform.
          // Every carousel card's "Add" button shares the same title, so using
          // .title collapsed all of them into the same, unroutable text.
          let text =
            msg.text?.body
            ?? msg.button?.text
            ?? msg.interactive?.button_reply?.id
            ?? msg.interactive?.list_reply?.id
            ?? "";

          // Voice note — download + transcribe via Groq Whisper. Falls back to
          // the canned "please send text" reply if transcription isn't available.
          if (!text && msg.type === "audio" && msg.audio?.id) {
            try {
              const cfg = await prisma.botConfig.findFirst({ where: { cloudPhoneNumberId: phoneNumberId } });
              const token = cfg?.cloudToken || config.cloud.token;
              const { buffer, mimeType } = await fetchMetaMedia(msg.audio.id, token);
              text = await transcribeAudio(buffer, mimeType);
              console.log(`[Voice] Transcribed: "${text}"`);
            } catch (e) {
              console.error("[Voice] Transcription failed, falling back:", e);
              text = VOICE_NOTE_SENTINEL;
            }
          }

          if (text.trim()) {
            const inbound: InboundMessage = {
              phone: msg.from as string,
              text: text.trim(),
              name: entry?.contacts?.[0]?.profile?.name as string | undefined,
            };
            await botSessionManager.routeCloudMessage(phoneNumberId, inbound);
          }
        }
      }


    } catch (e) {
      console.error("[Webhook]", e);
    }
  });


  // ── Public routes (no auth) ─────────────────────────────────────────────
  app.get("/api/ping", (_req, res) => res.json({ ok: true }));
  app.post("/api/auth/login", loginHandler);
  app.post("/api/auth/logout", logoutHandler);
  app.post("/api/founder/auth/login", founderLoginHandler);
  app.post("/api/founder/auth/logout", founderLogoutHandler);

  // ── Founder panel API ───────────────────────────────────────────────────
  const founder = express.Router();
  founder.use(founderMiddleware);

  founder.get("/auth/me", (_req, res) => res.json({ role: "founder" }));

  // List all restaurants with stats
  founder.get("/restaurants", async (_req, res) => {
    const restaurants = await prisma.botConfig.findMany({
      orderBy: { id: "asc" },
      include: {
        _count: { select: { orders: true, customers: true } },
      },
    });
    res.json(restaurants);
  });

  // Create new restaurant (onboard)
  founder.post("/restaurants", async (req, res) => {
    const { restaurantName, restaurantCity, ownerNumbers, dashboardPassword } = req.body;
    const name = restaurantName ?? "New Restaurant";
    const cfg = await prisma.botConfig.create({
      data: {
        restaurantName: name,
        restaurantCity: restaurantCity ?? "Hyderabad",
        ownerNumbers: ownerNumbers ?? "",
        dashboardPassword: dashboardPassword ?? "changeme",
      },
    });
    // Auto-assign a unique login username based on the restaurant name + ID
    const username = generateUsername(cfg.restaurantName, cfg.id);
    await prisma.botConfig.update({ where: { id: cfg.id }, data: { loginUsername: username } });
    // Seed default prompt template
    const defaultPrompt = await prisma.promptTemplate.findFirst({ where: { restaurantId: 1 } });
    if (defaultPrompt) {
      await prisma.promptTemplate.create({ data: { content: defaultPrompt.content, restaurantId: cfg.id } });
    }
    // Seed tool definitions from restaurant 1 as template
    const defaultTools = await prisma.toolDefinition.findMany({ where: { restaurantId: 1 } });
    for (const tool of defaultTools) {
      await prisma.toolDefinition.create({
        data: {
          name: tool.name, description: tool.description,
          parametersSchema: tool.parametersSchema, sortOrder: tool.sortOrder,
          restaurantId: cfg.id,
        },
      });
    }
    res.json(cfg);
  });

  // Get single restaurant config
  founder.get("/restaurants/:id", async (req, res) => {
    const cfg = await prisma.botConfig.findUnique({ where: { id: Number(req.params.id) } });
    if (!cfg) { res.status(404).json({ error: "not found" }); return; }
    res.json(cfg);
  });

  // Update restaurant config
  founder.put("/restaurants/:id/config", async (req, res) => {
    const id = Number(req.params.id);
    const allowed = [
      "restaurantName", "restaurantCity", "ownerNumbers", "dashboardPassword",
      "loginUsername", "isActive", "botPaused", "pauseMessage", "upiId", "paymentMethods",
      "requiresPaymentBeforeOrder", "razorpayEnabled", "razorpayKeyId",
      "razorpayKeySecret", "razorpayWebhookSecret",
      "cloudPhoneNumberId", "cloudToken",
    ];
    const data: Record<string, unknown> = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) data[key] = req.body[key];
    }
    const cfg = await prisma.botConfig.update({ where: { id }, data });
    res.json(cfg);
  });

  // Get prompt template
  founder.get("/restaurants/:id/prompt", async (req, res) => {
    const id = Number(req.params.id);
    const prompt = await prisma.promptTemplate.findFirst({ where: { restaurantId: id } });
    res.json(prompt ?? {});
  });

  // Update prompt template
  founder.put("/restaurants/:id/prompt", async (req, res) => {
    const id = Number(req.params.id);
    const { content } = req.body;
    if (typeof content !== "string") {
      res.status(400).json({ error: "content must be a string" });
      return;
    }
    try {
      const existing = await prisma.promptTemplate.findFirst({ where: { restaurantId: id } });
      const result = existing
        ? await prisma.promptTemplate.update({ where: { id: existing.id }, data: { content } })
        : await prisma.promptTemplate.create({ data: { content, restaurantId: id } });
      await notifyAdminOfEvent("config_updated", { restaurantId: id });
      res.json(result);
    } catch (e: any) {
      console.error(`[founder] prompt save failed for r${id}:`, e);
      res.status(500).json({ error: e?.message ?? "save failed" });
    }
  });

  // Restaurant stats overview
  founder.get("/restaurants/:id/stats", async (req, res) => {
    const id = Number(req.params.id);
    const [orderCount, customerCount, revenue] = await Promise.all([
      prisma.order.count({ where: { restaurantId: id } }),
      prisma.customer.count({ where: { restaurantId: id } }),
      prisma.payment.aggregate({ where: { restaurantId: id, status: "paid" }, _sum: { amount: true } }),
    ]);
    res.json({ orderCount, customerCount, revenue: revenue._sum.amount ?? 0 });
  });

  // Bot start/stop (via session manager)
  founder.post("/restaurants/:id/bot/start", async (req, res) => {
    const id = Number(req.params.id);
    const cfg = await prisma.botConfig.findUnique({ where: { id } });
    if (!cfg) { res.status(404).json({ error: "not found" }); return; }
    if (botSessionManager.isRunning(id)) {
      res.json({ ok: true, message: "already running" });
      return;
    }
    await botSessionManager.startSession(id, cfg.restaurantName);
    res.json({ ok: true });
  });

  founder.post("/restaurants/:id/bot/stop", (req, res) => {
    botSessionManager.stopSession(Number(req.params.id));
    res.json({ ok: true });
  });

  // Toggle active status
  founder.put("/restaurants/:id/active", async (req, res) => {
    const id = Number(req.params.id);
    const cfg = await prisma.botConfig.update({
      where: { id },
      data: { isActive: !!req.body.isActive },
    });
    res.json({ isActive: cfg.isActive });
  });

  // Serve founder panel static files at /api/founder/* (public files served separately)
  app.use("/api/founder", founder);

  // ── Protected API (session required — all routes below need valid JWT) ──
  const api = express.Router();
  api.use(authMiddleware);

  api.get("/auth/me", meHandler);

  // --- Categories ---
  api.get("/categories", async (req, res) => {
    res.json(await prisma.category.findMany({
      where: { restaurantId: req.restaurantId },
      orderBy: { sortOrder: "asc" },
    }));
  });

  api.post("/categories", async (req, res) => {
    const { name, sortOrder } = req.body;
    const category = await prisma.category.create({
      data: { name, sortOrder: sortOrder ?? 0, restaurantId: req.restaurantId },
    });
    await notifyAdminOfEvent("menu_updated", { type: "category_created", category });
    res.json(category);
  });

  api.delete("/categories/:id", async (req, res) => {
    const id = Number(req.params.id);
    try {
      await prisma.category.delete({ where: { id } });
      await notifyAdminOfEvent("menu_updated", { type: "category_deleted", id });
      res.json({ ok: true });
    } catch (e: any) {
      if (e?.code === "P2003") {
        res.status(409).json({ error: "Cannot delete — this category has items referenced by existing orders. Remove those orders first or soft-delete items instead." });
      } else {
        res.status(500).json({ error: e?.message ?? "Delete failed" });
      }
    }
  });

  // --- Menu items ---
  api.get("/menu", async (req, res) => {
    res.json(await getMenu(req.restaurantId, { includeUnavailable: true }));
  });

  api.post("/items", async (req, res) => {
    const { name, description, price, categoryId, isVeg, spiceLevel, available, stockCount, pieceInfo, sortOrder, imageUrl } = req.body;
    const item = await prisma.menuItem.create({
      data: {
        name,
        description,
        price: Number(price),
        categoryId: Number(categoryId),
        restaurantId: req.restaurantId,
        isVeg: !!isVeg,
        spiceLevel,
        available: available ?? true,
        stockCount: stockCount === null || stockCount === undefined || stockCount === "" ? null : Number(stockCount),
        pieceInfo: pieceInfo || null,
        sortOrder: sortOrder !== undefined ? Number(sortOrder) : 0,
        imageUrl: imageUrl || null,
      },
    });
    await notifyAdminOfEvent("menu_updated", { type: "item_created", item });
    res.json(item);
  });

  api.put("/items/:id", async (req, res) => {
    const { name, description, price, categoryId, isVeg, spiceLevel, available, stockCount, pieceInfo, sortOrder, imageUrl } = req.body;
    const id = Number(req.params.id);
    const data: Record<string, unknown> = {};
    if (name !== undefined) data.name = name;
    if (description !== undefined) data.description = description;
    if (price !== undefined) data.price = Number(price);
    if (categoryId !== undefined) data.categoryId = Number(categoryId);
    if (isVeg !== undefined) data.isVeg = !!isVeg;
    if (spiceLevel !== undefined) data.spiceLevel = spiceLevel;
    if (available !== undefined) data.available = !!available;
    // stockCount: null = unlimited, number = specific stock
    if (stockCount !== undefined) data.stockCount = stockCount === null || stockCount === "" ? null : Number(stockCount);
    if (pieceInfo !== undefined) data.pieceInfo = pieceInfo || null;
    if (sortOrder !== undefined) data.sortOrder = Number(sortOrder);
    if (imageUrl !== undefined) data.imageUrl = imageUrl || null;
    const item = await prisma.menuItem.update({ where: { id }, data });
    await notifyAdminOfEvent("menu_updated", { type: "item_updated", item });
    res.json(item);
  });

  api.delete("/items/:id", async (req, res) => {
    const id = Number(req.params.id);
    try {
      await prisma.menuItem.delete({ where: { id } });
      await notifyAdminOfEvent("menu_updated", { type: "item_deleted", id });
      res.json({ ok: true });
    } catch (e: any) {
      if (e?.code === "P2003") {
        res.status(409).json({ error: "Cannot delete — this item appears in existing orders. Toggle it unavailable instead." });
      } else {
        res.status(500).json({ error: e?.message ?? "Delete failed" });
      }
    }
  });

  // --- Menu item variants ---
  api.get("/items/:id/variants", async (req, res) => {
    res.json(await prisma.menuItemVariant.findMany({
      where: { menuItemId: Number(req.params.id), restaurantId: req.restaurantId },
      orderBy: { sortOrder: "asc" },
    }));
  });

  api.post("/items/:id/variants", async (req, res) => {
    const { name, price, available, sortOrder } = req.body;
    const variant = await prisma.menuItemVariant.create({
      data: {
        menuItemId: Number(req.params.id),
        restaurantId: req.restaurantId,
        name,
        price: Number(price),
        available: available ?? true,
        sortOrder: sortOrder ?? 0,
      },
    });
    await notifyAdminOfEvent("menu_updated", { type: "variant_created", variant });
    res.json(variant);
  });

  api.put("/variants/:id", async (req, res) => {
    const { name, price, available, sortOrder } = req.body;
    const data: Record<string, unknown> = {};
    if (name !== undefined) data.name = name;
    if (price !== undefined) data.price = Number(price);
    if (available !== undefined) data.available = !!available;
    if (sortOrder !== undefined) data.sortOrder = Number(sortOrder);
    const variant = await prisma.menuItemVariant.update({
      where: { id: Number(req.params.id) },
      data,
    });
    await notifyAdminOfEvent("menu_updated", { type: "variant_updated", variant });
    res.json(variant);
  });

  api.delete("/variants/:id", async (req, res) => {
    const id = Number(req.params.id);
    await prisma.menuItemVariant.delete({ where: { id } });
    await notifyAdminOfEvent("menu_updated", { type: "variant_deleted", id });
    res.json({ ok: true });
  });

  // --- Orders ---
  api.get("/orders", async (req, res) => {
    res.json(await listOrders(req.restaurantId, req.query.status as string | undefined));
  });

  api.put("/orders/:id/status", async (req, res) => {
    const order = await setOrderStatus(Number(req.params.id), req.body.status);
    res.json(order);

    // Notify customer on meaningful status changes
    const { status } = req.body;
    if (["preparing", "ready", "delivered", "cancelled"].includes(status)) {
      try {
        const cfg = await prisma.botConfig.findUnique({ where: { id: order.restaurantId } });
        const msg = orderStatusMsg(order, status, cfg?.restaurantName ?? "");
        if (msg) {
          const session = botSessionManager.getSession(order.restaurantId);
          if (session) await session.sendText(order.customer.phone, msg);
        }
      } catch (e) {
        console.error(`[r${order.restaurantId}] Status notify failed:`, e);
      }
    }
  });

  api.put("/orders/:id/payment", async (req, res) => {
    const { status } = req.body;
    res.json(await setPaymentStatus(Number(req.params.id), status));
  });

  // --- Payments ---
  api.get("/payments", asyncRoute(async (req, res) => {
    const payments = await prisma.payment.findMany({
      where: { restaurantId: req.restaurantId },
      orderBy: { createdAt: "desc" },
      include: { order: { include: { customer: { select: { phone: true, name: true } } } } },
      take: 200,
    });
    res.json(payments);
  }));

  // --- Bot pause toggle ---
  api.put("/bot/pause", async (req, res) => {
    const { paused, message } = req.body;
    const cfg = await prisma.botConfig.update({
      where: { id: req.restaurantId },
      data: {
        botPaused: !!paused,
        ...(message !== undefined ? { pauseMessage: message || null } : {}),
      },
    });
    res.json({ botPaused: cfg.botPaused, pauseMessage: cfg.pauseMessage });
  });

  // --- Daily menu publish toggle (gates ordering per prompt.ts's menu-state block) ---
  api.put("/daily-menu/publish", async (req, res) => {
    const { published } = req.body;
    const cfg = await prisma.botConfig.update({
      where: { id: req.restaurantId },
      data: {
        dailyMenuPublished: !!published,
        dailyMenuPublishedAt: published ? new Date() : null,
      },
    });
    await notifyAdminOfEvent("config_updated", { restaurantId: req.restaurantId });
    res.json({ dailyMenuPublished: cfg.dailyMenuPublished, dailyMenuPublishedAt: cfg.dailyMenuPublishedAt });
  });

  // --- Bot Config ---
  api.get("/config", async (req, res) => {
    res.json(await prisma.botConfig.findUnique({ where: { id: req.restaurantId } }) ?? {});
  });

  api.put("/config", async (req, res) => {
    const {
      restaurantName, restaurantCity, personaName, ownerNumbers,
      dashboardPassword, requiresPaymentBeforeOrder, upiId, paymentMethods,
      razorpayEnabled, razorpayKeyId, razorpayKeySecret, razorpayWebhookSecret,
      botPaused, pauseMessage, whatsappPhone,
      cloudPhoneNumberId, cloudToken,
    } = req.body;

    // Detect phone number change before saving (to decide if we need session reset)
    const prev = await prisma.botConfig.findUnique({ where: { id: req.restaurantId }, select: { whatsappPhone: true } });
    const phoneChanged = whatsappPhone !== undefined && (whatsappPhone || null) !== (prev?.whatsappPhone ?? null);

    const data: Record<string, unknown> = {};
    if (restaurantName !== undefined) data.restaurantName = restaurantName;
    if (restaurantCity !== undefined) data.restaurantCity = restaurantCity;
    if (personaName !== undefined) data.personaName = personaName || null;
    if (ownerNumbers !== undefined) data.ownerNumbers = ownerNumbers;
    if (dashboardPassword !== undefined) data.dashboardPassword = dashboardPassword;
    if (requiresPaymentBeforeOrder !== undefined) data.requiresPaymentBeforeOrder = !!requiresPaymentBeforeOrder;
    if (upiId !== undefined) data.upiId = upiId;
    if (paymentMethods !== undefined) data.paymentMethods = paymentMethods;
    if (razorpayEnabled !== undefined) data.razorpayEnabled = !!razorpayEnabled;
    if (razorpayKeyId !== undefined) data.razorpayKeyId = razorpayKeyId;
    if (razorpayKeySecret !== undefined) data.razorpayKeySecret = razorpayKeySecret;
    if (razorpayWebhookSecret !== undefined) data.razorpayWebhookSecret = razorpayWebhookSecret;
    if (botPaused !== undefined) data.botPaused = !!botPaused;
    if (pauseMessage !== undefined) data.pauseMessage = pauseMessage || null;
    if (whatsappPhone !== undefined) data.whatsappPhone = whatsappPhone || null;
    if (cloudPhoneNumberId !== undefined) data.cloudPhoneNumberId = cloudPhoneNumberId || null;
    if (cloudToken !== undefined && cloudToken) data.cloudToken = cloudToken;

    const updated = await prisma.botConfig.update({ where: { id: req.restaurantId }, data });

    // Invalidate the bot's in-memory config/menu/tools cache on the next message.
    await notifyAdminOfEvent("config_updated", { restaurantId: req.restaurantId });

    // Phone number changed → reset session so new pairing code / QR is issued automatically
    if (phoneChanged && config.whatsappProvider === "baileys") {
      botSessionManager.resetSession(req.restaurantId).catch((e) =>
        console.error(`[r${req.restaurantId}] Auto session reset failed:`, e),
      );
      return res.json({ ...updated, sessionReset: true });
    }

    res.json(updated);
  });

  // --- Prompt Template ---
  api.get("/prompt", async (req, res) => {
    res.json(await prisma.promptTemplate.findFirst({ where: { restaurantId: req.restaurantId } }) ?? {});
  });

  api.put("/prompt", async (req, res) => {
    const { content } = req.body;
    const existing = await prisma.promptTemplate.findFirst({ where: { restaurantId: req.restaurantId } });
    const result = existing
      ? await prisma.promptTemplate.update({ where: { id: existing.id }, data: { content } })
      : await prisma.promptTemplate.create({ data: { content, restaurantId: req.restaurantId } });
    await notifyAdminOfEvent("config_updated", { restaurantId: req.restaurantId });
    res.json(result);
  });

  // --- Tool Definitions ---
  api.get("/tools", async (req, res) => {
    res.json(await prisma.toolDefinition.findMany({
      where: { restaurantId: req.restaurantId },
      orderBy: { sortOrder: "asc" },
    }));
  });

  api.put("/tools/:id", async (req, res) => {
    const id = Number(req.params.id);
    const { isEnabled, description, parametersSchema } = req.body;
    const data: Record<string, unknown> = {};
    if (isEnabled !== undefined) data.isEnabled = !!isEnabled;
    if (description !== undefined) data.description = description;
    if (parametersSchema !== undefined) data.parametersSchema = parametersSchema;
    const result = await prisma.toolDefinition.update({ where: { id }, data });
    await notifyAdminOfEvent("config_updated", { restaurantId: req.restaurantId });
    res.json(result);
  });

  // --- Customers ---
  api.get("/customers", async (req, res) => {
    res.json(await prisma.customer.findMany({
      where: { restaurantId: req.restaurantId },
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { orders: true } } },
      take: 200,
    }));
  });

  api.get("/customers/:id/messages", async (req, res) => {
    res.json(await prisma.message.findMany({
      where: {
        customerId: Number(req.params.id),
        restaurantId: req.restaurantId,
      },
      orderBy: { createdAt: "asc" },
    }));
  });

  api.put("/customers/:id", async (req, res) => {
    const { name, address, notes } = req.body;
    const customer = await prisma.customer.update({
      where: { id: Number(req.params.id) },
      data: { name, address, notes },
    });
    await notifyAdminOfEvent("customer_updated", customer);
    res.json(customer);
  });

  // Staff reply to a customer (used during human handoff). Sends over WhatsApp
  // and logs it as an assistant-role message so it shows in the chat thread.
  api.post("/customers/:id/message", asyncRoute(async (req, res) => {
    const id = Number(req.params.id);
    const text = String(req.body?.text ?? "").trim();
    if (!text) { res.status(400).json({ error: "text is required" }); return; }

    const customer = await prisma.customer.findFirst({
      where: { id, restaurantId: req.restaurantId },
    });
    if (!customer) { res.status(404).json({ error: "customer not found" }); return; }

    const session = botSessionManager.getSession(req.restaurantId);
    if (!session) { res.status(503).json({ error: "bot session not running" }); return; }

    await session.sendText(customer.phone, text);
    const msg = await logMessage(customer.id, req.restaurantId, "assistant", text);
    res.json(msg);
  }));

  // Clear a human-handoff flag so the AI resumes handling this customer.
  api.put("/customers/:id/resume-ai", asyncRoute(async (req, res) => {
    const id = Number(req.params.id);
    const customer = await prisma.customer.update({
      where: { id },
      data: { humanRequestedAt: null },
    });
    await notifyAdminOfEvent("customer_updated", customer);
    await logActivity(req.restaurantId, "handoff_resolved", "Staff resumed the AI", undefined, id);
    res.json(customer);
  }));

  // --- Activity log (bot health) ---
  api.get("/activity", async (req, res) => {
    res.json(await prisma.activityLog.findMany({
      where: { restaurantId: req.restaurantId },
      orderBy: { createdAt: "desc" },
      take: 100,
    }));
  });

  // --- Real-time Events (SSE) ---
  api.get("/events", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
    const onEvent = (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    eventBus.on("event", onEvent);
    // Heartbeat every 25s to keep Railway's proxy from dropping the connection
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 25_000);
    req.on("close", () => { eventBus.off("event", onEvent); clearInterval(heartbeat); });
  });

  // --- QR / connection state ---
  api.get("/qr", (_req, res) => {
    res.json({
      qr: whatsappState.lastQR,
      pairingCode: whatsappState.lastPairingCode,
      connected: whatsappState.connected,
      connectedPhone: whatsappState.connectedPhone,
      provider: config.whatsappProvider,
    });
  });

  // Reset Baileys session: clears corrupted keys and triggers fresh QR
  api.post("/session/reset", async (req, res) => {
    try {
      const restaurantId = req.restaurantId;
      await botSessionManager.resetSession(restaurantId);
      res.json({ ok: true, message: "Session reset — scan the new QR to reconnect." });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.use("/api", api);

  // ── Internal route (called by the bot process, not the browser) ─────────
  // Secured by requiring a matching INTERNAL_SECRET header.
  app.post("/internal/events", (req, res) => {
    const secret = req.header("x-internal-secret");
    if (process.env.INTERNAL_SECRET && secret !== process.env.INTERNAL_SECRET) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    const { type, data } = req.body as { type: string; data: Record<string, unknown> };
    if (type === "qr_received") {
      whatsappState.lastQR = data.qr as string;
      whatsappState.lastPairingCode = null;
      whatsappState.connected = false;
    } else if (type === "pairing_code") {
      whatsappState.lastPairingCode = data.code as string;
      whatsappState.lastQR = null;
      whatsappState.connected = false;
    } else if (type === "whatsapp_connected") {
      whatsappState.lastQR = null;
      whatsappState.lastPairingCode = null;
      whatsappState.connected = true;
    } else if (type === "whatsapp_disconnected") {
      whatsappState.lastQR = null;
      whatsappState.lastPairingCode = null;
      whatsappState.connected = false;
    }
    eventBus.emit("event", { type, data });
    res.json({ ok: true });
  });

  // Fill in loginUsername for any restaurant that doesn't have one yet
  ensureLoginUsernames().catch(e => console.error("[startup] ensureLoginUsernames failed:", e));

  // Catch errors forwarded via next(err) — e.g. asyncRoute wrapping a DB call that fails.
  // Returns 503 so the admin UI shows an error message instead of hanging indefinitely.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error("[admin] Route error:", err);
    if (!res.headersSent) {
      res.status(503).json({ error: "Service temporarily unavailable — please try again" });
    }
  });

  return app;
}

if (process.argv[1] && process.argv[1].endsWith("server.ts")) {
  buildAdminApp().listen(config.adminPort, "0.0.0.0", () => {
    console.log(`🛠️  Admin portal: http://localhost:${config.adminPort}`);
  });
}
