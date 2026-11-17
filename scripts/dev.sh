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
  kill "$API_PID" "$WEB_PID" 2>/dev/null || true
  wait "$API_PID" "$WEB_PID" 2>/dev/null || true
}
trap cleanup INT TERM EXIT

wait -n "$API_PID" "$WEB_PID"
