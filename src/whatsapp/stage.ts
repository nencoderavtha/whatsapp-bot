/**
 * Order-stage transitions.
 *
 * A cart edit must not restart the journey. Once an address is on file the
 * customer should never be asked for it again just because they added a dish —
 * the cart rewinds only as far as the quote, which is the thing the edit
 * actually invalidated.
 */

import type { OrderStage } from "@prisma/client";
import { prisma } from "../db.js";
import type { CloudAdapter } from "./cloud.js";
import { renderPaymentLinkVoided, type Rendered } from "./renderers.js";

/** Send a rendered descriptor over whichever WhatsApp primitive it needs. */
export async function send(adapter: CloudAdapter, phone: string, msg: Rendered): Promise<void> {
  switch (msg.kind) {
    case "text":
      await adapter.sendText(phone, msg.body);
      return;
    case "buttons":
      await adapter.sendInteractiveButtons(phone, msg.body, msg.buttons, msg.header, msg.footer);
      return;
    case "cta":
      await adapter.sendInteractiveCtaUrl(phone, msg.body, msg.buttonTitle, msg.url);
      return;
  }
}

/**
 * Where a cart returns to after its contents change.
 *
 * Past PAYMENT_RECEIVED the order is settled and edits are refused upstream, so
 * those stages are left alone rather than silently rewound.
 */
export function stageAfterCartEdit(current: OrderStage): OrderStage {
  switch (current) {
    case "ADDRESS_SELECTED":
    case "QUOTE_GENERATED":
    case "AWAITING_PAYMENT":
      // Address survives; the quote and any payment link do not.
      return "ADDRESS_SELECTED";
    default:
      return "BUILDING_CART";
  }
}

/** Stages where the cart is settled and must not be edited. */
export function isLocked(stage: OrderStage): boolean {
  return stage === "PAYMENT_RECEIVED" || stage === "ORDER_PLACED";
}

/**
 * Clear a finished or expired cart so the customer can order again.
 *
 * PendingOrder is unique per customer, so the same row is reused for every
 * order. Once one completed, the row sat at ORDER_PLACED and isLocked refused
 * every subsequent edit — the customer was permanently unable to start another
 * order. A settled or expired cart is not a live cart and must be cleared
 * before the next one begins.
 */
export async function clearFinishedCart(customerId: number): Promise<boolean> {
  const cart = await prisma.pendingOrder.findUnique({ where: { customerId } });
  if (!cart) return false;

  const settled = isLocked(cart.stage) || Boolean(cart.confirmedOrderId);
  const expired = cart.expiresAt <= new Date();
  if (!settled && !expired) return false;

  await prisma.pendingOrder.delete({ where: { customerId } });
  console.log(
    `[Stage] Cleared ${settled ? "completed" : "expired"} cart for customer ${customerId} (was ${cart.stage}).`,
  );
  return true;
}

/**
 * Apply a cart edit: rewind the stage and cancel any outstanding payment link so
 * a stale amount cannot be paid. The customer is told, because they are holding
 * a link that looks live.
 */
export async function applyCartEdit(
  customerId: number,
  adapter?: CloudAdapter,
  phone?: string,
): Promise<void> {
  const cart = await prisma.pendingOrder.findUnique({ where: { customerId } });
  if (!cart || isLocked(cart.stage)) return;

  const hadLink = Boolean(cart.razorpayLinkId || cart.razorpayLinkUrl);

  await prisma.pendingOrder.update({
    where: { customerId },
    data: {
      stage: stageAfterCartEdit(cart.stage),
      // Drop the link outright. Reusing it after a cart change was charging the
      // old total while the message quoted the new one.
      razorpayLinkId: null,
      razorpayLinkUrl: null,
      deliveryFee: null,
    },
  });

  if (hadLink && adapter && phone) {
    try {
      await send(adapter, phone, renderPaymentLinkVoided());
    } catch (e) {
      console.error("[Stage] Could not tell the customer their link was voided:", e);
    }
  }
}
