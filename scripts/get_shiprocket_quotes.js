// Using global fetch built into Node.js

/**
 * Shiprocket Courier Serviceability & Rate Quote Script
 * 
 * Pickup Location: Godavari Ruchulu, MLA Colony, Jubilee Hills, Hyderabad (500033)
 * 
 * Usage:
 *   SHIPROCKET_EMAIL="your@email.com" SHIPROCKET_PASSWORD="yourpassword" node scripts/get_shiprocket_quotes.js
 */

const PICKUP_PINCODE = 500033; // Jubilee Hills / MLA Colony
const PICKUP_ADDRESS = "Godavari Ruchulu, MLA Colony, Jubilee Hills, Hyderabad";

const DROP_LOCATIONS = [
  { name: "Jubilee Hills", pincode: 500033, approxDistKm: 1 },
  { name: "Banjara Hills", pincode: 500034, approxDistKm: 3 },
  { name: "Madhapur / Hitec City", pincode: 500081, approxDistKm: 4 },
  { name: "Gachibowli", pincode: 500032, approxDistKm: 6 },
  { name: "Kondapur", pincode: 500084, approxDistKm: 7 },
  { name: "Ameerpet", pincode: 500038, approxDistKm: 6 },
  { name: "Begumpet", pincode: 500016, approxDistKm: 8 },
  { name: "Kukatpally / KPHB", pincode: 500072, approxDistKm: 10 },
  { name: "Secunderabad", pincode: 500003, approxDistKm: 13 },
  { name: "Charminar / Old City", pincode: 500002, approxDistKm: 14 },
  { name: "Dilsukhnagar / LB Nagar", pincode: 500036, approxDistKm: 16 },
];

async function getAuthToken(email, password) {
  console.log(`\n🔐 Authenticating with Shiprocket API (${email})...`);
  const res = await fetch("https://apiv2.shiprocket.in/v1/external/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Authentication failed (${res.status}): ${err}`);
  }

  const data = await res.json();
  console.log("✅ Authenticated successfully!");
  return data.token;
}

async function fetchServiceability(token, deliveryPincode, weightKg = 0.5, cod = 0) {
  const url = `https://apiv2.shiprocket.in/v1/external/courier/serviceability/?pickup_postcode=${PICKUP_PINCODE}&delivery_postcode=${deliveryPincode}&weight=${weightKg}&cod=${cod}`;
  
  const res = await fetch(url, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    },
  });

  if (!res.ok) {
    const err = await res.text();
    return { ok: false, error: err };
  }

  return { ok: true, data: await res.json() };
}

async function main() {
  const email = process.env.SHIPROCKET_EMAIL;
  const password = process.env.SHIPROCKET_PASSWORD;

  console.log("==========================================================================");
  console.log("📍 SHIPROCKET HYDERABAD DELIVERY QUOTE CALCULATOR");
  console.log(`Pickup Point: ${PICKUP_ADDRESS} (Pincode: ${PICKUP_PINCODE})`);
  console.log("==========================================================================");

  if (!email || !password) {
    console.log("\n⚠️  No SHIPROCKET_EMAIL or SHIPROCKET_PASSWORD environment variables found.");
    console.log("Displaying standard rate estimates & API execution guide below.\n");
    printEstimatedRateCard();
    return;
  }

  try {
    const token = await getAuthToken(email, password);

    console.log("\n📦 Fetching real-time courier quotes across Hyderabad drop locations...\n");

    for (const drop of DROP_LOCATIONS) {
      console.log(`--------------------------------------------------------------------------`);
      console.log(`🎯 Drop Location: ${drop.name} (Pincode: ${drop.pincode}) ~${drop.approxDistKm} km`);
      
      const result = await fetchServiceability(token, drop.pincode);

      if (!result.ok) {
        console.log(`   ❌ Error fetching serviceability: ${result.error}`);
        continue;
      }

      const couriers = result.data?.data?.available_courier_companies ?? [];
      if (couriers.length === 0) {
        console.log("   ⚠️ No serviceable couriers found for this pincode.");
        continue;
      }

      console.log(`   Found ${couriers.length} available courier options:`);
      for (const c of couriers.slice(0, 5)) { // Show top 5
        console.log(`   • ${c.courier_name.padEnd(25)} | Rate: ₹${c.rate} | Est. Delivery: ${c.etd} | COD: ${c.cod ? "Yes" : "No"}`);
      }
    }

    console.log("\n==========================================================================");
    console.log("✅ Quote fetch complete!");
  } catch (err) {
    console.error("❌ Execution Error:", err.message);
  }
}

function printEstimatedRateCard() {
  console.log("--------------------------------------------------------------------------");
  console.log("ESTIMATED HYDERALOCAL & COURIER RATES FROM MLA COLONY, JUBILEE HILLS (500033)");
  console.log("--------------------------------------------------------------------------\n");

  const tableData = DROP_LOCATIONS.map(d => {
    let hyperlocalRate = "";
    let surfaceRate = "";
    let estimatedTime = "";

    if (d.approxDistKm <= 3) {
      hyperlocalRate = "₹45 – ₹60";
      surfaceRate = "₹40 – ₹50";
      estimatedTime = "20 – 35 mins";
    } else if (d.approxDistKm <= 6) {
      hyperlocalRate = "₹60 – ₹85";
      surfaceRate = "₹45 – ₹55";
      estimatedTime = "30 – 45 mins";
    } else if (d.approxDistKm <= 10) {
      hyperlocalRate = "₹85 – ₹120";
      surfaceRate = "₹50 – ₹65";
      estimatedTime = "40 – 60 mins";
    } else {
      hyperlocalRate = "₹120 – ₹170";
      surfaceRate = "₹60 – ₹80";
      estimatedTime = "60 – 90 mins";
    }

    return {
      Location: d.name,
      Pincode: d.pincode,
      Dist: `~${d.approxDistKm} km`,
      "Hyperlocal (Shiprocket Quick)": hyperlocalRate,
      "Standard Courier": surfaceRate,
      "Estimated Time": estimatedTime,
    };
  });

  console.table(tableData);
}

main();
