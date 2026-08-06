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
import { AbakuMark } from './abaku/AbakuMark'
import { Button } from './ui/Button'
import { Card } from './ui/Card'
import { Field, Textarea } from './ui/Field'

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
      className="fixed inset-0 z-[300] flex items-center justify-center bg-[var(--surface-0)] p-4"
      role="dialog"
      aria-modal="true"
      aria-label="设置 API 令牌"
    >
      <Card ref={cardRef} tabIndex={-1} className="flex w-full max-w-[420px] flex-col gap-4 p-5">
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <AbakuMark className="size-6" />
            <span className="text-[15px] font-semibold text-[var(--text-primary)]">Abaku 算珠</span>
          </div>
          <p className="text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
            需要 Firefly III 个人访问令牌才能继续。在 Firefly III 个人资料 → OAuth → 个人访问令牌 创建，
            粘贴到下面并保存；令牌只保留在当前浏览器会话，不会经过任何第三方服务器。
          </p>
        </div>

        <Field label="个人访问令牌" srOnlyLabel error={error ?? undefined} hint="粘贴后按 Cmd/Ctrl + Enter 也能保存">
          <Textarea
            value={value}
            onChange={(e) => {
              setValue(e.target.value)
              setError(null)
            }}
            placeholder="粘贴个人访问令牌…"
            rows={5}
            autoFocus
            className="resize-none font-mono text-[11.5px] tabular-nums"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void handleSave()
            }}
          />
        </Field>

        <Button variant="primary" size="md" block onClick={() => void handleSave()}>
          保存并继续
        </Button>
      </Card>
    </div>
  )
}
