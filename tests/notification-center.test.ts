/**
 * Unit tests for the notification center's pure/testable parts.
 *
 * `notify()` itself talks to the DB, the SSE bus and (for critical severity)
 * live WhatsApp sessions, so it isn't exercised here. What's tested is the
 * decision logic around it — channel selection, the enabled/critical-only
 * skip rule, and the multi-channel/multi-contact dispatch loop — using fake
 * `NotificationChannel` implementations instead of any real provider or DB
 * row:
 *
 *   npx tsx --test tests/notification-center.test.ts
 */

import test, { after } from "node:test";
import assert from "node:assert/strict";

import {
  resolveChannels,
  shouldSkipDelivery,
  dispatchToContacts,
  whatsappChannel,
  smsChannel,
  emailChannel,
  pushChannel,
  type NotificationChannel,
} from "../src/services/notification-center.js";
import { prisma } from "../src/db.js";
import { redis } from "../src/services/redis.js";

// notification-center.js pulls in the shared Prisma client and (transitively)
// the Redis client used for the customer cache, even though none of the tests
// below touch either — same reason tests/token-counter.test.ts needs this:
// neither connection is closed by node:test on its own, so without this the
// process hangs after the last test instead of exiting.
after(async () => {
  await prisma.$disconnect();
  redis?.disconnect();
});

// ── resolveChannels ──────────────────────────────────────────────────────

test("resolveChannels parses a comma-separated list into the matching channels", () => {
  const channels = resolveChannels("whatsapp,sms");
  assert.equal(channels.length, 2);
  assert.equal(channels[0], whatsappChannel);
  assert.equal(channels[1], smsChannel);
});

test("resolveChannels trims whitespace and lowercases channel names", () => {
  const channels = resolveChannels(" WhatsApp , Email ");
  assert.deepEqual(channels, [whatsappChannel, emailChannel]);
});

test("resolveChannels ignores unrecognized channel names", () => {
  const channels = resolveChannels("whatsapp,carrier-pigeon,push");
  assert.deepEqual(channels, [whatsappChannel, pushChannel]);
});

test("resolveChannels falls back to whatsapp-only for empty/unrecognized config", () => {
  assert.deepEqual(resolveChannels(""), [whatsappChannel]);
  assert.deepEqual(resolveChannels(null), [whatsappChannel]);
  assert.deepEqual(resolveChannels("carrier-pigeon"), [whatsappChannel]);
});

// ── shouldSkipDelivery ───────────────────────────────────────────────────

test("shouldSkipDelivery does not skip when config is missing (defaults to attempt)", () => {
  assert.equal(shouldSkipDelivery(undefined, "critical"), false);
  assert.equal(shouldSkipDelivery(null, "info"), false);
});

test("shouldSkipDelivery skips everything when notificationsEnabled is false", () => {
  const cfg = { notificationsEnabled: false, criticalOnlyMode: false };
  assert.equal(shouldSkipDelivery(cfg, "critical"), true);
  assert.equal(shouldSkipDelivery(cfg, "info"), true);
});

test("shouldSkipDelivery in criticalOnlyMode skips non-critical severities only", () => {
  const cfg = { notificationsEnabled: true, criticalOnlyMode: true };
  assert.equal(shouldSkipDelivery(cfg, "info"), true);
  assert.equal(shouldSkipDelivery(cfg, "warning"), true);
  assert.equal(shouldSkipDelivery(cfg, "critical"), false);
});

test("shouldSkipDelivery attempts delivery when enabled and not critical-only", () => {
  const cfg = { notificationsEnabled: true, criticalOnlyMode: false };
  assert.equal(shouldSkipDelivery(cfg, "info"), false);
  assert.equal(shouldSkipDelivery(cfg, "warning"), false);
  assert.equal(shouldSkipDelivery(cfg, "critical"), false);
});

// ── dispatchToContacts ───────────────────────────────────────────────────

function fakeChannel(name: string, ok: boolean, error?: string): NotificationChannel {
  return {
    name,
    async send() {
      return ok ? { ok: true } : { ok: false, error: error ?? `${name} failed` };
    },
  };
}

test("dispatchToContacts reports success when at least one contact/channel succeeds", async () => {
  const working = fakeChannel("fake-working", true);
  const result = await dispatchToContacts(["+911111111111"], [working], "hello", 1);
  assert.equal(result.ok, true);
  assert.equal(result.channel, "fake-working");
});

test("dispatchToContacts reports failure only when every contact/channel fails", async () => {
  const broken = fakeChannel("fake-broken", false, "no credentials");
  const result = await dispatchToContacts(["+911111111111", "+922222222222"], [broken], "hello", 1);
  assert.equal(result.ok, false);
  assert.equal(result.error, "no credentials");
});

test("dispatchToContacts one recipient's failure does not stop the others", async () => {
  let calls = 0;
  const flaky: NotificationChannel = {
    name: "flaky",
    async send(phone) {
      calls++;
      if (phone === "+91bad") return { ok: false, error: "bad number" };
      return { ok: true };
    },
  };
  const result = await dispatchToContacts(["+91bad", "+91good"], [flaky], "hello", 1);
  assert.equal(calls, 2, "both contacts should have been attempted");
  assert.equal(result.ok, true);
});

test("dispatchToContacts tries every configured channel, not just the first", async () => {
  const broken = fakeChannel("broken", false);
  const working = fakeChannel("working", true);
  const result = await dispatchToContacts(["+911111111111"], [broken, working], "hello", 1);
  assert.equal(result.ok, true);
  assert.equal(result.channel, "working");
});

// ── Honest stubs ─────────────────────────────────────────────────────────

test("sms/email/push channels are honest stubs that report non-delivery, not fake success", async () => {
  for (const channel of [smsChannel, emailChannel, pushChannel]) {
    const result = await channel.send("+911111111111", "hello", 1);
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /not configured/);
  }
});
