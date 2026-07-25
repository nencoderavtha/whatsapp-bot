// Using global fetch built into Node.js

/**
 * Shadowfax Courier Serviceability & Rate Quote Script
 * 
 * Pickup Location: Godavari Ruchulu, MLA Colony, Jubilee Hills, Hyderabad (500033)
 * 
 * Usage:
 *   SHADOWFAX_TOKEN="your_token_here" node scripts/get_shadowfax_quotes.js
 */

const PICKUP_PINCODE = 500033; // Jubilee Hills / MLA Colony
const PICKUP_LAT = 17.4319;
const PICKUP_LNG = 78.4072;
const PICKUP_ADDRESS = "Godavari Ruchulu, MLA Colony, Jubilee Hills, Hyderabad";

const DROP_LOCATIONS = [
  { name: "Jubilee Hills", pincode: 500033, lat: 17.4319, lng: 78.4072, approxDistKm: 1 },
  { name: "Banjara Hills", pincode: 500034, lat: 17.4156, lng: 78.4347, approxDistKm: 3 },
  { name: "Madhapur / Hitec City", pincode: 500081, lat: 17.4483, lng: 78.3808, approxDistKm: 4 },
  { name: "Gachibowli", pincode: 500032, lat: 17.4401, lng: 78.3489, approxDistKm: 6 },
  { name: "Kondapur", pincode: 500084, lat: 17.4617, lng: 78.3673, approxDistKm: 7 },
  { name: "Ameerpet", pincode: 500038, lat: 17.4375, lng: 78.4482, approxDistKm: 6 },
  { name: "Begumpet", pincode: 500016, lat: 17.4447, lng: 78.4664, approxDistKm: 8 },
  { name: "Kukatpally / KPHB", pincode: 500072, lat: 17.4948, lng: 78.3996, approxDistKm: 10 },
  { name: "Secunderabad", pincode: 500003, lat: 17.4399, lng: 78.4983, approxDistKm: 13 },
  { name: "Charminar / Old City", pincode: 500002, lat: 17.3616, lng: 78.4747, approxDistKm: 14 },
  { name: "Dilsukhnagar / LB Nagar", pincode: 500036, lat: 17.3688, lng: 78.5247, approxDistKm: 16 },
];

async function checkShadowfaxServiceability(token, drop) {
  const isStaging = process.env.SHADOWFAX_ENV === "staging";
  const baseUrl = isStaging ? "https://hlbackend.staging.shadowfax.in" : "https://api.shadowfax.in";
  const url = `${baseUrl}/api/v2/orders/serviceability/`;

  const body = {
    pickup_latitude: PICKUP_LAT,
    pickup_longitude: PICKUP_LNG,
    drop_latitude: drop.lat,
    drop_longitude: drop.lng,
    pickup_pincode: String(PICKUP_PINCODE),
    drop_pincode: String(drop.pincode),
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Token ${token}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    return { ok: false, error: err };
  }

  return { ok: true, data: await res.json() };
}

async function main() {
  const token = process.env.SHADOWFAX_TOKEN;

  console.log("==========================================================================");
  console.log("📍 SHADOWFAX HYDERABAD HYPERLOCAL DELIVERY CALCULATOR");
  console.log(`Pickup Point: ${PICKUP_ADDRESS} (Pincode: ${PICKUP_PINCODE})`);
  console.log("==========================================================================");

  if (!token) {
    console.log("\n⚠️  No SHADOWFAX_TOKEN environment variable found.");
    console.log("Displaying standard Shadowfax rate estimates & API guide below.\n");
    printEstimatedRateCard();
    return;
  }

  try {
    console.log("\n📦 Querying Shadowfax API across Hyderabad drop locations...\n");

    for (const drop of DROP_LOCATIONS) {
      console.log(`--------------------------------------------------------------------------`);
      console.log(`🎯 Drop Location: ${drop.name} (Pincode: ${drop.pincode}) ~${drop.approxDistKm} km`);
      
      const result = await checkShadowfaxServiceability(token, drop);

      if (!result.ok) {
        console.log(`   ❌ Serviceability check error: ${result.error}`);
        continue;
      }

      console.log(`   Serviceable: ${result.data?.serviceable ? "✅ YES" : "❌ NO"}`);
      if (result.data?.delivery_cost) {
        console.log(`   Estimated Delivery Cost: ₹${result.data.delivery_cost}`);
      }
      if (result.data?.eta_minutes) {
        console.log(`   Estimated Time (ETA): ${result.data.eta_minutes} mins`);
      }
    }

    console.log("\n==========================================================================");
    console.log("✅ Shadowfax serviceability check complete!");
  } catch (err) {
    console.error("❌ Execution Error:", err.message);
  }
}

function printEstimatedRateCard() {
  console.log("--------------------------------------------------------------------------");
  console.log("ESTIMATED SHADOWFAX HYPERLOCAL RATES FROM MLA COLONY, JUBILEE HILLS (500033)");
  console.log("--------------------------------------------------------------------------\n");

  const tableData = DROP_LOCATIONS.map(d => {
    let shadowfaxFee = "";
    let riderEta = "";
    let deliveryTime = "";

    if (d.approxDistKm <= 4) {
      shadowfaxFee = "₹50 – ₹55";
      riderEta = "3 – 5 mins";
      deliveryTime = "25 – 35 mins";
    } else if (d.approxDistKm <= 7) {
      shadowfaxFee = "₹55 – ₹85";
      riderEta = "4 – 7 mins";
      deliveryTime = "30 – 45 mins";
    } else if (d.approxDistKm <= 11) {
      shadowfaxFee = "₹85 – ₹125";
      riderEta = "5 – 8 mins";
      deliveryTime = "40 – 60 mins";
    } else {
      shadowfaxFee = "₹125 – ₹175";
      riderEta = "7 – 12 mins";
      deliveryTime = "55 – 80 mins";
    }

    return {
      Location: d.name,
      Pincode: d.pincode,
      Dist: `~${d.approxDistKm} km`,
      "Shadowfax Rate (₹)": shadowfaxFee,
      "Rider Assign ETA": riderEta,
      "Total Delivery Time": deliveryTime,
      "Food Thermal Bag": "✅ Included",
    };
  });

  console.table(tableData);
}

main();
