import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AiPreferences,
  AuthConfigResponse,
  DevilsAdvocateResponse,
  EmailCodeSendResponse,
  MarketDiscoveryResponse,
  MdaDiffResponse,
  TokenResponse,
  UserProfile,
  WatchlistItem,
  WatchlistUpsert,
} from '../types/api'
import {
  ApiError,
  api,
  getAccessToken,
  getAuthEpoch,
  setAccessToken,
  subscribeAuthExpired,
} from './api'

const SAMPLE_USER: UserProfile = {
  id: '11111111-1111-1111-1111-111111111111',
  email: 'investor@example.com',
  phone: null,
  display_name: '价值猎手',
  email_verified: true,
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

  it('requests stock snapshot, sync, and compare endpoints with expected path, method, and query params', async () => {
    const requests: Array<{ method: string; url: string }> = []

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const request = asRequest(input)
      requests.push({ method: request.method, url: request.url })
      const pathname = new URL(request.url).pathname

      if (pathname === '/api/stocks/600519/snapshot') {
        return Promise.resolve(jsonResponse({ code: '600519' }, 200))
      }
      if (pathname === '/api/stocks/600519/sync' && request.method === 'POST') {
        return Promise.resolve(jsonResponse({ code: '600519' }, 200))
      }
      if (pathname === '/api/stocks/compare') {
        return Promise.resolve(jsonResponse([], 200))
      }
      return Promise.resolve(jsonResponse({ detail: 'unexpected' }, 500))
    })

    await api.getStockSnapshot('600519')
    await api.syncStockSnapshot('600519')
    await api.syncStockSnapshot('600519', undefined, { force: true })
    await api.compareStocks(['600519', '000858'])

    expect(requests[0]?.method).toBe('GET')
    expect(requests[0]?.url).toContain('/api/stocks/600519/snapshot')
    expect(requests[1]?.method).toBe('POST')
    expect(requests[1]?.url).toMatch(/\/api\/stocks\/600519\/sync$/)
    expect(requests[2]?.method).toBe('POST')
    expect(requests[2]?.url).toContain('/api/stocks/600519/sync?force=true')
    expect(requests[3]?.method).toBe('GET')
    expect(requests[3]?.url).toContain('/api/stocks/compare?codes=600519%2C000858')
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

  it('calls AI companion endpoints (devils-advocate, mda-diff, preferences) and propagates 422/429 errors', async () => {
    setAccessToken('valid-token')
    const calls: Array<{ method: string; url: string; body: unknown }> = []

    const samplePrefs: AiPreferences = {
      prefer_rule_only: false,
      byok_enabled: true,
      byok_base_url_masked: 'https://api.openai.com/****9999',
      byok_api_key_configured: true,
      byok_api_key_masked: 'sk-****1234',
      byok_model: 'gpt-4o-mini',
      quota: {
        plan_tier: 'pro',
        daily_limit: 30,
        used_today: 1,
        remaining_today: 29,
        byok_active: true,
        resets_at_shanghai: '2026-11-23 24:00 CST',
      },
    }

    const sampleDa: DevilsAdvocateResponse = {
      code: '600519',
      stock_name: '贵州茅台',
      as_of: '2026-11-20',
      mode: 'deterministic',
      fallback_reason: null,
      challenges: [
        {
          index: 1,
          title: '估值与隐含增速约束',
          thesis: '需验证高增速假设能否持续。',
          cited_facts: [{ label: 'PE(TTM)', value_text: '22.10', source_section: '估值截面' }],
          suggested_falsify_rule: { metric: 'pe_percentile_10y', op: 'gte', value: 80, periods: 1 },
        },
      ],
      quota: samplePrefs.quota,
      compliance_notice: '仅供研究复盘，不构成投资建议。',
    }

    const sampleMda: MdaDiffResponse = {
      code: '600519',
      stock_name: '贵州茅台',
      previous_period_label: '2024年报',
      current_period_label: '2025年报',
      mode: 'deterministic',
      summary: '识别到 1 处口径变更。',
      metric_shifts: [],
      text_highlights: [],
      quota: samplePrefs.quota,
      compliance_notice: '仅供研究复盘，不构成投资建议。',
    }

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const request = asRequest(input)
      const url = new URL(request.url)
      const rawBody =
        request.method === 'POST' || request.method === 'PUT' ? await request.clone().text() : ''
      const parsedBody: unknown = rawBody ? JSON.parse(rawBody) : null
      calls.push({ method: request.method, url: url.pathname + url.search, body: parsedBody })

      if (url.pathname === '/api/ai/preferences' && request.method === 'GET') {
        return jsonResponse(samplePrefs, 200)
      }
      if (url.pathname === '/api/ai/preferences' && request.method === 'PUT') {
        if (
          typeof parsedBody === 'object' &&
          parsedBody !== null &&
          'byok_base_url' in parsedBody &&
          parsedBody.byok_base_url === 'http://127.0.0.1:8000/v1'
        ) {
          return jsonResponse({ detail: 'BYOK Base URL 不能指向内网、回环或保留 IP 地址' }, 422)
        }
        return jsonResponse(samplePrefs, 200)
      }
      if (url.pathname === '/api/ai/devils-advocate' && request.method === 'POST') {
        if (
          typeof parsedBody === 'object' &&
          parsedBody !== null &&
          'reason' in parsedBody &&
          parsedBody.reason === 'quota-exhausted'
        ) {
          return jsonResponse({ detail: '今日平台 AI 额度已用完（5/5）' }, 429)
        }
        return jsonResponse(sampleDa, 200)
      }
      if (url.pathname === '/api/ai/mda-diff' && request.method === 'POST') {
        return jsonResponse(sampleMda, 200)
      }
      return jsonResponse({ detail: 'unexpected' }, 500)
    })

    expect(await api.getAiPreferences()).toEqual(samplePrefs)
    expect(
      await api.updateAiPreferences({
        prefer_rule_only: true,
        byok_enabled: false,
        byok_model: 'gpt-4o-mini',
      }),
    ).toEqual(samplePrefs)
    expect(
      await api.runDevilsAdvocate({
        code: '600519',
        action: 'buy',
        reason: '现金流稳健',
        falsify_condition: '',
        mode: 'auto',
      }),
    ).toEqual(sampleDa)
    expect(
      await api.runMdaDiff({
        code: '600519',
        previous_period_label: '2024年报',
        current_period_label: '2025年报',
        previous_text: '营收稳健增长',
        current_text: '毛利率承压',
        mode: 'rule_only',
      }),
    ).toEqual(sampleMda)

    await expect(
      api.updateAiPreferences({
        prefer_rule_only: false,
        byok_enabled: true,
        byok_base_url: 'http://127.0.0.1:8000/v1',
        byok_api_key: 'sk-test-1234',
        byok_model: 'gpt-4o-mini',
      }),
    ).rejects.toMatchObject({
      name: 'ApiError',
      status: 422,
      message: 'BYOK Base URL 不能指向内网、回环或保留 IP 地址',
    })

    await expect(
      api.runDevilsAdvocate({
        code: '600519',
        action: 'buy',
        reason: 'quota-exhausted',
        falsify_condition: '',
        mode: 'auto',
      }),
    ).rejects.toMatchObject({
      name: 'ApiError',
      status: 429,
      message: '今日平台 AI 额度已用完（5/5）',
    })

    expect(calls).toHaveLength(6)
    expect(calls[0]).toEqual({ method: 'GET', url: '/api/ai/preferences', body: null })
    expect(calls[2]).toEqual({
      method: 'POST',
      url: '/api/ai/devils-advocate',
      body: {
        code: '600519',
        action: 'buy',
        reason: '现金流稳健',
        falsify_condition: '',
        mode: 'auto',
      },
    })
    expect(calls[3]).toEqual({
      method: 'POST',
      url: '/api/ai/mda-diff',
      body: {
        code: '600519',
        previous_period_label: '2024年报',
        current_period_label: '2025年报',
        previous_text: '营收稳健增长',
        current_text: '毛利率承压',
        mode: 'rule_only',
      },
    })
  })

  it('increments getAuthEpoch on setAccessToken, register, login, logout, and notifyAuthExpired but not on 200 refresh', async () => {
    const tokenResponse: TokenResponse = {
      access_token: 'session-token',
      token_type: 'bearer',
      expires_in: 900,
      user: SAMPLE_USER,
    }
    let refreshStatus = 200

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const request = asRequest(input)
      const pathname = new URL(request.url).pathname

      if (pathname === '/api/auth/register') {
        return Promise.resolve(jsonResponse(tokenResponse, 201))
      }
      if (pathname === '/api/auth/login') {
        return Promise.resolve(jsonResponse(tokenResponse, 200))
      }
      if (pathname === '/api/auth/logout') {
        return Promise.resolve(new Response(null, { status: 204 }))
      }
      if (pathname === '/api/auth/refresh') {
        return Promise.resolve(
          refreshStatus === 200
            ? jsonResponse(tokenResponse, 200)
            : jsonResponse({ detail: '会话过期' }, 401),
        )
      }
      if (pathname === '/api/watchlist') {
        return Promise.resolve(jsonResponse({ detail: '登录凭证已过期' }, 401))
      }
      return Promise.resolve(jsonResponse({ detail: 'unexpected' }, 500))
    })

    const e0 = getAuthEpoch()
    setAccessToken('manual-token')
    const e1 = getAuthEpoch()
    expect(e1).toBeGreaterThan(e0)

    await api.register({
      email: 'investor@example.com',
      password: 'password123',
      display_name: '价值猎手',
    })
    const e2 = getAuthEpoch()
    expect(e2).toBeGreaterThan(e1)

    await api.login({ email: 'investor@example.com', password: 'password123' })
    const e3 = getAuthEpoch()
    expect(e3).toBeGreaterThan(e2)

    await api.refreshSession()
    expect(getAuthEpoch()).toBe(e3)

    await api.logout()
    const e4 = getAuthEpoch()
    expect(e4).toBeGreaterThan(e3)

    setAccessToken('expired-token')
    const e5 = getAuthEpoch()
    expect(e5).toBeGreaterThan(e4)

    refreshStatus = 401
    await expect(api.listWatchlist()).rejects.toMatchObject({ status: 401 })
    expect(getAuthEpoch()).toBeGreaterThan(e5)
  })

  it('calls auth closure endpoints (config, email codes, verify, reset, profile) without triggering refresh on public auth errors', async () => {
    setAccessToken('session-token')
    const calls: Array<{ method: string; url: string; body: unknown; auth: string | null }> = []
    const authConfig: AuthConfigResponse = {
      email_verification_required: true,
      smtp_configured: true,
      code_ttl_minutes: 10,
      code_cooldown_seconds: 60,
    }
    const sendCodeResponse: EmailCodeSendResponse = {
      sent: true,
      expires_in_seconds: 600,
      cooldown_seconds: 60,
      message: '验证码已发送至您的邮箱，请注意查收',
    }
    const updatedUser: UserProfile = {
      ...SAMPLE_USER,
      display_name: '安全复盘者',
      email_verified: true,
    }

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const request = asRequest(input)
      const url = new URL(request.url)
      const rawBody =
        request.method === 'POST' || request.method === 'PATCH' ? await request.clone().text() : ''
      const parsedBody: unknown = rawBody ? JSON.parse(rawBody) : null
      calls.push({
        method: request.method,
        url: url.pathname,
        body: parsedBody,
        auth: request.headers.get('Authorization'),
      })

      if (url.pathname === '/api/auth/config' && request.method === 'GET') {
        return jsonResponse(authConfig, 200)
      }
      if (url.pathname === '/api/auth/email-codes' && request.method === 'POST') {
        return jsonResponse(sendCodeResponse, 200)
      }
      if (url.pathname === '/api/auth/me/email-codes' && request.method === 'POST') {
        return jsonResponse(sendCodeResponse, 200)
      }
      if (url.pathname === '/api/auth/verify-email' && request.method === 'POST') {
        return jsonResponse(updatedUser, 200)
      }
      if (url.pathname === '/api/auth/password/reset' && request.method === 'POST') {
        return jsonResponse({ detail: '验证码错误或已过期' }, 401)
      }
      if (url.pathname === '/api/auth/me' && request.method === 'PATCH') {
        return jsonResponse(updatedUser, 200)
      }
      return jsonResponse({ detail: 'unexpected' }, 500)
    })

    expect(await api.getAuthConfig()).toEqual(authConfig)
    expect(
      await api.sendPublicEmailCode({ email: 'investor@example.com', purpose: 'register' }),
    ).toEqual(sendCodeResponse)
    expect(await api.sendMyEmailCode({ purpose: 'verify_email' })).toEqual(sendCodeResponse)
    expect(await api.verifyEmail({ verification_code: '123456' })).toEqual(updatedUser)
    expect(await api.updateProfile({ display_name: '安全复盘者' })).toEqual(updatedUser)
    await expect(
      api.resetPassword({
        email: 'investor@example.com',
        verification_code: '000000',
        new_password: 'newpassword123',
      }),
    ).rejects.toMatchObject({ status: 401, message: '验证码错误或已过期' })

    expect(calls).toEqual([
      { method: 'GET', url: '/api/auth/config', body: null, auth: null },
      {
        method: 'POST',
        url: '/api/auth/email-codes',
        body: { email: 'investor@example.com', purpose: 'register' },
        auth: null,
      },
      {
        method: 'POST',
        url: '/api/auth/me/email-codes',
        body: { purpose: 'verify_email' },
        auth: 'Bearer session-token',
      },
      {
        method: 'POST',
        url: '/api/auth/verify-email',
        body: { verification_code: '123456' },
        auth: 'Bearer session-token',
      },
      {
        method: 'PATCH',
        url: '/api/auth/me',
        body: { display_name: '安全复盘者' },
        auth: 'Bearer session-token',
      },
      {
        method: 'POST',
        url: '/api/auth/password/reset',
        body: {
          email: 'investor@example.com',
          verification_code: '000000',
          new_password: 'newpassword123',
        },
        auth: null,
      },
    ])
  })

  it('rotates accessToken on changePassword, cancels if logout races, and clears accessToken only on OK deleteAccount', async () => {
    setAccessToken('old-token')
    const rotatedTokenResponse: TokenResponse = {
      access_token: 'rotated-token',
      token_type: 'bearer',
      expires_in: 900,
      user: SAMPLE_USER,
    }

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const request = asRequest(input)
      const pathname = new URL(request.url).pathname

      if (pathname === '/api/auth/password/change' && request.method === 'POST') {
        return jsonResponse(rotatedTokenResponse, 200)
      }
      if (pathname === '/api/auth/me/delete' && request.method === 'POST') {
        const parsed: unknown = JSON.parse(await request.clone().text())
        if (typeof parsed === 'object' && parsed !== null && 'password' in parsed) {
          if (parsed.password === 'wrong-password') {
            return jsonResponse({ detail: '密码错误' }, 400)
          }
        }
        return new Response(null, { status: 204 })
      }
      if (pathname === '/api/auth/logout') {
        return new Response(null, { status: 204 })
      }
      return jsonResponse({ detail: 'unexpected' }, 500)
    })

    const epochBeforeChange = getAuthEpoch()
    const changed = await api.changePassword({
      current_password: 'old-password',
      new_password: 'new-password-123',
    })
    expect(changed.access_token).toBe('rotated-token')
    expect(getAccessToken()).toBe('rotated-token')
    expect(getAuthEpoch()).toBeGreaterThan(epochBeforeChange)

    await expect(api.deleteAccount({ password: 'wrong-password' })).rejects.toMatchObject({
      status: 400,
      message: '密码错误',
    })
    expect(getAccessToken()).toBe('rotated-token')

    const epochBeforeDelete = getAuthEpoch()
    await api.deleteAccount({ password: 'new-password-123' })
    expect(getAccessToken()).toBeNull()
    expect(getAuthEpoch()).toBeGreaterThan(epochBeforeDelete)

    // Race check: logout while changePassword is in flight must never resurrect token.
    setAccessToken('active-before-race')
    const changeStarted = createDeferred<void>()
    const changeGate = createDeferred<Response>()

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const request = asRequest(input)
      const pathname = new URL(request.url).pathname
      if (pathname === '/api/auth/password/change') {
        changeStarted.resolve()
        return changeGate.promise
      }
      if (pathname === '/api/auth/logout') {
        return Promise.resolve(new Response(null, { status: 204 }))
      }
      return Promise.resolve(jsonResponse({ detail: 'unexpected' }, 500))
    })

    const pendingChange = api.changePassword({
      current_password: 'new-password-123',
      new_password: 'newer-password-456',
    })
    await changeStarted.promise
    await api.logout()
    changeGate.resolve(jsonResponse(rotatedTokenResponse, 200))

    await expect(pendingChange).rejects.toMatchObject({ status: 0, message: '修改密码已取消' })
    expect(getAccessToken()).toBeNull()
  })

  it('does not wipe new session accessToken when slow deleteAccount finishes after relogin', async () => {
    setAccessToken('old-user-token')
    const deleteStarted = createDeferred<void>()
    const deleteGate = createDeferred<Response>()

    const newLoginResponse: TokenResponse = {
      access_token: 'new-user-token',
      token_type: 'bearer',
      expires_in: 900,
      user: SAMPLE_USER,
    }

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const request = asRequest(input)
      const pathname = new URL(request.url).pathname
      if (pathname === '/api/auth/me/delete') {
        deleteStarted.resolve()
        return deleteGate.promise
      }
      if (pathname === '/api/auth/login') {
        return Promise.resolve(jsonResponse(newLoginResponse, 200))
      }
      return Promise.resolve(jsonResponse({ detail: 'unexpected' }, 500))
    })

    const pendingDelete = api.deleteAccount({ password: 'old-password' })
    await deleteStarted.promise

    await api.login({ email: 'investor@example.com', password: 'password123' })
    expect(getAccessToken()).toBe('new-user-token')

    deleteGate.resolve(new Response(null, { status: 204 }))
    await pendingDelete

    expect(getAccessToken()).toBe('new-user-token')
  })

  it('clears inflightLogout on login and register so slow logout never blocks subsequent refreshes', async () => {
    setAccessToken('initial-token')
    const logoutGate1 = createDeferred<Response>()
    const logoutGate2 = createDeferred<Response>()
    let logoutCount = 0
    let refreshCount = 0

    const reloginToken: TokenResponse = {
      access_token: 'relogin-token',
      token_type: 'bearer',
      expires_in: 900,
      user: SAMPLE_USER,
    }
    const refreshedToken1: TokenResponse = {
      access_token: 'refreshed-after-login',
      token_type: 'bearer',
      expires_in: 900,
      user: SAMPLE_USER,
    }
    const registerToken: TokenResponse = {
      access_token: 'register-token',
      token_type: 'bearer',
      expires_in: 900,
      user: SAMPLE_USER,
    }
    const refreshedToken2: TokenResponse = {
      access_token: 'refreshed-after-register',
      token_type: 'bearer',
      expires_in: 900,
      user: SAMPLE_USER,
    }

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const request = asRequest(input)
      const pathname = new URL(request.url).pathname
      const auth = request.headers.get('Authorization')

      if (pathname === '/api/auth/logout') {
        logoutCount += 1
        return logoutCount === 1 ? logoutGate1.promise : logoutGate2.promise
      }
      if (pathname === '/api/auth/login') {
        return Promise.resolve(jsonResponse(reloginToken, 200))
      }
      if (pathname === '/api/auth/register') {
        return Promise.resolve(jsonResponse(registerToken, 201))
      }
      if (pathname === '/api/auth/refresh') {
        refreshCount += 1
        return Promise.resolve(
          jsonResponse(refreshCount === 1 ? refreshedToken1 : refreshedToken2, 200),
        )
      }
      if (pathname === '/api/watchlist') {
        if (auth === 'Bearer relogin-token' || auth === 'Bearer register-token') {
          return Promise.resolve(jsonResponse({ detail: '登录凭证已过期' }, 401))
        }
        if (auth === 'Bearer refreshed-after-login' || auth === 'Bearer refreshed-after-register') {
          return Promise.resolve(jsonResponse([SAMPLE_ITEM], 200))
        }
      }
      return Promise.resolve(jsonResponse({ detail: 'unexpected' }, 500))
    })

    const slowLogout1 = api.logout()
    await api.login({ email: 'investor@example.com', password: 'password123' })
    expect(getAccessToken()).toBe('relogin-token')

    const itemsAfterLogin = await api.listWatchlist()
    expect(itemsAfterLogin).toEqual([SAMPLE_ITEM])
    expect(refreshCount).toBe(1)
    expect(getAccessToken()).toBe('refreshed-after-login')

    logoutGate1.resolve(new Response(null, { status: 204 }))
    await slowLogout1
    expect(getAccessToken()).toBe('refreshed-after-login')

    const slowLogout2 = api.logout()
    await api.register({
      email: 'investor@example.com',
      password: 'password123',
      display_name: '价值猎手',
    })
    expect(getAccessToken()).toBe('register-token')

    const itemsAfterRegister = await api.listWatchlist()
    expect(itemsAfterRegister).toEqual([SAMPLE_ITEM])
    expect(refreshCount).toBe(2)
    expect(getAccessToken()).toBe('refreshed-after-register')

    logoutGate2.resolve(new Response(null, { status: 204 }))
    await slowLogout2
    expect(getAccessToken()).toBe('refreshed-after-register')
  })

  it('prevents concurrent 401 refresh from firing authExpired or wiping rotated token during changePassword, while expiring if changePassword fails', async () => {
    setAccessToken('old-token-a')
    const expiredListener = vi.fn()
    const unsubscribe = subscribeAuthExpired(expiredListener)

    const changeGateA = createDeferred<Response>()
    const refreshStartedA = createDeferred<void>()
    const refreshGateA = createDeferred<Response>()

    const rotatedResponseA: TokenResponse = {
      access_token: 'rotated-pw-token-a',
      token_type: 'bearer',
      expires_in: 900,
      user: SAMPLE_USER,
    }

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const request = asRequest(input)
      const pathname = new URL(request.url).pathname
      if (pathname === '/api/auth/password/change') {
        return changeGateA.promise
      }
      if (pathname === '/api/auth/refresh') {
        refreshStartedA.resolve()
        return refreshGateA.promise
      }
      return Promise.resolve(jsonResponse({ detail: 'unexpected' }, 500))
    })

    try {
      const pendingChangeA = api.changePassword({
        current_password: 'old-password',
        new_password: 'new-password-123',
      })
      const pendingRefreshA = api.refreshSession()
      await refreshStartedA.promise

      refreshGateA.resolve(jsonResponse({ detail: 'Refresh token 已吊销' }, 401))
      await Promise.resolve()
      changeGateA.resolve(jsonResponse(rotatedResponseA, 200))

      const [changeResA, refreshResA] = await Promise.all([pendingChangeA, pendingRefreshA])
      expect(changeResA.access_token).toBe('rotated-pw-token-a')
      expect(refreshResA?.access_token ?? 'rotated-pw-token-a').toBe('rotated-pw-token-a')
      expect(getAccessToken()).toBe('rotated-pw-token-a')
      expect(expiredListener).not.toHaveBeenCalled()

      setAccessToken('old-token-b')
      const refreshStartedB = createDeferred<void>()
      const refreshGateB = createDeferred<Response>()
      const changeGateB = createDeferred<Response>()
      const rotatedResponseB: TokenResponse = {
        access_token: 'rotated-pw-token-b',
        token_type: 'bearer',
        expires_in: 900,
        user: SAMPLE_USER,
      }

      vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
        const request = asRequest(input)
        const pathname = new URL(request.url).pathname
        if (pathname === '/api/auth/refresh') {
          refreshStartedB.resolve()
          return refreshGateB.promise
        }
        if (pathname === '/api/auth/password/change') {
          return changeGateB.promise
        }
        return Promise.resolve(jsonResponse({ detail: 'unexpected' }, 500))
      })

      const pendingRefreshB = api.refreshSession()
      await refreshStartedB.promise
      const pendingChangeB = api.changePassword({
        current_password: 'old-password',
        new_password: 'new-password-456',
      })

      refreshGateB.resolve(jsonResponse({ detail: 'Refresh token 已吊销' }, 401))
      await Promise.resolve()
      changeGateB.resolve(jsonResponse(rotatedResponseB, 200))

      await Promise.all([pendingRefreshB, pendingChangeB])
      expect(getAccessToken()).toBe('rotated-pw-token-b')
      expect(expiredListener).not.toHaveBeenCalled()

      setAccessToken('old-token-c')
      const refreshStartedC = createDeferred<void>()
      const refreshGateC = createDeferred<Response>()
      const changeGateC = createDeferred<Response>()

      vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
        const request = asRequest(input)
        const pathname = new URL(request.url).pathname
        if (pathname === '/api/auth/refresh') {
          refreshStartedC.resolve()
          return refreshGateC.promise
        }
        if (pathname === '/api/auth/password/change') {
          return changeGateC.promise
        }
        return Promise.resolve(jsonResponse({ detail: 'unexpected' }, 500))
      })

      const pendingChangeC = api.changePassword({
        current_password: 'wrong-password',
        new_password: 'new-password-789',
      })
      const pendingRefreshC = api.refreshSession()
      await refreshStartedC.promise

      refreshGateC.resolve(jsonResponse({ detail: '会话已失效' }, 401))
      await Promise.resolve()
      changeGateC.resolve(jsonResponse({ detail: '当前密码错误' }, 400))

      await expect(pendingChangeC).rejects.toMatchObject({ status: 400, message: '当前密码错误' })
      expect(await pendingRefreshC).toBeNull()
      expect(getAccessToken()).toBeNull()
      expect(expiredListener).toHaveBeenCalledTimes(1)
    } finally {
      unsubscribe()
    }
  })

  it('serializes only defined screener filters in getStockScreener', async () => {
    const requestedUrls: URL[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const request = asRequest(input)
      requestedUrls.push(new URL(request.url))
      return Promise.resolve(
        jsonResponse(
          {
            total_synced: 1,
            filtered_count: 1,
            industries: ['食品饮料'],
            items: [],
          },
          200,
        ),
      )
    })

    await api.getStockScreener({
      zeroRedOnly: true,
      maxPePercentile: 30,
      minRoe: 15,
      minDividendYield: 2,
      industry: '食品饮料',
      q: '茅台',
      qualityFilter: 'core_only',
      sortBy: 'pe_percentile_10y',
      sortDir: 'asc',
      limit: 20,
    })

    await api.getStockScreener({ zeroRedOnly: false, q: '   ', industry: '' })

    expect(requestedUrls).toHaveLength(2)
    expect(requestedUrls[0]?.pathname).toBe('/api/stocks/screener')
    expect(requestedUrls[0]?.searchParams.get('zero_red_only')).toBe('true')
    expect(requestedUrls[0]?.searchParams.get('max_pe_percentile')).toBe('30')
    expect(requestedUrls[0]?.searchParams.get('min_roe')).toBe('15')
    expect(requestedUrls[0]?.searchParams.get('min_dividend_yield')).toBe('2')
    expect(requestedUrls[0]?.searchParams.get('industry')).toBe('食品饮料')
    expect(requestedUrls[0]?.searchParams.get('q')).toBe('茅台')
    expect(requestedUrls[0]?.searchParams.get('quality_filter')).toBe('core_only')
    expect(requestedUrls[0]?.searchParams.get('sort_by')).toBe('pe_percentile_10y')
    expect(requestedUrls[0]?.searchParams.get('sort_dir')).toBe('asc')
    expect(requestedUrls[0]?.searchParams.get('limit')).toBe('20')

    expect(requestedUrls[1]?.searchParams.toString()).toBe('')
  })

  it('calls GET /api/market/discovery and propagates ApiError on failure', async () => {
    const sampleDiscovery: MarketDiscoveryResponse = {
      as_of: '2026-11-24',
      generated_at: '2026-11-24T10:00:00Z',
      synced_stock_count: 12,
      temperature: {
        score: 38,
        level: 'cool',
        pe_median: 24.6,
        pe_percentile: 31,
        bond_yield: 2.18,
        equity_bond_spread: 1.89,
        comment: '估值处于近十年偏低区间。',
      },
      cross_asset: {
        as_of: '2026-11-24',
        us_2y_yield: 4.25,
        us_10y_yield: 4.38,
        us_10y_2y_spread: 0.13,
        cn_10y_yield: 2.1,
        us_cn_10y_spread: 2.28,
        us_real_yield_proxy_pct: 1.78,
        gold_price_cny: 615.4,
        gold_symbol: 'Au99.99',
        style_indices: [],
        warnings: [],
      },
      themes: [
        {
          theme_id: 'gold_fed_cycle',
          title: '美联储政策预期 × 黄金配置赔率',
          subtitle: '利率见顶观察',
          signal: 'green',
          verdict: '宽松酝酿·赔率占优',
          regime_summary: '2Y 美债走弱支撑黄金配置赔率。',
          metrics: [{ label: '美债 2Y', value_text: '4.25%', tone: 'green' }],
          picks: [],
          caution_picks: [],
          compare_codes: [],
        },
      ],
      candidate_buckets: {
        dividend_fortresses: [],
        gold_resources: [],
        core_cash_cows: [],
        investment_cautions: [],
        deep_value: [],
      },
    }

    const calls: Array<{ method: string; pathname: string; hasSignal: boolean }> = []
    let failNext = false
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const request = asRequest(input)
      calls.push({
        method: request.method,
        pathname: new URL(request.url).pathname,
        hasSignal: request.signal !== undefined,
      })
      if (failNext) {
        return Promise.resolve(jsonResponse({ detail: '跨资产发现服务暂不可用' }, 503))
      }
      return Promise.resolve(jsonResponse(sampleDiscovery, 200))
    })

    const controller = new AbortController()
    const payload = await api.getMarketDiscovery(controller.signal)
    expect(payload).toEqual(sampleDiscovery)

    failNext = true
    await expect(api.getMarketDiscovery()).rejects.toMatchObject({
      name: 'ApiError',
      status: 503,
      message: '跨资产发现服务暂不可用',
    })

    expect(calls).toEqual([
      { method: 'GET', pathname: '/api/market/discovery', hasSignal: true },
      { method: 'GET', pathname: '/api/market/discovery', hasSignal: true },
    ])
  })
})
