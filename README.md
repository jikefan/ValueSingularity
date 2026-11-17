# 价值奇点 ValueSingularity

像做生意一样做投资 —— A 股价值挖掘分析平台。

> 状态：**v0.1 骨架**。本仓库是正式项目的干净起点，用于替换早期的 demo 实现。
> 产品规划见 [docs/architecture.md](docs/architecture.md) 与 [docs/roadmap.md](docs/roadmap.md)。

## 结构

```
apps/
  api/    FastAPI 后端（分层：domain / services / adapters / api）
  web/    Vite + React + TypeScript 前端
docs/     架构决策与路线图
scripts/  本地开发脚本
```

## 快速开始

前置：`uv`（Python 3.12+）、`pnpm`（Node 20+）。

```bash
make install     # 安装两端依赖
make dev         # 同时起 API :8000 与 Web :5173
```

单独运行：

```bash
make api         # http://127.0.0.1:8000/docs
make web         # http://127.0.0.1:5173
```

## 约定

命名、分层红线、契约、错误三态、提交信息等规则见 [docs/conventions.md](docs/conventions.md)。

## 校验

```bash
make test        # pytest + vitest
make lint        # ruff + mypy + eslint + tsc
make build       # 前端产物
```

## 约定

- 后端不直接依赖 akshare：数据源与算法都在 `adapters/` 后面，`domain/` 只放模型与端口。
- 前端不引 CDN：图表、字体、样式全部走本地依赖。
- 契约以 Pydantic 模型为准，前端 `src/types/api.ts` 与之一一对应。
