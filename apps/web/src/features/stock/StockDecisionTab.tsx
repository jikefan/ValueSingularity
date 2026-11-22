import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Card } from '../../components/ui/Card'
import { JournalEntryCard } from '../../components/ui/JournalEntryCard'
import { EmptyBlock, ErrorBlock, LoadingBlock } from '../../components/ui/StateBlock'
import { Tag } from '../../components/ui/Tag'
import { useAuth } from '../../lib/authContext'
import { formatNum, formatPct, formatSignedPct } from '../../lib/format'
import { JOURNAL_ACTION_META } from '../../lib/journalLabels'
import { useCreateJournal, useJournal, useRemoveJournal } from '../../lib/useJournal'
import { parseOptionalNumber } from '../../lib/validation'
import type {
  JournalAction,
  JournalCreate,
  StockDetail,
  StockSnapshotPayload,
} from '../../types/api'

const ACTION_OPTIONS: JournalAction[] = ['buy', 'add', 'trim', 'sell', 'pass']

function isJournalAction(value: string): value is JournalAction {
  return (
    value === 'buy' || value === 'add' || value === 'trim' || value === 'sell' || value === 'pass'
  )
}

export function StockDecisionTab({
  stock,
  snapshot = null,
}: {
  stock: StockDetail
  snapshot?: StockSnapshotPayload | null
}) {
  const { user, isAuthLoading } = useAuth()
  const journalQuery = useJournal(stock.code, Boolean(user))
  const createJournal = useCreateJournal()
  const removeJournal = useRemoveJournal()

  const [action, setAction] = useState<JournalAction>('buy')
  const [reason, setReason] = useState('')
  const [falsifyCondition, setFalsifyCondition] = useState('')
  const [price, setPrice] = useState('')
  const [maxDrawdown, setMaxDrawdown] = useState('')
  const [emotion, setEmotion] = useState('')
  const [formError, setFormError] = useState<string | null>(null)

  function handleSubmit() {
    const trimmedReason = reason.trim()
    const trimmedFalsify = falsifyCondition.trim()
    const trimmedEmotion = emotion.trim()

    if (!trimmedReason) {
      setFormError('请填写投资理由')
      return
    }
    if (trimmedReason.length > 5000) {
      setFormError('投资理由不能超过 5000 个字符')
      return
    }
    if (!trimmedFalsify) {
      setFormError('请填写否证条件')
      return
    }
    if (trimmedFalsify.length > 5000) {
      setFormError('否证条件不能超过 5000 个字符')
      return
    }
    if (trimmedEmotion.length > 32) {
      setFormError('当前情绪不能超过 32 个字符')
      return
    }

    const parsedPrice = parseOptionalNumber(price, '参考价格', {
      min: 0.001,
      max: 999_999_999.999,
    })
    if (!parsedPrice.ok) {
      setFormError(parsedPrice.error)
      return
    }

    const parsedDrawdown = parseOptionalNumber(maxDrawdown, '最大可承受回撤', {
      min: 0,
      max: 100,
    })
    if (!parsedDrawdown.ok) {
      setFormError(parsedDrawdown.error)
      return
    }

    setFormError(null)
    const payload: JournalCreate = {
      code: stock.code,
      name: stock.name,
      action,
      reason: trimmedReason,
      falsify_condition: trimmedFalsify,
      price: parsedPrice.value,
      max_drawdown: parsedDrawdown.value,
      emotion: trimmedEmotion || null,
      benchmark_code: '000300',
    }

    createJournal.mutate(payload, {
      onSuccess: () => {
        setReason('')
        setFalsifyCondition('')
        setPrice('')
        setMaxDrawdown('')
        setEmotion('')
      },
    })
  }

  const valuationAnchorStrip = snapshot ? (
    <div className="decision-anchor-bar">
      <span className="small muted">实时估值参考锚点：</span>
      <Tag color="blue">{`最新价 ${formatNum(snapshot.valuation.close, 2)}`}</Tag>
      <Tag color="gray">{`PE(TTM) ${formatNum(snapshot.valuation.pe_ttm, 2)} · 10Y 分位 ${formatPct(snapshot.valuation.pe_percentile_10y, 1)}`}</Tag>
      <Tag color="green">
        {snapshot.reverse_dcf.solvable
          ? `隐含 FCF 增速 ${formatSignedPct(snapshot.reverse_dcf.implied_fcf_cagr_pct, 2)}`
          : '隐含 FCF 增速不可求解'}
      </Tag>
      <Tag color="amber">{`雷达评分 ${snapshot.radar.total_score}/100`}</Tag>
    </div>
  ) : null

  if (isAuthLoading) {
    return (
      <Card title="投资决策日记">
        {valuationAnchorStrip}
        <LoadingBlock lines={3} />
      </Card>
    )
  }

  if (!user) {
    return (
      <Card title="投资决策日记" extra={<Tag color="gray">未登录</Tag>}>
        <div className="stack" style={{ gap: 12 }}>
          {valuationAnchorStrip}
          <EmptyBlock
            title="登录后记录你的投资决策与否证红线"
            hint={
              <Link
                className="btn-primary mt-16"
                to="/login"
                state={{ from: `/stock/${stock.code}` }}
              >
                前往登录 / 注册
              </Link>
            }
          />
        </div>
      </Card>
    )
  }

  const mutationError = createJournal.isError
    ? createJournal.error instanceof Error
      ? createJournal.error.message
      : '记录保存失败，请稍后重试'
    : null
  const activeError = formError ?? mutationError

  const removeError = removeJournal.isError
    ? removeJournal.error instanceof Error
      ? removeJournal.error.message
      : '删除失败，请稍后重试'
    : null

  return (
    <div className="stack" style={{ gap: 16 }}>
      {valuationAnchorStrip}

      <Card title={`新建决策记录 · ${stock.name}`} extra={<Tag color="green">强制写否证红线</Tag>}>
        <form
          className="stack"
          noValidate
          onSubmit={(event) => {
            event.preventDefault()
            handleSubmit()
          }}
        >
          <div className="form-grid">
            <div className="field">
              <label htmlFor="journal-action">决策动作</label>
              <select
                id="journal-action"
                className="input"
                value={action}
                onChange={(event) => {
                  const next = event.target.value
                  if (isJournalAction(next)) {
                    setAction(next)
                  }
                }}
              >
                {ACTION_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {JOURNAL_ACTION_META[option].label}
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label htmlFor="journal-emotion">当前情绪</label>
              <input
                id="journal-emotion"
                className="input"
                type="text"
                maxLength={32}
                placeholder="例如 冷静 / 贪婪 / 谨慎（可选）"
                value={emotion}
                onChange={(event) => setEmotion(event.target.value)}
              />
            </div>

            <div className="field">
              <div className="row">
                <label htmlFor="journal-price">参考价格（元）</label>
                {snapshot?.valuation.close !== null && snapshot?.valuation.close !== undefined ? (
                  <button
                    type="button"
                    className="link-accent small"
                    style={{ background: 'none', border: 'none', padding: 0 }}
                    onClick={() => {
                      const latestClose = snapshot.valuation.close
                      if (latestClose !== null && latestClose !== undefined) {
                        setPrice(String(latestClose))
                      }
                    }}
                  >
                    填入收盘价 {formatNum(snapshot.valuation.close, 2)}
                  </button>
                ) : null}
              </div>
              <input
                id="journal-price"
                className="input mono"
                type="number"
                step="0.001"
                min="0.001"
                max="999999999.999"
                placeholder="例如 1450（可选）"
                value={price}
                onChange={(event) => setPrice(event.target.value)}
              />
            </div>

            <div className="field">
              <label htmlFor="journal-drawdown">最大可承受回撤（%）</label>
              <input
                id="journal-drawdown"
                className="input mono"
                type="number"
                step="0.1"
                min="0"
                max="100"
                placeholder="0 – 100（可选）"
                value={maxDrawdown}
                onChange={(event) => setMaxDrawdown(event.target.value)}
              />
            </div>

            <div className="field field-full">
              <label htmlFor="journal-reason">投资理由</label>
              <textarea
                id="journal-reason"
                className="input textarea"
                maxLength={5000}
                placeholder="写下估值锚点、护城河变化或放弃买入的原因（必填）"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </div>

            <div className="field field-full">
              <label htmlFor="journal-falsify">否证条件</label>
              <textarea
                id="journal-falsify"
                className="input textarea"
                maxLength={5000}
                placeholder="明确什么变化会证伪当前判断，例如：连续两季现金流转负（必填）"
                value={falsifyCondition}
                onChange={(event) => setFalsifyCondition(event.target.value)}
              />
            </div>
          </div>

          <div className="form-actions">
            <button type="submit" className="btn-primary" disabled={createJournal.isPending}>
              {createJournal.isPending ? '保存中...' : '记录决策'}
            </button>
          </div>

          {activeError ? (
            <div className="inline-error" role="alert">
              {activeError}
            </div>
          ) : null}
        </form>
      </Card>

      <Card
        title={`${stock.code} 历史决策日记`}
        extra={
          journalQuery.data ? (
            <span className="small muted mono">{journalQuery.data.length} 条记录</span>
          ) : null
        }
      >
        {removeError ? (
          <div className="inline-error" style={{ marginBottom: 12 }} role="alert">
            {removeError}
          </div>
        ) : null}

        {journalQuery.isPending || (!journalQuery.data && journalQuery.isFetching) ? (
          <LoadingBlock lines={3} />
        ) : journalQuery.isError ? (
          <ErrorBlock
            title="决策日记加载失败"
            message={journalQuery.error instanceof Error ? journalQuery.error.message : '未知错误'}
            onRetry={() => {
              void journalQuery.refetch()
            }}
          />
        ) : !journalQuery.data || journalQuery.data.length === 0 ? (
          <EmptyBlock
            title="暂无该标的决策记录"
            hint="在上方写下本次买入、卖出或 Pass 的理由与否证条件。"
          />
        ) : (
          <div className="journal-list">
            {journalQuery.data.map((entry) => (
              <JournalEntryCard
                key={entry.id}
                entry={entry}
                isDeleting={removeJournal.isPending && removeJournal.variables === entry.id}
                onDelete={(entryId) => removeJournal.mutate(entryId)}
              />
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}
