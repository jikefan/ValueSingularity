import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createQueryClient } from '../../lib/queryClient'
import type { StockCompareItem, StockMetaRecord } from '../../types/api'
import { ComparePage } from './ComparePage'

const COMPARE_FIXTURES: Record<string, StockCompareItem> = {
  '600519': {
    code: '600519',
    meta: {
      code: '600519',
      name: '贵州茅台',
      exchange: 'SH',
      industry_sw1: '食品饮料',
      industry_sw2: '白酒Ⅱ',
      list_date: '2001-08-27',
      is_st: false,
      is_active: true,
    },
    snapshot_available: true,
    snapshot_as_of: '2026-11-20',
    metrics: {
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
  },
  '000858': {
    code: '000858',
    meta: {
      code: '000858',
      name: '五粮液',
      exchange: 'SZ',
      industry_sw1: '食品饮料',
      industry_sw2: '白酒Ⅱ',
      list_date: '1998-04-27',
      is_st: false,
      is_active: true,
    },
    snapshot_available: false,
    snapshot_as_of: null,
    metrics: null,
  },
  '000568': {
    code: '000568',
    meta: {
      code: '000568',
      name: '泸州老窖',
      exchange: 'SZ',
      industry_sw1: '食品饮料',
      industry_sw2: '白酒Ⅱ',
      list_date: '1994-05-09',
      is_st: false,
      is_active: true,
    },
    snapshot_available: true,
    snapshot_as_of: '2026-11-20',
    metrics: {
      code: '000568',
      name: '泸州老窖',
      exchange: 'SZ',
      industry_sw1: '食品饮料',
      as_of: '2026-11-20',
      close: 132.5,
      total_mv_yuan: 1.95e11,
      pe_ttm: 14.3,
      pe_percentile_10y: 12.1,
      pb: 4.1,
      roe_5y_avg_pct: 28.6,
      gross_margin_latest_pct: 88.4,
      net_cash_to_mv_pct: 12.1,
      ocf_to_profit_5y_pct: 102.0,
      shareholder_yield_pct: 4.2,
      implied_fcf_cagr_pct: 5.1,
      ct_red_count: 1,
      ct_yellow_count: 0,
      total_score: 81,
    },
  },
  '600809': {
    code: '600809',
    meta: {
      code: '600809',
      name: '山西汾酒',
      exchange: 'SH',
      industry_sw1: '食品饮料',
      industry_sw2: '白酒Ⅱ',
      list_date: '1994-01-06',
      is_st: false,
      is_active: true,
    },
    snapshot_available: false,
    snapshot_as_of: null,
    metrics: null,
  },
  '002304': {
    code: '002304',
    meta: {
      code: '002304',
      name: '洋河股份',
      exchange: 'SZ',
      industry_sw1: '食品饮料',
      industry_sw2: '白酒Ⅱ',
      list_date: '2009-11-06',
      is_st: false,
      is_active: true,
    },
    snapshot_available: false,
    snapshot_as_of: null,
    metrics: null,
  },
}

const SEARCH_ITEMS: StockMetaRecord[] = Object.values(COMPARE_FIXTURES).map((item) => item.meta)

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

function renderComparePage(initialEntry = '/compare') {
  const client = createQueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  })

  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/compare" element={<ComparePage />} />
          <Route path="/stock/:code" element={<div>个股详情</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('ComparePage', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('renders empty state preset and loads liquor leaders on one click', async () => {
    const compareRequests: string[] = []

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = new URL(asRequest(input).url)
      if (url.pathname === '/api/stocks/compare') {
        const codesParam = url.searchParams.get('codes') ?? ''
        compareRequests.push(codesParam)
        const items = codesParam
          .split(',')
          .map((code) => COMPARE_FIXTURES[code])
          .filter((item): item is StockCompareItem => Boolean(item))
        return Promise.resolve(jsonResponse(items, 200))
      }
      return Promise.resolve(jsonResponse({ detail: `Unhandled ${url.pathname}` }, 500))
    })

    renderComparePage('/compare')

    expect(screen.getByText('请添加 1–5 支标的开始同业横向对比')).toBeInTheDocument()
    const presetBtn = screen.getByRole('button', {
      name: '白酒龙头对比 (600519/000858/000568)',
    })
    fireEvent.click(presetBtn)

    expect(await screen.findByRole('link', { name: '贵州茅台' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '五粮液' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '泸州老窖' })).toBeInTheDocument()
    expect(compareRequests).toEqual(['600519,000858,000568'])
  })

  it('renders mixed synced/unsynced items, supports adding via search and code, removing peers, and enforces 5-peer limit', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = new URL(asRequest(input).url)
      if (url.pathname === '/api/stocks/search') {
        const q = url.searchParams.get('q') ?? ''
        const matched = SEARCH_ITEMS.filter(
          (item) => item.name.includes(q) || item.code.includes(q),
        )
        return Promise.resolve(jsonResponse(matched, 200))
      }
      if (url.pathname === '/api/stocks/compare') {
        const codesParam = url.searchParams.get('codes') ?? ''
        const items = codesParam
          .split(',')
          .map((code) => COMPARE_FIXTURES[code])
          .filter((item): item is StockCompareItem => Boolean(item))
        return Promise.resolve(jsonResponse(items, 200))
      }
      return Promise.resolve(jsonResponse({ detail: `Unhandled ${url.pathname}` }, 500))
    })

    renderComparePage('/compare?codes=600519,000858')

    expect(await screen.findByText('89 / 100')).toBeInTheDocument()
    expect(screen.getByText('19,100.00 亿元')).toBeInTheDocument()
    expect(screen.getByText('+8.42%')).toBeInTheDocument()
    expect(screen.getByText('+8.42%')).toHaveClass('tone-bad')
    expect(screen.getByText('3.66%')).toHaveClass('tone-good')
    expect(screen.getByText('9.69%')).toHaveClass('tone-good')
    expect(screen.getByText('0 红 / 1 黄')).toBeInTheDocument()
    expect(screen.getByText('未同步快照')).toBeInTheDocument()
    expect(screen.getByText('python -m app.cli.sync_stocks --codes 000858')).toBeInTheDocument()

    const addInput = screen.getByLabelText('添加对比股票')

    fireEvent.change(addInput, { target: { value: '600519' } })
    fireEvent.click(screen.getByRole('button', { name: '添加对比' }))
    expect(screen.getByRole('alert')).toHaveTextContent('600519 已在对比列表中')

    fireEvent.change(addInput, { target: { value: '老窖' } })
    const option = await screen.findByRole('option', { name: /000568.*泸州老窖/ })
    fireEvent.click(option)
    expect(await screen.findByText('81 / 100')).toBeInTheDocument()
    expect(screen.getByText('1 红 / 0 黄')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '移除 000858' }))
    expect(screen.queryByRole('link', { name: '五粮液' })).not.toBeInTheDocument()

    for (const code of ['000858', '600809', '002304']) {
      fireEvent.change(addInput, { target: { value: code } })
      fireEvent.click(screen.getByRole('button', { name: '添加对比' }))
    }

    expect(await screen.findByText('已选 5 / 5')).toBeInTheDocument()
    expect(addInput).toBeDisabled()
    expect(screen.getByRole('button', { name: '添加对比' })).toBeDisabled()
  })

  it('shows ErrorBlock on 503 and recovers on retry', async () => {
    let attempts = 0

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = new URL(asRequest(input).url)
      if (url.pathname === '/api/stocks/compare') {
        attempts += 1
        if (attempts === 1) {
          return Promise.resolve(jsonResponse({ detail: '数据库暂不可用' }, 503))
        }
        return Promise.resolve(jsonResponse([COMPARE_FIXTURES['600519']], 200))
      }
      return Promise.resolve(jsonResponse({ detail: `Unhandled ${url.pathname}` }, 500))
    })

    renderComparePage('/compare?codes=600519')

    expect(await screen.findByText('同业对比加载失败')).toBeInTheDocument()
    expect(screen.getByText('数据库暂不可用')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByText('89 / 100')).toBeInTheDocument()
  })

  it('ignores late-resolving search submit after concurrent removeCode race', async () => {
    let resolveDeferredSearch: ((response: Response) => void) | undefined
    const deferredSearch = new Promise<Response>((resolve) => {
      resolveDeferredSearch = resolve
    })
    const compareRequests: string[] = []

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = new URL(asRequest(input).url)
      if (url.pathname === '/api/stocks/search') {
        return deferredSearch
      }
      if (url.pathname === '/api/stocks/compare') {
        const codesParam = url.searchParams.get('codes') ?? ''
        compareRequests.push(codesParam)
        const items = codesParam
          .split(',')
          .map((code) => COMPARE_FIXTURES[code])
          .filter((item): item is StockCompareItem => Boolean(item))
        return Promise.resolve(jsonResponse(items, 200))
      }
      return Promise.resolve(jsonResponse({ detail: `Unhandled ${url.pathname}` }, 500))
    })

    renderComparePage('/compare?codes=600519,000858')
    expect(await screen.findByRole('link', { name: '五粮液' })).toBeInTheDocument()

    const addInput = screen.getByLabelText('添加对比股票')
    fireEvent.change(addInput, { target: { value: '老窖' } })
    fireEvent.click(screen.getByRole('button', { name: '添加对比' }))

    // Remove 000858 while the name search request is still in-flight.
    fireEvent.click(screen.getByRole('button', { name: '移除 000858' }))
    await waitFor(() => {
      expect(screen.queryByRole('link', { name: '五粮液' })).not.toBeInTheDocument()
    })
    expect(screen.getByText('已选 1 / 5')).toBeInTheDocument()

    const laojiaoMeta = COMPARE_FIXTURES['000568']?.meta
    if (!resolveDeferredSearch || !laojiaoMeta) {
      throw new Error('Test setup failure')
    }
    resolveDeferredSearch(jsonResponse([laojiaoMeta], 200))

    // Allow microtasks from handleSubmitAdd to flush, then verify stale response was dropped.
    await Promise.resolve()
    await Promise.resolve()

    expect(screen.getByText('已选 1 / 5')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: '五粮液' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: '泸州老窖' })).not.toBeInTheDocument()
    expect(compareRequests).toEqual(['600519,000858', '600519'])
  })
})
