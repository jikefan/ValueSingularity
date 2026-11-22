import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'
import { TopNav } from './components/layout/TopNav'
import { AuthProvider } from './lib/AuthProvider'
import { setAccessToken } from './lib/api'
import { createQueryClient } from './lib/queryClient'
import { queryKeys } from './lib/queryKeys'
import type { MarketOverview, StockDetail, StockMetaRecord } from './types/api'

vi.mock('./lib/charts', () => ({
  Chart: ({ ariaLabel }: { ariaLabel?: string }) => <div role="img" aria-label={ariaLabel} />,
}))

const SAMPLE_OVERVIEW: MarketOverview = {
  schema_version: 1,
  as_of: '2026-11-18',
  data_source: 'akshare',
  generated_at: '2026-11-18T10:00:00Z',
  indices: [{ code: '000001', name: '上证指数', price: 3218.42, change_pct: 0.62 }],
  temperature: {
    score: 38,
    level: 'cool',
    pe_median: 24.6,
    pe_percentile: 31,
    bond_yield: 2.18,
    equity_bond_spread: 1.89,
    comment: '估值处于近十年偏低区间。',
  },
  hot_industries: [],
}

const MAOTAI_META: StockMetaRecord = {
  code: '600519',
  name: '贵州茅台',
  exchange: 'SH',
  industry_sw1: '食品饮料',
  industry_sw2: '白酒Ⅱ',
  list_date: '2001-08-27',
  is_st: false,
  is_active: true,
}

const ST_DELISTED_META: StockMetaRecord = {
  code: '000002',
  name: '*ST示例',
  exchange: 'SZ',
  industry_sw1: '房地产',
  industry_sw2: null,
  list_date: '1991-01-29',
  is_st: true,
  is_active: false,
}

const MAOTAI_DETAIL: StockDetail = {
  ...MAOTAI_META,
  snapshot_available: false,
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

function renderApp(initialEntry = '/') {
  const client = createQueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  })

  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <AuthProvider>
          <MemoryRouter initialEntries={[initialEntry]}>
            <App />
          </MemoryRouter>
        </AuthProvider>
      </QueryClientProvider>,
    ),
  }
}

describe('App global stock search', () => {
  afterEach(() => {
    cleanup()
    setAccessToken(null)
    vi.restoreAllMocks()
  })

  it('debounces search input, renders matching stocks with tags, and navigates to /stock/600519', async () => {
    const searchQueries: string[] = []

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const request = asRequest(input)
      const url = new URL(request.url)

      if (url.pathname === '/api/auth/refresh') {
        return Promise.resolve(jsonResponse({ detail: '未登录' }, 401))
      }
      if (url.pathname === '/api/market/overview') {
        return Promise.resolve(jsonResponse(SAMPLE_OVERVIEW, 200))
      }
      if (url.pathname === '/api/stocks/search') {
        const q = url.searchParams.get('q') ?? ''
        searchQueries.push(q)
        return Promise.resolve(jsonResponse([MAOTAI_META, ST_DELISTED_META], 200))
      }
      if (url.pathname === '/api/stocks/600519') {
        return Promise.resolve(jsonResponse(MAOTAI_DETAIL, 200))
      }
      return Promise.resolve(jsonResponse({ detail: `Unhandled ${url.pathname}` }, 500))
    })

    renderApp('/')

    const searchInput = screen.getByLabelText('搜索股票')
    fireEvent.change(searchInput, { target: { value: '茅台' } })

    const maotaiOption = await screen.findByRole('option', { name: /600519.*贵州茅台/ })
    expect(maotaiOption).toBeInTheDocument()
    expect(screen.getByText('ST')).toBeInTheDocument()
    expect(screen.getByText('已退市')).toBeInTheDocument()
    expect(searchQueries).toEqual(['茅台'])

    fireEvent.click(maotaiOption)

    expect(await screen.findByRole('heading', { name: '贵州茅台' })).toBeInTheDocument()
    expect(screen.getByText(/食品饮料 \/ 白酒Ⅱ/)).toBeInTheDocument()
    expect(searchInput).toHaveValue('')
  })

  it('supports Enter navigation for 6-digit codes and Escape closing dropdown', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const request = asRequest(input)
      const url = new URL(request.url)

      if (url.pathname === '/api/auth/refresh') {
        return Promise.resolve(jsonResponse({ detail: '未登录' }, 401))
      }
      if (url.pathname === '/api/market/overview') {
        return Promise.resolve(jsonResponse(SAMPLE_OVERVIEW, 200))
      }
      if (url.pathname === '/api/stocks/search') {
        return Promise.resolve(jsonResponse([MAOTAI_META], 200))
      }
      if (url.pathname === '/api/stocks/600519') {
        return Promise.resolve(jsonResponse(MAOTAI_DETAIL, 200))
      }
      return Promise.resolve(jsonResponse({ detail: `Unhandled ${url.pathname}` }, 500))
    })

    renderApp('/')

    const searchInput = screen.getByLabelText('搜索股票')
    fireEvent.change(searchInput, { target: { value: '600519' } })
    expect(await screen.findByRole('listbox', { name: '搜索结果' })).toBeInTheDocument()

    fireEvent.keyDown(searchInput, { key: 'Escape' })
    expect(screen.queryByRole('listbox', { name: '搜索结果' })).not.toBeInTheDocument()

    fireEvent.keyDown(searchInput, { key: 'Enter' })
    expect(await screen.findByRole('heading', { name: '贵州茅台' })).toBeInTheDocument()
  })

  it('renders TopNav cleanly without search props', () => {
    render(
      <MemoryRouter>
        <TopNav />
      </MemoryRouter>,
    )

    expect(screen.getByLabelText('搜索股票')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '登录 / 注册' })).toBeInTheDocument()
  })

  it('closes dropdown on outside click, handles empty/error states, and navigates on Enter via first result', async () => {
    let searchMode: 'empty' | 'error' | 'found' = 'empty'

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const request = asRequest(input)
      const url = new URL(request.url)

      if (url.pathname === '/api/auth/refresh') {
        return Promise.resolve(jsonResponse({ detail: '未登录' }, 401))
      }
      if (url.pathname === '/api/market/overview') {
        return Promise.resolve(jsonResponse(SAMPLE_OVERVIEW, 200))
      }
      if (url.pathname === '/api/stocks/search') {
        if (searchMode === 'empty') {
          return Promise.resolve(jsonResponse([], 200))
        }
        if (searchMode === 'error') {
          return Promise.resolve(jsonResponse({ detail: '搜索服务暂不可用' }, 503))
        }
        return Promise.resolve(jsonResponse([MAOTAI_META], 200))
      }
      if (url.pathname === '/api/stocks/600519') {
        return Promise.resolve(jsonResponse(MAOTAI_DETAIL, 200))
      }
      return Promise.resolve(jsonResponse({ detail: `Unhandled ${url.pathname}` }, 500))
    })

    renderApp('/')

    const searchInput = screen.getByLabelText('搜索股票')
    fireEvent.change(searchInput, { target: { value: '不存在' } })
    expect(await screen.findByText('未找到匹配股票')).toBeInTheDocument()

    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('listbox', { name: '搜索结果' })).not.toBeInTheDocument()

    searchMode = 'error'
    fireEvent.change(searchInput, { target: { value: '故障' } })
    expect(await screen.findByText('搜索失败，请稍后重试')).toBeInTheDocument()

    searchMode = 'found'
    fireEvent.change(searchInput, { target: { value: '贵州' } })
    expect(await screen.findByRole('option', { name: /600519.*贵州茅台/ })).toBeInTheDocument()

    fireEvent.keyDown(searchInput, { key: 'Enter' })
    expect(await screen.findByRole('heading', { name: '贵州茅台' })).toBeInTheDocument()
  })

  it('resolves Enter pressed during 180ms debounce for non-6-digit queries and ignores IME composing keys', async () => {
    const searchCalls: string[] = []

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const request = asRequest(input)
      const url = new URL(request.url)

      if (url.pathname === '/api/auth/refresh') {
        return Promise.resolve(jsonResponse({ detail: '未登录' }, 401))
      }
      if (url.pathname === '/api/market/overview') {
        return Promise.resolve(jsonResponse(SAMPLE_OVERVIEW, 200))
      }
      if (url.pathname === '/api/stocks/search') {
        searchCalls.push(url.searchParams.get('q') ?? '')
        return Promise.resolve(jsonResponse([MAOTAI_META], 200))
      }
      if (url.pathname === '/api/stocks/600519') {
        return Promise.resolve(jsonResponse(MAOTAI_DETAIL, 200))
      }
      return Promise.resolve(jsonResponse({ detail: `Unhandled ${url.pathname}` }, 500))
    })

    renderApp('/')

    const searchInput = screen.getByLabelText('搜索股票')
    fireEvent.change(searchInput, { target: { value: '茅台' } })

    // IME composition Enter/ArrowDown must not hijack composition or navigate.
    fireEvent.keyDown(searchInput, { key: 'Enter', isComposing: true })
    expect(searchCalls).toEqual([])
    expect(screen.queryByRole('heading', { name: '贵州茅台' })).not.toBeInTheDocument()

    // Pressing Enter inside the 180ms debounce window triggers an immediate lookup and navigates.
    fireEvent.keyDown(searchInput, { key: 'Enter' })
    expect(await screen.findByRole('heading', { name: '贵州茅台' })).toBeInTheDocument()
    expect(searchCalls).toEqual(['茅台'])
  })

  it('prevents selecting stale cached results while refetching, clamps activeIndex when results shrink, and closes on blur', async () => {
    let searchStage: 'initial' | 'refetch_pending' = 'initial'
    let resolveRefetch!: (response: Response) => void

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const request = asRequest(input)
      const url = new URL(request.url)

      if (url.pathname === '/api/auth/refresh') {
        return Promise.resolve(jsonResponse({ detail: '未登录' }, 401))
      }
      if (url.pathname === '/api/market/overview') {
        return Promise.resolve(jsonResponse(SAMPLE_OVERVIEW, 200))
      }
      if (url.pathname === '/api/stocks/search') {
        const q = url.searchParams.get('q') ?? ''
        if (q === '茅台') {
          if (searchStage === 'refetch_pending') {
            return new Promise<Response>((resolve) => {
              resolveRefetch = resolve
            })
          }
          return Promise.resolve(jsonResponse([MAOTAI_META, ST_DELISTED_META], 200))
        }
        return Promise.resolve(jsonResponse([MAOTAI_META], 200))
      }
      if (url.pathname === '/api/stocks/600519') {
        return Promise.resolve(jsonResponse(MAOTAI_DETAIL, 200))
      }
      return Promise.resolve(jsonResponse({ detail: `Unhandled ${url.pathname}` }, 500))
    })

    const { client } = renderApp('/')
    const searchInput = screen.getByLabelText('搜索股票')

    fireEvent.change(searchInput, { target: { value: '茅台' } })
    expect(await screen.findByRole('option', { name: /000002.*\*ST示例/ })).toBeInTheDocument()

    fireEvent.keyDown(searchInput, { key: 'ArrowDown' })
    fireEvent.keyDown(searchInput, { key: 'ArrowDown' })
    expect(screen.getByRole('option', { name: /000002.*\*ST示例/ })).toHaveAttribute(
      'aria-selected',
      'true',
    )

    searchStage = 'refetch_pending'
    void client.invalidateQueries({ queryKey: queryKeys.stocks.search('茅台') })
    expect(await screen.findByText('搜索中...')).toBeInTheDocument()
    expect(screen.queryByRole('option')).not.toBeInTheDocument()

    fireEvent.keyDown(searchInput, { key: 'ArrowDown' })
    expect(screen.queryByRole('option')).not.toBeInTheDocument()

    resolveRefetch(jsonResponse([MAOTAI_META], 200))
    const singleOption = await screen.findByRole('option', { name: /600519.*贵州茅台/ })
    expect(screen.queryByRole('option', { name: /000002/ })).not.toBeInTheDocument()
    expect(singleOption).toHaveAttribute('aria-selected', 'false')

    fireEvent.keyDown(searchInput, { key: 'ArrowDown' })
    expect(singleOption).toHaveAttribute('aria-selected', 'true')

    fireEvent.blur(searchInput, { relatedTarget: document.body })
    await waitFor(() => {
      expect(screen.queryByRole('listbox', { name: '搜索结果' })).not.toBeInTheDocument()
    })
  })
})
