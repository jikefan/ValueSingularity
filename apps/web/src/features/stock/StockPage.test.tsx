import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ScoreRing } from '../../components/ui/ScoreRing'
import { AuthProvider } from '../../lib/AuthProvider'
import { setAccessToken } from '../../lib/api'
import { createQueryClient } from '../../lib/queryClient'
import type {
  JournalCreate,
  JournalEntryItem,
  StockDetail,
  StockSnapshotPayload,
  TokenResponse,
  UserProfile,
  WatchlistItem,
  WatchlistUpsert,
} from '../../types/api'
import { StockPage } from './StockPage'

vi.mock('../../lib/charts', () => ({
  Chart: ({ ariaLabel }: { ariaLabel?: string }) => <div role="img" aria-label={ariaLabel} />,
}))

const SAMPLE_USER: UserProfile = {
  id: '33333333-3333-3333-3333-333333333333',
  email: 'stock@example.com',
  phone: null,
  display_name: '护城河研究员',
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

    const tabs = screen.getAllByRole('tab')
    expect(tabs).toHaveLength(9)

    expect(await screen.findByRole('img', { name: '五维评分雷达图' })).toBeInTheDocument()
    expect(screen.getByText('综合评分 89 / 100')).toBeInTheDocument()
    expect(screen.getByText('高端白酒商务消费景气度受宏观周期影响。')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: '财务分析' }))
    expect(await screen.findByRole('img', { name: '十年财务趋势图' })).toBeInTheDocument()
    expect(screen.getByText('1,740.00')).toBeInTheDocument()
    expect(screen.getByText('32.50%')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: '护城河' }))
    expect(await screen.findByText('定价权与毛利率护城河')).toBeInTheDocument()
    expect(screen.getByText('34.60%')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: '估值' }))
    expect(await screen.findByRole('img', { name: '历史估值走势图' })).toBeInTheDocument()
    expect(screen.getByText('Reverse DCF 逆向估值反推器')).toBeInTheDocument()
    expect(screen.getAllByText('+8.42%')).toHaveLength(2)
    expect(screen.getByText('+14.80%')).toBeInTheDocument()
    expect(screen.getByText('-6.38%')).toBeInTheDocument()
    expect(screen.getByText('+11.10%').closest('td')).toBeInTheDocument()
    expect(screen.getByText(/不输出主观目标价/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: '增长引擎' }))
    expect(await screen.findByRole('img', { name: '盈利能力与研发投入趋势图' })).toBeInTheDocument()
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
    expect(screen.getByText('现金回馈充裕')).toBeInTheDocument()
    expect(screen.getByText('1.32x')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: '风险排雷' }))
    expect(await screen.findByText('存贷双高扫描')).toBeInTheDocument()
    expect(screen.getByText('应收与存货膨胀')).toBeInTheDocument()
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
    fireEvent.click(addWatchlistBtn)

    expect(await screen.findByText('已在自选')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '前往配置哨兵' })).toHaveAttribute('href', '/me')
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

  it('shows 已在自选 badge and sentinel link without firing PUT or POST when stock is already in watchlist', async () => {
    let writeCalled = false
    const configuredItem: WatchlistItem = {
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
    }

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
        return Promise.resolve(jsonResponse([configuredItem], 200))
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

    expect(await screen.findByText('已在自选')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '前往配置哨兵' })).toHaveAttribute('href', '/me')
    expect(screen.queryByRole('button', { name: '加入自选愿望单' })).not.toBeInTheDocument()
    expect(writeCalled).toBe(false)
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
})
