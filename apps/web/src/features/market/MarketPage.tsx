import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Card } from '../../components/ui/Card'
import { Metric } from '../../components/ui/Metric'
import { ScoreRing } from '../../components/ui/ScoreRing'
import { EmptyBlock, ErrorBlock, LoadingBlock } from '../../components/ui/StateBlock'
import { Tag } from '../../components/ui/Tag'
import { createChartTheme } from '../../lib/chartTheme'
import { Chart, type ChartOption } from '../../lib/charts'
import {
  chgClass,
  fmtDateTime,
  fmtMoney,
  fmtNum,
  fmtPct,
  formatNum,
  formatPct,
} from '../../lib/format'
import { useThemeMode } from '../../lib/theme'
import { useStockScreener } from '../../lib/useStockAnalysis'
import type {
  ScreenerSortDir,
  ScreenerSortField,
  StockScreenerFilters,
  StockScreenerItem,
  TemperatureLevel,
} from '../../types/api'
import { useMarketOverview } from './useMarketOverview'

const LEVEL_META: Record<
  TemperatureLevel,
  { label: string; color: 'gray' | 'green' | 'blue' | 'amber' | 'rose' }
> = {
  cold: { label: '冰点', color: 'blue' },
  cool: { label: '偏冷', color: 'green' },
  neutral: { label: '中性', color: 'gray' },
  warm: { label: '偏热', color: 'amber' },
  hot: { label: '过热', color: 'rose' },
}

const PE_PERCENTILE_OPTIONS: ReadonlyArray<{ label: string; value: number | undefined }> = [
  { label: '不限', value: undefined },
  { label: '< 30%', value: 30 },
  { label: '< 50%', value: 50 },
]

const ROE_OPTIONS: ReadonlyArray<{ label: string; value: number | undefined }> = [
  { label: '不限', value: undefined },
  { label: '>= 10%', value: 10 },
  { label: '>= 15%', value: 15 },
]

const DIVIDEND_OPTIONS: ReadonlyArray<{ label: string; value: number | undefined }> = [
  { label: '不限', value: undefined },
  { label: '>= 2%', value: 2 },
  { label: '>= 4%', value: 4 },
]

const SORT_OPTIONS: ReadonlyArray<{
  field: ScreenerSortField
  label: string
  defaultDir: ScreenerSortDir
}> = [
  { field: 'total_score', label: '雷达总分', defaultDir: 'desc' },
  { field: 'pe_percentile_10y', label: 'PE 10Y分位', defaultDir: 'asc' },
  { field: 'roe_5y_avg_pct', label: '5Y ROE', defaultDir: 'desc' },
  { field: 'dividend_yield_pct', label: '股息率', defaultDir: 'desc' },
  { field: 'pe_ttm', label: 'PE (TTM)', defaultDir: 'asc' },
  { field: 'total_mv_yuan', label: '总市值', defaultDir: 'desc' },
]

const MAX_COMPARE_SELECTION = 5

function pickFeaturedSyncedStocks(
  items: readonly StockScreenerItem[],
  limit = 5,
): StockScreenerItem[] {
  if (items.length === 0) {
    return []
  }
  const cleanFirst = [
    ...items.filter((item) => item.ct_red_count === 0),
    ...items.filter((item) => item.ct_red_count > 0),
  ]
  const picked: StockScreenerItem[] = []
  const pickedCodes = new Set<string>()
  const seenIndustries = new Set<string>()

  // First pass maximizes industry diversity before filling remaining slots by rank.
  for (const item of cleanFirst) {
    if (picked.length >= limit) break
    const industryKey = item.industry_sw1?.trim() ?? ''
    if (industryKey && seenIndustries.has(industryKey)) continue
    if (industryKey) seenIndustries.add(industryKey)
    picked.push(item)
    pickedCodes.add(item.code)
  }

  for (const item of cleanFirst) {
    if (picked.length >= limit) break
    if (pickedCodes.has(item.code)) continue
    picked.push(item)
    pickedCodes.add(item.code)
  }

  return picked
}

function ctTagColor(item: StockScreenerItem): 'green' | 'amber' | 'rose' {
  if (item.ct_red_count > 0) return 'rose'
  if (item.ct_yellow_count > 0) return 'amber'
  return 'green'
}

export function MarketPage() {
  const { data, error, isPending, isFetching, isError, refetch } = useMarketOverview()
  const { theme } = useThemeMode()

  const screenerSectionRef = useRef<HTMLElement>(null)
  const [zeroRedOnly, setZeroRedOnly] = useState(false)
  const [maxPePercentile, setMaxPePercentile] = useState<number | undefined>(undefined)
  const [minRoe, setMinRoe] = useState<number | undefined>(undefined)
  const [minDividendYield, setMinDividendYield] = useState<number | undefined>(undefined)
  const [industry, setIndustry] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [sortBy, setSortBy] = useState<ScreenerSortField>('total_score')
  const [sortDir, setSortDir] = useState<ScreenerSortDir>('desc')
  const [selectedCompareCodes, setSelectedCompareCodes] = useState<string[]>([])

  useEffect(() => {
    const trimmed = searchInput.trim()
    if (!trimmed) {
      setDebouncedSearch('')
      return
    }
    const timer = window.setTimeout(() => {
      setDebouncedSearch(trimmed)
    }, 150)
    return () => {
      window.clearTimeout(timer)
    }
  }, [searchInput])

  // Unfiltered pool shares cache key with default screener view on mount so only one request fires.
  const poolQuery = useStockScreener({ limit: 50 })

  const screenerFilters = useMemo<StockScreenerFilters>(
    () => ({
      zeroRedOnly: zeroRedOnly || undefined,
      maxPePercentile,
      minRoe,
      minDividendYield,
      industry: industry || undefined,
      q: debouncedSearch || undefined,
      sortBy,
      sortDir,
      limit: 50,
    }),
    [
      zeroRedOnly,
      maxPePercentile,
      minRoe,
      minDividendYield,
      industry,
      debouncedSearch,
      sortBy,
      sortDir,
    ],
  )
  const screenerQuery = useStockScreener(screenerFilters)

  const featuredStocks = useMemo(
    () => pickFeaturedSyncedStocks(poolQuery.data?.items ?? [], 5),
    [poolQuery.data?.items],
  )

  const industryOptions = useMemo(() => {
    const base = poolQuery.data?.industries ?? screenerQuery.data?.industries ?? []
    if (industry && !base.includes(industry)) {
      return [industry, ...base]
    }
    return base
  }, [poolQuery.data?.industries, screenerQuery.data?.industries, industry])

  function handleIndustryToggle(industryName: string) {
    const next = industry === industryName ? '' : industryName
    setIndustry(next)
    if (next && typeof screenerSectionRef.current?.scrollIntoView === 'function') {
      screenerSectionRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }

  function resetScreenerFilters() {
    setZeroRedOnly(false)
    setMaxPePercentile(undefined)
    setMinRoe(undefined)
    setMinDividendYield(undefined)
    setIndustry('')
    setSearchInput('')
    setDebouncedSearch('')
    setSortBy('total_score')
    setSortDir('desc')
  }

  function toggleCompareCode(code: string) {
    setSelectedCompareCodes((prev) => {
      if (prev.includes(code)) {
        return prev.filter((item) => item !== code)
      }
      if (prev.length >= MAX_COMPARE_SELECTION) {
        return prev
      }
      return [...prev, code]
    })
  }

  const flowOption = useMemo<ChartOption>(() => {
    const { colors, axis, tooltip } = createChartTheme(theme)
    const flows = data?.hot_industries ?? []
    return {
      grid: { left: 12, right: 20, top: 16, bottom: 12, containLabel: true },
      tooltip: {
        ...tooltip,
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        valueFormatter: (value: unknown) => `${fmtNum(Number(value), 2)} 亿`,
      },
      xAxis: {
        ...axis,
        type: 'value',
        axisLabel: {
          ...axis.axisLabel,
          formatter: '{value} 亿',
        },
      },
      yAxis: {
        ...axis,
        type: 'category',
        inverse: true,
        data: flows.map((flow) => flow.name),
        axisLabel: {
          ...axis.axisLabel,
          color: colors.text,
        },
        axisLine: { show: false },
        axisTick: { show: false },
        splitLine: { show: false },
      },
      series: [
        {
          type: 'bar',
          barWidth: 14,
          cursor: 'pointer',
          data: flows.map((flow) => {
            const baseStyle = {
              color: flow.net_inflow >= 0 ? colors.flowIn : colors.flowOut,
              borderRadius: flow.net_inflow >= 0 ? [0, 6, 6, 0] : [6, 0, 0, 6],
            }
            return {
              value: Number((flow.net_inflow / 1e8).toFixed(2)),
              itemStyle:
                industry === flow.name
                  ? { ...baseStyle, borderColor: colors.white, borderWidth: 1.5 }
                  : baseStyle,
            }
          }),
        },
      ],
    }
  }, [data, industry, theme])

  if (isPending || (!data && isFetching)) {
    return (
      <div className="container">
        <Card title="市场温度">
          <LoadingBlock lines={5} />
        </Card>
      </div>
    )
  }

  if (isError) {
    return (
      <div className="container">
        <Card title="市场温度">
          <ErrorBlock
            title="行情加载失败"
            message={error instanceof Error ? error.message : '未知错误'}
            onRetry={() => {
              void refetch()
            }}
          />
        </Card>
      </div>
    )
  }

  if (!data) {
    return (
      <div className="container">
        <Card title="市场温度">
          <EmptyBlock title="暂无市场概览数据" hint="请稍后刷新重试。" />
        </Card>
      </div>
    )
  }

  const meta = LEVEL_META[data.temperature.level]
  const screenerData = screenerQuery.data
  const screenerItems = screenerData?.items ?? []
  const topCandidates = screenerItems.slice(0, 3)
  const hasActiveFilter =
    zeroRedOnly ||
    maxPePercentile !== undefined ||
    minRoe !== undefined ||
    minDividendYield !== undefined ||
    industry.length > 0 ||
    searchInput.trim().length > 0 ||
    sortBy !== 'total_score' ||
    sortDir !== 'desc'

  return (
    <div className="container stack" style={{ gap: 16 }}>
      <Card title="三步价值投资工作流" extra={<Tag color="blue">新手快速上手</Tag>}>
        <div className="stack" style={{ gap: 12 }}>
          <p className="workflow-steps">
            ① 搜公司查排雷与估值水位 → ② 加入自选设好价格击球区 → ③
            买入前走反方质询，留下时间胶囊与否证红线
          </p>
          <div className="sample-stock-row" role="group" aria-label="精选已同步示例标的">
            <span className="small muted">精选已同步示例标的：</span>
            {poolQuery.isPending ? (
              <span className="small muted">正在加载已同步标的池...</span>
            ) : poolQuery.isError ? (
              <span className="small muted">已同步标的池暂不可用，可通过顶部搜索框检索个股。</span>
            ) : featuredStocks.length === 0 ? (
              <span className="small muted">暂无已同步全量快照标的，请先通过同步任务接入。</span>
            ) : (
              featuredStocks.map((stock) => (
                <Link key={stock.code} className="sample-stock-chip" to={`/stock/${stock.code}`}>
                  <span className="mono">{stock.code}</span>
                  <span>{stock.name}</span>
                  {stock.industry_sw1 ? (
                    <span className="small muted">{stock.industry_sw1}</span>
                  ) : null}
                </Link>
              ))
            )}
          </div>
        </div>
      </Card>

      <Card
        title="市场温度"
        extra={
          <span className="row" style={{ gap: 8 }}>
            <Tag color={meta.color}>{meta.label}</Tag>
            <Tag color="gray">{`交易日 ${data.as_of}`}</Tag>
            <span className="small muted mono">{fmtDateTime(data.generated_at)}</span>
          </span>
        }
      >
        <div className="hero">
          <ScoreRing score={data.temperature.score} label="TEMP" />
          <div className="stack">
            <div className="grid grid-4">
              <Metric label="全市场 PE 中位数" value={fmtNum(data.temperature.pe_median, 1)} />
              <Metric
                label="历史分位"
                value={`${fmtNum(data.temperature.pe_percentile, 0)}%`}
                sub="越低越便宜"
              />
              <Metric
                label="十年国债"
                value={`${fmtNum(data.temperature.bond_yield, 2)}%`}
                sub="无风险收益锚"
              />
              <Metric
                label="股债性价比"
                value={`${fmtNum(data.temperature.equity_bond_spread, 2)}%`}
                sub="EP − 国债（越高股票越占优）"
                tone={data.temperature.equity_bond_spread > 0 ? 'up' : 'down'}
              />
            </div>
            <p className="hero-comment">{data.temperature.comment}</p>
            <p className="small muted">
              市场冷暖提示：温度偏冷代表全市场估值分位较低；股债性价比（ERP = 股票盈利收益率 EP −
              十年国债收益率）越高，说明权益资产相对国债越具配置价值。
            </p>
          </div>
        </div>
      </Card>

      <div className="grid grid-4">
        {data.indices.map((index) => (
          <Card key={index.code}>
            <div className="row">
              <span className="soft">{index.name}</span>
              <Tag color={index.change_pct > 0 ? 'rose' : index.change_pct < 0 ? 'green' : 'gray'}>
                {fmtPct(index.change_pct)}
              </Tag>
            </div>
            <div className={`metric-value mt-8 ${chgClass(index.change_pct)}`}>
              {fmtNum(index.price, 2)}
            </div>
            <div className="small muted mono">{index.code}</div>
          </Card>
        ))}
      </div>

      <div className="grid grid-2">
        <Card
          className="flow-card"
          title="行业资金流（亿元）"
          extra={<span className="small muted">红流入 / 绿流出 · 点击行业联动筛选</span>}
        >
          <Chart
            option={flowOption}
            height={340}
            ariaLabel="行业净流入柱状图"
            onDatumClick={({ name }) => handleIndustryToggle(name)}
          />
        </Card>

        <Card
          title="净流入排行"
          extra={
            industry ? (
              <button type="button" className="filter-pill active" onClick={() => setIndustry('')}>
                {`已筛选: ${industry} ×`}
              </button>
            ) : (
              <span className="small muted">点击行筛选下方雷达池</span>
            )
          }
        >
          <div className="table-wrap">
            <table className="table" aria-label="行业净流入排行表">
              <thead>
                <tr>
                  <th>行业</th>
                  <th style={{ textAlign: 'right' }}>涨跌幅</th>
                  <th style={{ textAlign: 'right' }}>净流入</th>
                  <th style={{ textAlign: 'right' }}>公司数</th>
                </tr>
              </thead>
              <tbody>
                {data.hot_industries.map((flow) => {
                  const isSelected = industry === flow.name
                  return (
                    <tr
                      key={flow.name}
                      className={isSelected ? 'industry-flow-row active' : 'industry-flow-row'}
                      onClick={() => handleIndustryToggle(flow.name)}
                    >
                      <td>
                        <button
                          type="button"
                          className={
                            isSelected ? 'industry-filter-btn active' : 'industry-filter-btn'
                          }
                          aria-pressed={isSelected}
                          onClick={(event) => {
                            event.stopPropagation()
                            handleIndustryToggle(flow.name)
                          }}
                        >
                          {flow.name}
                        </button>
                      </td>
                      <td className={`num ${chgClass(flow.change_pct)}`}>
                        {fmtPct(flow.change_pct)}
                      </td>
                      <td className={`num ${chgClass(flow.net_inflow)}`}>
                        {fmtMoney(flow.net_inflow)}
                      </td>
                      <td className="num muted">
                        {flow.companies !== null && flow.companies !== undefined
                          ? flow.companies
                          : '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      <section
        ref={screenerSectionRef}
        className="card-machined bento-pad stack screener-deck"
        style={{ gap: 18 }}
        aria-label="价值击球区精选雷达"
      >
        <div className="sec-head" style={{ marginBottom: 0 }}>
          <div className="stack" style={{ gap: 6 }}>
            <div
              className="row"
              style={{ justifyContent: 'flex-start', gap: 10, flexWrap: 'wrap' }}
            >
              <span className="eyebrow-pill">
                <span className="live-beacon" />
                VALUE SCREENER
              </span>
              <h2 className="sec-title">价值击球区精选雷达</h2>
              {screenerQuery.isFetching && screenerData ? (
                <Tag color="blue">筛选更新中...</Tag>
              ) : null}
            </div>
            <p className="sec-sub">
              {screenerData
                ? `已同步全量财报标的池 ${screenerData.total_synced} 支 · 当前命中 ${screenerData.filtered_count} 支`
                : '基于已同步全量财报快照的多维价值筛查与排雷雷达'}
            </p>
          </div>

          <div className="screener-compare-bar">
            <Tag color={selectedCompareCodes.length > 0 ? 'green' : 'gray'}>
              {`已选对比 ${selectedCompareCodes.length} / ${MAX_COMPARE_SELECTION}`}
            </Tag>
            {selectedCompareCodes.length > 0 ? (
              <>
                <Link
                  className="btn-cta-sm"
                  to={`/compare?codes=${selectedCompareCodes.join(',')}`}
                >
                  {`发起对比 (${selectedCompareCodes.length})`}
                </Link>
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => setSelectedCompareCodes([])}
                >
                  清空勾选
                </button>
              </>
            ) : (
              <span className="small muted">勾选下方最多 5 支发起横向对比</span>
            )}
          </div>
        </div>

        <div className="screener-filters">
          <div className="screener-filter-row">
            <div className="screener-filter-group">
              <span className="screener-filter-label">排雷过滤</span>
              <div className="seg-well" role="group" aria-label="排雷过滤">
                <button
                  type="button"
                  className={zeroRedOnly ? 'seg-tab seg-tab-sm active' : 'seg-tab seg-tab-sm'}
                  aria-pressed={zeroRedOnly}
                  onClick={() => setZeroRedOnly((prev) => !prev)}
                >
                  仅看零红灯
                </button>
              </div>
            </div>

            <div className="screener-filter-group">
              <span className="screener-filter-label">PE 10Y 分位</span>
              <div className="seg-well" role="group" aria-label="PE 10Y 分位">
                {PE_PERCENTILE_OPTIONS.map((opt) => {
                  const active = maxPePercentile === opt.value
                  return (
                    <button
                      key={opt.label}
                      type="button"
                      className={active ? 'seg-tab seg-tab-sm active' : 'seg-tab seg-tab-sm'}
                      aria-pressed={active}
                      onClick={() => setMaxPePercentile(opt.value)}
                    >
                      {opt.label}
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="screener-filter-group">
              <span className="screener-filter-label">5Y ROE</span>
              <div className="seg-well" role="group" aria-label="5Y ROE">
                {ROE_OPTIONS.map((opt) => {
                  const active = minRoe === opt.value
                  return (
                    <button
                      key={opt.label}
                      type="button"
                      className={active ? 'seg-tab seg-tab-sm active' : 'seg-tab seg-tab-sm'}
                      aria-pressed={active}
                      onClick={() => setMinRoe(opt.value)}
                    >
                      {opt.label}
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="screener-filter-group">
              <span className="screener-filter-label">股息率</span>
              <div className="seg-well" role="group" aria-label="股息率">
                {DIVIDEND_OPTIONS.map((opt) => {
                  const active = minDividendYield === opt.value
                  return (
                    <button
                      key={opt.label}
                      type="button"
                      className={active ? 'seg-tab seg-tab-sm active' : 'seg-tab seg-tab-sm'}
                      aria-pressed={active}
                      onClick={() => setMinDividendYield(opt.value)}
                    >
                      {opt.label}
                    </button>
                  )
                })}
              </div>
            </div>
          </div>

          <div className="screener-control-row">
            <select
              className="input screener-select"
              aria-label="行业筛选"
              value={industry}
              onChange={(event) => setIndustry(event.target.value)}
            >
              <option value="">全部行业</option>
              {industryOptions.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>

            <input
              type="search"
              className="input screener-search-input"
              aria-label="筛选代码或名称"
              placeholder="筛选代码或名称..."
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  setDebouncedSearch(searchInput.trim())
                }
              }}
            />

            <div className="screener-sort-group">
              <select
                className="input screener-select"
                aria-label="排序方式"
                value={sortBy}
                onChange={(event) => {
                  const nextField = event.target.value as ScreenerSortField
                  const preset = SORT_OPTIONS.find((opt) => opt.field === nextField)
                  setSortBy(nextField)
                  if (preset) {
                    setSortDir(preset.defaultDir)
                  }
                }}
              >
                {SORT_OPTIONS.map((opt) => (
                  <option key={opt.field} value={opt.field}>
                    {`按${opt.label}`}
                  </option>
                ))}
              </select>

              <button
                type="button"
                className="btn-ghost screener-dir-btn"
                aria-label="切换排序方向"
                onClick={() => setSortDir((prev) => (prev === 'desc' ? 'asc' : 'desc'))}
              >
                {sortDir === 'desc' ? '降序 ↓' : '升序 ↑'}
              </button>
            </div>

            <button
              type="button"
              className="btn-ghost"
              disabled={!hasActiveFilter}
              onClick={resetScreenerFilters}
            >
              重置筛选
            </button>
          </div>
        </div>

        {screenerQuery.isPending && !screenerData ? (
          <LoadingBlock lines={5} />
        ) : screenerQuery.isError ? (
          <ErrorBlock
            title="精选雷达加载失败"
            message={
              screenerQuery.error instanceof Error ? screenerQuery.error.message : '未知错误'
            }
            onRetry={() => {
              void screenerQuery.refetch()
            }}
          />
        ) : screenerItems.length === 0 ? (
          <div className="stack" style={{ gap: 12, alignItems: 'center' }}>
            <EmptyBlock
              title="当前筛选条件下暂无匹配标的"
              hint={
                industry
                  ? `当前行业「${industry}」或复合阈值下无已同步标的，可放宽条件或重置筛选。`
                  : '可尝试放宽 PE 分位、5Y ROE 或股息率条件。'
              }
            />
            {hasActiveFilter ? (
              <button type="button" className="btn-primary" onClick={resetScreenerFilters}>
                恢复默认筛选
              </button>
            ) : null}
          </div>
        ) : (
          <>
            <div className="screener-top-grid" aria-label="精选候选前三名">
              {topCandidates.map((item) => {
                const isSelected = selectedCompareCodes.includes(item.code)
                const atLimit = !isSelected && selectedCompareCodes.length >= MAX_COMPARE_SELECTION
                return (
                  <div
                    key={item.code}
                    className={
                      isSelected ? 'tk-card screener-top-card active' : 'tk-card screener-top-card'
                    }
                  >
                    <div className="row" style={{ width: '100%', alignItems: 'flex-start' }}>
                      <div className="stack" style={{ gap: 4 }}>
                        <div
                          className="row"
                          style={{ justifyContent: 'flex-start', gap: 8, flexWrap: 'wrap' }}
                        >
                          <Link
                            className="link-accent screener-card-name"
                            to={`/stock/${item.code}`}
                          >
                            {item.name}
                          </Link>
                          <span className="code-pill">{item.code}</span>
                        </div>
                        <span className="small muted">{item.industry_sw1 ?? '未分类'}</span>
                      </div>
                      <Tag color={ctTagColor(item)}>
                        {`${item.ct_red_count} 红 / ${item.ct_yellow_count} 黄`}
                      </Tag>
                    </div>

                    <div className="screener-top-metrics">
                      <div className="screener-top-stat">
                        <span className="small muted">雷达总分</span>
                        <span className="tnum screener-top-score">{item.total_score}</span>
                      </div>
                      <div className="screener-top-stat">
                        <span className="small muted">PE分位</span>
                        <span className="tnum">{formatPct(item.pe_percentile_10y, 1)}</span>
                      </div>
                      <div className="screener-top-stat">
                        <span className="small muted">5Y ROE</span>
                        <span className="tnum">{formatPct(item.roe_5y_avg_pct, 1)}</span>
                      </div>
                      <div className="screener-top-stat">
                        <span className="small muted">股息率</span>
                        <span className="tnum">{formatPct(item.dividend_yield_pct, 2)}</span>
                      </div>
                    </div>

                    <div className="row" style={{ width: '100%' }}>
                      <Link className="small link-accent" to={`/stock/${item.code}`}>
                        查看深度分析 →
                      </Link>
                      <button
                        type="button"
                        className={isSelected ? 'filter-pill active' : 'filter-pill'}
                        disabled={atLimit}
                        onClick={() => toggleCompareCode(item.code)}
                      >
                        {isSelected ? '已选对比' : '加入对比'}
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>

            <div className="table-wrap">
              <table className="pro-table screener-table" aria-label="价值筛选结果明细表">
                <thead>
                  <tr>
                    <th>对比</th>
                    <th>代码 / 名称</th>
                    <th>行业</th>
                    <th className="text-right">雷达总分</th>
                    <th>排雷灯</th>
                    <th className="text-right">PE(TTM) / 10Y分位</th>
                    <th className="text-right">5Y ROE</th>
                    <th className="text-right">股息率</th>
                  </tr>
                </thead>
                <tbody>
                  {screenerItems.map((item) => {
                    const isChecked = selectedCompareCodes.includes(item.code)
                    const isDisabled =
                      !isChecked && selectedCompareCodes.length >= MAX_COMPARE_SELECTION
                    return (
                      <tr key={item.code}>
                        <td>
                          <input
                            type="checkbox"
                            aria-label={`选择对比 ${item.code} ${item.name}`}
                            checked={isChecked}
                            disabled={isDisabled}
                            onChange={() => toggleCompareCode(item.code)}
                          />
                        </td>
                        <td>
                          <div className="screener-stock-cell">
                            <Link
                              className="link-accent screener-stock-name"
                              to={`/stock/${item.code}`}
                            >
                              {item.name}
                            </Link>
                            <span className="mono small muted">{item.code}</span>
                            {item.is_financial ? <Tag color="blue">金融</Tag> : null}
                          </div>
                        </td>
                        <td className="soft">{item.industry_sw1 ?? '—'}</td>
                        <td className="text-right tnum">
                          <Tag
                            color={
                              item.total_score >= 70
                                ? 'green'
                                : item.total_score >= 45
                                  ? 'blue'
                                  : 'amber'
                            }
                          >
                            {item.total_score}
                          </Tag>
                        </td>
                        <td>
                          <Tag color={ctTagColor(item)}>
                            {`${item.ct_red_count} 红 / ${item.ct_yellow_count} 黄`}
                          </Tag>
                        </td>
                        <td className="text-right tnum">
                          {`${formatNum(item.pe_ttm, 1)} / ${formatPct(item.pe_percentile_10y, 1)}`}
                        </td>
                        <td className="text-right tnum">{formatPct(item.roe_5y_avg_pct, 2)}</td>
                        <td className="text-right tnum">{formatPct(item.dividend_yield_pct, 2)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      <div className="row small muted">
        <span>
          数据来源：<span className="mono">{data.data_source}</span>
        </span>
        <span>
          快照日期：<span className="mono">{data.as_of}</span>
        </span>
      </div>
    </div>
  )
}
