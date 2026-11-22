import { QueryClient, type QueryClientConfig } from '@tanstack/react-query'
import { ApiError } from './api'

function shouldRetry(failureCount: number, error: Error): boolean {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
    return false
  }
  return failureCount < 1
}

export function createQueryClient(overrides?: QueryClientConfig): QueryClient {
  return new QueryClient({
    ...overrides,
    defaultOptions: {
      ...overrides?.defaultOptions,
      queries: {
        staleTime: 30_000,
        gcTime: 300_000,
        refetchOnWindowFocus: false,
        retry: shouldRetry,
        ...overrides?.defaultOptions?.queries,
      },
    },
  })
}

export const queryClient = createQueryClient()
