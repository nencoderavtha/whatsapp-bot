import { createHmac, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Request, type Response, type NextFunction } from "express";
import cookieParser from "cookie-parser";

import { config } from "../config.js";
import { prisma } from "../db.js";
import { botSessionManager } from "../whatsapp/session-manager.js";
import { getMenu } from "../services/menu.js";
import { createOrder, getOrder, listOrders, rejectOrder, setOrderStatus, setPaymentStatus } from "../services/order.js";
import { getOrdersAnalytics, InvalidRangeError } from "../services/analytics.js";
import {
  orderConfirmationMsg,
  orderStatusMsg,
  ownerNewOrderMsg,
  deliveryStatusMsg,
  refundStatusMsg,
} from "../services/notifications.js";
import {
  authMiddleware,
  founderMiddleware,
  loginHandler,
  logoutHandler,
  founderLoginHandler,
  founderLogoutHandler,
  meHandler,
  requireOwner,
} from "./auth.js";
import { getOrCreateCustomer, logMessage } from "../services/customer.js";
import { cartSummaryText, renderPaymentFailed } from "../whatsapp/renderers.js";
import { send } from "../whatsapp/stage.js";
import { DEFAULT_RESTAURANT_ID, resolveRestaurantId } from "../tenancy.js";
import { notifyAdminOfEvent, eventBus } from "../services/events.js";
import { logActivity } from "../services/activity.js";
import { allergyLines } from "../services/allergy.js";
import { createPaymentLink, verifyWebhookSignature } from "../services/razorpay.js";
import { transcribeAudio } from "../services/transcription.js";
import { fetchMetaMedia } from "../whatsapp/media.js";
import { VOICE_NOTE_SENTINEL, type InboundMessage } from "../whatsapp/adapter.js";
import { DeliveryManager } from "../services/delivery/delivery-manager.js";
import { getExactServiceDeliveryFee } from "../services/delivery-fee.js";
import { orderStagedTemplate } from "../ai/templates.js";
import { logger } from '../services/logger.js';
import { ShiprocketDeliveryService } from "../services/delivery/shiprocket.js";
import { createExpressRateLimiter } from "../services/rate-limiter.js";
import { inspectContentSafety } from "../services/content-safety.js";
import { redis } from "../services/redis.js";
import { notify } from "../services/notification-center.js";

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

      // A link that is cancelled or expires leaves the cart at AWAITING_PAYMENT,
      // where it refuses edits and offers no way to pay — the customer is stuck
      // holding a dead link until the two-hour TTL quietly bins their order.
      const isFailure =
        event.event === "payment_link.cancelled" || event.event === "payment_link.expired";

      if (event.event !== "payment_link.paid" && !isFailure) {
        res.json({ ok: true });
        return;
      }

      const notes = event.payload?.payment_link?.entity?.notes ?? {};
      const restaurantId = resolveRestaurantId(notes.restaurantId);
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

      if (isFailure) {
        // Issuing a new link cancels the previous one, which fires this same
        // event for the superseded link. Acting on that would mark a live
        // payment failed the instant a fresh link was sent, so only the link the
        // cart is actually waiting on counts.
        const linkId = event.payload?.payment_link?.entity?.id;
        const isCurrentLink = Boolean(linkId) && linkId === pendingRow.razorpayLinkId;

        if (isCurrentLink && pendingRow.stage === "AWAITING_PAYMENT") {
          await prisma.pendingOrder.update({
            where: { customerId },
            data: { stage: "PAYMENT_FAILED", razorpayLinkId: null, razorpayLinkUrl: null },
          });

          const failedCustomer = await prisma.customer.findUnique({ where: { id: customerId } });
          const session = botSessionManager.getSession(restaurantId);
          if (failedCustomer && session) {
            try {
              await send(session, failedCustomer.phone, renderPaymentFailed());
            } catch (e) {
              logger.error("[Razorpay] Could not tell the customer payment failed:", e);
            }
          }

          // The customer is told; the owner/emergency contacts were not — a
          // stuck cart with a dead payment link is exactly the kind of thing
          // staff need to know about right away.
          void notify({
            type: "payment_failed",
            severity: "critical",
            title: "Payment link failed",
            message: `Payment link ${event.event === "payment_link.expired" ? "expired" : "was cancelled"} for ${failedCustomer?.phone ?? `customer #${customerId}`}. Their cart is stuck awaiting payment.`,
            customerId,
            restaurantId,
          }).catch((e) => logger.error("[notify] payment_failed failed:", e));
        }

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
        prisma.restaurantConfig.findUnique({ where: { id: DEFAULT_RESTAURANT_ID } }),
      ]);
      const session = botSessionManager.getSession(restaurantId);
      if (customer && session) {
        const restaurantName = cfg?.restaurantName ?? "Restaurant";
        const fullOrder = { ...order, customer };
        try {
          await session.sendText(customer.phone, orderConfirmationMsg(fullOrder, restaurantName));
        } catch (e) {
          logger.error("[Receipt Send] Customer receipt failed:", e);
        }
        const ownerNumbers = (cfg?.ownerNumbers ?? "").split(",").map((s: string) => s.trim()).filter(Boolean);
        const ownerMsg = ownerNewOrderMsg(fullOrder);
        for (const num of ownerNumbers) {
          session.sendText(num, ownerMsg).catch((e: any) =>
            logger.error("[Owner Notify] Owner notify failed for num:", e)
          );
        }
      }

      await notifyAdminOfEvent("order_created", order);
      res.json({ ok: true });
    },
  );

  // Default 100kb is fine for everything except POST /api/upload/image, whose
  // base64-encoded data: URI body can run to ~6.7MB for a 5MB image — bump
  // the global limit rather than special-casing one route's body parser.
  app.use(express.json({ limit: "10mb" }));
  app.use(express.static(path.join(__dirname, "public")));

  app.get("/menu", (_req, res) => {
    res.sendFile(path.join(__dirname, "public", "menu.html"));
  });

  app.get("/public/api/menu/:restaurantId", asyncRoute(async (_req, res) => {
    const restaurant = await prisma.restaurantConfig.findUnique({
      where: { id: DEFAULT_RESTAURANT_ID },
      select: { id: true, restaurantName: true, restaurantCity: true, whatsappPhone: true, brandColor: true, welcomeLogoUrl: true },
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

    const session = botSessionManager.getSession(DEFAULT_RESTAURANT_ID);
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
    }

    res.json({ ok: true });
  }));

  app.get("/test-delivery", (_req, res) => {
    const htmlPath = path.join(__dirname, "public", "test-delivery.html");
    res.sendFile(htmlPath);
  });

  app.post("/public/api/test-delivery/quote", asyncRoute(async (req, res) => {
    const { pickupPincode, pickupAddress, deliveryAddress, deliveryPincode, deliveryPhone, deliveryLat, deliveryLng, pickupLat, pickupLng, pickupPhone } = req.body;
    const results: Record<string, any> = { ok: true };

    const pickup = pickupPincode && !isNaN(Number(pickupPincode)) ? Number(pickupPincode) : 500081;
    const drop = deliveryPincode && !isNaN(Number(deliveryPincode)) ? Number(deliveryPincode) : 500081;

    const restaurant = await prisma.restaurantConfig.findFirst({ where: { id: 1 } });
    const pLat = pickupLat ? Number(pickupLat) : (restaurant?.restaurantLat ? Number(restaurant.restaurantLat) : undefined);
    const pLng = pickupLng ? Number(pickupLng) : (restaurant?.restaurantLng ? Number(restaurant.restaurantLng) : undefined);

    const dLat = deliveryLat ? Number(deliveryLat) : undefined;
    const dLng = deliveryLng ? Number(deliveryLng) : undefined;

    // Shiprocket Quick Quote Query
    const shiprocket = new ShiprocketDeliveryService();
    try {
      const quote = await shiprocket.getQuote({
        pickupPincode: pickup,
        deliveryPincode: drop,
        weightKg: 0.5,
        pickupLat: pLat,
        pickupLng: pLng,
        deliveryLat: dLat,
        deliveryLng: dLng,
      });
      results.shiprocket = quote;
    } catch (err: any) {
      results.shiprocket = { available: false, error: err?.message ?? err };
    }

    res.json(results);
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
        // "delivery_awaiting_details" is not a type checkout or order creation
        // recognises — both expect "delivery" — so it left the cart in a state
        // nothing downstream could bill.
        data: { type: "delivery", stage: "ADDRESS_SELECTED" },
      });
    }

    // The map form already requires flat/door number, building and landmark and
    // sends them composed into `address`. Asking for them again over WhatsApp
    // made the customer type everything twice.
    let subtotal = 0;
    const labels: string[] = [];
    if (pending && pending.lines) {
      let lines: any[] = [];
      try { lines = JSON.parse(pending.lines); } catch {}
      const menuItems = await prisma.menuItem.findMany({
        where: { id: { in: lines.map((l: any) => l.menuItemId) } },
        include: { variants: true },
      });
      const byId = new Map(menuItems.map((m) => [m.id, m]));
      for (const l of lines) {
        const mi = byId.get(l.menuItemId);
        if (!mi) continue;
        let p = mi.price;
        let vName: string | undefined;
        if (l.variantId) {
          const v = mi.variants.find((v: any) => v.id === l.variantId);
          if (v) { p = v.price; vName = v.name; }
        }
        const label = vName ? `${l.qty}x ${mi.name} (${vName})` : `${l.qty}x ${mi.name}`;
        labels.push(`${label} ₹${p * l.qty}`);
        subtotal += p * l.qty;
      }
    }
    const session = botSessionManager.getSession(DEFAULT_RESTAURANT_ID);
    let deliveryFee = 45;
    try {
      deliveryFee = await getExactServiceDeliveryFee(address);
    } catch (err) {
      if (session) {
        await session.sendInteractiveButtons(
          phone,
          `❌ *Delivery Location Not Serviceable*\n\nSorry, this delivery location is currently not serviceable by our delivery partners. Please pick another location or pin a location nearby!`,
          [
            { id: "pin_new_location_btn", title: "🗺️ Pin New Location" },
            { id: "use_saved_address_btn", title: "📍 Select Address" }
          ],
          "📦 Delivery Location",
        );
      }
      res.json({ ok: false, error: "Delivery location not serviceable" });
      return;
    }

    const botConfig = await prisma.restaurantConfig.findUnique({ where: { id: DEFAULT_RESTAURANT_ID } });
    const grandTotal = subtotal + deliveryFee;
    const summaryMsg = orderStagedTemplate(labels, subtotal, "delivery", pending?.note ?? undefined, deliveryFee, address);

    let payUrl: string | null = null;
    if (botConfig?.razorpayEnabled && botConfig.razorpayKeyId && botConfig.razorpayKeySecret) {
      const payRes = await createPaymentLink({
        restaurantId: DEFAULT_RESTAURANT_ID,
        customerId: customer.id,
        amount: grandTotal,
        customerPhone: phone,
        restaurantName: botConfig.restaurantName,
      });
      if (payRes?.url) payUrl = payRes.url;
    }

    if (session) {
      if (payUrl) {
        await session.sendInteractiveCtaUrl(
          phone,
          summaryMsg,
          `💳 Confirm & Pay ₹${grandTotal}`,
          payUrl,
        );
      } else {
        await session.sendInteractiveButtons(
          phone,
          summaryMsg,
          [
            { id: "confirm_order_btn", title: "✅ Confirm & Pay" },
            { id: "add_more_items_btn", title: "➕ Add More Items" },
          ],
          "🛍️ Order Summary",
        );
      }
    }

    res.json({ ok: true, address });
  }));

  const webhookLimiter = createExpressRateLimiter({ windowMs: 60 * 1000, max: 120, message: "Too many webhook requests" });
  const loginLimiter = createExpressRateLimiter({ windowMs: 60 * 1000, max: 10, message: "Too many login attempts. Please wait 1 minute." });
  const apiLimiter = createExpressRateLimiter({ windowMs: 15 * 60 * 1000, max: 300, message: "API rate limit exceeded." });

  app.get("/healthz", async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      let redisStatus = "disabled";
      if (redis) {
        try {
          await redis.ping();
          redisStatus = "healthy";
        } catch {
          redisStatus = "degraded";
        }
      }
      res.status(200).json({
        status: "ok",
        uptimeSeconds: Math.floor(process.uptime()),
        memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
        database: "healthy",
        redis: redisStatus,
      });
    } catch (err: any) {
      logger.error("[Health Check Failed]:", err);
      res.status(503).json({
        status: "error",
        error: "Database connection failed",
        details: err?.message ?? String(err),
      });
    }
  });

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

  app.post("/webhook", webhookLimiter, async (req, res) => {
    // Meta HMAC SHA256 Signature Verification (if WHATSAPP_APP_SECRET is set)
    const appSecret = process.env.WHATSAPP_APP_SECRET;
    const signature = req.headers["x-hub-signature-256"] as string | undefined;
    if (appSecret && signature) {
      const hmac = createHmac("sha256", appSecret);
      const expected = "sha256=" + hmac.update(JSON.stringify(req.body)).digest("hex");
      if (signature !== expected) {
        logger.warn("⚠️ [Meta Webhook] Signature mismatch — unauthorized request rejected.");
        res.status(401).json({ error: "Invalid payload signature" });
        return;
      }
    }

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
              const cfg = await prisma.restaurantConfig.findFirst({ where: { id: DEFAULT_RESTAURANT_ID } });
              const token = cfg?.cloudToken || config.cloud.token;
              const { buffer, mimeType } = await fetchMetaMedia(msg.audio.id, token);
              text = await transcribeAudio(buffer, mimeType);
            } catch (e) {
              logger.error("[Voice] Transcription failed, falling back:", e);
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
              logger.error("[Location Webhook Error]", e);
              text = locAddr;
            }
          }

          if (text.trim()) {
            const inbound: InboundMessage = {
              // The wamid Meta sends with every inbound message. markRead needs
              // it to send the read receipt, and the session manager guards on
              // `msg.id` being present — so dropping this field does not fail
              // loudly, it just silently stops every blue tick.
              id: msg.id as string | undefined,
              phone: msg.from as string,
              text: text.trim(),
              name: entry?.contacts?.[0]?.profile?.name as string | undefined,
            };
            await botSessionManager.routeCloudMessage(phoneNumberId, inbound);
          }
        }
      }
    } catch (e) {
      logger.error("[Webhook]", e);
    }
  });

  app.post("/api/webhooks/delivery/quick", asyncRoute(async (req, res) => {
    const apiKey = (req.headers["x-api-key"] || req.headers["x-shiprocket-token"] || req.headers["x-api-token"] || req.headers["authorization"] || req.query.token) as string | undefined;
    const expectedToken = process.env.DELIVERY_WEBHOOK_TOKEN || "godavari_ruchulu_secret_token";
    
    console.log(`[Shiprocket Webhook Auth] Received Token: "${apiKey}", Expected: "${expectedToken}"`);
    console.log(`[Shiprocket Webhook Headers] Headers:`, JSON.stringify(req.headers));

    if (apiKey && apiKey !== expectedToken) {
      logger.warn("[Shiprocket Webhook] Unauthorized request. Header token did not match.");
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const payload = req.body;
    logger.info("[Shiprocket Webhook] Received status update:", JSON.stringify(payload, null, 2));

    const trackingData = payload.tracking_data || payload;
    const { shipment_id, awb, order_id, channel_order_id, sr_order_id, shipment_status, current_status } = trackingData;

    const targetStatus = shipment_status || current_status;
    const lookupId = shipment_id || awb || sr_order_id;

    if (!lookupId && !order_id && !channel_order_id && !targetStatus) {
      res.status(400).json({ error: "Missing tracking identifier or status" });
      return;
    }

    let internalStatus = "SEARCHING_RIDER";
    const statusUpper = String(targetStatus || "").toUpperCase();

    if (["DELIVERED"].includes(statusUpper)) {
      internalStatus = "DELIVERED";
    } else if (["OUT FOR DELIVERY"].includes(statusUpper)) {
      internalStatus = "IN_TRANSIT";
    } else if (["PICKED UP", "IN TRANSIT"].includes(statusUpper)) {
      internalStatus = "PICKED_UP";
    } else if (["AWB GENERATED", "PICKUP SCHEDULED", "OUT FOR PICKUP", "SHIPPED", "RIDER ASSIGNED", "ASSIGNED"].includes(statusUpper)) {
      internalStatus = "COURIER_ASSIGNED";
    } else if (["CANCELLED", "CANCELED"].includes(statusUpper)) {
      internalStatus = "CANCELLED";
    }

    // Extract raw numeric order ID (e.g. "11_7302" -> 11)
    const rawIdStr = String(channel_order_id || order_id || "").split("_")[0];
    const orderIdNum = !isNaN(Number(rawIdStr)) && Number(rawIdStr) > 0 ? Number(rawIdStr) : -1;

    const dispatch = await prisma.deliveryDispatch.findFirst({
      where: {
        OR: [
          ...(lookupId ? [
            { externalDeliveryId: `SR-${lookupId}` },
            { externalDeliveryId: String(lookupId) },
            { waybillNumber: String(lookupId) }
          ] : []),
          ...(order_id ? [
            { externalDeliveryId: `SR-${order_id}` },
            { externalDeliveryId: String(order_id) }
          ] : []),
          ...(orderIdNum > 0 ? [{ orderId: orderIdNum }] : [])
        ]
      },
      include: { order: { include: { customer: true } } }
    });

    if (!dispatch) {
      logger.warn(`[Shiprocket Webhook] No matching dispatch found for lookup ID ${lookupId} / order ID ${order_id}`);
      res.status(200).json({ ok: false, message: "No matching order found" });
      return;
    }

    const riderName = trackingData.courier_name || trackingData.rider_name || null;
    const riderPhone = trackingData.courier_phone || trackingData.rider_phone || null;
    const vehicleNumber = trackingData.rider_vehicle || null;

    await prisma.deliveryDispatch.update({
      where: { id: dispatch.id },
      data: {
        status: internalStatus,
        ...(riderName ? { riderName } : {}),
        ...(riderPhone ? { riderPhone } : {}),
        ...(vehicleNumber ? { riderVehicleNumber: vehicleNumber } : {})
      }
    });

    if (internalStatus === "DELIVERED") {
      await setOrderStatus(dispatch.orderId, "delivered");
    }

    if (internalStatus === "CANCELLED") {
      // deliveryStatusMsg has no template for CANCELLED, so the customer gets
      // no message here today — but staff still need to know a delivery died
      // in flight so they can follow up (redeliver, refund, call the customer).
      void notify({
        type: "delivery_failed",
        severity: "critical",
        title: `Delivery cancelled for order #${dispatch.orderId}`,
        message: `Shiprocket reported the delivery for order #${dispatch.orderId} as ${statusUpper}. Customer: ${dispatch.order?.customer?.phone ?? "unknown"}.`,
        orderId: dispatch.orderId,
        customerId: dispatch.order?.customer?.id,
      }).catch((e) => logger.error("[notify] delivery_failed failed:", e));
    }

    const session = botSessionManager.getSession(DEFAULT_RESTAURANT_ID);
    if (session) {
      const cfg = await prisma.restaurantConfig.findUnique({ where: { id: DEFAULT_RESTAURANT_ID } });
      const trackingUrl = dispatch.externalDeliveryId ? `https://shiprocket.co/tracking/${dispatch.externalDeliveryId.replace("SR-", "")}` : null;
      const notifMsg = deliveryStatusMsg(
        dispatch.orderId,
        internalStatus,
        riderName,
        riderPhone,
        trackingUrl,
        cfg?.restaurantName ?? "Godavari Ruchulu"
      );

      if (notifMsg) {
        await session.sendText(dispatch.order.customer.phone, notifMsg);
      }
    }

    res.status(200).json({ ok: true });
  }));

  app.get("/api/ping", (_req, res) => res.json({ ok: true }));
  app.post("/api/auth/login", loginLimiter, loginHandler);
  app.post("/api/auth/logout", logoutHandler);
  app.post("/api/founder/auth/login", loginLimiter, founderLoginHandler);
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
    const cfg = await prisma.restaurantConfig.findUnique({ where: { id: DEFAULT_RESTAURANT_ID } });
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
    const cfg = await prisma.restaurantConfig.update({ where: { id: DEFAULT_RESTAURANT_ID }, data });
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
      await notifyAdminOfEvent("config_updated", { restaurantId: DEFAULT_RESTAURANT_ID });
      res.json(result);
    } catch (e: any) {
      logger.error("[founder] prompt save failed:", e);
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

  api.post("/categories", requireOwner, async (req, res) => {
    const { name, sortOrder } = req.body;
    const category = await prisma.category.create({
      data: { name, sortOrder: sortOrder ?? 0 },
    });
    await notifyAdminOfEvent("menu_updated", { type: "category_created", category });
    res.json(category);
  });

  api.delete("/categories/:id", requireOwner, async (req, res) => {
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

  api.post("/items", requireOwner, async (req, res) => {
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

  api.put("/items/:id", requireOwner, async (req, res) => {
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

  // Open to both roles — lets an employee toggle availability without full item-edit rights.
  api.put("/items/:id/availability", async (req, res) => {
    const id = Number(req.params.id);
    const { available } = req.body;
    const item = await prisma.menuItem.update({ where: { id }, data: { available: !!available } });
    await notifyAdminOfEvent("menu_updated", { type: "item_updated", item });
    res.json(item);
  });

  api.delete("/items/:id", requireOwner, async (req, res) => {
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

  api.post("/items/:id/variants", requireOwner, async (req, res) => {
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

  api.put("/variants/:id", requireOwner, async (req, res) => {
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

  api.delete("/variants/:id", requireOwner, async (req, res) => {
    const id = Number(req.params.id);
    await prisma.menuItemVariant.delete({ where: { id } });
    await notifyAdminOfEvent("menu_updated", { type: "variant_deleted", id });
    res.json({ ok: true });
  });

  // ── Image upload (dish photos) ───────────────────────────────────────────
  // Owner-only. Body: { dataUrl: "data:image/<jpeg|png|webp>;base64,<...>" }.
  // Writes the decoded bytes under public/dish-images/ (already served
  // statically via express.static above) and returns its public URL.
  api.post("/upload/image", requireOwner, async (req, res) => {
    try {
      const { dataUrl } = req.body as { dataUrl?: string };
      const match = typeof dataUrl === "string"
        ? dataUrl.match(/^data:image\/(jpeg|png|webp);base64,(.+)$/)
        : null;
      if (!match) {
        res.status(400).json({ error: "dataUrl must be a base64 image/jpeg, image/png, or image/webp data URI" });
        return;
      }
      const [, mimeSubtype, base64Data] = match;
      const buffer = Buffer.from(base64Data, "base64");
      const MAX_BYTES = 5 * 1024 * 1024;
      if (buffer.length > MAX_BYTES) {
        res.status(413).json({ error: "Image exceeds 5MB limit" });
        return;
      }
      const ext = mimeSubtype === "jpeg" ? "jpg" : mimeSubtype;
      const filename = `${randomUUID()}.${ext}`;
      const destDir = path.join(__dirname, "public", "dish-images");
      fs.mkdirSync(destDir, { recursive: true });
      fs.writeFileSync(path.join(destDir, filename), buffer);
      res.json({ url: `/dish-images/${filename}` });
    } catch (e: any) {
      logger.error("[Upload Image] Failed:", e);
      res.status(400).json({ error: e?.message ?? "Invalid image payload" });
    }
  });

  api.get("/orders", async (req, res) => {
    res.json(await listOrders(req.restaurantId, {
      status: req.query.status as string | undefined,
      search: req.query.search as string | undefined,
      dateFilter: req.query.dateFilter as "today" | undefined,
      sort: req.query.sort as "newest" | "oldest" | "highest" | "lowest" | undefined,
    }));
  });

  api.get("/analytics/orders", requireOwner, asyncRoute(async (req, res) => {
    try {
      res.json(await getOrdersAnalytics({
        range: req.query.range as string | undefined,
        from: req.query.from as string | undefined,
        to: req.query.to as string | undefined,
      }));
    } catch (e) {
      if (e instanceof InvalidRangeError) { res.status(400).json({ error: e.message }); return; }
      throw e;
    }
  }));

  api.get("/orders/:id", asyncRoute(async (req, res) => {
    const order = await getOrder(Number(req.params.id));
    if (!order) { res.status(404).json({ error: "order not found" }); return; }
    res.json(order);
  }));

  api.post("/orders/:id/reject", asyncRoute(async (req, res) => {
    const orderId = Number(req.params.id);
    const reason = req.body?.reason;
    if (!reason || typeof reason !== "string" || !reason.trim()) {
      res.status(400).json({ error: "reason is required" });
      return;
    }

    const order = await rejectOrder(orderId, reason.trim());
    res.json(order);

    try {
      const cfg = await prisma.restaurantConfig.findUnique({ where: { id: DEFAULT_RESTAURANT_ID } });
      const restaurantName = cfg?.restaurantName ?? "";
      const session = botSessionManager.getSession(DEFAULT_RESTAURANT_ID);
      if (session) {
        const msg = orderStatusMsg(order, "rejected", restaurantName);
        if (msg) await session.sendText(order.customer.phone, msg);
        if (order.refundStatus === "success" || order.refundStatus === "failed") {
          const refundMsg = refundStatusMsg(order);
          if (refundMsg) await session.sendText(order.customer.phone, refundMsg);
        }
      }
    } catch (e) {
      logger.error("[Reject Notify] Failed:", e);
    }
  }));

  api.put("/orders/:id/status", async (req, res) => {
    const orderId = Number(req.params.id);
    const order = await setOrderStatus(orderId, req.body.status);
    res.json(order);

    const { status } = req.body;
    if (["preparing", "ready", "delivered", "cancelled"].includes(status)) {
      try {
        const cfg = await prisma.restaurantConfig.findUnique({ where: { id: DEFAULT_RESTAURANT_ID } });
        const msg = orderStatusMsg(order, status, cfg?.restaurantName ?? "");
        if (msg) {
          const session = botSessionManager.getSession(DEFAULT_RESTAURANT_ID);
          if (session) await session.sendText(order.customer.phone, msg);
        }
      } catch (e) {
        logger.error("[Status Notify] Failed:", e);
      }
    }

    // Cooking done → book a courier, unless one was already called manually from
    // the "Call Rider" button while the food was still cooking. A rider takes
    // roughly ten minutes to reach the kitchen, so calling one earlier is the
    // better move; this is the safety net for when nobody did.
    if (status === "ready" && order.type === "delivery") {
      try {
        const result: any = await DeliveryManager.dispatchOrder(orderId, "shiprocket");
        logger.info(
          result?.alreadyDispatched
            ? `[Auto-Dispatch] Order #${orderId} already had a courier booked.`
            : `[Auto-Dispatch] Courier booked for order #${orderId}.`,
        );
      } catch (e: any) {
        // Hot food and no courier — the owner has to know, because nothing else
        // in the system will chase it.
        logger.error(`[Auto-Dispatch Failed] Order #${orderId}:`, e?.message ?? e);
        try {
          const cfg = await prisma.restaurantConfig.findUnique({ where: { id: DEFAULT_RESTAURANT_ID } });
          const owners = (cfg?.ownerNumbers ?? "").split(",").map((s) => s.trim()).filter(Boolean);
          const session = botSessionManager.getSession(DEFAULT_RESTAURANT_ID);
          const text = `⚠️ *Rider booking failed — Order #${orderId}*\n\n${e?.message ?? "Unknown error"}\n\nFood is ready but no courier is booked. Use *Call Rider* in the dashboard to retry.`;
          for (const num of owners) {
            if (session) await session.sendText(num, text);
          }
        } catch (notifyErr) {
          logger.error("[Auto-Dispatch] Owner alert failed:", notifyErr);
        }
      }
    }
  });

  api.post("/orders/:id/dispatch", async (req, res) => {
    const orderId = Number(req.params.id);
    const providerCode = req.body.providerCode || "shadowfax";
    try {
      const result = await DeliveryManager.dispatchOrder(orderId, providerCode);
      res.json(result);
    } catch (e: any) {
      logger.error("[Manual Dispatch Failed]", e);
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

  api.put("/bot/pause", requireOwner, async (req, res) => {
    const { paused, message } = req.body;
    const cfg = await prisma.restaurantConfig.update({
      where: { id: DEFAULT_RESTAURANT_ID },
      data: {
        botPaused: !!paused,
        ...(message !== undefined ? { pauseMessage: message || null } : {}),
      },
    });
    res.json({ botPaused: cfg.botPaused, pauseMessage: cfg.pauseMessage });
  });

  api.get("/config", async (_req, res) => {
    res.json(await prisma.restaurantConfig.findUnique({ where: { id: DEFAULT_RESTAURANT_ID } }) ?? {});
  });

  api.put("/config", requireOwner, async (req, res) => {
    const {
      restaurantName, restaurantCity, personaName, ownerNumbers,
      dashboardPassword, employeePassword, requiresPaymentBeforeOrder, upiId, paymentMethods,
      razorpayEnabled, razorpayKeyId, razorpayKeySecret, razorpayWebhookSecret,
      botPaused, pauseMessage, whatsappPhone,
      cloudPhoneNumberId, cloudToken,
      welcomeLogoUrl, welcomeTagline, openingHoursText, brandColor,
      emergencyContacts, notificationsEnabled, notificationChannels, criticalOnlyMode,
    } = req.body;

    const data: Record<string, unknown> = {};
    if (restaurantName !== undefined) data.restaurantName = restaurantName;
    if (restaurantCity !== undefined) data.restaurantCity = restaurantCity;
    if (personaName !== undefined) data.personaName = personaName || null;
    if (ownerNumbers !== undefined) data.ownerNumbers = ownerNumbers;
    if (dashboardPassword !== undefined) data.dashboardPassword = dashboardPassword;
    // Employee dashboard login — a second shared credential per restaurant,
    // parallel to dashboardPassword. Empty string clears it (disables employee login).
    if (employeePassword !== undefined) data.employeePassword = employeePassword || null;
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
    if (welcomeLogoUrl !== undefined) data.welcomeLogoUrl = welcomeLogoUrl || null;
    if (welcomeTagline !== undefined) data.welcomeTagline = welcomeTagline || null;
    if (openingHoursText !== undefined) data.openingHoursText = openingHoursText || null;
    if (brandColor !== undefined) data.brandColor = brandColor || null;
    // Notification center settings — owner-only, mirrors ownerNumbers exactly.
    if (emergencyContacts !== undefined) data.emergencyContacts = emergencyContacts || null;
    if (notificationsEnabled !== undefined) data.notificationsEnabled = !!notificationsEnabled;
    if (notificationChannels !== undefined) data.notificationChannels = notificationChannels || "whatsapp";
    if (criticalOnlyMode !== undefined) data.criticalOnlyMode = !!criticalOnlyMode;

    const updated = await prisma.restaurantConfig.update({ where: { id: DEFAULT_RESTAURANT_ID }, data });
    await notifyAdminOfEvent("config_updated", { restaurantId: DEFAULT_RESTAURANT_ID });
    res.json(updated);
  });

  api.get("/prompt", async (_req, res) => {
    res.json(await prisma.promptTemplate.findFirst({ where: { id: 1 } }) ?? {});
  });

  api.put("/prompt", requireOwner, async (req, res) => {
    const { content } = req.body;
    const existing = await prisma.promptTemplate.findFirst({ where: { id: 1 } });
    const result = existing
      ? await prisma.promptTemplate.update({ where: { id: existing.id }, data: { content } })
      : await prisma.promptTemplate.create({ data: { content } });
    await notifyAdminOfEvent("config_updated", { restaurantId: DEFAULT_RESTAURANT_ID });
    res.json(result);
  });

  api.get("/tools", async (_req, res) => {
    res.json(await prisma.toolDefinition.findMany({
      orderBy: { sortOrder: "asc" },
    }));
  });

  api.put("/tools/:id", requireOwner, async (req, res) => {
    const id = Number(req.params.id);
    const { isEnabled, description, parametersSchema } = req.body;
    const data: Record<string, unknown> = {};
    if (isEnabled !== undefined) data.isEnabled = !!isEnabled;
    if (description !== undefined) data.description = description;
    if (parametersSchema !== undefined) data.parametersSchema = parametersSchema;
    const result = await prisma.toolDefinition.update({ where: { id }, data });
    await notifyAdminOfEvent("config_updated", { restaurantId: DEFAULT_RESTAURANT_ID });
    res.json(result);
  });

  /**
   * Attach spend and ordering history to a page of customers.
   *
   * Computed from Order rather than read from Customer.totalOrdersCount,
   * totalSpentRupees, lastOrderedAt and favoriteDish. Those columns exist in the
   * schema and are written by nothing — showing them would have displayed zero
   * for every customer. Orders are the source of truth and cannot drift from
   * themselves.
   *
   * Two aggregate queries for the whole page, not per customer, so this stays
   * one round trip regardless of how many contacts are listed. Cancelled orders
   * are excluded: a cancelled order is not spend, and counting it would inflate
   * both the total and the "repeat customer" flag.
   */
  async function withInsights<T extends { id: number; notes?: string | null }>(customers: T[]) {
    const ids = customers.map((c) => c.id);
    if (ids.length === 0) return customers;

    const [totals, favourites] = await Promise.all([
      prisma.order.groupBy({
        by: ["customerId"],
        where: { customerId: { in: ids }, status: { not: "cancelled" } },
        _count: { _all: true },
        _sum: { total: true },
        _max: { createdAt: true },
      }),
      prisma.$queryRawUnsafe<Array<{ customerId: number; name: string; times: number }>>(
        `SELECT t."customerId", t.name, t.times FROM (
           SELECT o."customerId", mi.name,
                  COUNT(*)::int AS times,
                  ROW_NUMBER() OVER (PARTITION BY o."customerId" ORDER BY COUNT(*) DESC, mi.name) AS rn
             FROM "OrderItem" oi
             JOIN "Order" o  ON o.id = oi."orderId"
             JOIN "MenuItem" mi ON mi.id = oi."menuItemId"
            WHERE o."customerId" = ANY($1::int[]) AND o.status <> 'cancelled'
            GROUP BY o."customerId", mi.name
         ) t WHERE t.rn = 1`,
        ids,
      ).catch(() => []),
    ]);

    const byId = new Map(totals.map((t) => [t.customerId, t]));
    const favById = new Map(favourites.map((f) => [f.customerId, f]));

    return customers.map((c) => {
      const t = byId.get(c.id);
      const orders = t?._count._all ?? 0;
      const spent = t?._sum.total ?? 0;
      const fav = favById.get(c.id);
      return {
        ...c,
        insights: {
          orders,
          totalSpent: Math.round(spent),
          avgOrder: orders > 0 ? Math.round(spent / orders) : 0,
          lastOrderAt: t?._max.createdAt ?? null,
          isRepeat: orders > 1,
          favouriteDish: fav ? { name: fav.name, times: fav.times } : null,
          // Surfaced separately from notes so the dashboard can make it loud —
          // it is the one thing on this card that can hurt someone.
          allergies: allergyLines(c.notes),
        },
      };
    });
  }

  /**
   * Contacts for the chat list, most recently active first.
   *
   * This used to order by Customer.createdAt — when the record was first
   * created, not when they last said anything. A regular who ordered every week
   * sat frozen at the bottom of the list while a one-time contact from
   * yesterday stayed pinned to the top, and a new message never moved a thread.
   *
   * The ordering is derived from the messages table rather than the customer
   * row, so the 200 cap keeps the 200 most recently active conversations. Taking
   * the newest 200 customers and sorting those would still hide an old regular
   * who just messaged, which is precisely the person staff need to see.
   */
  api.get("/customers", async (_req, res) => {
    const recent = await prisma.message.groupBy({
      by: ["customerId"],
      _max: { createdAt: true },
      orderBy: { _max: { createdAt: "desc" } },
      take: 200,
    });

    const lastAt = new Map(recent.map((r) => [r.customerId, r._max.createdAt]));

    const customers = await prisma.customer.findMany({
      where: { id: { in: recent.map((r) => r.customerId) } },
      include: { _count: { select: { orders: true } } },
    });

    // findMany does not preserve the order of an `in` list.
    const ordered = customers
      .map((c) => ({ ...c, lastMessageAt: lastAt.get(c.id) ?? c.createdAt }))
      .sort((a, b) => b.lastMessageAt.getTime() - a.lastMessageAt.getTime());

    // Contacts who have never exchanged a message still belong in the list —
    // staff create them by hand — but they sort below anyone who has.
    if (ordered.length < 200) {
      const silent = await prisma.customer.findMany({
        where: { id: { notIn: recent.map((r) => r.customerId) } },
        include: { _count: { select: { orders: true } } },
        orderBy: { createdAt: "desc" },
        take: 200 - ordered.length,
      });
      ordered.push(...silent.map((c) => ({ ...c, lastMessageAt: c.createdAt })));
    }

    res.json(await withInsights(ordered));
  });

  api.get("/customers/:id/messages", async (req, res) => {
    res.json(await prisma.message.findMany({
      where: { customerId: Number(req.params.id) },
      orderBy: { createdAt: "asc" },
    }));
  });

  api.put("/customers/:id", requireOwner, async (req, res) => {
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
    res.json({ ok: true });
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

  // Owner-only. Tears down and re-establishes this restaurant's WhatsApp bot
  // session. TODO: the running provider is Meta Cloud API (see
  // BotSessionManager), which is stateless — there's no local auth_session/
  // folder to wipe like a Baileys-based provider would have. If a Baileys
  // adapter is ever added, clear its auth_session/<restaurantId> directory
  // here too before restarting so a fresh QR is actually forced.
  api.post("/session/reset", requireOwner, async (req, res) => {
    try {
      const restaurantId = req.restaurantId;
      const cfg = await prisma.restaurantConfig.findUnique({ where: { id: restaurantId } });
      if (!cfg) {
        res.status(404).json({ error: "restaurant not found" });
        return;
      }
      botSessionManager.stopSession(restaurantId);
      await botSessionManager.startSession(restaurantId, cfg.restaurantName);
      res.json({ ok: true });
    } catch (e: any) {
      logger.error("[Session Reset] Failed:", e);
      res.status(500).json({ error: e?.message ?? "Failed to reset session" });
    }
  });

  // ── Notification center ──────────────────────────────────────────────
  // Open to both owner and employee roles (authMiddleware, already applied
  // router-wide) — both need visibility into failures/handoffs for Orders
  // and Chats work.
  api.get("/notifications", asyncRoute(async (req, res) => {
    const unreadOnly = req.query.unread === "true" || req.query.unread === "1";
    const rows = await prisma.notification.findMany({
      where: unreadOnly ? { acknowledgedAt: null } : undefined,
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    res.json(rows);
  }));

  api.get("/notifications/unread-count", asyncRoute(async (_req, res) => {
    const count = await prisma.notification.count({ where: { acknowledgedAt: null } });
    res.json({ count });
  }));

  api.post("/notifications/:id/ack", asyncRoute(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "invalid id" });
      return;
    }
    const row = await prisma.notification.update({
      where: { id },
      data: { acknowledgedAt: new Date() },
    });
    res.json(row);
  }));

  app.use("/api", api);

  return app;
}
