import { createContext, useContext } from 'react'
import type { LoginRequest, RegisterRequest, UserProfile } from '../types/api'

export type AuthContextValue = {
  user: UserProfile | null
  isAuthLoading: boolean
  login: (body: LoginRequest) => Promise<UserProfile>
  register: (body: RegisterRequest) => Promise<UserProfile>
  logout: () => Promise<void>
}

export const AuthContext = createContext<AuthContextValue | null>(null)

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) {
    throw new Error('useAuth must be used within AuthProvider')
  }
  return ctx
}
