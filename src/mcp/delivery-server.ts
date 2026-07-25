/**
 * Delivery MCP (Model Context Protocol) Server
 * 
 * Exposes standardized MCP tools for hyperlocal logistics dispatch across:
 *   - Shiprocket Quick (aggregating Rapido Parcel)
 *   - Shadowfax Hyperlocal
 *   - Borzo Express
 *   - Direct Rapido Partner Fleet
 * 
 * Usage:
 *   npx tsx src/mcp/delivery-server.ts
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DeliveryOrchestrator, DeliveryProviderCode } from "../services/delivery/orchestrator.js";

// Initialize Delivery Orchestrator
const orchestrator = new DeliveryOrchestrator();

// Create MCP Server Instance
const server = new McpServer({
  name: "exter-ai-delivery-mcp",
  version: "1.0.0",
});

// ─────────────────────────────────────────────────────────────────────────────
// TOOL 1: Check Serviceability & Fetch Real-Time Competitive Quotes
// ─────────────────────────────────────────────────────────────────────────────
server.tool(
  "get_delivery_quotes",
  "Fetch competitive delivery quotes and ETAs across Rapido Parcel, Shiprocket Quick, Shadowfax, and Borzo for pickup/drop pincodes in Hyderabad.",
  {
    pickupPincode: z.number().describe("Pickup location pincode (e.g. 500033 for Jubilee Hills)"),
    deliveryPincode: z.number().describe("Customer drop pincode (e.g. 500081 for Madhapur)"),
    weightKg: z.number().optional().default(0.5).describe("Shipment weight in kg"),
  },
  async ({ pickupPincode, deliveryPincode, weightKg }) => {
    try {
      const quotesData = await orchestrator.getAllQuotes({
        pickupPincode,
        deliveryPincode,
        weightKg,
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
// TOOL 2: Dispatch Order to Selected Provider (Rapido / Shiprocket / Shadowfax / Borzo)
// ─────────────────────────────────────────────────────────────────────────────
server.tool(
  "dispatch_delivery_order",
  "Dispatch delivery order to selected provider (rapido, shiprocket, shadowfax, borzo) and generate live tracking URL.",
  {
    orderId: z.number().describe("Internal Order ID"),
    providerCode: z.enum(["rapido", "shiprocket", "shadowfax", "borzo", "porter"]).describe("Selected provider code"),
    customerName: z.string().describe("Customer recipient name"),
    customerPhone: z.string().describe("Customer contact phone number"),
    deliveryAddress: z.string().describe("Complete drop delivery address"),
  },
  async ({ orderId, providerCode, customerName, customerPhone, deliveryAddress }) => {
    try {
      const dispatchResult = await orchestrator.dispatchOrder({
        orderId,
        providerCode: providerCode as DeliveryProviderCode,
        customerName,
        customerPhone,
        deliveryAddress,
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
// TOOL 3: Fetch Live Rider Tracking Details
// ─────────────────────────────────────────────────────────────────────────────
server.tool(
  "get_delivery_tracking_status",
  "Fetch live rider tracking details, GPS coordinates, and status for active dispatch.",
  {
    dispatchId: z.string().describe("Dispatch / Tracking ID (e.g., SR-12345, SFX-98765, BRZ-54321)"),
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

// Start server over Stdio transport
async function startServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("🚀 Delivery MCP Server active over Stdio transport!");
}

startServer().catch((err) => {
  console.error("Fatal error starting Delivery MCP Server:", err);
  process.exit(1);
});
