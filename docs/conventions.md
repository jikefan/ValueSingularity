# 代码约定

> 目的：让一年后的自己和 AI agent 都能在不问人的情况下写出同一种代码。
> 能被工具强制的，就写进 lint 或单测；不能强制的，写在这里。

## 0. 提交前必跑

```bash
make check        # = 后端 ruff+mypy+OpenAPI校验+pytest + 前端 check:api+eslint+tsc+vitest
```

红的不提交。CI 会再跑一遍同样的命令，并额外对 `postgres:17-alpine` 跑 `alembic upgrade head`。

## 1. 目录与命名

**后端（`apps/api`）**

| 对象 | 规则 | 例子 |
|---|---|---|
| 模块/文件 | snake_case | `watchlist.py` |
| 类 | PascalCase | `WatchlistService`、`PostgresWatchlistRepository` |
| 函数/变量 | snake_case | `get_watchlist_service` |
| 私有 | 前缀下划线 | `_repository` |
| Pydantic 模型 | 名词、单数 | `MarketOverview`、`WatchlistItem` |
| 路由函数 | 动词或资源名 | `market_overview`、`health_db` |

**前端（`apps/web`）**

| 对象 | 规则 | 例子 |
|---|---|---|
| 组件文件 | PascalCase.tsx，文件名 = 组件名 | `ScoreRing.tsx` |
| hook | `useXxx.ts` | `useMarketOverview.ts` |
| 工具/常量 | camelCase.ts | `format.ts`、`chartTheme.ts`、`queryKeys.ts` |
| 测试 | 与被测文件同目录，`.test.ts(x)` | `MarketPage.test.tsx` |
| CSS 类 | kebab-case | `.metric-value`、`.retry-btn` |

**一律 named export，不用 default export**：重命名可追踪，打包器能摇树，IDE 自动导入不会起别名。

## 2. 分层红线

```
api/routes -> services -> domain <- adapters
```

- `api/routes/` 只做 HTTP：全异步路由（`async def`），解析参数、捕获领域/服务异常映射 HTTP 状态码、注入 `deps.py`。禁止直接导入 `adapters/`、`db/` 或 `sqlalchemy`。
- `services/` 只编排：全异步方法（`async def`），不导入具体 adapter、`db/`、`api/`、`sqlalchemy`、`fastapi` 或 `akshare`，只依赖 `domain/ports.py` 的全异步 `Protocol`。
- `domain/` 不导入任何三方库（Pydantic 除外），不知道 PostgreSQL / DuckDB / akshare 的存在。
- `adapters/` 实现端口，不导入 `services/` 或 `api/`。PostgreSQL 适配器使用 `AsyncSession` 与全异步公共方法；同步三方库（`akshare`、`duckdb`）必须在适配器内通过 `asyncio.to_thread` 卸载，不阻塞事件循环。
- 除 `migrations/env.py`（有意保持同步迁移，共用 `postgresql+psycopg://` DSN）外，禁止在 `db/session.py`、`api/`、`adapters/` 和 `tests/` 中导入同步 `create_engine`、`sessionmaker` 或 `sqlalchemy.orm.Session`。

以上分层与全异步守卫由 `apps/api/tests/test_architecture.py` 在每次 `pytest` 时强制校验。

前端对应的红线（由 `apps/web/eslint.config.js` 强制校验）：

- 禁止在 `src/lib/api.ts`（和测试文件）之外直接调用 `fetch`。
- `components/` 不得导入 `features/`、`lib/api` 或 `@tanstack/react-query`，只通过 props 接收数据与回调。
- `lib/` 不得导入 `features/`。
- `features/*` 之间不互相 import；共享组件下沉到 `components/ui/`，共享查询与工具下沉到 `lib/`。

## 3. API 契约

- `apps/api/app/domain/models.py` 与路由签名是唯一真源；修改后端模型或路由后，运行 `make gen-api` 同步生成 `apps/web/openapi.json` 和 `apps/web/src/types/openapi.gen.ts`。
- `apps/web/src/types/api.ts` 只导出从 `components['schemas']` 派生的类型别名，禁止手写 `interface`（ESLint 已强制）。
- 字段名 snake_case；时间一律 ISO 8601 UTC；金额在字段描述里写明单位。
- 百分比用**数值**表示百分数：`-1.2` 就是 -1.2%，前端统一用 `fmtPct` 格式化。

## 4. 错误与三态

- 后端服务层抛语义化业务异常（如 `WatchlistNotFoundError`），路由层或 `deps.py` 捕获后转为 `HTTPException(status_code=..., detail="人话")`，不返回裸 500。
- 前端所有请求走 `lib/api.ts`（`openapi-fetch`），错误统一为 `ApiError`；服务端请求状态与 QueryKey 统一收口到 `@tanstack/react-query` 与 `lib/queryKeys.ts`。
- **每个页面/卡片必须处理三态**：loading（`LoadingBlock`）、error（`ErrorBlock`，传入 `onRetry`）、empty（`EmptyBlock`）。不许出现白屏。

## 5. 样式

- 颜色、圆角、间距只能用 `styles/tokens.css` 的变量。组件里写死色值会被 ESLint 拦下（唯一豁免：`lib/chartTheme.ts`，因为 canvas 读不到 CSS 变量）。
- 组件样式用类名 + CSS 文件，不写内联样式（动态尺寸/位置除外）。
- 不引入 Tailwind / CSS-in-JS：现有 token 体系已经够用，重造一遍只会分裂视觉。

## 6. TypeScript 规则（ESLint 已强制）

| 规则 | 为什么 |
|---|---|
| `strict` + `noUncheckedIndexedAccess` | 索引访问天然可能 undefined，逼你处理 |
| 禁 `any` | 一处 any 会顺着调用链传染 |
| 禁非空断言 `!` | 断言失败是运行时崩溃，改成显式分支 |
| `no-floating-promises` | 没 await 的 Promise 会吞掉异常 |
| `consistent-type-imports` | 类型导入不产生运行时依赖，产物更小 |
| `switch-exhaustiveness-check` | 枚举新增分支时编译期就报错 |
| 命名约定（naming-convention） | 类型 PascalCase、变量 camelCase，统一认知 |
| `no-console`（warn） | 调试输出不进生产；要留日志走正式方案 |

## 7. 测试

- 后端：使用 `pytest-asyncio`（`asyncio_mode = "auto"`）与 `httpx.AsyncClient`（`ASGITransport`，禁止 `TestClient`）；每个路由至少一个契约测试（字段 + 状态码 + 排序/边界）；数据库集成测试用真实 PostgreSQL + `AsyncSession`；架构与全异步守卫用 `test_architecture.py`；**单测不联网**。
- 前端：纯函数必测；页面组件测正常渲染与错误重试分支（`MarketPage.test.tsx`），不测样式快照。
- 覆盖率不是 KPI。问自己一句：这个测试失败时，能不能定位到原因？

## 8. Git

**提交信息**用 Conventional Commits：

```
feat(api): 接入 akshare 指数行情适配器
fix(web): 修复市场页空数据白屏
refactor(api): 把缓存逻辑收进 adapter
docs: 补充契约变更说明
```

**分支**：`main` 永远可跑；功能 `feat/<slug>`，修复 `fix/<slug>`，重构 `refactor/<slug>`。

**PR**：一个 PR 只做一件事；描述写「为什么」和「怎么验证」，不写「改了哪些文件」。

## 9. 明确不做

- 不引 CDN（字体、图表、任何资源都本地化）。
- 不在组件里直接 `fetch`（统一走 `lib/api.ts` + `@tanstack/react-query`）。
- 不手写 `src/types/api.ts` 的 `interface` 或手改 `openapi.json` / `openapi.gen.ts`（走 `make gen-api`）。
- 不在 `domain/` 或 `services/` 里碰 akshare、PostgreSQL、DuckDB 或文件系统。
- 不在事件循环里直接跑阻塞同步库（`akshare`/`duckdb` 需走 `asyncio.to_thread`），不回退同步 `create_engine`/`Session`/`TestClient`。
- 不使用 SQLite / `user.db` 或重新引入 `app/repositories/`。
- 不在 `features/` 之间横向 import。
- 不为了「以后可能用到」加抽象层。
