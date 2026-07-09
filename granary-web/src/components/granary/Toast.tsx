import { useLayoutEffect, useRef } from 'react'
import gsap from 'gsap'
import { useToastStore, type ToastItem } from '../../store/toastStore'
import { prefersReducedMotion } from '../../motion/reducedMotion'
import { LottieIcon, type LottieIconKind } from './LottieIcon'

const ICON_KIND: Record<ToastItem['kind'], LottieIconKind> = {
  success: 'success',
  error: 'error',
  loading: 'loading',
  inbox: 'inbox',
}

const BORDER_COLOR: Record<ToastItem['kind'], string> = {
  success: 'var(--g-income)',
  error: 'var(--g-danger)',
  loading: 'var(--g-accent)',
  inbox: 'var(--g-warn)',
}

function ToastCard({ toast, onDismiss }: { toast: ToastItem; onDismiss: () => void }) {
  const ref = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    if (prefersReducedMotion()) return
    gsap.fromTo(
      el,
      { opacity: 0, y: -8, scale: 0.98 },
      { opacity: 1, y: 0, scale: 1, duration: 0.24, ease: 'power3.out' },
    )
  }, [])

  return (
    <div
      ref={ref}
      role="status"
      className="flex items-center gap-2.5 rounded-[10px] py-2.5 pl-3 pr-3.5"
      style={{
        background: 'var(--g-surface)',
        boxShadow: 'var(--g-shadow)',
        border: '1px solid var(--g-border)',
        borderLeft: `3px solid ${BORDER_COLOR[toast.kind]}`,
        minWidth: 260,
        maxWidth: 360,
      }}
    >
      <LottieIcon kind={ICON_KIND[toast.kind]} size={18} />
      <div className="flex-1 text-[12.5px]" style={{ color: 'var(--g-ink)' }}>
        {toast.message}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="关闭"
        className="shrink-0 text-[13px] leading-none"
        style={{ color: 'var(--g-ink-2)' }}
      >
        ×
      </button>
    </div>
  )
}

/** 全局唯一挂载，右上角固定容器 */
export function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts)
  const dismiss = useToastStore((s) => s.dismiss)

  if (toasts.length === 0) return null

  return (
    <div
      className="fixed right-5 top-5 flex flex-col gap-2"
      style={{ zIndex: 100 }}
      aria-live="polite"
    >
      {toasts.map((toast) => (
        <ToastCard key={toast.id} toast={toast} onDismiss={() => dismiss(toast.id)} />
      ))}
    </div>
  )
}
