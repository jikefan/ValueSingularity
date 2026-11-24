import { Tag } from './Tag'

export type GuestPreviewItem = {
  id: string
  badge: string
  badgeColor: 'green' | 'blue' | 'amber' | 'gray'
  title: string
  metrics: readonly string[]
  description: string
}

export function GuestPreviewGrid({
  items,
  subtitle = '能力示例预览 · 登录后使用实时个人数据',
}: {
  items: readonly GuestPreviewItem[]
  subtitle?: string
}) {
  return (
    <section className="guest-preview-section" aria-label="能力示例预览">
      <div className="guest-preview-header">
        <span className="eyebrow-pill">
          <span className="live-beacon" />
          功能预览
        </span>
        <span className="small muted">{subtitle}</span>
      </div>

      <div className="guest-preview-grid">
        {items.map((item) => (
          <article key={item.id} className="card-machined guest-preview-card">
            <div className="row" style={{ gap: 8 }}>
              <strong className="small">{item.title}</strong>
              <Tag color={item.badgeColor}>{item.badge}</Tag>
            </div>
            <div className="sentinel-list">
              {item.metrics.map((metric) => (
                <span key={metric} className="code-pill guest-preview-pill">
                  {metric}
                </span>
              ))}
            </div>
            <p className="small muted">{item.description}</p>
          </article>
        ))}
      </div>
    </section>
  )
}
