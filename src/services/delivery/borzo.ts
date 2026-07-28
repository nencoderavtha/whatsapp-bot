import { logger } from '../logger.js';
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

  /**
   * Precise routing. Borzo geocodes whatever address string it is given, so a
   * synthesised "Hyderabad Pincode 500033" resolves to the pincode centroid and
   * the fee is computed between centroids rather than the real pickup and drop.
   * On a measured Jubilee Hills → Gachibowli run that was ₹73 against a true
   * ₹140, i.e. the restaurant absorbing the difference. Pass the pinned address
   * and coordinates whenever they are known.
   */
  pickupAddress?: string;
  pickupLat?: number | null;
  pickupLng?: number | null;
  pickupPhone?: string;
  deliveryAddress?: string;
  deliveryLat?: number | null;
  deliveryLng?: number | null;
  deliveryPhone?: string;
}

/** Borzo wants E.164; ownerNumbers are stored bare, e.g. "917842766505". */
function e164(phone: string): string {
  const digits = (phone ?? "").replace(/\D/g, "");
  return digits ? `+${digits}` : "";
}

/** Borzo warns on points without a contact phone and prices them anyway. */
function borzoPoint(
  address: string,
  lat: number | null | undefined,
  lng: number | null | undefined,
  name: string,
  phone: string,
): Record<string, unknown> {
  const point: Record<string, unknown> = {
    address,
    contact_person: { name, phone: e164(phone) },
  };
  if (lat != null && lng != null) {
    point.latitude = String(lat);
    point.longitude = String(lng);
  }
  return point;
}

export interface BorzoQuoteResponse {
  provider: string;
  providerCode: "borzo";
  quotedFee: number;
  estimatedMinutes: number;
  available: boolean;
  vehicleType: string;
  error?: string;
}

export interface BorzoDispatchParams {
  orderId: number;
  customerName: string;
  customerPhone: string;
  deliveryAddress: string;
  deliveryLat?: number | null;
  deliveryLng?: number | null;
  /** Restaurant pickup details — the rider calls pickupPhone on arrival. */
  pickupName?: string;
  pickupAddress?: string;
  pickupLat?: number | null;
  pickupLng?: number | null;
  pickupPhone?: string;
}

export class BorzoDeliveryService {
  private apiToken: string;
  private baseUrl: string;

  constructor(forceEnv?: "sandbox" | "production") {
    const env = forceEnv || process.env.BORZO_ENV || "sandbox";
    const isSandbox = env !== "production";
    this.apiToken = (isSandbox ? process.env.BORZO_API_TOKEN : process.env.BORZO_PROD_API_TOKEN) || "";
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
            total_weight_kg: params.weightKg ?? 1,
            points: [
              borzoPoint(
                params.pickupAddress ?? `Hyderabad Pincode ${params.pickupPincode}`,
                params.pickupLat,
                params.pickupLng,
                "Pickup",
                params.pickupPhone ?? "",
              ),
              borzoPoint(
                params.deliveryAddress ?? `Hyderabad Pincode ${params.deliveryPincode}`,
                params.deliveryLat,
                params.deliveryLng,
                "Customer",
                params.deliveryPhone ?? params.pickupPhone ?? "",
              ),
            ],
          }),
        });

        if (res.ok) {
          const data = (await res.json()) as {
            is_successful?: boolean;
            order?: {
              payment_amount?: string;
              delivery_fee_amount?: string;
              points?: Array<{ previous_point_driving_distance_meters?: number }>;
            };
            errors?: string[];
            parameter_warnings?: unknown;
          };

          if (data.parameter_warnings) {
            logger.warn(
              "[Borzo] Quote returned parameter warnings:",
              JSON.stringify(data.parameter_warnings),
            );
          }

          if (data.is_successful && data.order) {
            const amount = Number(data.order.payment_amount || data.order.delivery_fee_amount || 52);
            const deliveryPoint = data.order.points?.[1] || data.order.points?.find((p: any) => p.point_type === "delivery");
            const distanceMeters = deliveryPoint?.previous_point_driving_distance_meters || 0;
            let estimatedMinutes = 28;
            if (distanceMeters > 0) {
              const distanceKm = distanceMeters / 1000;
              estimatedMinutes = Math.round(distanceKm * 3 + 10);
            }

            return {
              provider: "Borzo Express",
              providerCode: "borzo",
              quotedFee: amount,
              estimatedMinutes,
              available: true,
              vehicleType: "2-Wheeler Express Courier",
            };
          } else {
            return {
              provider: "Borzo Express",
              providerCode: "borzo",
              quotedFee: 0,
              estimatedMinutes: 0,
              available: false,
              vehicleType: "2-Wheeler Express Courier",
              error: data.errors?.join(", ") || "Validation failed or no route available.",
            };
          }
        } else {
          const text = await res.text();
          let errStr = text;
          try {
            const parsed = JSON.parse(text);
            errStr = parsed.errors?.join(", ") || parsed.message || text;
          } catch {}
          return {
            provider: "Borzo Express",
            providerCode: "borzo",
            quotedFee: 0,
            estimatedMinutes: 0,
            available: false,
            vehicleType: "2-Wheeler Express Courier",
            error: errStr || `HTTP error ${res.status}`,
          };
        }
      } catch (err: any) {
        logger.error("[Borzo API Error]", err);
        return {
          provider: "Borzo Express",
          providerCode: "borzo",
          quotedFee: 0,
          estimatedMinutes: 0,
          available: false,
          vehicleType: "2-Wheeler Express Courier",
          error: err?.message || String(err),
        };
      }
    }

    return {
      provider: "Borzo Express",
      providerCode: "borzo",
      quotedFee: 0,
      estimatedMinutes: 0,
      available: false,
      vehicleType: "2-Wheeler Express Courier",
      error: "No Borzo API token configured in .env",
    };
  }

  /**
   * Dispatch delivery order via Borzo
   */
  async dispatchOrder(params: BorzoDispatchParams) {
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
            total_weight_kg: 1,
            points: [
              borzoPoint(
                params.pickupAddress ?? "Godavari Ruchulu, MLA Colony, Jubilee Hills, Hyderabad",
                params.pickupLat,
                params.pickupLng,
                params.pickupName ?? "Restaurant",
                // The rider calls this number on arrival. It used to be the
                // placeholder +919999999999, which reaches nobody.
                params.pickupPhone ?? "",
              ),
              borzoPoint(
                params.deliveryAddress,
                params.deliveryLat,
                params.deliveryLng,
                params.customerName,
                params.customerPhone,
              ),
            ],
          }),
        });

        const raw = await res.text();
        if (!res.ok) {
          // Log what we sent alongside the rejection. A bare "invalid_phone" on
          // points[0] is not actionable without seeing the value that produced it.
          logger.error(`[Borzo Dispatch] HTTP ${res.status}:`, raw.slice(0, 500));
          logger.error(
            "[Borzo Dispatch] payload was:",
            JSON.stringify({
              pickupAddress: params.pickupAddress,
              pickupPhone: params.pickupPhone,
              pickupLat: params.pickupLat,
              pickupLng: params.pickupLng,
              deliveryAddress: params.deliveryAddress,
              deliveryPhone: params.customerPhone,
            }),
          );
        }

        if (res.ok) {
          const data = JSON.parse(raw) as {
            is_successful?: boolean;
            order?: { order_id?: number };
            parameter_warnings?: unknown;
          };
          if (data.parameter_warnings) {
            logger.warn("[Borzo Dispatch] parameter warnings:", JSON.stringify(data.parameter_warnings));
          }
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
        logger.error("[Borzo Dispatch Error, using fallback]", err);
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
