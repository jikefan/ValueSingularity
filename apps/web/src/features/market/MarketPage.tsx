import { useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Card } from '../../components/ui/Card'
import { GlossaryLabel, InfoHint } from '../../components/ui/InfoHint'
import { Metric } from '../../components/ui/Metric'
import { ScoreRing } from '../../components/ui/ScoreRing'
import { EmptyBlock, ErrorBlock, LoadingBlock } from '../../components/ui/StateBlock'
import { Tag } from '../../components/ui/Tag'
import { createChartTheme } from '../../lib/chartTheme'
import { Chart, type ChartOption } from '../../lib/charts'
import { chgClass, fmtDateTime, fmtMoney, fmtNum, fmtPct, formatStockName } from '../../lib/format'
import { useThemeMode } from '../../lib/theme'
import { useStockScreener } from '../../lib/useStockAnalysis'
import type { MarketOverview, ScreenerQualityFilter } from '../../types/api'
import { DiscoveryBoard } from './DiscoveryBoard'
import {
  INDEX_HINT_BY_CODE,
  LEVEL_META,
  getIndexHintEntry,
  pickFeaturedSyncedStocks,
  plainMarketTemperatureTakeaway,
} from './marketHelpers'
import { ScreenerSection } from './ScreenerSection'
import { useMarketOverview } from './useMarketOverview'

function MarketTemperatureAndIndices({ data }: { data: MarketOverview }) {
  const meta = LEVEL_META[data.temperature.level]
  const plainTakeaway = plainMarketTemperatureTakeaway(data.temperature)

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
            <p className="info-hint-plain">
              <strong>大白话：</strong>
              {plainTakeaway}
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
    </>
  )
}

function IndustryFlowSection({
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
  return (
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
        <div
          className="sample-stock-row sample-stock-row-scroll"
          role="group"
          aria-label="精选已同步示例标的"
        >
          <span className="small muted">精选已同步示例标的：</span>
          {poolQuery.isPending ? (
            <span className="small muted">正在加载已同步标的池...</span>
          ) : poolQuery.isError ? (
            <span className="small muted">已同步标的池暂不可用，可通过顶部搜索框检索个股。</span>
          ) : featuredStocks.length === 0 ? (
            <span className="small muted">暂无已同步全量快照标的，请先通过同步任务接入。</span>
          ) : (
            featuredStocks.map(({ item, badgeText }) => (
              <Link key={item.code} className="sample-stock-chip" to={`/stock/${item.code}`}>
                <span className="mono">{item.code}</span>
                <span>{formatStockName(item.name)}</span>
                {badgeText ? <span className="small muted">{`· ${badgeText}`}</span> : null}
              </Link>
            ))
          )}
        </div>
      </section>

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
        <MarketTemperatureAndIndices data={data} />
      )}

      <DiscoveryBoard onQuickFilter={applyDiscoveryQualityFilter} />

      {data ? (
        <IndustryFlowSection
          data={data}
          flowOption={flowOption}
          industry={industry}
          onClearIndustry={() => setIndustry('')}
          onToggleIndustry={handleIndustryToggle}
        />
      ) : null}

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
