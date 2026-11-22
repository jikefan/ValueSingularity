import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthProvider } from '../../lib/AuthProvider'
import { useAuth } from '../../lib/authContext'
import { setAccessToken } from '../../lib/api'
import { createQueryClient } from '../../lib/queryClient'
import type { TokenResponse, UserProfile } from '../../types/api'
import { AuthPage } from './AuthPage'

const SAMPLE_USER: UserProfile = {
  id: '11111111-1111-1111-1111-111111111111',
  email: 'newbie@example.com',
  phone: null,
  display_name: '巴菲特学徒',
  plan_tier: 'free',
  plan_expires_at: null,
  created_at: '2026-11-22T00:00:00Z',
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

function renderAuthRoute(
  initialEntry: string | { pathname: string; search?: string; state?: unknown } = '/login',
) {
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
            <Route path="/login" element={<AuthPage />} />
            <Route path="/register" element={<AuthPage initialMode="register" />} />
            <Route path="/me" element={<div>我的页面已跳转</div>} />
            <Route path="/stock/:code" element={<div>个股目标页已跳转</div>} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  )
}

describe('AuthPage', () => {
  afterEach(() => {
    cleanup()
    setAccessToken(null)
    vi.restoreAllMocks()
  })

  it('switches from login to register, submits registration, and navigates to /me', async () => {
    let registerPayload: unknown = null

    const tokenResponse: TokenResponse = {
      access_token: 'registered-token',
      token_type: 'bearer',
      expires_in: 900,
      user: SAMPLE_USER,
    }

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const request = asRequest(input)
      const pathname = new URL(request.url).pathname

      if (pathname === '/api/auth/refresh') {
        return jsonResponse({ detail: '会话已失效，请重新登录' }, 401)
      }
      if (pathname === '/api/auth/register' && request.method === 'POST') {
        registerPayload = JSON.parse(await request.clone().text())
        return jsonResponse(tokenResponse, 201)
      }
      return jsonResponse({ detail: 'unexpected' }, 500)
    })

    renderAuthRoute('/login')

    const emailInput = await screen.findByLabelText('邮箱')
    fireEvent.click(screen.getByRole('tab', { name: '注册' }))

    const nameInput = screen.getByLabelText('昵称')
    const passwordInput = screen.getByLabelText('密码')

    fireEvent.change(emailInput, { target: { value: 'newbie@example.com' } })
    fireEvent.change(nameInput, { target: { value: '巴菲特学徒' } })
    fireEvent.change(passwordInput, { target: { value: 'strongpass123' } })

    fireEvent.click(screen.getByRole('button', { name: '立即注册' }))

    expect(await screen.findByText('我的页面已跳转')).toBeInTheDocument()
    expect(registerPayload).toEqual({
      email: 'newbie@example.com',
      display_name: '巴菲特学徒',
      password: 'strongpass123',
    })
  })

  it('displays backend 409 error when registering an existing email', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const request = asRequest(input)
      const pathname = new URL(request.url).pathname

      if (pathname === '/api/auth/refresh') {
        return Promise.resolve(jsonResponse({ detail: '未登录' }, 401))
      }
      if (pathname === '/api/auth/register') {
        return Promise.resolve(jsonResponse({ detail: '该邮箱已注册' }, 409))
      }
      return Promise.resolve(jsonResponse({ detail: 'unexpected' }, 500))
    })

    renderAuthRoute('/register')

    fireEvent.change(await screen.findByLabelText('邮箱'), {
      target: { value: 'dup@example.com' },
    })
    fireEvent.change(screen.getByLabelText('昵称'), { target: { value: '老用户' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'password123' } })
    fireEvent.click(screen.getByRole('button', { name: '立即注册' }))

    expect(await screen.findByText('注册失败')).toBeInTheDocument()
    expect(screen.getByText('该邮箱已注册')).toBeInTheDocument()
  })

  it('displays backend 401 error on invalid login credentials', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const request = asRequest(input)
      const pathname = new URL(request.url).pathname

      if (pathname === '/api/auth/refresh') {
        return Promise.resolve(jsonResponse({ detail: '未登录' }, 401))
      }
      if (pathname === '/api/auth/login') {
        return Promise.resolve(jsonResponse({ detail: '邮箱或密码错误' }, 401))
      }
      return Promise.resolve(jsonResponse({ detail: 'unexpected' }, 500))
    })

    renderAuthRoute('/login')

    fireEvent.change(await screen.findByLabelText('邮箱'), {
      target: { value: 'investor@example.com' },
    })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'wrongpass' } })
    fireEvent.click(screen.getByRole('button', { name: '立即登录' }))

    expect(await screen.findByText('登录失败')).toBeInTheDocument()
    expect(screen.getByText('邮箱或密码错误')).toBeInTheDocument()
  })

  it('cancels slow bootstrapSession so login user state is never clobbered', async () => {
    let resolveBootstrapMe: ((res: Response) => void) | undefined
    const bootstrapMePromise = new Promise<Response>((resolve) => {
      resolveBootstrapMe = resolve
    })

    const oldUser: UserProfile = { ...SAMPLE_USER, email: 'stale@example.com' }
    const freshUser: UserProfile = { ...SAMPLE_USER, email: 'fresh@example.com' }
    const freshToken: TokenResponse = {
      access_token: 'fresh-login-token',
      token_type: 'bearer',
      expires_in: 900,
      user: freshUser,
    }

    setAccessToken('initial-stale-token')

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const request = asRequest(input)
      const pathname = new URL(request.url).pathname

      if (pathname === '/api/auth/me') {
        return bootstrapMePromise
      }
      if (pathname === '/api/auth/login') {
        return Promise.resolve(jsonResponse(freshToken, 200))
      }
      return Promise.resolve(jsonResponse({ detail: 'unexpected' }, 500))
    })

    function AuthProbe() {
      const { user, login } = useAuth()
      return (
        <div>
          <span data-testid="auth-user">{user ? user.email : 'none'}</span>
          <button
            type="button"
            onClick={() => {
              void login({ email: 'fresh@example.com', password: 'password123' })
            }}
          >
            切换登录
          </button>
        </div>
      )
    }

    const client = createQueryClient({
      defaultOptions: { queries: { retry: false } },
    })

    render(
      <QueryClientProvider client={client}>
        <AuthProvider>
          <AuthProbe />
        </AuthProvider>
      </QueryClientProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: '切换登录' }))

    await waitFor(() => {
      expect(screen.getByTestId('auth-user')).toHaveTextContent('fresh@example.com')
    })

    if (!resolveBootstrapMe) {
      throw new Error('Expected /api/auth/me resolver')
    }
    resolveBootstrapMe(jsonResponse(oldUser, 200))

    await Promise.resolve()
    await Promise.resolve()
    expect(screen.getByTestId('auth-user')).toHaveTextContent('fresh@example.com')
  })

  it('redirects via ?redirect= query param or location.state.from and rejects external URLs', async () => {
    const tokenResponse: TokenResponse = {
      access_token: 'redirect-token',
      token_type: 'bearer',
      expires_in: 900,
      user: SAMPLE_USER,
    }

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const request = asRequest(input)
      const pathname = new URL(request.url).pathname

      if (pathname === '/api/auth/refresh') {
        return Promise.resolve(jsonResponse({ detail: '未登录' }, 401))
      }
      if (pathname === '/api/auth/login') {
        return Promise.resolve(jsonResponse(tokenResponse, 200))
      }
      return Promise.resolve(jsonResponse({ detail: 'unexpected' }, 500))
    })

    const queryView = renderAuthRoute('/login?redirect=%2Fstock%2F600519')
    fireEvent.change(await screen.findByLabelText('邮箱'), {
      target: { value: 'investor@example.com' },
    })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'password123' } })
    fireEvent.click(screen.getByRole('button', { name: '立即登录' }))
    expect(await screen.findByText('个股目标页已跳转')).toBeInTheDocument()
    queryView.unmount()
    setAccessToken(null)

    const protocolRelativeView = renderAuthRoute('/login?redirect=//evil.com')
    fireEvent.change(await screen.findByLabelText('邮箱'), {
      target: { value: 'investor@example.com' },
    })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'password123' } })
    fireEvent.click(screen.getByRole('button', { name: '立即登录' }))
    expect(await screen.findByText('我的页面已跳转')).toBeInTheDocument()
    protocolRelativeView.unmount()
    setAccessToken(null)

    const externalUrlView = renderAuthRoute('/login?redirect=https://evil.com')
    fireEvent.change(await screen.findByLabelText('邮箱'), {
      target: { value: 'investor@example.com' },
    })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'password123' } })
    fireEvent.click(screen.getByRole('button', { name: '立即登录' }))
    expect(await screen.findByText('我的页面已跳转')).toBeInTheDocument()
    externalUrlView.unmount()
    setAccessToken(null)

    renderAuthRoute({ pathname: '/login', state: { from: '/stock/600036' } })
    fireEvent.change(await screen.findByLabelText('邮箱'), {
      target: { value: 'investor@example.com' },
    })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'password123' } })
    fireEvent.click(screen.getByRole('button', { name: '立即登录' }))
    expect(await screen.findByText('个股目标页已跳转')).toBeInTheDocument()
  })
})
