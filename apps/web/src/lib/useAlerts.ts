import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { NotificationPreferencesUpdate } from '../types/api'
import { api } from './api'
import { queryKeys } from './queryKeys'

export function useAlerts(enabled = true, limit = 50) {
  return useQuery({
    queryKey: queryKeys.alerts.list(limit),
    queryFn: ({ signal }) => api.listAlerts(limit, signal),
    enabled,
  })
}

export function useScanAlerts() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => api.scanAlerts(),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.alerts.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.events.all }),
      ])
    },
  })
}

export function useAlertPreferences(enabled = true) {
  return useQuery({
    queryKey: queryKeys.alerts.preferences(),
    queryFn: ({ signal }) => api.getAlertPreferences(signal),
    enabled,
  })
}

export function useUpdateAlertPreferences() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: NotificationPreferencesUpdate) => api.updateAlertPreferences(body),
    onSuccess: async (updated) => {
      queryClient.setQueryData(queryKeys.alerts.preferences(), updated)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.alerts.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.events.all }),
      ])
    },
  })
}
