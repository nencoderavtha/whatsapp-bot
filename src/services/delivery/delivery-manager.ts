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
    console.log(`\n📊 [Delivery Rate Comparison] Querying live quotes for Order #${orderId} (${pickupPincode} ➔ ${deliveryPincode})...`);

    const quotesData = await orchestrator.getAllQuotes({
      pickupPincode,
      deliveryPincode,
    });

    for (const q of quotesData.quotes) {
      console.log(`   • ${q.provider}: ₹${q.quotedFee} (${q.estimatedMinutes} mins) — ${q.available ? "Available ✅" : "Unavailable ❌"}`);
    }

    console.log(`🏆 [Selected Best Rate]: ${quotesData.cheapest.provider.toUpperCase()} (₹${quotesData.cheapest.quotedFee}, ${quotesData.cheapest.estimatedMinutes} mins)\n`);

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
    console.log(`\n🛵 [Delivery Dispatch Triggered] Processing Order #${orderId}...`);

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { customer: true, deliveryDispatch: true },
    });

    if (!order) throw new Error(`Order #${orderId} not found`);

    console.log(`👤 [Customer Details] Name: ${order.customer.name || "Customer"} | Phone: ${order.customer.phone}`);
    console.log(`📍 [Drop Address] ${order.deliveryAddress || "Jubilee Hills, Hyderabad"}`);

    // Step 1: Query live provider rates
    console.log(`📊 [Delivery Rate Comparison] Querying live quotes across providers...`);
    const quotesData = await orchestrator.getAllQuotes({
      pickupPincode: 500033,
      deliveryPincode: 500081,
    });

    for (const q of quotesData.quotes) {
      console.log(`   • ${q.provider}: ₹${q.quotedFee} (${q.estimatedMinutes} mins)`);
    }

    const selectedProviderCode = preferredProviderCode || quotesData.cheapest.providerCode;
    const selectedFee = quotesData.quotes.find((q) => q.providerCode === selectedProviderCode)?.quotedFee || order.deliveryFee || 45;

    console.log(`🏆 [Selected Delivery Partner]: ${selectedProviderCode.toUpperCase()} (Fee: ₹${selectedFee})`);

    // Step 2: Trigger dispatch via selected provider
    console.log(`🚀 [Dispatching Rider] Booking rider on ${selectedProviderCode.toUpperCase()} API...`);

    const restaurant = await prisma.restaurantConfig.findUnique({ where: { id: 1 } });
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
    });

    console.log(`🔍 [Rider Search Active] Booking ID: ${result.dispatchId} | Initial Status: ${result.status || "SEARCHING_RIDER"}`);

    // Step 3: Upsert DeliveryDispatch record in DB
    const dispatch = await prisma.deliveryDispatch.upsert({
      where: { orderId },
      update: {
        providerCode: result.providerCode,
        externalDeliveryId: result.dispatchId,
        status: result.status || "SEARCHING_RIDER",
        deliveryFee: selectedFee,
      },
      create: {
        orderId,
        providerCode: result.providerCode,
        externalDeliveryId: result.dispatchId,
        status: result.status || "SEARCHING_RIDER",
        deliveryFee: selectedFee,
      },
    });

    // Step 4: Update order status to out_for_delivery
    await prisma.order.update({
      where: { id: orderId },
      data: { status: "out_for_delivery" },
    });

    console.log(`✅ [Order #${orderId} Updated] Status -> out_for_delivery | Partner -> ${result.providerCode.toUpperCase()}\n`);

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
