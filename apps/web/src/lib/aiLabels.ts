import type {
  AiExecutionMode,
  AiQuotaStatus,
  DevilsAdvocateRequest,
  FalsifyRule,
  MdaDiffHighlight,
} from '../types/api'
import {
  FALSIFY_OP_LABEL,
  getFalsifyMetricLabel,
  isMultiPeriodFalsifyMetric,
} from './journalLabels'

export type AiRequestMode = DevilsAdvocateRequest['mode']

export const AI_REQUEST_MODE_OPTIONS: ReadonlyArray<{
  value: AiRequestMode
  label: string
}> = [
  { value: 'auto', label: '智能推演 (auto)' },
  { value: 'rule_only', label: '纯规则引擎 (rule_only)' },
]

export const AI_EXECUTION_MODE_META: Record<
  AiExecutionMode,
  { label: string; color: 'gray' | 'blue' | 'green' | 'amber' }
> = {
  deterministic: { label: '规则引擎 · deterministic', color: 'gray' },
  llm: { label: '智能推演 · llm', color: 'blue' },
  byok: { label: '自带密钥 · byok', color: 'green' },
  deterministic_fallback: { label: '规则回退 · deterministic_fallback', color: 'amber' },
}

export const MDA_CHANGE_TYPE_META: Record<
  MdaDiffHighlight['change_type'],
  { label: string; color: 'green' | 'rose' | 'amber' }
> = {
  added: { label: '新增 · added', color: 'green' },
  removed: { label: '删减 · removed', color: 'rose' },
  modified: { label: '修改 · modified', color: 'amber' },
}

export function getAiQuotaTagMeta(quota: AiQuotaStatus): {
  label: string
  color: 'green' | 'blue' | 'amber' | 'rose'
} {
  if (quota.byok_active) {
    return { label: 'BYOK 已启用', color: 'green' }
  }
  const color = quota.remaining_today === 0 ? 'rose' : quota.remaining_today <= 2 ? 'amber' : 'blue'
  return {
    label: `今日 AI 额度剩余 ${quota.remaining_today}/${quota.daily_limit}`,
    color,
  }
}

export function formatFalsifyRuleLine(rule: FalsifyRule): string {
  const label = getFalsifyMetricLabel(rule.metric)
  const op = FALSIFY_OP_LABEL[rule.op] ?? rule.op
  const periods = isMultiPeriodFalsifyMetric(rule.metric)
    ? Math.min(40, Math.max(1, Math.trunc(rule.periods) || 1))
    : 1
  return `${label} ${op} ${rule.value}（连续 ${periods} 期）`
}
