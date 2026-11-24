import type { ReactNode } from 'react'
import type { GlossaryKey } from '../../lib/glossary'
import { GlossaryLabel } from './InfoHint'

interface CardProps {
  title?: ReactNode
  hint?: GlossaryKey
  extra?: ReactNode
  className?: string
  children: ReactNode
}

export function Card({ title, hint, extra, className, children }: CardProps) {
  return (
    <section className={className ? `card ${className}` : 'card'}>
      {title ? (
        <div className="card-title">
          {hint ? <GlossaryLabel label={title} term={hint} /> : <span>{title}</span>}
          {extra}
        </div>
      ) : null}
      {children}
    </section>
  )
}
