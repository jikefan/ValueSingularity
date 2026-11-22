# 路线图

按"能验证"的顺序排：每一阶段都有可跑通的验收标准，不堆功能。产品商业化定位与七项核心增值能力背景见 [product-discussion.md](product-discussion.md)。

## Phase 0 · 骨架与商业化基线（已完成）

- [x] monorepo：`apps/api` + `apps/web` + `docs` + `scripts`
- [x] 后端分层与架构守卫（`api/routes -> services -> domain <- adapters` + `tests/test_architecture.py`）
- [x] PostgreSQL 17 + Alembic 基线：`watchlist` / `journal` / `events` / `settings` / `stock_snapshot` / `market_snapshot` 六张表 + `PostgresWatchlistRepository` + `/api/health/db`
- [x] 契约自动生成链：`app.openapi_export` -> `openapi.json` -> `openapi-typescript` -> `openapi-fetch` + `@tanstack/react-query`
- [x] 市场垂直切片：`GET /api/market/overview` → 首页渲染（评分环 + 指数 + 资金流图/表 + 503 重试恢复）
- [x] 工程化与 CI：Ruff + Mypy + Alembic + Pytest (`postgres:17-alpine`) + ESLint + `tsc --noEmit` + Vitest + OpenAPI 漂移检查

**验收**：`make check` 与 CI 全绿；`alembic upgrade head` 在全新 PostgreSQL 17 库可重复执行。

## Phase 1 · 多租户底座、数据层与自选愿望单（已完成）

- [x] 多用户与鉴权体系：新增 `users` / `refresh_tokens` 表，为 `watchlist` / `journal` / `events` / `settings` 引入 `user_id` 强隔离，后端提供 JWT + HttpOnly Cookie 刷新与 `CurrentUserDep`
- [x] `adapters/akshare`（及商用授权源/备用源）：指数、PE 历史、国债、行业资金流，同步库通过 `asyncio.to_thread` 隔离
- [x] Parquet + DuckDB 事实库：全市场元数据、日线行情与十年财报宽表分区落盘查询（平台共享，不进 PostgreSQL）
- [x] 盘后批处理与韧性：本地缓存、TTL、超时、重试、多源降级，以及 `market_snapshot` / `stock_snapshot` 预计算更新
- [x] 自选升级「击球区估值愿望单」：打通 `watchlist` 前后端 CRUD（按 `user_id` 隔离），支持设置目标估值分位或安全边际价位门槛，落 `events` / `journal` 基础接口
- [x] 浏览器端到端验证：注册登录、市场页与自选愿望单交互无报错、数据非空

**验收**：不同用户自选与日记严格隔离（防越权单测通过）；断网或上游限流时能返回快照并标注 `as_of` 时间；单测不联网。

## Phase 2 · 排雷、逆向估值与横向矩阵引擎（已完成）

- [x] 财务三表与 A 股本土财务排雷 CT 机：规则化扫描存贷双高、在建工程不转固、现金流背离、应收周转异常、商誉占比、大股东质押与审计机构变更，红黄灯可下钻到具体年份科目数值
- [x] 股东净回报体检器：近 5 到 10 年「分红 + 注销回购 - 股权再融资」净回报与自由现金流覆盖倍数，识破伪高股息
- [x] 估值引擎：PE/PB 分位、格雷厄姆、PEG 与**逆向估值反推器（Reverse DCF）**（由现价反推隐含未来十年现金流增速，不输出主观目标价）
- [x] 同行业多标的横向对比矩阵（DuckDB + 预计算快照支撑 3 到 5 只标的同屏比 ROE、现金流、净负债、股东净回报与十年分位）
- [x] 个股 9 Tab（含护城河六维、看空逻辑、五维评分）逐个接上，先用 fixture 快照测试锁住输出，每个引擎一页公式与边界说明

**验收**：任选 3 只股票，9 个 Tab 与同行业对比矩阵均能出数且排雷红灯可追溯原始年份数据；引擎公式有快照测试。

## Phase 3 · 决策闭环与哨兵提醒（已完成）

- [x] 投资日记（必填理由 + 结构化 `falsify_condition` + 最大回撤 + `emotion`，落 PG `journal` 表）与「看过没买（Pass）」观察记录
- [x] 时间胶囊与决策质量资产负债表：记录时快照关键指标（`journal.snapshot` JSONB），自动挂钩同期沪深 300 剥离大盘 Beta，按 `emotion` 交叉统计长期胜率、平均涨跌与能力圈
- [x] 击球区价格哨兵与否证条件自动雷达：盘后快照更新后，命中自选买入门槛或持仓否证红线时触发规则通知（站内事件 + 微信/飞书推送）

**验收**：记一条买入或放弃日记 → 三个月后能看到「当时 vs 现在 vs 沪深 300」的对照与情绪胜率统计；命中预设估值或否证阈值可触发提醒。

## Phase 4 · 克制的 AI 决策伙伴（已完成）

- [x] 规则引擎兜底先行：零成本、零幻觉的规则版关注雷达与排雷清单保持主路径可用
- [x] 买入前「魔鬼代言人」安检门：提交买入日记前，AI 基于确定性排雷数字与历史逻辑挑出 3 条潜在漏洞，经确认风险或补全否证条件后入库
- [x] 年报/半年报口径变化对比器（MD&A Diff）：对比连续两期管理层讨论与分析、风险提示与会计政策措辞增删并高亮输出
- [x] 商业化额度与评估集：上下文裁剪 + 成本闸门（按用户每日额度或 BYOK）+ 强制引用已算好的数字；固定 20 个质询场景人工打分回归

## 非目标

云原生微服务、广场晒单社区、自动实盘券商下单、日内高频量化回测、港美股与替代数据。先把 A 股「低频深研 + 排雷估值 + 决策复盘」闭环做到商业级可用再说。
