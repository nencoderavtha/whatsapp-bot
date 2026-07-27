/**
 * Delivery MCP (Model Context Protocol) Server
 *
 * Exposes standardized MCP tools for hyperlocal logistics dispatch across:
 *   - Shiprocket Quick (aggregating Rapido Parcel)
 *   - Shadowfax Hyperlocal  ← fully integrated with staging/prod toggle
 *   - Borzo Express
 *   - Direct Rapido Partner Fleet (placeholder)
 *
 * Usage:
 *   npx tsx src/mcp/delivery-server.ts
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DeliveryOrchestrator, DeliveryProviderCode } from "../services/delivery/orchestrator.js";
import { ShadowfaxDeliveryService } from "../services/delivery/shadowfax.js";
import { logger } from '../services/logger.js';

// ─── Singletons ────────────────────────────────────────────────────────────────
const orchestrator = new DeliveryOrchestrator();
const shadowfax = new ShadowfaxDeliveryService();

// ─── MCP Server Instance ───────────────────────────────────────────────────────
const server = new McpServer({
  name: "exter-ai-delivery-mcp",
  version: "1.1.0",
});

// ─────────────────────────────────────────────────────────────────────────────
// TOOL 1: Competitive Quotes — all providers in parallel
// ─────────────────────────────────────────────────────────────────────────────
server.tool(
  "get_delivery_quotes",
  "Fetch competitive delivery quotes and ETAs across Shiprocket Quick, Shadowfax Hyperlocal, and Borzo Express for a pickup/drop route in Hyderabad. Optionally pass lat/lng for improved Shadowfax accuracy.",
  {
    pickupPincode: z.number().describe("Pickup location pincode (e.g. 500033 for Jubilee Hills)"),
    deliveryPincode: z.number().describe("Customer drop pincode (e.g. 500081 for Madhapur)"),
    weightKg: z.number().optional().default(0.5).describe("Shipment weight in kg (default 0.5)"),
    pickupLat: z.number().optional().describe("Pickup latitude — improves Shadowfax geo-accuracy"),
    pickupLng: z.number().optional().describe("Pickup longitude — improves Shadowfax geo-accuracy"),
    deliveryLat: z.number().optional().describe("Drop latitude — improves Shadowfax geo-accuracy"),
    deliveryLng: z.number().optional().describe("Drop longitude — improves Shadowfax geo-accuracy"),
  },
  async ({ pickupPincode, deliveryPincode, weightKg, pickupLat, pickupLng, deliveryLat, deliveryLng }) => {
    try {
      const quotesData = await orchestrator.getAllQuotes({
        pickupPincode,
        deliveryPincode,
        weightKg,
        pickupLat,
        pickupLng,
        deliveryLat,
        deliveryLng,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(quotesData, null, 2),
          },
        ],
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: "text", text: `Error fetching delivery quotes: ${errorMessage}` }],
      };
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// TOOL 2: Shadowfax Serviceability Check (dedicated)
// ─────────────────────────────────────────────────────────────────────────────
server.tool(
  "check_shadowfax_serviceability",
  "Check if Shadowfax covers a specific pickup→drop route and get a real-time delivery fee + ETA. Supports both pincode-only and lat/lng-precision checks.",
  {
    pickupPincode: z.number().describe("Pickup pincode"),
    deliveryPincode: z.number().describe("Drop pincode"),
    pickupLat: z.number().optional().describe("Pickup latitude for geo-precision"),
    pickupLng: z.number().optional().describe("Pickup longitude for geo-precision"),
    deliveryLat: z.number().optional().describe("Drop latitude for geo-precision"),
    deliveryLng: z.number().optional().describe("Drop longitude for geo-precision"),
  },
  async ({ pickupPincode, deliveryPincode, pickupLat, pickupLng, deliveryLat, deliveryLng }) => {
    try {
      const result = await shadowfax.getQuote({
        pickupPincode,
        deliveryPincode,
        pickupLat,
        pickupLng,
        deliveryLat,
        deliveryLng,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: "text", text: `Error checking Shadowfax serviceability: ${errorMessage}` }],
      };
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// TOOL 3: Dispatch Order to Selected Provider
// ─────────────────────────────────────────────────────────────────────────────
server.tool(
  "dispatch_delivery_order",
  "Dispatch a delivery order to the selected provider (shiprocket, shadowfax, borzo, rapido) and return a live tracking URL.",
  {
    orderId: z.number().describe("Internal Order ID"),
    providerCode: z
      .enum(["rapido", "shiprocket", "shadowfax", "borzo", "porter"])
      .describe("Selected delivery provider code"),
    customerName: z.string().describe("Customer recipient name"),
    customerPhone: z.string().describe("Customer phone number (with country code preferred)"),
    deliveryAddress: z.string().describe("Full drop address including area, city, pincode"),
    pickupAddress: z.string().optional().describe("Override pickup address (defaults to Godavari Ruchulu Jubilee Hills)"),
  },
  async ({ orderId, providerCode, customerName, customerPhone, deliveryAddress, pickupAddress }) => {
    try {
      const dispatchResult = await orchestrator.dispatchOrder({
        orderId,
        providerCode: providerCode as DeliveryProviderCode,
        customerName,
        customerPhone,
        deliveryAddress,
        pickupAddress,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(dispatchResult, null, 2),
          },
        ],
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: "text", text: `Error dispatching delivery order: ${errorMessage}` }],
      };
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// TOOL 4: Live Rider Tracking
// ─────────────────────────────────────────────────────────────────────────────
server.tool(
  "get_delivery_tracking_status",
  "Fetch live rider tracking details — GPS coordinates, status, ETA — for an active dispatch. Provider is auto-detected from the dispatch ID prefix (SFX- = Shadowfax, BRZ- = Borzo, SR- = Shiprocket).",
  {
    dispatchId: z.string().describe("Dispatch / Tracking ID (e.g., SFX-1234567, BRZ-9876543, SR-1234567)"),
  },
  async ({ dispatchId }) => {
    try {
      const trackingResult = await orchestrator.getTrackingStatus(dispatchId);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(trackingResult, null, 2),
          },
        ],
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: "text", text: `Error fetching tracking status: ${errorMessage}` }],
      };
    }
  }
);

// ─── Start Server ──────────────────────────────────────────────────────────────
async function startServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.error("🚀 Delivery MCP Server v1.1.0 active over Stdio transport!");
  logger.error("   Tools: get_delivery_quotes | check_shadowfax_serviceability | dispatch_delivery_order | get_delivery_tracking_status");
}

startServer().catch((err) => {
  logger.error("Fatal error starting Delivery MCP Server:", err);
  process.exit(1);
});
