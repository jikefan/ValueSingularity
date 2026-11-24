import type { JournalAction, StockScreenerFilters } from '../types/api'

export const queryKeys = {
  health: ['health'] as const,
  auth: {
    all: ['auth'] as const,
    me: () => ['auth', 'me'] as const,
    config: () => ['auth', 'config'] as const,
  },
  market: {
    all: ['market'] as const,
    overview: () => ['market', 'overview'] as const,
  },
  watchlist: {
    all: ['watchlist'] as const,
    list: () => ['watchlist', 'list'] as const,
  },
  stocks: {
    all: ['stocks'] as const,
    search: (q: string) => ['stocks', 'search', q] as const,
    detail: (code: string) => ['stocks', 'detail', code] as const,
    snapshot: (code: string) => ['stocks', 'snapshot', code] as const,
    comparePrefix: () => ['stocks', 'compare'] as const,
    compare: (codes: readonly string[]) =>
      [
        'stocks',
        'compare',
        Array.from(new Set(codes.map((code) => code.trim()).filter(Boolean))).join(','),
      ] as const,
    screenerPrefix: () => ['stocks', 'screener'] as const,
    screener: (filters: StockScreenerFilters = {}) =>
      [
        'stocks',
        'screener',
        {
          zeroRedOnly: Boolean(filters.zeroRedOnly),
          maxPePercentile: filters.maxPePercentile ?? null,
          minRoe: filters.minRoe ?? null,
          minDividendYield: filters.minDividendYield ?? null,
          industry: filters.industry?.trim() || null,
          q: filters.q?.trim() || null,
          sortBy: filters.sortBy ?? 'total_score',
          sortDir: filters.sortDir ?? 'desc',
          limit: filters.limit ?? 50,
        },
      ] as const,
  },
  journal: {
    all: ['journal'] as const,
    list: (code?: string, actions?: readonly JournalAction[]) =>
      [
        'journal',
        'list',
        code ?? 'all',
        actions && actions.length > 0 ? [...actions].sort().join(',') : 'all',
      ] as const,
    ledger: (limit?: number) =>
      limit === undefined
        ? (['journal', 'ledger'] as const)
        : (['journal', 'ledger', limit] as const),
  },
  alerts: {
    all: ['alerts'] as const,
    list: (limit = 50) => ['alerts', 'list', limit] as const,
    preferences: () => ['alerts', 'preferences'] as const,
  },
  events: {
    all: ['events'] as const,
    list: () => ['events', 'list'] as const,
  },
  ai: {
    all: ['ai'] as const,
    preferences: () => ['ai', 'preferences'] as const,
    devilsAdvocate: (userKey: string, code: string) =>
      ['ai', 'devils-advocate', userKey, code] as const,
    mdaDiff: (userKey: string, code: string) => ['ai', 'mda-diff', userKey, code] as const,
  },
} as const
