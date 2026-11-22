import { fmtNum, formatPct, formatYi } from '../../lib/format'
import type { ReverseDcfSensitivityRow, SignalLight } from '../../types/api'

export const SIGNAL_META: Record<
  SignalLight,
  { label: string; color: 'green' | 'amber' | 'rose' | 'gray' }
> = {
  green: { label: '绿灯', color: 'green' },
  yellow: { label: '黄灯', color: 'amber' },
  red: { label: '红灯', color: 'rose' },
  na: { label: '待补充', color: 'gray' },
}

export const SHAREHOLDER_STATUS_META: Record<
  SignalLight,
  { label: string; color: 'green' | 'amber' | 'rose' | 'gray' }
> = {
  green: { label: '现金回馈充裕', color: 'green' },
  yellow: { label: '回报基本稳健', color: 'amber' },
  red: { label: '股权抽血 / 回报承压', color: 'rose' },
  na: { label: '数据不足', color: 'gray' },
}

export const FORMULA_NOTE_TITLES: Record<string, string> = {
  radar: '五维定量雷达模型',
  valuation_percentiles: '估值历史分位与采样规则',
  graham: '格雷厄姆数字与安全边际',
  roic_approx: '近似投入资本回报率 (ROIC)',
  reverse_dcf: '逆向 DCF 反推边界说明',
  shareholder_return: '股东净回报与 FCF 覆盖倍数',
  ct_scanner: '财务排雷 CT 扫描口径',
}

type EvidenceMetricMeta = {
  label: string
  kind: 'yuan' | 'pct' | 'ratio' | 'text'
}

const CT_EVIDENCE_METRIC_META: Record<string, EvidenceMetricMeta> = {
  monetary_funds_yuan: { label: '货币资金', kind: 'yuan' },
  interest_debt_yuan: { label: '有息负债', kind: 'yuan' },
  cash_to_assets_pct: { label: '货币资金/总资产', kind: 'pct' },
  debt_to_assets_pct: { label: '有息负债/总资产', kind: 'pct' },
  cip_yuan: { label: '在建工程', kind: 'yuan' },
  fixed_asset_yuan: { label: '固定资产', kind: 'yuan' },
  cip_to_assets_pct: { label: '在建工程/总资产', kind: 'pct' },
  cip_to_fixed_pct: { label: '在建工程/固定资产', kind: 'pct' },
  ocf_yuan: { label: '经营现金流', kind: 'yuan' },
  net_profit_yuan: { label: '归母净利润', kind: 'yuan' },
  ocf_to_profit: { label: '净现比 (OCF/净利)', kind: 'ratio' },
  receivable_yuan: { label: '应收票据及账款', kind: 'yuan' },
  inventory_yuan: { label: '存货', kind: 'yuan' },
  tied_to_revenue_pct: { label: '两金/营收', kind: 'pct' },
  tied_to_assets_pct: { label: '两金/总资产', kind: 'pct' },
  growth_gap_pct: { label: '两金增速−营收增速', kind: 'pct' },
  goodwill_yuan: { label: '商誉', kind: 'yuan' },
  parent_equity_yuan: { label: '归母净资产', kind: 'yuan' },
  goodwill_to_equity_pct: { label: '商誉/归母净资产', kind: 'pct' },
  goodwill_to_assets_pct: { label: '商誉/总资产', kind: 'pct' },
  pledge_ratio_pct: { label: '质押比例', kind: 'pct' },
  pledge_market_cap_yuan: { label: '质押市值', kind: 'yuan' },
  audit_opinion: { label: '审计意见', kind: 'text' },
}

export function getEvidenceMetricLabel(key: string): string {
  return CT_EVIDENCE_METRIC_META[key]?.label ?? key
}

export function formatEvidenceMetric(
  key: string,
  value: number | string | null | undefined,
): string {
  if (value === null || value === undefined) {
    return '—'
  }
  if (typeof value === 'string') {
    return value || '—'
  }
  if (!Number.isFinite(value)) {
    return '—'
  }
  const meta = CT_EVIDENCE_METRIC_META[key]
  if (meta?.kind === 'yuan' || key.endsWith('_yuan')) {
    return formatYi(value)
  }
  if (meta?.kind === 'pct' || key.endsWith('_pct')) {
    return formatPct(value, 2)
  }
  if (meta?.kind === 'ratio') {
    return `${fmtNum(value, 2)}x`
  }
  return fmtNum(value, 2)
}

export type SensitivityMatrix = {
  discountRates: number[]
  multiples: number[]
  values: Map<string, number | null>
}

export function buildSensitivityMatrix(
  rows: readonly ReverseDcfSensitivityRow[],
): SensitivityMatrix {
  const rateSet = new Set<number>()
  const multipleSet = new Set<number>()
  const values = new Map<string, number | null>()

  for (const row of rows) {
    rateSet.add(row.discount_rate_pct)
    multipleSet.add(row.terminal_multiple)
    values.set(
      `${row.discount_rate_pct}:${row.terminal_multiple}`,
      row.implied_fcf_cagr_pct ?? null,
    )
  }

  return {
    discountRates: Array.from(rateSet).sort((a, b) => a - b),
    multiples: Array.from(multipleSet).sort((a, b) => a - b),
    values,
  }
}
