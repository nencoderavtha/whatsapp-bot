/**
 * Unified Delivery Orchestrator Service
 *
 * Aggregates quotes and handles dispatch across:
 *   - Shiprocket Quick (aggregating Rapido Parcel)
 *   - Shadowfax Hyperlocal
 *   - Borzo Express
 *
 * Features: parallel fan-out, sort by fee/ETA, graceful failovers.
 */

import { prisma } from "../../db.js";
import { ShiprocketDeliveryService } from "./shiprocket.js";
import { ShadowfaxDeliveryService, ShadowfaxQuoteParams } from "./shadowfax.js";
import { BorzoDeliveryService } from "./borzo.js";
import { UberDirectDeliveryService } from "./uber-direct.js";
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
  /** Optional lat/lng for improved Shadowfax geo-accuracy */
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
  private shadowfax = new ShadowfaxDeliveryService();
  private borzo = new BorzoDeliveryService();
  private uber = new UberDirectDeliveryService();

  /**
   * Fetch quotes from all active providers concurrently and return sorted results.
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

    // Only ask providers that actually have credentials. Unconfigured providers
    // used to return invented simulation fees marked available, and since the
    // cheapest quote wins, a made-up number would routinely undercut the one
    // real quote and become the fee charged to the customer.
    // Active providers query (Unplugged Shiprocket and Borzo for testing Uber Direct)
    const pending: Array<Promise<UnifiedQuote | null>> = [];
    
    // Enable Uber Direct for testing
    pending.push(this.uber.getQuote(params) as Promise<UnifiedQuote | null>);

    /*
    // Shiprocket & Borzo unplugged per user request
    if (process.env.SHIPROCKET_API_EMAIL && process.env.SHIPROCKET_API_PASSWORD) {
      pending.push(this.shiprocket.getQuote(params) as Promise<UnifiedQuote | null>);
    }
    if (process.env.BORZO_API_TOKEN || process.env.BORZO_PROD_API_TOKEN) {
      pending.push(this.borzo.getQuote(params) as Promise<UnifiedQuote | null>);
    }
    */

    const results = await Promise.allSettled(pending);

    const quotes: UnifiedQuote[] = [];

    for (const res of results) {
      if (res.status === "fulfilled" && res.value && res.value.available) {
        quotes.push(res.value as UnifiedQuote);
      }
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
   * Dispatch delivery order (Exclusively routed to Uber Direct)
   */
  async dispatchOrder(request: DispatchRequest) {
    logger.info(`🚚 [Orchestrator] Directing dispatch for Order #${request.orderId} exclusively to Uber Direct`);
    return this.uber.dispatchOrder(request);
  }

  /**
   * Live rider details for a dispatch.
   *
   * Reads the DeliveryDispatch row, which the provider status webhooks keep up
   * to date. The per-provider implementations this replaced returned hardcoded
   * placeholder riders ("Vikram Reddy" and friends), so callers were shown a
   * confident answer that had nothing to do with the real courier.
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
