#!/bin/sh
set -e

# Substitute BACKEND_URL into the nginx config so /api/ proxies to the backend.
# Default to the docker-compose service name when not provided (Azure sets the
# real Core webapp URL via the BACKEND_URL env var).
BACKEND_URL="${BACKEND_URL:-http://server:3001}"
export BACKEND_URL

envsubst '${BACKEND_URL}' < /etc/nginx/conf.d/default.conf > /tmp/default.conf
cat /tmp/default.conf > /etc/nginx/conf.d/default.conf

echo "[entrypoint] Nginx /api/ -> $BACKEND_URL"

exec nginx -g 'daemon off;'
