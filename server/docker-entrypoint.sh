#!/bin/sh
set -e

# Run database migrations before starting the server.
# Migrations are idempotent (node-pg-migrate tracks applied migrations in the
# pgmigrations table) and fully provision the schema + seed data (questions, users),
# so the container is self-bootstrapping against a fresh Azure PostgreSQL instance.
echo "[entrypoint] Running database migrations..."
npm run migrate

echo "[entrypoint] Migrations complete. Starting server..."
exec node dist/index.js
