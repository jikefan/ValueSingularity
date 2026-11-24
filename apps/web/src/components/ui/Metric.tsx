import type { ReactNode } from 'react'
import type { GlossaryKey } from '../../lib/glossary'
import { GlossaryLabel } from './InfoHint'

interface MetricProps {
  label: ReactNode
  hint?: GlossaryKey
  value: ReactNode
  sub?: ReactNode
  tone?: 'up' | 'down' | 'flat' | 'tone-good' | 'tone-bad' | ''
}

export function Metric({ label, hint, value, sub, tone = '' }: MetricProps) {
  return (
    <div>
      <div className="metric-label">
        {hint ? <GlossaryLabel label={label} term={hint} /> : label}
      </div>
      <div className={`metric-value ${tone}`}>{value}</div>
      {sub ? <div className="metric-sub">{sub}</div> : null}
    </div>
  )
}
