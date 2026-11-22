# 数据架构

本项目把数据按访问模式拆成两层存储，不使用 SQLite（`user.db` 已废弃）。

## 1. 存储分层：PostgreSQL 17 vs Parquet / DuckDB

| 层 | 存储引擎 | 存放内容 | 选择理由 |
|---|---|---|---|
| 用户状态与预计算读模型 | PostgreSQL 17（`psycopg` 3 async + `AsyncSession`） | 自选、投资日记、事件、配置、个股/市场快照 | 需要事务、外键/检查约束、行级更新和 JSONB 索引；运行时经 `create_async_engine` 池化并在 lifespan 退出时释放 |
| 行情与财报事实表（Phase 1+） | Parquet + DuckDB | 日线行情、三大报表、历史估值分位 | 宽表列式扫描、按代码/年份分区追加，不膨胀 OLTP 备份；异步适配器中通过 `asyncio.to_thread` 执行同步查询 |

本地开发通过仓库根目录 `docker-compose.yml` 启动 `postgres:17-alpine`（端口 `5432`）。生产环境指向托管 PostgreSQL 实例即可，应用代码不绑定容器形态。

## 2. PostgreSQL 六张核心表与不变量

表结构定义在 `apps/api/app/db/models.py`，由 `apps/api/migrations/` 管理演进：

| 表名 | 主键 | 关键字段与约束 | 用途 |
|---|---|---|---|
| `watchlist` | `code` (`varchar(6)`) | `name` NOT NULL, `industry`, `note`, `added_at` (`timestamptz`) | 用户自选股列表 |
| `journal` | `id` (`bigserial`) | `code`, `action`, `reason` NOT NULL, `falsify_condition` NOT NULL, `max_drawdown`, `emotion`, `price`, `snapshot` (`JSONB`), `created_at`; 索引 `ix_journal_code`, `ix_journal_code_created_at` | 投资决策日记；强制填写买入/卖出理由与否证条件 |
| `events` | `id` (`bigserial`) | `type`, `code`, `meta` (`JSONB`), `ts` (`timestamptz`) | 行为与复盘事件流 |
| `settings` | `key` (`varchar(64)`) | `value` (`JSONB`, NOT NULL) | 用户偏好与系统配置 |
| `stock_snapshot` | `code` (`varchar(6)`) | `as_of` (`date`), `payload` (`JSONB`), `updated_at` (`timestamptz`) | 个股页预计算读模型，API 直接读取返回前端 |
| `market_snapshot` | `id` (`smallint`) | `as_of` (`date`), `payload` (`JSONB`), `updated_at` (`timestamptz`), `CHECK (id = 1)` | 全市场单行概览快照；数据库层强制最多一行 |

`JSONType` 在 PostgreSQL 上映射为 `JSONB`，在非 PG 方言回退为 `JSON`。

## 3. Alembic 迁移流程

`apps/api/app/db/base.py` 固定了 `NAMING_CONVENTION`（`ix` / `uq` / `ck` / `fk` / `pk`），保证约束名在不同环境下确定且可回滚。`apps/api/migrations/env.py` 会导入 `app.db.models` 以注册所有表元数据；迁移脚本有意保持同步（`engine_from_config` + `NullPool`），与异步运行时共用同一个 `postgresql+psycopg://` 连接串。

新增或修改表结构时：

1. 修改 `apps/api/app/db/models.py`。
2. 在 `apps/api` 目录生成迁移脚本：
   `uv run alembic revision --autogenerate -m "<说明>"`
3. 检查 `apps/api/migrations/versions/` 下生成的 `upgrade()` / `downgrade()`。
4. 执行迁移：`uv run alembic upgrade head`。

CI 会在每个 PR 上对全新 `postgres:17-alpine` 容器执行 `uv run alembic upgrade head`。

## 4. 连接串与测试隔离

配置读取自 `apps/api/app/settings.py`（前缀 `VS_`）：

- `VS_DATABASE_URL`：运行时与 Alembic 共用的 `psycopg` 3 连接串，默认 `postgresql+psycopg://vs:vs@127.0.0.1:5432/vs`（`psycopg` 3 同时支持异步运行时和同步 Alembic）。
- `VS_TEST_DATABASE_URL`：集成测试专用库（例如 `postgresql+psycopg://vs:vs@127.0.0.1:5432/vs_test`）。

`apps/api/tests/conftest.py` 中的 `db_client` 异步 fixture 会检测 `VS_TEST_DATABASE_URL`：本地未设置时自动跳过数据库集成测试（不影响纯契约和架构单测）；CI 会启动 `postgres:17-alpine` 服务并注入该变量，通过 `create_async_engine` + `AsyncSession` + `httpx.AsyncClient` 跑全量测试。
