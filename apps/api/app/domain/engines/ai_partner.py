"""Pure domain engine for Restrained AI Decision Companion (Devil's Advocate & grounding guard)."""

from __future__ import annotations

import contextlib
import math
import re
import unicodedata
from collections.abc import Sequence
from decimal import ROUND_HALF_EVEN, ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Any

from app.domain.engines._helpers import finite_or_none, is_financial_institution
from app.domain.engines.sentinel_radar import canonicalize_metric
from app.domain.models import (
    CitedMetricFact,
    CtCheckItem,
    DevilsAdvocateChallenge,
    FalsifyRule,
    JournalAction,
    MdaDiffHighlight,
    MdaMetricShift,
    StockMetaRecord,
    StockSnapshotPayload,
)

COMPLIANCE_NOTICE = (
    "合规提示：以上内容仅基于公开财务事实与逆向风控规则推导，不构成任何证券买卖评级、"
    "操作指导或价格预测；投资决策及盈亏责任请自行审慎评估。"
)

_ZERO_WIDTH_RE = re.compile(r"[\u200b-\u200f\u202a-\u202e\u2060\ufeff\u00ad]")
_MARKDOWN_FORMAT_RE = re.compile(r"[*_`~]+")
_COMPACT_STRIP_RE = re.compile(
    r"[\s*_`~|•·・.,，。、；;：:！!？?\"'“”‘’()（）\[\]【】{}<>《》/\\\-—–]+"
)

_FORBIDDEN_ADVICE_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    (
        "买卖操作建议",
        re.compile(
            r"(?:强烈|重点|积极|谨慎|维持)?\s*(?:建议|推荐|宜|应|可以|立即|赶紧)"
            r"[^\n。；;！？!，,]{0,8}?(?:买入|卖出|加仓|减仓|建仓|清仓|满仓|抄底|持有|做多|做空)"
            r"|维持\s*(?:买入|增持|持有|卖出|减持)"
        ),
    ),
    (
        "推荐评级用语",
        re.compile(r"强烈推荐|重点推荐|强烈看多|(?:买入|增持|卖出|减持)\s*评级|评级为"),
    ),
    ("目标价预测", re.compile(r"目标股?价(?:位|格)?")),
    (
        "收益承诺或信号措辞",
        re.compile(
            r"必涨|稳赚|稳赢|翻倍可期|翻倍行情|满仓抄底|抄底信号|买入信号|卖出信号|闭眼买|无脑买"
        ),
    ),
    (
        "英文买卖评级用语",
        re.compile(
            r"\b(?:strong\s+buy|buy\s+rating|sell\s+rating|target\s+price|"
            r"price\s+target|recommend\s+(?:to\s+)?(?:buy|sell|buying|selling)|"
            r"should\s+(?:buy|sell))\b",
            re.IGNORECASE,
        ),
    ),
)

_FORBIDDEN_COMPACT_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    (
        "买卖操作建议",
        re.compile(
            r"(?:建议|推荐|宜|应|可以|立即|赶紧)"
            r"(?:买入|卖出|加仓|减仓|建仓|清仓|满仓|抄底|持有|做多|做空)"
            r"|维持(?:买入|增持|持有|卖出|减持)"
        ),
    ),
    (
        "推荐评级用语",
        re.compile(r"强烈推荐|重点推荐|强烈看多|(?:买入|增持|卖出|减持)评级|评级为"),
    ),
    ("目标价预测", re.compile(r"目标股?价")),
    (
        "收益承诺或信号措辞",
        re.compile(
            r"必涨|稳赚|稳赢|翻倍可期|翻倍行情|满仓抄底|抄底信号|买入信号|卖出信号|闭眼买|无脑买"
        ),
    ),
    (
        "英文买卖评级用语",
        re.compile(
            r"(?:strongbuy|buyrating|sellrating|targetprice|pricetarget|"
            r"recommend(?:to)?(?:buy|sell|buying|selling)|should(?:buy|sell))",
            re.IGNORECASE,
        ),
    ),
)

_NUMBER_TOKEN_RE = re.compile(r"-?\d+(?:\.\d+)?")
_THOUSANDS_COMMA_RE = re.compile(r"(?<=\d),(?=\d{3}(?!\d))")
_ISO_DATE_RE = re.compile(r"(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)")
_YEAR_LABEL_RE = re.compile(r"(?<!\d)((?:19|20)\d{2})\s*年(?:报|度)?")
_YEAR_FOUR_DIGIT_RE = re.compile(r"(?<!\d)((?:19|20)\d{2})(?!\d)")
_SCHEMA_HORIZON_RE = re.compile(
    r"(?<!\d)(?:近\s*)?(?:3|5|10)\s*年"
    r"(?=\s*(?:平均|均值|最低|最高|分位|历史|复合|累计|营收|净利|扣非|净现比|分红|回购|股东回报|ROE|CAGR|FCF|自由现金流|\d))"
)
_UNICODE_NUMERAL_RE = re.compile(r"[²³¹⁰⁴-⁹₀-₉¼½¾⅓⅔⅕-⅘⅙⅚⅛-⅞①-⑳⑴-⒇Ⅰ-Ⅻⅰ-ⅻ]")
_SCIENTIFIC_NOTATION_RE = re.compile(r"\d[eE][+-]?\d")
_SEPARATED_MINUS_RE = re.compile(r"-\s+\d")
_DIGIT_SPACE_DIGIT_RE = re.compile(r"\d\s+\d")
_CHINESE_FINANCIAL_NUMERAL_RE = re.compile(
    r"(?:[零一二三四五六七八九十百千两壹贰叁肆伍陆柒捌玖拾佰仟〇]"
    r"[零一二三四五六七八九十百千万亿两壹贰叁肆伍陆柒捌玖拾佰仟〇]*\s*(?:亿元|万元|元|%|倍|折|成)"
    r"|万亿元"
    r"|百分之[零一二三四五六七八九十百千万亿两壹贰叁肆伍陆柒捌玖拾佰仟〇]+)"
)
_VAGUE_FALSIFY_HINTS = ("跌了就卖", "不好就卖", "看情况", "再说", "无", "暂无", "不知道")


def contains_forbidden_advice(text: str) -> str | None:
    """Return a violation label if text contains forbidden advice/ratings/target prices."""
    if not text:
        return None
    normalized = _ZERO_WIDTH_RE.sub("", unicodedata.normalize("NFKC", text))
    md_stripped = re.sub(r"\s+", " ", _MARKDOWN_FORMAT_RE.sub("", normalized))
    compact = _COMPACT_STRIP_RE.sub("", normalized)

    for candidate in (normalized, md_stripped):
        for label, pattern in _FORBIDDEN_ADVICE_PATTERNS:
            if pattern.search(candidate):
                return label
    for label, pattern in _FORBIDDEN_COMPACT_PATTERNS:
        if pattern.search(compact):
            return label
    return None


def _fmt_num(value: float, ndigits: int = 2) -> str:
    rendered = f"{round(float(value), ndigits):.{ndigits}f}"
    if rendered in {"-0", "-0.0", "-0.00"}:
        return rendered[1:]
    return rendered


def _fmt_yi(value_yuan: float) -> str:
    return f"{_fmt_num(value_yuan / 1e8, 2)}亿元"


def _add_number_variants(target: set[str], value: float | int | None) -> None:
    if value is None or isinstance(value, bool):
        return
    num = float(value)
    if not math.isfinite(num):
        return

    candidates = [num]
    if num < 0:
        candidates.append(abs(num))

    for item in candidates:
        if item.is_integer():
            target.add(str(round(item)))
        try:
            dec = Decimal(str(item))
        except InvalidOperation:
            dec = None
        for ndigits in (0, 1, 2):
            quant = Decimal(1) if ndigits == 0 else Decimal(10) ** -ndigits
            rounded_vals: list[str] = []
            if dec is not None:
                for mode in (ROUND_HALF_UP, ROUND_HALF_EVEN):
                    q = dec.quantize(quant, rounding=mode)
                    if q == 0:
                        q = Decimal(0).quantize(quant)
                    rounded_vals.append(format(q, "f"))
            else:
                rounded = round(item, ndigits)
                if rounded == 0:
                    rounded = 0.0
                rounded_vals.append(f"{rounded:.{ndigits}f}")

            for formatted in rounded_vals:
                target.add(formatted)
                if "." in formatted:
                    trimmed = formatted.rstrip("0").rstrip(".")
                    target.add("0" if trimmed in {"", "-0"} else trimmed)


def _add_yuan_metric(
    all_allowed: set[str],
    metric_allowed: set[str],
    value_yuan: float | None,
) -> None:
    if value_yuan is None or not math.isfinite(value_yuan):
        return
    _add_number_variants(all_allowed, value_yuan)
    _add_number_variants(all_allowed, value_yuan / 1e8)
    _add_number_variants(metric_allowed, value_yuan)
    _add_number_variants(metric_allowed, value_yuan / 1e8)


def _add_scalar_metric(
    all_allowed: set[str],
    metric_allowed: set[str],
    value: float | int | None,
) -> None:
    if value is None or isinstance(value, bool) or not math.isfinite(float(value)):
        return
    _add_number_variants(all_allowed, value)
    _add_number_variants(metric_allowed, value)


def collect_allowed_snapshot_numbers(snapshot: StockSnapshotPayload) -> tuple[set[str], set[str]]:
    """Collect (all_allowed, primary_metric_allowed) formatted number tokens from snapshot."""
    all_allowed: set[str] = set()
    metric_allowed: set[str] = set()

    _add_number_variants(all_allowed, snapshot.as_of.year)
    if snapshot.pledge_date is not None:
        _add_number_variants(all_allowed, snapshot.pledge_date.year)

    val = snapshot.valuation
    _add_scalar_metric(all_allowed, metric_allowed, val.close)
    _add_yuan_metric(all_allowed, metric_allowed, val.total_mv_yuan)
    _add_scalar_metric(all_allowed, metric_allowed, val.pe_ttm)
    _add_scalar_metric(all_allowed, metric_allowed, val.pe_percentile_5y)
    _add_scalar_metric(all_allowed, metric_allowed, val.pe_percentile_10y)
    _add_scalar_metric(all_allowed, metric_allowed, val.pb)
    _add_scalar_metric(all_allowed, metric_allowed, val.pb_percentile_10y)
    _add_scalar_metric(all_allowed, metric_allowed, val.dividend_yield_pct)
    _add_scalar_metric(all_allowed, metric_allowed, val.graham_number)
    _add_scalar_metric(all_allowed, metric_allowed, val.graham_margin_pct)
    _add_scalar_metric(all_allowed, metric_allowed, val.peg)

    dcf = snapshot.reverse_dcf
    _add_yuan_metric(all_allowed, metric_allowed, dcf.market_cap_yuan)
    _add_yuan_metric(all_allowed, metric_allowed, dcf.enterprise_value_yuan)
    _add_yuan_metric(all_allowed, metric_allowed, dcf.net_cash_yuan)
    _add_yuan_metric(all_allowed, metric_allowed, dcf.base_fcf_yuan)
    _add_number_variants(all_allowed, dcf.base_fcf_years)
    _add_scalar_metric(all_allowed, metric_allowed, dcf.discount_rate_pct)
    _add_scalar_metric(all_allowed, metric_allowed, dcf.terminal_multiple)
    _add_scalar_metric(all_allowed, metric_allowed, dcf.implied_fcf_cagr_pct)
    _add_scalar_metric(all_allowed, metric_allowed, dcf.historical_revenue_cagr_pct)
    _add_scalar_metric(all_allowed, metric_allowed, dcf.implied_vs_history_gap_pct)
    for row in dcf.sensitivity:
        _add_scalar_metric(all_allowed, metric_allowed, row.discount_rate_pct)
        _add_scalar_metric(all_allowed, metric_allowed, row.terminal_multiple)
        _add_scalar_metric(all_allowed, metric_allowed, row.implied_fcf_cagr_pct)

    sr = snapshot.shareholder_return
    _add_number_variants(all_allowed, sr.window_years)
    _add_yuan_metric(all_allowed, metric_allowed, sr.total_dividend_yuan)
    _add_yuan_metric(all_allowed, metric_allowed, sr.total_repurchase_yuan)
    _add_yuan_metric(all_allowed, metric_allowed, sr.total_equity_financing_yuan)
    _add_yuan_metric(all_allowed, metric_allowed, sr.net_return_yuan)
    _add_yuan_metric(all_allowed, metric_allowed, sr.total_fcf_yuan)
    _add_scalar_metric(all_allowed, metric_allowed, sr.fcf_coverage_ratio)
    _add_scalar_metric(all_allowed, metric_allowed, sr.current_dividend_yield_pct)
    for ret_point in sr.series:
        _add_number_variants(all_allowed, ret_point.year)
        _add_yuan_metric(all_allowed, metric_allowed, ret_point.dividend_yuan)
        _add_yuan_metric(all_allowed, metric_allowed, ret_point.repurchase_yuan)
        _add_yuan_metric(all_allowed, metric_allowed, ret_point.equity_financing_yuan)
        _add_yuan_metric(all_allowed, metric_allowed, ret_point.net_return_yuan)
        _add_yuan_metric(all_allowed, metric_allowed, ret_point.fcf_yuan)

    moat = snapshot.moat
    _add_scalar_metric(all_allowed, metric_allowed, moat.roe_5y_avg_pct)
    _add_scalar_metric(all_allowed, metric_allowed, moat.roe_10y_min_pct)
    _add_scalar_metric(all_allowed, metric_allowed, moat.gross_margin_latest_pct)
    _add_scalar_metric(all_allowed, metric_allowed, moat.gross_margin_5y_std_pct)
    _add_scalar_metric(all_allowed, metric_allowed, moat.roic_approx_pct)
    for dim in moat.dimensions:
        _add_scalar_metric(all_allowed, metric_allowed, dim.score)

    growth = snapshot.growth
    _add_scalar_metric(all_allowed, metric_allowed, growth.revenue_cagr_3y_pct)
    _add_scalar_metric(all_allowed, metric_allowed, growth.revenue_cagr_5y_pct)
    _add_scalar_metric(all_allowed, metric_allowed, growth.profit_cagr_5y_pct)
    _add_scalar_metric(all_allowed, metric_allowed, growth.deduct_profit_cagr_5y_pct)
    _add_scalar_metric(all_allowed, metric_allowed, growth.rd_ratio_latest_pct)
    _add_scalar_metric(all_allowed, metric_allowed, growth.capex_to_ocf_latest_pct)

    radar = snapshot.radar
    for score_val in (
        radar.profitability,
        radar.moat,
        radar.balance_sheet,
        radar.cashflow_quality,
        radar.valuation_margin,
        radar.total_score,
    ):
        _add_scalar_metric(all_allowed, metric_allowed, score_val)

    pm = snapshot.peer_metrics
    _add_scalar_metric(all_allowed, metric_allowed, pm.close)
    _add_yuan_metric(all_allowed, metric_allowed, pm.total_mv_yuan)
    _add_scalar_metric(all_allowed, metric_allowed, pm.pe_ttm)
    _add_scalar_metric(all_allowed, metric_allowed, pm.pe_percentile_10y)
    _add_scalar_metric(all_allowed, metric_allowed, pm.pb)
    _add_scalar_metric(all_allowed, metric_allowed, pm.roe_5y_avg_pct)
    _add_scalar_metric(all_allowed, metric_allowed, pm.gross_margin_latest_pct)
    _add_scalar_metric(all_allowed, metric_allowed, pm.net_cash_to_mv_pct)
    _add_scalar_metric(all_allowed, metric_allowed, pm.ocf_to_profit_5y_pct)
    _add_scalar_metric(all_allowed, metric_allowed, pm.shareholder_yield_pct)
    _add_scalar_metric(all_allowed, metric_allowed, pm.implied_fcf_cagr_pct)
    _add_scalar_metric(all_allowed, metric_allowed, pm.ct_red_count)
    _add_scalar_metric(all_allowed, metric_allowed, pm.ct_yellow_count)
    _add_scalar_metric(all_allowed, metric_allowed, pm.total_score)

    ct = snapshot.financial_ct
    _add_scalar_metric(all_allowed, metric_allowed, ct.red_count)
    _add_scalar_metric(all_allowed, metric_allowed, ct.yellow_count)
    _add_scalar_metric(all_allowed, metric_allowed, ct.green_count)
    for check in ct.checks:
        for evidence in check.evidences:
            _add_number_variants(all_allowed, evidence.year)
            for key, metric_val in evidence.metrics.items():
                if isinstance(metric_val, int | float) and not isinstance(metric_val, bool):
                    if key.endswith("_yuan"):
                        _add_yuan_metric(all_allowed, metric_allowed, float(metric_val))
                    else:
                        _add_scalar_metric(all_allowed, metric_allowed, float(metric_val))

    for trend in snapshot.annual_trends:
        _add_number_variants(all_allowed, trend.year)
        _add_yuan_metric(all_allowed, metric_allowed, trend.revenue_yuan)
        _add_yuan_metric(all_allowed, metric_allowed, trend.net_profit_yuan)
        _add_yuan_metric(all_allowed, metric_allowed, trend.deduct_net_profit_yuan)
        _add_yuan_metric(all_allowed, metric_allowed, trend.ocf_yuan)
        _add_yuan_metric(all_allowed, metric_allowed, trend.fcf_yuan)
        _add_yuan_metric(all_allowed, metric_allowed, trend.net_cash_yuan)
        _add_scalar_metric(all_allowed, metric_allowed, trend.roe_pct)
        _add_scalar_metric(all_allowed, metric_allowed, trend.gross_margin_pct)
        _add_scalar_metric(all_allowed, metric_allowed, trend.net_margin_pct)
        _add_scalar_metric(all_allowed, metric_allowed, trend.rd_ratio_pct)

    _add_scalar_metric(all_allowed, metric_allowed, snapshot.pledge_ratio_pct)
    return all_allowed, metric_allowed


def _collect_allowed_years(snapshot: StockSnapshotPayload) -> set[int]:
    years = {snapshot.as_of.year}
    if snapshot.pledge_date is not None:
        years.add(snapshot.pledge_date.year)
    for ret_point in snapshot.shareholder_return.series:
        years.add(ret_point.year)
    for check in snapshot.financial_ct.checks:
        for evidence in check.evidences:
            years.add(evidence.year)
    for trend in snapshot.annual_trends:
        years.add(trend.year)
    return years


def _collect_allowed_dates(snapshot: StockSnapshotPayload) -> set[str]:
    dates = {snapshot.as_of.isoformat()}
    if snapshot.pledge_date is not None:
        dates.add(snapshot.pledge_date.isoformat())
    return dates


def _scrub_identity(
    text: str,
    *,
    stock_code: str | None = None,
    stock_name: str | None = None,
    normalize_nfkc: bool = True,
) -> str:
    cleaned = unicodedata.normalize("NFKC", text) if normalize_nfkc else text
    cleaned = _ZERO_WIDTH_RE.sub("", cleaned)
    if stock_name:
        target_name = unicodedata.normalize("NFKC", stock_name) if normalize_nfkc else stock_name
        cleaned = cleaned.replace(target_name, " ")
        if normalize_nfkc and target_name != stock_name:
            cleaned = cleaned.replace(stock_name, " ")
    if stock_code:
        cleaned = cleaned.replace(stock_code, " ")
    else:
        cleaned = re.sub(r"(?<=[（(])[0-9]{6}(?=[，,）)])", " ", cleaned)
    return cleaned


def _find_obfuscated_number_violation(
    text: str,
    *,
    stock_code: str | None = None,
    stock_name: str | None = None,
    allowed_chinese_phrases: set[str] | None = None,
) -> str | None:
    raw_scrubbed = _scrub_identity(
        text, stock_code=stock_code, stock_name=stock_name, normalize_nfkc=False
    )
    if _UNICODE_NUMERAL_RE.search(raw_scrubbed):
        return "包含特殊 Unicode 数字符号"

    norm_scrubbed = _scrub_identity(
        text, stock_code=stock_code, stock_name=stock_name, normalize_nfkc=True
    )
    if _SCIENTIFIC_NOTATION_RE.search(norm_scrubbed):
        return "包含科学计数法数字"
    if _SEPARATED_MINUS_RE.search(norm_scrubbed):
        return "包含异常分隔负号数字"
    if _DIGIT_SPACE_DIGIT_RE.search(norm_scrubbed):
        return "包含空格分隔数字"
    for match in _CHINESE_FINANCIAL_NUMERAL_RE.finditer(norm_scrubbed):
        phrase = match.group(0)
        if allowed_chinese_phrases and phrase in allowed_chinese_phrases:
            continue
        return f"包含未验证中文金融数值: {phrase}"
    return None


def _extract_numeric_tokens(
    text: str,
    *,
    stock_code: str | None = None,
    stock_name: str | None = None,
    allowed_years: set[int] | None = None,
    allowed_dates: set[str] | None = None,
    allow_schema_horizons: bool = False,
) -> list[str]:
    cleaned = _scrub_identity(
        text, stock_code=stock_code, stock_name=stock_name, normalize_nfkc=True
    )
    cleaned = _THOUSANDS_COMMA_RE.sub("", cleaned)
    if allowed_dates is None:
        cleaned = _ISO_DATE_RE.sub(" ", cleaned)
    elif allowed_dates:
        cleaned = _ISO_DATE_RE.sub(
            lambda m: " " if m.group(0) in allowed_dates else m.group(0),
            cleaned,
        )
    if allowed_years is None:
        cleaned = _YEAR_LABEL_RE.sub(" ", cleaned)
    elif allowed_years:
        cleaned = _YEAR_LABEL_RE.sub(
            lambda m: " " if int(m.group(1)) in allowed_years else m.group(0),
            cleaned,
        )
    if allow_schema_horizons:
        cleaned = _SCHEMA_HORIZON_RE.sub(" ", cleaned)
    return _NUMBER_TOKEN_RE.findall(cleaned)


def trim_snapshot_context(
    meta: StockMetaRecord,
    snapshot: StockSnapshotPayload | None,
    *,
    action: JournalAction,
    reason: str,
    falsify_condition: str,
) -> dict[str, Any]:
    """Build a bounded, token-efficient JSON context summary for LLM prompts."""
    payload: dict[str, Any] = {
        "stock": {
            "code": meta.code,
            "name": meta.name,
            "exchange": meta.exchange,
            "industry_sw1": meta.industry_sw1,
            "industry_sw2": meta.industry_sw2,
            "is_st": meta.is_st,
        },
        "decision": {
            "action": action.value,
            "reason": reason[:1000],
            "falsify_condition": falsify_condition[:1000],
        },
    }
    if snapshot is None:
        payload["snapshot_available"] = False
        return payload

    val = snapshot.valuation
    dcf = snapshot.reverse_dcf
    sr = snapshot.shareholder_return
    moat = snapshot.moat
    growth = snapshot.growth
    pm = snapshot.peer_metrics
    ct = snapshot.financial_ct

    payload["snapshot_available"] = True
    payload["as_of"] = snapshot.as_of.isoformat()
    payload["valuation"] = {
        "close": val.close,
        "total_mv_yi": finite_or_none(val.total_mv_yuan / 1e8, 2)
        if val.total_mv_yuan is not None
        else None,
        "pe_ttm": val.pe_ttm,
        "pe_percentile_10y": val.pe_percentile_10y,
        "pb": val.pb,
        "pb_percentile_10y": val.pb_percentile_10y,
        "dividend_yield_pct": val.dividend_yield_pct,
        "graham_number": val.graham_number,
        "graham_margin_pct": val.graham_margin_pct,
        "peg": val.peg,
    }
    payload["reverse_dcf"] = {
        "solvable": dcf.solvable,
        "implied_fcf_cagr_pct": dcf.implied_fcf_cagr_pct,
        "historical_revenue_cagr_pct": dcf.historical_revenue_cagr_pct,
        "implied_vs_history_gap_pct": dcf.implied_vs_history_gap_pct,
        "base_fcf_yi": finite_or_none(dcf.base_fcf_yuan / 1e8, 2)
        if dcf.base_fcf_yuan is not None
        else None,
        "net_cash_yi": finite_or_none(dcf.net_cash_yuan / 1e8, 2)
        if dcf.net_cash_yuan is not None
        else None,
    }
    payload["moat_and_growth"] = {
        "roe_5y_avg_pct": moat.roe_5y_avg_pct,
        "roe_10y_min_pct": moat.roe_10y_min_pct,
        "gross_margin_latest_pct": moat.gross_margin_latest_pct,
        "gross_margin_5y_std_pct": moat.gross_margin_5y_std_pct,
        "roic_approx_pct": moat.roic_approx_pct,
        "revenue_cagr_3y_pct": growth.revenue_cagr_3y_pct,
        "revenue_cagr_5y_pct": growth.revenue_cagr_5y_pct,
        "profit_cagr_5y_pct": growth.profit_cagr_5y_pct,
        "deduct_profit_cagr_5y_pct": growth.deduct_profit_cagr_5y_pct,
        "rd_ratio_latest_pct": growth.rd_ratio_latest_pct,
    }
    payload["cash_and_return"] = {
        "ocf_to_profit_5y_pct": pm.ocf_to_profit_5y_pct,
        "net_cash_to_mv_pct": pm.net_cash_to_mv_pct,
        "shareholder_yield_pct": pm.shareholder_yield_pct,
        "fcf_coverage_ratio": sr.fcf_coverage_ratio,
        "net_return_yi": finite_or_none(sr.net_return_yuan / 1e8, 2),
        "total_equity_financing_yi": finite_or_none(sr.total_equity_financing_yuan / 1e8, 2),
        "status": sr.status,
    }
    payload["radar"] = {
        "total_score": snapshot.radar.total_score,
        "profitability": snapshot.radar.profitability,
        "moat": snapshot.radar.moat,
        "balance_sheet": snapshot.radar.balance_sheet,
        "cashflow_quality": snapshot.radar.cashflow_quality,
        "valuation_margin": snapshot.radar.valuation_margin,
        "bear_cases": list(snapshot.radar.bear_cases[:5]),
    }
    payload["ct_summary"] = {
        "overall_status": ct.overall_status,
        "red_count": ct.red_count,
        "yellow_count": ct.yellow_count,
        "pledge_ratio_pct": snapshot.pledge_ratio_pct,
        "latest_audit_opinion": snapshot.latest_audit_opinion,
        "alerts": [
            {
                "rule_id": item.rule_id,
                "title": item.title,
                "status": item.status,
                "value_text": item.value_text,
                "summary": item.summary,
            }
            for item in ct.checks
            if item.status in {"red", "yellow"}
        ],
    }
    payload["recent_annual_trends"] = [
        {
            "year": pt.year,
            "revenue_yi": finite_or_none(pt.revenue_yuan / 1e8, 2)
            if pt.revenue_yuan is not None
            else None,
            "net_profit_yi": finite_or_none(pt.net_profit_yuan / 1e8, 2)
            if pt.net_profit_yuan is not None
            else None,
            "deduct_net_profit_yi": finite_or_none(pt.deduct_net_profit_yuan / 1e8, 2)
            if pt.deduct_net_profit_yuan is not None
            else None,
            "ocf_yi": finite_or_none(pt.ocf_yuan / 1e8, 2) if pt.ocf_yuan is not None else None,
            "fcf_yi": finite_or_none(pt.fcf_yuan / 1e8, 2) if pt.fcf_yuan is not None else None,
            "roe_pct": pt.roe_pct,
            "gross_margin_pct": pt.gross_margin_pct,
        }
        for pt in sort_reports_like(snapshot.annual_trends)[-3:]
    ]
    return payload


def sort_reports_like(trends: Sequence[Any]) -> list[Any]:
    return sorted(trends, key=lambda item: item.year)


def _latest_evidence_float(check: CtCheckItem, key: str) -> float | None:
    for ev in reversed(check.evidences):
        val = ev.metrics.get(key)
        if isinstance(val, int | float) and not isinstance(val, bool) and math.isfinite(float(val)):
            return float(val)
    return None


def _is_vague_falsify(falsify_condition: str) -> bool:
    cleaned = falsify_condition.strip()
    if len(cleaned) < 10:
        return True
    if any(hint in cleaned for hint in _VAGUE_FALSIFY_HINTS) and len(cleaned) < 20:
        return True
    return not _NUMBER_TOKEN_RE.search(cleaned)


_ACTION_LABELS: dict[JournalAction, str] = {
    JournalAction.BUY: "买入",
    JournalAction.ADD: "加仓",
    JournalAction.TRIM: "减仓",
    JournalAction.SELL: "卖出",
    JournalAction.PASS: "观察跳过",
}


def _ct_challenge_for_check(
    check: CtCheckItem,
    snapshot: StockSnapshotPayload,
    *,
    is_financial: bool = False,
) -> tuple[int, str, DevilsAdvocateChallenge] | None:
    if check.status not in {"red", "yellow"}:
        return None
    if is_financial and check.rule_id in {
        "dual_high_cash_debt",
        "ocf_profit_divergence",
        "receivable_inventory_bloat",
    }:
        return None
    severity_base = 100 if check.status == "red" else 60
    rid = check.rule_id

    if rid == "dual_high_cash_debt":
        cash_pct = _latest_evidence_float(check, "cash_to_assets_pct")
        debt_pct = _latest_evidence_float(check, "debt_to_assets_pct")
        facts: list[CitedMetricFact] = []
        parts: list[str] = []
        if cash_pct is not None:
            txt = f"{_fmt_num(cash_pct, 1)}%"
            facts.append(
                CitedMetricFact(
                    label="货币资金/总资产", value_text=txt, source_section="financial_ct"
                )
            )
            parts.append(f"货币资金占总资产 {txt}")
        if debt_pct is not None:
            txt = f"{_fmt_num(debt_pct, 1)}%"
            facts.append(
                CitedMetricFact(
                    label="有息负债/总资产", value_text=txt, source_section="financial_ct"
                )
            )
            parts.append(f"有息负债占总资产 {txt}")
        if not facts:
            facts.append(
                CitedMetricFact(
                    label="排雷红灯数",
                    value_text=str(snapshot.financial_ct.red_count),
                    source_section="financial_ct",
                )
            )
            parts.append(f"财务排雷触发 {snapshot.financial_ct.red_count} 项红灯")
        thesis = (
            f"{'、'.join(parts)}，呈现存贷双高特征；需逐项核查受限货币资金比例、"
            "利息收入与有息负债利率匹配度，防范账面现金虚高或流动性抽血风险。"
        )
        return (
            severity_base + 15,
            "ct_dual_high",
            DevilsAdvocateChallenge(
                index=1,
                title="存贷双高与受限资金真实性核验",
                thesis=thesis,
                cited_facts=facts,
                suggested_falsify_rule=FalsifyRule(
                    metric="ct_red_count",
                    op="gt",
                    value=float(snapshot.financial_ct.red_count),
                    periods=1,
                ),
            ),
        )

    if rid == "stalled_cip":
        cip_assets = _latest_evidence_float(check, "cip_to_assets_pct")
        cip_fixed = _latest_evidence_float(check, "cip_to_fixed_pct")
        facts = []
        parts = []
        if cip_assets is not None:
            txt = f"{_fmt_num(cip_assets, 1)}%"
            facts.append(
                CitedMetricFact(
                    label="在建工程/总资产", value_text=txt, source_section="financial_ct"
                )
            )
            parts.append(f"在建工程占总资产 {txt}")
        if cip_fixed is not None:
            txt = f"{_fmt_num(cip_fixed, 1)}%"
            facts.append(
                CitedMetricFact(
                    label="在建工程/固定资产", value_text=txt, source_section="financial_ct"
                )
            )
            parts.append(f"占固定资产 {txt}")
        if not facts:
            facts.append(
                CitedMetricFact(
                    label="排雷警示",
                    value_text=str(snapshot.financial_ct.red_count),
                    source_section="financial_ct",
                )
            )
            parts.append(f"排雷计数 {snapshot.financial_ct.red_count}")
        base_gm = snapshot.moat.gross_margin_latest_pct or 20.0
        return (
            severity_base + 14,
            "ct_stalled_cip",
            DevilsAdvocateChallenge(
                index=1,
                title="在建工程长期沉淀与延迟转固风险",
                thesis=(
                    f"{'，'.join(parts)}；工程长期不转固可能延迟折旧计提并虚增当期盈利，"
                    "后续转固后折旧放量将直接压缩毛利率。"
                ),
                cited_facts=facts,
                suggested_falsify_rule=FalsifyRule(
                    metric="gross_margin_pct",
                    op="lt",
                    value=round(max(1.0, base_gm - 5.0), 1),
                    periods=2,
                ),
            ),
        )

    if rid == "ocf_profit_divergence":
        facts = []
        parts = []
        ocf_5y = snapshot.peer_metrics.ocf_to_profit_5y_pct
        if ocf_5y is not None:
            txt = f"{_fmt_num(ocf_5y, 1)}%"
            facts.append(
                CitedMetricFact(
                    label="5年累计净现比", value_text=txt, source_section="peer_metrics"
                )
            )
            parts.append(f"近 5 年净现比为 {txt}")
        latest_ocf = _latest_evidence_float(check, "ocf_yuan")
        latest_np = _latest_evidence_float(check, "net_profit_yuan")
        if latest_ocf is not None:
            txt = _fmt_yi(latest_ocf)
            facts.append(
                CitedMetricFact(
                    label="最新经营现金流", value_text=txt, source_section="financial_ct"
                )
            )
            parts.append(f"最新年报经营现金流 {txt}")
        if latest_np is not None:
            txt = _fmt_yi(latest_np)
            facts.append(
                CitedMetricFact(
                    label="最新归母净利润", value_text=txt, source_section="financial_ct"
                )
            )
            parts.append(f"归母净利润 {txt}")
        if not facts:
            cf_label = snapshot.radar.dimension_labels.get("cashflow_quality", "现金流质量")
            facts.append(
                CitedMetricFact(
                    label=f"{cf_label}评分",
                    value_text=f"{snapshot.radar.cashflow_quality}分",
                    source_section="radar",
                )
            )
            parts.append(f"{cf_label}评分 {snapshot.radar.cashflow_quality} 分")
        return (
            severity_base + 13,
            "ct_ocf_divergence",
            DevilsAdvocateChallenge(
                index=1,
                title="利润含金量与经营现金流背离",
                thesis=(
                    f"{'，'.join(parts)}，盈利未能充分转化为可支配现金流；"
                    "若应收占款或商业票据扩张持续，账面利润存在回调与坏账风险。"
                ),
                cited_facts=facts,
                suggested_falsify_rule=FalsifyRule(
                    metric="ocf_to_profit_5y_pct",
                    op="lt",
                    value=60.0,
                    periods=1,
                ),
            ),
        )

    if rid == "receivable_inventory_bloat":
        tied_rev = _latest_evidence_float(check, "tied_to_revenue_pct")
        tied_assets = _latest_evidence_float(check, "tied_to_assets_pct")
        facts = []
        parts = []
        if tied_rev is not None:
            txt = f"{_fmt_num(tied_rev, 1)}%"
            facts.append(
                CitedMetricFact(
                    label="应收+存货/营收", value_text=txt, source_section="financial_ct"
                )
            )
            parts.append(f"应收账款与存货合计占营收 {txt}")
        if tied_assets is not None:
            txt = f"{_fmt_num(tied_assets, 1)}%"
            facts.append(
                CitedMetricFact(
                    label="应收+存货/总资产", value_text=txt, source_section="financial_ct"
                )
            )
            parts.append(f"占总资产 {txt}")
        if not facts:
            facts.append(
                CitedMetricFact(
                    label="排雷黄红灯数",
                    value_text=str(
                        snapshot.financial_ct.red_count + snapshot.financial_ct.yellow_count
                    ),
                    source_section="financial_ct",
                )
            )
            parts.append(f"排雷灯数 {snapshot.financial_ct.red_count}")
        return (
            severity_base + 12,
            "ct_receivable_inventory",
            DevilsAdvocateChallenge(
                index=1,
                title="营运资金占款膨胀与存货跌价压力",
                thesis=(
                    f"{'，'.join(parts)}；高占款结构往往反映下游议价能力走弱或渠道压货，"
                    "一旦终端需求转弱将引发坏账计提与存货跌价双重冲击。"
                ),
                cited_facts=facts,
                suggested_falsify_rule=FalsifyRule(
                    metric="ocf_to_profit_5y_pct",
                    op="lt",
                    value=70.0,
                    periods=1,
                ),
            ),
        )

    if rid == "goodwill_overhang":
        gw_eq = _latest_evidence_float(check, "goodwill_to_equity_pct")
        gw_assets = _latest_evidence_float(check, "goodwill_to_assets_pct")
        gw_yuan = _latest_evidence_float(check, "goodwill_yuan")
        facts = []
        parts = []
        if gw_yuan is not None:
            txt = _fmt_yi(gw_yuan)
            facts.append(
                CitedMetricFact(label="账面商誉", value_text=txt, source_section="financial_ct")
            )
            parts.append(f"账面商誉达 {txt}")
        if gw_eq is not None:
            txt = f"{_fmt_num(gw_eq, 1)}%"
            facts.append(
                CitedMetricFact(
                    label="商誉/归母净资产", value_text=txt, source_section="financial_ct"
                )
            )
            parts.append(f"占归母净资产 {txt}")
        elif gw_assets is not None:
            txt = f"{_fmt_num(gw_assets, 1)}%"
            facts.append(
                CitedMetricFact(label="商誉/总资产", value_text=txt, source_section="financial_ct")
            )
            parts.append(f"占总资产 {txt}")
        return (
            severity_base + 14,
            "ct_goodwill",
            DevilsAdvocateChallenge(
                index=1,
                title="高商誉减值悬顶与并购后遗症",
                thesis=(
                    f"{'，'.join(parts)}；若被并购标的业绩承诺期后盈利不及预期，"
                    "大额商誉减值将直接侵蚀归母净利润并打穿账面净资产缓冲。"
                ),
                cited_facts=facts,
                suggested_falsify_rule=FalsifyRule(metric="roe_pct", op="lt", value=8.0, periods=1),
            ),
        )

    if rid == "shareholder_pledge":
        pledge = snapshot.pledge_ratio_pct
        if pledge is None:
            pledge = _latest_evidence_float(check, "pledge_ratio_pct")
        if pledge is None:
            return None
        pledge_txt = f"{_fmt_num(pledge, 2)}%"
        return (
            severity_base + 13,
            "ct_pledge",
            DevilsAdvocateChallenge(
                index=1,
                title="大股东高比例股权质押与被动减持风险",
                thesis=(
                    f"全市场股权质押比例达 {pledge_txt}；当市场波动导致股价下挫时，"
                    "高质押结构容易触发补充质押或平仓处置踩踏，冲击二级市场流动性与治理稳定性。"
                ),
                cited_facts=[
                    CitedMetricFact(
                        label="全市场质押率",
                        value_text=pledge_txt,
                        source_section="financial_ct",
                    )
                ],
                suggested_falsify_rule=FalsifyRule(
                    metric="pledge_ratio_pct", op="gte", value=30.0, periods=1
                ),
            ),
        )

    if rid == "audit_opinion":
        opinion = snapshot.latest_audit_opinion or check.value_text
        red_txt = str(snapshot.financial_ct.red_count)
        yellow_txt = str(snapshot.financial_ct.yellow_count)
        return (
            severity_base + 16,
            "ct_audit",
            DevilsAdvocateChallenge(
                index=1,
                title="审计意见异常与财务内控合规风险",
                thesis=(
                    f"年报审计意见为「{opinion}」（当前排雷红灯 {red_txt} 项、"
                    f"黄灯 {yellow_txt} 项）；"
                    "非标准审计意见往往涉及持续经营疑虑、资金占用或会计估计重大争议，"
                    "需先逐条排查审计师保留/强调事项段细节。"
                ),
                cited_facts=[
                    CitedMetricFact(
                        label="排雷红灯数", value_text=red_txt, source_section="financial_ct"
                    ),
                    CitedMetricFact(
                        label="排雷黄灯数", value_text=yellow_txt, source_section="financial_ct"
                    ),
                ],
                suggested_falsify_rule=FalsifyRule(
                    metric="ct_red_count",
                    op="gt",
                    value=float(snapshot.financial_ct.red_count),
                    periods=1,
                ),
            ),
        )
    return None


def _build_snapshot_candidates(
    meta: StockMetaRecord,
    snapshot: StockSnapshotPayload,
    *,
    action: JournalAction,
    reason: str,
    falsify_condition: str,
) -> list[tuple[int, str, DevilsAdvocateChallenge]]:
    industry_hint = (
        (snapshot.industry_sw1 or snapshot.industry_sw2) if snapshot is not None else None
    )
    is_financial = is_financial_institution(meta, industry_hint=industry_hint)
    candidates: list[tuple[int, str, DevilsAdvocateChallenge]] = []
    for check in snapshot.financial_ct.checks:
        built = _ct_challenge_for_check(check, snapshot, is_financial=is_financial)
        if built is not None:
            candidates.append(built)

    industry = meta.industry_sw1 or snapshot.industry_sw1 or "金融"
    if is_financial:
        facts: list[CitedMetricFact] = []
        parts: list[str] = []
        if snapshot.valuation.pb is not None:
            pb_txt = f"{_fmt_num(snapshot.valuation.pb, 2)}x"
            facts.append(
                CitedMetricFact(label="市净率 PB", value_text=pb_txt, source_section="valuation")
            )
            parts.append(f"当前 PB 为 {pb_txt}")
        if snapshot.moat.roe_5y_avg_pct is not None:
            roe_txt = f"{_fmt_num(snapshot.moat.roe_5y_avg_pct, 2)}%"
            facts.append(
                CitedMetricFact(label="5年平均 ROE", value_text=roe_txt, source_section="moat")
            )
            parts.append(f"5年均值 ROE 为 {roe_txt}")
        if not facts:
            score_txt = f"{snapshot.radar.total_score}分"
            facts.append(
                CitedMetricFact(label="综合评分", value_text=score_txt, source_section="radar")
            )
            parts.append(f"综合评分 {score_txt}")
        candidates.append(
            (
                88,
                "financial_exemption",
                DevilsAdvocateChallenge(
                    index=1,
                    title="金融行业高杠杆豁免项与拨备/不良暴露盲区",
                    thesis=(
                        f"{industry}行业已豁免存贷双高、应收膨胀及逆向 DCF 等工业指标，"
                        f"当前{'，'.join(parts)}；表面低估值或稳健 ROE 无法直接反映表外信贷质量、"
                        "净息差收窄压力与资本充足率约束。"
                    ),
                    cited_facts=facts,
                    suggested_falsify_rule=FalsifyRule(
                        metric="roe_pct", op="lt", value=8.0, periods=2
                    ),
                ),
            )
        )

        div_yield = (
            snapshot.valuation.dividend_yield_pct
            if snapshot.valuation.dividend_yield_pct is not None
            else snapshot.shareholder_return.current_dividend_yield_pct
        )
        fin_cap_facts: list[CitedMetricFact] = []
        fin_cap_parts: list[str] = []
        if div_yield is not None:
            dy_txt = f"{_fmt_num(div_yield, 2)}%"
            fin_cap_facts.append(
                CitedMetricFact(label="最新股息率", value_text=dy_txt, source_section="valuation")
            )
            fin_cap_parts.append(f"股息率为 {dy_txt}")
        if snapshot.valuation.pb is not None:
            pb_txt = f"{_fmt_num(snapshot.valuation.pb, 2)}x"
            fin_cap_facts.append(
                CitedMetricFact(label="市净率 PB", value_text=pb_txt, source_section="valuation")
            )
            fin_cap_parts.append(f"市净率 PB {pb_txt}")
        if snapshot.moat.roe_5y_avg_pct is not None:
            roe_txt = f"{_fmt_num(snapshot.moat.roe_5y_avg_pct, 2)}%"
            fin_cap_facts.append(
                CitedMetricFact(label="5年平均ROE", value_text=roe_txt, source_section="moat")
            )
            fin_cap_parts.append(f"5年均值 ROE {roe_txt}")
        if not fin_cap_facts:
            score_txt = f"{snapshot.radar.total_score}分"
            fin_cap_facts.append(
                CitedMetricFact(label="综合评分", value_text=score_txt, source_section="radar")
            )
            fin_cap_parts.append(f"综合评分 {score_txt}")
        cap_rule = (
            FalsifyRule(
                metric="dividend_yield_pct",
                op="lt",
                value=round(max(1.0, div_yield * 0.7), 2),
                periods=1,
            )
            if div_yield is not None and div_yield > 0
            else FalsifyRule(metric="roe_pct", op="lt", value=8.0, periods=2)
        )
        candidates.append(
            (
                44,
                "financial_dividend_capital",
                DevilsAdvocateChallenge(
                    index=1,
                    title="分红持续性与核心资本充足率约束核验",
                    thesis=(
                        f"当前{'、'.join(fin_cap_parts)}；金融机构的派息能力受监管核心一级资本充足率"
                        "与信贷拨备消耗直接约束，若风险加权资产扩张过快或拨备承压，分红率存在下修可能。"
                    ),
                    cited_facts=fin_cap_facts,
                    suggested_falsify_rule=cap_rule,
                ),
            )
        )

    dcf = snapshot.reverse_dcf
    if (
        not is_financial
        and dcf.solvable
        and dcf.implied_fcf_cagr_pct is not None
        and (
            (dcf.implied_vs_history_gap_pct is not None and dcf.implied_vs_history_gap_pct > 5.0)
            or dcf.implied_fcf_cagr_pct >= 15.0
        )
    ):
        cagr_txt = f"{_fmt_num(dcf.implied_fcf_cagr_pct, 2)}%"
        facts = [
            CitedMetricFact(
                label="逆向DCF隐含增速", value_text=cagr_txt, source_section="reverse_dcf"
            )
        ]
        detail_parts = [f"当前股价隐含未来十年 FCF 年化增速达 {cagr_txt}"]
        if dcf.historical_revenue_cagr_pct is not None:
            hist_txt = f"{_fmt_num(dcf.historical_revenue_cagr_pct, 2)}%"
            facts.append(
                CitedMetricFact(
                    label="历史营收复合增速", value_text=hist_txt, source_section="reverse_dcf"
                )
            )
            detail_parts.append(f"对比历史营收增速 {hist_txt}")
        if dcf.implied_vs_history_gap_pct is not None:
            gap_txt = f"{_fmt_num(dcf.implied_vs_history_gap_pct, 2)}"
            facts.append(
                CitedMetricFact(
                    label="预期与历史差值(pct)",
                    value_text=gap_txt,
                    source_section="reverse_dcf",
                )
            )
            detail_parts.append(f"高出 {gap_txt} 个百分点")
        candidates.append(
            (
                92,
                "reverse_dcf_optimism",
                DevilsAdvocateChallenge(
                    index=1,
                    title="逆向 DCF 隐含增速显著高于历史表现",
                    thesis=(
                        f"{'，'.join(detail_parts)}；市场已在现价中充分计价高增长预期，"
                        "若未来业绩兑现仅贴合历史均值，将面临预期下修与估值杀双杀。"
                    ),
                    cited_facts=facts,
                    suggested_falsify_rule=FalsifyRule(
                        metric="implied_fcf_cagr_pct",
                        op="gt",
                        value=round(dcf.implied_fcf_cagr_pct + 5.0, 1),
                        periods=1,
                    ),
                ),
            )
        )
    elif (
        not is_financial
        and not dcf.solvable
        and dcf.base_fcf_yuan is not None
        and dcf.base_fcf_yuan <= 0
    ):
        fcf_txt = _fmt_yi(dcf.base_fcf_yuan)
        facts = [
            CitedMetricFact(label="近3年平均FCF", value_text=fcf_txt, source_section="reverse_dcf")
        ]
        extra = ""
        if snapshot.valuation.total_mv_yuan is not None:
            mv_txt = _fmt_yi(snapshot.valuation.total_mv_yuan)
            facts.append(
                CitedMetricFact(label="最新总市值", value_text=mv_txt, source_section="valuation")
            )
            extra = f"（当前总市值 {mv_txt}）"
        candidates.append(
            (
                94,
                "negative_fcf",
                DevilsAdvocateChallenge(
                    index=1,
                    title="自由现金流为负导致内生造血估值失效",
                    thesis=(
                        f"近 3 年平均自由现金流为 {fcf_txt}{extra}，逆向 DCF 模型无法求解；"
                        "长期资本开支高于经营现金流会持续依赖外部融资或消耗账面现金。"
                    ),
                    cited_facts=facts,
                    suggested_falsify_rule=FalsifyRule(
                        metric="fcf_yuan", op="lt", value=0.0, periods=2
                    ),
                ),
            )
        )

    val = snapshot.valuation
    high_pe = val.pe_percentile_10y is not None and val.pe_percentile_10y >= 70.0
    high_pb = val.pb_percentile_10y is not None and val.pb_percentile_10y >= 75.0
    low_graham = val.graham_margin_pct is not None and val.graham_margin_pct < 0
    if high_pe or high_pb or low_graham:
        facts = []
        parts = []
        if val.pe_ttm is not None and (high_pe or low_graham or not high_pb):
            pe_txt = f"{_fmt_num(val.pe_ttm, 2)}x"
            facts.append(
                CitedMetricFact(label="PE(TTM)", value_text=pe_txt, source_section="valuation")
            )
            parts.append(f"当前 PE(TTM) 为 {pe_txt}")
        if val.pe_percentile_10y is not None and (high_pe or not high_pb):
            pct_txt = f"{_fmt_num(val.pe_percentile_10y, 1)}%"
            facts.append(
                CitedMetricFact(label="PE 10年分位", value_text=pct_txt, source_section="valuation")
            )
            parts.append(f"处于近 10 年 {pct_txt} 分位")
        if high_pb:
            if val.pb is not None:
                pb_txt = f"{_fmt_num(val.pb, 2)}x"
                facts.append(
                    CitedMetricFact(
                        label="市净率 PB", value_text=pb_txt, source_section="valuation"
                    )
                )
                parts.append(f"当前 PB 为 {pb_txt}")
            if val.pb_percentile_10y is not None:
                pbp_txt = f"{_fmt_num(val.pb_percentile_10y, 1)}%"
                facts.append(
                    CitedMetricFact(
                        label="PB 10年分位", value_text=pbp_txt, source_section="valuation"
                    )
                )
                parts.append(f"PB 处于近 10 年 {pbp_txt} 分位")
        if val.graham_margin_pct is not None and not is_financial:
            gm_txt = f"{_fmt_num(val.graham_margin_pct, 2)}%"
            facts.append(
                CitedMetricFact(
                    label="格雷厄姆安全边际", value_text=gm_txt, source_section="valuation"
                )
            )
            parts.append(f"格雷厄姆安全边际率为 {gm_txt}")
        if not facts and val.pb is not None:
            pb_txt = f"{_fmt_num(val.pb, 2)}x"
            facts.append(
                CitedMetricFact(label="市净率 PB", value_text=pb_txt, source_section="valuation")
            )
            parts.append(f"当前 PB 为 {pb_txt}")
        if facts:
            is_high_percentile = high_pe or high_pb
            val_anchor = "历史高分位" if is_high_percentile else "当前估值水平"
            if high_pb and not high_pe:
                val_rule = (
                    FalsifyRule(
                        metric="pb",
                        op="gte",
                        value=round(val.pb * 1.1, 2),
                        periods=1,
                    )
                    if val.pb is not None and val.pb > 0
                    else FalsifyRule(metric="pb_percentile_10y", op="gte", value=85.0, periods=1)
                )
            else:
                val_rule = FalsifyRule(metric="pe_percentile_10y", op="gte", value=80.0, periods=1)
            candidates.append(
                (
                    86 if is_high_percentile else 52,
                    "baseline_valuation",
                    DevilsAdvocateChallenge(
                        index=1,
                        title=(
                            "历史估值分位偏高与安全边际收窄"
                            if is_high_percentile
                            else "格雷厄姆安全边际偏窄与估值均值回归风险"
                        ),
                        thesis=(
                            f"{'，'.join(parts)}；{val_anchor}"
                            "对应容错空间有限，估值均值回归风险往往先于基本面恶化发生。"
                        ),
                        cited_facts=facts,
                        suggested_falsify_rule=val_rule,
                    ),
                )
            )
    elif (
        val.pe_ttm is not None
        and val.pe_ttm <= 12.0
        and snapshot.moat.roe_10y_min_pct is not None
        and snapshot.moat.roe_10y_min_pct < 8.0
    ):
        pe_txt = f"{_fmt_num(val.pe_ttm, 2)}x"
        min_roe_txt = f"{_fmt_num(snapshot.moat.roe_10y_min_pct, 2)}%"
        facts = [
            CitedMetricFact(label="PE(TTM)", value_text=pe_txt, source_section="valuation"),
            CitedMetricFact(label="近10年最低ROE", value_text=min_roe_txt, source_section="moat"),
        ]
        candidates.append(
            (
                72,
                "cyclical_low_pe_trap",
                DevilsAdvocateChallenge(
                    index=1,
                    title="低 PE 周期景气高点陷阱排查",
                    thesis=(
                        f"当前 PE(TTM) 仅 {pe_txt}，但历史周期低谷期 ROE 曾回落至 {min_roe_txt}；"
                        "对于强周期标的，低市盈率常常对应行业盈利顶点而非安全底部。"
                    ),
                    cited_facts=facts,
                    suggested_falsify_rule=FalsifyRule(
                        metric="roe_pct", op="lt", value=8.0, periods=1
                    ),
                ),
            )
        )

    sr = snapshot.shareholder_return
    sr_triggered = (
        sr.net_return_yuan < 0
        if is_financial
        else (
            sr.status in {"red", "yellow"}
            or sr.net_return_yuan < 0
            or (sr.fcf_coverage_ratio is not None and sr.fcf_coverage_ratio < 1.0)
        )
    )
    if sr_triggered:
        facts = []
        parts = []
        net_ret_txt = _fmt_yi(sr.net_return_yuan)
        facts.append(
            CitedMetricFact(
                label="股东净回报", value_text=net_ret_txt, source_section="shareholder_return"
            )
        )
        parts.append(f"历史窗口内股东净回报为 {net_ret_txt}")
        if sr.total_equity_financing_yuan > 0:
            fin_txt = _fmt_yi(sr.total_equity_financing_yuan)
            facts.append(
                CitedMetricFact(
                    label="累计股权再融资",
                    value_text=fin_txt,
                    source_section="shareholder_return",
                )
            )
            parts.append(f"期间累计股权再融资 {fin_txt}")
        if not is_financial and sr.fcf_coverage_ratio is not None:
            cov_txt = f"{_fmt_num(sr.fcf_coverage_ratio, 2)}倍"
            facts.append(
                CitedMetricFact(
                    label="FCF覆盖倍数", value_text=cov_txt, source_section="shareholder_return"
                )
            )
            parts.append(f"自由现金流覆盖倍数仅 {cov_txt}")
        if sr.current_dividend_yield_pct is not None and sr.current_dividend_yield_pct > 0:
            dy_txt = f"{_fmt_num(sr.current_dividend_yield_pct, 2)}%"
            facts.append(
                CitedMetricFact(
                    label="当前股息率", value_text=dy_txt, source_section="shareholder_return"
                )
            )
            parts.append(f"静态股息率 {dy_txt}")
        sr_rule = (
            FalsifyRule(metric="roe_pct", op="lt", value=8.0, periods=2)
            if is_financial
            else FalsifyRule(metric="fcf_coverage_ratio", op="lt", value=0.8, periods=1)
        )
        sr_thesis_prefix = (
            "当分红回购缺乏内生留存收益持续支撑或被定增再融资抵消时，"
            if is_financial
            else "当分红回购缺乏自由现金流持续覆盖或被定增再融资抵消时，"
        )
        candidates.append(
            (
                90 if sr.status == "red" else 68,
                "shareholder_return_weak",
                DevilsAdvocateChallenge(
                    index=1,
                    title=(
                        "股权再融资稀释与股东净回报偏弱风险"
                        if is_financial
                        else "股东净回报偏弱与伪高股息/再融资稀释风险"
                    ),
                    thesis=(
                        f"{'，'.join(parts)}；{sr_thesis_prefix}"
                        "表面股息率难以转化为真实的股东每股价值增厚。"
                    ),
                    cited_facts=facts,
                    suggested_falsify_rule=sr_rule,
                ),
            )
        )

    growth = snapshot.growth
    if (
        (growth.revenue_cagr_3y_pct is not None and growth.revenue_cagr_3y_pct < 0)
        or (growth.profit_cagr_5y_pct is not None and growth.profit_cagr_5y_pct < 0)
        or (growth.deduct_profit_cagr_5y_pct is not None and growth.deduct_profit_cagr_5y_pct < 0)
    ):
        facts = []
        parts = []
        if growth.revenue_cagr_3y_pct is not None:
            r3_txt = f"{_fmt_num(growth.revenue_cagr_3y_pct, 2)}%"
            facts.append(
                CitedMetricFact(label="3年营收CAGR", value_text=r3_txt, source_section="growth")
            )
            parts.append(f"近 3 年营收复合增速 {r3_txt}")
        if growth.deduct_profit_cagr_5y_pct is not None:
            dp_txt = f"{_fmt_num(growth.deduct_profit_cagr_5y_pct, 2)}%"
            facts.append(
                CitedMetricFact(label="5年扣非净利CAGR", value_text=dp_txt, source_section="growth")
            )
            parts.append(f"5 年扣非净利增速 {dp_txt}")
        elif growth.profit_cagr_5y_pct is not None:
            p5_txt = f"{_fmt_num(growth.profit_cagr_5y_pct, 2)}%"
            facts.append(
                CitedMetricFact(label="5年净利CAGR", value_text=p5_txt, source_section="growth")
            )
            parts.append(f"5 年净利增速 {p5_txt}")
        if not is_financial and snapshot.moat.gross_margin_latest_pct is not None:
            gm_txt = f"{_fmt_num(snapshot.moat.gross_margin_latest_pct, 2)}%"
            facts.append(
                CitedMetricFact(label="最新毛利率", value_text=gm_txt, source_section="moat")
            )
            parts.append(f"最新毛利率 {gm_txt}")
        candidates.append(
            (
                80,
                "growth_contraction",
                DevilsAdvocateChallenge(
                    index=1,
                    title="主业成长失速与需求收缩校验",
                    thesis=(
                        f"{'，'.join(parts)}；营收或扣非利润长期负增长提示行业见顶或份额流失，"
                        "单靠压缩费用很难长期维持净资产收益率。"
                    ),
                    cited_facts=facts,
                    suggested_falsify_rule=FalsifyRule(
                        metric="roe_pct", op="lt", value=10.0, periods=2
                    ),
                ),
            )
        )

    if _is_vague_falsify(falsify_condition) or len(reason.strip()) < 15:
        facts = [
            CitedMetricFact(
                label="雷达综合评分",
                value_text=f"{snapshot.radar.total_score}分",
                source_section="radar",
            )
        ]
        metric_desc = f"当前综合评分 {snapshot.radar.total_score} 分"
        if val.pe_ttm is not None:
            pe_txt = f"{_fmt_num(val.pe_ttm, 2)}x"
            facts.append(
                CitedMetricFact(label="PE(TTM)", value_text=pe_txt, source_section="valuation")
            )
            metric_desc += f"、PE(TTM) {pe_txt}"
        if snapshot.moat.roe_5y_avg_pct is not None:
            roe_txt = f"{_fmt_num(snapshot.moat.roe_5y_avg_pct, 2)}%"
            facts.append(
                CitedMetricFact(label="5年平均ROE", value_text=roe_txt, source_section="moat")
            )
            metric_desc += f"、5年平均 ROE {roe_txt}"
        tracker_metrics = "ROE、股息率、PB" if is_financial else "ROE、净现比、排雷红灯"
        if action in {JournalAction.BUY, JournalAction.ADD}:
            falsify_action_hint = (
                f"在入库前将退出边界落到 {tracker_metrics} 等可追踪指标，"
                "才能避免后续基本面走弱时产生确认偏误。"
            )
        elif action in {JournalAction.SELL, JournalAction.TRIM}:
            falsify_action_hint = (
                f"在减仓或清仓前将重估复查边界落到 {tracker_metrics} 等可追踪指标，"
                "才能避免短期情绪波动下误判基本面拐点。"
            )
        else:
            falsify_action_hint = (
                f"在记录观察跳过决策前将重启跟踪门槛落到 {tracker_metrics} 等可追踪指标，"
                "才能避免主观印象导致长期漏判。"
            )
        candidates.append(
            (
                76,
                "falsify_completeness",
                DevilsAdvocateChallenge(
                    index=1,
                    title="否证条件缺乏可量化财报门槛",
                    thesis=(
                        f"{metric_desc}，但当前输入的否证条件较宽泛或缺少明确数值红线；"
                        f"{falsify_action_hint}"
                    ),
                    cited_facts=facts,
                    suggested_falsify_rule=FalsifyRule(
                        metric="roe_pct", op="lt", value=12.0, periods=2
                    ),
                ),
            )
        )

    if action in {JournalAction.SELL, JournalAction.TRIM, JournalAction.PASS}:
        facts_alt: list[CitedMetricFact] = []
        parts_alt: list[str] = []
        if val.pe_percentile_10y is not None:
            p_txt = f"{_fmt_num(val.pe_percentile_10y, 1)}%"
            facts_alt.append(
                CitedMetricFact(label="PE 10年分位", value_text=p_txt, source_section="valuation")
            )
            parts_alt.append(f"PE 10年分位为 {p_txt}")
        if is_financial:
            if val.pb is not None:
                pb_txt = f"{_fmt_num(val.pb, 2)}x"
                facts_alt.append(
                    CitedMetricFact(
                        label="市净率 PB", value_text=pb_txt, source_section="valuation"
                    )
                )
                parts_alt.append(f"当前 PB 为 {pb_txt}")
            if snapshot.moat.roe_5y_avg_pct is not None:
                r_txt = f"{_fmt_num(snapshot.moat.roe_5y_avg_pct, 2)}%"
                facts_alt.append(
                    CitedMetricFact(label="5年平均ROE", value_text=r_txt, source_section="moat")
                )
                parts_alt.append(f"5年均值 ROE {r_txt}")
        elif snapshot.peer_metrics.ocf_to_profit_5y_pct is not None:
            o_txt = f"{_fmt_num(snapshot.peer_metrics.ocf_to_profit_5y_pct, 1)}%"
            facts_alt.append(
                CitedMetricFact(label="5年净现比", value_text=o_txt, source_section="peer_metrics")
            )
            parts_alt.append(f"5年净现比 {o_txt}")
        if not facts_alt:
            s_txt = f"{snapshot.radar.total_score}分"
            facts_alt.append(
                CitedMetricFact(label="综合评分", value_text=s_txt, source_section="radar")
            )
            parts_alt.append(f"综合评分 {s_txt}")
        title_alt = (
            "左侧悲观情绪过度外推与踏空反转核验"
            if action in {JournalAction.SELL, JournalAction.TRIM}
            else "观察清单遗漏安全垫与重估触发点核验"
        )
        candidates.append(
            (
                120,
                "action_counter_thesis",
                DevilsAdvocateChallenge(
                    index=1,
                    title=title_alt,
                    thesis=(
                        f"{'，'.join(parts_alt)}；需辨别当前{_ACTION_LABELS[action]}决策"
                        "是否受短期价格波动或机会成本错判驱动，并同步记录清晰的反向复查标准。"
                    ),
                    cited_facts=facts_alt,
                    suggested_falsify_rule=None,
                ),
            )
        )

    # Baseline probes ensure pristine cash cows still receive 3 fact-grounded challenges.
    base_val_facts: list[CitedMetricFact] = []
    base_val_parts: list[str] = []
    if val.close is not None:
        c_txt = f"{_fmt_num(val.close, 2)}元"
        base_val_facts.append(
            CitedMetricFact(label="最新收盘价", value_text=c_txt, source_section="valuation")
        )
        base_val_parts.append(f"最新收盘价 {c_txt}")
    if val.pe_ttm is not None:
        pe_txt = f"{_fmt_num(val.pe_ttm, 2)}x"
        base_val_facts.append(
            CitedMetricFact(label="PE(TTM)", value_text=pe_txt, source_section="valuation")
        )
        base_val_parts.append(f"PE(TTM) {pe_txt}")
    if not is_financial and dcf.implied_fcf_cagr_pct is not None:
        dcf_txt = f"{_fmt_num(dcf.implied_fcf_cagr_pct, 2)}%"
        base_val_facts.append(
            CitedMetricFact(label="隐含FCF增速", value_text=dcf_txt, source_section="reverse_dcf")
        )
        base_val_parts.append(f"逆向 DCF 隐含十年 FCF 年化增速 {dcf_txt}")
    elif val.pb is not None:
        pb_txt = f"{_fmt_num(val.pb, 2)}x"
        base_val_facts.append(
            CitedMetricFact(label="PB", value_text=pb_txt, source_section="valuation")
        )
        base_val_parts.append(f"PB {pb_txt}")
    if base_val_facts:
        base_val_rule = (
            FalsifyRule(
                metric="pb",
                op="gte",
                value=round(max(1.0, val.pb * 1.15), 2),
                periods=1,
            )
            if is_financial and val.pb is not None and val.pb > 0
            else FalsifyRule(metric="pe_percentile_10y", op="gte", value=80.0, periods=1)
        )
        candidates.append(
            (
                45,
                "baseline_valuation",
                DevilsAdvocateChallenge(
                    index=1,
                    title=(
                        "金融板块估值扩张与息差承压测试"
                        if is_financial
                        else "估值隐含增长假设与需求回落压力测试"
                    ),
                    thesis=(
                        f"当前{'、'.join(base_val_parts)}；即使排雷清单表现稳健，"
                        "若行业景气周期切换导致增速中枢下移，估值倍数压缩仍可能带来净值回撤。"
                    ),
                    cited_facts=base_val_facts,
                    suggested_falsify_rule=base_val_rule,
                ),
            )
        )

    base_moat_facts: list[CitedMetricFact] = []
    base_moat_parts: list[str] = []
    if snapshot.moat.roe_5y_avg_pct is not None:
        r_txt = f"{_fmt_num(snapshot.moat.roe_5y_avg_pct, 2)}%"
        base_moat_facts.append(
            CitedMetricFact(label="5年平均ROE", value_text=r_txt, source_section="moat")
        )
        base_moat_parts.append(f"5年均值 ROE {r_txt}")
    if not is_financial and snapshot.moat.gross_margin_latest_pct is not None:
        gm_txt = f"{_fmt_num(snapshot.moat.gross_margin_latest_pct, 2)}%"
        base_moat_facts.append(
            CitedMetricFact(label="最新毛利率", value_text=gm_txt, source_section="moat")
        )
        base_moat_parts.append(f"毛利率 {gm_txt}")
    if not is_financial and snapshot.moat.roic_approx_pct is not None:
        roic_txt = f"{_fmt_num(snapshot.moat.roic_approx_pct, 2)}%"
        base_moat_facts.append(
            CitedMetricFact(label="近似ROIC", value_text=roic_txt, source_section="moat")
        )
        base_moat_parts.append(f"近似 ROIC {roic_txt}")
    if base_moat_facts:
        roe_floor = round(max(8.0, (snapshot.moat.roe_5y_avg_pct or 15.0) * 0.7), 1)
        candidates.append(
            (
                42,
                "baseline_moat",
                DevilsAdvocateChallenge(
                    index=1,
                    title="高盈利能力均值回归与竞争壁垒侵蚀风险",
                    thesis=(
                        f"公司{'、'.join(base_moat_parts)}；高资本回报率长期必然吸引新进入者或替代技术，"
                        "需确认定价权与渠道壁垒是否足以在未来数年抵御竞争摊薄。"
                    ),
                    cited_facts=base_moat_facts,
                    suggested_falsify_rule=FalsifyRule(
                        metric="roe_pct", op="lt", value=roe_floor, periods=2
                    ),
                ),
            )
        )

    if not is_financial:
        base_cash_facts: list[CitedMetricFact] = []
        base_cash_parts: list[str] = []
        if snapshot.peer_metrics.ocf_to_profit_5y_pct is not None:
            ocf_txt = f"{_fmt_num(snapshot.peer_metrics.ocf_to_profit_5y_pct, 1)}%"
            base_cash_facts.append(
                CitedMetricFact(
                    label="5年净现比", value_text=ocf_txt, source_section="peer_metrics"
                )
            )
            base_cash_parts.append(f"近 5 年净现比 {ocf_txt}")
        if sr.fcf_coverage_ratio is not None:
            cov_txt = f"{_fmt_num(sr.fcf_coverage_ratio, 2)}倍"
            base_cash_facts.append(
                CitedMetricFact(
                    label="FCF覆盖倍数", value_text=cov_txt, source_section="shareholder_return"
                )
            )
            base_cash_parts.append(f"自由现金流对净回报覆盖 {cov_txt}")
        if snapshot.peer_metrics.net_cash_to_mv_pct is not None:
            nc_txt = f"{_fmt_num(snapshot.peer_metrics.net_cash_to_mv_pct, 2)}%"
            base_cash_facts.append(
                CitedMetricFact(
                    label="净现金/总市值", value_text=nc_txt, source_section="peer_metrics"
                )
            )
            base_cash_parts.append(f"净现金市值比 {nc_txt}")
        if base_cash_facts:
            candidates.append(
                (
                    40,
                    "baseline_cash",
                    DevilsAdvocateChallenge(
                        index=1,
                        title="现金转化持续性与资本开支再投资纪律",
                        thesis=(
                            f"当前{'、'.join(base_cash_parts)}；需跟踪后续大额资本开支或并购计划"
                            "是否会打破既有自由现金流分配纪律。"
                        ),
                        cited_facts=base_cash_facts,
                        suggested_falsify_rule=FalsifyRule(
                            metric="ocf_to_profit_5y_pct", op="lt", value=80.0, periods=1
                        ),
                    ),
                )
            )

    score_txt = f"{snapshot.radar.total_score}分"
    red_txt = str(snapshot.financial_ct.red_count)
    yellow_txt = str(snapshot.financial_ct.yellow_count)
    candidates.append(
        (
            35,
            "baseline_radar",
            DevilsAdvocateChallenge(
                index=1,
                title="财务排雷基线监控与边际恶化防线",
                thesis=(
                    f"雷达综合评分 {score_txt}（排雷红灯 {red_txt} 项、黄灯 {yellow_txt} 项）；"
                    "当前静态指标无法替代后续季报/年报追踪，应预先约定触发红灯增量时的复核动作。"
                ),
                cited_facts=[
                    CitedMetricFact(label="综合评分", value_text=score_txt, source_section="radar"),
                    CitedMetricFact(
                        label="排雷红灯数", value_text=red_txt, source_section="financial_ct"
                    ),
                    CitedMetricFact(
                        label="排雷黄灯数", value_text=yellow_txt, source_section="financial_ct"
                    ),
                ],
                suggested_falsify_rule=FalsifyRule(
                    metric="ct_red_count",
                    op="gt",
                    value=float(snapshot.financial_ct.red_count),
                    periods=1,
                ),
            ),
        )
    )
    return candidates


def _build_unsynced_challenges(
    meta: StockMetaRecord,
    *,
    action: JournalAction,
    falsify_condition: str,
) -> list[DevilsAdvocateChallenge]:
    industry = meta.industry_sw1 or "未分类行业"
    st_label = "ST 风险警示状态" if meta.is_st else "非 ST 状态"
    action_label = _ACTION_LABELS[action]
    falsify_status = (
        "当前否证条件缺少可量化财报门槛"
        if _is_vague_falsify(falsify_condition)
        else "当前否证条件尚未绑定实时财报快照"
    )
    return [
        DevilsAdvocateChallenge(
            index=1,
            title="财务快照尚未同步，三表排雷与现金流事实处于盲区",
            thesis=(
                f"{meta.name}({meta.code}，{meta.exchange} / {industry}) 尚未完成个股数据同步，"
                "当前无法核验存贷双高、在建工程、商誉占比、净现比或历史审计意见；"
                "在缺失量化财务排雷结果前直接下结论容易落入信息盲区。"
            ),
            cited_facts=[
                CitedMetricFact(
                    label="个股分析快照", value_text="未同步快照", source_section="stock_meta"
                ),
                CitedMetricFact(label="所属行业", value_text=industry, source_section="stock_meta"),
            ],
            suggested_falsify_rule=FalsifyRule(
                metric="ct_red_count", op="gt", value=0.0, periods=1
            ),
        ),
        DevilsAdvocateChallenge(
            index=2,
            title="缺少历史估值分位与逆向现金流定价参照",
            thesis=(
                f"当前仅可读取证券基础档案（{meta.exchange}，{st_label}），"
                "缺少历史市盈率/市净率分位、格雷厄姆安全边际与逆向 DCF 隐含增速参照；"
                "建议先同步行情与年报序列后再审视估值安全垫。"
            ),
            cited_facts=[
                CitedMetricFact(label="风险标识", value_text=st_label, source_section="stock_meta"),
                CitedMetricFact(
                    label="估值与逆向DCF", value_text="待同步生成", source_section="stock_meta"
                ),
            ],
            suggested_falsify_rule=FalsifyRule(
                metric="pe_percentile_10y", op="gte", value=80.0, periods=1
            ),
        ),
        DevilsAdvocateChallenge(
            index=3,
            title=f"{action_label}决策前需补全可追踪的量化否证红线",
            thesis=(
                f"{falsify_status}；即便在未同步快照时做预演评估，"
                "也应明确界定毛利率滑坡、净资产收益率失守或排雷红灯触发等客观证伪条件，"
                "避免情绪化决策。"
            ),
            cited_facts=[
                CitedMetricFact(
                    label="否证门槛状态", value_text=falsify_status, source_section="decision_input"
                ),
            ],
            suggested_falsify_rule=FalsifyRule(metric="roe_pct", op="lt", value=10.0, periods=2),
        ),
    ]


def build_deterministic_challenges(
    meta: StockMetaRecord,
    snapshot: StockSnapshotPayload | None,
    *,
    action: JournalAction,
    reason: str,
    falsify_condition: str,
) -> list[DevilsAdvocateChallenge]:
    """Always build 3 distinct, fact-grounded Devil's Advocate challenges."""
    if snapshot is None:
        return _build_unsynced_challenges(
            meta,
            action=action,
            falsify_condition=falsify_condition,
        )

    candidates = _build_snapshot_candidates(
        meta,
        snapshot,
        action=action,
        reason=reason,
        falsify_condition=falsify_condition,
    )
    candidates.sort(key=lambda item: -item[0])

    selected: list[DevilsAdvocateChallenge] = []
    seen_keys: set[str] = set()
    for _, key, challenge in candidates:
        if key in seen_keys:
            continue
        seen_keys.add(key)
        selected.append(challenge.model_copy(update={"index": len(selected) + 1}))
        if len(selected) == 3:
            break
    return selected


def _decimal_places(token: str) -> int:
    if "." not in token:
        return 0
    return len(token.split(".", 1)[1])


def _tokens_match_numeric(left: str, right: str) -> bool:
    if left == right:
        return True
    try:
        d_left = abs(Decimal(left))
        d_right = abs(Decimal(right))
    except InvalidOperation:
        return False
    if d_left == d_right:
        return True

    dec_left = _decimal_places(left)
    dec_right = _decimal_places(right)
    if dec_left == dec_right:
        return False

    more_precise, coarser, target_places = (
        (d_left, d_right, dec_right) if dec_left > dec_right else (d_right, d_left, dec_left)
    )
    quant = Decimal(1) if target_places == 0 else Decimal(10) ** -target_places
    return (
        more_precise.quantize(quant, rounding=ROUND_HALF_UP) == coarser
        or more_precise.quantize(quant, rounding=ROUND_HALF_EVEN) == coarser
    )


def _is_token_grounded(token: str, allowed: set[str]) -> bool:
    if token in allowed:
        return True
    return any(_tokens_match_numeric(token, candidate) for candidate in allowed)


def _challenge_text_fields(ch: DevilsAdvocateChallenge) -> list[str]:
    fields = [ch.title, ch.thesis]
    for fact in ch.cited_facts:
        fields.extend((fact.label, fact.value_text, fact.source_section))
    if ch.suggested_falsify_rule is not None:
        fields.append(ch.suggested_falsify_rule.metric)
    return fields


def verify_llm_challenges(
    raw_challenges: Sequence[DevilsAdvocateChallenge],
    snapshot: StockSnapshotPayload | None,
    *,
    stock_code: str | None = None,
    stock_name: str | None = None,
) -> tuple[bool, str | None]:
    """Verify LLM challenges pass compliance and strict snapshot numeric grounding."""
    if len(raw_challenges) != 3:
        return False, f"AI 质询数量必须为 3 条，实际返回 {len(raw_challenges)} 条"

    resolved_code = stock_code or (snapshot.code if snapshot is not None else None)
    resolved_name = stock_name or (snapshot.name if snapshot is not None else None)

    for ch in raw_challenges:
        if not ch.title.strip() or not ch.thesis.strip():
            return False, "AI 质询标题或正文为空"

        for field_text in _challenge_text_fields(ch):
            violation = contains_forbidden_advice(field_text)
            if violation is not None:
                return False, f"AI 输出包含违规表述 ({violation})"

        if (
            ch.suggested_falsify_rule is not None
            and canonicalize_metric(ch.suggested_falsify_rule.metric) is None
        ):
            return (
                False,
                f"AI 建议的否证规则指标不受支持: {ch.suggested_falsify_rule.metric}",
            )

        content_fields = [
            ch.title,
            ch.thesis,
            *(f.label for f in ch.cited_facts),
            *(f.value_text for f in ch.cited_facts),
            *(f.source_section for f in ch.cited_facts),
        ]
        for field_text in content_fields:
            obf = _find_obfuscated_number_violation(
                field_text,
                stock_code=resolved_code,
                stock_name=resolved_name,
            )
            if obf is not None:
                return False, f"AI 输出{obf}"

    if snapshot is None:
        for ch in raw_challenges:
            for field_text in (
                ch.title,
                ch.thesis,
                *(f.label for f in ch.cited_facts),
                *(f.value_text for f in ch.cited_facts),
                *(f.source_section for f in ch.cited_facts),
            ):
                if _extract_numeric_tokens(
                    field_text,
                    stock_code=resolved_code,
                    stock_name=resolved_name,
                    allowed_years=set(),
                    allowed_dates=set(),
                    allow_schema_horizons=False,
                ):
                    return False, "未同步财务快照时不得生成具体财务数字"
        return True, None

    all_allowed, metric_allowed = collect_allowed_snapshot_numbers(snapshot)
    allowed_years = _collect_allowed_years(snapshot)
    allowed_dates = _collect_allowed_dates(snapshot)

    for ch in raw_challenges:
        if not ch.cited_facts:
            return False, "AI 质询缺少 cited_facts 指标引用"

        cited_metric_tokens: list[str] = []
        for fact in ch.cited_facts:
            for meta_text in (fact.label, fact.source_section):
                meta_tokens = _extract_numeric_tokens(
                    meta_text,
                    stock_code=resolved_code,
                    stock_name=resolved_name,
                    allowed_years=allowed_years,
                    allowed_dates=allowed_dates,
                    allow_schema_horizons=True,
                )
                for tok in meta_tokens:
                    if not _is_token_grounded(tok, all_allowed):
                        return False, f"AI 引用指标标签包含未验证数字: {tok}"

            fact_tokens = _extract_numeric_tokens(
                fact.value_text,
                stock_code=resolved_code,
                stock_name=resolved_name,
                allowed_years=allowed_years,
                allowed_dates=allowed_dates,
                allow_schema_horizons=True,
            )
            for tok in fact_tokens:
                if not _is_token_grounded(tok, all_allowed):
                    return False, f"AI 引用指标包含未验证数字: {tok}"
                if _is_token_grounded(tok, metric_allowed):
                    cited_metric_tokens.append(tok)

        if not cited_metric_tokens:
            return False, "AI cited_facts 未引用快照中的真实定量指标"

        title_tokens = _extract_numeric_tokens(
            ch.title,
            stock_code=resolved_code,
            stock_name=resolved_name,
            allowed_years=allowed_years,
            allowed_dates=allowed_dates,
            allow_schema_horizons=True,
        )
        thesis_tokens = _extract_numeric_tokens(
            ch.thesis,
            stock_code=resolved_code,
            stock_name=resolved_name,
            allowed_years=allowed_years,
            allowed_dates=allowed_dates,
            allow_schema_horizons=True,
        )
        for tok in [*title_tokens, *thesis_tokens]:
            if not _is_token_grounded(tok, all_allowed):
                return False, f"AI 质询正文包含未在快照中验证的数字: {tok}"

        if not any(
            _tokens_match_numeric(cited_tok, thesis_tok)
            for cited_tok in cited_metric_tokens
            for thesis_tok in thesis_tokens
        ):
            return False, "AI 质询正文未在论据中引用所列快照指标数值"

    return True, None


def verify_mda_summary(
    summary_text: str,
    snapshot: StockSnapshotPayload | None,
    *,
    previous_text: str = "",
    current_text: str = "",
    stock_code: str | None = None,
    stock_name: str | None = None,
    previous_period_label: str = "",
    current_period_label: str = "",
    metric_shifts: Sequence[MdaMetricShift] = (),
    text_highlights: Sequence[MdaDiffHighlight] = (),
) -> tuple[bool, str | None]:
    """Verify MD&A diff summary is non-empty, compliant, and free of hallucinated numbers."""
    cleaned = summary_text.strip()
    if not cleaned:
        return False, "AI 口径对比摘要为空"

    violation = contains_forbidden_advice(cleaned)
    if violation is not None:
        return False, f"AI 摘要包含违规表述 ({violation})"

    resolved_code = stock_code or (snapshot.code if snapshot is not None else None)
    resolved_name = stock_name or (snapshot.name if snapshot is not None else None)

    source_chinese_phrases: set[str] = set()
    allowed_years: set[int] = _collect_allowed_years(snapshot) if snapshot is not None else set()
    allowed_dates: set[str] = _collect_allowed_dates(snapshot) if snapshot is not None else set()
    all_allowed: set[str] = (
        collect_allowed_snapshot_numbers(snapshot)[0] if snapshot is not None else set()
    )

    for src in (previous_text, current_text):
        if not src:
            continue
        scrubbed_src = _scrub_identity(
            src, stock_code=resolved_code, stock_name=resolved_name, normalize_nfkc=True
        )
        source_chinese_phrases.update(_CHINESE_FINANCIAL_NUMERAL_RE.findall(scrubbed_src))

    obf = _find_obfuscated_number_violation(
        cleaned,
        stock_code=resolved_code,
        stock_name=resolved_name,
        allowed_chinese_phrases=source_chinese_phrases,
    )
    if obf is not None:
        return False, f"AI 摘要{obf}"

    text_numbers: set[str] = set()
    for src in (previous_text, current_text, previous_period_label, current_period_label):
        if not src:
            continue
        scrubbed_src = _scrub_identity(
            src, stock_code=resolved_code, stock_name=resolved_name, normalize_nfkc=True
        )
        allowed_dates.update(_ISO_DATE_RE.findall(scrubbed_src))
        for yr_str in _YEAR_FOUR_DIGIT_RE.findall(scrubbed_src):
            allowed_years.add(int(yr_str))
        for tok in _extract_numeric_tokens(
            src,
            stock_code=resolved_code,
            stock_name=resolved_name,
            allowed_years=set(),
            allowed_dates=allowed_dates,
            allow_schema_horizons=False,
        ):
            text_numbers.add(tok)
            with contextlib.suppress(ValueError):
                _add_number_variants(text_numbers, float(tok))

    diff_counts: set[str] = set()
    if metric_shifts or text_highlights:
        count_values = (
            len(metric_shifts),
            sum(1 for item in metric_shifts if item.severity == "red"),
            sum(1 for item in metric_shifts if item.severity == "yellow"),
            len(text_highlights),
            sum(1 for item in text_highlights if item.change_type == "added"),
            sum(1 for item in text_highlights if item.change_type == "removed"),
            sum(1 for item in text_highlights if item.change_type == "modified"),
            sum(1 for item in text_highlights if item.severity == "red"),
            sum(1 for item in text_highlights if item.severity == "yellow"),
        )
        for cnt in count_values:
            _add_number_variants(diff_counts, cnt)

    allowed = all_allowed | text_numbers | diff_counts
    summary_tokens = _extract_numeric_tokens(
        cleaned,
        stock_code=resolved_code,
        stock_name=resolved_name,
        allowed_years=allowed_years,
        allowed_dates=allowed_dates,
        allow_schema_horizons=snapshot is not None,
    )
    for tok in summary_tokens:
        if not _is_token_grounded(tok, allowed):
            return False, f"AI 口径对比摘要包含未验证数字: {tok}"

    return True, None
