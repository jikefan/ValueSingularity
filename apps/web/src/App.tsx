import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { Route, Routes, useNavigate } from 'react-router-dom'
import { TopNav } from './components/layout/TopNav'
import { AuthPage } from './features/auth/AuthPage'
import { ComparePage } from './features/compare/ComparePage'
import { MarketPage } from './features/market/MarketPage'
import { MePage } from './features/me/MePage'
import { StockPage } from './features/stock/StockPage'
import { api } from './lib/api'
import { useAuth } from './lib/authContext'
import { queryKeys } from './lib/queryKeys'

export function App() {
  const { user, isAuthLoading, logout } = useAuth()
  const queryClient = useQueryClient()
  const navigate = useNavigate()

  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const trimmedSearch = searchQuery.trim()
  const latestQueryRef = useRef(trimmedSearch)
  latestQueryRef.current = trimmedSearch
  const submitSeqRef = useRef(0)

  useEffect(() => {
    if (!trimmedSearch) {
      return
    }
    const timer = window.setTimeout(() => {
      setDebouncedQuery(trimmedSearch)
    }, 180)
    return () => {
      window.clearTimeout(timer)
    }
  }, [trimmedSearch])

  const searchEnabled = debouncedQuery.length > 0
  const stockSearchQuery = useQuery({
    queryKey: queryKeys.stocks.search(debouncedQuery),
    queryFn: ({ signal }) => api.searchStocks(debouncedQuery, 10, signal),
    enabled: searchEnabled,
  })

  const isDebouncing = trimmedSearch.length > 0 && debouncedQuery !== trimmedSearch
  const isSearching = isDebouncing || (searchEnabled && stockSearchQuery.isFetching)
  const searchError = !isSearching && searchEnabled && stockSearchQuery.isError
  const searchResults = !isSearching && searchEnabled ? (stockSearchQuery.data ?? []) : []

  function handleSearchChange(next: string) {
    submitSeqRef.current += 1
    setSearchQuery(next)
    if (!next.trim()) {
      setDebouncedQuery('')
    }
  }

  function handleSelectStock(code: string) {
    submitSeqRef.current += 1
    setSearchQuery('')
    setDebouncedQuery('')
    void navigate(`/stock/${code}`)
  }

  async function handleSubmitQuery(rawQuery: string) {
    const submitted = rawQuery.trim()
    if (!submitted) {
      return
    }
    if (/^[0-9]{6}$/.test(submitted)) {
      handleSelectStock(submitted)
      return
    }
    const seq = ++submitSeqRef.current
    setDebouncedQuery(submitted)
    try {
      const matches = await queryClient.fetchQuery({
        queryKey: queryKeys.stocks.search(submitted),
        queryFn: ({ signal }) => api.searchStocks(submitted, 10, signal),
      })
      if (seq !== submitSeqRef.current || latestQueryRef.current !== submitted) {
        return
      }
      const first = matches[0]
      if (first) {
        handleSelectStock(first.code)
      }
    } catch {
      // Error state is rendered by stockSearchQuery in the dropdown.
    }
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
        onSubmitQuery={(query) => {
          void handleSubmitQuery(query)
        }}
      />
      <Routes>
        <Route path="/" element={<MarketPage />} />
        <Route path="/stock/:code" element={<StockPage />} />
        <Route path="/compare" element={<ComparePage />} />
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
