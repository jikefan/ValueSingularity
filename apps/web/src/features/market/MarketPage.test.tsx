import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChartOption } from '../../lib/charts'
import { CHART_COLORS, LIGHT_CHART_COLORS } from '../../lib/chartTheme'
import { createQueryClient } from '../../lib/queryClient'
import type {
  MarketDiscoveryResponse,
  MarketOverview,
  StockScreenerItem,
  StockScreenerResponse,
} from '../../types/api'
import { MarketPage } from './MarketPage'

const capturedChartOptions = new Map<string, ChartOption>()
let latestChartDatumClick: ((params: { name: string }) => void) | undefined

vi.mock('../../lib/charts', () => ({
  Chart: ({
    ariaLabel,
    option,
    onDatumClick,
  }: {
    ariaLabel?: string
    option: ChartOption
    onDatumClick?: (params: { name: string }) => void
  }) => {
    if (ariaLabel) {
      capturedChartOptions.set(ariaLabel, option)
    }
    latestChartDatumClick = onDatumClick
    return <div role="img" aria-label={ariaLabel} />
  },
}))

const SAMPLE_OVERVIEW: MarketOverview = {
  schema_version: 1,
  as_of: '2026-11-18',
  data_source: 'akshare',
  generated_at: '2026-11-18T10:00:00Z',
  indices: [
    { code: '000001', name: '上证指数', price: 3218.42, change_pct: 0.62 },
    { code: '399001', name: '深证成指', price: 10142.07, change_pct: 0.91 },
  ],
  temperature: {
    score: 38.0,
    level: 'cool',
    pe_median: 24.6,
    pe_percentile: 31.0,
    bond_yield: 2.18,
    equity_bond_spread: 1.89,
    comment: '估值处于近十年偏低区间，股债性价比偏向股票。',
  },
  hot_industries: [
    { name: '食品饮料', change_pct: 2.41, net_inflow: 3.12e9, companies: 168 },
    { name: '银行', change_pct: -0.35, net_inflow: -6.1e8, companies: 42 },
  ],
}

const SAMPLE_DISCOVERY: MarketDiscoveryResponse = {
  as_of: '2026-11-24',
  generated_at: '2026-11-24T10:00:00Z',
  synced_stock_count: 6,
  temperature: SAMPLE_OVERVIEW.temperature,
  cross_asset: {
    as_of: '2026-11-24',
    us_2y_yield: 4.18,
    us_2y_change_20d_bps: -18,
    us_10y_yield: 4.31,
    us_10y_change_20d_bps: -9,
    us_10y_2y_spread: 0.13,
    cn_10y_yield: 2.1,
    us_cn_10y_spread: 2.21,
    us_cpi_yoy: 2.6,
    us_real_yield_proxy_pct: 1.71,
    gold_symbol: 'Au99.99',
    gold_price_cny: 615.4,
    gold_change_5d_pct: 1.8,
    gold_change_20d_pct: 4.5,
    gold_percentile_1y: 82.0,
    gold_etf_tonnes: 879.5,
    gold_etf_delta_tonnes: 4.3,
    style_indices: [
      {
        code: 'sh000688',
        name: '科创50',
        market: 'A',
        style: 'tech',
        close: 960.2,
        change_1d_pct: -1.4,
        change_5d_pct: -4.2,
        change_20d_pct: -7.5,
        drawdown_60d_pct: -14.2,
      },
      {
        code: 'sz399006',
        name: '创业板指',
        market: 'A',
        style: 'tech',
        close: 2120.5,
        change_1d_pct: -0.9,
        change_5d_pct: -2.8,
        change_20d_pct: -5.5,
        drawdown_60d_pct: -10.4,
      },
      {
        code: '.IXIC',
        name: '纳斯达克',
        market: 'US',
        style: 'tech',
        close: 18640.0,
        change_1d_pct: -0.5,
        change_5d_pct: -1.3,
        change_20d_pct: -2.0,
        drawdown_60d_pct: -6.1,
      },
      {
        code: 'sh000015',
        name: '上证红利',
        market: 'A',
        style: 'dividend',
        close: 2945.1,
        change_1d_pct: 0.6,
        change_5d_pct: 1.9,
        change_20d_pct: 3.5,
        drawdown_60d_pct: -1.8,
      },
    ],
    warnings: [],
  },
  themes: [
    {
      theme_id: 'gold_fed_cycle',
      title: '美联储政策预期 × 黄金配置赔率',
      subtitle: '以美债 2Y 政策利率锚、实际利率与 SPDR 持仓验证黄金避险与货币周期赔率',
      signal: 'green',
      verdict: '宽松酝酿·赔率占优',
      regime_summary: '2Y 美债 4.18%（20日 -18.0bps），黄金配置赔率占优。',
      metrics: [
        { label: '美债 2Y / 20D变动', value_text: '4.18% (-18.0bps)', tone: 'green' },
        { label: '美国实际利率代理', value_text: '1.71%', tone: 'yellow' },
      ],
      picks: [
        {
          code: '600547',
          name: '山东黄金',
          industry_sw1: '有色金属',
          close: 26.8,
          pe_ttm: 24.5,
          pe_percentile_10y: 32.0,
          roe_5y_avg_pct: 11.4,
          dividend_yield_pct: 1.4,
          ct_red_count: 0,
          total_score: 76,
          is_financial: false,
          earnings_quality_tag: 'balanced_steady',
          earnings_quality_label: '盈利结构稳健均衡',
          reason: '黄金贵金属资源标的，ROE 11.4%，评分 76。',
        },
      ],
      caution_picks: [],
      compare_codes: ['600547'],
    },
    {
      theme_id: 'tech_vs_dividend_rotation',
      title: '科技成长回撤 × 红利避风港切换',
      subtitle: '跟踪科创50/创业板/纳斯达克回撤节奏与上证红利相对国债利差',
      signal: 'green',
      verdict: '科技成长回撤·红利股债利差占优',
      regime_summary: '科创50/创业板/纳指近60日最大回撤 -14.2%，上证红利相对科技占优。',
      metrics: [
        { label: '科创50 60D回撤 / 20D', value_text: '-14.2% / -7.5%', tone: 'yellow' },
        { label: '最高股息-国债利差', value_text: '+3.02%', tone: 'green' },
      ],
      picks: [
        {
          code: '600036',
          name: '招商银行',
          industry_sw1: '银行',
          close: 38.5,
          pe_ttm: 6.4,
          pe_percentile_10y: 42.0,
          roe_5y_avg_pct: 15.6,
          dividend_yield_pct: 5.12,
          dividend_spread_over_bond_pct: 3.02,
          ct_red_count: 0,
          total_score: 84,
          is_financial: true,
          earnings_quality_tag: 'financial_special',
          earnings_quality_label: '金融特殊结构',
          reason: '股息率 5.12%（较十年国债 +3.02%），金融分红稳健，CT 零红灯。',
        },
        {
          code: '000333',
          name: '美的集团',
          industry_sw1: '家用电器',
          close: 72.1,
          pe_ttm: 13.8,
          pe_percentile_10y: 28.4,
          roe_5y_avg_pct: 25.1,
          dividend_yield_pct: 4.2,
          dividend_spread_over_bond_pct: 2.1,
          ct_red_count: 0,
          total_score: 82,
          is_financial: false,
          earnings_quality_tag: 'core_cash_cow',
          earnings_quality_label: '主业造血现金牛',
          invest_profit_share_3y_pct: 4.1,
          reason: '股息率 4.20%（较十年国债 +2.10%），FCF 覆盖 1.25x，CT 零红灯。',
        },
      ],
      caution_picks: [],
      compare_codes: ['600036', '000333'],
    },
    {
      theme_id: 'earnings_quality_radar',
      title: '主业造血现金牛 vs 投资收益依赖排查',
      subtitle: '拆解营业利润中的主业经营、对外股权/证券投资收益与政府补助',
      signal: 'green',
      verdict: '识别 2 只主业现金牛 · 标红 1 只投资/补贴依赖',
      regime_summary: '剔除投资收益与公允价值变动干扰，识别表面低PE的价值陷阱。',
      metrics: [
        { label: '主业现金牛样本', value_text: '2 只', tone: 'green' },
        { label: '投资/补贴依赖预警', value_text: '1 只', tone: 'yellow' },
      ],
      picks: [
        {
          code: '600519',
          name: '贵州茅台',
          industry_sw1: '食品饮料',
          close: 1520.0,
          pe_ttm: 22.1,
          pe_percentile_10y: 26.5,
          roe_5y_avg_pct: 31.8,
          dividend_yield_pct: 3.66,
          ct_red_count: 0,
          total_score: 89,
          is_financial: false,
          earnings_quality_tag: 'core_cash_cow',
          earnings_quality_label: '主业造血现金牛',
          invest_profit_share_3y_pct: 1.4,
          reason: '主业造血现金牛：主业利润占比 98.2%、5年均值 ROE 31.8%。',
        },
      ],
      caution_picks: [
        {
          code: '600177',
          name: '雅戈尔',
          industry_sw1: '纺织服饰',
          close: 8.12,
          pe_ttm: 9.8,
          pe_percentile_10y: 24.0,
          roe_5y_avg_pct: 9.6,
          dividend_yield_pct: 5.4,
          ct_red_count: 1,
          total_score: 54,
          is_financial: false,
          earnings_quality_tag: 'investment_driven',
          earnings_quality_label: '盈利高度依赖对外投资',
          invest_profit_share_3y_pct: 68.4,
          investment_assets_ratio_pct: 52.1,
          reason:
            '盈利高度依赖对外投资：近3年投资收益占营业利润 68.4%，表内投资资产占总资产 52.1%。',
        },
      ],
      compare_codes: ['600519', '600177'],
    },
    {
      theme_id: 'deep_value_fortress',
      title: '高净现金与低估值安全边际',
      subtitle: '筛选 CT 零红灯、PE/PB 处于近十年低分位且具备净现金保护的标的',
      signal: 'green',
      verdict: '市场温度 38.0 · 深度价值安全边际充裕',
      regime_summary: '全市场 PE 中位数 24.60（历史 31.0% 分位），股债性价比 1.89%。',
      metrics: [
        { label: '市场温度 / 分位', value_text: '38.0 (31.0%)', tone: 'green' },
        { label: '深度价值候选', value_text: '2 只', tone: 'green' },
      ],
      picks: [
        {
          code: '000858',
          name: '五粮液',
          industry_sw1: '食品饮料',
          close: 145.0,
          pe_ttm: 17.5,
          pe_percentile_10y: 19.0,
          roe_5y_avg_pct: 24.5,
          dividend_yield_pct: 3.9,
          net_cash_to_mv_pct: 26.8,
          ct_red_count: 0,
          total_score: 86,
          is_financial: false,
          earnings_quality_tag: 'core_cash_cow',
          earnings_quality_label: '主业造血现金牛',
          reason: 'PE 10年分位 19.0%，净现金/市值 26.8%，CT 零红灯。',
        },
      ],
      caution_picks: [],
      compare_codes: ['000858', '000333'],
    },
  ],
  candidate_buckets: {
    dividend_fortresses: [],
    gold_resources: [],
    core_cash_cows: [],
    investment_cautions: [],
    deep_value: [],
  },
}

const SCREENER_ITEMS: StockScreenerItem[] = [
  {
    code: '600519',
    name: '贵州茅台',
    exchange: 'SH',
    industry_sw1: '食品饮料',
    as_of: '2026-11-18',
    close: 1520,
    total_mv_yuan: 1.91e12,
    pe_ttm: 22.1,
    pe_percentile_10y: 26.5,
    pb: 7.8,
    pb_percentile_10y: 22.0,
    roe_5y_avg_pct: 31.8,
    dividend_yield_pct: 3.66,
    shareholder_yield_pct: 3.66,
    implied_fcf_cagr_pct: 8.4,
    ct_red_count: 0,
    ct_yellow_count: 1,
    ct_green_count: 10,
    total_score: 89,
    valuation_margin: 74,
    is_financial: false,
    earnings_quality_tag: 'core_cash_cow',
    earnings_quality_label: '主业造血现金牛',
    invest_profit_share_3y_pct: 1.4,
    investment_assets_ratio_pct: 2.8,
  },
  {
    code: '000858',
    name: '五粮液',
    exchange: 'SZ',
    industry_sw1: '食品饮料',
    as_of: '2026-11-18',
    close: 145,
    total_mv_yuan: 5.6e11,
    pe_ttm: 17.5,
    pe_percentile_10y: 19.0,
    pb: 4.1,
    pb_percentile_10y: 18.0,
    roe_5y_avg_pct: 24.5,
    dividend_yield_pct: 3.9,
    shareholder_yield_pct: 4.1,
    implied_fcf_cagr_pct: 5.2,
    ct_red_count: 0,
    ct_yellow_count: 0,
    ct_green_count: 11,
    total_score: 86,
    valuation_margin: 78,
    is_financial: false,
    earnings_quality_tag: 'core_cash_cow',
    earnings_quality_label: '主业造血现金牛',
    invest_profit_share_3y_pct: 2.1,
    investment_assets_ratio_pct: 3.5,
  },
  {
    code: '600036',
    name: '招商银行',
    exchange: 'SH',
    industry_sw1: '银行',
    as_of: '2026-11-18',
    close: 38.5,
    total_mv_yuan: 9.7e11,
    pe_ttm: 6.4,
    pe_percentile_10y: 42.0,
    pb: 0.92,
    pb_percentile_10y: 38.0,
    roe_5y_avg_pct: 15.6,
    dividend_yield_pct: 5.12,
    shareholder_yield_pct: 5.12,
    implied_fcf_cagr_pct: null,
    ct_red_count: 0,
    ct_yellow_count: 0,
    ct_green_count: 8,
    total_score: 84,
    valuation_margin: 80,
    is_financial: true,
    earnings_quality_tag: 'financial_special',
    earnings_quality_label: '金融特殊结构',
  },
  {
    code: '000333',
    name: '美的集团',
    exchange: 'SZ',
    industry_sw1: '家用电器',
    as_of: '2026-11-18',
    close: 72.1,
    total_mv_yuan: 5.5e11,
    pe_ttm: 13.8,
    pe_percentile_10y: 28.4,
    pb: 3.0,
    pb_percentile_10y: 35.0,
    roe_5y_avg_pct: 25.1,
    dividend_yield_pct: 4.2,
    shareholder_yield_pct: 4.8,
    implied_fcf_cagr_pct: 6.1,
    ct_red_count: 0,
    ct_yellow_count: 1,
    ct_green_count: 10,
    total_score: 82,
    valuation_margin: 75,
    is_financial: false,
    earnings_quality_tag: 'core_cash_cow',
    earnings_quality_label: '主业造血现金牛',
    invest_profit_share_3y_pct: 4.1,
    investment_assets_ratio_pct: 9.4,
  },
  {
    code: '002594',
    name: '比亚迪',
    exchange: 'SZ',
    industry_sw1: '汽车',
    as_of: '2026-11-18',
    close: 280.0,
    total_mv_yuan: 8.1e11,
    pe_ttm: 23.4,
    pe_percentile_10y: 44.0,
    pb: 4.9,
    pb_percentile_10y: 51.0,
    roe_5y_avg_pct: 19.2,
    dividend_yield_pct: 1.1,
    shareholder_yield_pct: 1.1,
    implied_fcf_cagr_pct: 11.4,
    ct_red_count: 0,
    ct_yellow_count: 2,
    ct_green_count: 9,
    total_score: 79,
    valuation_margin: 63,
    is_financial: false,
    earnings_quality_tag: 'balanced_steady',
    earnings_quality_label: '盈利结构稳健均衡',
    invest_profit_share_3y_pct: 3.5,
    investment_assets_ratio_pct: 7.2,
  },
  {
    code: '601012',
    name: '隆基绿能',
    exchange: 'SH',
    industry_sw1: '电力设备',
    as_of: '2026-11-18',
    close: 18.2,
    total_mv_yuan: 1.38e11,
    pe_ttm: 29.0,
    pe_percentile_10y: 65.0,
    pb: 1.9,
    pb_percentile_10y: 25.0,
    roe_5y_avg_pct: 12.1,
    dividend_yield_pct: 0.8,
    shareholder_yield_pct: 0.8,
    implied_fcf_cagr_pct: 14.0,
    ct_red_count: 2,
    ct_yellow_count: 1,
    ct_green_count: 7,
    total_score: 62,
    valuation_margin: 48,
    is_financial: false,
    earnings_quality_tag: 'cashflow_divergent',
    earnings_quality_label: '现金转化偏弱或利息负担偏重',
    invest_profit_share_3y_pct: 11.0,
    investment_assets_ratio_pct: 14.2,
  },
]

function filterScreenerResponse(url: URL, items = SCREENER_ITEMS): StockScreenerResponse {
  const zeroRed = url.searchParams.get('zero_red_only') === 'true'
  const maxPeRaw = url.searchParams.get('max_pe_percentile')
  const minRoeRaw = url.searchParams.get('min_roe')
  const minDivRaw = url.searchParams.get('min_dividend_yield')
  const qualityFilter = url.searchParams.get('quality_filter')
  const industry = url.searchParams.get('industry') ?? ''
  const q = (url.searchParams.get('q') ?? '').trim().toLowerCase()
  const sortBy = (url.searchParams.get('sort_by') ?? 'total_score') as keyof StockScreenerItem
  const sortDir = url.searchParams.get('sort_dir') === 'asc' ? 'asc' : 'desc'

  const filtered = items.filter((item) => {
    if (zeroRed && item.ct_red_count > 0) return false
    if (qualityFilter === 'core_only' && item.earnings_quality_tag !== 'core_cash_cow') {
      return false
    }
    if (
      qualityFilter === 'hide_investment_heavy' &&
      (item.earnings_quality_tag === 'investment_driven' ||
        item.earnings_quality_tag === 'subsidy_inflated' ||
        (item.invest_profit_share_3y_pct !== null &&
          item.invest_profit_share_3y_pct !== undefined &&
          item.invest_profit_share_3y_pct >= 25))
    ) {
      return false
    }
    if (
      qualityFilter === 'dividend_fortress' &&
      (item.ct_red_count > 0 ||
        item.dividend_yield_pct === null ||
        item.dividend_yield_pct === undefined ||
        item.dividend_yield_pct < 3.0 ||
        item.earnings_quality_tag === 'investment_driven' ||
        item.earnings_quality_tag === 'subsidy_inflated')
    ) {
      return false
    }
    if (
      maxPeRaw !== null &&
      (item.pe_percentile_10y === null ||
        item.pe_percentile_10y === undefined ||
        item.pe_percentile_10y > Number(maxPeRaw))
    ) {
      return false
    }
    if (
      minRoeRaw !== null &&
      (item.roe_5y_avg_pct === null ||
        item.roe_5y_avg_pct === undefined ||
        item.roe_5y_avg_pct < Number(minRoeRaw))
    ) {
      return false
    }
    if (
      minDivRaw !== null &&
      (item.dividend_yield_pct === null ||
        item.dividend_yield_pct === undefined ||
        item.dividend_yield_pct < Number(minDivRaw))
    ) {
      return false
    }
    if (industry && item.industry_sw1 !== industry) return false
    if (q && !item.code.toLowerCase().includes(q) && !item.name.toLowerCase().includes(q))
      return false
    return true
  })

  filtered.sort((a, b) => {
    const av = Number(a[sortBy] ?? -Infinity)
    const bv = Number(b[sortBy] ?? -Infinity)
    return sortDir === 'asc' ? av - bv : bv - av
  })

  return {
    total_synced: items.length,
    filtered_count: filtered.length,
    industries: Array.from(
      new Set(items.map((item) => item.industry_sw1).filter(Boolean) as string[]),
    ),
    items: filtered,
  }
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

function CompareEcho() {
  const location = useLocation()
  return <div>{`对比页 ${location.search}`}</div>
}

function renderMarketPage() {
  const client = createQueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<MarketPage />} />
          <Route path="/stock/:code" element={<div>个股详情页</div>} />
          <Route path="/compare" element={<CompareEcho />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('MarketPage', () => {
  afterEach(() => {
    cleanup()
    capturedChartOptions.clear()
    latestChartDatumClick = undefined
    vi.restoreAllMocks()
    delete document.documentElement.dataset.theme
    window.localStorage.clear()
  })

  it('renders onboarding workflow, dynamic synced quick-picks, A-share flow colors, and screener discovery deck', async () => {
    const requestedUrls: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = new URL(asRequest(input).url)
      requestedUrls.push(`${url.pathname}${url.search}`)
      if (url.pathname === '/api/market/overview') {
        return Promise.resolve(jsonResponse(SAMPLE_OVERVIEW))
      }
      if (url.pathname === '/api/market/discovery') {
        return Promise.resolve(jsonResponse(SAMPLE_DISCOVERY))
      }
      if (url.pathname === '/api/stocks/screener') {
        return Promise.resolve(jsonResponse(filterScreenerResponse(url)))
      }
      return Promise.resolve(jsonResponse({ detail: `Unhandled ${url.pathname}` }, 500))
    })

    renderMarketPage()

    expect(await screen.findByText('上证指数')).toBeInTheDocument()
    expect(screen.getByText('三步价值投资工作流')).toBeInTheDocument()
    expect(screen.getByText('价值击球区精选雷达')).toBeInTheDocument()

    // Quick-access chips come from synced screener pool with industry diversity, never hardcoded 300750.
    const quickGroup = await screen.findByRole('group', { name: '精选已同步示例标的' })
    expect(quickGroup).toHaveClass('sample-stock-row-scroll')
    expect(within(quickGroup).getByRole('link', { name: /600519.*贵州茅台/ })).toHaveAttribute(
      'href',
      '/stock/600519',
    )
    expect(within(quickGroup).getByRole('link', { name: /600036.*招商银行/ })).toBeInTheDocument()
    expect(within(quickGroup).getByRole('link', { name: /000333.*美的集团/ })).toBeInTheDocument()
    expect(within(quickGroup).getByRole('link', { name: /002594.*比亚迪/ })).toBeInTheDocument()
    expect(within(quickGroup).queryByText('300750')).not.toBeInTheDocument()

    // Section hierarchy: 市场温度 appears above DiscoveryBoard, which appears above 行业资金流 and ScreenerSection.
    const tempHeading = screen.getByText('市场温度')
    const discoveryRegion = screen.getByRole('region', { name: '价值奇点机会挖掘看板' })
    const flowHeading = screen.getByText('行业资金流（亿元）')
    const screenerRegion = screen.getByRole('region', { name: '价值击球区精选雷达' })
    expect(
      tempHeading.compareDocumentPosition(discoveryRegion) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(
      discoveryRegion.compareDocumentPosition(flowHeading) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(
      flowHeading.compareDocumentPosition(screenerRegion) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(screen.getByText(/全市场估值比历史上 69% 的时候都便宜/)).toBeInTheDocument()

    const flowOption = capturedChartOptions.get('行业净流入柱状图')
    expect(flowOption).toBeDefined()
    expect(flowOption?.yAxis).toMatchObject({
      type: 'category',
      inverse: true,
      data: ['食品饮料', '银行'],
    })
    expect(flowOption?.series).toMatchObject([
      {
        type: 'bar',
        data: [
          {
            value: 31.2,
            itemStyle: { color: CHART_COLORS.flowIn, borderRadius: [0, 6, 6, 0] },
          },
          {
            value: -6.1,
            itemStyle: { color: CHART_COLORS.flowOut, borderRadius: [6, 0, 0, 6] },
          },
        ],
      },
    ])

    // Top 3 tk-card strip and pro-table render screener items cleanly.
    const topStrip = screen.getByLabelText('精选候选前三名')
    expect(within(topStrip).getByText('贵州茅台')).toBeInTheDocument()
    expect(within(topStrip).getByText('五粮液')).toBeInTheDocument()
    expect(within(topStrip).getByText('招商银行')).toBeInTheDocument()

    const screenerTable = screen.getByRole('table', { name: '价值筛选结果明细表' })
    expect(within(screenerTable).getByText('隆基绿能')).toBeInTheDocument()

    // Deduplicated initial fetch: only one overview + one screener call.
    expect(requestedUrls.filter((u) => u.startsWith('/api/stocks/screener'))).toHaveLength(1)

    fireEvent.click(within(quickGroup).getByRole('link', { name: /600519.*贵州茅台/ }))
    expect(await screen.findByText('个股详情页')).toBeInTheDocument()
  })

  it('keeps market temperature and indices visible even if screener fails (non-blocking)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = new URL(asRequest(input).url)
      if (url.pathname === '/api/market/overview') {
        return Promise.resolve(jsonResponse(SAMPLE_OVERVIEW))
      }
      if (url.pathname === '/api/market/discovery') {
        return Promise.resolve(jsonResponse(SAMPLE_DISCOVERY))
      }
      if (url.pathname === '/api/stocks/screener') {
        return Promise.resolve(jsonResponse({ detail: '雷达缓存构建中' }, 503))
      }
      return Promise.resolve(jsonResponse({ detail: `Unhandled ${url.pathname}` }, 500))
    })

    renderMarketPage()

    expect(await screen.findByText('上证指数')).toBeInTheDocument()
    expect(screen.getByText('3,218.42')).toBeInTheDocument()
    expect(await screen.findByText('精选雷达加载失败')).toBeInTheDocument()
    expect(screen.getByText('雷达缓存构建中')).toBeInTheDocument()
    expect(screen.getByText(/已同步标的池暂不可用/)).toBeInTheDocument()
  })

  it('supports screener filters, industry click-to-filter linkage, reset, and batch compare up to 5 stocks', async () => {
    const screenerCalls: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = new URL(asRequest(input).url)
      if (url.pathname === '/api/market/overview') {
        return Promise.resolve(jsonResponse(SAMPLE_OVERVIEW))
      }
      if (url.pathname === '/api/market/discovery') {
        return Promise.resolve(jsonResponse(SAMPLE_DISCOVERY))
      }
      if (url.pathname === '/api/stocks/screener') {
        screenerCalls.push(url.searchParams.toString())
        return Promise.resolve(jsonResponse(filterScreenerResponse(url)))
      }
      return Promise.resolve(jsonResponse({ detail: `Unhandled ${url.pathname}` }, 500))
    })

    renderMarketPage()
    const screenerDeck = await screen.findByRole('region', { name: '价值击球区精选雷达' })
    expect(await within(screenerDeck).findByLabelText('精选候选前三名')).toBeInTheDocument()

    // Toggle zero-red CT filter: 隆基绿能 (2 red) disappears from the screener deck.
    fireEvent.click(within(screenerDeck).getByRole('button', { name: '仅看零红灯' }))
    await waitFor(() => {
      expect(within(screenerDeck).queryByText('隆基绿能')).not.toBeInTheDocument()
    })

    // 5Y ROE >= 15%, PE 10Y < 30%, and dividend >= 4% narrows down to 美的集团 (28.4%, 4.2%).
    const roeGroup = within(screenerDeck).getByRole('group', { name: '5Y ROE' })
    fireEvent.click(within(roeGroup).getByRole('button', { name: '>= 15%' }))
    const peGroup = within(screenerDeck).getByRole('group', { name: 'PE 10Y 分位' })
    fireEvent.click(within(peGroup).getByRole('button', { name: '< 30%' }))
    const divGroup = within(screenerDeck).getByRole('group', { name: '股息率' })
    fireEvent.click(within(divGroup).getByRole('button', { name: '>= 4%' }))
    await waitFor(() => {
      expect(within(screenerDeck).getByText(/当前命中 1 支/)).toBeInTheDocument()
    })
    expect(
      within(within(screenerDeck).getByLabelText('精选候选前三名')).getByText('美的集团'),
    ).toBeInTheDocument()

    // Reset restores full synced pool.
    fireEvent.click(within(screenerDeck).getByRole('button', { name: '重置筛选' }))
    await waitFor(() => {
      expect(within(screenerDeck).getByText(/当前命中 6 支/)).toBeInTheDocument()
    })

    // Search input + Enter filters immediately; sort select + direction toggle updates order.
    const filterInput = within(screenerDeck).getByLabelText('筛选代码或名称')
    fireEvent.change(filterInput, { target: { value: '茅台' } })
    fireEvent.keyDown(filterInput, { key: 'Enter' })
    await waitFor(() => {
      expect(within(screenerDeck).getByText(/当前命中 1 支/)).toBeInTheDocument()
    })
    expect(
      within(within(screenerDeck).getByLabelText('精选候选前三名')).getByText('贵州茅台'),
    ).toBeInTheDocument()

    fireEvent.click(within(screenerDeck).getByRole('button', { name: '重置筛选' }))
    await waitFor(() => {
      expect(within(screenerDeck).getByText(/当前命中 6 支/)).toBeInTheDocument()
    })

    fireEvent.change(within(screenerDeck).getByLabelText('排序方式'), {
      target: { value: 'dividend_yield_pct' },
    })
    fireEvent.click(within(screenerDeck).getByRole('button', { name: '切换排序方向' }))
    await waitFor(() => {
      expect(screenerCalls.some((q) => q.includes('sort_by=dividend_yield_pct&sort_dir=asc'))).toBe(
        true,
      )
    })
    fireEvent.click(within(screenerDeck).getByRole('button', { name: '重置筛选' }))
    await waitFor(() => {
      expect(within(screenerDeck).getByText(/当前命中 6 支/)).toBeInTheDocument()
    })

    // Click industry in 净流入排行 table -> filters Screener table & shows clear pill.
    fireEvent.click(screen.getByRole('button', { name: '银行' }))
    await waitFor(() => {
      expect(within(screenerDeck).getByText(/当前命中 1 支/)).toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: '已筛选: 银行 ×' })).toBeInTheDocument()

    // Clicking ECharts bar datum switches industry filter to 食品饮料.
    latestChartDatumClick?.({ name: '食品饮料' })
    await waitFor(() => {
      expect(within(screenerDeck).getByText(/当前命中 2 支/)).toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: '已筛选: 食品饮料 ×' })).toBeInTheDocument()

    // Clear industry pill to select up to 5 stocks for batch compare.
    fireEvent.click(screen.getByRole('button', { name: '已筛选: 食品饮料 ×' }))
    await waitFor(() => {
      expect(within(screenerDeck).getByText(/当前命中 6 支/)).toBeInTheDocument()
    })

    const checkboxes = within(screenerDeck).getAllByRole('checkbox')
    expect(checkboxes).toHaveLength(6)
    for (let i = 0; i < 5; i += 1) {
      const box = checkboxes[i]
      if (box) fireEvent.click(box)
    }
    expect(checkboxes[5]).toBeDisabled()
    expect(within(screenerDeck).getByText('已选对比 5 / 5')).toBeInTheDocument()

    fireEvent.click(within(screenerDeck).getByRole('link', { name: '发起对比 (5)' }))
    expect(
      await screen.findByText('对比页 ?codes=600519,000858,600036,000333,002594'),
    ).toBeInTheDocument()
    expect(screenerCalls.some((q) => q.includes('zero_red_only=true'))).toBe(true)
  })

  it('renders ErrorBlock with backend detail on 503 and recovers after clicking retry', async () => {
    let overviewAttempts = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = new URL(asRequest(input).url)
      if (url.pathname === '/api/market/overview') {
        overviewAttempts += 1
        if (overviewAttempts === 1) {
          return Promise.resolve(jsonResponse({ detail: '数据库不可用: OperationalError' }, 503))
        }
        return Promise.resolve(jsonResponse(SAMPLE_OVERVIEW))
      }
      if (url.pathname === '/api/market/discovery') {
        return Promise.resolve(jsonResponse(SAMPLE_DISCOVERY))
      }
      if (url.pathname === '/api/stocks/screener') {
        return Promise.resolve(jsonResponse(filterScreenerResponse(url)))
      }
      return Promise.resolve(jsonResponse({ detail: `Unhandled ${url.pathname}` }, 500))
    })

    renderMarketPage()

    const errorHeading = await screen.findByText('行情加载失败')
    expect(errorHeading).toBeInTheDocument()
    expect(screen.getByText('数据库不可用: OperationalError')).toBeInTheDocument()

    const overviewCard = errorHeading.closest('section')
    if (!overviewCard) {
      throw new Error('Expected overview error card section')
    }
    fireEvent.click(within(overviewCard).getByRole('button', { name: '重试' }))

    expect(await screen.findByText('上证指数')).toBeInTheDocument()
    expect(screen.getAllByText('食品饮料').length).toBeGreaterThan(0)
  })

  it('keeps DiscoveryBoard and ScreenerSection visible and interactive when /api/market/overview returns 503', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = new URL(asRequest(input).url)
      if (url.pathname === '/api/market/overview') {
        return Promise.resolve(jsonResponse({ detail: '行情服务维护中' }, 503))
      }
      if (url.pathname === '/api/market/discovery') {
        return Promise.resolve(jsonResponse(SAMPLE_DISCOVERY))
      }
      if (url.pathname === '/api/stocks/screener') {
        return Promise.resolve(jsonResponse(filterScreenerResponse(url)))
      }
      return Promise.resolve(jsonResponse({ detail: `Unhandled ${url.pathname}` }, 500))
    })

    renderMarketPage()

    const errorHeading = await screen.findByText('行情加载失败')
    expect(errorHeading).toBeInTheDocument()
    expect(screen.getByText('行情服务维护中')).toBeInTheDocument()

    const discoveryBoard = await screen.findByRole('region', { name: '价值奇点机会挖掘看板' })
    expect(within(discoveryBoard).getByText('跨资产机会 · 财报排雷看板')).toBeInTheDocument()
    expect(await within(discoveryBoard).findByText('4.18%')).toBeInTheDocument()
    expect(within(discoveryBoard).getByRole('link', { name: '贵州茅台' })).toBeInTheDocument()

    const screenerDeck = screen.getByRole('region', { name: '价值击球区精选雷达' })
    const screenerTable = await within(screenerDeck).findByRole('table', {
      name: '价值筛选结果明细表',
    })
    expect(within(screenerTable).getByText('隆基绿能')).toBeInTheDocument()

    fireEvent.click(within(screenerDeck).getByRole('button', { name: '仅看零红灯' }))
    await waitFor(() => {
      expect(within(screenerDeck).queryByText('隆基绿能')).not.toBeInTheDocument()
    })
  })

  it('renders em dash when industry flow companies count is null', async () => {
    const overviewWithMissingCompanies: MarketOverview = {
      ...SAMPLE_OVERVIEW,
      hot_industries: [
        { name: '半导体', change_pct: 2.41, net_inflow: 3.12e9, companies: null },
        { name: '银行', change_pct: -0.35, net_inflow: -6.1e8, companies: 42 },
      ],
    }
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = new URL(asRequest(input).url)
      if (url.pathname === '/api/market/overview') {
        return Promise.resolve(jsonResponse(overviewWithMissingCompanies))
      }
      if (url.pathname === '/api/market/discovery') {
        return Promise.resolve(jsonResponse(SAMPLE_DISCOVERY))
      }
      if (url.pathname === '/api/stocks/screener') {
        return Promise.resolve(jsonResponse(filterScreenerResponse(url, [])))
      }
      return Promise.resolve(jsonResponse({ detail: `Unhandled ${url.pathname}` }, 500))
    })

    renderMarketPage()

    expect(await screen.findByText('半导体')).toBeInTheDocument()
    expect(screen.getByText('—')).toBeInTheDocument()
    expect(screen.getByText('42')).toBeInTheDocument()
  })

  it('updates industry flow chart option to LIGHT_CHART_COLORS when data-theme toggles to light', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = new URL(asRequest(input).url)
      if (url.pathname === '/api/market/overview') {
        return Promise.resolve(jsonResponse(SAMPLE_OVERVIEW))
      }
      if (url.pathname === '/api/market/discovery') {
        return Promise.resolve(jsonResponse(SAMPLE_DISCOVERY))
      }
      if (url.pathname === '/api/stocks/screener') {
        return Promise.resolve(jsonResponse(filterScreenerResponse(url)))
      }
      return Promise.resolve(jsonResponse({ detail: `Unhandled ${url.pathname}` }, 500))
    })

    renderMarketPage()
    expect(await screen.findByText('3,218.42')).toBeInTheDocument()

    document.documentElement.dataset.theme = 'light'

    await waitFor(() => {
      const flowOption = capturedChartOptions.get('行业净流入柱状图')
      expect(flowOption?.tooltip).toMatchObject({
        backgroundColor: LIGHT_CHART_COLORS.panel,
        borderColor: LIGHT_CHART_COLORS.axisLine,
      })
      expect(flowOption?.xAxis).toMatchObject({
        axisLine: { lineStyle: { color: LIGHT_CHART_COLORS.axisLine } },
      })
      expect(flowOption?.yAxis).toMatchObject({
        axisLabel: { color: LIGHT_CHART_COLORS.text },
      })
      expect(flowOption?.series).toMatchObject([
        {
          type: 'bar',
          data: [
            {
              value: 31.2,
              itemStyle: { color: LIGHT_CHART_COLORS.flowIn, borderRadius: [0, 6, 6, 0] },
            },
            {
              value: -6.1,
              itemStyle: { color: LIGHT_CHART_COLORS.flowOut, borderRadius: [6, 0, 0, 6] },
            },
          ],
        },
      ])
    })
  })

  it('renders cross-asset macro pulse strip, 4 discovery cards with style bars and caution picks, glossary hints, and one-click compare links', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = new URL(asRequest(input).url)
      if (url.pathname === '/api/market/overview') {
        return Promise.resolve(jsonResponse(SAMPLE_OVERVIEW))
      }
      if (url.pathname === '/api/market/discovery') {
        return Promise.resolve(jsonResponse(SAMPLE_DISCOVERY))
      }
      if (url.pathname === '/api/stocks/screener') {
        return Promise.resolve(jsonResponse(filterScreenerResponse(url)))
      }
      return Promise.resolve(jsonResponse({ detail: `Unhandled ${url.pathname}` }, 500))
    })

    renderMarketPage()

    const discoveryBoard = await screen.findByRole('region', { name: '价值奇点机会挖掘看板' })
    expect(within(discoveryBoard).getByText('跨资产机会 · 财报排雷看板')).toBeInTheDocument()
    expect(await within(discoveryBoard).findByText('已追踪 6 支深度快照')).toBeInTheDocument()

    // Macro pulse strip verifies US 2Y, real yield, spread, Au99.99 + SPDR, and style rotation diff.
    const pulseStrip = await within(discoveryBoard).findByRole('region', {
      name: '跨资产宏观脉搏',
    })
    expect(within(pulseStrip).getByText('4.18%')).toBeInTheDocument()
    expect(within(pulseStrip).getByText('近20日 -18 bps')).toBeInTheDocument()
    expect(within(pulseStrip).getByText(/100 基点\(bps\)=1%/)).toBeInTheDocument()
    expect(within(pulseStrip).getByText('1.71%')).toBeInTheDocument()
    expect(within(pulseStrip).getByText('615.40 元/克')).toBeInTheDocument()
    expect(within(pulseStrip).getByText(/879\.5t \(\+4\.3t\)/)).toBeInTheDocument()
    expect(within(pulseStrip).getByText('红利 +8.5%')).toBeInTheDocument()
    expect(within(pulseStrip).getByText(/科创50 \/ 创业板 vs 上证红利/)).toBeInTheDocument()

    // Glossary hints open for discovery board & macro indicators.
    fireEvent.click(
      within(discoveryBoard).getByRole('button', { name: '解释：跨资产发现与风格轮动面板' }),
    )
    expect(screen.getByRole('tooltip')).toHaveTextContent('美债利率锚')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()

    fireEvent.click(within(pulseStrip).getByRole('button', { name: '解释：中美 10Y 国债利差' }))
    expect(screen.getByRole('tooltip')).toHaveTextContent('美国 10 年期国债收益率')
    fireEvent.keyDown(document, { key: 'Escape' })

    // Style rotation card displays style index bars.
    const rotationCard = within(discoveryBoard).getByRole('article', {
      name: '科技成长回撤 × 红利避风港切换',
    })
    const styleBars = within(rotationCard).getByLabelText('风格指数近20日涨跌与60日回撤')
    expect(within(styleBars).getByText('科创50')).toBeInTheDocument()
    expect(within(styleBars).getByText('上证红利')).toBeInTheDocument()
    expect(within(styleBars).getByText('纳斯达克')).toBeInTheDocument()
    expect(within(styleBars).getByText(/20D -7\.5% · 60D回撤 -14\.2%/)).toBeInTheDocument()

    // Earnings quality radar displays core pick and red-toned caution strip for 600177 雅戈尔.
    const qualityCard = within(discoveryBoard).getByRole('article', {
      name: '主业造血现金牛 vs 投资收益依赖排查',
    })
    const cautionRegion = within(qualityCard).getByRole('region', {
      name: '高投资收益依赖 / 盈利失真警示标的',
    })
    expect(cautionRegion).toHaveClass('discovery-caution-strip', 'discovery-caution-strip-red')
    expect(within(cautionRegion).getByRole('link', { name: '雅戈尔' })).toHaveAttribute(
      'href',
      '/stock/600177',
    )
    expect(within(cautionRegion).getByText('盈利高度依赖对外投资')).toHaveClass(
      'quality-badge',
      'quality-badge-red',
    )

    // One-click compare link navigates cleanly with compare_codes.
    const compareLink = within(qualityCard).getByRole('link', { name: '一键同池对比 (2)' })
    expect(compareLink).toHaveAttribute('href', '/compare?codes=600519,600177')
    fireEvent.click(compareLink)
    expect(await screen.findByText('对比页 ?codes=600519,600177')).toBeInTheDocument()
  })

  it('keeps market overview and screener operational when /api/market/discovery fails (non-blocking), and handles null cross_asset', async () => {
    let discoveryAttempts = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = new URL(asRequest(input).url)
      if (url.pathname === '/api/market/overview') {
        return Promise.resolve(jsonResponse(SAMPLE_OVERVIEW))
      }
      if (url.pathname === '/api/market/discovery') {
        discoveryAttempts += 1
        if (discoveryAttempts === 1) {
          return Promise.resolve(jsonResponse({ detail: '跨资产接口超时' }, 500))
        }
        return Promise.resolve(
          jsonResponse({
            ...SAMPLE_DISCOVERY,
            cross_asset: null,
          }),
        )
      }
      if (url.pathname === '/api/stocks/screener') {
        return Promise.resolve(jsonResponse(filterScreenerResponse(url)))
      }
      return Promise.resolve(jsonResponse({ detail: `Unhandled ${url.pathname}` }, 500))
    })

    renderMarketPage()

    expect(await screen.findByText('上证指数')).toBeInTheDocument()
    expect(screen.getByText('价值击球区精选雷达')).toBeInTheDocument()

    const discoveryBoard = screen.getByRole('region', { name: '价值奇点机会挖掘看板' })
    expect(await within(discoveryBoard).findByText('跨资产发现看板暂不可用')).toBeInTheDocument()
    expect(within(discoveryBoard).getByText('跨资产接口超时')).toBeInTheDocument()

    // Retry recovers cleanly even when cross_asset is null.
    fireEvent.click(within(discoveryBoard).getByRole('button', { name: '重试' }))
    expect(await within(discoveryBoard).findByText('已追踪 6 支深度快照')).toBeInTheDocument()
    expect(within(discoveryBoard).getByText('近20日 —')).toBeInTheDocument()
  })

  it('supports screener quality_filter segmented tabs, discovery quick filter jump, and quality badges in top cards & table', async () => {
    const youngorItem: StockScreenerItem = {
      code: '600177',
      name: '雅戈尔',
      exchange: 'SH',
      industry_sw1: '纺织服饰',
      as_of: '2026-11-18',
      close: 8.12,
      total_mv_yuan: 3.75e10,
      pe_ttm: 9.8,
      pe_percentile_10y: 24.0,
      pb: 0.94,
      pb_percentile_10y: 28.0,
      roe_5y_avg_pct: 9.6,
      dividend_yield_pct: 5.4,
      shareholder_yield_pct: 5.4,
      implied_fcf_cagr_pct: 3.1,
      ct_red_count: 1,
      ct_yellow_count: 1,
      ct_green_count: 8,
      total_score: 54,
      valuation_margin: 62,
      is_financial: false,
      earnings_quality_tag: 'investment_driven',
      earnings_quality_label: '盈利高度依赖对外投资',
      invest_profit_share_3y_pct: 68.4,
      investment_assets_ratio_pct: 52.1,
    }
    const legacyNoQualityItem: StockScreenerItem = {
      code: '000002',
      name: '旧快照样本',
      exchange: 'SZ',
      industry_sw1: '房地产',
      as_of: '2026-11-18',
      close: 7.5,
      total_mv_yuan: 8.2e10,
      pe_ttm: 11.2,
      pe_percentile_10y: 18.0,
      pb: 0.65,
      pb_percentile_10y: 15.0,
      roe_5y_avg_pct: 8.4,
      dividend_yield_pct: 0.0,
      shareholder_yield_pct: 0.0,
      implied_fcf_cagr_pct: null,
      ct_red_count: 1,
      ct_yellow_count: 0,
      ct_green_count: 8,
      total_score: 48,
      valuation_margin: 55,
      is_financial: false,
    }
    const customItems: StockScreenerItem[] = [...SCREENER_ITEMS, youngorItem, legacyNoQualityItem]
    const screenerQueries: string[] = []

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = new URL(asRequest(input).url)
      if (url.pathname === '/api/market/overview') {
        return Promise.resolve(jsonResponse(SAMPLE_OVERVIEW))
      }
      if (url.pathname === '/api/market/discovery') {
        return Promise.resolve(jsonResponse(SAMPLE_DISCOVERY))
      }
      if (url.pathname === '/api/stocks/screener') {
        screenerQueries.push(url.searchParams.toString())
        return Promise.resolve(jsonResponse(filterScreenerResponse(url, customItems)))
      }
      return Promise.resolve(jsonResponse({ detail: `Unhandled ${url.pathname}` }, 500))
    })

    renderMarketPage()

    const screenerDeck = await screen.findByRole('region', { name: '价值击球区精选雷达' })
    const screenerTable = await within(screenerDeck).findByRole('table', {
      name: '价值筛选结果明细表',
    })

    // Top 3 candidate cards and table display quality badges + investment share + fallback em dash.
    const topStrip = within(screenerDeck).getByLabelText('精选候选前三名')
    expect(within(topStrip).getAllByText('主业造血现金牛').length).toBeGreaterThan(0)
    expect(within(topStrip).getByText('投资占比 1.4%')).toBeInTheDocument()

    const youngorRow = within(screenerTable).getByText('雅戈尔').closest('tr')
    const legacyRow = within(screenerTable).getByText('旧快照样本').closest('tr')
    if (!youngorRow || !legacyRow) {
      throw new Error('Expected rows in screener table')
    }
    expect(within(youngorRow).getByText('盈利高度依赖对外投资')).toHaveClass(
      'quality-badge',
      'quality-badge-red',
    )
    expect(within(youngorRow).getByText('投资 68.4%')).toHaveClass('tone-bad')
    expect(within(legacyRow).getByText('—')).toBeInTheDocument()

    // Segmented quality_filter tabs dispatch expected query parameters.
    const qualityGroup = within(screenerDeck).getByRole('group', { name: '盈利成色' })
    fireEvent.click(within(qualityGroup).getByRole('button', { name: '剔除投资依赖' }))
    await waitFor(() => {
      expect(screenerQueries.some((q) => q.includes('quality_filter=hide_investment_heavy'))).toBe(
        true,
      )
      expect(within(screenerDeck).queryByText('雅戈尔')).not.toBeInTheDocument()
    })

    fireEvent.click(within(qualityGroup).getByRole('button', { name: '红利堡垒' }))
    await waitFor(() => {
      expect(screenerQueries.some((q) => q.includes('quality_filter=dividend_fortress'))).toBe(true)
    })

    fireEvent.click(within(qualityGroup).getByRole('button', { name: '全部' }))
    await waitFor(() => {
      expect(within(screenerDeck).getByText(/当前命中 8 支/)).toBeInTheDocument()
    })

    // Discovery quick filter jump sets core_only in screener.
    const discoveryBoard = screen.getByRole('region', { name: '价值奇点机会挖掘看板' })
    fireEvent.click(within(discoveryBoard).getByRole('button', { name: '在雷达中仅看主业现金牛' }))
    await waitFor(() => {
      expect(screenerQueries.some((q) => q.includes('quality_filter=core_only'))).toBe(true)
      expect(within(screenerDeck).getByText(/当前命中 3 支/)).toBeInTheDocument()
    })
  })

  it('renders subsidy_inflated quality badge as red across DiscoveryBoard and ScreenerSection', async () => {
    const subsidyItem: StockScreenerItem = {
      code: '688001',
      name: '补贴样本',
      exchange: 'SH',
      industry_sw1: '电子',
      as_of: '2026-11-18',
      close: 32.0,
      total_mv_yuan: 1.5e10,
      pe_ttm: 28.0,
      pe_percentile_10y: 35.0,
      pb: 2.8,
      pb_percentile_10y: 30.0,
      roe_5y_avg_pct: 10.2,
      dividend_yield_pct: 0.9,
      shareholder_yield_pct: 0.9,
      implied_fcf_cagr_pct: 4.5,
      ct_red_count: 0,
      ct_yellow_count: 1,
      ct_green_count: 8,
      total_score: 78,
      valuation_margin: 60,
      is_financial: false,
      earnings_quality_tag: 'subsidy_inflated',
      earnings_quality_label: '补贴 / 一次性损益偏高',
      invest_profit_share_3y_pct: 8.5,
      investment_assets_ratio_pct: 5.0,
    }
    const discoveryWithSubsidy: MarketDiscoveryResponse = {
      ...SAMPLE_DISCOVERY,
      themes: (SAMPLE_DISCOVERY.themes ?? []).map((theme) =>
        theme.theme_id === 'gold_fed_cycle'
          ? {
              ...theme,
              picks: [
                {
                  code: '688001',
                  name: '补贴样本',
                  industry_sw1: '电子',
                  close: 32.0,
                  pe_ttm: 28.0,
                  pe_percentile_10y: 35.0,
                  roe_5y_avg_pct: 10.2,
                  dividend_yield_pct: 0.9,
                  ct_red_count: 0,
                  total_score: 78,
                  is_financial: false,
                  earnings_quality_tag: 'subsidy_inflated',
                  earnings_quality_label: '补贴 / 一次性损益偏高',
                  reason: '政府补助占净利润偏高。',
                },
              ],
            }
          : theme,
      ),
    }

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = new URL(asRequest(input).url)
      if (url.pathname === '/api/market/overview') {
        return Promise.resolve(jsonResponse(SAMPLE_OVERVIEW))
      }
      if (url.pathname === '/api/market/discovery') {
        return Promise.resolve(jsonResponse(discoveryWithSubsidy))
      }
      if (url.pathname === '/api/stocks/screener') {
        return Promise.resolve(jsonResponse(filterScreenerResponse(url, [subsidyItem])))
      }
      return Promise.resolve(jsonResponse({ detail: `Unhandled ${url.pathname}` }, 500))
    })

    renderMarketPage()

    const discoveryBoard = await screen.findByRole('region', { name: '价值奇点机会挖掘看板' })
    expect(await within(discoveryBoard).findByText('补贴 / 一次性损益偏高')).toHaveClass(
      'quality-badge',
      'quality-badge-red',
    )

    const screenerDeck = screen.getByRole('region', { name: '价值击球区精选雷达' })
    const topStrip = await within(screenerDeck).findByLabelText('精选候选前三名')
    expect(within(topStrip).getByText('补贴 / 一次性损益偏高')).toHaveClass(
      'quality-badge',
      'quality-badge-red',
    )

    const screenerTable = within(screenerDeck).getByRole('table', { name: '价值筛选结果明细表' })
    expect(within(screenerTable).getByText('补贴 / 一次性损益偏高')).toHaveClass(
      'quality-badge',
      'quality-badge-red',
    )
  })

  it('renders curated 5 blue-chip shortcuts, normalizes names, guards 999.0%, and collapses/expands DiscoveryBoard picks (3) and Screener rows (12)', async () => {
    const baseA = SCREENER_ITEMS[0]
    const baseB = SCREENER_ITEMS[1]
    const baseC = SCREENER_ITEMS[2]
    const baseD = SCREENER_ITEMS[3]
    const baseE = SCREENER_ITEMS[4]
    const deepValueTheme = SAMPLE_DISCOVERY.themes?.find(
      (theme) => theme.theme_id === 'deep_value_fortress',
    )
    const samplePick = deepValueTheme?.picks?.[0]
    const eqTheme = SAMPLE_DISCOVERY.themes?.find(
      (theme) => theme.theme_id === 'earnings_quality_radar',
    )
    const sampleCaution = eqTheme?.caution_picks?.[0]
    if (!baseA || !baseB || !baseC || !baseD || !baseE || !samplePick || !sampleCaution) {
      throw new Error('Expected test fixtures')
    }

    const manyScreenerItems: StockScreenerItem[] = [
      { ...baseA, code: '600519', name: '贵州 茅台', total_score: 95 },
      {
        ...baseC,
        code: '600900',
        name: '长江电力',
        industry_sw1: '公用事业',
        is_financial: false,
        total_score: 91,
      },
      { ...baseC, code: '600036', name: '招商银行', total_score: 89 },
      { ...baseB, code: '000858', name: '五 粮 液', total_score: 87 },
      { ...baseD, code: '300750', name: '宁德时代', industry_sw1: '电力设备', total_score: 85 },
      {
        ...baseE,
        code: '600177',
        name: '雅戈尔',
        industry_sw1: '纺织服饰',
        ct_red_count: 1,
        total_score: 54,
      },
      ...Array.from({ length: 9 }, (_, idx) => ({
        ...baseD,
        code: `60010${idx}`,
        name: `示例标的${idx + 1}`,
        total_score: 80 - idx,
      })),
    ]

    const fivePicksDiscovery: MarketDiscoveryResponse = {
      ...SAMPLE_DISCOVERY,
      themes: (SAMPLE_DISCOVERY.themes ?? []).map((theme) => {
        if (theme.theme_id === 'deep_value_fortress') {
          return {
            ...theme,
            picks: [
              { ...samplePick, code: '000858', name: '五 粮 液' },
              { ...samplePick, code: '600900', name: '长江电力' },
              { ...samplePick, code: '601088', name: '中国神华' },
              { ...samplePick, code: '600028', name: '中国石化' },
              { ...samplePick, code: '601398', name: '工商银行' },
            ],
          }
        }
        if (theme.theme_id === 'earnings_quality_radar') {
          return {
            ...theme,
            caution_picks: [
              {
                ...sampleCaution,
                code: '600177',
                name: '雅 戈 尔',
                earnings_quality_label: undefined,
                invest_profit_share_3y_pct: 999.0,
                reason: '近3年投资收益占营业利润 999.0%，存在盈利失真风险。',
              },
            ],
          }
        }
        return theme
      }),
    }

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = new URL(asRequest(input).url)
      if (url.pathname === '/api/market/overview') {
        return Promise.resolve(jsonResponse(SAMPLE_OVERVIEW))
      }
      if (url.pathname === '/api/market/discovery') {
        return Promise.resolve(jsonResponse(fivePicksDiscovery))
      }
      if (url.pathname === '/api/stocks/screener') {
        return Promise.resolve(jsonResponse(filterScreenerResponse(url, manyScreenerItems)))
      }
      return Promise.resolve(jsonResponse({ detail: `Unhandled ${url.pathname}` }, 500))
    })

    renderMarketPage()

    // Curated 5 blue chips render with role tags and compact stock names.
    const quickGroup = await screen.findByRole('group', { name: '精选已同步示例标的' })
    expect(
      await within(quickGroup).findByRole('link', { name: /600519.*贵州茅台.*现金牛/ }),
    ).toBeInTheDocument()
    expect(
      within(quickGroup).getByRole('link', { name: /600900.*长江电力.*红利防守/ }),
    ).toBeInTheDocument()
    expect(
      within(quickGroup).getByRole('link', { name: /600177.*雅戈尔.*投资依赖反例/ }),
    ).toBeInTheDocument()
    expect(
      within(quickGroup).getByRole('link', { name: /600036.*招商银行.*高息银行/ }),
    ).toBeInTheDocument()
    expect(
      within(quickGroup).getByRole('link', { name: /300750.*宁德时代.*制造龙头/ }),
    ).toBeInTheDocument()

    // Discovery theme collapses 5 picks -> 3 by default and expands cleanly.
    const deepValueCard = await screen.findByRole('article', {
      name: '高净现金与低估值安全边际',
    })
    expect(within(deepValueCard).getByRole('link', { name: '五粮液' })).toBeInTheDocument()
    expect(within(deepValueCard).queryByText('五 粮 液')).not.toBeInTheDocument()
    expect(within(deepValueCard).queryByRole('link', { name: '中国石化' })).not.toBeInTheDocument()
    expect(within(deepValueCard).queryByRole('link', { name: '工商银行' })).not.toBeInTheDocument()

    const themeExpandBtn = within(deepValueCard).getByRole('button', {
      name: '展开更多（共 5 只）',
    })
    fireEvent.click(themeExpandBtn)
    expect(within(deepValueCard).getByRole('link', { name: '中国石化' })).toBeInTheDocument()
    expect(within(deepValueCard).getByRole('link', { name: '工商银行' })).toBeInTheDocument()
    fireEvent.click(within(deepValueCard).getByRole('button', { name: '收起' }))
    expect(within(deepValueCard).queryByRole('link', { name: '工商银行' })).not.toBeInTheDocument()

    // Caution pick guards 999.0% in stats, badge, and reason text.
    const qualityCard = screen.getByRole('article', {
      name: '主业造血现金牛 vs 投资收益依赖排查',
    })
    expect(within(qualityCard).queryByText(/999\.0%/)).not.toBeInTheDocument()
    expect(within(qualityCard).getAllByText(/主业微利\(不适用\)/).length).toBeGreaterThan(0)
    expect(within(qualityCard).getByRole('link', { name: '雅戈尔' })).toBeInTheDocument()

    // Screener renders 12 rows by default out of 15, expands on click, and resets on filter change.
    const screenerDeck = screen.getByRole('region', { name: '价值击球区精选雷达' })
    const screenerTable = within(screenerDeck).getByRole('table', { name: '价值筛选结果明细表' })
    const tbody = screenerTable.querySelector('tbody')
    expect(tbody?.querySelectorAll('tr')).toHaveLength(12)
    expect(within(screenerTable).getByRole('link', { name: '五粮液' })).toBeInTheDocument()
    expect(within(screenerTable).queryByText('五 粮 液')).not.toBeInTheDocument()
    expect(within(screenerTable).queryByText('示例标的9')).not.toBeInTheDocument()

    fireEvent.click(within(screenerDeck).getByRole('button', { name: '展开全部 15 条' }))
    expect(tbody?.querySelectorAll('tr')).toHaveLength(15)
    expect(within(screenerTable).getByText('示例标的9')).toBeInTheDocument()

    fireEvent.click(within(screenerDeck).getByRole('button', { name: '收起至前 12 条' }))
    expect(tbody?.querySelectorAll('tr')).toHaveLength(12)

    fireEvent.click(within(screenerDeck).getByRole('button', { name: '展开全部 15 条' }))
    expect(tbody?.querySelectorAll('tr')).toHaveLength(15)

    // Changing filter resets expanded screener table back to default 12 rows.
    fireEvent.click(within(screenerDeck).getByRole('button', { name: '仅看零红灯' }))
    await waitFor(() => {
      expect(tbody?.querySelectorAll('tr')).toHaveLength(12)
    })
  })

  it('shows all 5 curated showcase targets when total_synced >= 50 even if some targets fall outside the top-50 score slice', async () => {
    const baseA = SCREENER_ITEMS[0]
    const baseD = SCREENER_ITEMS[3]
    if (!baseA || !baseD) {
      throw new Error('Expected test fixtures')
    }

    const top50Items: StockScreenerItem[] = [
      { ...baseA, code: '600519', name: '贵州 茅台', total_score: 95 },
      { ...baseD, code: '300750', name: '宁德时代', industry_sw1: '电力设备', total_score: 88 },
      ...Array.from({ length: 48 }, (_, idx) => ({
        ...baseD,
        code: `601${String(idx).padStart(3, '0')}`,
        name: `高分示例${idx + 1}`,
        total_score: 85 - idx * 0.1,
      })),
    ]

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = new URL(asRequest(input).url)
      if (url.pathname === '/api/market/overview') {
        return Promise.resolve(jsonResponse(SAMPLE_OVERVIEW))
      }
      if (url.pathname === '/api/market/discovery') {
        return Promise.resolve(jsonResponse(SAMPLE_DISCOVERY))
      }
      if (url.pathname === '/api/stocks/screener') {
        return Promise.resolve(
          jsonResponse({
            total_synced: 500,
            filtered_count: 500,
            industries: ['食品饮料', '电力设备', '家用电器'],
            items: top50Items,
          } satisfies StockScreenerResponse),
        )
      }
      return Promise.resolve(jsonResponse({ detail: `Unhandled ${url.pathname}` }, 500))
    })

    renderMarketPage()

    const quickGroup = await screen.findByRole('group', { name: '精选已同步示例标的' })
    expect(
      await within(quickGroup).findByRole('link', { name: /600519.*贵州茅台.*现金牛/ }),
    ).toHaveAttribute('href', '/stock/600519')
    expect(
      within(quickGroup).getByRole('link', { name: /600900.*长江电力.*红利防守/ }),
    ).toHaveAttribute('href', '/stock/600900')
    expect(
      within(quickGroup).getByRole('link', { name: /600177.*雅戈尔.*投资依赖反例/ }),
    ).toHaveAttribute('href', '/stock/600177')
    expect(
      within(quickGroup).getByRole('link', { name: /600036.*招商银行.*高息银行/ }),
    ).toHaveAttribute('href', '/stock/600036')
    expect(
      within(quickGroup).getByRole('link', { name: /300750.*宁德时代.*制造龙头/ }),
    ).toHaveAttribute('href', '/stock/300750')
    expect(within(quickGroup).getAllByRole('link')).toHaveLength(5)

    const screenerTable = screen.getByRole('table', { name: '价值筛选结果明细表' })
    expect(within(screenerTable).queryByText('长江电力')).not.toBeInTheDocument()
    expect(within(screenerTable).queryByText('雅戈尔')).not.toBeInTheDocument()
    expect(within(screenerTable).queryByText('招商银行')).not.toBeInTheDocument()
  })
})
