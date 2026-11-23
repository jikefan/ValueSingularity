import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthProvider } from '../../lib/AuthProvider'
import { useAuth } from '../../lib/authContext'
import { setAccessToken } from '../../lib/api'
import { createQueryClient } from '../../lib/queryClient'
import type {
  AuthConfigResponse,
  EmailCodeSendResponse,
  TokenResponse,
  UserProfile,
} from '../../types/api'
import { AuthPage } from './AuthPage'

const SAMPLE_USER: UserProfile = {
  id: '11111111-1111-1111-1111-111111111111',
  email: 'newbie@example.com',
  phone: null,
  display_name: '巴菲特学徒',
  email_verified: true,
  plan_tier: 'free',
  plan_expires_at: null,
  created_at: '2026-11-22T00:00:00Z',
}

const DEFAULT_CONFIG: AuthConfigResponse = {
  email_verification_required: false,
  smtp_configured: false,
  code_ttl_minutes: 10,
  code_cooldown_seconds: 60,
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

function LocationProbe() {
  const loc = useLocation()
  return <span data-testid="location-probe">{`${loc.pathname}${loc.search}`}</span>
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
          <LocationProbe />
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
    vi.useRealTimers()
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

      if (pathname === '/api/auth/config') {
        return jsonResponse(DEFAULT_CONFIG, 200)
      }
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

      if (pathname === '/api/auth/config') {
        return Promise.resolve(jsonResponse(DEFAULT_CONFIG, 200))
      }
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

      if (pathname === '/api/auth/config') {
        return Promise.resolve(jsonResponse(DEFAULT_CONFIG, 200))
      }
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

      if (pathname === '/api/auth/config') {
        return Promise.resolve(jsonResponse(DEFAULT_CONFIG, 200))
      }
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

  it('fails closed while auth/config is pending or errored on Register, omits config warning on Reset, recovers on retry, and handles 409/429/503 + countdown', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })

    let configCalls = 0
    let sendCodeCalls = 0
    let registerPayload: unknown = null
    let resolvePendingConfig!: (res: Response) => void
    const pendingConfigPromise = new Promise<Response>((resolve) => {
      resolvePendingConfig = resolve
    })

    const verifiedConfig: AuthConfigResponse = {
      email_verification_required: true,
      smtp_configured: true,
      code_ttl_minutes: 10,
      code_cooldown_seconds: 60,
    }
    const sendSuccess: EmailCodeSendResponse = {
      sent: true,
      expires_in_seconds: 600,
      cooldown_seconds: 60,
      message: '验证码已发送至您的邮箱，请注意查收',
    }
    const tokenResponse: TokenResponse = {
      access_token: 'verified-reg-token',
      token_type: 'bearer',
      expires_in: 900,
      user: SAMPLE_USER,
    }

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const request = asRequest(input)
      const pathname = new URL(request.url).pathname

      if (pathname === '/api/auth/refresh') {
        return jsonResponse({ detail: '未登录' }, 401)
      }
      if (pathname === '/api/auth/config') {
        configCalls += 1
        if (configCalls === 1) {
          return pendingConfigPromise
        }
        return jsonResponse(verifiedConfig, 200)
      }
      if (pathname === '/api/auth/email-codes' && request.method === 'POST') {
        sendCodeCalls += 1
        if (sendCodeCalls === 1) {
          return jsonResponse({ detail: '该邮箱已注册' }, 409)
        }
        if (sendCodeCalls === 2) {
          return jsonResponse({ detail: '发送过于频繁，请在 35 秒后再试' }, 429)
        }
        if (sendCodeCalls === 3) {
          return jsonResponse({ detail: '邮件网关暂不可用' }, 503)
        }
        return jsonResponse(sendSuccess, 200)
      }
      if (pathname === '/api/auth/register' && request.method === 'POST') {
        registerPayload = JSON.parse(await request.clone().text())
        return jsonResponse(tokenResponse, 201)
      }
      return jsonResponse({ detail: 'unexpected' }, 500)
    })

    renderAuthRoute('/register')

    expect(await screen.findByText('正在加载邮箱安全配置...')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '立即注册' })).toBeDisabled()
    expect(screen.queryByLabelText('邮箱验证码')).not.toBeInTheDocument()

    resolvePendingConfig(jsonResponse({ detail: '配置服务暂不可用' }, 503))

    expect(await screen.findByText('邮箱安全配置加载失败，请重试后再注册')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '立即注册' })).toBeDisabled()
    expect(screen.queryByLabelText('邮箱验证码')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: '忘记密码' }))
    expect(screen.queryByText('邮箱安全配置加载失败，请重试后再注册')).not.toBeInTheDocument()
    expect(screen.queryByText('安全配置获取失败')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: '注册' }))
    fireEvent.click(await screen.findByRole('button', { name: '重试加载配置' }))
    const codeInput = await screen.findByLabelText('邮箱验证码')
    expect(codeInput).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '立即注册' })).not.toBeDisabled()

    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'newbie@example.com' } })
    fireEvent.change(screen.getByLabelText('昵称'), { target: { value: '巴菲特学徒' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'strongpass123' } })

    // 409 error on send code
    fireEvent.click(screen.getByRole('button', { name: '发送验证码' }))
    expect(await screen.findByText('该邮箱已注册')).toBeInTheDocument()

    // 429 error on send code
    fireEvent.click(screen.getByRole('button', { name: '发送验证码' }))
    expect(await screen.findByText('发送过于频繁，请在 35 秒后再试')).toBeInTheDocument()

    // 503 error on send code
    fireEvent.click(screen.getByRole('button', { name: '发送验证码' }))
    expect(await screen.findByText('邮件网关暂不可用')).toBeInTheDocument()

    // 200 success starts 60s countdown
    fireEvent.click(screen.getByRole('button', { name: '发送验证码' }))
    expect(await screen.findByText('验证码已发送至您的邮箱，请注意查收')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重新发送 (60s)' })).toBeDisabled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    expect(screen.getByRole('button', { name: '重新发送 (58s)' })).toBeDisabled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(58_000)
    })
    expect(screen.getByRole('button', { name: '发送验证码' })).not.toBeDisabled()

    // Client-side validation rejects non-6-digit code
    fireEvent.change(codeInput, { target: { value: '123' } })
    fireEvent.click(screen.getByRole('button', { name: '立即注册' }))
    expect(await screen.findByText('请输入 6 位数字邮箱验证码')).toBeInTheDocument()

    fireEvent.change(codeInput, { target: { value: '654321' } })
    fireEvent.click(screen.getByRole('button', { name: '立即注册' }))

    expect(await screen.findByText('我的页面已跳转')).toBeInTheDocument()
    expect(registerPayload).toEqual({
      email: 'newbie@example.com',
      display_name: '巴菲特学徒',
      password: 'strongpass123',
      verification_code: '654321',
    })
  })

  it('supports optional verification code when smtp_configured is true and email_verification_required is false', async () => {
    const payloads: unknown[] = []
    const optionalConfig: AuthConfigResponse = {
      email_verification_required: false,
      smtp_configured: true,
      code_ttl_minutes: 10,
      code_cooldown_seconds: 60,
    }
    const tokenResponse: TokenResponse = {
      access_token: 'optional-reg-token',
      token_type: 'bearer',
      expires_in: 900,
      user: SAMPLE_USER,
    }

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const request = asRequest(input)
      const pathname = new URL(request.url).pathname
      if (pathname === '/api/auth/refresh') {
        return jsonResponse({ detail: '未登录' }, 401)
      }
      if (pathname === '/api/auth/config') {
        return jsonResponse(optionalConfig, 200)
      }
      if (pathname === '/api/auth/register' && request.method === 'POST') {
        payloads.push(JSON.parse(await request.clone().text()))
        return jsonResponse(tokenResponse, 201)
      }
      return jsonResponse({ detail: 'unexpected' }, 500)
    })

    renderAuthRoute('/register')

    expect(await screen.findByLabelText('邮箱验证码')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'newbie@example.com' } })
    fireEvent.change(screen.getByLabelText('昵称'), { target: { value: '巴菲特学徒' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'strongpass123' } })
    fireEvent.click(screen.getByRole('button', { name: '立即注册' }))

    expect(await screen.findByText('我的页面已跳转')).toBeInTheDocument()
    expect(payloads[0]).toEqual({
      email: 'newbie@example.com',
      display_name: '巴菲特学徒',
      password: 'strongpass123',
    })
  })

  it('supports password reset via ?mode=reset and inline link, validates inputs, and returns to login with green notice and prefilled email', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })

    let resetPayload: unknown = null
    let loginPayload: unknown = null
    const sendSuccess: EmailCodeSendResponse = {
      sent: true,
      expires_in_seconds: 600,
      cooldown_seconds: 60,
      message: '若该邮箱已注册且可用，验证码已发送至您的邮箱，请注意查收',
    }
    const tokenResponse: TokenResponse = {
      access_token: 'after-reset-token',
      token_type: 'bearer',
      expires_in: 900,
      user: SAMPLE_USER,
    }

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const request = asRequest(input)
      const pathname = new URL(request.url).pathname
      if (pathname === '/api/auth/refresh') {
        return jsonResponse({ detail: '未登录' }, 401)
      }
      if (pathname === '/api/auth/config') {
        return jsonResponse({ ...DEFAULT_CONFIG, smtp_configured: true }, 200)
      }
      if (pathname === '/api/auth/email-codes' && request.method === 'POST') {
        return jsonResponse(sendSuccess, 200)
      }
      if (pathname === '/api/auth/password/reset' && request.method === 'POST') {
        resetPayload = JSON.parse(await request.clone().text())
        return new Response(null, { status: 204 })
      }
      if (pathname === '/api/auth/login' && request.method === 'POST') {
        loginPayload = JSON.parse(await request.clone().text())
        return jsonResponse(tokenResponse, 200)
      }
      return jsonResponse({ detail: 'unexpected' }, 500)
    })

    // First verify ?mode=reset opens reset tab directly
    const resetQueryView = renderAuthRoute('/login?mode=reset')
    expect(await screen.findByRole('tab', { name: '忘记密码' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    expect(screen.getByRole('button', { name: '发送重置验证码' })).toBeInTheDocument()
    resetQueryView.unmount()

    // Now navigate from Login inline "忘记密码？" button
    renderAuthRoute('/login')
    fireEvent.click(await screen.findByRole('button', { name: '忘记密码？' }))
    expect(screen.getByRole('tab', { name: '忘记密码' })).toHaveAttribute('aria-selected', 'true')

    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'investor@example.com' } })
    fireEvent.click(screen.getByRole('button', { name: '发送重置验证码' }))

    expect(
      await screen.findByText('若该邮箱已注册，验证码已发送至收件箱，10 分钟内有效'),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重新发送 (60s)' })).toBeDisabled()

    fireEvent.change(screen.getByLabelText('邮箱验证码'), { target: { value: '888999' } })
    fireEvent.change(screen.getByLabelText('新密码'), { target: { value: 'short' } })
    fireEvent.change(screen.getByLabelText('确认新密码'), { target: { value: 'short' } })
    fireEvent.click(screen.getByRole('button', { name: '重置密码' }))
    expect(await screen.findByText('新密码至少需要 8 位')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('新密码'), { target: { value: 'newstrongpass123' } })
    fireEvent.change(screen.getByLabelText('确认新密码'), { target: { value: 'mismatch123' } })
    fireEvent.click(screen.getByRole('button', { name: '重置密码' }))
    expect(await screen.findByText('两次输入的新密码不一致')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('确认新密码'), {
      target: { value: 'newstrongpass123' },
    })
    fireEvent.click(screen.getByRole('button', { name: '重置密码' }))

    expect(await screen.findByText('密码重置成功，请使用新密码登录')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveClass('notice-success')
    expect(screen.getByRole('tab', { name: '登录' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByLabelText('邮箱')).toHaveValue('investor@example.com')
    expect(resetPayload).toEqual({
      email: 'investor@example.com',
      verification_code: '888999',
      new_password: 'newstrongpass123',
    })

    // Clicking active 登录 tab preserves confirmation notice
    fireEvent.click(screen.getByRole('tab', { name: '登录' }))
    expect(screen.getByText('密码重置成功，请使用新密码登录')).toBeInTheDocument()

    // Complete login with the new password
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'newstrongpass123' } })
    fireEvent.click(screen.getByRole('button', { name: '立即登录' }))
    expect(await screen.findByText('我的页面已跳转')).toBeInTheDocument()
    expect(loginPayload).toEqual({
      email: 'investor@example.com',
      password: 'newstrongpass123',
    })
  })

  it('enforces client validation parity (email format, >128 password, >64 display_name) across login/register/reset without network calls', async () => {
    let authSubmitCalls = 0

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const request = asRequest(input)
      const pathname = new URL(request.url).pathname
      if (pathname === '/api/auth/refresh') {
        return Promise.resolve(jsonResponse({ detail: '未登录' }, 401))
      }
      if (pathname === '/api/auth/config') {
        return Promise.resolve(jsonResponse(DEFAULT_CONFIG, 200))
      }
      authSubmitCalls += 1
      return Promise.resolve(jsonResponse({ detail: 'unexpected' }, 500))
    })

    renderAuthRoute('/login')
    const emailInput = await screen.findByLabelText('邮箱')
    const loginPasswordInput = screen.getByLabelText('密码')
    expect(loginPasswordInput).toHaveAttribute('maxLength', '128')

    fireEvent.change(emailInput, { target: { value: 'not-an-email' } })
    fireEvent.change(loginPasswordInput, { target: { value: 'validpass123' } })
    fireEvent.click(screen.getByRole('button', { name: '立即登录' }))
    expect(await screen.findByText('请输入有效的邮箱地址')).toBeInTheDocument()

    fireEvent.change(emailInput, { target: { value: 'investor@example.com' } })
    fireEvent.change(loginPasswordInput, { target: { value: 'p'.repeat(129) } })
    fireEvent.click(screen.getByRole('button', { name: '立即登录' }))
    expect(await screen.findByText('密码长度不能超过 128 位')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: '注册' }))
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'bad-register-email' } })
    fireEvent.change(screen.getByLabelText('昵称'), { target: { value: '昵称' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'strongpass123' } })
    fireEvent.click(screen.getByRole('button', { name: '立即注册' }))
    expect(await screen.findByText('请输入有效的邮箱地址')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'valid@example.com' } })
    fireEvent.change(screen.getByLabelText('昵称'), { target: { value: '名'.repeat(65) } })
    fireEvent.click(screen.getByRole('button', { name: '立即注册' }))
    expect(await screen.findByText('昵称不能超过 64 个字符')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('昵称'), { target: { value: '价值投资者' } })
    const regPasswordInput = screen.getByLabelText('密码')
    expect(regPasswordInput).toHaveAttribute('maxLength', '128')
    fireEvent.change(regPasswordInput, { target: { value: 'p'.repeat(129) } })
    fireEvent.click(screen.getByRole('button', { name: '立即注册' }))
    expect(await screen.findByText('密码长度不能超过 128 位')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: '忘记密码' }))
    const resetNewInput = screen.getByLabelText('新密码')
    const resetConfirmInput = screen.getByLabelText('确认新密码')
    expect(resetNewInput).toHaveAttribute('maxLength', '128')
    expect(resetConfirmInput).toHaveAttribute('maxLength', '128')

    fireEvent.change(screen.getByLabelText('邮箱验证码'), { target: { value: '123456' } })
    fireEvent.change(resetNewInput, { target: { value: 'p'.repeat(129) } })
    fireEvent.change(resetConfirmInput, { target: { value: 'p'.repeat(129) } })
    fireEvent.click(screen.getByRole('button', { name: '重置密码' }))
    expect(await screen.findByText('新密码长度不能超过 128 位')).toBeInTheDocument()

    expect(authSubmitCalls).toBe(0)
  })

  it('resets verification notice and countdown when editing email away from lastSentEmail, syncs ?mode=reset with URL, supports WAI-ARIA keyboard tabs, disables tabs while busy, and links logged-in redirectTo', async () => {
    const sendCalls: Array<{ email: string; purpose: string }> = []
    let resolveLogin!: (res: Response) => void
    const loginPromise = new Promise<Response>((resolve) => {
      resolveLogin = resolve
    })
    let isLoggedInMock = false

    const sendSuccess: EmailCodeSendResponse = {
      sent: true,
      expires_in_seconds: 600,
      cooldown_seconds: 60,
      message: '验证码已发送至您的邮箱，请注意查收',
    }
    const tokenResponse: TokenResponse = {
      access_token: 'sync-token',
      token_type: 'bearer',
      expires_in: 900,
      user: SAMPLE_USER,
    }

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const request = asRequest(input)
      const pathname = new URL(request.url).pathname
      if (pathname === '/api/auth/refresh') {
        return isLoggedInMock
          ? jsonResponse(tokenResponse, 200)
          : jsonResponse({ detail: '未登录' }, 401)
      }
      if (pathname === '/api/auth/config') {
        return jsonResponse(
          { ...DEFAULT_CONFIG, email_verification_required: true, smtp_configured: true },
          200,
        )
      }
      if (pathname === '/api/auth/email-codes' && request.method === 'POST') {
        const parsed = JSON.parse(await request.clone().text()) as {
          email: string
          purpose: string
        }
        sendCalls.push(parsed)
        return jsonResponse(sendSuccess, 200)
      }
      if (pathname === '/api/auth/password/reset' && request.method === 'POST') {
        return new Response(null, { status: 204 })
      }
      if (pathname === '/api/auth/login' && request.method === 'POST') {
        return loginPromise
      }
      return jsonResponse({ detail: 'unexpected' }, 500)
    })

    const view1 = renderAuthRoute('/login?mode=reset&redirect=%2Fstock%2F600519')

    const loginTab = await screen.findByRole('tab', { name: '登录' })
    const registerTab = screen.getByRole('tab', { name: '注册' })
    const resetTab = screen.getByRole('tab', { name: '忘记密码' })

    expect(loginTab).toHaveAttribute('id', 'auth-tab-login')
    expect(loginTab).toHaveAttribute('aria-controls', 'auth-tabpanel-login')
    expect(registerTab).toHaveAttribute('id', 'auth-tab-register')
    expect(registerTab).toHaveAttribute('aria-controls', 'auth-tabpanel-register')
    expect(resetTab).toHaveAttribute('id', 'auth-tab-reset')
    expect(resetTab).toHaveAttribute('aria-controls', 'auth-tabpanel-reset')
    expect(resetTab).toHaveAttribute('tabindex', '0')
    expect(loginTab).toHaveAttribute('tabindex', '-1')
    expect(screen.getByRole('tabpanel')).toHaveAttribute('id', 'auth-tabpanel-reset')
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'auth-tab-reset')

    resetTab.focus()
    fireEvent.keyDown(resetTab, { key: 'ArrowLeft' })
    expect(registerTab).toHaveAttribute('aria-selected', 'true')
    expect(registerTab).toHaveAttribute('tabindex', '0')
    expect(registerTab).toHaveFocus()
    expect(screen.getByTestId('location-probe')).toHaveTextContent(
      '/login?mode=register&redirect=%2Fstock%2F600519',
    )

    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'typo@example.com' } })
    fireEvent.click(screen.getByRole('button', { name: '发送验证码' }))
    expect(await screen.findByText('验证码已发送至您的邮箱，请注意查收')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重新发送 (60s)' })).toBeDisabled()

    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'fixed@example.com' } })
    expect(screen.queryByText('验证码已发送至您的邮箱，请注意查收')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '发送验证码' })).not.toBeDisabled()

    fireEvent.keyDown(registerTab, { key: 'ArrowRight' })
    expect(resetTab).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('location-probe')).toHaveTextContent(
      '/login?mode=reset&redirect=%2Fstock%2F600519',
    )

    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'reset-typo@example.com' } })
    fireEvent.click(screen.getByRole('button', { name: '发送重置验证码' }))
    expect(
      await screen.findByText('若该邮箱已注册，验证码已发送至收件箱，10 分钟内有效'),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重新发送 (60s)' })).toBeDisabled()

    fireEvent.change(screen.getByLabelText('邮箱'), {
      target: { value: 'reset-fixed@example.com' },
    })
    expect(
      screen.queryByText('若该邮箱已注册，验证码已发送至收件箱，10 分钟内有效'),
    ).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '发送重置验证码' })).not.toBeDisabled()

    fireEvent.change(screen.getByLabelText('邮箱验证码'), { target: { value: '112233' } })
    fireEvent.change(screen.getByLabelText('新密码'), { target: { value: 'newstrongpass123' } })
    fireEvent.change(screen.getByLabelText('确认新密码'), { target: { value: 'newstrongpass123' } })
    fireEvent.click(screen.getByRole('button', { name: '重置密码' }))

    expect(await screen.findByText('密码重置成功，请使用新密码登录')).toBeInTheDocument()
    expect(screen.getByTestId('location-probe')).toHaveTextContent(
      '/login?redirect=%2Fstock%2F600519',
    )

    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'newstrongpass123' } })
    fireEvent.click(screen.getByRole('button', { name: '立即登录' }))
    expect(screen.getByRole('tab', { name: '注册' })).toBeDisabled()
    expect(screen.getByRole('tab', { name: '忘记密码' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '忘记密码？' })).toBeDisabled()

    resolveLogin(jsonResponse(tokenResponse, 200))
    expect(await screen.findByText('个股目标页已跳转')).toBeInTheDocument()
    expect(sendCalls).toEqual([
      { email: 'typo@example.com', purpose: 'register' },
      { email: 'reset-typo@example.com', purpose: 'reset_password' },
    ])
    view1.unmount()
    setAccessToken(null)

    isLoggedInMock = true
    renderAuthRoute('/login?redirect=%2Fstock%2F600519')
    const continueLink = await screen.findByRole('link', { name: '继续前往目标页面' })
    expect(continueLink).toHaveAttribute('href', '/stock/600519')
    expect(screen.getByText('newbie@example.com')).toHaveClass('wrap-anywhere')
  })

  it('displays 400/429/503 errors on resetPassword without losing input state', async () => {
    let resetAttempt = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const request = asRequest(input)
      const pathname = new URL(request.url).pathname
      if (pathname === '/api/auth/refresh') {
        return Promise.resolve(jsonResponse({ detail: '未登录' }, 401))
      }
      if (pathname === '/api/auth/config') {
        return Promise.resolve(jsonResponse({ ...DEFAULT_CONFIG, smtp_configured: true }, 200))
      }
      if (pathname === '/api/auth/password/reset') {
        resetAttempt += 1
        if (resetAttempt === 1) {
          return Promise.resolve(jsonResponse({ detail: '验证码错误或已过期' }, 400))
        }
        if (resetAttempt === 2) {
          return Promise.resolve(jsonResponse({ detail: '尝试过于频繁，请稍后再试' }, 429))
        }
        return Promise.resolve(jsonResponse({ detail: '认证服务暂不可用' }, 503))
      }
      return Promise.resolve(jsonResponse({ detail: 'unexpected' }, 500))
    })

    renderAuthRoute('/login?mode=reset')
    fireEvent.change(await screen.findByLabelText('邮箱'), {
      target: { value: 'investor@example.com' },
    })
    fireEvent.change(screen.getByLabelText('邮箱验证码'), { target: { value: '123456' } })
    fireEvent.change(screen.getByLabelText('新密码'), { target: { value: 'newstrongpass123' } })
    fireEvent.change(screen.getByLabelText('确认新密码'), { target: { value: 'newstrongpass123' } })

    fireEvent.click(screen.getByRole('button', { name: '重置密码' }))
    expect(await screen.findByText('验证码错误或已过期')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '重置密码' }))
    expect(await screen.findByText('尝试过于频繁，请稍后再试')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '重置密码' }))
    expect(await screen.findByText('认证服务暂不可用')).toBeInTheDocument()
  })

  it('clears password and verificationCode after login or register success', async () => {
    const tokenResponse: TokenResponse = {
      access_token: 'clear-state-token',
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
      if (pathname === '/api/auth/config') {
        return Promise.resolve(
          jsonResponse(
            { ...DEFAULT_CONFIG, email_verification_required: true, smtp_configured: true },
            200,
          ),
        )
      }
      if (pathname === '/api/auth/login' || pathname === '/api/auth/register') {
        return Promise.resolve(jsonResponse(tokenResponse, 200))
      }
      if (pathname === '/api/auth/logout') {
        return Promise.resolve(new Response(null, { status: 204 }))
      }
      return Promise.resolve(jsonResponse({ detail: 'unexpected' }, 500))
    })

    function LogoutButton() {
      const { user, logout } = useAuth()
      if (!user) {
        return null
      }
      return (
        <button
          type="button"
          onClick={() => {
            void logout()
          }}
        >
          退出测试会话
        </button>
      )
    }

    const client1 = createQueryClient({ defaultOptions: { queries: { retry: false } } })
    const loginView = render(
      <QueryClientProvider client={client1}>
        <AuthProvider>
          <MemoryRouter initialEntries={['/login?redirect=%2Flogin']}>
            <LogoutButton />
            <Routes>
              <Route path="/login" element={<AuthPage />} />
            </Routes>
          </MemoryRouter>
        </AuthProvider>
      </QueryClientProvider>,
    )

    fireEvent.change(await screen.findByLabelText('邮箱'), {
      target: { value: 'investor@example.com' },
    })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secretpass123' } })
    fireEvent.click(screen.getByRole('button', { name: '立即登录' }))

    expect(await screen.findByText('已登录')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '退出测试会话' }))

    expect(await screen.findByLabelText('密码')).toHaveValue('')
    loginView.unmount()
    setAccessToken(null)

    const client2 = createQueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client2}>
        <AuthProvider>
          <MemoryRouter initialEntries={['/register?redirect=%2Fregister']}>
            <LogoutButton />
            <Routes>
              <Route path="/register" element={<AuthPage initialMode="register" />} />
            </Routes>
          </MemoryRouter>
        </AuthProvider>
      </QueryClientProvider>,
    )

    fireEvent.change(await screen.findByLabelText('邮箱'), {
      target: { value: 'newbie@example.com' },
    })
    fireEvent.change(screen.getByLabelText('昵称'), { target: { value: '新用户' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secretpass123' } })
    fireEvent.change(screen.getByLabelText('邮箱验证码'), { target: { value: '654321' } })
    fireEvent.click(screen.getByRole('button', { name: '立即注册' }))

    expect(await screen.findByText('已登录')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '退出测试会话' }))

    expect(await screen.findByLabelText('密码')).toHaveValue('')
    expect(screen.getByLabelText('邮箱验证码')).toHaveValue('')
  })
})
