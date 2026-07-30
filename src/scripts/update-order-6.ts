import { prisma } from "../db.js";

async function main() {
  const o = await prisma.order.findUnique({ where: { id: 6 }, include: { deliveryDispatch: true } });
  if (o) {
    const newFee = 133.93;
    const newTotal = o.subtotal + newFee;
    await prisma.order.update({
      where: { id: 6 },
      data: { deliveryFee: newFee, total: newTotal }
    });
    if (o.deliveryDispatch) {
      await prisma.deliveryDispatch.update({
        where: { id: o.deliveryDispatch.id },
        data: { deliveryFee: newFee }
      });
    }
    console.log(`Successfully updated Order #6 in DB: deliveryFee=133.93, total=${newTotal}`);
  } else {
    console.log("Order #6 not found, listing recent orders...");
    const orders = await prisma.order.findMany({ orderBy: { id: "desc" }, take: 5 });
    console.log(orders);
  }
}

main().finally(() => prisma.$disconnect());
