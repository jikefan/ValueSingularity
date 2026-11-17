import type { ReactNode } from 'react'

type TagColor = 'gray' | 'green' | 'blue' | 'amber' | 'rose'

export function Tag({ color = 'gray', children }: { color?: TagColor; children: ReactNode }) {
  return <span className={`tag tag-${color}`}>{children}</span>
}
