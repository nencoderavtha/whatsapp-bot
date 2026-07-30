import { prisma } from "../db.js";

async function main() {
  const botCfg = await prisma.restaurantConfig.findUnique({
    where: { id: 1 },
    select: { whatsappPhone: true, cloudPhoneNumberId: true, cloudToken: true },
  });
  console.log("DB Config:", botCfg);
  console.log("ENV Config PhoneId:", process.env.WHATSAPP_PHONE_NUMBER_ID);
  
  if (botCfg?.cloudToken && botCfg.cloudToken !== process.env.WHATSAPP_CLOUD_TOKEN) {
    console.log("Tokens are different!");
  }
}

main().catch(console.error);
