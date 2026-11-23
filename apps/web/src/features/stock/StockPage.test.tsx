import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ScoreRing } from '../../components/ui/ScoreRing'
import { AuthProvider } from '../../lib/AuthProvider'
import { setAccessToken } from '../../lib/api'
import type { ChartOption } from '../../lib/charts'
import { createQueryClient } from '../../lib/queryClient'
import type {
  AiPreferences,
  DevilsAdvocateRequest,
  DevilsAdvocateResponse,
  FalsifyRule,
  JournalCreate,
  JournalEntryItem,
  MdaDiffRequest,
  MdaDiffResponse,
  StockDetail,
  StockSnapshotPayload,
  TokenResponse,
  UserProfile,
  WatchlistItem,
  WatchlistUpsert,
} from '../../types/api'
import { StockPage } from './StockPage'

const capturedChartOptions = new Map<string, ChartOption>()

vi.mock('../../lib/charts', () => ({
  Chart: ({ ariaLabel, option }: { ariaLabel?: string; option: ChartOption }) => {
    if (ariaLabel) {
      capturedChartOptions.set(ariaLabel, option)
    }
    return <div role="img" aria-label={ariaLabel} />
  },
}))

const SAMPLE_USER: UserProfile = {
  id: '33333333-3333-3333-3333-333333333333',
  email: 'stock@example.com',
  phone: null,
  display_name: '护城河研究员',
  email_verified: true,
  plan_tier: 'pro',
  plan_expires_at: null,
  created_at: '2026-11-22T00:00:00Z',
}

const SAMPLE_STOCK: StockDetail = {
  code: '600519',
  name: '贵州茅台',
  exchange: 'SH',
  industry_sw1: '食品饮料',
  industry_sw2: '白酒Ⅱ',
  list_date: '2001-08-27',
  is_st: false,
  is_active: true,
  snapshot_available: true,
}

const SAMPLE_SNAPSHOT: StockSnapshotPayload = {
  schema_version: 1,
  code: '600519',
  name: '贵州茅台',
  exchange: 'SH',
  industry_sw1: '食品饮料',
  industry_sw2: '白酒Ⅱ',
  as_of: '2026-11-20',
  generated_at: '2026-11-20T10:00:00Z',
  data_source: 'akshare',
  annual_trends: [
    {
      year: 2024,
      revenue_yuan: 1.5e11,
      net_profit_yuan: 7.5e10,
      deduct_net_profit_yuan: 7.45e10,
      ocf_yuan: 8.1e10,
      fcf_yuan: 7.8e10,
      roe_pct: 31.2,
      gross_margin_pct: 91.8,
      net_margin_pct: 50.0,
      net_cash_yuan: 1.6e11,
      rd_ratio_pct: 0.42,
    },
    {
      year: 2025,
      revenue_yuan: 1.74e11,
      net_profit_yuan: 8.6e10,
      deduct_net_profit_yuan: 8.55e10,
      ocf_yuan: 9.2e10,
      fcf_yuan: 8.9e10,
      roe_pct: 32.5,
      gross_margin_pct: 92.1,
      net_margin_pct: 49.4,
      net_cash_yuan: 1.85e11,
      rd_ratio_pct: 0.45,
    },
  ],
  valuation: {
    latest_trade_date: '2026-11-20',
    close: 1520.0,
    total_mv_yuan: 1.91e12,
    pe_ttm: 22.1,
    pe_percentile_5y: 18.4,
    pe_percentile_10y: 26.5,
    pb: 7.8,
    pb_percentile_10y: 24.0,
    dividend_yield_pct: 3.45,
    graham_number: 1380.5,
    graham_margin_pct: -10.11,
    peg: 1.38,
    history: [
      { trade_date: '2025-11-20', close: 1480.0, pe_ttm: 21.8, pb: 7.5, total_mv_yuan: 1.86e12 },
      { trade_date: '2026-11-20', close: 1520.0, pe_ttm: 22.1, pb: 7.8, total_mv_yuan: 1.91e12 },
    ],
  },
  reverse_dcf: {
    solvable: true,
    note: '当前市值隐含未来 10 年 FCF 年化增速约 8.42%，低于近 5 年营收复合增速。',
    market_cap_yuan: 1.91e12,
    enterprise_value_yuan: 1.725e12,
    net_cash_yuan: 1.85e11,
    base_fcf_yuan: 8.35e10,
    base_fcf_years: 3,
    discount_rate_pct: 9.0,
    terminal_multiple: 12.0,
    implied_fcf_cagr_pct: 8.42,
    historical_revenue_cagr_pct: 14.8,
    implied_vs_history_gap_pct: -6.38,
    sensitivity: [
      { discount_rate_pct: 8.0, terminal_multiple: 10.0, implied_fcf_cagr_pct: 8.15 },
      { discount_rate_pct: 8.0, terminal_multiple: 12.0, implied_fcf_cagr_pct: 7.1 },
      { discount_rate_pct: 8.0, terminal_multiple: 15.0, implied_fcf_cagr_pct: 5.8 },
      { discount_rate_pct: 9.0, terminal_multiple: 10.0, implied_fcf_cagr_pct: 9.55 },
      { discount_rate_pct: 9.0, terminal_multiple: 12.0, implied_fcf_cagr_pct: 8.42 },
      { discount_rate_pct: 9.0, terminal_multiple: 15.0, implied_fcf_cagr_pct: 7.02 },
      { discount_rate_pct: 10.0, terminal_multiple: 10.0, implied_fcf_cagr_pct: 11.1 },
      { discount_rate_pct: 10.0, terminal_multiple: 12.0, implied_fcf_cagr_pct: 9.88 },
      { discount_rate_pct: 10.0, terminal_multiple: 15.0, implied_fcf_cagr_pct: 8.4 },
    ],
  },
  financial_ct: {
    overall_status: 'yellow',
    red_count: 0,
    yellow_count: 1,
    green_count: 6,
    checks: [
      {
        rule_id: 'dual_high_cash_debt',
        title: '存贷双高扫描',
        status: 'green',
        summary: '货币资金充沛且有息负债极低。',
        threshold: '货币资金/总资产 >= 25% 且 有息负债/总资产 >= 25%',
        value_text: '现金占比 58.2% / 负债占比 0.4%',
        evidences: [
          {
            year: 2025,
            label: '2025 年报存贷对照',
            metrics: {
              monetary_funds_yuan: 1.86e11,
              interest_debt_yuan: 1.2e9,
              cash_to_assets_pct: 58.2,
              debt_to_assets_pct: 0.4,
            },
          },
        ],
      },
      {
        rule_id: 'stalled_cip',
        title: '在建工程不转固',
        status: 'green',
        summary: '在建工程占比可控，无异常长期挂账。',
        threshold: '连续3年在建工程/总资产 >= 10%',
        value_text: '在建占比 2.1%',
        evidences: [],
      },
      {
        rule_id: 'ocf_profit_divergence',
        title: '现金流与利润背离',
        status: 'green',
        summary: '经营现金流连续高于归母净利润。',
        threshold: '近3年平均净现比 < 0.8',
        value_text: '净现比 1.07x',
        evidences: [],
      },
      {
        rule_id: 'receivable_inventory_bloat',
        title: '应收与存货膨胀',
        status: 'yellow',
        summary: '基酒存货随扩产温和上升，需关注渠道动销。',
        threshold: '两金增速连续显著高于营收增速',
        value_text: '增速差 +4.2%',
        evidences: [
          {
            year: 2025,
            label: '2025 两金占款变化',
            metrics: {
              receivable_yuan: 1.1e9,
              inventory_yuan: 5.2e10,
              tied_to_revenue_pct: 30.5,
              growth_gap_pct: 4.2,
            },
          },
        ],
      },
      {
        rule_id: 'goodwill_overhang',
        title: '商誉减值悬顶',
        status: 'green',
        summary: '账面无商誉包袱。',
        threshold: '商誉/归母净资产 >= 20%',
        value_text: '0.00%',
        evidences: [],
      },
      {
        rule_id: 'equity_pledge',
        title: '大股东股权质押',
        status: 'green',
        summary: '全市场质押比例为 0.00%。',
        threshold: '质押比例 >= 15% 黄灯 / >= 30% 红灯',
        value_text: '0.00%',
        evidences: [],
      },
      {
        rule_id: 'audit_opinion',
        title: '审计意见扫描',
        status: 'green',
        summary: '历年均获标准无保留审计意见。',
        threshold: '出现非标审计意见直接红灯',
        value_text: '标准无保留意见',
        evidences: [
          {
            year: 2025,
            label: '2025 年报审计意见',
            metrics: { audit_opinion: '标准无保留意见' },
          },
        ],
      },
    ],
  },
  shareholder_return: {
    window_years: 5,
    total_dividend_yuan: 2.6e11,
    total_repurchase_yuan: 6e9,
    total_equity_financing_yuan: 0,
    net_return_yuan: 2.66e11,
    total_fcf_yuan: 3.5e11,
    fcf_coverage_ratio: 1.32,
    current_dividend_yield_pct: 3.45,
    status: 'green',
    verdict: '近 5 年累计净回馈 2,660 亿元，自由现金流覆盖倍数 1.32x，回馈质量极高。',
    series: [
      {
        year: 2024,
        dividend_yuan: 5.8e10,
        repurchase_yuan: 0,
        equity_financing_yuan: 0,
        net_return_yuan: 5.8e10,
        fcf_yuan: 7.8e10,
      },
      {
        year: 2025,
        dividend_yuan: 6.4e10,
        repurchase_yuan: 6e9,
        equity_financing_yuan: 0,
        net_return_yuan: 7.0e10,
        fcf_yuan: 8.9e10,
      },
    ],
  },
  moat: {
    roe_5y_avg_pct: 31.8,
    roe_10y_min_pct: 25.4,
    gross_margin_latest_pct: 92.1,
    gross_margin_5y_std_pct: 0.35,
    roic_approx_pct: 34.6,
    dimensions: [
      {
        key: 'pricing_power',
        label: '定价权与毛利率护城河',
        score: 96,
        summary: '毛利率长期稳定在 91% 以上且波动率极低。',
      },
      {
        key: 'capital_efficiency',
        label: '超额资本回报持续性',
        score: 92,
        summary: '十年最低 ROE 仍高于 25%，ROIC 显著高于资本成本。',
      },
    ],
  },
  growth: {
    revenue_cagr_3y_pct: 15.2,
    revenue_cagr_5y_pct: 14.8,
    profit_cagr_5y_pct: 16.1,
    deduct_profit_cagr_5y_pct: 15.9,
    rd_ratio_latest_pct: 0.45,
    capex_to_ocf_latest_pct: 3.26,
  },
  radar: {
    profitability: 95,
    moat: 94,
    balance_sheet: 92,
    cashflow_quality: 90,
    valuation_margin: 74,
    total_score: 89,
    bear_cases: ['高端白酒商务消费景气度受宏观周期影响。'],
  },
  peer_metrics: {
    code: '600519',
    name: '贵州茅台',
    exchange: 'SH',
    industry_sw1: '食品饮料',
    as_of: '2026-11-20',
    close: 1520.0,
    total_mv_yuan: 1.91e12,
    pe_ttm: 22.1,
    pe_percentile_10y: 26.5,
    pb: 7.8,
    roe_5y_avg_pct: 31.8,
    gross_margin_latest_pct: 92.1,
    net_cash_to_mv_pct: 9.69,
    ocf_to_profit_5y_pct: 107.2,
    shareholder_yield_pct: 3.66,
    implied_fcf_cagr_pct: 8.42,
    ct_red_count: 0,
    ct_yellow_count: 1,
    total_score: 89,
  },
  pledge_ratio_pct: 0.0,
  pledge_date: '2026-11-20',
  latest_audit_opinion: '标准无保留意见',
  formula_notes: {
    radar: '五维雷达按确定性定量规则映射至 0–100 分。',
    reverse_dcf: '逆向 DCF 仅反推隐含未来十年 FCF 年化增速，不输出主观目标价。',
    shareholder_return: '股东净回报 = 累计现金分红 + 累计回购 - 累计股权再融资。',
    ct_scanner: '财务排雷 CT 共扫描 7 项本土风险，支持下钻历年科目。',
  },
}

const SAMPLE_TOKEN: TokenResponse = {
  access_token: 'stock-token',
  token_type: 'bearer',
  expires_in: 900,
  user: SAMPLE_USER,
}

const SAMPLE_AI_PREFS: AiPreferences = {
  prefer_rule_only: false,
  byok_enabled: false,
  byok_base_url_masked: null,
  byok_api_key_configured: false,
  byok_api_key_masked: null,
  byok_model: 'gpt-4o-mini',
  quota: {
    plan_tier: 'pro',
    daily_limit: 5,
    used_today: 1,
    remaining_today: 4,
    byok_active: false,
    resets_at_shanghai: '2026-11-23 24:00 CST',
  },
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function asRequest(input: RequestInfo | URL): Request {
  if (input instanceof Request) {
    return input
  }
  throw new Error('Expected Request instance')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isJournalAction(value: unknown): value is JournalCreate['action'] {
  return (
    value === 'buy' || value === 'add' || value === 'trim' || value === 'sell' || value === 'pass'
  )
}

function isFalsifyOp(value: unknown): value is FalsifyRule['op'] {
  return value === 'lt' || value === 'lte' || value === 'gt' || value === 'gte' || value === 'eq'
}

function parseFalsifyRules(raw: unknown): FalsifyRule[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined
  }
  const rules: FalsifyRule[] = []
  for (const item of raw) {
    if (
      isRecord(item) &&
      typeof item.metric === 'string' &&
      isFalsifyOp(item.op) &&
      typeof item.value === 'number' &&
      typeof item.periods === 'number'
    ) {
      rules.push({
        metric: item.metric,
        op: item.op,
        value: item.value,
        periods: item.periods,
      })
    }
  }
  return rules
}

function parseJournalCreate(raw: string): JournalCreate {
  const parsed: unknown = JSON.parse(raw)
  if (
    !isRecord(parsed) ||
    typeof parsed.code !== 'string' ||
    !isJournalAction(parsed.action) ||
    typeof parsed.reason !== 'string' ||
    typeof parsed.falsify_condition !== 'string' ||
    typeof parsed.benchmark_code !== 'string'
  ) {
    throw new Error('Invalid JournalCreate payload')
  }
  const falsifyRules = parseFalsifyRules(parsed.falsify_rules)
  return {
    code: parsed.code,
    name: typeof parsed.name === 'string' ? parsed.name : null,
    action: parsed.action,
    reason: parsed.reason,
    falsify_condition: parsed.falsify_condition,
    price: typeof parsed.price === 'number' ? parsed.price : null,
    max_drawdown: typeof parsed.max_drawdown === 'number' ? parsed.max_drawdown : null,
    emotion: typeof parsed.emotion === 'string' ? parsed.emotion : null,
    benchmark_code: parsed.benchmark_code,
    ...(falsifyRules ? { falsify_rules: falsifyRules } : {}),
  }
}

function parseWatchlistUpsert(raw: string): WatchlistUpsert {
  const parsed: unknown = JSON.parse(raw)
  if (!isRecord(parsed) || typeof parsed.code !== 'string' || typeof parsed.name !== 'string') {
    throw new Error('Invalid WatchlistUpsert payload')
  }
  return {
    code: parsed.code,
    name: parsed.name,
    industry: typeof parsed.industry === 'string' ? parsed.industry : null,
    alert_enabled: Boolean(parsed.alert_enabled),
  }
}

function parseDevilsAdvocateRequest(raw: string): DevilsAdvocateRequest {
  const parsed: unknown = JSON.parse(raw)
  if (
    !isRecord(parsed) ||
    typeof parsed.code !== 'string' ||
    !isJournalAction(parsed.action) ||
    typeof parsed.reason !== 'string' ||
    typeof parsed.falsify_condition !== 'string' ||
    (parsed.mode !== 'auto' && parsed.mode !== 'rule_only')
  ) {
    throw new Error('Invalid DevilsAdvocateRequest payload')
  }
  return {
    code: parsed.code,
    action: parsed.action,
    reason: parsed.reason,
    falsify_condition: parsed.falsify_condition,
    mode: parsed.mode,
  }
}

function parseMdaDiffRequest(raw: string): MdaDiffRequest {
  const parsed: unknown = JSON.parse(raw)
  if (
    !isRecord(parsed) ||
    typeof parsed.code !== 'string' ||
    typeof parsed.previous_period_label !== 'string' ||
    typeof parsed.current_period_label !== 'string' ||
    typeof parsed.previous_text !== 'string' ||
    typeof parsed.current_text !== 'string' ||
    (parsed.mode !== 'auto' && parsed.mode !== 'rule_only')
  ) {
    throw new Error('Invalid MdaDiffRequest payload')
  }
  return {
    code: parsed.code,
    previous_period_label: parsed.previous_period_label,
    current_period_label: parsed.current_period_label,
    previous_text: parsed.previous_text,
    current_text: parsed.current_text,
    mode: parsed.mode,
  }
}

function renderStockPage(initialEntry = '/stock/600519') {
  const client = createQueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  })

  return render(
    <QueryClientProvider client={client}>
      <AuthProvider>
        <MemoryRouter initialEntries={[initialEntry]}>
          <Routes>
            <Route path="/stock/:code" element={<StockPage />} />
            <Route path="/compare" element={<div>同业对比页面</div>} />
            <Route path="/login" element={<div>登录页面</div>} />
            <Route path="/me" element={<div>我的自选页</div>} />
            <Route path="/" element={<div>市场主页</div>} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  )
}

describe('StockPage', () => {
  afterEach(() => {
    cleanup()
    capturedChartOptions.clear()
    setAccessToken(null)
    vi.restoreAllMocks()
  })

  it('lights up all 9 tabs from StockSnapshotPayload including Reverse DCF matrix and CT drill-down', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const request = asRequest(input)
      const pathname = new URL(request.url).pathname

      if (pathname === '/api/auth/refresh') {
        return Promise.resolve(jsonResponse({ detail: '未登录' }, 401))
      }
      if (pathname === '/api/stocks/600519') {
        return Promise.resolve(jsonResponse(SAMPLE_STOCK, 200))
      }
      if (pathname === '/api/stocks/600519/snapshot') {
        return Promise.resolve(jsonResponse(SAMPLE_SNAPSHOT, 200))
      }
      return Promise.resolve(jsonResponse({ detail: `Unhandled ${pathname}` }, 500))
    })

    renderStockPage('/stock/600519')

    expect(await screen.findByRole('heading', { name: '贵州茅台' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '同业对比' })).toHaveAttribute(
      'href',
      '/compare?codes=600519',
    )
    expect(screen.getByRole('link', { name: '登录后加入自选' })).toHaveAttribute(
      'href',
      '/login?redirect=%2Fstock%2F600519',
    )

    const tabs = screen.getAllByRole('tab')
    expect(tabs).toHaveLength(9)

    expect(await screen.findByRole('img', { name: '五维评分雷达图' })).toBeInTheDocument()
    expect(screen.getByText('综合评分 89 / 100')).toBeInTheDocument()
    expect(screen.getByText('高端白酒商务消费景气度受宏观周期影响。')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: '财务分析' }))
    expect(await screen.findByRole('img', { name: '十年财务趋势图' })).toBeInTheDocument()
    expect(screen.getByText('1,740.00')).toBeInTheDocument()
    expect(screen.getByText('32.50%')).toBeInTheDocument()
    expect(capturedChartOptions.get('十年财务趋势图')).toMatchObject({
      grid: { top: 56 },
      legend: { top: 0, type: 'scroll' },
      yAxis: [{ nameGap: 14 }, { nameGap: 14 }],
    })

    fireEvent.click(screen.getByRole('tab', { name: '护城河' }))
    expect(await screen.findByText('定价权与毛利率护城河')).toBeInTheDocument()
    expect(screen.getByText('34.60%')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: '估值' }))
    expect(await screen.findByRole('img', { name: '历史估值走势图' })).toBeInTheDocument()
    expect(capturedChartOptions.get('历史估值走势图')).toMatchObject({
      grid: { top: 56 },
      legend: { top: 0, type: 'scroll' },
      yAxis: [{ nameGap: 14 }, { nameGap: 14 }],
    })
    expect(
      screen.getByText(/小白提示：格雷厄姆公式偏重静态净资产，对茅台等高 ROE/),
    ).toBeInTheDocument()
    expect(screen.getByText('Reverse DCF 逆向估值反推器')).toBeInTheDocument()
    expect(screen.getAllByText('+8.42%')).toHaveLength(2)
    expect(screen.getByText('+14.80%')).toBeInTheDocument()
    expect(screen.getByText('-6.38%')).toBeInTheDocument()
    expect(screen.getByText('+11.10%').closest('td')).toBeInTheDocument()
    expect(screen.getByText(/不输出主观目标价/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: '增长引擎' }))
    expect(await screen.findByRole('img', { name: '盈利能力与研发投入趋势图' })).toBeInTheDocument()
    expect(capturedChartOptions.get('盈利能力与研发投入趋势图')).toMatchObject({
      grid: { top: 56 },
      legend: { top: 0, type: 'scroll' },
      yAxis: { nameGap: 14 },
    })
    expect(screen.getByText('15.20%')).toBeInTheDocument()
    expect(screen.getByText('3.26%')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: '机构视角' }))
    expect(await screen.findByText('标准无保留意见')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '对比同行标的（打开矩阵）' })).toHaveAttribute(
      'href',
      '/compare?codes=600519',
    )

    fireEvent.click(screen.getByRole('tab', { name: '治理' }))
    expect(await screen.findByRole('img', { name: '股东净回报柱状图' })).toBeInTheDocument()
    expect(capturedChartOptions.get('股东净回报柱状图')).toMatchObject({
      grid: { top: 56 },
      legend: { top: 0, type: 'scroll' },
      yAxis: { nameGap: 14 },
    })
    expect(
      screen.queryByText('含本年度截至目前公告的分红/回购进度，年度尚未收官'),
    ).not.toBeInTheDocument()
    expect(screen.getByText('现金回馈充裕')).toBeInTheDocument()
    expect(screen.getByText('1.32x')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: '风险排雷' }))
    expect(await screen.findByText('存贷双高扫描')).toBeInTheDocument()
    expect(screen.getByText('应收与存货膨胀')).toBeInTheDocument()
    expect(screen.getByText('登录后对比连续两期年报管理层讨论与财务口径变化')).toBeInTheDocument()
    const expandButtons = screen.getAllByRole('button', { name: /展开历年证据/ })
    expect(expandButtons).toHaveLength(3)
    const firstExpandBtn = expandButtons[0]
    expect(firstExpandBtn).toBeDefined()
    if (firstExpandBtn) {
      fireEvent.click(firstExpandBtn)
    }
    expect(await screen.findByText('2025 年报存贷对照')).toBeInTheDocument()
    expect(screen.getByText('1,860.00 亿元')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: '投资决策' }))
    expect(await screen.findByText('最新价 1,520.00')).toBeInTheDocument()
    expect(screen.getByText('隐含 FCF 增速 +8.42%')).toBeInTheDocument()
  })

  it('renders Reverse DCF unsolvable fallback note clearly', async () => {
    const unsolvableSnapshot: StockSnapshotPayload = {
      ...SAMPLE_SNAPSHOT,
      reverse_dcf: {
        ...SAMPLE_SNAPSHOT.reverse_dcf,
        solvable: false,
        implied_fcf_cagr_pct: null,
        implied_vs_history_gap_pct: null,
        base_fcf_yuan: -1.5e9,
        note: '近 3 年平均自由现金流为负，无法反推隐含增速。',
      },
    }

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const pathname = new URL(asRequest(input).url).pathname
      if (pathname === '/api/auth/refresh') {
        return Promise.resolve(jsonResponse({ detail: '未登录' }, 401))
      }
      if (pathname === '/api/stocks/600519') {
        return Promise.resolve(jsonResponse(SAMPLE_STOCK, 200))
      }
      if (pathname === '/api/stocks/600519/snapshot') {
        return Promise.resolve(jsonResponse(unsolvableSnapshot, 200))
      }
      return Promise.resolve(jsonResponse({ detail: `Unhandled ${pathname}` }, 500))
    })

    renderStockPage('/stock/600519')
    fireEvent.click(await screen.findByRole('tab', { name: '估值' }))

    expect(await screen.findByText('不可求解回退说明：')).toBeInTheDocument()
    expect(screen.getByText('近 3 年平均自由现金流为负，无法反推隐含增速。')).toBeInTheDocument()
  })

  it('falls back cleanly on snapshot_available=false and 404 snapshot while keeping Decision tab usable', async () => {
    const unsyncedDetail: StockDetail = {
      ...SAMPLE_STOCK,
      code: '000999',
      name: '*ST样本',
      exchange: 'SZ',
      is_st: true,
      is_active: false,
      snapshot_available: false,
    }
    let snapshot404Count = 0

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const pathname = new URL(asRequest(input).url).pathname
      if (pathname === '/api/auth/refresh') {
        return Promise.resolve(jsonResponse({ detail: '未登录' }, 401))
      }
      if (pathname === '/api/stocks/000999') {
        return Promise.resolve(jsonResponse(unsyncedDetail, 200))
      }
      if (pathname === '/api/stocks/600519') {
        return Promise.resolve(jsonResponse(SAMPLE_STOCK, 200))
      }
      if (pathname === '/api/stocks/600519/snapshot') {
        snapshot404Count += 1
        return Promise.resolve(jsonResponse({ detail: '尚未生成快照' }, 404))
      }
      return Promise.resolve(jsonResponse({ detail: `Unhandled ${pathname}` }, 500))
    })

    const unsyncedView = renderStockPage('/stock/000999')
    expect(await screen.findByRole('heading', { name: '*ST样本' })).toBeInTheDocument()
    expect(screen.getByText('基础元数据')).toBeInTheDocument()
    expect(screen.getByText('公司画像尚无深度分析快照')).toBeInTheDocument()
    expect(
      screen.getByText(/该标的暂未生成深度财报与历史估值快照，暂不展示图表与排雷数据/),
    ).toBeInTheDocument()
    expect(screen.getByText('管理员离线同步命令')).toBeInTheDocument()
    expect(screen.getByText('python -m app.cli.sync_stocks --codes 000999')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '前往投资决策' }))
    expect(await screen.findByText('登录后记录你的投资决策与否证红线')).toBeInTheDocument()
    unsyncedView.unmount()

    renderStockPage('/stock/600519')
    expect(await screen.findByText('公司画像尚无深度分析快照')).toBeInTheDocument()
    expect(screen.getByText('python -m app.cli.sync_stocks --codes 600519')).toBeInTheDocument()
    expect(snapshot404Count).toBe(1)

    fireEvent.click(screen.getByRole('tab', { name: '投资决策' }))
    expect(await screen.findByText('登录后记录你的投资决策与否证红线')).toBeInTheDocument()
  })

  it('shows invalid code state and 404 sync guidance plus 503 retry recovery', async () => {
    let stockAttempts = 0

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const request = asRequest(input)
      const pathname = new URL(request.url).pathname

      if (pathname === '/api/auth/refresh') {
        return Promise.resolve(jsonResponse({ detail: '未登录' }, 401))
      }
      if (pathname === '/api/stocks/999999') {
        return Promise.resolve(jsonResponse({ detail: '未找到股票 999999' }, 404))
      }
      if (pathname === '/api/stocks/600519') {
        stockAttempts += 1
        if (stockAttempts === 1) {
          return Promise.resolve(jsonResponse({ detail: '数据库连接暂时中断' }, 503))
        }
        return Promise.resolve(jsonResponse(SAMPLE_STOCK, 200))
      }
      if (pathname === '/api/stocks/600519/snapshot') {
        return Promise.resolve(jsonResponse(SAMPLE_SNAPSHOT, 200))
      }
      return Promise.resolve(jsonResponse({ detail: `Unhandled ${pathname}` }, 500))
    })

    const { unmount } = renderStockPage('/stock/invalid')
    expect(screen.getByText('股票代码格式无效')).toBeInTheDocument()
    unmount()

    const notFoundView = renderStockPage('/stock/999999')
    expect(await screen.findByText('未找到股票 999999')).toBeInTheDocument()
    expect(screen.getByText(/python -m app\.cli\.sync/)).toBeInTheDocument()
    notFoundView.unmount()

    renderStockPage('/stock/600519')
    expect(await screen.findByText('个股信息加载失败')).toBeInTheDocument()
    expect(screen.getByText('数据库连接暂时中断')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByRole('heading', { name: '贵州茅台' })).toBeInTheDocument()
    expect(screen.getByText('已预计算快照')).toBeInTheDocument()
  })

  it('validates journal reason/falsify_condition, submits pass decision, deletes entry, and adds to watchlist', async () => {
    let journalState: JournalEntryItem[] = []
    let watchlistState: WatchlistItem[] = []
    let postCalled = false
    let putWatchlistCalled = false
    let postWatchlistCalled = false
    let createdPayload: JournalCreate | null = null
    let watchlistPayload: WatchlistUpsert | null = null
    let deletedEntryId: number | null = null

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const request = asRequest(input)
      const url = new URL(request.url)

      if (url.pathname === '/api/auth/refresh' && request.method === 'POST') {
        return jsonResponse(SAMPLE_TOKEN, 200)
      }
      if (url.pathname === '/api/stocks/600519' && request.method === 'GET') {
        return jsonResponse(SAMPLE_STOCK, 200)
      }
      if (url.pathname === '/api/stocks/600519/snapshot' && request.method === 'GET') {
        return jsonResponse(SAMPLE_SNAPSHOT, 200)
      }
      if (url.pathname === '/api/watchlist' && request.method === 'GET') {
        return jsonResponse(watchlistState, 200)
      }
      if (url.pathname === '/api/journal' && request.method === 'GET') {
        return jsonResponse(journalState, 200)
      }
      if (url.pathname === '/api/ai/preferences' && request.method === 'GET') {
        return jsonResponse(SAMPLE_AI_PREFS, 200)
      }
      if (url.pathname === '/api/journal' && request.method === 'POST') {
        postCalled = true
        const body = parseJournalCreate(await request.clone().text())
        createdPayload = body
        const created: JournalEntryItem = {
          id: 42,
          code: body.code,
          name: body.name ?? null,
          action: body.action,
          reason: body.reason,
          falsify_condition: body.falsify_condition,
          falsify_rules: null,
          max_drawdown: body.max_drawdown ?? null,
          emotion: body.emotion ?? null,
          price: body.price ?? null,
          benchmark_code: body.benchmark_code,
          benchmark_price: null,
          created_at: '2026-11-22T12:00:00Z',
        }
        journalState = [created, ...journalState]
        return jsonResponse(created, 201)
      }
      if (url.pathname === '/api/journal/42' && request.method === 'DELETE') {
        deletedEntryId = 42
        journalState = journalState.filter((entry) => entry.id !== 42)
        return new Response(null, { status: 204 })
      }
      if (url.pathname === '/api/watchlist' && request.method === 'PUT') {
        putWatchlistCalled = true
        return jsonResponse({ detail: 'PUT should not be called by quick-add' }, 500)
      }
      if (url.pathname === '/api/watchlist' && request.method === 'POST') {
        postWatchlistCalled = true
        const body = parseWatchlistUpsert(await request.clone().text())
        watchlistPayload = body
        const item: WatchlistItem = {
          code: body.code,
          name: body.name,
          industry: body.industry ?? null,
          note: null,
          target_price: null,
          target_pe_percentile: null,
          target_dividend_yield: null,
          alert_enabled: body.alert_enabled,
          added_at: '2026-11-22T12:00:00Z',
          updated_at: '2026-11-22T12:00:00Z',
        }
        watchlistState = [item]
        return jsonResponse(item, 200)
      }
      return jsonResponse({ detail: `Unhandled ${request.method} ${url.pathname}` }, 500)
    })

    renderStockPage('/stock/600519')

    const addWatchlistBtn = await screen.findByRole('button', { name: '加入自选愿望单' })
    expect(screen.getByText('加入后可在「我的」配置到价自动提醒')).toBeInTheDocument()
    fireEvent.click(addWatchlistBtn)

    expect(await screen.findByText('已在自选 ✓')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '前往配置哨兵' })).toHaveAttribute('href', '/me')
    expect(screen.getByRole('button', { name: '移出自选' })).toBeInTheDocument()
    expect(postWatchlistCalled).toBe(true)
    expect(putWatchlistCalled).toBe(false)
    expect(watchlistPayload).toEqual({
      code: '600519',
      name: '贵州茅台',
      industry: '食品饮料',
      alert_enabled: false,
    })

    fireEvent.click(screen.getByRole('tab', { name: '投资决策' }))

    const submitBtn = await screen.findByRole('button', { name: '记录决策' })
    fireEvent.change(screen.getByLabelText('投资理由'), { target: { value: '   ' } })
    fireEvent.click(submitBtn)
    expect(await screen.findByRole('alert')).toHaveTextContent('请填写投资理由')
    expect(postCalled).toBe(false)

    fireEvent.change(screen.getByLabelText('投资理由'), {
      target: { value: '估值仍略高于安全边际，先观望等待' },
    })
    fireEvent.change(screen.getByLabelText('否证条件'), { target: { value: '   ' } })
    fireEvent.click(submitBtn)
    expect(await screen.findByRole('alert')).toHaveTextContent('请填写否证条件')
    expect(postCalled).toBe(false)

    fireEvent.change(screen.getByLabelText('决策动作'), { target: { value: 'pass' } })
    fireEvent.change(screen.getByLabelText('当前情绪'), { target: { value: '冷静' } })
    fireEvent.change(screen.getByLabelText('参考价格（元）'), { target: { value: '1520' } })
    fireEvent.change(screen.getByLabelText('最大可承受回撤（%）'), { target: { value: '20' } })
    fireEvent.change(screen.getByLabelText('否证条件'), {
      target: { value: '若跌破 1350 且批价企稳则重新评估买入' },
    })
    fireEvent.click(submitBtn)

    expect(await screen.findByText('估值仍略高于安全边际，先观望等待')).toBeInTheDocument()
    expect(screen.getByText('若跌破 1350 且批价企稳则重新评估买入')).toBeInTheDocument()
    expect(screen.getByText('价格 1,520.00')).toBeInTheDocument()
    expect(screen.getByText('最大回撤 20.0%')).toBeInTheDocument()
    expect(screen.getByText('情绪：冷静')).toBeInTheDocument()
    expect(createdPayload).toEqual({
      code: '600519',
      name: '贵州茅台',
      action: 'pass',
      reason: '估值仍略高于安全边际，先观望等待',
      falsify_condition: '若跌破 1350 且批价企稳则重新评估买入',
      price: 1520,
      max_drawdown: 20,
      emotion: '冷静',
      benchmark_code: '000300',
    })

    fireEvent.click(screen.getByRole('button', { name: '删除日记' }))
    await waitFor(() => {
      expect(screen.queryByText('估值仍略高于安全边际，先观望等待')).not.toBeInTheDocument()
    })
    expect(deletedEntryId).toBe(42)
  })

  it('shows 已在自选 ✓ badge, sentinel link, and supports removing from watchlist via DELETE without firing PUT/POST', async () => {
    let writeCalled = false
    let watchlistState: WatchlistItem[] = [
      {
        code: '600519',
        name: '贵州茅台',
        industry: '白酒',
        note: '长期跟踪',
        target_price: 1400,
        target_pe_percentile: 20,
        target_dividend_yield: 3.5,
        alert_enabled: true,
        added_at: '2026-11-22T00:00:00Z',
        updated_at: '2026-11-22T00:00:00Z',
      },
    ]
    let deletedCode: string | null = null

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const request = asRequest(input)
      const url = new URL(request.url)

      if (url.pathname === '/api/auth/refresh' && request.method === 'POST') {
        return Promise.resolve(jsonResponse(SAMPLE_TOKEN, 200))
      }
      if (url.pathname === '/api/stocks/600519' && request.method === 'GET') {
        return Promise.resolve(jsonResponse(SAMPLE_STOCK, 200))
      }
      if (url.pathname === '/api/stocks/600519/snapshot' && request.method === 'GET') {
        return Promise.resolve(jsonResponse(SAMPLE_SNAPSHOT, 200))
      }
      if (url.pathname === '/api/watchlist' && request.method === 'GET') {
        return Promise.resolve(jsonResponse(watchlistState, 200))
      }
      if (url.pathname === '/api/watchlist/600519' && request.method === 'DELETE') {
        deletedCode = '600519'
        watchlistState = []
        return Promise.resolve(new Response(null, { status: 204 }))
      }
      if (url.pathname === '/api/journal' && request.method === 'GET') {
        return Promise.resolve(jsonResponse([], 200))
      }
      if (
        url.pathname === '/api/watchlist' &&
        (request.method === 'PUT' || request.method === 'POST')
      ) {
        writeCalled = true
        return Promise.resolve(jsonResponse({ detail: 'unexpected write' }, 500))
      }
      return Promise.resolve(
        jsonResponse({ detail: `Unhandled ${request.method} ${url.pathname}` }, 500),
      )
    })

    renderStockPage('/stock/600519')

    expect(await screen.findByText('已在自选 ✓')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '前往配置哨兵' })).toHaveAttribute('href', '/me')
    expect(screen.queryByRole('button', { name: '加入自选愿望单' })).not.toBeInTheDocument()
    expect(writeCalled).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: '移出自选' }))
    expect(await screen.findByRole('button', { name: '加入自选愿望单' })).toBeInTheDocument()
    expect(deletedCode).toBe('600519')
  })

  it('uses quality polarity for ScoreRing and fundamental metrics instead of price up/down colors', async () => {
    const { container: ringHigh } = render(
      <ScoreRing score={89} toneMode="quality" label="RADAR" />,
    )
    expect(ringHigh.querySelectorAll('circle')[1]).toHaveAttribute('stroke', 'var(--accent)')

    const { container: ringMid } = render(<ScoreRing score={55} toneMode="quality" label="RADAR" />)
    expect(ringMid.querySelectorAll('circle')[1]).toHaveAttribute('stroke', 'var(--electric)')

    const { container: ringLow } = render(<ScoreRing score={30} toneMode="quality" label="RADAR" />)
    expect(ringLow.querySelectorAll('circle')[1]).toHaveAttribute('stroke', 'var(--amber)')

    const { container: ringHeat } = render(<ScoreRing score={89} label="TEMP" />)
    expect(ringHeat.querySelectorAll('circle')[1]).toHaveAttribute('stroke', 'var(--rose)')
    cleanup()

    const oppositeSnapshot: StockSnapshotPayload = {
      ...SAMPLE_SNAPSHOT,
      valuation: {
        ...SAMPLE_SNAPSHOT.valuation,
        graham_margin_pct: 18.5,
      },
      reverse_dcf: {
        ...SAMPLE_SNAPSHOT.reverse_dcf,
        implied_vs_history_gap_pct: 7.2,
      },
      shareholder_return: {
        ...SAMPLE_SNAPSHOT.shareholder_return,
        net_return_yuan: -1.2e10,
      },
    }

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const pathname = new URL(asRequest(input).url).pathname
      if (pathname === '/api/auth/refresh') {
        return Promise.resolve(jsonResponse({ detail: '未登录' }, 401))
      }
      if (pathname === '/api/stocks/600519') {
        return Promise.resolve(jsonResponse(SAMPLE_STOCK, 200))
      }
      if (pathname === '/api/stocks/600519/snapshot') {
        return Promise.resolve(jsonResponse(oppositeSnapshot, 200))
      }
      return Promise.resolve(jsonResponse({ detail: `Unhandled ${pathname}` }, 500))
    })

    const view = renderStockPage('/stock/600519')
    expect(await screen.findByRole('img', { name: 'RADAR' })).toBeInTheDocument()
    const radarRing = screen.getByRole('img', { name: 'RADAR' })
    expect(radarRing.querySelectorAll('circle')[1]).toHaveAttribute('stroke', 'var(--accent)')

    fireEvent.click(screen.getByRole('tab', { name: '估值' }))
    const grahamMetric = (await screen.findByText('1,380.50')).closest('.metric-value')
    expect(grahamMetric).toHaveClass('tone-good')
    const gapMetric = screen.getByText('+7.20%').closest('.metric-value')
    expect(gapMetric).toHaveClass('tone-bad')

    fireEvent.click(screen.getByRole('tab', { name: '治理' }))
    const netReturnMetric = (await screen.findByText('-120.00 亿元')).closest('.metric-value')
    expect(netReturnMetric).toHaveClass('tone-bad')
    view.unmount()
  })

  it('submits structured falsify_rules with emotion chip, resets builder, and renders time-capsule pills', async () => {
    let journalState: JournalEntryItem[] = [
      {
        id: 1,
        code: '600519',
        name: '贵州茅台',
        action: 'add',
        reason: '自定义规则历史验证',
        falsify_condition: '净现金覆盖下降',
        falsify_rules: [{ metric: 'custom_ratio', op: 'lt', value: 1.5, periods: 2 }],
        max_drawdown: null,
        emotion: '冷静',
        price: 1480,
        benchmark_code: '000300',
        benchmark_price: 3900,
        snapshot: {
          as_of: '2026-11-01',
          close: 1480,
          pe_ttm: 21.8,
          pe_percentile_10y: 22.4,
          total_score: 88,
          benchmark_code: '000300',
          benchmark_price: 3900,
        },
        created_at: '2026-11-01T10:00:00Z',
      },
    ]
    let capturedCreate: JournalCreate | null = null

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const request = asRequest(input)
      const url = new URL(request.url)

      if (url.pathname === '/api/auth/refresh' && request.method === 'POST') {
        return jsonResponse(SAMPLE_TOKEN, 200)
      }
      if (url.pathname === '/api/stocks/600519' && request.method === 'GET') {
        return jsonResponse(SAMPLE_STOCK, 200)
      }
      if (url.pathname === '/api/stocks/600519/snapshot' && request.method === 'GET') {
        return jsonResponse(SAMPLE_SNAPSHOT, 200)
      }
      if (url.pathname === '/api/watchlist' && request.method === 'GET') {
        return jsonResponse([], 200)
      }
      if (url.pathname === '/api/journal' && request.method === 'GET') {
        return jsonResponse(journalState, 200)
      }
      if (url.pathname === '/api/ai/preferences' && request.method === 'GET') {
        return jsonResponse(SAMPLE_AI_PREFS, 200)
      }
      if (url.pathname === '/api/journal' && request.method === 'POST') {
        const body = parseJournalCreate(await request.clone().text())
        capturedCreate = body
        const created: JournalEntryItem = {
          id: 99,
          code: body.code,
          name: body.name ?? null,
          action: body.action,
          reason: body.reason,
          falsify_condition: body.falsify_condition,
          falsify_rules: body.falsify_rules ?? null,
          max_drawdown: body.max_drawdown ?? null,
          emotion: body.emotion ?? null,
          price: body.price ?? null,
          benchmark_code: body.benchmark_code,
          benchmark_price: 3950.25,
          snapshot: {
            as_of: '2026-11-20',
            close: 1520,
            pe_ttm: 22.1,
            pe_percentile_10y: 26.5,
            total_score: 89,
            benchmark_code: '000300',
            benchmark_price: 3950.25,
            benchmark_as_of: '2026-11-21',
          },
          created_at: '2026-11-22T12:00:00Z',
        }
        journalState = [created, ...journalState]
        return jsonResponse(created, 201)
      }
      return jsonResponse({ detail: `Unhandled ${request.method} ${url.pathname}` }, 500)
    })

    renderStockPage('/stock/600519')
    fireEvent.click(await screen.findByRole('tab', { name: '投资决策' }))

    expect(await screen.findByText('时间胶囊将自动留存：')).toBeInTheDocument()
    expect(
      screen.getByText(/股价 1,520\.00 · PE\(TTM\) 22\.10 · 股息率 3\.45% · 雷达评分 89\/100/),
    ).toBeInTheDocument()

    expect(await screen.findByText('规则：custom_ratio < 1.5（连续 2 期）')).toBeInTheDocument()
    expect(screen.getByText('快照 PE 21.80')).toBeInTheDocument()
    expect(screen.getByText('分位 22.4%')).toBeInTheDocument()
    expect(screen.getByText('评分 88')).toBeInTheDocument()
    expect(screen.getByText('沪深300 3,900.00')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '乐观' }))
    expect(screen.getByLabelText('当前情绪')).toHaveValue('乐观')

    fireEvent.change(screen.getByLabelText('投资理由'), {
      target: { value: '高 ROE 现金牛折价窗口买入' },
    })
    fireEvent.change(screen.getByLabelText('否证条件'), {
      target: { value: '出现 CT 红灯或估值极端过热时证伪' },
    })

    fireEvent.click(screen.getByRole('button', { name: '+ CT红灯≥1' }))
    fireEvent.click(screen.getByRole('button', { name: '+ PE分位≥85%' }))
    fireEvent.click(screen.getByRole('button', { name: '+ ROE<12%' }))
    fireEvent.click(screen.getByRole('button', { name: '+ 自定义规则' }))

    expect(screen.getByLabelText('规则 1 连续期数')).toBeDisabled()
    expect(screen.getByLabelText('规则 1 连续期数')).toHaveValue(1)
    expect(screen.getByLabelText('规则 2 连续期数')).toBeDisabled()
    expect(screen.getByLabelText('规则 2 连续期数')).toHaveValue(1)
    expect(screen.getByLabelText('规则 3 连续期数')).not.toBeDisabled()
    expect(screen.getAllByText('当期快照指标按最新 1 期判定')).toHaveLength(3)

    // Multi-period annual metric retains user periods, while switching back to a scalar metric locks periods=1.
    fireEvent.change(screen.getByLabelText('规则 4 指标'), { target: { value: 'roe_pct' } })
    fireEvent.change(screen.getByLabelText('规则 4 连续期数'), { target: { value: '3' } })
    expect(screen.getByLabelText('规则 4 连续期数')).toHaveValue(3)
    fireEvent.change(screen.getByLabelText('规则 4 指标'), { target: { value: 'pe_ttm' } })
    expect(screen.getByLabelText('规则 4 连续期数')).toBeDisabled()
    expect(screen.getByLabelText('规则 4 连续期数')).toHaveValue(1)

    fireEvent.click(screen.getByRole('button', { name: '记录决策' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('请填写第 4 条否证规则的阈值')
    expect(capturedCreate).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '移除规则 4' }))
    fireEvent.change(screen.getByLabelText('规则 3 连续期数'), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: '记录决策' }))

    expect(await screen.findByRole('button', { name: '跳过质询，直接提交' })).toBeInTheDocument()
    expect(capturedCreate).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '跳过质询，直接提交' }))

    expect(await screen.findByText('高 ROE 现金牛折价窗口买入')).toBeInTheDocument()
    expect(capturedCreate).toEqual({
      code: '600519',
      name: '贵州茅台',
      action: 'buy',
      reason: '高 ROE 现金牛折价窗口买入',
      falsify_condition: '出现 CT 红灯或估值极端过热时证伪',
      price: null,
      max_drawdown: null,
      emotion: '乐观',
      benchmark_code: '000300',
      falsify_rules: [
        { metric: 'ct_red_count', op: 'gte', value: 1, periods: 1 },
        { metric: 'pe_percentile_10y', op: 'gte', value: 85, periods: 1 },
        { metric: 'roe_pct', op: 'lt', value: 12, periods: 2 },
      ],
    })

    expect(screen.getByText('规则：CT红灯数 ≥ 1（连续 1 期）')).toBeInTheDocument()
    expect(screen.getByText('规则：10年PE分位 ≥ 85（连续 1 期）')).toBeInTheDocument()
    expect(screen.getByText('规则：ROE < 12（连续 2 期）')).toBeInTheDocument()
    expect(screen.getByText('快照 PE 22.10')).toBeInTheDocument()
    expect(screen.getByText('分位 26.5%')).toBeInTheDocument()
    expect(screen.getByText('评分 89')).toBeInTheDocument()
    expect(screen.getByText('沪深300 3,950.25 (2026-11-21)')).toBeInTheDocument()
    expect(screen.getByText(/0\/5/)).toBeInTheDocument()
  })

  it('runs pre-trade Devils Advocate gate, adopts suggested falsify rule, syncs quota, and gates edited drafts', async () => {
    let journalState: JournalEntryItem[] = []
    let prefsGetCount = 0
    const daRequests: DevilsAdvocateRequest[] = []
    const journalCreates: JournalCreate[] = []

    const daResponse: DevilsAdvocateResponse = {
      code: '600519',
      stock_name: '贵州茅台',
      as_of: '2026-11-20',
      mode: 'deterministic_fallback',
      fallback_reason: '外部模型超时，已自动回退规则引擎',
      challenges: [
        {
          index: 1,
          title: '估值与逆向隐含增速约束',
          thesis: '当前 PE 仍高于绝对深度折价区间，需核查长期现金流增速。',
          cited_facts: [
            { label: 'PE(TTM)', value_text: '22.10', source_section: 'valuation' },
            { label: '隐含FCF增速', value_text: '+8.42%', source_section: 'reverse_dcf' },
          ],
          suggested_falsify_rule: {
            metric: 'roe',
            op: 'lt',
            value: 12,
            periods: 2,
          },
        },
        {
          index: 2,
          title: '渠道库存与两金增速背离',
          thesis: '存货增速略高于营收增速，需持续跟踪批价与去库节奏。',
          cited_facts: [
            { label: '增速差', value_text: '+4.2%', source_section: 'financial_ct' },
            { label: '综合评分', value_text: '89', source_section: 'radar' },
          ],
          suggested_falsify_rule: {
            metric: 'ocf_to_profit_5y_pct',
            op: 'lt',
            value: 80,
            periods: 1,
          },
        },
        {
          index: 3,
          title: '宏观商务消费需求扰动',
          thesis: '高端消费对宏观景气存在滞后弹性。',
          cited_facts: [],
          suggested_falsify_rule: null,
        },
      ],
      quota: {
        ...SAMPLE_AI_PREFS.quota,
        used_today: 2,
        remaining_today: 3,
      },
      compliance_notice: '合规提示：反方质询基于已同步财报快照生成，仅供投资复盘，不构成买卖建议。',
    }

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const request = asRequest(input)
      const url = new URL(request.url)

      if (url.pathname === '/api/auth/refresh' && request.method === 'POST') {
        return jsonResponse(SAMPLE_TOKEN, 200)
      }
      if (url.pathname === '/api/stocks/600519' && request.method === 'GET') {
        return jsonResponse(SAMPLE_STOCK, 200)
      }
      if (url.pathname === '/api/stocks/600519/snapshot' && request.method === 'GET') {
        return jsonResponse(SAMPLE_SNAPSHOT, 200)
      }
      if (url.pathname === '/api/watchlist' && request.method === 'GET') {
        return jsonResponse([], 200)
      }
      if (url.pathname === '/api/journal' && request.method === 'GET') {
        return jsonResponse(journalState, 200)
      }
      if (url.pathname === '/api/ai/preferences' && request.method === 'GET') {
        prefsGetCount += 1
        return jsonResponse(SAMPLE_AI_PREFS, 200)
      }
      if (url.pathname === '/api/ai/devils-advocate' && request.method === 'POST') {
        daRequests.push(parseDevilsAdvocateRequest(await request.clone().text()))
        return jsonResponse(daResponse, 200)
      }
      if (url.pathname === '/api/journal' && request.method === 'POST') {
        const body = parseJournalCreate(await request.clone().text())
        journalCreates.push(body)
        const created: JournalEntryItem = {
          id: 88,
          code: body.code,
          name: body.name ?? null,
          action: body.action,
          reason: body.reason,
          falsify_condition: body.falsify_condition,
          falsify_rules: body.falsify_rules ?? null,
          max_drawdown: body.max_drawdown ?? null,
          emotion: body.emotion ?? null,
          price: body.price ?? null,
          benchmark_code: body.benchmark_code,
          benchmark_price: 3950,
          created_at: '2026-11-22T12:30:00Z',
        }
        journalState = [created, ...journalState]
        return jsonResponse(created, 201)
      }
      return jsonResponse({ detail: `Unhandled ${request.method} ${url.pathname}` }, 500)
    })

    renderStockPage('/stock/600519')
    fireEvent.click(await screen.findByRole('tab', { name: '投资决策' }))

    expect(await screen.findByText('买入前反方质询 · 理性安检门')).toBeInTheDocument()
    expect(await screen.findByText('今日 AI 额度剩余 4/5')).toBeInTheDocument()

    // Non-buy/add actions hide the gate; buy/add show it.
    fireEvent.change(screen.getByLabelText('决策动作'), { target: { value: 'sell' } })
    expect(screen.queryByText('买入前反方质询 · 理性安检门')).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('决策动作'), { target: { value: 'buy' } })
    expect(screen.getByText('买入前反方质询 · 理性安检门')).toBeInTheDocument()

    // Running DA with empty reason prompts cleanly without firing API call.
    fireEvent.click(screen.getByRole('button', { name: '运行反方质询' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '请先填写投资理由，再运行买入前反方质询',
    )
    expect(daRequests).toHaveLength(0)

    // Populate required fields and click 记录决策 without running DA -> inline confirmation gate appears.
    fireEvent.change(screen.getByLabelText('投资理由'), {
      target: { value: '现金流稳健，分红率具备吸引力' },
    })
    fireEvent.change(screen.getByLabelText('否证条件'), {
      target: { value: '待质询补充' },
    })
    fireEvent.click(screen.getByRole('button', { name: '记录决策' }))

    const buyGateBanner = await screen.findByRole('region', { name: '买入前理性安检门确认' })
    expect(buyGateBanner).toHaveAttribute('aria-live', 'polite')
    expect(screen.getByRole('button', { name: '先运行反方质询' })).toHaveFocus()
    expect(journalCreates).toHaveLength(0)

    // Clear falsifyCondition so adopting a suggested rule fills it automatically when empty.
    fireEvent.change(screen.getByLabelText('否证条件'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: '纯规则引擎 (rule_only)' }))
    fireEvent.click(screen.getByRole('button', { name: '先运行反方质询' }))

    expect(await screen.findByText('#1 估值与逆向隐含增速约束')).toBeInTheDocument()
    expect(screen.getByText('#2 渠道库存与两金增速背离')).toBeInTheDocument()
    expect(screen.getByText('#3 宏观商务消费需求扰动')).toBeInTheDocument()
    expect(screen.getByText('PE(TTM): 22.10 · 估值')).toBeInTheDocument()
    expect(screen.getByText('隐含FCF增速: +8.42% · 逆向DCF')).toBeInTheDocument()
    expect(screen.getByText('增速差: +4.2% · 财务排雷')).toBeInTheDocument()
    expect(screen.getByText('综合评分: 89 · 五维雷达')).toBeInTheDocument()
    expect(screen.getByText('规则回退 · deterministic_fallback')).toBeInTheDocument()
    expect(screen.getByText(/外部模型超时，已自动回退规则引擎/)).toBeInTheDocument()
    expect(screen.getByText(/仅供投资复盘，不构成买卖建议/)).toBeInTheDocument()

    // Quota pill synced live without a second GET /api/ai/preferences roundtrip.
    expect(screen.getByText('今日 AI 额度剩余 3/5')).toBeInTheDocument()
    expect(prefsGetCount).toBe(1)
    expect(daRequests).toEqual([
      {
        code: '600519',
        action: 'buy',
        reason: '现金流稳健，分红率具备吸引力',
        falsify_condition: '',
        mode: 'rule_only',
      },
    ])

    // Adopt suggested rule 1 (legacy 'roe' < 12 for 2 periods) -> canonicalizes to 'roe_pct' without duplicate options.
    const firstAdoptBtn = screen.getByRole('button', { name: '采纳第 1 条建议红线' })
    const secondAdoptBtn = screen.getByRole('button', { name: '采纳第 2 条建议红线' })
    fireEvent.click(firstAdoptBtn)

    expect(screen.getByLabelText('规则 1 指标')).toHaveValue('roe_pct')
    expect(screen.getAllByRole('option', { name: 'ROE (%)' })).toHaveLength(1)
    expect(screen.queryByRole('option', { name: 'ROE' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('规则 1 条件')).toHaveValue('lt')
    expect(screen.getByLabelText('规则 1 阈值')).toHaveValue(12)
    expect(screen.getByLabelText('规则 1 连续期数')).toHaveValue(2)
    expect(screen.getByLabelText('否证条件')).toHaveValue('ROE < 12%（连续 2 期）')
    expect(firstAdoptBtn).toBeDisabled()
    expect(firstAdoptBtn).toHaveTextContent('已采纳')

    // Adopting a second rule while falsifyCondition is non-empty adds the rule without overwriting existing text.
    fireEvent.click(secondAdoptBtn)
    expect(screen.getByLabelText('规则 2 指标')).toHaveValue('ocf_to_profit_5y_pct')
    expect(screen.getByLabelText('规则 2 阈值')).toHaveValue(80)
    expect(screen.getByLabelText('否证条件')).toHaveValue('ROE < 12%（连续 2 期）')
    expect(secondAdoptBtn).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '移除规则 2' }))
    expect(secondAdoptBtn).not.toBeDisabled()

    // Editing reason re-arms the buy gate; reverting back or running again clears it.
    fireEvent.change(screen.getByLabelText('投资理由'), {
      target: { value: '完全不同的新买入逻辑' },
    })
    fireEvent.click(screen.getByRole('button', { name: '记录决策' }))
    const rearmedGateBanner = await screen.findByRole('region', { name: '买入前理性安检门确认' })
    expect(rearmedGateBanner).toHaveAttribute('aria-live', 'polite')
    expect(screen.getByRole('button', { name: '先运行反方质询' })).toHaveFocus()
    expect(journalCreates).toHaveLength(0)

    // Restore reviewed draft reason -> submitting logs directly without gate.
    fireEvent.change(screen.getByLabelText('投资理由'), {
      target: { value: '现金流稳健，分红率具备吸引力' },
    })
    fireEvent.click(screen.getByRole('button', { name: '记录决策' }))

    expect(await screen.findByText('现金流稳健，分红率具备吸引力')).toBeInTheDocument()
    expect(journalCreates).toEqual([
      {
        code: '600519',
        name: '贵州茅台',
        action: 'buy',
        reason: '现金流稳健，分红率具备吸引力',
        falsify_condition: 'ROE < 12%（连续 2 期）',
        price: null,
        max_drawdown: null,
        emotion: null,
        benchmark_code: '000300',
        falsify_rules: [{ metric: 'roe_pct', op: 'lt', value: 12, periods: 2 }],
      },
    ])
  })

  it('renders MD&A Diff panel under 风险排雷 tab, fills sample snippets, clears text, and renders shifts and highlights', async () => {
    const mdaRequests: MdaDiffRequest[] = []
    let prefsGetCount = 0

    const mdaResponse: MdaDiffResponse = {
      code: '600519',
      stock_name: '贵州茅台',
      previous_period_label: '2024年报',
      current_period_label: '2025年报',
      mode: 'deterministic',
      summary:
        '共识别文本变更 2 处（新增 1 处、删除 0 处、修改 1 处），其中高敏感会计/风险提示 1 处。',
      metric_shifts: [
        {
          metric_label: '毛利率变化',
          previous_text: '2024年 91.80%',
          current_text: '2025年 86.10%',
          delta_text: '-5.70 个百分点',
          severity: 'red',
          interpretation: '毛利率大幅下滑，可能存在价格竞争加剧或产品结构承压。',
        },
      ],
      text_highlights: [
        {
          change_type: 'modified',
          category: '会计政策与审计口径变更',
          previous_excerpt: '前五大客户营收占比为 28.5%，渠道库存周转天数保持在 35 天健康区间。',
          current_excerpt: '渠道库存承压，本期针对部分长账龄应收款调整坏账准备计提比例并计提减值。',
          signal_tags: ['口径:坏账准备', '风险:计提减值'],
          severity: 'red',
        },
      ],
      quota: {
        ...SAMPLE_AI_PREFS.quota,
        byok_active: true,
      },
      compliance_notice: '合规提示：MD&A 差异仅作研究辅助，不构成任何证券投资建议。',
    }

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const request = asRequest(input)
      const url = new URL(request.url)

      if (url.pathname === '/api/auth/refresh' && request.method === 'POST') {
        return jsonResponse(SAMPLE_TOKEN, 200)
      }
      if (url.pathname === '/api/stocks/600519' && request.method === 'GET') {
        return jsonResponse(SAMPLE_STOCK, 200)
      }
      if (url.pathname === '/api/stocks/600519/snapshot' && request.method === 'GET') {
        return jsonResponse(SAMPLE_SNAPSHOT, 200)
      }
      if (url.pathname === '/api/watchlist' && request.method === 'GET') {
        return jsonResponse([], 200)
      }
      if (url.pathname === '/api/ai/preferences' && request.method === 'GET') {
        prefsGetCount += 1
        return jsonResponse(SAMPLE_AI_PREFS, 200)
      }
      if (url.pathname === '/api/ai/mda-diff' && request.method === 'POST') {
        mdaRequests.push(parseMdaDiffRequest(await request.clone().text()))
        return jsonResponse(mdaResponse, 200)
      }
      return jsonResponse({ detail: `Unhandled ${request.method} ${url.pathname}` }, 500)
    })

    renderStockPage('/stock/600519')
    fireEvent.click(await screen.findByRole('tab', { name: '风险排雷' }))

    expect(await screen.findByText('年报 MD&A 口径变化对比器 · 贵州茅台')).toBeInTheDocument()
    expect(await screen.findByText('今日 AI 额度剩余 4/5')).toBeInTheDocument()

    // Quick-fill sample -> clear -> quick-fill again -> toggle rule_only -> submit.
    fireEvent.click(screen.getByRole('button', { name: '填入年报对比样例' }))
    expect(screen.getByLabelText('上期报告标签')).toHaveValue('2024年报')
    expect(screen.getByLabelText('本期报告标签')).toHaveValue('2025年报')
    expect(screen.getByLabelText('上期管理层讨论与分析原文')).not.toHaveValue('')
    expect(screen.getByLabelText('本期管理层讨论与分析原文')).not.toHaveValue('')

    fireEvent.click(screen.getByRole('button', { name: '清空文本' }))
    expect(screen.getByLabelText('上期管理层讨论与分析原文')).toHaveValue('')
    expect(screen.getByLabelText('本期管理层讨论与分析原文')).toHaveValue('')

    fireEvent.click(screen.getByRole('button', { name: '填入年报对比样例' }))
    fireEvent.click(screen.getByRole('button', { name: '纯规则引擎 (rule_only)' }))
    fireEvent.click(screen.getByRole('button', { name: '运行 MD&A 口径对比' }))

    expect(await screen.findByText('对比结论摘要')).toBeInTheDocument()
    expect(screen.getByText(/共识别文本变更 2 处/)).toBeInTheDocument()
    expect(screen.getByText('规则引擎 · deterministic')).toBeInTheDocument()
    expect(screen.getByText('毛利率变化')).toBeInTheDocument()
    expect(screen.getByText('变化：-5.70 个百分点')).toBeInTheDocument()
    expect(screen.getByText('会计政策与审计口径变更')).toBeInTheDocument()
    expect(screen.getByText('修改 · modified')).toBeInTheDocument()
    expect(screen.getByText('口径:坏账准备')).toBeInTheDocument()
    expect(screen.getByText('风险:计提减值')).toBeInTheDocument()
    expect(screen.getByText(/MD&A 差异仅作研究辅助/)).toBeInTheDocument()
    expect(screen.getByText('BYOK 已启用')).toBeInTheDocument()
    expect(prefsGetCount).toBe(1)
    expect(mdaRequests).toHaveLength(1)
    expect(mdaRequests[0]?.mode).toBe('rule_only')
    expect(mdaRequests[0]?.previous_period_label).toBe('2024年报')
    expect(mdaRequests[0]?.current_period_label).toBe('2025年报')
  })

  it('preserves DA and MD&A Diff results across tab switches while unmounting inactive tabs, and clears MD&A cache on 清空文本', async () => {
    let daCalls = 0
    let mdaCalls = 0

    const daResponse: DevilsAdvocateResponse = {
      code: '600519',
      stock_name: '贵州茅台',
      as_of: '2026-11-20',
      mode: 'deterministic',
      fallback_reason: null,
      challenges: [
        {
          index: 1,
          title: '跨Tab保留的质询项',
          thesis: '切换 tab 后仍应保留此条质询。',
          cited_facts: [],
          suggested_falsify_rule: null,
        },
      ],
      quota: SAMPLE_AI_PREFS.quota,
      compliance_notice: '仅供研究复盘，不构成投资建议。',
    }
    const mdaResponse: MdaDiffResponse = {
      code: '600519',
      stock_name: '贵州茅台',
      previous_period_label: '2024年报',
      current_period_label: '2025年报',
      mode: 'deterministic',
      fallback_reason: null,
      summary: '跨Tab保留的MD&A对比摘要。',
      metric_shifts: [],
      text_highlights: [],
      quota: SAMPLE_AI_PREFS.quota,
      compliance_notice: '仅供研究复盘，不构成投资建议。',
    }

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const request = asRequest(input)
      const url = new URL(request.url)

      if (url.pathname === '/api/auth/refresh') {
        return Promise.resolve(jsonResponse(SAMPLE_TOKEN, 200))
      }
      if (url.pathname === '/api/stocks/600519') {
        return Promise.resolve(jsonResponse(SAMPLE_STOCK, 200))
      }
      if (url.pathname === '/api/stocks/600519/snapshot') {
        return Promise.resolve(jsonResponse(SAMPLE_SNAPSHOT, 200))
      }
      if (url.pathname === '/api/watchlist') {
        return Promise.resolve(jsonResponse([], 200))
      }
      if (url.pathname === '/api/journal') {
        return Promise.resolve(jsonResponse([], 200))
      }
      if (url.pathname === '/api/ai/preferences') {
        return Promise.resolve(jsonResponse(SAMPLE_AI_PREFS, 200))
      }
      if (url.pathname === '/api/ai/devils-advocate') {
        daCalls += 1
        return Promise.resolve(jsonResponse(daResponse, 200))
      }
      if (url.pathname === '/api/ai/mda-diff') {
        mdaCalls += 1
        return Promise.resolve(jsonResponse(mdaResponse, 200))
      }
      return Promise.resolve(jsonResponse({ detail: `Unhandled ${url.pathname}` }, 500))
    })

    renderStockPage('/stock/600519')

    fireEvent.click(await screen.findByRole('tab', { name: '投资决策' }))
    fireEvent.change(await screen.findByLabelText('投资理由'), {
      target: { value: '护城河深厚，分红率高' },
    })
    fireEvent.click(screen.getByRole('button', { name: '运行反方质询' }))
    expect(await screen.findByText('#1 跨Tab保留的质询项')).toBeInTheDocument()

    // Switch to 风险排雷 -> Decision tab unmounts cleanly, MD&A Diff runs.
    fireEvent.click(screen.getByRole('tab', { name: '风险排雷' }))
    expect(screen.queryByText('#1 跨Tab保留的质询项')).not.toBeInTheDocument()

    fireEvent.click(await screen.findByRole('button', { name: '填入年报对比样例' }))
    fireEvent.click(screen.getByRole('button', { name: '运行 MD&A 口径对比' }))
    expect(await screen.findByText('跨Tab保留的MD&A对比摘要。')).toBeInTheDocument()

    // Switch to 估值 -> Risks tab unmounts cleanly.
    fireEvent.click(screen.getByRole('tab', { name: '估值' }))
    expect(screen.queryByText('跨Tab保留的MD&A对比摘要。')).not.toBeInTheDocument()

    // Switch back to 投资决策 -> cached DA result renders immediately with 0 extra POSTs.
    fireEvent.click(screen.getByRole('tab', { name: '投资决策' }))
    expect(await screen.findByText('#1 跨Tab保留的质询项')).toBeInTheDocument()
    expect(daCalls).toBe(1)

    // Switch back to 风险排雷 -> cached MD&A Diff renders immediately with 0 extra POSTs, then 清空文本 clears it.
    fireEvent.click(screen.getByRole('tab', { name: '风险排雷' }))
    expect(await screen.findByText('跨Tab保留的MD&A对比摘要。')).toBeInTheDocument()
    expect(mdaCalls).toBe(1)

    fireEvent.click(screen.getByRole('button', { name: '清空文本' }))
    await waitFor(() => {
      expect(screen.queryByText('跨Tab保留的MD&A对比摘要。')).not.toBeInTheDocument()
    })
    fireEvent.click(screen.getByRole('tab', { name: '估值' }))
    fireEvent.click(screen.getByRole('tab', { name: '风险排雷' }))
    expect(screen.queryByText('跨Tab保留的MD&A对比摘要。')).not.toBeInTheDocument()
  })

  it('unlocks MD&A Diff for unsynced stocks with strict blank-text validation, single-text warning, and fallback_reason', async () => {
    const unsyncedDetail: StockDetail = {
      ...SAMPLE_STOCK,
      code: '000999',
      name: '*ST样本',
      exchange: 'SZ',
      is_st: true,
      snapshot_available: false,
    }
    const mdaRequests: MdaDiffRequest[] = []

    const fallbackMdaResponse: MdaDiffResponse = {
      code: '000999',
      stock_name: '*ST样本',
      previous_period_label: '上期年报',
      current_period_label: '本期年报',
      mode: 'deterministic_fallback',
      fallback_reason: '模型输出未通过事实校验，已自动切回纯规则差异引擎',
      summary: '识别到 1 处风险提示变化。',
      metric_shifts: [],
      text_highlights: [],
      quota: SAMPLE_AI_PREFS.quota,
      compliance_notice: '仅供研究复盘，不构成投资建议。',
    }

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const request = asRequest(input)
      const url = new URL(request.url)

      if (url.pathname === '/api/auth/refresh') {
        return jsonResponse(SAMPLE_TOKEN, 200)
      }
      if (url.pathname === '/api/stocks/000999') {
        return jsonResponse(unsyncedDetail, 200)
      }
      if (url.pathname === '/api/watchlist') {
        return jsonResponse([], 200)
      }
      if (url.pathname === '/api/ai/preferences') {
        return jsonResponse(SAMPLE_AI_PREFS, 200)
      }
      if (url.pathname === '/api/ai/mda-diff' && request.method === 'POST') {
        mdaRequests.push(parseMdaDiffRequest(await request.clone().text()))
        return jsonResponse(fallbackMdaResponse, 200)
      }
      return jsonResponse({ detail: `Unhandled ${url.pathname}` }, 500)
    })

    renderStockPage('/stock/000999')
    fireEvent.click(await screen.findByRole('tab', { name: '风险排雷' }))

    expect(await screen.findByText('风险排雷尚无深度分析快照')).toBeInTheDocument()
    expect(screen.getByText('年报 MD&A 口径变化对比器 · *ST样本')).toBeInTheDocument()
    expect(
      screen.getByText(/尚未同步结构化财报快照，请粘贴两期年报原文进行对比/),
    ).toBeInTheDocument()

    // Blank submission is blocked without calling API.
    fireEvent.click(screen.getByRole('button', { name: '运行 MD&A 口径对比' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '该标的尚未同步结构化财报快照，请粘贴两期年报原文后再运行对比',
    )
    expect(mdaRequests).toHaveLength(0)

    // Filling only one textarea warns clearly.
    fireEvent.change(screen.getByLabelText('上期管理层讨论与分析原文'), {
      target: { value: '上期业务正常推进。' },
    })
    expect(screen.getByRole('status')).toHaveTextContent(/全部条款将被标记为“已删除”/)

    // Filling current textarea clears warning and allows submission, rendering fallback_reason.
    fireEvent.change(screen.getByLabelText('本期管理层讨论与分析原文'), {
      target: { value: '本期应收账款坏账准备计提比例上调。' },
    })
    fireEvent.click(screen.getByRole('button', { name: '运行 MD&A 口径对比' }))

    expect(await screen.findByText('识别到 1 处风险提示变化。')).toBeInTheDocument()
    expect(
      screen.getByText('已回退规则引擎：模型输出未通过事实校验，已自动切回纯规则差异引擎'),
    ).toBeInTheDocument()
    expect(mdaRequests).toHaveLength(1)
  })

  it('protects LLM quota on blank MD&A text for synced stocks, recovers from 429 on both AI tools, enforces rules bounds/cap, and shows prefer_rule_only notice', async () => {
    let prefsState: AiPreferences = {
      ...SAMPLE_AI_PREFS,
      prefer_rule_only: true,
    }
    let daAttempt = 0
    let mdaAttempt = 0
    let resolvePendingDa!: (res: Response) => void
    const pendingDa = new Promise<Response>((resolve) => {
      resolvePendingDa = resolve
    })
    const daRequests: DevilsAdvocateRequest[] = []
    const mdaRequests: MdaDiffRequest[] = []
    const journalCreates: JournalCreate[] = []

    const daFallbackChallengeResponse: DevilsAdvocateResponse = {
      code: '600519',
      stock_name: '贵州茅台',
      as_of: '2026-11-20',
      mode: 'deterministic',
      fallback_reason: null,
      challenges: [
        {
          index: 1,
          title: 'PB分位过高提醒',
          thesis: '估值高于历史均值区间。',
          cited_facts: [],
          suggested_falsify_rule: {
            metric: 'pb_percentile',
            op: 'gte',
            value: 85,
            periods: 3,
          },
        },
        {
          index: 2,
          title: '现金流保障提示',
          thesis: '关注净现比持续性。',
          cited_facts: [],
          suggested_falsify_rule: {
            metric: 'ocf_to_profit_5y_pct',
            op: 'lt',
            value: 80,
            periods: 1,
          },
        },
      ],
      quota: {
        ...SAMPLE_AI_PREFS.quota,
        used_today: 5,
        remaining_today: 0,
      },
      compliance_notice: '仅供研究复盘，不构成投资建议。',
    }

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const request = asRequest(input)
      const url = new URL(request.url)

      if (url.pathname === '/api/auth/refresh') {
        return jsonResponse(SAMPLE_TOKEN, 200)
      }
      if (url.pathname === '/api/stocks/600519') {
        return jsonResponse(SAMPLE_STOCK, 200)
      }
      if (url.pathname === '/api/stocks/600519/snapshot') {
        return jsonResponse(SAMPLE_SNAPSHOT, 200)
      }
      if (url.pathname === '/api/watchlist') {
        return jsonResponse([], 200)
      }
      if (url.pathname === '/api/journal' && request.method === 'GET') {
        return jsonResponse([], 200)
      }
      if (url.pathname === '/api/journal' && request.method === 'POST') {
        const body = parseJournalCreate(await request.clone().text())
        journalCreates.push(body)
        return jsonResponse(
          {
            id: 77,
            code: body.code,
            name: body.name ?? null,
            action: body.action,
            reason: body.reason,
            falsify_condition: body.falsify_condition,
            falsify_rules: body.falsify_rules ?? null,
            max_drawdown: body.max_drawdown ?? null,
            emotion: body.emotion ?? null,
            price: body.price ?? null,
            benchmark_code: body.benchmark_code,
            benchmark_price: null,
            created_at: '2026-11-22T12:00:00Z',
          },
          201,
        )
      }
      if (url.pathname === '/api/ai/preferences') {
        return jsonResponse(prefsState, 200)
      }
      if (url.pathname === '/api/ai/mda-diff' && request.method === 'POST') {
        const body = parseMdaDiffRequest(await request.clone().text())
        mdaRequests.push(body)
        mdaAttempt += 1
        if (mdaAttempt === 2) {
          prefsState = {
            ...prefsState,
            quota: { ...prefsState.quota, used_today: 5, remaining_today: 0 },
          }
          return jsonResponse({ detail: '今日平台 AI 额度已用完（5/5）' }, 429)
        }
        return jsonResponse(
          {
            code: '600519',
            stock_name: '贵州茅台',
            previous_period_label: body.previous_period_label,
            current_period_label: body.current_period_label,
            mode: 'deterministic',
            fallback_reason: null,
            summary: '纯规则对比完成。',
            metric_shifts: [],
            text_highlights: [],
            quota: prefsState.quota,
            compliance_notice: '仅供研究复盘，不构成投资建议。',
          } satisfies MdaDiffResponse,
          200,
        )
      }
      if (url.pathname === '/api/ai/devils-advocate' && request.method === 'POST') {
        const body = parseDevilsAdvocateRequest(await request.clone().text())
        daRequests.push(body)
        daAttempt += 1
        if (daAttempt <= 2) {
          prefsState = {
            ...prefsState,
            quota: { ...prefsState.quota, used_today: 5, remaining_today: 0 },
          }
          return jsonResponse({ detail: '今日平台 AI 额度已用完（5/5）' }, 429)
        }
        if (daAttempt === 3) {
          return pendingDa
        }
        return jsonResponse(daFallbackChallengeResponse, 200)
      }
      return jsonResponse({ detail: `Unhandled ${request.method} ${url.pathname}` }, 500)
    })

    renderStockPage('/stock/600519')

    // Check prefer_rule_only notice and blank-text auto-rule_only quota protection in MD&A Diff.
    fireEvent.click(await screen.findByRole('tab', { name: '风险排雷' }))
    expect(
      await screen.findByText('全局偏好已设为仅纯规则，当前免费零消耗运行'),
    ).toBeInTheDocument()

    // Override mode to auto while leaving both textareas blank -> still forces mode: 'rule_only'.
    fireEvent.click(screen.getByRole('button', { name: '智能推演 (auto)' }))
    fireEvent.click(screen.getByRole('button', { name: '运行 MD&A 口径对比' }))
    expect(await screen.findByText('纯规则对比完成。')).toBeInTheDocument()
    expect(
      screen.getByText('当前由本地确定性规则引擎生成（零 AI 额度消耗，免费使用）'),
    ).toBeInTheDocument()
    expect(mdaRequests[0]?.mode).toBe('rule_only')
    expect(screen.getByText(/不消耗每日 AI 额度/)).toBeInTheDocument()

    // Fill text in auto mode -> 429 triggers quota refresh + error reset on edit + 1-click switch to rule_only & retry.
    fireEvent.change(screen.getByLabelText('上期管理层讨论与分析原文'), {
      target: { value: '上期原文内容' },
    })
    fireEvent.change(screen.getByLabelText('本期管理层讨论与分析原文'), {
      target: { value: '本期原文内容' },
    })
    fireEvent.click(screen.getByRole('button', { name: '运行 MD&A 口径对比' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('今日平台 AI 额度已用完（5/5）')
    expect(await screen.findByText('今日 AI 额度剩余 0/5')).toBeInTheDocument()

    // Editing input clears stale MD&A error, then re-triggering 429 and using 1-click retry recovers.
    fireEvent.change(screen.getByLabelText('本期管理层讨论与分析原文'), {
      target: { value: '本期原文内容补充' },
    })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    mdaAttempt = 1
    fireEvent.click(screen.getByRole('button', { name: '运行 MD&A 口径对比' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('今日平台 AI 额度已用完（5/5）')

    fireEvent.click(screen.getByRole('button', { name: '切换纯规则引擎并重试' }))
    expect(await screen.findByText('纯规则对比完成。')).toBeInTheDocument()
    expect(mdaRequests[3]?.mode).toBe('rule_only')

    // Switch to 投资决策 -> check prefer_rule_only notice, buy-gate + 429 recovery + pending disable + bounds + cap hint.
    fireEvent.click(screen.getByRole('tab', { name: '投资决策' }))
    expect(
      await screen.findByText('全局偏好已设为仅纯规则，当前免费零消耗运行'),
    ).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('投资理由'), {
      target: { value: '测试买入前理性安检门并发与429恢复' },
    })
    fireEvent.change(screen.getByLabelText('否证条件'), {
      target: { value: '测试否证条件' },
    })
    fireEvent.click(screen.getByRole('button', { name: '智能推演 (auto)' }))
    fireEvent.click(screen.getByRole('button', { name: '记录决策' }))

    expect(await screen.findByRole('region', { name: '买入前理性安检门确认' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '先运行反方质询' }))

    // On 429: buy gate stays open; editing reason clears stale DA error cleanly.
    expect(await screen.findByRole('alert')).toHaveTextContent('今日平台 AI 额度已用完（5/5）')
    expect(screen.getByRole('region', { name: '买入前理性安检门确认' })).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('投资理由'), {
      target: { value: '调整后的买入理由，验证429错误清除与1-click重试' },
    })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '记录决策' }))
    expect(await screen.findByRole('region', { name: '买入前理性安检门确认' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '先运行反方质询' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('今日平台 AI 额度已用完（5/5）')

    fireEvent.click(screen.getByRole('button', { name: '切换纯规则引擎并重试' }))

    // While pending, submit buttons are disabled to prevent racing onto a cleared form.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '质询运行中...' })).toBeDisabled()
    })
    expect(screen.getByRole('button', { name: '跳过质询，直接提交' })).toBeDisabled()

    resolvePendingDa(jsonResponse(daFallbackChallengeResponse, 200))

    // Non-multi-period pb_percentile renders periods=1 in preview and adopts canonical pb_percentile_10y with periods=1.
    expect(await screen.findByText('建议红线：10年PB分位 ≥ 85%（连续 1 期）')).toBeInTheDocument()
    expect(
      screen.getByText('当前由本地确定性规则引擎生成（零 AI 额度消耗，免费使用）'),
    ).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: '买入前理性安检门确认' })).not.toBeInTheDocument()
    expect(daRequests[2]?.mode).toBe('rule_only')

    const adoptPbBtn = screen.getByRole('button', { name: '采纳第 1 条建议红线' })
    fireEvent.click(adoptPbBtn)
    expect(screen.getByLabelText('规则 1 指标')).toHaveValue('pb_percentile_10y')
    expect(screen.getByLabelText('规则 1 连续期数')).toHaveValue(1)
    expect(screen.getByLabelText('规则 1 连续期数')).toBeDisabled()
    expect(adoptPbBtn).toBeDisabled()

    // Add 4 more rules to hit MAX_FALSIFY_RULES=5 and verify >1e12 revenue + periods=40 + inline cap hint!
    fireEvent.click(screen.getByRole('button', { name: '+ 自定义规则' }))
    fireEvent.change(screen.getByLabelText('规则 2 指标'), { target: { value: 'revenue_yuan' } })
    fireEvent.change(screen.getByLabelText('规则 2 阈值'), { target: { value: '2500000000000' } })
    fireEvent.change(screen.getByLabelText('规则 2 连续期数'), { target: { value: '40' } })
    fireEvent.click(screen.getByRole('button', { name: '+ CT红灯≥1' }))
    fireEvent.click(screen.getByRole('button', { name: '+ PE分位≥85%' }))
    fireEvent.click(screen.getByRole('button', { name: '+ ROE<12%' }))

    expect(screen.getByText('已达 5 条红线上限')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '记录决策' }))
    await waitFor(() => {
      expect(journalCreates).toHaveLength(1)
    })
    expect(journalCreates[0]?.falsify_rules?.[0]).toEqual({
      metric: 'pb_percentile_10y',
      op: 'gte',
      value: 85,
      periods: 1,
    })
    expect(journalCreates[0]?.falsify_rules?.[1]).toEqual({
      metric: 'revenue_yuan',
      op: 'gte',
      value: 2.5e12,
      periods: 40,
    })

    // Submitting journal clears cached DA results for the next decision.
    expect(screen.queryByText('#1 PB分位过高提醒')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: '估值' }))
    fireEvent.click(screen.getByRole('tab', { name: '投资决策' }))
    expect(screen.queryByText('#1 PB分位过高提醒')).not.toBeInTheDocument()
  })

  it('annotates current-year partial shareholder return series with (年内) label and YTD note', async () => {
    const partialYearSnapshot: StockSnapshotPayload = {
      ...SAMPLE_SNAPSHOT,
      as_of: '2026-11-20',
      shareholder_return: {
        ...SAMPLE_SNAPSHOT.shareholder_return,
        series: [
          ...SAMPLE_SNAPSHOT.shareholder_return.series,
          {
            year: 2026,
            dividend_yuan: 3.1e10,
            repurchase_yuan: 1.5e9,
            equity_financing_yuan: 0,
            net_return_yuan: 3.25e10,
            fcf_yuan: 4.5e10,
          },
        ],
      },
    }

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const pathname = new URL(asRequest(input).url).pathname
      if (pathname === '/api/auth/refresh') {
        return Promise.resolve(jsonResponse({ detail: '未登录' }, 401))
      }
      if (pathname === '/api/stocks/600519') {
        return Promise.resolve(jsonResponse(SAMPLE_STOCK, 200))
      }
      if (pathname === '/api/stocks/600519/snapshot') {
        return Promise.resolve(jsonResponse(partialYearSnapshot, 200))
      }
      return Promise.resolve(jsonResponse({ detail: `Unhandled ${pathname}` }, 500))
    })

    renderStockPage('/stock/600519')
    fireEvent.click(await screen.findByRole('tab', { name: '治理' }))

    expect(
      await screen.findByText('含本年度截至目前公告的分红/回购进度，年度尚未收官'),
    ).toBeInTheDocument()
    expect(screen.getByText('2026(年内)')).toBeInTheDocument()

    const governanceChart = capturedChartOptions.get('股东净回报柱状图')
    expect(governanceChart?.xAxis).toMatchObject({
      data: ['2024', '2025', '2026(年内)'],
    })
  })
})
