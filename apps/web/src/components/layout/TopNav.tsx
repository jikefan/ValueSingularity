import { NavLink } from 'react-router-dom'

const links = [
  { to: '/', label: '市场', end: true },
  { to: '/me', label: '我的', end: false },
]

export function TopNav() {
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
      </div>
    </header>
  )
}
