import { eventBus } from "./events.js";

/**
 * Tiny in-memory per-restaurant cache for restaurant-global data that only
 * changes when the owner edits the dashboard (botConfig, rendered menu text,
 * enabled tool list, prompt notes). These are otherwise re-fetched from
 * Postgres on every single inbound message.
 *
 * Two-layer invalidation:
 *   1. A short safety-net TTL (default 60s) — backstop for the split-process
 *      case where dashboard edits reach the bot only via the HTTP event forward.
 *   2. Immediate invalidation via the in-process eventBus on menu_updated /
 *      config_updated, so edits take effect on the very next message.
 *
 * Only restaurant-GLOBAL data belongs here. Never cache per-customer state.
 */

type Entry = { value: unknown; expires: number };

const DEFAULT_TTL_MS = 60_000;
const store = new Map<string, Entry>();

function keyOf(restaurantId: number, key: string): string {
  return `${restaurantId}:${key}`;
}

export async function getCached<T>(
  restaurantId: number,
  key: string,
  loader: () => Promise<T>,
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<T> {
  const k = keyOf(restaurantId, key);
  const hit = store.get(k);
  if (hit && hit.expires > Date.now()) {
    return hit.value as T;
  }
  const value = await loader();
  store.set(k, { value, expires: Date.now() + ttlMs });
  return value;
}

/** Invalidate one key, or the whole restaurant when key is omitted. */
export function invalidate(restaurantId: number, key?: string): void {
  if (key) {
    store.delete(keyOf(restaurantId, key));
    return;
  }
  const prefix = `${restaurantId}:`;
  for (const k of store.keys()) {
    if (k.startsWith(prefix)) store.delete(k);
  }
}

// ── Invalidate immediately on dashboard edits ───────────────────────────────
// menu_updated → menu text + enabled tools may have changed.
// config_updated → botConfig, prompt notes, or tool definitions changed.
eventBus.on("event", (event: { type?: string; data?: { restaurantId?: number } }) => {
  const type = event?.type;
  const rid = event?.data?.restaurantId;
  if (type !== "menu_updated" && type !== "config_updated") return;

  if (typeof rid === "number") {
    invalidate(rid);
  } else {
    // No restaurant scope on the event — clear everything to stay correct.
    store.clear();
  }
});
