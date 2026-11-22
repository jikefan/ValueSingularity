import type { FalsifyRule, JournalAction } from '../types/api'

export const JOURNAL_ACTION_META: Record<
  JournalAction,
  { label: string; color: 'green' | 'amber' | 'rose' }
> = {
  buy: { label: '买入', color: 'green' },
  add: { label: '加仓', color: 'green' },
  trim: { label: '减仓', color: 'rose' },
  sell: { label: '卖出', color: 'rose' },
  pass: { label: 'Pass 观察', color: 'amber' },
}

export const JOURNAL_EMOTION_PRESETS = ['冷静', '乐观', '贪婪', '焦虑', '犹豫'] as const

export type FalsifyOp = FalsifyRule['op']

export const FALSIFY_OP_OPTIONS: ReadonlyArray<{ value: FalsifyOp; label: string }> = [
  { value: 'lt', label: '<' },
  { value: 'lte', label: '≤' },
  { value: 'gt', label: '>' },
  { value: 'gte', label: '≥' },
  { value: 'eq', label: '=' },
]

export const FALSIFY_OP_LABEL: Record<FalsifyOp, string> = {
  lt: '<',
  lte: '≤',
  gt: '>',
  gte: '≥',
  eq: '=',
}

export type FalsifyMetricOption = {
  value: string
  label: string
  unit?: string
  multiPeriod: boolean
}

export const FALSIFY_METRIC_OPTIONS: ReadonlyArray<FalsifyMetricOption> = [
  { value: 'ct_red_count', label: 'CT红灯数', multiPeriod: false },
  { value: 'pe_ttm', label: 'PE(TTM)', multiPeriod: false },
  { value: 'pe_percentile_10y', label: '10年PE分位', unit: '%', multiPeriod: false },
  { value: 'pb', label: 'PB', multiPeriod: false },
  { value: 'pb_percentile_10y', label: '10年PB分位', unit: '%', multiPeriod: false },
  { value: 'close', label: '股价', unit: '元', multiPeriod: false },
  { value: 'dividend_yield_pct', label: '股息率', unit: '%', multiPeriod: false },
  { value: 'implied_fcf_cagr_pct', label: '逆向DCF增速', unit: '%', multiPeriod: false },
  { value: 'roe_5y_avg_pct', label: '5年ROE均值', unit: '%', multiPeriod: false },
  { value: 'roe_pct', label: 'ROE', unit: '%', multiPeriod: true },
  { value: 'pledge_ratio_pct', label: '质押比例', unit: '%', multiPeriod: false },
  { value: 'gross_margin_pct', label: '毛利率', unit: '%', multiPeriod: true },
  { value: 'net_margin_pct', label: '净利率', unit: '%', multiPeriod: true },
  { value: 'net_profit_yuan', label: '归母净利润', unit: '元', multiPeriod: true },
  { value: 'revenue_yuan', label: '营业收入', unit: '元', multiPeriod: true },
  { value: 'fcf_yuan', label: '自由现金流', unit: '元', multiPeriod: true },
  { value: 'ocf_yuan', label: '经营现金流', unit: '元', multiPeriod: true },
  { value: 'ocf_to_profit_5y_pct', label: '5年净现比', unit: '%', multiPeriod: false },
  { value: 'fcf_coverage_ratio', label: 'FCF覆盖倍数', unit: 'x', multiPeriod: false },
  { value: 'total_score', label: '雷达评分', multiPeriod: false },
]

const CANONICAL_METRIC_ALIASES: Readonly<Record<string, ReadonlyArray<string>>> = {
  roe_pct: ['roe', 'roe_pct', '净资产收益率'],
  gross_margin_pct: ['gross_margin', 'gross_margin_pct', '毛利率'],
  net_margin_pct: ['net_margin', 'net_margin_pct', '净利率'],
  net_profit_yuan: ['net_profit', 'net_profit_yuan', '净利润', '归母净利润'],
  deduct_net_profit_yuan: ['deduct_net_profit', 'deduct_net_profit_yuan', '扣非净利润'],
  revenue_yuan: ['revenue', 'revenue_yuan', '营业收入', '营收'],
  ocf_yuan: ['ocf', 'ocf_yuan', '经营现金流'],
  fcf_yuan: ['fcf', 'fcf_yuan', '自由现金流'],
  net_cash_yuan: ['net_cash', 'net_cash_yuan', '净现金'],
  rd_ratio_pct: ['rd_ratio', 'rd_ratio_pct', '研发费用率'],
  ct_red_count: [
    'ct_red_count',
    'ct_red',
    'red_count',
    'financial_ct.red_count',
    '排雷红灯',
    '红灯数',
    'ct红灯',
  ],
  ct_yellow_count: [
    'ct_yellow_count',
    'ct_yellow',
    'yellow_count',
    'financial_ct.yellow_count',
    '排雷黄灯',
    '黄灯数',
    'ct黄灯',
  ],
  pe_ttm: ['pe_ttm', 'pe', 'valuation.pe_ttm', '市盈率', '动态市盈率'],
  pe_percentile_10y: [
    'pe_percentile_10y',
    'pe_percentile',
    'valuation.pe_percentile_10y',
    'pe分位',
    '市盈率分位',
  ],
  pe_percentile_5y: ['pe_percentile_5y'],
  pb: ['pb', 'valuation.pb', '市净率'],
  pb_percentile_10y: ['pb_percentile_10y', 'pb_percentile', '市净率分位'],
  close: ['close', 'price', 'valuation.close', '收盘价', '现价', '股价'],
  dividend_yield_pct: [
    'dividend_yield_pct',
    'dividend_yield',
    'valuation.dividend_yield_pct',
    '股息率',
  ],
  implied_fcf_cagr_pct: [
    'implied_fcf_cagr_pct',
    'implied_fcf_cagr',
    'reverse_dcf.implied_fcf_cagr_pct',
    '隐含增速',
    '隐含fcf增速',
  ],
  roe_5y_avg_pct: [
    'roe_5y_avg_pct',
    'roe_5y_avg',
    'moat.roe_5y_avg_pct',
    'roe5年均值',
    '5年平均roe',
  ],
  gross_margin_latest_pct: ['gross_margin_latest_pct', 'moat.gross_margin_latest_pct'],
  net_cash_to_mv_pct: [
    'net_cash_to_mv_pct',
    'net_cash_to_mv',
    'peer_metrics.net_cash_to_mv_pct',
    '净现金市值比',
  ],
  ocf_to_profit_5y_pct: [
    'ocf_to_profit_5y_pct',
    'ocf_to_profit',
    'peer_metrics.ocf_to_profit_5y_pct',
    '净现比',
    '现金流利润比',
  ],
  pledge_ratio_pct: ['pledge_ratio_pct', 'pledge_ratio', '质押率', '股权质押率'],
  total_score: ['total_score', 'score', 'radar.total_score', '综合评分', '雷达评分'],
  shareholder_yield_pct: ['shareholder_yield_pct', 'shareholder_yield', '股东回报率'],
  fcf_coverage_ratio: ['fcf_coverage_ratio', '自由现金流覆盖倍数'],
  revenue_cagr_3y_pct: ['revenue_cagr_3y_pct'],
  revenue_cagr_5y_pct: ['revenue_cagr_5y_pct'],
  profit_cagr_5y_pct: ['profit_cagr_5y_pct'],
}

const CANONICAL_METRIC_MAP: Record<string, string> = Object.fromEntries(
  Object.entries(CANONICAL_METRIC_ALIASES).flatMap(([canonical, aliases]) =>
    aliases.map((alias) => [alias, canonical]),
  ),
)

export function canonicalizeFalsifyMetric(metric: string): string {
  const trimmed = metric.trim()
  if (!trimmed) {
    return ''
  }
  const lower = trimmed.toLowerCase()
  const normalized = lower.replace(/[-\s]+/g, '_')
  return CANONICAL_METRIC_MAP[lower] ?? CANONICAL_METRIC_MAP[normalized] ?? trimmed
}

const MULTI_PERIOD_METRICS = new Set([
  'roe_pct',
  'gross_margin_pct',
  'net_margin_pct',
  'net_profit_yuan',
  'deduct_net_profit_yuan',
  'revenue_yuan',
  'ocf_yuan',
  'fcf_yuan',
  'net_cash_yuan',
  'rd_ratio_pct',
])

export function isMultiPeriodFalsifyMetric(metric: string): boolean {
  const canonical = canonicalizeFalsifyMetric(metric)
  const normalized = canonical.toLowerCase().replace(/[-\s]+/g, '_')
  return MULTI_PERIOD_METRICS.has(canonical) || MULTI_PERIOD_METRICS.has(normalized)
}

const FALSIFY_METRIC_LABELS: Record<string, string> = {
  ct_red_count: 'CT红灯数',
  ct_yellow_count: 'CT黄灯数',
  pe_ttm: 'PE(TTM)',
  pe_percentile_10y: '10年PE分位',
  pe_percentile_5y: '5年PE分位',
  pb: 'PB',
  pb_percentile_10y: '10年PB分位',
  close: '股价',
  dividend_yield_pct: '股息率',
  implied_fcf_cagr_pct: '逆向DCF增速',
  roe_5y_avg_pct: '5年ROE均值',
  roe_pct: 'ROE',
  pledge_ratio_pct: '质押比例',
  gross_margin_pct: '毛利率',
  gross_margin_latest_pct: '毛利率',
  net_margin_pct: '净利率',
  net_profit_yuan: '归母净利润',
  deduct_net_profit_yuan: '扣非净利润',
  revenue_yuan: '营业收入',
  fcf_yuan: '自由现金流',
  ocf_yuan: '经营现金流',
  net_cash_yuan: '净现金',
  rd_ratio_pct: '研发费用率',
  ocf_to_profit_5y_pct: '5年净现比',
  fcf_coverage_ratio: 'FCF覆盖倍数',
  net_cash_to_mv_pct: '净现金市值比',
  shareholder_yield_pct: '股东回报率',
  revenue_cagr_3y_pct: '3年营收复合增速',
  revenue_cagr_5y_pct: '5年营收复合增速',
  profit_cagr_5y_pct: '5年利润复合增速',
  total_score: '雷达评分',
}

export function getFalsifyMetricLabel(metric: string): string {
  const canonical = canonicalizeFalsifyMetric(metric)
  if (!canonical) {
    return ''
  }
  const normalized = canonical.toLowerCase().replace(/[-\s]+/g, '_')
  return FALSIFY_METRIC_LABELS[canonical] ?? FALSIFY_METRIC_LABELS[normalized] ?? canonical
}

const FALSIFY_METRIC_UNITS: Readonly<Record<string, string>> = {
  ...Object.fromEntries(
    FALSIFY_METRIC_OPTIONS.flatMap((opt) => (opt.unit ? [[opt.value, opt.unit]] : [])),
  ),
  pe_percentile_5y: '%',
  gross_margin_latest_pct: '%',
  deduct_net_profit_yuan: '元',
  net_cash_yuan: '元',
  rd_ratio_pct: '%',
  net_cash_to_mv_pct: '%',
  shareholder_yield_pct: '%',
  revenue_cagr_3y_pct: '%',
  revenue_cagr_5y_pct: '%',
  profit_cagr_5y_pct: '%',
}

export function getFalsifyMetricUnit(metric: string): string {
  const canonical = canonicalizeFalsifyMetric(metric)
  if (!canonical) {
    return ''
  }
  const normalized = canonical.toLowerCase().replace(/[-\s]+/g, '_')
  const explicit = FALSIFY_METRIC_UNITS[canonical] ?? FALSIFY_METRIC_UNITS[normalized]
  if (explicit !== undefined) {
    return explicit
  }
  if (normalized.endsWith('_pct')) {
    return '%'
  }
  if (normalized.endsWith('_yuan')) {
    return '元'
  }
  return ''
}

export const FALSIFY_RULE_PRESETS: ReadonlyArray<{
  label: string
  rule: FalsifyRule
}> = [
  {
    label: 'CT红灯≥1',
    rule: { metric: 'ct_red_count', op: 'gte', value: 1, periods: 1 },
  },
  {
    label: 'PE分位≥85%',
    rule: { metric: 'pe_percentile_10y', op: 'gte', value: 85, periods: 1 },
  },
  {
    label: 'ROE<12%',
    rule: { metric: 'roe_pct', op: 'lt', value: 12, periods: 1 },
  },
]
