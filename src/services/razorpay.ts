import Razorpay from "razorpay";
import { createHmac } from "node:crypto";
import { prisma } from "../db.js";

function rzpError(e: any): string {
  return (
    e?.error?.description ??
    e?.error?.reason ??
    e?.message ??
    JSON.stringify(e) ??
    "Unknown Razorpay error"
  );
}

async function getClient(_restaurantId?: number): Promise<Razorpay | null> {
  const cfg = await prisma.restaurantConfig.findUnique({ where: { id: 1 } });
  if (!cfg?.razorpayKeyId || !cfg.razorpayKeySecret) {
    console.warn("[Razorpay] Keys not configured in RestaurantConfig");
    return null;
  }
  return new Razorpay({ key_id: cfg.razorpayKeyId, key_secret: cfg.razorpayKeySecret });
}

export async function createPaymentLink(params: {
  restaurantId?: number;
  customerId: number;
  amount: number;
  customerPhone: string;
  restaurantName: string;
}): Promise<{ id: string; url: string } | null> {
  const client = await getClient(params.restaurantId);
  if (!client) return null;

  const contactRaw = params.customerPhone.startsWith("+")
    ? params.customerPhone
    : `+${params.customerPhone}`;
  const contact = contactRaw.length >= 8 && contactRaw.length <= 14 ? contactRaw : undefined;

  try {
    const link = await client.paymentLink.create({
      amount: Math.round(params.amount * 100),
      currency: "INR",
      description: `Order from ${params.restaurantName}`,
      ...(contact ? { customer: { contact } } : {}),
      notify: { sms: false, email: false },
      reminder_enable: false,
      notes: {
        restaurantId: String(params.restaurantId ?? 1),
        customerId: String(params.customerId),
      },
    } as any);

    console.log(`[Razorpay] Payment link created — ${(link as any).short_url}`);
    return { id: (link as any).id, url: (link as any).short_url };
  } catch (e: any) {
    console.error("[Razorpay] createPaymentLink failed —", rzpError(e));
    throw new Error(`Razorpay: ${rzpError(e)}`);
  }
}

export async function verifyWebhookSignature(
  rawBody: string,
  signature: string,
  _restaurantId?: number,
): Promise<boolean> {
  const cfg = await prisma.restaurantConfig.findUnique({ where: { id: 1 } });
  if (!cfg?.razorpayWebhookSecret) {
    // Fail closed. This used to return true, so with no secret configured ANY
    // unsigned POST to /webhook/razorpay could mark an order paid — fine behind an
    // obscure tunnel, not on a stable public URL.
    console.error("[Razorpay] No webhook secret configured — rejecting webhook");
    return false;
  }
  const expected = createHmac("sha256", cfg.razorpayWebhookSecret)
    .update(rawBody)
    .digest("hex");
  return expected === signature;
}
