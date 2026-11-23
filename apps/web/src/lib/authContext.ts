import { createContext, useContext } from 'react'
import type {
  DeleteAccountRequest,
  LoginRequest,
  PasswordChangeRequest,
  RegisterRequest,
  UserProfile,
  UserProfileUpdateRequest,
  VerifyEmailRequest,
} from '../types/api'

export type AuthContextValue = {
  user: UserProfile | null
  isAuthLoading: boolean
  login: (body: LoginRequest) => Promise<UserProfile>
  register: (body: RegisterRequest) => Promise<UserProfile>
  logout: () => Promise<void>
  updateProfile: (body: UserProfileUpdateRequest) => Promise<UserProfile>
  verifyEmail: (body: VerifyEmailRequest) => Promise<UserProfile>
  changePassword: (body: PasswordChangeRequest) => Promise<UserProfile>
  deleteAccount: (body: DeleteAccountRequest) => Promise<void>
}

export const AuthContext = createContext<AuthContextValue | null>(null)

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) {
    throw new Error('useAuth must be used within AuthProvider')
  }
  return ctx
}
