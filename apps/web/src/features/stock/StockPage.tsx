import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Card } from '../../components/ui/Card'
import { EmptyBlock, ErrorBlock, LoadingBlock } from '../../components/ui/StateBlock'
import { Tag } from '../../components/ui/Tag'
import { ApiError, api } from '../../lib/api'
import { useAuth } from '../../lib/authContext'
import { formatNum, formatPct, formatSignedPct } from '../../lib/format'
import { queryKeys } from '../../lib/queryKeys'
import { useStockScreener, useStockSnapshot } from '../../lib/useStockAnalysis'
import { useAddWatchlist, useRemoveWatchlist, useWatchlist } from '../../lib/useWatchlist'
import type { StockDetail, StockScreenerItem, StockSnapshotPayload } from '../../types/api'
import { StockCtTab } from './StockCtTab'
import { StockDecisionTab } from './StockDecisionTab'
import { StockGovernanceTab } from './StockGovernanceTab'
import { StockMdaDiffPanel } from './StockMdaDiffPanel'
import {
  StockFinancialsTab,
  StockGrowthTab,
  StockInstitutionsTab,
  StockMoatTab,
  StockOverviewTab,
} from './StockOverviewTabs'
import { StockValuationTab } from './StockValuationTab'
import {
  computeFinancialPbRoeMetrics,
  deriveStockVerdict,
  formatStockDossierMarkdown,
  isFinancialSnapshot,
} from './stockHelpers'

const TABS = [
  { key: 'overview', label: '公司画像' },
  { key: 'financials', label: '财务分析' },
  { key: 'moat', label: '护城河' },
  { key: 'valuation', label: '估值' },
  { key: 'growth', label: '增长引擎' },
  { key: 'institutions', label: '机构视角' },
  { key: 'governance', label: '治理' },
  { key: 'risks', label: '风险排雷' },
  { key: 'decision', label: '投资决策' },
] as const

type TabKey = (typeof TABS)[number]['key']
type SnapshotTabKey = Exclude<TabKey, 'decision'>

function renderSnapshotTab(tab: SnapshotTabKey, snapshot: StockSnapshotPayload) {
  switch (tab) {
    case 'overview':
      return <StockOverviewTab snapshot={snapshot} />
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
    anchor.download = `${stock.code}-${stock.name}-定量研报简报.md`
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
                <span>{item.name}</span>
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
  const snapshotQuery = useStockSnapshot(code, Boolean(stock?.snapshot_available))
  const watchlistQuery = useWatchlist(Boolean(user))
  const addWatchlistMutation = useAddWatchlist()
  const removeWatchlistMutation = useRemoveWatchlist()

  const isNotFoundError =
    stockQuery.isError && stockQuery.error instanceof ApiError && stockQuery.error.status === 404
  const isSnapshot404 =
    snapshotQuery.isError &&
    snapshotQuery.error instanceof ApiError &&
    snapshotQuery.error.status === 404
  const isSnapshotUnsynced = Boolean(stock) && (!stock?.snapshot_available || isSnapshot404)

  const screenerQuery = useStockScreener({ limit: 6 }, isNotFoundError || isSnapshotUnsynced)
  const curatedTargets = useMemo(
    () => (screenerQuery.data?.items ?? []).filter((item) => item.code !== code).slice(0, 4),
    [code, screenerQuery.data?.items],
  )

  const snapshot = snapshotQuery.data ?? null
  const isFinancial = useMemo(() => (snapshot ? isFinancialSnapshot(snapshot) : false), [snapshot])
  const verdict = useMemo(() => (snapshot ? deriveStockVerdict(snapshot) : null), [snapshot])
  const pbRoe = useMemo(
    () => (snapshot ? computeFinancialPbRoeMetrics(snapshot) : null),
    [snapshot],
  )

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
    if (isSnapshotUnsynced) {
      const unsyncedCard = (
        <Card title={currentTabMeta.label} extra={<Tag color="gray">未同步快照</Tag>}>
          <EmptyBlock
            title={`${currentTabMeta.label}尚无深度分析快照`}
            hint={
              <span className="stack" style={{ gap: 12, alignItems: 'center' }}>
                <span>
                  该标的暂未生成深度财报与历史估值快照，暂不展示图表与排雷数据；您仍可在「风险排雷」使用年报口径对比，或在「投资决策」记录笔记。
                </span>
                <span
                  className="row"
                  style={{ gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}
                >
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
              </span>
            }
          />
        </Card>
      )
      if (activeTab === 'risks') {
        return (
          <div className="stack" style={{ gap: 16 }}>
            {unsyncedCard}
            <StockMdaDiffPanel
              code={currentStock.code}
              stockName={currentStock.name}
              snapshotAvailable={false}
            />
          </div>
        )
      }
      return unsyncedCard
    }
    if (snapshotQuery.isPending || (!snapshotQuery.data && snapshotQuery.isFetching)) {
      return (
        <Card title={currentTabMeta.label}>
          <LoadingBlock lines={5} />
        </Card>
      )
    }
    if (snapshotQuery.isError) {
      return (
        <Card title={currentTabMeta.label}>
          <ErrorBlock
            title="深度分析快照加载失败"
            message={
              snapshotQuery.error instanceof Error ? snapshotQuery.error.message : '未知错误'
            }
            onRetry={() => {
              void snapshotQuery.refetch()
            }}
          />
        </Card>
      )
    }
    if (!snapshot) {
      return (
        <Card title={currentTabMeta.label}>
          <EmptyBlock title="暂无分析快照数据" />
        </Card>
      )
    }
    return renderSnapshotTab(activeTab, snapshot)
  }

  return (
    <div className="container stack" style={{ gap: 16 }}>
      <section className="card-machined stock-workstation-header" aria-label="个股研究工作台概览">
        <div className="stock-header-top">
          <div className="stack" style={{ gap: 8 }}>
            <div className="stock-title-row">
              <h1 className="stock-name">{stock.name}</h1>
              <span className="code-pill">{stock.code}</span>
              <Tag color="blue">{stock.exchange}</Tag>
              {stock.is_st ? <Tag color="amber">ST</Tag> : null}
              {!stock.is_active ? <Tag color="rose">已退市</Tag> : null}
              <Tag color={stock.snapshot_available && !isSnapshot404 ? 'green' : 'gray'}>
                {stock.snapshot_available && !isSnapshot404 ? '已预计算快照' : '基础元数据'}
              </Tag>
              {isFinancial ? <Tag color="blue">金融业专项口径</Tag> : null}
            </div>
            <div className="small muted">
              {snapshot
                ? `快照日期 ${snapshot.as_of} · 数据源 ${snapshot.data_source}`
                : `${stock.exchange} 交易所档案 · 尚未生成深度分析快照`}
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

            <div className="well-grid-4 stock-workstation-ribbon" aria-label="核心定量速览">
              <div className="well-cell">
                <div className="metric-label">综合雷达评分</div>
                <div className="metric-value tnum">{`${snapshot.radar.total_score} / 100`}</div>
                <div className="metric-sub">
                  {isFinancial ? '金融业专项五维' : '通用五维定量雷达'}
                </div>
              </div>

              <div className="well-cell">
                <div className="metric-label">10Y PE / PB 分位</div>
                <div className="metric-value tnum" style={{ fontSize: 18 }}>
                  {`PE ${formatPct(snapshot.valuation.pe_percentile_10y, 1)} · PB ${formatPct(snapshot.valuation.pb_percentile_10y, 1)}`}
                </div>
                <div className="metric-sub">
                  {`PE(TTM) ${formatNum(snapshot.valuation.pe_ttm, 2)} · PB ${formatNum(snapshot.valuation.pb, 2)}`}
                </div>
              </div>

              <div className="well-cell">
                <div className="metric-label">5年平均 ROE / 股息率</div>
                <div className="metric-value tnum" style={{ fontSize: 18 }}>
                  {`${formatPct(snapshot.moat.roe_5y_avg_pct, 2)} / ${formatPct(divYieldPct, 2)}`}
                </div>
                <div className="metric-sub">
                  {`收盘价 ${formatNum(snapshot.valuation.close, 2)}`}
                </div>
              </div>

              <div className="well-cell">
                <div className="metric-label">CT 排雷与隐含预期</div>
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
            <div className="metric-label">申万一级</div>
            <div className="metric-sub">{stock.industry_sw1 ?? '—'}</div>
          </div>
          <div>
            <div className="metric-label">申万二级</div>
            <div className="metric-sub">{stock.industry_sw2 ?? '—'}</div>
          </div>
          <div>
            <div className="metric-label">上市日期</div>
            <div className="metric-sub mono">{stock.list_date ?? '—'}</div>
          </div>
          <div>
            <div className="metric-label">交易状态</div>
            <div className="metric-sub">{stock.is_active ? '正常交易' : '已退市'}</div>
          </div>
        </div>
      </section>

      <div className="tab-bar" role="tablist" aria-label="个股分析维度">
        {TABS.map((tab) => (
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
