import { prisma } from "../db.js";
import { createOrder, findRecentDuplicate, getOrder } from "../services/order.js";
import { updateCustomer } from "../services/customer.js";
import { stageAfterCartEdit } from "../whatsapp/stage.js";
import { cartSummaryText } from "../whatsapp/renderers.js";
import { createPaymentLink, cancelPaymentLink } from "../services/razorpay.js";
import { orderStagedTemplate, cartStagedTemplate, paymentLinkTemplate, orderConfirmedTemplate, humanHandoffTemplate, orderCancelledTemplate, paymentPendingTemplate } from "./templates.js";
import { orderStatusMsg } from "../services/notifications.js";
import { logActivity } from "../services/activity.js";
import { getCached } from "../services/cache.js";
import { notifyAdminOfEvent } from "../services/events.js";
import { getExactServiceDeliveryFee } from "../services/delivery-fee.js";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { DEFAULT_RESTAURANT_ID } from "../tenancy.js";
import { logger } from '../services/logger.js';

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

export async function getEnabledTools(restaurantId = DEFAULT_RESTAURANT_ID): Promise<ChatCompletionTool[]> {
  return getCached(restaurantId, "enabledTools", async () => {
    const defs = await prisma.toolDefinition.findMany({
      where: { isEnabled: true },
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
  const existing = await prisma.pendingOrder.findUnique({ where: { customerId } });
  if (existing?.razorpayLinkId && existing.razorpayLinkId !== cart.razorpayLinkId) {
    void cancelPaymentLink(existing.razorpayLinkId, restaurantId);
  }

  // Rewind rather than restart. A cart edit invalidates the quote and any
  // payment link, but not the address the customer already gave — asking for it
  // again because they added a dish is the journey resetting under them.
  const stage = cart.confirmedOrderId
    ? ("ORDER_PLACED" as const)
    : existing
      ? stageAfterCartEdit(existing.stage)
      : ("BUILDING_CART" as const);

  const data = {
    stage,
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
    create: { customerId, ...data },
    update: data,
  });
}

async function handleGeneratePaymentLink(customerId: number, restaurantId: number) {
  const cart = await getPendingCart(customerId);
  if (!cart) {
    return { output: { ok: false, error: "No order staged. Call propose_order first." } };
  }

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

  // Reuse the existing link only while it still matches the cart. A cart edit
  // clears these columns (see stage.applyCartEdit), so a surviving link is one
  // issued for exactly this basket. Previously any stored link was returned
  // regardless, quoting the new total beside a link charging the old one.
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
  const restaurant = await prisma.restaurantConfig.findUnique({ where: { id: DEFAULT_RESTAURANT_ID } });

  const link = await createPaymentLink({
    restaurantId,
    customerId,
    amount: total,
    customerPhone: customer!.phone,
    restaurantName: restaurant?.restaurantName ?? "Restaurant",
  });

  if (!link) {
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

export async function runTool(
  customerId: number,
  restaurantId: number,
  name: string,
  args: Record<string, any>,
): Promise<{ output: unknown; orderId?: number; templateReply?: string; humanHandoff?: boolean; mediaReply?: { imageUrl: string; caption?: string } }> {
  try {
    switch (name) {
      case "save_customer_info": {
        // An address that came from the map form is authoritative — it has GPS
        // coordinates behind it and a courier drives to it. The model would
        // otherwise rewrite it from conversation text: one order was saved as
        // "<pinned address> — already add chesa" because the customer happened
        // to say that while the address was in context.
        const existing = await prisma.customer.findUnique({
          where: { id: customerId },
          select: { deliveryLat: true, deliveryLng: true },
        });
        const hasPinnedAddress = existing?.deliveryLat != null && existing?.deliveryLng != null;

        // A blank address is never an instruction to erase one. The model called
        // this with address:"" while trying to start an address change, which
        // would have destroyed a pinned delivery location mid-order.
        const proposed = typeof args.address === "string" ? args.address.trim() : undefined;

        if (args.address !== undefined && !proposed) {
          logger.warn(
            `[save_customer_info] Refusing to clear the address for customer ${customerId} — empty value supplied.`,
          );
        } else if (proposed && hasPinnedAddress) {
          logger.warn(
            `[save_customer_info] Ignoring model-supplied address for customer ${customerId} — a pinned location is already on file.`,
          );
        }

        await updateCustomer(customerId, {
          name: args.name,
          address: !proposed || hasPinnedAddress ? undefined : proposed,
          notes: args.notes,
        });
        return { output: { ok: true } };
      }

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

        // Read back the stage setPendingCart rewound to, so the summary reflects
        // where the customer actually is rather than assuming a fresh cart.
        const stagedRow = await prisma.pendingOrder.findUnique({
          where: { customerId },
          select: { stage: true },
        });
        const stageNow = stagedRow?.stage ?? "BUILDING_CART";

        const restaurant = await prisma.restaurantConfig.findUnique({ where: { id: DEFAULT_RESTAURANT_ID } });
        const razorpayReady = !!(restaurant?.razorpayKeyId && restaurant.razorpayKeySecret);
        const requiresPayment = true;

        let paymentNote: string;
        let upiPayLink: string | undefined;
        let paymentPath: string;

        if (requiresPayment && razorpayReady) {
          paymentPath = "razorpay";
          paymentNote =
            `Read the total back and ask the customer to confirm. Once they say YES — ` +
            `call generate_payment_link. Do NOT call confirm_order. ` +
            `The order auto-confirms when they complete payment.`;
        } else if (requiresPayment) {
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
          paymentPath = "cash";
          paymentNote =
            `Read this total back and ask the customer to confirm. ` +
            `Once they say YES — call confirm_order directly. Do NOT call it before they confirm.`;
        }

        const customer = await prisma.customer.findUnique({ where: { id: customerId } });
        const isDelivery = (args.type ?? "pickup") === "delivery";

        let liveDeliveryFee = 45;
        let isUnserviceable = false;

        if (isDelivery && customer?.address) {
          try {
            liveDeliveryFee = await getExactServiceDeliveryFee(customer.address);
          } catch (e) {
            isUnserviceable = true;
          }
        }

        const stagedTemplateReply = cartStagedTemplate(labels, total, args.note);

        return {
          output: {
            ok: true,
            staged: true,
            type: args.type ?? "pickup",
            items: labels,
            total: isDelivery ? total + liveDeliveryFee : total,
            rejected: rejected.length > 0 ? rejected : undefined,
            paymentPath,
            razorpayEnabled: razorpayReady,
            upiPayLink,
            upiId: paymentPath === "manual" ? restaurant?.upiId : undefined,
            paymentMethods: paymentPath === "manual" ? restaurant?.paymentMethods : undefined,
            note: isDelivery && !customer?.address
              ? "Ask the customer for their delivery location first."
              : paymentNote,
          },
          // Render through the same stage-aware summary the button path uses.
          // orderStagedTemplate hardcoded the BUILDING_CART hint, so editing a
          // cart by chat told the customer to pin a location they had already
          // pinned, and implied the journey had restarted.
          templateReply: cartSummaryText(labels, total, stageNow, args.note),
        };
      }

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

        const rpRestaurant = await prisma.restaurantConfig.findUnique({ where: { id: DEFAULT_RESTAURANT_ID } });
        const razorpayConfigured = !!(rpRestaurant?.razorpayKeyId && rpRestaurant.razorpayKeySecret);
        if (razorpayConfigured) {
          if (cart.confirmedOrderId) {
            const existing = await getOrder(cart.confirmedOrderId);
            return {
              output: {
                ok: true,
                alreadyPaid: true,
                orderId: cart.confirmedOrderId,
                total: existing?.total,
                note: "Payment already received via Razorpay and the order is confirmed. Tell the customer their order number and that it's confirmed.",
              },
            };
          }
          return {
            output: {
              ok: false,
              paymentPending: true,
              note: "Razorpay online payment is in use. Payment is NOT received yet — it confirms automatically only when the customer completes payment.",
            },
            templateReply: paymentPendingTemplate(),
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

        const restaurant = await prisma.restaurantConfig.findUnique({ where: { id: DEFAULT_RESTAURANT_ID } });
        const razorpayConfigured = !!(restaurant?.razorpayKeyId && restaurant.razorpayKeySecret);

        // When Razorpay is configured, order confirmation is handled by the
        // session manager which collects the delivery address, fetches a live
        // Borzo delivery quote, shows the final bill, and then generates the
        // payment link. The AI must NOT short-circuit this flow.
        if (razorpayConfigured) {
          return {
            output: {
              ok: false,
              error: "Order confirmation is handled automatically. Tell the customer to tap the ✅ Confirm Order button shown earlier, or say 'confirm' / 'yes'. The system will ask for their delivery address and show the final bill with delivery fee before generating the payment link. Do NOT call generate_payment_link yourself.",
            },
          };
        }
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

        if (cart.confirmedOrderId) {
          const existing = await getOrder(cart.confirmedOrderId);
          return {
            output: {
              ok: true,
              alreadyPlaced: true,
              orderId: cart.confirmedOrderId,
              total: existing?.total,
              note: "Already placed — tell the customer their order number and reassure them it's confirmed.",
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
          lines: cart.lines,
          type: cart.type,
          note: cart.note,
          payment: cart.paymentMethod
            ? { method: cart.paymentMethod, reference: cart.paymentReference }
            : undefined,
        });

        for (const l of cart.lines) {
          await prisma.menuItem.updateMany({
            where: { id: l.menuItemId, stockCount: { not: null } },
            data: { stockCount: { decrement: l.qty } },
          });
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

      case "generate_payment_link": {
        return await handleGeneratePaymentLink(customerId, restaurantId);
      }

      case "check_order_status": {
        const restaurant = await prisma.restaurantConfig.findUnique({ where: { id: DEFAULT_RESTAURANT_ID } });
        const restaurantName = restaurant?.restaurantName ?? "our restaurant";

        const order = args.orderId
          ? await prisma.order.findFirst({
              where: { id: Number(args.orderId), customerId },
              include: { items: true, customer: true, payment: true },
            })
          : await prisma.order.findFirst({
              where: { customerId, status: { not: "cancelled" } },
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

      case "cancel_order": {
        const cart = await getPendingCart(customerId);
        if (!cart) {
          return {
            output: { ok: false, error: "No staged order to cancel. Tell the customer there's nothing to cancel." },
          };
        }
        if (cart.confirmedOrderId) {
          return {
            output: {
              ok: false,
              alreadyConfirmed: true,
              orderId: cart.confirmedOrderId,
              error: "This order was already placed and sent to the kitchen — you can't cancel it yourself. Apologize once and call request_human_handoff so staff can handle it.",
            },
          };
        }
        await prisma.pendingOrder.delete({ where: { customerId } }).catch(() => {});
        return {
          output: { ok: true, note: "Staged order cancelled." },
          templateReply: orderCancelledTemplate(),
        };
      }

      case "request_human_handoff": {
        const updatedCustomer = await prisma.customer.update({
          where: { id: customerId },
          data: { humanRequestedAt: new Date() },
        });
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

      case "send_item_photo": {
        if (!args.itemName) {
          return { output: { error: "itemName is required" } };
        }
        
        // Find item ignoring case
        const item = await prisma.menuItem.findFirst({
          where: {
            name: {
              contains: args.itemName,
              mode: 'insensitive'
            }
          }
        });

        if (!item) {
          return { output: { error: `Item '${args.itemName}' not found in the menu. Tell the customer you couldn't find the photo.` } };
        }
        if (!item.imageUrl) {
          return { output: { error: `No photo available for '${item.name}'. Apologize and say you don't have a picture of that right now.` } };
        }

        return {
          output: { ok: true, note: "Photo sent via mediaReply. You don't need to describe it further." },
          mediaReply: {
            imageUrl: item.imageUrl,
            caption: `${item.name} - ₹${item.price}`,
          }
        };
      }

      default:
        return { output: { error: `Unknown tool: ${name}` } };
    }
  } catch (e: any) {
    const msg = e?.error?.description ?? e?.message ?? JSON.stringify(e) ?? "Unknown error";
    logger.error(`[tool:${name}] error:`, msg);
    void logActivity(restaurantId, "tool_error", `${name}: ${msg}`.slice(0, 300), { tool: name }, customerId);
    return { output: { error: msg } };
  }
}
