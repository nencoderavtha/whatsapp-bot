import 'dotenv/config';

async function testWebhook() {
  const cloudRunUrl = "https://godavari-ruchulu-bot-1014973248302.asia-south1.run.app/api/webhooks/delivery/quick";
  console.log(`🌐 Testing live webhook with sr_order_id = 1491464067...`);

  const payload = {
    current_status: "RIDER ASSIGNED",
    order_id: "1491464067",
    sr_order_id: 1491464067,
    shipment_id: 1487687436,
    awb: "6a6f833c48b1e92840e8271d",
    courier_name: "Quick-Rapido",
    rider_name: "VIKKI RAJU ETHADI",
    rider_phone: "6301043511",
  };

  try {
    const res = await fetch(cloudRunUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": "godavari_ruchulu_secret_token",
      },
      body: JSON.stringify(payload),
    });

    const status = res.status;
    const text = await res.text();
    console.log(`\nResponse Status: ${status}`);
    console.log(`Response Body  : ${text}`);
  } catch (err) {
    console.error("Error connecting to Cloud Run webhook:", err);
  }
}

testWebhook();
