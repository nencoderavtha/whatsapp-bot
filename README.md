# Godavari Ruchulu — WhatsApp AI Ordering Agent

A WhatsApp agent that chats like a real person at the counter, takes orders, and
remembers customers. The menu is **dynamic** — stored in a database and edited
live from an admin portal, so the bot always knows what's actually available today.

## What's inside
- **Human-like AI agent** with a plain, understated Konaseema-kitchen voice. Never reveals it's a bot.
- **Dynamic menu** in a database (Prisma + SQLite for dev, Postgres for prod).
- **Order taking** via tool-calling — confirms items + total, places the order, alerts the owner on WhatsApp.
- **Per-customer memory** — full conversation history + saved name/address/preferences.
- **Admin portal** (web) — manage menu, toggle item availability live, view & update orders, see customers.
- **Swappable WhatsApp layer** — Baileys (free QR login, for demo) or the official Meta Cloud API (production).

## Architecture
```
WhatsApp  ──▶  Adapter (Baileys | Cloud API)  ──▶  AI Agent (Groq + tools)
                                                       │
                                                       ▼
                                              Services: menu / orders / customer
                                                       │
                                                       ▼
                                              Database (Prisma)  ◀──  Admin Portal (web)
```

## Setup
1. Install dependencies:
   ```
   npm install
   ```
2. Create your `.env` from the template and add your **free** Groq key:
   ```
   copy .env.example .env
   ```
   Get a free key at https://console.groq.com/keys and set `GROQ_API_KEY`.
   Also change `ADMIN_PASSWORD`, and (optionally) set `OWNER_NUMBERS`.
3. Create the database and seed a starter menu:
   ```
   npm run db:push
   npm run db:seed
   ```

## Test the AI first (no WhatsApp needed)
Talk to the bot right in your terminal to confirm your key + persona work:
```
npm run chat
```

## Run
- Everything together (admin + bot):
  ```
  npm run dev
  ```
- Or separately:
  ```
  npm run admin    # admin portal only
  npm run bot      # WhatsApp bot only
  ```

### First WhatsApp connection (Baileys / demo)
When the bot starts it prints a QR code in the terminal. On the phone you want the
bot to use: **WhatsApp → Settings → Linked Devices → Link a device** → scan it.
The session is saved in `auth_session/` so you only scan once.

> ⚠️ Baileys is unofficial. Great for demos, but use a spare number — heavy
> automated use of a personal number risks a WhatsApp ban. For production, switch
> to the official Cloud API (below).

### Admin portal
Open `http://localhost:4000`, log in with `ADMIN_PASSWORD`. Add/edit categories
and dishes, flip the **available** toggle when something runs out (the bot picks
it up immediately), and manage incoming orders.

## Going to production: official WhatsApp Cloud API
1. Create a Meta Business app + WhatsApp product, get a permanent token and phone number ID.
2. In `.env` set:
   ```
   WHATSAPP_PROVIDER=cloud
   WHATSAPP_CLOUD_TOKEN=...
   WHATSAPP_PHONE_NUMBER_ID=...
   WHATSAPP_VERIFY_TOKEN=some-secret
   ```
3. Point the Meta webhook at `https://your-server/webhook` (the bot serves it on `ADMIN_PORT + 1`).
   No other code changes needed.

## Switching to Postgres
1. In `prisma/schema.prisma` change the datasource `provider` to `"postgresql"`.
2. Set `DATABASE_URL` to your Postgres connection string.
3. `npm run db:push && npm run db:seed`.

## ⚠️ Free-tier limits (read before going live)
- The bot uses **`llama-3.3-70b-versatile`** — this is the model that reliably calls tools
  and writes good Telugu. **Do not switch to `llama-3.1-8b-instant`**: it hallucinates
  items and fails to place orders correctly.
- Groq's **free tier caps the 70B model at ~100,000 tokens/day**. Because each order
  conversation re-sends the menu + persona several times, that's only roughly
  **5–10 full orders per day**. This is fine for **building and demoing**, but a live
  restaurant will hit the cap fast.
- **Before real launch**, enable Groq's pay-as-you-go Dev tier at
  https://console.groq.com/settings/billing (removes the daily cap, still cheap — a few
  dollars/month for a small restaurant). No code change needed.
- The bot auto-retries on short rate-limits and degrades gracefully when the daily cap is hit.

## How order placement works (no duplicate/fake orders)
The AI never writes an order directly. It must:
1. `propose_order` — stages the cart, validated against the live menu (real IDs + prices).
2. Read the total back to the customer and get a clear "yes".
3. `confirm_order` — places the **server-stored** proposed cart, exactly once (idempotent).

This makes duplicate or fabricated orders structurally impossible even if the model misbehaves.

## Notes
- Conversation memory lives in the `Message` table; the last ~14 turns are sent to the model each reply.
