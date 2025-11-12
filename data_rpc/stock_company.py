import os
from typing import Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel


class StockCompanyParams(BaseModel):
    ts_code: Optional[str] = None  # e.g. "000001.SZ"; None 返回全量（注意速率限制）
    name: Optional[str] = None
    exchange: Optional[str] = None  # SSE/ SZSE/ BSE


app = FastAPI(title="ValueSingularity Data RPC", version="0.1.0")


def _load_tushare_token() -> str:
    """安全加载 TuShare Token，优先级：环境变量 -> .env -> macOS 钥匙串。

    环境变量名：TUSHARE_TOKEN
    钥匙串项名：tushare_token
    """
    # 1) 环境变量
    token = os.getenv("TUSHARE_TOKEN")
    if token:
        return token

    # 2) .env 文件
    try:
        from dotenv import load_dotenv

        load_dotenv()
        token = os.getenv("TUSHARE_TOKEN")
        if token:
            return token
    except Exception:
        pass

    # 3) macOS 钥匙串（仅在 darwin 下尝试）
    if os.uname().sysname.lower() == "darwin":
        try:
            import subprocess

            result = subprocess.run(
                [
                    "security",
                    "find-generic-password",
                    "-s",
                    "tushare_token",
                    "-w",
                ],
                capture_output=True,
                text=True,
                check=False,
            )
            candidate = (result.stdout or "").strip()
            if candidate:
                return candidate
        except Exception:
            pass

    raise RuntimeError(
        "未找到 TuShare Token，请在环境变量 TUSHARE_TOKEN、.env，或 macOS 钥匙串(service=tushare_token)中配置"
    )


def _get_tushare_pro():
    import tushare as ts

    token = _load_tushare_token()
    ts.set_token(token)
    return ts.pro_api(token)


@app.post("/rpc/stock_company")
def get_stock_company(params: StockCompanyParams):
    """获取 TuShare 公司基础信息。

    - 参数同 TuShare `stock_company`，此处支持 ts_code/name/exchange 简化筛选
    - 返回 JSON 数组
    """
    try:
        pro = _get_tushare_pro()
        df = pro.stock_company(
            ts_code=params.ts_code,
            name=params.name,
            exchange=params.exchange,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"tushare 调用失败: {exc}")

    # DataFrame -> list[dict]
    try:
        records = df.to_dict(orient="records") if df is not None else []
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"结果转换失败: {exc}")

    return {"data": records, "count": len(records)}


# 可选：本地开发启动
if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8000")))
