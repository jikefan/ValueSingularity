"""Shared deterministic financial math helpers for Phase 2 domain engines."""

from __future__ import annotations

import math
from collections.abc import Sequence

from app.domain.models import StockAnnualReport


def finite_or_none(value: float | None, ndigits: int | None = None) -> float | None:
    if value is None or not math.isfinite(value):
        return None
    return round(float(value), ndigits) if ndigits is not None else float(value)


def safe_pct(numerator: float | None, denominator: float | None, ndigits: int = 2) -> float | None:
    if numerator is None or denominator is None or denominator <= 0:
        return None
    if not (math.isfinite(numerator) and math.isfinite(denominator)):
        return None
    return round((numerator / denominator) * 100.0, ndigits)


def clamp_score(value: float) -> int:
    if not math.isfinite(value):
        return 0
    return max(0, min(100, round(value)))


def report_interest_debt_yuan(report: StockAnnualReport, *, include_lease: bool = False) -> float:
    parts = [
        report.short_loan_yuan,
        report.noncurrent_liab_1y_yuan,
        report.long_loan_yuan,
        report.bond_payable_yuan,
        report.short_bond_payable_yuan,
    ]
    if include_lease:
        parts.append(report.lease_liab_yuan)
    return sum(v for v in parts if v is not None and math.isfinite(v) and v > 0)


def report_cash_yuan(report: StockAnnualReport, *, include_trade_fin: bool = True) -> float:
    cash = report.monetary_funds_yuan or 0.0
    if include_trade_fin and report.trade_fin_assets_yuan is not None:
        cash += max(0.0, report.trade_fin_assets_yuan)
    return cash if math.isfinite(cash) else 0.0


def report_net_cash_yuan(report: StockAnnualReport) -> float | None:
    if report.monetary_funds_yuan is None and report.total_assets_yuan is None:
        return None
    net_cash = report_cash_yuan(report, include_trade_fin=True) - report_interest_debt_yuan(
        report, include_lease=True
    )
    return finite_or_none(net_cash, 2)


def report_fcf_yuan(report: StockAnnualReport) -> float | None:
    if report.ocf_yuan is None or not math.isfinite(report.ocf_yuan):
        return None
    capex = (
        report.capex_yuan
        if report.capex_yuan is not None and math.isfinite(report.capex_yuan)
        else 0.0
    )
    return finite_or_none(report.ocf_yuan - max(0.0, capex), 2)


def compute_cagr_pct(start_val: float | None, end_val: float | None, years: int) -> float | None:
    if years <= 0 or start_val is None or end_val is None:
        return None
    if not (math.isfinite(start_val) and math.isfinite(end_val)):
        return None
    if start_val <= 0 or end_val <= 0:
        return None
    return finite_or_none(((end_val / start_val) ** (1.0 / years) - 1.0) * 100.0, 2)


def percentile_rank(values: Sequence[float], target: float) -> float | None:
    valid = [v for v in values if math.isfinite(v)]
    if not valid or not math.isfinite(target):
        return None
    less = sum(1 for v in valid if v < target)
    equal = sum(1 for v in valid if v == target)
    return round(max(0.0, min(100.0, ((less + 0.5 * equal) / len(valid)) * 100.0)), 1)


def sort_reports_asc(reports: Sequence[StockAnnualReport]) -> list[StockAnnualReport]:
    by_year: dict[int, StockAnnualReport] = {}
    for report in reports:
        by_year[report.report_year] = report
    return [by_year[year] for year in sorted(by_year)]
