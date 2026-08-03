import 'dotenv/config';
import { ShiprocketDeliveryService } from '../src/services/delivery/shiprocket.js';

async function debugOrder() {
  const shiprocket = new ShiprocketDeliveryService();
  const token = await shiprocket.authenticate();

  if (!token) {
    console.error("Failed to authenticate with Shiprocket");
    return;
  }

  const orderId = 1491077101;
  const shipmentId = 1487300474;

  console.log(`\n🔍 === 1. FETCHING ORDER DETAILS FOR ${orderId} ===`);
  try {
    const orderRes = await fetch(`https://apiv2.shiprocket.in/v1/external/orders/show/${orderId}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const orderData = await orderRes.json();
    console.log("Order Show Data:", JSON.stringify(orderData, null, 2));
  } catch (err) {
    console.error("Error fetching order details:", err);
  }

  console.log(`\n🔍 === 2. FETCHING TRACKING DETAILS FOR SHIPMENT ${shipmentId} ===`);
  try {
    const trackRes = await fetch(`https://apiv2.shiprocket.in/v1/external/courier/track/shipment/${shipmentId}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const trackData = await trackRes.json();
    console.log("Tracking Data:", JSON.stringify(trackData, null, 2));
  } catch (err) {
    console.error("Error fetching tracking details:", err);
  }

  console.log(`\n🔍 === 3. CHECKING HYPERLOCAL ORDERS LIST ===`);
  try {
    const hlRes = await fetch(`https://apiv2.shiprocket.in/v1/hyperlocal/orders/hyperlocal?is_web=1&is_hyperlocal=1`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const hlData = await hlRes.json();
    const matched = hlData.data?.find((o: any) => o.id === orderId || o.channel_order_id?.startsWith("9"));
    console.log("Matched Order in Hyperlocal List:", JSON.stringify(matched, null, 2));
  } catch (err) {
    console.error("Error fetching hyperlocal list:", err);
  }
}

debugOrder();
