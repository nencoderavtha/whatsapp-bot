/**
 * Delivery MCP (Model Context Protocol) Server
 *
 * Exposes standardized MCP tools for hyperlocal logistics dispatch exclusively through
 * Shiprocket Quick (aggregating Rapido Parcel, Dunzo, Shadowfax 2-wheeler fleets).
 *
 * Usage:
 *   npx tsx src/mcp/delivery-server.ts
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DeliveryOrchestrator } from "../services/delivery/orchestrator.js";
import { ShiprocketDeliveryService } from "../services/delivery/shiprocket.js";
import { logger } from "../services/logger.js";

// ─── Singletons ────────────────────────────────────────────────────────────────
const orchestrator = new DeliveryOrchestrator();
const shiprocket = new ShiprocketDeliveryService();

// ─── MCP Server Instance ───────────────────────────────────────────────────────
const server = new McpServer({
  name: "exter-ai-delivery-mcp",
  version: "1.2.0",
});

// ─────────────────────────────────────────────────────────────────────────────
// TOOL 1: Delivery Quotes (Exclusively via Shiprocket Quick)
// ─────────────────────────────────────────────────────────────────────────────
server.tool(
  "get_delivery_quotes",
  "Fetch delivery quote and ETA via Shiprocket Quick (aggregating Rapido, Dunzo, Shadowfax 2-wheeler fleets) for a pickup/drop route in Hyderabad.",
  {
    pickupPincode: z.number().describe("Pickup location pincode (e.g. 500081 for Madhapur / 500072 for KPHB)"),
    deliveryPincode: z.number().describe("Customer drop pincode (e.g. 500032 for Gachibowli / 500104 for Rai Durg)"),
    weightKg: z.number().optional().default(0.5).describe("Shipment weight in kg (default 0.5)"),
    pickupLat: z.number().optional().describe("Pickup latitude for exact coordinate routing"),
    pickupLng: z.number().optional().describe("Pickup longitude for exact coordinate routing"),
    deliveryLat: z.number().optional().describe("Drop latitude for exact coordinate routing"),
    deliveryLng: z.number().optional().describe("Drop longitude for exact coordinate routing"),
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
// TOOL 2: Dedicated Shiprocket Quick Serviceability Check
// ─────────────────────────────────────────────────────────────────────────────
server.tool(
  "check_shiprocket_quick_serviceability",
  "Directly check Shiprocket Quick serviceability and get cheapest 2-wheeler rate quote + ETA between pickup and drop locations.",
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
      const result = await shiprocket.getQuote({
        pickupPincode,
        deliveryPincode,
        weightKg: 0.5,
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
        content: [{ type: "text", text: `Error checking Shiprocket Quick serviceability: ${errorMessage}` }],
      };
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// TOOL 3: Dispatch Order via Shiprocket Quick
// ─────────────────────────────────────────────────────────────────────────────
server.tool(
  "dispatch_delivery_order",
  "Dispatch a food/parcel order exclusively via Shiprocket Quick and receive a live tracking URL and shipment ID.",
  {
    orderId: z.number().describe("Internal Order ID"),
    customerName: z.string().describe("Customer recipient name"),
    customerPhone: z.string().describe("Customer phone number"),
    deliveryAddress: z.string().describe("Full drop address including area, city, pincode"),
    deliveryLat: z.number().optional().describe("Drop latitude"),
    deliveryLng: z.number().optional().describe("Drop longitude"),
    pickupAddress: z.string().optional().describe("Override pickup address"),
    pickupLat: z.number().optional().describe("Pickup latitude"),
    pickupLng: z.number().optional().describe("Pickup longitude"),
  },
  async ({ orderId, customerName, customerPhone, deliveryAddress, deliveryLat, deliveryLng, pickupAddress, pickupLat, pickupLng }) => {
    try {
      const dispatchResult = await orchestrator.dispatchOrder({
        orderId,
        providerCode: "shiprocket",
        customerName,
        customerPhone,
        deliveryAddress,
        deliveryLat,
        deliveryLng,
        pickupAddress,
        pickupLat,
        pickupLng,
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
  "Fetch live rider tracking details (status, rider name, rider phone, vehicle number) from the database dispatch record.",
  {
    dispatchId: z.string().describe("Dispatch / Tracking ID (e.g. SR-1481144966 or 1477369298)"),
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
  logger.info("🚀 Delivery MCP Server v1.2.0 active over Stdio transport (Shiprocket Quick Exclusive)!");
  logger.info("   Tools: get_delivery_quotes | check_shiprocket_quick_serviceability | dispatch_delivery_order | get_delivery_tracking_status");
}

startServer().catch((err) => {
  logger.error("Fatal error starting Delivery MCP Server:", err);
  process.exit(1);
});
