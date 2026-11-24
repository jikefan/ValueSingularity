import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { AiCompanionControls } from '../../components/ui/AiCompanionControls'
import { Card } from '../../components/ui/Card'
import { GuestPreviewGrid, type GuestPreviewItem } from '../../components/ui/GuestPreviewGrid'
import { GlossaryLabel, InfoHint } from '../../components/ui/InfoHint'
import { EmptyBlock, LoadingBlock } from '../../components/ui/StateBlock'
import { Tag } from '../../components/ui/Tag'
import {
  AI_EXECUTION_MODE_META,
  MDA_CHANGE_TYPE_META,
  type AiRequestMode,
} from '../../lib/aiLabels'
import { useAuth } from '../../lib/authContext'
import { clearCachedMdaDiff, useAiPreferences, useCachedMdaDiff, useMdaDiff } from '../../lib/useAi'
import { SIGNAL_META } from './stockHelpers'

const SAMPLE_PREVIOUS_PERIOD = '2024年报'
const SAMPLE_CURRENT_PERIOD = '2025年报'
const SAMPLE_PREVIOUS_MDA =
  '公司主营业务稳健增长，产能扩张按计划稳步推进。核心产品定价稳定，毛利率维持在行业较高水平，下游订单饱满，在建产线预计明年达产。前五大客户营收占比为 28.5%，渠道库存周转天数保持在 35 天健康区间。'
const SAMPLE_CURRENT_MDA =
  '受下游需求不及预期及行业价格战影响，公司综合毛利率下滑，短期业绩承压。渠道库存承压，经销商库存周转天数上升至 62 天，回款放缓，本期针对部分长账龄应收款调整坏账准备计提比例并计提减值。前五大客户集中度升至 46.8%，核心大客户订单存在一定不确定性。公司主动放缓原定产能扩张与在建工程资本开支节奏，优先保障现金流安全。'

type StockMdaDiffPanelProps = {
  code: string
  stockName: string
  snapshotAvailable: boolean
}

type StockMdaDiffPanelContentProps = StockMdaDiffPanelProps & {
  userId: string
}

function StockMdaDiffPanelContent({
  code,
  stockName,
  snapshotAvailable,
  userId,
}: StockMdaDiffPanelContentProps) {
  const queryClient = useQueryClient()
  const aiPrefsQuery = useAiPreferences(true)
  const cachedMdaQuery = useCachedMdaDiff(userId, code)
  const mdaDiff = useMdaDiff()

  const [previousPeriodLabel, setPreviousPeriodLabel] = useState('上期年报')
  const [currentPeriodLabel, setCurrentPeriodLabel] = useState('本期年报')
  const [previousText, setPreviousText] = useState('')
  const [currentText, setCurrentText] = useState('')
  const [modeOverride, setModeOverride] = useState<AiRequestMode | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [autoRuleOnlyNote, setAutoRuleOnlyNote] = useState<string | null>(null)

  const effectiveMode: AiRequestMode =
    modeOverride ?? (aiPrefsQuery.data?.prefer_rule_only ? 'rule_only' : 'auto')
  const rawResult =
    cachedMdaQuery.data ?? (mdaDiff.data && mdaDiff.data.code === code ? mdaDiff.data : null)
  const result = rawResult && rawResult.code === code ? rawResult : null
  const activeQuota = aiPrefsQuery.data?.quota ?? result?.quota ?? null
  const modeMeta = result ? AI_EXECUTION_MODE_META[result.mode] : null

  const hasPrevText = Boolean(previousText.trim())
  const hasCurrText = Boolean(currentText.trim())
  const hasOnlyOneText = hasPrevText !== hasCurrText
  const willAutoForceRuleOnly = snapshotAvailable && !hasPrevText && !hasCurrText

  function clearFeedbackOnEdit() {
    setFormError(null)
    setAutoRuleOnlyNote(null)
    if (mdaDiff.isError) {
      mdaDiff.reset()
    }
  }

  function handleFillSample() {
    setPreviousPeriodLabel(SAMPLE_PREVIOUS_PERIOD)
    setCurrentPeriodLabel(SAMPLE_CURRENT_PERIOD)
    setPreviousText(SAMPLE_PREVIOUS_MDA)
    setCurrentText(SAMPLE_CURRENT_MDA)
    clearFeedbackOnEdit()
  }

  function handleClearTexts() {
    setPreviousText('')
    setCurrentText('')
    setFormError(null)
    setAutoRuleOnlyNote(null)
    mdaDiff.reset()
    clearCachedMdaDiff(queryClient, userId, code)
  }

  function handleSubmit(requestedModeOverride?: AiRequestMode) {
    if (mdaDiff.isPending) {
      return
    }
    const trimmedPrevLabel = previousPeriodLabel.trim()
    const trimmedCurrLabel = currentPeriodLabel.trim()
    const trimmedPrevText = previousText.trim()
    const trimmedCurrText = currentText.trim()

    if (!trimmedPrevLabel || trimmedPrevLabel.length > 40) {
      setFormError('请填写 1–40 个字符的上期报告标签')
      return
    }
    if (!trimmedCurrLabel || trimmedCurrLabel.length > 40) {
      setFormError('请填写 1–40 个字符的本期报告标签')
      return
    }
    if (trimmedPrevText.length > 30000 || trimmedCurrText.length > 30000) {
      setFormError('单期年报 MD&A 文本不能超过 30000 个字符')
      return
    }

    const bothTextsBlank = !trimmedPrevText && !trimmedCurrText
    if (!snapshotAvailable && bothTextsBlank) {
      setFormError('该标的尚未同步结构化财报快照，请粘贴两期年报原文后再运行对比')
      return
    }

    const requestMode: AiRequestMode =
      snapshotAvailable && bothTextsBlank ? 'rule_only' : (requestedModeOverride ?? effectiveMode)
    if (snapshotAvailable && bothTextsBlank) {
      setAutoRuleOnlyNote(
        '未粘贴年报原文，已自动以纯规则模式仅对比已同步财报指标，本次不消耗每日 AI 额度。',
      )
    } else {
      setAutoRuleOnlyNote(null)
    }

    setFormError(null)
    mdaDiff.mutate({
      code,
      previous_period_label: trimmedPrevLabel,
      current_period_label: trimmedCurrLabel,
      previous_text: trimmedPrevText,
      current_text: trimmedCurrText,
      mode: requestMode,
    })
  }

  function handleSwitchRuleOnlyAndRetry() {
    if (mdaDiff.isPending) {
      return
    }
    setModeOverride('rule_only')
    mdaDiff.reset()
    handleSubmit('rule_only')
  }

  const mutationError = mdaDiff.isError
    ? mdaDiff.error instanceof Error
      ? mdaDiff.error.message
      : 'MD&A 口径对比失败，请稍后重试'
    : null
  const activeError = formError ?? mutationError

  return (
    <Card
      title={`年报 MD&A 口径变化对比器 · ${stockName}`}
      hint="mda_diff"
      extra={
        <AiCompanionControls
          mode={effectiveMode}
          onModeChange={(nextMode) => {
            setModeOverride(nextMode)
            clearFeedbackOnEdit()
          }}
          quota={activeQuota}
          ariaLabel="MD&A 对比执行模式"
          disabled={mdaDiff.isPending}
        />
      }
    >
      <div className="stack" style={{ gap: 16 }} aria-busy={mdaDiff.isPending}>
        <p className="small muted">
          {snapshotAvailable
            ? '自动对比近两年核心财务与审计口径变动，并逐句扫描管理层讨论与分析中的毛利承压、渠道库存、大客户集中度、资本开支与会计估计调整信号（可留空文本仅对比已同步财报指标）。'
            : '逐句扫描管理层讨论与分析中的毛利承压、渠道库存、大客户集中度、资本开支与会计估计调整信号（尚未同步结构化财报快照，请粘贴两期年报原文进行对比）。'}
        </p>

        {aiPrefsQuery.data?.prefer_rule_only ? (
          <div className="notice-box small" role="status">
            全局偏好已设为仅纯规则，当前免费零消耗运行
          </div>
        ) : null}

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
              <div className="field-label-row">
                <label htmlFor="mda-prev-label">上期报告标签</label>
                <InfoHint
                  title="上期报告标签"
                  entry={{
                    summary: '用于标识对比基准期的年报或半年报期次（如“2024年报”）。',
                    reading: '留空文本仅对比结构化财报快照时，系统会自动对齐最近两期完整财报年度。',
                  }}
                />
              </div>
              <input
                id="mda-prev-label"
                className="input"
                type="text"
                maxLength={40}
                disabled={mdaDiff.isPending}
                value={previousPeriodLabel}
                onChange={(event) => {
                  setPreviousPeriodLabel(event.target.value)
                  clearFeedbackOnEdit()
                }}
              />
            </div>

            <div className="field">
              <div className="field-label-row">
                <label htmlFor="mda-curr-label">本期报告标签</label>
                <InfoHint
                  title="本期报告标签"
                  entry={{
                    summary: '用于标识最新待核查的报告期名称（如“2025年报”），与上期形成前后对照。',
                    reading: '建议填写真实财报期次，便于留痕追踪措辞与会计口径变化。',
                  }}
                />
              </div>
              <input
                id="mda-curr-label"
                className="input"
                type="text"
                maxLength={40}
                disabled={mdaDiff.isPending}
                value={currentPeriodLabel}
                onChange={(event) => {
                  setCurrentPeriodLabel(event.target.value)
                  clearFeedbackOnEdit()
                }}
              />
            </div>

            <div className="field">
              <div className="field-label-row">
                <label htmlFor="mda-prev-text">上期管理层讨论与分析原文</label>
                <InfoHint term="mda_text_diff" title="上期 MD&A 原文" />
              </div>
              <textarea
                id="mda-prev-text"
                className="input textarea"
                rows={5}
                maxLength={30000}
                disabled={mdaDiff.isPending}
                placeholder={
                  snapshotAvailable
                    ? '粘贴上期年报/半年报 MD&A 段落（可选）'
                    : '粘贴上期年报/半年报 MD&A 段落'
                }
                value={previousText}
                onChange={(event) => {
                  setPreviousText(event.target.value)
                  clearFeedbackOnEdit()
                }}
              />
            </div>

            <div className="field">
              <div className="field-label-row">
                <label htmlFor="mda-curr-text">本期管理层讨论与分析原文</label>
                <InfoHint term="mda_text_diff" title="本期 MD&A 原文" />
              </div>
              <textarea
                id="mda-curr-text"
                className="input textarea"
                rows={5}
                maxLength={30000}
                disabled={mdaDiff.isPending}
                placeholder={
                  snapshotAvailable
                    ? '粘贴本期年报/半年报 MD&A 段落（可选）'
                    : '粘贴本期年报/半年报 MD&A 段落'
                }
                value={currentText}
                onChange={(event) => {
                  setCurrentText(event.target.value)
                  clearFeedbackOnEdit()
                }}
              />
            </div>
          </div>

          {hasOnlyOneText ? (
            <div className="notice-box notice-warn small" role="status">
              {hasPrevText
                ? '当前仅填写了上期原文、未填写本期原文，全部条款将被标记为“已删除”；建议同时粘贴两期年报原文以准确对比增删。'
                : '当前仅填写了本期原文、未填写上期原文，全部条款将被标记为“新增”；建议同时粘贴两期年报原文以准确对比增删。'}
            </div>
          ) : null}

          {willAutoForceRuleOnly && effectiveMode === 'auto' && !autoRuleOnlyNote ? (
            <div className="notice-box small" role="status">
              两期原文均留空时，提交将自动使用纯规则模式仅对比已同步财报指标，不消耗每日 AI 额度。
            </div>
          ) : null}

          {autoRuleOnlyNote ? (
            <div className="notice-box small" role="status">
              {autoRuleOnlyNote}
            </div>
          ) : null}

          <div className="row" style={{ flexWrap: 'wrap' }}>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <button
                type="button"
                className="btn-ghost"
                disabled={mdaDiff.isPending}
                onClick={handleFillSample}
              >
                填入年报对比样例
              </button>
              <button
                type="button"
                className="btn-ghost"
                disabled={mdaDiff.isPending}
                onClick={handleClearTexts}
              >
                清空文本
              </button>
            </div>

            <button type="submit" className="btn-primary" disabled={mdaDiff.isPending}>
              {mdaDiff.isPending ? '对比分析中...' : '运行 MD&A 口径对比'}
            </button>
          </div>

          {activeError ? (
            <div className="inline-error stack" style={{ gap: 8 }} role="alert">
              <span>{activeError}</span>
              {!formError && mdaDiff.isError ? (
                <div
                  className="row"
                  style={{ justifyContent: 'flex-start', gap: 8, flexWrap: 'wrap' }}
                >
                  {effectiveMode !== 'rule_only' ? (
                    <button
                      type="button"
                      className="btn-ghost"
                      disabled={mdaDiff.isPending}
                      onClick={handleSwitchRuleOnlyAndRetry}
                    >
                      切换纯规则引擎并重试
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn-ghost"
                      disabled={mdaDiff.isPending}
                      onClick={() => handleSubmit('rule_only')}
                    >
                      重试纯规则引擎
                    </button>
                  )}
                </div>
              ) : null}
            </div>
          ) : null}
        </form>

        {mdaDiff.isPending ? (
          <div className="stack" style={{ gap: 8 }} role="status">
            <span className="small muted">正在对比两期年报口径与管理层表述...</span>
            <LoadingBlock lines={4} />
          </div>
        ) : result ? (
          <div className="stack" style={{ gap: 16 }}>
            {result.fallback_reason ? (
              <div className="notice-box notice-warn" role="status">
                {`已回退规则引擎：${result.fallback_reason}`}
              </div>
            ) : result.mode === 'deterministic_fallback' ? (
              <div className="notice-box notice-warn" role="status">
                已回退规则引擎，当前展示确定性对比结果。
              </div>
            ) : result.mode === 'deterministic' ? (
              <p className="small muted" role="status">
                当前由本地确定性规则引擎生成（零 AI 额度消耗，免费使用）
              </p>
            ) : null}

            <div className="notice-box stack" style={{ gap: 8 }}>
              <div className="row" style={{ flexWrap: 'wrap' }}>
                <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <span className="label-with-hint">
                    <strong>对比结论摘要</strong>
                    <InfoHint term="mda_diff" />
                  </span>
                  <Tag color="blue">{`${result.previous_period_label} → ${result.current_period_label}`}</Tag>
                </div>
                {modeMeta ? <Tag color={modeMeta.color}>{modeMeta.label}</Tag> : null}
              </div>
              <p className="small">{result.summary}</p>
            </div>

            {result.metric_shifts.length > 0 ? (
              <div className="stack" style={{ gap: 10 }}>
                <h3 className="ledger-section-title">
                  <GlossaryLabel label="核心财务与审计口径变化" term="mda_metric_shift" />
                </h3>
                <div className="mda-shift-grid">
                  {result.metric_shifts.map((shift, idx) => {
                    const sevMeta = SIGNAL_META[shift.severity]
                    return (
                      <article key={`${shift.metric_label}-${idx}`} className="mda-shift-card">
                        <div className="row" style={{ gap: 8 }}>
                          <strong>{shift.metric_label}</strong>
                          <Tag color={sevMeta.color}>{sevMeta.label}</Tag>
                        </div>
                        <div className="small mono soft">
                          {`${shift.previous_text} → ${shift.current_text}`}
                        </div>
                        <div className="small mono">{`变化：${shift.delta_text}`}</div>
                        <p className="small muted">{shift.interpretation}</p>
                      </article>
                    )
                  })}
                </div>
              </div>
            ) : null}

            <div className="stack" style={{ gap: 10 }}>
              <h3 className="ledger-section-title">
                <GlossaryLabel label="管理层措辞增删高亮" term="mda_text_diff" />
              </h3>
              {result.text_highlights.length === 0 ? (
                <p className="small muted">未提供管理层讨论文本，或两期对比文本条款完全一致。</p>
              ) : (
                <div className="mda-highlight-list">
                  {result.text_highlights.map((highlight, idx) => {
                    const changeMeta = MDA_CHANGE_TYPE_META[highlight.change_type]
                    const sevMeta = SIGNAL_META[highlight.severity]
                    return (
                      <article
                        key={`${highlight.category}-${highlight.change_type}-${idx}`}
                        className="mda-highlight-card"
                      >
                        <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
                          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                            <Tag color={changeMeta.color}>{changeMeta.label}</Tag>
                            <strong>{highlight.category}</strong>
                          </div>
                          <Tag color={sevMeta.color}>{sevMeta.label}</Tag>
                        </div>

                        {highlight.signal_tags.length > 0 ? (
                          <div className="sentinel-list">
                            {highlight.signal_tags.map((tag, tagIdx) => (
                              <Tag key={`${tag}-${tagIdx}`} color="gray">
                                {tag}
                              </Tag>
                            ))}
                          </div>
                        ) : null}

                        <div className="mda-excerpt-grid">
                          <div className="mda-excerpt-box">
                            <div className="small muted">{result.previous_period_label}</div>
                            <p className="soft">
                              {highlight.previous_excerpt
                                ? highlight.previous_excerpt
                                : '（上期无对应表述）'}
                            </p>
                          </div>
                          <div className="mda-excerpt-box">
                            <div className="small muted">{result.current_period_label}</div>
                            <p className="soft">
                              {highlight.current_excerpt
                                ? highlight.current_excerpt
                                : '（本期已删除该表述）'}
                            </p>
                          </div>
                        </div>
                      </article>
                    )
                  })}
                </div>
              )}
            </div>

            <div className="disclaimer-box small muted">{result.compliance_notice}</div>
          </div>
        ) : null}
      </div>
    </Card>
  )
}

const MDA_GUEST_PREVIEWS: readonly GuestPreviewItem[] = [
  {
    id: 'metric-shift',
    badge: '指标异动示例',
    badgeColor: 'amber',
    title: '财务与审计口径变迁识别',
    metrics: ['毛利率 -5.70 pct', '两金增速差 +4.2%'],
    description: '自动对齐连续两期年报核心盈利、净现比与审计口径变化，快速定位潜在质量滑坡。',
  },
  {
    id: 'semantic-diff',
    badge: '措辞高亮示例',
    badgeColor: 'blue',
    title: '管理层讨论语义增删对照',
    metrics: ['新增：渠道库存承压', '修改：坏账计提比例'],
    description: '逐句标注上期与本期年报 MD&A 的删除、修改与新增风险表述，防微杜渐。',
  },
  {
    id: 'deterministic-free',
    badge: '本地兜底引擎',
    badgeColor: 'green',
    title: '纯规则差异对比零额度运行',
    metrics: ['不消耗 AI 额度', '100% 引用原文'],
    description: '支持在纯规则确定性引擎与 AI 协同模式间自由切换，始终保留原文追溯证据。',
  },
]

export function StockMdaDiffPanel({ code, stockName, snapshotAvailable }: StockMdaDiffPanelProps) {
  const { user, isAuthLoading } = useAuth()

  if (isAuthLoading) {
    return (
      <Card title={`年报 MD&A 口径变化对比器 · ${stockName}`} hint="mda_diff">
        <LoadingBlock lines={2} />
      </Card>
    )
  }

  if (!user) {
    return (
      <Card
        title={`年报 MD&A 口径变化对比器 · ${stockName}`}
        hint="mda_diff"
        extra={<Tag color="gray">未登录</Tag>}
      >
        <div className="stack" style={{ gap: 16 }}>
          <EmptyBlock
            title="登录后对比连续两期年报管理层讨论与财务口径变化"
            hint={
              <Link
                className="btn-primary mt-16"
                to={`/login?redirect=${encodeURIComponent(`/stock/${code}`)}`}
                state={{ from: `/stock/${code}` }}
              >
                前往登录 / 注册
              </Link>
            }
          />
          <GuestPreviewGrid items={MDA_GUEST_PREVIEWS} />
        </div>
      </Card>
    )
  }

  return (
    <StockMdaDiffPanelContent
      key={`${code}:${user.id}`}
      code={code}
      stockName={stockName}
      snapshotAvailable={snapshotAvailable}
      userId={user.id}
    />
  )
}
