#!/usr/bin/env bash
set -euo pipefail

if [[ ! -f .env.local ]]; then
  cp .env.local.example .env.local
fi

SUPABASE_URL="$(grep -E '^SUPABASE_URL=' .env.local | head -n1 | cut -d= -f2-)"
SUPABASE_URL="${SUPABASE_URL:-http://127.0.0.1:55321}"

PAIRING_CODE="${1:-}"
if [[ -z "$PAIRING_CODE" ]]; then
  read -r -p "Pairing code: " PAIRING_CODE
fi
AGENT_NAME="$(hostname)"

RESP="$(curl -sS "$SUPABASE_URL/functions/v1/pair-device" \
  -H 'content-type: application/json' \
  -d "{\"code\":\"$PAIRING_CODE\",\"agent_name\":\"$AGENT_NAME\",\"device_os\":\"linux\"}")"

TOKEN="$(printf '%s' "$RESP" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s||'{}');if(!j.agent_token){process.stderr.write('Pairing failed\\n');process.exit(1)};process.stdout.write(j.agent_token);});")"

grep -v '^CONNECTOR_AGENT_TOKEN=' .env.local > .env.local.tmp || true
printf 'CONNECTOR_AGENT_TOKEN=%s\n' "$TOKEN" >> .env.local.tmp
mv .env.local.tmp .env.local

echo "Connector token saved to .env.local"
npm --workspace @agenthub/connector run dev
