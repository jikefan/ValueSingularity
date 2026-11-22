import { useMemo } from 'react'
import type { EChartsOption } from 'echarts'
import { Card } from '../../components/ui/Card'
import { Metric } from '../../components/ui/Metric'
import { ScoreRing } from '../../components/ui/ScoreRing'
import { EmptyBlock, ErrorBlock, LoadingBlock } from '../../components/ui/StateBlock'
import { Tag } from '../../components/ui/Tag'
import { CHART_COLORS } from '../../lib/chartTheme'
import { Chart } from '../../lib/charts'
import { chgClass, fmtDateTime, fmtMoney, fmtNum, fmtPct } from '../../lib/format'
import type { TemperatureLevel } from '../../types/api'
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

export function MarketPage() {
  const { data, error, isPending, isFetching, isError, refetch } = useMarketOverview()

  const flowOption = useMemo<EChartsOption>(() => {
    const flows = data?.hot_industries ?? []
    return {
      grid: { left: 8, right: 16, top: 16, bottom: 8, containLabel: true },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        valueFormatter: (value) => `${fmtNum(Number(value), 2)} 亿`,
      },
      xAxis: {
        type: 'value',
        axisLabel: { color: CHART_COLORS.muted, formatter: '{value} 亿' },
        splitLine: { lineStyle: { color: CHART_COLORS.grid } },
      },
      yAxis: {
        type: 'category',
        data: flows.map((flow) => flow.name),
        axisLabel: { color: CHART_COLORS.text },
        axisLine: { show: false },
        axisTick: { show: false },
      },
      series: [
        {
          type: 'bar',
          barWidth: 14,
          data: flows.map((flow) => ({
            value: Number((flow.net_inflow / 1e8).toFixed(2)),
            itemStyle: {
              color: flow.net_inflow >= 0 ? CHART_COLORS.positive : CHART_COLORS.negative,
              borderRadius: 6,
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
      <Card
        title="市场温度"
        extra={
          <span className="row" style={{ gap: 8 }}>
            <Tag color={meta.color}>{meta.label}</Tag>
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
                sub="EP − 国债"
                tone={data.temperature.equity_bond_spread > 0 ? 'up' : 'down'}
              />
            </div>
            <p className="hero-comment">{data.temperature.comment}</p>
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
                  <td className={`num ${chgClass(flow.change_pct)}`}>{fmtPct(flow.change_pct)}</td>
                  <td className={`num ${chgClass(flow.net_inflow)}`}>
                    {fmtMoney(flow.net_inflow)}
                  </td>
                  <td className="num muted">{flow.companies}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>

      <p className="small muted">
        数据来自 API 当前适配器（骨架阶段为内存 fixture，接入 akshare 后替换，接口不变）。
      </p>
    </div>
  )
}
