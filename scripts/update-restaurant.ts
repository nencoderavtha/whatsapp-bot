import 'dotenv/config';
import { prisma } from '../src/db.js';

async function run() {
  console.log("Connecting to Database:", process.env.DATABASE_URL?.replace(/:[^:@]+@/, ':****@'));

  const updated = await prisma.restaurantConfig.updateMany({
    data: {
      restaurantName: "Venky's Idly",
      restaurantAddress: "5, Kukatpally Housing Board Rd, Kukatpally Housing Board Colony, K P H B Phase 1, Kukatpally, Hyderabad, Telangana 500072",
      restaurantCity: "Hyderabad",
      restaurantLat: 17.4929148369678,
      restaurantLng: 78.39597322530967,
    },
  });

  console.log(`\n🎉 SUCCESS! Updated ${updated.count} restaurant config record(s) in project kkxftlwsijprcfwjqyxw.`);

  const currentConfigs = await prisma.restaurantConfig.findMany();
  console.log("\n📍 [Current Restaurant Configuration in DB]:");
  console.log(JSON.stringify(currentConfigs, null, 2));
}

run().catch((err) => {
  console.error("❌ Error updating restaurant config:", err);
  process.exit(1);
});
