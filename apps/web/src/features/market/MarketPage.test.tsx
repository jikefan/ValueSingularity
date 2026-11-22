import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createQueryClient } from '../../lib/queryClient'
import type { MarketOverview } from '../../types/api'
import { MarketPage } from './MarketPage'

vi.mock('../../lib/charts', () => ({
  Chart: ({ ariaLabel }: { ariaLabel?: string }) => <div role="img" aria-label={ariaLabel} />,
}))

const SAMPLE_OVERVIEW: MarketOverview = {
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
      <MarketPage />
    </QueryClientProvider>,
  )
}

describe('MarketPage', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('renders overview metrics, indices, and industry table from /api/market/overview', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(SAMPLE_OVERVIEW))

    renderMarketPage()

    expect(await screen.findByText('上证指数')).toBeInTheDocument()
    expect(screen.getByText('偏冷')).toBeInTheDocument()
    expect(screen.getByText('24.6')).toBeInTheDocument()
    expect(screen.getByText('31%')).toBeInTheDocument()
    expect(screen.getByText('2.18%')).toBeInTheDocument()
    expect(screen.getByText('1.89%')).toBeInTheDocument()
    expect(screen.getByText('3,218.42')).toBeInTheDocument()
    expect(screen.getByText('半导体')).toBeInTheDocument()
    expect(screen.getByText('31.20 亿')).toBeInTheDocument()
    expect(screen.getByText('168')).toBeInTheDocument()

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const requestArg = fetchSpy.mock.calls[0]?.[0]
    const pathname =
      requestArg instanceof Request ? new URL(requestArg.url).pathname : String(requestArg)
    expect(pathname).toBe('/api/market/overview')
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
})
