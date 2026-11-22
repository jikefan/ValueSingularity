import { useQuery } from '@tanstack/react-query'
import { ApiError, api } from './api'
import { queryKeys } from './queryKeys'

const STOCK_CODE_RE = /^[0-9]{6}$/

export function normalizeCompareCodes(codes: readonly string[]): string[] {
  const seen = new Set<string>()
  const normalized: string[] = []
  for (const raw of codes) {
    const trimmed = raw.trim()
    if (STOCK_CODE_RE.test(trimmed) && !seen.has(trimmed)) {
      seen.add(trimmed)
      normalized.push(trimmed)
    }
    if (normalized.length >= 5) {
      break
    }
  }
  return normalized
}

export function useStockSnapshot(code: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.stocks.snapshot(code),
    queryFn: ({ signal }) => api.getStockSnapshot(code, signal),
    enabled: enabled && STOCK_CODE_RE.test(code),
    retry: (failureCount, error) => {
      if (error instanceof ApiError && error.status === 404) {
        return false
      }
      if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
        return false
      }
      return failureCount < 1
    },
  })
}

export function useStockCompare(codes: readonly string[]) {
  const normalized = normalizeCompareCodes(codes)
  return useQuery({
    queryKey: queryKeys.stocks.compare(normalized),
    queryFn: ({ signal }) => api.compareStocks(normalized, signal),
    enabled: normalized.length > 0,
  })
}
