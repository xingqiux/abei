import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  getActiveToken,
  hasActiveToken,
  setStoredToken,
  TOKEN_READY_EVENT,
  UNAUTHORIZED_EVENT,
} from '../api/client'
import { useDialogBehavior } from './abaku/useDialogBehavior'
import { REQUEST_TOKEN_EVENT } from './tokenEvents'
import { resetUserScopedState } from '../store/resetUserScopedState'

const cardStyle = {
  background: 'var(--surface-2)',
  boxShadow: '0 1px 2px 0 rgb(0 0 0 / 0.05), 0 1px 3px 0 rgb(0 0 0 / 0.08)',
  border: '1px solid var(--border-subtle)',
} as const

const inputStyle = {
  background: 'var(--surface-hover)',
  color: 'var(--text-primary)',
  border: '1px solid var(--border-subtle)',
} as const

export function TokenGate({ children }: { children?: ReactNode }) {
  const [open, setOpen] = useState(() => !hasActiveToken())
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const queryClient = useQueryClient()
  const cardRef = useRef<HTMLDivElement>(null)
  useDialogBehavior(open, cardRef)

  useEffect(() => {
    async function show() {
      const tokenAtFailure = getActiveToken()
      // Hide and unmount the authenticated application immediately. This stops
      // mounted queries from issuing more requests while the token is absent.
      setOpen(true)
      await queryClient.cancelQueries()
      // Saving a replacement token can overlap with cleanup for an earlier 401.
      // Do not let that stale event clear fresh queries and reopen the gate.
      if (getActiveToken() !== tokenAtFailure) return
      queryClient.clear()
      resetUserScopedState()
    }
    window.addEventListener(UNAUTHORIZED_EVENT, show)
    window.addEventListener(REQUEST_TOKEN_EVENT, show)
    return () => {
      window.removeEventListener(UNAUTHORIZED_EVENT, show)
      window.removeEventListener(REQUEST_TOKEN_EVENT, show)
    }
  }, [queryClient])

  if (!open) return children

  async function handleSave() {
    const trimmed = value.trim()
    if (!trimmed) {
      setError('请粘贴令牌')
      return
    }
    await queryClient.cancelQueries()
    queryClient.clear()
    resetUserScopedState()
    setStoredToken(trimmed)
    setError(null)
    setValue('')
    setOpen(false)
    // 通知依赖令牌的订阅方（日期范围偏好等）重新启用查询。
    window.dispatchEvent(new CustomEvent(TOKEN_READY_EVENT))
    // 令牌页可能是因 401 弹出的，之前失败的查询需要重新发一遍。
    void queryClient.invalidateQueries()
    void queryClient.refetchQueries()
  }

  return (
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center p-4 bg-[var(--surface-0)] "
      role="dialog"
      aria-modal="true"
      aria-label="设置 API 令牌"
    >
      <div ref={cardRef} tabIndex={-1} className="flex w-full max-w-[420px] flex-col gap-4 rounded-[10px] p-5" style={cardStyle}>
        <div className="flex flex-col gap-1.5">
          <div className="text-[15px] font-semibold text-[var(--text-primary)] ">
            Abaku 算珠
          </div>
          <div className="text-[12.5px] leading-relaxed text-[var(--text-secondary)] ">
            需要 Firefly III 个人访问令牌才能继续。在 Firefly III 个人资料 → OAuth → 个人访问令牌 创建，
            粘贴到下面并保存；令牌只保留在当前浏览器会话，不会经过任何第三方服务器。
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <textarea
            value={value}
            onChange={(e) => {
              setValue(e.target.value)
              setError(null)
            }}
            placeholder="粘贴个人访问令牌…"
            rows={5}
            autoFocus
            className="font-mono tabular-nums w-full resize-none rounded-[6px] px-2.5 py-2 text-[11.5px] outline-none"
            style={{ ...inputStyle, border: `1px solid ${error ? 'var(--danger)' : 'var(--border-subtle)'}` }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void handleSave()
            }}
          />
          {error && (
            <div className="text-[11px] text-[var(--danger)] ">
              {error}
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={() => void handleSave()}
          className="w-full rounded-[6px] px-3 py-2 text-[12.5px] bg-[var(--brand)]  text-white font-semibold"

        >
          保存并继续
        </button>
      </div>
    </div>
  )
}
