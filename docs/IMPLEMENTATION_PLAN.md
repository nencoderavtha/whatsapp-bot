# Implementation Plan — Deterministic Ordering Core

> **Status:** executable plan, written against the code as it stands on `production-hardening` (commit `297d6fe`).
> **Supersedes:** the Phase 2 "AI Performance & Routing Engines" section of [`PRODUCTION_ROADMAP.md`](./PRODUCTION_ROADMAP.md), which is a wishlist rather than a sequence. Phases 3 and 4 of that document remain valid and are folded in below.

Every claim about current behaviour here was verified against the source, not inferred. Line references are to `production-hardening`.

---

## 1. Where the system actually is

**The platform works.** It takes orders from real customers, collects addresses, quotes delivery live via Borzo, charges through Razorpay and dispatches couriers. This is not a rewrite plan.

**What is already correct** — and must not be undone by anything below:

| Capability | Where | Note |
|---|---|---|
| Message renderer layer | `src/whatsapp/renderers.ts` | `MessageType` enum, pure render functions returning a `Rendered` descriptor. The AI does not compose customer-facing UI. |
| Address survives a cart edit | `src/whatsapp/stage.ts:36` | `stageAfterCartEdit` rewinds to `ADDRESS_SELECTED`, never to `BUILDING_CART`. |
| Stale payment links voided | `src/whatsapp/stage.ts:82` | Cart edit nulls the link and tells the customer. |
| Deterministic button routing | `src/whatsapp/session-manager.ts` | Address and payment button ids are handled before the agent is reached. |
| Cross-instance turn locking | `src/services/conversation-lock.ts` | Postgres lease. |
| Payment-failure recovery | `src/admin/server.ts:200`+ | `payment_link.cancelled` / `expired` → `PAYMENT_FAILED`, guarded by link id. |

**What is genuinely missing** — verified counts, not estimates:

| Gap | Evidence |
|---|---|
| No structured intent layer | `src/ai/agent.ts:115` runs a 6-hop free-form tool loop; the LLM chooses the tools |
| No observability | 112 `console.*` calls; `pino` is a dependency imported **nowhere**; 0 correlation ids |
| No Redis | 0 references; all active state is Postgres |
| No delivery failover | No `DeliveryProvider` interface; `DeliveryOrchestrator` is a concrete class |
| No campaign/loyalty engine | Tables exist (`Campaign`, `LoyaltyAccount`, `FollowupTask`); no code drives them |
| No Petpooja integration | 0 references anywhere |

---

## 2. The core problem, stated precisely

The system prompt currently contains these instructions (`src/ai/prompt.ts:55`, `:57`):

> `Do NOT generate a payment link or call confirm_order yourself — the system handles address collection, final bill, and payment after the customer confirms.`

> `NEVER tell the customer "payment received" or "order confirmed" just because they SAY they paid.`

**Every one of those lines is a business rule being enforced by persuasion.** A prompt is advisory. The model has `confirm_order` and `generate_payment_link` in its tool list and can call them on any turn; the only thing stopping it is that it was asked nicely. `tools.ts:474` then has to defensively reject `confirm_order` at runtime *because the model does call it*.

That is the actual root cause. The bugs already fixed on this branch — the cart-wiping heuristic, the address loop, the stale payment link — were all symptoms of business logic living in a place that cannot enforce it. Fixing symptoms one at a time is what the last several commits have been doing. More will arrive until the workflow moves.

**The fix:** the LLM classifies and phrases. The backend decides and acts.

---

## 3. Sequencing

Ordered by dependency and by risk to live customers — not by value. Two rules drove the order:

1. **Observability comes before the refactor.** You cannot safely rewrite the core of a system serving real orders when the only instrument is `console.log`. This reverses what I recommended earlier in conversation; the earlier ordering was wrong.
2. **The intent layer ships in shadow mode first.** It runs and logs alongside the existing path without controlling anything, until its agreement rate is measured.

| Phase | Outcome | Size | Risk |
|---|---|---|---|
| **0** | P0 defects | ✅ done | — |
| **1** | Structured logging + correlation ids | S | Low |
| **2** | Intent extraction in shadow mode | M | **None** (nothing acts on it) |
| **3** | Slot engine + deterministic router | L | High — gated by Phase 2 data |
| **4** | Consistency cleanup | S | Low |
| **5** | Redis for hot state | M | Medium |
| **6** | Delivery provider interface + failover | M | Medium |
| **7** | Campaigns / loyalty / abandoned cart | L | Low |

Sizes are relative. Phase 3 is larger than 1, 2 and 4 combined.

---

## Phase 1 — Observability

**Why first:** Phase 2 measures agreement between two code paths and Phase 3 changes the core. Neither is verifiable without structured logs. This phase is small and pays for itself immediately.

**Changes**
- `src/services/logger.ts` (new) — wrap `pino`, already a dependency at `package.json`. JSON to stdout; Cloud Run ingests it as structured automatically.
- Correlation id per inbound message, generated in `session-manager.ts` at ingest, threaded through `handleIncoming` → `processIncoming` → `runTool`. Use `AsyncLocalStorage` so it does not become a parameter on 40 functions.
- Replace the 112 `console.*` calls. Mechanical; do it in one commit so review is a diff of shape, not logic.
- Log per turn: `correlationId`, `customerId`, `stage` before and after, tools called, LLM latency, total latency, outcome.

**Verification:** trigger a full order in staging, confirm one correlation id links every line from webhook to payment link.

**Rollback:** revert the commit. No schema, no behaviour change.

---

## Phase 2 — Intent extraction (shadow mode)

**Deliberately does nothing to customers.** It runs beside the existing path and writes both results to the log.

**Changes**
- `src/ai/intent.ts` (new). One LLM call, JSON-only response, no tools:

  ```ts
  export const INTENTS = [
    "ADD_ITEM", "REMOVE_ITEM", "UPDATE_QUANTITY", "CLEAR_CART",
    "CONFIRM_CART", "CHANGE_ADDRESS", "SELECT_ADDRESS",
    "CHECK_STATUS", "CANCEL_ORDER", "FAQ", "REQUEST_HUMAN",
    "GREETING", "OUT_OF_SCOPE", "UNKNOWN",
  ] as const;

  export interface Intent {
    intent: (typeof INTENTS)[number];
    items?: { name: string; qty?: number; variant?: string; note?: string }[];
    confidence: number;
  }
  ```
  Validate with `zod` (already a dependency). A response that fails the schema becomes `UNKNOWN` — never a guess.

- In `agent.ts`, run `classifyIntent()` concurrently with the existing tool loop via `Promise.all`. **It adds no latency** — it runs in parallel, and its result is discarded.
- Log both: classified intent vs. tools the loop actually called.
- `ShadowIntentLog` table, or reuse `ActivityLog` with `type: "intent_shadow"`. Reusing `ActivityLog` is cheaper and it already has a `createdAt` index.

**Exit criteria — do not start Phase 3 until:**
- ≥ 500 real turns logged
- ≥ 95% agreement between classified intent and the tool the loop chose, on turns where the loop called a cart tool
- Every disagreement class inspected by hand and either explained or fixed

**Cost note:** this doubles LLM calls per turn for the duration. At Groq/Gemini Flash pricing on this volume it is negligible; if it is not, sample at 30% rather than shortening the measurement window.

**Rollback:** feature-flag it off. It touches nothing.

---

## Phase 3 — Slot engine and deterministic router

The real work. Only begin once Phase 2's exit criteria are met.

**Changes**

`src/orchestrator/slots.ts` (new) — what the order still needs:

```ts
export type Slot = "cart" | "address" | "quote" | "confirmation" | "payment";

/** Slots still unfilled, in the order they must be collected. */
export function missingSlots(draft: PendingOrder, customer: Customer): Slot[];
```

Derived from the row, never from conversation history. This is the direct answer to "what information is missing?" and it replaces every place the code currently infers position from what was said.

`src/orchestrator/transitions.ts` (new) — the state machine:

```ts
export function nextAction(
  stage: OrderStage,
  intent: Intent,
  missing: Slot[],
): Action;   // { kind: "render", type: MessageType } | { kind: "mutate", op: ... } | { kind: "reply_freeform" }
```

Pure, total, unit-testable with no database. **This is where the plan's value concentrates** — a pure function over (stage × intent × slots) can be exhaustively tested, which the current tool loop cannot be.

**Routing after the change**
- Cart/address/payment intents → orchestrator → renderer. The LLM never touches these.
- `FAQ`, `GREETING`, `OUT_OF_SCOPE` → LLM for natural phrasing only, with no tools bound.
- `UNKNOWN` or confidence below threshold → clarifying question, never a guess at a mutation.

**Tools removed from the LLM entirely:** `propose_order`, `confirm_order`, `generate_payment_link`, `record_payment`, `cancel_order`. They become internal functions the orchestrator calls. `send_item_photo` and `check_order_status` can stay — they are reads.

Once the model cannot call them, the `Do NOT ...` fences come out of the system prompt, and `tools.ts:474`'s defensive rejection is deleted. **That deletion is the acceptance test for this phase.**

**Rollout**
1. Ship behind `ORCHESTRATOR_ENABLED`, default off.
2. Enable for the owner's own number first.
3. Enable for 10% of customers by `customerId % 10`.
4. Full rollout after a week clean.

**Rollback:** flag off — the old path stays in the codebase until step 4 has held for a week.

---

## Phase 4 — Consistency cleanup

Small, independent, can slot in anywhere after Phase 1.

1. **Last prose-sniffing interceptor** — `session-manager.ts:1329` still branches on `reply.includes("🛒 *Your Cart:*")`. Dies naturally with Phase 3; delete it explicitly if Phase 3 slips.
2. **Pickup is broken and needs a product decision.** `session-manager.ts:1026` sets `PendingOrder.type = "pickup"`, but the Razorpay webhook hardcodes `type: "delivery"` (`admin/server.ts:243`). **A customer who taps "🛍️ Pickup" today is charged a delivery fee and has a courier dispatched.** Either remove the pickup button and handler, or honour `type` through the webhook, fee calculation and dispatch. Removing is ~20 lines; honouring is ~150 plus admin UI. This is the one item on this plan that is a business call, not an engineering one.
3. **Dead `PAYMENT_RECEIVED` stage** — nothing sets it anywhere. Remove from the enum, or start setting it in the webhook between payment and order creation. Cosmetic either way.

---

## Phase 5 — Redis (✅ Completed)

**Not a correctness fix — a latency fix.** Deferred deliberately until after Phase 3, because Phase 3 changes what state is hot and doing this first would mean caching the wrong things.

The database is in `ap-northeast-2` / `ap-southeast-1`; the restaurant is in Hyderabad. Every message pays that round trip several times, and the conversation lock added one more.

**Move to Redis:** conversation lock and queue (`conversation-lock.ts` is written to be swapped — same three functions), active `PendingOrder` drafts, menu cache, delivery-quote cache, idempotency keys.
**Stays in Postgres:** everything that is a source of truth. Redis is a cache and a lock, never the record.

**Prerequisite:** provision Redis (Upstash via Vercel Marketplace, or Memorystore alongside Cloud Run) and set `REDIS_URL`. Keep the Postgres implementation as a fallback so a Redis outage degrades to today's latency rather than downtime.

---

## Phase 6 — Delivery provider interface

```ts
export interface DeliveryProvider {
  readonly code: DeliveryProviderCode;
  getQuote(p: QuoteParams): Promise<UnifiedQuote | null>;
  createDelivery(r: DispatchRequest): Promise<DispatchResult>;
  cancelDelivery(id: string): Promise<boolean>;
  trackDelivery(id: string): Promise<TrackingState>;
}
```

Retrofit Borzo, Shadowfax and Shiprocket to it — the shapes already exist in `orchestrator.ts:19-58`, they are just not behind an interface. Then add: quote all enabled providers in parallel, select by `DeliveryProviderConfig.priorityWeight`, and fail over to the next provider on dispatch failure. Uber Direct and Rapido then become new files rather than new branches in the orchestrator.

**Test with a deliberately failing stub provider** — provider outage is not something to first exercise in production.

---

## Phase 7 — Growth engines

Absorbs Phase 3 of `PRODUCTION_ROADMAP.md`, unchanged in intent. Tables already exist.

- **Abandoned cart** — `FollowupTask` at 15 min on a cart that never reached `PAYMENT_RECEIVED`. Highest revenue-per-line-of-code item in this document.
- **Loyalty ledger** — earn on paid orders, redeem at checkout. `LoyaltyAccount` / `LoyaltyTransaction` are ready.
- **Campaign engine** — segment (`dormant`, `high_value`, per-dish), send, track via `CampaignRecipient`.
- Needs a scheduler. Cloud Run Jobs on a cron is sufficient; do not add a queue system for this.

---

## 4. Explicitly not doing

| Item | Why |
|---|---|
| **Full multi-tenancy** | `PRODUCTION_ROADMAP.md` Phase 1 records that 12 `restaurantId` foreign keys were **deliberately removed** for query and storage efficiency. Reversing a deliberate decision speculatively is wrong. `DEFAULT_RESTAURANT_ID` marks the seam; do the migration when a second restaurant signs, not before. |
| **Petpooja adapter** | Zero code today, and the integration shape depends entirely on which Petpooja API tier the restaurant is on. Design it against a real credential, not a spec. |
| **Full event-driven rewrite** | The original plan's section C. Phase 3 delivers the actual benefit — deterministic, testable transitions. An event bus on top adds indirection without adding correctness at this scale. Revisit if a second consumer of order events appears. |
| **Tiered LLM router** | `PRODUCTION_ROADMAP.md` Phase 2C. After Phase 3 most turns will not reach an LLM at all, which is a bigger saving than routing between models. Re-evaluate then. |

---

## 5. Immediate next actions

1. Merge `production-hardening` after the UAT suite passes against staging — **not** against the live Supabase instance in `.env`.
2. Provision a staging database. Phases 2 and 3 are not safely testable without one, and `npm start` runs `prisma db push` on whatever `DATABASE_URL` points at.
3. Begin Phase 1.

Decide the pickup question (Phase 4, item 2) whenever convenient — it is independent of everything else, and it is charging customers a delivery fee for pickup orders today.
