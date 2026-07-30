#!/bin/sh
set -e

# BACKEND_URL  = the Core webapp (used by /auth/* and as the /api fallback).
# API_UPSTREAM = where /api/ is sent. In Azure this is the compliance PROXY; when
#                unset (local compose) it falls back to the Core directly.
BACKEND_URL="${BACKEND_URL:-http://server:3001}"
API_UPSTREAM="${API_UPSTREAM:-$BACKEND_URL}"
export BACKEND_URL API_UPSTREAM

envsubst '${BACKEND_URL} ${API_UPSTREAM}' < /etc/nginx/conf.d/default.conf > /tmp/default.conf
cat /tmp/default.conf > /etc/nginx/conf.d/default.conf

echo "[entrypoint] Nginx /api/ -> $API_UPSTREAM   /auth/ -> $BACKEND_URL"

exec nginx -g 'daemon off;'
