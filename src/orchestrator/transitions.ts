import { OrderStage } from "@prisma/client";
import { Intent } from "../ai/intent.js";
import { Slot } from "./slots.js";

export type Action = 
  | { kind: "render", type: string }
  | { kind: "mutate", op: string, args?: any }
  | { kind: "reply_freeform" }
  | { kind: "clarify", text: string };

export function nextAction(stage: OrderStage, intent: Intent, missing: Slot[]): Action {
  // If confidence is extremely low, always clarify
  if (intent.confidence < 0.5 || intent.intent === "UNKNOWN") {
    return { kind: "clarify", text: "Sorry andi, naku sarriga ardam kaledu. Inko sari cheptara?" };
  }

  // Handle global/read-only intents first
  switch (intent.intent) {
    case "FAQ":
    case "GREETING":
    case "OUT_OF_SCOPE":
      return { kind: "reply_freeform" };
    case "REQUEST_HUMAN":
      return { kind: "mutate", op: "request_human", args: { reason: "User requested human handoff." } };
    case "CHECK_STATUS":
      return { kind: "mutate", op: "check_status" };
    case "CANCEL_ORDER":
      return { kind: "mutate", op: "cancel_order" };
  }

  // If the user wants to clear the cart, allow it anywhere except if paid
  if (intent.intent === "CLEAR_CART") {
    return { kind: "mutate", op: "clear_cart" };
  }

  // If the user explicitly wants to modify the cart, do it.
  if (intent.intent === "ADD_ITEM") {
    return { kind: "mutate", op: "add_items", args: { items: intent.items } };
  }
  if (intent.intent === "REMOVE_ITEM") {
    return { kind: "mutate", op: "remove_items", args: { items: intent.items } };
  }
  if (intent.intent === "UPDATE_QUANTITY") {
    return { kind: "mutate", op: "update_items", args: { items: intent.items } };
  }

  // Address handling
  if (intent.intent === "CHANGE_ADDRESS") {
    return { kind: "mutate", op: "change_address" };
  }
  if (intent.intent === "SELECT_ADDRESS") {
    return { kind: "mutate", op: "select_address" }; // Handled elsewhere or as part of address flow
  }

  // If they are explicitly confirming the cart
  if (intent.intent === "CONFIRM_CART") {
    if (missing.includes("cart")) {
      return { kind: "clarify", text: "Cart empty andi. Mundu menu nunchi em kavalando select cheskondi." };
    }
    // Check what's missing sequentially
    if (missing.includes("address")) {
      return { kind: "render", type: "request_address" };
    }
    if (missing.includes("quote")) {
      return { kind: "mutate", op: "generate_quote" }; // or wait for it
    }
    if (missing.includes("confirmation")) {
      return { kind: "mutate", op: "confirm_order" };
    }
    if (missing.includes("payment")) {
      return { kind: "render", type: "request_payment" };
    }
    return { kind: "reply_freeform" };
  }

  return { kind: "reply_freeform" };
}
