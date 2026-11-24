import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import type { StockScreenerFilters } from '../types/api'
import { ApiError, api } from './api'
import { queryKeys } from './queryKeys'

export type { StockScreenerFilters }

export type UseStockSnapshotOptions = {
  enabled?: boolean
  ensureOnDemand?: boolean
  snapshotAvailableHint?: boolean
}

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

export function useStockSnapshot(
  code: string,
  optionsOrEnabled: UseStockSnapshotOptions | boolean = {},
) {
  const queryClient = useQueryClient()
  const {
    enabled = true,
    ensureOnDemand = true,
    snapshotAvailableHint,
  } = typeof optionsOrEnabled === 'boolean' ? { enabled: optionsOrEnabled } : optionsOrEnabled

  const invalidateAfterSync = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.stocks.detail(code) })
    void queryClient.invalidateQueries({ queryKey: queryKeys.stocks.screenerPrefix() })
  }

  return useQuery({
    queryKey: queryKeys.stocks.snapshot(code),
    queryFn: async ({ signal }) => {
      if (!ensureOnDemand) {
        return api.getStockSnapshot(code, signal)
      }
      if (snapshotAvailableHint === false) {
        const synced = await api.syncStockSnapshot(code, signal)
        invalidateAfterSync()
        return synced
      }
      try {
        return await api.getStockSnapshot(code, signal)
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          const synced = await api.syncStockSnapshot(code, signal)
          invalidateAfterSync()
          return synced
        }
        throw err
      }
    },
    enabled: enabled && STOCK_CODE_RE.test(code),
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

export function useStockScreener(filters: StockScreenerFilters = {}, enabled = true) {
  return useQuery({
    queryKey: queryKeys.stocks.screener(filters),
    queryFn: ({ signal }) => api.getStockScreener(filters, signal),
    enabled,
    placeholderData: keepPreviousData,
  })
}
