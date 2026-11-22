# 价值奇点 ValueSingularity

像做生意一样做投资 —— A 股价值挖掘分析平台。

> 状态：**v0.1 商业化基线**。
> 架构与数据分工见 [docs/architecture.md](docs/architecture.md)、[docs/data-architecture.md](docs/data-architecture.md)、[docs/roadmap.md](docs/roadmap.md)；AI agent 守则见 [AGENTS.md](AGENTS.md)。

## 结构

```
apps/
  api/    全异步 FastAPI 后端（psycopg 3 + AsyncSession；分层：api/routes -> services -> domain <- adapters）
  web/    Vite + React + TypeScript 前端（TanStack Query + openapi-fetch）
docs/     架构决策、数据架构、约定与路线图
scripts/  本地开发脚本
```

## 快速开始

前置：`uv`（Python 3.12+）、`pnpm`（Node 22+）、Docker（或本地 PostgreSQL 17）。

```bash
make install                           # 安装两端依赖
docker compose up -d                   # 启动本地 PostgreSQL 17（127.0.0.1:5432）
cd apps/api && uv run alembic upgrade head
make dev                               # 同时起 API :8000 与 Web :5173
```

单独运行：

```bash
make api         # http://127.0.0.1:8000/docs
make web         # http://127.0.0.1:5173
```

## 校验与契约同步

```bash
make gen-api     # 导出 apps/web/openapi.json 并生成 src/types/openapi.gen.ts
make test        # pytest + vitest
make lint        # ruff + mypy + OpenAPI 漂移检查 + eslint + tsc
make check       # lint + test
make build       # 前端产物
```

## 核心约定

详细红线见 [AGENTS.md](AGENTS.md) 与 [docs/conventions.md](docs/conventions.md)：

- 后端依赖严格向内（`api/routes -> services -> domain <- adapters`），`domain/` 与 `services/` 不碰数据库或 akshare，全链路采用 `psycopg` 3 async + `AsyncSession`（同步库 `akshare` / `duckdb` 在适配器内走 `asyncio.to_thread`，`migrations/env.py` 保持同步迁移并共用 `postgresql+psycopg://` DSN，测试使用 `httpx.AsyncClient`），由 `tests/test_architecture.py` 强制校验。
- 数据按职责拆库：用户数据与读模型快照存 PostgreSQL 17，历史行情与财报事实表存 Parquet/DuckDB（不用 SQLite）。
- 契约以 `apps/api/app/domain/models.py` 为唯一真源，通过 `make gen-api` 同步到前端，禁止在 `src/types/api.ts` 手写 `interface`。
- 前端不引 CDN，所有 HTTP 请求走 `src/lib/api.ts` 与 `@tanstack/react-query`。
