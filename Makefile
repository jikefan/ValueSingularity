.PHONY: install dev api web gen-api test lint check format build

install:
	cd apps/api && uv sync
	cd apps/web && pnpm install

dev:
	./scripts/dev.sh

api:
	cd apps/api && uv run uvicorn app.main:app --reload --port 8000

web:
	cd apps/web && pnpm dev

gen-api:
	cd apps/api && uv run python -m app.openapi_export ../../apps/web/openapi.json
	cd apps/web && pnpm generate:api

test:
	cd apps/api && uv run pytest
	cd apps/web && pnpm test

lint:
	cd apps/api && uv run ruff check . && uv run mypy app && uv run python -m app.openapi_export ../../apps/web/openapi.json --check
	cd apps/web && pnpm check:api && pnpm lint && pnpm typecheck

check: lint test

format:
	cd apps/api && uv run ruff format .
	cd apps/web && pnpm format

build:
	cd apps/web && pnpm build
