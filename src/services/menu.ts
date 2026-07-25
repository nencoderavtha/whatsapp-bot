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

export async function menuAsInteractiveCarouselCards(_restaurantId?: number) {
  const categories = await getMenu();
  const cards: Array<{ title: string; desc: string; imageUrl: string; buttonId: string; buttonTitle: string }> = [];

  for (const cat of categories) {
    for (const item of cat.items) {
      if (cards.length >= 10) break;
      if (!item.imageUrl) continue;

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
        imageUrl: item.imageUrl,
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
