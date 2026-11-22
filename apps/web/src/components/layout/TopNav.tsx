import { useEffect, useRef, useState } from 'react'
import { NavLink } from 'react-router-dom'
import type { PlanTier, StockMetaRecord, UserProfile } from '../../types/api'
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

const EMPTY_RESULTS: StockMetaRecord[] = []

type TopNavProps = {
  user?: UserProfile | null
  isAuthLoading?: boolean
  onLogout?: () => void
  searchQuery?: string
  onSearchChange?: (q: string) => void
  searchResults?: StockMetaRecord[]
  isSearching?: boolean
  onSelectStock?: (code: string) => void
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
  searchError = false,
}: TopNavProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const searchRef = useRef<HTMLFormElement>(null)

  const trimmedQuery = searchQuery.trim()
  const showDropdown = isOpen && trimmedQuery.length > 0

  useEffect(() => {
    function handleOutsideMouseDown(event: MouseEvent) {
      if (
        searchRef.current &&
        event.target instanceof Node &&
        !searchRef.current.contains(event.target)
      ) {
        setIsOpen(false)
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
    const highlighted = activeIndex >= 0 ? searchResults[activeIndex] : undefined
    if (highlighted) {
      selectCode(highlighted.code)
      return
    }
    if (/^\d{6}$/.test(trimmedQuery)) {
      selectCode(trimmedQuery)
      return
    }
    const first = searchResults[0]
    if (first) {
      selectCode(first.code)
    }
  }

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

        <form
          ref={searchRef}
          className="nav-search"
          role="search"
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
              if (event.key === 'Escape') {
                setIsOpen(false)
                setActiveIndex(-1)
                return
              }
              if (event.key === 'ArrowDown' && searchResults.length > 0) {
                event.preventDefault()
                setIsOpen(true)
                setActiveIndex((prev) => (prev + 1) % searchResults.length)
                return
              }
              if (event.key === 'ArrowUp' && searchResults.length > 0) {
                event.preventDefault()
                setIsOpen(true)
                setActiveIndex((prev) => (prev <= 0 ? searchResults.length - 1 : prev - 1))
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
                    aria-selected={index === activeIndex}
                    className={index === activeIndex ? 'nav-search-item active' : 'nav-search-item'}
                    onClick={() => selectCode(stock.code)}
                  >
                    <span className="nav-search-item-main">
                      <span className="mono">{stock.code}</span>
                      <span>{stock.name}</span>
                    </span>
                    <span className="nav-search-item-tags">
                      <Tag color="blue">{stock.exchange}</Tag>
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
