import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TokenResponse, UserProfile, WatchlistItem, WatchlistUpsert } from '../types/api'
import { ApiError, api, getAccessToken, setAccessToken, subscribeAuthExpired } from './api'

const SAMPLE_USER: UserProfile = {
  id: '11111111-1111-1111-1111-111111111111',
  email: 'investor@example.com',
  phone: null,
  display_name: '价值猎手',
  plan_tier: 'pro',
  plan_expires_at: null,
  created_at: '2026-11-22T00:00:00Z',
}

const SAMPLE_ITEM: WatchlistItem = {
  code: '600519',
  name: '贵州茅台',
  industry: '白酒',
  note: '现金流充沛',
  target_price: 1400,
  target_pe_percentile: 25,
  target_dividend_yield: 3.2,
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
  throw new Error('Expected Request instance from openapi-fetch')
}

function createDeferred<T>() {
  let resolvePromise: ((value: T) => void) | undefined
  let rejectPromise: ((reason?: unknown) => void) | undefined
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return {
    promise,
    resolve(value: T) {
      if (!resolvePromise) {
        throw new Error('Deferred resolver not initialized')
      }
      resolvePromise(value)
    },
    reject(reason?: unknown) {
      if (!rejectPromise) {
        throw new Error('Deferred rejector not initialized')
      }
      rejectPromise(reason)
    },
  }
}

describe('api auth and single-flight refresh middleware', () => {
  afterEach(() => {
    setAccessToken(null)
    vi.restoreAllMocks()
  })

  it('deduplicates concurrent 401 refreshes and retries GET + PUT with body intact', async () => {
    setAccessToken('expired-token')

    const payload: WatchlistUpsert = {
      code: '600519',
      name: '贵州茅台',
      industry: '白酒',
      note: '现金流充沛',
      target_price: 1400,
      target_pe_percentile: 25,
      target_dividend_yield: 3.2,
      alert_enabled: true,
    }

    const tokenResponse: TokenResponse = {
      access_token: 'fresh-token',
      token_type: 'bearer',
      expires_in: 900,
      user: SAMPLE_USER,
    }

    let refreshCount = 0
    let putRetryBody: unknown = null

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const request = asRequest(input)
      const pathname = new URL(request.url).pathname
      const auth = request.headers.get('Authorization')

      if (pathname === '/api/auth/refresh' && request.method === 'POST') {
        refreshCount += 1
        // Yield a tick so any concurrent 401 caller joins the in-flight refresh.
        await Promise.resolve()
        return jsonResponse(tokenResponse, 200)
      }

      if (pathname === '/api/watchlist' && request.method === 'GET') {
        if (auth === 'Bearer expired-token') {
          return jsonResponse({ detail: '登录凭证已过期' }, 401)
        }
        if (auth === 'Bearer fresh-token') {
          return jsonResponse([SAMPLE_ITEM], 200)
        }
        return jsonResponse({ detail: 'unexpected auth header' }, 400)
      }

      if (pathname === '/api/watchlist' && request.method === 'PUT') {
        if (auth === 'Bearer expired-token') {
          return jsonResponse({ detail: '登录凭证已过期' }, 401)
        }
        if (auth === 'Bearer fresh-token') {
          putRetryBody = JSON.parse(await request.clone().text())
          return jsonResponse(SAMPLE_ITEM, 200)
        }
        return jsonResponse({ detail: 'unexpected auth header' }, 400)
      }

      return jsonResponse({ detail: `Unhandled ${request.method} ${pathname}` }, 500)
    })

    const [items, upserted] = await Promise.all([api.listWatchlist(), api.upsertWatchlist(payload)])

    expect(refreshCount).toBe(1)
    expect(getAccessToken()).toBe('fresh-token')
    expect(items).toEqual([SAMPLE_ITEM])
    expect(upserted).toEqual(SAMPLE_ITEM)
    expect(putRetryBody).toEqual(payload)
  })

  it('clears access token and notifies subscribers when refresh fails', async () => {
    setAccessToken('expired-token')
    const expiredListener = vi.fn()
    const unsubscribe = subscribeAuthExpired(expiredListener)

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const request = asRequest(input)
      const pathname = new URL(request.url).pathname

      if (pathname === '/api/watchlist') {
        return Promise.resolve(jsonResponse({ detail: '需要重新登录' }, 401))
      }
      if (pathname === '/api/auth/refresh') {
        return Promise.resolve(jsonResponse({ detail: '会话已失效，请重新登录' }, 401))
      }
      return Promise.resolve(jsonResponse({ detail: 'unexpected' }, 500))
    })

    try {
      await expect(api.listWatchlist()).rejects.toMatchObject({
        name: 'ApiError',
        status: 401,
        message: '需要重新登录',
      })
      expect(getAccessToken()).toBeNull()
      expect(expiredListener).toHaveBeenCalledTimes(1)
    } finally {
      unsubscribe()
    }
  })

  it('does not trigger refresh on public auth endpoint 401 responses', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ detail: '邮箱或密码错误' }, 401))

    await expect(
      api.login({ email: 'investor@example.com', password: 'wrong-password' }),
    ).rejects.toBeInstanceOf(ApiError)

    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('never resurrects accessToken when logout() races with an in-flight refresh', async () => {
    setAccessToken('expired-token')
    const expiredListener = vi.fn()
    const unsubscribe = subscribeAuthExpired(expiredListener)
    const refreshStarted = createDeferred<void>()
    const refreshGate = createDeferred<Response>()

    const tokenResponse: TokenResponse = {
      access_token: 'resurrected-token',
      token_type: 'bearer',
      expires_in: 900,
      user: SAMPLE_USER,
    }

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const request = asRequest(input)
      const pathname = new URL(request.url).pathname

      if (pathname === '/api/watchlist') {
        return Promise.resolve(jsonResponse({ detail: '登录凭证已过期' }, 401))
      }
      if (pathname === '/api/auth/refresh') {
        refreshStarted.resolve()
        return refreshGate.promise
      }
      if (pathname === '/api/auth/logout') {
        return Promise.resolve(new Response(null, { status: 204 }))
      }
      return Promise.resolve(jsonResponse({ detail: 'unexpected' }, 500))
    })

    try {
      const pendingRequest = api.listWatchlist()
      await refreshStarted.promise

      await api.logout()
      expect(getAccessToken()).toBeNull()

      refreshGate.resolve(jsonResponse(tokenResponse, 200))

      await expect(pendingRequest).rejects.toMatchObject({
        name: 'ApiError',
        status: 401,
      })
      expect(getAccessToken()).toBeNull()
      expect(expiredListener).not.toHaveBeenCalled()
    } finally {
      unsubscribe()
    }
  })

  it('does not wipe new login accessToken or emit authExpired when a stale refresh fails', async () => {
    setAccessToken('expired-token')
    const expiredListener = vi.fn()
    const unsubscribe = subscribeAuthExpired(expiredListener)
    const refreshStarted = createDeferred<void>()
    const refreshGate = createDeferred<Response>()

    const newLoginResponse: TokenResponse = {
      access_token: 'new-user-token',
      token_type: 'bearer',
      expires_in: 900,
      user: SAMPLE_USER,
    }

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const request = asRequest(input)
      const pathname = new URL(request.url).pathname

      if (pathname === '/api/watchlist') {
        return Promise.resolve(jsonResponse({ detail: '登录凭证已过期' }, 401))
      }
      if (pathname === '/api/auth/refresh') {
        refreshStarted.resolve()
        return refreshGate.promise
      }
      if (pathname === '/api/auth/login') {
        return Promise.resolve(jsonResponse(newLoginResponse, 200))
      }
      return Promise.resolve(jsonResponse({ detail: 'unexpected' }, 500))
    })

    try {
      const pendingRequest = api.listWatchlist()
      await refreshStarted.promise

      await api.login({ email: 'investor@example.com', password: 'password123' })
      expect(getAccessToken()).toBe('new-user-token')

      refreshGate.resolve(jsonResponse({ detail: '会话已失效，请重新登录' }, 401))

      await expect(pendingRequest).rejects.toMatchObject({
        name: 'ApiError',
        status: 401,
      })
      expect(getAccessToken()).toBe('new-user-token')
      expect(expiredListener).not.toHaveBeenCalled()
    } finally {
      unsubscribe()
    }
  })

  it('reuses already-rotated accessToken on slow late-401 without a second refresh', async () => {
    setAccessToken('expired-token')

    const payload: WatchlistUpsert = {
      code: '600519',
      name: '贵州茅台',
      industry: '白酒',
      note: '现金流充沛',
      target_price: 1400,
      target_pe_percentile: 25,
      target_dividend_yield: 3.2,
      alert_enabled: true,
    }

    const tokenResponse: TokenResponse = {
      access_token: 'fresh-token',
      token_type: 'bearer',
      expires_in: 900,
      user: SAMPLE_USER,
    }

    const slowPutStarted = createDeferred<void>()
    const slowPutGate = createDeferred<Response>()
    let refreshCount = 0

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const request = asRequest(input)
      const pathname = new URL(request.url).pathname
      const auth = request.headers.get('Authorization')

      if (pathname === '/api/auth/refresh') {
        refreshCount += 1
        return jsonResponse(tokenResponse, 200)
      }

      if (pathname === '/api/watchlist' && request.method === 'GET') {
        if (auth === 'Bearer expired-token') {
          return jsonResponse({ detail: '登录凭证已过期' }, 401)
        }
        if (auth === 'Bearer fresh-token') {
          return jsonResponse([SAMPLE_ITEM], 200)
        }
      }

      if (pathname === '/api/watchlist' && request.method === 'PUT') {
        if (auth === 'Bearer expired-token') {
          slowPutStarted.resolve()
          return await slowPutGate.promise
        }
        if (auth === 'Bearer fresh-token') {
          return jsonResponse(SAMPLE_ITEM, 200)
        }
      }

      return jsonResponse({ detail: `Unhandled ${request.method} ${pathname}` }, 500)
    })

    const slowPut = api.upsertWatchlist(payload)
    await slowPutStarted.promise

    const items = await api.listWatchlist()
    expect(items).toEqual([SAMPLE_ITEM])
    expect(refreshCount).toBe(1)

    slowPutGate.resolve(jsonResponse({ detail: '登录凭证已过期' }, 401))
    const upserted = await slowPut

    expect(upserted).toEqual(SAMPLE_ITEM)
    expect(refreshCount).toBe(1)
    expect(getAccessToken()).toBe('fresh-token')
  })

  it('propagates 503 ApiError from refresh without clearing accessToken or firing authExpired', async () => {
    setAccessToken('current-token')
    const expiredListener = vi.fn()
    const unsubscribe = subscribeAuthExpired(expiredListener)

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const request = asRequest(input)
      const pathname = new URL(request.url).pathname

      if (pathname === '/api/watchlist') {
        return Promise.resolve(jsonResponse({ detail: '登录凭证已过期' }, 401))
      }
      if (pathname === '/api/auth/refresh') {
        return Promise.resolve(jsonResponse({ detail: '服务暂不可用' }, 503))
      }
      return Promise.resolve(jsonResponse({ detail: 'unexpected' }, 500))
    })

    try {
      await expect(api.listWatchlist()).rejects.toMatchObject({
        name: 'ApiError',
        status: 503,
        message: '服务暂不可用',
      })
      expect(getAccessToken()).toBe('current-token')
      expect(expiredListener).not.toHaveBeenCalled()

      await expect(api.refreshSession()).rejects.toMatchObject({
        name: 'ApiError',
        status: 503,
        message: '服务暂不可用',
      })
      expect(getAccessToken()).toBe('current-token')
      expect(expiredListener).not.toHaveBeenCalled()
    } finally {
      unsubscribe()
    }
  })

  it('preserves accessToken and throws ApiError when refresh hits a network failure', async () => {
    setAccessToken('current-token')
    const expiredListener = vi.fn()
    const unsubscribe = subscribeAuthExpired(expiredListener)

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const request = asRequest(input)
      const pathname = new URL(request.url).pathname

      if (pathname === '/api/watchlist') {
        return Promise.resolve(jsonResponse({ detail: '登录凭证已过期' }, 401))
      }
      if (pathname === '/api/auth/refresh') {
        return Promise.reject(new TypeError('Failed to fetch'))
      }
      return Promise.resolve(jsonResponse({ detail: 'unexpected' }, 500))
    })

    try {
      await expect(api.listWatchlist()).rejects.toMatchObject({
        name: 'ApiError',
        status: 0,
        message: 'Failed to fetch',
      })
      expect(getAccessToken()).toBe('current-token')
      expect(expiredListener).not.toHaveBeenCalled()
    } finally {
      unsubscribe()
    }
  })

  it('requests stock snapshot and compare endpoints with expected path and query params', async () => {
    const requestedUrls: string[] = []

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const request = asRequest(input)
      requestedUrls.push(request.url)
      const pathname = new URL(request.url).pathname

      if (pathname === '/api/stocks/600519/snapshot') {
        return Promise.resolve(jsonResponse({ code: '600519' }, 200))
      }
      if (pathname === '/api/stocks/compare') {
        return Promise.resolve(jsonResponse([], 200))
      }
      return Promise.resolve(jsonResponse({ detail: 'unexpected' }, 500))
    })

    await api.getStockSnapshot('600519')
    await api.compareStocks(['600519', '000858'])

    expect(requestedUrls[0]).toContain('/api/stocks/600519/snapshot')
    expect(requestedUrls[1]).toContain('/api/stocks/compare?codes=600519%2C000858')
  })

  it('calls journal ledger and sentinel alert endpoints with expected payloads and error propagation', async () => {
    setAccessToken('valid-token')
    const calls: Array<{ method: string; url: string; body: unknown }> = []

    const sampleLedger = {
      total_entries: 1,
      comparable_count: 1,
      win_count: 1,
      win_rate_pct: 100,
      avg_stock_return_pct: 12.5,
      avg_excess_return_pct: 8.2,
      pass_count: 0,
      pass_avoided_loss_count: 0,
      current_benchmark_code: '000300',
      current_benchmark_price: 3950.25,
      benchmark_as_of: '2026-11-22',
      by_emotion: [],
      by_action: [],
      items: [],
    }
    const samplePrefs = {
      in_app_enabled: true,
      webhook_enabled: true,
      channel_type: 'feishu',
      webhook_url_configured: true,
      webhook_url_masked: 'https://open.feishu.cn/****abcd',
    }
    const sampleScan = {
      as_of: '2026-11-22',
      users_scanned: 1,
      evaluated_rules: 3,
      matched_count: 1,
      newly_triggered_count: 1,
      webhook_sent_count: 0,
      webhook_failed_count: 0,
      deliveries: [],
    }

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const request = asRequest(input)
      const url = new URL(request.url)
      const rawBody = request.method === 'PUT' ? await request.clone().text() : ''
      const parsedBody: unknown = rawBody ? JSON.parse(rawBody) : null
      calls.push({ method: request.method, url: url.pathname + url.search, body: parsedBody })

      if (url.pathname === '/api/journal/ledger' && request.method === 'GET') {
        return jsonResponse(sampleLedger, 200)
      }
      if (url.pathname === '/api/alerts' && request.method === 'GET') {
        return jsonResponse([], 200)
      }
      if (url.pathname === '/api/alerts/scan' && request.method === 'POST') {
        return jsonResponse(sampleScan, 200)
      }
      if (url.pathname === '/api/alerts/preferences' && request.method === 'GET') {
        return jsonResponse(samplePrefs, 200)
      }
      if (url.pathname === '/api/alerts/preferences' && request.method === 'PUT') {
        if (
          typeof parsedBody === 'object' &&
          parsedBody !== null &&
          'webhook_url' in parsedBody &&
          parsedBody.webhook_url === 'http://127.0.0.1/hook'
        ) {
          return jsonResponse({ detail: 'Webhook URL 不能指向内网、回环或保留 IP 地址' }, 422)
        }
        return jsonResponse(samplePrefs, 200)
      }
      return jsonResponse({ detail: 'unexpected' }, 500)
    })

    expect(await api.getJournalLedger(100)).toEqual(sampleLedger)
    expect(await api.listAlerts(25)).toEqual([])
    expect(await api.scanAlerts()).toEqual(sampleScan)
    expect(await api.getAlertPreferences()).toEqual(samplePrefs)
    expect(
      await api.updateAlertPreferences({
        in_app_enabled: true,
        webhook_enabled: true,
        channel_type: 'wecom',
      }),
    ).toEqual(samplePrefs)

    await expect(
      api.updateAlertPreferences({
        in_app_enabled: true,
        webhook_enabled: true,
        channel_type: 'custom',
        webhook_url: 'http://127.0.0.1/hook',
      }),
    ).rejects.toMatchObject({
      name: 'ApiError',
      status: 422,
      message: 'Webhook URL 不能指向内网、回环或保留 IP 地址',
    })

    expect(calls).toEqual([
      { method: 'GET', url: '/api/journal/ledger?limit=100', body: null },
      { method: 'GET', url: '/api/alerts?limit=25', body: null },
      { method: 'POST', url: '/api/alerts/scan', body: null },
      { method: 'GET', url: '/api/alerts/preferences', body: null },
      {
        method: 'PUT',
        url: '/api/alerts/preferences',
        body: { in_app_enabled: true, webhook_enabled: true, channel_type: 'wecom' },
      },
      {
        method: 'PUT',
        url: '/api/alerts/preferences',
        body: {
          in_app_enabled: true,
          webhook_enabled: true,
          channel_type: 'custom',
          webhook_url: 'http://127.0.0.1/hook',
        },
      },
    ])
  })
})
