# syntax=docker/dockerfile:1
# NBG RDARR Compliance Checklist — Backend (Express / TypeScript)
# Build context: ./server

# ── Stage 1: Compile TypeScript ──────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY . .
RUN npx tsc

# ── Stage 2: Production runtime ───────────────────────────────────────────────
FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Compiled app (includes dist/scripts/run-migrations.js)
COPY --from=builder /app/dist ./dist
# Azure SQL schema + seed scripts — applied by dist/scripts/run-migrations.js at
# startup (cwd=/app -> /app/init-db). MUST ship in the image.
COPY init-db ./init-db
# Legacy node-pg-migrate files kept for reference only (no longer executed).
COPY migrations ./migrations
# Startup script: run migrations, then start the server
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

# Attachments route creates ./uploads at startup; it must be writable by the
# non-root node user. NOTE: Azure Web App container storage is ephemeral —
# uploaded files do not survive restarts/redeploys unless an Azure Files mount
# is configured for /app/uploads.
RUN mkdir -p /app/uploads && chown -R node:node /app/uploads

USER node

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD wget -qO- http://localhost:3001/api/health || exit 1

ENTRYPOINT ["./docker-entrypoint.sh"]
