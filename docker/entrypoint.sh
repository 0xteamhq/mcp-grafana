#!/bin/sh
set -e

GRAFANA_URL="${GRAFANA_URL:-http://grafana:3000}"
ADMIN_USER="${GRAFANA_ADMIN_USER:-admin}"
ADMIN_PASS="${GRAFANA_ADMIN_PASSWORD:-admin}"
SA_NAME="mcp-server"

echo "[entrypoint] Waiting for Grafana at ${GRAFANA_URL}..."
until curl -sf "${GRAFANA_URL}/api/health" > /dev/null; do
  sleep 2
done
echo "[entrypoint] Grafana is up."

# Create service account (idempotent — fails silently if already exists)
SA_ID=$(curl -sf -X POST "${GRAFANA_URL}/api/serviceaccounts" \
  -u "${ADMIN_USER}:${ADMIN_PASS}" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"${SA_NAME}\",\"role\":\"Editor\"}" \
  | sed 's/.*"id":\([0-9]*\).*/\1/' 2>/dev/null || true)

if [ -z "$SA_ID" ]; then
  # Already exists — look it up
  SA_ID=$(curl -sf "${GRAFANA_URL}/api/serviceaccounts/search?query=${SA_NAME}" \
    -u "${ADMIN_USER}:${ADMIN_PASS}" \
    | sed 's/.*"id":\([0-9]*\).*/\1/')
fi

echo "[entrypoint] Service account ID: ${SA_ID}"

# Create a token for this run
TOKEN=$(curl -sf -X POST "${GRAFANA_URL}/api/serviceaccounts/${SA_ID}/tokens" \
  -u "${ADMIN_USER}:${ADMIN_PASS}" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"mcp-token-$(date +%s)\"}" \
  | sed 's/.*"key":"\([^"]*\)".*/\1/')

if [ -z "$TOKEN" ]; then
  echo "[entrypoint] ERROR: Could not obtain service account token." >&2
  exit 1
fi

echo "[entrypoint] Service account token obtained."

# Build governance flags from environment
EXTRA_FLAGS=""
[ "${MCP_READ_ONLY}" = "true" ]  && EXTRA_FLAGS="$EXTRA_FLAGS --read-only"
[ "${MCP_DRY_RUN}" = "true" ]    && EXTRA_FLAGS="$EXTRA_FLAGS --dry-run"
[ -n "${MCP_AUDIT_LOG}" ]        && EXTRA_FLAGS="$EXTRA_FLAGS --audit-log ${MCP_AUDIT_LOG}"
if [ -n "${MCP_WRITE_RATE_LIMIT}" ] && [ "${MCP_WRITE_RATE_LIMIT}" != "0" ]; then
  EXTRA_FLAGS="$EXTRA_FLAGS --write-rate-limit ${MCP_WRITE_RATE_LIMIT}"
fi

echo "[entrypoint] Starting MCP server (flags:${EXTRA_FLAGS:-none})..."
exec node /app/dist/cli.js \
  --grafana-url "${GRAFANA_URL}" \
  --grafana-token "${TOKEN}" \
  ${EXTRA_FLAGS}
