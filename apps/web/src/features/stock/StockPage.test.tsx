import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthProvider } from '../../lib/AuthProvider'
import { setAccessToken } from '../../lib/api'
import { createQueryClient } from '../../lib/queryClient'
import type {
  JournalCreate,
  JournalEntryItem,
  StockDetail,
  TokenResponse,
  UserProfile,
  WatchlistItem,
  WatchlistUpsert,
} from '../../types/api'
import { StockPage } from './StockPage'

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

  it('renders StockDetail metadata, status tags, and interactive 9 dimension tabs', async () => {
    const stDelistedStock: StockDetail = {
      ...SAMPLE_STOCK,
      code: '000999',
      name: '*ST样本',
      exchange: 'SZ',
      is_st: true,
      is_active: false,
      snapshot_available: false,
    }

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const request = asRequest(input)
      const pathname = new URL(request.url).pathname

      if (pathname === '/api/auth/refresh') {
        return Promise.resolve(jsonResponse({ detail: '未登录' }, 401))
      }
      if (pathname === '/api/stocks/000999') {
        return Promise.resolve(jsonResponse(stDelistedStock, 200))
      }
      return Promise.resolve(jsonResponse({ detail: `Unhandled ${pathname}` }, 500))
    })

    renderStockPage('/stock/000999')

    expect(await screen.findByRole('heading', { name: '*ST样本' })).toBeInTheDocument()
    expect(screen.getByText('000999')).toBeInTheDocument()
    expect(screen.getByText('SZ')).toBeInTheDocument()
    expect(screen.getByText('ST')).toBeInTheDocument()
    expect(screen.getAllByText('已退市')).toHaveLength(2)
    expect(screen.getByText('基础元数据')).toBeInTheDocument()
    expect(screen.getByText('2001-08-27')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '登录后加入自选' })).toHaveAttribute('href', '/login')

    const tabs = screen.getAllByRole('tab')
    expect(tabs).toHaveLength(9)

    fireEvent.click(screen.getByRole('tab', { name: '护城河' }))
    expect(await screen.findByText('护城河模块规划中')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: '公司画像' }))
    expect(await screen.findByText('公司画像模块规划中')).toBeInTheDocument()
    expect(screen.getByText(/当前已接入股票基础元数据/)).toBeInTheDocument()
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

    const submitBtn = screen.getByRole('button', { name: '记录决策' })
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
})
