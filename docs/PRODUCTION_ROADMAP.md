# 🚀 Production Architecture & Implementation Roadmap

This document outlines the multi-phase technical roadmap for building a high-throughput, sub-second latency, low-cost production WhatsApp AI Bot for **Godavari Ruchulu**.

---

## 🎯 High-Level Architecture

```mermaid
flowchart TD
    A[Incoming WhatsApp Message] --> B{Step 1: Deterministic Engine}
    B -- Button Click / List Selection / Quick Code --> C[Instant Action Handler\n0ms latency | $0 LLM Tokens]
    B -- Natural Language Text --> D{Step 2: Response Cache}
    
    D -- Exact / High-Similarity Match --> E[Cached Response\n<10ms latency | $0 LLM Tokens]
    D -- Cache Miss --> F[Step 3: Lightweight Intent Classifier / Router]
    
    F -- FAQ / Order Status / Standard Query --> G[Tier 1 Fast LLM\nGemini 2.5 Flash / Haiku\nLow Cost | Fast TTFT]
    F -- Complex Inquiry / Customization / Complaints --> H[Tier 2 Reasoning LLM\nGemini 2.5 Pro / Claude Sonnet\nDeep Thinking]
    
    G --> I[Prompt Caching Layer\nStatic System Prompt + Menu Catalog cached by Provider]
    H --> I
    
    I --> J[WhatsApp Cloud API Response]
```

---

## 📋 Phase Roadmap Summary

| Phase | Module / Target | Status | Deliverables |
| :--- | :--- | :--- | :--- |
| **Phase 1** | **Database Schema & Infrastructure** | ✅ **Completed** | Single-restaurant Postgres schema, delivery dispatch tables, Supabase 500MB capacity math, documentation dictionary. |
| **Phase 2** | **AI Performance & Routing Engines** | 🚀 **Next Step** | System prompt caching, response cache layer, Tier 1 vs Tier 2 LLM router, multi-provider delivery dispatch engine. |
| **Phase 3** | **Growth & Engagement Engines** | ⏳ **Upcoming** | Festival broadcast campaigns, abandoned cart recovery (15 min), post-delivery review triggers (45 min), loyalty points. |
| **Phase 4** | **Deployment & Observability** | ⏳ **Upcoming** | GCP Cloud Run deployment pipeline, prototype DB isolation, real-time activity logging, performance dashboards. |

---

## 📑 Detailed Phase Specifications

### Phase 1: Database Schema & Infrastructure (Completed ✅)
- **Single-Tenant Optimization:** Removed 12 multi-tenant foreign keys (`restaurantId`), reducing query overhead and storage footprint.
- **Supabase Capacity Math:** Calculated storage limits (50,000 MAU, 280,000 orders max).
- **Multi-Provider Delivery Schema:** Added `DeliveryProviderConfig`, `DeliveryQuote`, and `DeliveryDispatch` tables supporting Rapido, Dunzo, Shadowfax, Uber Direct, and Porter.
- **Documentation:** Created [`DATABASE_DICTIONARY.md`](./DATABASE_DICTIONARY.md) and [`DELIVERY_INTEGRATION.md`](./DELIVERY_INTEGRATION.md).

---

### Phase 2: AI Performance & Routing Engines (Next Step 🚀)

#### Step 2A: Provider-Native Prompt Caching (`src/ai/prompt.ts`)
- **Objective:** Restructure system prompt so static prefixes (System Persona + Operating Hours + Menu Catalog + Tools Schema) stay **100% identical** across calls.
- **Benefit:** 80%+ prompt cache hit rate on Gemini / OpenAI, reducing input token costs by **75%** and Time-To-First-Token (TTFT) latency by **60%**.

#### Step 2B: Exact & Semantic Response Cache (`src/services/cache.ts`)
- **Objective:** Intercept common repetitive questions (*"What are your hours?"*, *"Send location"*, *"Show menu"*) using exact text hash or fuzzy match.
- **Benefit:** Returns cached responses in **<10ms with $0 token cost**, saving 30-50% of LLM calls during peak lunch/dinner rush.

#### Step 2C: Tiered LLM Intent Router (`src/ai/router.ts`)
- **Objective:** Classify incoming messages by complexity:
  - **Tier 1 (Fast & Cheap):** `gemini-2.5-flash` for simple FAQs, status checks, parameter extraction ($0.075/1M tokens).
  - **Tier 2 (High Reasoning):** `gemini-2.5-pro` for complex multi-item customizations, dietary advice, complaint resolution.

#### Step 2D: Multi-Provider Delivery Engine (`src/services/delivery.ts`)
- **Objective:** Build quote aggregator service that requests real-time delivery quotes from Rapido, Dunzo, Shadowfax, Uber, and Porter.
- **Selection Strategy:** Auto-dispatch using `CHEAPEST` (lowest fee) or `FASTEST` (lowest ETA) strategies.

---

### Phase 3: Automated Growth & Engagement Engines

#### 3A. Festival Broadcast Campaigns (`src/services/campaign.ts`)
- Bulk WhatsApp broadcast marketing with festival image banners, message templates, and automated coupon attachments targeted by customer segment (`top_spenders`, `inactive_30d`).

#### 3B. Automated Follow-up Tasks (`src/services/followup.ts`)
- **Abandoned Cart Recovery:** 15-minute scheduled nudge if cart is left unconfirmed (*"Your Biryani is waiting! Tap to confirm now"*).
- **Post-Delivery Review Request:** 45-minute scheduled nudge after order delivery requesting feedback or Google Review.

#### 3C. Loyalty Points Ledger (`src/services/loyalty.ts`)
- Earn points automatically on paid orders (1 point per ₹100 spent) and redeem points at checkout (1 point = ₹1 discount).

---

### Phase 4: Production Deployment & Observability
- **Prototype Database Isolation:** Staging DB setup (`godavari-bot-dev`) to test changes without touching live production bot.
- **Cloud Run Deployment Pipeline:** Containerized multi-stage Docker build deployed to GCP Cloud Run with Secret Manager environment bindings.
- **Observability & Health Checks:** Real-time latency tracking, tool error logging, and live staff notification triggers via `ActivityLog`.
