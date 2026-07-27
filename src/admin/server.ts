import { createHmac } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Request, type Response, type NextFunction } from "express";
import cookieParser from "cookie-parser";

import { config } from "../config.js";
import { prisma } from "../db.js";
import { botSessionManager } from "../whatsapp/session-manager.js";
import { getMenu } from "../services/menu.js";
import { createOrder, getOrder, listOrders, setOrderStatus, setPaymentStatus } from "../services/order.js";
import {
  orderConfirmationMsg,
  orderStatusMsg,
  ownerNewOrderMsg,
  deliveryStatusMsg,
} from "../services/notifications.js";
import {
  authMiddleware,
  founderMiddleware,
  loginHandler,
  logoutHandler,
  founderLoginHandler,
  founderLogoutHandler,
  meHandler,
} from "./auth.js";
import { getOrCreateCustomer, logMessage } from "../services/customer.js";
import { cartSummaryText } from "../whatsapp/renderers.js";
import { notifyAdminOfEvent, eventBus } from "../services/events.js";
import { logActivity } from "../services/activity.js";
import { createPaymentLink, verifyWebhookSignature } from "../services/razorpay.js";
import { transcribeAudio } from "../services/transcription.js";
import { fetchMetaMedia } from "../whatsapp/media.js";
import { VOICE_NOTE_SENTINEL, type InboundMessage } from "../whatsapp/adapter.js";
import { DeliveryManager } from "../services/delivery/delivery-manager.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function asyncRoute(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

export function buildAdminApp() {
  const app = express();
  app.use(cookieParser());
  app.use((_req, res, next) => {
    res.setHeader("ngrok-skip-browser-warning", "true");
    next();
  });

  app.post("/webhook/borzo", express.json(), async (req, res) => {
    const callbackToken = process.env.BORZO_CALLBACK_TOKEN;
    const incomingToken = req.header("X-DV-Auth-Token") || req.header("X-DV-Callback-Token");

    if (callbackToken && incomingToken && incomingToken !== callbackToken) {
      console.warn("⚠️ [Borzo Webhook] Unauthorized callback attempt — token mismatch.");
      res.status(401).json({ error: "Unauthorized callback token" });
      return;
    }

    console.log("🚚 [Borzo Webhook Event Received]:", JSON.stringify(req.body, null, 2));

    const body = req.body;
    const orderData = body?.order || (body?.delivery ? { order_id: body.delivery.order_id, status: body.delivery.status, courier: body.delivery.courier, points: [] } : null);

    if (orderData) {
      const borzoOrderId = String(orderData.order_id || "");
      const dbOrderId = orderData.client_order_id ? Number(orderData.client_order_id) : null;
      const rawStatus = String(orderData.status || orderData.status_description || "").toLowerCase();
      const courier = orderData.courier;

      const statusMap: Record<string, string> = {
        // Order level statuses
        new: "SEARCHING_RIDER",
        available: "SEARCHING_RIDER",
        active: "COURIER_ASSIGNED",
        courier_assigned: "COURIER_ASSIGNED",
        picked_up: "PICKED_UP",
        in_transit: "IN_TRANSIT",
        completed: "DELIVERED",
        delivered: "DELIVERED",
        canceled: "CANCELLED",
        cancelled: "CANCELLED",

        // Delivery point / rider progress statuses
        planned: "SEARCHING_RIDER",
        courier_departed: "COURIER_ASSIGNED",
        courier_at_pickup: "COURIER_ASSIGNED",
        parcel_picked_up: "PICKED_UP",
        courier_arrived: "IN_TRANSIT",
        finished: "DELIVERED",
      };

      const mappedStatus = statusMap[rawStatus] || "COURIER_ASSIGNED";
      // Fall back to a tracking URL on whichever Borzo environment we're pointed at —
      // hardcoding the sandbox host sent production customers to a test tracking page.
      const borzoTrackHost =
        (process.env.BORZO_ENV ?? "sandbox") === "production"
          ? "https://borzodelivery.com"
          : "https://robotapitest-in.borzodelivery.com";
      const trackingUrl = orderData.points?.find((p: any) => p.tracking_url)?.tracking_url || `${borzoTrackHost}/in/track/${borzoOrderId}`;

      const logStatusMessages: Record<string, string> = {
        SEARCHING_RIDER: `🔍 [Rider Search Active] Borzo Order #${borzoOrderId}: Searching for nearby riders...`,
        COURIER_ASSIGNED: `👤 [Courier Assigned] Borzo Order #${borzoOrderId}: Rider ${courier ? `${courier.name} (${courier.phone})` : "Assigned"}`,
        PICKED_UP: `📦 [Parcel Picked Up] Borzo Order #${borzoOrderId}: Courier picked up parcel from kitchen`,
        IN_TRANSIT: `🛵 [Out for Delivery] Borzo Order #${borzoOrderId}: Courier enroute to customer address`,
        DELIVERED: `🎉 [Delivery Completed] Borzo Order #${borzoOrderId}: Parcel delivered successfully!`,
      };

      console.log(logStatusMessages[mappedStatus] || `📦 [Borzo Status Update] Order #${borzoOrderId} -> ${mappedStatus}`);

      try {
        // Find dispatch record by externalDeliveryId (e.g. BRZ-329268 or 329268) or by orderId
        const existing = await prisma.deliveryDispatch.findFirst({
          where: {
            OR: [
              { externalDeliveryId: `BRZ-${borzoOrderId}` },
              { externalDeliveryId: borzoOrderId },
              ...(dbOrderId ? [{ orderId: dbOrderId }] : []),
            ],
          },
        });

        if (existing) {
          const updatedDispatch = await prisma.deliveryDispatch.update({
            where: { id: existing.id },
            data: {
              status: mappedStatus,
              ...(courier?.name ? { riderName: courier.name } : {}),
              ...(courier?.phone ? { riderPhone: courier.phone } : {}),
              ...(courier?.vehicle_number ? { riderVehicleNumber: courier.vehicle_number } : {}),
            },
          });

          // Send live WhatsApp status update to customer (Only for PICKED_UP, IN_TRANSIT, DELIVERED)
          if (["PICKED_UP", "IN_TRANSIT", "DELIVERED"].includes(mappedStatus)) {
            const order = await getOrder(existing.orderId);
            if (order && order.customer?.phone) {
              const session = botSessionManager.getSession(1);
              if (session) {
                const cfg = await prisma.restaurantConfig.findUnique({ where: { id: 1 } });
                const msgText = deliveryStatusMsg(
                  existing.orderId,
                  mappedStatus,
                  courier?.name,
                  courier?.phone,
                  trackingUrl,
                  cfg?.restaurantName ?? "Godavari Ruchulu",
                );
                if (msgText) {
                  await session.sendText(order.customer.phone, msgText);
                  console.log(`📱 [WhatsApp Sent to Customer ${order.customer.phone}] Delivery Status: ${mappedStatus}`);
                }
              }
            }
          }

          if (mappedStatus === "DELIVERED") {
            await setOrderStatus(existing.orderId, "delivered");
          } else if (["PICKED_UP", "IN_TRANSIT"].includes(mappedStatus)) {
            // The courier has the food — only now is the order really out for
            // delivery. Setting this at booking time claimed it before a rider
            // had even been assigned.
            await setOrderStatus(existing.orderId, "out_for_delivery");
            await notifyAdminOfEvent("order_updated", { orderId: existing.orderId, status: mappedStatus, deliveryDispatch: updatedDispatch });
          } else {
            await notifyAdminOfEvent("order_updated", { orderId: existing.orderId, status: mappedStatus, deliveryDispatch: updatedDispatch });
          }
        }
      } catch (err) {
        console.error("⚠️ [Borzo Webhook DB Error]", err);
      }
    }

    res.json({ ok: true });
  });

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

      if (event.event !== "payment_link.paid") {
        res.json({ ok: true });
        return;
      }

      const notes = event.payload?.payment_link?.entity?.notes ?? {};
      const restaurantId = parseInt(notes.restaurantId ?? "1");
      const customerId   = parseInt(notes.customerId   ?? "0");
      if (!customerId) {
        res.status(400).json({ error: "missing customerId in notes" });
        return;
      }

      const valid = await verifyWebhookSignature(rawBody, signature, restaurantId);
      if (!valid) {
        res.status(400).json({ error: "invalid signature" });
        return;
      }

      const pendingRow = await prisma.pendingOrder.findUnique({ where: { customerId } });
      if (!pendingRow) {
        res.json({ ok: true });
        return;
      }

      if (pendingRow.confirmedOrderId) {
        res.json({ ok: true });
        return;
      }

      const cart: { lines: any[]; type: string; note?: string } = {
        lines: JSON.parse(pendingRow.lines),
        type: pendingRow.type,
        note: pendingRow.note ?? undefined,
      };

      // Snapshot the delivery details onto the order. Without these the receipt,
      // the owner notification and the customer's saved-address list all come up
      // empty, and the order total omits the delivery fee that was charged.
      const payingCustomer = await prisma.customer.findUnique({ where: { id: customerId } });

      const order = await createOrder({
        customerId,
        // Every order is a delivery order — there is no pickup path.
        type: "delivery",
        note: cart.note,
        lines: cart.lines,
        deliveryFee: pendingRow.deliveryFee ?? undefined,
        deliveryAddress: payingCustomer?.address ?? undefined,
        deliveryLat: payingCustomer?.deliveryLat ?? undefined,
        deliveryLng: payingCustomer?.deliveryLng ?? undefined,
        payment: {
          method: "razorpay",
          reference: event.payload?.payment?.entity?.id ?? null,
          status: "paid",
          paidAt: new Date(),
        },
      });

      await prisma.pendingOrder.update({
        where: { customerId },
        data: { confirmedOrderId: order.id, stage: "ORDER_PLACED" },
      });

      const [customer, cfg] = await Promise.all([
        prisma.customer.findUnique({ where: { id: customerId } }),
        prisma.restaurantConfig.findUnique({ where: { id: 1 } }),
      ]);
      const session = botSessionManager.getSession(restaurantId);
      if (customer && session) {
        const restaurantName = cfg?.restaurantName ?? "Restaurant";
        const fullOrder = { ...order, customer };
        try {
          await session.sendText(customer.phone, orderConfirmationMsg(fullOrder, restaurantName));
        } catch (e) {
          console.error("[Receipt Send] Customer receipt failed:", e);
        }
        const ownerNumbers = (cfg?.ownerNumbers ?? "").split(",").map((s: string) => s.trim()).filter(Boolean);
        const ownerMsg = ownerNewOrderMsg(fullOrder);
        for (const num of ownerNumbers) {
          session.sendText(num, ownerMsg).catch((e: any) =>
            console.error("[Owner Notify] Owner notify failed for num:", e)
          );
        }
      }

      await notifyAdminOfEvent("order_created", order);
      res.json({ ok: true });
    },
  );

  app.use(express.json());
  app.use(express.static(path.join(__dirname, "public")));

  app.get("/menu", (_req, res) => {
    res.sendFile(path.join(__dirname, "public", "menu.html"));
  });

  app.get("/public/api/menu/:restaurantId", asyncRoute(async (_req, res) => {
    const restaurant = await prisma.restaurantConfig.findUnique({
      where: { id: 1 },
      select: { id: true, restaurantName: true, restaurantCity: true, whatsappPhone: true },
    });
    if (!restaurant) {
      res.status(404).json({ error: "Restaurant not found" });
      return;
    }
    const categories = await getMenu();
    res.json({ restaurant, categories });
  }));

  app.post("/public/api/menu/order", asyncRoute(async (req, res) => {
    const phone = req.body.phone;
    const items = req.body.items;

    if (!phone || !Array.isArray(items) || items.length === 0) {
      res.status(400).json({ error: "Missing required fields" });
      return;
    }

    const customer = await getOrCreateCustomer(phone);

    await prisma.$transaction([
      prisma.message.deleteMany({ where: { customerId: customer.id } }),
      prisma.pendingOrder.deleteMany({ where: { customerId: customer.id } }),
    ]);

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
        const v = mi.variants.find((v) => v.id === l.variantId);
        if (v) { price = v.price; variantName = v.name; }
      }
      validLines.push({ menuItemId: mi.id, variantId: l.variantId, qty: l.qty });
      const label = variantName ? `${l.qty}x ${mi.name} (${variantName})` : `${l.qty}x ${mi.name}`;
      labels.push(`${label} ₹${price * l.qty}`);
      total += price * l.qty;
    }

    const CART_TTL_MS = 2 * 60 * 60 * 1000;
    const cartData = {
      lines: JSON.stringify(validLines),
      type: "delivery",
      expiresAt: new Date(Date.now() + CART_TTL_MS),
    };
    await prisma.pendingOrder.create({
      data: {
        customerId: customer.id,
        ...cartData,
      },
    });

    const session = botSessionManager.getSession(1);
    if (session) {
      const promptText = `I selected some items from the web menu: ${validLines.map(v => `${v.qty}x ${byId.get(v.menuItemId)?.name}`).join(", ")}`;
      await logMessage(customer.id, "user", promptText);

      // Same stage-aware summary as every other path. orderStagedTemplate ended
      // with "Tap Confirm Order to continue", duplicating the button directly
      // beneath it and repeating the pin-location hint after an address existed.
      const cart = await prisma.pendingOrder.findUnique({
        where: { customerId: customer.id },
        select: { stage: true },
      });
      const stagedMsg = cartSummaryText(labels, total, cart?.stage ?? "BUILDING_CART");
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

      await logMessage(customer.id, "assistant", stagedMsg);
    }

    res.json({ ok: true });
  }));

  app.get("/address", (_req, res) => {
    const htmlPath = path.join(__dirname, "public", "address.html");
    fs.readFile(htmlPath, "utf8", (err, content) => {
      if (err) {
        res.sendFile(htmlPath);
        return;
      }
      const apiKey = process.env.GOOGLE_MAPS_API_KEY || "";
      const injected = content.replace("/* GOOGLE_MAPS_KEY_PLACEHOLDER */", `window.GOOGLE_MAPS_API_KEY = "${apiKey}";`);
      res.setHeader("Content-Type", "text/html");
      res.send(injected);
    });
  });

  app.post("/public/api/customer/address", asyncRoute(async (req, res) => {
    const { phone, address, lat, lng } = req.body;
    if (!phone || !address) {
      res.status(400).json({ error: "Missing phone or address" });
      return;
    }

    const customer = await getOrCreateCustomer(phone);
    await prisma.customer.update({
      where: { id: customer.id },
      data: {
        address,
        ...(lat ? { deliveryLat: Number(lat) } : {}),
        ...(lng ? { deliveryLng: Number(lng) } : {}),
      },
    });

    const pending = await prisma.pendingOrder.findFirst({
      where: { customerId: customer.id, expiresAt: { gt: new Date() } },
    });

    if (pending) {
      await prisma.pendingOrder.update({
        where: { id: pending.id },
        data: { type: "delivery_awaiting_details" },
      });
    }

    // After the customer pins their location, ask for flat/door number and
    // landmark details before proceeding to billing.
    const session = botSessionManager.getSession(1);
    if (session) {
      await session.sendText(
        phone,
        `📍 *Location vachindi andi!*\n\nMee flat/door number, building name and landmark cheppandi.`,
      );
    }

    res.json({ ok: true, address });
  }));

  app.get("/webhook", (req, res) => {
    const mode = req.query["hub.mode"] ?? req.query.mode;
    const token = req.query["hub.verify_token"] ?? req.query.verify_token;
    const challenge = req.query["hub.challenge"] ?? req.query.challenge;

    if (mode && token === config.cloud.verifyToken) {
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  });

  app.post("/webhook", async (req, res) => {
    res.sendStatus(200);

    try {
      const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol || "https";
      const host = req.get("host");
      if (host) {
        botSessionManager.setRuntimeHost(proto, host);
      }

      const body = req.body;
      const entry = body?.entry?.[0]?.changes?.[0]?.value;
      const msg = entry?.messages?.[0];
      if (msg) {
        const phoneNumberId = entry?.metadata?.phone_number_id;
        if (phoneNumberId) {
          let text =
            msg.text?.body
            ?? msg.button?.payload
            ?? msg.button?.text
            ?? msg.interactive?.button_reply?.id
            ?? msg.interactive?.list_reply?.id
            ?? "";

          if (!text && msg.type === "audio" && msg.audio?.id) {
            try {
              const cfg = await prisma.restaurantConfig.findFirst({ where: { id: 1 } });
              const token = cfg?.cloudToken || config.cloud.token;
              const { buffer, mimeType } = await fetchMetaMedia(msg.audio.id, token);
              text = await transcribeAudio(buffer, mimeType);
            } catch (e) {
              console.error("[Voice] Transcription failed, falling back:", e);
              text = VOICE_NOTE_SENTINEL;
            }
          }

          if (!text && msg.type === "location" && msg.location) {
            const lat = msg.location.latitude;
            const lng = msg.location.longitude;
            const locAddr = msg.location.address || msg.location.name || `GPS Pin (${lat.toFixed(4)}, ${lng.toFixed(4)})`;

            try {
              const customer = await getOrCreateCustomer(msg.from);
              await prisma.customer.update({
                where: { id: customer.id },
                data: {
                  address: locAddr,
                  deliveryLat: Number(lat),
                  deliveryLng: Number(lng),
                },
              });

              const pending = await prisma.pendingOrder.findFirst({
                where: { customerId: customer.id, expiresAt: { gt: new Date() } },
              });

              if (pending) {
                await prisma.pendingOrder.update({
                  where: { id: pending.id },
                  data: { type: "delivery" },
                });
              }

              text = "confirm order";
            } catch (e) {
              console.error("[Location Webhook Error]", e);
              text = locAddr;
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

  app.get("/api/ping", (_req, res) => res.json({ ok: true }));
  app.post("/api/auth/login", loginHandler);
  app.post("/api/auth/logout", logoutHandler);
  app.post("/api/founder/auth/login", founderLoginHandler);
  app.post("/api/founder/auth/logout", founderLogoutHandler);

  const founder = express.Router();
  founder.use(founderMiddleware);

  founder.get("/auth/me", (_req, res) => res.json({ role: "founder" }));

  founder.get("/restaurants", async (_req, res) => {
    const restaurants = await prisma.restaurantConfig.findMany({
      orderBy: { id: "asc" },
    });
    res.json(restaurants);
  });

  founder.get("/restaurants/:id", async (_req, res) => {
    const cfg = await prisma.restaurantConfig.findUnique({ where: { id: 1 } });
    if (!cfg) { res.status(404).json({ error: "not found" }); return; }
    res.json(cfg);
  });

  founder.put("/restaurants/:id/config", async (req, res) => {
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
    const cfg = await prisma.restaurantConfig.update({ where: { id: 1 }, data });
    res.json(cfg);
  });

  founder.get("/restaurants/:id/prompt", async (_req, res) => {
    const prompt = await prisma.promptTemplate.findFirst({ where: { id: 1 } });
    res.json(prompt ?? {});
  });

  founder.put("/restaurants/:id/prompt", async (req, res) => {
    const { content } = req.body;
    if (typeof content !== "string") {
      res.status(400).json({ error: "content must be a string" });
      return;
    }
    try {
      const existing = await prisma.promptTemplate.findFirst({ where: { id: 1 } });
      const result = existing
        ? await prisma.promptTemplate.update({ where: { id: existing.id }, data: { content } })
        : await prisma.promptTemplate.create({ data: { content } });
      await notifyAdminOfEvent("config_updated", { restaurantId: 1 });
      res.json(result);
    } catch (e: any) {
      console.error("[founder] prompt save failed:", e);
      res.status(500).json({ error: e?.message ?? "save failed" });
    }
  });

  founder.get("/restaurants/:id/stats", async (_req, res) => {
    const [orderCount, customerCount, revenue] = await Promise.all([
      prisma.order.count(),
      prisma.customer.count(),
      prisma.payment.aggregate({ where: { status: "paid" }, _sum: { amount: true } }),
    ]);
    res.json({ orderCount, customerCount, revenue: revenue._sum.amount ?? 0 });
  });

  app.use("/api/founder", founder);

  const api = express.Router();
  api.use(authMiddleware);

  api.get("/auth/me", meHandler);

  api.get("/categories", async (_req, res) => {
    res.json(await prisma.category.findMany({
      orderBy: { sortOrder: "asc" },
    }));
  });

  api.post("/categories", async (req, res) => {
    const { name, sortOrder } = req.body;
    const category = await prisma.category.create({
      data: { name, sortOrder: sortOrder ?? 0 },
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
        res.status(409).json({ error: "Cannot delete category with items." });
      } else {
        res.status(500).json({ error: e?.message ?? "Delete failed" });
      }
    }
  });

  api.get("/menu", async (_req, res) => {
    res.json(await getMenu(1, { includeUnavailable: true }));
  });

  api.post("/items", async (req, res) => {
    const { name, description, price, categoryId, isVeg, spiceLevel, available, stockCount, pieceInfo, sortOrder, imageUrl } = req.body;
    const item = await prisma.menuItem.create({
      data: {
        name,
        description,
        price: Number(price),
        categoryId: Number(categoryId),
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
        res.status(409).json({ error: "Cannot delete item in existing orders." });
      } else {
        res.status(500).json({ error: e?.message ?? "Delete failed" });
      }
    }
  });

  api.get("/items/:id/variants", async (req, res) => {
    res.json(await prisma.menuItemVariant.findMany({
      where: { menuItemId: Number(req.params.id) },
      orderBy: { sortOrder: "asc" },
    }));
  });

  api.post("/items/:id/variants", async (req, res) => {
    const { name, price, available, sortOrder } = req.body;
    const variant = await prisma.menuItemVariant.create({
      data: {
        menuItemId: Number(req.params.id),
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

  api.get("/orders", async (req, res) => {
    res.json(await listOrders(req.restaurantId, req.query.status as string | undefined));
  });

  api.put("/orders/:id/status", async (req, res) => {
    const orderId = Number(req.params.id);
    const order = await setOrderStatus(orderId, req.body.status);
    res.json(order);

    const { status } = req.body;
    if (["preparing", "ready", "delivered", "cancelled"].includes(status)) {
      try {
        const cfg = await prisma.restaurantConfig.findUnique({ where: { id: 1 } });
        const msg = orderStatusMsg(order, status, cfg?.restaurantName ?? "");
        if (msg) {
          const session = botSessionManager.getSession(1);
          if (session) await session.sendText(order.customer.phone, msg);
        }
      } catch (e) {
        console.error("[Status Notify] Failed:", e);
      }
    }

    // Cooking done → book a courier, unless one was already called manually from
    // the "Call Rider" button while the food was still cooking. A rider takes
    // roughly ten minutes to reach the kitchen, so calling one earlier is the
    // better move; this is the safety net for when nobody did.
    if (status === "ready" && order.type === "delivery") {
      try {
        const result: any = await DeliveryManager.dispatchOrder(orderId, "borzo");
        console.log(
          result?.alreadyDispatched
            ? `[Auto-Dispatch] Order #${orderId} already had a courier booked.`
            : `[Auto-Dispatch] Courier booked for order #${orderId}.`,
        );
      } catch (e: any) {
        // Hot food and no courier — the owner has to know, because nothing else
        // in the system will chase it.
        console.error(`[Auto-Dispatch Failed] Order #${orderId}:`, e?.message ?? e);
        try {
          const cfg = await prisma.restaurantConfig.findUnique({ where: { id: 1 } });
          const owners = (cfg?.ownerNumbers ?? "").split(",").map((s) => s.trim()).filter(Boolean);
          const session = botSessionManager.getSession(1);
          const text = `⚠️ *Rider booking failed — Order #${orderId}*\n\n${e?.message ?? "Unknown error"}\n\nFood is ready but no courier is booked. Use *Call Rider* in the dashboard to retry.`;
          for (const num of owners) {
            if (session) await session.sendText(num, text);
          }
        } catch (notifyErr) {
          console.error("[Auto-Dispatch] Owner alert failed:", notifyErr);
        }
      }
    }
  });

  api.post("/orders/:id/dispatch", async (req, res) => {
    const orderId = Number(req.params.id);
    const providerCode = req.body.providerCode || "borzo";
    try {
      const result = await DeliveryManager.dispatchOrder(orderId, providerCode);
      res.json(result);
    } catch (e: any) {
      console.error("[Manual Dispatch Failed]", e);
      res.status(500).json({ error: e?.message ?? "Dispatch failed" });
    }
  });

  api.put("/orders/:id/payment", async (req, res) => {
    const { status } = req.body;
    res.json(await setPaymentStatus(Number(req.params.id), status));
  });

  api.get("/payments", asyncRoute(async (_req, res) => {
    const payments = await prisma.payment.findMany({
      orderBy: { createdAt: "desc" },
      include: { order: { include: { customer: { select: { phone: true, name: true } } } } },
      take: 200,
    });
    res.json(payments);
  }));

  api.put("/bot/pause", async (req, res) => {
    const { paused, message } = req.body;
    const cfg = await prisma.restaurantConfig.update({
      where: { id: 1 },
      data: {
        botPaused: !!paused,
        ...(message !== undefined ? { pauseMessage: message || null } : {}),
      },
    });
    res.json({ botPaused: cfg.botPaused, pauseMessage: cfg.pauseMessage });
  });

  api.get("/config", async (_req, res) => {
    res.json(await prisma.restaurantConfig.findUnique({ where: { id: 1 } }) ?? {});
  });

  api.put("/config", async (req, res) => {
    const {
      restaurantName, restaurantCity, personaName, ownerNumbers,
      dashboardPassword, requiresPaymentBeforeOrder, upiId, paymentMethods,
      razorpayEnabled, razorpayKeyId, razorpayKeySecret, razorpayWebhookSecret,
      botPaused, pauseMessage, whatsappPhone,
      cloudPhoneNumberId, cloudToken,
    } = req.body;

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

    const updated = await prisma.restaurantConfig.update({ where: { id: 1 }, data });
    await notifyAdminOfEvent("config_updated", { restaurantId: 1 });
    res.json(updated);
  });

  api.get("/prompt", async (_req, res) => {
    res.json(await prisma.promptTemplate.findFirst({ where: { id: 1 } }) ?? {});
  });

  api.put("/prompt", async (req, res) => {
    const { content } = req.body;
    const existing = await prisma.promptTemplate.findFirst({ where: { id: 1 } });
    const result = existing
      ? await prisma.promptTemplate.update({ where: { id: existing.id }, data: { content } })
      : await prisma.promptTemplate.create({ data: { content } });
    await notifyAdminOfEvent("config_updated", { restaurantId: 1 });
    res.json(result);
  });

  api.get("/tools", async (_req, res) => {
    res.json(await prisma.toolDefinition.findMany({
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
    await notifyAdminOfEvent("config_updated", { restaurantId: 1 });
    res.json(result);
  });

  api.get("/customers", async (_req, res) => {
    res.json(await prisma.customer.findMany({
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { orders: true } } },
      take: 200,
    }));
  });

  api.get("/customers/:id/messages", async (req, res) => {
    res.json(await prisma.message.findMany({
      where: { customerId: Number(req.params.id) },
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

  api.post("/customers/:id/message", asyncRoute(async (req, res) => {
    const id = Number(req.params.id);
    const text = String(req.body?.text ?? "").trim();
    if (!text) { res.status(400).json({ error: "text is required" }); return; }

    const customer = await prisma.customer.findUnique({ where: { id } });
    if (!customer) { res.status(404).json({ error: "customer not found" }); return; }

    const session = botSessionManager.getSession(req.restaurantId);
    if (!session) { res.status(503).json({ error: "bot session not running" }); return; }

    await session.sendText(customer.phone, text);
    const msg = await logMessage(customer.id, "assistant", text);
    res.json(msg);
  }));

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

  api.get("/activity", async (_req, res) => {
    res.json(await prisma.activityLog.findMany({
      orderBy: { createdAt: "desc" },
      take: 100,
    }));
  });

  api.get("/events", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
    const onEvent = (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    eventBus.on("event", onEvent);
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 25_000);
    req.on("close", () => { eventBus.off("event", onEvent); clearInterval(heartbeat); });
  });

  api.get("/qr", (_req, res) => {
    res.json({
      connected: true,
      provider: "cloud",
    });
  });

  app.use("/api", api);

  return app;
}
