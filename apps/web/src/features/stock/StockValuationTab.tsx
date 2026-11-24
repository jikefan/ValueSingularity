import { useEffect, useMemo, useState } from 'react'
import { Card } from '../../components/ui/Card'
import { Metric } from '../../components/ui/Metric'
import { EmptyBlock } from '../../components/ui/StateBlock'
import { Tag } from '../../components/ui/Tag'
import { createChartTheme } from '../../lib/chartTheme'
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
import { formatSpreadPct, solveImpliedFcfCagrPct } from '../../lib/reverseDcfSolver'
import { useThemeMode } from '../../lib/theme'
import type { StockSnapshotPayload } from '../../types/api'
import {
  buildSensitivityMatrix,
  computeFinancialPbRoeMetrics,
  isFinancialSnapshot,
} from './stockHelpers'
import { useCompactViewport } from './useCompactViewport'

function buildGrahamTip(snapshot: StockSnapshotPayload, isFinancial: boolean): string {
  const roe5y = snapshot.moat.roe_5y_avg_pct
  if (isFinancial) {
    return `估值口径提示：金融业受存贷款及资本充足率约束，静态格雷厄姆数字易偏离实际净资产复利能力；建议重点参照 PB（当前 ${formatNum(snapshot.valuation.pb, 2)}）、5Y 平均 ROE（${formatPct(roe5y, 1)}）、10Y PB 分位与当前股息率交叉评估。`
  }
  if (roe5y !== null && roe5y !== undefined && roe5y >= 18) {
    return `估值口径提示：格雷厄姆公式偏重静态净资产；当前标的 5 年平均 ROE 达 ${formatPct(roe5y, 1)}，高资本回报或轻资产/品牌模式下格雷厄姆安全边际常呈保守甚至负值，建议结合 10 年 PE 分位与逆向 DCF 交叉评估。`
  }
  return '估值口径提示：格雷厄姆公式偏重静态净资产与账面盈利锚定，负值不代表绝对高估，建议结合 10 年 PE/PB 历史分位与逆向 DCF 隐含增速交叉评估。'
}

export function StockValuationTab({ snapshot }: { snapshot: StockSnapshotPayload }) {
  const { theme } = useThemeMode()
  const isCompact = useCompactViewport()
  const { valuation, reverse_dcf: reverseDcf, formula_notes: formulaNotes } = snapshot

  const isFinancial = useMemo(() => isFinancialSnapshot(snapshot), [snapshot])
  const pbRoeMetrics = useMemo(() => computeFinancialPbRoeMetrics(snapshot), [snapshot])
  const grahamTip = useMemo(() => buildGrahamTip(snapshot, isFinancial), [snapshot, isFinancial])

  const [discountRatePct, setDiscountRatePct] = useState(reverseDcf.discount_rate_pct)
  const [terminalMultiple, setTerminalMultiple] = useState(reverseDcf.terminal_multiple)

  useEffect(() => {
    setDiscountRatePct(reverseDcf.discount_rate_pct)
    setTerminalMultiple(reverseDcf.terminal_multiple)
  }, [snapshot.code, reverseDcf.discount_rate_pct, reverseDcf.terminal_multiple])

  const evYuan = reverseDcf.enterprise_value_yuan
  const baseFcfYuan = reverseDcf.base_fcf_yuan
  const canInteractDcf =
    !isFinancial &&
    evYuan !== null &&
    evYuan !== undefined &&
    evYuan > 0 &&
    baseFcfYuan !== null &&
    baseFcfYuan !== undefined &&
    baseFcfYuan > 0

  const isBaseParams =
    discountRatePct === reverseDcf.discount_rate_pct &&
    terminalMultiple === reverseDcf.terminal_multiple

  const activeImpliedCagr = useMemo(() => {
    if (!canInteractDcf) {
      return reverseDcf.implied_fcf_cagr_pct ?? null
    }
    if (isBaseParams) {
      return reverseDcf.implied_fcf_cagr_pct ?? null
    }
    return solveImpliedFcfCagrPct({
      enterpriseValueYuan: evYuan,
      baseFcfYuan,
      discountRatePct,
      terminalMultiple,
    })
  }, [
    baseFcfYuan,
    canInteractDcf,
    discountRatePct,
    evYuan,
    isBaseParams,
    reverseDcf.implied_fcf_cagr_pct,
    terminalMultiple,
  ])

  const activeSpreadPct = useMemo(() => {
    if (!canInteractDcf || isBaseParams) {
      return reverseDcf.implied_vs_history_gap_pct ?? null
    }
    return formatSpreadPct(activeImpliedCagr, reverseDcf.historical_revenue_cagr_pct)
  }, [
    activeImpliedCagr,
    canInteractDcf,
    isBaseParams,
    reverseDcf.historical_revenue_cagr_pct,
    reverseDcf.implied_vs_history_gap_pct,
  ])

  const isCurrentlySolvable = canInteractDcf ? activeImpliedCagr !== null : reverseDcf.solvable

  const historyPoints = valuation.history
  const historyOption = useMemo<ChartOption>(() => {
    const { colors, axis, legend, tooltip } = createChartTheme(theme)
    return {
      tooltip: {
        ...tooltip,
        trigger: 'axis',
        axisPointer: { type: 'cross' },
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
        data: ['PE (TTM)', '总市值（亿元）'],
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
        data: historyPoints.map((point) => point.trade_date),
      },
      yAxis: [
        {
          ...axis,
          type: 'value',
          name: 'PE (TTM)',
          nameGap: 14,
          nameTextStyle: { color: colors.muted },
        },
        {
          ...axis,
          type: 'value',
          name: '市值(亿)',
          nameGap: 14,
          nameTextStyle: { color: colors.muted },
          splitLine: { show: false },
        },
      ],
      series: [
        {
          name: 'PE (TTM)',
          type: 'line',
          smooth: false,
          showSymbol: false,
          itemStyle: { color: colors.electric },
          lineStyle: { color: colors.electric, width: 2 },
          data: historyPoints.map((point) => point.pe_ttm ?? null),
        },
        {
          name: '总市值（亿元）',
          type: 'line',
          yAxisIndex: 1,
          smooth: false,
          showSymbol: false,
          itemStyle: { color: colors.positive },
          lineStyle: { color: colors.positive, width: 2 },
          data: historyPoints.map((point) => toYi(point.total_mv_yuan)),
        },
      ],
    }
  }, [historyPoints, isCompact, theme])

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
        <div className="small muted mt-16 stack" style={{ gap: 4 }}>
          <p>{grahamTip}</p>
          {formulaNotes.valuation_percentiles ? <p>{formulaNotes.valuation_percentiles}</p> : null}
          {formulaNotes.graham ? <p>{formulaNotes.graham}</p> : null}
        </div>
      </Card>

      <Card title="历史 PE(TTM) 与总市值走势">
        {historyPoints.length === 0 ? (
          <EmptyBlock title="暂无历史估值走势数据" />
        ) : (
          <Chart option={historyOption} height={280} ariaLabel="历史估值走势图" />
        )}
      </Card>

      <Card
        title={isFinancial ? '金融业替代估值与期望参考' : 'Reverse DCF 逆向估值反推器'}
        extra={
          <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            {isFinancial ? (
              <Tag color="blue">金融业专项口径</Tag>
            ) : (
              <Tag color={isCurrentlySolvable ? 'green' : 'amber'}>
                {isCurrentlySolvable ? '可求解' : '不可求解'}
              </Tag>
            )}
            <Tag color="blue">仅反推隐含预期 · 不输出目标价</Tag>
          </span>
        }
      >
        {isFinancial ? (
          <div className="stack" style={{ gap: 16 }}>
            <section
              className="pb-roe-card stack"
              aria-label="金融业替代估值：PB-ROE 隐含长期回报参考"
            >
              <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
                <strong>金融业替代估值：PB-ROE 隐含长期回报参考</strong>
                <Tag color="green">不输出主观目标价</Tag>
              </div>

              <div className="well-grid-4">
                <div className="well-cell">
                  <Metric
                    label="当前 PB"
                    value={formatNum(pbRoeMetrics.pb, 2)}
                    sub={`10Y PB 分位 ${formatPct(pbRoeMetrics.pbPercentile10y, 1)}`}
                  />
                </div>
                <div className="well-cell">
                  <Metric
                    label="5年平均 ROE"
                    value={formatPct(pbRoeMetrics.roe5yAvgPct, 2)}
                    sub={`10Y 最低 ROE ${formatPct(pbRoeMetrics.roe10yMinPct, 2)}`}
                  />
                </div>
                <div className="well-cell">
                  <Metric
                    label="隐含当期盈利收益率 (ROE / PB)"
                    value={formatPct(pbRoeMetrics.impliedEarningsYieldPct, 2)}
                    sub="稳态净资产收益率 ÷ 当前市净率"
                    tone={qualityTone(pbRoeMetrics.impliedEarningsYieldPct)}
                  />
                </div>
                <div className="well-cell">
                  <Metric
                    label="当前股息率"
                    value={formatPct(pbRoeMetrics.dividendYieldPct, 2)}
                    sub="年度现金分红静态回报"
                  />
                </div>
              </div>

              <p className="small soft">
                会计公式说明：在金融企业净资产相对稳定假设下，隐含当期盈利收益率 ≈ 5 年平均 ROE ÷
                当前
                PB，反映以当前市净率买入单位净资产对应的历史盈利回报率；实际实现仍受信用拨备周期、息差变化与资本补充影响，不构成主观目标价。
              </p>
            </section>

            <div className="notice-box notice-warn" role="note">
              <strong>传统 DCF 豁免说明：</strong>
              <span>{reverseDcf.note}</span>
            </div>

            <div className="disclaimer-box small muted">
              <strong>模型边界声明：</strong>
              {reverseDcfNote}
            </div>
          </div>
        ) : (
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

            {canInteractDcf ? (
              <div className="dcf-slider-panel stack" style={{ gap: 12 }}>
                <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
                  <div className="stack" style={{ gap: 2 }}>
                    <strong className="small">交互式参数敏感性推演（本地实时二分求解）</strong>
                    <span className="small muted">
                      调整折现率或第 10 年终值倍数，实时观测当前市值隐含的 FCF 增速门槛
                    </span>
                  </div>
                  <button
                    type="button"
                    className="btn-ghost"
                    disabled={isBaseParams}
                    onClick={() => {
                      setDiscountRatePct(reverseDcf.discount_rate_pct)
                      setTerminalMultiple(reverseDcf.terminal_multiple)
                    }}
                  >
                    恢复默认参数
                  </button>
                </div>

                <div className="dcf-slider-grid">
                  <div className="dcf-slider-field">
                    <div className="row">
                      <label htmlFor="dcf-wacc-slider" className="small soft">
                        折现率 WACC (%)
                      </label>
                      <span className="mono small">{fmtNum(discountRatePct, 1)}%</span>
                    </div>
                    <input
                      id="dcf-wacc-slider"
                      type="range"
                      min={6}
                      max={14}
                      step={0.5}
                      value={discountRatePct}
                      onChange={(event) => setDiscountRatePct(Number(event.target.value))}
                    />
                  </div>

                  <div className="dcf-slider-field">
                    <div className="row">
                      <label htmlFor="dcf-multiple-slider" className="small soft">
                        终值倍数 (x)
                      </label>
                      <span className="mono small">{fmtNum(terminalMultiple, 1)}x</span>
                    </div>
                    <input
                      id="dcf-multiple-slider"
                      type="range"
                      min={6}
                      max={25}
                      step={1}
                      value={terminalMultiple}
                      onChange={(event) => setTerminalMultiple(Number(event.target.value))}
                    />
                  </div>
                </div>
              </div>
            ) : null}

            <div className="grid grid-3">
              <Metric
                label="市场隐含 10Y FCF CAGR"
                value={isCurrentlySolvable ? formatSignedPct(activeImpliedCagr, 2) : '不可求解'}
                sub={`折现率 ${fmtNum(discountRatePct, 1)}% · 终值 ${fmtNum(terminalMultiple, 1)}x`}
              />
              <Metric
                label="历史营收 CAGR 参考"
                value={formatSignedPct(reverseDcf.historical_revenue_cagr_pct, 2)}
                sub="近 3–5 年实际营业收入复合增速"
              />
              <Metric
                label="隐含增速 − 历史增速"
                value={formatSignedPct(activeSpreadPct, 2)}
                sub="正值代表市场预期高于历史增速"
                tone={qualityTone(activeSpreadPct, true)}
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
                            const isActiveCell =
                              rate === discountRatePct && multiple === terminalMultiple
                            return (
                              <td
                                key={`${rate}-${multiple}`}
                                className={isActiveCell ? 'num sensitivity-base' : 'num'}
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
        )}
      </Card>
    </div>
  )
}
