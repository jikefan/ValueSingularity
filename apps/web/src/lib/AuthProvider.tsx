import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, type ReactNode } from 'react'
import type { LoginRequest, RegisterRequest, UserProfile } from '../types/api'
import { api, getAccessToken, subscribeAuthExpired } from './api'
import { AuthContext, type AuthContextValue } from './authContext'
import { queryKeys } from './queryKeys'

const USER_SCOPED_QUERY_KEYS = [
  queryKeys.watchlist.all,
  queryKeys.journal.all,
  queryKeys.events.all,
] as const

async function bootstrapSession(signal?: AbortSignal): Promise<UserProfile | null> {
  if (!getAccessToken()) {
    const session = await api.refreshSession()
    return session ? session.user : null
  }
  return api.me(signal)
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()

  const clearUserCaches = useCallback(() => {
    for (const queryKey of USER_SCOPED_QUERY_KEYS) {
      queryClient.removeQueries({ queryKey })
    }
  }, [queryClient])

  const resetUserCaches = useCallback(async () => {
    await Promise.all(
      USER_SCOPED_QUERY_KEYS.map((queryKey) => queryClient.resetQueries({ queryKey })),
    )
  }, [queryClient])

  const { data, isPending } = useQuery({
    queryKey: queryKeys.auth.me(),
    queryFn: ({ signal }) => bootstrapSession(signal),
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  })

  useEffect(() => {
    return subscribeAuthExpired(() => {
      queryClient.setQueryData(queryKeys.auth.me(), null)
      clearUserCaches()
    })
  }, [clearUserCaches, queryClient])

  const login = useCallback(
    async (body: LoginRequest): Promise<UserProfile> => {
      const res = await api.login(body)
      await queryClient.cancelQueries({ queryKey: queryKeys.auth.me() })
      queryClient.setQueryData(queryKeys.auth.me(), res.user)
      await resetUserCaches()
      return res.user
    },
    [queryClient, resetUserCaches],
  )

  const register = useCallback(
    async (body: RegisterRequest): Promise<UserProfile> => {
      const res = await api.register(body)
      await queryClient.cancelQueries({ queryKey: queryKeys.auth.me() })
      queryClient.setQueryData(queryKeys.auth.me(), res.user)
      await resetUserCaches()
      return res.user
    },
    [queryClient, resetUserCaches],
  )

  const logout = useCallback(async (): Promise<void> => {
    try {
      await api.logout()
    } catch {
      // Clear local session state even if the remote logout call fails.
    } finally {
      await queryClient.cancelQueries({ queryKey: queryKeys.auth.me() })
      queryClient.setQueryData(queryKeys.auth.me(), null)
      clearUserCaches()
    }
  }, [clearUserCaches, queryClient])

  const value = useMemo<AuthContextValue>(
    () => ({
      user: data ?? null,
      isAuthLoading: isPending,
      login,
      register,
      logout,
    }),
    [data, isPending, login, register, logout],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
