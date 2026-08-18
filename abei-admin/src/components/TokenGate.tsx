import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  hasActiveToken,
  setStoredToken,
  TOKEN_READY_EVENT,
  UNAUTHORIZED_EVENT,
} from '../api/client'
import { useDialogBehavior } from './abei/useDialogBehavior'
import { REQUEST_TOKEN_EVENT } from './tokenEvents'
import { useToastStore } from '../store/toastStore'
import { AbeiMark } from './abei/AbeiMark'
import { Button } from './ui/Button'
import { Card } from './ui/Card'
import { Field, Textarea } from './ui/Field'

/**
 * 令牌闸门。
 *
 * 早先这里是「401 就把 children 卸载 + queryClient.clear()」。代价是：正在写的规则条件、
 * 编到一半的 YAML、填了一半的表单，全部随组件一起没了——而令牌过期跟这些草稿毫无关系，
 * 重新粘一次令牌本该能接着编。所以现在它是覆盖在应用之上的一层：children 始终挂着，
 * 缓存也不清，只把在飞的请求取消掉；存好新令牌后原地重发一遍失败的查询。
 */
export function TokenGate({ children }: { children?: ReactNode }) {
  const [open, setOpen] = useState(() => !hasActiveToken())
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const queryClient = useQueryClient()
  const cardRef = useRef<HTMLDivElement>(null)
  useDialogBehavior(open, cardRef)
  /**
   * 进门时没令牌就别挂 children：那样每个查询都会先打一发注定 401 的请求。
   * 一旦挂过（有过令牌），之后再过期也不卸载——这正是不丢编辑内容的地方。
   */
  const everAuthorized = useRef(hasActiveToken())
  if (!open) everAuthorized.current = true

  useEffect(() => {
    function show() {
      setOpen(true)
      // 取消在飞的请求就够了：没有令牌时它们只会一路 401。缓存留着——
      // 缓存里是数据，编辑器里是人写了一半的东西，两者都不该为一次过期陪葬。
      void queryClient.cancelQueries()
    }
    window.addEventListener(UNAUTHORIZED_EVENT, show)
    window.addEventListener(REQUEST_TOKEN_EVENT, show)
    return () => {
      window.removeEventListener(UNAUTHORIZED_EVENT, show)
      window.removeEventListener(REQUEST_TOKEN_EVENT, show)
    }
  }, [queryClient])

  async function handleSave() {
    const trimmed = value.trim()
    if (!trimmed) {
      setError('请粘贴令牌')
      return
    }
    await queryClient.cancelQueries()
    useToastStore.getState().clear()
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
    <>
      {everAuthorized.current && children}
      {open && <TokenOverlay
        cardRef={cardRef}
        value={value}
        error={error}
        onChange={(next) => { setValue(next); setError(null) }}
        onSave={() => void handleSave()}
      />}
    </>
  )
}

function TokenOverlay({
  cardRef,
  value,
  error,
  onChange,
  onSave,
}: {
  cardRef: RefObject<HTMLDivElement | null>
  value: string
  error: string | null
  onChange: (value: string) => void
  onSave: () => void
}) {
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
            <AbeiMark size={24} />
            <span className="text-[15px] font-semibold text-[var(--text-primary)]">阿贝</span>
          </div>
          <p className="text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
            需要 Firefly III 个人访问令牌才能继续。在 Firefly III 个人资料 → OAuth → 个人访问令牌 创建，
            粘贴到下面并保存；令牌只保留在当前浏览器会话，不会经过任何第三方服务器。
          </p>
        </div>

        <Field label="个人访问令牌" srOnlyLabel error={error ?? undefined} hint="粘贴后按 Cmd/Ctrl + Enter 也能保存">
          <Textarea
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="粘贴个人访问令牌…"
            rows={5}
            autoFocus
            className="resize-none font-mono text-[11.5px] tabular-nums"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) onSave()
            }}
          />
        </Field>

        <p className="text-[11.5px] text-[var(--text-tertiary)]">
          页面上没保存的编辑还在，保存令牌后可以接着改。
        </p>

        <Button variant="primary" size="md" block onClick={onSave}>
          保存并继续
        </Button>
      </Card>
    </div>
  )
}
