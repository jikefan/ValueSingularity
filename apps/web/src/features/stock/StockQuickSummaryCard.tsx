import { useMemo } from 'react'
import { Card } from '../../components/ui/Card'
import { Tag } from '../../components/ui/Tag'
import type { StockSnapshotPayload } from '../../types/api'
import {
  deriveQuickCheckupCards,
  type QuickCheckupTargetTab,
  type QuickCheckupTone,
} from './stockHelpers'

const TONE_TAG_COLOR: Record<QuickCheckupTone, 'green' | 'amber' | 'rose' | 'blue'> = {
  signal: 'green',
  amber: 'amber',
  danger: 'rose',
  cobalt: 'blue',
}

export type StockQuickSummaryCardProps = {
  snapshot: StockSnapshotPayload
  onSwitchTab: (tab: QuickCheckupTargetTab) => void
}

export function StockQuickSummaryCard({ snapshot, onSwitchTab }: StockQuickSummaryCardProps) {
  const cards = useMemo(() => deriveQuickCheckupCards(snapshot), [snapshot])

  return (
    <Card
      title="30 秒小白体检卡"
      extra={<span className="small muted">先看三大核心结论，再按需下钻细分页</span>}
    >
      <div className="quick-checkup-grid" role="region" aria-label="30 秒小白体检卡">
        {cards.map((card) => (
          <article key={card.id} className="quick-checkup-card" data-tone={card.tone}>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <strong className="small">{card.question}</strong>
              <Tag color={TONE_TAG_COLOR[card.tone]}>{card.statusLabel}</Tag>
            </div>
            <p className="small soft" style={{ margin: 0, flex: '1 1 auto' }}>
              {card.verdict}
            </p>
            <div className="row" style={{ justifyContent: 'flex-start' }}>
              <button
                type="button"
                className="btn-ghost"
                onClick={() => onSwitchTab(card.targetTab)}
              >
                {card.ctaLabel}
              </button>
            </div>
          </article>
        ))}
      </div>
    </Card>
  )
}
