import { prisma } from "../db.js";

export async function getMenu(
  restaurantId: number,
  opts: { includeUnavailable?: boolean } = {},
) {
  const categories = await prisma.category.findMany({
    where: { restaurantId },
    orderBy: { sortOrder: "asc" },
    include: {
      items: {
        where: opts.includeUnavailable ? {} : { available: true },
        orderBy: { name: "asc" },
        include: {
          variants: {
            where: opts.includeUnavailable ? {} : { available: true },
            orderBy: { sortOrder: "asc" },
          },
        },
      },
    },
  });
  return categories.filter((c) => c.items.length > 0);
}

export async function menuAsText(restaurantId: number): Promise<string> {
  const cats = await getMenu(restaurantId);

  const availableLines: string[] = [];
  const stockSoldOut: string[] = [];

  for (const c of cats) {
    const lines: string[] = [];
    for (const i of c.items) {
      // Items where stockCount hit 0 go to the sold-out section, not available
      if (i.stockCount !== null && i.stockCount === 0) {
        stockSoldOut.push(i.name);
        continue;
      }

      const stockTag = i.stockCount !== null ? ` ⚠️ only ${i.stockCount} left` : "";

      const flags = [
        i.isVeg ? "(veg)" : "",
        i.spiceLevel ? `[${i.spiceLevel}]` : "",
        i.description ? `— ${i.description}` : "",
      ]
        .filter(Boolean)
        .join(" ");

      if (i.variants.length > 0) {
        const variantList = i.variants
          .map((v) => `${v.name}[v${v.id}]₹${v.price}`)
          .join(" | ");
        lines.push(`  [${i.id}] ${i.name} ${flags}${stockTag}\n       ${variantList}`);
      } else {
        lines.push(`  [${i.id}] ${i.name} — ₹${i.price} ${flags}${stockTag}`.trimEnd());
      }
    }
    if (lines.length > 0) availableLines.push(`${c.name}:\n${lines.join("\n")}`);
  }

  const available = availableLines.length === 0
    ? "(The menu is currently empty.)"
    : availableLines.join("\n\n");

  // Combine DB-marked unavailable + zero-stock items
  const dbSoldOut = await prisma.menuItem.findMany({
    where: { available: false, restaurantId },
    select: { name: true },
  });
  const allSoldOut = [...dbSoldOut.map((s) => s.name), ...stockSoldOut];
  const soldOutLine = allSoldOut.length
    ? `\n\nSOLD OUT right now (do NOT accept orders for these): ${allSoldOut.join(", ")}`
    : "";

  return available + soldOutLine;
}

export async function findItems(restaurantId: number, query: string) {
  const q = query.trim().toLowerCase();
  const all = await prisma.menuItem.findMany({
    where: { available: true, restaurantId },
    include: { variants: { where: { available: true } } },
  });
  const exact = all.filter((i) => i.name.toLowerCase() === q);
  if (exact.length) return exact;
  return all.filter(
    (i) => i.name.toLowerCase().includes(q) || q.includes(i.name.toLowerCase()),
  );
}
