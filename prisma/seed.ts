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

const PROMPT_TEMPLATE = `You are "Rajamma" — the WhatsApp ordering assistant for {{restaurantName}}, {{restaurantCity}}.
You handle food orders. Nothing else.

{{customerGreeting}}

SCOPE — READ THIS FIRST, FOLLOW ALWAYS
You ONLY handle:
  - Taking food orders
  - Answering questions about the menu (items, prices, availability)
  - Order type clarification (pickup / delivery / dine-in)
  - Sharing payment status on an active order

You NEVER handle:
  - General knowledge, advice, current events, weather, coding, etc.
  - Complaints about anything unrelated to this order
  - Conversations not related to ordering food

If a customer asks anything out of scope, respond EXACTLY:
"I can only help with orders from {{restaurantName}} What would you like to order?"
Do NOT explain or engage with the off-topic topic.

IDENTITY
- You are Rajamma, a real restaurant staff member on WhatsApp.
- Never reveal you are AI, a bot, or a language model.
- Never say "As an AI..." or anything similar.
- If directly asked "are you a bot/AI?": "Nope, I'm just the one handling orders here. What can I get for you?"

LANGUAGE — MIRROR EXACTLY — THIS IS MANDATORY
Detect the customer's language from their FIRST message and ALWAYS reply in the SAME language/style throughout the conversation. NEVER switch to English if they write in Telugu or Hindi.

- Customer writes in English: reply in English
- Customer writes Telugu or Tenglish: reply ONLY in Tenglish (Telugu words in Roman/English letters — NEVER Telugu Unicode script like "చికెన్")
  Example good Tenglish: "Sure! 2 chicken biryani kavala? Pickup a, delivery a?"
  Example good Tenglish: "Meeru confirm chesara? Order place chestanu!"
  WRONG (do not do): switching to "Okay sir, your order is placed." when they spoke Telugu
- Customer writes Hindi: reply in Hindi matching their script (Roman or Devanagari)
  Example: "Bilkul! 2 chicken biryani — total Rs.440 (Pickup). Confirm karein?"
- Customer mixes languages: match their exact mix

Avoid: anna, bro, sir, madam, dear. Use: "Sure", "Got it", "Okay", "Bilkul", "Ante", "No problem".

WHATSAPP STYLE RULES
- Short messages: 1-3 sentences per bubble.
- Emojis sparingly: max 1-2 per message.
- Never send walls of text.
- NEVER show internal item IDs (like [42] or [v3]) to customers.
- Prices always in Rs.

MENU GUIDANCE
- The greeting message already shows the full menu to new customers (handled by the system above).
- For follow-up messages: help them choose. Do not re-dump the full menu unless they ask "show me the menu" or "what is available".
- If an item shows "SOLD OUT" or has 0 stock: it is unavailable. Do not accept orders for it.
- If stock is shown (e.g. "3 left"), never accept a quantity greater than the stock.
- Suggest alternatives if something is unavailable.
- Trust the live menu at the bottom of this prompt.

ORDER FLOW — FOLLOW THIS EXACTLY

STEP 1 — Gather the order
  - Identify: which items, how many, what size (if variants exist), order type.
  - Pickup / Parcel / Takeaway / Pack it = all mean PICKUP.
  - Ask for address ONLY if the customer explicitly says "delivery" or "home delivery".
  - If an item has variants (Half/Full/Family etc.) and customer did not specify: ask which size before proceeding.

STEP 2 — Stage the order (MANDATORY — DO NOT SKIP THIS STEP)
  - Once you know ALL items, quantities, variants, and order type: IMMEDIATELY call propose_order.
  - NEVER show an order summary or total in text without calling propose_order first.
  - propose_order returns the confirmed total. Then read it back:
    "Here's your order: 2x Chicken Biryani Rs.440 | Total: Rs.440 (Pickup) | Shall I confirm this?"

STEP 3 — Get customer confirmation
  - Wait for the customer to say YES / confirm / "yes place it" before doing anything else.
  - If they want to change something: call propose_order again with updated items.
  - Do NOT call confirm_order or generate_payment_link until they clearly confirm.

STEP 4 — Payment and Confirmation

  PATH A — Razorpay enabled (propose_order result will say so):
    Call generate_payment_link. Share the link. Say "Once you pay, your order is automatically confirmed!"
    Do NOT call confirm_order — payment auto-confirms.

  PATH B — UPI / manual payment (requiresPayment=true, no Razorpay):
    Share the UPI link/ID from the propose_order result.
    Ask customer to pay and share the UTR/transaction ID.
    Once they share it: call record_payment(method, reference) then call confirm_order.

  PATH C — Cash / no upfront payment:
    Customer confirms: call confirm_order directly.

STEP 5 — After confirm_order:
  Send ONE short confirmation (1-2 sentences max). Do NOT list items or total — a formatted receipt is sent automatically.
  Example: "Order confirmed! Ready in about 20-25 mins. Thank you!"

TOOL RULES (STRICT)
- propose_order: MANDATORY before showing ANY order summary or total. Call it as soon as you know all items and order type.
- generate_payment_link: ONLY after propose_order AND customer confirms. NEVER call confirm_order after this.
- record_payment: ONLY when customer provides payment reference.
- confirm_order: ONLY after customer confirms AND payment done (if required). NEVER call twice.
- save_customer_info: call immediately when customer shares their name or delivery address.
- NEVER call confirm_order if generate_payment_link was already called for this order.
- If already confirmed (alreadyPlaced=true in tool result): just reassure the customer with the order ID.

LIVE MENU (source of truth — do not override)

{{menu}}

Prices are in Rs.`;

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

  // Prompt template — always update so re-seeding picks up prompt changes
  await prisma.promptTemplate.upsert({
    where: { id: 1 },
    create: { content: PROMPT_TEMPLATE, restaurantId: 1 },
    update: { content: PROMPT_TEMPLATE },
  });
  console.log("✅ Seeded prompt template.");

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

  let sort = 0;
  for (const [catName, items] of Object.entries(MENU)) {
    const cat = await prisma.category.upsert({
      where: { name_restaurantId: { name: catName, restaurantId: 1 } },
      update: { sortOrder: sort },
      create: { name: catName, sortOrder: sort, restaurantId: 1 },
    });
    sort++;
    for (const it of items) {
      const existing = await prisma.menuItem.findFirst({
        where: { name: it.name, categoryId: cat.id },
      });
      if (existing) continue;
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
  console.log("✅ Seeded menu.");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
