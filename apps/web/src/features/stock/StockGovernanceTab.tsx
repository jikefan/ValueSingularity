import { useMemo } from 'react'
import { Card } from '../../components/ui/Card'
import { Metric } from '../../components/ui/Metric'
import { EmptyBlock } from '../../components/ui/StateBlock'
import { Tag } from '../../components/ui/Tag'
import { createChartTheme } from '../../lib/chartTheme'
import { Chart, type ChartOption } from '../../lib/charts'
import { fmtNum, formatNum, formatPct, formatYi, qualityTone, toYi } from '../../lib/format'
import { useThemeMode } from '../../lib/theme'
import type { StockSnapshotPayload } from '../../types/api'
import { SHAREHOLDER_STATUS_META } from './stockHelpers'
import { useCompactViewport } from './useCompactViewport'

export function StockGovernanceTab({ snapshot }: { snapshot: StockSnapshotPayload }) {
  const { theme } = useThemeMode()
  const isCompact = useCompactViewport()
  const { shareholder_return: sReturn, formula_notes: formulaNotes } = snapshot
  const statusMeta = SHAREHOLDER_STATUS_META[sReturn.status]

  const seriesAsc = useMemo(
    () => [...sReturn.series].sort((a, b) => a.year - b.year),
    [sReturn.series],
  )
  const seriesDesc = useMemo(() => [...seriesAsc].reverse(), [seriesAsc])

  const asOfYear = /^\d{4}/.test(snapshot.as_of)
    ? Number(snapshot.as_of.slice(0, 4))
    : new Date(snapshot.as_of).getUTCFullYear()
  const latestSeriesYear = seriesAsc[seriesAsc.length - 1]?.year ?? null
  const hasPartialCurrentYear =
    latestSeriesYear !== null && Number.isFinite(asOfYear) && latestSeriesYear === asOfYear

  const barOption = useMemo<ChartOption>(() => {
    const { colors, axis, legend, tooltip } = createChartTheme(theme)
    return {
      tooltip: {
        ...tooltip,
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
      },
      legend: {
        ...legend,
        top: 0,
        type: 'scroll',
        ...(isCompact
          ? {
              itemGap: 10,
              itemWidth: 14,
              textStyle: { ...legend.textStyle, fontSize: 11 },
            }
          : {}),
        data: ['现金分红', '股份回购', '股权再融资', '股东净回报'],
      },
      grid: {
        left: isCompact ? 8 : 12,
        right: isCompact ? 8 : 14,
        top: isCompact ? 72 : 56,
        bottom: 10,
        containLabel: true,
      },
      xAxis: {
        ...axis,
        type: 'category',
        data: seriesAsc.map((point) =>
          point.year === asOfYear ? `${point.year}(年内)` : String(point.year),
        ),
      },
      yAxis: {
        ...axis,
        type: 'value',
        name: '亿元',
        nameGap: 14,
        nameTextStyle: { color: colors.muted },
      },
      series: [
        {
          name: '现金分红',
          type: 'bar',
          stack: 'outflow',
          barMaxWidth: 20,
          itemStyle: { color: colors.positive },
          data: seriesAsc.map((point) => toYi(point.dividend_yuan)),
        },
        {
          name: '股份回购',
          type: 'bar',
          stack: 'outflow',
          barMaxWidth: 20,
          itemStyle: { color: colors.electric },
          data: seriesAsc.map((point) => toYi(point.repurchase_yuan)),
        },
        {
          name: '股权再融资',
          type: 'bar',
          barMaxWidth: 20,
          itemStyle: { color: colors.negative },
          data: seriesAsc.map((point) => toYi(point.equity_financing_yuan)),
        },
        {
          name: '股东净回报',
          type: 'line',
          smooth: false,
          itemStyle: { color: colors.amber },
          lineStyle: { color: colors.amber, width: 2 },
          data: seriesAsc.map((point) => toYi(point.net_return_yuan)),
        },
      ],
    }
  }, [asOfYear, isCompact, seriesAsc, theme])

  return (
    <div className="stack" style={{ gap: 16 }}>
      <Card
        title="治理 · 股东净回报体检器"
        extra={
          <span className="row" style={{ gap: 8 }}>
            <Tag color={statusMeta.color}>{statusMeta.label}</Tag>
            <Tag color="gray">近 {sReturn.window_years} 年窗口</Tag>
          </span>
        }
      >
        <div className="stack" style={{ gap: 16 }}>
          <div className="notice-box" role="note">
            <strong>体检结论：</strong>
            <span>{sReturn.verdict}</span>
          </div>

          <div className="grid grid-4">
            <Metric label="累计现金分红" value={formatYi(sReturn.total_dividend_yuan)} />
            <Metric label="累计股份回购" value={formatYi(sReturn.total_repurchase_yuan)} />
            <Metric
              label="累计股权再融资"
              value={formatYi(sReturn.total_equity_financing_yuan)}
              sub="再融资向市场抽血"
            />
            <Metric
              label="股东净回报"
              value={formatYi(sReturn.net_return_yuan)}
              sub="分红 + 回购 − 再融资"
              tone={qualityTone(sReturn.net_return_yuan)}
            />
            <Metric label="累计自由现金流" value={formatYi(sReturn.total_fcf_yuan)} />
            <Metric
              label="FCF 覆盖倍数"
              value={
                sReturn.fcf_coverage_ratio !== null && sReturn.fcf_coverage_ratio !== undefined
                  ? `${fmtNum(sReturn.fcf_coverage_ratio, 2)}x`
                  : '—'
              }
              sub="≥ 1.0x 代表有真现金兜底"
            />
            <Metric label="当前股息率" value={formatPct(sReturn.current_dividend_yield_pct, 2)} />
          </div>

          {formulaNotes.shareholder_return ? (
            <p className="small muted">{formulaNotes.shareholder_return}</p>
          ) : null}
        </div>
      </Card>

      <Card title="年度分红 / 回购 / 再融资与净回报趋势（亿元）">
        {seriesAsc.length === 0 ? (
          <EmptyBlock title="暂无年度股东回报明细" />
        ) : (
          <>
            <Chart option={barOption} height={280} ariaLabel="股东净回报柱状图" />
            {hasPartialCurrentYear ? (
              <p className="small muted mt-8">含本年度截至目前公告的分红/回购进度，年度尚未收官</p>
            ) : null}
          </>
        )}
      </Card>

      {seriesDesc.length > 0 ? (
        <Card title="历年股东净回报明细（金额单位：亿元）">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>年份</th>
                  <th style={{ textAlign: 'right' }}>现金分红</th>
                  <th style={{ textAlign: 'right' }}>股份回购</th>
                  <th style={{ textAlign: 'right' }}>股权再融资</th>
                  <th style={{ textAlign: 'right' }}>股东净回报</th>
                  <th style={{ textAlign: 'right' }}>自由现金流</th>
                </tr>
              </thead>
              <tbody>
                {seriesDesc.map((point) => (
                  <tr key={point.year}>
                    <td className="mono">
                      {point.year === asOfYear ? `${point.year}(年内)` : point.year}
                    </td>
                    <td className="num">{formatNum(toYi(point.dividend_yuan), 2)}</td>
                    <td className="num">{formatNum(toYi(point.repurchase_yuan), 2)}</td>
                    <td className="num">{formatNum(toYi(point.equity_financing_yuan), 2)}</td>
                    <td className={`num ${qualityTone(point.net_return_yuan)}`}>
                      {formatNum(toYi(point.net_return_yuan), 2)}
                    </td>
                    <td className="num">{formatNum(toYi(point.fcf_yuan), 2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}
    </div>
  )
}
