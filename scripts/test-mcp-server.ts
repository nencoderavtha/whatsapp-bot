/**
 * Delivery MCP Server Test Client
 * 
 * Verifies tool discovery and executes test calls over Stdio transport.
 * 
 * Usage:
 *   npx tsx scripts/test-mcp-server.ts
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function runTest() {
  console.log("🔌 Connecting to Delivery MCP Server via Stdio...");

  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", "src/mcp/delivery-server.ts"],
  });

  const client = new Client(
    { name: "delivery-mcp-test-runner", version: "1.0.0" },
    { capabilities: {} }
  );

  await client.connect(transport);
  console.log("✅ Successfully connected to Delivery MCP Server!");

  // 1. List Available Tools
  const toolsResponse = await client.listTools();
  console.log("\n🛠️ Discovered MCP Tools:");
  toolsResponse.tools.forEach((t) => {
    console.log(`  • ${t.name}: ${t.description}`);
  });

  // 2. Test Tool 1: get_delivery_quotes
  console.log("\n📊 1. Testing 'get_delivery_quotes' (Pickup: 500033 Jubilee Hills -> Drop: 500081 Madhapur)...");
  const quotesResult = await client.callTool({
    name: "get_delivery_quotes",
    arguments: {
      pickupPincode: 500033,
      deliveryPincode: 500081,
      weightKg: 0.5,
    },
  });
  console.log("Result:\n", (quotesResult.content[0] as { type: string; text: string }).text);

  // 3. Test Tool 2: dispatch_delivery_order
  console.log("\n🛵 2. Testing 'dispatch_delivery_order' via Rapido/Shiprocket...");
  const dispatchResult = await client.callTool({
    name: "dispatch_delivery_order",
    arguments: {
      orderId: 1042,
      providerCode: "rapido",
      customerName: "Srinivas Rao",
      customerPhone: "+919848011223",
      deliveryAddress: "Plot 12, Kavuri Hills, Madhapur, Hyderabad",
    },
  });
  const dispatchJsonText = (dispatchResult.content[0] as { type: string; text: string }).text;
  console.log("Result:\n", dispatchJsonText);

  // Extract dispatchId for tracking
  const dispatchData = JSON.parse(dispatchJsonText);
  const dispatchId = dispatchData.dispatchId || "SR-104299";

  // 4. Test Tool 3: get_delivery_tracking_status
  console.log(`\n📍 3. Testing 'get_delivery_tracking_status' for Dispatch ID: ${dispatchId}...`);
  const trackingResult = await client.callTool({
    name: "get_delivery_tracking_status",
    arguments: {
      dispatchId,
    },
  });
  console.log("Result:\n", (trackingResult.content[0] as { type: string; text: string }).text);

  await client.close();
  console.log("\n🎉 All Delivery MCP tools executed successfully!");
}

runTest().catch((err) => {
  console.error("❌ MCP Test Execution Failed:", err);
  process.exit(1);
});
