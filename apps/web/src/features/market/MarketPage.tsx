import { useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Card } from '../../components/ui/Card'
import { GlossaryLabel, InfoHint, type CustomGlossaryEntry } from '../../components/ui/InfoHint'
import { Metric } from '../../components/ui/Metric'
import { ScoreRing } from '../../components/ui/ScoreRing'
import { EmptyBlock, ErrorBlock, LoadingBlock } from '../../components/ui/StateBlock'
import { Tag } from '../../components/ui/Tag'
import { createChartTheme } from '../../lib/chartTheme'
import { Chart, type ChartOption } from '../../lib/charts'
import { chgClass, fmtDateTime, fmtMoney, fmtNum, fmtPct } from '../../lib/format'
import { useThemeMode } from '../../lib/theme'
import { useStockScreener } from '../../lib/useStockAnalysis'
import type {
  MarketOverview,
  ScreenerQualityFilter,
  StockScreenerItem,
  TemperatureLevel,
} from '../../types/api'
import { DiscoveryBoard } from './DiscoveryBoard'
import { ScreenerSection } from './ScreenerSection'
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

const INDEX_HINT_BY_CODE: Record<string, CustomGlossaryEntry> = {
  '000001': {
    summary: '上海证券交易所综合指数，覆盖上交所全部上市股票，按总市值加权反映沪市大盘整体表现。',
    reading: '受银行、能源、央企权重股影响较大；用于对照全市场大盘温度与权重走势。',
  },
  '399001': {
    summary: '深圳证券交易所成份指数，选取深市最具代表性的 500 家上市公司按自由流通市值加权编制。',
    reading: '先进制造、消费电子与成长蓝筹占比较高，常与上证指数交叉观察市场风格分化。',
  },
  '399006': {
    summary: '创业板核心宽基指数，聚焦深市创业板高成长创新与科技医药类头部企业。',
    reading: '弹性与波动率通常高于主板指数，可侧面反映市场风险偏好与成长赛道情绪。',
  },
  '000300': {
    summary:
      '沪深 300 指数，汇集沪深两市市值大、流动性好的 300 只核心蓝筹龙头，是机构与本系统决策账本的默认基准。',
    reading: '代表 A 股核心资产 Beta 基准，个股决策日记超额 Alpha 均以此指数同期涨跌作对照。',
  },
}

function getIndexHintEntry(name: string): CustomGlossaryEntry {
  return {
    summary: `${name}的实时点位与当日涨跌幅快照，用于观察 A 股核心宽基市场的整体方向与 Beta 风险偏好。`,
    reading: '红色上涨、绿色下跌（符合 A 股红涨绿跌习惯）；指数短期涨跌不改变个股安全边际锚点。',
  }
}

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

function MarketOverviewContent({
  data,
  flowOption,
  industry,
  onClearIndustry,
  onToggleIndustry,
}: {
  data: MarketOverview
  flowOption: ChartOption
  industry: string
  onClearIndustry: () => void
  onToggleIndustry: (industryName: string) => void
}) {
  const meta = LEVEL_META[data.temperature.level]

  return (
    <>
      <Card
        title="市场温度"
        hint="market_temperature"
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
              <Metric
                label="全市场 PE 中位数"
                hint="pe_median"
                value={fmtNum(data.temperature.pe_median, 1)}
              />
              <Metric
                label="历史分位"
                hint="market_pe_percentile"
                value={`${fmtNum(data.temperature.pe_percentile, 0)}%`}
                sub="越低越便宜"
              />
              <Metric
                label="十年国债"
                hint="bond_yield_10y"
                value={`${fmtNum(data.temperature.bond_yield, 2)}%`}
                sub="无风险收益锚"
              />
              <Metric
                label="股债性价比"
                hint="equity_bond_spread"
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
              <span className="label-with-hint">
                <span className="soft">{index.name}</span>
                <InfoHint
                  title={index.name}
                  entry={INDEX_HINT_BY_CODE[index.code] ?? getIndexHintEntry(index.name)}
                />
              </span>
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
          hint="industry_money_flow"
          extra={<span className="small muted">红流入 / 绿流出 · 点击行业联动筛选</span>}
        >
          <Chart
            option={flowOption}
            height={340}
            ariaLabel="行业净流入柱状图"
            onDatumClick={({ name }) => onToggleIndustry(name)}
          />
        </Card>

        <Card
          title={
            <span className="label-with-hint">
              <span>净流入排行</span>
              <InfoHint
                title="净流入排行"
                entry={{
                  summary:
                    '按统计周期内申万行业主力资金净流入金额排序的明细榜，直观对比板块涨跌幅、资金净差额与成份股数。',
                  reading: '点击任意行业行或左侧柱状图可联动筛选下方价值精选雷达中的同行业标的。',
                }}
              />
            </span>
          }
          extra={
            industry ? (
              <button type="button" className="filter-pill active" onClick={onClearIndustry}>
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
                  <th>
                    <GlossaryLabel label="行业" term="industry_sw1" />
                  </th>
                  <th style={{ textAlign: 'right' }}>
                    <GlossaryLabel label="涨跌幅" term="industry_change_pct" />
                  </th>
                  <th style={{ textAlign: 'right' }}>
                    <GlossaryLabel label="净流入" term="industry_net_inflow" />
                  </th>
                  <th style={{ textAlign: 'right' }}>
                    <GlossaryLabel label="公司数" term="industry_company_count" />
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.hot_industries.map((flow) => {
                  const isSelected = industry === flow.name
                  return (
                    <tr
                      key={flow.name}
                      className={isSelected ? 'industry-flow-row active' : 'industry-flow-row'}
                      onClick={() => onToggleIndustry(flow.name)}
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
                            onToggleIndustry(flow.name)
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
    </>
  )
}

export function MarketPage() {
  const { data, error, isPending, isFetching, isError, refetch } = useMarketOverview()
  const { theme } = useThemeMode()

  // Unfiltered pool shares cache key with default screener view on mount so only one request fires.
  const poolQuery = useStockScreener({ limit: 50 })

  const screenerSectionRef = useRef<HTMLElement>(null)
  const [industry, setIndustry] = useState('')
  const [qualityFilter, setQualityFilter] = useState<ScreenerQualityFilter | undefined>(undefined)

  const featuredStocks = useMemo(
    () => pickFeaturedSyncedStocks(poolQuery.data?.items ?? [], 5),
    [poolQuery.data?.items],
  )

  function scrollToScreener() {
    if (typeof screenerSectionRef.current?.scrollIntoView === 'function') {
      screenerSectionRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }

  function handleIndustryToggle(industryName: string) {
    const next = industry === industryName ? '' : industryName
    setIndustry(next)
    if (next) {
      scrollToScreener()
    }
  }

  function applyDiscoveryQualityFilter(nextFilter: ScreenerQualityFilter) {
    setQualityFilter(nextFilter)
    scrollToScreener()
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

  return (
    <div className="container stack" style={{ gap: 16 }}>
      <section
        className="card-machined stack"
        style={{ padding: '12px 18px', gap: 8 }}
        aria-label="三步价值投资工作流"
      >
        <div className="row" style={{ justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
          <div className="row" style={{ justifyContent: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
            <span className="small soft" style={{ fontWeight: 600 }}>
              <GlossaryLabel label="三步价值投资工作流" term="workflow_guide" />
            </span>
            <span className="workflow-steps">
              ① 搜公司查排雷与估值水位 → ② 加入自选设好价格击球区 → ③
              买入前走反方质询，留下时间胶囊与否证红线
            </span>
          </div>
          <Tag color="blue">新手快速上手</Tag>
        </div>
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
      </section>

      <DiscoveryBoard onQuickFilter={applyDiscoveryQualityFilter} />

      {isPending || (!data && isFetching) ? (
        <Card title="市场温度" hint="market_temperature">
          <LoadingBlock lines={5} />
        </Card>
      ) : isError ? (
        <Card title="市场温度" hint="market_temperature">
          <ErrorBlock
            title="行情加载失败"
            message={error instanceof Error ? error.message : '未知错误'}
            onRetry={() => {
              void refetch()
            }}
          />
        </Card>
      ) : !data ? (
        <Card title="市场温度" hint="market_temperature">
          <EmptyBlock title="暂无市场概览数据" hint="请稍后刷新重试。" />
        </Card>
      ) : (
        <MarketOverviewContent
          data={data}
          flowOption={flowOption}
          industry={industry}
          onClearIndustry={() => setIndustry('')}
          onToggleIndustry={handleIndustryToggle}
        />
      )}

      <ScreenerSection
        ref={screenerSectionRef}
        industry={industry}
        onIndustryChange={setIndustry}
        qualityFilter={qualityFilter}
        onQualityFilterChange={setQualityFilter}
        poolIndustries={poolQuery.data?.industries}
      />

      {data ? (
        <div className="row small muted">
          <span>
            数据来源：<span className="mono">{data.data_source}</span>
          </span>
          <span>
            快照日期：<span className="mono">{data.as_of}</span>
          </span>
        </div>
      ) : null}
    </div>
  )
}
