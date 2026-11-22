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
  stock: {
    all: ['stock'] as const,
    detail: (code: string) => ['stock', code] as const,
  },
} as const
