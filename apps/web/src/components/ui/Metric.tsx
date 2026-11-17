import type { ReactNode } from 'react'

interface MetricProps {
  label: ReactNode
  value: ReactNode
  sub?: ReactNode
  tone?: 'up' | 'down' | 'flat' | ''
}

export function Metric({ label, value, sub, tone = '' }: MetricProps) {
  return (
    <div>
      <div className="metric-label">{label}</div>
      <div className={`metric-value ${tone}`}>{value}</div>
      {sub ? <div className="metric-sub">{sub}</div> : null}
    </div>
  )
}
