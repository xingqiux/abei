import {
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { LogIn } from 'lucide-react'
import {
  bootstrapInstance,
  clearGranarySession,
  getActiveBookId,
  getBooks,
  getCurrentUser,
  getInstanceInfo,
  login,
  logout,
  refreshCsrfToken,
  setActiveBookId,
  verifyMfaLogin,
  type GranaryBook,
  type GranaryUser,
} from '../api/granary'
import { FireflyApiError, UNAUTHORIZED_EVENT } from '../api/client'
import { resetUserScopedState } from '../store/resetUserScopedState'
import { SessionContext, type SessionContextValue } from './GranarySession'

type Screen = 'loading' | 'bootstrap' | 'login' | 'mfa' | 'ready'

const inputStyle = {
  background: 'var(--g-surface-2)',
  color: 'var(--g-ink)',
  border: '1px solid var(--g-border)',
} as const

export function AuthGate({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()
  const [screen, setScreen] = useState<Screen>('loading')
  const [user, setUser] = useState<GranaryUser | null>(null)
  const [books, setBooks] = useState<GranaryBook[]>([])
  const [activeBook, setActiveBook] = useState<GranaryBook | null>(null)
  const [email, setEmail] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [passwordConfirm, setPasswordConfirm] = useState('')
  const [mfaCode, setMfaCode] = useState('')
  const [mfaChallenge, setMfaChallenge] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function loadAuthenticatedSession() {
    const [currentUser] = await Promise.all([getCurrentUser(), refreshCsrfToken()])
    const availableBooks = await getBooks()
    if (availableBooks.length === 0) throw new FireflyApiError(409, '当前用户没有可访问账本')
    let selectedId: number | null = null
    try {
      selectedId = getActiveBookId()
    } catch {
      selectedId = null
    }
    const selected = availableBooks.find((book) => book.id === selectedId) ?? availableBooks[0]
    setActiveBookId(selected.id)
    setUser(currentUser)
    setBooks(availableBooks)
    setActiveBook(selected)
    setScreen('ready')
  }

  useEffect(() => {
    let cancelled = false
    async function start() {
      try {
        const instance = await getInstanceInfo()
        if (cancelled) return
        if (!instance.initialized) {
          setScreen('bootstrap')
          return
        }
        await loadAuthenticatedSession()
      } catch (reason) {
        if (cancelled) return
        if (reason instanceof FireflyApiError && reason.status === 401) {
          clearGranarySession()
          setScreen('login')
        } else {
          setError(reason instanceof Error ? reason.message : '无法连接 Granary Server')
          setScreen('login')
        }
      }
    }
    function unauthorized() {
      clearGranarySession()
      queryClient.clear()
      resetUserScopedState()
      setUser(null)
      setBooks([])
      setActiveBook(null)
      setScreen('login')
    }
    window.addEventListener(UNAUTHORIZED_EVENT, unauthorized)
    void start()
    return () => {
      cancelled = true
      window.removeEventListener(UNAUTHORIZED_EVENT, unauthorized)
    }
    // Session bootstrap intentionally runs once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function submit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    setPending(true)
    try {
      if (screen === 'bootstrap') {
        if (!displayName.trim()) throw new Error('请输入显示名称')
        if (password !== passwordConfirm) throw new Error('两次输入的密码不一致')
        await bootstrapInstance({
          email: email.trim(),
          display_name: displayName.trim(),
          password,
        })
      }
      const result = await login({ email: email.trim(), password })
      if (result.mfa_required) {
        setMfaChallenge(result.mfa_challenge_token ?? '')
        setScreen('mfa')
        return
      }
      await loadAuthenticatedSession()
      setPassword('')
      setPasswordConfirm('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '登录失败')
    } finally {
      setPending(false)
    }
  }

  async function submitMfa(event: FormEvent) {
    event.preventDefault()
    setError(null)
    setPending(true)
    try {
      await verifyMfaLogin({ challenge_token: mfaChallenge, code: mfaCode.trim() })
      await loadAuthenticatedSession()
      setPassword('')
      setMfaCode('')
      setMfaChallenge('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'MFA 验证失败')
    } finally {
      setPending(false)
    }
  }

  const context = useMemo<SessionContextValue | null>(() => {
    if (!user || !activeBook) return null
    return {
      user,
      books,
      activeBook,
      selectBook: async (bookId) => {
        const selected = books.find((book) => book.id === bookId)
        if (!selected || selected.id === activeBook.id) return
        await queryClient.cancelQueries()
        queryClient.clear()
        resetUserScopedState()
        setActiveBookId(selected.id)
        setActiveBook(selected)
      },
      signOut: async () => {
        try {
          await logout()
        } finally {
          queryClient.clear()
          resetUserScopedState()
          setUser(null)
          setBooks([])
          setActiveBook(null)
          setScreen('login')
        }
      },
    }
  }, [activeBook, books, queryClient, user])

  if (screen === 'loading') {
    return <div className="flex h-full items-center justify-center text-[12.5px]" style={{ color: 'var(--g-ink-2)' }}>正在连接账本...</div>
  }
  if (screen === 'ready' && context) {
    return <SessionContext.Provider value={context}>{children}</SessionContext.Provider>
  }

  const isBootstrap = screen === 'bootstrap'
  return (
    <div className="flex h-full items-center justify-center p-4" style={{ background: 'var(--g-bg)' }}>
      <form onSubmit={screen === 'mfa' ? submitMfa : submit} className="flex w-full max-w-[400px] flex-col gap-4 rounded-[8px] p-5" style={{ background: 'var(--g-surface)', border: '1px solid var(--g-border)', boxShadow: 'var(--g-shadow)' }}>
        <div>
          <div className="text-[16px]" style={{ color: 'var(--g-ink)', fontWeight: 'var(--g-weight-demibold)' }}>谷仓</div>
          <div className="mt-1 text-[12px]" style={{ color: 'var(--g-ink-2)' }}>{screen === 'mfa' ? '双重验证' : isBootstrap ? '初始化私有实例' : '登录账本'}</div>
        </div>
        {screen === 'mfa' ? (
          <Field label="验证码或恢复码"><input autoFocus autoComplete="one-time-code" value={mfaCode} onChange={(event) => setMfaCode(event.target.value)} className="rounded-[6px] px-2.5 py-2" style={inputStyle} /></Field>
        ) : (
          <>
            {isBootstrap && <Field label="显示名称"><input autoFocus value={displayName} onChange={(event) => setDisplayName(event.target.value)} className="rounded-[6px] px-2.5 py-2" style={inputStyle} /></Field>}
            <Field label="邮箱"><input autoFocus={!isBootstrap} type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} className="rounded-[6px] px-2.5 py-2" style={inputStyle} /></Field>
            <Field label="密码"><input type="password" autoComplete={isBootstrap ? 'new-password' : 'current-password'} value={password} onChange={(event) => setPassword(event.target.value)} className="rounded-[6px] px-2.5 py-2" style={inputStyle} /></Field>
            {isBootstrap && <Field label="确认密码"><input type="password" autoComplete="new-password" value={passwordConfirm} onChange={(event) => setPasswordConfirm(event.target.value)} className="rounded-[6px] px-2.5 py-2" style={inputStyle} /></Field>}
          </>
        )}
        {error && <div className="text-[12px]" style={{ color: 'var(--g-danger)' }}>{error}</div>}
        <button type="submit" disabled={pending} className="flex items-center justify-center gap-1.5 rounded-[6px] px-3 py-2 text-[12.5px] disabled:opacity-50" style={{ background: 'var(--g-accent)', color: 'var(--g-accent-ink)', fontWeight: 'var(--g-weight-demibold)' }}>
          <LogIn size={14} aria-hidden />
          {pending ? '处理中...' : screen === 'mfa' ? '验证' : isBootstrap ? '创建并登录' : '登录'}
        </button>
      </form>
    </div>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="flex flex-col gap-1 text-[12px]" style={{ color: 'var(--g-ink-2)' }}><span>{label}</span>{children}</label>
}
