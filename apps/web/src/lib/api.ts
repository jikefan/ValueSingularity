import type { Health, MarketOverview } from '../types/api'

export class ApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

async function get<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    headers: { Accept: 'application/json' },
    ...init,
  })

  if (!response.ok) {
    let detail = response.statusText
    try {
      const body: unknown = await response.json()
      if (body && typeof body === 'object' && 'detail' in body) {
        detail = String(body.detail)
      }
    } catch {
      // keep statusText
    }
    throw new ApiError(detail, response.status)
  }

  return (await response.json()) as T
}

export const api = {
  health: () => get<Health>('/health'),
  marketOverview: () => get<MarketOverview>('/market/overview'),
}
