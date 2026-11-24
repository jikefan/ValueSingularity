import { useEffect, useRef, useState } from 'react'
import { NavLink } from 'react-router-dom'
import { useThemeMode, type ThemeMode } from '../../lib/theme'
import type { PlanTier, StockMetaRecord, UserProfile } from '../../types/api'
import { Tag } from '../ui/Tag'

const links = [
  { to: '/', label: '市场', end: true },
  { to: '/compare', label: '对比', end: false },
  { to: '/me', label: '我的', end: false },
]

const PLAN_COLOR: Record<PlanTier, 'gray' | 'blue' | 'green'> = {
  free: 'gray',
  pro: 'blue',
  ai_plus: 'green',
}

const EMPTY_RESULTS: StockMetaRecord[] = []

const THEME_OPTIONS: ReadonlyArray<{ mode: ThemeMode; label: string }> = [
  { mode: 'dark', label: '碳黑' },
  { mode: 'light', label: '陶瓷白' },
]

function ThemeIcon({ mode }: { mode: ThemeMode }) {
  switch (mode) {
    case 'dark':
      return (
        <svg
          width={12}
          height={12}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
        </svg>
      )
    case 'light':
      return (
        <svg
          width={12}
          height={12}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
        </svg>
      )
    default: {
      const _exhaustive: never = mode
      return _exhaustive
    }
  }
}

type TopNavProps = {
  user?: UserProfile | null
  isAuthLoading?: boolean
  onLogout?: () => void
  searchQuery?: string
  onSearchChange?: (q: string) => void
  searchResults?: StockMetaRecord[]
  isSearching?: boolean
  onSelectStock?: (code: string) => void
  onSubmitQuery?: (query: string) => void
  searchError?: boolean
}

export function TopNav({
  user = null,
  isAuthLoading = false,
  onLogout,
  searchQuery = '',
  onSearchChange,
  searchResults = EMPTY_RESULTS,
  isSearching = false,
  onSelectStock,
  onSubmitQuery,
  searchError = false,
}: TopNavProps) {
  const { theme, setTheme } = useThemeMode()
  const [isOpen, setIsOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const searchRef = useRef<HTMLFormElement>(null)

  const trimmedQuery = searchQuery.trim()
  const showDropdown = isOpen && trimmedQuery.length > 0
  const effectiveActiveIndex =
    !isSearching && activeIndex >= 0 && activeIndex < searchResults.length ? activeIndex : -1

  useEffect(() => {
    function handleOutsideMouseDown(event: MouseEvent) {
      if (
        searchRef.current &&
        event.target instanceof Node &&
        !searchRef.current.contains(event.target)
      ) {
        setIsOpen(false)
        setActiveIndex(-1)
      }
    }
    document.addEventListener('mousedown', handleOutsideMouseDown)
    return () => {
      document.removeEventListener('mousedown', handleOutsideMouseDown)
    }
  }, [])

  function selectCode(code: string) {
    setIsOpen(false)
    setActiveIndex(-1)
    onSelectStock?.(code)
  }

  function submitSearch() {
    if (!trimmedQuery) {
      return
    }
    const highlighted = effectiveActiveIndex >= 0 ? searchResults[effectiveActiveIndex] : undefined
    if (highlighted) {
      selectCode(highlighted.code)
      return
    }
    if (/^[0-9]{6}$/.test(trimmedQuery)) {
      selectCode(trimmedQuery)
      return
    }
    if (!isSearching) {
      const first = searchResults[0]
      if (first) {
        selectCode(first.code)
        return
      }
    }
    onSubmitQuery?.(trimmedQuery)
  }

  return (
    <header className="topnav">
      <div className="topnav-inner">
        <NavLink className="brand" to="/">
          <span className="vs-checker" aria-hidden="true">
            <i />
            <i className="off" />
            <i className="sig" />
            <i className="off" />
            <i />
            <i className="off" />
            <i />
            <i className="off" />
            <i />
          </span>
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

        <form
          ref={searchRef}
          className="nav-search"
          role="search"
          onBlur={(event) => {
            const related = event.relatedTarget
            if (!(related instanceof Node) || !searchRef.current?.contains(related)) {
              setIsOpen(false)
              setActiveIndex(-1)
            }
          }}
          onSubmit={(event) => {
            event.preventDefault()
            submitSearch()
          }}
        >
          <input
            type="text"
            className="input nav-search-input"
            aria-label="搜索股票"
            aria-expanded={showDropdown}
            aria-autocomplete="list"
            autoComplete="off"
            placeholder="搜代码或名称，如 600519"
            value={searchQuery}
            onFocus={() => {
              if (trimmedQuery.length > 0) {
                setIsOpen(true)
              }
            }}
            onChange={(event) => {
              const nextValue = event.target.value
              onSearchChange?.(nextValue)
              setActiveIndex(-1)
              setIsOpen(nextValue.trim().length > 0)
            }}
            onKeyDown={(event) => {
              if (
                event.nativeEvent.isComposing ||
                event.key === 'Process' ||
                event.keyCode === 229
              ) {
                return
              }
              if (event.key === 'Escape') {
                setIsOpen(false)
                setActiveIndex(-1)
                return
              }
              if (event.key === 'ArrowDown' && !isSearching && searchResults.length > 0) {
                event.preventDefault()
                setIsOpen(true)
                setActiveIndex((prev) => {
                  const current = prev >= 0 && prev < searchResults.length ? prev : -1
                  return (current + 1) % searchResults.length
                })
                return
              }
              if (event.key === 'ArrowUp' && !isSearching && searchResults.length > 0) {
                event.preventDefault()
                setIsOpen(true)
                setActiveIndex((prev) => {
                  const current = prev >= 0 && prev < searchResults.length ? prev : -1
                  return current <= 0 ? searchResults.length - 1 : current - 1
                })
                return
              }
              if (event.key === 'Enter') {
                event.preventDefault()
                submitSearch()
              }
            }}
          />

          {showDropdown ? (
            <div className="nav-search-dropdown" role="listbox" aria-label="搜索结果">
              {isSearching ? (
                <div className="nav-search-status">搜索中...</div>
              ) : searchError ? (
                <div className="nav-search-status">搜索失败，请稍后重试</div>
              ) : searchResults.length === 0 ? (
                <div className="nav-search-status">未找到匹配股票</div>
              ) : (
                searchResults.map((stock, index) => (
                  <button
                    key={stock.code}
                    type="button"
                    role="option"
                    aria-selected={index === effectiveActiveIndex}
                    className={
                      index === effectiveActiveIndex ? 'nav-search-item active' : 'nav-search-item'
                    }
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => selectCode(stock.code)}
                  >
                    <span className="nav-search-item-main">
                      <span className="mono">{stock.code}</span>
                      <span>{stock.name}</span>
                    </span>
                    <span className="nav-search-item-tags">
                      <Tag color="blue">{stock.exchange}</Tag>
                      <Tag color={stock.snapshot_available ? 'green' : 'gray'}>
                        {stock.snapshot_available ? '已同步快照' : '仅基础信息'}
                      </Tag>
                      {stock.is_st ? <Tag color="amber">ST</Tag> : null}
                      {!stock.is_active ? <Tag color="rose">已退市</Tag> : null}
                    </span>
                  </button>
                ))
              )}
            </div>
          ) : null}
        </form>

        <span className="spacer" />

        <div className="theme-capsule" role="group" aria-label="主题切换">
          {THEME_OPTIONS.map(({ mode, label }) => {
            const isActive = theme === mode
            return (
              <button
                key={mode}
                type="button"
                className={isActive ? 'theme-opt active' : 'theme-opt'}
                aria-pressed={isActive}
                onClick={() => {
                  if (!isActive) {
                    setTheme(mode, { animate: true })
                  }
                }}
              >
                <ThemeIcon mode={mode} />
                {label}
              </button>
            )
          })}
        </div>

        {user ? (
          <span className="nav-user">
            <span className="nav-user-name soft small" title={user.display_name}>
              {user.display_name}
            </span>
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
