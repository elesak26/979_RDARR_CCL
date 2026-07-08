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
# The runner exits 2 when it detects DRIFT (an already-applied init-db file was
# edited): it safely SKIPS the drifted file and still applies every NEW file.
# Drift is a warning, NOT a reason to abort startup — treat exit 2 as non-fatal
# so the server still boots. Any OTHER non-zero exit (real migration error) is
# fatal and aborts, as before.
set +e
node dist/scripts/run-migrations.js
migrate_rc=$?
set -e
if [ "$migrate_rc" != "0" ] && [ "$migrate_rc" != "2" ]; then
  echo "[entrypoint] Migrations FAILED (exit $migrate_rc) — aborting startup."
  exit "$migrate_rc"
fi
[ "$migrate_rc" = "2" ] && echo "[entrypoint] Migrations reported drift (exit 2) — non-fatal, continuing."

echo "[entrypoint] Migrations complete. Starting server..."
exec node dist/index.js
