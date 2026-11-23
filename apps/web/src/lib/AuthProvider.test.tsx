import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthProvider } from './AuthProvider'
import { ApiError, api, getAccessToken, setAccessToken } from './api'
import { useAuth } from './authContext'
import { createQueryClient } from './queryClient'
import { queryKeys } from './queryKeys'
import { useDevilsAdvocate, useMdaDiff, useUpdateAiPreferences } from './useAi'
import type {
  AiPreferences,
  DevilsAdvocateResponse,
  MdaDiffResponse,
  TokenResponse,
  UserProfile,
} from '../types/api'

const USER_A: UserProfile = {
  id: 'aaaa1111-1111-1111-1111-111111111111',
  email: 'user-a@example.com',
  phone: null,
  display_name: '租户A',
  email_verified: true,
  plan_tier: 'pro',
  plan_expires_at: null,
  created_at: '2026-11-22T00:00:00Z',
}

const USER_B: UserProfile = {
  id: 'bbbb2222-2222-2222-2222-222222222222',
  email: 'user-b@example.com',
  phone: null,
  display_name: '租户B',
  email_verified: true,
  plan_tier: 'free',
  plan_expires_at: null,
  created_at: '2026-11-22T01:00:00Z',
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

describe('AuthProvider tenant cache isolation', () => {
  afterEach(() => {
    cleanup()
    setAccessToken(null)
    vi.restoreAllMocks()
  })

  it('clears watchlist, journal, and events caches on logout and login switch', async () => {
    const tokenA: TokenResponse = {
      access_token: 'token-a',
      token_type: 'bearer',
      expires_in: 900,
      user: USER_A,
    }
    const tokenB: TokenResponse = {
      access_token: 'token-b',
      token_type: 'bearer',
      expires_in: 900,
      user: USER_B,
    }

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const request = asRequest(input)
      const pathname = new URL(request.url).pathname

      if (pathname === '/api/auth/refresh') {
        return Promise.resolve(jsonResponse(tokenA, 200))
      }
      if (pathname === '/api/auth/logout') {
        return Promise.resolve(new Response(null, { status: 204 }))
      }
      if (pathname === '/api/auth/login') {
        return Promise.resolve(jsonResponse(tokenB, 200))
      }
      return Promise.resolve(jsonResponse({ detail: `Unhandled ${pathname}` }, 500))
    })

    const client = createQueryClient({
      defaultOptions: { queries: { retry: false } },
    })

    function Probe() {
      const { user, login, logout } = useAuth()
      return (
        <div>
          <span data-testid="current-user">{user ? user.email : 'guest'}</span>
          <button
            type="button"
            onClick={() => {
              void logout()
            }}
          >
            退出登录
          </button>
          <button
            type="button"
            onClick={() => {
              void login({ email: 'user-b@example.com', password: 'password123' })
            }}
          >
            登录B
          </button>
        </div>
      )
    }

    render(
      <QueryClientProvider client={client}>
        <AuthProvider>
          <Probe />
        </AuthProvider>
      </QueryClientProvider>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('current-user')).toHaveTextContent('user-a@example.com')
    })

    client.setQueryData(queryKeys.watchlist.list(), [{ code: '600519', name: '贵州茅台' }])
    client.setQueryData(queryKeys.journal.list(), [
      { id: 1, code: '600519', reason: 'A的私密理由' },
    ])
    client.setQueryData(queryKeys.alerts.list(), [{ id: 101, detail: 'A的告警明细' }])
    client.setQueryData(queryKeys.alerts.preferences(), {
      in_app_enabled: true,
      webhook_enabled: true,
      channel_type: 'feishu',
      webhook_url_configured: true,
      webhook_url_masked: 'https://open.feishu.cn/****A123',
    })
    client.setQueryData(queryKeys.ai.preferences(), {
      prefer_rule_only: false,
      byok_enabled: true,
      byok_base_url_masked: 'https://api.openai.com/****A111',
      byok_api_key_configured: true,
      byok_api_key_masked: 'sk-****A111',
      byok_model: 'gpt-4o-mini',
      quota: {
        plan_tier: 'pro',
        daily_limit: 30,
        used_today: 2,
        remaining_today: 28,
        byok_active: true,
        resets_at_shanghai: '2026-11-23 24:00 CST',
      },
    })
    client.setQueryData(queryKeys.events.list(), [{ id: 10, type: 'journal_create' }])

    fireEvent.click(screen.getByRole('button', { name: '退出登录' }))

    await waitFor(() => {
      expect(screen.getByTestId('current-user')).toHaveTextContent('guest')
    })
    expect(client.getQueryData(queryKeys.watchlist.list())).toBeUndefined()
    expect(client.getQueryData(queryKeys.journal.list())).toBeUndefined()
    expect(client.getQueryData(queryKeys.alerts.list())).toBeUndefined()
    expect(client.getQueryData(queryKeys.alerts.preferences())).toBeUndefined()
    expect(client.getQueryData(queryKeys.ai.preferences())).toBeUndefined()
    expect(client.getQueryData(queryKeys.events.list())).toBeUndefined()

    client.setQueryData(queryKeys.watchlist.list(), [{ code: '000001', name: '残留' }])
    client.setQueryData(queryKeys.journal.list('600519'), [{ id: 2, reason: '残留日记' }])
    client.setQueryData(queryKeys.alerts.list(), [{ id: 102, detail: '残留告警' }])
    client.setQueryData(queryKeys.alerts.preferences(), {
      in_app_enabled: false,
      webhook_enabled: true,
      channel_type: 'wecom',
      webhook_url_configured: true,
      webhook_url_masked: 'https://qyapi.weixin.qq.com/****9999',
    })
    client.setQueryData(queryKeys.ai.preferences(), {
      prefer_rule_only: true,
      byok_enabled: true,
      byok_base_url_masked: 'https://api.example.com/****9999',
      byok_api_key_configured: true,
      byok_api_key_masked: 'sk-****9999',
      byok_model: 'gpt-4o',
      quota: {
        plan_tier: 'pro',
        daily_limit: 30,
        used_today: 5,
        remaining_today: 25,
        byok_active: true,
        resets_at_shanghai: '2026-11-23 24:00 CST',
      },
    })
    client.setQueryData(queryKeys.events.list(), [{ id: 20, type: 'stale' }])

    fireEvent.click(screen.getByRole('button', { name: '登录B' }))

    await waitFor(() => {
      expect(screen.getByTestId('current-user')).toHaveTextContent('user-b@example.com')
    })
    expect(client.getQueryData(queryKeys.watchlist.list())).toBeUndefined()
    expect(client.getQueryData(queryKeys.journal.list('600519'))).toBeUndefined()
    expect(client.getQueryData(queryKeys.alerts.list())).toBeUndefined()
    expect(client.getQueryData(queryKeys.alerts.preferences())).toBeUndefined()
    expect(client.getQueryData(queryKeys.ai.preferences())).toBeUndefined()
    expect(client.getQueryData(queryKeys.events.list())).toBeUndefined()
  })

  it('clears watchlist, journal, and events caches when refresh expires mid-session', async () => {
    const tokenA: TokenResponse = {
      access_token: 'token-a',
      token_type: 'bearer',
      expires_in: 900,
      user: USER_A,
    }
    let refreshAttempt = 0

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const request = asRequest(input)
      const pathname = new URL(request.url).pathname

      if (pathname === '/api/auth/refresh') {
        refreshAttempt += 1
        if (refreshAttempt === 1) {
          return Promise.resolve(jsonResponse(tokenA, 200))
        }
        return Promise.resolve(jsonResponse({ detail: '会话已失效' }, 401))
      }
      if (pathname === '/api/events') {
        return Promise.resolve(jsonResponse({ detail: '登录凭证已过期' }, 401))
      }
      return Promise.resolve(jsonResponse({ detail: `Unhandled ${pathname}` }, 500))
    })

    const client = createQueryClient({
      defaultOptions: { queries: { retry: false } },
    })

    function Probe() {
      const { user } = useAuth()
      return <span data-testid="auth-state">{user ? user.email : 'guest'}</span>
    }

    render(
      <QueryClientProvider client={client}>
        <AuthProvider>
          <Probe />
        </AuthProvider>
      </QueryClientProvider>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('auth-state')).toHaveTextContent('user-a@example.com')
    })

    client.setQueryData(queryKeys.watchlist.list(), [{ code: '600519' }])
    client.setQueryData(queryKeys.journal.list(), [{ id: 1 }])
    client.setQueryData(queryKeys.alerts.list(), [{ id: 301 }])
    client.setQueryData(queryKeys.alerts.preferences(), { in_app_enabled: true })
    client.setQueryData(queryKeys.ai.preferences(), {
      byok_enabled: true,
      byok_api_key_masked: 'sk-****1234',
    })
    client.setQueryData(queryKeys.events.list(), [{ id: 2 }])

    await expect(api.listEvents()).rejects.toMatchObject({ status: 401 })

    await waitFor(() => {
      expect(screen.getByTestId('auth-state')).toHaveTextContent('guest')
    })
    expect(client.getQueryData(queryKeys.watchlist.list())).toBeUndefined()
    expect(client.getQueryData(queryKeys.journal.list())).toBeUndefined()
    expect(client.getQueryData(queryKeys.alerts.list())).toBeUndefined()
    expect(client.getQueryData(queryKeys.alerts.preferences())).toBeUndefined()
    expect(client.getQueryData(queryKeys.ai.preferences())).toBeUndefined()
    expect(client.getQueryData(queryKeys.events.list())).toBeUndefined()
  })

  it('does not re-mint accessToken via /refresh when refetch runs right after logout starts', async () => {
    const tokenA: TokenResponse = {
      access_token: 'token-a',
      token_type: 'bearer',
      expires_in: 900,
      user: USER_A,
    }
    let refreshCalls = 0
    let resolveLogout!: (response: Response) => void
    const logoutDeferred = new Promise<Response>((resolve) => {
      resolveLogout = resolve
    })

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const request = asRequest(input)
      const pathname = new URL(request.url).pathname

      if (pathname === '/api/auth/refresh') {
        refreshCalls += 1
        return Promise.resolve(jsonResponse(tokenA, 200))
      }
      if (pathname === '/api/auth/logout') {
        return logoutDeferred
      }
      return Promise.resolve(jsonResponse({ detail: `Unhandled ${pathname}` }, 500))
    })

    const client = createQueryClient({
      defaultOptions: { queries: { retry: false } },
    })

    function Probe() {
      const { user, logout } = useAuth()
      return (
        <div>
          <span data-testid="current-user">{user ? user.email : 'guest'}</span>
          <button
            type="button"
            onClick={() => {
              void logout()
            }}
          >
            退出登录
          </button>
        </div>
      )
    }

    render(
      <QueryClientProvider client={client}>
        <AuthProvider>
          <Probe />
        </AuthProvider>
      </QueryClientProvider>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('current-user')).toHaveTextContent('user-a@example.com')
    })
    expect(getAccessToken()).toBe('token-a')

    fireEvent.click(screen.getByRole('button', { name: '退出登录' }))
    expect(getAccessToken()).toBeNull()
    expect(client.getQueryData(queryKeys.auth.me())).toBeNull()

    await client.refetchQueries({ queryKey: queryKeys.auth.me() })

    expect(refreshCalls).toBe(1)
    expect(getAccessToken()).toBeNull()
    await waitFor(() => {
      expect(screen.getByTestId('current-user')).toHaveTextContent('guest')
    })

    resolveLogout(new Response(null, { status: 204 }))
    await waitFor(() => {
      expect(screen.getByTestId('current-user')).toHaveTextContent('guest')
    })
    expect(getAccessToken()).toBeNull()
  })

  it('keeps user logged out when logout runs during slow in-flight login', async () => {
    const tokenB: TokenResponse = {
      access_token: 'token-b',
      token_type: 'bearer',
      expires_in: 900,
      user: USER_B,
    }
    let resolveLogin!: (response: Response) => void
    const loginDeferred = new Promise<Response>((resolve) => {
      resolveLogin = resolve
    })

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const request = asRequest(input)
      const pathname = new URL(request.url).pathname

      if (pathname === '/api/auth/refresh') {
        return Promise.resolve(jsonResponse({ detail: '未登录' }, 401))
      }
      if (pathname === '/api/auth/login') {
        return loginDeferred
      }
      if (pathname === '/api/auth/logout') {
        return Promise.resolve(new Response(null, { status: 204 }))
      }
      return Promise.resolve(jsonResponse({ detail: `Unhandled ${pathname}` }, 500))
    })

    const client = createQueryClient({
      defaultOptions: { queries: { retry: false } },
    })

    let loginError: unknown = null
    let loginDone = false

    function Probe() {
      const { user, isAuthLoading, login, logout } = useAuth()
      return (
        <div>
          <span data-testid="auth-loading">{isAuthLoading ? 'loading' : 'ready'}</span>
          <span data-testid="current-user">{user ? user.email : 'guest'}</span>
          <button
            type="button"
            onClick={() => {
              void login({ email: 'user-b@example.com', password: 'password123' })
                .catch((err: unknown) => {
                  loginError = err
                })
                .finally(() => {
                  loginDone = true
                })
            }}
          >
            登录B
          </button>
          <button
            type="button"
            onClick={() => {
              void logout()
            }}
          >
            退出登录
          </button>
        </div>
      )
    }

    render(
      <QueryClientProvider client={client}>
        <AuthProvider>
          <Probe />
        </AuthProvider>
      </QueryClientProvider>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('auth-loading')).toHaveTextContent('ready')
    })
    expect(screen.getByTestId('current-user')).toHaveTextContent('guest')

    fireEvent.click(screen.getByRole('button', { name: '登录B' }))
    fireEvent.click(screen.getByRole('button', { name: '退出登录' }))

    resolveLogin(jsonResponse(tokenB, 200))

    await waitFor(() => {
      expect(loginDone).toBe(true)
    })
    expect(loginError).toBeInstanceOf(ApiError)
    expect(screen.getByTestId('current-user')).toHaveTextContent('guest')
    expect(getAccessToken()).toBeNull()
    expect(client.getQueryData(queryKeys.auth.me())).toBeNull()
  })

  it('isolates alerts.list and alerts.preferences across logout and User B login', async () => {
    const tokenA: TokenResponse = {
      access_token: 'token-a',
      token_type: 'bearer',
      expires_in: 900,
      user: USER_A,
    }
    const tokenB: TokenResponse = {
      access_token: 'token-b',
      token_type: 'bearer',
      expires_in: 900,
      user: USER_B,
    }

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const request = asRequest(input)
      const pathname = new URL(request.url).pathname

      if (pathname === '/api/auth/refresh') {
        return Promise.resolve(jsonResponse(tokenA, 200))
      }
      if (pathname === '/api/auth/logout') {
        return Promise.resolve(new Response(null, { status: 204 }))
      }
      if (pathname === '/api/auth/login') {
        return Promise.resolve(jsonResponse(tokenB, 200))
      }
      return Promise.resolve(jsonResponse({ detail: `Unhandled ${pathname}` }, 500))
    })

    const client = createQueryClient({
      defaultOptions: { queries: { retry: false } },
    })

    function Probe() {
      const { user, login, logout } = useAuth()
      return (
        <div>
          <span data-testid="current-user">{user ? user.email : 'guest'}</span>
          <button
            type="button"
            onClick={() => {
              void logout()
            }}
          >
            退出登录
          </button>
          <button
            type="button"
            onClick={() => {
              void login({ email: 'user-b@example.com', password: 'password123' })
            }}
          >
            登录B
          </button>
        </div>
      )
    }

    render(
      <QueryClientProvider client={client}>
        <AuthProvider>
          <Probe />
        </AuthProvider>
      </QueryClientProvider>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('current-user')).toHaveTextContent('user-a@example.com')
    })

    client.setQueryData(queryKeys.alerts.list(50), [{ id: 1, detail: 'A的绝密触达' }])
    client.setQueryData(queryKeys.alerts.preferences(), {
      in_app_enabled: true,
      webhook_enabled: true,
      channel_type: 'feishu',
      webhook_url_configured: true,
      webhook_url_masked: 'https://open.feishu.cn/****A999',
    })

    fireEvent.click(screen.getByRole('button', { name: '退出登录' }))
    await waitFor(() => {
      expect(screen.getByTestId('current-user')).toHaveTextContent('guest')
    })
    expect(client.getQueryData(queryKeys.alerts.list(50))).toBeUndefined()
    expect(client.getQueryData(queryKeys.alerts.preferences())).toBeUndefined()

    fireEvent.click(screen.getByRole('button', { name: '登录B' }))
    await waitFor(() => {
      expect(screen.getByTestId('current-user')).toHaveTextContent('user-b@example.com')
    })
    expect(client.getQueryData(queryKeys.alerts.list(50))).toBeUndefined()
    expect(client.getQueryData(queryKeys.alerts.preferences())).toBeUndefined()
  })

  it('evicts per-stock AI caches, cancels in-flight user queries, and drops stale in-flight AI mutation writes across user switch', async () => {
    const tokenA: TokenResponse = {
      access_token: 'token-a',
      token_type: 'bearer',
      expires_in: 900,
      user: USER_A,
    }
    const tokenB: TokenResponse = {
      access_token: 'token-b',
      token_type: 'bearer',
      expires_in: 900,
      user: USER_B,
    }
    const userBPrefs: AiPreferences = {
      prefer_rule_only: false,
      byok_enabled: false,
      byok_base_url_masked: null,
      byok_api_key_configured: false,
      byok_api_key_masked: null,
      byok_model: 'gpt-4o-mini',
      quota: {
        plan_tier: 'free',
        daily_limit: 5,
        used_today: 0,
        remaining_today: 5,
        byok_active: false,
        resets_at_shanghai: '2026-11-23 24:00 CST',
      },
    }
    const userADaResponse: DevilsAdvocateResponse = {
      code: '600519',
      stock_name: '贵州茅台',
      as_of: '2026-11-22',
      mode: 'llm',
      fallback_reason: null,
      challenges: [],
      quota: {
        plan_tier: 'pro',
        daily_limit: 30,
        used_today: 29,
        remaining_today: 1,
        byok_active: false,
        resets_at_shanghai: '2026-11-23 24:00 CST',
      },
      compliance_notice: 'A的合规提示',
    }
    const userAMdaResponse: MdaDiffResponse = {
      code: '600519',
      stock_name: '贵州茅台',
      previous_period_label: '2024',
      current_period_label: '2025',
      mode: 'llm',
      fallback_reason: null,
      summary: 'A的MD&A摘要',
      metric_shifts: [],
      text_highlights: [],
      quota: userADaResponse.quota,
      compliance_notice: 'A的合规提示',
    }

    let resolveDa!: (res: Response) => void
    let resolveMda!: (res: Response) => void
    let resolvePrefsUpdate!: (res: Response) => void
    const daDeferred = new Promise<Response>((resolve) => {
      resolveDa = resolve
    })
    const mdaDeferred = new Promise<Response>((resolve) => {
      resolveMda = resolve
    })
    const prefsUpdateDeferred = new Promise<Response>((resolve) => {
      resolvePrefsUpdate = resolve
    })
    let userBPrefsFetchCount = 0

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const request = asRequest(input)
      const pathname = new URL(request.url).pathname

      if (pathname === '/api/auth/refresh') {
        return Promise.resolve(jsonResponse(tokenA, 200))
      }
      if (pathname === '/api/auth/logout') {
        return Promise.resolve(new Response(null, { status: 204 }))
      }
      if (pathname === '/api/auth/login') {
        return Promise.resolve(jsonResponse(tokenB, 200))
      }
      if (pathname === '/api/ai/preferences' && request.method === 'GET') {
        userBPrefsFetchCount += 1
        return Promise.resolve(jsonResponse(userBPrefs, 200))
      }
      if (pathname === '/api/ai/preferences' && request.method === 'PUT') {
        return prefsUpdateDeferred
      }
      if (pathname === '/api/ai/devils-advocate') {
        return daDeferred
      }
      if (pathname === '/api/ai/mda-diff') {
        return mdaDeferred
      }
      return Promise.resolve(jsonResponse({ detail: `Unhandled ${pathname}` }, 500))
    })

    const client = createQueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const cancelSpy = vi.spyOn(client, 'cancelQueries')

    function Probe() {
      const { user, login, logout } = useAuth()
      const daMutation = useDevilsAdvocate()
      const mdaMutation = useMdaDiff()
      const prefsMutation = useUpdateAiPreferences()
      return (
        <div>
          <span data-testid="current-user">{user ? user.email : 'guest'}</span>
          <button
            type="button"
            onClick={() => {
              daMutation.mutate({
                code: '600519',
                action: 'buy',
                reason: 'A的质询',
                falsify_condition: '',
                mode: 'auto',
              })
              mdaMutation.mutate({
                code: '600519',
                previous_period_label: '2024',
                current_period_label: '2025',
                previous_text: 'prev',
                current_text: 'curr',
                mode: 'auto',
              })
              prefsMutation.mutate({ prefer_rule_only: true })
            }}
          >
            触发A并发AI调用
          </button>
          <button
            type="button"
            onClick={() => {
              void logout()
            }}
          >
            退出登录
          </button>
          <button
            type="button"
            onClick={() => {
              void login({ email: 'user-b@example.com', password: 'password123' })
            }}
          >
            登录B
          </button>
        </div>
      )
    }

    render(
      <QueryClientProvider client={client}>
        <AuthProvider>
          <Probe />
        </AuthProvider>
      </QueryClientProvider>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('current-user')).toHaveTextContent('user-a@example.com')
    })

    client.setQueryData(queryKeys.ai.devilsAdvocate(USER_A.id, '600519'), userADaResponse)
    client.setQueryData(queryKeys.ai.mdaDiff(USER_A.id, '600519'), userAMdaResponse)
    client.setQueryData(queryKeys.ai.preferences(), { ...userBPrefs, prefer_rule_only: true })

    fireEvent.click(screen.getByRole('button', { name: '触发A并发AI调用' }))

    fireEvent.click(screen.getByRole('button', { name: '退出登录' }))
    await waitFor(() => {
      expect(screen.getByTestId('current-user')).toHaveTextContent('guest')
    })
    expect(cancelSpy).toHaveBeenCalledWith({ queryKey: queryKeys.ai.all })
    expect(client.getQueryData(queryKeys.ai.devilsAdvocate(USER_A.id, '600519'))).toBeUndefined()
    expect(client.getQueryData(queryKeys.ai.mdaDiff(USER_A.id, '600519'))).toBeUndefined()

    fireEvent.click(screen.getByRole('button', { name: '登录B' }))
    await waitFor(() => {
      expect(screen.getByTestId('current-user')).toHaveTextContent('user-b@example.com')
    })
    client.setQueryData(queryKeys.ai.preferences(), userBPrefs)

    // User A's stale in-flight mutations settle AFTER User B logged in (one 200, one 429, one PUT 200).
    resolveDa(jsonResponse(userADaResponse, 200))
    resolveMda(jsonResponse({ detail: '今日平台 AI 额度已用完（30/30）' }, 429))
    resolvePrefsUpdate(jsonResponse({ ...userBPrefs, prefer_rule_only: true }, 200))

    await waitFor(() => {
      expect(client.getQueryData(queryKeys.ai.preferences())).toEqual(userBPrefs)
    })
    expect(client.getQueryData(queryKeys.ai.devilsAdvocate(USER_A.id, '600519'))).toBeUndefined()
    expect(client.getQueryData(queryKeys.ai.devilsAdvocate(USER_B.id, '600519'))).toBeUndefined()
    expect(client.getQueryData(queryKeys.ai.mdaDiff(USER_A.id, '600519'))).toBeUndefined()
    expect(userBPrefsFetchCount).toBe(0)
  })

  it('syncs updateProfile, verifyEmail, and changePassword without clearing caches, and drops stale resolutions after logout', async () => {
    const unverifiedUserA: UserProfile = { ...USER_A, email_verified: false }
    const tokenA: TokenResponse = {
      access_token: 'token-a',
      token_type: 'bearer',
      expires_in: 900,
      user: unverifiedUserA,
    }
    const renamedUserA: UserProfile = { ...unverifiedUserA, display_name: '新昵称A' }
    const verifiedUserA: UserProfile = { ...renamedUserA, email_verified: true }
    const passwordRotatedToken: TokenResponse = {
      access_token: 'token-a-rotated',
      token_type: 'bearer',
      expires_in: 900,
      user: verifiedUserA,
    }

    let resolveSlowProfile!: (res: Response) => void
    let profileCalls = 0

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const request = asRequest(input)
      const pathname = new URL(request.url).pathname

      if (pathname === '/api/auth/refresh') {
        return Promise.resolve(jsonResponse(tokenA, 200))
      }
      if (pathname === '/api/auth/me' && request.method === 'PATCH') {
        profileCalls += 1
        if (profileCalls === 1) {
          return Promise.resolve(jsonResponse(renamedUserA, 200))
        }
        return new Promise<Response>((resolve) => {
          resolveSlowProfile = resolve
        })
      }
      if (pathname === '/api/auth/verify-email' && request.method === 'POST') {
        return Promise.resolve(jsonResponse(verifiedUserA, 200))
      }
      if (pathname === '/api/auth/password/change' && request.method === 'POST') {
        return Promise.resolve(jsonResponse(passwordRotatedToken, 200))
      }
      if (pathname === '/api/auth/logout' && request.method === 'POST') {
        return Promise.resolve(new Response(null, { status: 204 }))
      }
      return Promise.resolve(jsonResponse({ detail: `Unhandled ${pathname}` }, 500))
    })

    const client = createQueryClient({
      defaultOptions: { queries: { retry: false } },
    })

    function Probe() {
      const { user, updateProfile, verifyEmail, changePassword, logout } = useAuth()
      return (
        <div>
          <span data-testid="user-name">{user ? user.display_name : 'guest'}</span>
          <span data-testid="user-verified">{user?.email_verified ? 'yes' : 'no'}</span>
          <button
            type="button"
            onClick={() => {
              void updateProfile({ display_name: '新昵称A' })
            }}
          >
            改昵称
          </button>
          <button
            type="button"
            onClick={() => {
              void verifyEmail({ verification_code: '123456' })
            }}
          >
            验邮箱
          </button>
          <button
            type="button"
            onClick={() => {
              void changePassword({
                current_password: 'old-password',
                new_password: 'new-password-123',
              })
            }}
          >
            改密码
          </button>
          <button
            type="button"
            onClick={() => {
              void updateProfile({ display_name: '慢请求昵称' })
            }}
          >
            慢改昵称
          </button>
          <button
            type="button"
            onClick={() => {
              void logout()
            }}
          >
            退出
          </button>
        </div>
      )
    }

    render(
      <QueryClientProvider client={client}>
        <AuthProvider>
          <Probe />
        </AuthProvider>
      </QueryClientProvider>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('user-name')).toHaveTextContent('租户A')
    })
    client.setQueryData(queryKeys.watchlist.list(), [{ code: '600519' }])

    fireEvent.click(screen.getByRole('button', { name: '改昵称' }))
    await waitFor(() => {
      expect(screen.getByTestId('user-name')).toHaveTextContent('新昵称A')
    })

    fireEvent.click(screen.getByRole('button', { name: '验邮箱' }))
    await waitFor(() => {
      expect(screen.getByTestId('user-verified')).toHaveTextContent('yes')
    })

    fireEvent.click(screen.getByRole('button', { name: '改密码' }))
    await waitFor(() => {
      expect(getAccessToken()).toBe('token-a-rotated')
    })
    expect(screen.getByTestId('user-name')).toHaveTextContent('新昵称A')
    expect(client.getQueryData(queryKeys.watchlist.list())).toEqual([{ code: '600519' }])

    // Start slow updateProfile, then immediately logout; slow resolution must NOT restore user state.
    fireEvent.click(screen.getByRole('button', { name: '慢改昵称' }))
    fireEvent.click(screen.getByRole('button', { name: '退出' }))
    await waitFor(() => {
      expect(screen.getByTestId('user-name')).toHaveTextContent('guest')
    })

    resolveSlowProfile(jsonResponse({ ...verifiedUserA, display_name: '慢请求昵称' }, 200))
    await Promise.resolve()
    await Promise.resolve()

    expect(screen.getByTestId('user-name')).toHaveTextContent('guest')
    expect(client.getQueryData(queryKeys.auth.me())).toBeNull()
  })

  it('clears user session and USER_SCOPED_QUERY_KEYS on deleteAccount success while keeping auth.config and preserving state on error', async () => {
    const tokenA: TokenResponse = {
      access_token: 'token-a',
      token_type: 'bearer',
      expires_in: 900,
      user: USER_A,
    }
    const authConfig = {
      email_verification_required: false,
      smtp_configured: false,
      code_ttl_minutes: 10,
      code_cooldown_seconds: 60,
    }

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const request = asRequest(input)
      const pathname = new URL(request.url).pathname

      if (pathname === '/api/auth/refresh') {
        return jsonResponse(tokenA, 200)
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
      return jsonResponse({ detail: `Unhandled ${pathname}` }, 500)
    })

    const client = createQueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const cancelSpy = vi.spyOn(client, 'cancelQueries')
    let lastError: unknown = null

    function Probe() {
      const { user, deleteAccount } = useAuth()
      return (
        <div>
          <span data-testid="current-user">{user ? user.email : 'guest'}</span>
          <button
            type="button"
            onClick={() => {
              void deleteAccount({ password: 'wrong-password' }).catch((err: unknown) => {
                lastError = err
              })
            }}
          >
            错误密码注销
          </button>
          <button
            type="button"
            onClick={() => {
              void deleteAccount({ password: 'correct-password' })
            }}
          >
            确认注销
          </button>
        </div>
      )
    }

    render(
      <QueryClientProvider client={client}>
        <AuthProvider>
          <Probe />
        </AuthProvider>
      </QueryClientProvider>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('current-user')).toHaveTextContent('user-a@example.com')
    })

    client.setQueryData(queryKeys.auth.config(), authConfig)
    client.setQueryData(queryKeys.watchlist.list(), [{ code: '600519' }])
    client.setQueryData(queryKeys.journal.list(), [{ id: 1 }])
    client.setQueryData(queryKeys.alerts.list(), [{ id: 10 }])
    client.setQueryData(queryKeys.events.list(), [{ id: 20 }])
    client.setQueryData(queryKeys.ai.preferences(), { prefer_rule_only: false })

    fireEvent.click(screen.getByRole('button', { name: '错误密码注销' }))
    await waitFor(() => {
      expect(lastError).toBeInstanceOf(ApiError)
    })
    expect(screen.getByTestId('current-user')).toHaveTextContent('user-a@example.com')
    expect(getAccessToken()).toBe('token-a')
    expect(client.getQueryData(queryKeys.watchlist.list())).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: '确认注销' }))
    await waitFor(() => {
      expect(screen.getByTestId('current-user')).toHaveTextContent('guest')
    })

    expect(getAccessToken()).toBeNull()
    expect(client.getQueryData(queryKeys.auth.me())).toBeNull()
    expect(client.getQueryData(queryKeys.watchlist.list())).toBeUndefined()
    expect(client.getQueryData(queryKeys.journal.list())).toBeUndefined()
    expect(client.getQueryData(queryKeys.alerts.list())).toBeUndefined()
    expect(client.getQueryData(queryKeys.events.list())).toBeUndefined()
    expect(client.getQueryData(queryKeys.ai.preferences())).toBeUndefined()
    expect(client.getQueryData(queryKeys.auth.config())).toEqual(authConfig)
    expect(cancelSpy).toHaveBeenCalledWith({ queryKey: queryKeys.auth.me() })
    expect(cancelSpy).toHaveBeenCalledWith({ queryKey: queryKeys.watchlist.all })
  })

  it('merges concurrent verifyEmail and updateProfile in any completion order without dropping either update', async () => {
    const initialUser: UserProfile = { ...USER_A, display_name: '租户A', email_verified: false }
    const tokenA: TokenResponse = {
      access_token: 'token-a',
      token_type: 'bearer',
      expires_in: 900,
      user: initialUser,
    }

    let resolveVerify!: (res: Response) => void
    let resolveProfile!: (res: Response) => void

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const request = asRequest(input)
      const pathname = new URL(request.url).pathname

      if (pathname === '/api/auth/refresh') {
        return Promise.resolve(jsonResponse(tokenA, 200))
      }
      if (pathname === '/api/auth/verify-email' && request.method === 'POST') {
        return new Promise<Response>((resolve) => {
          resolveVerify = resolve
        })
      }
      if (pathname === '/api/auth/me' && request.method === 'PATCH') {
        return new Promise<Response>((resolve) => {
          resolveProfile = resolve
        })
      }
      return Promise.resolve(jsonResponse({ detail: `Unhandled ${pathname}` }, 500))
    })

    function Probe() {
      const { user, verifyEmail, updateProfile } = useAuth()
      return (
        <div>
          <span data-testid="user-name">{user ? user.display_name : 'guest'}</span>
          <span data-testid="user-verified">{user?.email_verified ? 'yes' : 'no'}</span>
          <button
            type="button"
            onClick={() => {
              void verifyEmail({ verification_code: '123456' })
              void updateProfile({ display_name: '并发新昵称' })
            }}
          >
            并发触发
          </button>
        </div>
      )
    }

    const client1 = createQueryClient({ defaultOptions: { queries: { retry: false } } })
    const view1 = render(
      <QueryClientProvider client={client1}>
        <AuthProvider>
          <Probe />
        </AuthProvider>
      </QueryClientProvider>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('user-name')).toHaveTextContent('租户A')
    })

    fireEvent.click(screen.getByRole('button', { name: '并发触发' }))
    resolveVerify(jsonResponse({ ...initialUser, email_verified: true }, 200))
    await waitFor(() => {
      expect(screen.getByTestId('user-verified')).toHaveTextContent('yes')
    })

    resolveProfile(
      jsonResponse({ ...initialUser, display_name: '并发新昵称', email_verified: false }, 200),
    )
    await waitFor(() => {
      expect(screen.getByTestId('user-name')).toHaveTextContent('并发新昵称')
    })
    expect(screen.getByTestId('user-verified')).toHaveTextContent('yes')
    view1.unmount()
    setAccessToken(null)

    const client2 = createQueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client2}>
        <AuthProvider>
          <Probe />
        </AuthProvider>
      </QueryClientProvider>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('user-name')).toHaveTextContent('租户A')
    })

    fireEvent.click(screen.getByRole('button', { name: '并发触发' }))
    resolveProfile(
      jsonResponse({ ...initialUser, display_name: '顺序二昵称', email_verified: false }, 200),
    )
    await waitFor(() => {
      expect(screen.getByTestId('user-name')).toHaveTextContent('顺序二昵称')
    })

    resolveVerify(
      jsonResponse({ ...initialUser, display_name: '租户A', email_verified: true }, 200),
    )
    await waitFor(() => {
      expect(screen.getByTestId('user-verified')).toHaveTextContent('yes')
    })
    expect(screen.getByTestId('user-name')).toHaveTextContent('顺序二昵称')
  })

  it('drops stale in-flight profile updates after deleteAccount or session expiry', async () => {
    const initialUser: UserProfile = { ...USER_A, email_verified: false }
    const tokenA: TokenResponse = {
      access_token: 'token-a',
      token_type: 'bearer',
      expires_in: 900,
      user: initialUser,
    }
    let refreshAttempt = 0
    let resolveSlowProfile!: (res: Response) => void
    let resolveSlowVerify!: (res: Response) => void

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const request = asRequest(input)
      const pathname = new URL(request.url).pathname

      if (pathname === '/api/auth/refresh') {
        refreshAttempt += 1
        if (refreshAttempt === 1) {
          return Promise.resolve(jsonResponse(tokenA, 200))
        }
        return Promise.resolve(jsonResponse({ detail: '会话已失效' }, 401))
      }
      if (pathname === '/api/auth/me' && request.method === 'PATCH') {
        return new Promise<Response>((resolve) => {
          resolveSlowProfile = resolve
        })
      }
      if (pathname === '/api/auth/verify-email' && request.method === 'POST') {
        return new Promise<Response>((resolve) => {
          resolveSlowVerify = resolve
        })
      }
      if (pathname === '/api/auth/me/delete' && request.method === 'POST') {
        return Promise.resolve(new Response(null, { status: 204 }))
      }
      if (pathname === '/api/events') {
        return Promise.resolve(jsonResponse({ detail: '登录凭证已过期' }, 401))
      }
      return Promise.resolve(jsonResponse({ detail: `Unhandled ${pathname}` }, 500))
    })

    function Probe() {
      const { user, updateProfile, verifyEmail, deleteAccount } = useAuth()
      return (
        <div>
          <span data-testid="current-user">{user ? user.display_name : 'guest'}</span>
          <button
            type="button"
            onClick={() => {
              void updateProfile({ display_name: '晚到昵称' })
              void verifyEmail({ verification_code: '123456' })
            }}
          >
            发起更新
          </button>
          <button
            type="button"
            onClick={() => {
              void deleteAccount({ password: 'correct-password' })
            }}
          >
            注销账户
          </button>
        </div>
      )
    }

    const client1 = createQueryClient({ defaultOptions: { queries: { retry: false } } })
    const view1 = render(
      <QueryClientProvider client={client1}>
        <AuthProvider>
          <Probe />
        </AuthProvider>
      </QueryClientProvider>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('current-user')).toHaveTextContent('租户A')
    })

    fireEvent.click(screen.getByRole('button', { name: '发起更新' }))
    fireEvent.click(screen.getByRole('button', { name: '注销账户' }))
    await waitFor(() => {
      expect(screen.getByTestId('current-user')).toHaveTextContent('guest')
    })

    resolveSlowProfile(jsonResponse({ ...initialUser, display_name: '晚到昵称' }, 200))
    resolveSlowVerify(jsonResponse({ ...initialUser, email_verified: true }, 200))
    await Promise.resolve()
    await Promise.resolve()

    expect(screen.getByTestId('current-user')).toHaveTextContent('guest')
    expect(client1.getQueryData(queryKeys.auth.me())).toBeNull()
    view1.unmount()
    setAccessToken(null)

    refreshAttempt = 0
    const client2 = createQueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client2}>
        <AuthProvider>
          <Probe />
        </AuthProvider>
      </QueryClientProvider>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('current-user')).toHaveTextContent('租户A')
    })

    fireEvent.click(screen.getByRole('button', { name: '发起更新' }))
    await expect(api.listEvents()).rejects.toMatchObject({ status: 401 })
    await waitFor(() => {
      expect(screen.getByTestId('current-user')).toHaveTextContent('guest')
    })

    resolveSlowProfile(jsonResponse({ ...initialUser, display_name: '晚到昵称' }, 200))
    resolveSlowVerify(jsonResponse({ ...initialUser, email_verified: true }, 200))
    await Promise.resolve()
    await Promise.resolve()

    expect(screen.getByTestId('current-user')).toHaveTextContent('guest')
    expect(client2.getQueryData(queryKeys.auth.me())).toBeNull()
  })
})
