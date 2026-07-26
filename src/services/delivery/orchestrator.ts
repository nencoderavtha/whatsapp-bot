/**
 * Unified Delivery Orchestrator Service
 * 
 * Aggregates quotes and handles dispatch dispatches across:
 *   - Shiprocket Quick (aggregating Rapido Parcel)
 *   - Shadowfax Hyperlocal
 *   - Borzo Express
 * 
 * Features parallel query fan-out, sorting by fee/ETA, and seamless failovers.
 */

import { prisma } from "../../db.js";
import { ShiprocketDeliveryService, ShiprocketQuoteResponse } from "./shiprocket.js";
import { ShadowfaxDeliveryService, ShadowfaxQuoteResponse } from "./shadowfax.js";
import { BorzoDeliveryService, BorzoQuoteResponse } from "./borzo.js";

export type DeliveryProviderCode = "rapido" | "shiprocket" | "shadowfax" | "borzo" | "porter";

export interface UnifiedQuote {
  provider: string;
  providerCode: DeliveryProviderCode;
  quotedFee: number;
  estimatedMinutes: number;
  available: boolean;
  vehicleType: string;
  underlyingCarrier?: string;
}

export interface DispatchRequest {
  orderId: number;
  providerCode: DeliveryProviderCode;
  customerName: string;
  customerPhone: string;
  deliveryAddress: string;
  pickupPincode?: number;
  deliveryPincode?: number;
}

export class DeliveryOrchestrator {
  private shiprocket = new ShiprocketDeliveryService();
  private shadowfax = new ShadowfaxDeliveryService();
  private borzo = new BorzoDeliveryService();

  /**
   * Fetch quotes from all active providers concurrently
   */
  async getAllQuotes(params: {
    pickupPincode: number;
    deliveryPincode: number;
    weightKg?: number;
    // Optional precise routing — Borzo prices on these when supplied, instead of
    // geocoding a pincode to its centroid and under-quoting the real distance.
    pickupAddress?: string;
    pickupLat?: number | null;
    pickupLng?: number | null;
    pickupPhone?: string;
    deliveryAddress?: string;
    deliveryLat?: number | null;
    deliveryLng?: number | null;
    deliveryPhone?: string;
  }): Promise<{
    ok: boolean;
    pickupPincode: number;
    deliveryPincode: number;
    quotes: UnifiedQuote[];
    cheapest: UnifiedQuote;
    fastest: UnifiedQuote;
  }> {
    // Only ask providers that actually have credentials. Unconfigured providers
    // used to return invented "simulation" fees marked available, and since the
    // cheapest quote wins, a made-up number would routinely undercut the one
    // real quote and become the fee charged to the customer.
    const pending: Array<Promise<UnifiedQuote | null>> = [];
    if (process.env.SHIPROCKET_API_EMAIL && process.env.SHIPROCKET_API_PASSWORD) {
      pending.push(this.shiprocket.getQuote(params) as Promise<UnifiedQuote | null>);
    }
    if (process.env.SHADOWFAX_API_KEY) {
      pending.push(this.shadowfax.getQuote(params) as Promise<UnifiedQuote | null>);
    }
    if (process.env.BORZO_API_TOKEN) {
      pending.push(this.borzo.getQuote(params) as Promise<UnifiedQuote | null>);
    }

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

    // Sort by cheapest fee
    const sortedByFee = [...quotes].sort((a, b) => a.quotedFee - b.quotedFee);
    // Sort by fastest ETA
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
   * Dispatch delivery order to target provider
   */
  async dispatchOrder(request: DispatchRequest) {
    switch (request.providerCode) {
      case "shiprocket":
        return this.shiprocket.dispatchOrder(request);
      case "shadowfax":
        return this.shadowfax.dispatchOrder(request);
      case "borzo":
        return this.borzo.dispatchOrder(request);
      case "rapido":
        // Rapido dispatch via Shiprocket Quick / Direct Partner route
        return this.shiprocket.dispatchOrder({ ...request });
      default:
        return this.shiprocket.dispatchOrder(request);
    }
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
