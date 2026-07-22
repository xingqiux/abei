import { useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Link } from '@tanstack/react-router'
import gsap from 'gsap'
import { useMoreSheetStore } from '../../store/moreSheetStore'
import { NAV_ITEMS, type NavPath } from '../../routes/navItems'
import { prefersReducedMotion } from '../../motion/reducedMotion'
import { useDialogBehavior } from '../granary/useDialogBehavior'

/** 「我的」sheet 里列出的剩余导航项（总览/交易/收件箱已在底部 tab 常驻，此处不重复）。 */
const MORE_PATHS: NavPath[] = ['/accounts', '/settings']

/**
 * 移动端底部弹出 sheet：列出侧栏剩余五个导航项，240ms 上滑入场（规范 §3/§6）。
 * 只在移动端渲染有意义，但组件本身用 `md:hidden` 兜底，避免桌面视口下意外挂载。
 */
export function MoreSheet() {
  const open = useMoreSheetStore((s) => s.open)
  const close = useMoreSheetStore((s) => s.close)
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
      <div className="absolute inset-0" style={{ background: 'rgb(0 0 0 / 0.5)' }} onClick={close} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="更多"
        tabIndex={-1}
        className="absolute inset-x-0 bottom-0 flex flex-col rounded-t-[10px] pb-[env(safe-area-inset-bottom)]"
        style={{ background: 'var(--g-surface)', boxShadow: 'var(--g-shadow)', border: '1px solid var(--g-border)', borderBottom: 'none' }}
      >
        <div className="mx-auto mt-2.5 h-1 w-9 rounded-full" style={{ background: 'var(--g-border)' }} />
        <div className="flex flex-col gap-0.5 px-3 py-3">
          {items.map((item) => {
            const Icon = item.icon
            return (
              <Link
                key={item.to}
                to={item.to}
                onClick={close}
                className="flex items-center justify-between rounded-[6px] px-3 py-3 text-[13.5px]"
                style={{ color: 'var(--g-ink)' }}
              >
                <span className="flex items-center gap-2.5">
                  <Icon aria-hidden size={18} strokeWidth={2} color="var(--g-ink-2)" />
                  {item.label}
                </span>
              </Link>
            )
          })}
        </div>
      </div>
    </div>,
    document.body,
  )
}
