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
  }): Promise<{
    ok: boolean;
    pickupPincode: number;
    deliveryPincode: number;
    quotes: UnifiedQuote[];
    cheapest: UnifiedQuote;
    fastest: UnifiedQuote;
  }> {
    const results = await Promise.allSettled([
      this.shiprocket.getQuote(params),
      this.shadowfax.getQuote(params),
      this.borzo.getQuote(params),
      this.getDirectRapidoQuote(params),
    ]);

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
   * Fetch Live Rider Tracking Details
   */
  async getTrackingStatus(dispatchId: string, providerCode?: DeliveryProviderCode) {
    if (dispatchId.startsWith("SFX")) {
      return this.shadowfax.getTrackingStatus(dispatchId);
    }
    if (dispatchId.startsWith("BRZ")) {
      return this.borzo.getTrackingStatus(dispatchId);
    }
    return this.shiprocket.getTrackingStatus(dispatchId);
  }

  /**
   * Direct Rapido Quote Helper (simulated/direct enterprise partner route)
   */
  private async getDirectRapidoQuote(params: { pickupPincode: number; deliveryPincode: number }) {
    const distanceKm = Math.abs(params.deliveryPincode - params.pickupPincode) % 10 + 2;
    const fee = Math.max(42, Math.round(32 + distanceKm * 5.2));
    const eta = Math.min(35, 12 + distanceKm * 1.8);

    return {
      provider: "Rapido Parcel (Direct)",
      providerCode: "rapido" as const,
      quotedFee: fee,
      estimatedMinutes: eta,
      available: true,
      vehicleType: "2-Wheeler Bike",
    };
  }
}
