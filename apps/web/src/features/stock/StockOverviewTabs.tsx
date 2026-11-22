import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { Card } from '../../components/ui/Card'
import { Metric } from '../../components/ui/Metric'
import { ScoreRing } from '../../components/ui/ScoreRing'
import { EmptyBlock } from '../../components/ui/StateBlock'
import { Tag } from '../../components/ui/Tag'
import {
  CHART_AXIS_COMMON,
  CHART_COLORS,
  CHART_LEGEND_COMMON,
  CHART_TOOLTIP_COMMON,
} from '../../lib/chartTheme'
import { Chart, type ChartOption } from '../../lib/charts'
import { formatNum, formatPct, formatYi, qualityTone, toYi } from '../../lib/format'
import type { StockSnapshotPayload } from '../../types/api'
import { FORMULA_NOTE_TITLES } from './stockHelpers'

function clampPctWidth(score: number): number {
  return Math.min(100, Math.max(0, score))
}

export function StockOverviewTab({ snapshot }: { snapshot: StockSnapshotPayload }) {
  const {
    radar,
    valuation,
    moat,
    financial_ct: financialCt,
    shareholder_return: sReturn,
  } = snapshot

  const radarDimensions = useMemo(
    () => [
      { key: 'profitability', label: '盈利能力', score: radar.profitability },
      { key: 'moat', label: '护城河', score: radar.moat },
      { key: 'balance_sheet', label: '资产负债', score: radar.balance_sheet },
      { key: 'cashflow_quality', label: '现金流质量', score: radar.cashflow_quality },
      { key: 'valuation_margin', label: '估值安全边际', score: radar.valuation_margin },
    ],
    [radar],
  )

  const radarOption = useMemo<ChartOption>(
    () => ({
      tooltip: {
        ...CHART_TOOLTIP_COMMON,
        trigger: 'item',
      },
      radar: {
        radius: '66%',
        indicator: radarDimensions.map((dim) => ({ name: dim.label, max: 100 })),
        axisName: { color: CHART_COLORS.text, fontSize: 12 },
        splitArea: { areaStyle: { color: ['transparent'] } },
        splitLine: { lineStyle: { color: CHART_COLORS.grid } },
        axisLine: { lineStyle: { color: CHART_COLORS.axisLine } },
      },
      series: [
        {
          type: 'radar',
          symbolSize: 5,
          data: [
            {
              value: radarDimensions.map((dim) => dim.score),
              name: `${snapshot.name} 综合画像`,
              itemStyle: { color: CHART_COLORS.positive },
              lineStyle: { color: CHART_COLORS.positive, width: 2 },
              areaStyle: { color: CHART_COLORS.electric, opacity: 0.16 },
            },
          ],
        },
      ],
    }),
    [radarDimensions, snapshot.name],
  )

  const formulaEntries = Object.entries(snapshot.formula_notes)

  return (
    <div className="stack" style={{ gap: 16 }}>
      <Card
        title="五维定量雷达评分"
        extra={
          <span className="row" style={{ gap: 8 }}>
            <Tag
              color={radar.total_score >= 70 ? 'green' : radar.total_score >= 45 ? 'blue' : 'amber'}
            >
              综合评分 {radar.total_score} / 100
            </Tag>
            <Tag color="gray">快照 {snapshot.as_of}</Tag>
          </span>
        }
      >
        <div className="overview-hero">
          <div className="overview-ring-col">
            <ScoreRing score={radar.total_score} size={156} label="RADAR" toneMode="quality" />
            <span className="small muted">确定性定量映射 · 非主观评级</span>
          </div>

          <div className="overview-radar-col">
            <Chart option={radarOption} height={240} ariaLabel="五维评分雷达图" />
          </div>

          <div className="stack" style={{ gap: 10 }}>
            {radarDimensions.map((dim) => (
              <div key={dim.key} className="score-bar-item">
                <div className="row">
                  <span className="small soft">{dim.label}</span>
                  <span className="small mono">{dim.score}</span>
                </div>
                <div className="score-bar-track">
                  <div
                    className="score-bar-fill"
                    style={{ width: `${clampPctWidth(dim.score)}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      </Card>

      <div className="grid grid-4">
        <Card>
          <Metric
            label="最新收盘价"
            value={formatNum(valuation.close, 2)}
            sub={valuation.latest_trade_date ? `交易日 ${valuation.latest_trade_date}` : '—'}
          />
        </Card>
        <Card>
          <Metric
            label="总市值"
            value={formatYi(valuation.total_mv_yuan)}
            sub={`PE(TTM) ${formatNum(valuation.pe_ttm, 2)}`}
          />
        </Card>
        <Card>
          <Metric
            label="5年平均 ROE"
            value={formatPct(moat.roe_5y_avg_pct, 2)}
            sub={`10Y PE 分位 ${formatPct(valuation.pe_percentile_10y, 1)}`}
          />
        </Card>
        <Card>
          <Metric
            label="排雷与股东回报"
            value={`${financialCt.red_count} 红 / ${financialCt.yellow_count} 黄`}
            sub={`当前股息率 ${formatPct(sReturn.current_dividend_yield_pct, 2)}`}
            tone={financialCt.red_count > 0 ? 'tone-bad' : 'tone-good'}
          />
        </Card>
      </div>

      <Card
        title="空头视角与核心风险提示"
        extra={<Tag color={radar.bear_cases.length > 0 ? 'amber' : 'green'}>反面校验</Tag>}
      >
        <ul className="bear-case-list">
          {radar.bear_cases.map((item, index) => (
            <li key={`${index}-${item}`} className="bear-case-item">
              {item}
            </li>
          ))}
        </ul>
      </Card>

      {formulaEntries.length > 0 ? (
        <Card title="方法论与口径说明书">
          <details className="formula-details">
            <summary className="formula-summary">
              展开查看全部定量指标计算公式（{formulaEntries.length} 项）
            </summary>
            <div className="formula-list mt-16">
              {formulaEntries.map(([key, note]) => (
                <div key={key} className="formula-item">
                  <div className="small soft" style={{ fontWeight: 600 }}>
                    {FORMULA_NOTE_TITLES[key] ?? key}
                  </div>
                  <div className="small muted mt-8">{note}</div>
                </div>
              ))}
            </div>
          </details>
        </Card>
      ) : null}
    </div>
  )
}

export function StockFinancialsTab({ snapshot }: { snapshot: StockSnapshotPayload }) {
  const trendsAsc = useMemo(
    () => [...snapshot.annual_trends].sort((a, b) => a.year - b.year),
    [snapshot.annual_trends],
  )
  const trendsDesc = useMemo(() => [...trendsAsc].reverse(), [trendsAsc])

  const trendOption = useMemo<ChartOption>(
    () => ({
      tooltip: {
        ...CHART_TOOLTIP_COMMON,
        trigger: 'axis',
        axisPointer: { type: 'cross' },
      },
      legend: {
        ...CHART_LEGEND_COMMON,
        data: ['营业收入', '归母净利润', '自由现金流', 'ROE (%)'],
      },
      grid: { left: 12, right: 14, top: 38, bottom: 10, containLabel: true },
      xAxis: {
        ...CHART_AXIS_COMMON,
        type: 'category',
        data: trendsAsc.map((point) => String(point.year)),
      },
      yAxis: [
        {
          ...CHART_AXIS_COMMON,
          type: 'value',
          name: '亿元',
          nameTextStyle: { color: CHART_COLORS.muted },
        },
        {
          ...CHART_AXIS_COMMON,
          type: 'value',
          name: 'ROE %',
          nameTextStyle: { color: CHART_COLORS.muted },
          splitLine: { show: false },
        },
      ],
      series: [
        {
          name: '营业收入',
          type: 'bar',
          barMaxWidth: 18,
          itemStyle: { color: CHART_COLORS.electric, borderRadius: [4, 4, 0, 0] },
          data: trendsAsc.map((point) => toYi(point.revenue_yuan)),
        },
        {
          name: '归母净利润',
          type: 'bar',
          barMaxWidth: 18,
          itemStyle: { color: CHART_COLORS.positive, borderRadius: [4, 4, 0, 0] },
          data: trendsAsc.map((point) => toYi(point.net_profit_yuan)),
        },
        {
          name: '自由现金流',
          type: 'bar',
          barMaxWidth: 18,
          itemStyle: { color: CHART_COLORS.violet, borderRadius: [4, 4, 0, 0] },
          data: trendsAsc.map((point) => toYi(point.fcf_yuan)),
        },
        {
          name: 'ROE (%)',
          type: 'line',
          yAxisIndex: 1,
          smooth: true,
          symbolSize: 6,
          itemStyle: { color: CHART_COLORS.amber },
          lineStyle: { color: CHART_COLORS.amber, width: 2 },
          data: trendsAsc.map((point) =>
            point.roe_pct !== null && point.roe_pct !== undefined
              ? Number(point.roe_pct.toFixed(2))
              : null,
          ),
        },
      ],
    }),
    [trendsAsc],
  )

  if (trendsAsc.length === 0) {
    return (
      <Card title="财务分析 · 十年核心指标">
        <EmptyBlock title="暂无历年财务趋势数据" hint="请确认已同步该标的历史年报数据。" />
      </Card>
    )
  }

  return (
    <div className="stack" style={{ gap: 16 }}>
      <Card
        title="十年财务趋势（营收 / 归母净利润 / 自由现金流 & ROE）"
        extra={<Tag color="blue">{trendsAsc.length} 个报告期</Tag>}
      >
        <Chart option={trendOption} height={300} ariaLabel="十年财务趋势图" />
      </Card>

      <Card title="历年核心财务明细（金额单位：亿元）">
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>年份</th>
                <th style={{ textAlign: 'right' }}>营业收入</th>
                <th style={{ textAlign: 'right' }}>归母净利润</th>
                <th style={{ textAlign: 'right' }}>扣非净利润</th>
                <th style={{ textAlign: 'right' }}>经营现金流</th>
                <th style={{ textAlign: 'right' }}>自由现金流</th>
                <th style={{ textAlign: 'right' }}>ROE</th>
                <th style={{ textAlign: 'right' }}>毛利率</th>
                <th style={{ textAlign: 'right' }}>净利率</th>
                <th style={{ textAlign: 'right' }}>净现金</th>
              </tr>
            </thead>
            <tbody>
              {trendsDesc.map((point) => (
                <tr key={point.year}>
                  <td className="mono">{point.year}</td>
                  <td className="num">{formatNum(toYi(point.revenue_yuan), 2)}</td>
                  <td className="num">{formatNum(toYi(point.net_profit_yuan), 2)}</td>
                  <td className="num">{formatNum(toYi(point.deduct_net_profit_yuan), 2)}</td>
                  <td className="num">{formatNum(toYi(point.ocf_yuan), 2)}</td>
                  <td className={`num ${qualityTone(point.fcf_yuan)}`}>
                    {formatNum(toYi(point.fcf_yuan), 2)}
                  </td>
                  <td className="num">{formatPct(point.roe_pct, 2)}</td>
                  <td className="num">{formatPct(point.gross_margin_pct, 2)}</td>
                  <td className="num">{formatPct(point.net_margin_pct, 2)}</td>
                  <td className={`num ${qualityTone(point.net_cash_yuan)}`}>
                    {formatNum(toYi(point.net_cash_yuan), 2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}

export function StockMoatTab({ snapshot }: { snapshot: StockSnapshotPayload }) {
  const { moat } = snapshot
  const roicNote = snapshot.formula_notes.roic_approx

  return (
    <div className="stack" style={{ gap: 16 }}>
      <Card title="护城河资本回报核心指标">
        <div className="grid grid-5">
          <Metric label="5年平均 ROE" value={formatPct(moat.roe_5y_avg_pct, 2)} />
          <Metric label="10年最低 ROE" value={formatPct(moat.roe_10y_min_pct, 2)} />
          <Metric label="最新毛利率" value={formatPct(moat.gross_margin_latest_pct, 2)} />
          <Metric
            label="5年毛利率标准差"
            value={formatPct(moat.gross_margin_5y_std_pct, 2)}
            sub="越低越稳定"
          />
          <Metric label="近似 ROIC" value={formatPct(moat.roic_approx_pct, 2)} />
        </div>
        {roicNote ? <p className="small muted mt-16">{roicNote}</p> : null}
      </Card>

      <Card
        title="护城河分项评估"
        extra={<Tag color="blue">{moat.dimensions.length} 个定量维度</Tag>}
      >
        {moat.dimensions.length === 0 ? (
          <EmptyBlock title="暂无护城河分项评估" />
        ) : (
          <div className="grid grid-2">
            {moat.dimensions.map((item) => (
              <div key={item.key} className="subpanel">
                <div className="row">
                  <strong>{item.label}</strong>
                  <Tag color={item.score >= 75 ? 'green' : item.score >= 50 ? 'blue' : 'amber'}>
                    {item.score} / 100
                  </Tag>
                </div>
                <div className="score-bar-track mt-8">
                  <div
                    className="score-bar-fill"
                    style={{ width: `${clampPctWidth(item.score)}%` }}
                  />
                </div>
                <p className="small soft mt-8">{item.summary}</p>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}

export function StockGrowthTab({ snapshot }: { snapshot: StockSnapshotPayload }) {
  const { growth, annual_trends: annualTrends } = snapshot
  const trendsAsc = useMemo(() => [...annualTrends].sort((a, b) => a.year - b.year), [annualTrends])

  const marginOption = useMemo<ChartOption>(
    () => ({
      tooltip: {
        ...CHART_TOOLTIP_COMMON,
        trigger: 'axis',
      },
      legend: {
        ...CHART_LEGEND_COMMON,
        data: ['毛利率 (%)', '净利率 (%)', '研发费用率 (%)'],
      },
      grid: { left: 12, right: 14, top: 38, bottom: 10, containLabel: true },
      xAxis: {
        ...CHART_AXIS_COMMON,
        type: 'category',
        data: trendsAsc.map((point) => String(point.year)),
      },
      yAxis: {
        ...CHART_AXIS_COMMON,
        type: 'value',
        name: '%',
        nameTextStyle: { color: CHART_COLORS.muted },
      },
      series: [
        {
          name: '毛利率 (%)',
          type: 'line',
          smooth: true,
          itemStyle: { color: CHART_COLORS.positive },
          data: trendsAsc.map((point) => point.gross_margin_pct ?? null),
        },
        {
          name: '净利率 (%)',
          type: 'line',
          smooth: true,
          itemStyle: { color: CHART_COLORS.electric },
          data: trendsAsc.map((point) => point.net_margin_pct ?? null),
        },
        {
          name: '研发费用率 (%)',
          type: 'line',
          smooth: true,
          itemStyle: { color: CHART_COLORS.amber },
          data: trendsAsc.map((point) => point.rd_ratio_pct ?? null),
        },
      ],
    }),
    [trendsAsc],
  )

  return (
    <div className="stack" style={{ gap: 16 }}>
      <Card title="增长引擎与再投资效率">
        <div className="grid grid-3">
          <Metric
            label="3年营收 CAGR"
            value={formatPct(growth.revenue_cagr_3y_pct, 2)}
            tone={qualityTone(growth.revenue_cagr_3y_pct)}
          />
          <Metric
            label="5年营收 CAGR"
            value={formatPct(growth.revenue_cagr_5y_pct, 2)}
            tone={qualityTone(growth.revenue_cagr_5y_pct)}
          />
          <Metric
            label="5年归母净利润 CAGR"
            value={formatPct(growth.profit_cagr_5y_pct, 2)}
            tone={qualityTone(growth.profit_cagr_5y_pct)}
          />
          <Metric
            label="5年扣非净利润 CAGR"
            value={formatPct(growth.deduct_profit_cagr_5y_pct, 2)}
            tone={qualityTone(growth.deduct_profit_cagr_5y_pct)}
          />
          <Metric
            label="最新研发费用率"
            value={formatPct(growth.rd_ratio_latest_pct, 2)}
            sub="研发投入 / 营业收入"
          />
          <Metric
            label="资本开支 / 经营现金流"
            value={formatPct(growth.capex_to_ocf_latest_pct, 2)}
            sub="越低代表内生现金越充裕"
          />
        </div>
      </Card>

      <Card title="利润率与研发投入强度走势">
        {trendsAsc.length === 0 ? (
          <EmptyBlock title="暂无利润率趋势数据" />
        ) : (
          <Chart option={marginOption} height={260} ariaLabel="盈利能力与研发投入趋势图" />
        )}
      </Card>
    </div>
  )
}

export function StockInstitutionsTab({ snapshot }: { snapshot: StockSnapshotPayload }) {
  const pledgeRatio = snapshot.pledge_ratio_pct
  const pledgeColor =
    pledgeRatio === null || pledgeRatio === undefined
      ? 'gray'
      : pledgeRatio >= 30
        ? 'rose'
        : pledgeRatio >= 15
          ? 'amber'
          : 'green'

  const auditOpinion = snapshot.latest_audit_opinion
  const auditColor = !auditOpinion
    ? 'gray'
    : auditOpinion.includes('标准无保留')
      ? 'green'
      : 'amber'

  const industryLabel =
    [snapshot.industry_sw1, snapshot.industry_sw2].filter(Boolean).join(' / ') || '全行业'

  return (
    <div className="stack" style={{ gap: 16 }}>
      <Card title="机构风控视角 · 股权质押与审计意见" extra={<Tag color="blue">尽调核查</Tag>}>
        <div className="grid grid-4">
          <div>
            <div className="metric-label">全市场股权质押比例</div>
            <div className="row mt-8" style={{ justifyContent: 'flex-start' }}>
              <span className="metric-value" style={{ fontSize: 22 }}>
                {formatPct(pledgeRatio, 2)}
              </span>
              <Tag color={pledgeColor}>
                {pledgeRatio === null || pledgeRatio === undefined
                  ? '未披露'
                  : pledgeRatio >= 30
                    ? '高风险'
                    : pledgeRatio >= 15
                      ? '中等关注'
                      : '低质押'}
              </Tag>
            </div>
            <div className="metric-sub">
              {snapshot.pledge_date ? `统计日 ${snapshot.pledge_date}` : '暂无质押记录'}
            </div>
          </div>

          <div>
            <div className="metric-label">最新年报审计意见</div>
            <div className="mt-8">
              <Tag color={auditColor}>{auditOpinion ?? '未披露'}</Tag>
            </div>
            <div className="metric-sub mt-8">来自最新同步年度报告</div>
          </div>

          <Metric
            label="5年累计 OCF / 净利润"
            value={formatPct(snapshot.peer_metrics.ocf_to_profit_5y_pct, 1)}
            sub="现金含金量校验"
          />

          <Metric
            label="净现金 / 总市值"
            value={formatPct(snapshot.peer_metrics.net_cash_to_mv_pct, 2)}
            sub={`CT 告警 ${snapshot.financial_ct.red_count} 红 / ${snapshot.financial_ct.yellow_count} 黄`}
          />
        </div>
      </Card>

      <Card title="核心空头论点摘要">
        <ul className="bear-case-list">
          {snapshot.radar.bear_cases.map((item, index) => (
            <li key={`${index}-${item}`} className="bear-case-item">
              {item}
            </li>
          ))}
        </ul>
      </Card>

      <Card title="同行横向排位对照" extra={<Tag color="green">{industryLabel}</Tag>}>
        <div className="row" style={{ flexWrap: 'wrap', gap: 12 }}>
          <div className="stack" style={{ gap: 4 }}>
            <strong>将 {snapshot.name} 放入同业横向对比矩阵</strong>
            <span className="small muted">
              一键比较 PE 分位、5 年平均 ROE、毛利率、股东回报率、隐含 FCF 增速与 CT 红黄灯。
            </span>
          </div>
          <Link className="btn-primary" to={`/compare?codes=${snapshot.code}`}>
            对比同行标的（打开矩阵）
          </Link>
        </div>
      </Card>
    </div>
  )
}
