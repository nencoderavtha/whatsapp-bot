# ── Build stage ──────────────────────────────────────────────────────────────
FROM node:20-slim AS builder
WORKDIR /app

# Prisma needs OpenSSL to generate/run its query engine.
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY . .

# `npm run build` = prisma generate && tsc -p tsconfig.json (emits to dist/).
RUN npm run build

# tsc only compiles .ts files, so the static admin/public assets (HTML, JS, CSS)
# are NOT emitted to dist. server.ts serves them from `<dist>/admin/public`
# (path.join(__dirname, "public")), so copy them into place.
RUN cp -r src/admin/public dist/admin/public

# ── Runtime stage ────────────────────────────────────────────────────────────
FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

# Compiled app + the generated Prisma client + schema.
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma

# Cloud Run injects PORT (default 8080); config.ts and index.ts honor it.
EXPOSE 8080
CMD ["node", "dist/index.js"]
