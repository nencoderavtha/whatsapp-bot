/**
 * Delivery Manager Service
 * 
 * Handles database operations for DeliveryQuotes and DeliveryDispatch,
 * integrates with DeliveryOrchestrator, and handles manual/automated dispatches.
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
    const quotesData = await orchestrator.getAllQuotes({
      pickupPincode,
      deliveryPincode,
    });

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
   * Dispatch an order to a delivery provider (Borzo, Shadowfax, Shiprocket)
   */
  static async dispatchOrder(
    orderId: number,
    providerCode: DeliveryProviderCode = "borzo",
  ) {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { customer: true, deliveryDispatch: true },
    });

    if (!order) throw new Error(`Order #${orderId} not found`);

    const result = await orchestrator.dispatchOrder({
      orderId,
      providerCode,
      customerName: order.customer.name ?? "Customer",
      customerPhone: order.customer.phone,
      deliveryAddress: order.deliveryAddress ?? "Jubilee Hills, Hyderabad",
    });

    // Upsert DeliveryDispatch record in DB
    const dispatch = await prisma.deliveryDispatch.upsert({
      where: { orderId },
      update: {
        providerCode: result.providerCode,
        externalDeliveryId: result.dispatchId,
        status: result.status || "SEARCHING_RIDER",
        deliveryFee: order.deliveryFee || 45,
      },
      create: {
        orderId,
        providerCode: result.providerCode,
        externalDeliveryId: result.dispatchId,
        status: result.status || "SEARCHING_RIDER",
        deliveryFee: order.deliveryFee || 45,
      },
    });

    // Also update order status to out_for_delivery or preparing
    await prisma.order.update({
      where: { id: orderId },
      data: { status: "out_for_delivery" },
    });

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
