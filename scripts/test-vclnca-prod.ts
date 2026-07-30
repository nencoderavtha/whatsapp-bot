import dotenv from "dotenv";
dotenv.config();

async function run() {
  const clientId = "VCLNca-Ij09TRPlaLD54Dq0Gb7zhTYoU";
  const clientSecret = "QW2a_hLl-L0FHZcwxNcawJknOnUL-DAzQd81m0UU";
  const customerId = "81c31018-3d19-5839-9c9d-20ced36d96b1";

  console.log("Testing OAuth with VCLNca-... credentials...");
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

  const data = await res.json() as any;
  console.log("OAuth token response:", res.status, data.access_token ? "TOKEN_OBTAINED" : data);

  if (data.access_token) {
    console.log("Testing production quote API with VCLNca-... credentials...");
    const quoteRes = await fetch(`https://api.uber.com/v1/customers/${customerId}/delivery_quotes`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${data.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        pickup_address: "Godavari Ruchulu, MLA Colony, Road No 12, Banjara Hills, Hyderabad, Telangana 500034",
        dropoff_address: "Flat 402, My Home Bhooja, Silpa Gram Craft Village, Gachibowli, Hyderabad, Telangana 500081",
        pickup_phone_number: "+919999999999",
        dropoff_phone_number: "+919398449524",
        manifest_total_value: 10000,
      }),
    });

    const quoteText = await quoteRes.text();
    console.log("Production Quote Response HTTP Status:", quoteRes.status);
    console.log("Production Quote Body:", quoteText);
  }
}

run().catch(console.error);
