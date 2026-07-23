import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// A starter menu typical of an Andhra "military" hotel in Hyderabad.
// Owner can fully edit this later from the admin portal.
const MENU: Record<string, Array<{ name: string; price: number; desc?: string; veg?: boolean; spice?: string }>> = {
  "Mutton Specials": [
    { name: "Mutton Curry", price: 280, desc: "Andhra-style spicy mutton gravy", spice: "spicy" },
    { name: "Mutton Fry", price: 300, desc: "Dry pepper mutton fry", spice: "extra spicy" },
    { name: "Mutton Pulusu", price: 270, desc: "Tangy tamarind mutton", spice: "spicy" },
    { name: "Boti / Kheema", price: 260 },
  ],
  "Chicken": [
    { name: "Naati Kodi Curry", price: 260, desc: "Country chicken curry", spice: "extra spicy" },
    { name: "Chicken Fry", price: 220, spice: "spicy" },
    { name: "Chicken 65", price: 200, spice: "spicy" },
    { name: "Pepper Chicken", price: 230, spice: "spicy" },
  ],
  "Biryani": [
    { name: "Mutton Biryani", price: 290 },
    { name: "Chicken Biryani", price: 220 },
    { name: "Egg Biryani", price: 160 },
    { name: "Veg Biryani", price: 150, veg: true },
  ],
  "Rice & Breads": [
    { name: "Steamed Rice", price: 60, veg: true },
    { name: "Ragi Sangati", price: 80, veg: true, desc: "Finger-millet mudda" },
    { name: "Jowar Roti", price: 30, veg: true },
  ],
  "Veg & Sides": [
    { name: "Gongura Pappu", price: 120, veg: true, desc: "Sorrel-leaf dal", spice: "spicy" },
    { name: "Egg Curry", price: 110 },
    { name: "Curd Rice", price: 90, veg: true },
    { name: "Ulava Charu", price: 100, veg: true, desc: "Horsegram soup" },
  ],
};

// Short, editable "restaurant notes" seeded into the PromptTemplate table.
// The live prompt builder (src/ai/prompt.ts) injects this as an
// "ADDITIONAL NOTES FROM THE RESTAURANT" reference block — it's where the owner
// puts hours, delivery info, contact, and FAQs. It must NOT be a full system
// prompt (identity/scope/tool rules live in code now). The owner edits this
// from the dashboard prompt/notes editor.
const NOTES_TEMPLATE = `Hours: 11:00 AM – 11:00 PM, every day.
Delivery: within ~5 km of the restaurant. Pickup and dine-in also available.
Payment: UPI and cash accepted.
Contact: call the restaurant directly for anything urgent.
Specialities: Andhra-style military hotel food — mutton, naati kodi (country chicken), and biryani.`;

const TOOLS: Array<{
  name: string;
  description: string;
  parameters: object;
  sortOrder: number;
}> = [
  {
    name: "propose_order",
    description:
      "Stage the order and calculate the total so you can read it back to the customer for confirmation. Call this ONLY when you know ALL items, quantities, variants (for items with size options), and the order type. Returns the total and payment instructions. This does NOT place the order — the customer must confirm first.",
    parameters: {
      type: "object",
      properties: {
        items: {
          type: "array",
          description: "Line items the customer wants to order",
          items: {
            type: "object",
            properties: {
              menuItemId: { type: "number", description: "The numeric [id] shown before the item name in the menu. Never guess — only use IDs from the live menu." },
              variantId: { type: "number", description: "The [v#] variant ID for items with Half/Full/Family Pack etc options. Required if the item has variants — ask the customer which size before calling." },
              qty: { type: "number", description: "Quantity ordered. Must not exceed the item's stock count if one is shown." },
              note: { type: "string", description: "Item-specific special request (e.g. less spice). Optional." },
            },
            required: ["menuItemId", "qty"],
          },
        },
        type: { type: "string", enum: ["pickup", "delivery", "dine-in"], description: "Order type. Default to pickup unless customer says delivery/home delivery." },
        note: { type: "string", description: "Overall order note, optional" },
      },
      required: ["items", "type"],
    },
    sortOrder: 0,
  },
  {
    name: "generate_payment_link",
    description:
      "Generate a Razorpay payment link for the staged order. Call this ONLY after propose_order AND after the customer confirms the order. The order auto-confirms when the customer pays — NEVER call confirm_order after this tool. If Razorpay is not configured it returns a UPI deep link as fallback.",
    parameters: { type: "object", properties: {} },
    sortOrder: 1,
  },
  {
    name: "record_payment",
    description:
      "Record that the customer has paid manually (cash / UPI). Call this when: (1) the customer shares a UPI transaction ID, (2) they say they paid cash, or (3) Razorpay is not in use. After calling this, call confirm_order to place the order.",
    parameters: {
      type: "object",
      properties: {
        method: { type: "string", enum: ["upi", "cash", "card", "online"], description: "Payment method the customer used" },
        reference: { type: "string", description: "UPI transaction ID or payment reference. Optional for cash." },
      },
      required: ["method"],
    },
    sortOrder: 2,
  },
  {
    name: "confirm_order",
    description:
      "Place the order that was staged by propose_order. Call ONLY after the customer clearly confirms AND payment conditions are met. If generate_payment_link was already called for this order, do NOT call confirm_order — payment auto-confirms. Takes no arguments.",
    parameters: { type: "object", properties: {} },
    sortOrder: 3,
  },
  {
    name: "save_customer_info",
    description:
      "Save the customer's name, delivery address, or food preferences/allergies for future orders. Call this as soon as the customer shares any of this information — do not wait.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Customer's name" },
        address: { type: "string", description: "Delivery address" },
        notes: { type: "string", description: "Preferences, allergies, or other notes" },
      },
    },
    sortOrder: 4,
  },
  {
    name: "check_order_status",
    description:
      "Check the status of the customer's order when they ask 'where is my order', 'is my order ready', 'order status', etc. Leave orderId empty to look up their most recent active order, or pass a specific orderId if the customer mentions an order number. Returns the current status and sends the customer a status update.",
    parameters: {
      type: "object",
      properties: {
        orderId: { type: "number", description: "Specific order number to check. Optional — omit to use the customer's most recent active order." },
      },
    },
    sortOrder: 5,
  },
  {
    name: "request_human_handoff",
    description:
      "Hand the conversation over to a human staff member. Call this ONLY when the customer clearly wants to talk to a real person / staff / manager (e.g. 'talk to a human', 'I want to speak to someone', 'connect me to staff'), or has a complaint/issue you cannot resolve within ordering. This pauses the AI for this customer until staff resume it — do NOT call it for normal ordering questions.",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Short reason for the handoff (e.g. 'complaint about last order'). Optional." },
      },
    },
    sortOrder: 6,
  },
];

async function main() {
  // Bot config singleton
  await prisma.botConfig.upsert({
    where: { id: 1 },
    create: {
      restaurantName: "Military Rajamma Hotel",
      restaurantCity: "Hyderabad",
      ownerNumbers: process.env.OWNER_NUMBERS ?? "",
      dashboardPassword: process.env.ADMIN_PASSWORD ?? "changeme",
    },
    update: {},
  });
  console.log("✅ Seeded bot config.");

  // Prompt template — only create if none exists; never overwrite a custom prompt
  await prisma.promptTemplate.upsert({
    where: { id: 1 },
    create: { content: NOTES_TEMPLATE, restaurantId: 1 },
    update: {},
  });
  console.log("✅ Seeded restaurant notes template.");

  // Tool definitions (scoped to restaurant 1)
  for (const tool of TOOLS) {
    await prisma.toolDefinition.upsert({
      where: { name_restaurantId: { name: tool.name, restaurantId: 1 } },
      create: {
        name: tool.name,
        description: tool.description,
        parametersSchema: JSON.stringify(tool.parameters),
        sortOrder: tool.sortOrder,
        restaurantId: 1,
      },
      update: {
        description: tool.description,
        parametersSchema: JSON.stringify(tool.parameters),
        sortOrder: tool.sortOrder,
      },
    });
  }
  console.log("✅ Seeded tool definitions.");

  // Menu — only seed if the restaurant has no menu items at all (first-time setup).
  // Once the owner has customised the menu, redeploys must never touch it.
  const existingItemCount = await prisma.menuItem.count({ where: { restaurantId: 1 } });
  if (existingItemCount === 0) {
    let sort = 0;
    for (const [catName, items] of Object.entries(MENU)) {
      const cat = await prisma.category.create({
        data: { name: catName, sortOrder: sort, restaurantId: 1 },
      });
      sort++;
      for (const it of items) {
        await prisma.menuItem.create({
          data: {
            name: it.name,
            price: it.price,
            description: it.desc,
            isVeg: it.veg ?? false,
            spiceLevel: it.spice,
            categoryId: cat.id,
            restaurantId: 1,
          },
        });
      }
    }
    console.log("✅ Seeded menu (first-time setup).");
  } else {
    console.log(`⏭️  Skipped menu seed — ${existingItemCount} items already exist.`);
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
