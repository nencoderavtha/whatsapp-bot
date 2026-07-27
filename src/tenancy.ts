/**
 * The single seam where "which restaurant is this?" is answered.
 *
 * The schema is single-tenant today: `RestaurantConfig` is one row pinned to id
 * 1, and `Customer`, `MenuItem` and `Order` carry no restaurant foreign key. The
 * literal `1` was written into config lookups, auth, prompt building, tool
 * loading and the Razorpay webhook independently — dozens of places that all
 * have to change together, with nothing linking them.
 *
 * Routing them through this constant does not make the platform multi-tenant. It
 * makes the eventual migration a bounded change: every place that assumes one
 * restaurant is now findable by following references to `DEFAULT_RESTAURANT_ID`,
 * and each becomes a real lookup (WhatsApp phone number id → restaurant) one at
 * a time instead of all at once.
 *
 * Genuine multi-tenancy additionally needs `restaurantId` on Customer, MenuItem,
 * Order and PendingOrder, and every query scoped by it. That is a schema
 * migration on a live orders table and is deliberately not attempted here.
 */
export const DEFAULT_RESTAURANT_ID = 1;

/**
 * Resolve a restaurant id from an untrusted source (a webhook note, a query
 * param), falling back to the default rather than to `NaN`.
 *
 * `parseInt(undefined ?? "1")` was the previous idiom and quietly produced `NaN`
 * whenever the value was present but non-numeric, which then missed every
 * `where: { id }` lookup and surfaced as a null config.
 */
export function resolveRestaurantId(raw: unknown): number {
  const n = typeof raw === "number" ? raw : parseInt(String(raw ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RESTAURANT_ID;
}
