import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Godavari Ruchulu's daily menu changes every evening — this is a DEMO day's
// 13 numbered items (per the brand doc) with placeholder ~₹350-400 prices.
// The real owner/staff enter each day's actual menu + prices from the admin
// dashboard's daily-menu screen; this seed only gives the demo something to
// show out of the box. Dish names are printed exactly as given — never
// translated. Bagara/Annam pairs (same curry, two rice bases) are modeled as
// two MenuItemVariant rows on one MenuItem, priced separately (Bagara a bit
// higher, matching the doc's note that it's usually priced higher).
const MENU: Array<{
  name: string;
  price?: number; // set when the item has no Annam/Bagara variants
  desc?: string;
  veg?: boolean;
  spice?: string;
  pieceInfo?: string;
  variants?: Array<{ name: string; price: number }>;
}> = [
  { name: "Chicken Layer Fry Piece Biryani", price: 380, desc: "Layered dum biryani, fried chicken pieces", spice: "medium" },
  { name: "Chicken Fry Piece Biryani", price: 350, desc: "Fried chicken piece biryani", spice: "medium" },
  { name: "Prawn Pulao", price: 370, desc: "Prawn pulao, coastal style", spice: "mild-medium" },
  {
    name: "Mavidikaya Prawn",
    desc: "Raw mango + prawn curry",
    spice: "hot, sour",
    variants: [
      { name: "Annam", price: 360 },
      { name: "Bagara", price: 390 },
    ],
  },
  {
    name: "Jeedipappu Mutton",
    desc: "Cashew mutton curry",
    spice: "medium, rich",
    variants: [
      { name: "Annam", price: 380 },
      { name: "Bagara", price: 400 },
    ],
  },
  { name: "Godavari Chepala Pulusu Annam", price: 390, desc: "Tamarind fish stew, rice", spice: "hot, very sour", pieceInfo: "2 pieces" },
  { name: "Kodiguddu Endu Royyalu Pulusu Annam", price: 370, desc: "Egg + dried prawn pulusu, rice", spice: "hot, sour" },
  {
    name: "Mavidikaya Jeedipappu Chinni Ullipaya",
    desc: "Raw mango, cashew, shallot curry",
    veg: true,
    spice: "medium, sour",
    variants: [
      { name: "Annam", price: 350 },
      { name: "Bagara", price: 380 },
    ],
  },
  { name: "Beerakaya Vellulli Guddu Nethallu Annam", price: 360, desc: "Ridge gourd, garlic, egg, anchovies, rice", spice: "medium" },
  { name: "Bagara Rice", price: 350, desc: "Bagara rice on its own", veg: true, spice: "mild" },
];

// Short, editable "restaurant notes" seeded into the PromptTemplate table.
// The live prompt builder (src/ai/prompt.ts) injects this as an
// "ADDITIONAL NOTES FROM THE RESTAURANT" reference block — it's where the owner
// puts hours, delivery info, contact, and FAQs. It must NOT be a full system
// prompt (identity/scope/tool rules live in code now). The owner edits this
// from the dashboard prompt/notes editor.
const NOTES_TEMPLATE = `Location: The Street, Madhapur, Hyderabad.
Hours: one evening service, starts 7:30 PM.
Order type: parcel/pickup. Delivery is not live yet.
Payment: Razorpay online payment link only.
Contact: for anything urgent, a manager is available during working hours.`;

const TOOLS: Array<{
  name: string;
  description: string;
  parameters: object;
  sortOrder: number;
}> = [
  {
    name: "propose_order",
    description:
      "Stage the order and calculate the total so you can read it back to the customer for confirmation. Call this ONLY when you know ALL items, quantities, variants (for items with an Annam/Bagara or other size choice), and the order type. Returns the total and payment instructions. This does NOT place the order — the customer must confirm first.",
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
              variantId: { type: "number", description: "The [v#] variant ID for items with an Annam/Bagara or size choice. Required if the item has variants — ask the customer which one before calling." },
              qty: { type: "number", description: "Quantity ordered. Must not exceed the item's stock count if one is shown." },
              note: { type: "string", description: "Item-specific special request (e.g. less spice, no onion). Optional." },
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
      "Generate a Razorpay payment link for the staged order. Call this ONLY after propose_order AND after the customer confirms the order. The order auto-confirms when the customer pays — NEVER call confirm_order after this tool.",
    parameters: { type: "object", properties: {} },
    sortOrder: 1,
  },
  {
    name: "record_payment",
    description:
      "Record that the customer has paid manually. Call this only if Razorpay is not in use for this restaurant. After calling this, call confirm_order to place the order.",
    parameters: {
      type: "object",
      properties: {
        method: { type: "string", enum: ["upi", "cash", "card", "online"], description: "Payment method the customer used" },
        reference: { type: "string", description: "Transaction reference. Optional for cash." },
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
      "Hand the conversation over to a human staff member. Call this ONLY for: the customer explicitly asks for a human/staff/manager/person; a genuine complaint (unhappy about an order — wrong item, bad quality, missing item, food safety); an explicit refund request; or a clearly large/bulk or party order. This is the exception, not the default — do NOT call it for ordinary menu/price/availability/allergy questions, ambiguous replies, or customization requests (answer allergy questions directly from the menu's listed ingredients instead). This pauses the AI for this customer until staff resume it.",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Short reason for the handoff (e.g. 'complaint about last order'). Optional." },
      },
    },
    sortOrder: 6,
  },
  {
    name: "cancel_order",
    description:
      "Cancel the customer's currently staged (not yet confirmed) order when they say 'cancel', 'cancel order', 'vaddu', 'nakoddu', etc. Only cancels an unconfirmed staged cart — if the order was already placed/confirmed, this tells you to apologize and call request_human_handoff instead. Takes no arguments.",
    parameters: { type: "object", properties: {} },
    sortOrder: 7,
  },
];

async function main() {
  // Bot config singleton
  await prisma.botConfig.upsert({
    where: { id: 1 },
    create: {
      restaurantName: "Godavari Ruchulu",
      restaurantCity: "Hyderabad",
      ownerNumbers: process.env.OWNER_NUMBERS ?? "",
      dashboardPassword: process.env.ADMIN_PASSWORD ?? "changeme",
      // Demo defaults to published so the sales demo works immediately;
      // staff toggle this from the admin daily-menu screen each evening.
      dailyMenuPublished: true,
      dailyMenuPublishedAt: new Date(),
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
  // Once staff have entered a real day's menu, redeploys must never touch it.
  const existingItemCount = await prisma.menuItem.count({ where: { restaurantId: 1 } });
  if (existingItemCount === 0) {
    const cat = await prisma.category.create({
      data: { name: "Today's Menu", sortOrder: 0, restaurantId: 1 },
    });

    let sort = 0;
    for (const it of MENU) {
      sort++;
      const item = await prisma.menuItem.create({
        data: {
          name: it.name,
          price: it.price ?? 0, // ignored when variants exist
          description: it.desc,
          isVeg: it.veg ?? false,
          spiceLevel: it.spice,
          pieceInfo: it.pieceInfo,
          sortOrder: sort,
          categoryId: cat.id,
          restaurantId: 1,
        },
      });
      if (it.variants) {
        let vSort = 0;
        for (const v of it.variants) {
          await prisma.menuItemVariant.create({
            data: {
              menuItemId: item.id,
              restaurantId: 1,
              name: v.name,
              price: v.price,
              sortOrder: vSort++,
            },
          });
        }
      }
    }
    console.log("✅ Seeded demo menu (first-time setup).");
  } else {
    console.log(`⏭️  Skipped menu seed — ${existingItemCount} items already exist.`);
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
