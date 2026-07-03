#!/usr/bin/env bash
# WPConvert API example — convert a zip file to a WordPress theme.
#
# Usage:
#   export WPCONVERT_API_KEY=wpc_live_xxx
#   ./convert.sh ./my-site.zip my-site
#
# Requires: curl, jq (optional, for pretty output)

set -euo pipefail

API_BASE="${WPCONVERT_API_BASE:-https://api.wpconvert.ai}"
API_KEY="${WPCONVERT_API_KEY:?Set WPCONVERT_API_KEY}"

ZIP_FILE="${1:?Usage: $0 <zip-file> [project-name]}"
PROJECT_NAME="${2:-$(basename "$ZIP_FILE" .zip)}"

echo "Uploading $ZIP_FILE as '$PROJECT_NAME' ..."

# Step 1: Start conversion (multipart upload)
RESPONSE=$(curl -sS -X POST "$API_BASE/api/convert" \
  -H "X-API-Key: $API_KEY" \
  -F "file=@$ZIP_FILE" \
  -F "project_name=$PROJECT_NAME" \
  -F "export_type=theme")

JOB_ID=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('jobId',''))" 2>/dev/null || echo "")

if [ -z "$JOB_ID" ]; then
  echo "Error starting conversion:"
  echo "$RESPONSE"
  exit 1
fi

echo "Conversion queued: jobId=$JOB_ID"
echo "Polling status ..."

# Step 2: Poll until done
while true; do
  STATUS_RESPONSE=$(curl -sS "$API_BASE/api/convert/$JOB_ID/status" \
    -H "X-API-Key: $API_KEY")

  STATUS=$(echo "$STATUS_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null || echo "")
  PROGRESS=$(echo "$STATUS_RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('progress',''))" 2>/dev/null || echo "")

  if [ "$STATUS" = "done" ]; then
    echo "Conversion complete."
    break
  elif [ "$STATUS" = "failed" ]; then
    echo "Conversion failed:"
    echo "$STATUS_RESPONSE"
    exit 1
  fi

  echo "  status=$STATUS${PROGRESS:+ progress=$PROGRESS%}"
  sleep 3
done

# Step 3: Get download URL (follow server-returned URL, never hard-code storage paths)
DOWNLOAD_RESPONSE=$(curl -sS "$API_BASE/api/download/$JOB_ID" \
  -H "X-API-Key: $API_KEY")

DOWNLOAD_URL=$(echo "$DOWNLOAD_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('download_url',''))" 2>/dev/null || echo "")
FILE_NAME=$(echo "$DOWNLOAD_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('name','theme.zip'))" 2>/dev/null || echo "theme.zip")

if [ -z "$DOWNLOAD_URL" ]; then
  echo "Error getting download URL:"
  echo "$DOWNLOAD_RESPONSE"
  exit 1
fi

echo "Downloading $FILE_NAME ..."
curl -sS -o "$FILE_NAME" "$DOWNLOAD_URL"
echo "Saved $FILE_NAME"
