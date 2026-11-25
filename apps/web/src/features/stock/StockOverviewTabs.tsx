import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Card } from '../../components/ui/Card'
import { type CustomGlossaryEntry, GlossaryLabel, InfoHint } from '../../components/ui/InfoHint'
import { Metric } from '../../components/ui/Metric'
import { ScoreRing } from '../../components/ui/ScoreRing'
import { EmptyBlock } from '../../components/ui/StateBlock'
import { Tag } from '../../components/ui/Tag'
import { createChartTheme } from '../../lib/chartTheme'
import { Chart, type ChartOption } from '../../lib/charts'
import {
  formatForensicRatioPct,
  formatNum,
  formatPct,
  formatYi,
  qualityTone,
  toYi,
} from '../../lib/format'
import type { GlossaryKey } from '../../lib/glossary'
import { useThemeMode } from '../../lib/theme'
import type { StockSnapshotPayload } from '../../types/api'
import { SingularitySphereCanvas } from './SingularitySphereCanvas'
import {
  FORMULA_NOTE_TITLES,
  getEarningsQualityBadgeMeta,
  getForensicBridgeStepClass,
  getRadarDimensions,
  isFinancialSnapshot,
  type RadarDimensionKey,
} from './stockHelpers'
import { useCompactViewport } from './useCompactViewport'

function CustomHintLabel({
  label,
  title,
  entry,
}: {
  label: string
  title?: string
  entry: CustomGlossaryEntry
}) {
  return (
    <span className="label-with-hint">
      <span>{label}</span>
      <InfoHint title={title ?? label} entry={entry} />
    </span>
  )
}

function getRadarDimensionGlossaryKey(key: RadarDimensionKey, isFinancial: boolean): GlossaryKey {
  switch (key) {
    case 'profitability':
      return 'radar_profitability'
    case 'moat':
      return 'radar_moat'
    case 'balance_sheet':
      return 'radar_leverage'
    case 'cashflow_quality':
      return isFinancial ? 'radar_capital_endurance' : 'radar_cashflow'
    case 'valuation_margin':
      return 'radar_valuation'
    default: {
      const exhaustive: never = key
      return exhaustive
    }
  }
}

const MOAT_DIMENSION_GLOSSARY_KEYS: Readonly<Record<string, GlossaryKey>> = {
  roe_durability: 'roe_5y_avg',
  pricing_power: 'gross_margin_latest',
  cash_conversion: 'cash_profit_ratio',
  capital_efficiency: 'roic_approx',
  balance_fortress: 'radar_leverage',
  rd_reinvestment: 'rd_intensity',
}

function clampPctWidth(score: number): number {
  return Math.min(100, Math.max(0, score))
}

export function StockOverviewTab({ snapshot }: { snapshot: StockSnapshotPayload }) {
  const { theme } = useThemeMode()
  const [radarView, setRadarView] = useState<'2d' | '3d'>('2d')
  const {
    radar,
    valuation,
    moat,
    financial_ct: financialCt,
    shareholder_return: sReturn,
  } = snapshot

  const isFinancial = useMemo(() => isFinancialSnapshot(snapshot), [snapshot])
  const radarDimensions = useMemo(() => getRadarDimensions(snapshot), [snapshot])
  const forensics = snapshot.forensics ?? null
  const forensicsBadge = useMemo(
    () =>
      forensics
        ? getEarningsQualityBadgeMeta(
            forensics.earnings_quality_tag,
            forensics.earnings_quality_label,
          )
        : null,
    [forensics],
  )

  const radarOption = useMemo<ChartOption>(() => {
    const { colors, tooltip } = createChartTheme(theme)
    return {
      tooltip: {
        ...tooltip,
        trigger: 'item',
      },
      radar: {
        radius: '66%',
        indicator: radarDimensions.map((dim) => ({ name: dim.label, max: 100 })),
        axisName: { color: colors.text, fontSize: 12 },
        splitArea: { areaStyle: { color: ['transparent'] } },
        splitLine: { lineStyle: { color: colors.grid } },
        axisLine: { lineStyle: { color: colors.axisLine } },
      },
      series: [
        {
          type: 'radar',
          symbolSize: 5,
          data: [
            {
              value: radarDimensions.map((dim) => dim.score),
              name: `${snapshot.name} 综合画像`,
              itemStyle: { color: colors.positive },
              lineStyle: { color: colors.positive, width: 2 },
              areaStyle: { color: colors.electric, opacity: 0.16 },
            },
          ],
        },
      ],
    }
  }, [radarDimensions, snapshot.name, theme])

  const formulaEntries = Object.entries(snapshot.formula_notes)

  return (
    <div className="stack" style={{ gap: 16 }}>
      <Card
        title="五维定量雷达评分"
        hint="stock_radar_summary"
        extra={
          <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <div className="label-with-hint">
              <div className="seg-well" role="group" aria-label="五维视图切换">
                <button
                  type="button"
                  className={
                    radarView === '2d' ? 'seg-tab seg-tab-sm active' : 'seg-tab seg-tab-sm'
                  }
                  aria-pressed={radarView === '2d'}
                  onClick={() => setRadarView('2d')}
                >
                  2D 雷达图
                </button>
                <button
                  type="button"
                  className={
                    radarView === '3d' ? 'seg-tab seg-tab-sm active' : 'seg-tab seg-tab-sm'
                  }
                  aria-pressed={radarView === '3d'}
                  onClick={() => setRadarView('3d')}
                >
                  3D 奇点球
                </button>
              </div>
              <InfoHint term="radar_2d_3d" />
            </div>
            {isFinancial ? <Tag color="blue">金融业专项口径</Tag> : null}
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
            {radarView === '2d' ? (
              <Chart option={radarOption} height={240} ariaLabel="五维评分雷达图" />
            ) : (
              <SingularitySphereCanvas
                stockName={snapshot.name}
                totalScore={radar.total_score}
                dimensions={radarDimensions}
                height={340}
              />
            )}
          </div>

          <div className="stack" style={{ gap: 10 }}>
            {radarDimensions.map((dim) => (
              <div key={dim.key} className="score-bar-item">
                <div className="row">
                  <GlossaryLabel
                    label={dim.label}
                    term={getRadarDimensionGlossaryKey(dim.key, isFinancial)}
                    className="small soft"
                  />
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
            hint="latest_close"
            value={formatNum(valuation.close, 2)}
            sub={valuation.latest_trade_date ? `交易日 ${valuation.latest_trade_date}` : '—'}
          />
        </Card>
        <Card>
          <Metric
            label="总市值"
            hint="market_cap"
            value={formatYi(valuation.total_mv_yuan)}
            sub={`PE(TTM) ${formatNum(valuation.pe_ttm, 2)}`}
          />
        </Card>
        <Card>
          <Metric
            label="5年平均 ROE"
            hint="roe_5y_avg"
            value={formatPct(moat.roe_5y_avg_pct, 2)}
            sub={
              isFinancial &&
              valuation.pb_percentile_10y !== null &&
              valuation.pb_percentile_10y !== undefined
                ? `10Y PB 分位 ${formatPct(valuation.pb_percentile_10y, 1)}`
                : `10Y PE 分位 ${formatPct(valuation.pe_percentile_10y, 1)}`
            }
          />
        </Card>
        <Card>
          <Metric
            label={
              <CustomHintLabel
                label="排雷与股东回报"
                entry={{
                  summary:
                    '汇总 ClearTruth 财务排雷 7 项扫描触发的红灯/黄灯数量，以及当前年度现金分红对应总市值的静态股息率。',
                  formula:
                    '红/黄灯来自 7 项财务 CT 规则；当前股息率 = 最近年度现金分红总额 ÷ 当前总市值 × 100%。',
                  reading:
                    '存在红灯时建议优先切换至「风险排雷」下钻原值；股息率需在「治理」页确认自由现金流覆盖倍数。',
                }}
              />
            }
            value={`${financialCt.red_count} 红 / ${financialCt.yellow_count} 黄`}
            sub={`当前股息率 ${formatPct(sReturn.current_dividend_yield_pct, 2)}`}
            tone={financialCt.red_count > 0 ? 'tone-bad' : 'tone-good'}
          />
        </Card>
      </div>

      {forensics && forensicsBadge ? (
        <Card
          title="利润含金量与表内结构速览"
          hint="forensic_profit_truth"
          extra={<span className={forensicsBadge.badgeClass}>{forensicsBadge.label}</span>}
        >
          <div className="stack" style={{ gap: 12 }}>
            <div className="forensic-bridge-grid">
              <div
                className={getForensicBridgeStepClass(
                  'core',
                  forensics.core_profit_share_3y_pct,
                  forensics.earnings_quality_tag,
                )}
              >
                <div className="forensic-bridge-label">
                  <GlossaryLabel label="主业核心占比" term="core_operating_profit" />
                </div>
                <div className="forensic-bridge-value">
                  {forensics.core_profit_share_3y_pct === null ||
                  forensics.core_profit_share_3y_pct === undefined
                    ? '—'
                    : formatForensicRatioPct(forensics.core_profit_share_3y_pct)}
                </div>
                <div className="forensic-bridge-sub">近3年主业核心营业利润占比</div>
              </div>

              <div
                className={getForensicBridgeStepClass(
                  'invest',
                  forensics.invest_profit_share_3y_pct,
                  forensics.earnings_quality_tag,
                )}
              >
                <div className="forensic-bridge-label">
                  <GlossaryLabel label="投资收益占比" term="invest_profit_share" />
                </div>
                <div className="forensic-bridge-value">
                  {forensics.invest_profit_share_3y_pct === null ||
                  forensics.invest_profit_share_3y_pct === undefined
                    ? '—'
                    : formatForensicRatioPct(forensics.invest_profit_share_3y_pct, {
                        fallbackText: '主业微利(不适用)',
                      })}
                </div>
                <div className="forensic-bridge-sub">近3年投资与公允价值占营业利润</div>
              </div>

              <div
                className={getForensicBridgeStepClass(
                  'assets',
                  forensics.investment_assets_ratio_pct,
                  forensics.earnings_quality_tag,
                )}
              >
                <div className="forensic-bridge-label">
                  <GlossaryLabel label="表内投资资产占比" term="investment_assets_ratio" />
                </div>
                <div className="forensic-bridge-value">
                  {forensics.investment_assets_ratio_pct === null ||
                  forensics.investment_assets_ratio_pct === undefined
                    ? '—'
                    : formatForensicRatioPct(forensics.investment_assets_ratio_pct)}
                </div>
                <div className="forensic-bridge-sub">
                  {`投资类资产 ${formatYi(forensics.investment_assets_yuan)}`}
                </div>
              </div>

              <div className="forensic-bridge-step">
                <div className="forensic-bridge-label">
                  <GlossaryLabel label="OCF/核心利润" term="ocf_to_core_profit" />
                </div>
                <div className="forensic-bridge-value">
                  {forensics.earnings_quality_tag === 'financial_special' &&
                  (forensics.ocf_to_core_profit_3y_pct === null ||
                    forensics.ocf_to_core_profit_3y_pct === undefined)
                    ? '金融业不适用'
                    : formatForensicRatioPct(forensics.ocf_to_core_profit_3y_pct, {
                        fallbackText: '主业微利(不适用)',
                      })}
                </div>
                <div className="forensic-bridge-sub">近3年经营现金流转化率</div>
              </div>
            </div>

            <p className="small soft wrap-anywhere">{forensics.verdict}</p>
          </div>
        </Card>
      ) : null}

      <Card
        title="空头视角与核心风险提示"
        hint="bear_risk_summary"
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
        <Card title="方法论与口径说明书" hint="methodology_spec">
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
  const { theme } = useThemeMode()
  const isCompact = useCompactViewport()
  const trendsAsc = useMemo(
    () => [...snapshot.annual_trends].sort((a, b) => a.year - b.year),
    [snapshot.annual_trends],
  )
  const trendsDesc = useMemo(() => [...trendsAsc].reverse(), [trendsAsc])

  const trendOption = useMemo<ChartOption>(() => {
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
        data: ['营业收入', '归母净利润', '自由现金流', 'ROE (%)'],
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
        data: trendsAsc.map((point) => String(point.year)),
      },
      yAxis: [
        {
          ...axis,
          type: 'value',
          name: '亿元',
          nameGap: 14,
          nameTextStyle: { color: colors.muted },
        },
        {
          ...axis,
          type: 'value',
          name: 'ROE %',
          nameGap: 14,
          nameTextStyle: { color: colors.muted },
          splitLine: { show: false },
        },
      ],
      series: [
        {
          name: '营业收入',
          type: 'bar',
          barMaxWidth: 18,
          itemStyle: { color: colors.electric, borderRadius: [4, 4, 0, 0] },
          data: trendsAsc.map((point) => toYi(point.revenue_yuan)),
        },
        {
          name: '归母净利润',
          type: 'bar',
          barMaxWidth: 18,
          itemStyle: { color: colors.positive, borderRadius: [4, 4, 0, 0] },
          data: trendsAsc.map((point) => toYi(point.net_profit_yuan)),
        },
        {
          name: '自由现金流',
          type: 'bar',
          barMaxWidth: 18,
          itemStyle: { color: colors.violet, borderRadius: [4, 4, 0, 0] },
          data: trendsAsc.map((point) => toYi(point.fcf_yuan)),
        },
        {
          name: 'ROE (%)',
          type: 'line',
          yAxisIndex: 1,
          smooth: true,
          symbolSize: 6,
          itemStyle: { color: colors.amber },
          lineStyle: { color: colors.amber, width: 2 },
          data: trendsAsc.map((point) =>
            point.roe_pct !== null && point.roe_pct !== undefined
              ? Number(point.roe_pct.toFixed(2))
              : null,
          ),
        },
      ],
    }
  }, [isCompact, trendsAsc, theme])

  if (trendsAsc.length === 0) {
    return (
      <Card
        title={
          <CustomHintLabel
            label="财务分析 · 十年核心指标"
            entry={{
              summary:
                '汇总最近 10 个完整会计年度的营业收入、利润、现金流、ROE 与净现金等核心财务指标，用于检验跨周期复利质量。',
              reading: '优先关注扣非净利润、自由现金流与毛利率的长期稳健性。',
            }}
          />
        }
      >
        <EmptyBlock title="暂无历年财务趋势数据" hint="请确认已同步该标的历史年报数据。" />
      </Card>
    )
  }

  return (
    <div className="stack" style={{ gap: 16 }}>
      <Card
        title={
          <CustomHintLabel
            label="十年财务趋势（营收 / 归母净利润 / 自由现金流 & ROE）"
            title="十年财务趋势图"
            entry={{
              summary:
                '同图对照历年营业收入、归母净利润、自由现金流（柱状，左轴亿元）与净资产收益率 ROE（折线，右轴 %）。',
              reading:
                '观察营收扩张是否同步带来自由现金流增长，以及 ROE 是否在高位保持平稳，警惕只增收不增现的扩张。',
            }}
          />
        }
        extra={<Tag color="blue">{trendsAsc.length} 个报告期</Tag>}
      >
        <Chart option={trendOption} height={300} ariaLabel="十年财务趋势图" />
      </Card>

      <Card
        title={
          <CustomHintLabel
            label="历年核心财务明细（金额单位：亿元）"
            title="历年核心财务明细"
            entry={{
              summary:
                '按报告年度倒序呈现营业收入、归母净利润、扣非净利润、经营现金流、自由现金流、ROE、毛利率、净利率与净现金头寸。',
              reading: '可点击表头各指标旁的 ? 查看对应会计公式与研读口径。',
            }}
          />
        }
      >
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>年份</th>
                <th style={{ textAlign: 'right' }}>
                  <GlossaryLabel label="营业收入" term="revenue" />
                </th>
                <th style={{ textAlign: 'right' }}>
                  <GlossaryLabel label="归母净利润" term="net_profit" />
                </th>
                <th style={{ textAlign: 'right' }}>
                  <GlossaryLabel label="扣非净利润" term="deduct_net_profit" />
                </th>
                <th style={{ textAlign: 'right' }}>
                  <GlossaryLabel label="经营现金流" term="ocf" />
                </th>
                <th style={{ textAlign: 'right' }}>
                  <GlossaryLabel label="自由现金流" term="fcf" />
                </th>
                <th style={{ textAlign: 'right' }}>
                  <GlossaryLabel label="ROE" term="roe" />
                </th>
                <th style={{ textAlign: 'right' }}>
                  <GlossaryLabel label="毛利率" term="gross_margin" />
                </th>
                <th style={{ textAlign: 'right' }}>
                  <GlossaryLabel label="净利率" term="net_margin" />
                </th>
                <th style={{ textAlign: 'right' }}>
                  <GlossaryLabel label="净现金" term="net_cash" />
                </th>
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
      <Card title="护城河资本回报核心指标" hint="moat_indicators">
        <div className="grid grid-5">
          <Metric label="5年平均 ROE" hint="roe_5y_avg" value={formatPct(moat.roe_5y_avg_pct, 2)} />
          <Metric
            label="10年最低 ROE"
            hint="roe_10y_min"
            value={formatPct(moat.roe_10y_min_pct, 2)}
          />
          <Metric
            label="最新毛利率"
            hint="gross_margin_latest"
            value={formatPct(moat.gross_margin_latest_pct, 2)}
          />
          <Metric
            label="5年毛利率标准差"
            hint="gross_margin_std"
            value={formatPct(moat.gross_margin_5y_std_pct, 2)}
            sub="越低越稳定"
          />
          <Metric label="近似 ROIC" hint="roic_approx" value={formatPct(moat.roic_approx_pct, 2)} />
        </div>
        {roicNote ? <p className="small muted mt-16">{roicNote}</p> : null}
      </Card>

      <Card
        title={
          <CustomHintLabel
            label="护城河分项评估"
            entry={{
              summary:
                '把抽象的竞争壁垒拆解为 ROE 持久力、定价权与毛利率稳定性、盈利含金量、投入资本效率、资产负债安全垫等 0–100 分定量代理指标。',
              reading: '重点观察得分偏低的分项（< 50 分），判断短板属于行业属性还是竞争力弱化。',
            }}
          />
        }
        extra={<Tag color="blue">{moat.dimensions.length} 个定量维度</Tag>}
      >
        {moat.dimensions.length === 0 ? (
          <EmptyBlock title="暂无护城河分项评估" />
        ) : (
          <div className="grid grid-2">
            {moat.dimensions.map((item) => {
              const moatDimTerm = MOAT_DIMENSION_GLOSSARY_KEYS[item.key]
              return (
                <div key={item.key} className="subpanel">
                  <div className="row">
                    <span className="label-with-hint">
                      <strong>{item.label}</strong>
                      {moatDimTerm ? (
                        <InfoHint term={moatDimTerm} title={item.label} />
                      ) : (
                        <InfoHint
                          title={item.label}
                          entry={{
                            summary: item.summary,
                            reading: '定量分项评分范围 0–100，分数越高表示该维度壁垒表现越稳健。',
                          }}
                        />
                      )}
                    </span>
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
              )
            })}
          </div>
        )}
      </Card>
    </div>
  )
}

export function StockGrowthTab({ snapshot }: { snapshot: StockSnapshotPayload }) {
  const { theme } = useThemeMode()
  const isCompact = useCompactViewport()
  const { growth, annual_trends: annualTrends } = snapshot
  const trendsAsc = useMemo(() => [...annualTrends].sort((a, b) => a.year - b.year), [annualTrends])

  const marginOption = useMemo<ChartOption>(() => {
    const { colors, axis, legend, tooltip } = createChartTheme(theme)
    return {
      tooltip: {
        ...tooltip,
        trigger: 'axis',
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
        data: ['毛利率 (%)', '净利率 (%)', '研发费用率 (%)'],
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
        data: trendsAsc.map((point) => String(point.year)),
      },
      yAxis: {
        ...axis,
        type: 'value',
        name: '%',
        nameGap: 14,
        nameTextStyle: { color: colors.muted },
      },
      series: [
        {
          name: '毛利率 (%)',
          type: 'line',
          smooth: true,
          itemStyle: { color: colors.positive },
          data: trendsAsc.map((point) => point.gross_margin_pct ?? null),
        },
        {
          name: '净利率 (%)',
          type: 'line',
          smooth: true,
          itemStyle: { color: colors.electric },
          data: trendsAsc.map((point) => point.net_margin_pct ?? null),
        },
        {
          name: '研发费用率 (%)',
          type: 'line',
          smooth: true,
          itemStyle: { color: colors.amber },
          data: trendsAsc.map((point) => point.rd_ratio_pct ?? null),
        },
      ],
    }
  }, [isCompact, trendsAsc, theme])

  return (
    <div className="stack" style={{ gap: 16 }}>
      <Card title="增长引擎与再投资效率" hint="growth_engine">
        <div className="grid grid-3">
          <Metric
            label={
              <CustomHintLabel
                label="3年营收 CAGR"
                entry={{
                  summary:
                    '公司最近 3 个完整会计年度营业收入的年化复合增长率（CAGR），反映中期业务扩张速度。',
                  formula: '3年营收 CAGR = ((最新年营收 ÷ 3年前营收)^(1 / 3) − 1) × 100%。',
                  reading: '与 5 年营收 CAGR 对比，可判断企业增长是在提速还是进入成熟放缓期。',
                }}
              />
            }
            value={formatPct(growth.revenue_cagr_3y_pct, 2)}
            tone={qualityTone(growth.revenue_cagr_3y_pct)}
          />
          <Metric
            label="5年营收 CAGR"
            hint="hist_rev_cagr"
            value={formatPct(growth.revenue_cagr_5y_pct, 2)}
            tone={qualityTone(growth.revenue_cagr_5y_pct)}
          />
          <Metric
            label={
              <CustomHintLabel
                label="5年归母净利润 CAGR"
                entry={{
                  summary: '最近 5 个完整会计年度归属于母公司股东净利润的年化复合增速。',
                  formula:
                    '5年归母净利润 CAGR = ((最新年归母净利润 ÷ 5年前归母净利润)^(1 / 5) − 1) × 100%。',
                  reading:
                    '若持续高于营收增速说明存在规模效应或净利率提升；显著低于营收增速则需警惕费用或减值侵蚀。',
                }}
              />
            }
            value={formatPct(growth.profit_cagr_5y_pct, 2)}
            tone={qualityTone(growth.profit_cagr_5y_pct)}
          />
          <Metric
            label={
              <CustomHintLabel
                label="5年扣非净利润 CAGR"
                entry={{
                  summary:
                    '最近 5 个完整会计年度扣除非经常性损益后归母净利润的年化复合增速，更能体现核心主业真实成长性。',
                  formula:
                    '5年扣非净利润 CAGR = ((最新年扣非净利润 ÷ 5年前扣非净利润)^(1 / 5) − 1) × 100%。',
                  reading: '长期扣非净利润增速与经营现金流同步扩张是高质量复利的重要印证。',
                }}
              />
            }
            value={formatPct(growth.deduct_profit_cagr_5y_pct, 2)}
            tone={qualityTone(growth.deduct_profit_cagr_5y_pct)}
          />
          <Metric
            label="最新研发费用率"
            hint="rd_intensity"
            value={formatPct(growth.rd_ratio_latest_pct, 2)}
            sub="研发投入 / 营业收入"
          />
          <Metric
            label="资本开支 / 经营现金流"
            hint="capex_burden"
            value={formatPct(growth.capex_to_ocf_latest_pct, 2)}
            sub="越低代表内生现金越充裕"
          />
        </div>
      </Card>

      <Card
        title={
          <CustomHintLabel
            label="利润率与研发投入强度走势"
            entry={{
              summary:
                '在同一时间轴追踪历年销售毛利率、净利率与研发费用率（%）的演变轨迹，观察产品力与费用效率变化。',
              formula:
                '毛利率 = (营收−营业成本)÷营收；净利率 = 净利润÷营收；研发费用率 = 研发费用÷营收。',
              reading: '毛利率高位企稳且期间费用受控时，净利率能维持稳定或稳步抬升。',
            }}
          />
        }
      >
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
      <Card
        title={
          <CustomHintLabel
            label="机构风控视角 · 股权质押与审计意见"
            title="机构风控视角"
            entry={{
              summary:
                '从大股东股权质押风险、最新年报审计意见结论、5 年累计净现比及净现金占总市值比例四个维度开展机构式底线尽调。',
              reading: '优先排查质押红线与非标审计意见，再验证长期利润现金含金量与资产负债安全垫。',
            }}
          />
        }
        extra={<Tag color="blue">尽调核查</Tag>}
      >
        <div className="grid grid-4">
          <div>
            <div className="metric-label">
              <GlossaryLabel label="全市场股权质押比例" term="pledge_ratio" />
            </div>
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
            <div className="metric-label">
              <GlossaryLabel label="最新年报审计意见" term="audit_opinion" />
            </div>
            <div className="mt-8">
              <Tag color={auditColor}>{auditOpinion ?? '未披露'}</Tag>
            </div>
            <div className="metric-sub mt-8">来自最新同步年度报告</div>
          </div>

          <Metric
            label="5年累计 OCF / 净利润"
            hint="ocf_to_profit_5y"
            value={formatPct(snapshot.peer_metrics.ocf_to_profit_5y_pct, 1)}
            sub="现金含金量校验"
          />

          <Metric
            label="净现金 / 总市值"
            hint="net_cash_to_mv"
            value={formatPct(snapshot.peer_metrics.net_cash_to_mv_pct, 2)}
            sub={`CT 告警 ${snapshot.financial_ct.red_count} 红 / ${snapshot.financial_ct.yellow_count} 黄`}
          />
        </div>
      </Card>

      <Card title="核心空头论点摘要" hint="bear_risk_summary">
        <ul className="bear-case-list">
          {snapshot.radar.bear_cases.map((item, index) => (
            <li key={`${index}-${item}`} className="bear-case-item">
              {item}
            </li>
          ))}
        </ul>
      </Card>

      <Card
        title="同行横向排位对照"
        hint="peer_rank"
        extra={<Tag color="green">{industryLabel}</Tag>}
      >
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
