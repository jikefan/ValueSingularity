import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createQueryClient } from './queryClient'
import { useStockSnapshot } from './useStockAnalysis'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function asRequest(input: RequestInfo | URL): Request {
  if (input instanceof Request) {
    return input
  }
  throw new Error('Expected Request instance')
}

describe('useStockSnapshot', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('respects ensureOnDemand=false by keeping 404 without triggering /sync', async () => {
    const calls: Array<{ method: string; pathname: string }> = []

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const request = asRequest(input)
      const pathname = new URL(request.url).pathname
      calls.push({ method: request.method, pathname })
      if (pathname === '/api/stocks/600519/snapshot') {
        return Promise.resolve(jsonResponse({ detail: '尚未生成快照' }, 404))
      }
      return Promise.resolve(jsonResponse({ detail: `Unhandled ${pathname}` }, 500))
    })

    const client = createQueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    )

    const { result } = renderHook(
      () => useStockSnapshot('600519', { enabled: true, ensureOnDemand: false }),
      { wrapper },
    )

    await waitFor(() => {
      expect(result.current.isError).toBe(true)
    })

    expect(calls).toEqual([{ method: 'GET', pathname: '/api/stocks/600519/snapshot' }])
  })
})
