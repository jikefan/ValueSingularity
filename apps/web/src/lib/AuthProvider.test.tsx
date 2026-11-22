import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthProvider } from './AuthProvider'
import { api, setAccessToken } from './api'
import { useAuth } from './authContext'
import { createQueryClient } from './queryClient'
import { queryKeys } from './queryKeys'
import type { TokenResponse, UserProfile } from '../types/api'

const USER_A: UserProfile = {
  id: 'aaaa1111-1111-1111-1111-111111111111',
  email: 'user-a@example.com',
  phone: null,
  display_name: '租户A',
  plan_tier: 'pro',
  plan_expires_at: null,
  created_at: '2026-11-22T00:00:00Z',
}

const USER_B: UserProfile = {
  id: 'bbbb2222-2222-2222-2222-222222222222',
  email: 'user-b@example.com',
  phone: null,
  display_name: '租户B',
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
    client.setQueryData(queryKeys.events.list(), [{ id: 10, type: 'journal_create' }])

    fireEvent.click(screen.getByRole('button', { name: '退出登录' }))

    await waitFor(() => {
      expect(screen.getByTestId('current-user')).toHaveTextContent('guest')
    })
    expect(client.getQueryData(queryKeys.watchlist.list())).toBeUndefined()
    expect(client.getQueryData(queryKeys.journal.list())).toBeUndefined()
    expect(client.getQueryData(queryKeys.events.list())).toBeUndefined()

    client.setQueryData(queryKeys.watchlist.list(), [{ code: '000001', name: '残留' }])
    client.setQueryData(queryKeys.journal.list('600519'), [{ id: 2, reason: '残留日记' }])
    client.setQueryData(queryKeys.events.list(), [{ id: 20, type: 'stale' }])

    fireEvent.click(screen.getByRole('button', { name: '登录B' }))

    await waitFor(() => {
      expect(screen.getByTestId('current-user')).toHaveTextContent('user-b@example.com')
    })
    expect(client.getQueryData(queryKeys.watchlist.list())).toBeUndefined()
    expect(client.getQueryData(queryKeys.journal.list('600519'))).toBeUndefined()
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
    client.setQueryData(queryKeys.events.list(), [{ id: 2 }])

    await expect(api.listEvents()).rejects.toMatchObject({ status: 401 })

    await waitFor(() => {
      expect(screen.getByTestId('auth-state')).toHaveTextContent('guest')
    })
    expect(client.getQueryData(queryKeys.watchlist.list())).toBeUndefined()
    expect(client.getQueryData(queryKeys.journal.list())).toBeUndefined()
    expect(client.getQueryData(queryKeys.events.list())).toBeUndefined()
  })
})
