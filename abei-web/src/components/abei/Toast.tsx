import { useLayoutEffect, useRef } from 'react'
import { Link } from '@tanstack/react-router'
import { X } from '@phosphor-icons/react'
import gsap from 'gsap'
import { useToastStore, type ToastItem } from '../../store/toastStore'
import { prefersReducedMotion } from '../../motion/reducedMotion'
import { LottieIcon, type LottieIconKind } from './LottieIcon'
import { IconButton } from '../ui/Button'

const ICON_KIND: Record<ToastItem['kind'], LottieIconKind> = {
  success: 'success',
  error: 'error',
  loading: 'loading',
  inbox: 'inbox',
}

/** 左侧竖条颜色：不靠图标一个信号传达「成功还是出错」 */
const ACCENT: Record<ToastItem['kind'], string> = {
  success: 'border-l-[var(--done)]',
  error: 'border-l-[var(--danger)]',
  loading: 'border-l-[var(--brand-text)]',
  inbox: 'border-l-[var(--attention-mark)]',
}

/**
 * 提示卡片。版式取自 tailwind-plus `overlays/notifications/simple`：
 * 左图标 / 中文案 / 右关闭，关闭是 X 而不是一个「×」字符
 * （字符在不同字体下大小和基线都会飘）。
 * 进场动画留 GSAP，已经处理了 reduced-motion。
 */
/** 动作词的样式：链接型和按钮型必须长得一样，否则同一个位置两种观感 */
const ACTION_CLASS = 'ml-2 font-semibold text-[var(--brand-text)] underline-offset-2 hover:underline'

function ToastCard({ toast, onDismiss }: { toast: ToastItem; onDismiss: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const action = toast.action

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
      className={`pointer-events-auto flex w-full max-w-sm min-w-[260px] items-start gap-3 rounded-lg border-l-[3px] bg-[var(--surface-2)] p-3 shadow-[var(--shadow-pop)] ring-1 ring-[var(--border-subtle)] ${ACCENT[toast.kind]}`}
    >
      <span className="mt-0.5 shrink-0">
        <LottieIcon kind={ICON_KIND[toast.kind]} size={18} />
      </span>
      <p className="flex-1 text-sm text-[var(--text-primary)]">
        {toast.message}
        {action?.to !== undefined && (
          <Link to={action.to} onClick={onDismiss} className={ACTION_CLASS}>
            {action.label}
          </Link>
        )}
        {action !== undefined && action.to === undefined && action.onClick !== undefined && (
          // 就地动作（「撤销」）：点完先关掉这条提示，回调再跑。
          // 让它留着的话，撤销的结果提示会叠在原提示上面，看着像没生效。
          <button
            type="button"
            onClick={() => {
              onDismiss()
              action.onClick?.()
            }}
            className={ACTION_CLASS}
          >
            {action.label}
          </button>
        )}
      </p>
      <IconButton label="关闭" className="-m-1 size-6" onClick={onDismiss}>
        <X aria-hidden className="size-4" />
      </IconButton>
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
      // 层级要压过弹窗（Modal 是 z-200）：入账失败的提示原来被遮罩盖着，
      // 用户在弹窗里只看到「没反应」，于是再点一次。
      className="pointer-events-none fixed top-5 right-5 z-[210] flex flex-col items-end gap-2"
      aria-live="polite"
    >
      {toasts.map((toast) => (
        <ToastCard key={toast.id} toast={toast} onDismiss={() => dismiss(toast.id)} />
      ))}
    </div>
  )
}
