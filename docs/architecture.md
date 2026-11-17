# 架构

> 状态：v0.1（骨架）。本文记录**为什么这么搭**，改动前先改这里。

## 1. 形态

本地优先的单体应用：一个 FastAPI 进程 + 一个 React SPA，数据落本地 SQLite，行情来自 akshare。

早期文档（`ValueSingularity` demo 仓库的 `docs/cloud-native-architecture/`）设计过 7 个微服务 + K3s/Istio/ArgoCD。那是**单人本地工具不需要的复杂度**，且从未落地（仓库里没有任何部署清单）。本架构明确否决它。

| 决策 | 选择 | 理由 |
|---|---|---|
| 部署形态 | 单体 | 一个用户、一台机器；拆服务只会换来联调和运维成本 |
| 数据存储 | SQLite | 单机读写、易备份；用户数据不出本机 |
| 数据源 | 适配器隔离 | 公共行情源会限流/改版，换源不能碰业务逻辑 |

## 2. 后端分层

```
api/        HTTP：路由、状态码、依赖注入（薄）
services/   编排：一个用例一个方法（无 I/O）
domain/     模型与端口：Pydantic 契约 + Protocol
adapters/   实现：akshare、SQLite、内存 fixture
```

依赖方向只能向内：`api → services → domain`，`adapters` 实现 `domain/ports.py` 的协议。这样做换来三件事：

1. **换数据源不改业务**：`MarketRepository` 现在由 `MemoryMarketRepository` 实现，接入 akshare 时只加一个 adapter。
2. **测试不联网**：service 单测用假仓库，路由测试用 `TestClient`。
3. **契约稳定**：`domain/models.py` 就是 API 文档（`/docs` 自动生成）。

## 3. 前端

Vite + React 19 + TypeScript，**没有** UI 组件库，靠 `styles/tokens.css` 的 CSS 变量 + `components/ui` 里的小组件。

| 决策 | 选择 | 理由 |
|---|---|---|
| 框架 | React | 9 个分析 Tab + 表单 + 状态较多；手写 `innerHTML` 的维护成本已经证明不可持续 |
| 构建 | Vite | HMR 快，零配置；`tsc --noEmit` 单独做类型门禁 |
| 样式 | CSS 变量 + 手写类 | 视觉要与已有的暗色设计系统一致，Tailwind 会重造一遍 token |
| 图表 | ECharts 按需注册 | 只 `use` 用到的图表与组件，产物从 1.38MB 降到 756KB |
| 外部资源 | 零 CDN | 字体走系统栈，图表走 npm，离线可用 |

页面结构：`features/<域>/<Page>.tsx`，共享能力在 `lib/`（api / format / charts），纯展示组件在 `components/ui/`。

## 4. 契约

`apps/api/app/domain/models.py` 是唯一真源；`apps/web/src/types/api.ts` 手工镜像它。改一个字段要同时改两处，并在 PR 里说明——这是当前刻意的成本，等接口稳定后再上 codegen（`openapi-typescript`）。

## 5. 测试

| 层 | 工具 | 现在覆盖 |
|---|---|---|
| 后端契约 | pytest + TestClient | health、market overview 字段与排序 |
| 后端静态 | ruff + mypy(strict) | 全量 |
| 前端逻辑 | vitest | 格式化函数（符号、亿/万、涨跌类） |
| 前端静态 | eslint + tsc | 全量 |
| 端到端 | 待补 | Phase 1 起加 Playwright 冒烟 |

## 6. 未决问题

- 用户体系：保持单用户本地，还是加账号（决定 user 表结构与鉴权）？
- 数据刷新：请求时拉取 + 缓存，还是后台定时预热（决定是否引入任务队列）？
- AI 层：接 LLM 做决策伙伴（有成本与幻觉问题），还是继续规则引擎？
