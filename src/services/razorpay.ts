import Razorpay from "razorpay";
import { createHmac } from "node:crypto";
import { prisma } from "../db.js";

function rzpError(e: any): string {
  // Razorpay SDK throws plain objects, not Error instances
  return (
    e?.error?.description ??
    e?.error?.reason ??
    e?.message ??
    JSON.stringify(e) ??
    "Unknown Razorpay error"
  );
}

async function getClient(restaurantId: number): Promise<Razorpay | null> {
  const cfg = await prisma.botConfig.findUnique({ where: { id: restaurantId } });
  if (!cfg?.razorpayKeyId || !cfg.razorpayKeySecret) {
    console.warn(`[Razorpay] r${restaurantId}: keys not configured`);
    return null;
  }
  return new Razorpay({ key_id: cfg.razorpayKeyId, key_secret: cfg.razorpayKeySecret });
}

export async function createPaymentLink(params: {
  restaurantId: number;
  customerId: number;
  amount: number;          // in ₹ (not paise)
  customerPhone: string;
  restaurantName: string;
}): Promise<{ id: string; url: string } | null> {
  const client = await getClient(params.restaurantId);
  if (!client) return null;

  // WhatsApp stores numbers as 919876543210 (country code, no +); Razorpay wants +919876543210
  // LID-type JIDs look like phone numbers but can be 15+ digits — Razorpay cap is 8-14 chars
  const contactRaw = params.customerPhone.startsWith("+")
    ? params.customerPhone
    : `+${params.customerPhone}`;
  const contact = contactRaw.length >= 8 && contactRaw.length <= 14 ? contactRaw : undefined;

  try {
    const link = await client.paymentLink.create({
      amount: Math.round(params.amount * 100), // paise
      currency: "INR",
      description: `Order from ${params.restaurantName}`,
      ...(contact ? { customer: { contact } } : {}),
      notify: { sms: false, email: false },
      reminder_enable: false,
      notes: {
        restaurantId: String(params.restaurantId),
        customerId: String(params.customerId),
      },
    } as any);

    console.log(`[Razorpay] r${params.restaurantId}: payment link created — ${(link as any).short_url}`);
    return { id: (link as any).id, url: (link as any).short_url };
  } catch (e: any) {
    console.error(`[Razorpay] r${params.restaurantId}: createPaymentLink failed —`, rzpError(e));
    throw new Error(`Razorpay: ${rzpError(e)}`);
  }
}

// Verify that the webhook payload came from Razorpay (HMAC-SHA256).
// If no webhook secret is configured, the check is skipped (with a warning) so
// orders still auto-confirm during initial setup before the secret is added.
export async function verifyWebhookSignature(
  rawBody: string,
  signature: string,
  restaurantId: number,
): Promise<boolean> {
  const cfg = await prisma.botConfig.findUnique({ where: { id: restaurantId } });
  if (!cfg?.razorpayWebhookSecret) {
    console.warn(`[Razorpay] r${restaurantId}: no webhook secret — skipping signature check`);
    return true;
  }
  const expected = createHmac("sha256", cfg.razorpayWebhookSecret)
    .update(rawBody)
    .digest("hex");
  return expected === signature;
}
