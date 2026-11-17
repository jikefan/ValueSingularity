import type { ReactNode } from 'react'

interface CardProps {
  title?: ReactNode
  extra?: ReactNode
  className?: string
  children: ReactNode
}

export function Card({ title, extra, className, children }: CardProps) {
  return (
    <section className={className ? `card ${className}` : 'card'}>
      {title ? (
        <div className="card-title">
          <span>{title}</span>
          {extra}
        </div>
      ) : null}
      {children}
    </section>
  )
}
