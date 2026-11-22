import { Link } from 'react-router-dom'
import { fmtDateTime, fmtNum } from '../../lib/format'
import { JOURNAL_ACTION_META } from '../../lib/journalLabels'
import type { JournalEntryItem } from '../../types/api'
import { Tag } from './Tag'

type JournalEntryCardProps = {
  entry: JournalEntryItem
  showStockLink?: boolean
  isDeleting?: boolean
  onDelete: (entryId: number) => void
}

const FALSIFY_OP_LABEL: Record<string, string> = {
  lt: '<',
  lte: '≤',
  gt: '>',
  gte: '≥',
  eq: '=',
}

export function JournalEntryCard({
  entry,
  showStockLink = false,
  isDeleting = false,
  onDelete,
}: JournalEntryCardProps) {
  const meta = JOURNAL_ACTION_META[entry.action]
  const rules = entry.falsify_rules ?? []
  const hasOptionalMeta =
    (entry.price !== null && entry.price !== undefined) ||
    (entry.max_drawdown !== null && entry.max_drawdown !== undefined) ||
    Boolean(entry.emotion) ||
    rules.length > 0

  return (
    <article className="journal-item">
      <div className="journal-item-header">
        <div className="journal-item-title">
          {showStockLink ? (
            <>
              <Link className="mono link-accent" to={`/stock/${entry.code}`}>
                {entry.code}
              </Link>
              {entry.name ? <strong>{entry.name}</strong> : null}
            </>
          ) : null}
          <Tag color={meta.color}>{meta.label}</Tag>
          <span className="small muted mono">{fmtDateTime(entry.created_at)}</span>
        </div>
        <button
          type="button"
          className="btn-danger"
          disabled={isDeleting}
          onClick={() => onDelete(entry.id)}
        >
          删除日记
        </button>
      </div>

      <div className="journal-item-body">
        <div>
          <span className="journal-field-label">投资理由</span>
          <span>{entry.reason}</span>
        </div>
        <div>
          <span className="journal-field-label">否证条件</span>
          <span className="soft">{entry.falsify_condition}</span>
        </div>
      </div>

      {hasOptionalMeta ? (
        <div className="journal-meta-row">
          {entry.price !== null && entry.price !== undefined ? (
            <Tag color="blue">价格 {fmtNum(entry.price, 2)}</Tag>
          ) : null}
          {entry.max_drawdown !== null && entry.max_drawdown !== undefined ? (
            <Tag color="gray">最大回撤 {fmtNum(entry.max_drawdown, 1)}%</Tag>
          ) : null}
          {entry.emotion ? <Tag color="gray">情绪：{entry.emotion}</Tag> : null}
          {rules.map((rule, index) => (
            <Tag key={`${rule.metric}-${rule.op}-${index}`} color="amber">
              {`规则：${rule.metric} ${FALSIFY_OP_LABEL[rule.op] ?? rule.op} ${rule.value}（连续 ${rule.periods} 期）`}
            </Tag>
          ))}
        </div>
      ) : null}
    </article>
  )
}
