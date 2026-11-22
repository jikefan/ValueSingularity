import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react'
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
  const transitionSeqRef = useRef(0)

  const clearUserCaches = useCallback(() => {
    for (const queryKey of USER_SCOPED_QUERY_KEYS) {
      queryClient.removeQueries({ queryKey })
    }
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
      transitionSeqRef.current += 1
      queryClient.setQueryData(queryKeys.auth.me(), null)
      clearUserCaches()
    })
  }, [clearUserCaches, queryClient])

  const login = useCallback(
    async (body: LoginRequest): Promise<UserProfile> => {
      const seq = ++transitionSeqRef.current
      const res = await api.login(body)
      if (seq !== transitionSeqRef.current) {
        return res.user
      }
      await queryClient.cancelQueries({ queryKey: queryKeys.auth.me() })
      if (seq !== transitionSeqRef.current) {
        return res.user
      }
      clearUserCaches()
      queryClient.setQueryData(queryKeys.auth.me(), res.user)
      return res.user
    },
    [clearUserCaches, queryClient],
  )

  const register = useCallback(
    async (body: RegisterRequest): Promise<UserProfile> => {
      const seq = ++transitionSeqRef.current
      const res = await api.register(body)
      if (seq !== transitionSeqRef.current) {
        return res.user
      }
      await queryClient.cancelQueries({ queryKey: queryKeys.auth.me() })
      if (seq !== transitionSeqRef.current) {
        return res.user
      }
      clearUserCaches()
      queryClient.setQueryData(queryKeys.auth.me(), res.user)
      return res.user
    },
    [clearUserCaches, queryClient],
  )

  const logout = useCallback(async (): Promise<void> => {
    const seq = ++transitionSeqRef.current
    queryClient.setQueryData(queryKeys.auth.me(), null)
    clearUserCaches()
    const logoutPromise = api.logout().catch(() => {
      // Clear local session state even if the remote logout call fails.
    })
    await Promise.all([
      queryClient.cancelQueries({ queryKey: queryKeys.auth.me() }),
      ...USER_SCOPED_QUERY_KEYS.map((queryKey) => queryClient.cancelQueries({ queryKey })),
      logoutPromise,
    ])
    if (seq === transitionSeqRef.current) {
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
