/**
 * Delivery fee for a destination address.
 *
 * Callers pass only an address string, so the provider geocodes it. The
 * restaurant's own coordinates are sent alongside when they are on file, which
 * matters: quoting from a pincode resolves to the area centroid and under-priced
 * a real Jubilee Hills → Gachibowli run by roughly 40%.
 *
 * Throws UnserviceableLocationError rather than returning a fallback. Every
 * caller already decides what to do with a failure — createOrder falls back to
 * the flat rate, the conversational paths offer the customer another location —
 * and inventing a number here would hide an unserviceable address behind a
 * plausible-looking fee.
 */

import { prisma } from "../db.js";
import { DeliveryOrchestrator } from "./delivery/orchestrator.js";

export class UnserviceableLocationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnserviceableLocationError";
  }
}

const orchestrator = new DeliveryOrchestrator();

/** Origin pincode fallback — Madhapur. Only used when no pickup address is set. */
const PICKUP_PINCODE = Number(process.env.PICKUP_PINCODE ?? 500081);

/** The schema default names a different suburb from the kitchen. */
const PLACEHOLDER_ADDRESS = "Plot 12, Main Road, Gachibowli, Hyderabad";

/** Quotes are stable minute to minute; propose_order otherwise re-quotes on every cart edit. */
const CACHE_TTL_MS = 60_000;
const feeCache = new Map<string, { fee: number; expires: number }>();

/**
 * Above this, treat the address as out of range rather than quoting it.
 *
 * Borzo geocodes whatever string it is handed and always returns a price — the
 * literal input "asdkjhasdkjh zzzz" came back at ₹175. Without a ceiling the
 * unserviceable path never fires, and a customer who mistypes their address is
 * quietly charged a large fee to deliver somewhere that isn't theirs. Local
 * runs are ₹50–100, so this leaves generous headroom.
 */
const MAX_SERVICEABLE_FEE = Number(process.env.MAX_DELIVERY_FEE ?? 250);

/** The address form appends the pincode as "... - 500081". */
function pincodeFromAddress(address?: string | null): number | null {
  const m = address?.match(/(\d{6})\s*$/) ?? address?.match(/\b(\d{6})\b/);
  return m ? Number(m[1]) : null;
}

export async function getExactServiceDeliveryFee(address?: string | null): Promise<number> {
  const drop = address?.trim();
  if (!drop) {
    throw new UnserviceableLocationError("No delivery address supplied");
  }

  const cached = feeCache.get(drop);
  if (cached && cached.expires > Date.now()) return cached.fee;

  const restaurant = await prisma.restaurantConfig.findUnique({ where: { id: 1 } });
  const ownerPhone = (restaurant?.ownerNumbers ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)[0];

  const pickupAddress =
    restaurant?.restaurantAddress && restaurant.restaurantAddress !== PLACEHOLDER_ADDRESS
      ? restaurant.restaurantAddress
      : undefined;

  let fee: number | undefined;
  try {
    const quotes = await orchestrator.getAllQuotes({
      pickupPincode: PICKUP_PINCODE,
      deliveryPincode: pincodeFromAddress(drop) ?? PICKUP_PINCODE,
      pickupAddress,
      pickupLat: restaurant?.restaurantLat,
      pickupLng: restaurant?.restaurantLng,
      pickupPhone: ownerPhone,
      deliveryAddress: drop,
      deliveryPhone: ownerPhone,
    });
    fee = quotes?.cheapest?.quotedFee;
  } catch (e) {
    // getAllQuotes throws when no configured provider returns an available
    // quote. That covers both a genuinely unserviceable address and a provider
    // being unreachable; the log line is the only way to tell them apart, so
    // keep the original message.
    console.warn(`[DeliveryFee] No quote for "${drop}":`, (e as Error)?.message ?? e);
    throw new UnserviceableLocationError(
      `No delivery partner covers this location: ${drop}`,
    );
  }

  if (fee == null || !Number.isFinite(fee)) {
    throw new UnserviceableLocationError(`No usable quote returned for: ${drop}`);
  }

  const rounded = Math.round(fee);

  if (rounded > MAX_SERVICEABLE_FEE) {
    console.warn(
      `[DeliveryFee] ₹${rounded} exceeds the ₹${MAX_SERVICEABLE_FEE} ceiling for "${drop}" — treating as out of range.`,
    );
    throw new UnserviceableLocationError(
      `Delivery to this location costs ₹${rounded}, beyond the serviceable range`,
    );
  }

  feeCache.set(drop, { fee: rounded, expires: Date.now() + CACHE_TTL_MS });
  return rounded;
}
