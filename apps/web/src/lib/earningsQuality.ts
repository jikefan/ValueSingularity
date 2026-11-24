import type { EarningsQualityTag } from '../types/api'

export type EarningsQualityBadgeMeta = {
  label: string
  badgeClass: string
  verdictTone: 'green' | 'yellow' | 'red' | 'blue'
}

function meta(
  label: string,
  badgeTone: 'green' | 'amber' | 'red' | 'blue' | 'muted',
  verdictTone: EarningsQualityBadgeMeta['verdictTone'],
): EarningsQualityBadgeMeta {
  return { label, badgeClass: `quality-badge quality-badge-${badgeTone}`, verdictTone }
}

const BADGE_META_BY_TAG = {
  core_cash_cow: meta('主业造血现金牛', 'green', 'green'),
  investment_driven: meta('投资收益驱动型', 'red', 'red'),
  subsidy_inflated: meta('补贴 / 一次性损益偏高', 'red', 'red'),
  cashflow_divergent: meta('账面盈利待现金验证', 'amber', 'yellow'),
  leveraged_roe: meta('高杠杆驱动型 ROE', 'amber', 'yellow'),
  balanced_steady: meta('主业均衡稳健', 'blue', 'blue'),
  financial_special: meta('金融专项口径', 'blue', 'blue'),
} satisfies Record<EarningsQualityTag, EarningsQualityBadgeMeta>

const FALLBACK_META = meta('均衡跟踪', 'muted', 'blue')

export function getEarningsQualityBadgeMeta(
  tag: EarningsQualityTag | null | undefined,
  customLabel?: string | null,
): EarningsQualityBadgeMeta {
  const base: EarningsQualityBadgeMeta = tag ? BADGE_META_BY_TAG[tag] : FALLBACK_META
  const trimmed = customLabel?.trim()
  return trimmed ? { ...base, label: trimmed } : { ...base }
}
