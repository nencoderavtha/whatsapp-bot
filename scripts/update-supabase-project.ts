import { PrismaClient } from '@prisma/client';

const regions = [
  'aws-1-ap-northeast-2.pooler.supabase.com',
  'aws-0-ap-northeast-2.pooler.supabase.com',
  'aws-0-ap-northeast-1.pooler.supabase.com',
  'aws-1-ap-northeast-1.pooler.supabase.com',
  'aws-0-ap-south-1.pooler.supabase.com',
  'aws-1-ap-south-1.pooler.supabase.com',
  'aws-0-ap-southeast-1.pooler.supabase.com',
  'aws-1-ap-southeast-1.pooler.supabase.com',
  'aws-0-ap-south-2.pooler.supabase.com',
  'aws-1-ap-south-2.pooler.supabase.com',
  'aws-0-us-east-1.pooler.supabase.com',
  'aws-1-us-east-1.pooler.supabase.com',
  'aws-0-eu-central-1.pooler.supabase.com',
  'aws-1-eu-central-1.pooler.supabase.com',
  'aws-0-eu-west-1.pooler.supabase.com',
  'aws-0-ap-southeast-2.pooler.supabase.com',
];

async function tryConnect(host: string) {
  const url = `postgresql://postgres.kxftlwsijprcfwjqyxw:sathvik@2004@${host}:6543/postgres?pgbouncer=true`;
  const client = new PrismaClient({ datasources: { db: { url } } });
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
    console.log(`\n🎉 SUCCESS! Connected to project kxftlwsijprcfwjqyxw on pooler: ${host}`);
    console.log(`Updated ${updated.count} row(s) in RestaurantConfig.`);
    const all = await client.restaurantConfig.findMany();
    console.log("Updated record:", JSON.stringify(all, null, 2));
    return url;
  } catch (err: any) {
    const msg = String(err?.message || err);
    if (!msg.includes("tenant/user")) {
      console.log(`Response on ${host}:`, msg.slice(0, 120));
    }
    return null;
  } finally {
    await client.$disconnect();
  }
}

async function run() {
  console.log("Scanning pooler regions for project kxftlwsijprcfwjqyxw...");
  for (const host of regions) {
    const successUrl = await tryConnect(host);
    if (successUrl) {
      console.log("\nActive Connection URL:", successUrl);
      break;
    }
  }
}

run();
