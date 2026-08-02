import { prisma } from "../db.js";

export async function getMenu(
  _restaurantId?: number,
  opts: { includeUnavailable?: boolean } = {},
) {
  const categories = await prisma.category.findMany({
    orderBy: { sortOrder: "asc" },
    include: {
      items: {
        where: opts.includeUnavailable ? {} : { available: true },
        orderBy: { sortOrder: "asc" },
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

/**
 * Minimal name → id index for the intent classifier.
 *
 * The classifier's only job with the menu is mapping "two parottas" onto
 * menuItemId 31 and a variant id. It does not need prices, spice levels,
 * descriptions or piece counts — but it was being handed the full menuAsText,
 * the same block the responder gets, so every turn shipped the menu twice.
 *
 * Sold-out items are still listed, briefly: the classifier should recognise a
 * request for one so it can be refused properly, rather than failing to map it
 * and falling through to UNKNOWN.
 */
export async function menuAsCompactIndex(_restaurantId?: number): Promise<string> {
  const cats = await getMenu();

  const lines: string[] = [];
  const soldOut: string[] = [];

  for (const c of cats) {
    for (const i of c.items) {
      if (i.stockCount !== null && i.stockCount === 0) {
        soldOut.push(`[${i.id}] ${i.name}`);
        continue;
      }
      const variants = i.variants.length
        ? ` (${i.variants.map((v) => `${v.name}[v${v.id}]`).join(" | ")})`
        : "";
      lines.push(`[${i.id}] ${i.name}${variants}`);
    }
  }

  const unavailable = await prisma.menuItem.findMany({
    where: { available: false },
    select: { id: true, name: true },
  });
  for (const u of unavailable) soldOut.push(`[${u.id}] ${u.name}`);

  const body = lines.length ? lines.join("\n") : "(no items available)";
  return soldOut.length
    ? `${body}\n\nSOLD OUT (recognise but do not add): ${soldOut.join(", ")}`
    : body;
}

export interface MenuSearchFilters {
  query?: string;
  isVeg?: boolean;
  category?: string;
  minPrice?: number;
  maxPrice?: number;
  limit?: number;
}

export interface MenuSearchResult {
  /** How many items matched in total — not how many are listed below. */
  totalMatches: number;
  truncated: boolean;
  items: string[];
}

/** Cheapest and dearest way to buy an item, accounting for variants. */
function priceRange(item: { price: number; variants: { price: number }[] }) {
  if (item.variants.length === 0) return { min: item.price, max: item.price };
  const prices = item.variants.map((v) => v.price);
  return { min: Math.min(...prices), max: Math.max(...prices) };
}

/**
 * Score an item against the query words.
 *
 * Whole-string matching breaks on word order — "chicken biryani" would miss
 * "Biryani Chicken Special" — so each word is matched separately and the score
 * is how many of them landed. An item matching both words outranks one
 * matching either, which is the ordering a customer expects.
 */
function relevance(haystack: string, words: string[], name: string): number {
  let score = 0;
  for (const w of words) if (haystack.includes(w)) score++;
  if (score === 0) return 0;
  const n = name.toLowerCase();
  const joined = words.join(" ");
  if (n === joined) score += 100;
  else if (n.startsWith(joined)) score += 50;
  return score;
}

/**
 * Structured search over the menu.
 *
 * The whole menu is pasted into the system prompt today, which works at 11
 * items and stops working well before a few hundred. This is the replacement:
 * the model asks for what it needs instead of carrying everything.
 *
 * Filters are applied by the database where it can (availability, veg,
 * category) and in memory where the schema can't express it — price has to
 * account for variants, so the comparison is against the item's real cheapest
 * and dearest options rather than the base price, which is meaningless for a
 * dish sold only in Half/Full.
 *
 * totalMatches is deliberately the count BEFORE the limit is applied. Without
 * it the model sees ten results, assumes that is the whole answer, and tells a
 * customer asking "what veg dishes do you have" that there are ten when there
 * are forty. Truncated results say so.
 */
export async function searchMenu(
  filters: MenuSearchFilters,
  _restaurantId?: number,
): Promise<MenuSearchResult> {
  const limit = Math.min(Math.max(1, filters.limit ?? 12), 30);

  const candidates = await prisma.menuItem.findMany({
    where: {
      available: true,
      ...(filters.isVeg !== undefined ? { isVeg: filters.isVeg } : {}),
      ...(filters.category
        ? { category: { name: { contains: filters.category, mode: "insensitive" } } }
        : {}),
    },
    include: {
      variants: { where: { available: true }, orderBy: { sortOrder: "asc" } },
      category: { select: { name: true } },
    },
    orderBy: { sortOrder: "asc" },
  });

  const words = (filters.query ?? "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 2);

  const scored: { item: (typeof candidates)[number]; score: number }[] = [];

  for (const item of candidates) {
    if (item.stockCount !== null && item.stockCount === 0) continue;

    const { min, max } = priceRange(item);
    if (filters.maxPrice !== undefined && min > filters.maxPrice) continue;
    if (filters.minPrice !== undefined && max < filters.minPrice) continue;

    let score = 0;
    if (words.length > 0) {
      const haystack = [
        item.name,
        item.description ?? "",
        item.category.name,
        ...item.variants.map((v) => v.name),
      ]
        .join(" ")
        .toLowerCase();
      score = relevance(haystack, words, item.name);
      if (score === 0) continue;
    }

    scored.push({ item, score });
  }

  scored.sort((a, b) => b.score - a.score || a.item.sortOrder - b.item.sortOrder);

  const items = scored.slice(0, limit).map(({ item }) => {
    const flags = [
      item.isVeg ? "veg" : "non-veg",
      item.spiceLevel ?? "",
      item.stockCount !== null ? `only ${item.stockCount} left` : "",
    ]
      .filter(Boolean)
      .join(", ");

    const price =
      item.variants.length > 0
        ? item.variants.map((v) => `${v.name}[v${v.id}]₹${v.price}`).join(" | ")
        : `₹${item.price}`;

    const desc = item.description
      ? ` — ${item.description.length > 80 ? item.description.slice(0, 77) + "…" : item.description}`
      : "";

    return `[${item.id}] ${item.name} — ${price} (${flags})${desc}`;
  });

  return {
    totalMatches: scored.length,
    truncated: scored.length > items.length,
    items,
  };
}

export async function menuAsText(_restaurantId?: number): Promise<string> {
  const cats = await getMenu();

  const availableLines: string[] = [];
  const stockSoldOut: string[] = [];

  for (const c of cats) {
    const lines: string[] = [];
    for (const i of c.items) {
      if (i.stockCount !== null && i.stockCount === 0) {
        stockSoldOut.push(i.name);
        continue;
      }

      const stockTag = i.stockCount !== null ? ` ⚠️ only ${i.stockCount} left` : "";

      const flags = [
        i.isVeg ? "(veg)" : "",
        i.spiceLevel ? `[${i.spiceLevel}]` : "",
        i.description ? `— ${i.description}` : "",
        i.pieceInfo ? `(pieceInfo: ${i.pieceInfo} — mention only if asked)` : "",
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

  const dbSoldOut = await prisma.menuItem.findMany({
    where: { available: false },
    select: { name: true },
  });
  const allSoldOut = [...dbSoldOut.map((s) => s.name), ...stockSoldOut];
  const soldOutLine = allSoldOut.length
    ? `\n\nSOLD OUT right now (do NOT accept orders for these): ${allSoldOut.join(", ")}`
    : "";

  return available + soldOutLine;
}

export async function menuForCustomer(_restaurantId?: number): Promise<string> {
  const cats = await getMenu();
  const sections: string[] = [];

  for (const c of cats) {
    const lines: string[] = [`*${c.name}*`];
    for (const i of c.items) {
      if (i.stockCount !== null && i.stockCount === 0) continue;
      const veg = i.isVeg ? " 🌿" : "";
      if (i.variants.length > 0) {
        const vars = i.variants.map((v) => `${v.name} ₹${v.price}`).join(" / ");
        lines.push(`  • ${i.name}${veg} — ${vars}`);
      } else {
        lines.push(`  • ${i.name}${veg} — ₹${i.price}`);
      }
    }
    if (lines.length > 1) sections.push(lines.join("\n"));
  }

  return sections.length ? sections.join("\n\n") : "(Menu coming soon)";
}

export async function findItems(query: string, _restaurantId?: number) {
  const q = query.trim().toLowerCase();
  const all = await prisma.menuItem.findMany({
    where: { available: true },
    include: { variants: { where: { available: true } } },
  });
  const exact = all.filter((i) => i.name.toLowerCase() === q);
  if (exact.length) return exact;
  return all.filter(
    (i) => i.name.toLowerCase().includes(q) || q.includes(i.name.toLowerCase()),
  );
}

const DEFAULT_FOOD_IMAGES: Record<string, string> = {
  biryani: "https://images.unsplash.com/photo-1563379091339-03b21ab4a4f8?w=800&auto=format&fit=crop&q=80",
  starter: "https://images.unsplash.com/photo-1626777552726-4a6b54c97e46?w=800&auto=format&fit=crop&q=80",
  chicken: "https://images.unsplash.com/photo-1603894584373-5ac82b2ae398?w=800&auto=format&fit=crop&q=80",
  mutton: "https://images.unsplash.com/photo-1544025162-d76694265947?w=800&auto=format&fit=crop&q=80",
  paneer: "https://images.unsplash.com/photo-1631452180519-c014fe946bc7?w=800&auto=format&fit=crop&q=80",
  default: "https://images.unsplash.com/photo-1589301760014-d929f3979dbc?w=800&auto=format&fit=crop&q=80",
};

function getFoodImage(name: string, catName: string, existingUrl?: string | null): string {
  if (existingUrl && existingUrl.trim().length > 5) return existingUrl.trim();
  const n = (name + " " + catName).toLowerCase();
  if (n.includes("biryani")) return DEFAULT_FOOD_IMAGES.biryani;
  if (n.includes("starter") || n.includes("fry") || n.includes("65")) return DEFAULT_FOOD_IMAGES.starter;
  if (n.includes("chicken")) return DEFAULT_FOOD_IMAGES.chicken;
  if (n.includes("mutton")) return DEFAULT_FOOD_IMAGES.mutton;
  if (n.includes("paneer")) return DEFAULT_FOOD_IMAGES.paneer;
  return DEFAULT_FOOD_IMAGES.default;
}

export async function menuAsInteractiveCarouselCards(_restaurantId?: number) {
  const categories = await getMenu();
  const cards: Array<{ title: string; desc: string; imageUrl: string; buttonId: string; buttonTitle: string }> = [];

  for (const cat of categories) {
    for (const item of cat.items) {
      if (cards.length >= 10) break;
      const imageUrl = getFoodImage(item.name, cat.name, item.imageUrl);

      let price = "";
      if (item.variants.length > 0) {
        const prices = item.variants.map((v) => v.price);
        const min = Math.min(...prices);
        const max = Math.max(...prices);
        price = min === max ? `₹${min}` : `₹${min}–₹${max}`;
      } else {
        price = `₹${item.price}`;
      }
      const descParts = [price, item.description].filter(Boolean).join(" · ");

      cards.push({
        title: item.name.length > 60 ? item.name.slice(0, 57) + "…" : item.name,
        desc: descParts.length > 72 ? descParts.slice(0, 69) + "…" : descParts,
        imageUrl,
        buttonId: `menu_item_${item.id}`,
        buttonTitle: "Add",
      });
    }
  }
  return cards;
}

export async function menuAsInteractiveListSections(_restaurantId?: number) {
  const categories = await getMenu();

  const sections: { title: string; rows: any[] }[] = [];
  let totalRows = 0;
  const maxRowsTotal = 10;
  const itemsPerCat = Math.max(1, Math.floor(maxRowsTotal / Math.max(1, categories.length)));

  for (const cat of categories) {
    if (totalRows >= maxRowsTotal) break;

    const availableItems = cat.items.filter((i) => i.available && (i.stockCount === null || i.stockCount > 0));
    const itemsToInclude = availableItems.slice(0, itemsPerCat);

    const rows: any[] = [];
    for (const item of itemsToInclude) {
      if (totalRows >= maxRowsTotal) break;

      const veg = item.isVeg ? "🌿 " : "🍗 ";
      const rawTitle = `${veg}${item.name}`;
      const title = rawTitle.length > 24 ? rawTitle.slice(0, 21) + "…" : rawTitle;

      let price = "";
      if (item.variants.length > 0) {
        const prices = item.variants.map((v) => v.price);
        const min = Math.min(...prices);
        const max = Math.max(...prices);
        price = min === max ? `₹${min}` : `₹${min}–₹${max}`;
      } else {
        price = `₹${item.price}`;
      }
      const rawDesc = `${price}${item.description ? ` · ${item.description}` : ""}`;
      const description = rawDesc.length > 72 ? rawDesc.slice(0, 69) + "…" : rawDesc;

      rows.push({
        id: `menu_item_${item.id}`,
        title,
        description,
      });
      totalRows++;
    }

    if (rows.length > 0) {
      sections.push({ title: cat.name, rows });
    }
  }

  return sections;
}

export async function menuAsInteractiveListSectionsForFilter(
  filterQuery: string,
  _restaurantId?: number,
) {
  const categories = await getMenu();
  const q = filterQuery.trim().toLowerCase();

  const sections: { title: string; rows: any[] }[] = [];
  let totalRows = 0;

  for (const cat of categories) {
    if (totalRows >= 10) break;

    const catMatches = cat.name.toLowerCase().includes(q) || q.includes(cat.name.toLowerCase());

    const availableItems = cat.items.filter((i) => {
      if (!i.available || (i.stockCount !== null && i.stockCount === 0)) return false;
      if (catMatches) return true;
      if (q === "veg" || q === "vegetarian") return i.isVeg;
      if (q === "non-veg" || q === "nonveg") return !i.isVeg;
      return (
        i.name.toLowerCase().includes(q) ||
        (i.description && i.description.toLowerCase().includes(q))
      );
    });

    if (availableItems.length === 0) continue;

    const rows: any[] = [];
    for (const item of availableItems) {
      if (totalRows >= 10) break;

      const veg = item.isVeg ? "🌿 " : "🍗 ";
      const rawTitle = `${veg}${item.name}`;
      const title = rawTitle.length > 24 ? rawTitle.slice(0, 21) + "…" : rawTitle;

      let price = "";
      if (item.variants.length > 0) {
        const prices = item.variants.map((v) => v.price);
        const min = Math.min(...prices);
        const max = Math.max(...prices);
        price = min === max ? `₹${min}` : `₹${min}–₹${max}`;
      } else {
        price = `₹${item.price}`;
      }
      const stockTag =
        item.stockCount !== null && item.stockCount <= 5
          ? ` ⚠️ ${item.stockCount} left`
          : "";
      const rawDesc = `${price}${stockTag}${item.description ? ` · ${item.description}` : ""}`;
      const description = rawDesc.length > 72 ? rawDesc.slice(0, 69) + "…" : rawDesc;

      rows.push({
        id: `menu_item_${item.id}`,
        title,
        description,
      });
      totalRows++;
    }

    if (rows.length > 0) {
      sections.push({ title: cat.name, rows });
    }
  }

  return sections;
}
