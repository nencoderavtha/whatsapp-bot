import dotenv from "dotenv";
dotenv.config();

async function testCreds(name: string, clientId: string, clientSecret: string) {
  console.log(`\n--- Testing ${name} ---`);
  console.log("Client ID:", clientId);

  const params = new URLSearchParams();
  params.append("client_id", clientId);
  params.append("client_secret", clientSecret);
  params.append("grant_type", "client_credentials");
  params.append("scope", "eats.deliveries");

  const res = await fetch("https://auth.uber.com/oauth/v2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  const text = await res.text();
  console.log(`OAuth with eats.deliveries -> HTTP ${res.status}:`, text);
}

async function run() {
  await testCreds(
    "New Credentials (.env)",
    process.env.UBER_CLIENT_ID || "",
    process.env.UBER_CLIENT_SECRET || ""
  );

  await testCreds(
    "Previous Working Credentials",
    "VCLNca-Ij09TRPlaLD54Dq0Gb7zhTYoU",
    "QW2a_hLl-L0FHZcwxNcawJknOnUL-DAzQd81m0UU"
  );
}

run().catch(console.error);
