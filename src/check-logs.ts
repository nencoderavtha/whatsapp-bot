import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
async function main() {
  const customer = await prisma.customer.findFirst({
    where: { phone: "919398449524" },
    include: {
      pendingOrder: true,
      messages: { orderBy: { createdAt: "desc" }, take: 5 }
    }
  });
  console.log("CUSTOMER DETAILS:");
  console.log(JSON.stringify(customer, null, 2));
}
main().catch(console.error).finally(() => prisma.$disconnect());
