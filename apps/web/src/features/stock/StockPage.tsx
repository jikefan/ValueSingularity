import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Card } from '../../components/ui/Card'
import { EmptyBlock, ErrorBlock, LoadingBlock } from '../../components/ui/StateBlock'
import { Tag } from '../../components/ui/Tag'
import { ApiError, api } from '../../lib/api'
import { useAuth } from '../../lib/authContext'
import { queryKeys } from '../../lib/queryKeys'
import { useStockSnapshot } from '../../lib/useStockAnalysis'
import { useAddWatchlist, useRemoveWatchlist, useWatchlist } from '../../lib/useWatchlist'
import type { StockSnapshotPayload } from '../../types/api'
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

function StockPageContent({ code }: { code: string }) {
  const { user, isAuthLoading } = useAuth()
  const [activeTab, setActiveTab] = useState<TabKey>('overview')

  const stockQuery = useQuery({
    queryKey: queryKeys.stocks.detail(code),
    queryFn: ({ signal }) => api.getStock(code, signal),
  })

  const stock = stockQuery.data
  const snapshotQuery = useStockSnapshot(code, Boolean(stock?.snapshot_available))
  const watchlistQuery = useWatchlist(Boolean(user))
  const addWatchlistMutation = useAddWatchlist()
  const removeWatchlistMutation = useRemoveWatchlist()

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
    if (stockQuery.error instanceof ApiError && stockQuery.error.status === 404) {
      return (
        <div className="container stack" style={{ gap: 16 }}>
          <Card title={`${code} · 个股分析`} extra={<Tag color="amber">未收录</Tag>}>
            <EmptyBlock
              title={`未找到股票 ${code}`}
              hint={
                <span className="stack" style={{ gap: 10, alignItems: 'center' }}>
                  <span>
                    本地股票池暂未收录该 6 位代码，请确认代码是否正确或返回市场概览重新搜索。
                  </span>
                  <Link className="btn-ghost" to="/">
                    返回市场概览
                  </Link>
                  <details className="small muted">
                    <summary style={{ cursor: 'pointer' }}>管理员离线同步命令</summary>
                    <div className="mt-8">
                      <code className="mono">python -m app.cli.sync</code>
                    </div>
                  </details>
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
  const industryText =
    [currentStock.industry_sw1, currentStock.industry_sw2].filter(Boolean).join(' / ') || '—'
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

  const isSnapshot404 =
    snapshotQuery.isError &&
    snapshotQuery.error instanceof ApiError &&
    snapshotQuery.error.status === 404
  const isSnapshotUnsynced = !currentStock.snapshot_available || isSnapshot404
  const snapshot = snapshotQuery.data ?? null

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
                <details className="small muted">
                  <summary style={{ cursor: 'pointer' }}>管理员离线同步命令</summary>
                  <div className="mt-8">
                    <code className="mono">{`python -m app.cli.sync_stocks --codes ${currentStock.code}`}</code>
                  </div>
                </details>
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
      <Card>
        <div className="stock-header-top">
          <div className="stack" style={{ gap: 8 }}>
            <div className="stock-title-row">
              <h1 className="stock-name">{stock.name}</h1>
              <span className="mono soft">{stock.code}</span>
              <Tag color="blue">{stock.exchange}</Tag>
              {stock.is_st ? <Tag color="amber">ST</Tag> : null}
              {!stock.is_active ? <Tag color="rose">已退市</Tag> : null}
              <Tag color={stock.snapshot_available && !isSnapshot404 ? 'green' : 'gray'}>
                {stock.snapshot_available && !isSnapshot404 ? '已预计算快照' : '基础元数据'}
              </Tag>
            </div>
            <div className="small muted">
              申万行业：{industryText}
              {snapshot ? ` · 快照日期 ${snapshot.as_of} · 数据源 ${snapshot.data_source}` : ''}
            </div>
          </div>

          <div className="stack stock-header-actions" style={{ gap: 8 }}>
            <div className="row stock-header-action-row" style={{ gap: 8, flexWrap: 'wrap' }}>
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
      </Card>

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
              返回市场概览
            </Link>
          </div>
        </Card>
      </div>
    )
  }

  return <StockPageContent key={normalizedCode} code={normalizedCode} />
}
