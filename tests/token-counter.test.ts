/**
 * Tests for the daily-resetting order token counter.
 *
 *   npx tsx --test tests/token-counter.test.ts
 *
 * getBusinessDate() is pure (no DB) and is tested with fixed Date objects.
 *
 * getNextToken() writes to the real `DailyTokenCounter` table (this project has
 * no test database) so its concurrency test is scoped to a fake, high-numbered
 * `restaurantId` (999999) that can never collide with the real restaurant
 * (id 1), and the row it creates is deleted afterward so no debris is left in
 * the live DB.
 */

import test, { after } from "node:test";
import assert from "node:assert/strict";

import { getBusinessDate, getNextToken } from "../src/services/order.js";
import { prisma } from "../src/db.js";
import { redis } from "../src/services/redis.js";

// order.js pulls in the shared Prisma client and (transitively) the Redis
// client used for the customer cache. Neither is closed by node:test on its
// own, so without this the process hangs after the last test instead of
// exiting — the tests themselves still pass either way.
after(async () => {
  await prisma.$disconnect();
  redis?.disconnect();
});

// node:test runs top-level tests in the same file concurrently by default, so
// the two DB-touching tests below get their own fake restaurant ids — sharing
// one id let one test's cleanup()/seed race the other test's in-flight
// getNextToken() calls, which is a test-isolation bug, not a getNextToken bug
// (a standalone script firing 10 rounds of 8 concurrent getNextToken() calls
// against the live DB, outside the test runner, came back clean every time).
const FAKE_RESTAURANT_ID = 999999;
const FAKE_RESTAURANT_ID_2 = 999998;

async function cleanup(restaurantId: number) {
  await prisma.dailyTokenCounter.deleteMany({
    where: { restaurantId },
  });
}

// ── getBusinessDate: pure, no DB ─────────────────────────────────────────────

test("a UTC evening timestamp is already tomorrow in IST", () => {
  // 2026-01-01 20:00 UTC = 2026-01-02 01:30 IST — past midnight IST.
  const d = new Date(Date.UTC(2026, 0, 1, 20, 0, 0));
  assert.equal(getBusinessDate(d), "2026-01-02");
});

test("a UTC early-morning timestamp is still the same day in IST", () => {
  // 2026-01-01 03:00 UTC = 2026-01-01 08:30 IST — well before midnight rollover.
  const d = new Date(Date.UTC(2026, 0, 1, 3, 0, 0));
  assert.equal(getBusinessDate(d), "2026-01-01");
});

test("just before IST midnight is still the previous day", () => {
  // 2026-03-15 18:29 UTC = 2026-03-15 23:59 IST.
  const d = new Date(Date.UTC(2026, 2, 15, 18, 29, 0));
  assert.equal(getBusinessDate(d), "2026-03-15");
});

test("just after IST midnight rolls to the next day", () => {
  // 2026-03-15 18:31 UTC = 2026-03-16 00:01 IST.
  const d = new Date(Date.UTC(2026, 2, 15, 18, 31, 0));
  assert.equal(getBusinessDate(d), "2026-03-16");
});

test("the format is exactly YYYY-MM-DD", () => {
  assert.match(getBusinessDate(new Date()), /^\d{4}-\d{2}-\d{2}$/);
});

// ── getNextToken: real DB, isolated fake restaurant id, cleaned up after ────

test("concurrent calls for the same restaurant/day hand out unique, gapless tokens", async () => {
  await cleanup(FAKE_RESTAURANT_ID);
  try {
    const N = 8;
    const results = await Promise.all(
      Array.from({ length: N }, () => getNextToken(FAKE_RESTAURANT_ID)),
    );
    const tokens = results.map((r) => r.token).sort((a, b) => a - b);
    assert.deepEqual(tokens, Array.from({ length: N }, (_, i) => i + 1));

    // All calls agree on the same businessDate (they ran within the same test).
    const dates = new Set(results.map((r) => r.businessDate));
    assert.equal(dates.size, 1);
  } finally {
    await cleanup(FAKE_RESTAURANT_ID);
  }
});

test("a new business day starts a fresh row rather than continuing the old one", async () => {
  await cleanup(FAKE_RESTAURANT_ID_2);
  try {
    // Seed a "yesterday" row directly so today's getNextToken can't see it.
    await prisma.dailyTokenCounter.create({
      data: {
        restaurantId: FAKE_RESTAURANT_ID_2,
        businessDate: "2000-01-01",
        lastToken: 47,
      },
    });
    const { token } = await getNextToken(FAKE_RESTAURANT_ID_2);
    assert.equal(token, 1);
  } finally {
    await cleanup(FAKE_RESTAURANT_ID_2);
  }
});
