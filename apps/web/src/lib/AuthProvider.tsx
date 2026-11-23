import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react'
import type {
  DeleteAccountRequest,
  LoginRequest,
  PasswordChangeRequest,
  RegisterRequest,
  UserProfile,
  UserProfileUpdateRequest,
  VerifyEmailRequest,
} from '../types/api'
import { api, getAccessToken, subscribeAuthExpired } from './api'
import { AuthContext, type AuthContextValue } from './authContext'
import { queryKeys } from './queryKeys'

const USER_SCOPED_QUERY_KEYS = [
  queryKeys.watchlist.all,
  queryKeys.journal.all,
  queryKeys.alerts.all,
  queryKeys.events.all,
  queryKeys.ai.all,
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
  const sessionEpochRef = useRef(0)
  const profileUpdateSeqRef = useRef(0)

  const clearUserCaches = useCallback(() => {
    for (const queryKey of USER_SCOPED_QUERY_KEYS) {
      void queryClient.cancelQueries({ queryKey })
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
      sessionEpochRef.current += 1
      queryClient.setQueryData(queryKeys.auth.me(), null)
      clearUserCaches()
    })
  }, [clearUserCaches, queryClient])

  const applySessionTransition = useCallback(
    async (run: () => Promise<UserProfile>): Promise<UserProfile> => {
      const seq = ++sessionEpochRef.current
      const nextUser = await run()
      if (seq !== sessionEpochRef.current) {
        return nextUser
      }
      await queryClient.cancelQueries({ queryKey: queryKeys.auth.me() })
      if (seq !== sessionEpochRef.current) {
        return nextUser
      }
      clearUserCaches()
      queryClient.setQueryData(queryKeys.auth.me(), nextUser)
      return nextUser
    },
    [clearUserCaches, queryClient],
  )

  const applyInSessionUserMerge = useCallback(
    async (
      run: () => Promise<UserProfile>,
      merge: (prev: UserProfile, nextUser: UserProfile) => UserProfile,
    ): Promise<UserProfile> => {
      const seq = sessionEpochRef.current
      const nextUser = await run()
      if (seq !== sessionEpochRef.current) {
        return nextUser
      }
      await queryClient.cancelQueries({ queryKey: queryKeys.auth.me() })
      if (seq !== sessionEpochRef.current) {
        return nextUser
      }
      queryClient.setQueryData<UserProfile | null>(queryKeys.auth.me(), (prev) =>
        prev ? merge(prev, nextUser) : nextUser,
      )
      return nextUser
    },
    [queryClient],
  )

  const login = useCallback(
    (body: LoginRequest): Promise<UserProfile> =>
      applySessionTransition(async () => (await api.login(body)).user),
    [applySessionTransition],
  )

  const register = useCallback(
    (body: RegisterRequest): Promise<UserProfile> =>
      applySessionTransition(async () => (await api.register(body)).user),
    [applySessionTransition],
  )

  const updateProfile = useCallback(
    (body: UserProfileUpdateRequest): Promise<UserProfile> => {
      const profileSeq = ++profileUpdateSeqRef.current
      return applyInSessionUserMerge(
        () => api.updateProfile(body),
        (prev, nextUser) => ({
          ...prev,
          ...nextUser,
          display_name:
            profileSeq === profileUpdateSeqRef.current ? nextUser.display_name : prev.display_name,
          email_verified: prev.email_verified || nextUser.email_verified,
        }),
      )
    },
    [applyInSessionUserMerge],
  )

  const verifyEmail = useCallback(
    (body: VerifyEmailRequest): Promise<UserProfile> =>
      applyInSessionUserMerge(
        () => api.verifyEmail(body),
        (prev, nextUser) => ({
          ...prev,
          ...nextUser,
          display_name: prev.display_name,
          email_verified: prev.email_verified || nextUser.email_verified,
        }),
      ),
    [applyInSessionUserMerge],
  )

  const changePassword = useCallback(
    (body: PasswordChangeRequest): Promise<UserProfile> =>
      applyInSessionUserMerge(
        async () => (await api.changePassword(body)).user,
        (prev, nextUser) => ({
          ...prev,
          ...nextUser,
          display_name: prev.display_name,
          email_verified: prev.email_verified || nextUser.email_verified,
        }),
      ),
    [applyInSessionUserMerge],
  )

  const logout = useCallback(async (): Promise<void> => {
    const seq = ++sessionEpochRef.current
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
    if (seq === sessionEpochRef.current) {
      queryClient.setQueryData(queryKeys.auth.me(), null)
      clearUserCaches()
    }
  }, [clearUserCaches, queryClient])

  const deleteAccount = useCallback(
    async (body: DeleteAccountRequest): Promise<void> => {
      const seq = ++sessionEpochRef.current
      await api.deleteAccount(body)
      if (seq !== sessionEpochRef.current) {
        return
      }
      const commitSeq = ++sessionEpochRef.current
      queryClient.setQueryData(queryKeys.auth.me(), null)
      clearUserCaches()
      await Promise.all([
        queryClient.cancelQueries({ queryKey: queryKeys.auth.me() }),
        ...USER_SCOPED_QUERY_KEYS.map((queryKey) => queryClient.cancelQueries({ queryKey })),
      ])
      if (commitSeq === sessionEpochRef.current) {
        queryClient.setQueryData(queryKeys.auth.me(), null)
        clearUserCaches()
      }
    },
    [clearUserCaches, queryClient],
  )

  const value = useMemo<AuthContextValue>(
    () => ({
      user: data ?? null,
      isAuthLoading: isPending,
      login,
      register,
      logout,
      updateProfile,
      verifyEmail,
      changePassword,
      deleteAccount,
    }),
    [
      data,
      isPending,
      login,
      register,
      logout,
      updateProfile,
      verifyEmail,
      changePassword,
      deleteAccount,
    ],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
