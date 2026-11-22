import createClient from 'openapi-fetch'
import type { Health, MarketOverview, WatchlistItem, WatchlistUpsert } from '../types/api'
import type { paths } from '../types/openapi.gen'

export class ApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

const client = createClient<paths>({
  baseUrl: '',
  fetch: (input) => globalThis.fetch(input),
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value)
}

function extractErrorMessage(error: unknown, fallback: string): string {
  if (typeof error === 'string' && error.length > 0) {
    return error
  }
  if (!isRecord(error)) {
    return fallback
  }
  const detail = error.detail
  if (typeof detail === 'string' && detail.length > 0) {
    return detail
  }
  if (isUnknownArray(detail) && detail.length > 0) {
    const first = detail[0]
    if (isRecord(first) && typeof first.msg === 'string' && first.msg.length > 0) {
      return first.msg
    }
    return JSON.stringify(detail)
  }
  if (detail !== undefined && detail !== null) {
    return JSON.stringify(detail)
  }
  return fallback
}

interface ApiResult<T> {
  data?: T
  error?: unknown
  response: Response
}

function fallbackMessage(response: Response): string {
  return response.statusText || `HTTP ${response.status}`
}

function unwrap<T>(result: ApiResult<T>): T {
  const { data, error, response } = result
  if (!response.ok || data === undefined) {
    throw new ApiError(extractErrorMessage(error, fallbackMessage(response)), response.status)
  }
  return data
}

export const api = {
  health: async (signal?: AbortSignal): Promise<Health> =>
    unwrap(await client.GET('/api/health', { signal })),

  healthDb: async (signal?: AbortSignal): Promise<Health> =>
    unwrap(await client.GET('/api/health/db', { signal })),

  marketOverview: async (signal?: AbortSignal): Promise<MarketOverview> =>
    unwrap(await client.GET('/api/market/overview', { signal })),

  listWatchlist: async (signal?: AbortSignal): Promise<WatchlistItem[]> =>
    unwrap(await client.GET('/api/watchlist', { signal })),

  upsertWatchlist: async (body: WatchlistUpsert): Promise<WatchlistItem> =>
    unwrap(await client.PUT('/api/watchlist', { body })),

  removeWatchlist: async (code: string): Promise<void> => {
    const { error, response } = await client.DELETE('/api/watchlist/{code}', {
      params: { path: { code } },
    })
    if (!response.ok) {
      throw new ApiError(extractErrorMessage(error, fallbackMessage(response)), response.status)
    }
  },
}
