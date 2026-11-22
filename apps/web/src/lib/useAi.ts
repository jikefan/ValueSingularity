import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  AiPreferences,
  AiPreferencesUpdate,
  AiQuotaStatus,
  DevilsAdvocateRequest,
  DevilsAdvocateResponse,
  MdaDiffRequest,
  MdaDiffResponse,
  UserProfile,
} from '../types/api'
import { ApiError, api, getAuthEpoch } from './api'
import { queryKeys } from './queryKeys'

type AiMutationContext = {
  startEpoch: number
  startUserId: string | null
}

function getAuthenticatedUserId(queryClient: ReturnType<typeof useQueryClient>): string | null {
  return queryClient.getQueryData<UserProfile | null>(queryKeys.auth.me())?.id ?? null
}

function canCommitAiCacheUpdate(
  queryClient: ReturnType<typeof useQueryClient>,
  context: AiMutationContext | undefined,
): context is { startEpoch: number; startUserId: string } {
  if (context === undefined || context.startUserId === null) {
    return false
  }
  if (getAuthEpoch() !== context.startEpoch) {
    return false
  }
  const activeUser = queryClient.getQueryData<UserProfile | null>(queryKeys.auth.me())
  return Boolean(activeUser) && activeUser?.id === context.startUserId
}

function canHandleSessionBoundError(
  queryClient: ReturnType<typeof useQueryClient>,
  context: AiMutationContext | undefined,
): boolean {
  if (context === undefined || getAuthEpoch() !== context.startEpoch) {
    return false
  }
  return Boolean(queryClient.getQueryData<UserProfile | null>(queryKeys.auth.me()))
}

function syncCachedAiQuota(
  queryClient: ReturnType<typeof useQueryClient>,
  quota: AiQuotaStatus,
): void {
  if (queryClient.getQueryData<AiPreferences>(queryKeys.ai.preferences()) === undefined) {
    return
  }
  queryClient.setQueryData<AiPreferences>(queryKeys.ai.preferences(), (prev) =>
    prev ? { ...prev, quota } : prev,
  )
}

export function useAiPreferences(enabled = true) {
  return useQuery({
    queryKey: queryKeys.ai.preferences(),
    queryFn: ({ signal }) => api.getAiPreferences(signal),
    enabled,
  })
}

export function useCachedDevilsAdvocate(userKey: string | null, code: string) {
  return useQuery<DevilsAdvocateResponse>({
    queryKey: queryKeys.ai.devilsAdvocate(userKey ?? 'guest', code),
    queryFn: () => Promise.reject(new Error('Cached Devils Advocate query should not fetch')),
    enabled: false,
    staleTime: Infinity,
  })
}

export function useCachedMdaDiff(userKey: string | null, code: string) {
  return useQuery<MdaDiffResponse>({
    queryKey: queryKeys.ai.mdaDiff(userKey ?? 'guest', code),
    queryFn: () => Promise.reject(new Error('Cached MD&A Diff query should not fetch')),
    enabled: false,
    staleTime: Infinity,
  })
}

export function clearCachedDevilsAdvocate(
  queryClient: ReturnType<typeof useQueryClient>,
  userKey: string,
  code: string,
): void {
  const queryKey = queryKeys.ai.devilsAdvocate(userKey, code)
  void queryClient.resetQueries({ queryKey, exact: true })
  queryClient.removeQueries({ queryKey, exact: true })
}

export function clearCachedMdaDiff(
  queryClient: ReturnType<typeof useQueryClient>,
  userKey: string,
  code: string,
): void {
  const queryKey = queryKeys.ai.mdaDiff(userKey, code)
  void queryClient.resetQueries({ queryKey, exact: true })
  queryClient.removeQueries({ queryKey, exact: true })
}

export function useUpdateAiPreferences() {
  const queryClient = useQueryClient()
  return useMutation<AiPreferences, Error, AiPreferencesUpdate, AiMutationContext>({
    onMutate: () => ({
      startEpoch: getAuthEpoch(),
      startUserId: getAuthenticatedUserId(queryClient),
    }),
    mutationFn: (body) => api.updateAiPreferences(body),
    onSuccess: (updated, _variables, context) => {
      if (!canCommitAiCacheUpdate(queryClient, context)) {
        return
      }
      queryClient.setQueryData(queryKeys.ai.preferences(), updated)
    },
  })
}

export function useDevilsAdvocate() {
  const queryClient = useQueryClient()
  return useMutation<DevilsAdvocateResponse, Error, DevilsAdvocateRequest, AiMutationContext>({
    onMutate: () => ({
      startEpoch: getAuthEpoch(),
      startUserId: getAuthenticatedUserId(queryClient),
    }),
    mutationFn: (body) => api.runDevilsAdvocate(body),
    onSuccess: (res, variables, context) => {
      if (!canCommitAiCacheUpdate(queryClient, context)) {
        return
      }
      syncCachedAiQuota(queryClient, res.quota)
      if (res.code === variables.code) {
        queryClient.setQueryData(queryKeys.ai.devilsAdvocate(context.startUserId, res.code), res)
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.events.all })
    },
    onError: (error, _variables, context) => {
      if (
        error instanceof ApiError &&
        error.status === 429 &&
        canHandleSessionBoundError(queryClient, context)
      ) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.ai.preferences() })
      }
    },
  })
}

export function useMdaDiff() {
  const queryClient = useQueryClient()
  return useMutation<MdaDiffResponse, Error, MdaDiffRequest, AiMutationContext>({
    onMutate: () => ({
      startEpoch: getAuthEpoch(),
      startUserId: getAuthenticatedUserId(queryClient),
    }),
    mutationFn: (body) => api.runMdaDiff(body),
    onSuccess: (res, variables, context) => {
      if (!canCommitAiCacheUpdate(queryClient, context)) {
        return
      }
      syncCachedAiQuota(queryClient, res.quota)
      if (res.code === variables.code) {
        queryClient.setQueryData(queryKeys.ai.mdaDiff(context.startUserId, res.code), res)
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.events.all })
    },
    onError: (error, _variables, context) => {
      if (
        error instanceof ApiError &&
        error.status === 429 &&
        canHandleSessionBoundError(queryClient, context)
      ) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.ai.preferences() })
      }
    },
  })
}
