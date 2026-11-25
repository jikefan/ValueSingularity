import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthProvider } from '../../lib/AuthProvider'
import { getAccessToken, setAccessToken } from '../../lib/api'
import { createQueryClient } from '../../lib/queryClient'
import { queryKeys } from '../../lib/queryKeys'
import type {
  AiPreferences,
  AlertDeliveryItem,
  AlertScanSummary,
  AuthConfigResponse,
  DecisionLedgerReport,
  EmailCodeSendResponse,
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
  email_verified: true,
  plan_tier: 'pro',
  plan_expires_at: null,
  created_at: '2026-11-22T00:00:00Z',
}

const DEFAULT_AUTH_CONFIG: AuthConfigResponse = {
  email_verification_required: false,
  smtp_configured: false,
  code_ttl_minutes: 10,
  code_cooldown_seconds: 60,
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

const DEFAULT_AI_PREFS: AiPreferences = {
  prefer_rule_only: false,
  byok_enabled: false,
  byok_base_url_masked: null,
  byok_api_key_configured: false,
  byok_api_key_masked: null,
  byok_model: 'gpt-4o-mini',
  quota: {
    plan_tier: 'pro',
    daily_limit: 30,
    used_today: 2,
    remaining_today: 28,
    byok_active: false,
    resets_at_shanghai: '2026-11-23 24:00 CST',
  },
}

function handleEmptyPhase3Get(pathname: string, method: string): Response | null {
  if (method !== 'GET') {
    return null
  }
  if (pathname === '/api/auth/config') {
    return jsonResponse(DEFAULT_AUTH_CONFIG, 200)
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
  if (pathname === '/api/ai/preferences') {
    return jsonResponse(DEFAULT_AI_PREFS, 200)
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

  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <AuthProvider>
          <MemoryRouter initialEntries={['/me']}>
            <Routes>
              <Route path="/" element={<div>首页已跳转</div>} />
              <Route path="/me" element={<MePage />} />
              <Route path="/login" element={<div>登录入口页</div>} />
              <Route path="/stock/:code" element={<div>个股详情</div>} />
            </Routes>
          </MemoryRouter>
        </AuthProvider>
      </QueryClientProvider>,
    ),
  }
}

describe('MePage', () => {
  afterEach(() => {
    vi.useRealTimers()
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
    expect(screen.getByText('能力示例预览 · 登录后使用实时个人数据')).toBeInTheDocument()
    expect(screen.getByText('到价邮件提醒')).toBeInTheDocument()
    expect(screen.getByText('买卖超额对比账本')).toBeInTheDocument()
    expect(screen.getByText('情绪胜率统计')).toBeInTheDocument()
    expect(screen.getByText('好公司跌到心里价位，自动给你发邮件')).toBeInTheDocument()
    expect(screen.getByText('每笔买入与放弃，事后对照沪深 300 算总账')).toBeInTheDocument()
    expect(screen.queryByText(/Webhook/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Alpha 归因/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Pass 观察池/)).not.toBeInTheDocument()
    expect(screen.queryByText(/否证红线/)).not.toBeInTheDocument()

    // Interactive read-only guest sample preview card toggles between watchlist and journal tabs.
    const watchlistTab = screen.getByRole('tab', { name: '示范愿望单（2 只）' })
    const journalTab = screen.getByRole('tab', { name: '示范复盘日记（1 笔）' })
    expect(watchlistTab).toHaveAttribute('aria-selected', 'true')
    expect(journalTab).toHaveAttribute('aria-selected', 'false')
    expect(screen.getByText('贵州茅台')).toBeInTheDocument()
    expect(screen.getByText('长江电力')).toBeInTheDocument()
    expect(screen.getByText(/目标价 ≤ 1,400 \/ PE 分位 ≤ 20%/)).toBeInTheDocument()
    expect(screen.getByText(/股息率 ≥ 3\.8% \/ PE 分位 ≤ 50%/)).toBeInTheDocument()
    expect(screen.getAllByText(/触发后会发生什么/)).toHaveLength(2)

    fireEvent.click(journalTab)
    expect(journalTab).toHaveAttribute('aria-selected', 'true')
    expect(watchlistTab).toHaveAttribute('aria-selected', 'false')
    expect(screen.getByText('雅戈尔')).toBeInTheDocument()
    expect(screen.getByText('当时心态：冷静')).toBeInTheDocument()
    expect(screen.getByText('买前自检清单已记录')).toBeInTheDocument()
    expect(screen.getByText(/3 个月后对照沪深 300 复盘/)).toBeInTheDocument()

    fireEvent.click(watchlistTab)
    expect(watchlistTab).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('贵州茅台')).toBeInTheDocument()

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
      if (pathname === '/api/auth/config' && request.method === 'GET') {
        return jsonResponse(DEFAULT_AUTH_CONFIG, 200)
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
    const watchlistLink = screen.getByRole('link', { name: '600519' })
    expect(watchlistLink).toHaveAttribute('href', '/stock/600519')
    const watchlistTable = watchlistLink.closest('table')
    expect(watchlistTable).toHaveClass('watchlist-table')
    expect(watchlistTable?.parentElement).toHaveClass('table-wrap')

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
      if (pathname === '/api/auth/config' && request.method === 'GET') {
        return Promise.resolve(jsonResponse(DEFAULT_AUTH_CONFIG, 200))
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
      if (pathname === '/api/auth/config' && request.method === 'GET') {
        return Promise.resolve(jsonResponse(DEFAULT_AUTH_CONFIG, 200))
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
      if (pathname === '/api/auth/config' && request.method === 'GET') {
        return Promise.resolve(jsonResponse(DEFAULT_AUTH_CONFIG, 200))
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
      if (pathname === '/api/auth/config' && request.method === 'GET') {
        return Promise.resolve(jsonResponse(DEFAULT_AUTH_CONFIG, 200))
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
      if (pathname === '/api/ai/preferences' && request.method === 'GET') {
        return Promise.resolve(jsonResponse(DEFAULT_AI_PREFS, 200))
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

  it('uses 绝对收益胜率 with neutral tone for first-day flat ledger entries, while keeping tone-bad for real losses', async () => {
    const firstDayFlatItem = {
      id: 601,
      code: '600519',
      name: '贵州茅台',
      action: 'buy' as const,
      emotion: '冷静',
      created_at: '2026-11-22T09:00:00Z',
      entry_price: 1520,
      current_price: 1520,
      stock_return_pct: 0.0,
      entry_benchmark_price: null,
      current_benchmark_price: null,
      benchmark_return_pct: null,
      excess_return_pct: null,
      entry_pe_ttm: 22.1,
      current_pe_ttm: 22.1,
      entry_score: 89,
      current_score: 89,
      days_held: 0,
      falsify_triggered: false,
      falsify_triggers: [],
    }

    const firstDayFlatLedger: DecisionLedgerReport = {
      total_entries: 1,
      comparable_count: 1,
      win_count: 0,
      win_rate_pct: 0.0,
      avg_stock_return_pct: 0.0,
      avg_excess_return_pct: null,
      pass_count: 0,
      pass_avoided_loss_count: 0,
      current_benchmark_code: '000300',
      current_benchmark_price: null,
      benchmark_as_of: null,
      by_emotion: [
        {
          emotion: '冷静',
          total_count: 1,
          comparable_count: 1,
          win_count: 0,
          win_rate_pct: 0.0,
          avg_stock_return_pct: 0.0,
          avg_excess_return_pct: null,
        },
      ],
      by_action: [],
      items: [firstDayFlatItem],
    }

    const realLossLedger: DecisionLedgerReport = {
      ...firstDayFlatLedger,
      avg_stock_return_pct: -8.5,
      avg_excess_return_pct: -6.2,
      current_benchmark_price: 3980.5,
      benchmark_as_of: '2026-11-22',
      by_emotion: [
        {
          emotion: '冷静',
          total_count: 1,
          comparable_count: 1,
          win_count: 0,
          win_rate_pct: 0.0,
          avg_stock_return_pct: -8.5,
          avg_excess_return_pct: -6.2,
        },
      ],
      items: [
        {
          ...firstDayFlatItem,
          current_price: 1390.8,
          stock_return_pct: -8.5,
          entry_benchmark_price: 4074.2,
          current_benchmark_price: 3980.5,
          benchmark_return_pct: -2.3,
          excess_return_pct: -6.2,
          days_held: 12,
        },
      ],
    }

    let currentLedger = firstDayFlatLedger
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
      if (pathname === '/api/auth/config' && request.method === 'GET') {
        return Promise.resolve(jsonResponse(DEFAULT_AUTH_CONFIG, 200))
      }
      if (pathname === '/api/watchlist' && request.method === 'GET') {
        return Promise.resolve(jsonResponse([], 200))
      }
      if (pathname === '/api/journal' && request.method === 'GET') {
        return Promise.resolve(jsonResponse([], 200))
      }
      if (pathname === '/api/journal/ledger' && request.method === 'GET') {
        return Promise.resolve(jsonResponse(currentLedger, 200))
      }
      const emptyPhase3 = handleEmptyPhase3Get(pathname, request.method)
      if (emptyPhase3) {
        return Promise.resolve(emptyPhase3)
      }
      return Promise.resolve(
        jsonResponse({ detail: `Unhandled ${request.method} ${pathname}` }, 500),
      )
    })

    const flatView = renderMePage()

    expect(await screen.findByText('绝对收益胜率')).toBeInTheDocument()
    expect(screen.queryByText('跑赢沪深 300 胜率')).not.toBeInTheDocument()
    expect(screen.getByText('首日平价入库，待下一交易日收市后计算胜负')).toBeInTheDocument()
    const flatWinMetric = screen
      .getByText('绝对收益胜率')
      .parentElement?.querySelector('.metric-value')
    expect(flatWinMetric).toHaveTextContent('0.0%')
    expect(flatWinMetric).not.toHaveClass('tone-bad')
    const emotionWinCell = screen.getAllByText('0.0%')[1]
    expect(emotionWinCell).not.toHaveClass('tone-bad')
    flatView.unmount()
    setAccessToken(null)

    currentLedger = realLossLedger
    renderMePage()

    expect(await screen.findByText('跑赢沪深 300 胜率')).toBeInTheDocument()
    expect(screen.getByText('胜 0 / 可比 1')).toBeInTheDocument()
    const lossWinMetric = screen
      .getByText('跑赢沪深 300 胜率')
      .parentElement?.querySelector('.metric-value')
    expect(lossWinMetric).toHaveTextContent('0.0%')
    expect(lossWinMetric).toHaveClass('tone-bad')
    const lossEmotionWinCell = screen.getAllByText('0.0%')[1]
    expect(lossEmotionWinCell).toHaveClass('tone-bad')
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
      if (pathname === '/api/auth/config' && request.method === 'GET') {
        return jsonResponse(DEFAULT_AUTH_CONFIG, 200)
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
      if (pathname === '/api/ai/preferences' && request.method === 'GET') {
        return jsonResponse(DEFAULT_AI_PREFS, 200)
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

  it('displays AI quota, manages BYOK preferences with masking/SSRF 422/explicit clear, and recovers on 503 retry', async () => {
    let aiPrefsAttempts = 0
    let aiPrefsState: AiPreferences = {
      prefer_rule_only: false,
      byok_enabled: false,
      byok_base_url_masked: null,
      byok_api_key_configured: false,
      byok_api_key_masked: null,
      byok_model: 'gpt-4o-mini',
      quota: {
        plan_tier: 'pro',
        daily_limit: 30,
        used_today: 4,
        remaining_today: 26,
        byok_active: false,
        resets_at_shanghai: '2026-11-23 24:00 CST',
      },
    }
    const savedAiPayloads: unknown[] = []

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
      if (pathname === '/api/auth/config' && request.method === 'GET') {
        return jsonResponse(DEFAULT_AUTH_CONFIG, 200)
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
        return jsonResponse([], 200)
      }
      if (pathname === '/api/alerts/preferences' && request.method === 'GET') {
        return jsonResponse(DEFAULT_PREFS, 200)
      }
      if (pathname === '/api/ai/preferences' && request.method === 'GET') {
        aiPrefsAttempts += 1
        if (aiPrefsAttempts === 1) {
          return jsonResponse({ detail: 'AI 配置服务暂不可用' }, 503)
        }
        return jsonResponse(aiPrefsState, 200)
      }
      if (pathname === '/api/ai/preferences' && request.method === 'PUT') {
        const parsed: unknown = JSON.parse(await request.clone().text())
        savedAiPayloads.push(parsed)
        if (
          isRecord(parsed) &&
          typeof parsed.byok_base_url === 'string' &&
          parsed.byok_base_url.includes('127.0.0.1')
        ) {
          return jsonResponse({ detail: 'BYOK Base URL 不能指向内网、回环或保留 IP 地址' }, 422)
        }
        if (isRecord(parsed)) {
          const clearingUrl = parsed.byok_base_url === ''
          const clearingKey = parsed.byok_api_key === ''
          const nextUrl =
            typeof parsed.byok_base_url === 'string' && parsed.byok_base_url.length > 0
              ? 'https://api.openai.com/****v1'
              : clearingUrl
                ? null
                : aiPrefsState.byok_base_url_masked
          const nextKeyConfigured = clearingKey
            ? false
            : typeof parsed.byok_api_key === 'string' && parsed.byok_api_key.length > 0
              ? true
              : aiPrefsState.byok_api_key_configured
          const nextKeyMasked = clearingKey
            ? null
            : typeof parsed.byok_api_key === 'string' && parsed.byok_api_key.length > 0
              ? 'sk-****9876'
              : aiPrefsState.byok_api_key_masked
          const nextByokEnabled =
            typeof parsed.byok_enabled === 'boolean'
              ? parsed.byok_enabled
              : aiPrefsState.byok_enabled
          const nextPreferRuleOnly =
            typeof parsed.prefer_rule_only === 'boolean'
              ? parsed.prefer_rule_only
              : aiPrefsState.prefer_rule_only
          const nextByokModel =
            typeof parsed.byok_model === 'string' ? parsed.byok_model : aiPrefsState.byok_model

          aiPrefsState = {
            prefer_rule_only: nextPreferRuleOnly,
            byok_enabled: nextByokEnabled,
            byok_base_url_masked: nextUrl,
            byok_api_key_configured: nextKeyConfigured,
            byok_api_key_masked: nextKeyMasked,
            byok_model: nextByokModel,
            quota: {
              ...aiPrefsState.quota,
              byok_active: nextByokEnabled && Boolean(nextUrl) && nextKeyConfigured,
            },
          }
        }
        return jsonResponse(aiPrefsState, 200)
      }
      return jsonResponse({ detail: `Unhandled ${request.method} ${pathname}` }, 500)
    })

    renderMePage()

    expect(await screen.findByText('AI 额度与偏好设置加载失败')).toBeInTheDocument()
    expect(screen.getByText('AI 配置服务暂不可用')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '重试' }))

    expect(await screen.findByText('平台托管额度')).toBeInTheDocument()
    expect(screen.getByText('套餐 PRO')).toBeInTheDocument()
    expect(screen.getByText('4 / 30')).toBeInTheDocument()
    expect(screen.getByText('26')).toBeInTheDocument()
    expect(screen.getByText('北京时间每日 00:00 清零')).toBeInTheDocument()
    expect(screen.getByText('2026-11-23 24:00 CST')).toBeInTheDocument()

    // SSRF URL rejected with 422 inline alert.
    fireEvent.click(screen.getByLabelText('启用 BYOK 自备 OpenAI 兼容密钥'))
    fireEvent.change(screen.getByLabelText('BYOK Base URL（可选）'), {
      target: { value: 'http://127.0.0.1:8000/v1' },
    })
    fireEvent.change(screen.getByLabelText('BYOK API Key（可选）'), {
      target: { value: 'sk-live-secret-9876' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存 AI 设置' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'BYOK Base URL 不能指向内网、回环或保留 IP 地址',
    )

    // Save valid BYOK config.
    fireEvent.change(screen.getByLabelText('BYOK Base URL（可选）'), {
      target: { value: 'https://api.openai.com/v1' },
    })
    fireEvent.change(screen.getByLabelText('BYOK 模型名称'), {
      target: { value: 'gpt-4.1-mini' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存 AI 设置' }))

    expect(await screen.findByText('AI 偏好与 BYOK 设置已保存')).toBeInTheDocument()
    expect(screen.getByText('BYOK 已接管')).toBeInTheDocument()
    expect(screen.getByText('Base URL · https://api.openai.com/****v1')).toBeInTheDocument()
    expect(screen.getByText('API Key · sk-****9876')).toBeInTheDocument()

    // Blank URL & Key preserves existing values when toggling prefer_rule_only.
    fireEvent.click(screen.getByLabelText('默认仅用纯规则引擎（不消耗额度）'))
    fireEvent.click(screen.getByRole('button', { name: '保存 AI 设置' }))
    expect(await screen.findByText('AI 偏好与 BYOK 设置已保存')).toBeInTheDocument()
    expect(savedAiPayloads[2]).toEqual({
      prefer_rule_only: true,
      byok_enabled: true,
      byok_model: 'gpt-4.1-mini',
    })

    // Cannot clear Base URL while BYOK is enabled.
    fireEvent.click(screen.getByLabelText('清空 Base URL'))
    fireEvent.click(screen.getByRole('button', { name: '保存 AI 设置' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('启用 BYOK 时不能同时清空 Base URL')

    // Unchecking BYOK allows clearing Base URL with "".
    fireEvent.click(screen.getByLabelText('启用 BYOK 自备 OpenAI 兼容密钥'))
    fireEvent.click(screen.getByRole('button', { name: '保存 AI 设置' }))
    expect(await screen.findByText('AI 偏好与 BYOK 设置已保存')).toBeInTheDocument()
    expect(savedAiPayloads[3]).toEqual({
      prefer_rule_only: true,
      byok_enabled: false,
      byok_model: 'gpt-4.1-mini',
      byok_base_url: '',
    })
    expect(screen.getByText('Base URL 未配置')).toBeInTheDocument()
    expect(screen.getByText('平台托管额度')).toBeInTheDocument()

    // Explicit clear API Key sends partial PUT and preserves prefer_rule_only + model.
    fireEvent.click(screen.getByRole('button', { name: '清除已存 Key' }))
    expect(
      await screen.findByText('已清除已存 BYOK API Key 并关闭自备密钥接管'),
    ).toBeInTheDocument()
    expect(savedAiPayloads[4]).toEqual({
      byok_enabled: false,
      byok_api_key: '',
    })
    expect(screen.getByText('API Key 未配置')).toBeInTheDocument()
    expect(screen.getByLabelText('默认仅用纯规则引擎（不消耗额度）')).toBeChecked()
    expect(screen.getByLabelText('BYOK 模型名称')).toHaveValue('gpt-4.1-mini')
  })

  it('validates BYOK prerequisites, clears errors on edit, supports discard dirty changes, disables inputs while saving, and avoids clearBaseUrl deadlock', async () => {
    let aiPrefsState: AiPreferences = {
      prefer_rule_only: false,
      byok_enabled: false,
      byok_base_url_masked: 'https://api.openai.com/****v1',
      byok_api_key_configured: true,
      byok_api_key_masked: 'sk-****1234',
      byok_model: 'gpt-4o-mini',
      quota: {
        plan_tier: 'pro',
        daily_limit: 30,
        used_today: 0,
        remaining_today: 30,
        byok_active: false,
        resets_at_shanghai: '2026-11-23 24:00 CST',
      },
    }
    let putCount = 0
    let resolvePendingPut!: (res: Response) => void
    const pendingPut = new Promise<Response>((resolve) => {
      resolvePendingPut = resolve
    })

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
      if (pathname === '/api/auth/config' && request.method === 'GET') {
        return Promise.resolve(jsonResponse(DEFAULT_AUTH_CONFIG, 200))
      }
      if (pathname === '/api/watchlist' && request.method === 'GET') {
        return Promise.resolve(jsonResponse([], 200))
      }
      if (pathname === '/api/journal' && request.method === 'GET') {
        return Promise.resolve(jsonResponse([], 200))
      }
      if (pathname === '/api/ai/preferences' && request.method === 'GET') {
        return Promise.resolve(jsonResponse(aiPrefsState, 200))
      }
      if (pathname === '/api/ai/preferences' && request.method === 'PUT') {
        putCount += 1
        if (putCount === 1) {
          return Promise.resolve(jsonResponse({ detail: '服务端保存失败' }, 422))
        }
        return pendingPut
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

    expect(await screen.findByText('Base URL · https://api.openai.com/****v1')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '重置未保存修改' })).not.toBeInTheDocument()

    // Editing shows dirty discard button and resets cleanly.
    fireEvent.click(screen.getByLabelText('默认仅用纯规则引擎（不消耗额度）'))
    expect(screen.getByRole('button', { name: '重置未保存修改' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '重置未保存修改' }))
    expect(screen.getByLabelText('默认仅用纯规则引擎（不消耗额度）')).not.toBeChecked()
    expect(screen.queryByRole('button', { name: '重置未保存修改' })).not.toBeInTheDocument()

    // Server 422 error clears immediately when editing any field.
    fireEvent.click(screen.getByLabelText('默认仅用纯规则引擎（不消耗额度）'))
    fireEvent.click(screen.getByRole('button', { name: '保存 AI 设置' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('服务端保存失败')
    fireEvent.change(screen.getByLabelText('BYOK 模型名称'), { target: { value: 'gpt-4.1' } })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    // Clear Base URL -> pending disables all controls -> once saved with masked=null, #ai-byok-base-url is NOT deadlocked disabled.
    fireEvent.click(screen.getByLabelText('清空 Base URL'))
    fireEvent.click(screen.getByRole('button', { name: '保存 AI 设置' }))

    await waitFor(() => {
      expect(screen.getByLabelText('默认仅用纯规则引擎（不消耗额度）')).toBeDisabled()
    })
    expect(screen.getByLabelText('启用 BYOK 自备 OpenAI 兼容密钥')).toBeDisabled()
    expect(screen.getByLabelText('BYOK 模型名称')).toBeDisabled()
    expect(screen.getByLabelText('BYOK Base URL（可选）')).toBeDisabled()
    expect(screen.getByLabelText('BYOK API Key（可选）')).toBeDisabled()
    expect(screen.getByRole('button', { name: '保存中...' })).toBeDisabled()

    aiPrefsState = {
      ...aiPrefsState,
      prefer_rule_only: true,
      byok_base_url_masked: null,
      byok_model: 'gpt-4.1',
    }
    resolvePendingPut(jsonResponse(aiPrefsState, 200))

    expect(await screen.findByText('AI 偏好与 BYOK 设置已保存')).toBeInTheDocument()
    expect(screen.getByLabelText('BYOK Base URL（可选）')).not.toBeDisabled()
    expect(screen.getByLabelText('清空 Base URL')).toBeDisabled()

    // Enabling BYOK when Base URL is absent from both server and input is blocked client-side.
    const callsBeforeClientCheck = putCount
    fireEvent.click(screen.getByLabelText('启用 BYOK 自备 OpenAI 兼容密钥'))
    fireEvent.click(screen.getByRole('button', { name: '保存 AI 设置' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '启用 BYOK 自备密钥前，请先填写公网 Base URL',
    )
    expect(putCount).toBe(callsBeforeClientCheck)
  })

  it('supports legacy email verification, profile display_name edit, and changePassword keeping session alive', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })

    let userState: UserProfile = { ...SAMPLE_USER, email_verified: false }
    let verifyPayload: unknown = null
    let profilePayload: unknown = null
    let changePasswordPayload: unknown = null

    const sendResponse: EmailCodeSendResponse = {
      sent: true,
      expires_in_seconds: 600,
      cooldown_seconds: 60,
      message: '验证码已发送至您的邮箱，请注意查收',
    }

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const request = asRequest(input)
      const pathname = new URL(request.url).pathname

      if (pathname === '/api/auth/refresh' && request.method === 'POST') {
        return jsonResponse(
          {
            access_token: 'initial-active-token',
            token_type: 'bearer',
            expires_in: 900,
            user: userState,
          } satisfies TokenResponse,
          200,
        )
      }
      if (pathname === '/api/auth/me/email-codes' && request.method === 'POST') {
        return jsonResponse(sendResponse, 200)
      }
      if (pathname === '/api/auth/verify-email' && request.method === 'POST') {
        verifyPayload = JSON.parse(await request.clone().text())
        userState = { ...userState, email_verified: true }
        return jsonResponse(userState, 200)
      }
      if (pathname === '/api/auth/me' && request.method === 'PATCH') {
        const parsed: unknown = JSON.parse(await request.clone().text())
        profilePayload = parsed
        if (isRecord(parsed) && typeof parsed.display_name === 'string') {
          userState = { ...userState, display_name: parsed.display_name }
        }
        return jsonResponse(userState, 200)
      }
      if (pathname === '/api/auth/password/change' && request.method === 'POST') {
        const parsed: unknown = JSON.parse(await request.clone().text())
        changePasswordPayload = parsed
        if (isRecord(parsed) && parsed.current_password === 'wrong-current') {
          return jsonResponse({ detail: '当前密码错误' }, 400)
        }
        return jsonResponse(
          {
            access_token: 'rotated-after-pw-change',
            token_type: 'bearer',
            expires_in: 900,
            user: userState,
          } satisfies TokenResponse,
          200,
        )
      }
      if (pathname === '/api/watchlist' && request.method === 'GET') {
        return jsonResponse([INITIAL_ITEM], 200)
      }
      if (pathname === '/api/journal' && request.method === 'GET') {
        return jsonResponse([], 200)
      }
      const emptyPhase3 = handleEmptyPhase3Get(pathname, request.method)
      if (emptyPhase3) {
        return emptyPhase3
      }
      return jsonResponse({ detail: `Unhandled ${request.method} ${pathname}` }, 500)
    })

    renderMePage()

    expect(await screen.findByText('邮箱未验证')).toBeInTheDocument()
    expect(screen.getByText('邮箱未验证')).toHaveClass('tag-amber')

    // Send verification email and test 60s countdown
    fireEvent.click(screen.getByRole('button', { name: '发送验证邮件' }))
    expect(await screen.findByText('验证码已发送至您的邮箱，请注意查收')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重新发送 (60s)' })).toBeDisabled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    expect(screen.getByRole('button', { name: '重新发送 (58s)' })).toBeDisabled()

    // Invalid code rejected client-side
    fireEvent.change(screen.getByLabelText('邮箱验证码'), { target: { value: '12' } })
    fireEvent.click(screen.getByRole('button', { name: '验证邮箱' }))
    expect(await screen.findByText('请输入 6 位数字邮箱验证码')).toBeInTheDocument()

    // Valid code verifies email and updates Tag in 投资账户
    fireEvent.change(screen.getByLabelText('邮箱验证码'), { target: { value: '246810' } })
    fireEvent.click(screen.getByRole('button', { name: '验证邮箱' }))

    expect(await screen.findByText('邮箱验证成功')).toBeInTheDocument()
    expect(screen.getByText('邮箱已验证')).toHaveClass('tag-green')
    expect(verifyPayload).toEqual({ verification_code: '246810' })

    // Update display_name
    fireEvent.change(screen.getByLabelText('显示昵称'), { target: { value: '   ' } })
    fireEvent.click(screen.getByRole('button', { name: '保存昵称' }))
    expect(await screen.findByText('请输入 1–64 个字符的显示昵称')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('显示昵称'), { target: { value: '安全复盘者' } })
    fireEvent.click(screen.getByRole('button', { name: '保存昵称' }))
    expect(await screen.findByText('显示昵称已更新')).toBeInTheDocument()
    expect(screen.getByText('安全复盘者')).toBeInTheDocument()
    expect(profilePayload).toEqual({ display_name: '安全复盘者' })

    // Change password validation & submit
    fireEvent.change(screen.getByLabelText('当前密码'), { target: { value: 'oldpass123' } })
    fireEvent.change(screen.getByLabelText('新密码'), { target: { value: 'oldpass123' } })
    fireEvent.change(screen.getByLabelText('确认新密码'), { target: { value: 'oldpass123' } })
    fireEvent.click(screen.getByRole('button', { name: '修改密码' }))
    expect(await screen.findByText('新密码不能与当前密码相同')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('新密码'), { target: { value: 'newpass1234' } })
    fireEvent.change(screen.getByLabelText('确认新密码'), { target: { value: 'different123' } })
    fireEvent.click(screen.getByRole('button', { name: '修改密码' }))
    expect(await screen.findByText('两次输入的新密码不一致')).toBeInTheDocument()

    // Backend 400 error on wrong current password
    fireEvent.change(screen.getByLabelText('当前密码'), { target: { value: 'wrong-current' } })
    fireEvent.change(screen.getByLabelText('确认新密码'), { target: { value: 'newpass1234' } })
    fireEvent.click(screen.getByRole('button', { name: '修改密码' }))
    expect(await screen.findByText('当前密码错误')).toBeInTheDocument()

    // Successful password change rotates access token and preserves online session + watchlist
    fireEvent.change(screen.getByLabelText('当前密码'), { target: { value: 'oldpass123' } })
    fireEvent.click(screen.getByRole('button', { name: '修改密码' }))
    expect(await screen.findByText('密码修改成功，当前会话已保持在线')).toBeInTheDocument()
    expect(getAccessToken()).toBe('rotated-after-pw-change')
    expect(changePasswordPayload).toEqual({
      current_password: 'oldpass123',
      new_password: 'newpass1234',
    })
    expect(screen.getByText('贵州茅台')).toBeInTheDocument()
  })

  it('supports permanent account deletion with password + optional/required verification code, clears caches, and redirects to /', async () => {
    let authConfig: AuthConfigResponse = { ...DEFAULT_AUTH_CONFIG }
    const deletePayloads: unknown[] = []
    const sendCodePayloads: unknown[] = []

    const tokenResponse: TokenResponse = {
      access_token: 'delete-session-token',
      token_type: 'bearer',
      expires_in: 900,
      user: SAMPLE_USER,
    }
    const sendResponse: EmailCodeSendResponse = {
      sent: true,
      expires_in_seconds: 600,
      cooldown_seconds: 60,
      message: '验证码已发送至您的邮箱，请注意查收',
    }

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const request = asRequest(input)
      const pathname = new URL(request.url).pathname

      if (pathname === '/api/auth/refresh' && request.method === 'POST') {
        return jsonResponse(tokenResponse, 200)
      }
      if (pathname === '/api/auth/config' && request.method === 'GET') {
        return jsonResponse(authConfig, 200)
      }
      if (pathname === '/api/auth/me/email-codes' && request.method === 'POST') {
        sendCodePayloads.push(JSON.parse(await request.clone().text()))
        return jsonResponse(sendResponse, 200)
      }
      if (pathname === '/api/auth/me/delete' && request.method === 'POST') {
        const parsed: unknown = JSON.parse(await request.clone().text())
        deletePayloads.push(parsed)
        if (isRecord(parsed) && parsed.password === 'wrong-pass') {
          return jsonResponse({ detail: '密码错误' }, 400)
        }
        return new Response(null, { status: 204 })
      }
      if (pathname === '/api/watchlist' && request.method === 'GET') {
        return jsonResponse([INITIAL_ITEM], 200)
      }
      if (pathname === '/api/journal' && request.method === 'GET') {
        return jsonResponse([], 200)
      }
      const emptyPhase3 = handleEmptyPhase3Get(pathname, request.method)
      if (emptyPhase3) {
        return emptyPhase3
      }
      return jsonResponse({ detail: `Unhandled ${request.method} ${pathname}` }, 500)
    })

    // Case 1: email_verification_required = false (password + checkbox only)
    const view1 = renderMePage()
    expect(await screen.findByText('贵州茅台')).toBeInTheDocument()
    expect(
      screen.getByText(
        '注销后将永久清除自选愿望单、投资日记时间胶囊、哨兵与 BYOK 配置，所有会话将立即失效。',
      ),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '发送注销验证码' })).not.toBeInTheDocument()

    const deleteBtn = screen.getByRole('button', { name: '永久注销账户' })
    expect(deleteBtn).toBeDisabled()

    fireEvent.click(screen.getByLabelText('我确认永久删除账户及全部关联数据'))
    expect(deleteBtn).not.toBeDisabled()

    // Wrong password shows inline error and keeps user signed in
    fireEvent.change(screen.getByLabelText('注销确认密码'), { target: { value: 'wrong-pass' } })
    fireEvent.click(deleteBtn)
    expect(await screen.findByText('密码错误')).toBeInTheDocument()
    expect(getAccessToken()).toBe('delete-session-token')

    // Correct password deletes account, clears caches & access token, and redirects to /
    fireEvent.change(screen.getByLabelText('注销确认密码'), { target: { value: 'right-pass' } })
    fireEvent.click(deleteBtn)

    expect(await screen.findByText('首页已跳转')).toBeInTheDocument()
    expect(getAccessToken()).toBeNull()
    expect(view1.client.getQueryData(queryKeys.auth.me())).toBeNull()
    expect(view1.client.getQueryData(queryKeys.watchlist.list())).toBeUndefined()
    expect(view1.client.getQueryData(queryKeys.ai.preferences())).toBeUndefined()
    expect(deletePayloads[1]).toEqual({ password: 'right-pass' })
    view1.unmount()

    // Case 2: email_verification_required = true (requires 6-digit verification code)
    authConfig = {
      ...DEFAULT_AUTH_CONFIG,
      email_verification_required: true,
      smtp_configured: true,
    }
    const view2 = renderMePage()
    expect(await screen.findByRole('button', { name: '发送注销验证码' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '发送注销验证码' }))
    expect(await screen.findByText('验证码已发送至您的邮箱，请注意查收')).toBeInTheDocument()
    expect(sendCodePayloads[0]).toEqual({ purpose: 'delete_account' })

    fireEvent.change(screen.getByLabelText('注销确认密码'), { target: { value: 'right-pass' } })
    fireEvent.click(screen.getByLabelText('我确认永久删除账户及全部关联数据'))
    fireEvent.click(screen.getByRole('button', { name: '永久注销账户' }))
    expect(await screen.findByText('请输入 6 位数字注销验证码')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('注销验证码'), { target: { value: '998877' } })
    fireEvent.click(screen.getByRole('button', { name: '永久注销账户' }))

    expect(await screen.findByText('首页已跳转')).toBeInTheDocument()
    expect(getAccessToken()).toBeNull()
    expect(view2.client.getQueryData(queryKeys.auth.me())).toBeNull()
    expect(view2.client.getQueryData(queryKeys.watchlist.list())).toBeUndefined()
    expect(deletePayloads[2]).toEqual({
      password: 'right-pass',
      verification_code: '998877',
    })
  })

  it('blocks deleteAccount while auth/config is pending or errored, recovers on retry, and allows phone-only accounts to delete cleanly when email_verification_required is true', async () => {
    let configCalls = 0
    let resolvePendingConfig!: (res: Response) => void
    const pendingConfig = new Promise<Response>((resolve) => {
      resolvePendingConfig = resolve
    })
    const deletePayloads: unknown[] = []

    const emailToken: TokenResponse = {
      access_token: 'email-user-token',
      token_type: 'bearer',
      expires_in: 900,
      user: SAMPLE_USER,
    }
    const phoneOnlyUser: UserProfile = {
      ...SAMPLE_USER,
      id: '33333333-3333-3333-3333-333333333333',
      email: null,
      phone: '13800138000',
      email_verified: false,
      display_name: '手机用户',
    }
    const phoneToken: TokenResponse = {
      access_token: 'phone-user-token',
      token_type: 'bearer',
      expires_in: 900,
      user: phoneOnlyUser,
    }

    let currentToken = emailToken

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const request = asRequest(input)
      const pathname = new URL(request.url).pathname

      if (pathname === '/api/auth/refresh' && request.method === 'POST') {
        return jsonResponse(currentToken, 200)
      }
      if (pathname === '/api/auth/config' && request.method === 'GET') {
        configCalls += 1
        if (configCalls === 1) {
          return pendingConfig
        }
        return jsonResponse(
          {
            email_verification_required: true,
            smtp_configured: true,
            code_ttl_minutes: 10,
            code_cooldown_seconds: 60,
          } satisfies AuthConfigResponse,
          200,
        )
      }
      if (pathname === '/api/auth/me/delete' && request.method === 'POST') {
        deletePayloads.push(JSON.parse(await request.clone().text()))
        return new Response(null, { status: 204 })
      }
      if (pathname === '/api/watchlist' && request.method === 'GET') {
        return jsonResponse([], 200)
      }
      if (pathname === '/api/journal' && request.method === 'GET') {
        return jsonResponse([], 200)
      }
      const emptyPhase3 = handleEmptyPhase3Get(pathname, request.method)
      if (emptyPhase3) {
        return emptyPhase3
      }
      return jsonResponse({ detail: `Unhandled ${request.method} ${pathname}` }, 500)
    })

    const view1 = renderMePage()
    expect(await screen.findByText('正在加载邮箱安全配置...')).toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('我确认永久删除账户及全部关联数据'))
    fireEvent.change(screen.getByLabelText('注销确认密码'), { target: { value: 'right-pass' } })
    expect(screen.getByRole('button', { name: '永久注销账户' })).toBeDisabled()

    resolvePendingConfig(jsonResponse({ detail: '配置服务异常' }, 503))

    expect(
      await screen.findByText('邮箱安全配置加载失败，暂无法确认注销验证要求'),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '永久注销账户' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: '重试加载配置' }))
    expect(await screen.findByLabelText('注销验证码')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '永久注销账户' })).not.toBeDisabled()
    view1.unmount()
    setAccessToken(null)

    currentToken = phoneToken
    renderMePage()

    expect(await screen.findByText('未绑定邮箱')).toBeInTheDocument()
    expect(screen.getByText('当前账户未绑定邮箱地址，暂不支持邮箱验证码认证。')).toBeInTheDocument()
    expect(screen.queryByLabelText('注销验证码')).not.toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('注销确认密码'), { target: { value: 'phone-pass' } })
    fireEvent.click(screen.getByLabelText('我确认永久删除账户及全部关联数据'))
    fireEvent.click(screen.getByRole('button', { name: '永久注销账户' }))

    expect(await screen.findByText('首页已跳转')).toBeInTheDocument()
    expect(deletePayloads).toEqual([{ password: 'phone-pass' }])
  })

  it('enforces >128 password validation, handles 400/429/503 security errors, resets verifyCooldown on success, and applies wrap-anywhere + danger-zone-title classes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })

    let verifySendCalls = 0
    let verifyConfirmCalls = 0
    let changePasswordCalls = 0
    let deleteCalls = 0
    let userState: UserProfile = {
      ...SAMPLE_USER,
      email: 'very.long.investor.email.address.for.mobile.wrapping.check@subdomain.example.com',
      display_name: '超长昵称'.repeat(16),
      email_verified: false,
    }

    const sendResponse: EmailCodeSendResponse = {
      sent: true,
      expires_in_seconds: 600,
      cooldown_seconds: 60,
      message: '验证码已发送至您的邮箱，请注意查收',
    }

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const request = asRequest(input)
      const pathname = new URL(request.url).pathname

      if (pathname === '/api/auth/refresh' && request.method === 'POST') {
        return Promise.resolve(
          jsonResponse(
            {
              access_token: 'security-token',
              token_type: 'bearer',
              expires_in: 900,
              user: userState,
            } satisfies TokenResponse,
            200,
          ),
        )
      }
      if (pathname === '/api/auth/me/email-codes' && request.method === 'POST') {
        verifySendCalls += 1
        if (verifySendCalls === 1) {
          return Promise.resolve(jsonResponse({ detail: '发送过于频繁，请 45 秒后再试' }, 429))
        }
        if (verifySendCalls === 2) {
          return Promise.resolve(jsonResponse({ detail: 'SMTP 服务暂不可用' }, 503))
        }
        return Promise.resolve(jsonResponse(sendResponse, 200))
      }
      if (pathname === '/api/auth/verify-email' && request.method === 'POST') {
        verifyConfirmCalls += 1
        if (verifyConfirmCalls === 1) {
          return Promise.resolve(jsonResponse({ detail: '验证码错误或已过期' }, 400))
        }
        userState = { ...userState, email_verified: true }
        return Promise.resolve(jsonResponse(userState, 200))
      }
      if (pathname === '/api/auth/password/change' && request.method === 'POST') {
        changePasswordCalls += 1
        return Promise.resolve(jsonResponse({ detail: '密码修改服务暂不可用' }, 503))
      }
      if (pathname === '/api/auth/me/delete' && request.method === 'POST') {
        deleteCalls += 1
        return Promise.resolve(jsonResponse({ detail: '注销服务暂不可用' }, 503))
      }
      if (pathname === '/api/watchlist' && request.method === 'GET') {
        return Promise.resolve(jsonResponse([], 200))
      }
      if (pathname === '/api/journal' && request.method === 'GET') {
        return Promise.resolve(jsonResponse([], 200))
      }
      const emptyPhase3 = handleEmptyPhase3Get(pathname, request.method)
      if (emptyPhase3) {
        return Promise.resolve(emptyPhase3)
      }
      return Promise.resolve(
        jsonResponse({ detail: `Unhandled ${request.method} ${pathname}` }, 500),
      )
    })

    const clearIntervalSpy = vi.spyOn(window, 'clearInterval')
    renderMePage()

    const emailNodes = await screen.findAllByText(
      'very.long.investor.email.address.for.mobile.wrapping.check@subdomain.example.com',
    )
    expect(emailNodes.length).toBeGreaterThanOrEqual(2)
    for (const node of emailNodes) {
      expect(node).toHaveClass('wrap-anywhere')
    }
    const dangerToggle = screen.getByRole('button', { name: /永久注销账户（危险操作）/ })
    expect(dangerToggle).toHaveClass('danger-zone-title')
    expect(dangerToggle.closest('.danger-zone')).not.toBeNull()

    const currentPwInput = screen.getByLabelText('当前密码')
    const newPwInput = screen.getByLabelText('新密码')
    const confirmPwInput = screen.getByLabelText('确认新密码')
    const deletePwInput = screen.getByLabelText('注销确认密码')
    expect(currentPwInput).toHaveAttribute('maxLength', '128')
    expect(newPwInput).toHaveAttribute('maxLength', '128')
    expect(confirmPwInput).toHaveAttribute('maxLength', '128')
    expect(deletePwInput).toHaveAttribute('maxLength', '128')

    fireEvent.change(currentPwInput, { target: { value: 'c'.repeat(129) } })
    fireEvent.click(screen.getByRole('button', { name: '修改密码' }))
    expect(await screen.findByText('当前密码长度不能超过 128 位')).toBeInTheDocument()

    fireEvent.change(currentPwInput, { target: { value: 'validpass123' } })
    fireEvent.change(newPwInput, { target: { value: 'n'.repeat(129) } })
    fireEvent.change(confirmPwInput, { target: { value: 'n'.repeat(129) } })
    fireEvent.click(screen.getByRole('button', { name: '修改密码' }))
    expect(await screen.findByText('新密码长度不能超过 128 位')).toBeInTheDocument()
    expect(changePasswordCalls).toBe(0)

    fireEvent.change(newPwInput, { target: { value: 'newvalidpass123' } })
    fireEvent.change(confirmPwInput, { target: { value: 'newvalidpass123' } })
    fireEvent.click(screen.getByRole('button', { name: '修改密码' }))
    expect(await screen.findByText('密码修改服务暂不可用')).toBeInTheDocument()
    expect(changePasswordCalls).toBe(1)

    fireEvent.click(screen.getByLabelText('我确认永久删除账户及全部关联数据'))
    fireEvent.change(deletePwInput, { target: { value: 'd'.repeat(129) } })
    fireEvent.click(screen.getByRole('button', { name: '永久注销账户' }))
    expect(await screen.findByText('密码长度不能超过 128 位')).toBeInTheDocument()
    expect(deleteCalls).toBe(0)

    fireEvent.change(deletePwInput, { target: { value: 'validpass123' } })
    fireEvent.click(screen.getByRole('button', { name: '永久注销账户' }))
    expect(await screen.findByText('注销服务暂不可用')).toBeInTheDocument()
    expect(deleteCalls).toBe(1)

    fireEvent.click(screen.getByRole('button', { name: '发送验证邮件' }))
    expect(await screen.findByText('发送过于频繁，请 45 秒后再试')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '发送验证邮件' }))
    expect(await screen.findByText('SMTP 服务暂不可用')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '发送验证邮件' }))
    expect(await screen.findByText('验证码已发送至您的邮箱，请注意查收')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重新发送 (60s)' })).toBeDisabled()

    fireEvent.change(screen.getByLabelText('邮箱验证码'), { target: { value: '000000' } })
    fireEvent.click(screen.getByRole('button', { name: '验证邮箱' }))
    expect(await screen.findByText('验证码错误或已过期')).toBeInTheDocument()

    const clearsBeforeVerifySuccess = clearIntervalSpy.mock.calls.length
    fireEvent.change(screen.getByLabelText('邮箱验证码'), { target: { value: '654321' } })
    fireEvent.click(screen.getByRole('button', { name: '验证邮箱' }))
    expect(await screen.findByText('邮箱验证成功')).toBeInTheDocument()
    expect(clearIntervalSpy.mock.calls.length).toBeGreaterThan(clearsBeforeVerifySuccess)
  })
})
