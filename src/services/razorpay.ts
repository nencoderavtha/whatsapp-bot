import Razorpay from "razorpay";
import { createHmac } from "node:crypto";
import { prisma } from "../db.js";
import { DEFAULT_RESTAURANT_ID } from "../tenancy.js";

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
  const cfg = await prisma.restaurantConfig.findUnique({ where: { id: DEFAULT_RESTAURANT_ID } });
  if (!cfg?.razorpayKeyId || !cfg.razorpayKeySecret) {
    console.warn("[Razorpay] Keys not configured in RestaurantConfig");
    return null;
  }
  return new Razorpay({ key_id: cfg.razorpayKeyId, key_secret: cfg.razorpayKeySecret });
}

export async function cancelPaymentLink(linkId: string, restaurantId?: number): Promise<boolean> {
  if (!linkId) return false;
  const client = await getClient(restaurantId);
  if (!client) return false;
  try {
    await client.paymentLink.cancel(linkId);
    console.log(`[Razorpay] Cancelled old payment link: ${linkId}`);
    return true;
  } catch (e: any) {
    console.warn(`[Razorpay] Could not cancel payment link ${linkId}:`, rzpError(e));
    return false;
  }
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

  // 1. Cancel any existing active payment link for this customer so ONLY ONE link is active!
  const pending = await prisma.pendingOrder.findUnique({ where: { customerId: params.customerId } });
  if (pending?.razorpayLinkId) {
    await cancelPaymentLink(pending.razorpayLinkId, params.restaurantId);
  }

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
        restaurantId: String(params.restaurantId ?? DEFAULT_RESTAURANT_ID),
        customerId: String(params.customerId),
      },
    } as any);

    const linkId = (link as any).id;
    const shortUrl = (link as any).short_url;

    // 2. Save new active payment link ID on PendingOrder
    if (pending) {
      await prisma.pendingOrder.update({
        where: { customerId: params.customerId },
        data: { razorpayLinkId: linkId, razorpayLinkUrl: shortUrl },
      }).catch(() => {});
    }

    console.log(`[Razorpay] New payment link created — ${shortUrl}`);
    return { id: linkId, url: shortUrl };
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
  const cfg = await prisma.restaurantConfig.findUnique({ where: { id: DEFAULT_RESTAURANT_ID } });
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
