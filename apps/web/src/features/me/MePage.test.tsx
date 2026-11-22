import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthProvider } from '../../lib/AuthProvider'
import { setAccessToken } from '../../lib/api'
import { createQueryClient } from '../../lib/queryClient'
import type { TokenResponse, UserProfile, WatchlistItem, WatchlistUpsert } from '../../types/api'
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
})
