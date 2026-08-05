import { useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Link } from '@tanstack/react-router'
import gsap from 'gsap'
import { useMoreSheetStore } from '../../store/moreSheetStore'
import { useNavBadges } from '../../routes/useNavBadges'
import { NAV_ITEMS, type NavPath } from '../../routes/navItems'
import { prefersReducedMotion } from '../../motion/reducedMotion'
import { useDialogBehavior } from '../granary/useDialogBehavior'

/** 「我的」sheet 里列出的剩余导航项（总览/交易/收件箱已在底部 tab 常驻，此处不重复）。 */
const MORE_PATHS: NavPath[] = ['/reconciliation', '/budgets', '/accounts', '/reports', '/settings']

/**
 * 移动端底部弹出 sheet：列出侧栏剩余五个导航项，240ms 上滑入场。
 */
export function MoreSheet() {
  const open = useMoreSheetStore((s) => s.open)
  const close = useMoreSheetStore((s) => s.close)
  const badges = useNavBadges()
  const panelRef = useRef<HTMLDivElement>(null)

  useDialogBehavior(open, panelRef, close)

  useLayoutEffect(() => {
    if (!open) return
    const el = panelRef.current
    if (!el || prefersReducedMotion()) return
    gsap.fromTo(el, { y: '100%' }, { y: '0%', duration: 0.24, ease: 'power3.out' })
  }, [open])

  if (!open) return null

  const items = NAV_ITEMS.filter((item) => MORE_PATHS.includes(item.to))

  return createPortal(
    <div className="fixed inset-0 z-[200] md:hidden" role="presentation">
      <div className="absolute inset-0 bg-gray-900/50" onClick={close} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="更多"
        tabIndex={-1}
        className="absolute inset-x-0 bottom-0 flex flex-col rounded-t-2xl border border-b-0 border-gray-200 bg-white pb-[env(safe-area-inset-bottom)] shadow-xl dark:border-gray-700 dark:bg-gray-900"
      >
        <div className="mx-auto mt-3 h-1 w-9 rounded-full bg-gray-200 dark:bg-gray-700" />
        <div className="flex flex-col gap-1 px-3 py-3">
          {items.map((item) => {
            const Icon = item.icon
            const badge = badges[item.to]
            return (
              <Link
                key={item.to}
                to={item.to}
                onClick={close}
                className="flex items-center justify-between rounded-md px-3 py-3 text-sm font-medium text-gray-900 hover:bg-gray-50 dark:text-gray-100 dark:hover:bg-gray-800"
              >
                <span className="flex items-center gap-3">
                  <Icon aria-hidden className="size-5 text-gray-400" />
                  {item.label}
                </span>
                {badge && (
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                      badge.kind === 'warn'
                        ? 'bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-400'
                        : 'bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-400'
                    }`}
                  >
                    {badge.text}
                  </span>
                )}
              </Link>
            )
          })}
        </div>
      </div>
    </div>,
    document.body,
  )
}
