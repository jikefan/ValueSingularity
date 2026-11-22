import type { JournalAction } from '../types/api'

export const JOURNAL_ACTION_META: Record<
  JournalAction,
  { label: string; color: 'green' | 'amber' | 'rose' }
> = {
  buy: { label: '买入', color: 'green' },
  add: { label: '加仓', color: 'green' },
  trim: { label: '减仓', color: 'rose' },
  sell: { label: '卖出', color: 'rose' },
  pass: { label: 'Pass 观察', color: 'amber' },
}
