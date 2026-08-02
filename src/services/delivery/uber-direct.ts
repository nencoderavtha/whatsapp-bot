import { logger } from "../logger.js";
import { QuoteParams } from "./orchestrator.js";

export interface UberDirectQuoteResponse {
  provider: string;
  providerCode: "uber";
  quotedFee: number;
  estimatedMinutes: number;
  available: boolean;
  vehicleType: string;
  raw?: any;
  error?: string;
  pickupDuration?: number;
}

export class UberDirectDeliveryService {
  private static cachedToken: string | null = null;
  private static tokenExpiresAt: number = 0;

  private getEnvKeys() {
    return {
      env: (process.env.UBER_ENV || "").trim(),
      customerId: (process.env.UBER_CUSTOMER_ID || "").trim(),
      clientId: (process.env.UBER_CLIENT_ID || "").trim(),
      clientSecret: (process.env.UBER_CLIENT_SECRET || "").trim(),
      scope: (process.env.UBER_SCOPE || "").trim(),
    };
  }

  private async authenticate(): Promise<string | null> {
    const { clientId, clientSecret, scope } = this.getEnvKeys();

    if (!clientId || !clientSecret) {
      return null;
    }

    // Reuse token if valid (with 60 second buffer)
    if (
      UberDirectDeliveryService.cachedToken &&
      Date.now() < UberDirectDeliveryService.tokenExpiresAt - 60000
    ) {
      return UberDirectDeliveryService.cachedToken;
    }

    try {
      const primaryScope = scope || "eats.deliveries";
      const params = new URLSearchParams();
      params.append("client_id", clientId);
      params.append("client_secret", clientSecret);
      params.append("grant_type", "client_credentials");
      params.append("scope", primaryScope);

      let res = await fetch("https://auth.uber.com/oauth/v2/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
      });

      if (!res.ok) {
        const errText = await res.text();
        logger.error(`[Uber Direct Auth] Failed to authenticate with scope '${primaryScope}': HTTP ${res.status}`, errText);
        if (errText.includes("invalid_scope")) {
          logger.error("⚠️ [Uber Direct Setup Required] Enable the 'eats.deliveries' scope in your Uber Developer Dashboard (developer.uber.com -> Your App -> Products/Scopes).");
        }
        return null;
      }

      const data = (await res.json()) as { access_token?: string; expires_in?: number };
      if (data.access_token) {
        UberDirectDeliveryService.cachedToken = data.access_token;
        const expiresIn = data.expires_in ?? 3600;
        UberDirectDeliveryService.tokenExpiresAt = Date.now() + expiresIn * 1000;
        return data.access_token;
      }
      return null;
    } catch (err) {
      logger.error("[Uber Direct Auth] Error fetching OAuth token:", err);
      return null;
    }
  }

  /**
   * Get delivery quote from Uber Direct
   */
  async getQuote(params: QuoteParams): Promise<UberDirectQuoteResponse> {
    const token = await this.authenticate();
    if (!token) {
      return {
        provider: "Uber Direct",
        providerCode: "uber",
        quotedFee: 0,
        estimatedMinutes: 0,
        available: false,
        vehicleType: "Uber Direct Hyperlocal",
        error: "Missing or invalid Uber credentials",
      };
    }

    const { env, customerId } = this.getEnvKeys();
    if (!customerId) {
      return {
        provider: "Uber Direct",
        providerCode: "uber",
        quotedFee: 0,
        estimatedMinutes: 0,
        available: false,
        vehicleType: "Uber Direct Hyperlocal",
        error: "Missing UBER_CUSTOMER_ID in environment",
      };
    }

    const isTest = env === "test" || env === "sandbox";
    const baseUrl = isTest ? "https://sandbox-api.uber.com" : "https://api.uber.com";

    const pickupAddress = params.pickupAddress ?? `Hyderabad Pincode ${params.pickupPincode}`;
    const deliveryAddress = params.deliveryAddress ?? `Hyderabad Pincode ${params.deliveryPincode}`;

    const formatPhone = (phone?: string) => {
      const cleaned = (phone ?? "").replace(/\D/g, "");
      return cleaned ? `+${cleaned}` : "+919999999999";
    };

    const payload: Record<string, any> = {
      pickup_address: pickupAddress,
      dropoff_address: deliveryAddress,
      pickup_phone_number: formatPhone(params.pickupPhone),
      dropoff_phone_number: formatPhone(params.deliveryPhone),
      manifest_total_value: 10000,
    };

    if (params.pickupLat != null && params.pickupLng != null) {
      payload.pickup_latitude = Number(params.pickupLat);
      payload.pickup_longitude = Number(params.pickupLng);
    }
    if (params.deliveryLat != null && params.deliveryLng != null) {
      payload.dropoff_latitude = Number(params.deliveryLat);
      payload.dropoff_longitude = Number(params.deliveryLng);
    }

    try {
      const res = await fetch(`${baseUrl}/v1/customers/${customerId}/delivery_quotes`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      const rawText = await res.text();
      if (!res.ok) {
        logger.error(`[Uber Direct Quote] HTTP ${res.status}:`, rawText);
        let errorMsg = "API quote request failed";
        try {
          const errObj = JSON.parse(rawText);
          errorMsg = errObj.message || errObj.error || errorMsg;
        } catch {}
        return {
          provider: "Uber Direct",
          providerCode: "uber",
          quotedFee: 0,
          estimatedMinutes: 0,
          available: false,
          vehicleType: "Uber Direct Hyperlocal",
          raw: rawText,
          error: errorMsg,
        };
      }

      const data = JSON.parse(rawText);
      const fee = Number(data.fee || 0) / 100;
      const duration = Number(data.duration || 0);

      return {
        provider: "Uber Direct",
        providerCode: "uber",
        quotedFee: fee,
        estimatedMinutes: duration,
        pickupDuration: Number(data.pickup_duration || 0),
        available: true,
        vehicleType: "Uber Direct Hyperlocal",
        raw: data,
      };
    } catch (err: any) {
      logger.error("[Uber Direct API Error]", err);
      return {
        provider: "Uber Direct",
        providerCode: "uber",
        quotedFee: 0,
        estimatedMinutes: 0,
        available: false,
        vehicleType: "Uber Direct Hyperlocal",
        error: err?.message || String(err),
      };
    }
  }

  /**
   * Dispatch delivery order via Uber Direct
   */
  async dispatchOrder(params: any) {
    const token = await this.authenticate();
    const { env, customerId } = this.getEnvKeys();
    if (!token || !customerId) {
      return {
        ok: false,
        orderId: params.orderId,
        providerCode: "uber",
        dispatchId: null,
        trackingUrl: null,
        status: "FAILED",
        message: "Missing or invalid Uber Direct configurations.",
      };
    }

    const isTest = env === "test" || env === "sandbox";
    const baseUrl = isTest ? "https://sandbox-api.uber.com" : "https://api.uber.com";

    try {
      const quoteRes = await this.getQuote({
        pickupPincode: params.pickupPincode ?? 500081,
        deliveryPincode: params.deliveryPincode ?? 500081,
        weightKg: 1,
        pickupAddress: params.pickupAddress,
        pickupPhone: params.pickupPhone,
        pickupLat: params.pickupLat,
        pickupLng: params.pickupLng,
        deliveryAddress: params.deliveryAddress,
        deliveryPhone: params.customerPhone,
        deliveryLat: params.deliveryLat,
        deliveryLng: params.deliveryLng,
      });

      if (!quoteRes.available || !quoteRes.raw?.id) {
        return {
          ok: false,
          orderId: params.orderId,
          providerCode: "uber",
          dispatchId: null,
          trackingUrl: null,
          status: "FAILED",
          message: `Uber Direct quote generation failed: ${quoteRes.error || "unserviceable"}`,
        };
      }

      const quoteId = quoteRes.raw.id;

      const formatPhone = (phone?: string) => {
        const cleaned = (phone ?? "").replace(/\D/g, "");
        return cleaned ? `+${cleaned}` : "+919999999999";
      };

      const pickupAddress = params.pickupAddress ?? `Hyderabad Pincode ${params.pickupPincode ?? 500081}`;
      const deliveryAddress = params.deliveryAddress ?? `Hyderabad Pincode ${params.deliveryPincode ?? 500081}`;

      const payload: Record<string, any> = {
        quote_id: quoteId,
        pickup_name: params.pickupName || "Restaurant",
        pickup_address: pickupAddress,
        pickup_phone_number: formatPhone(params.pickupPhone),
        dropoff_name: params.customerName || "Customer",
        dropoff_address: deliveryAddress,
        dropoff_phone_number: formatPhone(params.customerPhone),
        manifest_items: (params.items || [{ name: "Food Order", qty: 1, price: 100 }]).map((item: any) => ({
          name: item.name,
          quantity: item.qty || 1,
          price: Math.round((item.price || 100) * 100),
        })),
      };

      if (params.pickupLat != null && params.pickupLng != null) {
        payload.pickup_latitude = Number(params.pickupLat);
        payload.pickup_longitude = Number(params.pickupLng);
      }
      if (params.deliveryLat != null && params.deliveryLng != null) {
        payload.dropoff_latitude = Number(params.deliveryLat);
        payload.dropoff_longitude = Number(params.deliveryLng);
      }

      const res = await fetch(`${baseUrl}/v1/customers/${customerId}/deliveries`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      const rawText = await res.text();
      if (!res.ok) {
        logger.error(`[Uber Direct Dispatch Error] HTTP ${res.status}: ${rawText}`);
        let errorMsg = `HTTP ${res.status}`;
        try {
          const errObj = JSON.parse(rawText);
          errorMsg = errObj.message || errObj.code || errorMsg;
        } catch {}
        return {
          ok: false,
          orderId: params.orderId,
          providerCode: "uber",
          dispatchId: null,
          trackingUrl: null,
          status: "FAILED",
          message: `Uber Direct dispatch failed: ${errorMsg} (${rawText})`,
        };
      }

      const data = JSON.parse(rawText);
      const deliveryId = data.id || data.delivery_id;
      const trackingUrl = data.tracking_url;

      return {
        ok: true,
        orderId: params.orderId,
        providerCode: "uber",
        dispatchId: `UBR-${deliveryId}`,
        trackingUrl: trackingUrl || null,
        status: "COURIER_ASSIGNED",
        message: "Successfully created delivery order on Uber Direct.",
      };
    } catch (err: any) {
      logger.error("[Uber Direct Dispatch Error]", err);
      return {
        ok: false,
        orderId: params.orderId,
        providerCode: "uber",
        dispatchId: null,
        trackingUrl: null,
        status: "FAILED",
        message: err?.message || String(err),
      };
    }
  }

  /**
   * Cancel a delivery order on Uber Direct
   */
  async cancelDelivery(deliveryId: string) {
    const cleanId = deliveryId.replace(/^UBR-/, "");
    const token = await this.authenticate();
    const { env, customerId } = this.getEnvKeys();
    if (!token || !customerId) {
      return { ok: false, message: "Missing Uber Direct credentials" };
    }

    const isTest = env === "test" || env === "sandbox";
    const baseUrl = isTest ? "https://sandbox-api.uber.com" : "https://api.uber.com";

    try {
      const res = await fetch(`${baseUrl}/v1/customers/${customerId}/deliveries/${cleanId}/cancel`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      });

      const rawText = await res.text();
      if (!res.ok) {
        logger.error(`[Uber Direct Cancel Error] HTTP ${res.status}: ${rawText}`);
        return { ok: false, status: res.status, raw: rawText };
      }

      const data = rawText ? JSON.parse(rawText) : {};
      return { ok: true, data };
    } catch (err: any) {
      logger.error("[Uber Direct Cancel Exception]", err);
      return { ok: false, error: err?.message || String(err) };
    }
  }
}
