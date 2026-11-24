import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChartOption } from '../../lib/charts'
import { CHART_COLORS, LIGHT_CHART_COLORS } from '../../lib/chartTheme'
import { createQueryClient } from '../../lib/queryClient'
import type { MarketOverview, StockScreenerItem, StockScreenerResponse } from '../../types/api'
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
  },
]

function filterScreenerResponse(url: URL, items = SCREENER_ITEMS): StockScreenerResponse {
  const zeroRed = url.searchParams.get('zero_red_only') === 'true'
  const maxPeRaw = url.searchParams.get('max_pe_percentile')
  const minRoeRaw = url.searchParams.get('min_roe')
  const minDivRaw = url.searchParams.get('min_dividend_yield')
  const industry = url.searchParams.get('industry') ?? ''
  const q = (url.searchParams.get('q') ?? '').trim().toLowerCase()
  const sortBy = (url.searchParams.get('sort_by') ?? 'total_score') as keyof StockScreenerItem
  const sortDir = url.searchParams.get('sort_dir') === 'asc' ? 'asc' : 'desc'

  const filtered = items.filter((item) => {
    if (zeroRed && item.ct_red_count > 0) return false
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
    expect(within(quickGroup).getByRole('link', { name: /600519.*贵州茅台/ })).toHaveAttribute(
      'href',
      '/stock/600519',
    )
    expect(within(quickGroup).getByRole('link', { name: /600036.*招商银行/ })).toBeInTheDocument()
    expect(within(quickGroup).getByRole('link', { name: /000333.*美的集团/ })).toBeInTheDocument()
    expect(within(quickGroup).getByRole('link', { name: /002594.*比亚迪/ })).toBeInTheDocument()
    expect(within(quickGroup).queryByText('300750')).not.toBeInTheDocument()

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
      if (url.pathname === '/api/stocks/screener') {
        return Promise.resolve(jsonResponse(filterScreenerResponse(url)))
      }
      return Promise.resolve(jsonResponse({ detail: `Unhandled ${url.pathname}` }, 500))
    })

    renderMarketPage()

    expect(await screen.findByText('行情加载失败')).toBeInTheDocument()
    expect(screen.getByText('数据库不可用: OperationalError')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '重试' }))

    expect(await screen.findByText('上证指数')).toBeInTheDocument()
    expect(screen.getAllByText('食品饮料').length).toBeGreaterThan(0)
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
})
