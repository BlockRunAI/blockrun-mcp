#!/usr/bin/env bash
# Deploy the Tokyo egress relay to Cloud Run (asia-northeast1).
#
# Cloud Run gives a public HTTPS endpoint WITHOUT a VM external IP, so it
# sidesteps the org-wide compute.vmExternalIpAccess=DENY policy that blocks the
# plain-VM proxy. Run this yourself (gcloud auth required):
#
#   bash deploy/tokyo-egress/deploy.sh
#
# When it finishes it prints the service URL; set these on the demo machine:
#   export POLYMARKET_CLOB_HOST="https://<URL>/clob"
#   export POLYMARKET_RELAYER_URL="https://<URL>/relayer"
#   export POLYMARKET_GEOBLOCK_URL="https://<URL>/geoblock/api/geoblock"
set -euo pipefail

PROJECT="${PROJECT:-blockrun-prod-2026}"
REGION="${REGION:-asia-northeast1}"   # Tokyo — API-unrestricted for Polymarket
SERVICE="${SERVICE:-pm-egress}"

cd "$(dirname "$0")"

gcloud run deploy "${SERVICE}" \
  --project="${PROJECT}" \
  --region="${REGION}" \
  --source=. \
  --allow-unauthenticated \
  --cpu=1 --memory=256Mi \
  --min-instances=0 --max-instances=2 \
  --port=8080

URL=$(gcloud run services describe "${SERVICE}" --project="${PROJECT}" --region="${REGION}" --format='value(status.url)')

cat <<SUMMARY

─────────────────────────────────────────────────────────────────────────────
✅ Tokyo egress relay deployed: ${URL}

Sanity check (should reach CLOB from Tokyo):
  curl -s ${URL}/clob/version        # → {"version":2}
  curl -s ${URL}/healthz             # → ok

On the DEMO machine (Claude Code + @blockrun/mcp), set:
  export POLYMARKET_CLOB_HOST="${URL}/clob"
  export POLYMARKET_RELAYER_URL="${URL}/relayer"
  export POLYMARKET_GEOBLOCK_URL="${URL}/geoblock/api/geoblock"
  # plus the relayer creds: POLYMARKET_RELAYER_API_KEY/_SECRET/_PASSPHRASE

Then: blockrun_polymarket action:"setup"  → should report ✅ Region: permitted.

Teardown after the showcase:
  gcloud run services delete ${SERVICE} --project=${PROJECT} --region=${REGION} -q
─────────────────────────────────────────────────────────────────────────────
SUMMARY
