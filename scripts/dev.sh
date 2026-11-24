#!/usr/bin/env bash
# Run API and Web together; Ctrl-C stops both.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

(cd apps/api && uv run uvicorn app.main:app --reload --port 8000) &
API_PID=$!
(cd apps/web && pnpm dev) &
WEB_PID=$!

cleanup() {
  trap - INT TERM EXIT
  kill "$API_PID" "$WEB_PID" 2>/dev/null || true
  wait "$API_PID" "$WEB_PID" 2>/dev/null || true
}
trap cleanup INT TERM EXIT

# macOS ships Bash 3.2 without `wait -n`; poll child liveness portably.
while kill -0 "$API_PID" 2>/dev/null && kill -0 "$WEB_PID" 2>/dev/null; do
  sleep 1
done

EXIT_CODE=0
if ! kill -0 "$API_PID" 2>/dev/null; then
  wait "$API_PID" || EXIT_CODE=$?
elif ! kill -0 "$WEB_PID" 2>/dev/null; then
  wait "$WEB_PID" || EXIT_CODE=$?
fi
exit "$EXIT_CODE"
