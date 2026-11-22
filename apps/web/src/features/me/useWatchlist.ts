import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { queryKeys } from '../../lib/queryKeys'
import type { WatchlistUpsert } from '../../types/api'

export function useWatchlist(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.watchlist.list(),
    queryFn: ({ signal }) => api.listWatchlist(signal),
    enabled,
  })
}

export function useUpsertWatchlist() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: WatchlistUpsert) => api.upsertWatchlist(body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.watchlist.all }),
  })
}

export function useRemoveWatchlist() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (code: string) => api.removeWatchlist(code),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.watchlist.all }),
  })
}
