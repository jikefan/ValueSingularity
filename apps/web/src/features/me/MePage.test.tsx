import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthProvider } from '../../lib/AuthProvider'
import { setAccessToken } from '../../lib/api'
import { createQueryClient } from '../../lib/queryClient'
import type {
  AlertDeliveryItem,
  AlertScanSummary,
  DecisionLedgerReport,
  JournalEntryItem,
  NotificationPreferences,
  TokenResponse,
  UserProfile,
  WatchlistItem,
  WatchlistUpsert,
} from '../../types/api'
import { MePage } from './MePage'

const SAMPLE_USER: UserProfile = {
  id: '22222222-2222-2222-2222-222222222222',
  email: 'pro@example.com',
  phone: null,
  display_name: '长坡厚雪',
  plan_tier: 'pro',
  plan_expires_at: null,
  created_at: '2026-11-22T00:00:00Z',
}

const INITIAL_ITEM: WatchlistItem = {
  code: '600519',
  name: '贵州茅台',
  industry: '白酒',
  note: '批价观察',
  target_price: 1400,
  target_pe_percentile: 20,
  target_dividend_yield: 3.5,
  alert_enabled: true,
  added_at: '2026-11-22T00:00:00Z',
  updated_at: '2026-11-22T00:00:00Z',
}

const EMPTY_LEDGER: DecisionLedgerReport = {
  total_entries: 0,
  comparable_count: 0,
  win_count: 0,
  win_rate_pct: null,
  avg_stock_return_pct: null,
  avg_excess_return_pct: null,
  pass_count: 0,
  pass_avoided_loss_count: 0,
  current_benchmark_code: '000300',
  current_benchmark_price: null,
  benchmark_as_of: null,
  by_emotion: [],
  by_action: [],
  items: [],
}

const DEFAULT_PREFS: NotificationPreferences = {
  in_app_enabled: true,
  webhook_enabled: false,
  channel_type: 'feishu',
  webhook_url_configured: false,
  webhook_url_masked: null,
}

function handleEmptyPhase3Get(pathname: string, method: string): Response | null {
  if (method !== 'GET') {
    return null
  }
  if (pathname === '/api/journal/ledger') {
    return jsonResponse(EMPTY_LEDGER, 200)
  }
  if (pathname === '/api/alerts') {
    return jsonResponse([], 200)
  }
  if (pathname === '/api/alerts/preferences') {
    return jsonResponse(DEFAULT_PREFS, 200)
  }
  return null
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

function parseWatchlistUpsert(raw: string): WatchlistUpsert {
  const parsed: unknown = JSON.parse(raw)
  if (!isRecord(parsed) || typeof parsed.code !== 'string' || typeof parsed.name !== 'string') {
    throw new Error('Invalid WatchlistUpsert payload')
  }
  return {
    code: parsed.code,
    name: parsed.name,
    industry: typeof parsed.industry === 'string' ? parsed.industry : null,
    note: typeof parsed.note === 'string' ? parsed.note : null,
    target_price: typeof parsed.target_price === 'number' ? parsed.target_price : null,
    target_pe_percentile:
      typeof parsed.target_pe_percentile === 'number' ? parsed.target_pe_percentile : null,
    target_dividend_yield:
      typeof parsed.target_dividend_yield === 'number' ? parsed.target_dividend_yield : null,
    alert_enabled: Boolean(parsed.alert_enabled),
  }
}

function renderMePage() {
  const client = createQueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  })

  return render(
    <QueryClientProvider client={client}>
      <AuthProvider>
        <MemoryRouter initialEntries={['/me']}>
          <Routes>
            <Route path="/me" element={<MePage />} />
            <Route path="/login" element={<div>登录入口页</div>} />
            <Route path="/stock/:code" element={<div>个股详情</div>} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  )
}

describe('MePage', () => {
  afterEach(() => {
    cleanup()
    setAccessToken(null)
    vi.restoreAllMocks()
  })

  it('shows login guidance without calling /api/watchlist when unauthenticated', async () => {
    const calledPaths: string[] = []

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const request = asRequest(input)
      const pathname = new URL(request.url).pathname
      calledPaths.push(pathname)

      if (pathname === '/api/auth/refresh') {
        return Promise.resolve(jsonResponse({ detail: '未登录' }, 401))
      }
      return Promise.resolve(jsonResponse({ detail: 'unexpected' }, 500))
    })

    renderMePage()

    expect(await screen.findByText('登录后同步你的自选愿望单与投资日记')).toBeInTheDocument()
    const loginLink = screen.getByRole('link', { name: '前往登录 / 注册' })
    expect(loginLink).toHaveAttribute('href', '/login')
    expect(calledPaths).toEqual(['/api/auth/refresh'])
  })

  it('renders sentinel items, upserts via PUT /api/watchlist, and deletes via DELETE /api/watchlist/{code}', async () => {
    let watchlistState: WatchlistItem[] = [INITIAL_ITEM]
    let putPayload: unknown = null
    let deletedCode: string | null = null

    const tokenResponse: TokenResponse = {
      access_token: 'active-token',
      token_type: 'bearer',
      expires_in: 900,
      user: SAMPLE_USER,
    }

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const request = asRequest(input)
      const pathname = new URL(request.url).pathname

      if (pathname === '/api/auth/refresh' && request.method === 'POST') {
        return jsonResponse(tokenResponse, 200)
      }
      if (pathname === '/api/watchlist' && request.method === 'GET') {
        return jsonResponse(watchlistState, 200)
      }
      if (pathname === '/api/journal' && request.method === 'GET') {
        return jsonResponse([], 200)
      }
      if (pathname === '/api/watchlist' && request.method === 'PUT') {
        const body = parseWatchlistUpsert(await request.clone().text())
        putPayload = body
        const created: WatchlistItem = {
          code: body.code,
          name: body.name,
          industry: body.industry ?? null,
          note: body.note ?? null,
          target_price: body.target_price ?? null,
          target_pe_percentile: body.target_pe_percentile ?? null,
          target_dividend_yield: body.target_dividend_yield ?? null,
          alert_enabled: body.alert_enabled,
          added_at: '2026-11-22T01:00:00Z',
          updated_at: '2026-11-22T01:00:00Z',
        }
        watchlistState = [
          created,
          ...watchlistState.filter((existing) => existing.code !== created.code),
        ]
        return jsonResponse(created, 200)
      }
      if (pathname.startsWith('/api/watchlist/') && request.method === 'DELETE') {
        deletedCode = pathname.slice('/api/watchlist/'.length)
        watchlistState = watchlistState.filter((existing) => existing.code !== deletedCode)
        return new Response(null, { status: 204 })
      }
      const emptyPhase3 = handleEmptyPhase3Get(pathname, request.method)
      if (emptyPhase3) {
        return emptyPhase3
      }
      return jsonResponse({ detail: `Unhandled ${request.method} ${pathname}` }, 500)
    })

    renderMePage()

    expect(await screen.findByText('贵州茅台')).toBeInTheDocument()
    expect(screen.getByText('长坡厚雪')).toBeInTheDocument()
    expect(screen.getByText('PRO')).toBeInTheDocument()
    expect(screen.getByText('哨兵开启')).toBeInTheDocument()
    expect(screen.getByText('目标价 ≤ 1,400.00')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '600519' })).toHaveAttribute('href', '/stock/600519')

    fireEvent.change(screen.getByLabelText('股票代码'), { target: { value: '000858' } })
    fireEvent.change(screen.getByLabelText('股票名称'), { target: { value: '五粮液' } })
    fireEvent.change(screen.getByLabelText('行业'), { target: { value: '白酒' } })
    fireEvent.change(screen.getByLabelText('目标价（元）'), { target: { value: '120' } })
    fireEvent.change(screen.getByLabelText('备注'), { target: { value: '股息打底' } })

    fireEvent.click(screen.getByRole('button', { name: '保存自选' }))

    expect(await screen.findByText('五粮液')).toBeInTheDocument()
    expect(putPayload).toEqual({
      code: '000858',
      name: '五粮液',
      industry: '白酒',
      note: '股息打底',
      target_price: 120,
      target_pe_percentile: null,
      target_dividend_yield: null,
      alert_enabled: true,
    })

    const editButtons = screen.getAllByRole('button', { name: '编辑' })
    const firstEditButton = editButtons[0]
    expect(firstEditButton).toBeDefined()
    if (firstEditButton) {
      fireEvent.click(firstEditButton)
    }
    expect(screen.getByLabelText('股票代码')).toHaveAttribute('readonly')
    expect(screen.getByRole('button', { name: '更新愿望单' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '重置' }))
    expect(screen.getByRole('button', { name: '保存自选' })).toBeInTheDocument()

    const deleteButtons = screen.getAllByRole('button', { name: '删除' })
    const secondDeleteButton = deleteButtons[1]
    expect(secondDeleteButton).toBeDefined()
    if (secondDeleteButton) {
      fireEvent.click(secondDeleteButton)
    }

    await waitFor(() => {
      expect(screen.queryByText('贵州茅台')).not.toBeInTheDocument()
    })
    expect(deletedCode).toBe('600519')
  })

  it('enforces field length and target price bounds aligned with backend schema', async () => {
    let putCalled = false

    const tokenResponse: TokenResponse = {
      access_token: 'active-token',
      token_type: 'bearer',
      expires_in: 900,
      user: SAMPLE_USER,
    }

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const request = asRequest(input)
      const pathname = new URL(request.url).pathname

      if (pathname === '/api/auth/refresh' && request.method === 'POST') {
        return Promise.resolve(jsonResponse(tokenResponse, 200))
      }
      if (pathname === '/api/watchlist' && request.method === 'GET') {
        return Promise.resolve(jsonResponse([], 200))
      }
      if (pathname === '/api/journal' && request.method === 'GET') {
        return Promise.resolve(jsonResponse([], 200))
      }
      if (pathname === '/api/watchlist' && request.method === 'PUT') {
        putCalled = true
      }
      const emptyPhase3 = handleEmptyPhase3Get(pathname, request.method)
      if (emptyPhase3) {
        return Promise.resolve(emptyPhase3)
      }
      return Promise.resolve(
        jsonResponse({ detail: `Unhandled ${request.method} ${pathname}` }, 500),
      )
    })

    renderMePage()

    const nameInput = await screen.findByLabelText('股票名称')
    const industryInput = screen.getByLabelText('行业')
    const targetPriceInput = screen.getByLabelText('目标价（元）')

    expect(nameInput).toHaveAttribute('maxLength', '64')
    expect(industryInput).toHaveAttribute('maxLength', '64')
    expect(targetPriceInput).toHaveAttribute('min', '0.001')
    expect(targetPriceInput).toHaveAttribute('max', '999999999.999')
    expect(targetPriceInput).toHaveAttribute('step', '0.001')

    fireEvent.change(screen.getByLabelText('股票代码'), { target: { value: '600519' } })
    fireEvent.change(nameInput, { target: { value: '   ' } })
    fireEvent.click(screen.getByRole('button', { name: '保存自选' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('请输入 1–64 个字符的股票名称')

    fireEvent.change(nameInput, { target: { value: '贵州茅台' } })
    fireEvent.change(industryInput, { target: { value: '行'.repeat(65) } })
    fireEvent.click(screen.getByRole('button', { name: '保存自选' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('行业名称不能超过 64 个字符')

    fireEvent.change(industryInput, { target: { value: '白酒' } })
    fireEvent.change(targetPriceInput, { target: { value: '0.0001' } })
    fireEvent.click(screen.getByRole('button', { name: '保存自选' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('目标价不能小于 0.001')

    fireEvent.change(targetPriceInput, { target: { value: '1000000000' } })
    fireEvent.click(screen.getByRole('button', { name: '保存自选' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('目标价不能大于 999999999.999')

    expect(putCalled).toBe(false)
  })

  it('renders journal entries, filters Pass pool via server query, and deletes via DELETE /api/journal/{id}', async () => {
    let journalState: JournalEntryItem[] = [
      {
        id: 101,
        code: '600519',
        name: '贵州茅台',
        action: 'buy',
        reason: '批价企稳回升，分红率具备吸引力',
        falsify_condition: '连续两季现金流低于净利润',
        falsify_rules: null,
        max_drawdown: 18,
        emotion: '冷静',
        price: 1450,
        benchmark_code: '000300',
        benchmark_price: null,
        created_at: '2026-11-22T09:00:00Z',
      },
      {
        id: 102,
        code: '000858',
        name: '五粮液',
        action: 'pass',
        reason: '短期渠道库存偏高，暂放入观察池',
        falsify_condition: '春节动销超预期且估值回落至 12 倍以下',
        falsify_rules: null,
        max_drawdown: null,
        emotion: '克制',
        price: null,
        benchmark_code: '000300',
        benchmark_price: null,
        created_at: '2026-11-22T10:00:00Z',
      },
    ]
    const buriedPassEntry: JournalEntryItem = {
      id: 99,
      code: '600809',
      name: '山西汾酒',
      action: 'pass',
      reason: '早期高估放入观察池',
      falsify_condition: '估值回到 18 倍 PE',
      falsify_rules: null,
      max_drawdown: null,
      emotion: '克制',
      price: null,
      benchmark_code: '000300',
      benchmark_price: null,
      created_at: '2026-11-01T10:00:00Z',
    }
    const requestedJournalActions: string[][] = []
    let deletedJournalId: number | null = null

    const tokenResponse: TokenResponse = {
      access_token: 'active-token',
      token_type: 'bearer',
      expires_in: 900,
      user: SAMPLE_USER,
    }

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const request = asRequest(input)
      const url = new URL(request.url)
      const pathname = url.pathname

      if (pathname === '/api/auth/refresh' && request.method === 'POST') {
        return Promise.resolve(jsonResponse(tokenResponse, 200))
      }
      if (pathname === '/api/watchlist' && request.method === 'GET') {
        return Promise.resolve(jsonResponse([INITIAL_ITEM], 200))
      }
      if (pathname === '/api/journal' && request.method === 'GET') {
        const actions = url.searchParams.getAll('action')
        requestedJournalActions.push(actions)
        if (actions.length === 0) {
          return Promise.resolve(jsonResponse(journalState, 200))
        }
        const pool = [...journalState, buriedPassEntry].filter((entry) =>
          actions.includes(entry.action),
        )
        return Promise.resolve(jsonResponse(pool, 200))
      }
      if (pathname.startsWith('/api/journal/') && request.method === 'DELETE') {
        deletedJournalId = Number(pathname.slice('/api/journal/'.length))
        journalState = journalState.filter((entry) => entry.id !== deletedJournalId)
        return Promise.resolve(new Response(null, { status: 204 }))
      }
      const emptyPhase3 = handleEmptyPhase3Get(pathname, request.method)
      if (emptyPhase3) {
        return Promise.resolve(emptyPhase3)
      }
      return Promise.resolve(
        jsonResponse({ detail: `Unhandled ${request.method} ${pathname}` }, 500),
      )
    })

    renderMePage()

    expect(await screen.findByText('批价企稳回升，分红率具备吸引力')).toBeInTheDocument()
    expect(screen.getByText('短期渠道库存偏高，暂放入观察池')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '000858' })).toHaveAttribute('href', '/stock/000858')

    fireEvent.click(screen.getByRole('button', { name: 'Pass 观察池' }))
    expect(await screen.findByText('早期高估放入观察池')).toBeInTheDocument()
    expect(screen.getByText('短期渠道库存偏高，暂放入观察池')).toBeInTheDocument()
    expect(screen.queryByText('批价企稳回升，分红率具备吸引力')).not.toBeInTheDocument()
    expect(screen.getByText('当前筛选 2 条')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '买入 / 加仓' }))
    expect(await screen.findByText('批价企稳回升，分红率具备吸引力')).toBeInTheDocument()
    expect(screen.queryByText('短期渠道库存偏高，暂放入观察池')).not.toBeInTheDocument()

    expect(requestedJournalActions).toEqual([[], ['pass'], ['buy', 'add']])

    fireEvent.click(screen.getByRole('button', { name: '全部' }))
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: '删除日记' })).toHaveLength(2)
    })
    const journalDeleteButtons = screen.getAllByRole('button', { name: '删除日记' })
    expect(screen.getAllByRole('button', { name: '删除' })).toHaveLength(1)

    const secondJournalDelete = journalDeleteButtons[1]
    expect(secondJournalDelete).toBeDefined()
    if (secondJournalDelete) {
      fireEvent.click(secondJournalDelete)
    }

    await waitFor(() => {
      expect(screen.queryByText('短期渠道库存偏高，暂放入观察池')).not.toBeInTheDocument()
    })
    expect(deletedJournalId).toBe(102)
  })

  it('shows journal error block on 503 and recovers on retry', async () => {
    let journalAttempts = 0

    const tokenResponse: TokenResponse = {
      access_token: 'active-token',
      token_type: 'bearer',
      expires_in: 900,
      user: SAMPLE_USER,
    }

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const request = asRequest(input)
      const pathname = new URL(request.url).pathname

      if (pathname === '/api/auth/refresh' && request.method === 'POST') {
        return Promise.resolve(jsonResponse(tokenResponse, 200))
      }
      if (pathname === '/api/watchlist' && request.method === 'GET') {
        return Promise.resolve(jsonResponse([INITIAL_ITEM], 200))
      }
      if (pathname === '/api/journal' && request.method === 'GET') {
        journalAttempts += 1
        if (journalAttempts === 1) {
          return Promise.resolve(jsonResponse({ detail: '日记查询超时' }, 503))
        }
        return Promise.resolve(
          jsonResponse(
            [
              {
                id: 201,
                code: '600519',
                name: '贵州茅台',
                action: 'add',
                reason: '批价回升加仓',
                falsify_condition: '库存周转恶化',
                falsify_rules: null,
                max_drawdown: null,
                emotion: null,
                price: null,
                benchmark_code: '000300',
                benchmark_price: null,
                created_at: '2026-11-22T11:00:00Z',
              },
            ],
            200,
          ),
        )
      }
      const emptyPhase3 = handleEmptyPhase3Get(pathname, request.method)
      if (emptyPhase3) {
        return Promise.resolve(emptyPhase3)
      }
      return Promise.resolve(
        jsonResponse({ detail: `Unhandled ${request.method} ${pathname}` }, 500),
      )
    })

    renderMePage()

    expect(await screen.findByText('决策日记加载失败')).toBeInTheDocument()
    expect(screen.getByText('日记查询超时')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByText('批价回升加仓')).toBeInTheDocument()
  })

  it('renders Decision Quality Ledger with emotion attribution, CSI 300 Alpha, and falsify trigger status', async () => {
    const ledgerReport: DecisionLedgerReport = {
      total_entries: 3,
      comparable_count: 2,
      win_count: 1,
      win_rate_pct: 50.0,
      avg_stock_return_pct: 4.25,
      avg_excess_return_pct: 2.15,
      pass_count: 1,
      pass_avoided_loss_count: 1,
      current_benchmark_code: '000300',
      current_benchmark_price: 3980.5,
      benchmark_as_of: '2026-11-22',
      by_emotion: [
        {
          emotion: '冷静',
          total_count: 2,
          comparable_count: 1,
          win_count: 1,
          win_rate_pct: 100.0,
          avg_stock_return_pct: 18.5,
          avg_excess_return_pct: 14.2,
        },
        {
          emotion: '贪婪',
          total_count: 1,
          comparable_count: 1,
          win_count: 0,
          win_rate_pct: 0.0,
          avg_stock_return_pct: -10.0,
          avg_excess_return_pct: -9.9,
        },
      ],
      by_action: [],
      items: [
        {
          id: 501,
          code: '600519',
          name: '贵州茅台',
          action: 'buy',
          emotion: '冷静',
          created_at: '2026-10-01T09:00:00Z',
          entry_price: 1400,
          current_price: 1659,
          stock_return_pct: 18.5,
          entry_benchmark_price: 3816.3,
          current_benchmark_price: 3980.5,
          benchmark_return_pct: 4.3,
          excess_return_pct: 14.2,
          entry_pe_ttm: 20.5,
          current_pe_ttm: 24.3,
          entry_score: 86,
          current_score: 89,
          days_held: 52,
          falsify_triggered: false,
          falsify_triggers: [],
        },
        {
          id: 502,
          code: '000858',
          name: '五粮液',
          action: 'add',
          emotion: '贪婪',
          created_at: '2026-10-15T09:00:00Z',
          entry_price: 150,
          current_price: 135,
          stock_return_pct: -10.0,
          entry_benchmark_price: 3984.5,
          current_benchmark_price: 3980.5,
          benchmark_return_pct: -0.1,
          excess_return_pct: -9.9,
          entry_pe_ttm: 16.0,
          current_pe_ttm: 14.4,
          entry_score: 78,
          current_score: 72,
          days_held: 38,
          falsify_triggered: true,
          falsify_triggers: ['ct_red_count >= 1 (当前 1)'],
        },
      ],
    }

    const tokenResponse: TokenResponse = {
      access_token: 'active-token',
      token_type: 'bearer',
      expires_in: 900,
      user: SAMPLE_USER,
    }

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const request = asRequest(input)
      const pathname = new URL(request.url).pathname
      if (pathname === '/api/auth/refresh' && request.method === 'POST') {
        return Promise.resolve(jsonResponse(tokenResponse, 200))
      }
      if (pathname === '/api/watchlist' && request.method === 'GET') {
        return Promise.resolve(jsonResponse([], 200))
      }
      if (pathname === '/api/journal' && request.method === 'GET') {
        return Promise.resolve(jsonResponse([], 200))
      }
      if (pathname === '/api/journal/ledger' && request.method === 'GET') {
        return Promise.resolve(jsonResponse(ledgerReport, 200))
      }
      if (pathname === '/api/alerts' && request.method === 'GET') {
        return Promise.resolve(jsonResponse([], 200))
      }
      if (pathname === '/api/alerts/preferences' && request.method === 'GET') {
        return Promise.resolve(jsonResponse(DEFAULT_PREFS, 200))
      }
      return Promise.resolve(
        jsonResponse({ detail: `Unhandled ${request.method} ${pathname}` }, 500),
      )
    })

    renderMePage()

    expect(await screen.findByText('决策质量账本与沪深 300 Beta 归因')).toBeInTheDocument()
    expect(await screen.findByText('2 / 3')).toBeInTheDocument()
    expect(screen.getByText('50.0%').closest('.metric-value')).toHaveClass('tone-good')
    expect(screen.getByText('+2.15%').closest('.metric-value')).toHaveClass('tone-good')
    const passAvoidedMetric = screen
      .getByText('Pass 观察池避险')
      .parentElement?.querySelector('.metric-value')
    expect(passAvoidedMetric).toHaveTextContent('1 / 1')
    expect(passAvoidedMetric).toHaveClass('tone-good')
    expect(screen.getByText('3,980.50')).toBeInTheDocument()

    expect(screen.getByText('情绪胜率归因')).toBeInTheDocument()
    expect(screen.getByText('100.0%')).toBeInTheDocument()
    const negativeAlphaCells = screen.getAllByText('-9.90%')
    expect(negativeAlphaCells).toHaveLength(2)
    for (const cell of negativeAlphaCells) {
      expect(cell).toHaveClass('tone-bad')
    }

    expect(screen.getByText('时间胶囊对照明细')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '600519' })).toHaveAttribute('href', '/stock/600519')
    expect(screen.getByRole('link', { name: '000858' })).toHaveAttribute('href', '/stock/000858')
    expect(screen.getByText('1,400.00 → 1,659.00')).toBeInTheDocument()
    const positiveAlphaCells = screen.getAllByText('+14.20%')
    expect(positiveAlphaCells).toHaveLength(2)
    for (const cell of positiveAlphaCells) {
      expect(cell).toHaveClass('tone-good')
    }
    expect(screen.getByText('未触发')).toBeInTheDocument()
    expect(screen.getByText('已触发否证')).toBeInTheDocument()
    expect(screen.getByText('ct_red_count >= 1 (当前 1)')).toBeInTheDocument()
  })

  it('triggers manual Sentinel scan, updates alerts radar, and manages webhook preferences including 422 and clear', async () => {
    let alertsState: AlertDeliveryItem[] = []
    let prefsState: NotificationPreferences = {
      in_app_enabled: true,
      webhook_enabled: true,
      channel_type: 'feishu',
      webhook_url_configured: true,
      webhook_url_masked: 'https://open.feishu.cn/****abcd',
    }
    const savedPrefPayloads: unknown[] = []
    let scanShouldFail = false

    const newAlerts: AlertDeliveryItem[] = [
      {
        id: 1,
        source_type: 'watchlist_sentinel',
        code: '600519',
        stock_name: '贵州茅台',
        trigger_date: '2026-11-22',
        rule_signature: 'wl:abc123',
        matched_conditions: ['现价 1,380 <= 目标价 1,400'],
        detail: '贵州茅台(600519) 命中自选击球区: 现价 1,380 <= 目标价 1,400',
        current_price: 1380,
        current_pe_percentile: 18.2,
        current_dividend_yield_pct: 3.6,
        channel: 'feishu',
        status: 'sent',
        created_at: '2026-11-22T12:00:00Z',
      },
      {
        id: 2,
        source_type: 'journal_falsify',
        code: '000858',
        stock_name: '五粮液',
        trigger_date: '2026-11-22',
        rule_signature: 'jf:9:def456',
        matched_conditions: ['ct_red_count >= 1 (当前 1)'],
        detail: '五粮液(000858) 触发持仓否证红线: ct_red_count >= 1 (当前 1)',
        current_price: 135,
        current_pe_percentile: 28.0,
        current_dividend_yield_pct: 4.1,
        channel: 'in_app',
        status: 'recorded',
        created_at: '2026-11-22T12:00:00Z',
      },
    ]

    const tokenResponse: TokenResponse = {
      access_token: 'active-token',
      token_type: 'bearer',
      expires_in: 900,
      user: SAMPLE_USER,
    }

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const request = asRequest(input)
      const pathname = new URL(request.url).pathname

      if (pathname === '/api/auth/refresh' && request.method === 'POST') {
        return jsonResponse(tokenResponse, 200)
      }
      if (pathname === '/api/watchlist' && request.method === 'GET') {
        return jsonResponse([], 200)
      }
      if (pathname === '/api/journal' && request.method === 'GET') {
        return jsonResponse([], 200)
      }
      if (pathname === '/api/journal/ledger' && request.method === 'GET') {
        return jsonResponse(EMPTY_LEDGER, 200)
      }
      if (pathname === '/api/alerts' && request.method === 'GET') {
        return jsonResponse(alertsState, 200)
      }
      if (pathname === '/api/alerts/scan' && request.method === 'POST') {
        if (scanShouldFail) {
          return jsonResponse({ detail: '行情快照服务不可用' }, 503)
        }
        alertsState = newAlerts
        const summary: AlertScanSummary = {
          as_of: '2026-11-22',
          users_scanned: 1,
          evaluated_rules: 4,
          matched_count: 2,
          newly_triggered_count: 2,
          webhook_sent_count: 1,
          webhook_failed_count: 0,
          deliveries: newAlerts,
        }
        return jsonResponse(summary, 200)
      }
      if (pathname === '/api/alerts/preferences' && request.method === 'GET') {
        return jsonResponse(prefsState, 200)
      }
      if (pathname === '/api/alerts/preferences' && request.method === 'PUT') {
        const parsed: unknown = JSON.parse(await request.clone().text())
        savedPrefPayloads.push(parsed)
        if (
          isRecord(parsed) &&
          typeof parsed.webhook_url === 'string' &&
          parsed.webhook_url.includes('127.0.0.1')
        ) {
          return jsonResponse({ detail: 'Webhook URL 不能指向内网、回环或保留 IP 地址' }, 422)
        }
        if (isRecord(parsed)) {
          const clearing = parsed.webhook_url === ''
          const newUrl =
            typeof parsed.webhook_url === 'string' && parsed.webhook_url.length > 0
              ? parsed.webhook_url
              : null
          prefsState = {
            in_app_enabled: Boolean(parsed.in_app_enabled),
            webhook_enabled: Boolean(parsed.webhook_enabled),
            channel_type:
              parsed.channel_type === 'wecom' || parsed.channel_type === 'custom'
                ? parsed.channel_type
                : 'feishu',
            webhook_url_configured: clearing
              ? false
              : Boolean(newUrl ?? prefsState.webhook_url_configured),
            webhook_url_masked: clearing
              ? null
              : newUrl
                ? 'https://qyapi.weixin.qq.com/****9999'
                : prefsState.webhook_url_masked,
          }
        }
        return jsonResponse(prefsState, 200)
      }
      return jsonResponse({ detail: `Unhandled ${request.method} ${pathname}` }, 500)
    })

    renderMePage()

    expect(await screen.findByText('已配置 · https://open.feishu.cn/****abcd')).toBeInTheDocument()
    expect(screen.getByText('暂无击球区命中或否证触发记录')).toBeInTheDocument()

    scanShouldFail = true
    fireEvent.click(screen.getByRole('button', { name: '立即扫描哨兵雷达' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('行情快照服务不可用')

    scanShouldFail = false
    fireEvent.click(screen.getByRole('button', { name: '立即扫描哨兵雷达' }))
    expect(
      await screen.findByText(
        '本次扫描完成：评估 4 条 · 命中 2 条 · 新增 2 条 · Webhook 成功 1 / 失败 0（基准日 2026-11-22）',
      ),
    ).toBeInTheDocument()
    expect(await screen.findByText('击球区命中')).toBeInTheDocument()
    expect(screen.getByText('否证红线')).toBeInTheDocument()
    expect(screen.getByText('Webhook 已送达')).toBeInTheDocument()
    expect(screen.getByText('站内已记录')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '600519' })).toHaveAttribute('href', '/stock/600519')
    expect(screen.getByRole('link', { name: '000858' })).toHaveAttribute('href', '/stock/000858')

    fireEvent.change(screen.getByLabelText('推送渠道类型'), { target: { value: 'wecom' } })
    fireEvent.click(screen.getByRole('button', { name: '保存推送设置' }))
    expect(await screen.findByText('推送渠道设置已保存')).toBeInTheDocument()
    expect(savedPrefPayloads[0]).toEqual({
      in_app_enabled: true,
      webhook_enabled: true,
      channel_type: 'wecom',
    })

    fireEvent.change(screen.getByLabelText('新 Webhook URL（可选）'), {
      target: { value: 'http://127.0.0.1/hook' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存推送设置' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Webhook URL 不能指向内网、回环或保留 IP 地址',
    )

    fireEvent.click(screen.getByRole('button', { name: '清空 Webhook' }))
    expect(await screen.findByText('已清空 Webhook 地址并关闭外部推送')).toBeInTheDocument()
    expect(screen.getByText('Webhook 未配置')).toBeInTheDocument()
    expect(savedPrefPayloads[2]).toEqual({
      in_app_enabled: true,
      webhook_enabled: false,
      channel_type: 'wecom',
      webhook_url: '',
    })
  })
})
