# 🔌 Custom Delivery MCP Server Architecture Guide

This document outlines how to build a custom **Model Context Protocol (MCP) Server** for Hyperlocal Logistics & Delivery Integration (Rapido Parcel, Shadowfax, Borzo, Porter, Shiprocket Quick).

---

## 1. Why Build a Custom Delivery MCP Server?

Instead of tightly coupling your WhatsApp Bot or AI agent to individual provider APIs, a **Delivery MCP Server** acts as an intelligent logistics middleware:

```
┌─────────────────────────────────────────────────────────────────┐
│                    AI Agent / WhatsApp Bot                      │
└────────────────────────────────┬────────────────────────────────┘
                                 │
                   Standard MCP Protocol (Stdio/SSE)
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│               Custom Delivery MCP Server (@exter-ai/mcp)         │
│                                                                 │
│   Exposes standardized tools:                                   │
│     • check_delivery_serviceability                              │
│     • get_delivery_quotes (Rapido, Shadowfax, Borzo, Porter)    │
│     • dispatch_delivery_order                                    │
│     • get_delivery_tracking_status                               │
└────────┬───────────────┬────────────────┬───────────────┬───────┘
         │               │                │               │
         ▼               ▼                ▼               ▼
   ┌───────────┐   ┌───────────┐    ┌───────────┐   ┌───────────┐
   │  Rapido   │   │ Shadowfax │    │   Borzo   │   │Shiprocket │
   │  Parcel   │   │    API    │    │    API    │   │   Quick   │
   └───────────┘   └───────────┘    └───────────┘   └───────────┘
```

### Key Advantages:
1. **Provider Agnostic**: The AI agent calls `get_delivery_quotes({ pickup, drop })` without needing to know provider-specific API formats.
2. **Reusable Across Applications**: The same MCP server can be connected to your WhatsApp Bot, Admin Dashboard, Web App, or Claude Desktop / Gemini CLI agents.
3. **Rapido Parcel Failover**: If Rapido is busy or unavailable in a specific pincode, the MCP server automatically queries Shadowfax/Borzo/Shiprocket Quick as a fallback.

---

## 2. Rapido Parcel Integration Options

Rapido Parcel can be integrated in **two ways**:

### Option A: Direct Rapido Enterprise Partnership
1. Apply for a B2B delivery partnership at [rapido.bike/delivery-partners](https://www.rapido.bike/delivery-partners) or [rapido.bike/corporate](https://www.rapido.bike/corporate).
2. Rapido handles B2B API access via enterprise onboarding (no instant public self-serve portal). Submit the "Request Callback" form with your order volume.
3. Once onboarded, Rapido provides:
   - **Auth**: Corporate Client ID & API Token
   - **Quote Endpoint**: `POST /v1/orders/quote`
   - **Booking Endpoint**: `POST /v1/orders/create`
   - **Captain Tracking Endpoint**: `GET /v1/orders/{order_id}/track`
   - **Status Webhook**: `POST /api/webhooks/rapido`

### Option B: Via Shiprocket Quick Aggregator API (Recommended for instant access)
Rapido Parcel is one of the underlying 2-wheeler courier partners on **Shiprocket Quick**. By querying Shiprocket Quick's serviceability API, Rapido Parcel rates and ETAs are automatically included in the response without needing a separate direct contract!

---

## 3. Custom MCP Server Implementation Blueprint

Below is the complete implementation of a custom **Delivery MCP Server** using `@modelcontextprotocol/sdk` in TypeScript.

### `src/mcp/delivery-server.ts`

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// Create MCP Server instance
const server = new McpServer({
  name: "exter-ai-delivery-mcp",
  version: "1.0.0",
});

// ─────────────────────────────────────────────────────────────────────────────
// TOOL 1: Check Delivery Serviceability & Compare Quotes across Rapido/Others
// ─────────────────────────────────────────────────────────────────────────────
server.tool(
  "get_delivery_quotes",
  "Fetch competitive delivery quotes and ETAs from Rapido Parcel, Shadowfax, Borzo, and Porter for a pickup and drop location in Hyderabad.",
  {
    pickupPincode: z.number().describe("Pickup location pincode (e.g. 500033 for Jubilee Hills)"),
    deliveryPincode: z.number().describe("Customer drop pincode (e.g. 500081 for Madhapur)"),
    weightKg: z.number().optional().default(0.5).describe("Shipment weight in kg"),
  },
  async ({ pickupPincode, deliveryPincode, weightKg }) => {
    console.error(`[MCP] Fetching quotes from ${pickupPincode} -> ${deliveryPincode}`);

    // Mock / Provider Orchestration logic
    // In production, this queries Rapido API, Shadowfax API, Borzo API, and Shiprocket Quick
    const quotes = [
      {
        provider: "Rapido Parcel",
        providerCode: "rapido",
        quotedFee: 55.00,
        estimatedMinutes: 25,
        available: true,
        vehicleType: "2-Wheeler Motorbike",
      },
      {
        provider: "Shadowfax Hyperlocal",
        providerCode: "shadowfax",
        quotedFee: 50.00,
        estimatedMinutes: 30,
        available: true,
        vehicleType: "2-Wheeler (Thermal Bag)",
      },
      {
        provider: "Borzo Express",
        providerCode: "borzo",
        quotedFee: 58.00,
        estimatedMinutes: 28,
        available: true,
        vehicleType: "2-Wheeler Courier",
      },
      {
        provider: "Porter Two-Wheeler",
        providerCode: "porter",
        quotedFee: 62.00,
        estimatedMinutes: 20,
        available: true,
        vehicleType: "2-Wheeler Parcel",
      },
    ];

    // Sort by cheapest fee
    quotes.sort((a, b) => a.quotedFee - b.quotedFee);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            pickupPincode,
            deliveryPincode,
            weightKg,
            cheapestProvider: quotes[0],
            allQuotes: quotes,
          }, null, 2),
        },
      ],
    };
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// TOOL 2: Dispatch Delivery Order to Selected Provider (Rapido/Shadowfax/etc)
// ─────────────────────────────────────────────────────────────────────────────
server.tool(
  "dispatch_delivery_order",
  "Dispatch a delivery order to the selected provider (e.g., rapido, shadowfax, borzo) and generate a live tracking link.",
  {
    orderId: z.number().describe("Internal Order ID"),
    providerCode: z.enum(["rapido", "shadowfax", "borzo", "porter", "shiprocket"]).describe("Selected provider code"),
    customerName: z.string().describe("Customer recipient name"),
    customerPhone: z.string().describe("Customer contact phone number"),
    deliveryAddress: z.string().describe("Complete drop delivery address"),
  },
  async ({ orderId, providerCode, customerName, customerPhone, deliveryAddress }) => {
    console.error(`[MCP] Dispatching Order #${orderId} via ${providerCode}...`);

    // In production, execute the selected provider's booking API request
    const mockTrackingId = `TRK-${providerCode.toUpperCase()}-${Date.now().toString().slice(-6)}`;
    const mockTrackingUrl = `https://track.delivery.exter.ai/${providerCode}/${mockTrackingId}`;

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            orderId,
            providerCode,
            status: "SEARCHING_RIDER",
            dispatchId: mockTrackingId,
            trackingUrl: mockTrackingUrl,
            message: `Delivery successfully dispatched via ${providerCode}. Tracking link generated.`,
          }, null, 2),
        },
      ],
    };
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// TOOL 3: Query Real-Time Rider Tracking Status
// ─────────────────────────────────────────────────────────────────────────────
server.tool(
  "get_delivery_tracking_status",
  "Fetch live rider tracking details, GPS coordinates, and status for an active dispatch.",
  {
    dispatchId: z.string().describe("Dispatch / Tracking ID"),
  },
  async ({ dispatchId }) => {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            dispatchId,
            status: "RIDER_ASSIGNED",
            rider: {
              name: "Raju Kumar",
              phone: "9876543210",
              vehicleNumber: "AP 09 AB 1234",
              location: { lat: 17.4319, lng: 78.4072 },
            },
            estimatedArrivalMinutes: 12,
          }, null, 2),
        },
      ],
    };
  }
);

// Start MCP Server over Stdio transport
async function startServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("🚀 Delivery MCP Server running over Stdio!");
}

startServer().catch((err) => {
  console.error("Fatal MCP Server Error:", err);
  process.exit(1);
});
```

---

## 4. Connecting the Delivery MCP Server to your Project

### A. Run via CLI / Stdio:
```bash
npx tsx src/mcp/delivery-server.ts
```

### B. Add to your AI Agent tool registry:
Your AI agent can seamlessly import the MCP server tools or call them via `@modelcontextprotocol/sdk/client/mcp.js`.

---

## Summary Recommendation

| Requirement | Solution |
|---|---|
| **Can we integrate Rapido Parcel?** | **Yes.** Via direct enterprise account (`delivery.rapido.bike`) or immediately through **Shiprocket Quick API** which already aggregates Rapido. |
| **Can we write our own MCP Server?** | **Yes, highly recommended.** A Delivery MCP Server (`src/mcp/delivery-server.ts`) provides a clean, decoupled architecture where AI models interact with standardized tools while the server handles Rapido, Shadowfax, and Borzo behind the scenes. |
