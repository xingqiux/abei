import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import gsap from 'gsap'
import { XMarkIcon } from '@heroicons/react/20/solid'
import { prefersReducedMotion } from '../../motion/reducedMotion'
import { useDialogBehavior } from './useDialogBehavior'

/**
 * 通用确认/信息弹层：surface 底、阴影+1px 描边、240ms 入场，Esc 关闭（规范 §5/§6）。
 * 破坏性操作确认框（忽略任务等）必须在 children 里写明对象名与数量。
 */
export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  width = 440,
}: {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  footer?: ReactNode
  width?: number
}) {
  const cardRef = useRef<HTMLDivElement>(null)
  useDialogBehavior(open, cardRef, onClose)

  useLayoutEffect(() => {
    if (!open) return
    const el = cardRef.current
    if (!el || prefersReducedMotion()) return
    gsap.fromTo(
      el,
      { opacity: 0, y: -8, scale: 0.98 },
      { opacity: 1, y: 0, scale: 1, duration: 0.24, ease: 'power3.out' },
    )
  }, [open])

  if (!open) return null

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center p-4"
      style={{ background: 'rgb(0 0 0 / 0.5)' }}
      onClick={onClose}
      role="presentation"
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[86vh] w-full flex-col rounded-xl bg-white shadow-2xl ring-1 ring-gray-200 dark:bg-gray-900 dark:ring-gray-700"
        style={{ maxWidth: width }}
      >
        <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-gray-700">
          <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            {title}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="rounded p-1 leading-none text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
          >
            <XMarkIcon aria-hidden className="size-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 text-[13px] text-gray-900 dark:text-gray-100">
          {children}
        </div>
        {footer && (
          <div className="flex justify-end gap-2 border-t border-gray-200 px-4 py-3 dark:border-gray-700">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}
