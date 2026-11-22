export const queryKeys = {
  health: ['health'] as const,
  auth: {
    all: ['auth'] as const,
    me: () => ['auth', 'me'] as const,
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
  },
  journal: {
    all: ['journal'] as const,
    list: (code?: string) => ['journal', 'list', code ?? 'all'] as const,
  },
  events: {
    all: ['events'] as const,
    list: () => ['events', 'list'] as const,
  },
} as const
