/**
 * Borzo (WeFast Express) Delivery Integration Service
 * 
 * Provides rate estimation, order creation, and courier tracking capabilities
 * for Borzo 2-wheeler express courier network in Hyderabad.
 */

export interface BorzoQuoteParams {
  pickupPincode: number;
  deliveryPincode: number;
  weightKg?: number;
}

export interface BorzoQuoteResponse {
  provider: string;
  providerCode: "borzo";
  quotedFee: number;
  estimatedMinutes: number;
  available: boolean;
  vehicleType: string;
}

export interface BorzoDispatchParams {
  orderId: number;
  customerName: string;
  customerPhone: string;
  deliveryAddress: string;
}

export class BorzoDeliveryService {
  private apiToken: string;
  private baseUrl: string;

  constructor() {
    this.apiToken = process.env.BORZO_API_TOKEN || "";
    // Sandbox unless BORZO_ENV is explicitly "production". This used to also force
    // sandbox for any token starting with the old test token's prefix, which meant
    // BORZO_ENV=production silently did nothing.
    const isSandbox = (process.env.BORZO_ENV ?? "sandbox") !== "production";
    this.baseUrl = isSandbox
      ? "https://robotapitest-in.borzodelivery.com/api/business/1.8"
      : "https://robot-in.borzodelivery.com/api/business/1.8";
  }

  /**
   * Get delivery quote / calculation from Borzo API
   */
  async getQuote(params: BorzoQuoteParams): Promise<BorzoQuoteResponse> {
    if (this.apiToken) {
      try {
        const res = await fetch(`${this.baseUrl}/calculate-order`, {
          method: "POST",
          headers: {
            "X-DV-Auth-Token": this.apiToken,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            matter: "Food parcel",
            points: [
              { address: `Hyderabad Pincode ${params.pickupPincode}` },
              { address: `Hyderabad Pincode ${params.deliveryPincode}` },
            ],
          }),
        });

        if (res.ok) {
          const data = (await res.json()) as {
            is_successful?: boolean;
            order?: { payment_amount?: string; delivery_fee_amount?: string };
          };
          if (data.is_successful && data.order) {
            const amount = Number(data.order.payment_amount || data.order.delivery_fee_amount || 52);
            return {
              provider: "Borzo Express",
              providerCode: "borzo",
              quotedFee: amount,
              estimatedMinutes: 28,
              available: true,
              vehicleType: "2-Wheeler Express Courier",
            };
          }
        }
      } catch (err) {
        console.error("[Borzo API Error, using fallback]", err);
      }
    }

    // No invented fee. A made-up number here becomes the amount the customer is
    // actually charged, so an unavailable quote must report itself unavailable
    // and let the caller fall back to the flat rate deliberately.
    return {
      provider: "Borzo Express",
      providerCode: "borzo",
      quotedFee: 0,
      estimatedMinutes: 0,
      available: false,
      vehicleType: "2-Wheeler Express Courier",
    };
  }

  /**
   * Dispatch delivery order via Borzo
   */
  async dispatchOrder(params: BorzoDispatchParams) {
    const mockDispatchId = `BRZ-${Date.now().toString().slice(-7)}`;

    if (this.apiToken) {
      try {
        const res = await fetch(`${this.baseUrl}/create-order`, {
          method: "POST",
          headers: {
            "X-DV-Auth-Token": this.apiToken,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            matter: `Food Order #${params.orderId}`,
            points: [
              {
                address: "Godavari Ruchulu, Jubilee Hills, Hyderabad",
                contact_person: { phone: "+919999999999" },
              },
              {
                address: params.deliveryAddress,
                contact_person: {
                  name: params.customerName,
                  phone: params.customerPhone,
                },
              },
            ],
          }),
        });

        if (res.ok) {
          const data = (await res.json()) as { is_successful?: boolean; order?: { order_id?: number } };
          if (data.is_successful && data.order?.order_id) {
            return {
              ok: true,
              orderId: params.orderId,
              providerCode: "borzo",
              dispatchId: `BRZ-${data.order.order_id}`,
              trackingUrl: `https://borzodelivery.com/in/track/${data.order.order_id}`,
              status: "COURIER_ASSIGNED",
              message: "Successfully created delivery order on Borzo Express.",
            };
          }
        }
      } catch (err) {
        console.error("[Borzo Dispatch Error, using fallback]", err);
      }
    }

    // Report the failure honestly. This used to return ok:true with a fabricated
    // dispatch id and tracking URL, so a failed dispatch looked successful and
    // the customer was told a courier was coming when none had been booked.
    return {
      ok: false,
      orderId: params.orderId,
      providerCode: "borzo",
      dispatchId: null,
      trackingUrl: null,
      status: "FAILED",
      message: "Could not create the delivery order on Borzo.",
    };
  }
}
