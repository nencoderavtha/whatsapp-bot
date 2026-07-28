/**
 * Delivery Manager Service
 * 
 * Handles database operations for DeliveryQuotes and DeliveryDispatch,
 * integrates with DeliveryOrchestrator, and handles manual/automated dispatches.
 * Provides clean, structured console logs for 100% terminal observability.
 */

import { prisma } from "../../db.js";
import { DeliveryOrchestrator, DeliveryProviderCode } from "./orchestrator.js";
import { notifyAdminOfEvent } from "../events.js";
import { DEFAULT_RESTAURANT_ID } from "../../tenancy.js";
import { logger } from '../logger.js';

const orchestrator = new DeliveryOrchestrator();

export interface DeliveryQuoteResult {
  pickupPincode: number;
  deliveryPincode: number;
  cheapestFee: number;
  providerCode: DeliveryProviderCode;
  providerName: string;
  estimatedMinutes: number;
}

export class DeliveryManager {
  /**
   * Get quotes for a pincode route and store them in database for the pending order
   */
  static async getAndSaveQuotes(
    orderId: number,
    pickupPincode = 500033,
    deliveryPincode = 500081,
  ): Promise<DeliveryQuoteResult> {
    logger.info(`\n📊 [Delivery Rate Comparison] Querying live quotes for Order #${orderId} (${pickupPincode} ➔ ${deliveryPincode})...`);

    const quotesData = await orchestrator.getAllQuotes({
      pickupPincode,
      deliveryPincode,
    });

    for (const q of quotesData.quotes) {
      logger.info(`   • ${q.provider}: ₹${q.quotedFee} (${q.estimatedMinutes} mins) — ${q.available ? "Available ✅" : "Unavailable ❌"}`);
    }

    logger.info(`🏆 [Selected Best Rate]: ${quotesData.cheapest.provider.toUpperCase()} (₹${quotesData.cheapest.quotedFee}, ${quotesData.cheapest.estimatedMinutes} mins)\n`);

    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 min expiry

    // Store quotes in DB
    for (const q of quotesData.quotes) {
      await prisma.deliveryQuote.create({
        data: {
          orderId,
          providerCode: q.providerCode,
          quotedFee: q.quotedFee,
          estimatedMinutes: q.estimatedMinutes,
          isAvailable: q.available,
          expiresAt,
          isSelected: q.providerCode === quotesData.cheapest.providerCode,
        },
      });
    }

    return {
      pickupPincode,
      deliveryPincode,
      cheapestFee: quotesData.cheapest.quotedFee,
      providerCode: quotesData.cheapest.providerCode,
      providerName: quotesData.cheapest.provider,
      estimatedMinutes: quotesData.cheapest.estimatedMinutes,
    };
  }

  /**
   * Dispatch an order: Compares live quotes, picks lowest fee, and dispatches rider
   */
  static async dispatchOrder(
    orderId: number,
    preferredProviderCode?: DeliveryProviderCode,
  ) {
    logger.info(`\n🛵 [Delivery Dispatch Triggered] Processing Order #${orderId}...`);

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { customer: true, deliveryDispatch: true },
    });

    if (!order) throw new Error(`Order #${orderId} not found`);

    logger.info(`👤 [Customer Details] Name: ${order.customer.name || "Customer"} | Phone: ${order.customer.phone}`);
    logger.info(`📍 [Drop Address] ${order.deliveryAddress || "Jubilee Hills, Hyderabad"}`);

    if (
      order.deliveryDispatch &&
      order.deliveryDispatch.externalDeliveryId &&
      order.deliveryDispatch.externalDeliveryId !== "NOT_DISPATCHED_YET"
    ) {
      logger.info(
        `↩️  [Already Dispatched] Order #${orderId} → ${order.deliveryDispatch.externalDeliveryId}. Not booking a second courier.`,
      );
      return { ok: true, dispatch: order.deliveryDispatch, result: null, alreadyDispatched: true };
    }

    // The customer paid order.deliveryFee at checkout. That figure is settled and
    // is never recomputed here — re-quoting at booking time (20-30 minutes later,
    // at a different price) and writing the new number back left the books
    // disagreeing with what was actually charged.
    const selectedProviderCode = preferredProviderCode ?? "shiprocket";
    const billedFee = order.deliveryFee || 45;

    logger.info(`🏆 [Delivery Partner]: ${selectedProviderCode.toUpperCase()} | Customer was billed ₹${billedFee}`);

    // Step 2: Trigger dispatch via selected provider
    logger.info(`🚀 [Dispatching Rider] Booking rider on ${selectedProviderCode.toUpperCase()} API...`);

    const restaurant = await prisma.restaurantConfig.findUnique({ where: { id: DEFAULT_RESTAURANT_ID } });
    const ownerPhone = (restaurant?.ownerNumbers ?? "").split(",").map((s) => s.trim()).filter(Boolean)[0];
    const PLACEHOLDER_ADDRESS = "Plot 12, Main Road, Gachibowli, Hyderabad";
    const pickupAddress = restaurant?.restaurantAddress && restaurant.restaurantAddress !== PLACEHOLDER_ADDRESS
      ? restaurant.restaurantAddress
      : undefined;

    const result = await orchestrator.dispatchOrder({
      orderId,
      providerCode: selectedProviderCode,
      customerName: order.customer.name ?? "Customer",
      customerPhone: order.customer.phone,
      deliveryAddress: order.deliveryAddress ?? "Jubilee Hills, Hyderabad",
      deliveryLat: order.deliveryLat ?? undefined,
      deliveryLng: order.deliveryLng ?? undefined,
      pickupAddress,
      pickupLat: restaurant?.restaurantLat ?? undefined,
      pickupLng: restaurant?.restaurantLng ?? undefined,
      pickupPhone: ownerPhone,
      pickupName: restaurant?.restaurantName ?? "Restaurant",
    });

    // A rejected booking is not a dispatch. Recording one wrote a row with a null
    // id and status SEARCHING_RIDER, and moved the order to out_for_delivery — so
    // the dashboard showed a rider en route when Borzo had booked nobody.
    if (!result.ok || !result.dispatchId) {
      logger.error(
        `❌ [Dispatch Failed] Order #${orderId}: ${result.message ?? "provider returned no booking"}`,
      );
      throw new Error(result.message ?? `Could not book a rider for order #${orderId}`);
    }

    logger.info(`🔍 [Rider Search Active] Booking ID: ${result.dispatchId} | Initial Status: ${result.status || "SEARCHING_RIDER"}`);

    const dispatch = await prisma.deliveryDispatch.upsert({
      where: { orderId },
      update: {
        providerCode: result.providerCode,
        externalDeliveryId: result.dispatchId,
        status: result.status || "SEARCHING_RIDER",
        deliveryFee: billedFee,
      },
      create: {
        orderId,
        providerCode: result.providerCode,
        externalDeliveryId: result.dispatchId,
        status: result.status || "SEARCHING_RIDER",
        deliveryFee: billedFee,
      },
    });

    // The order stays "ready" until the courier actually collects it. Borzo's
    // PICKED_UP webhook moves it to out_for_delivery, so the status reflects
    // where the food is rather than when we sent an API call.
    logger.info(`✅ [Order #${orderId}] Rider booked on ${result.providerCode.toUpperCase()} — awaiting pickup\n`);

    await notifyAdminOfEvent("order_updated", { ...order, deliveryDispatch: dispatch });
    return { ok: true, dispatch, result };
  }

  /**
   * Update live rider details & status from provider webhook callbacks
   */
  static async updateRiderStatus(
    orderId: number,
    status: string,
    riderInfo?: { name?: string; phone?: string; vehicleNumber?: string; lat?: number; lng?: number },
  ) {
    const dispatch = await prisma.deliveryDispatch.update({
      where: { orderId },
      data: {
        status,
        ...(riderInfo?.name ? { riderName: riderInfo.name } : {}),
        ...(riderInfo?.phone ? { riderPhone: riderInfo.phone } : {}),
        ...(riderInfo?.vehicleNumber ? { riderVehicleNumber: riderInfo.vehicleNumber } : {}),
        ...(riderInfo?.lat ? { riderLat: riderInfo.lat } : {}),
        ...(riderInfo?.lng ? { riderLng: riderInfo.lng } : {}),
      },
    });

    await notifyAdminOfEvent("order_updated", { orderId, status, dispatch });
    return dispatch;
  }
}
