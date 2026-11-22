import { Link } from 'react-router-dom'
import { fmtDateTime, fmtNum } from '../../lib/format'
import {
  FALSIFY_OP_LABEL,
  getFalsifyMetricLabel,
  JOURNAL_ACTION_META,
} from '../../lib/journalLabels'
import type { JournalEntryItem } from '../../types/api'
import { Tag } from './Tag'

type JournalEntryCardProps = {
  entry: JournalEntryItem
  showStockLink?: boolean
  isDeleting?: boolean
  onDelete: (entryId: number) => void
}

function hasFiniteNumber(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isFinite(value)
}

export function JournalEntryCard({
  entry,
  showStockLink = false,
  isDeleting = false,
  onDelete,
}: JournalEntryCardProps) {
  const meta = JOURNAL_ACTION_META[entry.action]
  const rules = entry.falsify_rules ?? []
  const snapshot = entry.snapshot ?? null
  const hasOptionalMeta =
    hasFiniteNumber(entry.price) ||
    hasFiniteNumber(entry.max_drawdown) ||
    Boolean(entry.emotion) ||
    rules.length > 0
  const hasSnapshotTags =
    snapshot !== null &&
    (hasFiniteNumber(snapshot.close) ||
      hasFiniteNumber(snapshot.pe_ttm) ||
      hasFiniteNumber(snapshot.pe_percentile_10y) ||
      hasFiniteNumber(snapshot.total_score) ||
      hasFiniteNumber(snapshot.benchmark_price))

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
          {hasFiniteNumber(entry.price) ? (
            <Tag color="blue">价格 {fmtNum(entry.price, 2)}</Tag>
          ) : null}
          {hasFiniteNumber(entry.max_drawdown) ? (
            <Tag color="gray">最大回撤 {fmtNum(entry.max_drawdown, 1)}%</Tag>
          ) : null}
          {entry.emotion ? <Tag color="gray">情绪：{entry.emotion}</Tag> : null}
          {rules.map((rule, index) => (
            <Tag key={`${rule.metric}-${rule.op}-${index}`} color="amber">
              {`规则：${getFalsifyMetricLabel(rule.metric)} ${FALSIFY_OP_LABEL[rule.op] ?? rule.op} ${rule.value}（连续 ${rule.periods} 期）`}
            </Tag>
          ))}
        </div>
      ) : null}

      {snapshot && hasSnapshotTags ? (
        <div className="journal-capsule-row">
          <span className="journal-field-label">
            时间胶囊{snapshot.as_of ? ` (${snapshot.as_of})` : ''}
          </span>
          {hasFiniteNumber(snapshot.close) ? (
            <Tag color="gray">{`快照价 ${fmtNum(snapshot.close, 2)}`}</Tag>
          ) : null}
          {hasFiniteNumber(snapshot.pe_ttm) ? (
            <Tag color="blue">{`快照 PE ${fmtNum(snapshot.pe_ttm, 2)}`}</Tag>
          ) : null}
          {hasFiniteNumber(snapshot.pe_percentile_10y) ? (
            <Tag color="gray">{`分位 ${fmtNum(snapshot.pe_percentile_10y, 1)}%`}</Tag>
          ) : null}
          {hasFiniteNumber(snapshot.total_score) ? (
            <Tag color="green">{`评分 ${snapshot.total_score}`}</Tag>
          ) : null}
          {hasFiniteNumber(snapshot.benchmark_price) ? (
            <Tag color="gray">
              {`沪深300 ${fmtNum(snapshot.benchmark_price, 2)}${snapshot.benchmark_as_of && snapshot.benchmark_as_of !== snapshot.as_of ? ` (${snapshot.benchmark_as_of})` : ''}`}
            </Tag>
          ) : null}
        </div>
      ) : null}
    </article>
  )
}
