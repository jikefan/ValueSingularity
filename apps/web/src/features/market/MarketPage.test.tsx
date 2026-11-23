import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChartOption } from '../../lib/charts'
import { CHART_COLORS, LIGHT_CHART_COLORS } from '../../lib/chartTheme'
import { createQueryClient } from '../../lib/queryClient'
import type { MarketOverview } from '../../types/api'
import { MarketPage } from './MarketPage'

const capturedChartOptions = new Map<string, ChartOption>()

vi.mock('../../lib/charts', () => ({
  Chart: ({ ariaLabel, option }: { ariaLabel?: string; option: ChartOption }) => {
    if (ariaLabel) {
      capturedChartOptions.set(ariaLabel, option)
    }
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
    { name: '半导体', change_pct: 2.41, net_inflow: 3.12e9, companies: 168 },
    { name: '银行', change_pct: -0.35, net_inflow: -6.1e8, companies: 42 },
  ],
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
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
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('MarketPage', () => {
  afterEach(() => {
    cleanup()
    capturedChartOptions.clear()
    vi.restoreAllMocks()
    delete document.documentElement.dataset.theme
    window.localStorage.clear()
  })

  it('renders onboarding workflow, quick-access stock links, metrics, and aligned inverse flowOption', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(SAMPLE_OVERVIEW))

    renderMarketPage()

    expect(await screen.findByText('上证指数')).toBeInTheDocument()
    expect(screen.getByText('三步价值投资工作流')).toBeInTheDocument()
    expect(screen.getByText(/搜公司查排雷与估值水位/)).toBeInTheDocument()
    expect(screen.getByText('EP − 国债（越高股票越占优）')).toBeInTheDocument()
    expect(screen.getByText(/市场冷暖提示：/)).toBeInTheDocument()

    expect(screen.getByRole('link', { name: /600519.*贵州茅台/ })).toHaveAttribute(
      'href',
      '/stock/600519',
    )
    expect(screen.getByRole('link', { name: /600036.*招商银行/ })).toHaveAttribute(
      'href',
      '/stock/600036',
    )
    expect(screen.getByRole('link', { name: /002594.*比亚迪/ })).toHaveAttribute(
      'href',
      '/stock/002594',
    )
    expect(screen.getByRole('link', { name: /000858.*五粮液/ })).toHaveAttribute(
      'href',
      '/stock/000858',
    )
    expect(screen.getByRole('link', { name: /300750.*宁德时代/ })).toHaveAttribute(
      'href',
      '/stock/300750',
    )

    expect(screen.getByText('偏冷')).toBeInTheDocument()
    expect(screen.getByText('24.6')).toBeInTheDocument()
    expect(screen.getByText('31%')).toBeInTheDocument()
    expect(screen.getByText('2.18%')).toBeInTheDocument()
    expect(screen.getByText('1.89%')).toBeInTheDocument()
    expect(screen.getByText('3,218.42')).toBeInTheDocument()
    expect(screen.getByText('半导体')).toBeInTheDocument()
    expect(screen.getByText('31.20 亿')).toBeInTheDocument()
    expect(screen.getByText('168')).toBeInTheDocument()
    expect(screen.getByText('交易日 2026-11-18')).toBeInTheDocument()
    expect(screen.getByText('2026-11-18')).toBeInTheDocument()
    expect(screen.getByText('akshare')).toBeInTheDocument()

    const flowOption = capturedChartOptions.get('行业净流入柱状图')
    expect(flowOption).toBeDefined()
    expect(flowOption?.yAxis).toMatchObject({
      type: 'category',
      inverse: true,
      data: ['半导体', '银行'],
    })
    expect(flowOption?.tooltip).toMatchObject({
      backgroundColor: CHART_COLORS.panel,
      borderColor: CHART_COLORS.axisLine,
    })
    expect(flowOption?.series).toMatchObject([
      {
        type: 'bar',
        data: [
          {
            value: 31.2,
            itemStyle: { color: CHART_COLORS.positive, borderRadius: [0, 6, 6, 0] },
          },
          {
            value: -6.1,
            itemStyle: { color: CHART_COLORS.negative, borderRadius: [6, 0, 0, 6] },
          },
        ],
      },
    ])

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const requestArg = fetchSpy.mock.calls[0]?.[0]
    const pathname =
      requestArg instanceof Request ? new URL(requestArg.url).pathname : String(requestArg)
    expect(pathname).toBe('/api/market/overview')

    fireEvent.click(screen.getByRole('link', { name: /600519.*贵州茅台/ }))
    expect(await screen.findByText('个股详情页')).toBeInTheDocument()
  })

  it('renders ErrorBlock with backend detail on 503 and recovers after clicking retry', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ detail: '数据库不可用: OperationalError' }, 503))
      .mockResolvedValueOnce(jsonResponse(SAMPLE_OVERVIEW))

    renderMarketPage()

    expect(await screen.findByText('行情加载失败')).toBeInTheDocument()
    expect(screen.getByText('数据库不可用: OperationalError')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '重试' }))

    expect(await screen.findByText('上证指数')).toBeInTheDocument()
    expect(screen.getByText('半导体')).toBeInTheDocument()
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('renders em dash when industry flow companies count is null', async () => {
    const overviewWithMissingCompanies: MarketOverview = {
      ...SAMPLE_OVERVIEW,
      hot_industries: [
        { name: '半导体', change_pct: 2.41, net_inflow: 3.12e9, companies: null },
        { name: '银行', change_pct: -0.35, net_inflow: -6.1e8, companies: 42 },
      ],
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse(overviewWithMissingCompanies))

    renderMarketPage()

    expect(await screen.findByText('半导体')).toBeInTheDocument()
    expect(screen.getByText('—')).toBeInTheDocument()
    expect(screen.getByText('42')).toBeInTheDocument()
  })

  it('updates industry flow chart option to LIGHT_CHART_COLORS when data-theme toggles to light', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse(SAMPLE_OVERVIEW))

    renderMarketPage()
    expect(await screen.findByText('半导体')).toBeInTheDocument()

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
              itemStyle: { color: LIGHT_CHART_COLORS.positive, borderRadius: [0, 6, 6, 0] },
            },
            {
              value: -6.1,
              itemStyle: { color: LIGHT_CHART_COLORS.negative, borderRadius: [6, 0, 0, 6] },
            },
          ],
        },
      ])
    })
  })
})
