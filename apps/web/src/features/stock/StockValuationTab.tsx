import { useMemo } from 'react'
import { Card } from '../../components/ui/Card'
import { Metric } from '../../components/ui/Metric'
import { EmptyBlock } from '../../components/ui/StateBlock'
import { Tag } from '../../components/ui/Tag'
import {
  CHART_AXIS_COMMON,
  CHART_COLORS,
  CHART_LEGEND_COMMON,
  CHART_TOOLTIP_COMMON,
} from '../../lib/chartTheme'
import { Chart, type ChartOption } from '../../lib/charts'
import {
  fmtNum,
  formatNum,
  formatPct,
  formatSignedPct,
  formatYi,
  qualityTone,
  toYi,
} from '../../lib/format'
import type { StockSnapshotPayload } from '../../types/api'
import { buildSensitivityMatrix } from './stockHelpers'

export function StockValuationTab({ snapshot }: { snapshot: StockSnapshotPayload }) {
  const { valuation, reverse_dcf: reverseDcf, formula_notes: formulaNotes } = snapshot

  const historyPoints = valuation.history
  const historyOption = useMemo<ChartOption>(
    () => ({
      tooltip: {
        ...CHART_TOOLTIP_COMMON,
        trigger: 'axis',
        axisPointer: { type: 'cross' },
      },
      legend: {
        ...CHART_LEGEND_COMMON,
        data: ['PE (TTM)', '总市值（亿元）'],
      },
      grid: { left: 12, right: 14, top: 38, bottom: 10, containLabel: true },
      xAxis: {
        ...CHART_AXIS_COMMON,
        type: 'category',
        data: historyPoints.map((point) => point.trade_date),
      },
      yAxis: [
        {
          ...CHART_AXIS_COMMON,
          type: 'value',
          name: 'PE (TTM)',
          nameTextStyle: { color: CHART_COLORS.muted },
        },
        {
          ...CHART_AXIS_COMMON,
          type: 'value',
          name: '市值(亿)',
          nameTextStyle: { color: CHART_COLORS.muted },
          splitLine: { show: false },
        },
      ],
      series: [
        {
          name: 'PE (TTM)',
          type: 'line',
          smooth: false,
          showSymbol: false,
          itemStyle: { color: CHART_COLORS.electric },
          lineStyle: { color: CHART_COLORS.electric, width: 2 },
          data: historyPoints.map((point) => point.pe_ttm ?? null),
        },
        {
          name: '总市值（亿元）',
          type: 'line',
          yAxisIndex: 1,
          smooth: false,
          showSymbol: false,
          itemStyle: { color: CHART_COLORS.positive },
          lineStyle: { color: CHART_COLORS.positive, width: 2 },
          data: historyPoints.map((point) => toYi(point.total_mv_yuan)),
        },
      ],
    }),
    [historyPoints],
  )

  const matrix = useMemo(
    () => buildSensitivityMatrix(reverseDcf.sensitivity),
    [reverseDcf.sensitivity],
  )

  const reverseDcfNote =
    formulaNotes.reverse_dcf ??
    '逆向 DCF 仅基于当前企业价值与历史基准 FCF 反推市场隐含增速，严禁视为主观目标价或买卖建议。'

  return (
    <div className="stack" style={{ gap: 16 }}>
      <Card
        title="估值坐标与历史分位"
        extra={
          valuation.latest_trade_date ? (
            <Tag color="gray">截至 {valuation.latest_trade_date}</Tag>
          ) : null
        }
      >
        <div className="grid grid-4">
          <Metric
            label="PE (TTM)"
            value={formatNum(valuation.pe_ttm, 2)}
            sub={`5Y 分位 ${formatPct(valuation.pe_percentile_5y, 1)} · 10Y 分位 ${formatPct(valuation.pe_percentile_10y, 1)}`}
          />
          <Metric
            label="PB"
            value={formatNum(valuation.pb, 2)}
            sub={`10Y 分位 ${formatPct(valuation.pb_percentile_10y, 1)}`}
          />
          <Metric
            label="格雷厄姆数字"
            value={formatNum(valuation.graham_number, 2)}
            sub={`安全边际 ${formatSignedPct(valuation.graham_margin_pct, 2)}`}
            tone={qualityTone(valuation.graham_margin_pct)}
          />
          <Metric
            label="PEG & 股息率"
            value={formatNum(valuation.peg, 2)}
            sub={`当前股息率 ${formatPct(valuation.dividend_yield_pct, 2)}`}
          />
        </div>
        {formulaNotes.valuation_percentiles || formulaNotes.graham ? (
          <div className="small muted mt-16 stack" style={{ gap: 4 }}>
            {formulaNotes.valuation_percentiles ? (
              <p>{formulaNotes.valuation_percentiles}</p>
            ) : null}
            {formulaNotes.graham ? <p>{formulaNotes.graham}</p> : null}
          </div>
        ) : null}
      </Card>

      <Card title="历史 PE(TTM) 与总市值走势">
        {historyPoints.length === 0 ? (
          <EmptyBlock title="暂无历史估值走势数据" />
        ) : (
          <Chart option={historyOption} height={280} ariaLabel="历史估值走势图" />
        )}
      </Card>

      <Card
        title="Reverse DCF 逆向估值反推器"
        extra={
          <span className="row" style={{ gap: 8 }}>
            <Tag color={reverseDcf.solvable ? 'green' : 'amber'}>
              {reverseDcf.solvable ? '可求解' : '不可求解'}
            </Tag>
            <Tag color="blue">仅反推隐含预期 · 不输出目标价</Tag>
          </span>
        }
      >
        <div className="stack" style={{ gap: 16 }}>
          <div className="grid grid-4">
            <Metric label="总市值" value={formatYi(reverseDcf.market_cap_yuan)} />
            <Metric
              label="净现金"
              value={formatYi(reverseDcf.net_cash_yuan)}
              sub="货币资金+交易金资产−有息负债"
            />
            <Metric
              label="企业价值 EV"
              value={formatYi(reverseDcf.enterprise_value_yuan)}
              sub="EV = 总市值 − 净现金"
            />
            <Metric
              label={`基准 FCF（${reverseDcf.base_fcf_years} 年均值）`}
              value={formatYi(reverseDcf.base_fcf_yuan)}
            />
          </div>

          <div className="grid grid-3">
            <Metric
              label="市场隐含 10Y FCF CAGR"
              value={
                reverseDcf.solvable
                  ? formatSignedPct(reverseDcf.implied_fcf_cagr_pct, 2)
                  : '不可求解'
              }
              sub={`折现率 ${fmtNum(reverseDcf.discount_rate_pct, 1)}% · 终值 ${fmtNum(reverseDcf.terminal_multiple, 1)}x`}
            />
            <Metric
              label="历史营收 CAGR 参考"
              value={formatSignedPct(reverseDcf.historical_revenue_cagr_pct, 2)}
              sub="近 3–5 年实际营业收入复合增速"
            />
            <Metric
              label="隐含增速 − 历史增速"
              value={formatSignedPct(reverseDcf.implied_vs_history_gap_pct, 2)}
              sub="正值代表市场预期高于历史增速"
              tone={qualityTone(reverseDcf.implied_vs_history_gap_pct, true)}
            />
          </div>

          <div
            className={reverseDcf.solvable ? 'notice-box' : 'notice-box notice-warn'}
            role="note"
          >
            <strong>{reverseDcf.solvable ? '反推结果说明：' : '不可求解回退说明：'}</strong>
            <span>{reverseDcf.note}</span>
          </div>

          {matrix.discountRates.length > 0 && matrix.multiples.length > 0 ? (
            <div className="stack" style={{ gap: 8 }}>
              <div className="small soft">
                WACC（折现率）× 终值倍数 3×3 敏感性矩阵（单元格为隐含 10Y FCF CAGR）
              </div>
              <div className="table-wrap">
                <table className="table sensitivity-table">
                  <thead>
                    <tr>
                      <th>WACC \ 终值倍数</th>
                      {matrix.multiples.map((multiple) => (
                        <th key={multiple} style={{ textAlign: 'right' }}>
                          {fmtNum(multiple, 1)}x
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {matrix.discountRates.map((rate) => (
                      <tr key={rate}>
                        <td className="mono">{fmtNum(rate, 1)}%</td>
                        {matrix.multiples.map((multiple) => {
                          const cellVal = matrix.values.get(`${rate}:${multiple}`) ?? null
                          const isBase =
                            rate === reverseDcf.discount_rate_pct &&
                            multiple === reverseDcf.terminal_multiple
                          return (
                            <td
                              key={`${rate}-${multiple}`}
                              className={isBase ? 'num sensitivity-base' : 'num'}
                            >
                              {cellVal !== null ? formatSignedPct(cellVal, 2) : '无解'}
                            </td>
                          )
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}

          <div className="disclaimer-box small muted">
            <strong>模型边界声明：</strong>
            {reverseDcfNote}
          </div>
        </div>
      </Card>
    </div>
  )
}
