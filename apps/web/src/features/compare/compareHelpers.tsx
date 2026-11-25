import type { ReactNode } from 'react'
import { Tag } from '../../components/ui/Tag'
import { getEarningsQualityBadgeMeta } from '../../lib/earningsQuality'
import {
  formatForensicRatioPct,
  formatNum,
  formatPct,
  formatSignedPct,
  formatStockName,
  formatYi,
  qualityTone,
} from '../../lib/format'
import type { GlossaryKey } from '../../lib/glossary'
import type { StockCompareItem } from '../../types/api'

export type ComparePreset = {
  label: string
  title: string
  namesSummary: string
  subtitle: string
  codes: readonly [string, ...string[]]
}

export const COMPARE_PRESETS: readonly ComparePreset[] = [
  {
    label: '白酒龙头对比（贵州茅台 · 五粮液 · 泸州老窖）',
    title: '白酒龙头对比',
    namesSummary: '贵州茅台 · 五粮液 · 泸州老窖',
    subtitle: '高端消费与现金流标杆',
    codes: ['600519', '000858', '000568'],
  },
  {
    label: '高股息银行（招商银行 · 工商银行 · 平安银行）',
    title: '高股息银行',
    namesSummary: '招商银行 · 工商银行 · 平安银行',
    subtitle: '低估值高分红红利代表',
    codes: ['600036', '601398', '000001'],
  },
  {
    label: '制造消费蓝筹（美的集团 · 比亚迪 · 伊利股份）',
    title: '制造消费蓝筹',
    namesSummary: '美的集团 · 比亚迪 · 伊利股份',
    subtitle: '跨行业龙头护城河对照',
    codes: ['000333', '002594', '600887'],
  },
  {
    label: '主业现金牛 vs 投资依赖（贵州茅台 · 长江电力 · 雅戈尔）',
    title: '主业现金牛 vs 投资依赖',
    namesSummary: '贵州茅台 · 长江电力 · 雅戈尔',
    subtitle: '主业造血与投资依赖盈利成色对照',
    codes: ['600519', '600900', '600177'],
  },
]

const FINANCIAL_SW1_INDUSTRIES = new Set(['银行', '非银金融', '保险', '证券', '多元金融'])
const FORENSIC_SENTINEL_ABS_LIMIT = 900

export function isFinancialCompareItem(item: StockCompareItem): boolean {
  if (item.metrics) {
    return item.metrics.is_financial
  }
  const sw1 = item.meta.industry_sw1?.trim() ?? ''
  return FINANCIAL_SW1_INDUSTRIES.has(sw1)
}

function getNonFinancialForensicNumber(
  item: StockCompareItem,
  selector: (metrics: NonNullable<StockCompareItem['metrics']>) => number | null | undefined,
): number | null {
  if (!item.metrics || isFinancialCompareItem(item)) {
    return null
  }
  const value = selector(item.metrics)
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return null
  }
  // Guard against legacy 999.0% sentinel values when ranking best forensic ratios.
  if (Math.abs(value) >= FORENSIC_SENTINEL_ABS_LIMIT) {
    return null
  }
  return value
}

export function renderExemptibleMetric(
  item: StockCompareItem,
  value: number | null | undefined,
  renderValue: (val: number | null | undefined) => ReactNode,
  { forceExemptOnFinancial = false }: { forceExemptOnFinancial?: boolean } = {},
): ReactNode {
  if (
    item.metrics &&
    isFinancialCompareItem(item) &&
    (forceExemptOnFinancial || value === null || value === undefined)
  ) {
    return <span className="small muted">行业不适用</span>
  }
  return renderValue(value)
}

export type CompareSyncStatus = 'syncing' | 'done' | 'failed'

type RowComparableSpec = {
  direction: 'higher' | 'lower'
  getValue: (item: StockCompareItem) => number | null
}

export type CompareMetricRow = {
  key: string
  label: string
  glossaryKey: GlossaryKey
  comparable?: RowComparableSpec
  render: (item: StockCompareItem, syncStatus?: CompareSyncStatus) => ReactNode
}

export const COMPARE_METRIC_ROWS: readonly CompareMetricRow[] = [
  {
    key: 'snapshot_status',
    label: '快照状态',
    glossaryKey: 'snapshot_status',
    render: (item, syncStatus) => {
      if (item.snapshot_available) {
        return (
          <Tag color="green">
            {item.snapshot_as_of ? `已同步 ${item.snapshot_as_of}` : '已同步'}
          </Tag>
        )
      }
      if (syncStatus === 'syncing') {
        return <Tag color="blue">自动拉取中…</Tag>
      }
      if (syncStatus === 'failed') {
        return <Tag color="amber">同步失败（暂缺）</Tag>
      }
      return <Tag color="gray">未同步快照</Tag>
    },
  },
  {
    key: 'industry',
    label: '申万一级行业',
    glossaryKey: 'industry_sw1',
    render: (item) => item.metrics?.industry_sw1 ?? item.meta.industry_sw1 ?? '—',
  },
  {
    key: 'total_score',
    label: '五维综合评分',
    glossaryKey: 'radar_total_score',
    comparable: {
      direction: 'higher',
      getValue: (item) => (item.metrics ? item.metrics.total_score : null),
    },
    render: (item) =>
      item.metrics ? (
        <Tag
          color={
            item.metrics.total_score >= 70
              ? 'green'
              : item.metrics.total_score >= 45
                ? 'blue'
                : 'amber'
          }
        >
          {item.metrics.total_score} / 100
        </Tag>
      ) : (
        '—'
      ),
  },
  {
    key: 'close',
    label: '最新收盘价（元）',
    glossaryKey: 'latest_close',
    render: (item) => <span className="mono">{formatNum(item.metrics?.close, 2)}</span>,
  },
  {
    key: 'total_mv_yuan',
    label: '总市值',
    glossaryKey: 'market_cap',
    render: (item) => <span className="mono">{formatYi(item.metrics?.total_mv_yuan)}</span>,
  },
  {
    key: 'pe_ttm',
    label: 'PE (TTM)',
    glossaryKey: 'pe_ttm',
    render: (item) => <span className="mono">{formatNum(item.metrics?.pe_ttm, 2)}</span>,
  },
  {
    key: 'pe_percentile_10y',
    label: 'PE 10年历史分位',
    glossaryKey: 'valuation_pct_10y',
    comparable: {
      direction: 'lower',
      getValue: (item) => item.metrics?.pe_percentile_10y ?? null,
    },
    render: (item) => <span className="mono">{formatPct(item.metrics?.pe_percentile_10y, 1)}</span>,
  },
  {
    key: 'pb',
    label: 'PB (市净率)',
    glossaryKey: 'pb',
    render: (item) => <span className="mono">{formatNum(item.metrics?.pb, 2)}</span>,
  },
  {
    key: 'roe_5y_avg_pct',
    label: '5年平均 ROE',
    glossaryKey: 'roe_5y_avg',
    comparable: {
      direction: 'higher',
      getValue: (item) => item.metrics?.roe_5y_avg_pct ?? null,
    },
    render: (item) => <span className="mono">{formatPct(item.metrics?.roe_5y_avg_pct, 2)}</span>,
  },
  {
    key: 'gross_margin_latest_pct',
    label: '最新毛利率',
    glossaryKey: 'gross_margin_latest',
    comparable: {
      direction: 'higher',
      getValue: (item) =>
        !item.metrics || isFinancialCompareItem(item)
          ? null
          : (item.metrics.gross_margin_latest_pct ?? null),
    },
    render: (item) =>
      renderExemptibleMetric(item, item.metrics?.gross_margin_latest_pct, (value) => (
        <span className="mono">{formatPct(value, 2)}</span>
      )),
  },
  {
    key: 'net_cash_to_mv_pct',
    label: '净现金 / 总市值',
    glossaryKey: 'net_cash_to_mv',
    comparable: {
      direction: 'higher',
      getValue: (item) =>
        !item.metrics || isFinancialCompareItem(item)
          ? null
          : (item.metrics.net_cash_to_mv_pct ?? null),
    },
    render: (item) =>
      renderExemptibleMetric(
        item,
        item.metrics?.net_cash_to_mv_pct,
        (value) => <span className={`mono ${qualityTone(value)}`}>{formatPct(value, 2)}</span>,
        { forceExemptOnFinancial: true },
      ),
  },
  {
    key: 'ocf_to_profit_5y_pct',
    label: '5年 OCF / 净利润',
    glossaryKey: 'ocf_to_profit_5y',
    comparable: {
      direction: 'higher',
      getValue: (item) =>
        !item.metrics || isFinancialCompareItem(item)
          ? null
          : (item.metrics.ocf_to_profit_5y_pct ?? null),
    },
    render: (item) =>
      renderExemptibleMetric(
        item,
        item.metrics?.ocf_to_profit_5y_pct,
        (value) => <span className="mono">{formatPct(value, 1)}</span>,
        { forceExemptOnFinancial: true },
      ),
  },
  {
    key: 'shareholder_yield_pct',
    label: '股东回报率',
    glossaryKey: 'net_cash_yield',
    comparable: {
      direction: 'higher',
      getValue: (item) => item.metrics?.shareholder_yield_pct ?? null,
    },
    render: (item) => (
      <span className={`mono ${qualityTone(item.metrics?.shareholder_yield_pct)}`}>
        {formatPct(item.metrics?.shareholder_yield_pct, 2)}
      </span>
    ),
  },
  {
    key: 'implied_fcf_cagr_pct',
    label: 'Reverse DCF 隐含 FCF 增速',
    glossaryKey: 'implied_fcf_cagr',
    render: (item) =>
      renderExemptibleMetric(
        item,
        item.metrics?.implied_fcf_cagr_pct,
        (value) => (
          <span className={`mono ${qualityTone(value, true)}`}>{formatSignedPct(value, 2)}</span>
        ),
        { forceExemptOnFinancial: true },
      ),
  },
  {
    key: 'earnings_quality',
    label: '盈利成色标签',
    glossaryKey: 'forensic_profit_truth',
    render: (item) =>
      item.metrics?.earnings_quality_label ? (
        <span
          className={
            getEarningsQualityBadgeMeta(
              item.metrics.earnings_quality_tag,
              item.metrics.earnings_quality_label,
            ).badgeClass
          }
        >
          {item.metrics.earnings_quality_label}
        </span>
      ) : (
        '—'
      ),
  },
  {
    key: 'invest_profit_share_3y_pct',
    label: '近3年投资收益占比',
    glossaryKey: 'invest_profit_share',
    comparable: {
      direction: 'lower',
      getValue: (item) =>
        getNonFinancialForensicNumber(item, (metrics) => metrics.invest_profit_share_3y_pct),
    },
    render: (item) =>
      renderExemptibleMetric(
        item,
        item.metrics?.invest_profit_share_3y_pct,
        (value) => {
          const isHigh =
            value !== null &&
            value !== undefined &&
            Number.isFinite(value) &&
            value >= 30 &&
            Math.abs(value) < FORENSIC_SENTINEL_ABS_LIMIT
          return (
            <span className={isHigh ? 'mono tone-bad' : 'mono'}>
              {formatForensicRatioPct(value)}
            </span>
          )
        },
        { forceExemptOnFinancial: true },
      ),
  },
  {
    key: 'investment_assets_ratio_pct',
    label: '表内投资类资产占比',
    glossaryKey: 'investment_assets_ratio',
    comparable: {
      direction: 'lower',
      getValue: (item) =>
        getNonFinancialForensicNumber(item, (metrics) => metrics.investment_assets_ratio_pct),
    },
    render: (item) =>
      renderExemptibleMetric(
        item,
        item.metrics?.investment_assets_ratio_pct,
        (value) => <span className="mono">{formatForensicRatioPct(value)}</span>,
        { forceExemptOnFinancial: true },
      ),
  },
  {
    key: 'ct_alerts',
    label: 'CT 排雷 (红 / 黄灯)',
    glossaryKey: 'ct_lights',
    comparable: {
      direction: 'lower',
      getValue: (item) => (item.metrics ? item.metrics.ct_red_count : null),
    },
    render: (item) => {
      if (!item.metrics) {
        return '—'
      }
      const { ct_red_count: redCount, ct_yellow_count: yellowCount } = item.metrics
      const color = redCount > 0 ? 'rose' : yellowCount > 0 ? 'amber' : 'green'
      return <Tag color={color}>{`${redCount} 红 / ${yellowCount} 黄`}</Tag>
    },
  },
]

export function computeRowBestCodes(
  row: CompareMetricRow,
  items: readonly StockCompareItem[],
): Set<string> {
  if (!row.comparable) {
    return new Set()
  }
  const { direction, getValue } = row.comparable
  const validEntries: Array<{ code: string; value: number }> = []

  for (const item of items) {
    const val = getValue(item)
    if (val !== null && Number.isFinite(val)) {
      validEntries.push({ code: item.code, value: val })
    }
  }

  if (validEntries.length < 2) {
    return new Set()
  }

  const values = validEntries.map((entry) => entry.value)
  const minVal = Math.min(...values)
  const maxVal = Math.max(...values)
  if (Math.abs(maxVal - minVal) <= 1e-9) {
    return new Set()
  }

  const targetVal = direction === 'higher' ? maxVal : minVal
  return new Set(
    validEntries
      .filter((entry) => Math.abs(entry.value - targetVal) <= 1e-9)
      .map((entry) => entry.code),
  )
}

type SyncedCompareItem = StockCompareItem & {
  metrics: NonNullable<StockCompareItem['metrics']>
}

export function buildCompareTakeaway(items: readonly StockCompareItem[]): string | null {
  const syncedItems = items.filter((item): item is SyncedCompareItem => Boolean(item.metrics))
  if (syncedItems.length === 0) {
    return null
  }

  const cautionTexts: string[] = []
  for (const item of syncedItems) {
    if (isFinancialCompareItem(item)) continue
    const share = item.metrics.invest_profit_share_3y_pct
    const hasHighShare =
      share !== null && share !== undefined && Number.isFinite(share) && share >= 50
    const isInvestDriven = item.metrics.earnings_quality_tag === 'investment_driven'
    if (!hasHighShare && !isInvestDriven) continue

    const name = formatStockName(item.meta.name)
    if (share !== null && share !== undefined && Number.isFinite(share)) {
      if (Math.abs(share) >= FORENSIC_SENTINEL_ABS_LIMIT) {
        cautionTexts.push(`${name}（主业微利、盈利高度依赖对外投资）`)
      } else {
        cautionTexts.push(`${name}（投资收益占比 ${formatForensicRatioPct(share)}）`)
      }
    } else {
      cautionTexts.push(`${name}（盈利高度依赖对外投资）`)
    }
  }

  if (syncedItems.length === 1) {
    const only = syncedItems[0]
    if (!only) return null
    const pePct = only.metrics.pe_percentile_10y
    const peClause =
      pePct !== null && pePct !== undefined && Number.isFinite(pePct)
        ? `，PE 处于近10年 ${pePct.toFixed(1)}% 分位`
        : ''
    const suffix =
      cautionTexts.length > 0
        ? `；需注意 ${cautionTexts.join('、')} 盈利较多依赖对外投资，别只看表面低PE。`
        : '；等待其余标的同步或继续添加标的即可展开横向对比。'
    return `对比结论：当前仅 ${formatStockName(only.meta.name)} 已同步（综合评分 ${only.metrics.total_score} 分${peClause}）${suffix}`
  }

  const maxScore = Math.max(...syncedItems.map((item) => item.metrics.total_score))
  const scoreLeaders = syncedItems
    .filter((item) => item.metrics.total_score === maxScore)
    .map((item) => formatStockName(item.meta.name))
    .join('、')

  const valCandidates = syncedItems.filter(
    (item) =>
      item.metrics.pe_percentile_10y !== null &&
      item.metrics.pe_percentile_10y !== undefined &&
      Number.isFinite(item.metrics.pe_percentile_10y),
  )
  let valuationClause = ''
  if (valCandidates.length > 0) {
    const minPePct = Math.min(
      ...valCandidates.map((item) => item.metrics.pe_percentile_10y ?? Number.POSITIVE_INFINITY),
    )
    const valLeaders = valCandidates
      .filter((item) => Math.abs((item.metrics.pe_percentile_10y ?? 0) - minPePct) <= 1e-9)
      .map((item) => formatStockName(item.meta.name))
      .join('、')
    valuationClause = `，${valLeaders} 估值安全垫最厚（PE 处于近10年 ${minPePct.toFixed(1)}% 分位）`
  }

  const cautionClause =
    cautionTexts.length > 0
      ? `；需注意 ${cautionTexts.join('、')} 盈利较多依赖对外投资，别只看表面低PE。`
      : '；已同步标的暂未发现非金融投资依赖警示。'

  return `对比结论：${scoreLeaders} 综合评分最高（${maxScore} 分）${valuationClause}${cautionClause}`
}
