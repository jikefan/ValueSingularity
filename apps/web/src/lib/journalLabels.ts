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
  { value: 'total_score', label: '雷达评分', multiPeriod: false },
]

const MULTI_PERIOD_METRICS = new Set([
  'roe',
  'roe_pct',
  '净资产收益率',
  'gross_margin',
  'gross_margin_pct',
  '毛利率',
  'net_margin',
  'net_margin_pct',
  '净利率',
  'net_profit',
  'net_profit_yuan',
  '净利润',
  '归母净利润',
  'deduct_net_profit',
  'deduct_net_profit_yuan',
  '扣非净利润',
  'revenue',
  'revenue_yuan',
  '营业收入',
  '营收',
  'ocf',
  'ocf_yuan',
  '经营现金流',
  'fcf',
  'fcf_yuan',
  '自由现金流',
  'net_cash',
  'net_cash_yuan',
  '净现金',
  'rd_ratio',
  'rd_ratio_pct',
  '研发费用率',
])

export function isMultiPeriodFalsifyMetric(metric: string): boolean {
  const trimmed = metric.trim().toLowerCase()
  const normalized = trimmed.replace(/[-\s]+/g, '_')
  return MULTI_PERIOD_METRICS.has(trimmed) || MULTI_PERIOD_METRICS.has(normalized)
}

const FALSIFY_METRIC_LABELS: Record<string, string> = {
  ct_red_count: 'CT红灯数',
  ct_red: 'CT红灯数',
  ct_yellow_count: 'CT黄灯数',
  pe_ttm: 'PE(TTM)',
  pe: 'PE(TTM)',
  pe_percentile_10y: '10年PE分位',
  pe_percentile: '10年PE分位',
  pb: 'PB',
  close: '股价',
  price: '股价',
  dividend_yield_pct: '股息率',
  dividend_yield: '股息率',
  implied_fcf_cagr_pct: '逆向DCF增速',
  implied_fcf_cagr: '逆向DCF增速',
  roe_5y_avg_pct: '5年ROE均值',
  roe_5y_avg: '5年ROE均值',
  roe_pct: 'ROE',
  roe: 'ROE',
  pledge_ratio_pct: '质押比例',
  pledge_ratio: '质押比例',
  gross_margin_pct: '毛利率',
  gross_margin_latest_pct: '毛利率',
  net_margin_pct: '净利率',
  net_profit_yuan: '归母净利润',
  net_profit: '归母净利润',
  revenue_yuan: '营业收入',
  revenue: '营业收入',
  fcf_yuan: '自由现金流',
  fcf: '自由现金流',
  ocf_yuan: '经营现金流',
  ocf: '经营现金流',
  ocf_to_profit_5y_pct: '5年净现比',
  net_cash_to_mv_pct: '净现金市值比',
  total_score: '雷达评分',
}

export function getFalsifyMetricLabel(metric: string): string {
  const trimmed = metric.trim()
  const normalized = trimmed.toLowerCase().replace(/[-\s]+/g, '_')
  return FALSIFY_METRIC_LABELS[trimmed] ?? FALSIFY_METRIC_LABELS[normalized] ?? trimmed
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
