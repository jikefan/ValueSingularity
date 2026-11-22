import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { AiCompanionControls } from '../../components/ui/AiCompanionControls'
import { Card } from '../../components/ui/Card'
import { JournalEntryCard } from '../../components/ui/JournalEntryCard'
import { EmptyBlock, ErrorBlock, LoadingBlock } from '../../components/ui/StateBlock'
import { Tag } from '../../components/ui/Tag'
import {
  AI_EXECUTION_MODE_META,
  formatFalsifyRuleLine,
  getAiSourceSectionLabel,
  type AiRequestMode,
} from '../../lib/aiLabels'
import { getAuthEpoch } from '../../lib/api'
import { useAuth } from '../../lib/authContext'
import { formatNum, formatPct, formatSignedPct } from '../../lib/format'
import {
  canonicalizeFalsifyMetric,
  FALSIFY_METRIC_OPTIONS,
  FALSIFY_OP_OPTIONS,
  FALSIFY_RULE_PRESETS,
  getFalsifyMetricLabel,
  isMultiPeriodFalsifyMetric,
  JOURNAL_ACTION_META,
  JOURNAL_EMOTION_PRESETS,
  type FalsifyOp,
} from '../../lib/journalLabels'
import {
  clearCachedDevilsAdvocate,
  useAiPreferences,
  useCachedDevilsAdvocate,
  useDevilsAdvocate,
} from '../../lib/useAi'
import { useCreateJournal, useJournal, useRemoveJournal } from '../../lib/useJournal'
import { parseOptionalNumber } from '../../lib/validation'
import type {
  FalsifyRule,
  JournalAction,
  JournalCreate,
  StockDetail,
  StockSnapshotPayload,
  UserProfile,
} from '../../types/api'

const ACTION_OPTIONS: JournalAction[] = ['buy', 'add', 'trim', 'sell', 'pass']
const MAX_FALSIFY_RULES = 5
const MAX_FALSIFY_PERIODS = 40

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

function normalizeSuggestedFalsifyRule(rule: FalsifyRule): FalsifyRule {
  const canonicalMetric = canonicalizeFalsifyMetric(rule.metric) || rule.metric.trim()
  const normalizedPeriods = isMultiPeriodFalsifyMetric(canonicalMetric)
    ? Math.min(MAX_FALSIFY_PERIODS, Math.max(1, Math.trunc(rule.periods) || 1))
    : 1
  return {
    metric: canonicalMetric,
    op: rule.op,
    value: rule.value,
    periods: normalizedPeriods,
  }
}

function isRuleMatchingDraft(draft: FalsifyRuleDraft, rule: FalsifyRule): boolean {
  const trimmedValue = draft.value.trim()
  if (!trimmedValue) {
    return false
  }
  const canonicalDraftMetric = canonicalizeFalsifyMetric(draft.metric)
  const canonicalRuleMetric = canonicalizeFalsifyMetric(rule.metric)
  const expectedPeriods = isMultiPeriodFalsifyMetric(canonicalRuleMetric)
    ? Math.min(MAX_FALSIFY_PERIODS, Math.max(1, Math.trunc(rule.periods) || 1))
    : 1
  return (
    canonicalDraftMetric === canonicalRuleMetric &&
    draft.op === rule.op &&
    Number(trimmedValue) === rule.value &&
    Number(draft.periods) === expectedPeriods
  )
}

function buildValuationAnchorStrip(snapshot: StockSnapshotPayload | null) {
  if (!snapshot) {
    return null
  }
  return (
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
  )
}

function StockDecisionTabContent({
  stock,
  snapshot,
  user,
}: {
  stock: StockDetail
  snapshot: StockSnapshotPayload | null
  user: UserProfile
}) {
  const queryClient = useQueryClient()
  const journalQuery = useJournal(stock.code, true)
  const aiPrefsQuery = useAiPreferences(true)
  const cachedDaQuery = useCachedDevilsAdvocate(user.id, stock.code)
  const devilsAdvocate = useDevilsAdvocate()
  const createJournal = useCreateJournal()
  const removeJournal = useRemoveJournal()

  const nextRuleIdRef = useRef(1)
  const gateRunDaButtonRef = useRef<HTMLButtonElement | null>(null)
  const [action, setAction] = useState<JournalAction>('buy')
  const [reason, setReason] = useState('')
  const [falsifyCondition, setFalsifyCondition] = useState('')
  const [price, setPrice] = useState('')
  const [maxDrawdown, setMaxDrawdown] = useState('')
  const [emotion, setEmotion] = useState('')
  const [ruleDrafts, setRuleDrafts] = useState<FalsifyRuleDraft[]>([])
  const [formError, setFormError] = useState<string | null>(null)
  const [daModeOverride, setDaModeOverride] = useState<AiRequestMode | null>(null)
  const [lastReviewedDraftKey, setLastReviewedDraftKey] = useState<string | null>(null)
  const [daValidationError, setDaValidationError] = useState<string | null>(null)
  const [showBuyGate, setShowBuyGate] = useState(false)

  const isBuyOrAddAction = action === 'buy' || action === 'add'
  const isBusy = createJournal.isPending || devilsAdvocate.isPending
  const effectiveDaMode: AiRequestMode =
    daModeOverride ?? (aiPrefsQuery.data?.prefer_rule_only ? 'rule_only' : 'auto')
  const currentDraftKey = `${stock.code}:${action}:${reason.trim()}`
  const rawDaResult =
    cachedDaQuery.data ??
    (devilsAdvocate.data && devilsAdvocate.data.code === stock.code ? devilsAdvocate.data : null)
  const daResult = rawDaResult && rawDaResult.code === stock.code ? rawDaResult : null
  const hasReviewedCurrentDraft =
    lastReviewedDraftKey !== null && lastReviewedDraftKey === currentDraftKey && daResult !== null
  const activeQuota = aiPrefsQuery.data?.quota ?? daResult?.quota ?? null
  const isRuleLimitReached = ruleDrafts.length >= MAX_FALSIFY_RULES

  useEffect(() => {
    if (showBuyGate && isBuyOrAddAction) {
      gateRunDaButtonRef.current?.focus()
    }
  }, [showBuyGate, isBuyOrAddAction])

  function clearCreateErrorOnEdit() {
    setFormError(null)
    if (createJournal.isError) {
      createJournal.reset()
    }
  }

  function clearDaErrorOnEdit() {
    setDaValidationError(null)
    if (devilsAdvocate.isError) {
      devilsAdvocate.reset()
    }
  }

  function addRuleDraft(initial?: FalsifyRule) {
    clearCreateErrorOnEdit()
    setRuleDrafts((prev) => {
      if (prev.length >= MAX_FALSIFY_RULES) {
        return prev
      }
      const id = nextRuleIdRef.current
      nextRuleIdRef.current += 1
      const metric = canonicalizeFalsifyMetric(initial?.metric ?? 'pe_ttm') || 'pe_ttm'
      const supportsMultiPeriod = isMultiPeriodFalsifyMetric(metric)
      const clampedPeriods =
        supportsMultiPeriod && initial !== undefined
          ? String(Math.min(MAX_FALSIFY_PERIODS, Math.max(1, Math.trunc(initial.periods) || 1)))
          : '1'
      return [
        ...prev,
        {
          id,
          metric,
          op: initial?.op ?? 'gte',
          value: initial !== undefined ? String(initial.value) : '',
          periods: clampedPeriods,
        },
      ]
    })
  }

  function updateRuleDraft(id: number, patch: Partial<Omit<FalsifyRuleDraft, 'id'>>) {
    clearCreateErrorOnEdit()
    setRuleDrafts((prev) => prev.map((draft) => (draft.id === id ? { ...draft, ...patch } : draft)))
  }

  function removeRuleDraft(id: number) {
    clearCreateErrorOnEdit()
    setRuleDrafts((prev) => prev.filter((draft) => draft.id !== id))
  }

  function handleRunDevilsAdvocate(requestedModeOverride?: AiRequestMode) {
    if (isBusy) {
      return
    }
    const trimmedReason = reason.trim()
    const trimmedFalsify = falsifyCondition.trim()

    if (!trimmedReason) {
      setDaValidationError('请先填写投资理由，再运行买入前反方质询')
      return
    }
    if (trimmedReason.length > 5000) {
      setDaValidationError('投资理由不能超过 5000 个字符')
      return
    }
    if (trimmedFalsify.length > 5000) {
      setDaValidationError('否证条件不能超过 5000 个字符')
      return
    }

    setDaValidationError(null)
    const draftKey = `${stock.code}:${action}:${trimmedReason}`
    const startEpoch = getAuthEpoch()
    const requestMode = requestedModeOverride ?? effectiveDaMode

    devilsAdvocate.mutate(
      {
        code: stock.code,
        action,
        reason: trimmedReason,
        falsify_condition: trimmedFalsify,
        mode: requestMode,
      },
      {
        onSuccess: () => {
          if (getAuthEpoch() !== startEpoch) {
            return
          }
          setLastReviewedDraftKey(draftKey)
          setShowBuyGate(false)
        },
      },
    )
  }

  function handleSwitchRuleOnlyAndRetry() {
    if (isBusy) {
      return
    }
    setDaModeOverride('rule_only')
    devilsAdvocate.reset()
    handleRunDevilsAdvocate('rule_only')
  }

  function handleAdoptSuggestedRule(rule: FalsifyRule) {
    const normalizedRule = normalizeSuggestedFalsifyRule(rule)

    const alreadyAdopted = ruleDrafts.some((draft) => isRuleMatchingDraft(draft, normalizedRule))
    if (!alreadyAdopted) {
      if (ruleDrafts.length >= MAX_FALSIFY_RULES) {
        setFormError(`最多添加 ${MAX_FALSIFY_RULES} 条量化否证规则，请先移除已有规则再采纳`)
        return
      }
      addRuleDraft(normalizedRule)
    }

    if (!falsifyCondition.trim()) {
      setFalsifyCondition(formatFalsifyRuleLine(normalizedRule))
    }
    setFormError(null)
  }

  function validateAndBuildPayload(): JournalCreate | null {
    const trimmedReason = reason.trim()
    const trimmedFalsify = falsifyCondition.trim()
    const trimmedEmotion = emotion.trim()

    if (!trimmedReason) {
      setFormError('请填写投资理由')
      return null
    }
    if (trimmedReason.length > 5000) {
      setFormError('投资理由不能超过 5000 个字符')
      return null
    }
    if (!trimmedFalsify) {
      setFormError('请填写否证条件')
      return null
    }
    if (trimmedFalsify.length > 5000) {
      setFormError('否证条件不能超过 5000 个字符')
      return null
    }
    if (trimmedEmotion.length > 32) {
      setFormError('当前情绪不能超过 32 个字符')
      return null
    }

    const parsedPrice = parseOptionalNumber(price, '参考价格', {
      min: 0.001,
      max: 999_999_999.999,
    })
    if (!parsedPrice.ok) {
      setFormError(parsedPrice.error)
      return null
    }

    const parsedDrawdown = parseOptionalNumber(maxDrawdown, '最大可承受回撤', {
      min: 0,
      max: 100,
    })
    if (!parsedDrawdown.ok) {
      setFormError(parsedDrawdown.error)
      return null
    }

    const parsedRules: FalsifyRule[] = []
    for (let idx = 0; idx < ruleDrafts.length; idx += 1) {
      const draft = ruleDrafts[idx]
      if (!draft) {
        continue
      }
      const metric = canonicalizeFalsifyMetric(draft.metric) || draft.metric.trim()
      if (!metric || metric.length > 64) {
        setFormError(`第 ${idx + 1} 条否证规则指标无效`)
        return null
      }
      if (!draft.value.trim()) {
        setFormError(`请填写第 ${idx + 1} 条否证规则的阈值`)
        return null
      }
      const parsedValue = parseOptionalNumber(draft.value, `第 ${idx + 1} 条规则阈值`, {})
      if (!parsedValue.ok || parsedValue.value === null) {
        setFormError(parsedValue.ok ? `请填写第 ${idx + 1} 条否证规则的阈值` : parsedValue.error)
        return null
      }
      const supportsMultiPeriod = isMultiPeriodFalsifyMetric(metric)
      let periodsValue = 1
      if (supportsMultiPeriod) {
        if (!draft.periods.trim()) {
          setFormError(`请填写第 ${idx + 1} 条否证规则的连续期数`)
          return null
        }
        const parsedPeriods = parseOptionalNumber(draft.periods, `第 ${idx + 1} 条规则连续期数`, {
          min: 1,
          max: MAX_FALSIFY_PERIODS,
        })
        if (
          !parsedPeriods.ok ||
          parsedPeriods.value === null ||
          !Number.isInteger(parsedPeriods.value)
        ) {
          setFormError(
            parsedPeriods.ok
              ? `第 ${idx + 1} 条规则连续期数须为 1–${MAX_FALSIFY_PERIODS} 的整数`
              : parsedPeriods.error,
          )
          return null
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
    return {
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
  }

  function submitJournalPayload(payload: JournalCreate) {
    createJournal.mutate(payload, {
      onSuccess: () => {
        setReason('')
        setFalsifyCondition('')
        setPrice('')
        setMaxDrawdown('')
        setEmotion('')
        setRuleDrafts([])
        setShowBuyGate(false)
        setLastReviewedDraftKey(null)
        setDaValidationError(null)
        devilsAdvocate.reset()
        clearCachedDevilsAdvocate(queryClient, user.id, stock.code)
      },
    })
  }

  function handleSubmit() {
    if (isBusy) {
      return
    }
    const payload = validateAndBuildPayload()
    if (!payload) {
      return
    }
    if (isBuyOrAddAction && !hasReviewedCurrentDraft) {
      setShowBuyGate(true)
      return
    }
    submitJournalPayload(payload)
  }

  function handleSkipGateAndSubmit() {
    if (isBusy) {
      return
    }
    const payload = validateAndBuildPayload()
    if (!payload) {
      setShowBuyGate(false)
      return
    }
    setShowBuyGate(false)
    submitJournalPayload(payload)
  }

  const valuationAnchorStrip = buildValuationAnchorStrip(snapshot)
  const dividendYieldPct = snapshot
    ? (snapshot.valuation.dividend_yield_pct ??
      snapshot.shareholder_return.current_dividend_yield_pct)
    : null

  const mutationError = createJournal.isError
    ? createJournal.error instanceof Error
      ? createJournal.error.message
      : '记录保存失败，请稍后重试'
    : null
  const activeError = formError ?? mutationError
  const daMutationError = devilsAdvocate.isError
    ? devilsAdvocate.error instanceof Error
      ? devilsAdvocate.error.message
      : '反方质询运行失败，请稍后重试'
    : null
  const activeDaError = daValidationError ?? daMutationError
  const daModeMeta = daResult ? AI_EXECUTION_MODE_META[daResult.mode] : null

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
                    setShowBuyGate(false)
                    clearDaErrorOnEdit()
                    clearCreateErrorOnEdit()
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
                onChange={(event) => {
                  setEmotion(event.target.value)
                  clearCreateErrorOnEdit()
                }}
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
                      onClick={() => {
                        setEmotion(active ? '' : preset)
                        clearCreateErrorOnEdit()
                      }}
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
                        clearCreateErrorOnEdit()
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
                onChange={(event) => {
                  setPrice(event.target.value)
                  clearCreateErrorOnEdit()
                }}
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
                onChange={(event) => {
                  setMaxDrawdown(event.target.value)
                  clearCreateErrorOnEdit()
                }}
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
                onChange={(event) => {
                  setReason(event.target.value)
                  setShowBuyGate(false)
                  clearDaErrorOnEdit()
                  clearCreateErrorOnEdit()
                }}
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
                onChange={(event) => {
                  setFalsifyCondition(event.target.value)
                  clearDaErrorOnEdit()
                  clearCreateErrorOnEdit()
                }}
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
                        disabled={isRuleLimitReached}
                        onClick={() => addRuleDraft(preset.rule)}
                      >
                        + {preset.label}
                      </button>
                    ))}
                    <button
                      type="button"
                      className="btn-ghost"
                      disabled={isRuleLimitReached}
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
                      const canonicalMetric = canonicalizeFalsifyMetric(draft.metric)
                      const hasCanonicalOption = FALSIFY_METRIC_OPTIONS.some(
                        (opt) => opt.value === canonicalMetric,
                      )
                      return (
                        <div key={draft.id} className="stack" style={{ gap: 4 }}>
                          <div className="falsify-rule-row">
                            <select
                              aria-label={`规则 ${index + 1} 指标`}
                              className="input"
                              value={hasCanonicalOption ? canonicalMetric : draft.metric}
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
                              {hasCanonicalOption ? null : (
                                <option value={draft.metric}>
                                  {getFalsifyMetricLabel(draft.metric)}
                                </option>
                              )}
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
                                max={MAX_FALSIFY_PERIODS}
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

          {isBuyOrAddAction ? (
            <section
              className="da-panel"
              aria-label="买入前反方质询 · 理性安检门"
              aria-busy={devilsAdvocate.isPending}
            >
              <div className="da-header">
                <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <strong className="small">买入前反方质询 · 理性安检门</strong>
                  {daModeMeta ? <Tag color={daModeMeta.color}>{daModeMeta.label}</Tag> : null}
                  {daResult?.as_of ? (
                    <span className="small muted mono">{`快照基准 ${daResult.as_of}`}</span>
                  ) : null}
                </div>

                <div className="ai-controls">
                  <AiCompanionControls
                    mode={effectiveDaMode}
                    onModeChange={(nextMode) => {
                      setDaModeOverride(nextMode)
                      clearDaErrorOnEdit()
                    }}
                    quota={activeQuota}
                    ariaLabel="反方质询执行模式"
                    disabled={isBusy}
                  />
                  <button
                    type="button"
                    className="btn-ghost"
                    disabled={isBusy}
                    onClick={() => handleRunDevilsAdvocate()}
                  >
                    {devilsAdvocate.isPending ? '质询生成中...' : '运行反方质询'}
                  </button>
                </div>
              </div>

              <p className="small muted">
                强制基于确定性排雷指标、逆向估值与历史财务数据挑出 3 条反面质疑，辅助确认否证红线。
              </p>

              {aiPrefsQuery.data?.prefer_rule_only ? (
                <div className="notice-box small" role="status">
                  全局偏好已设为仅纯规则，当前免费零消耗运行
                </div>
              ) : null}

              {activeDaError ? (
                <div className="inline-error stack" style={{ gap: 8 }} role="alert">
                  <span>{activeDaError}</span>
                  {!daValidationError && devilsAdvocate.isError ? (
                    <div
                      className="row"
                      style={{ justifyContent: 'flex-start', gap: 8, flexWrap: 'wrap' }}
                    >
                      {effectiveDaMode !== 'rule_only' ? (
                        <button
                          type="button"
                          className="btn-ghost"
                          disabled={isBusy}
                          onClick={handleSwitchRuleOnlyAndRetry}
                        >
                          切换纯规则引擎并重试
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn-ghost"
                          disabled={isBusy}
                          onClick={() => handleRunDevilsAdvocate('rule_only')}
                        >
                          重试纯规则引擎
                        </button>
                      )}
                    </div>
                  ) : null}
                </div>
              ) : null}

              {devilsAdvocate.isPending ? (
                <div className="stack" style={{ gap: 8 }} role="status">
                  <span className="small muted">正在生成反方质询...</span>
                  <LoadingBlock lines={3} />
                </div>
              ) : daResult ? (
                <div className="stack" style={{ gap: 10 }}>
                  {(lastReviewedDraftKey !== null || reason.trim().length > 0) &&
                  !hasReviewedCurrentDraft ? (
                    <div className="notice-box notice-warn">
                      当前买入动作或投资理由较上次质询已有调整，建议重新运行反方质询。
                    </div>
                  ) : null}

                  {daResult.fallback_reason ? (
                    <div className="notice-box notice-warn" role="status">
                      {`已回退规则引擎：${daResult.fallback_reason}`}
                    </div>
                  ) : daResult.mode === 'deterministic_fallback' ? (
                    <div className="notice-box notice-warn" role="status">
                      已回退规则引擎，当前展示确定性反方质询。
                    </div>
                  ) : daResult.mode === 'deterministic' ? (
                    <p className="small muted" role="status">
                      当前由本地确定性规则引擎生成（零 AI 额度消耗，免费使用）
                    </p>
                  ) : null}

                  <div className="da-challenge-list">
                    {daResult.challenges.map((challenge) => {
                      const rawSuggestedRule = challenge.suggested_falsify_rule ?? null
                      const normalizedSuggestedRule = rawSuggestedRule
                        ? normalizeSuggestedFalsifyRule(rawSuggestedRule)
                        : null
                      const isAdopted =
                        normalizedSuggestedRule !== null &&
                        ruleDrafts.some((draft) =>
                          isRuleMatchingDraft(draft, normalizedSuggestedRule),
                        )

                      return (
                        <article key={challenge.index} className="da-challenge-card">
                          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                            <strong>{`#${challenge.index} ${challenge.title}`}</strong>
                            {isAdopted ? <Tag color="green">已加入规则</Tag> : null}
                          </div>

                          <p className="small soft">{challenge.thesis}</p>

                          {(challenge.cited_facts ?? []).length > 0 ? (
                            <div className="da-fact-chips">
                              {(challenge.cited_facts ?? []).map((fact, factIdx) => (
                                <span
                                  key={`${fact.label}-${fact.source_section}-${factIdx}`}
                                  className="da-fact-chip mono"
                                >
                                  {`${fact.label}: ${fact.value_text} · ${getAiSourceSectionLabel(fact.source_section)}`}
                                </span>
                              ))}
                            </div>
                          ) : null}

                          {normalizedSuggestedRule ? (
                            <div className="da-suggest-row">
                              <span className="small muted mono">
                                {`建议红线：${formatFalsifyRuleLine(normalizedSuggestedRule)}`}
                              </span>
                              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                                {!isAdopted && isRuleLimitReached ? (
                                  <span className="small muted">
                                    {`已达 ${MAX_FALSIFY_RULES} 条红线上限`}
                                  </span>
                                ) : null}
                                <button
                                  type="button"
                                  className="btn-ghost"
                                  disabled={isAdopted}
                                  aria-label={`采纳第 ${challenge.index} 条建议红线`}
                                  onClick={() => handleAdoptSuggestedRule(normalizedSuggestedRule)}
                                >
                                  {isAdopted ? '已采纳' : '采纳为否证红线'}
                                </button>
                              </div>
                            </div>
                          ) : null}
                        </article>
                      )
                    })}
                  </div>

                  <div className="disclaimer-box small muted">{daResult.compliance_notice}</div>
                </div>
              ) : null}
            </section>
          ) : null}

          {showBuyGate && isBuyOrAddAction ? (
            <div
              className="da-gate-banner"
              role="region"
              aria-label="买入前理性安检门确认"
              aria-live="polite"
            >
              <p className="small">
                {`尚未对当前${action === 'buy' ? '买入' : '加仓'}草稿运行「反方质询」安检门。建议先检验潜在漏洞并核对否证红线，也可在离线或额度用尽时直接跳过提交。`}
              </p>
              <div className="da-gate-actions">
                <button
                  type="button"
                  className="btn-ghost"
                  disabled={isBusy}
                  onClick={handleSkipGateAndSubmit}
                >
                  跳过质询，直接提交
                </button>
                <button
                  ref={gateRunDaButtonRef}
                  type="button"
                  className="btn-primary"
                  disabled={isBusy}
                  onClick={() => handleRunDevilsAdvocate()}
                >
                  先运行反方质询
                </button>
              </div>
            </div>
          ) : null}

          <div className="form-actions">
            <button type="submit" className="btn-primary" disabled={isBusy}>
              {createJournal.isPending
                ? '保存中...'
                : devilsAdvocate.isPending
                  ? '质询运行中...'
                  : '记录决策'}
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

export function StockDecisionTab({
  stock,
  snapshot = null,
}: {
  stock: StockDetail
  snapshot?: StockSnapshotPayload | null
}) {
  const { user, isAuthLoading } = useAuth()
  const valuationAnchorStrip = buildValuationAnchorStrip(snapshot)

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
                to={`/login?redirect=${encodeURIComponent(`/stock/${stock.code}`)}`}
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

  return (
    <StockDecisionTabContent
      key={`${stock.code}:${user.id}`}
      stock={stock}
      snapshot={snapshot}
      user={user}
    />
  )
}
