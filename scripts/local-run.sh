#!/usr/bin/env bash
# Runs the full action flow from a terminal against a real pull request, without
# GitHub Actions. Posts a real sticky comment on the target PR.
#
# Usage:
#   CLOVER_CLIENT_ID=... CLOVER_SECRET_KEY=... scripts/local-run.sh <pull-request-url>
#
# Optional environment:
#   CLOVER_BASE_URL       (default https://api-dev.cloversec.io)
#   CLOVER_AUTH_BASE_URL  (default https://auth-dev.cloversec.io)
#   GITHUB_TOKEN          (default: gh auth token)
set -euo pipefail

PR_URL="${1:?usage: CLOVER_CLIENT_ID=... CLOVER_SECRET_KEY=... scripts/local-run.sh <pull-request-url>}"

: "${CLOVER_CLIENT_ID:?set CLOVER_CLIENT_ID}"
: "${CLOVER_SECRET_KEY:?set CLOVER_SECRET_KEY}"

BASE_URL="${CLOVER_BASE_URL:-https://api-dev.cloversec.io}"
AUTH_BASE_URL="${CLOVER_AUTH_BASE_URL:-https://auth-dev.cloversec.io}"
GITHUB_TOKEN="${GITHUB_TOKEN:-$(gh auth token)}"

if [[ "$PR_URL" =~ ^https://github\.com/([^/]+/[^/]+)/pull/([0-9]+)$ ]]; then
  REPOSITORY="${BASH_REMATCH[1]}"
  PR_NUMBER="${BASH_REMATCH[2]}"
else
  echo "Unrecognized pull request URL: $PR_URL" >&2
  exit 1
fi

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

printf '{"pull_request": {"number": %s, "html_url": "%s"}}' "$PR_NUMBER" "$PR_URL" > "$WORK_DIR/event.json"
touch "$WORK_DIR/output.txt"

# Input env var names contain dashes (as the Actions runner sets them), so they
# must be passed via env(1) — the shell cannot export them directly.
env \
  "INPUT_CLIENT-ID=$CLOVER_CLIENT_ID" \
  "INPUT_SECRET-KEY=$CLOVER_SECRET_KEY" \
  "INPUT_BASE-URL=$BASE_URL" \
  "INPUT_AUTH-BASE-URL=$AUTH_BASE_URL" \
  "INPUT_GITHUB-TOKEN=$GITHUB_TOKEN" \
  GITHUB_REPOSITORY="$REPOSITORY" \
  GITHUB_EVENT_PATH="$WORK_DIR/event.json" \
  GITHUB_OUTPUT="$WORK_DIR/output.txt" \
  node "$(dirname "$0")/../src/main.js"

echo
echo "Outputs:"
cat "$WORK_DIR/output.txt"
