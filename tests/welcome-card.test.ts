/**
 * Unit tests for the welcome card builder.
 *
 * Pure function, no DB, no network — buildWelcomeCard only assembles a body
 * string and a fixed set of list rows from whatever the caller already looked
 * up (cached config, one categories query, one coupon query).
 *
 *   npx tsx --test tests/welcome-card.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";

import { buildWelcomeCard } from "../src/whatsapp/renderers.js";

const baseParams = {
  greetName: "Priya garu",
  restaurantName: "Godavari Ruchulu",
  isOpen: true,
  categoryNames: [] as string[],
};

test("open state with a name greets, shows open status, and has 4 rows", () => {
  const card = buildWelcomeCard({ ...baseParams });
  assert.match(card.body, /Priya garu/);
  assert.match(card.body, /open right now/i);
  assert.equal(card.sections.length, 1);
  assert.equal(card.sections[0].rows.length, 4);
});

test("closed state shows the pause message instead of open status", () => {
  const card = buildWelcomeCard({
    ...baseParams,
    isOpen: false,
    pauseMessage: "Back at 11 AM tomorrow!",
  });
  assert.match(card.body, /closed right now/i);
  assert.match(card.body, /Back at 11 AM tomorrow!/);
  assert.doesNotMatch(card.body, /open right now/i);
});

test("closed state without a pause message falls back to a default line", () => {
  const card = buildWelcomeCard({ ...baseParams, isOpen: false, pauseMessage: null });
  assert.match(card.body, /closed right now/i);
  assert.match(card.body, /back shortly/i);
});

test("logo url is surfaced for the caller to send separately, and omitted when absent", () => {
  const withLogo = buildWelcomeCard({ ...baseParams, logoUrl: "https://example.com/logo.png" });
  assert.equal(withLogo.logoUrl, "https://example.com/logo.png");

  const withoutLogo = buildWelcomeCard({ ...baseParams, logoUrl: null });
  assert.equal(withoutLogo.logoUrl, undefined);
});

test("an active coupon adds an offer line; no coupon means no offer line", () => {
  const withCoupon = buildWelcomeCard({
    ...baseParams,
    activeCoupon: { code: "UGADI20", description: "20% off today" },
  });
  assert.match(withCoupon.body, /UGADI20/);
  assert.match(withCoupon.body, /20% off today/);

  const withoutCoupon = buildWelcomeCard({ ...baseParams, activeCoupon: null });
  assert.doesNotMatch(withoutCoupon.body, /Offer/i);
});

test("popular categories appear only when there are some to show", () => {
  const withCats = buildWelcomeCard({
    ...baseParams,
    categoryNames: ["Biryani", "Starters", "Curries"],
  });
  assert.match(withCats.body, /Biryani/);
  assert.match(withCats.body, /Starters/);

  const withoutCats = buildWelcomeCard({ ...baseParams, categoryNames: [] });
  assert.doesNotMatch(withoutCats.body, /Popular/i);
});

test("no profile name falls back to the 'andi' honorific, same as the old greeting", () => {
  const card = buildWelcomeCard({ ...baseParams, greetName: "andi" });
  assert.match(card.body, /Namaskaram andi/);
});

test("the 4 list rows use the ids the rest of the bot already handles", () => {
  const card = buildWelcomeCard({ ...baseParams });
  const ids = card.sections[0].rows.map((r) => r.id);
  assert.deepEqual(ids, ["view_menu", "start_ordering_btn", "track_order_btn", "talk_to_human_btn"]);
});
