import { createContext, useContext } from 'react'
import type { GranaryBook, GranaryUser } from '../api/granary'

export interface SessionContextValue {
  user: GranaryUser
  books: GranaryBook[]
  activeBook: GranaryBook
  selectBook: (bookId: number) => Promise<void>
  signOut: () => Promise<void>
}

export const SessionContext = createContext<SessionContextValue | null>(null)

export function useGranarySession(): SessionContextValue {
  const value = useContext(SessionContext)
  if (!value) throw new Error('useGranarySession 必须在 AuthGate 内使用')
  return value
}
