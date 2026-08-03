import { PrismaClient } from '@prisma/client';

const host = 'aws-1-ap-south-2.pooler.supabase.com';
const project = 'kxftlwsijprcfwjqyxw';
const pass = 'sathvik@2004';

const url = `postgresql://postgres.${project}:${encodeURIComponent(pass)}@${host}:6543/postgres?pgbouncer=true`;
const client = new PrismaClient({ datasources: { db: { url } } });

async function run() {
  try {
    const updated = await client.restaurantConfig.updateMany({
      data: {
        restaurantName: "Venky's Idly",
        restaurantAddress: "5, Kukatpally Housing Board Rd, Kukatpally Housing Board Colony, K P H B Phase 1, Kukatpally, Hyderabad, Telangana 500072",
        restaurantCity: "Hyderabad",
        restaurantLat: 17.4929148369678,
        restaurantLng: 78.39597322530967,
      }
    });
    console.log(`\n🎉 SUCCESS! Updated ${updated.count} row(s).`);
  } catch (err: any) {
    console.error("Full error message:", err);
  } finally {
    await client.$disconnect();
  }
}

run();
