import type { ReactNode } from 'react'

export function LoadingBlock({ lines = 4 }: { lines?: number }) {
  return (
    <div className="stack" aria-busy="true" aria-label="加载中">
      {Array.from({ length: lines }, (_, index) => (
        <div key={index} className="skeleton" style={{ width: `${100 - index * 8}%` }} />
      ))}
    </div>
  )
}

export function EmptyBlock({ title, hint }: { title: string; hint?: ReactNode }) {
  return (
    <div className="state">
      <p>{title}</p>
      {hint ? <p className="small mt-8">{hint}</p> : null}
    </div>
  )
}

export function ErrorBlock({
  title,
  message,
  onRetry,
}: {
  title: string
  message: string
  onRetry?: () => void
}) {
  return (
    <div className="state">
      <p style={{ color: 'var(--rose)' }}>{title}</p>
      <p className="small mt-8">{message}</p>
      {onRetry ? (
        <button type="button" className="retry-btn mt-16" onClick={onRetry}>
          重试
        </button>
      ) : null}
    </div>
  )
}
