import { NavLink } from 'react-router-dom'
import type { PlanTier, UserProfile } from '../../types/api'
import { Tag } from '../ui/Tag'

const links = [
  { to: '/', label: '市场', end: true },
  { to: '/me', label: '我的', end: false },
]

const PLAN_COLOR: Record<PlanTier, 'gray' | 'blue' | 'green'> = {
  free: 'gray',
  pro: 'blue',
  ai_plus: 'green',
}

type TopNavProps = {
  user?: UserProfile | null
  isAuthLoading?: boolean
  onLogout?: () => void
}

export function TopNav({ user = null, isAuthLoading = false, onLogout }: TopNavProps) {
  return (
    <header className="topnav">
      <div className="topnav-inner">
        <NavLink className="brand" to="/">
          <span className="brand-mark">VS</span>
          <span className="brand-text">
            <b>价值奇点</b>
            <i>VALUE SINGULARITY</i>
          </span>
        </NavLink>

        <nav className="nav-links">
          {links.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              end={link.end}
              className={({ isActive }) => (isActive ? 'active' : undefined)}
            >
              {link.label}
            </NavLink>
          ))}
        </nav>

        <span className="spacer" />

        <button type="button" className="persona-chip" title="AI 陪伴人格（待接入）">
          中性分析师
        </button>

        {user ? (
          <span className="nav-user">
            <span className="soft small">{user.display_name}</span>
            <Tag color={PLAN_COLOR[user.plan_tier]}>{user.plan_tier.toUpperCase()}</Tag>
            <button type="button" className="btn-ghost" onClick={onLogout}>
              退出
            </button>
          </span>
        ) : !isAuthLoading ? (
          <NavLink className="btn-ghost" to="/login">
            登录 / 注册
          </NavLink>
        ) : null}
      </div>
    </header>
  )
}
