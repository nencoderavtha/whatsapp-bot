/**
 * Sets up the knowledge base for a restaurant.
 *
 * Two things happen here:
 *   1. the search_knowledge tool definition is registered (disabled by default)
 *   2. a checklist of the questions customers actually ask is created as
 *      UNPUBLISHED drafts with EMPTY answers
 *
 * The answers are deliberately blank. Nobody here knows this restaurant's
 * allergen list, refund terms or delivery radius, and a plausible-sounding
 * invented answer is worse than no answer — it reaches a real customer as fact.
 * The restaurant fills these in and publishes them; until then the bot says it
 * will check with staff.
 *
 * Existing articles are never overwritten, so this is safe to re-run when the
 * checklist grows.
 *
 *   node scripts/seed-knowledge-base.mjs                  # drafts + tool (off)
 *   node scripts/seed-knowledge-base.mjs --restaurant=2   # onboard another one
 *   node scripts/seed-knowledge-base.mjs --enable         # turn the tool on
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const enable = process.argv.includes("--enable");
const restaurantId = Number(
  (process.argv.find((a) => a.startsWith("--restaurant=")) ?? "").split("=")[1] ?? 1,
);

// verbatim: a rephrase could be wrong in a way that costs the customer money,
// breaks a promise, or — for allergens — hurts someone.
const CHECKLIST = [
  ["allergens", "Which dishes contain nuts?", "nuts, peanut, cashew, almond, allergy, allergic", true],
  ["allergens", "Which dishes contain dairy?", "dairy, milk, ghee, butter, paneer, curd, lactose", true],
  ["allergens", "Do you have gluten-free options?", "gluten, wheat, maida, celiac", true],
  ["allergens", "Is the food cooked in the same oil as non-veg?", "same oil, cross contamination, pure veg, separate", true],
  ["allergens", "Do you use MSG or artificial colours?", "msg, ajinomoto, colour, preservative", true],

  ["hours", "What time do you open and close?", "timing, hours, open, close, kab, ippudu", false],
  ["hours", "Are you open on Sundays and public holidays?", "sunday, holiday, festival, weekend", false],
  ["hours", "Until what time do you take delivery orders?", "last order, cutoff, late night", false],

  ["delivery", "Which areas do you deliver to?", "area, radius, distance, pin code, locality", true],
  ["delivery", "How long does delivery take?", "how long, time, eta, late, fast", false],
  ["delivery", "How much is the delivery fee?", "delivery charge, fee, free delivery", false],
  ["delivery", "Is there a minimum order value?", "minimum, minimum order, at least", true],

  ["location", "Where exactly are you located?", "address, location, where, direction, landmark", false],
  ["location", "Do you have parking?", "parking, car, bike, park", false],
  ["location", "Do you have seating or is it takeaway only?", "dine in, seating, sit, takeaway, parcel", false],

  ["payment", "Which payment methods do you accept?", "payment, upi, card, cash, gpay, phonepe, cod", false],
  ["payment", "Can I pay cash on delivery?", "cod, cash on delivery, cash", false],

  ["policy", "What is your refund or cancellation policy?", "refund, cancel, money back, wrong order", true],
  ["policy", "Do you take bulk or party orders?", "bulk, party, catering, function, large order, 50 people", false],
  ["policy", "Can I pre-order or schedule for later?", "pre order, advance, schedule, tomorrow, book", false],
  ["policy", "Do you provide GST invoices?", "gst, bill, invoice, tax, receipt", false],
];

let created = 0;
let skipped = 0;

for (const [category, question, keywords, isVerbatim] of CHECKLIST) {
  const existing = await prisma.knowledgeArticle.findUnique({
    where: { restaurantId_question: { restaurantId, question } },
  });
  if (existing) {
    skipped++;
    continue;
  }
  await prisma.knowledgeArticle.create({
    data: { restaurantId, question, answer: "", keywords, category, isVerbatim, isPublished: false },
  });
  created++;
}

const description =
  "Look up the restaurant's own answer to a non-menu question — allergens and " +
  "ingredients, opening hours, delivery areas and fees, parking, payment methods, " +
  "refunds, bulk orders. Call this BEFORE answering any such question. If it " +
  "returns found:false the restaurant has not published an answer, and you must " +
  "say you'll check rather than answering from general knowledge. Use search_menu " +
  "instead for what dishes are available and what they cost.";

const parametersSchema = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "The customer's question, in English, e.g. 'do you deliver to Gachibowli'.",
    },
  },
  required: ["query"],
};

const tool = await prisma.toolDefinition.upsert({
  where: { name: "search_knowledge" },
  update: { description, parametersSchema: JSON.stringify(parametersSchema), isEnabled: enable },
  create: {
    name: "search_knowledge",
    description,
    parametersSchema: JSON.stringify(parametersSchema),
    isEnabled: enable,
    sortOrder: 2,
  },
});

const unanswered = await prisma.knowledgeArticle.count({
  where: { restaurantId, OR: [{ answer: "" }, { isPublished: false }] },
});

console.log(`restaurant ${restaurantId}: ${created} draft(s) created, ${skipped} already present`);
console.log(`search_knowledge ${tool.isEnabled ? "ENABLED" : "seeded (disabled)"}`);
console.log(`${unanswered} article(s) still unanswered or unpublished — the bot will not use these`);
if (!enable) console.log("Deploy the image containing the runTool case, then re-run with --enable.");

await prisma.$disconnect();
