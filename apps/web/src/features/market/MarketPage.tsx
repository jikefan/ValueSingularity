import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { Card } from '../../components/ui/Card'
import { Metric } from '../../components/ui/Metric'
import { ScoreRing } from '../../components/ui/ScoreRing'
import { EmptyBlock, ErrorBlock, LoadingBlock } from '../../components/ui/StateBlock'
import { Tag } from '../../components/ui/Tag'
import { CHART_AXIS_COMMON, CHART_COLORS, CHART_TOOLTIP_COMMON } from '../../lib/chartTheme'
import { Chart, type ChartOption } from '../../lib/charts'
import { chgClass, fmtDateTime, fmtMoney, fmtNum, fmtPct } from '../../lib/format'
import type { TemperatureLevel } from '../../types/api'
import { useMarketOverview } from './useMarketOverview'

const SAMPLE_STOCKS: ReadonlyArray<{ code: string; name: string }> = [
  { code: '600519', name: '贵州茅台' },
  { code: '600036', name: '招商银行' },
  { code: '002594', name: '比亚迪' },
  { code: '000858', name: '五粮液' },
  { code: '300750', name: '宁德时代' },
]

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

export function MarketPage() {
  const { data, error, isPending, isFetching, isError, refetch } = useMarketOverview()

  const flowOption = useMemo<ChartOption>(() => {
    const flows = data?.hot_industries ?? []
    return {
      grid: { left: 12, right: 20, top: 16, bottom: 12, containLabel: true },
      tooltip: {
        ...CHART_TOOLTIP_COMMON,
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        valueFormatter: (value: unknown) => `${fmtNum(Number(value), 2)} 亿`,
      },
      xAxis: {
        ...CHART_AXIS_COMMON,
        type: 'value',
        axisLabel: {
          ...CHART_AXIS_COMMON.axisLabel,
          formatter: '{value} 亿',
        },
      },
      yAxis: {
        ...CHART_AXIS_COMMON,
        type: 'category',
        inverse: true,
        data: flows.map((flow) => flow.name),
        axisLabel: {
          ...CHART_AXIS_COMMON.axisLabel,
          color: CHART_COLORS.text,
        },
        axisLine: { show: false },
        axisTick: { show: false },
        splitLine: { show: false },
      },
      series: [
        {
          type: 'bar',
          barWidth: 14,
          data: flows.map((flow) => ({
            value: Number((flow.net_inflow / 1e8).toFixed(2)),
            itemStyle: {
              color: flow.net_inflow >= 0 ? CHART_COLORS.positive : CHART_COLORS.negative,
              borderRadius: flow.net_inflow >= 0 ? [0, 6, 6, 0] : [6, 0, 0, 6],
            },
          })),
        },
      ],
    }
  }, [data])

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

  return (
    <div className="container stack" style={{ gap: 16 }}>
      <Card title="三步价值投资工作流" extra={<Tag color="blue">新手快速上手</Tag>}>
        <div className="stack" style={{ gap: 12 }}>
          <p className="workflow-steps">
            ① 搜公司查排雷与估值水位 → ② 加入自选设好价格击球区 → ③
            买入前走反方质询，留下时间胶囊与否证红线
          </p>
          <div className="sample-stock-row" role="group" aria-label="快捷示例标的">
            <span className="small muted">快捷示例标的：</span>
            {SAMPLE_STOCKS.map((stock) => (
              <Link key={stock.code} className="sample-stock-chip" to={`/stock/${stock.code}`}>
                <span className="mono">{stock.code}</span>
                <span>{stock.name}</span>
              </Link>
            ))}
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
        <Card title="行业资金流（亿元）">
          <Chart option={flowOption} height={260} ariaLabel="行业净流入柱状图" />
        </Card>

        <Card title="净流入排行">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>行业</th>
                  <th style={{ textAlign: 'right' }}>涨跌幅</th>
                  <th style={{ textAlign: 'right' }}>净流入</th>
                  <th style={{ textAlign: 'right' }}>公司数</th>
                </tr>
              </thead>
              <tbody>
                {data.hot_industries.map((flow) => (
                  <tr key={flow.name}>
                    <td>{flow.name}</td>
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
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

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
