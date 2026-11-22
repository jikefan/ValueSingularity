import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { WatchlistItem, WatchlistUpsert } from '../types/api'
import { api } from './api'
import { queryKeys } from './queryKeys'

export function useWatchlist(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.watchlist.list(),
    queryFn: ({ signal }) => api.listWatchlist(signal),
    enabled,
  })
}

export function useAddWatchlist() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: WatchlistUpsert) => api.addWatchlist(body),
    onSuccess: (created) => {
      queryClient.setQueryData<WatchlistItem[]>(queryKeys.watchlist.list(), (prev) => {
        if (!prev) {
          return [created]
        }
        return prev.some((item) => item.code === created.code) ? prev : [created, ...prev]
      })
      return queryClient.invalidateQueries({ queryKey: queryKeys.watchlist.all })
    },
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
