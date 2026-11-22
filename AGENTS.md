# ValueSingularity Agent Guide

Monorepo layout: `apps/api` (full-async FastAPI, SQLAlchemy `AsyncSession` + `psycopg` 3, Alembic, PostgreSQL 17, Parquet/DuckDB) and `apps/web` (Vite, React 19, TypeScript, TanStack Query, `openapi-fetch`).

## Non-Negotiable Rules

1. **Backend dependency direction (`api -> services -> domain <- adapters`)**
   - `domain/` imports only stdlib and `pydantic`.
   - `services/` imports only `domain/` (never `adapters/`, `db/`, `api/`, `sqlalchemy`, `fastapi`, or `akshare`).
   - `api/routes/` imports `api/deps.py`, `domain/models.py`, and service exceptions (never `adapters/`, `db/`, or `sqlalchemy`).
   - `adapters/` implements `domain/ports.py` and never imports `services/` or `api/`.
   - **Enforced by**: AST layer checks in `apps/api/tests/test_architecture.py`.

2. **Schema-first API contract**
   - `apps/api/app/domain/models.py` and FastAPI route signatures are the single source of truth.
   - Never hand-edit `apps/web/openapi.json` or `apps/web/src/types/openapi.gen.ts`.
   - Never declare `interface` in `apps/web/src/types/api.ts`; export only type aliases derived from `components['schemas']`.
   - Run `make gen-api` after changing any backend endpoint or schema.
   - **Enforced by**: `app.openapi_export --check`, `test_openapi_schema_is_in_sync`, `pnpm check:api`, and ESLint `TSInterfaceDeclaration` rule on `src/types/api.ts`.

3. **Frontend layer and request boundaries**
   - All HTTP calls go through `apps/web/src/lib/api.ts` (`openapi-fetch`). Never call `fetch` in components, hooks, or other modules.
   - `src/components/` cannot import `features/`, `lib/api`, or `@tanstack/react-query`.
   - `src/lib/` cannot import `features/`.
   - **Enforced by**: `no-restricted-globals` and `no-restricted-imports` in `apps/web/eslint.config.js`.

4. **Storage split and Alembic migrations**
   - User state and precomputed UI snapshots live in PostgreSQL 17 via Alembic (`apps/api/migrations/versions/`).
   - Market facts (daily bars, financial statements) belong in local Parquet files queried by DuckDB, never PG tables.
   - Never reintroduce SQLite (`user.db`) or `apps/api/app/repositories/`.
   - **Enforced by**: `test_legacy_repositories_directory_removed` and CI running `alembic upgrade head` against `postgres:17-alpine`.

5. **Offline UI and design tokens**
   - Never add external CDN URLs for fonts, charts, or scripts.
   - Never hardcode hex color literals in UI code; use CSS variables from `apps/web/src/styles/tokens.css` (`apps/web/src/lib/chartTheme.ts` is the sole canvas exception).
   - **Enforced by**: ESLint hex-literal `no-restricted-syntax` rule.

6. **Full-async backend (`psycopg` 3 + `AsyncSession`)**
   - All FastAPI route handlers (`api/routes/`), domain port methods (`domain/ports.py`), service methods (`services/`), and PostgreSQL adapter public methods (`adapters/postgres/`) are `async def` end-to-end using `psycopg` 3 async (`postgresql+psycopg://...`) and SQLAlchemy `AsyncSession`.
   - Sync-only libraries (`akshare`, `duckdb`) must be wrapped with `asyncio.to_thread` inside their adapters so they never block the event loop.
   - `apps/api/migrations/env.py` stays synchronous (`engine_from_config` + `NullPool`) and shares the same `postgresql+psycopg://` DSN.
   - Backend tests run under `pytest-asyncio` (`asyncio_mode = "auto"`) using `httpx.AsyncClient` + `ASGITransport` (never `TestClient`, sync `create_engine`, `sessionmaker`, or `sqlalchemy.orm.Session`).
   - **Enforced by**: `test_all_routes_are_async`, `test_ports_and_services_are_async`, `test_postgres_adapters_are_async`, and `test_no_sync_db_or_testclient_regressions` in `apps/api/tests/test_architecture.py`.

## Commands

| Command | Purpose |
|---|---|
| `make install` | Install Python (`uv sync`) and Node (`pnpm install`) deps |
| `docker compose up -d` | Start local PostgreSQL 17 on `127.0.0.1:5432` |
| `cd apps/api && uv run alembic upgrade head` | Apply PostgreSQL schema migrations |
| `make gen-api` | Export `apps/web/openapi.json` and regenerate `src/types/openapi.gen.ts` |
| `make lint` | Run Ruff, Mypy, OpenAPI drift checks, ESLint, and `tsc --noEmit` |
| `make test` | Run `pytest` and `vitest run` |
| `make check` | Run `make lint` and `make test` |
| `make format` | Format Python (`ruff format`) and TypeScript (`prettier`, excluding generated files) |
| `make dev` | Run FastAPI (`:8000`) and Vite (`:5173`) concurrently |
| `make build` | Typecheck and build `apps/web/dist` |

## Documentation

- [docs/architecture.md](docs/architecture.md): System shape, backend/frontend layering, and API contract pipeline.
- [docs/data-architecture.md](docs/data-architecture.md): PostgreSQL 17 vs Parquet/DuckDB split, 6 PG tables, and Alembic workflow.
- [docs/conventions.md](docs/conventions.md): Naming, error/loading/empty states, testing, and Git rules.
- [docs/roadmap.md](docs/roadmap.md): Phased milestones and acceptance criteria.
