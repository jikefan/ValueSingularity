import createClient from 'openapi-fetch'
import type {
  Health,
  LoginRequest,
  MarketOverview,
  RegisterRequest,
  TokenResponse,
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

const PUBLIC_AUTH_PATHS = new Set(['/api/auth/login', '/api/auth/register', '/api/auth/refresh'])

let accessToken: string | null = null
let inflightRefresh: Promise<TokenResponse | null> | null = null
const authExpiredListeners = new Set<() => void>()

export function getAccessToken(): string | null {
  return accessToken
}

export function setAccessToken(token: string | null): void {
  accessToken = token
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

  if (accessToken && !isPublicAuth) {
    request.headers.set('Authorization', `Bearer ${accessToken}`)
  }

  const response = await globalThis.fetch(request)
  if (response.status !== 401 || isPublicAuth || !retrySnapshot) {
    return response
  }

  const refreshed = await refreshSingleFlight()
  if (!refreshed) {
    return response
  }

  retrySnapshot.headers.set('Authorization', `Bearer ${refreshed.access_token}`)
  return await globalThis.fetch(retrySnapshot)
}

const client = createClient<paths>({
  baseUrl: '',
  credentials: 'include',
  fetch: fetchWithAuth,
})

function refreshSingleFlight(): Promise<TokenResponse | null> {
  if (inflightRefresh === null) {
    inflightRefresh = (async () => {
      try {
        const { data, response } = await client.POST('/api/auth/refresh')
        if (!response.ok || data === undefined) {
          accessToken = null
          notifyAuthExpired()
          return null
        }
        accessToken = data.access_token
        return data
      } finally {
        inflightRefresh = null
      }
    })()
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
    const data = unwrap(await client.POST('/api/auth/register', { body }))
    accessToken = data.access_token
    return data
  },

  login: async (body: LoginRequest): Promise<TokenResponse> => {
    const data = unwrap(await client.POST('/api/auth/login', { body }))
    accessToken = data.access_token
    return data
  },

  refreshSession: (): Promise<TokenResponse | null> => refreshSingleFlight(),

  logout: async (): Promise<void> => {
    try {
      const { error, response } = await client.POST('/api/auth/logout')
      if (!response.ok) {
        throw new ApiError(extractErrorMessage(error, fallbackMessage(response)), response.status)
      }
    } finally {
      accessToken = null
    }
  },

  me: async (signal?: AbortSignal): Promise<UserProfile> =>
    unwrap(await client.GET('/api/auth/me', { signal })),

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
