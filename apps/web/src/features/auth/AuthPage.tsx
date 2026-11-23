import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { Card } from '../../components/ui/Card'
import { ErrorBlock, LoadingBlock } from '../../components/ui/StateBlock'
import { Tag } from '../../components/ui/Tag'
import { api } from '../../lib/api'
import { useAuth } from '../../lib/authContext'
import { useAuthConfig } from '../../lib/useAuthConfig'
import { useCooldown } from '../../lib/useCooldown'
import { isSixDigitCode, isValidEmailFormat } from '../../lib/validation'
import type { PlanTier } from '../../types/api'

type AuthMode = 'login' | 'register' | 'reset'

const AUTH_MODES: readonly AuthMode[] = ['login', 'register', 'reset']

const PLAN_COLOR: Record<PlanTier, 'gray' | 'blue' | 'green'> = {
  free: 'gray',
  pro: 'blue',
  ai_plus: 'green',
}

const MODE_META: Record<AuthMode, { tabLabel: string; cardTitle: string; errorTitle: string }> = {
  login: { tabLabel: '登录', cardTitle: '账号登录', errorTitle: '登录失败' },
  register: { tabLabel: '注册', cardTitle: '创建账号', errorTitle: '注册失败' },
  reset: { tabLabel: '忘记密码', cardTitle: '重置密码', errorTitle: '重置失败' },
}

function isSafeLocalRedirect(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//')
}

function extractRedirectPath(state: unknown, search: string): string {
  if (state !== null && typeof state === 'object' && 'from' in state) {
    const from = state.from
    if (isSafeLocalRedirect(from)) {
      return from
    }
    if (
      from !== null &&
      typeof from === 'object' &&
      'pathname' in from &&
      isSafeLocalRedirect(from.pathname)
    ) {
      return from.pathname
    }
  }
  const queryRedirect = new URLSearchParams(search).get('redirect')
  if (isSafeLocalRedirect(queryRedirect)) {
    return queryRedirect
  }
  return '/me'
}

function resolveRouteMode(initialMode: AuthMode, searchParams: URLSearchParams): AuthMode {
  const queryMode = searchParams.get('mode')
  if (queryMode === 'login' || queryMode === 'register' || queryMode === 'reset') {
    return queryMode
  }
  return initialMode
}

export function AuthPage({ initialMode = 'login' }: { initialMode?: AuthMode }) {
  const { user, isAuthLoading, login, register } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()
  const redirectTo = extractRedirectPath(location.state, location.search)
  const mode = resolveRouteMode(initialMode, searchParams)
  const expectedModeRef = useRef<AuthMode>(mode)
  const tabRefs = useRef<Partial<Record<AuthMode, HTMLButtonElement | null>>>({})

  const authConfigQuery = useAuthConfig()
  const authConfig = authConfigQuery.data ?? null
  const isConfigLoading = authConfigQuery.isPending || (authConfigQuery.isFetching && !authConfig)
  const isConfigError = !isConfigLoading && authConfigQuery.isError && !authConfig

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [registerCode, setRegisterCode] = useState('')
  const [resetCode, setResetCode] = useState('')
  const [resetNewPassword, setResetNewPassword] = useState('')
  const [resetConfirmPassword, setResetConfirmPassword] = useState('')
  const [lastSentRegisterEmail, setLastSentRegisterEmail] = useState<string | null>(null)
  const [lastSentResetEmail, setLastSentResetEmail] = useState<string | null>(null)

  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [statusNotice, setStatusNotice] = useState<string | null>(null)
  const [registerCodeNotice, setRegisterCodeNotice] = useState<string | null>(null)
  const [resetCodeNotice, setResetCodeNotice] = useState<string | null>(null)
  const [sendingRegisterCode, setSendingRegisterCode] = useState(false)
  const [sendingResetCode, setSendingResetCode] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const registerCooldown = useCooldown()
  const resetCooldown = useCooldown()

  useEffect(() => {
    if (expectedModeRef.current !== mode) {
      expectedModeRef.current = mode
      setErrorMessage(null)
      setStatusNotice(null)
      setRegisterCodeNotice(null)
      setResetCodeNotice(null)
    }
  }, [mode])

  function switchMode(nextMode: AuthMode, nextStatusNotice: string | null = null) {
    if (nextMode === mode && nextStatusNotice === null) {
      return
    }
    expectedModeRef.current = nextMode
    setErrorMessage(null)
    setStatusNotice(nextStatusNotice)
    setRegisterCodeNotice(null)
    setResetCodeNotice(null)

    const nextParams = new URLSearchParams(searchParams)
    if (nextMode === initialMode) {
      nextParams.delete('mode')
    } else {
      nextParams.set('mode', nextMode)
    }
    const navState: unknown = location.state
    setSearchParams(nextParams, { replace: true, state: navState })
  }

  function handleEmailChange(nextEmail: string) {
    setEmail(nextEmail)
    setErrorMessage(null)
    setRegisterCodeNotice(null)
    setResetCodeNotice(null)
    const trimmedNext = nextEmail.trim()
    if (lastSentRegisterEmail !== null && trimmedNext !== lastSentRegisterEmail) {
      registerCooldown.reset()
      setLastSentRegisterEmail(null)
    }
    if (lastSentResetEmail !== null && trimmedNext !== lastSentResetEmail) {
      resetCooldown.reset()
      setLastSentResetEmail(null)
    }
  }

  const isBusy = submitting || sendingRegisterCode || sendingResetCode
  const isRegisterConfigBlocked = mode === 'register' && !authConfig

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, currentIndex: number) {
    if (isBusy) {
      return
    }
    let nextIndex: number | null = null
    if (event.key === 'ArrowRight') {
      nextIndex = (currentIndex + 1) % AUTH_MODES.length
    } else if (event.key === 'ArrowLeft') {
      nextIndex = (currentIndex - 1 + AUTH_MODES.length) % AUTH_MODES.length
    } else if (event.key === 'Home') {
      nextIndex = 0
    } else if (event.key === 'End') {
      nextIndex = AUTH_MODES.length - 1
    }
    if (nextIndex === null) {
      return
    }
    event.preventDefault()
    const nextMode = AUTH_MODES[nextIndex]
    if (!nextMode) {
      return
    }
    switchMode(nextMode)
    tabRefs.current[nextMode]?.focus()
  }

  async function handleSendRegisterCode() {
    if (sendingRegisterCode || registerCooldown.secondsLeft > 0 || submitting) {
      return
    }
    const trimmedEmail = email.trim()
    if (!trimmedEmail || !isValidEmailFormat(trimmedEmail)) {
      setErrorMessage('请输入有效的邮箱地址')
      return
    }
    setErrorMessage(null)
    setRegisterCodeNotice(null)
    setSendingRegisterCode(true)
    try {
      const res = await api.sendPublicEmailCode({ email: trimmedEmail, purpose: 'register' })
      registerCooldown.start(res.cooldown_seconds || authConfig?.code_cooldown_seconds || 60)
      setLastSentRegisterEmail(trimmedEmail)
      setRegisterCodeNotice(res.message || '验证码已发送至您的邮箱，请注意查收')
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : '验证码发送失败，请稍后重试')
    } finally {
      setSendingRegisterCode(false)
    }
  }

  async function handleSendResetCode() {
    if (sendingResetCode || resetCooldown.secondsLeft > 0 || submitting) {
      return
    }
    const trimmedEmail = email.trim()
    if (!trimmedEmail || !isValidEmailFormat(trimmedEmail)) {
      setErrorMessage('请输入有效的邮箱地址')
      return
    }
    setErrorMessage(null)
    setResetCodeNotice(null)
    setSendingResetCode(true)
    try {
      const res = await api.sendPublicEmailCode({ email: trimmedEmail, purpose: 'reset_password' })
      resetCooldown.start(res.cooldown_seconds || authConfig?.code_cooldown_seconds || 60)
      setLastSentResetEmail(trimmedEmail)
      const ttlMinutes = Math.max(1, Math.round(res.expires_in_seconds / 60))
      setResetCodeNotice(`若该邮箱已注册，验证码已发送至收件箱，${ttlMinutes} 分钟内有效`)
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : '重置验证码发送失败，请稍后重试')
    } finally {
      setSendingResetCode(false)
    }
  }

  async function handleSubmit() {
    if (submitting || isRegisterConfigBlocked) {
      return
    }
    const trimmedEmail = email.trim()
    const trimmedName = displayName.trim()
    const trimmedRegisterCode = registerCode.trim()
    const trimmedResetCode = resetCode.trim()

    if (!trimmedEmail) {
      setErrorMessage('请输入邮箱')
      return
    }
    if (!isValidEmailFormat(trimmedEmail)) {
      setErrorMessage('请输入有效的邮箱地址')
      return
    }

    if (mode === 'register') {
      if (!authConfig) {
        return
      }
      if (!trimmedName) {
        setErrorMessage('请输入昵称')
        return
      }
      if (trimmedName.length > 64) {
        setErrorMessage('昵称不能超过 64 个字符')
        return
      }
      if (password.length < 8) {
        setErrorMessage('密码至少需要 8 位')
        return
      }
      if (password.length > 128) {
        setErrorMessage('密码长度不能超过 128 位')
        return
      }
      if (authConfig.email_verification_required) {
        if (!isSixDigitCode(trimmedRegisterCode)) {
          setErrorMessage('请输入 6 位数字邮箱验证码')
          return
        }
      } else if (trimmedRegisterCode.length > 0 && !isSixDigitCode(trimmedRegisterCode)) {
        setErrorMessage('邮箱验证码须为 6 位数字')
        return
      }
    } else if (mode === 'reset') {
      if (!isSixDigitCode(trimmedResetCode)) {
        setErrorMessage('请输入 6 位数字验证码')
        return
      }
      if (resetNewPassword.length < 8) {
        setErrorMessage('新密码至少需要 8 位')
        return
      }
      if (resetNewPassword.length > 128) {
        setErrorMessage('新密码长度不能超过 128 位')
        return
      }
      if (resetNewPassword !== resetConfirmPassword) {
        setErrorMessage('两次输入的新密码不一致')
        return
      }
    } else {
      if (password.length === 0) {
        setErrorMessage('请输入密码')
        return
      }
      if (password.length > 128) {
        setErrorMessage('密码长度不能超过 128 位')
        return
      }
    }

    setErrorMessage(null)
    setStatusNotice(null)
    setSubmitting(true)
    try {
      if (mode === 'login') {
        await login({ email: trimmedEmail, password })
        setPassword('')
        void navigate(redirectTo, { replace: true })
      } else if (mode === 'register') {
        await register({
          email: trimmedEmail,
          password,
          display_name: trimmedName,
          ...(trimmedRegisterCode ? { verification_code: trimmedRegisterCode } : {}),
        })
        setPassword('')
        setRegisterCode('')
        setRegisterCodeNotice(null)
        setLastSentRegisterEmail(null)
        registerCooldown.reset()
        void navigate(redirectTo, { replace: true })
      } else {
        await api.resetPassword({
          email: trimmedEmail,
          verification_code: trimmedResetCode,
          new_password: resetNewPassword,
        })
        setEmail(trimmedEmail)
        setPassword('')
        setResetCode('')
        setResetNewPassword('')
        setResetConfirmPassword('')
        setResetCodeNotice(null)
        setLastSentResetEmail(null)
        resetCooldown.reset()
        switchMode('login', '密码重置成功，请使用新密码登录')
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : '请求失败，请稍后重试')
    } finally {
      setSubmitting(false)
    }
  }

  if (isAuthLoading) {
    return (
      <div className="container">
        <div className="auth-shell">
          <Card title="账号会话">
            <LoadingBlock lines={3} />
          </Card>
        </div>
      </div>
    )
  }

  if (user) {
    return (
      <div className="container">
        <div className="auth-shell">
          <Card
            title="已登录"
            extra={<Tag color={PLAN_COLOR[user.plan_tier]}>{user.plan_tier.toUpperCase()}</Tag>}
          >
            <div className="stack">
              <p className="soft wrap-anywhere">当前账号：{user.display_name}</p>
              {user.email ? <p className="small muted mono wrap-anywhere">{user.email}</p> : null}
              <Link className="btn-primary mt-8" to={redirectTo}>
                继续前往目标页面
              </Link>
            </div>
          </Card>
        </div>
      </div>
    )
  }

  const showRegisterCodeField =
    mode === 'register' &&
    authConfig !== null &&
    (authConfig.email_verification_required || authConfig.smtp_configured)
  const submitLabel =
    mode === 'login'
      ? submitting
        ? '登录中...'
        : '立即登录'
      : mode === 'register'
        ? submitting
          ? '注册中...'
          : '立即注册'
        : submitting
          ? '重置中...'
          : '重置密码'

  return (
    <div className="container">
      <div className="auth-shell">
        <Card title={MODE_META[mode].cardTitle} extra={<Tag color="blue">ValueSingularity</Tag>}>
          <div className="auth-tabs" role="tablist" aria-label="认证模式">
            {AUTH_MODES.map((tabMode, index) => {
              const isSelected = mode === tabMode
              return (
                <button
                  key={tabMode}
                  ref={(element) => {
                    tabRefs.current[tabMode] = element
                  }}
                  id={`auth-tab-${tabMode}`}
                  type="button"
                  role="tab"
                  aria-selected={isSelected}
                  aria-controls={`auth-tabpanel-${tabMode}`}
                  tabIndex={isSelected ? 0 : -1}
                  disabled={isBusy}
                  className={isSelected ? 'auth-tab active' : 'auth-tab'}
                  onClick={() => switchMode(tabMode)}
                  onKeyDown={(event) => handleTabKeyDown(event, index)}
                >
                  {MODE_META[tabMode].tabLabel}
                </button>
              )
            })}
          </div>

          <div role="tabpanel" id={`auth-tabpanel-${mode}`} aria-labelledby={`auth-tab-${mode}`}>
            <form
              className="stack"
              noValidate
              onSubmit={(event) => {
                event.preventDefault()
                void handleSubmit()
              }}
            >
              {mode === 'register' && isConfigLoading ? (
                <div className="notice-box" role="status">
                  正在加载邮箱安全配置...
                </div>
              ) : null}

              {mode === 'register' && isConfigError ? (
                <div className="inline-error row" style={{ flexWrap: 'wrap' }} role="alert">
                  <span className="small">邮箱安全配置加载失败，请重试后再注册</span>
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={() => {
                      void authConfigQuery.refetch()
                    }}
                  >
                    重试加载配置
                  </button>
                </div>
              ) : null}

              {mode === 'login' && statusNotice ? (
                <div className="notice-box notice-success" role="status">
                  {statusNotice}
                </div>
              ) : null}

              <div className="field">
                <label htmlFor="auth-email">邮箱</label>
                {mode === 'reset' ? (
                  <div className="input-action-row">
                    <input
                      id="auth-email"
                      className="input"
                      type="email"
                      autoComplete="email"
                      required
                      placeholder="investor@example.com"
                      value={email}
                      onChange={(event) => handleEmailChange(event.target.value)}
                    />
                    <button
                      type="button"
                      className="btn-ghost"
                      disabled={sendingResetCode || resetCooldown.secondsLeft > 0 || submitting}
                      onClick={() => {
                        void handleSendResetCode()
                      }}
                    >
                      {sendingResetCode
                        ? '发送中...'
                        : resetCooldown.secondsLeft > 0
                          ? `重新发送 (${resetCooldown.secondsLeft}s)`
                          : '发送重置验证码'}
                    </button>
                  </div>
                ) : (
                  <input
                    id="auth-email"
                    className="input"
                    type="email"
                    autoComplete="email"
                    required
                    placeholder="investor@example.com"
                    value={email}
                    onChange={(event) => handleEmailChange(event.target.value)}
                  />
                )}
              </div>

              {mode === 'reset' && resetCodeNotice ? (
                <div className="notice-box" role="status">
                  {resetCodeNotice}
                </div>
              ) : null}

              {mode === 'register' ? (
                <div className="field">
                  <label htmlFor="auth-display-name">昵称</label>
                  <input
                    id="auth-display-name"
                    className="input"
                    type="text"
                    autoComplete="nickname"
                    required
                    maxLength={64}
                    placeholder="怎么称呼你"
                    value={displayName}
                    onChange={(event) => {
                      setDisplayName(event.target.value)
                      setErrorMessage(null)
                    }}
                  />
                </div>
              ) : null}

              {mode === 'login' || mode === 'register' ? (
                <div className="field">
                  {mode === 'login' ? (
                    <div className="row">
                      <label htmlFor="auth-password">密码</label>
                      <button
                        type="button"
                        className="auth-link-btn"
                        disabled={isBusy}
                        onClick={() => switchMode('reset')}
                      >
                        忘记密码？
                      </button>
                    </div>
                  ) : (
                    <label htmlFor="auth-password">密码</label>
                  )}
                  <input
                    id="auth-password"
                    className="input"
                    type="password"
                    autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                    required
                    minLength={mode === 'register' ? 8 : 1}
                    maxLength={128}
                    placeholder={mode === 'register' ? '至少 8 位字符' : '请输入密码'}
                    value={password}
                    onChange={(event) => {
                      setPassword(event.target.value)
                      setErrorMessage(null)
                    }}
                  />
                </div>
              ) : null}

              {showRegisterCodeField ? (
                <div className="field">
                  <label htmlFor="auth-register-code">邮箱验证码</label>
                  <div className="input-action-row">
                    <input
                      id="auth-register-code"
                      className="input mono"
                      type="text"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      maxLength={6}
                      required={Boolean(authConfig?.email_verification_required)}
                      placeholder={
                        authConfig?.email_verification_required
                          ? '输入 6 位数字验证码'
                          : '6 位数字验证码（可选）'
                      }
                      value={registerCode}
                      onChange={(event) => {
                        setRegisterCode(event.target.value)
                        setErrorMessage(null)
                      }}
                    />
                    <button
                      type="button"
                      className="btn-ghost"
                      disabled={
                        sendingRegisterCode || registerCooldown.secondsLeft > 0 || submitting
                      }
                      onClick={() => {
                        void handleSendRegisterCode()
                      }}
                    >
                      {sendingRegisterCode
                        ? '发送中...'
                        : registerCooldown.secondsLeft > 0
                          ? `重新发送 (${registerCooldown.secondsLeft}s)`
                          : '发送验证码'}
                    </button>
                  </div>
                  {registerCodeNotice ? (
                    <div className="notice-box notice-success" role="status">
                      {registerCodeNotice}
                    </div>
                  ) : null}
                </div>
              ) : null}

              {mode === 'reset' ? (
                <>
                  <div className="field">
                    <label htmlFor="auth-reset-code">邮箱验证码</label>
                    <input
                      id="auth-reset-code"
                      className="input mono"
                      type="text"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      maxLength={6}
                      required
                      placeholder="输入 6 位数字验证码"
                      value={resetCode}
                      onChange={(event) => {
                        setResetCode(event.target.value)
                        setErrorMessage(null)
                      }}
                    />
                  </div>

                  <div className="field">
                    <label htmlFor="auth-reset-new-password">新密码</label>
                    <input
                      id="auth-reset-new-password"
                      className="input"
                      type="password"
                      autoComplete="new-password"
                      required
                      minLength={8}
                      maxLength={128}
                      placeholder="至少 8 位字符"
                      value={resetNewPassword}
                      onChange={(event) => {
                        setResetNewPassword(event.target.value)
                        setErrorMessage(null)
                      }}
                    />
                  </div>

                  <div className="field">
                    <label htmlFor="auth-reset-confirm-password">确认新密码</label>
                    <input
                      id="auth-reset-confirm-password"
                      className="input"
                      type="password"
                      autoComplete="new-password"
                      required
                      minLength={8}
                      maxLength={128}
                      placeholder="再次输入新密码"
                      value={resetConfirmPassword}
                      onChange={(event) => {
                        setResetConfirmPassword(event.target.value)
                        setErrorMessage(null)
                      }}
                    />
                  </div>
                </>
              ) : null}

              {errorMessage ? (
                <div className="inline-error" role="alert">
                  <ErrorBlock title={MODE_META[mode].errorTitle} message={errorMessage} />
                </div>
              ) : null}

              <button
                type="submit"
                className="btn-primary mt-8"
                disabled={submitting || isRegisterConfigBlocked}
              >
                {submitLabel}
              </button>
            </form>
          </div>
          {AUTH_MODES.filter((tabMode) => tabMode !== mode).map((inactiveMode) => (
            <div
              key={inactiveMode}
              role="tabpanel"
              id={`auth-tabpanel-${inactiveMode}`}
              aria-labelledby={`auth-tab-${inactiveMode}`}
              hidden
            />
          ))}
        </Card>
      </div>
    </div>
  )
}
