import { useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Link } from '@tanstack/react-router'
import { SignOut } from '@phosphor-icons/react'
import gsap from 'gsap'
import { useMoreSheetStore } from '../../store/moreSheetStore'
import { useNavBadges } from '../../routes/useNavBadges'
import { NAV_ITEMS, type NavPath } from '../../routes/navItems'
import { prefersReducedMotion } from '../../motion/reducedMotion'
import { useDialogBehavior } from '../abei/useDialogBehavior'
import { requestTokenReset } from '../tokenEvents'
import { NavCountBadge } from './NavCountBadge'

/** 「我的」sheet 里列出的剩余导航项（概况/交易/收件箱已在底部 tab 常驻，此处不重复）。 */
const MORE_PATHS: NavPath[] = ['/assistant', '/accounts', '/budgets', '/reference-data', '/analysis', '/settings']

/**
 * 移动端底部弹出 sheet：列出侧栏剩余导航项，240ms 上滑入场。
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

  // 顺序跟着侧栏走，MORE_PATHS 只决定哪几项出现在这里
  const items = NAV_ITEMS.filter((item) => MORE_PATHS.includes(item.to))

  return createPortal(
    <div className="fixed inset-0 z-[200] md:hidden" role="presentation">
      <div className="absolute inset-0 bg-black/50" onClick={close} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="更多"
        tabIndex={-1}
        className="absolute inset-x-0 bottom-0 flex flex-col rounded-t-2xl border border-b-0 border-[var(--border-subtle)] bg-[var(--surface-1)] pb-[env(safe-area-inset-bottom)] shadow-xl  "
      >
        <div aria-hidden className="mx-auto mt-3 h-1 w-9 rounded-full bg-[var(--surface-selected)]" />
        <ul role="list" className="flex flex-col gap-1 px-3 py-3">
          {items.map((item) => {
            const Icon = item.icon
            const badge = badges[item.to]
            return (
              <li key={item.to}>
                <Link
                  to={item.to}
                  onClick={close}
                  className="flex items-center justify-between rounded-md px-3 py-3 text-sm font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-hover)]"
                >
                  <span className="flex items-center gap-3">
                    <Icon aria-hidden className="size-5 text-[var(--text-tertiary)]" />
                    {item.label}
                  </span>
                  {badge && <NavCountBadge count={badge.text} hasDanger={badge.hasDanger} />}
                </Link>
              </li>
            )
          })}
        </ul>
        {/* 更换令牌只在桌面顶栏有过入口，手机上等于没有：换个账号、令牌过期都只能清缓存。
            放在导航项下面并用分隔线隔开——它不是一个「去某个页面」的动作。 */}
        <div className="border-t border-[var(--border-subtle)] px-3 py-3">
          <button
            type="button"
            onClick={() => {
              close()
              requestTokenReset()
            }}
            className="flex w-full items-center gap-3 rounded-md px-3 py-3 text-sm font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-hover)]"
          >
            <SignOut aria-hidden className="size-5 text-[var(--text-tertiary)]" />
            更换令牌
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
