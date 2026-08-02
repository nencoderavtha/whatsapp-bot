/**
 * Registers the search_menu tool definition.
 *
 * Tools live in the database, not in code, so adding the runTool case is only
 * half the change — the model never sees a tool that has no ToolDefinition row.
 *
 * Seeded DISABLED on purpose. A running image without the search_menu case in
 * runTool would offer the tool to the model and then fail the call, so the row
 * must exist before the deploy and only be switched on after it. Enable with:
 *
 *   node scripts/seed-search-menu-tool.mjs --enable
 *
 * Idempotent: safe to run more than once.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const enable = process.argv.includes("--enable");

const description =
  "Search today's menu by name, dietary preference, category or price. " +
  "Call this whenever the customer asks what is available, asks for a kind of " +
  "food ('any veg starters?', 'what biryanis do you have', 'anything under 200'), " +
  "or names a dish you need the id and price for. Returns matching items with " +
  "their numeric [id] and variant [v-id] for propose_order, plus totalMatches — " +
  "the true number of matches, which may exceed the items listed.";

const parametersSchema = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description:
        "Dish name or keywords, e.g. 'chicken biryani' or 'paneer'. Omit to list everything matching the other filters.",
    },
    isVeg: {
      type: "boolean",
      description: "true for vegetarian only, false for non-vegetarian only. Omit for both.",
    },
    category: {
      type: "string",
      description: "Restrict to a menu category, e.g. 'Starters', 'Biryani'.",
    },
    minPrice: { type: "number", description: "Only items with something at or above this price." },
    maxPrice: { type: "number", description: "Only items with something at or below this price." },
    limit: {
      type: "number",
      description: "How many items to return, 1-30. Defaults to 12.",
    },
  },
  required: [],
};

const row = await prisma.toolDefinition.upsert({
  where: { name: "search_menu" },
  update: { description, parametersSchema: JSON.stringify(parametersSchema), isEnabled: enable },
  create: {
    name: "search_menu",
    description,
    parametersSchema: JSON.stringify(parametersSchema),
    isEnabled: enable,
    sortOrder: 1,
  },
});

console.log(`search_menu ${row.isEnabled ? "ENABLED" : "seeded (disabled)"} — id ${row.id}`);
if (!enable) console.log("Deploy the image containing the runTool case, then re-run with --enable.");

await prisma.$disconnect();
