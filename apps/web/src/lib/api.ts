import createClient from 'openapi-fetch'
import type {
  AiPreferences,
  AiPreferencesUpdate,
  AlertDeliveryItem,
  AlertScanSummary,
  AuthConfigResponse,
  AuthenticatedEmailCodeRequest,
  DecisionLedgerReport,
  DeleteAccountRequest,
  DevilsAdvocateRequest,
  DevilsAdvocateResponse,
  EmailCodeSendRequest,
  EmailCodeSendResponse,
  Health,
  JournalAction,
  JournalCreate,
  JournalEntryItem,
  LoginRequest,
  MarketOverview,
  MdaDiffRequest,
  MdaDiffResponse,
  NotificationPreferences,
  NotificationPreferencesUpdate,
  PasswordChangeRequest,
  PasswordResetConfirmRequest,
  RegisterRequest,
  StockCompareItem,
  StockDetail,
  StockMetaRecord,
  StockScreenerFilters,
  StockScreenerResponse,
  StockSnapshotPayload,
  TokenResponse,
  UserEventItem,
  UserProfile,
  UserProfileUpdateRequest,
  VerifyEmailRequest,
  WatchlistItem,
  WatchlistUpsert,
} from '../types/api'
import type { operations, paths } from '../types/openapi.gen'

export class ApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

const PUBLIC_AUTH_PATHS = new Set([
  '/api/auth/config',
  '/api/auth/email-codes',
  '/api/auth/login',
  '/api/auth/password/reset',
  '/api/auth/register',
  '/api/auth/refresh',
  '/api/auth/logout',
])

type InflightChangePassword = {
  epoch: number
  promise: Promise<TokenResponse>
}

let accessToken: string | null = null
let authEpoch = 0
let inflightRefresh: Promise<TokenResponse | null> | null = null
let inflightLogout: Promise<void> | null = null
let inflightChangePassword: InflightChangePassword | null = null
const authExpiredListeners = new Set<() => void>()

export function getAccessToken(): string | null {
  return accessToken
}

export function getAuthEpoch(): number {
  return authEpoch
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
  authEpoch += 1
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

async function waitForInflightChangePassword(epoch: number): Promise<TokenResponse | null> {
  const pending = inflightChangePassword
  if (!pending || pending.epoch !== epoch) {
    return null
  }
  try {
    return await pending.promise
  } catch {
    return null
  }
}

async function executeRefresh(epoch: number): Promise<TokenResponse | null> {
  let result: ApiResult<TokenResponse>
  try {
    result = await client.POST('/api/auth/refresh')
  } catch (err) {
    const changed = await waitForInflightChangePassword(epoch)
    if (authEpoch !== epoch) {
      return changed && accessToken === changed.access_token ? changed : null
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
    const changed = await waitForInflightChangePassword(epoch)
    if (authEpoch !== epoch) {
      return changed && accessToken === changed.access_token ? changed : null
    }
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
    inflightLogout = null
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
    inflightLogout = null
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

  getAuthConfig: async (signal?: AbortSignal): Promise<AuthConfigResponse> =>
    unwrap(await client.GET('/api/auth/config', { signal })),

  sendPublicEmailCode: async (body: EmailCodeSendRequest): Promise<EmailCodeSendResponse> =>
    unwrap(await client.POST('/api/auth/email-codes', { body })),

  sendMyEmailCode: async (body: AuthenticatedEmailCodeRequest): Promise<EmailCodeSendResponse> =>
    unwrap(await client.POST('/api/auth/me/email-codes', { body })),

  verifyEmail: async (body: VerifyEmailRequest): Promise<UserProfile> =>
    unwrap(await client.POST('/api/auth/verify-email', { body })),

  resetPassword: async (body: PasswordResetConfirmRequest): Promise<void> => {
    const { error, response } = await client.POST('/api/auth/password/reset', { body })
    if (!response.ok) {
      throw new ApiError(extractErrorMessage(error, fallbackMessage(response)), response.status)
    }
  },

  changePassword: async (body: PasswordChangeRequest): Promise<TokenResponse> => {
    const startEpoch = authEpoch
    const promise = (async () => {
      const data = unwrap(await client.POST('/api/auth/password/change', { body }))
      if (authEpoch !== startEpoch) {
        throw new ApiError('修改密码已取消', 0)
      }
      setAccessToken(data.access_token)
      return data
    })().finally(() => {
      if (inflightChangePassword?.promise === promise) {
        inflightChangePassword = null
      }
    })
    inflightChangePassword = { epoch: startEpoch, promise }
    return promise
  },

  updateProfile: async (body: UserProfileUpdateRequest): Promise<UserProfile> =>
    unwrap(await client.PATCH('/api/auth/me', { body })),

  deleteAccount: async (body: DeleteAccountRequest): Promise<void> => {
    const startEpoch = authEpoch
    const { error, response } = await client.POST('/api/auth/me/delete', { body })
    if (!response.ok) {
      throw new ApiError(extractErrorMessage(error, fallbackMessage(response)), response.status)
    }
    if (authEpoch === startEpoch) {
      setAccessToken(null)
    }
  },

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

  syncStockSnapshot: async (
    code: string,
    signal?: AbortSignal,
    options?: { force?: boolean },
  ): Promise<StockSnapshotPayload> =>
    unwrap(
      await client.POST('/api/stocks/{code}/sync', {
        params: {
          path: { code },
          query: options?.force ? { force: true } : undefined,
        },
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

  getStockScreener: async (
    filters: StockScreenerFilters = {},
    signal?: AbortSignal,
  ): Promise<StockScreenerResponse> => {
    const query: NonNullable<operations['stocks_screen_stocks']['parameters']['query']> = {}
    if (filters.zeroRedOnly) {
      query.zero_red_only = true
    }
    if (filters.maxPePercentile !== undefined) {
      query.max_pe_percentile = filters.maxPePercentile
    }
    if (filters.minRoe !== undefined) {
      query.min_roe = filters.minRoe
    }
    if (filters.minDividendYield !== undefined) {
      query.min_dividend_yield = filters.minDividendYield
    }
    const trimmedIndustry = filters.industry?.trim()
    if (trimmedIndustry) {
      query.industry = trimmedIndustry
    }
    const trimmedQuery = filters.q?.trim()
    if (trimmedQuery) {
      query.q = trimmedQuery
    }
    if (filters.sortBy !== undefined) {
      query.sort_by = filters.sortBy
    }
    if (filters.sortDir !== undefined) {
      query.sort_dir = filters.sortDir
    }
    if (filters.limit !== undefined) {
      query.limit = filters.limit
    }
    return unwrap(
      await client.GET('/api/stocks/screener', {
        params: { query },
        signal,
      }),
    )
  },

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

  getJournalLedger: async (limit = 200, signal?: AbortSignal): Promise<DecisionLedgerReport> =>
    unwrap(
      await client.GET('/api/journal/ledger', {
        params: { query: { limit } },
        signal,
      }),
    ),

  listAlerts: async (limit = 50, signal?: AbortSignal): Promise<AlertDeliveryItem[]> =>
    unwrap(
      await client.GET('/api/alerts', {
        params: { query: { limit } },
        signal,
      }),
    ),

  scanAlerts: async (): Promise<AlertScanSummary> => unwrap(await client.POST('/api/alerts/scan')),

  getAlertPreferences: async (signal?: AbortSignal): Promise<NotificationPreferences> =>
    unwrap(await client.GET('/api/alerts/preferences', { signal })),

  updateAlertPreferences: async (
    body: NotificationPreferencesUpdate,
  ): Promise<NotificationPreferences> =>
    unwrap(await client.PUT('/api/alerts/preferences', { body })),

  listEvents: async (limit = 50, signal?: AbortSignal): Promise<UserEventItem[]> =>
    unwrap(
      await client.GET('/api/events', {
        params: { query: { limit } },
        signal,
      }),
    ),

  runDevilsAdvocate: async (body: DevilsAdvocateRequest): Promise<DevilsAdvocateResponse> =>
    unwrap(await client.POST('/api/ai/devils-advocate', { body })),

  runMdaDiff: async (body: MdaDiffRequest): Promise<MdaDiffResponse> =>
    unwrap(await client.POST('/api/ai/mda-diff', { body })),

  getAiPreferences: async (signal?: AbortSignal): Promise<AiPreferences> =>
    unwrap(await client.GET('/api/ai/preferences', { signal })),

  updateAiPreferences: async (body: AiPreferencesUpdate): Promise<AiPreferences> =>
    unwrap(await client.PUT('/api/ai/preferences', { body })),
}
