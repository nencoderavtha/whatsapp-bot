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

async function main() {
  let sort = 0;
  for (const [catName, items] of Object.entries(MENU)) {
    const cat = await prisma.category.upsert({
      where: { name: catName },
      update: { sortOrder: sort },
      create: { name: catName, sortOrder: sort },
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
        },
      });
    }
  }
  console.log("✅ Seeded menu.");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
