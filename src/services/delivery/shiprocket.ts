import { logger } from '../logger.js';
/**
 * Shiprocket Quick Delivery Integration Service
 * 
 * Provides rate quote, order dispatch, and live tracking capabilities
 * for 2-wheeler hyperlocal shipments (aggregates Rapido Parcel, Dunzo, Shadowfax).
 */

export interface ShiprocketQuoteParams {
  pickupPincode: number;
  deliveryPincode: number;
  weightKg?: number;
  declaredValue?: number;
  pickupLat?: number | null;
  pickupLng?: number | null;
  deliveryLat?: number | null;
  deliveryLng?: number | null;
}

export interface ShiprocketQuoteResponse {
  provider: string;
  providerCode: "shiprocket";
  quotedFee: number;
  estimatedMinutes: number;
  available: boolean;
  vehicleType: string;
  underlyingCarrier?: string;
  error?: string;
  raw?: any;
}

export interface ShiprocketDispatchParams {
  orderId: number;
  customerName: string;
  customerPhone: string;
  deliveryAddress: string;
  deliveryLat?: number | null;
  deliveryLng?: number | null;
  pickupAddress?: string;
  pickupLat?: number | null;
  pickupLng?: number | null;
  items?: Array<{ name: string; qty: number; price: number }>;
  subTotal?: number;
}

export class ShiprocketDeliveryService {
  private email: string;
  private password?: string;
  private token: string | null = null;
  private baseUrl: string = "https://apiv2.shiprocket.in/v1/external";

  constructor() {
    this.email = process.env.SHIPROCKET_API_EMAIL || "";
    this.password = process.env.SHIPROCKET_API_PASSWORD || "";
  }

  /**
   * Authenticate and get bearer token
   */
  private async authenticate(): Promise<string | null> {
    if (this.token) return this.token;
    if (!this.email || !this.password) return null;

    try {
      const res = await fetch(`${this.baseUrl}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: this.email, password: this.password }),
      });

      if (!res.ok) return null;
      const data = (await res.json()) as { token?: string };
      this.token = data.token || null;
      return this.token;
    } catch {
      return null;
    }
  }

  /**
   * Get delivery serviceability quote from Shiprocket Quick
   */
  async getQuote(params: ShiprocketQuoteParams): Promise<ShiprocketQuoteResponse> {
    const token = await this.authenticate();

    if (token) {
      try {
        const queryParams: Record<string, string> = {
          pickup_postcode: params.pickupPincode.toString(),
          delivery_postcode: params.deliveryPincode.toString(),
          weight: (params.weightKg || 0.5).toString(),
          cod: "0",
        };

        if (params.pickupLat && params.pickupLng && params.deliveryLat && params.deliveryLng) {
          queryParams.is_new_hyperlocal = "1";
          queryParams.lat_from = params.pickupLat.toString();
          queryParams.long_from = params.pickupLng.toString();
          queryParams.lat_to = params.deliveryLat.toString();
          queryParams.long_to = params.deliveryLng.toString();
        }

        const query = new URLSearchParams(queryParams);
        const res = await fetch(`${this.baseUrl}/courier/serviceability?${query}`, {
          headers: { Authorization: `Bearer ${token}` },
        });

        if (res.ok) {
          const data = (await res.json()) as any;
          let couriers: Array<{ name: string; rate: number; etd: string; etd_hours: number | null }> = [];
          
          if (data.data && Array.isArray(data.data)) {
            // Hyperlocal response structure
            couriers = data.data.map((c: any) => ({
              id: c.courier_company_id || c.courier_id || c.id,
              name: c.courier_name || "Shiprocket Quick",
              rate: Number(c.rates || c.rate || 0),
              etd: c.etd || `${c.etd_hours || 1} hour`,
              etd_hours: c.etd_hours ? Number(c.etd_hours) : null,
            }));
          } else if (data.data?.available_courier_companies) {
            // Standard domestic response structure
            couriers = data.data.available_courier_companies.map((c: any) => ({
              id: c.courier_company_id || c.courier_id || c.id,
              name: c.courier_name,
              rate: Number(c.rate || c.rates || 0),
              etd: c.etd,
              etd_hours: c.etd_hours ? Number(c.etd_hours) : null,
            }));
          }

          if (couriers.length > 0) {
            const cheapest = couriers.reduce((prev, curr) => (curr.rate < prev.rate ? curr : prev));
            
            let estimatedMinutes = 0;
            if (cheapest.etd_hours != null && !isNaN(cheapest.etd_hours) && cheapest.etd_hours > 0) {
              estimatedMinutes = Math.round(cheapest.etd_hours * 60);
            } else if (cheapest.etd) {
              const etdLower = cheapest.etd.toLowerCase();
              if (etdLower.includes("hour")) {
                const hrs = parseFloat(etdLower.match(/(\d+(\.\d+)?)/)?.[0] || "0");
                estimatedMinutes = Math.round(hrs * 60);
              } else if (etdLower.includes("min")) {
                estimatedMinutes = parseInt(etdLower.match(/\d+/)?.[0] || "0", 10);
              } else {
                const parsedDate = Date.parse(cheapest.etd);
                if (!isNaN(parsedDate)) {
                  const diff = parsedDate - Date.now();
                  if (diff > 0) {
                    estimatedMinutes = Math.round(diff / 60000);
                  }
                }
              }
            }

            let vehicleType = "2-Wheeler Hyperlocal";
            const carrierLower = cheapest.name.toLowerCase();
            if (carrierLower.includes("surface") || carrierLower.includes("air") || carrierLower.includes("express")) {
              vehicleType = "E-Commerce Delivery Courier";
            } else if (carrierLower.includes("quick") || carrierLower.includes("rapido") || carrierLower.includes("dunzo") || carrierLower.includes("shadowfax") || carrierLower.includes("porter")) {
              vehicleType = "2-Wheeler Motorbike (Hyperlocal)";
            }

            return {
               provider: "Shiprocket Quick",
               providerCode: "shiprocket",
               quotedFee: cheapest.rate,
               estimatedMinutes,
               available: true,
               vehicleType,
               underlyingCarrier: cheapest.name,
               raw: data,
             };
           } else {
             return {
               provider: "Shiprocket Quick",
               providerCode: "shiprocket",
               quotedFee: 0,
               estimatedMinutes: 0,
               available: false,
               vehicleType: "2-Wheeler Hyperlocal",
               error: "No serviceable couriers returned by Shiprocket.",
               raw: data,
             };
           }
        } else {
          const text = await res.text();
          let errStr = text;
          try {
            const parsed = JSON.parse(text);
            errStr = parsed.message || parsed.errors?.join(", ") || text;
          } catch {}
          return {
            provider: "Shiprocket Quick",
            providerCode: "shiprocket",
            quotedFee: 0,
            estimatedMinutes: 0,
            available: false,
            vehicleType: "2-Wheeler Hyperlocal",
            error: errStr || `HTTP error ${res.status}`,
            raw: text,
          };
        }
      } catch (err: any) {
        logger.error("[Shiprocket API Error]", err);
        return {
          provider: "Shiprocket Quick",
          providerCode: "shiprocket",
          quotedFee: 0,
          estimatedMinutes: 0,
          available: false,
          vehicleType: "2-Wheeler Hyperlocal",
          error: err?.message || String(err),
        };
      }
    }

    return {
      provider: "Shiprocket Quick",
      providerCode: "shiprocket",
      quotedFee: 0,
      estimatedMinutes: 0,
      available: false,
      vehicleType: "2-Wheeler Hyperlocal",
      error: "Authentication failed. Check your Shiprocket credentials in .env.",
    };
  }

  /**
   * Dispatch delivery order via Shiprocket Quick
   */
  async dispatchOrder(params: ShiprocketDispatchParams) {
    const token = await this.authenticate();

    if (token) {
      try {
        const nameParts = params.customerName.trim().split(/\s+/);
        const firstName = nameParts[0] || "Customer";
        const lastName = nameParts.slice(1).join(" ") || "Customer";

        const cleanPhone = params.customerPhone.replace(/^(\+?91)/, "").trim();

        const cleanAddress = params.deliveryAddress
          .replace(/\b[A-Z0-9]{4}\+[A-Z0-9]{2,4}\b/g, "")
          .replace(/Telangana|India|- 500\d{3}|500\d{3}/gi, "")
          .replace(/\s+/g, " ")
          .trim();

        const pincodeMatch = params.deliveryAddress.match(/(\d{6})\s*$/) || params.deliveryAddress.match(/\b(\d{6})\b/);
        const billingPincode = pincodeMatch ? Number(pincodeMatch[1]) : 500081;

        const orderItems = params.items && params.items.length > 0
          ? params.items.map((item, idx) => ({
              name: item.name,
              qty: item.qty,
              price: item.price,
              selling_price: item.price,
              units: item.qty,
              sku: `ITEM_${idx + 1}`,
              category_name: "Food",
              category: "Food",
            }))
          : [{
              name: "Food Package",
              qty: 1,
              price: params.subTotal || 1,
              selling_price: params.subTotal || 1,
              units: 1,
              sku: "FOOD01",
              category_name: "Food",
              category: "Food",
            }];

        const orderSubTotal = params.subTotal && params.subTotal > 0
          ? params.subTotal
          : orderItems.reduce((acc, i) => acc + i.price * i.qty, 0);

        const orderData = {
          order_id: `${params.orderId}_${Date.now().toString().slice(-4)}`,
          order_date: new Date().toISOString().split("T")[0],
          pickup_location: process.env.SHIPROCKET_PICKUP_LOCATION || "work",
          billing_customer_name: firstName,
          billing_last_name: lastName,
          billing_phone: cleanPhone,
          billing_address: cleanAddress,
          billing_city: "Hyderabad",
          billing_state: "Telangana",
          billing_pincode: billingPincode,
          billing_country: "India",
          shipping_is_billing: true,
          shipping_pincode: billingPincode,
          latitude: params.deliveryLat || 17.420299,
          longitude: params.deliveryLng || 78.382698,
          is_hyperlocal: 1,
          shipping_method: "HL",
          ...(params.pickupLat && { lat_from: params.pickupLat.toString() }),
          ...(params.pickupLng && { long_from: params.pickupLng.toString() }),
          ...(params.deliveryLat && { lat_to: params.deliveryLat.toString() }),
          ...(params.deliveryLng && { long_to: params.deliveryLng.toString() }),
          order_items: orderItems,
          payment_method: "Prepaid",
          sub_total: orderSubTotal,
          length: 10,
          breadth: 10,
          height: 10,
          weight: 0.5,
        };

        logger.info(`Sending Shiprocket Quick Order Payload: ${JSON.stringify(orderData)}`);

        const createRes = await fetch(`${this.baseUrl}/orders/create/adhoc`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(orderData),
        });

        if (!createRes.ok) {
          const errText = await createRes.text();
          logger.error(`Shiprocket Order Creation Error (${createRes.status}): ${errText}`);
          return { ok: false, error: `Shiprocket API error (${createRes.status}): ${errText}` };
        }

        const createResult = (await createRes.json()) as { shipment_id?: number; order_id?: number };
        logger.info(`Shiprocket Order Created Response: ${JSON.stringify(createResult)}`);

        const shipmentId = createResult.shipment_id;
        const externalOrderId = createResult.order_id;
        let awbCode = "";
        let courierName = "Shiprocket Quick";

        if (shipmentId) {
          try {
            const awbRes = await fetch(`${this.baseUrl}/courier/assign/awb`, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ shipment_id: shipmentId, is_hyperlocal: 1 }),
            });

            if (awbRes.ok) {
              const awbData = (await awbRes.json()) as any;
              logger.info(`Shiprocket Quick AWB Response: ${JSON.stringify(awbData)}`);
              awbCode = awbData.response?.data?.awb_code || "";
              courierName = awbData.response?.data?.courier_name || "Shiprocket Quick";
            }
          } catch (awbErr) {
            logger.error("[Shiprocket Auto-Ship Error]", awbErr);
          }
        }

        return {
          ok: true,
          orderId: params.orderId,
          providerCode: "shiprocket",
          dispatchId: awbCode || `SR-${externalOrderId || shipmentId}`,
          trackingUrl: `https://quick.shiprocket.in/tracking/${shipmentId}`,
          status: "BOOKED",
          message: `Successfully dispatched order directly to Shiprocket Quick (SEARCHING FOR RIDER).`,
        };
      } catch (err) {
        logger.error("[Shiprocket Dispatch Error]", err);
        return {
          ok: false,
          orderId: params.orderId,
          providerCode: "shiprocket",
          dispatchId: null,
          trackingUrl: null,
          status: "FAILED",
          message: `Failed to dispatch order to Shiprocket Quick: ${err}`,
        };
      }
    }

    return {
      ok: false,
      orderId: params.orderId,
      providerCode: "shiprocket",
      dispatchId: null,
      trackingUrl: null,
      status: "FAILED",
      message: "Could not create the delivery order on Shiprocket Quick. Check credentials or API availability.",
    };
  }

  /**
   * Tracking is served from the DeliveryDispatch row that provider webhooks
   * keep current — see DeliveryOrchestrator.getTrackingStatus.
   */
}
