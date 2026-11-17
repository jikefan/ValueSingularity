.PHONY: install dev api web test lint format build

install:
	cd apps/api && uv sync
	cd apps/web && pnpm install

dev:
	./scripts/dev.sh

api:
	cd apps/api && uv run uvicorn app.main:app --reload --port 8000

web:
	cd apps/web && pnpm dev

test:
	cd apps/api && uv run pytest
	cd apps/web && pnpm test

lint:
	cd apps/api && uv run ruff check . && uv run mypy app
	cd apps/web && pnpm lint && pnpm typecheck

format:
	cd apps/api && uv run ruff format .
	cd apps/web && pnpm format

build:
	cd apps/web && pnpm build
