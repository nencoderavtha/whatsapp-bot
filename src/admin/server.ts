import express from "express";
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
import type { InboundMessage } from "../whatsapp/adapter.js";
import { orderStatusMsg, paymentReceivedMsg } from "../services/notifications.js";

process.env.IS_ADMIN_SERVER = "true";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

      // Send WhatsApp confirmation to customer automatically
      const [customer, cfg] = await Promise.all([
        prisma.customer.findUnique({ where: { id: customerId } }),
        prisma.botConfig.findUnique({ where: { id: restaurantId } }),
      ]);
      if (customer) {
        const session = botSessionManager.getSession(restaurantId);
        if (session) {
          try {
            const fullOrder = { ...order, customer };
            const msg = paymentReceivedMsg(fullOrder, cfg?.restaurantName ?? "Restaurant");
            await session.sendText(customer.phone, msg);
          } catch (e) {
            console.error(`[r${restaurantId}] WhatsApp confirmation failed:`, e);
          }
        }
      }

      await notifyAdminOfEvent("order_created", order);
      res.json({ ok: true });
    },
  );

  app.use(express.json());
  app.use(express.static(path.join(__dirname, "public")));

  // ── WhatsApp Cloud API webhook ──────────────────────────────────────────
  // GET: Meta verification handshake
  app.get("/webhook", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === config.cloud.verifyToken) {
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  });

  // POST: inbound messages from Meta — route to correct restaurant by phoneNumberId
  app.post("/webhook", async (req, res) => {
    res.sendStatus(200); // ack immediately — Meta requires < 5s
    try {
      const entry = req.body?.entry?.[0]?.changes?.[0]?.value;
      const msg = entry?.messages?.[0];
      if (!msg) return;
      const phoneNumberId: string = entry?.metadata?.phone_number_id;
      if (!phoneNumberId) return;
      const text: string =
        msg.text?.body ?? msg.button?.text ?? msg.interactive?.list_reply?.title ?? "";
      if (!text.trim()) return;
      const inbound: InboundMessage = {
        phone: msg.from as string,
        text: text.trim(),
        name: entry?.contacts?.[0]?.profile?.name as string | undefined,
      };
      await botSessionManager.routeCloudMessage(phoneNumberId, inbound);
    } catch (e) {
      console.error("[Cloud webhook]", e);
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
    const cfg = await prisma.botConfig.create({
      data: {
        restaurantName: restaurantName ?? "New Restaurant",
        restaurantCity: restaurantCity ?? "Hyderabad",
        ownerNumbers: ownerNumbers ?? "",
        dashboardPassword: dashboardPassword ?? "changeme",
      },
    });
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
      "isActive", "botPaused", "pauseMessage", "upiId", "paymentMethods",
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

  // Update prompt template (with variable substitution preview)
  founder.put("/restaurants/:id/prompt", async (req, res) => {
    const id = Number(req.params.id);
    const { content } = req.body;
    const existing = await prisma.promptTemplate.findFirst({ where: { restaurantId: id } });
    const result = existing
      ? await prisma.promptTemplate.update({ where: { id: existing.id }, data: { content } })
      : await prisma.promptTemplate.create({ data: { content, restaurantId: id } });
    res.json(result);
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
    await prisma.category.delete({ where: { id } });
    await notifyAdminOfEvent("menu_updated", { type: "category_deleted", id });
    res.json({ ok: true });
  });

  // --- Menu items ---
  api.get("/menu", async (req, res) => {
    res.json(await getMenu(req.restaurantId, { includeUnavailable: true }));
  });

  api.post("/items", async (req, res) => {
    const { name, description, price, categoryId, isVeg, spiceLevel, available } = req.body;
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
      },
    });
    await notifyAdminOfEvent("menu_updated", { type: "item_created", item });
    res.json(item);
  });

  api.put("/items/:id", async (req, res) => {
    const { name, description, price, categoryId, isVeg, spiceLevel, available, stockCount } = req.body;
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
    const item = await prisma.menuItem.update({ where: { id }, data });
    await notifyAdminOfEvent("menu_updated", { type: "item_updated", item });
    res.json(item);
  });

  api.delete("/items/:id", async (req, res) => {
    const id = Number(req.params.id);
    await prisma.menuItem.delete({ where: { id } });
    await notifyAdminOfEvent("menu_updated", { type: "item_deleted", id });
    res.json({ ok: true });
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
  api.get("/payments", async (req, res) => {
    const payments = await prisma.payment.findMany({
      where: { restaurantId: req.restaurantId },
      orderBy: { createdAt: "desc" },
      include: { order: { include: { customer: { select: { phone: true, name: true } } } } },
      take: 200,
    });
    res.json(payments);
  });

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

  // --- Bot Config ---
  api.get("/config", async (req, res) => {
    res.json(await prisma.botConfig.findUnique({ where: { id: req.restaurantId } }) ?? {});
  });

  api.put("/config", async (req, res) => {
    const {
      restaurantName, restaurantCity, ownerNumbers,
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
    res.json(await prisma.toolDefinition.update({ where: { id }, data }));
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

  // --- Real-time Events (SSE) ---
  api.get("/events", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
    const onEvent = (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    eventBus.on("event", onEvent);
    req.on("close", () => eventBus.off("event", onEvent));
  });

  // --- QR / connection state ---
  api.get("/qr", (_req, res) => {
    res.json({
      qr: whatsappState.lastQR,
      pairingCode: whatsappState.lastPairingCode,
      connected: whatsappState.connected,
      provider: config.whatsappProvider,
    });
  });

  // Reset Baileys session: clears corrupted keys and triggers fresh QR
  api.post("/session/reset", async (req, res) => {
    try {
      const restaurantId = Number((req as any).user?.restaurantId ?? 1);
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

  return app;
}

if (process.argv[1] && process.argv[1].endsWith("server.ts")) {
  buildAdminApp().listen(config.adminPort, "0.0.0.0", () => {
    console.log(`🛠️  Admin portal: http://localhost:${config.adminPort}`);
  });
}
