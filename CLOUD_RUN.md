# Deploying to Google Cloud Run

This is the current production deployment path for the WhatsApp bot + admin dashboard.
(The older Fly.io notes in `DEPLOYMENT.md` are kept only for historical reference.)

Cloud Run fits this app because the active WhatsApp provider is the **stateless Cloud API
webhook** (`WHATSAPP_PROVIDER=cloud`) — there is no persistent WebSocket or on-disk session to
keep, so no volume is needed. The container is built by the repo `Dockerfile` (multi-stage:
`prisma generate && tsc`, then runs `node dist/index.js`).

Region used below: **`asia-south1`** (Mumbai). All commands run from your machine.

---

## 0. Prerequisites

- A Supabase Postgres project (you already have one — reuse its `DATABASE_URL` / `DIRECT_URL`).
- The `gcloud` CLI installed and a Google account with billing available.
- Your AI key(s), Meta WhatsApp Cloud token + phone number ID, admin password, JWT secret.

```bash
gcloud auth login
gcloud config set project <YOUR_PROJECT_ID>       # or: gcloud projects create ...
gcloud config set run/region asia-south1
```

Enable the required APIs:

```bash
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  cloudbuild.googleapis.com
```

---

## 1. One-time database init (run locally, NOT in the container)

The container does **not** run `prisma db push` or seed on boot. Do it once against Supabase:

```bash
# with DATABASE_URL and DIRECT_URL pointed at Supabase in your local .env
npx prisma db push        # creates/updates tables incl. ActivityLog, personaName, humanRequestedAt
npm run db:seed           # seeds tool definitions (incl. check_order_status, request_human_handoff)
                          # and the restaurant "notes" template
```

Re-run `npx prisma db push` any time the schema changes on a later deploy.

---

## 2. Store secrets in Secret Manager

Create one secret per value (repeat for each). Example:

```bash
printf '%s' 'postgresql://...pooler.supabase.com:6543/postgres?pgbouncer=true' \
  | gcloud secrets create DATABASE_URL --data-file=-
```

Secrets to create (names match the env vars the app reads in `src/config.ts`):

| Secret | Notes |
|---|---|
| `DATABASE_URL` | Supabase transaction pooler URL (port 6543) |
| `DIRECT_URL` | Supabase session pooler URL (used by prisma db push/seed) |
| `OPENROUTER_API_KEY` **or** `GEMINI_API_KEY` | whichever provider you keep (see §5) |
| `WHATSAPP_CLOUD_TOKEN` | Meta permanent token |
| `WHATSAPP_PHONE_NUMBER_ID` | Meta phone number ID |
| `WHATSAPP_VERIFY_TOKEN` | your chosen webhook verify token |
| `ADMIN_PASSWORD` | dashboard password |
| `JWT_SECRET` | long random string |
| `OWNER_NUMBERS` | comma-separated owner WhatsApp numbers |

Non-secret config (`AI_PROVIDER`, `AI_MODEL`, `WHATSAPP_PROVIDER=cloud`) is passed as plain env
vars at deploy time (§4).

---

## 3. Build & push the image

```bash
gcloud builds submit --tag asia-south1-docker.pkg.dev/<YOUR_PROJECT_ID>/bot/godavari-ruchulu-bot:latest
```

(If the Artifact Registry repo doesn't exist yet:
`gcloud artifacts repositories create bot --repository-format=docker --location=asia-south1`.)

---

## 4. Deploy the Cloud Run service

`--min-instances=1` keeps the demo warm (no cold-start lag in front of a client).

```bash
gcloud run deploy godavari-ruchulu-bot \
  --image asia-south1-docker.pkg.dev/<YOUR_PROJECT_ID>/bot/godavari-ruchulu-bot:latest \
  --region asia-south1 \
  --allow-unauthenticated \
  --min-instances=1 \
  --port 8080 \
  --set-env-vars AI_PROVIDER=openrouter,AI_MODEL=google/gemini-2.5-flash,WHATSAPP_PROVIDER=cloud \
  --set-secrets \
DATABASE_URL=DATABASE_URL:latest,\
DIRECT_URL=DIRECT_URL:latest,\
OPENROUTER_API_KEY=OPENROUTER_API_KEY:latest,\
WHATSAPP_CLOUD_TOKEN=WHATSAPP_CLOUD_TOKEN:latest,\
WHATSAPP_PHONE_NUMBER_ID=WHATSAPP_PHONE_NUMBER_ID:latest,\
WHATSAPP_VERIFY_TOKEN=WHATSAPP_VERIFY_TOKEN:latest,\
ADMIN_PASSWORD=ADMIN_PASSWORD:latest,\
JWT_SECRET=JWT_SECRET:latest,\
OWNER_NUMBERS=OWNER_NUMBERS:latest
```

Note the service URL it prints (e.g. `https://godavari-ruchulu-bot-xxxx.a.run.app`). Then set `SERVER_URL`
to that URL so CTA menu/pay links resolve, and redeploy (add to `--set-env-vars`):

```bash
gcloud run services update godavari-ruchulu-bot --region asia-south1 \
  --update-env-vars SERVER_URL=https://godavari-ruchulu-bot-xxxx.a.run.app
```

---

## 5. (Optional) Pick the faster AI path

Current default is Gemini via OpenRouter (`AI_PROVIDER=openrouter`,
`AI_MODEL=google/gemini-2.5-flash`). Direct Gemini is also supported. Measure both locally with
`npm run chat` (watch the **Activity** tab's "Avg Response" stat), then keep the faster one — it's
just env vars, no code change:

```bash
# direct Gemini
--set-env-vars AI_PROVIDER=gemini,AI_MODEL=gemini-2.5-flash,WHATSAPP_PROVIDER=cloud
# and store GEMINI_API_KEY as a secret instead of OPENROUTER_API_KEY
```

---

## 6. Point Meta's webhook at Cloud Run

In the Meta App dashboard → WhatsApp → Configuration → Webhook:

- **Callback URL:** `https://godavari-ruchulu-bot-xxxx.a.run.app/webhook`
- **Verify token:** the same value you stored in `WHATSAPP_VERIFY_TOKEN`.

Click Verify and Save, then make sure the **messages** field is subscribed. The app's
`GET /webhook` handler answers the verification challenge and `POST /webhook` ingests messages.

---

## 7. Smoke test

- Message the connected WhatsApp number: run a full order (menu → order → payment → confirm).
- Ask "where is my order?" → `check_order_status` replies.
- Ask "I want to talk to a person" → handoff fires, the AI pauses. In the dashboard **Chats** tab
  the "🙋 Human requested" banner appears — reply from the box, then tap **Resume AI**.
- Open the dashboard at the Cloud Run URL and confirm the **Activity** tab populates
  (response times, any tool errors, the handoff/resume events).
