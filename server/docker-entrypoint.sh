#!/bin/sh
set -e

# Apply database migrations (schema + seeds) before starting the server.
# Azure SQL has no docker-entrypoint-initdb.d; the migration runner is the ONLY
# path that provisions the schema + seed data (questions, users, reference
# tables/weights). It is idempotent — each init-db/*.sql is guarded and the
# runner records applied files in app.schema_migrations, so re-runs are no-ops.
#
# Production image installs prod deps only (no tsx), so we run the COMPILED
# runner (dist/scripts/run-migrations.js) rather than `npm run db:migrate`
# (which uses tsx for local dev). init-db/ is copied next to the app (cwd=/app).
echo "[entrypoint] Running database migrations..."
node dist/scripts/run-migrations.js

echo "[entrypoint] Migrations complete. Starting server..."
exec node dist/index.js
