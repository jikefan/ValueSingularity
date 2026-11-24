import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createQueryClient } from '../../lib/queryClient'
import type { StockCompareItem, StockMetaRecord, StockScreenerResponse } from '../../types/api'
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
      snapshot_available: true,
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
      is_financial: false,
      earnings_quality_tag: 'core_cash_cow',
      earnings_quality_label: '主业造血现金牛',
      invest_profit_share_3y_pct: 1.4,
      investment_assets_ratio_pct: 2.8,
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
      snapshot_available: false,
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
      snapshot_available: true,
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
      is_financial: false,
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
      snapshot_available: false,
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
      snapshot_available: false,
    },
    snapshot_available: false,
    snapshot_as_of: null,
    metrics: null,
  },
  '600036': {
    code: '600036',
    meta: {
      code: '600036',
      name: '招商银行',
      exchange: 'SH',
      industry_sw1: '银行',
      industry_sw2: '股份制银行',
      list_date: '2002-04-09',
      is_st: false,
      is_active: true,
      snapshot_available: true,
    },
    snapshot_available: true,
    snapshot_as_of: '2026-11-20',
    metrics: {
      code: '600036',
      name: '招商银行',
      exchange: 'SH',
      industry_sw1: '银行',
      as_of: '2026-11-20',
      close: 38.5,
      total_mv_yuan: 9.7e11,
      pe_ttm: 6.4,
      pe_percentile_10y: 42.0,
      pb: 0.92,
      roe_5y_avg_pct: 15.6,
      gross_margin_latest_pct: null,
      net_cash_to_mv_pct: null,
      ocf_to_profit_5y_pct: null,
      shareholder_yield_pct: 5.12,
      implied_fcf_cagr_pct: null,
      ct_red_count: 0,
      ct_yellow_count: 0,
      total_score: 84,
      is_financial: true,
    },
  },
  '601398': {
    code: '601398',
    meta: {
      code: '601398',
      name: '工商银行',
      exchange: 'SH',
      industry_sw1: '银行',
      industry_sw2: '国有大行',
      list_date: '2006-10-27',
      is_st: false,
      is_active: true,
      snapshot_available: true,
    },
    snapshot_available: true,
    snapshot_as_of: '2026-11-20',
    metrics: null,
  },
  '000001': {
    code: '000001',
    meta: {
      code: '000001',
      name: '平安银行',
      exchange: 'SZ',
      industry_sw1: '银行',
      industry_sw2: '股份制银行',
      list_date: '1991-04-03',
      is_st: false,
      is_active: true,
      snapshot_available: false,
    },
    snapshot_available: false,
    snapshot_as_of: null,
    metrics: null,
  },
  '000333': {
    code: '000333',
    meta: {
      code: '000333',
      name: '美的集团',
      exchange: 'SZ',
      industry_sw1: '家用电器',
      industry_sw2: '白色家电',
      list_date: '2013-09-18',
      is_st: false,
      is_active: true,
      snapshot_available: true,
    },
    snapshot_available: true,
    snapshot_as_of: '2026-11-20',
    metrics: null,
  },
  '002594': {
    code: '002594',
    meta: {
      code: '002594',
      name: '比亚迪',
      exchange: 'SZ',
      industry_sw1: '汽车',
      industry_sw2: '乘用车',
      list_date: '2011-06-30',
      is_st: false,
      is_active: true,
      snapshot_available: true,
    },
    snapshot_available: true,
    snapshot_as_of: '2026-11-20',
    metrics: null,
  },
  '600887': {
    code: '600887',
    meta: {
      code: '600887',
      name: '伊利股份',
      exchange: 'SH',
      industry_sw1: '食品饮料',
      industry_sw2: '乳品',
      list_date: '1996-03-12',
      is_st: false,
      is_active: true,
      snapshot_available: true,
    },
    snapshot_available: true,
    snapshot_as_of: '2026-11-20',
    metrics: null,
  },
}

const SEARCH_ITEMS: StockMetaRecord[] = Object.values(COMPARE_FIXTURES).map((item) => item.meta)

const SAMPLE_SCREENER: StockScreenerResponse = {
  total_synced: 2,
  filtered_count: 2,
  industries: ['食品饮料', '银行'],
  items: [
    {
      code: '600519',
      name: '贵州茅台',
      exchange: 'SH',
      industry_sw1: '食品饮料',
      as_of: '2026-11-20',
      close: 1520,
      total_mv_yuan: 1.91e12,
      pe_ttm: 22.1,
      pe_percentile_10y: 26.5,
      pb: 7.8,
      pb_percentile_10y: 22.0,
      roe_5y_avg_pct: 31.8,
      dividend_yield_pct: 3.66,
      shareholder_yield_pct: 3.66,
      implied_fcf_cagr_pct: 8.42,
      ct_red_count: 0,
      ct_yellow_count: 1,
      ct_green_count: 10,
      total_score: 89,
      valuation_margin: 74,
      is_financial: false,
    },
    {
      code: '600036',
      name: '招商银行',
      exchange: 'SH',
      industry_sw1: '银行',
      as_of: '2026-11-20',
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
  ],
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
          <Route path="/" element={<div>首页筛选</div>} />
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

  it('renders empty state presets including bank/blue-chip and synced screener hot preset', async () => {
    const compareRequests: string[] = []

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = new URL(asRequest(input).url)
      if (url.pathname === '/api/stocks/screener') {
        return Promise.resolve(jsonResponse(SAMPLE_SCREENER, 200))
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

    renderComparePage('/compare')

    expect(screen.getByRole('heading', { name: '同业横向对比', level: 1 })).toBeInTheDocument()
    expect(screen.getByText('请添加 1–5 支标的开始同业横向对比')).toBeInTheDocument()
    expect(screen.getByText('或选择精选行业对比方案')).toBeInTheDocument()

    const bankPresetBtn = screen.getByRole('button', {
      name: '高股息银行 (600036/601398/000001)',
    })
    expect(bankPresetBtn).toHaveClass('tk-card', 'compare-preset-card')
    expect(within(bankPresetBtn).getByText('高股息银行')).toBeInTheDocument()
    expect(within(bankPresetBtn).getByText('低估值高分红红利代表')).toBeInTheDocument()
    expect(within(bankPresetBtn).getByText('一键对比 →')).toBeInTheDocument()
    expect(within(bankPresetBtn).getByText('600036')).toBeInTheDocument()
    expect(within(bankPresetBtn).getByText('601398')).toBeInTheDocument()
    expect(within(bankPresetBtn).getByText('000001')).toBeInTheDocument()

    expect(
      screen.getByRole('button', { name: '制造消费蓝筹 (000333/002594/600887)' }),
    ).toBeInTheDocument()

    const hotSyncedBtn = await screen.findByRole('button', { name: '对比已同步热门标的' })
    expect(hotSyncedBtn).toHaveClass('btn-primary', 'compare-hot-btn')
    fireEvent.click(hotSyncedBtn)

    expect(await screen.findByRole('link', { name: '贵州茅台' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '招商银行' })).toBeInTheDocument()
    expect(compareRequests).toEqual(['600519,600036'])

    fireEvent.click(screen.getByRole('button', { name: '清空列表' }))
    const presetBtn = await screen.findByRole('button', {
      name: '白酒龙头对比 (600519/000858/000568)',
    })
    expect(within(presetBtn).getByText('白酒龙头对比')).toBeInTheDocument()
    expect(within(presetBtn).getByText('高端消费与现金流标杆')).toBeInTheDocument()
    expect(within(presetBtn).getByText('600519')).toBeInTheDocument()
    expect(within(presetBtn).getByText('000858')).toBeInTheDocument()
    expect(within(presetBtn).getByText('000568')).toBeInTheDocument()
    fireEvent.click(presetBtn)

    expect(await screen.findByRole('link', { name: '贵州茅台' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '五粮液' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '泸州老窖' })).toBeInTheDocument()
    expect(compareRequests).toEqual(['600519,600036', '600519,000858,000568'])
  })

  it('auto-syncs unsynced compare items in background, renders 自动拉取中…, and hydrates matrix on settlement', async () => {
    let resolveSync: ((response: Response) => void) | undefined
    const deferredSync = new Promise<Response>((resolve) => {
      resolveSync = resolve
    })
    let wuliangyeSynced = false
    const syncCalls: string[] = []

    const wuliangyeBase = COMPARE_FIXTURES['000858']
    if (!wuliangyeBase) {
      throw new Error('Expected 000858 compare fixture')
    }
    const syncedWuliangye: StockCompareItem = {
      code: '000858',
      meta: {
        ...wuliangyeBase.meta,
        snapshot_available: true,
      },
      snapshot_available: true,
      snapshot_as_of: '2026-11-20',
      metrics: {
        code: '000858',
        name: '五粮液',
        exchange: 'SZ',
        industry_sw1: '食品饮料',
        as_of: '2026-11-20',
        close: 148.2,
        total_mv_yuan: 5.75e11,
        pe_ttm: 17.6,
        pe_percentile_10y: 19.4,
        pb: 4.3,
        roe_5y_avg_pct: 25.1,
        gross_margin_latest_pct: 77.2,
        net_cash_to_mv_pct: 18.4,
        ocf_to_profit_5y_pct: 109.5,
        shareholder_yield_pct: 3.9,
        implied_fcf_cagr_pct: 5.8,
        ct_red_count: 0,
        ct_yellow_count: 0,
        total_score: 85,
        is_financial: false,
      },
    }

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const request = asRequest(input)
      const url = new URL(request.url)
      if (url.pathname === '/api/stocks/000858/sync' && request.method === 'POST') {
        syncCalls.push('000858')
        return deferredSync
      }
      if (url.pathname === '/api/stocks/compare') {
        const codesParam = url.searchParams.get('codes') ?? ''
        const items = codesParam
          .split(',')
          .map((code) =>
            code === '000858' && wuliangyeSynced ? syncedWuliangye : COMPARE_FIXTURES[code],
          )
          .filter((item): item is StockCompareItem => Boolean(item))
        return Promise.resolve(jsonResponse(items, 200))
      }
      return Promise.resolve(jsonResponse({ detail: `Unhandled ${url.pathname}` }, 500))
    })

    renderComparePage('/compare?codes=600519,000858')

    expect(await screen.findByText('自动拉取中…')).toBeInTheDocument()
    expect(screen.getByText(/正在为/)).toHaveTextContent('000858')

    wuliangyeSynced = true
    if (!resolveSync) {
      throw new Error('Expected sync resolver')
    }
    resolveSync(jsonResponse({ code: '000858' }, 200))

    expect(await screen.findByText('85 / 100')).toBeInTheDocument()
    expect(screen.queryByText('自动拉取中…')).not.toBeInTheDocument()
    expect(screen.getAllByText('已同步 2026-11-20')).toHaveLength(2)
    expect(syncCalls).toEqual(['000858'])
  })

  it('renders mixed synced/unsynced items with one-shot failure fallback, financial exempt labels, glossary hints, and search snapshot badges', async () => {
    const syncAttempts = new Map<string, number>()

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const request = asRequest(input)
      const url = new URL(request.url)
      if (url.pathname === '/api/stocks/screener') {
        return Promise.resolve(jsonResponse(SAMPLE_SCREENER, 200))
      }
      if (url.pathname === '/api/stocks/search') {
        const q = url.searchParams.get('q') ?? ''
        const matched = SEARCH_ITEMS.filter(
          (item) => item.name.includes(q) || item.code.includes(q),
        )
        return Promise.resolve(jsonResponse(matched, 200))
      }
      if (url.pathname.endsWith('/sync') && request.method === 'POST') {
        const code = url.pathname.split('/')[3] ?? ''
        syncAttempts.set(code, (syncAttempts.get(code) ?? 0) + 1)
        return Promise.resolve(jsonResponse({ detail: '上游数据源暂不可用' }, 503))
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

    renderComparePage('/compare?codes=600519,000858,600036')

    expect(await screen.findByText('89 / 100')).toBeInTheDocument()
    expect(screen.getByText('19,100.00 亿元')).toBeInTheDocument()
    expect(screen.getByText('+8.42%')).toBeInTheDocument()
    expect(screen.getByText('+8.42%')).toHaveClass('tone-bad')
    expect(screen.getByText('3.66%')).toHaveClass('tone-good')
    expect(screen.getByText('9.69%')).toHaveClass('tone-good')
    expect(screen.getByText('0 红 / 1 黄')).toBeInTheDocument()
    expect(await screen.findByText('同步失败（暂缺）')).toBeInTheDocument()
    expect(syncAttempts.get('000858')).toBe(1)

    // Glossary hints open cleanly for matrix title and metric rows.
    fireEvent.click(screen.getByRole('button', { name: '解释：净现金 / 总市值' }))
    expect(screen.getByRole('tooltip')).toHaveTextContent('货币资金 + 交易性金融资产')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()

    // Financial metrics on bank display 行业不适用 across all 6 bank-exempt rows rather than em dash.
    expect(screen.getAllByText('行业不适用')).toHaveLength(6)
    for (const label of [
      '最新毛利率',
      '净现金 / 总市值',
      '5年 OCF / 净利润',
      'Reverse DCF 隐含 FCF 增速',
      '近3年投资收益占比',
      '表内投资类资产占比',
    ]) {
      const row = screen.getByText(label).closest('tr')
      if (!row) {
        throw new Error(`Expected table row for ${label}`)
      }
      expect(within(row).getByText('行业不适用')).toBeInTheDocument()
    }
    // No CLI sync command leaked to end users; link back to homepage screener exists.
    expect(screen.queryByText(/python -m app\.cli\.sync_stocks/)).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: '前往首页浏览已覆盖全量财报的标的' })).toHaveAttribute(
      'href',
      '/',
    )

    const addInput = screen.getByLabelText('添加对比股票')

    fireEvent.change(addInput, { target: { value: '600519' } })
    fireEvent.click(screen.getByRole('button', { name: '添加对比' }))
    expect(screen.getByRole('alert')).toHaveTextContent('600519 已在对比列表中')

    fireEvent.change(addInput, { target: { value: '老窖' } })
    const option = await screen.findByRole('option', { name: /000568.*泸州老窖/ })
    expect(screen.getByText('已同步快照')).toBeInTheDocument()
    fireEvent.click(option)
    expect(await screen.findByText('81 / 100')).toBeInTheDocument()
    expect(screen.getByText('1 红 / 0 黄')).toBeInTheDocument()
    // Adding 000568 must not re-attempt failed sync for 000858.
    expect(syncAttempts.get('000858')).toBe(1)

    // Search for an unsynced stock shows 仅基础信息 badge.
    fireEvent.change(addInput, { target: { value: '洋河' } })
    expect(await screen.findByRole('option', { name: /002304.*洋河股份/ })).toBeInTheDocument()
    expect(screen.getByText('仅基础信息')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '移除 000858' }))
    expect(screen.queryByRole('link', { name: '五粮液' })).not.toBeInTheDocument()

    for (const code of ['000858', '600809']) {
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
      if (url.pathname === '/api/stocks/000858/sync') {
        return Promise.resolve(jsonResponse({ detail: '同步暂不可用' }, 503))
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

  it('forces 行业不适用 on legacy cached bank snapshots with deposit-skewed ratios', async () => {
    const bankFixture = COMPARE_FIXTURES['600036']
    if (!bankFixture?.metrics) {
      throw new Error('Expected bank fixture with metrics')
    }
    const legacyBank: StockCompareItem = {
      ...bankFixture,
      metrics: {
        ...bankFixture.metrics,
        gross_margin_latest_pct: null,
        net_cash_to_mv_pct: -12.34,
        ocf_to_profit_5y_pct: 285.4,
        implied_fcf_cagr_pct: -6.78,
      },
    }

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = new URL(asRequest(input).url)
      if (url.pathname === '/api/stocks/compare') {
        return Promise.resolve(jsonResponse([legacyBank], 200))
      }
      return Promise.resolve(jsonResponse({ detail: `Unhandled ${url.pathname}` }, 500))
    })

    renderComparePage('/compare?codes=600036')

    expect(await screen.findByText('84 / 100')).toBeInTheDocument()
    expect(screen.getAllByText('行业不适用')).toHaveLength(6)
    expect(screen.queryByText('-12.34%')).not.toBeInTheDocument()
    expect(screen.queryByText('285.4%')).not.toBeInTheDocument()
    expect(screen.queryByText('-6.78%')).not.toBeInTheDocument()
  })

  it('renders forensic earnings quality rows across industrial, investment-driven, financial, and legacy/unsynced items', async () => {
    const youngor: StockCompareItem = {
      code: '600177',
      meta: {
        code: '600177',
        name: '雅戈尔',
        exchange: 'SH',
        industry_sw1: '纺织服饰',
        industry_sw2: '服装家纺',
        list_date: '1998-11-19',
        is_st: false,
        is_active: true,
        snapshot_available: true,
      },
      snapshot_available: true,
      snapshot_as_of: '2026-11-20',
      metrics: {
        code: '600177',
        name: '雅戈尔',
        exchange: 'SH',
        industry_sw1: '纺织服饰',
        as_of: '2026-11-20',
        close: 8.12,
        total_mv_yuan: 3.75e10,
        pe_ttm: 9.8,
        pe_percentile_10y: 24.0,
        pb: 0.94,
        roe_5y_avg_pct: 9.6,
        gross_margin_latest_pct: 48.2,
        net_cash_to_mv_pct: -18.5,
        ocf_to_profit_5y_pct: 61.0,
        shareholder_yield_pct: 5.4,
        implied_fcf_cagr_pct: 3.1,
        ct_red_count: 1,
        ct_yellow_count: 1,
        total_score: 54,
        is_financial: false,
        earnings_quality_tag: 'investment_driven',
        earnings_quality_label: '盈利高度依赖对外投资',
        invest_profit_share_3y_pct: 68.4,
        investment_assets_ratio_pct: 52.1,
      },
    }

    const moutaiFixture = COMPARE_FIXTURES['600519']
    const bankBase = COMPARE_FIXTURES['600036']
    const laojiaoLegacy = COMPARE_FIXTURES['000568']
    const wuliangyeFixture = COMPARE_FIXTURES['000858']
    if (!moutaiFixture || !bankBase?.metrics || !laojiaoLegacy || !wuliangyeFixture) {
      throw new Error('Missing fixtures')
    }
    const syncedBankWithForensics: StockCompareItem = {
      ...bankBase,
      metrics: {
        ...bankBase.metrics,
        earnings_quality_tag: 'financial_special',
        earnings_quality_label: '金融特殊结构',
        invest_profit_share_3y_pct: 12.0,
        investment_assets_ratio_pct: 22.0,
      },
    }

    const itemsByCode: Record<string, StockCompareItem> = {
      '600519': moutaiFixture,
      '600177': youngor,
      '600036': syncedBankWithForensics,
      '000568': laojiaoLegacy,
      '000858': wuliangyeFixture,
    }

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const request = asRequest(input)
      const url = new URL(request.url)
      if (url.pathname.endsWith('/sync') && request.method === 'POST') {
        return Promise.resolve(jsonResponse({ detail: '跳过同步' }, 503))
      }
      if (url.pathname === '/api/stocks/compare') {
        const codesParam = url.searchParams.get('codes') ?? ''
        const items = codesParam
          .split(',')
          .map((code) => itemsByCode[code])
          .filter((item): item is StockCompareItem => Boolean(item))
        return Promise.resolve(jsonResponse(items, 200))
      }
      return Promise.resolve(jsonResponse({ detail: `Unhandled ${url.pathname}` }, 500))
    })

    renderComparePage('/compare?codes=600519,600177,600036,000568,000858')

    expect(await screen.findByText('主业造血现金牛')).toBeInTheDocument()

    const qualityRow = screen.getByText('盈利成色标签').closest('tr')
    const investShareRow = screen.getByText('近3年投资收益占比').closest('tr')
    const investAssetRow = screen.getByText('表内投资类资产占比').closest('tr')
    if (!qualityRow || !investShareRow || !investAssetRow) {
      throw new Error('Expected forensic rows in compare matrix')
    }

    expect(within(qualityRow).getByText('主业造血现金牛')).toHaveClass(
      'quality-badge',
      'quality-badge-green',
    )
    expect(within(qualityRow).getByText('盈利高度依赖对外投资')).toHaveClass(
      'quality-badge',
      'quality-badge-red',
    )
    expect(within(qualityRow).getByText('金融特殊结构')).toHaveClass(
      'quality-badge',
      'quality-badge-blue',
    )
    // Legacy synced (000568) and unsynced (000858) show em dash cleanly.
    expect(within(qualityRow).getAllByText('—')).toHaveLength(2)

    expect(within(investShareRow).getByText('1.4%')).not.toHaveClass('tone-bad')
    expect(within(investShareRow).getByText('68.4%')).toHaveClass('tone-bad')
    expect(within(investShareRow).getByText('行业不适用')).toBeInTheDocument()
    expect(within(investShareRow).getAllByText('—')).toHaveLength(2)

    expect(within(investAssetRow).getByText('2.8%')).toBeInTheDocument()
    expect(within(investAssetRow).getByText('52.1%')).toBeInTheDocument()
    expect(within(investAssetRow).getByText('行业不适用')).toBeInTheDocument()
    expect(within(investAssetRow).getAllByText('—')).toHaveLength(2)
  })

  it('trusts metrics.is_financial directly and renders subsidy_inflated quality badge as red', async () => {
    const fintechFinancial: StockCompareItem = {
      code: '300059',
      meta: {
        code: '300059',
        name: '东方财富信息',
        exchange: 'SZ',
        industry_sw1: '非银金融',
        industry_sw2: '证券Ⅱ',
        list_date: '2010-03-19',
        is_st: false,
        is_active: true,
        snapshot_available: true,
      },
      snapshot_available: true,
      snapshot_as_of: '2026-11-20',
      metrics: {
        code: '300059',
        name: '东方财富信息',
        exchange: 'SZ',
        industry_sw1: '非银金融',
        as_of: '2026-11-20',
        close: 24.5,
        total_mv_yuan: 3.8e11,
        pe_ttm: 38.0,
        pe_percentile_10y: 55.0,
        pb: 4.5,
        roe_5y_avg_pct: 14.2,
        gross_margin_latest_pct: null,
        net_cash_to_mv_pct: -5.0,
        ocf_to_profit_5y_pct: 180.0,
        shareholder_yield_pct: 0.5,
        implied_fcf_cagr_pct: 12.0,
        ct_red_count: 0,
        ct_yellow_count: 0,
        total_score: 72,
        is_financial: true,
        earnings_quality_tag: 'financial_special',
        earnings_quality_label: '金融专项口径',
      },
    }
    const subsidyNonFinancial: StockCompareItem = {
      code: '688001',
      meta: {
        code: '688001',
        name: '补贴样本',
        exchange: 'SH',
        industry_sw1: '电子',
        industry_sw2: '半导体',
        list_date: '2020-01-01',
        is_st: false,
        is_active: true,
        snapshot_available: true,
      },
      snapshot_available: true,
      snapshot_as_of: '2026-11-20',
      metrics: {
        code: '688001',
        name: '补贴样本',
        exchange: 'SH',
        industry_sw1: '电子',
        as_of: '2026-11-20',
        close: 32.0,
        total_mv_yuan: 1.5e10,
        pe_ttm: 28.0,
        pe_percentile_10y: 35.0,
        pb: 2.8,
        roe_5y_avg_pct: 10.2,
        gross_margin_latest_pct: 36.4,
        net_cash_to_mv_pct: 4.2,
        ocf_to_profit_5y_pct: 75.0,
        shareholder_yield_pct: 0.9,
        implied_fcf_cagr_pct: 4.5,
        ct_red_count: 0,
        ct_yellow_count: 1,
        total_score: 68,
        is_financial: false,
        earnings_quality_tag: 'subsidy_inflated',
        earnings_quality_label: '补贴 / 一次性损益偏高',
      },
    }

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = new URL(asRequest(input).url)
      if (url.pathname === '/api/stocks/compare') {
        return Promise.resolve(jsonResponse([fintechFinancial, subsidyNonFinancial], 200))
      }
      return Promise.resolve(jsonResponse({ detail: `Unhandled ${url.pathname}` }, 500))
    })

    renderComparePage('/compare?codes=300059,688001')

    expect(await screen.findByText('72 / 100')).toBeInTheDocument()
    // metrics.is_financial=true exempts all 6 rows even though name contains '信息'.
    expect(screen.getAllByText('行业不适用')).toHaveLength(6)

    const qualityRow = screen.getByText('盈利成色标签').closest('tr')
    if (!qualityRow) {
      throw new Error('Expected quality row')
    }
    expect(within(qualityRow).getByText('补贴 / 一次性损益偏高')).toHaveClass(
      'quality-badge',
      'quality-badge-red',
    )
  })
})
