# 架构

> 状态：v0.1 商业化基线。本文记录**为什么这么搭**，改动前先改这里。

## 1. 形态

单体架构：一个 FastAPI 进程 + 一个 React SPA。用户数据与预计算读模型落 PostgreSQL 17，历史行情与财报事实表（Phase 1+）存本地 Parquet 并由 DuckDB 查询，外部行情来自 akshare。存储细节见 [docs/data-architecture.md](data-architecture.md)。

早期 demo 文档曾设想 7 个微服务 + K3s/Istio/ArgoCD，那是单机研究工具不需要的运维复杂度，本仓库明确不采用。

| 决策 | 选择 | 理由 |
|---|---|---|
| 部署形态 | 单体 | 一个 FastAPI 进程托管 API（可选托管前端静态产物），避免拆服务后的联调成本 |
| 运行时并发模型 | 全链路异步 | `psycopg` 3 async + SQLAlchemy `AsyncSession` 贯穿路由、服务、端口与 PostgreSQL 适配器；同步库（`akshare`、`duckdb`）在适配器内通过 `asyncio.to_thread` 卸载 |
| 用户与快照存储 | PostgreSQL 17 + Alembic | 事务、约束（如单行快照与日记必填检查）和 JSONB 读模型可靠，替代早期 SQLite 草案；`migrations/env.py` 保留同步迁移并复用 `postgresql+psycopg://` DSN |
| 事实分析存储 | Parquet + DuckDB | 列式分析大宽表不污染 OLTP 库和备份 |
| 数据源 | 适配器隔离 | 公共行情源会限流或改版，换源不碰业务逻辑 |

## 2. 后端分层

```
api/        HTTP：全异步路由、状态码、依赖注入（薄）
services/   编排：全异步用例方法（无 SQL、无 HTTP、无第三方数据源 I/O）
domain/     模型与端口：Pydantic 契约 + 全异步 Protocol
adapters/   实现：PostgreSQL（AsyncSession）、DuckDB / akshare（asyncio.to_thread）、内存 fixture
db/         SQLAlchemy AsyncEngine、AsyncSession 与 ORM 表模型（仅由 adapters/postgres 与 api/deps 导入）
```

依赖方向严格单向：`api -> services -> domain <- adapters`。由 `apps/api/tests/test_architecture.py` 在每次 `pytest` 中用 AST 静态强制执行：

1. `domain/` 不知道 SQLAlchemy、FastAPI、akshare 的存在。
2. `services/` 只依赖 `domain/ports.py` 的 `Protocol`，不碰 `adapters/`、`db/` 或 `api/`。
3. `api/routes/` 通过 `api/deps.py` 注入 service 和数据库健康检查，不直接导入 `adapters/`、`db/` 或 `sqlalchemy`。
4. `adapters/` 实现端口协议，不反向依赖 `services/` 或 `api/`。
5. 路由处理器、端口方法、服务方法与 PostgreSQL 适配器公共方法一律为 `async def`；运行时、适配器与测试代码禁止回退同步 `create_engine`、`sessionmaker`、`Session` 或 `TestClient`。

## 3. 前端

Vite + React 19 + TypeScript，**没有** UI 组件库，靠 `styles/tokens.css` 的 CSS 变量 + `components/ui` 里的小组件。服务端状态与请求由 `@tanstack/react-query` + `openapi-fetch` 管理。

| 决策 | 选择 | 理由 |
|---|---|---|
| 框架 | React | 9 个分析 Tab + 表单 + 状态较多；手写 `innerHTML` 的维护成本已经证明不可持续 |
| 请求与缓存 | `openapi-fetch` + `@tanstack/react-query` | 路径、入参、出参与错误载荷编译期受 OpenAPI 约束；缓存、取消和重试由 QueryClient 统一托管 |
| 构建 | Vite | HMR 快，零配置；`tsc --noEmit` 单独做类型门禁 |
| 样式 | CSS 变量 + 手写类 | 视觉与暗色金融终端设计系统一致，不引入 Tailwind |
| 图表 | ECharts 按需注册 | 只 `use` 用到的图表与组件，控制产物体积 |
| 外部资源 | 零 CDN | 字体走系统栈，图表走 npm，离线可用 |

页面结构：`features/<域>/<Page>.tsx`（及本域 `useXxx.ts` hooks），请求与共享工具在 `lib/`（`api` / `queryClient` / `queryKeys` / `format` / `charts`），纯展示组件在 `components/ui/`。依赖边界由 `apps/web/eslint.config.js` 强制执行。

## 4. 契约

`apps/api/app/domain/models.py` 与 FastAPI 路由是唯一真源，通过一条自动生成链同步到前端：

```
domain/models.py + routes
  -> python -m app.openapi_export apps/web/openapi.json
  -> openapi-typescript -> apps/web/src/types/openapi.gen.ts
  -> apps/web/src/types/api.ts（纯类型别名导出，禁止手写 interface）
  -> apps/web/src/lib/api.ts（openapi-fetch 客户端）
```

改动后端模型或路由后，在仓库根目录运行 `make gen-api`。CI 通过 `app.openapi_export --check`、`test_openapi_schema_is_in_sync` 和 `pnpm check:api` 验证两端完全一致。

## 5. 测试与门禁

| 层 | 工具 | 覆盖范围 |
|---|---|---|
| 后端架构与契约 | pytest-asyncio + AST + `httpx.AsyncClient` | 分层隔离、全异步守卫、lifespan 连接池释放、OpenAPI 同步、health、market overview |
| 后端数据库集成 | Alembic + pytest-asyncio (`postgres:17-alpine`) | `alembic upgrade head`、`/api/health/db`、watchlist CRUD（`AsyncSession`） |
| 后端静态 | ruff + mypy (strict) | 全量 |
| 前端契约同步 | `pnpm check:api` | 验证 `openapi.gen.ts` 与 `openapi.json` 一致 |
| 前端逻辑与交互 | vitest + Testing Library | `format.ts`、`MarketPage` 正常渲染与 503 重试恢复 |
| 前端静态 | eslint + `tsc --noEmit` | 全量 + 分层/禁裸 `fetch`/禁手写 `interface` 规则 |
| 端到端 | 待补 | Phase 1 起加 Playwright 冒烟 |

## 6. 已决与未决问题

- **已决 · 用户体系**：Phase 1 直接引入 `users`、`refresh_tokens` 与全业务表 `user_id` 多租户隔离，面向云端商业 SaaS 演进；全市场快照与 Parquet/DuckDB 事实库保持平台共享。
- **未决 · 数据刷新频率**：每日盘后批处理统一刷新为主，是否需要盘中高频增量刷新（决定商用数据源套餐等级与批处理调度频次）。
- **未决 · AI 计费与接入**：Phase 4 采用平台托管大模型配额包、用户 BYOK 自备 Key，还是两者并行。
