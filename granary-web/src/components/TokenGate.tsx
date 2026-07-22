import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  getActiveToken,
  hasActiveToken,
  setStoredToken,
  TOKEN_READY_EVENT,
  UNAUTHORIZED_EVENT,
} from '../api/client'
import { useDialogBehavior } from './granary/useDialogBehavior'
import { REQUEST_TOKEN_EVENT } from './tokenEvents'
import { resetUserScopedState } from '../store/resetUserScopedState'

const cardStyle = {
  background: 'var(--g-surface)',
  boxShadow: 'var(--g-shadow)',
  border: '1px solid var(--g-border)',
} as const

const inputStyle = {
  background: 'var(--g-surface-2)',
  color: 'var(--g-ink)',
  border: '1px solid var(--g-border)',
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
      className="fixed inset-0 z-[300] flex items-center justify-center p-4"
      style={{ background: 'var(--g-bg)' }}
      role="dialog"
      aria-modal="true"
      aria-label="设置 API 令牌"
    >
      <div ref={cardRef} tabIndex={-1} className="flex w-full max-w-[420px] flex-col gap-4 rounded-[10px] p-5" style={cardStyle}>
        <div className="flex flex-col gap-1.5">
          <div className="text-[15px]" style={{ fontWeight: 'var(--g-weight-demibold)', color: 'var(--g-ink)' }}>
            谷仓 Granary
          </div>
          <div className="text-[12.5px] leading-relaxed" style={{ color: 'var(--g-ink-2)' }}>
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
            className="font-num w-full resize-none rounded-[6px] px-2.5 py-2 text-[11.5px] outline-none"
            style={{ ...inputStyle, border: `1px solid ${error ? 'var(--g-danger)' : 'var(--g-border)'}` }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void handleSave()
            }}
          />
          {error && (
            <div className="text-[11px]" style={{ color: 'var(--g-danger)' }}>
              {error}
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={() => void handleSave()}
          className="w-full rounded-[6px] px-3 py-2 text-[12.5px]"
          style={{ background: 'var(--g-accent)', color: 'var(--g-accent-ink)', fontWeight: 'var(--g-weight-demibold)' }}
        >
          保存并继续
        </button>
      </div>
    </div>
  )
}
