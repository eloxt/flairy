import { createContext } from 'react'
import type { LoginRequest, User } from '@flairy/shared'

export interface AuthContextValue {
  user: User | null
  token: string | null
  login: (credentials: LoginRequest) => Promise<void>
  logout: () => void
}

export const AuthContext = createContext<AuthContextValue | null>(null)
