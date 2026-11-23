import { useQuery } from '@tanstack/react-query'
import type { AuthConfigResponse } from '../types/api'
import { api } from './api'
import { queryKeys } from './queryKeys'

export const DEFAULT_AUTH_CONFIG: AuthConfigResponse = {
  email_verification_required: false,
  smtp_configured: false,
  code_ttl_minutes: 10,
  code_cooldown_seconds: 60,
}

export function useAuthConfig(enabled = true) {
  return useQuery({
    queryKey: queryKeys.auth.config(),
    queryFn: ({ signal }) => api.getAuthConfig(signal),
    enabled,
    staleTime: 60_000,
  })
}
