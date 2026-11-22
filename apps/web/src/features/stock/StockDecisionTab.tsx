import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Card } from '../../components/ui/Card'
import { JournalEntryCard } from '../../components/ui/JournalEntryCard'
import { EmptyBlock, ErrorBlock, LoadingBlock } from '../../components/ui/StateBlock'
import { Tag } from '../../components/ui/Tag'
import { useAuth } from '../../lib/authContext'
import { formatNum, formatPct, formatSignedPct } from '../../lib/format'
import {
  FALSIFY_METRIC_OPTIONS,
  FALSIFY_OP_OPTIONS,
  FALSIFY_RULE_PRESETS,
  isMultiPeriodFalsifyMetric,
  JOURNAL_ACTION_META,
  JOURNAL_EMOTION_PRESETS,
  type FalsifyOp,
} from '../../lib/journalLabels'
import { useCreateJournal, useJournal, useRemoveJournal } from '../../lib/useJournal'
import { parseOptionalNumber } from '../../lib/validation'
import type {
  FalsifyRule,
  JournalAction,
  JournalCreate,
  StockDetail,
  StockSnapshotPayload,
} from '../../types/api'

const ACTION_OPTIONS: JournalAction[] = ['buy', 'add', 'trim', 'sell', 'pass']
const MAX_FALSIFY_RULES = 5

type FalsifyRuleDraft = {
  id: number
  metric: string
  op: FalsifyOp
  value: string
  periods: string
}

function isJournalAction(value: string): value is JournalAction {
  return (
    value === 'buy' || value === 'add' || value === 'trim' || value === 'sell' || value === 'pass'
  )
}

function isFalsifyOp(value: string): value is FalsifyOp {
  return value === 'lt' || value === 'lte' || value === 'gt' || value === 'gte' || value === 'eq'
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

  const nextRuleIdRef = useRef(1)
  const [action, setAction] = useState<JournalAction>('buy')
  const [reason, setReason] = useState('')
  const [falsifyCondition, setFalsifyCondition] = useState('')
  const [price, setPrice] = useState('')
  const [maxDrawdown, setMaxDrawdown] = useState('')
  const [emotion, setEmotion] = useState('')
  const [ruleDrafts, setRuleDrafts] = useState<FalsifyRuleDraft[]>([])
  const [formError, setFormError] = useState<string | null>(null)

  function addRuleDraft(initial?: FalsifyRule) {
    setRuleDrafts((prev) => {
      if (prev.length >= MAX_FALSIFY_RULES) {
        return prev
      }
      const id = nextRuleIdRef.current
      nextRuleIdRef.current += 1
      const metric = initial?.metric ?? 'pe_ttm'
      const supportsMultiPeriod = isMultiPeriodFalsifyMetric(metric)
      return [
        ...prev,
        {
          id,
          metric,
          op: initial?.op ?? 'gte',
          value: initial !== undefined ? String(initial.value) : '',
          periods: supportsMultiPeriod && initial !== undefined ? String(initial.periods) : '1',
        },
      ]
    })
  }

  function updateRuleDraft(id: number, patch: Partial<Omit<FalsifyRuleDraft, 'id'>>) {
    setRuleDrafts((prev) => prev.map((draft) => (draft.id === id ? { ...draft, ...patch } : draft)))
  }

  function removeRuleDraft(id: number) {
    setRuleDrafts((prev) => prev.filter((draft) => draft.id !== id))
  }

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

    const parsedRules: FalsifyRule[] = []
    for (let idx = 0; idx < ruleDrafts.length; idx += 1) {
      const draft = ruleDrafts[idx]
      if (!draft) {
        continue
      }
      const metric = draft.metric.trim()
      if (!metric || metric.length > 64) {
        setFormError(`第 ${idx + 1} 条否证规则指标无效`)
        return
      }
      if (!draft.value.trim()) {
        setFormError(`请填写第 ${idx + 1} 条否证规则的阈值`)
        return
      }
      const parsedValue = parseOptionalNumber(draft.value, `第 ${idx + 1} 条规则阈值`, {
        min: -1e12,
        max: 1e12,
      })
      if (!parsedValue.ok || parsedValue.value === null) {
        setFormError(parsedValue.ok ? `请填写第 ${idx + 1} 条否证规则的阈值` : parsedValue.error)
        return
      }
      const supportsMultiPeriod = isMultiPeriodFalsifyMetric(metric)
      let periodsValue = 1
      if (supportsMultiPeriod) {
        if (!draft.periods.trim()) {
          setFormError(`请填写第 ${idx + 1} 条否证规则的连续期数`)
          return
        }
        const parsedPeriods = parseOptionalNumber(draft.periods, `第 ${idx + 1} 条规则连续期数`, {
          min: 1,
          max: 10,
        })
        if (
          !parsedPeriods.ok ||
          parsedPeriods.value === null ||
          !Number.isInteger(parsedPeriods.value)
        ) {
          setFormError(
            parsedPeriods.ok ? `第 ${idx + 1} 条规则连续期数须为 1–10 的整数` : parsedPeriods.error,
          )
          return
        }
        periodsValue = parsedPeriods.value
      }
      parsedRules.push({
        metric,
        op: draft.op,
        value: parsedValue.value,
        periods: periodsValue,
      })
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
      ...(parsedRules.length > 0 ? { falsify_rules: parsedRules } : {}),
    }

    createJournal.mutate(payload, {
      onSuccess: () => {
        setReason('')
        setFalsifyCondition('')
        setPrice('')
        setMaxDrawdown('')
        setEmotion('')
        setRuleDrafts([])
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

  const dividendYieldPct = snapshot
    ? (snapshot.valuation.dividend_yield_pct ??
      snapshot.shareholder_return.current_dividend_yield_pct)
    : null

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
          {snapshot ? (
            <div className="notice-box decision-capsule-hint">
              <strong>时间胶囊将自动留存：</strong>
              <span>
                {`股价 ${formatNum(snapshot.valuation.close, 2)} · PE(TTM) ${formatNum(snapshot.valuation.pe_ttm, 2)} · 股息率 ${formatPct(dividendYieldPct, 2)} · 雷达评分 ${snapshot.radar.total_score}/100（及沪深 300 基准点位）`}
              </span>
            </div>
          ) : null}

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
              <div className="emotion-chips" role="group" aria-label="快捷情绪标签">
                {JOURNAL_EMOTION_PRESETS.map((preset) => {
                  const active = emotion.trim() === preset
                  return (
                    <button
                      key={preset}
                      type="button"
                      aria-pressed={active}
                      className={active ? 'filter-pill active' : 'filter-pill'}
                      onClick={() => setEmotion(active ? '' : preset)}
                    >
                      {preset}
                    </button>
                  )
                })}
              </div>
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

            <div className="field field-full">
              <div className="falsify-builder">
                <div className="falsify-builder-head">
                  <span className="small soft">
                    量化否证红线构建器（可选 · {ruleDrafts.length}/{MAX_FALSIFY_RULES}）
                  </span>
                  <div className="falsify-preset-row">
                    {FALSIFY_RULE_PRESETS.map((preset) => (
                      <button
                        key={preset.label}
                        type="button"
                        className="btn-ghost"
                        disabled={ruleDrafts.length >= MAX_FALSIFY_RULES}
                        onClick={() => addRuleDraft(preset.rule)}
                      >
                        + {preset.label}
                      </button>
                    ))}
                    <button
                      type="button"
                      className="btn-ghost"
                      disabled={ruleDrafts.length >= MAX_FALSIFY_RULES}
                      onClick={() => addRuleDraft()}
                    >
                      + 自定义规则
                    </button>
                  </div>
                </div>

                {ruleDrafts.length > 0 ? (
                  <div className="falsify-rule-list">
                    {ruleDrafts.map((draft, index) => {
                      const supportsMultiPeriod = isMultiPeriodFalsifyMetric(draft.metric)
                      return (
                        <div key={draft.id} className="stack" style={{ gap: 4 }}>
                          <div className="falsify-rule-row">
                            <select
                              aria-label={`规则 ${index + 1} 指标`}
                              className="input"
                              value={draft.metric}
                              onChange={(event) => {
                                const nextMetric = event.target.value
                                updateRuleDraft(draft.id, {
                                  metric: nextMetric,
                                  ...(isMultiPeriodFalsifyMetric(nextMetric)
                                    ? {}
                                    : { periods: '1' }),
                                })
                              }}
                            >
                              {FALSIFY_METRIC_OPTIONS.map((opt) => (
                                <option key={opt.value} value={opt.value}>
                                  {opt.unit ? `${opt.label} (${opt.unit})` : opt.label}
                                </option>
                              ))}
                            </select>

                            <select
                              aria-label={`规则 ${index + 1} 条件`}
                              className="input mono"
                              value={draft.op}
                              onChange={(event) => {
                                const next = event.target.value
                                if (isFalsifyOp(next)) {
                                  updateRuleDraft(draft.id, { op: next })
                                }
                              }}
                            >
                              {FALSIFY_OP_OPTIONS.map((opt) => (
                                <option key={opt.value} value={opt.value}>
                                  {opt.label}
                                </option>
                              ))}
                            </select>

                            <input
                              aria-label={`规则 ${index + 1} 阈值`}
                              className="input mono"
                              type="number"
                              step="any"
                              placeholder="阈值"
                              value={draft.value}
                              onChange={(event) =>
                                updateRuleDraft(draft.id, { value: event.target.value })
                              }
                            />

                            <div className="falsify-periods-wrap">
                              <input
                                aria-label={`规则 ${index + 1} 连续期数`}
                                className="input mono"
                                type="number"
                                min={1}
                                max={10}
                                step={1}
                                disabled={!supportsMultiPeriod}
                                title={
                                  supportsMultiPeriod ? undefined : '当期快照指标按最新 1 期判定'
                                }
                                value={supportsMultiPeriod ? draft.periods : '1'}
                                onChange={(event) =>
                                  updateRuleDraft(draft.id, { periods: event.target.value })
                                }
                              />
                              <span className="small muted">期</span>
                            </div>

                            <button
                              type="button"
                              className="btn-danger"
                              aria-label={`移除规则 ${index + 1}`}
                              onClick={() => removeRuleDraft(draft.id)}
                            >
                              移除
                            </button>
                          </div>
                          {!supportsMultiPeriod ? (
                            <span className="small muted">当期快照指标按最新 1 期判定</span>
                          ) : null}
                        </div>
                      )
                    })}
                  </div>
                ) : (
                  <p className="small muted">
                    添加结构化量化条件后，哨兵雷达可在指标触及红线时自动发出否证提醒。
                  </p>
                )}
              </div>
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
