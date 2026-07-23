# Deployment & Scaling Architecture

> **Note:** The current production deployment path is **Google Cloud Run** — see
> [`CLOUD_RUN.md`](./CLOUD_RUN.md). The Fly.io content below is kept for historical
> reference (it targets the Baileys persistent-socket setup; the app now runs the
> stateless WhatsApp Cloud API, which is why Cloud Run needs no volume).

## Current Stack

| Component | Platform | Notes |
|---|---|---|
| Portfolio site (`exter-ai.com`) | Vercel | Static HTML/CSS/JS, unchanged |
| WhatsApp bot + admin dashboard | Railway (migrate → Fly.io) | Node.js, persistent process |
| Database | SQLite → migrate to Supabase | PostgreSQL |

---

## Target Architecture

```
exter-ai.com              → Vercel (portfolio, unchanged)
app.exter-ai.com          → Fly.io (bot platform + admin dashboards)
                               └── Supabase PostgreSQL (database)
```

### DNS flow

```
Browser: app.exter-ai.com
  → Vercel DNS: CNAME app → <app-name>.fly.dev
  → Fly.io: terminates SSL, routes to Node.js container
  → Express: serves admin dashboard + REST API
  → Bot process: WhatsApp connection (Baileys or Cloud API)
  → Supabase: reads/writes all data
```

### Today (1 restaurant)

```
app.exter-ai.com/          ← admin dashboard (Godavari Ruchulu)
app.exter-ai.com/api/*     ← REST API (Godavari Ruchulu)
                              WhatsApp bot process (Godavari Ruchulu number)
                              Supabase DB
```

### Future (N restaurants — multi-tenant)

```
app.exter-ai.com/rajamma/dashboard    ← Godavari Ruchulu admin
app.exter-ai.com/hotel-b/dashboard   ← Hotel B admin
app.exter-ai.com/api/rajamma/*        ← Godavari Ruchulu API (scoped by restaurantId)
app.exter-ai.com/api/hotel-b/*        ← Hotel B API (scoped by restaurantId)

Database: ONE Supabase project
  Restaurant table  ← top-level tenant
  All other tables have restaurantId FK → data never crosses tenants

Bot processes: one per WhatsApp number
  Can run as worker threads in the same Fly.io app
  OR separate Fly.io apps (one per restaurant) sharing the same DB
```

---

## Phase 1 — Supabase Migration

### 1. Create Supabase project

1. Go to https://supabase.com → New project
2. Copy the **connection string** (Settings → Database → Connection string → URI mode)
   - Use the **pooler URL** (port 6543) for production: avoids connection limit issues

### 2. Update Prisma schema

Change `prisma/schema.prisma`:

```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
```

### 3. Push schema and seed

```bash
# Set DATABASE_URL to your Supabase pooler URL first
npx prisma db push
npm run db:seed
```

### 4. Update environment variables

```env
DATABASE_URL=postgresql://postgres.[project-ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres
```

---

## Phase 2 — Subdomain Setup (Fly.io, Free)

### Why Fly.io

| Platform | Persistent process | Custom domain free | Always-on free tier | Volume storage |
|---|---|---|---|---|
| Vercel | No (serverless) | Yes | N/A | No |
| Railway | Yes | Requires Hobby ($5/mo) | No | No |
| Render | Yes | Yes | Spins down after 15 min | No |
| **Fly.io** | **Yes** | **Yes** | **Yes (3 free VMs)** | **Yes (3 GB free)** |

Baileys requires a persistent WebSocket connection and writes session files to disk — Fly.io is the only free platform that handles both.

### Step 1 — Install Fly CLI

```powershell
# Windows PowerShell
iwr https://fly.io/install.ps1 -useb | iex
fly auth signup
```

### Step 2 — Add Dockerfile

Create `Dockerfile` in the project root:

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN npm run build
EXPOSE 4000
CMD ["node", "dist/index.js"]
```

### Step 3 — Add fly.toml

Create `fly.toml` in the project root:

```toml
app = "godavari-ruchulu-bot"          # change to your chosen app name
primary_region = "sin"       # Singapore — closest free region to Hyderabad

[build]

[env]
  NODE_ENV = "production"
  ADMIN_PORT = "4000"

[http_service]
  internal_port = 4000
  force_https = true
  auto_stop_machines = false   # keep bot alive 24/7
  auto_start_machines = true

[[vm]]
  size = "shared-cpu-1x"
  memory = "256mb"

[mounts]
  source = "bot_data"
  destination = "/app/auth_session"   # persists WhatsApp login across deploys
```

### Step 4 — Create volume and set secrets

```bash
fly volumes create bot_data --size 1 --region sin
fly secrets set \
  GROQ_API_KEY="..." \
  DATABASE_URL="..." \
  ADMIN_PASSWORD="..." \
  OWNER_NUMBERS="..."
```

### Step 5 — Deploy

```bash
fly deploy
```

### Step 6 — Add custom domain

```bash
fly certs add app.exter-ai.com
# Fly outputs a CNAME target, e.g.: app.exter-ai.com.fly.dev
```

Fly.io auto-provisions a Let's Encrypt SSL certificate — no cost.

### Step 7 — Add DNS record in Vercel

Vercel dashboard → exter-ai project → Domains → DNS Records:

```
Type:   CNAME
Name:   app
Value:  <the .fly.dev address from step 6>
TTL:    300
```

Done. `https://app.exter-ai.com` is live with SSL.

---

## Phase 3 — Multi-Tenant Refactor (when adding restaurant #2)

Do this only when onboarding a second restaurant. No point building it early.

### DB schema addition

```prisma
model Restaurant {
  id          Int        @id @default(autoincrement())
  slug        String     @unique   // "rajamma", "hotel-b" — used in URL
  name        String
  ownerPhone  String               // receives order alert messages
  apiKey      String     @unique   // bot authenticates with this
  createdAt   DateTime   @default(now())

  categories  Category[]
  customers   Customer[]
  orders      Order[]
}
```

Add `restaurantId Int` to: `Category`, `Customer`, `Order`. `MenuItem` inherits scope through `Category`. `Message` inherits scope through `Customer`.

### API routing pattern

```
/api/:slug/menu
/api/:slug/orders
/api/:slug/customers
```

Middleware reads `:slug`, looks up `restaurantId`, injects it into every DB query — Hotel A can never read Hotel B's data.

### Dashboard routing pattern

```
/:slug/dashboard     → serves the admin UI with restaurantId context
```

### Bot process pattern

Each restaurant runs its own bot instance identified by `apiKey`. Options:

- **Option A (simple):** Each restaurant = a separate Fly.io app (same Supabase DB, different bot process). Easy to manage, slightly more overhead.
- **Option B (efficient):** One Fly.io app runs N bot instances as worker threads, each scoped to a `restaurantId`. Cheaper, but more complex.

Start with Option A. Migrate to Option B if you have 5+ restaurants.

---

## Cost Summary (all free tier)

| Component | Platform | Free tier limit | Cost |
|---|---|---|---|
| Portfolio | Vercel | 100 GB bandwidth/mo | $0 |
| Bot + dashboard | Fly.io | 3 VMs, 160 GB transfer/mo | $0 |
| Volume (auth session) | Fly.io | 3 GB | $0 |
| Database | Supabase | 500 MB DB, 2 GB bandwidth | $0 |
| SSL certificate | Fly.io (Let's Encrypt) | Unlimited | $0 |
| DNS | Vercel DNS | Unlimited records | $0 |
| **Total** | | | **$0/mo** |

### When you'll hit limits

| Trigger | Which limit | Fix |
|---|---|---|
| DB > 500 MB | Supabase free tier | Upgrade Supabase to Pro ($25/mo) |
| 2+ restaurants | Fly.io 3 VM limit | Upgrade to Fly.io Pay-as-you-go (~$2-3/VM/mo) |
| AI tokens > 100k/day | Groq free tier | Enable Groq pay-as-you-go billing |
| Large media/images | Fly.io 160 GB transfer | Unlikely for a text bot |

---

## Deployment Checklist

- [ ] Supabase project created, connection string copied
- [ ] `prisma/schema.prisma` provider changed to `postgresql`
- [ ] `prisma db push` run against Supabase, seed data inserted
- [ ] `Dockerfile` added to project root
- [ ] `fly.toml` added to project root
- [ ] Fly.io account created, CLI installed
- [ ] `fly volumes create bot_data` run
- [ ] All secrets set via `fly secrets set`
- [ ] `fly deploy` succeeded
- [ ] `fly certs add app.exter-ai.com` run, CNAME target noted
- [ ] CNAME record added in Vercel DNS
- [ ] `https://app.exter-ai.com` loads admin dashboard
- [ ] WhatsApp QR scanned, bot connected
- [ ] Test order placed end-to-end
