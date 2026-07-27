import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const MENU: Array<{
  name: string;
  price?: number;
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

const NOTES_TEMPLATE = `Location: Plot 12, Main Road, Gachibowli, Hyderabad.
Hours: Open 11:30 AM - 10:30 PM.
Order type: Parcel, Pickup & Home Delivery.
Payment: Cash, UPI & Online.
Contact: For urgent support, call manager during working hours.`;

const TOOLS: Array<{
  name: string;
  description: string;
  parameters: object;
  sortOrder: number;
}> = [
  {
    name: "propose_order",
    description:
      "Stage the order and calculate the total so you can read it back to the customer for confirmation. Call this ONLY when you know ALL items, quantities, variants, and the order type. Returns the total and payment instructions.",
    parameters: {
      type: "object",
      properties: {
        items: {
          type: "array",
          description: "Line items the customer wants to order",
          items: {
            type: "object",
            properties: {
              menuItemId: { type: "number", description: "The numeric [id] of the item." },
              variantId: { type: "number", description: "Variant ID if item has size/rice choices." },
              qty: { type: "number", description: "Quantity ordered." },
              note: { type: "string", description: "Special customization request." },
            },
            required: ["menuItemId", "qty"],
          },
        },
        type: { type: "string", enum: ["pickup", "delivery", "dine-in"], description: "Order type." },
        note: { type: "string", description: "Overall order note" },
      },
      required: ["items", "type"],
    },
    sortOrder: 0,
  },
  {
    name: "generate_payment_link",
    description: "Generate a Razorpay payment link for the staged order.",
    parameters: { type: "object", properties: {} },
    sortOrder: 1,
  },
  {
    name: "record_payment",
    description: "Record manual UPI or Cash payment.",
    parameters: {
      type: "object",
      properties: {
        method: { type: "string", enum: ["upi", "cash", "card", "online"], description: "Payment method" },
        reference: { type: "string", description: "Transaction reference." },
      },
      required: ["method"],
    },
    sortOrder: 2,
  },
  {
    name: "confirm_order",
    description: "Finalize and place the staged order.",
    parameters: { type: "object", properties: {} },
    sortOrder: 3,
  },
  {
    name: "check_order_status",
    description: "Check status of the customer's order.",
    parameters: {
      type: "object",
      properties: {
        orderId: { type: "number", description: "Specific order ID to check." },
      },
    },
    sortOrder: 4,
  },
  {
    name: "request_human_handoff",
    description: "Hand conversation over to a human staff member.",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Reason for handoff." },
      },
    },
    sortOrder: 5,
  },
  {
    name: "cancel_order",
    description: "Cancel the unconfirmed staged order.",
    parameters: { type: "object", properties: {} },
    sortOrder: 6,
  },
  {
    name: "send_item_photo",
    description: "Send a photo of a specific dish/menu item to the customer. Use this when the customer asks to see a picture of an item.",
    parameters: {
      type: "object",
      properties: {
        itemName: { type: "string", description: "The name of the menu item to send a photo of." }
      },
      required: ["itemName"]
    },
    sortOrder: 10,
  },
];

async function main() {
  // Restaurant config singleton
  await prisma.restaurantConfig.upsert({
    where: { id: 1 },
    create: {
      restaurantName: "Godavari Ruchulu",
      restaurantCity: "Hyderabad",
      restaurantAddress: "Plot 12, Main Road, Gachibowli, Hyderabad",
      ownerNumbers: process.env.OWNER_NUMBERS ?? "",
      dashboardPassword: process.env.ADMIN_PASSWORD ?? "changeme",
    },
    update: {},
  });
  console.log("✅ Seeded restaurant config.");

  // Prompt template
  await prisma.promptTemplate.upsert({
    where: { id: 1 },
    create: { content: NOTES_TEMPLATE },
    update: {},
  });
  console.log("✅ Seeded restaurant notes template.");

  // Tool definitions
  for (const tool of TOOLS) {
    await prisma.toolDefinition.upsert({
      where: { name: tool.name },
      create: {
        name: tool.name,
        description: tool.description,
        parametersSchema: JSON.stringify(tool.parameters),
        sortOrder: tool.sortOrder,
      },
      update: {
        description: tool.description,
        parametersSchema: JSON.stringify(tool.parameters),
        sortOrder: tool.sortOrder,
      },
    });
  }
  console.log("✅ Seeded tool definitions.");

  // Seed Menu
  const existingItemCount = await prisma.menuItem.count();
  if (existingItemCount === 0) {
    const cat = await prisma.category.create({
      data: { name: "Special Menu", sortOrder: 0 },
    });

    let sort = 0;
    for (const it of MENU) {
      sort++;
      const item = await prisma.menuItem.create({
        data: {
          name: it.name,
          price: it.price ?? 0,
          description: it.desc,
          isVeg: it.veg ?? false,
          spiceLevel: it.spice,
          pieceInfo: it.pieceInfo,
          sortOrder: sort,
          categoryId: cat.id,
        },
      });
      if (it.variants) {
        let vSort = 0;
        for (const v of it.variants) {
          await prisma.menuItemVariant.create({
            data: {
              menuItemId: item.id,
              name: v.name,
              price: v.price,
              sortOrder: vSort++,
            },
          });
        }
      }
    }
    console.log(`✅ Seeded ${MENU.length} menu items.`);
  }
}

main()
  .catch((e) => {
    console.error("❌ Seed error:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
