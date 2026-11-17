# 代码约定

> 目的：让一年后的自己和 AI agent 都能在不问人的情况下写出同一种代码。
> 能被工具强制的，就写进 lint；不能强制的，写在这里。

## 0. 提交前必跑

```bash
make check        # = 后端 lint+mypy+pytest + 前端 lint+tsc+vitest
```

红的不提交。CI 会再跑一遍同样的命令。

## 1. 目录与命名

**后端（`apps/api`）**

| 对象 | 规则 | 例子 |
|---|---|---|
| 模块/文件 | snake_case | `market_service.py` |
| 类 | PascalCase | `MarketService` |
| 函数/变量 | snake_case | `get_market_overview` |
| 私有 | 前缀下划线 | `_repository` |
| Pydantic 模型 | 名词、单数 | `MarketOverview`、`IndexQuote` |
| 路由函数 | 动词或资源名 | `market_overview`、`health` |

**前端（`apps/web`）**

| 对象 | 规则 | 例子 |
|---|---|---|
| 组件文件 | PascalCase.tsx，文件名 = 组件名 | `ScoreRing.tsx` |
| hook | `useXxx.ts` | `useMarketOverview.ts` |
| 工具/常量 | camelCase.ts | `format.ts`、`chartTheme.ts` |
| 测试 | 与被测文件同目录，`.test.ts(x)` | `format.test.ts` |
| CSS 类 | kebab-case | `.metric-value` |

**一律 named export，不用 default export**：重命名可追踪，打包器能摇树，IDE 自动导入不会起别名。

## 2. 分层红线

```
api → services → domain ← adapters
```

- `api/` 只做 HTTP：解析、状态码、依赖注入。不写业务分支。
- `services/` 只编排：不 import 具体 adapter，只依赖 `domain/ports.py` 的 Protocol。
- `domain/` 不 import 任何三方库（Pydantic 除外），不知道 akshare / SQLite 的存在。
- `adapters/` 实现端口，不 import services。

前端对应的红线：

- `features/*` 之间**不互相 import**。要共享就下沉到 `components/ui` 或 `lib/`。
- 页面组件负责取数（或调用本 feature 的 hook），展示组件只接 props。
- `lib/` 不 import `features/`。

## 3. API 契约

- `apps/api/app/domain/models.py` 是唯一真源；`apps/web/src/types/api.ts` 手工镜像。
- 字段名 snake_case；时间一律 ISO 8601 UTC；金额在字段描述里写明单位。
- 百分比用**数值**表示百分数：`-1.2` 就是 -1.2%，前端统一用 `fmtPct` 格式化。
- 改契约必须同时改：模型、前端类型、契约测试。三者不同步视为 bug。

## 4. 错误与三态

- 后端错误抛 `HTTPException(status_code=..., detail="人话")`，不返回裸 500。
- 前端所有请求走 `lib/api.ts`，错误统一为 `ApiError`。
- **每个页面/卡片必须处理三态**：loading（`LoadingBlock`）、error（`ErrorBlock`，带可重试提示）、empty（`EmptyBlock`）。不许出现白屏。

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

- 后端：每个路由至少一个契约测试（字段 + 状态码 + 排序/边界）；服务层用假仓库，**测试不联网**。
- 前端：纯函数必测；组件只测交互与分支，不测样式快照。
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
- 不在组件里直接 `fetch`（走 `lib/api.ts`）。
- 不在 `domain/` 里碰 akshare / SQLite / 文件系统。
- 不在 `features/` 之间横向 import。
- 不为了「以后可能用到」加抽象层。
