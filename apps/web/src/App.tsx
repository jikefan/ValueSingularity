import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Route, Routes, useNavigate } from 'react-router-dom'
import { TopNav } from './components/layout/TopNav'
import { AuthPage } from './features/auth/AuthPage'
import { MarketPage } from './features/market/MarketPage'
import { MePage } from './features/me/MePage'
import { StockPage } from './features/stock/StockPage'
import { api } from './lib/api'
import { useAuth } from './lib/authContext'
import { queryKeys } from './lib/queryKeys'

export function App() {
  const { user, isAuthLoading, logout } = useAuth()
  const navigate = useNavigate()

  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')

  useEffect(() => {
    const trimmed = searchQuery.trim()
    if (!trimmed) {
      return
    }
    const timer = window.setTimeout(() => {
      setDebouncedQuery(trimmed)
    }, 180)
    return () => {
      window.clearTimeout(timer)
    }
  }, [searchQuery])

  const trimmedSearch = searchQuery.trim()
  const searchEnabled = debouncedQuery.length > 0
  const stockSearchQuery = useQuery({
    queryKey: queryKeys.stocks.search(debouncedQuery),
    queryFn: ({ signal }) => api.searchStocks(debouncedQuery, 10, signal),
    enabled: searchEnabled,
  })

  const isDebouncing = trimmedSearch.length > 0 && debouncedQuery !== trimmedSearch
  const isSearching = isDebouncing || (searchEnabled && stockSearchQuery.isFetching)
  const searchError = !isDebouncing && searchEnabled && stockSearchQuery.isError
  const searchResults = !isDebouncing && searchEnabled ? (stockSearchQuery.data ?? []) : []

  function handleSearchChange(next: string) {
    setSearchQuery(next)
    if (!next.trim()) {
      setDebouncedQuery('')
    }
  }

  function handleSelectStock(code: string) {
    setSearchQuery('')
    setDebouncedQuery('')
    void navigate(`/stock/${code}`)
  }

  return (
    <div className="shell">
      <TopNav
        user={user}
        isAuthLoading={isAuthLoading}
        onLogout={() => {
          void logout()
        }}
        searchQuery={searchQuery}
        onSearchChange={handleSearchChange}
        searchResults={searchResults}
        isSearching={isSearching}
        searchError={searchError}
        onSelectStock={handleSelectStock}
      />
      <Routes>
        <Route path="/" element={<MarketPage />} />
        <Route path="/stock/:code" element={<StockPage />} />
        <Route path="/me" element={<MePage />} />
        <Route path="/login" element={<AuthPage />} />
        <Route path="/register" element={<AuthPage initialMode="register" />} />
        <Route path="*" element={<MarketPage />} />
      </Routes>
      <footer className="footer">
        <div>价值奇点 ValueSingularity · 数据来源 akshare</div>
        <div className="mt-8">本工具仅用于研究与学习，不构成任何投资建议。</div>
      </footer>
    </div>
  )
}
