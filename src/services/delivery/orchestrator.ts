/**
 * Unified Delivery Orchestrator Service
 *
 * Routes all quotes and dispatches exclusively through Shiprocket Quick
 * (aggregates Rapido Parcel, Dunzo, Shadowfax hyperlocal riders).
 */

import { prisma } from "../../db.js";
import { ShiprocketDeliveryService } from "./shiprocket.js";
import { logger } from "../logger.js";

export type DeliveryProviderCode = "rapido" | "shiprocket" | "shadowfax" | "borzo" | "porter" | "uber";

export interface UnifiedQuote {
  provider: string;
  providerCode: DeliveryProviderCode;
  quotedFee: number;
  estimatedMinutes: number;
  available: boolean;
  vehicleType: string;
  underlyingCarrier?: string;
  pickupDuration?: number;
}

export interface QuoteParams {
  pickupPincode: number;
  deliveryPincode: number;
  weightKg?: number;
  pickupLat?: number | null;
  pickupLng?: number | null;
  deliveryLat?: number | null;
  deliveryLng?: number | null;
  pickupAddress?: string;
  pickupPhone?: string;
  deliveryAddress?: string;
  deliveryPhone?: string;
}

export interface DispatchRequest {
  orderId: number;
  providerCode: DeliveryProviderCode;
  customerName: string;
  customerPhone: string;
  deliveryAddress: string;
  deliveryLat?: number;
  deliveryLng?: number;
  pickupAddress?: string;
  pickupLat?: number;
  pickupLng?: number;
  pickupPhone?: string;
  pickupName?: string;
  pickupPincode?: number;
  deliveryPincode?: number;
  items?: Array<{ name: string; qty: number; price: number }>;
  subTotal?: number;
}

export class DeliveryOrchestrator {
  private shiprocket = new ShiprocketDeliveryService();

  /**
   * Fetch quotes exclusively from Shiprocket Quick.
   */
  async getAllQuotes(params: QuoteParams): Promise<{
    ok: boolean;
    pickupPincode: number;
    deliveryPincode: number;
    quotes: UnifiedQuote[];
    cheapest: UnifiedQuote;
    fastest: UnifiedQuote;
  }> {
    logger.info(
      `\n🌐 [Delivery Quote Request]\n` +
      `   📍 Pickup Address : ${params.pickupAddress ?? "Pincode " + params.pickupPincode} (Lat: ${params.pickupLat ?? "N/A"}, Lng: ${params.pickupLng ?? "N/A"})\n` +
      `   🏁 Drop Address   : ${params.deliveryAddress ?? "Pincode " + params.deliveryPincode} (Lat: ${params.deliveryLat ?? "N/A"}, Lng: ${params.deliveryLng ?? "N/A"})\n`
    );

    // Exclusively Shiprocket Quick
    const shiprocketQuote = await this.shiprocket.getQuote({
      pickupPincode: params.pickupPincode,
      deliveryPincode: params.deliveryPincode,
      weightKg: params.weightKg,
      pickupLat: params.pickupLat ?? undefined,
      pickupLng: params.pickupLng ?? undefined,
      deliveryLat: params.deliveryLat ?? undefined,
      deliveryLng: params.deliveryLng ?? undefined,
    });

    const quotes: UnifiedQuote[] = [];
    if (shiprocketQuote.available) {
      quotes.push(shiprocketQuote as UnifiedQuote);
    }

    if (quotes.length === 0) {
      throw new Error("No delivery partners available for the requested route.");
    }

    const sortedByFee = [...quotes].sort((a, b) => a.quotedFee - b.quotedFee);
    const sortedByEta = [...quotes].sort((a, b) => a.estimatedMinutes - b.estimatedMinutes);

    return {
      ok: true,
      pickupPincode: params.pickupPincode,
      deliveryPincode: params.deliveryPincode,
      quotes: sortedByFee,
      cheapest: sortedByFee[0],
      fastest: sortedByEta[0],
    };
  }

  /**
   * Dispatch delivery order exclusively via Shiprocket Quick.
   */
  async dispatchOrder(request: DispatchRequest) {
    logger.info(`🚚 [Orchestrator] Directing dispatch for Order #${request.orderId} exclusively to Shiprocket Quick`);
    return this.shiprocket.dispatchOrder({
      orderId: request.orderId,
      customerName: request.customerName,
      customerPhone: request.customerPhone,
      deliveryAddress: request.deliveryAddress,
      deliveryLat: request.deliveryLat,
      deliveryLng: request.deliveryLng,
      pickupAddress: request.pickupAddress,
      pickupLat: request.pickupLat,
      pickupLng: request.pickupLng,
      items: request.items,
      subTotal: request.subTotal,
    });
  }

  /**
   * Live rider details for a dispatch.
   */
  async getTrackingStatus(dispatchId: string) {
    const dispatch = await prisma.deliveryDispatch.findFirst({
      where: { externalDeliveryId: dispatchId },
    });

    if (!dispatch) {
      return { ok: false, dispatchId, status: "UNKNOWN", rider: null };
    }

    return {
      ok: true,
      dispatchId,
      providerCode: dispatch.providerCode,
      status: dispatch.status,
      trackingUrl: dispatch.trackingUrl ?? null,
      rider: dispatch.riderName
        ? {
            name: dispatch.riderName,
            phone: dispatch.riderPhone ?? null,
            vehicleNumber: dispatch.riderVehicleNumber ?? null,
          }
        : null,
    };
  }
}
