import { PrismaClient } from '@prisma/client';

const poolers = [
  'aws-0-ap-south-1.pooler.supabase.com',
  'aws-1-ap-south-1.pooler.supabase.com',
  'aws-0-ap-southeast-1.pooler.supabase.com',
  'aws-1-ap-southeast-1.pooler.supabase.com',
  'aws-0-ap-northeast-2.pooler.supabase.com',
  'aws-1-ap-northeast-2.pooler.supabase.com',
  'aws-0-ap-northeast-1.pooler.supabase.com',
  'aws-1-ap-northeast-1.pooler.supabase.com',
  'aws-0-us-east-1.pooler.supabase.com',
  'aws-1-us-east-1.pooler.supabase.com',
  'aws-0-eu-central-1.pooler.supabase.com',
  'aws-1-eu-central-1.pooler.supabase.com',
];

async function run() {
  const pass = 'sathvik@2004';
  const project = 'kxftlwsijprcfwjqyxw';

  for (const host of poolers) {
    const url = `postgresql://postgres.${project}:${encodeURIComponent(pass)}@${host}:6543/postgres?pgbouncer=true`;
    console.log(`Checking ${host}...`);
    const client = new PrismaClient({ datasources: { db: { url } } });
    try {
      const count = await client.restaurantConfig.count();
      console.log(`\n🎉 MATCH! Host ${host} connected! Count: ${count}`);
      const updated = await client.restaurantConfig.updateMany({
        data: {
          restaurantName: "Venky's Idly",
          restaurantAddress: "5, Kukatpally Housing Board Rd, Kukatpally Housing Board Colony, K P H B Phase 1, Kukatpally, Hyderabad, Telangana 500072",
          restaurantCity: "Hyderabad",
          restaurantLat: 17.4929148369678,
          restaurantLng: 78.39597322530967,
        }
      });
      console.log(`Updated ${updated.count} row(s) in RestaurantConfig on project ${project}!`);
      break;
    } catch (err: any) {
      const msg = String(err?.message || err);
      if (msg.includes("tenant/user")) {
        // Not this host
      } else {
        console.log(`Host ${host} error:`, msg.slice(0, 150));
      }
    } finally {
      await client.$disconnect();
    }
  }
}

run();
