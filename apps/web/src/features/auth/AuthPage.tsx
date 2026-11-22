import { useEffect, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { Card } from '../../components/ui/Card'
import { ErrorBlock, LoadingBlock } from '../../components/ui/StateBlock'
import { Tag } from '../../components/ui/Tag'
import { useAuth } from '../../lib/authContext'
import type { PlanTier } from '../../types/api'

type AuthMode = 'login' | 'register'

const PLAN_COLOR: Record<PlanTier, 'gray' | 'blue' | 'green'> = {
  free: 'gray',
  pro: 'blue',
  ai_plus: 'green',
}

function extractRedirectPath(state: unknown): string {
  if (state !== null && typeof state === 'object' && 'from' in state) {
    const from = state.from
    if (typeof from === 'string' && from.startsWith('/')) {
      return from
    }
    if (
      from !== null &&
      typeof from === 'object' &&
      'pathname' in from &&
      typeof from.pathname === 'string' &&
      from.pathname.startsWith('/')
    ) {
      return from.pathname
    }
  }
  return '/me'
}

export function AuthPage({ initialMode = 'login' }: { initialMode?: AuthMode }) {
  const { user, isAuthLoading, login, register } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const redirectTo = extractRedirectPath(location.state)

  const [mode, setMode] = useState<AuthMode>(initialMode)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    setMode(initialMode)
    setErrorMessage(null)
  }, [initialMode])

  function switchMode(nextMode: AuthMode) {
    setMode(nextMode)
    setErrorMessage(null)
  }

  async function handleSubmit() {
    const trimmedEmail = email.trim()
    const trimmedName = displayName.trim()

    if (!trimmedEmail) {
      setErrorMessage('请输入邮箱')
      return
    }
    if (mode === 'register') {
      if (!trimmedName) {
        setErrorMessage('请输入昵称')
        return
      }
      if (password.length < 8) {
        setErrorMessage('密码至少需要 8 位')
        return
      }
    } else if (password.length === 0) {
      setErrorMessage('请输入密码')
      return
    }

    setErrorMessage(null)
    setSubmitting(true)
    try {
      if (mode === 'login') {
        await login({ email: trimmedEmail, password })
      } else {
        await register({
          email: trimmedEmail,
          password,
          display_name: trimmedName,
        })
      }
      void navigate(redirectTo, { replace: true })
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
              <p className="soft">当前账号：{user.display_name}</p>
              {user.email ? <p className="small muted mono">{user.email}</p> : null}
              <Link className="btn-primary mt-8" to="/me">
                进入我的自选
              </Link>
            </div>
          </Card>
        </div>
      </div>
    )
  }

  return (
    <div className="container">
      <div className="auth-shell">
        <Card
          title={mode === 'login' ? '账号登录' : '创建账号'}
          extra={<Tag color="blue">ValueSingularity</Tag>}
        >
          <div className="auth-tabs" role="tablist" aria-label="认证模式">
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'login'}
              className={mode === 'login' ? 'auth-tab active' : 'auth-tab'}
              onClick={() => switchMode('login')}
            >
              登录
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'register'}
              className={mode === 'register' ? 'auth-tab active' : 'auth-tab'}
              onClick={() => switchMode('register')}
            >
              注册
            </button>
          </div>

          <form
            className="stack"
            noValidate
            onSubmit={(event) => {
              event.preventDefault()
              void handleSubmit()
            }}
          >
            <div className="field">
              <label htmlFor="auth-email">邮箱</label>
              <input
                id="auth-email"
                className="input"
                type="email"
                autoComplete="email"
                required
                placeholder="investor@example.com"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>

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
                  onChange={(event) => setDisplayName(event.target.value)}
                />
              </div>
            ) : null}

            <div className="field">
              <label htmlFor="auth-password">密码</label>
              <input
                id="auth-password"
                className="input"
                type="password"
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                required
                minLength={mode === 'register' ? 8 : 1}
                placeholder={mode === 'register' ? '至少 8 位字符' : '请输入密码'}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>

            {errorMessage ? (
              <div className="inline-error">
                <ErrorBlock
                  title={mode === 'login' ? '登录失败' : '注册失败'}
                  message={errorMessage}
                />
              </div>
            ) : null}

            <button type="submit" className="btn-primary mt-8" disabled={submitting}>
              {submitting
                ? mode === 'login'
                  ? '登录中...'
                  : '注册中...'
                : mode === 'login'
                  ? '立即登录'
                  : '立即注册'}
            </button>
          </form>
        </Card>
      </div>
    </div>
  )
}
