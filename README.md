## ValueSingularity Data RPC

### 功能
- 提供基于 FastAPI 的 RPC 接口 `/rpc/stock_company`，调用 TuShare `stock_company` 返回公司基本信息。

### 依赖安装
```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### 安全配置 TuShare Token（三种方式，按优先级）
1. 环境变量：
   ```bash
   export TUSHARE_TOKEN="你的token"
   ```
2. .env 文件（项目根目录创建 `.env`）：
   ```env
   TUSHARE_TOKEN=你的token
   ```
3. macOS 钥匙串（service 名称 `tushare_token`）：
   ```bash
   security add-generic-password -a "$USER" -s tushare_token -w "你的token"
   ```

### 启动服务
```bash
python -m data_rpc.stock_company
# 或使用 uvicorn
uvicorn data_rpc.stock_company:app --host 0.0.0.0 --port 8000
```

### 示例请求
```bash
curl -X POST 'http://127.0.0.1:8000/rpc/stock_company' \
  -H 'Content-Type: application/json' \
  -d '{"ts_code":"000001.SZ"}'
```

### 说明
- 当 `ts_code/name/exchange` 均为空时，TuShare 可能返回全量数据，注意速率与权限限制。
- 返回结构：
  ```json
  { "data": [ {"ts_code": "...", "name": "...", ...} ], "count": 123 }
  ```

