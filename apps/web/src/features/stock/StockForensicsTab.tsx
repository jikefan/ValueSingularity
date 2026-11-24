import { useMemo } from 'react'
import { Card } from '../../components/ui/Card'
import { GlossaryLabel, InfoHint } from '../../components/ui/InfoHint'
import { Metric } from '../../components/ui/Metric'
import { EmptyBlock } from '../../components/ui/StateBlock'
import { Tag } from '../../components/ui/Tag'
import { createChartTheme } from '../../lib/chartTheme'
import { Chart, type ChartOption } from '../../lib/charts'
import { fmtNum, formatNum, formatPct, formatYi, qualityTone, toYi } from '../../lib/format'
import type { GlossaryKey } from '../../lib/glossary'
import { useThemeMode } from '../../lib/theme'
import { useForceSyncStockSnapshot } from '../../lib/useStockAnalysis'
import type { CapitalAllocationSummary, StockSnapshotPayload } from '../../types/api'
import {
  getEarningsQualityBadgeMeta,
  getEarningsQualityVerdictTone,
  getForensicBridgeStepClass,
  SIGNAL_META,
} from './stockHelpers'
import { useCompactViewport } from './useCompactViewport'

const FINDING_GLOSSARY_KEYS: Readonly<Record<string, GlossaryKey>> = {
  investment_reliance: 'invest_profit_share',
  non_recurring_subsidy: 'subsidy_and_oneoff',
  dupont_attribution: 'dupont_attribution',
  cashflow_core_conversion: 'ocf_to_core_profit',
  capital_allocation: 'capital_allocation',
  financial_profit_stability: 'roe_5y_avg',
}

function roundMetric(value: number | null | undefined, digits = 2): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return null
  }
  return Number(value.toFixed(digits))
}

function formatRatioValue(value: number | null | undefined, suffix: string): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '—'
  }
  return `${fmtNum(value, 2)}${suffix}`
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value)
}

function formatTooltipValue(value: unknown, unit: string, digits = 2): string {
  const scalar = isUnknownArray(value) ? value[0] : value
  if (scalar === null || scalar === undefined || scalar === '' || typeof scalar === 'boolean') {
    return '—'
  }
  const numeric = typeof scalar === 'number' ? scalar : Number(scalar)
  if (!Number.isFinite(numeric)) {
    return '—'
  }
  return unit ? `${formatNum(numeric, digits)}${unit}` : formatNum(numeric, digits)
}

function getCapitalAllocationTagColor(
  capAlloc: CapitalAllocationSummary,
): 'green' | 'amber' | 'rose' | 'gray' {
  if (capAlloc.total_ocf_yuan === null || capAlloc.total_ocf_yuan === undefined) {
    return 'gray'
  }
  if (capAlloc.total_ocf_yuan <= 0) {
    return 'rose'
  }
  if (
    capAlloc.allocation_style.includes('现金牛') ||
    capAlloc.allocation_style.includes('平衡') ||
    capAlloc.allocation_style.includes('内生')
  ) {
    return 'green'
  }
  return 'amber'
}

export type StockForensicsTabProps = {
  snapshot: StockSnapshotPayload
  stockCode?: string
  onSwitchTab?: (tab: 'financials' | 'risks') => void
}

export function StockForensicsTab({ snapshot, stockCode, onSwitchTab }: StockForensicsTabProps) {
  const { theme } = useThemeMode()
  const isCompact = useCompactViewport()
  const resolvedCode = stockCode?.trim() || snapshot.code
  const forceSyncMutation = useForceSyncStockSnapshot(resolvedCode)
  const activeSnapshot =
    !snapshot.forensics &&
    forceSyncMutation.data &&
    forceSyncMutation.data.code === resolvedCode &&
    forceSyncMutation.data.forensics
      ? forceSyncMutation.data
      : snapshot
  const forensics = activeSnapshot.forensics ?? null

  const decompAsc = useMemo(() => {
    const items = forensics?.annual_decomposition ?? []
    return [...items].sort((a, b) => a.year - b.year)
  }, [forensics?.annual_decomposition])

  const decompDesc = useMemo(() => [...decompAsc].reverse(), [decompAsc])

  const dupontAsc = useMemo(() => {
    const items = forensics?.dupont_series ?? []
    return [...items].sort((a, b) => a.year - b.year)
  }, [forensics?.dupont_series])

  const dupontDesc = useMemo(() => [...dupontAsc].reverse(), [dupontAsc])

  const profitBridgeOption = useMemo<ChartOption>(() => {
    const { colors, axis, legend, tooltip } = createChartTheme(theme)
    return {
      tooltip: {
        ...tooltip,
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        valueFormatter: (value: unknown) => formatTooltipValue(value, ' 亿'),
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
        data: [
          '主业核心经营利润',
          '投资收益与公允价值',
          '补贴与一次性损益',
          '营业利润',
          '归母净利润',
          '经营现金流 OCF',
        ],
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
        data: decompAsc.map((point) => String(point.year)),
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
          name: '主业核心经营利润',
          type: 'bar',
          barMaxWidth: 16,
          itemStyle: { color: colors.positive },
          data: decompAsc.map((point) => toYi(point.core_operating_profit_yuan)),
        },
        {
          name: '投资收益与公允价值',
          type: 'bar',
          barMaxWidth: 16,
          itemStyle: { color: colors.amber },
          data: decompAsc.map((point) => toYi(point.investment_and_fair_value_yuan)),
        },
        {
          name: '补贴与一次性损益',
          type: 'bar',
          barMaxWidth: 16,
          itemStyle: { color: colors.negative },
          data: decompAsc.map((point) => toYi(point.subsidy_and_oneoff_yuan)),
        },
        {
          name: '营业利润',
          type: 'line',
          smooth: false,
          symbolSize: 6,
          itemStyle: { color: colors.white },
          lineStyle: { color: colors.white, width: 2, type: 'dashed' },
          data: decompAsc.map((point) => toYi(point.operate_profit_yuan)),
        },
        {
          name: '归母净利润',
          type: 'line',
          smooth: false,
          symbolSize: 6,
          itemStyle: { color: colors.electric },
          lineStyle: { color: colors.electric, width: 2 },
          data: decompAsc.map((point) => toYi(point.net_profit_yuan)),
        },
        {
          name: '经营现金流 OCF',
          type: 'line',
          smooth: false,
          symbolSize: 6,
          itemStyle: { color: colors.violet },
          lineStyle: { color: colors.violet, width: 2 },
          data: decompAsc.map((point) => toYi(point.ocf_yuan)),
        },
      ],
    }
  }, [decompAsc, isCompact, theme])

  const dupontOption = useMemo<ChartOption>(() => {
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
        data: ['ROE (%)', '销售净利率 (%)', '总资产周转率 (次)', '权益乘数 (x)'],
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
        data: dupontAsc.map((point) => String(point.year)),
      },
      yAxis: [
        {
          ...axis,
          type: 'value',
          name: '%',
          nameGap: 14,
          nameTextStyle: { color: colors.muted },
        },
        {
          ...axis,
          type: 'value',
          name: '倍数 / 次',
          nameGap: 14,
          nameTextStyle: { color: colors.muted },
          splitLine: { show: false },
        },
      ],
      series: [
        {
          name: 'ROE (%)',
          type: 'bar',
          barMaxWidth: 18,
          itemStyle: { color: colors.positive, borderRadius: [4, 4, 0, 0] },
          tooltip: { valueFormatter: (value: unknown) => formatTooltipValue(value, '%') },
          data: dupontAsc.map((point) => roundMetric(point.roe_pct)),
        },
        {
          name: '销售净利率 (%)',
          type: 'line',
          smooth: true,
          symbolSize: 6,
          itemStyle: { color: colors.electric },
          lineStyle: { color: colors.electric, width: 2 },
          tooltip: { valueFormatter: (value: unknown) => formatTooltipValue(value, '%') },
          data: dupontAsc.map((point) => roundMetric(point.net_margin_pct)),
        },
        {
          name: '总资产周转率 (次)',
          type: 'line',
          yAxisIndex: 1,
          smooth: true,
          symbolSize: 6,
          itemStyle: { color: colors.amber },
          lineStyle: { color: colors.amber, width: 2 },
          tooltip: { valueFormatter: (value: unknown) => formatTooltipValue(value, ' 次') },
          data: dupontAsc.map((point) => roundMetric(point.asset_turnover)),
        },
        {
          name: '权益乘数 (x)',
          type: 'line',
          yAxisIndex: 1,
          smooth: true,
          symbolSize: 6,
          itemStyle: { color: colors.violet },
          lineStyle: { color: colors.violet, width: 2 },
          tooltip: { valueFormatter: (value: unknown) => formatTooltipValue(value, ' 倍') },
          data: dupontAsc.map((point) => roundMetric(point.equity_multiplier)),
        },
      ],
    }
  }, [dupontAsc, isCompact, theme])

  if (!forensics) {
    const syncErrorMessage = forceSyncMutation.isError
      ? forceSyncMutation.error instanceof Error
        ? forceSyncMutation.error.message
        : '快照重算失败，请稍后重试'
      : null

    return (
      <Card title="利润真相与资本归因" hint="forensic_profit_truth">
        <div className="stack" style={{ gap: 14 }}>
          <EmptyBlock
            title="当前快照暂未包含利润真相深拆字段"
            hint="等待后台同步升级全量财报字段，或进入「风险排雷 / 财务分析」查看基础科目。"
          />
          {syncErrorMessage ? (
            <div className="inline-error" role="alert">
              {syncErrorMessage}
            </div>
          ) : null}
          {forceSyncMutation.isSuccess && !forceSyncMutation.data.forensics ? (
            <div className="notice-box" role="status">
              已完成快照重算，但当前财报数据源暂缺完整利润拆解所需科目。
            </div>
          ) : null}
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
            <button
              type="button"
              className="btn-primary"
              disabled={forceSyncMutation.isPending}
              onClick={() => {
                forceSyncMutation.mutate()
              }}
            >
              {forceSyncMutation.isPending ? '重算同步中...' : '立即重算并刷新利润真相'}
            </button>
            {onSwitchTab ? (
              <>
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => onSwitchTab('financials')}
                >
                  查看财务分析
                </button>
                <button type="button" className="btn-ghost" onClick={() => onSwitchTab('risks')}>
                  前往风险排雷
                </button>
              </>
            ) : null}
          </div>
        </div>
      </Card>
    )
  }

  const badgeMeta = getEarningsQualityBadgeMeta(
    forensics.earnings_quality_tag,
    forensics.earnings_quality_label,
  )
  const verdictTone = getEarningsQualityVerdictTone(forensics.earnings_quality_tag)
  const findings = forensics.findings ?? []
  const capAlloc = forensics.capital_allocation ?? null
  const isFinancialProfile = forensics.earnings_quality_tag === 'financial_special'

  return (
    <div className="stack" style={{ gap: 16 }}>
      <Card
        title="利润含金量深度鉴真"
        hint="forensic_profit_truth"
        extra={<span className={badgeMeta.badgeClass}>{badgeMeta.label}</span>}
      >
        <div className="stack" style={{ gap: 14 }}>
          <div className={`discovery-verdict-box discovery-verdict-${verdictTone}`} role="note">
            <strong>利润成色结论：</strong>
            <span>{forensics.verdict}</span>
          </div>

          <div className="forensic-bridge-grid">
            <div
              className={getForensicBridgeStepClass(
                'core',
                forensics.core_profit_share_3y_pct,
                forensics.earnings_quality_tag,
              )}
            >
              <div className="forensic-bridge-label">
                <GlossaryLabel label="主业核心利润占比 (3Y)" term="core_operating_profit" />
              </div>
              <div className="forensic-bridge-value">
                {formatPct(forensics.core_profit_share_3y_pct, 1)}
              </div>
              <div className="forensic-bridge-sub">
                {isFinancialProfile ? '金融业豁免主业剥离' : '≥ 75% 代表主业造血主导'}
              </div>
            </div>

            <div
              className={getForensicBridgeStepClass(
                'invest',
                forensics.invest_profit_share_3y_pct,
                forensics.earnings_quality_tag,
              )}
            >
              <div className="forensic-bridge-label">
                <GlossaryLabel label="投资与公允价值占比 (3Y)" term="invest_profit_share" />
              </div>
              <div className="forensic-bridge-value">
                {formatPct(forensics.invest_profit_share_3y_pct, 1)}
              </div>
              <div className="forensic-bridge-sub">
                {isFinancialProfile
                  ? '含债券配置与自营正常投资收益'
                  : '≥ 50% 触发高依赖红灯 · ≥ 20% 关注'}
              </div>
            </div>

            <div
              className={getForensicBridgeStepClass(
                'subsidy',
                forensics.non_recurring_share_3y_pct,
                forensics.earnings_quality_tag,
              )}
            >
              <div className="forensic-bridge-label">
                <GlossaryLabel label="补贴及一次性损益占比 (3Y)" term="subsidy_and_oneoff" />
              </div>
              <div className="forensic-bridge-value">
                {formatPct(forensics.non_recurring_share_3y_pct, 1)}
              </div>
              <div className="forensic-bridge-sub">政府补助、资产处置与营业外收支</div>
            </div>

            <div
              className={getForensicBridgeStepClass(
                'assets',
                forensics.investment_assets_ratio_pct,
                forensics.earnings_quality_tag,
              )}
            >
              <div className="forensic-bridge-label">
                <GlossaryLabel label="表内投资类资产占比" term="investment_assets_ratio" />
              </div>
              <div className="forensic-bridge-value">
                {formatPct(forensics.investment_assets_ratio_pct, 1)}
              </div>
              <div className="forensic-bridge-sub">
                {formatYi(forensics.investment_assets_yuan)}
              </div>
            </div>
          </div>

          <div className="grid grid-2">
            <div className="subpanel">
              <Metric
                label="OCF / 主业核心利润 (3Y)"
                hint="ocf_to_core_profit"
                value={formatPct(forensics.ocf_to_core_profit_3y_pct, 1)}
                sub="税后OCF / 税前核心利润 · ≥ 60% 扎实 / < 35% 红灯"
              />
            </div>
            <div className="subpanel">
              <Metric
                label="利息负担率 (3Y)"
                hint="interest_burden"
                value={formatPct(forensics.interest_burden_pct, 1)}
                sub="利息/息税前核心利润 · ≥ 50% 红灯 / ≥ 25% 黄灯"
              />
            </div>
          </div>
        </div>
      </Card>

      <Card
        title="盈利失真与护城河线索雷达"
        hint="forensic_profit_truth"
        extra={<Tag color="blue">{findings.length} 项鉴真线索</Tag>}
      >
        {findings.length > 0 ? (
          <div className="forensic-findings-grid">
            {findings.map((finding) => {
              const statusMeta = SIGNAL_META[finding.status]
              const glossaryTerm = FINDING_GLOSSARY_KEYS[finding.finding_id]
              return (
                <article
                  key={finding.finding_id}
                  className={`forensic-finding-card forensic-finding-${finding.status}`}
                >
                  <div className="forensic-finding-head">
                    <span className="forensic-finding-title">
                      <span>{finding.title}</span>
                      {glossaryTerm ? (
                        <InfoHint term={glossaryTerm} title={finding.title} />
                      ) : (
                        <InfoHint title={finding.title} entry={{ summary: finding.detail }} />
                      )}
                    </span>
                    <Tag color={statusMeta.color}>{finding.metric_text}</Tag>
                  </div>
                  <div className="forensic-finding-headline">{finding.headline}</div>
                  <p className="forensic-finding-detail">{finding.detail}</p>
                </article>
              )
            })}
          </div>
        ) : (
          <EmptyBlock title="暂无盈利失真线索扫描项" />
        )}
      </Card>

      <Card
        title="年度利润构成拆解"
        hint="core_operating_profit"
        extra={
          decompAsc.length > 0 ? <Tag color="blue">{decompAsc.length} 个报告期</Tag> : undefined
        }
      >
        {decompAsc.length > 0 ? (
          <div className="stack" style={{ gap: 16 }}>
            <Chart option={profitBridgeOption} height={300} ariaLabel="年度利润构成拆解图" />
            <div className="table-wrap">
              <table className="pro-table" aria-label="年度利润构成拆解明细表">
                <thead>
                  <tr>
                    <th>年份</th>
                    <th className="text-right">
                      <GlossaryLabel label="营收 (亿)" term="revenue" />
                    </th>
                    <th className="text-right">
                      <GlossaryLabel label="主业核心利润 (亿)" term="core_operating_profit" />
                    </th>
                    <th className="text-right">
                      <GlossaryLabel label="核心利润率" term="core_operating_profit" />
                    </th>
                    <th className="text-right">
                      <GlossaryLabel label="投资与公允价值 (亿)" term="invest_and_fair_value" />
                    </th>
                    <th className="text-right">
                      <GlossaryLabel label="投资/营业利润比" term="invest_profit_share" />
                    </th>
                    <th className="text-right">
                      <GlossaryLabel label="补贴及一次性 (亿)" term="subsidy_and_oneoff" />
                    </th>
                    <th className="text-right">
                      <GlossaryLabel label="经营现金流 (亿)" term="ocf" />
                    </th>
                    <th className="text-right">
                      <GlossaryLabel label="归母净利 (亿)" term="net_profit" />
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {decompDesc.map((point) => (
                    <tr key={point.year}>
                      <td className="mono">{point.year}</td>
                      <td className="text-right tnum">{formatNum(toYi(point.revenue_yuan), 2)}</td>
                      <td
                        className={`text-right tnum ${qualityTone(point.core_operating_profit_yuan)}`}
                      >
                        {formatNum(toYi(point.core_operating_profit_yuan), 2)}
                      </td>
                      <td className="text-right tnum">
                        {formatPct(point.core_operating_margin_pct, 2)}
                      </td>
                      <td className="text-right tnum">
                        {formatNum(toYi(point.investment_and_fair_value_yuan), 2)}
                      </td>
                      <td className="text-right tnum">
                        {formatPct(point.invest_share_of_op_profit_pct, 1)}
                      </td>
                      <td className="text-right tnum">
                        {formatNum(toYi(point.subsidy_and_oneoff_yuan), 2)}
                      </td>
                      <td className="text-right tnum">{formatNum(toYi(point.ocf_yuan), 2)}</td>
                      <td className="text-right tnum">
                        {formatNum(toYi(point.net_profit_yuan), 2)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <EmptyBlock
            title="暂无年度利润构成拆解数据"
            hint="等待同步完整利润表投资收益、公允价值变动与政府补助明细。"
          />
        )}
      </Card>

      <Card
        title="近5年杜邦三因子归因"
        hint="dupont_attribution"
        extra={
          dupontAsc.length > 0 ? <Tag color="blue">{dupontAsc.length} 个报告期</Tag> : undefined
        }
      >
        <div className="stack" style={{ gap: 16 }}>
          <div className="forensic-dupont-grid">
            <div className="forensic-dupont-cell">
              <div className="forensic-bridge-label">
                <GlossaryLabel label="5Y ROE 均值" term="roe_5y_avg" />
              </div>
              <div className="forensic-bridge-value">
                {formatPct(forensics.dupont_roe_5y_avg_pct, 2)}
              </div>
              <div className="forensic-bridge-sub">净利率 × 周转率 × 乘数</div>
            </div>

            <div className="forensic-dupont-cell">
              <div className="forensic-bridge-label">
                <GlossaryLabel label="5Y 净利率均值" term="net_margin" />
              </div>
              <div className="forensic-bridge-value">
                {formatPct(forensics.dupont_net_margin_5y_avg_pct, 2)}
              </div>
              <div className="forensic-bridge-sub">定价权与期间费控体现</div>
            </div>

            <div className="forensic-dupont-cell">
              <div className="forensic-bridge-label">
                <GlossaryLabel label="5Y 总资产周转率" term="asset_turnover" />
              </div>
              <div className="forensic-bridge-value">
                {formatRatioValue(forensics.dupont_asset_turnover_5y_avg, ' 次')}
              </div>
              <div className="forensic-bridge-sub">
                {isFinancialProfile ? '金融业已豁免周转率对比' : '资产周转与营运效率'}
              </div>
            </div>

            <div className="forensic-dupont-cell">
              <div className="forensic-bridge-label">
                <GlossaryLabel label="5Y 权益乘数" term="equity_multiplier" />
              </div>
              <div className="forensic-bridge-value">
                {formatRatioValue(forensics.dupont_equity_multiplier_5y_avg, 'x')}
              </div>
              <div className="forensic-bridge-sub">非金融 &lt; 2.2x 较稳健</div>
            </div>
          </div>

          {dupontAsc.length > 0 ? (
            <>
              <Chart option={dupontOption} height={260} ariaLabel="杜邦三因子趋势图" />
              <div className="table-wrap">
                <table className="pro-table" aria-label="杜邦三因子历年明细表">
                  <thead>
                    <tr>
                      <th>年份</th>
                      <th className="text-right">
                        <GlossaryLabel label="ROE" term="roe" />
                      </th>
                      <th className="text-right">
                        <GlossaryLabel label="销售净利率" term="net_margin" />
                      </th>
                      <th className="text-right">
                        <GlossaryLabel label="总资产周转率" term="asset_turnover" />
                      </th>
                      <th className="text-right">
                        <GlossaryLabel label="权益乘数" term="equity_multiplier" />
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {dupontDesc.map((point) => (
                      <tr key={point.year}>
                        <td className="mono">{point.year}</td>
                        <td className="text-right tnum">{formatPct(point.roe_pct, 2)}</td>
                        <td className="text-right tnum">{formatPct(point.net_margin_pct, 2)}</td>
                        <td className="text-right tnum">
                          {formatRatioValue(point.asset_turnover, ' 次')}
                        </td>
                        <td className="text-right tnum">
                          {formatRatioValue(point.equity_multiplier, 'x')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <EmptyBlock title="暂无逐年杜邦三因子明细序列" />
          )}
        </div>
      </Card>

      <Card
        title="近5年资本配置画像"
        hint="capital_allocation"
        extra={
          capAlloc ? (
            <span className="row" style={{ gap: 8 }}>
              <Tag color={getCapitalAllocationTagColor(capAlloc)}>{capAlloc.allocation_style}</Tag>
              <Tag color="gray">近 {capAlloc.window_years} 年</Tag>
            </span>
          ) : undefined
        }
      >
        {capAlloc ? (
          <div className="stack" style={{ gap: 14 }}>
            <div className="notice-box" role="note">
              <strong>配置结论：</strong>
              <span>{capAlloc.summary}</span>
            </div>

            <div className="forensic-capalloc-grid">
              <div className="forensic-dupont-cell">
                <div className="forensic-bridge-label">
                  <GlossaryLabel label="累计 OCF" term="ocf" />
                </div>
                <div className="forensic-bridge-value">{formatYi(capAlloc.total_ocf_yuan)}</div>
                <div className="forensic-bridge-sub">{`近 ${capAlloc.window_years} 年经营现金总流入`}</div>
              </div>

              <div className="forensic-dupont-cell">
                <div className="forensic-bridge-label">
                  <GlossaryLabel label="累计资本开支" term="capex_burden" />
                </div>
                <div className="forensic-bridge-value">{formatYi(capAlloc.total_capex_yuan)}</div>
                <div className="forensic-bridge-sub">{`CapEx/OCF ${formatPct(capAlloc.capex_to_ocf_pct, 1)}`}</div>
              </div>

              <div className="forensic-dupont-cell">
                <div className="forensic-bridge-label">
                  <GlossaryLabel label="累计分红与回购" term="net_shareholder_return" />
                </div>
                <div className="forensic-bridge-value">
                  {formatYi(capAlloc.total_dividends_yuan + capAlloc.total_repurchases_yuan)}
                </div>
                <div className="forensic-bridge-sub">
                  {`回馈/OCF ${formatPct(capAlloc.payout_to_ocf_pct, 1)} · 股权再融资 ${formatYi(capAlloc.total_equity_financing_yuan)}`}
                </div>
              </div>

              <div className="forensic-dupont-cell">
                <div className="forensic-bridge-label">
                  <GlossaryLabel label="期末净现金 / 投资资产" term="net_cash" />
                </div>
                <div className="forensic-bridge-value">
                  {formatYi(capAlloc.ending_net_cash_yuan)}
                </div>
                <div className="forensic-bridge-sub">
                  {`表内投资资产 ${formatYi(capAlloc.ending_investment_assets_yuan)}`}
                </div>
              </div>
            </div>
          </div>
        ) : (
          <EmptyBlock title="暂无近5年资本配置画像" />
        )}
      </Card>
    </div>
  )
}
