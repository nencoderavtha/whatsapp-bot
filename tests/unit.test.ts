/**
 * Unit tests for the decision logic that guards order state.
 *
 * These are the rules a customer notices when they break: their address
 * disappears, their cart is wiped, or a stale reply is answered as if it were
 * current. Everything here is pure, so it runs with no database, no LLM and no
 * WhatsApp credentials:
 *
 *   npx tsx --test tests/unit.test.ts
 *
 * The end-to-end flows live in uat-scenarios.ts, which does need all three.
 */

import test, { after } from "node:test";
import assert from "node:assert/strict";

import { stageAfterCartEdit, isLocked } from "../src/whatsapp/stage.js";
import { sliceAtIdleGap } from "../src/services/customer.js";
import { resolveRestaurantId, DEFAULT_RESTAURANT_ID } from "../src/tenancy.js";
import { prisma } from "../src/db.js";
import { redis } from "../src/services/redis.js";

// stage.js pulls in the shared Prisma client and (transitively) the Redis
// client used for the customer cache, even though every test below is pure
// (no DB, no network). Neither connection is closed by node:test on its own,
// so without this the process never exits after the last test — it just sits
// on an open Redis socket — which hangs `npm run test:unit` when this file
// runs alongside others. Same fix as tests/token-counter.test.ts.
after(async () => {
  await prisma.$disconnect();
  redis?.disconnect();
});

// ── Cart edits must not restart the journey ─────────────────────────────────

test("editing the cart after an address is set keeps the address", () => {
  for (const stage of ["ADDRESS_SELECTED", "QUOTE_GENERATED", "AWAITING_PAYMENT"] as const) {
    assert.equal(
      stageAfterCartEdit(stage),
      "ADDRESS_SELECTED",
      `${stage} must rewind only as far as the quote`,
    );
  }
});

test("a failed payment is still a live cart with an address", () => {
  // The recovery path is "change something and pay again". Sending them back to
  // BUILDING_CART would ask for a location they already gave.
  assert.equal(stageAfterCartEdit("PAYMENT_FAILED"), "ADDRESS_SELECTED");
  assert.equal(isLocked("PAYMENT_FAILED"), false);
});

test("editing a cart with no address yet stays at BUILDING_CART", () => {
  assert.equal(stageAfterCartEdit("BUILDING_CART"), "BUILDING_CART");
});

test("settled and abandoned carts are locked; live ones are not", () => {
  assert.equal(isLocked("ORDER_PLACED"), true);
  assert.equal(isLocked("CANCELLED"), true);

  assert.equal(isLocked("BUILDING_CART"), false);
  assert.equal(isLocked("ADDRESS_SELECTED"), false);
  assert.equal(isLocked("QUOTE_GENERATED"), false);
  assert.equal(isLocked("AWAITING_PAYMENT"), false);
});

// ── Context freshness without deleting history ──────────────────────────────

const MIN = 60_000;

function at(minutesAgo: number) {
  return { createdAt: new Date(Date.UTC(2026, 0, 1, 12, 0) - minutesAgo * MIN) };
}

test("an unbroken conversation is kept whole", () => {
  const rows = [at(6), at(4), at(2), at(0)];
  assert.equal(sliceAtIdleGap(rows).length, 4);
});

test("messages before a long silence are dropped from the model's view", () => {
  // Yesterday's order, then today's greeting. Only today is context.
  const rows = [at(1440), at(1438), at(3), at(1)];
  const kept = sliceAtIdleGap(rows);
  assert.equal(kept.length, 2);
  assert.deepEqual(kept, rows.slice(2));
});

test("the cut lands at the most recent gap, not the first one", () => {
  const rows = [at(600), at(400), at(200), at(2), at(0)];
  assert.deepEqual(sliceAtIdleGap(rows), rows.slice(3));
});

test("a gap exactly at the threshold is not a new conversation", () => {
  const rows = [at(15), at(0)];
  assert.equal(sliceAtIdleGap(rows).length, 2);
});

test("empty and single-message histories are handled", () => {
  assert.deepEqual(sliceAtIdleGap([]), []);
  assert.equal(sliceAtIdleGap([at(0)]).length, 1);
});

// ── Tenancy resolution from untrusted input ─────────────────────────────────

test("a restaurant id is read when present and valid", () => {
  assert.equal(resolveRestaurantId("7"), 7);
  assert.equal(resolveRestaurantId(7), 7);
});

test("junk falls back to the default rather than NaN", () => {
  // `parseInt(notes.restaurantId ?? "1")` returned NaN for these, which then
  // matched no row and surfaced as a missing restaurant config.
  for (const bad of [undefined, null, "", "abc", "0", -3, {}]) {
    assert.equal(resolveRestaurantId(bad), DEFAULT_RESTAURANT_ID, `input: ${String(bad)}`);
  }
});
