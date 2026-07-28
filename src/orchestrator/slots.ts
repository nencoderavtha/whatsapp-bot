import { PendingOrder, Customer } from "@prisma/client";

export type Slot = "cart" | "address" | "quote" | "confirmation" | "payment";

/**
 * Derives missing slots sequentially based on the database state.
 * Replaces inference based on conversation history.
 */
export function missingSlots(draft: PendingOrder | null, customer: Customer): Slot[] {
  const missing: Slot[] = [];

  // 1. Cart
  if (!draft) {
    missing.push("cart");
  } else {
    try {
      const lines = JSON.parse(draft.lines);
      if (!Array.isArray(lines) || lines.length === 0) {
        missing.push("cart");
      }
    } catch {
      missing.push("cart");
    }
  }

  if (!draft) {
    // If no draft, everything else is missing too
    missing.push("address", "quote", "confirmation", "payment");
    return missing;
  }

  // 2. Address
  if (draft.type === "delivery" && !customer.address) {
    missing.push("address");
  }

  // 3. Quote
  if (draft.type === "delivery" && draft.deliveryFee === null) {
    missing.push("quote");
  }

  // 4. Confirmation
  if (
    !draft.confirmedOrderId &&
    draft.stage !== "ORDER_PLACED" &&
    draft.stage !== "AWAITING_PAYMENT" &&
    draft.stage !== "PAYMENT_FAILED"
  ) {
    missing.push("confirmation");
  }

  // 5. Payment
  if (
    !draft.confirmedOrderId &&
    (draft.stage === "AWAITING_PAYMENT" || draft.stage === "PAYMENT_FAILED")
  ) {
    missing.push("payment");
  }

  return missing;
}
