import { prisma } from "../db.js";
import { createOrder, findRecentDuplicate, getOrder } from "../services/order.js";
import { updateCustomer } from "../services/customer.js";
import { createPaymentLink } from "../services/razorpay.js";
import { orderStagedTemplate, paymentLinkTemplate, orderConfirmedTemplate, humanHandoffTemplate } from "./templates.js";
import { orderStatusMsg } from "../services/notifications.js";
import { logActivity } from "../services/activity.js";
import { getCached } from "../services/cache.js";
import { notifyAdminOfEvent } from "../services/events.js";
import type { ChatCompletionTool } from "openai/resources/chat/completions";

export interface PendingCart {
  lines: { menuItemId: number; variantId?: number; qty: number; note?: string }[];
  type: string;
  note?: string;
  confirmedOrderId?: number;
  paymentMethod?: string;
  paymentReference?: string;
  razorpayLinkId?: string;
  razorpayLinkUrl?: string;
}

const CART_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

// ---------------------------------------------------------------------------
// Tool definitions — loaded from DB so admin can toggle/tune without redeploy
// ---------------------------------------------------------------------------

export async function getEnabledTools(restaurantId: number): Promise<ChatCompletionTool[]> {
  // Cached — the enabled tool set only changes when the owner toggles/edits a
  // tool in the dashboard (which emits config_updated → cache invalidation).
  return getCached(restaurantId, "enabledTools", async () => {
    const defs = await prisma.toolDefinition.findMany({
      where: { isEnabled: true, restaurantId },
      orderBy: { sortOrder: "asc" },
    });
    return defs.map((def) => ({
      type: "function" as const,
      function: {
        name: def.name,
        description: def.description,
        parameters: JSON.parse(def.parametersSchema),
      },
    }));
  });
}

// ---------------------------------------------------------------------------
// Pending cart helpers — persisted in DB so restarts don't lose staged orders
// ---------------------------------------------------------------------------

async function getPendingCart(customerId: number): Promise<PendingCart | null> {
  const row = await prisma.pendingOrder.findUnique({ where: { customerId } });
  if (!row) return null;
  if (row.expiresAt < new Date()) {
    await prisma.pendingOrder.delete({ where: { customerId } }).catch(() => {});
    return null;
  }
  return {
    lines: JSON.parse(row.lines),
    type: row.type,
    note: row.note ?? undefined,
    confirmedOrderId: row.confirmedOrderId ?? undefined,
    paymentMethod: row.paymentMethod ?? undefined,
    paymentReference: row.paymentReference ?? undefined,
    razorpayLinkId: row.razorpayLinkId ?? undefined,
    razorpayLinkUrl: row.razorpayLinkUrl ?? undefined,
  };
}

async function setPendingCart(customerId: number, restaurantId: number, cart: PendingCart): Promise<void> {
  const data = {
    lines: JSON.stringify(cart.lines),
    type: cart.type,
    note: cart.note ?? null,
    confirmedOrderId: cart.confirmedOrderId ?? null,
    paymentMethod: cart.paymentMethod ?? null,
    paymentReference: cart.paymentReference ?? null,
    razorpayLinkId: cart.razorpayLinkId ?? null,
    razorpayLinkUrl: cart.razorpayLinkUrl ?? null,
    expiresAt: new Date(Date.now() + CART_TTL_MS),
  };
  await prisma.pendingOrder.upsert({
    where: { customerId },
    create: { customerId, restaurantId, ...data },
    update: data,
  });
}

async function handleGeneratePaymentLink(customerId: number, restaurantId: number) {
  const cart = await getPendingCart(customerId);
  if (!cart) {
    return { output: { ok: false, error: "No order staged. Call propose_order first." } };
  }

  // Recalculate total from staged cart
  const menuItems = await prisma.menuItem.findMany({
    where: { id: { in: cart.lines.map((l) => l.menuItemId) } },
    include: { variants: true },
  });
  const byId = new Map(menuItems.map((m) => [m.id, m]));
  const total = cart.lines.reduce((sum, l) => {
    const mi = byId.get(l.menuItemId)!;
    const v = l.variantId ? mi.variants.find((v) => v.id === l.variantId) : undefined;
    return sum + (v?.price ?? mi.price) * l.qty;
  }, 0);

  // Idempotent — return existing link if already generated
  if (cart.razorpayLinkId && cart.razorpayLinkUrl) {
    return {
      output: {
        ok: true,
        url: cart.razorpayLinkUrl,
        alreadyGenerated: true,
        note: "Payment link already sent. Remind the customer to tap and pay. Order auto-confirms on payment.",
      },
      templateReply: paymentLinkTemplate(cart.razorpayLinkUrl, total),
    };
  }

  const customer = await prisma.customer.findUnique({ where: { id: customerId } });
  const restaurant = await prisma.botConfig.findUnique({ where: { id: restaurantId } });

  const link = await createPaymentLink({
    restaurantId,
    customerId,
    amount: total,
    customerPhone: customer!.phone,
    restaurantName: restaurant?.restaurantName ?? "Restaurant",
  });

  if (!link) {
    // Razorpay not configured — fall back to UPI deep link
    const upiId = restaurant?.upiId;
    if (upiId) {
      const upiLink = `upi://pay?pa=${upiId}&pn=${encodeURIComponent(restaurant!.restaurantName)}&am=${total}&tn=WhatsApp+Order&cu=INR`;
      return {
        output: {
          ok: true,
          upiLink,
          total,
          note: `Razorpay not enabled. Share this UPI link: ${upiLink} — Once customer confirms payment (no UTR needed), call record_payment (method="upi") then confirm_order.`,
        },
      };
    }
    return {
      output: {
        ok: false,
        error: "Payment gateway not configured. Inform the customer and ask them to contact the restaurant directly to arrange payment.",
      },
    };
  }

  await setPendingCart(customerId, restaurantId, {
    ...cart,
    razorpayLinkId: link.id,
    razorpayLinkUrl: link.url,
  });

  return {
    output: {
      ok: true,
      url: link.url,
      total,
      note: "Payment link generated. templateReply will be used — do NOT generate your own message.",
    },
    templateReply: paymentLinkTemplate(link.url, total),
  };
}

// ---------------------------------------------------------------------------
// Tool execution — names must match ToolDefinition.name in the DB
// ---------------------------------------------------------------------------

export async function runTool(
  customerId: number,
  restaurantId: number,
  name: string,
  args: Record<string, any>,
): Promise<{ output: unknown; orderId?: number; templateReply?: string; humanHandoff?: boolean }> {
  try {
    switch (name) {

      // ── Save customer info ──────────────────────────────────────────────
      case "save_customer_info": {
        await updateCustomer(customerId, {
          name: args.name,
          address: args.address,
          notes: args.notes,
        });
        return { output: { ok: true } };
      }

      // ── Stage order (validate items + variants, calculate total) ────────
      case "propose_order": {
        const rawLines: Array<{ menuItemId: number; variantId?: number; qty: number; note?: string }> =
          (args.items ?? []).map((l: any) => ({
            menuItemId: Number(l.menuItemId),
            variantId: l.variantId ? Number(l.variantId) : undefined,
            qty: Math.max(1, Number(l.qty ?? 1)),
            note: l.note as string | undefined,
          }));

        const menuItems = await prisma.menuItem.findMany({
          where: { id: { in: rawLines.map((l) => l.menuItemId) } },
          include: { variants: { where: { available: true }, orderBy: { sortOrder: "asc" } } },
        });
        const byId = new Map(menuItems.map((m) => [m.id, m]));

        const valid: PendingCart["lines"] = [];
        const labels: string[] = [];
        const rejected: string[] = [];

        for (const l of rawLines) {
          const mi = byId.get(l.menuItemId);
          if (!mi || !mi.available) {
            rejected.push(mi?.name ?? `#${l.menuItemId}`);
            continue;
          }

          // Item has variants but customer didn't pick one — ask them
          if (mi.variants.length > 0 && !l.variantId) {
            const opts = mi.variants.map((v) => `${v.name}[v${v.id}]₹${v.price}`).join(", ");
            return {
              output: {
                ok: false,
                error: `"${mi.name}" has size options: ${opts}. Ask the customer which one and re-call propose_order with the variantId.`,
              },
            };
          }

          let price = mi.price;
          let variantName: string | undefined;

          if (l.variantId) {
            const variant = mi.variants.find((v) => v.id === l.variantId);
            if (!variant) {
              rejected.push(`${mi.name} (unknown variant)`);
              continue;
            }
            price = variant.price;
            variantName = variant.name;
          }

          // Stock check: null = unlimited; 0 = sold out; >0 = remaining units
          if (mi.stockCount !== null && mi.stockCount < l.qty) {
            if (mi.stockCount === 0) {
              rejected.push(`${mi.name} (sold out)`);
            } else {
              return {
                output: {
                  ok: false,
                  error: `Only ${mi.stockCount} unit(s) of "${mi.name}" remaining. Ask the customer if ${mi.stockCount} is okay and re-call propose_order with qty ≤ ${mi.stockCount}.`,
                },
              };
            }
            continue;
          }

          valid.push({ menuItemId: mi.id, variantId: l.variantId, qty: l.qty, note: l.note });
          const label = variantName
            ? `${l.qty}x ${mi.name} (${variantName}) ₹${price}`
            : `${l.qty}x ${mi.name} ₹${price}`;
          labels.push(label);
        }

        if (valid.length === 0) {
          return {
            output: {
              ok: false,
              error: "None of those items are available. Ask the customer to pick from the menu — do NOT substitute on your own.",
            },
          };
        }

        // Recalculate total from validated lines with correct prices
        const menuItemsForTotal = await prisma.menuItem.findMany({
          where: { id: { in: valid.map((l) => l.menuItemId) } },
          include: { variants: true },
        });
        const byIdForTotal = new Map(menuItemsForTotal.map((m) => [m.id, m]));
        const total = valid.reduce((sum, l: PendingCart["lines"][number]) => {
          const mi = byIdForTotal.get(l.menuItemId)!;
          if (l.variantId) {
            const v = mi.variants.find((v) => v.id === l.variantId);
            return sum + (v?.price ?? mi.price) * l.qty;
          }
          return sum + mi.price * l.qty;
        }, 0);

        await setPendingCart(customerId, restaurantId, {
          lines: valid,
          type: args.type ?? "pickup",
          note: args.note,
        });

        // Fetch restaurant payment config to pre-inform the bot
        const restaurant = await prisma.botConfig.findFirst({ where: { id: restaurantId } });

        // Razorpay is active whenever both keys are present — ignores the toggle.
        const razorpayReady = !!(restaurant?.razorpayKeyId && restaurant.razorpayKeySecret);
        // Payment is always required before confirming an order.
        const requiresPayment = true;

        let paymentNote: string;
        let upiPayLink: string | undefined;
        let paymentPath: string;

        if (requiresPayment && razorpayReady) {
          // PATH A — Online payment required, Razorpay configured
          paymentPath = "razorpay";
          paymentNote =
            `Read the total back and ask the customer to confirm. Once they say YES — ` +
            `call generate_payment_link. Do NOT call confirm_order. ` +
            `The order auto-confirms when they complete payment.`;
        } else if (requiresPayment) {
          // PATH B — Online payment required, no Razorpay → UPI/manual
          paymentPath = "manual";
          if (restaurant?.upiId) {
            const upiName = encodeURIComponent(restaurant.restaurantName);
            const upiNote = encodeURIComponent("WhatsApp Order");
            upiPayLink = `upi://pay?pa=${restaurant.upiId}&pn=${upiName}&am=${total}&tn=${upiNote}&cu=INR`;
          }
          const methodsStr = restaurant?.paymentMethods ?? "UPI";
          paymentNote = upiPayLink
            ? `Read the total back. Share this UPI link: ${upiPayLink} — customer taps it and pays ₹${total}. Once the customer says they have paid (no UTR needed), call record_payment (method="upi") then confirm_order.`
            : `Read the total back. Ask them to pay ₹${total} via ${methodsStr}${restaurant?.upiId ? ` to ${restaurant.upiId}` : ""}. Once the customer confirms payment (no UTR needed), call record_payment (method="${restaurant?.paymentMethods?.split(",")[0] ?? "upi"}") then confirm_order.`;
        } else {
          // PATH C — No payment required, cash at pickup
          paymentPath = "cash";
          paymentNote =
            `Read this total back and ask the customer to confirm. ` +
            `Once they say YES — call confirm_order directly. Do NOT call it before they confirm.`;
        }

        return {
          output: {
            ok: true,
            staged: true,
            type: args.type ?? "pickup",
            items: labels,
            total,
            rejected: rejected.length > 0 ? rejected : undefined,
            paymentPath,
            razorpayEnabled: razorpayReady,
            upiPayLink,
            upiId: paymentPath === "manual" ? restaurant?.upiId : undefined,
            paymentMethods: paymentPath === "manual" ? restaurant?.paymentMethods : undefined,
            note: paymentNote,
          },
          templateReply: orderStagedTemplate(labels, total, args.type ?? "pickup", args.note),
        };
      }

      // ── Record payment (stage before confirm_order) ─────────────────────
      case "record_payment": {
        const cart = await getPendingCart(customerId);
        if (!cart) {
          return {
            output: {
              ok: false,
              error: "No order is staged yet. Use propose_order first.",
            },
          };
        }

        await setPendingCart(customerId, restaurantId, {
          ...cart,
          paymentMethod: args.method,
          paymentReference: args.reference ?? undefined,
        });

        return {
          output: {
            ok: true,
            method: args.method,
            reference: args.reference,
            note: "Payment recorded. Now call confirm_order to place the order.",
          },
        };
      }

      // ── Place order (idempotent; checks payment if restaurant requires it) ─
      case "confirm_order": {
        const cart = await getPendingCart(customerId);
        if (!cart) {
          return {
            output: {
              ok: false,
              error: "No order is staged yet. Use propose_order first after gathering the items.",
            },
          };
        }

        // ── Payment gate (BEFORE dedup/idempotency check) ─────────────────────
        const restaurant = await prisma.botConfig.findFirst({ where: { id: restaurantId } });
        // Razorpay active when both keys present — ignores toggle.
        const razorpayConfigured = !!(restaurant?.razorpayKeyId && restaurant.razorpayKeySecret);

        // Payment is always required.
        {
          // If Razorpay is configured, generate payment link immediately (no extra LLM roundtrip delay!)
          if (razorpayConfigured) {
            return await handleGeneratePaymentLink(customerId, restaurantId);
          }
          // Manual payment (UPI) — must have a recorded payment method
          if (!cart.paymentMethod) {
            return {
              output: {
                ok: false,
                requiresPayment: true,
                upiId: restaurant?.upiId,
                paymentMethods: restaurant?.paymentMethods,
                error: `Payment required. Share the UPI ID ${restaurant?.upiId ?? ""} and ask the customer to pay. Once they confirm payment (no UTR needed), call record_payment (method="upi") then confirm_order.`,
              },
            };
          }
        }

        // ── Idempotency: already confirmed this cart ───────────────────────────
        if (cart.confirmedOrderId) {
          const existing = await getOrder(cart.confirmedOrderId);
          return {
            output: {
              ok: true,
              alreadyPlaced: true,
              orderId: cart.confirmedOrderId,
              total: existing?.total,
              note: "Already placed — tell the customer their order number and reassure them it's confirmed. Do NOT place again.",
            },
          };
        }

        const dup = await findRecentDuplicate(customerId, cart.lines);
        if (dup) {
          await setPendingCart(customerId, restaurantId, { ...cart, confirmedOrderId: dup.id });
          return {
            output: { ok: true, alreadyPlaced: true, orderId: dup.id, total: dup.total },
          };
        }

        const order = await createOrder({
          customerId,
          restaurantId,
          type: cart.type,
          note: cart.note,
          lines: cart.lines,
          payment: cart.paymentMethod
            ? { method: cart.paymentMethod, reference: cart.paymentReference }
            : undefined,
        });

        // Decrement stock for each line item
        for (const l of cart.lines) {
          await prisma.menuItem.updateMany({
            where: { id: l.menuItemId, stockCount: { not: null } },
            data: { stockCount: { decrement: l.qty } },
          });
          // Clamp negatives to 0
          await prisma.menuItem.updateMany({
            where: { id: l.menuItemId, stockCount: { lt: 0 } },
            data: { stockCount: 0 },
          });
        }

        await setPendingCart(customerId, restaurantId, { ...cart, confirmedOrderId: order.id });

        return {
          output: {
            ok: true,
            orderId: order.id,
            total: order.total,
            paymentRecorded: !!cart.paymentMethod,
            note: "Order placed. templateReply will be sent — do NOT generate your own confirmation.",
          },
          orderId: order.id,
          templateReply: orderConfirmedTemplate(),
        };
      }

      // ── Generate Razorpay payment link (auto-confirms on payment) ──────────
      case "generate_payment_link": {
        return await handleGeneratePaymentLink(customerId, restaurantId);
      }

      // ── Check the status of a customer's order ─────────────────────────────
      case "check_order_status": {
        const restaurant = await prisma.botConfig.findFirst({ where: { id: restaurantId } });
        const restaurantName = restaurant?.restaurantName ?? "our restaurant";

        const order = args.orderId
          ? await prisma.order.findFirst({
              where: { id: Number(args.orderId), customerId, restaurantId },
              include: { items: true, customer: true, payment: true },
            })
          : await prisma.order.findFirst({
              where: { customerId, restaurantId, status: { not: "cancelled" } },
              orderBy: { createdAt: "desc" },
              include: { items: true, customer: true, payment: true },
            });

        if (!order) {
          return {
            output: {
              ok: false,
              error: "No active order found for this customer. Tell them you don't see a recent order and offer to take a new one.",
            },
          };
        }

        return {
          output: { ok: true, orderId: order.id, status: order.status, total: order.total },
          templateReply: orderStatusMsg(order as any, order.status, restaurantName),
        };
      }

      // ── Request a human staff member (pauses the AI for this customer) ──────
      case "request_human_handoff": {
        const updatedCustomer = await prisma.customer.update({
          where: { id: customerId },
          data: { humanRequestedAt: new Date() },
        });
        // Live-update the dashboard so the handoff banner appears immediately.
        void notifyAdminOfEvent("customer_updated", updatedCustomer);
        void logActivity(
          restaurantId,
          "human_handoff",
          args.reason ? `Human requested: ${String(args.reason).slice(0, 120)}` : "Customer requested a human",
          undefined,
          customerId,
        );
        return {
          output: { ok: true, note: "Human handoff requested. The customer will now be handled by staff." },
          templateReply: humanHandoffTemplate(),
          humanHandoff: true,
        };
      }

      default:
        return { output: { error: `Unknown tool: ${name}` } };
    }
  } catch (e: any) {
    const msg = e?.error?.description ?? e?.message ?? JSON.stringify(e) ?? "Unknown error";
    console.error(`[tool:${name}] error:`, msg);
    void logActivity(restaurantId, "tool_error", `${name}: ${msg}`.slice(0, 300), { tool: name }, customerId);
    return { output: { error: msg } };
  }
}
