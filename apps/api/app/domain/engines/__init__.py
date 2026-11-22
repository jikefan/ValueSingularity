"""Pure Phase 2 and Phase 3 calculation engines."""

from app.domain.engines._helpers import is_financial_institution
from app.domain.engines.ai_partner import (
    COMPLIANCE_NOTICE,
    build_deterministic_challenges,
    collect_allowed_snapshot_numbers,
    contains_forbidden_advice,
    trim_snapshot_context,
    verify_llm_challenges,
    verify_mda_summary,
)
from app.domain.engines.ct_scanner import scan_financial_ct
from app.domain.engines.decision_ledger import build_decision_ledger
from app.domain.engines.mda_diff import (
    compute_accounting_metric_shifts,
    compute_text_mda_diff,
)
from app.domain.engines.reverse_dcf import (
    compute_reverse_dcf,
    dcf_present_value,
    solve_implied_fcf_cagr_pct,
)
from app.domain.engines.sentinel_radar import (
    SUPPORTED_CANONICAL_METRICS,
    SentinelEvaluationResult,
    canonicalize_metric,
    evaluate_entry_falsify,
    evaluate_user_alerts,
)
from app.domain.engines.shareholder_return import analyze_shareholder_return
from app.domain.engines.snapshot_builder import build_stock_snapshot

__all__ = [
    "COMPLIANCE_NOTICE",
    "SUPPORTED_CANONICAL_METRICS",
    "SentinelEvaluationResult",
    "analyze_shareholder_return",
    "build_decision_ledger",
    "build_deterministic_challenges",
    "build_stock_snapshot",
    "canonicalize_metric",
    "collect_allowed_snapshot_numbers",
    "compute_accounting_metric_shifts",
    "compute_reverse_dcf",
    "compute_text_mda_diff",
    "contains_forbidden_advice",
    "dcf_present_value",
    "evaluate_entry_falsify",
    "evaluate_user_alerts",
    "is_financial_institution",
    "scan_financial_ct",
    "solve_implied_fcf_cagr_pct",
    "trim_snapshot_context",
    "verify_llm_challenges",
    "verify_mda_summary",
]
