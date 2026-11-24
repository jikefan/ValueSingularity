"""Resilient akshare 1.20.65 per-stock fact feed adapter (non-Push2 endpoints)."""

from __future__ import annotations

import asyncio
import logging
import math
from bisect import bisect_right
from collections import defaultdict
from collections.abc import Callable, Sequence
from datetime import date, datetime, timedelta
from typing import Any

import akshare as ak
import pandas as pd

from app.adapters.akshare._common import (
    MINI_RACER_LOCK,
    SHANGHAI_TZ,
    STOCK_CODE_RE,
    coerce_cn_amount_yuan,
    coerce_date,
    coerce_float,
    infer_exchange,
    is_missing,
    run_akshare_call,
)
from app.domain.errors import StockFactUnavailableError
from app.domain.market_math import subtract_years
from app.domain.models import (
    StockAnnualReport,
    StockDailyBar,
    StockDividendRecord,
    StockEquityFinancingRecord,
    StockFactBundle,
    StockPledgeSnapshot,
    StockRepurchaseRecord,
)

logger = logging.getLogger("vs.akshare.stock")

_VALID_DIVIDEND_PROGRESS = frozenset({"实施分配", "股东大会通过"})
_VALID_REPURCHASE_PROGRESS = frozenset({"完成实施", "实施中"})
_PLEDGE_LOOKBACK_WEEKS = 5
_VALUATION_MAX_LAG_DAYS = 10

_SW1_CANONICAL_SET = frozenset(
    {
        "农林牧渔",
        "基础化工",
        "钢铁",
        "有色金属",
        "电子",
        "汽车",
        "家用电器",
        "食品饮料",
        "纺织服饰",
        "轻工制造",
        "医药生物",
        "公用事业",
        "交通运输",
        "房地产",
        "商贸零售",
        "社会服务",
        "银行",
        "非银金融",
        "综合",
        "建筑材料",
        "建筑装饰",
        "电力设备",
        "机械设备",
        "国防军工",
        "计算机",
        "传媒",
        "通信",
        "煤炭",
        "石油石化",
        "环保",
        "美容护理",
    }
)
_IT_SECTOR_GUARD: tuple[str, ...] = (
    "软件",
    "信息技术",
    "计算机",
    "IT",
    "大数据",
    "云计算",
    "网络安全",
    "人工智能",
    "金融科技",
    "金融信息",
    "互联网金融",
)
_COMPUTER_TRIGGERS: tuple[str, ...] = (
    "软件",
    "信息技术",
    "计算机应用",
    "计算机整机",
    "垂直应用软件",
    "横向通用软件",
    "IT服务",
    "金融IT",
    "证券IT",
    "银行IT",
    "金融信息",
    "互联网金融",
    "大数据",
    "云计算",
    "网络安全",
    "人工智能",
    "服务器",
)
_BANK_TRIGGERS: tuple[str, ...] = (
    "货币金融服务",
    "银行业",
    "商业银行",
    "农商银行",
    "农商行",
    "吸收公众存款",
    "银行产品",
    "银行",
)
_NONBANK_FIN_TRIGGERS: tuple[str, ...] = (
    "保险",
    "人寿",
    "财险",
    "再保险",
    "资本市场",
    "证券",
    "信托",
    "期货",
    "多元金融",
    "其他金融业",
)
_CSRC_BROAD_SECTORS: dict[str, str] = {
    "计算机、通信和其他电子设备制造业": "电子",
}
_SECTOR_KEYWORD_RULES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("计算机", _COMPUTER_TRIGGERS),
    (
        "电子",
        (
            "半导体",
            "集成电路",
            "芯片",
            "晶圆",
            "印制电路板",
            "PCB",
            "光学光电子",
            "面板",
            "显示器件",
            "消费电子",
            "电子元件",
            "电子制造",
        ),
    ),
    (
        "食品饮料",
        (
            "茅台酒",
            "系列酒",
            "白酒",
            "啤酒",
            "葡萄酒",
            "黄酒",
            "酿酒",
            "酒业",
            "酒、饮料",
            "乳制品",
            "调味品",
            "食品饮料",
            "食品、饮料",
            "饮料制造",
            "制茶",
        ),
    ),
    ("汽车", ("整车", "乘用车", "商用车", "汽车业务", "汽车制造", "汽车销售")),
    (
        "电力设备",
        (
            "动力电池",
            "锂电池",
            "储能",
            "光伏",
            "风电",
            "逆变器",
            "电气设备",
            "电气机械",
            "输变电",
            "电网设备",
            "电力设备",
        ),
    ),
    ("汽车", ("新能源汽车", "汽车零部件", "汽车")),
    (
        "医药生物",
        ("医药", "制药", "中药", "生物制品", "医疗器械", "医疗服务", "创新药", "化学药"),
    ),
    ("家用电器", ("家用电器", "空调", "冰箱", "洗衣机", "厨电", "小家电")),
    ("通信", ("通信设备", "电信", "5G", "光模块", "光通信")),
    ("煤炭", ("煤炭",)),
    ("石油石化", ("石油", "石化", "炼化", "油气")),
    ("公用事业", ("电力、热力", "火力发电", "水力发电", "核电", "水务", "燃气")),
    ("房地产", ("房地产", "物业开发")),
    ("交通运输", ("航空运输", "航运", "港口", "铁路运输", "公路运输", "快递", "仓储物流")),
    ("有色金属", ("有色金属", "黄金", "铜", "铝", "稀土", "锂矿")),
    ("钢铁", ("钢铁", "特钢")),
    ("基础化工", ("基础化工", "化学原料", "化学制品", "化肥", "农药", "聚氨酯")),
    ("机械设备", ("工程机械", "通用设备", "专用设备", "工业机器人", "数控机床")),
    ("国防军工", ("国防军工", "航空航天", "军工", "兵器", "船舶制造")),
    ("建筑材料", ("建筑材料", "水泥", "玻璃")),
    ("建筑装饰", ("建筑装饰", "工程施工", "建筑工程")),
    ("农林牧渔", ("农林牧渔", "生猪养殖", "畜牧", "饲料", "种植业")),
    ("传媒", ("传媒", "出版", "影视", "游戏", "广告营销")),
    ("商贸零售", ("商贸零售", "百货", "超市", "专业连锁")),
    ("社会服务", ("社会服务", "酒店", "旅游", "餐饮", "教育")),
    ("美容护理", ("美容护理", "化妆品", "护肤")),
    ("环保", ("环保", "污水处理", "固废")),
    ("轻工制造", ("轻工制造", "造纸", "包装印刷", "家居")),
    ("纺织服饰", ("纺织服饰", "服装", "纺织")),
)
_LEGACY_INDUSTRY_STANDARDS: dict[str, int] = {
    "申银万国行业分类标准(旧)": 0,
    "中证行业分类标准(旧)": 1,
    "巨潮行业分类标准": 2,
    "巨潮行业分类标准(旧)": 3,
    "中国上市公司协会上市公司行业分类标准": 4,
    "证监会行业分类标准（2012）": 5,
}


def _lookup_backward(
    dates: Sequence[date],
    mapping: dict[date, float],
    target: date,
    *,
    max_lag_days: int = _VALUATION_MAX_LAG_DAYS,
) -> float | None:
    if not dates:
        return None
    idx = bisect_right(dates, target) - 1
    if idx < 0:
        return None
    matched_date = dates[idx]
    if (target - matched_date).days > max_lag_days:
        return None
    return mapping[matched_date]


def _first_float(row: dict[str, Any], *keys: str) -> float | None:
    for key in keys:
        if key in row:
            val = coerce_float(row.get(key))
            if val is not None:
                return val
    return None


def _sum_available(row: dict[str, Any], *keys: str) -> float | None:
    total = 0.0
    found = False
    for key in keys:
        if key in row:
            val = coerce_float(row.get(key))
            if val is not None:
                total += val
                found = True
    return total if found and math.isfinite(total) else None


def _compute_nonbusiness_net(ps: dict[str, Any]) -> float | None:
    inc = _first_float(ps, "NONBUSINESS_INCOME")
    exp = _first_float(ps, "NONBUSINESS_EXPENSE")
    if inc is None and exp is None:
        return None
    return (inc or 0.0) - (exp or 0.0)


def _compute_impairment_net(ps: dict[str, Any], report_year: int) -> float | None:
    asset_inc = _first_float(ps, "ASSET_IMPAIRMENT_INCOME")
    credit_inc = _first_float(ps, "CREDIT_IMPAIRMENT_INCOME")
    if asset_inc is not None or credit_inc is not None:
        total = (asset_inc or 0.0) + (credit_inc or 0.0)
        if not math.isfinite(total):
            return None
        return 0.0 if total == 0 else total

    asset_loss = _first_float(ps, "ASSET_IMPAIRMENT_LOSS")
    credit_loss = _first_float(ps, "CREDIT_IMPAIRMENT_LOSS")
    if asset_loss is None and credit_loss is None:
        return None

    # Pre-2018 bank reports often emit restated CREDIT_IMPAIRMENT_LOSS alongside ASSET.
    if (
        report_year < 2018
        and asset_loss is not None
        and credit_loss is not None
        and abs(asset_loss - credit_loss) <= 0.1 * max(abs(asset_loss), abs(credit_loss), 1.0)
    ):
        loss_sum = asset_loss
    else:
        loss_sum = (asset_loss or 0.0) + (credit_loss or 0.0)
    if not math.isfinite(loss_sum):
        return None
    net = -loss_sum
    return 0.0 if net == 0 else net


def _first_str(row: dict[str, Any], *keys: str) -> str | None:
    for key in keys:
        if key in row:
            raw = row.get(key)
            if not is_missing(raw):
                text = str(raw).strip()
                if text:
                    return text
    return None


def _earliest_trigger_pos(text: str, triggers: tuple[str, ...]) -> int | None:
    positions = [pos for kw in triggers if (pos := text.find(kw)) >= 0]
    return min(positions) if positions else None


def normalize_canonical_sector(
    text: str | None,
    *,
    name_hint: str | None = None,
) -> str | None:
    """Map CNInfo / CSI / CSRC / THS industry descriptions onto canonical SW1 sector names."""
    cleaned = text.strip() if text else ""
    if not cleaned or cleaned in _CSRC_BROAD_SECTORS:
        return None
    if cleaned in _SW1_CANONICAL_SET:
        return cleaned

    upper = cleaned.upper()
    has_it_guard = any(kw in upper for kw in _IT_SECTOR_GUARD)

    if not has_it_guard:
        bank_pos = _earliest_trigger_pos(cleaned, _BANK_TRIGGERS)
        nonbank_pos = _earliest_trigger_pos(cleaned, _NONBANK_FIN_TRIGGERS)
        if bank_pos is not None and (nonbank_pos is None or bank_pos <= nonbank_pos):
            return "银行"
        if nonbank_pos is not None:
            return "非银金融"

    for sector, triggers in _SECTOR_KEYWORD_RULES:
        if any(kw in upper for kw in triggers):
            return sector

    if not has_it_guard and cleaned in {"金融", "金融业", "金融服务", "金融地产"}:
        if name_hint and any(kw in name_hint for kw in ("银行", "农商行")):
            return "银行"
        return "非银金融"
    return None


def _normalize_csi_row(
    row: dict[str, Any], *, name_hint: str | None = None
) -> tuple[str | None, str | None]:
    cat1 = _first_str(row, "行业门类")
    cat2 = _first_str(row, "行业次类")
    cat3 = _first_str(row, "行业大类")
    cat4 = _first_str(row, "行业中类")
    joined = " ".join(part for part in (cat1, cat2, cat3, cat4) if part)
    upper = joined.upper()
    has_it_guard = any(kw in upper for kw in _IT_SECTOR_GUARD)

    if not has_it_guard:
        if any(part and "银行" in part for part in (cat2, cat3, cat4)):
            bank_sub = cat3 or cat2 or "银行"
            return "银行", bank_sub[:64]
        if any(kw in joined for kw in ("保险", "资本市场", "证券", "信托", "多元金融", "金融")):
            non_bank_sub = cat2 or cat3 or cat1
            return "非银金融", non_bank_sub[:64] if non_bank_sub else None

    for part in (cat4, cat3, cat2, cat1):
        sector = normalize_canonical_sector(part, name_hint=name_hint)
        if sector is not None:
            fallback_sub = cat3 or cat2
            return sector, fallback_sub[:64] if fallback_sub else None
    return None, None


def parse_cninfo_industry_change(
    df: pd.DataFrame,
    *,
    name_hint: str | None = None,
) -> tuple[str | None, str | None]:
    """Extract latest SW1/SW2 or normalized CSI sector from stock_industry_change_cninfo."""
    if df.empty or "分类标准" not in df.columns:
        return None, None

    sw_rows: list[tuple[date, int, dict[str, Any]]] = []
    csi_rows: list[tuple[date, int, dict[str, Any]]] = []
    legacy_rows: list[tuple[int, date, int, dict[str, Any]]] = []

    for idx, raw in enumerate(df.to_dict(orient="records")):
        row = {str(k): v for k, v in raw.items()}
        std = _first_str(row, "分类标准")
        if not std:
            continue
        vary_date = coerce_date(row.get("变更日期")) or date.min
        if std == "申银万国行业分类标准":
            if _first_str(row, "行业门类"):
                sw_rows.append((vary_date, idx, row))
        elif std == "中证行业分类标准":
            csi_rows.append((vary_date, idx, row))
        elif std in _LEGACY_INDUSTRY_STANDARDS:
            legacy_rows.append((-_LEGACY_INDUSTRY_STANDARDS[std], vary_date, idx, row))

    if sw_rows:
        _, _, latest_sw = max(sw_rows, key=lambda item: (item[0], item[1]))
        sw1 = _first_str(latest_sw, "行业门类")
        sw2 = _first_str(latest_sw, "行业次类")
        return (sw1[:64] if sw1 else None), (sw2[:64] if sw2 else None)

    if csi_rows:
        _, _, latest_csi = max(csi_rows, key=lambda item: (item[0], item[1]))
        resolved_name = name_hint or _first_str(latest_csi, "新证券简称", "机构名称")
        sw1, sw2 = _normalize_csi_row(latest_csi, name_hint=resolved_name)
        if sw1 is not None:
            return sw1, sw2

    if legacy_rows:
        legacy_rows.sort(key=lambda item: (item[0], item[1], item[2]), reverse=True)
        for _, _, _, row in legacy_rows:
            resolved_name = name_hint or _first_str(row, "新证券简称", "机构名称")
            for key in ("行业中类", "行业大类", "行业次类", "行业门类"):
                sector = normalize_canonical_sector(_first_str(row, key), name_hint=resolved_name)
                if sector is not None:
                    sub = _first_str(row, "行业次类")
                    std_name = _first_str(row, "分类标准")
                    kept_sub = sub[:64] if sub and std_name == "申银万国行业分类标准(旧)" else None
                    return sector, kept_sub

    return None, None


def parse_cninfo_ipo_list_date(df: pd.DataFrame) -> date | None:
    """Extract listing date from stock_ipo_summary_cninfo."""
    if df.empty or "上市日期" not in df.columns:
        return None
    for row in df.to_dict(orient="records"):
        parsed = coerce_date(row.get("上市日期"))
        if parsed is not None:
            return parsed
    return None


def parse_cninfo_profile(
    df: pd.DataFrame,
    *,
    name_hint: str | None = None,
) -> tuple[str | None, str | None, date | None]:
    """Extract sector, optional sub-sector, and listing date from stock_profile_cninfo."""
    if df.empty:
        return None, None, None

    raw = df.to_dict(orient="records")[0]
    row = {str(k): v for k, v in raw.items()}
    list_date = coerce_date(row.get("上市日期"))
    resolved_name = name_hint or _first_str(row, "A股简称", "公司名称")

    raw_ind = _first_str(row, "所属行业")
    main_biz = _first_str(row, "主营业务")
    biz_scope = _first_str(row, "经营范围")

    sw1 = normalize_canonical_sector(raw_ind, name_hint=resolved_name)
    if sw1 is None and main_biz:
        sw1 = normalize_canonical_sector(main_biz, name_hint=resolved_name)
    if sw1 is None and raw_ind in _CSRC_BROAD_SECTORS:
        sw1 = _CSRC_BROAD_SECTORS[raw_ind]
    if sw1 is None and biz_scope:
        sw1 = normalize_canonical_sector(biz_scope, name_hint=resolved_name)

    sw2: str | None = None
    if sw1 == "非银金融" and raw_ind:
        if "保险" in raw_ind:
            sw2 = "保险"
        elif "资本市场" in raw_ind or "证券" in raw_ind:
            sw2 = "证券"
        elif "多元金融" in raw_ind or "其他金融" in raw_ind:
            sw2 = "多元金融"
    elif sw1 == "银行" and raw_ind:
        sw2 = "银行"

    return sw1, sw2, list_date


def parse_ths_zyjs_sector(
    df: pd.DataFrame,
    *,
    name_hint: str | None = None,
) -> str | None:
    """Infer canonical SW1 sector from stock_zyjs_ths main business description."""
    if df.empty:
        return None
    raw = df.to_dict(orient="records")[0]
    row = {str(k): v for k, v in raw.items()}
    for key in ("所属行业", "主营业务", "产品类型", "产品名称", "经营范围"):
        text = _first_str(row, key)
        if not text:
            continue
        sector = normalize_canonical_sector(text, name_hint=name_hint)
        if sector is not None:
            return sector
    return None


def parse_baidu_valuation(
    df: pd.DataFrame,
    *,
    scale: float = 1.0,
    positive_only: bool = False,
) -> dict[date, float]:
    if df.empty or not {"date", "value"} <= set(df.columns):
        return {}
    by_date: dict[date, float] = {}
    for row in df.to_dict(orient="records"):
        d = coerce_date(row.get("date"))
        val = coerce_float(row.get("value"))
        if d is None or val is None:
            continue
        if positive_only and val <= 0:
            continue
        by_date[d] = val * scale
    return by_date


def parse_daily_bars(
    bars_df: pd.DataFrame,
    code: str,
    *,
    mv_df: pd.DataFrame | None = None,
    pe_df: pd.DataFrame | None = None,
    pb_df: pd.DataFrame | None = None,
    pcf_df: pd.DataFrame | None = None,
    as_of: date | None = None,
) -> list[StockDailyBar]:
    required_cols = {"date", "open", "high", "low", "close"}
    if bars_df.empty or not required_cols <= set(bars_df.columns):
        raise StockFactUnavailableError(code, "stock_daily_bars", "日线行情为空或缺少必需 OHLC 列")

    mv_map = (
        parse_baidu_valuation(mv_df, scale=1e8, positive_only=True) if mv_df is not None else {}
    )
    pe_map = parse_baidu_valuation(pe_df) if pe_df is not None else {}
    pb_map = parse_baidu_valuation(pb_df) if pb_df is not None else {}
    pcf_map = parse_baidu_valuation(pcf_df) if pcf_df is not None else {}

    mv_dates = sorted(mv_map)
    pe_dates = sorted(pe_map)
    pb_dates = sorted(pb_map)
    pcf_dates = sorted(pcf_map)

    by_date: dict[date, StockDailyBar] = {}
    for row in bars_df.to_dict(orient="records"):
        trade_date = coerce_date(row.get("date"))
        if trade_date is None:
            continue
        if as_of is not None and trade_date > as_of:
            continue

        open_p = coerce_float(row.get("open"))
        high_p = coerce_float(row.get("high"))
        low_p = coerce_float(row.get("low"))
        close_p = coerce_float(row.get("close"))
        if open_p is None or high_p is None or low_p is None or close_p is None or close_p <= 0:
            continue

        outstanding_share = coerce_float(row.get("outstanding_share"))
        total_mv_yuan = _lookup_backward(mv_dates, mv_map, trade_date)
        if total_mv_yuan is None and outstanding_share is not None and outstanding_share > 0:
            total_mv_yuan = close_p * outstanding_share

        by_date[trade_date] = StockDailyBar(
            code=code,
            trade_date=trade_date,
            open=open_p,
            high=high_p,
            low=low_p,
            close=close_p,
            volume=coerce_float(row.get("volume")),
            amount=coerce_float(row.get("amount")),
            outstanding_share=outstanding_share,
            turnover=coerce_float(row.get("turnover")),
            total_mv_yuan=total_mv_yuan,
            pe_ttm=_lookup_backward(pe_dates, pe_map, trade_date),
            pb=_lookup_backward(pb_dates, pb_map, trade_date),
            pcf=_lookup_backward(pcf_dates, pcf_map, trade_date),
        )

    if not by_date:
        raise StockFactUnavailableError(code, "stock_daily_bars", "有效日线行情记录为空")

    return [by_date[d] for d in sorted(by_date)]


def _dedup_annual_sheet(df: pd.DataFrame, *, as_of: date | None) -> dict[int, dict[str, Any]]:
    if df.empty or "REPORT_DATE" not in df.columns:
        return {}
    selected: dict[int, tuple[tuple[date, date, date], dict[str, Any]]] = {}
    for raw in df.to_dict(orient="records"):
        row = {str(k): v for k, v in raw.items()}
        if "REPORT_TYPE" in row and str(row.get("REPORT_TYPE", "")).strip() != "年报":
            continue
        report_date = coerce_date(row.get("REPORT_DATE"))
        if report_date is None:
            continue
        raw_notice_date = coerce_date(row.get("NOTICE_DATE"))
        raw_update_date = coerce_date(row.get("UPDATE_DATE"))
        if as_of is not None:
            if report_date > as_of:
                continue
            if raw_notice_date is not None and raw_notice_date > as_of:
                continue
            if raw_update_date is not None and raw_update_date > as_of:
                continue
        year = report_date.year
        update_date = raw_update_date or date.min
        notice_date = raw_notice_date or date.min
        rank = (update_date, notice_date, report_date)
        existing = selected.get(year)
        if existing is None or rank >= existing[0]:
            selected[year] = (rank, row)
    return {year: pair[1] for year, pair in selected.items()}


def parse_annual_reports(
    code: str,
    *,
    balance_df: pd.DataFrame,
    profit_df: pd.DataFrame,
    cash_flow_df: pd.DataFrame,
    as_of: date | None = None,
    max_years: int = 12,
) -> list[StockAnnualReport]:
    bs_by_year = _dedup_annual_sheet(balance_df, as_of=as_of)
    ps_by_year = _dedup_annual_sheet(profit_df, as_of=as_of)
    cf_by_year = _dedup_annual_sheet(cash_flow_df, as_of=as_of)

    years = sorted(set(bs_by_year) | set(ps_by_year) | set(cf_by_year), reverse=True)[:max_years]
    if not years:
        return []

    reports: list[StockAnnualReport] = []
    for year in sorted(years):
        bs = bs_by_year.get(year, {})
        ps = ps_by_year.get(year, {})
        cf = cf_by_year.get(year, {})

        report_date = (
            coerce_date(bs.get("REPORT_DATE"))
            or coerce_date(ps.get("REPORT_DATE"))
            or coerce_date(cf.get("REPORT_DATE"))
            or date(year, 12, 31)
        )
        notice_date = (
            coerce_date(bs.get("NOTICE_DATE"))
            or coerce_date(ps.get("NOTICE_DATE"))
            or coerce_date(cf.get("NOTICE_DATE"))
        )
        update_date = max(
            [
                d
                for d in (
                    coerce_date(bs.get("UPDATE_DATE")),
                    coerce_date(ps.get("UPDATE_DATE")),
                    coerce_date(cf.get("UPDATE_DATE")),
                )
                if d is not None
            ],
            default=None,
        )
        audit_opinion = (
            _first_str(bs, "OPINION_TYPE")
            or _first_str(ps, "OPINION_TYPE")
            or _first_str(cf, "OPINION_TYPE")
        )

        reports.append(
            StockAnnualReport(
                code=code,
                report_year=year,
                report_date=report_date,
                notice_date=notice_date,
                update_date=update_date,
                audit_opinion=audit_opinion,
                revenue_yuan=_first_float(ps, "OPERATE_INCOME", "TOTAL_OPERATE_INCOME"),
                operate_cost_yuan=_first_float(ps, "OPERATE_COST"),
                net_profit_yuan=_first_float(ps, "PARENT_NETPROFIT", "NETPROFIT"),
                deduct_net_profit_yuan=_first_float(ps, "DEDUCT_PARENT_NETPROFIT"),
                research_expense_yuan=_first_float(ps, "RESEARCH_EXPENSE", "ME_RESEARCH_EXPENSE"),
                interest_expense_yuan=_first_float(ps, "FE_INTEREST_EXPENSE", "INTEREST_EXPENSE"),
                finance_expense_yuan=_first_float(ps, "FINANCE_EXPENSE"),
                total_assets_yuan=_first_float(bs, "TOTAL_ASSETS"),
                total_liabilities_yuan=_first_float(bs, "TOTAL_LIABILITIES"),
                total_equity_yuan=_first_float(bs, "TOTAL_EQUITY"),
                parent_equity_yuan=_first_float(bs, "TOTAL_PARENT_EQUITY"),
                monetary_funds_yuan=_first_float(bs, "MONETARYFUNDS"),
                trade_fin_assets_yuan=_first_float(
                    bs, "TRADE_FINASSET_NOTFVTPL", "TRADE_FINASSET", "FVTPL_FINASSET"
                ),
                short_loan_yuan=_first_float(bs, "SHORT_LOAN"),
                noncurrent_liab_1y_yuan=_first_float(bs, "NONCURRENT_LIAB_1YEAR"),
                long_loan_yuan=_first_float(bs, "LONG_LOAN"),
                bond_payable_yuan=_first_float(bs, "BOND_PAYABLE"),
                short_bond_payable_yuan=_first_float(bs, "SHORT_BOND_PAYABLE"),
                lease_liab_yuan=_first_float(bs, "LEASE_LIAB"),
                cip_yuan=_first_float(bs, "CIP"),
                fixed_asset_yuan=_first_float(bs, "FIXED_ASSET"),
                accounts_receivable_yuan=_first_float(bs, "ACCOUNTS_RECE"),
                note_accounts_rece_yuan=_first_float(bs, "NOTE_ACCOUNTS_RECE"),
                inventory_yuan=_first_float(bs, "INVENTORY"),
                goodwill_yuan=_first_float(bs, "GOODWILL"),
                share_capital_yuan=_first_float(bs, "SHARE_CAPITAL"),
                ocf_yuan=_first_float(cf, "NETCASH_OPERATE"),
                capex_yuan=_first_float(cf, "CONSTRUCT_LONG_ASSET"),
                accept_invest_cash_yuan=_first_float(cf, "ACCEPT_INVEST_CASH"),
                subsidiary_accept_invest_yuan=_first_float(cf, "SUBSIDIARY_ACCEPT_INVEST"),
                cash_dividend_paid_yuan=_first_float(cf, "ASSIGN_DIVIDEND_PORFIT"),
                operate_profit_yuan=_first_float(ps, "OPERATE_PROFIT"),
                sale_expense_yuan=_first_float(ps, "SALE_EXPENSE"),
                manage_expense_yuan=_first_float(ps, "MANAGE_EXPENSE"),
                operate_tax_add_yuan=_first_float(ps, "OPERATE_TAX_ADD"),
                invest_income_yuan=_first_float(ps, "INVEST_INCOME"),
                invest_joint_income_yuan=_first_float(ps, "INVEST_JOINT_INCOME"),
                fair_value_change_yuan=_first_float(ps, "FAIRVALUE_CHANGE_INCOME"),
                other_income_yuan=_first_float(ps, "OTHER_INCOME"),
                asset_disposal_yuan=_first_float(ps, "ASSET_DISPOSAL_INCOME"),
                impairment_net_yuan=_compute_impairment_net(ps, year),
                nonbusiness_net_yuan=_compute_nonbusiness_net(ps),
                long_equity_invest_yuan=_first_float(bs, "LONG_EQUITY_INVEST"),
                invest_property_and_other_fin_yuan=_sum_available(
                    bs,
                    "OTHER_EQUITY_INVEST",
                    "OTHER_NONCURRENT_FINASSET",
                    "INVEST_REALESTATE",
                    "CREDITOR_INVEST",
                    "OTHER_CREDITOR_INVEST",
                    "AVAILABLE_SALE_FINASSET",
                ),
            )
        )

    return reports


def parse_dividends(
    df: pd.DataFrame,
    code: str,
    *,
    as_of: date | None = None,
) -> list[StockDividendRecord]:
    if df.empty or not {"报告期", "现金分红-现金分红比例", "总股本", "方案进度"} <= set(df.columns):
        return []

    by_report_date: dict[date, StockDividendRecord] = {}
    for row in df.to_dict(orient="records"):
        progress = str(row.get("方案进度", "")).strip()
        if progress not in _VALID_DIVIDEND_PROGRESS:
            continue
        report_date = coerce_date(row.get("报告期"))
        if report_date is None:
            continue
        notice_date = coerce_date(row.get("最新公告日期")) or coerce_date(row.get("业绩披露日期"))
        effective_disclosure = notice_date or report_date
        if as_of is not None and (report_date > as_of or effective_disclosure > as_of):
            continue

        cash_per_10 = coerce_float(row.get("现金分红-现金分红比例"))
        total_shares = coerce_float(row.get("总股本"))
        if cash_per_10 is None or total_shares is None or cash_per_10 <= 0 or total_shares <= 0:
            continue

        raw_yield = coerce_float(row.get("现金分红-股息率"))
        yield_pct = (
            round(raw_yield * 100.0, 2) if raw_yield is not None and raw_yield >= 0 else None
        )

        by_report_date[report_date] = StockDividendRecord(
            code=code,
            report_date=report_date,
            report_year=report_date.year,
            ex_dividend_date=coerce_date(row.get("除权除息日")),
            notice_date=notice_date,
            plan_progress=progress,
            cash_per_10_shares=cash_per_10,
            total_shares=total_shares,
            dividend_cash_total_yuan=round((cash_per_10 / 10.0) * total_shares, 2),
            dividend_yield_pct=yield_pct,
        )

    return [by_report_date[d] for d in sorted(by_report_date)]


def parse_repurchases(df: pd.DataFrame) -> dict[str, list[StockRepurchaseRecord]]:
    required_cols = {"股票代码", "实施进度", "已回购金额"}
    if df.empty or not required_cols <= set(df.columns):
        return {}

    grouped: dict[str, dict[tuple[date | None, date], StockRepurchaseRecord]] = defaultdict(dict)
    for row in df.to_dict(orient="records"):
        raw_code = row.get("股票代码")
        if is_missing(raw_code):
            continue
        code = str(raw_code).strip().zfill(6)
        if not STOCK_CODE_RE.fullmatch(code):
            continue

        progress = str(row.get("实施进度", "")).strip()
        if progress not in _VALID_REPURCHASE_PROGRESS:
            continue

        amount = coerce_float(row.get("已回购金额"))
        if amount is None or amount <= 0:
            continue

        start_date = coerce_date(row.get("回购起始时间"))
        event_date = coerce_date(row.get("最新公告日期")) or start_date
        if event_date is None:
            continue

        candidate = StockRepurchaseRecord(
            code=code,
            event_date=event_date,
            year=event_date.year,
            start_date=start_date,
            progress=progress,
            repurchased_amount_yuan=round(amount, 2),
            repurchased_shares=coerce_float(row.get("已回购股份数量")),
        )
        dedup_key = (start_date, event_date)
        existing = grouped[code].get(dedup_key)
        if existing is None or (
            candidate.event_date,
            candidate.repurchased_amount_yuan,
        ) >= (
            existing.event_date,
            existing.repurchased_amount_yuan,
        ):
            grouped[code][dedup_key] = candidate

    return {
        code: sorted(
            records.values(),
            key=lambda item: (item.event_date, item.start_date or date.min),
        )
        for code, records in grouped.items()
    }


def parse_pledge_table(df: pd.DataFrame) -> tuple[date, dict[str, StockPledgeSnapshot]] | None:
    if df.empty or not {"股票代码", "交易日期", "质押比例"} <= set(df.columns):
        return None

    by_code: dict[str, StockPledgeSnapshot] = {}
    latest_date: date | None = None
    for row in df.to_dict(orient="records"):
        raw_code = row.get("股票代码")
        if is_missing(raw_code):
            continue
        code = str(raw_code).strip().zfill(6)
        if not STOCK_CODE_RE.fullmatch(code):
            continue

        trade_date = coerce_date(row.get("交易日期"))
        ratio = coerce_float(row.get("质押比例"))
        if trade_date is None or ratio is None or ratio < 0:
            continue
        if latest_date is None or trade_date > latest_date:
            latest_date = trade_date

        pledge_shares_wan = coerce_float(row.get("质押股数"))
        pledge_mcap_wan = coerce_float(row.get("质押市值"))
        by_code[code] = StockPledgeSnapshot(
            code=code,
            trade_date=trade_date,
            pledge_ratio_pct=round(ratio, 2),
            pledge_shares=pledge_shares_wan * 1e4 if pledge_shares_wan is not None else None,
            pledge_market_cap_yuan=pledge_mcap_wan * 1e4 if pledge_mcap_wan is not None else None,
        )

    if latest_date is None or not by_code:
        return None
    return latest_date, by_code


def parse_add_stock(
    df: pd.DataFrame,
    code: str,
    *,
    as_of: date | None = None,
) -> list[StockEquityFinancingRecord]:
    if df.empty or not {"公告日期", "实际公司募集资金总额"} <= set(df.columns):
        return []

    records: list[StockEquityFinancingRecord] = []
    for row in df.to_dict(orient="records"):
        event_date = coerce_date(row.get("公告日期"))
        if event_date is None:
            continue
        if as_of is not None and event_date > as_of:
            continue
        amount_yuan = coerce_cn_amount_yuan(row.get("实际公司募集资金总额"))
        if amount_yuan is None or amount_yuan <= 0:
            continue
        issue_mode = str(row.get("发行方式", "")).strip() or "增发募集"
        records.append(
            StockEquityFinancingRecord(
                code=code,
                year=event_date.year,
                event_date=event_date,
                source="add_stock",
                financing_type=issue_mode,
                amount_yuan=round(amount_yuan, 2),
            )
        )
    return sorted(records, key=lambda item: item.event_date)


def extract_cf_equity_financings(
    code: str,
    reports: list[StockAnnualReport],
) -> list[StockEquityFinancingRecord]:
    records: list[StockEquityFinancingRecord] = []
    for report in reports:
        inflow = max(
            0.0,
            (report.accept_invest_cash_yuan or 0.0) - (report.subsidiary_accept_invest_yuan or 0.0),
        )
        if inflow > 0:
            records.append(
                StockEquityFinancingRecord(
                    code=code,
                    year=report.report_year,
                    event_date=report.report_date,
                    source="cash_flow",
                    financing_type="现金流量表-吸收投资(母公司口径)",
                    amount_yuan=round(inflow, 2),
                )
            )
    return records


def _safe_fhps_detail_em(code: str) -> pd.DataFrame:
    try:
        return ak.stock_fhps_detail_em(symbol=code)
    except (ValueError, TypeError, KeyError):
        return pd.DataFrame()


def _safe_add_stock_em(code: str) -> pd.DataFrame:
    try:
        return ak.stock_add_stock(symbol=code)
    except Exception as exc:
        msg = str(exc)
        if "BaseException" in msg or "无增发记录" in msg:
            return pd.DataFrame()
        raise


class AkshareStockFactFeed:
    def __init__(
        self,
        *,
        timeout_seconds: float = 20.0,
        max_attempts: int = 3,
        retry_wait_seconds: float = 1.0,
    ) -> None:
        self._timeout_seconds = timeout_seconds
        self._max_attempts = max(1, max_attempts)
        self._retry_wait_seconds = max(0.0, retry_wait_seconds)
        self._pledge_lock = asyncio.Lock()
        self._repurchase_lock = asyncio.Lock()
        self._pledge_cache: dict[date, tuple[date, dict[str, StockPledgeSnapshot]]] = {}
        self._repurchase_cache: tuple[date, dict[str, list[StockRepurchaseRecord]]] | None = None

    async def _run_call[T](self, code: str, source_name: str, fn: Callable[[], T]) -> T:
        try:
            return await run_akshare_call(
                fn,
                timeout_seconds=self._timeout_seconds,
                max_attempts=self._max_attempts,
                retry_wait_seconds=self._retry_wait_seconds,
            )
        except StockFactUnavailableError:
            raise
        except Exception as exc:
            msg = str(exc).strip()
            detail = f"{exc.__class__.__name__}: {msg}" if msg else exc.__class__.__name__
            raise StockFactUnavailableError(code, source_name, detail) from exc

    async def _fetch_bars_and_valuation(
        self,
        code: str,
        *,
        exchange: str,
        as_of: date | None,
    ) -> tuple[list[StockDailyBar], bool]:
        anchor = as_of or datetime.now(SHANGHAI_TZ).date()
        start_str = subtract_years(anchor, 11).strftime("%Y%m%d")
        end_str = anchor.strftime("%Y%m%d")
        sina_symbol = f"{exchange.lower()}{code}"

        used_tx_fallback = False

        def _fetch_sina_hist() -> pd.DataFrame:
            with MINI_RACER_LOCK:
                return ak.stock_zh_a_hist_sina(
                    symbol=sina_symbol,
                    start_date=start_str,
                    end_date=end_str,
                )

        try:
            bars_df = await self._run_call(
                code,
                "stock_zh_a_hist_sina",
                _fetch_sina_hist,
            )
        except Exception as primary_exc:
            logger.warning("Sina 个股日线失败 (%s)，切换至腾讯备用源: %s", code, primary_exc)
            used_tx_fallback = True
            bars_df = await self._run_call(
                code,
                "stock_zh_a_hist_tx",
                lambda: ak.stock_zh_a_hist_tx(
                    symbol=sina_symbol,
                    start_date=start_str,
                    end_date=end_str,
                ),
            )

        async def _safe_baidu_period(indicator: str, period: str) -> pd.DataFrame | None:
            def _fetch() -> pd.DataFrame:
                return ak.stock_zh_valuation_baidu(
                    symbol=code,
                    indicator=indicator,
                    period=period,
                )

            try:
                return await self._run_call(
                    code,
                    f"stock_zh_valuation_baidu:{indicator}:{period}",
                    _fetch,
                )
            except Exception as exc:
                logger.warning(
                    "百度估值指标 %s (%s) 获取失败 (%s): %s",
                    indicator,
                    period,
                    code,
                    exc,
                )
                return None

        async def _safe_baidu(indicator: str) -> pd.DataFrame | None:
            long_df, recent_df = await asyncio.gather(
                _safe_baidu_period(indicator, "近十年"),
                _safe_baidu_period(indicator, "近一年"),
            )
            frames = [df for df in (long_df, recent_df) if df is not None and not df.empty]
            if not frames:
                return None
            if len(frames) == 1:
                return frames[0]
            # Order long before recent so dense 1y rows override sparse 10y rows on shared dates.
            return pd.concat(frames, ignore_index=True)

        mv_df, pe_df, pb_df, pcf_df = await asyncio.gather(
            _safe_baidu("总市值"),
            _safe_baidu("市盈率(TTM)"),
            _safe_baidu("市净率"),
            _safe_baidu("市现率"),
        )
        bars = parse_daily_bars(
            bars_df,
            code,
            mv_df=mv_df,
            pe_df=pe_df,
            pb_df=pb_df,
            pcf_df=pcf_df,
            as_of=as_of,
        )
        return bars, used_tx_fallback

    async def _fetch_statements(
        self,
        code: str,
        *,
        exchange: str,
        as_of: date | None,
    ) -> list[StockAnnualReport]:
        em_symbol = f"{exchange.upper()}{code}"

        async def _safe_sheet(source: str, fn: Callable[[], pd.DataFrame]) -> pd.DataFrame | None:
            try:
                return await self._run_call(code, source, fn)
            except Exception as exc:
                logger.warning("东方财富报表 %s 获取失败 (%s): %s", source, code, exc)
                return None

        bs_df, ps_df, cf_df = await asyncio.gather(
            _safe_sheet(
                "stock_balance_sheet_by_report_em",
                lambda: ak.stock_balance_sheet_by_report_em(symbol=em_symbol),
            ),
            _safe_sheet(
                "stock_profit_sheet_by_report_em",
                lambda: ak.stock_profit_sheet_by_report_em(symbol=em_symbol),
            ),
            _safe_sheet(
                "stock_cash_flow_sheet_by_report_em",
                lambda: ak.stock_cash_flow_sheet_by_report_em(symbol=em_symbol),
            ),
        )
        if bs_df is None and ps_df is None and cf_df is None:
            raise StockFactUnavailableError(
                code, "eastmoney_statements", "三张财务报表全部获取失败"
            )

        return parse_annual_reports(
            code,
            balance_df=bs_df if bs_df is not None else pd.DataFrame(),
            profit_df=ps_df if ps_df is not None else pd.DataFrame(),
            cash_flow_df=cf_df if cf_df is not None else pd.DataFrame(),
            as_of=as_of,
        )

    async def _fetch_dividends(self, code: str, *, as_of: date | None) -> list[StockDividendRecord]:
        try:
            df = await self._run_call(
                code,
                "stock_fhps_detail_em",
                lambda: _safe_fhps_detail_em(code),
            )
            return parse_dividends(df, code, as_of=as_of)
        except Exception as exc:
            logger.warning("分红送配详情获取失败 (%s): %s", code, exc)
            return []

    async def _get_repurchases_for_code(
        self, code: str, *, as_of: date | None
    ) -> list[StockRepurchaseRecord]:
        today = datetime.now(SHANGHAI_TZ).date()
        async with self._repurchase_lock:
            if self._repurchase_cache is None or self._repurchase_cache[0] != today:
                try:
                    df = await self._run_call(
                        code,
                        "stock_repurchase_em",
                        ak.stock_repurchase_em,
                    )
                    self._repurchase_cache = (today, parse_repurchases(df))
                except Exception as exc:
                    logger.warning("全市场回购数据获取失败: %s", exc)
                    return []
            by_code = self._repurchase_cache[1]

        records = by_code.get(code, [])
        if as_of is None:
            return list(records)
        return [item for item in records if item.event_date <= as_of]

    async def _get_pledge_for_code(
        self, code: str, *, anchor_date: date
    ) -> StockPledgeSnapshot | None:
        days_since_friday = (anchor_date.weekday() - 4) % 7
        latest_friday = anchor_date - timedelta(days=days_since_friday)
        async with self._pledge_lock:
            cached = self._pledge_cache.get(latest_friday)
            if cached is None:
                for week_offset in range(_PLEDGE_LOOKBACK_WEEKS):
                    candidate_date = latest_friday - timedelta(weeks=week_offset)
                    date_str = candidate_date.strftime("%Y%m%d")

                    def _fetch_pledge(ds: str = date_str) -> pd.DataFrame:
                        return ak.stock_gpzy_pledge_ratio_em(date=ds)

                    try:
                        df = await self._run_call(
                            code,
                            "stock_gpzy_pledge_ratio_em",
                            _fetch_pledge,
                        )
                        parsed = parse_pledge_table(df)
                        if parsed is not None and parsed[0] <= anchor_date:
                            cached = parsed
                            self._pledge_cache[latest_friday] = parsed
                            break
                    except Exception as exc:
                        logger.debug("质押日期 %s 查询无果: %s", date_str, exc)

        if cached is None:
            return None
        pledge_date, pledge_by_code = cached
        if pledge_date > anchor_date:
            return None
        existing = pledge_by_code.get(code)
        if existing is not None:
            if existing.trade_date > anchor_date:
                return None
            return existing
        # Explicit 0.0% snapshot when the global pledge table succeeded and omitted the stock.
        return StockPledgeSnapshot(
            code=code,
            trade_date=pledge_date,
            pledge_ratio_pct=0.0,
        )

    async def _fetch_add_stock(
        self, code: str, *, as_of: date | None
    ) -> list[StockEquityFinancingRecord]:
        try:
            df = await self._run_call(
                code,
                "stock_add_stock",
                lambda: _safe_add_stock_em(code),
            )
            return parse_add_stock(df, code, as_of=as_of)
        except Exception as exc:
            logger.warning("新浪增发记录获取跳过 (%s): %s", code, exc)
            return []

    async def _safe_profile_df(
        self,
        code: str,
        source_name: str,
        fn: Callable[[], pd.DataFrame],
        *,
        serialized: bool = False,
    ) -> pd.DataFrame | None:
        def _invoke() -> pd.DataFrame:
            if serialized:
                with MINI_RACER_LOCK:
                    return fn()
            return fn()

        try:
            ak_timeout = (min(5.0, self._timeout_seconds), self._timeout_seconds)
            ak.set_timeout(ak_timeout)
            return await asyncio.wait_for(
                asyncio.to_thread(_invoke),
                timeout=self._timeout_seconds,
            )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.debug("个股档案辅助接口 %s 跳过 (%s): %s", source_name, code, exc)
            return None

    async def _fetch_stock_profile_meta(
        self,
        code: str,
        name: str | None = None,
        *,
        as_of: date | None = None,
    ) -> tuple[str | None, str | None, date | None]:
        end_str = (as_of or datetime.now(SHANGHAI_TZ).date()).strftime("%Y%m%d")

        def _call_ind_change() -> pd.DataFrame:
            try:
                return ak.stock_industry_change_cninfo(
                    symbol=code, start_date="19900101", end_date=end_str
                )
            except TypeError:
                return ak.stock_industry_change_cninfo(symbol=code)

        ind_df = await self._safe_profile_df(
            code,
            "stock_industry_change_cninfo",
            _call_ind_change,
            serialized=True,
        )
        ipo_df = await self._safe_profile_df(
            code,
            "stock_ipo_summary_cninfo",
            lambda: ak.stock_ipo_summary_cninfo(symbol=code),
            serialized=True,
        )

        name_hint = name
        if name_hint is None and ind_df is not None and not ind_df.empty:
            for row in ind_df.to_dict(orient="records"):
                row_str = {str(k): v for k, v in row.items()}
                name_hint = _first_str(row_str, "新证券简称", "机构名称")
                if name_hint:
                    break

        sw1, sw2 = (
            parse_cninfo_industry_change(ind_df, name_hint=name_hint)
            if ind_df is not None
            else (None, None)
        )
        list_date = parse_cninfo_ipo_list_date(ipo_df) if ipo_df is not None else None

        if sw1 is None or list_date is None:
            profile_df = await self._safe_profile_df(
                code,
                "stock_profile_cninfo",
                lambda: ak.stock_profile_cninfo(symbol=code),
                serialized=True,
            )
            if profile_df is not None:
                p_sw1, p_sw2, p_list_date = parse_cninfo_profile(profile_df, name_hint=name_hint)
                if sw1 is None and p_sw1 is not None:
                    sw1 = p_sw1
                    if sw2 is None:
                        sw2 = p_sw2
                if list_date is None and p_list_date is not None:
                    list_date = p_list_date

        if sw1 is None:
            zyjs_df = await self._safe_profile_df(
                code,
                "stock_zyjs_ths",
                lambda: ak.stock_zyjs_ths(symbol=code),
            )
            if zyjs_df is not None:
                sw1 = parse_ths_zyjs_sector(zyjs_df, name_hint=name_hint)

        return sw1, sw2, list_date

    async def fetch_stock_bundle(self, code: str, *, as_of: date | None = None) -> StockFactBundle:
        exchange = infer_exchange(code)
        if exchange is None:
            raise StockFactUnavailableError(code, "exchange", f"不支持的股票代码前缀: {code}")

        bars, used_tx = await self._fetch_bars_and_valuation(code, exchange=exchange, as_of=as_of)
        resolved_as_of = as_of or bars[-1].trade_date

        reports = await self._fetch_statements(code, exchange=exchange, as_of=resolved_as_of)
        dividends, repurchases, pledge, add_stocks, profile_meta = await asyncio.gather(
            self._fetch_dividends(code, as_of=resolved_as_of),
            self._get_repurchases_for_code(code, as_of=resolved_as_of),
            self._get_pledge_for_code(code, anchor_date=resolved_as_of),
            self._fetch_add_stock(code, as_of=resolved_as_of),
            self._fetch_stock_profile_meta(code, None, as_of=resolved_as_of),
        )
        cf_financings = extract_cf_equity_financings(code, reports)
        profile_sw1, profile_sw2, profile_list_date = profile_meta

        return StockFactBundle(
            code=code,
            as_of=resolved_as_of,
            data_source="akshare:tx" if used_tx else "akshare",
            daily_bars=bars,
            annual_reports=reports,
            dividends=dividends,
            repurchases=repurchases,
            pledge=pledge,
            equity_financings=[*cf_financings, *add_stocks],
            profile_industry_sw1=profile_sw1,
            profile_industry_sw2=profile_sw2,
            profile_list_date=profile_list_date,
        )
