import { prisma } from "../db.js";

/** Full menu grouped by category, only available items by default. */
export async function getMenu(opts: { includeUnavailable?: boolean } = {}) {
  const categories = await prisma.category.findMany({
    orderBy: { sortOrder: "asc" },
    include: {
      items: {
        where: opts.includeUnavailable ? {} : { available: true },
        orderBy: { name: "asc" },
      },
    },
  });
  return categories.filter((c) => c.items.length > 0);
}

/**
 * Compact text version of the live menu, injected into the AI prompt.
 * Each item is prefixed with [id] so the model can call propose_order directly
 * without an extra menu-lookup round-trip (saves tokens + tool hops).
 */
export async function menuAsText(): Promise<string> {
  const cats = await getMenu();
  const available =
    cats.length === 0
      ? "(The menu is currently empty.)"
      : cats
          .map((c) => {
            const lines = c.items
              .map(
                (i) =>
                  `  [${i.id}] ${i.name} — ₹${i.price}${i.isVeg ? " (veg)" : ""}${
                    i.spiceLevel ? ` [${i.spiceLevel}]` : ""
                  }${i.description ? ` — ${i.description}` : ""}`,
              )
              .join("\n");
            return `${c.name}:\n${lines}`;
          })
          .join("\n\n");

  // Explicitly list today's sold-out items so the bot declines them even if they
  // were discussed earlier in the chat (availability is toggled live from the admin portal).
  const soldOut = await prisma.menuItem.findMany({
    where: { available: false },
    select: { name: true },
  });
  const soldOutLine = soldOut.length
    ? `\n\nSOLD OUT right now (do NOT offer or accept these — say they just ran out and suggest an alternative): ${soldOut
        .map((s) => s.name)
        .join(", ")}`
    : "";

  return available + soldOutLine;
}

/** Fuzzy-ish lookup used by the AI tool to resolve a spoken item name to a row. */
export async function findItems(query: string) {
  const q = query.trim().toLowerCase();
  const all = await prisma.menuItem.findMany({ where: { available: true } });
  // Prefer exact, then contains.
  const exact = all.filter((i) => i.name.toLowerCase() === q);
  if (exact.length) return exact;
  return all.filter(
    (i) =>
      i.name.toLowerCase().includes(q) || q.includes(i.name.toLowerCase()),
  );
}
