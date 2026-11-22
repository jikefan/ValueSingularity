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
})
