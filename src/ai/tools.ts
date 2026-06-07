import { prisma } from "../db.js";
import { createOrder, findRecentDuplicate, getOrder } from "../services/order.js";
import { updateCustomer } from "../services/customer.js";

import type { PrismaClient } from "@prisma/client";
import type { ChatCompletionTool } from "openai/resources/chat/completions";

export const tools: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "propose_order",
      description:
        "Calculate and stage the order so you can read back the items + total to the customer. This does NOT place the order yet — call it once you know all the items, quantities, and pickup/delivery. Returns the validated items and total to confirm with the customer.",
      parameters: {
        type: "object",
        properties: {
          items: {
            type: "array",
            description: "Line items the customer asked for",
            items: {
              type: "object",
              properties: {
                menuItemId: { type: "number" },
                qty: { type: "number" },
                note: {
                  type: "string",
                  description: "Special request for this item, optional",
                },
              },
              required: ["menuItemId", "qty"],
            },
          },
          type: { type: "string", enum: ["pickup", "delivery", "dine-in"] },
          note: { type: "string", description: "Overall order note, optional" },
        },
        required: ["items", "type"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "confirm_order",
      description:
        "Actually place the order that was staged with propose_order. Call this ONLY after the customer has clearly said yes/confirm to the read-back. Takes no arguments — it places exactly what was proposed. Safe to be called only after a proposal exists.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "save_customer_info",
      description:
        "Remember the customer's name, address, or notes (preferences/allergies) for future orders.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          address: { type: "string" },
          notes: { type: "string" },
        },
      },
    },
  },
];

// Server-side staged cart per customer. confirm_order persists THIS, not whatever
// the model passes — so the model cannot fabricate or alter the order at confirm time.
export interface PendingCart {
  lines: { menuItemId: number; qty: number; note?: string }[];
  type: string;
  note?: string;
  confirmedOrderId?: number; // set once placed → makes confirm idempotent
}

const pendingCarts = new Map<number, PendingCart>();

export async function runTool(
  customerId: number,
  name: string,
  args: Record<string, any>,
): Promise<{ output: unknown; orderId?: number }> {
  try {
    switch (name) {
      case "save_customer_info": {
        const c = await prisma.customer.findUnique({
          where: { id: customerId },
        });
        if (c) {
          await updateCustomer(c.phone, {
            name: args.name,
            address: args.address,
            notes: args.notes,
          });
        }
        return { output: { ok: true } };
      }

      case "propose_order": {
        const rawLines = (args.items ?? []).map((l: any) => ({
          menuItemId: Number(l.menuItemId),
          qty: Math.max(1, Number(l.qty ?? 1)),
          note: l.note,
        }));

        // Validate every item against the live menu; reject unknown/unavailable ones.
        const menuItems = await prisma.menuItem.findMany({
          where: { id: { in: rawLines.map((l: any) => l.menuItemId) } },
        });
        const byId = new Map(menuItems.map((m) => [m.id, m]));

        const valid = rawLines.filter((l: any) => byId.get(l.menuItemId)?.available);
        const rejected = rawLines.filter((l: any) => !byId.get(l.menuItemId)?.available);

        if (valid.length === 0) {
          return {
            output: {
              ok: false,
              error:
                "None of those items are on the live menu / available. Ask the customer to pick from the menu — do NOT substitute on your own.",
            },
          };
        }

        const total = valid.reduce(
          (sum: number, l: any) => sum + (byId.get(l.menuItemId)!.price ?? 0) * l.qty,
          0,
        );

        pendingCarts.set(customerId, {
          lines: valid,
          type: args.type ?? "pickup",
          note: args.note,
        });

        return {
          output: {
            ok: true,
            staged: true,
            type: args.type ?? "pickup",
            items: valid.map((l: any) => {
              const mi = byId.get(l.menuItemId)!;
              return `${l.qty}x ${mi.name} (₹${mi.price})`;
            }),
            total,
            rejected:
              rejected.length > 0
                ? rejected.map((l: any) => byId.get(l.menuItemId)?.name ?? `#${l.menuItemId}`)
                : undefined,
            note:
              "Read this total back to the customer and ask them to confirm. Do NOT call confirm_order until they clearly say yes.",
          },
        };
      }

      case "confirm_order": {
        const cart = pendingCarts.get(customerId);
        if (!cart) {
          return {
            output: {
              ok: false,
              error:
                "No order is staged yet. Use propose_order first after gathering the items.",
            },
          };
        }

        // Idempotent: if already confirmed, return the same order; never create twice.
        if (cart.confirmedOrderId) {
          const existing = await getOrder(cart.confirmedOrderId);
          return {
            output: {
              ok: true,
              alreadyPlaced: true,
              orderId: cart.confirmedOrderId,
              total: existing?.total,
              note:
                "Already placed — just reassure the customer with this order number. Do NOT place again.",
            },
          };
        }

        // Second safety net against duplicates from a near-identical recent order.
        const dup = await findRecentDuplicate(customerId, cart.lines);
        if (dup) {
          cart.confirmedOrderId = dup.id;
          return {
            output: { ok: true, alreadyPlaced: true, orderId: dup.id, total: dup.total },
          };
        }

        const order = await createOrder({
          customerId,
          type: cart.type,
          note: cart.note,
          lines: cart.lines,
        });

        cart.confirmedOrderId = order.id;

        return {
          output: {
            ok: true,
            orderId: order.id,
            total: order.total,
            items: order.items.map((i) => `${i.qty}x ${i.nameSnap}`),
          },
          orderId: order.id,
        };
      }

      default:
        return { output: { error: `Unknown tool ${name}` } };
    }
  } catch (e: any) {
    return { output: { error: e?.message ?? String(e) } };
  }
}

