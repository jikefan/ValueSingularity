import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { JournalCreate } from '../types/api'
import { api } from './api'
import { queryKeys } from './queryKeys'

export function useJournal(code?: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.journal.list(code),
    queryFn: ({ signal }) => api.listJournal(code, 50, signal),
    enabled,
  })
}

export function useCreateJournal() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: JournalCreate) => api.createJournal(body),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.journal.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.events.all }),
      ])
    },
  })
}

export function useRemoveJournal() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (entryId: number) => api.removeJournal(entryId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.journal.all }),
  })
}
