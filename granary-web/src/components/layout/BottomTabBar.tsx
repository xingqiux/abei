import type { ComponentType } from 'react'
import { Link, useRouterState } from '@tanstack/react-router'
import {
  ArrowsRightLeftIcon,
  InboxIcon,
  PlusIcon,
  Squares2X2Icon,
  UserIcon,
} from '@heroicons/react/24/outline'
import { useRecordTxStore } from '../../store/recordTxStore'
import { useMoreSheetStore } from '../../store/moreSheetStore'
import { useNavBadges } from '../../routes/useNavBadges'
import type { NavPath } from '../../routes/navItems'

/** 「我的」sheet 覆盖的剩余导航路径，用于判断底部 tab「我的」的高亮态。 */
const MORE_PATHS: NavPath[] = ['/reconciliation', '/budgets', '/accounts', '/reports', '/settings']

/**
 * 移动端（<768px）底部 5 tab：总览 / 交易 / 记一笔（中间凸起）/ 收件箱（徽标点）/ 我的（弹出 sheet）。
 */
export function BottomTabBar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const openRecordForm = useRecordTxStore((s) => s.openForm)
  const openMoreSheet = useMoreSheetStore((s) => s.openSheet)
  const badges = useNavBadges()

  const isMoreActive = MORE_PATHS.some((p) => pathname.startsWith(p))
  const inboxBadge = badges['/bill-inbox']

  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-[150] flex h-16 items-stretch border-t border-gray-200 bg-white shadow-[0_-4px_16px_rgb(0_0_0/0.06)] md:hidden dark:border-gray-800 dark:bg-gray-900"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <TabLink to="/" label="总览" icon={Squares2X2Icon} active={pathname === '/'} />
      <TabLink to="/transactions" label="交易" icon={ArrowsRightLeftIcon} active={pathname.startsWith('/transactions')} />

      <div className="flex flex-1 items-center justify-center">
        <button
          type="button"
          onClick={openRecordForm}
          aria-label="记一笔"
          className="flex h-12 w-12 -translate-y-3 items-center justify-center rounded-full bg-indigo-600 text-white shadow-lg hover:bg-indigo-500"
        >
          <PlusIcon aria-hidden className="size-6" strokeWidth={2.5} />
        </button>
      </div>

      <TabLink to="/bill-inbox" label="收件箱" icon={InboxIcon} active={pathname.startsWith('/bill-inbox')} showDot={!!inboxBadge} dotKind={inboxBadge?.kind} />

      <button
        type="button"
        onClick={openMoreSheet}
        className="flex flex-1 flex-col items-center justify-center gap-1 text-[10px] font-medium"
        style={{ color: isMoreActive ? 'var(--g-accent)' : 'var(--g-ink-2)' }}
      >
        <UserIcon aria-hidden className="size-6" />
        我的
      </button>
    </nav>
  )
}

function TabLink({
  to,
  label,
  icon: Icon,
  active,
  showDot,
  dotKind,
}: {
  to: NavPath
  label: string
  icon: ComponentType<{ className?: string }>
  active: boolean
  showDot?: boolean
  dotKind?: 'warn' | 'danger'
}) {
  return (
    <Link
      to={to}
      className="relative flex flex-1 flex-col items-center justify-center gap-1 text-[10px] font-medium"
      style={{ color: active ? 'var(--g-accent)' : 'var(--g-ink-2)' }}
    >
      <span className="relative">
        <Icon aria-hidden className="size-6" />
        {showDot && (
          <span
            className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full"
            style={{ background: dotKind === 'danger' ? 'var(--g-danger)' : 'var(--g-warn)' }}
          />
        )}
      </span>
      {label}
    </Link>
  )
}
