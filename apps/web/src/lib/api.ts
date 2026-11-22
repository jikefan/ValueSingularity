import createClient from 'openapi-fetch'
import type {
  Health,
  JournalAction,
  JournalCreate,
  JournalEntryItem,
  LoginRequest,
  MarketOverview,
  RegisterRequest,
  StockCompareItem,
  StockDetail,
  StockMetaRecord,
  StockSnapshotPayload,
  TokenResponse,
  UserEventItem,
  UserProfile,
  WatchlistItem,
  WatchlistUpsert,
} from '../types/api'
import type { paths } from '../types/openapi.gen'

export class ApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

const PUBLIC_AUTH_PATHS = new Set([
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/refresh',
  '/api/auth/logout',
])

let accessToken: string | null = null
let authEpoch = 0
let inflightRefresh: Promise<TokenResponse | null> | null = null
let inflightLogout: Promise<void> | null = null
const authExpiredListeners = new Set<() => void>()

export function getAccessToken(): string | null {
  return accessToken
}

export function setAccessToken(token: string | null): void {
  authEpoch += 1
  accessToken = token
  inflightRefresh = null
}

export function subscribeAuthExpired(listener: () => void): () => void {
  authExpiredListeners.add(listener)
  return () => {
    authExpiredListeners.delete(listener)
  }
}

function notifyAuthExpired(): void {
  for (const listener of authExpiredListeners) {
    listener()
  }
}

async function fetchWithAuth(request: Request): Promise<Response> {
  const pathname = new URL(request.url, 'http://localhost').pathname
  const isPublicAuth = PUBLIC_AUTH_PATHS.has(pathname)
  // Clone before sending so POST/PUT request bodies remain readable for a single 401 retry.
  const retrySnapshot = !isPublicAuth && !request.bodyUsed ? request.clone() : null
  const epoch = authEpoch
  const tokenUsed = accessToken

  if (tokenUsed && !isPublicAuth) {
    request.headers.set('Authorization', `Bearer ${tokenUsed}`)
  }

  const response = await globalThis.fetch(request)
  if (response.status !== 401 || isPublicAuth || !retrySnapshot) {
    return response
  }

  if (authEpoch !== epoch) {
    return response
  }

  if (accessToken !== null && accessToken !== tokenUsed) {
    const retryRequest = retrySnapshot.clone()
    retryRequest.headers.set('Authorization', `Bearer ${accessToken}`)
    return await globalThis.fetch(retryRequest)
  }

  const refreshed = await refreshSingleFlight()
  if (!refreshed || authEpoch !== epoch) {
    return response
  }

  const retryRequest = retrySnapshot.clone()
  retryRequest.headers.set('Authorization', `Bearer ${refreshed.access_token}`)
  return await globalThis.fetch(retryRequest)
}

const client = createClient<paths>({
  baseUrl: '',
  credentials: 'include',
  fetch: fetchWithAuth,
})

async function executeRefresh(epoch: number): Promise<TokenResponse | null> {
  let result: ApiResult<TokenResponse>
  try {
    result = await client.POST('/api/auth/refresh')
  } catch (err) {
    if (authEpoch !== epoch) {
      return null
    }
    if (err instanceof ApiError) {
      throw err
    }
    const message = err instanceof Error && err.message ? err.message : '网络请求失败'
    throw new ApiError(message, 0)
  }

  if (authEpoch !== epoch) {
    return null
  }

  const { data, error, response } = result
  if (response.status === 401 || response.status === 403) {
    accessToken = null
    notifyAuthExpired()
    return null
  }

  if (!response.ok || data === undefined) {
    throw new ApiError(extractErrorMessage(error, fallbackMessage(response)), response.status)
  }

  accessToken = data.access_token
  return data
}

function refreshSingleFlight(): Promise<TokenResponse | null> {
  if (inflightLogout !== null) {
    return Promise.resolve(null)
  }
  if (inflightRefresh === null) {
    const epoch = authEpoch
    const promise = executeRefresh(epoch).finally(() => {
      if (inflightRefresh === promise) {
        inflightRefresh = null
      }
    })
    inflightRefresh = promise
  }
  return inflightRefresh
}

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

type ApiResult<T> = {
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

  register: async (body: RegisterRequest): Promise<TokenResponse> => {
    const startEpoch = authEpoch
    const data = unwrap(await client.POST('/api/auth/register', { body }))
    if (authEpoch !== startEpoch) {
      throw new ApiError('注册已取消', 0)
    }
    authEpoch += 1
    accessToken = data.access_token
    inflightRefresh = null
    return data
  },

  login: async (body: LoginRequest): Promise<TokenResponse> => {
    const startEpoch = authEpoch
    const data = unwrap(await client.POST('/api/auth/login', { body }))
    if (authEpoch !== startEpoch) {
      throw new ApiError('登录已取消', 0)
    }
    authEpoch += 1
    accessToken = data.access_token
    inflightRefresh = null
    return data
  },

  refreshSession: (): Promise<TokenResponse | null> => refreshSingleFlight(),

  logout: async (): Promise<void> => {
    authEpoch += 1
    accessToken = null
    inflightRefresh = null
    const promise = (async () => {
      const { error, response } = await client.POST('/api/auth/logout')
      if (!response.ok) {
        throw new ApiError(extractErrorMessage(error, fallbackMessage(response)), response.status)
      }
    })().finally(() => {
      if (inflightLogout === promise) {
        inflightLogout = null
      }
    })
    inflightLogout = promise
    return promise
  },

  me: async (signal?: AbortSignal): Promise<UserProfile> =>
    unwrap(await client.GET('/api/auth/me', { signal })),

  marketOverview: async (signal?: AbortSignal): Promise<MarketOverview> =>
    unwrap(await client.GET('/api/market/overview', { signal })),

  listWatchlist: async (signal?: AbortSignal): Promise<WatchlistItem[]> =>
    unwrap(await client.GET('/api/watchlist', { signal })),

  addWatchlist: async (body: WatchlistUpsert): Promise<WatchlistItem> =>
    unwrap(await client.POST('/api/watchlist', { body })),

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

  searchStocks: async (q: string, limit = 10, signal?: AbortSignal): Promise<StockMetaRecord[]> =>
    unwrap(
      await client.GET('/api/stocks/search', {
        params: { query: { q, limit } },
        signal,
      }),
    ),

  getStock: async (code: string, signal?: AbortSignal): Promise<StockDetail> =>
    unwrap(
      await client.GET('/api/stocks/{code}', {
        params: { path: { code } },
        signal,
      }),
    ),

  getStockSnapshot: async (code: string, signal?: AbortSignal): Promise<StockSnapshotPayload> =>
    unwrap(
      await client.GET('/api/stocks/{code}/snapshot', {
        params: { path: { code } },
        signal,
      }),
    ),

  compareStocks: async (
    codes: readonly string[],
    signal?: AbortSignal,
  ): Promise<StockCompareItem[]> =>
    unwrap(
      await client.GET('/api/stocks/compare', {
        params: { query: { codes: codes.join(',') } },
        signal,
      }),
    ),

  listJournal: async (
    options: {
      code?: string
      actions?: readonly JournalAction[]
      limit?: number
      signal?: AbortSignal
    } = {},
  ): Promise<JournalEntryItem[]> => {
    const { code, actions, limit = 50, signal } = options
    const query: { code?: string; action?: JournalAction[]; limit: number } = { limit }
    if (code) {
      query.code = code
    }
    if (actions && actions.length > 0) {
      query.action = [...actions]
    }
    return unwrap(
      await client.GET('/api/journal', {
        params: { query },
        signal,
      }),
    )
  },

  createJournal: async (body: JournalCreate): Promise<JournalEntryItem> =>
    unwrap(await client.POST('/api/journal', { body })),

  removeJournal: async (entryId: number): Promise<void> => {
    const { error, response } = await client.DELETE('/api/journal/{entry_id}', {
      params: { path: { entry_id: entryId } },
    })
    if (!response.ok) {
      throw new ApiError(extractErrorMessage(error, fallbackMessage(response)), response.status)
    }
  },

  listEvents: async (limit = 50, signal?: AbortSignal): Promise<UserEventItem[]> =>
    unwrap(
      await client.GET('/api/events', {
        params: { query: { limit } },
        signal,
      }),
    ),
}
