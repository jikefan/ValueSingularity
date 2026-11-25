import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Card } from '../../components/ui/Card'
import { GlossaryLabel, InfoHint } from '../../components/ui/InfoHint'
import { EmptyBlock, ErrorBlock, LoadingBlock } from '../../components/ui/StateBlock'
import { Tag } from '../../components/ui/Tag'
import { ApiError, api } from '../../lib/api'
import { useAuth } from '../../lib/authContext'
import { formatNum, formatPct, formatSignedPct, formatStockName } from '../../lib/format'
import { queryKeys } from '../../lib/queryKeys'
import { useStockScreener, useStockSnapshot } from '../../lib/useStockAnalysis'
import { useAddWatchlist, useRemoveWatchlist, useWatchlist } from '../../lib/useWatchlist'
import { useViewMode } from '../../lib/viewMode'
import type { StockDetail, StockScreenerItem, StockSnapshotPayload } from '../../types/api'
import { StockCtTab } from './StockCtTab'
import { StockDecisionTab } from './StockDecisionTab'
import { StockForensicsTab } from './StockForensicsTab'
import { StockGovernanceTab } from './StockGovernanceTab'
import { StockMdaDiffPanel } from './StockMdaDiffPanel'
import {
  StockFinancialsTab,
  StockGrowthTab,
  StockInstitutionsTab,
  StockMoatTab,
  StockOverviewTab,
} from './StockOverviewTabs'
import { StockQuickSummaryCard } from './StockQuickSummaryCard'
import { StockValuationTab } from './StockValuationTab'
import {
  computeFinancialPbRoeMetrics,
  deriveStockVerdict,
  formatStockDossierMarkdown,
  getEarningsQualityBadgeMeta,
  getForensicCautionAlertState,
  isFinancialSnapshot,
} from './stockHelpers'

const CORE_TABS = [
  { key: 'overview', label: '公司画像' },
  { key: 'forensics', label: '利润真相' },
  { key: 'valuation', label: '估值' },
  { key: 'risks', label: '风险排雷' },
  { key: 'decision', label: '投资决策' },
] as const

const DEEP_TABS = [
  { key: 'financials', label: '财务分析' },
  { key: 'moat', label: '护城河' },
  { key: 'growth', label: '增长引擎' },
  { key: 'institutions', label: '机构视角' },
  { key: 'governance', label: '治理' },
] as const

const TABS = [...CORE_TABS, ...DEEP_TABS] as const

type TabKey = (typeof TABS)[number]['key']
type SnapshotTabKey = Exclude<TabKey, 'decision'>

function renderSnapshotTab(
  tab: SnapshotTabKey,
  snapshot: StockSnapshotPayload,
  stockCode: string,
  onSwitchTab: (nextTab: TabKey) => void,
) {
  switch (tab) {
    case 'overview':
      return <StockOverviewTab snapshot={snapshot} />
    case 'forensics':
      return (
        <StockForensicsTab snapshot={snapshot} stockCode={stockCode} onSwitchTab={onSwitchTab} />
      )
    case 'financials':
      return <StockFinancialsTab snapshot={snapshot} />
    case 'moat':
      return <StockMoatTab snapshot={snapshot} />
    case 'valuation':
      return <StockValuationTab snapshot={snapshot} />
    case 'growth':
      return <StockGrowthTab snapshot={snapshot} />
    case 'institutions':
      return <StockInstitutionsTab snapshot={snapshot} />
    case 'governance':
      return <StockGovernanceTab snapshot={snapshot} />
    case 'risks':
      return <StockCtTab snapshot={snapshot} />
    default: {
      const exhaustive: never = tab
      return exhaustive
    }
  }
}

function triggerMarkdownDownload(stock: StockDetail, snapshot: StockSnapshotPayload): void {
  const markdown = formatStockDossierMarkdown(stock, snapshot)
  if (
    typeof navigator !== 'undefined' &&
    navigator.clipboard &&
    typeof navigator.clipboard.writeText === 'function'
  ) {
    void navigator.clipboard.writeText(markdown).catch(() => {})
  }

  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    return
  }

  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' })
  const objectUrl = URL.createObjectURL(blob)
  if (typeof document !== 'undefined') {
    const anchor = document.createElement('a')
    anchor.href = objectUrl
    anchor.download = `${stock.code}-${formatStockName(stock.name)}-定量研报简报.md`
    anchor.style.display = 'none'
    document.body.appendChild(anchor)
    anchor.click()
    document.body.removeChild(anchor)
  }
  if (typeof URL.revokeObjectURL === 'function') {
    URL.revokeObjectURL(objectUrl)
  }
}

function CoverageDiscoveryLinks({
  curatedTargets,
}: {
  curatedTargets: readonly StockScreenerItem[]
}) {
  return (
    <div className="stack" style={{ gap: 10, alignItems: 'center' }}>
      <Link className="btn-ghost" to="/">
        返回价值击球区
      </Link>
      {curatedTargets.length > 0 ? (
        <div className="stock-curated-links">
          <span className="small muted">已覆盖精选标的可直接查看：</span>
          <div className="sample-stock-row" style={{ justifyContent: 'center' }}>
            {curatedTargets.map((item) => (
              <Link key={item.code} className="sample-stock-chip" to={`/stock/${item.code}`}>
                <span>{formatStockName(item.name)}</span>
                <span className="mono muted">{item.code}</span>
              </Link>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}

function StockPageContent({ code }: { code: string }) {
  const { user, isAuthLoading } = useAuth()
  const { setViewMode, isSimple } = useViewMode()
  const [activeTab, setActiveTab] = useState<TabKey>('overview')
  const [exportedNotice, setExportedNotice] = useState(false)
  const exportTimerRef = useRef<number | undefined>(undefined)

  useEffect(() => {
    return () => {
      if (exportTimerRef.current !== undefined && typeof window !== 'undefined') {
        window.clearTimeout(exportTimerRef.current)
      }
    }
  }, [])

  const stockQuery = useQuery({
    queryKey: queryKeys.stocks.detail(code),
    queryFn: ({ signal }) => api.getStock(code, signal),
  })

  const stock = stockQuery.data
  const snapshotQuery = useStockSnapshot(code, {
    enabled: Boolean(stock),
    snapshotAvailableHint: stock?.snapshot_available,
  })
  const watchlistQuery = useWatchlist(Boolean(user))
  const addWatchlistMutation = useAddWatchlist()
  const removeWatchlistMutation = useRemoveWatchlist()

  const snapshot = snapshotQuery.data ?? null
  const isSnapshotLoading =
    snapshotQuery.isPending || (!snapshotQuery.data && snapshotQuery.isFetching)
  const isSnapshotUnavailableError = snapshotQuery.isError && !snapshot

  const isNotFoundError =
    stockQuery.isError && stockQuery.error instanceof ApiError && stockQuery.error.status === 404

  const screenerQuery = useStockScreener(
    { limit: 6 },
    isNotFoundError || isSnapshotUnavailableError,
  )
  const curatedTargets = useMemo(
    () => (screenerQuery.data?.items ?? []).filter((item) => item.code !== code).slice(0, 4),
    [code, screenerQuery.data?.items],
  )

  const isFinancial = useMemo(() => (snapshot ? isFinancialSnapshot(snapshot) : false), [snapshot])
  const verdict = useMemo(() => (snapshot ? deriveStockVerdict(snapshot) : null), [snapshot])
  const pbRoe = useMemo(
    () => (snapshot ? computeFinancialPbRoeMetrics(snapshot) : null),
    [snapshot],
  )
  const forensics = snapshot?.forensics ?? null
  const forensicsBadgeMeta = useMemo(
    () =>
      forensics
        ? getEarningsQualityBadgeMeta(
            forensics.earnings_quality_tag,
            forensics.earnings_quality_label,
          )
        : null,
    [forensics],
  )
  const forensicAlert = useMemo(() => getForensicCautionAlertState(forensics), [forensics])

  if (stockQuery.isPending || (!stockQuery.data && stockQuery.isFetching)) {
    return (
      <div className="container stack" style={{ gap: 16 }}>
        <Card title={`${code} · 个股分析`}>
          <LoadingBlock lines={5} />
        </Card>
      </div>
    )
  }

  if (stockQuery.isError) {
    if (isNotFoundError) {
      return (
        <div className="container stack" style={{ gap: 16 }}>
          <Card title={`${code} · 个股分析`} extra={<Tag color="amber">未收录</Tag>}>
            <EmptyBlock
              title={`未找到股票 ${code}`}
              hint={
                <span className="stack" style={{ gap: 12, alignItems: 'center' }}>
                  <span>
                    当前核心研究覆盖池暂未收录该 6
                    位代码，请核对代码是否正确，或前往价值击球区浏览已覆盖标的。
                  </span>
                  <CoverageDiscoveryLinks curatedTargets={curatedTargets} />
                </span>
              }
            />
          </Card>
        </div>
      )
    }

    return (
      <div className="container stack" style={{ gap: 16 }}>
        <Card title={`${code} · 个股分析`}>
          <ErrorBlock
            title="个股信息加载失败"
            message={stockQuery.error instanceof Error ? stockQuery.error.message : '未知错误'}
            onRetry={() => {
              void stockQuery.refetch()
            }}
          />
        </Card>
      </div>
    )
  }

  if (!stock) {
    return null
  }

  const currentStock = stock
  const currentTabMeta = TABS.find((tab) => tab.key === activeTab) ?? TABS[0]
  const isWatchlistChecking = Boolean(user) && watchlistQuery.isPending
  const isInWatchlist = Boolean(
    watchlistQuery.data?.some((item) => item.code === currentStock.code),
  )
  const watchlistError = addWatchlistMutation.isError
    ? addWatchlistMutation.error instanceof Error
      ? addWatchlistMutation.error.message
      : '加入自选失败'
    : removeWatchlistMutation.isError
      ? removeWatchlistMutation.error instanceof Error
        ? removeWatchlistMutation.error.message
        : '移出自选失败'
      : null

  const divYieldPct = snapshot
    ? (snapshot.valuation.dividend_yield_pct ??
      snapshot.shareholder_return.current_dividend_yield_pct)
    : null

  function handleExportMarkdown() {
    if (!snapshot) {
      return
    }
    triggerMarkdownDownload(currentStock, snapshot)
    setExportedNotice(true)
    if (typeof window !== 'undefined') {
      if (exportTimerRef.current !== undefined) {
        window.clearTimeout(exportTimerRef.current)
      }
      exportTimerRef.current = window.setTimeout(() => {
        setExportedNotice(false)
        exportTimerRef.current = undefined
      }, 3000)
    }
  }

  function renderActiveTabBody() {
    if (activeTab === 'decision') {
      return <StockDecisionTab stock={currentStock} snapshot={snapshot} />
    }
    if (isSnapshotLoading) {
      return (
        <Card
          title={currentTabMeta.label}
          extra={
            !currentStock.snapshot_available ? <Tag color="blue">首次按需计算</Tag> : undefined
          }
        >
          <div className="stack" style={{ gap: 12 }}>
            {!currentStock.snapshot_available ? (
              <div className="notice-box" role="status">
                {`正在同步并计算 ${currentStock.code} ${formatStockName(currentStock.name)} 深度财报与估值快照（首次约需 5–8 秒）...`}
              </div>
            ) : null}
            <LoadingBlock lines={5} />
          </div>
        </Card>
      )
    }
    if (isSnapshotUnavailableError) {
      const fallbackCard = (
        <Card title={currentTabMeta.label} extra={<Tag color="amber">同步暂不可用</Tag>}>
          <div className="stack" style={{ gap: 14 }}>
            <ErrorBlock
              title="深度分析快照加载失败"
              message={
                snapshotQuery.error instanceof Error ? snapshotQuery.error.message : '未知错误'
              }
              onRetry={() => {
                void snapshotQuery.refetch()
              }}
            />
            <div className="stack" style={{ gap: 12, alignItems: 'center' }}>
              <span className="small muted">
                当前无法拉取全量财报或历史估值快照，您仍可在「风险排雷」使用年报口径对比，或在「投资决策」记录笔记。
              </span>
              <span className="row" style={{ gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => setActiveTab('decision')}
                >
                  前往投资决策
                </button>
                <Link className="btn-ghost" to={`/compare?codes=${currentStock.code}`}>
                  打开同业对比
                </Link>
              </span>
              <CoverageDiscoveryLinks curatedTargets={curatedTargets} />
            </div>
          </div>
        </Card>
      )
      if (activeTab === 'risks') {
        return (
          <div className="stack" style={{ gap: 16 }}>
            {fallbackCard}
            <StockMdaDiffPanel
              code={currentStock.code}
              stockName={formatStockName(currentStock.name)}
              snapshotAvailable={false}
            />
          </div>
        )
      }
      return fallbackCard
    }
    if (!snapshot) {
      return (
        <Card title={currentTabMeta.label}>
          <EmptyBlock title="暂无分析快照数据" />
        </Card>
      )
    }
    return renderSnapshotTab(activeTab, snapshot, currentStock.code, setActiveTab)
  }

  return (
    <div className="container stack" style={{ gap: 16 }}>
      <section className="card-machined stock-workstation-header" aria-label="个股研究工作台概览">
        <div className="stock-header-top">
          <div className="stack" style={{ gap: 8 }}>
            <div className="stock-title-row">
              <h1 className="stock-name">{formatStockName(stock.name)}</h1>
              <span className="code-pill">{stock.code}</span>
              <Tag color="blue">{stock.exchange}</Tag>
              {stock.is_st ? <Tag color="amber">ST</Tag> : null}
              {!stock.is_active ? <Tag color="rose">已退市</Tag> : null}
              <Tag
                color={
                  snapshot || (stock.snapshot_available && !isSnapshotUnavailableError)
                    ? 'green'
                    : isSnapshotLoading
                      ? 'blue'
                      : 'gray'
                }
              >
                {snapshot || (stock.snapshot_available && !isSnapshotUnavailableError)
                  ? '已预计算快照'
                  : isSnapshotLoading
                    ? '自动同步中'
                    : '基础元数据'}
              </Tag>
              {isFinancial ? <Tag color="blue">金融业专项口径</Tag> : null}
              {forensicsBadgeMeta ? (
                <span className={forensicsBadgeMeta.badgeClass}>{forensicsBadgeMeta.label}</span>
              ) : null}
            </div>
            <div className="small muted">
              {snapshot
                ? `快照日期 ${snapshot.as_of} · 数据源 ${snapshot.data_source}`
                : isSnapshotLoading && !stock.snapshot_available
                  ? `正在首次同步 ${stock.code} ${formatStockName(stock.name)} 财报与历史估值数据…`
                  : isSnapshotLoading
                    ? `${stock.exchange} 交易所档案 · 正在读取深度分析快照`
                    : `${stock.exchange} 交易所档案 · 深度分析快照暂不可用`}
            </div>
          </div>

          <div className="stack stock-header-actions" style={{ gap: 8 }}>
            <div className="row stock-header-action-row" style={{ gap: 8, flexWrap: 'wrap' }}>
              {snapshot ? (
                <button type="button" className="btn-ghost" onClick={handleExportMarkdown}>
                  导出研报 (.md)
                </button>
              ) : null}

              {exportedNotice ? (
                <span className="tag tag-green" role="status">
                  已导出 .md
                </span>
              ) : null}

              <Link className="btn-ghost" to={`/compare?codes=${stock.code}`}>
                同业对比
              </Link>

              {user ? (
                isWatchlistChecking ? (
                  <span className="small muted">加载自选状态...</span>
                ) : isInWatchlist ? (
                  <>
                    <Tag color="green">已在自选 ✓</Tag>
                    <Link className="btn-ghost" to="/me">
                      前往配置哨兵
                    </Link>
                    <button
                      type="button"
                      className="btn-danger"
                      disabled={removeWatchlistMutation.isPending}
                      onClick={() => {
                        addWatchlistMutation.reset()
                        removeWatchlistMutation.mutate(currentStock.code)
                      }}
                    >
                      {removeWatchlistMutation.isPending ? '移除中...' : '移出自选'}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="btn-primary"
                    disabled={addWatchlistMutation.isPending}
                    onClick={() => {
                      removeWatchlistMutation.reset()
                      addWatchlistMutation.mutate({
                        code: stock.code,
                        name: stock.name,
                        industry: stock.industry_sw1 ?? null,
                        alert_enabled: false,
                      })
                    }}
                  >
                    {addWatchlistMutation.isPending ? '加入中...' : '加入自选愿望单'}
                  </button>
                )
              ) : !isAuthLoading ? (
                <Link
                  className="btn-ghost"
                  to={`/login?redirect=${encodeURIComponent(`/stock/${currentStock.code}`)}`}
                  state={{ from: `/stock/${currentStock.code}` }}
                >
                  登录后加入自选
                </Link>
              ) : null}
            </div>

            {user && !isWatchlistChecking && !isInWatchlist ? (
              <span className="small muted">加入后可在「我的」配置到价自动提醒</span>
            ) : null}

            {watchlistError ? (
              <div className="inline-error" role="alert">
                {watchlistError}
              </div>
            ) : null}
          </div>
        </div>

        {snapshot && verdict ? (
          <>
            <div className={`verdict-banner verdict-tone-${verdict.tone}`} role="status">
              <span className="eyebrow-pill">
                <span className="live-beacon" />
                {verdict.badge}
              </span>
              <span className="small soft">{verdict.summary}</span>
            </div>

            {forensicAlert.show && forensics ? (
              <div
                className={
                  forensicAlert.highSeverity
                    ? 'discovery-caution-strip discovery-caution-strip-red'
                    : 'discovery-caution-strip'
                }
                role="note"
                aria-label="利润成色鉴真提示"
              >
                <div className="row" style={{ flexWrap: 'wrap', gap: 10 }}>
                  <div className="stack" style={{ gap: 4, flex: '1 1 260px' }}>
                    <span className="label-with-hint">
                      <strong>
                        利润成色警示 ·{' '}
                        {forensicsBadgeMeta?.label ?? forensics.earnings_quality_label}
                      </strong>
                      <InfoHint term="forensic_profit_truth" />
                    </span>
                    <span>{forensics.verdict}</span>
                  </div>
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={() => setActiveTab('forensics')}
                  >
                    下钻「利润真相」 →
                  </button>
                </div>
              </div>
            ) : null}

            <div className="well-grid-4 stock-workstation-ribbon" aria-label="核心定量速览">
              <div className="well-cell">
                <div className="metric-label">
                  <GlossaryLabel label="综合雷达评分" term="radar_total_score" />
                </div>
                <div className="metric-value tnum">{`${snapshot.radar.total_score} / 100`}</div>
                <div className="metric-sub">
                  {isFinancial ? '金融业专项五维' : '通用五维定量雷达'}
                </div>
              </div>

              <div className="well-cell">
                <div className="metric-label">
                  <GlossaryLabel label="10Y PE / PB 分位" term="valuation_pct_10y" />
                </div>
                <div className="metric-value tnum" style={{ fontSize: 18 }}>
                  {`PE ${formatPct(snapshot.valuation.pe_percentile_10y, 1)} · PB ${formatPct(snapshot.valuation.pb_percentile_10y, 1)}`}
                </div>
                <div className="metric-sub">
                  {`PE(TTM) ${formatNum(snapshot.valuation.pe_ttm, 2)} · PB ${formatNum(snapshot.valuation.pb, 2)}`}
                </div>
              </div>

              <div className="well-cell">
                <div className="metric-label">
                  <GlossaryLabel label="5年平均 ROE / 股息率" term="roe_5y_avg" />
                </div>
                <div className="metric-value tnum" style={{ fontSize: 18 }}>
                  {`${formatPct(snapshot.moat.roe_5y_avg_pct, 2)} / ${formatPct(divYieldPct, 2)}`}
                </div>
                <div className="metric-sub">
                  {`收盘价 ${formatNum(snapshot.valuation.close, 2)}`}
                </div>
              </div>

              <div className="well-cell">
                <div className="metric-label">
                  <GlossaryLabel label="财报排雷与市场预期" term="ct_and_implied" />
                </div>
                <div className="metric-value tnum" style={{ fontSize: 18 }}>
                  {`${snapshot.financial_ct.red_count} 红 / ${snapshot.financial_ct.yellow_count} 黄`}
                </div>
                <div className="metric-sub">
                  {isFinancial
                    ? `盈利收益率(ROE/PB) ${formatPct(pbRoe?.impliedEarningsYieldPct, 2)}`
                    : snapshot.reverse_dcf.solvable
                      ? `隐含 10Y FCF ${formatSignedPct(snapshot.reverse_dcf.implied_fcf_cagr_pct, 2)}`
                      : '隐含预期不可求解'}
                </div>
              </div>
            </div>
          </>
        ) : null}

        <div className="stock-meta-grid">
          <div>
            <div className="metric-label">
              <GlossaryLabel label="申万一级" term="industry_sw1" />
            </div>
            <div className="metric-sub">{stock.industry_sw1 ?? '—'}</div>
          </div>
          <div>
            <div className="metric-label">
              <GlossaryLabel label="申万二级" term="industry_sw2" />
            </div>
            <div className="metric-sub">{stock.industry_sw2 ?? '—'}</div>
          </div>
          <div>
            <div className="metric-label">
              <GlossaryLabel label="上市日期" term="list_date" />
            </div>
            <div className="metric-sub mono">{stock.list_date ?? '—'}</div>
          </div>
          <div>
            <div className="metric-label">
              <GlossaryLabel label="交易状态" term="trade_status" />
            </div>
            <div className="metric-sub">{stock.is_active ? '正常交易' : '已退市'}</div>
          </div>
        </div>
      </section>

      {snapshot && isSimple ? (
        <StockQuickSummaryCard snapshot={snapshot} onSwitchTab={setActiveTab} />
      ) : null}

      <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <div
          className="tab-bar tab-bar-grouped"
          role="tablist"
          aria-label="个股分析维度"
          style={{ flex: '1 1 560px' }}
        >
          <span className="tab-group-tag">核心必看</span>
          {CORE_TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.key}
              className={activeTab === tab.key ? 'tab-btn active' : 'tab-btn'}
              onClick={() => setActiveTab(tab.key)}
            >
              {tab.label}
            </button>
          ))}
          <span className="tab-group-divider" aria-hidden="true" />
          <span className="tab-group-tag">深度研究</span>
          {DEEP_TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.key}
              className={activeTab === tab.key ? 'tab-btn active' : 'tab-btn'}
              onClick={() => setActiveTab(tab.key)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="view-mode-switch" role="group" aria-label="研究视角切换">
          <button
            type="button"
            className={isSimple ? 'view-mode-opt active' : 'view-mode-opt'}
            aria-pressed={isSimple}
            onClick={() => setViewMode('simple')}
          >
            简洁视角
          </button>
          <button
            type="button"
            className={!isSimple ? 'view-mode-opt active' : 'view-mode-opt'}
            aria-pressed={!isSimple}
            onClick={() => setViewMode('pro')}
          >
            专业视角
          </button>
        </div>
      </div>

      {renderActiveTabBody()}
    </div>
  )
}

export function StockPage() {
  const { code = '' } = useParams<{ code: string }>()
  const normalizedCode = code.trim()
  const isValidCode = /^[0-9]{6}$/.test(normalizedCode)

  if (!isValidCode) {
    return (
      <div className="container stack" style={{ gap: 16 }}>
        <Card title="个股分析" extra={<Tag color="rose">代码无效</Tag>}>
          <ErrorBlock
            title="股票代码格式无效"
            message={`“${normalizedCode || '空'}” 不是有效的 6 位 A 股代码，请输入如 600519。`}
          />
          <div className="row" style={{ justifyContent: 'center' }}>
            <Link className="btn-ghost" to="/">
              返回价值击球区
            </Link>
          </div>
        </Card>
      </div>
    )
  }

  return <StockPageContent key={normalizedCode} code={normalizedCode} />
}
