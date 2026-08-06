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
const MORE_PATHS: NavPath[] = ['/reconciliation', '/budgets', '/accounts', '/analysis', '/settings']

/**
 * 选中态用 --brand-text 而不是 --brand：后者是「实心底」的颜色，深色主题下它
 * 压在 surface-1 上当文字用只有 2.x:1，基本看不见。
 */
const TAB_BASE = 'flex flex-1 flex-col items-center justify-center gap-1 text-[10px] font-medium transition-colors'
const TAB_ACTIVE = 'text-[var(--brand-text)]'
const TAB_IDLE = 'text-[var(--text-secondary)]'

/**
 * 移动端（<768px）底部 5 tab：今天 / 交易 / 记一笔（中间凸起）/ 收件箱（徽标点）/ 我的（弹出 sheet）。
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
      aria-label="主导航"
      className="fixed inset-x-0 bottom-0 z-[150] flex h-16 items-stretch border-t border-[var(--border-subtle)] bg-[var(--surface-1)] pb-[env(safe-area-inset-bottom)] shadow-[0_-4px_16px_rgb(0_0_0/0.06)] md:hidden"
    >
      <TabLink to="/" label="今天" icon={Squares2X2Icon} active={pathname === '/'} />
      <TabLink to="/transactions" label="交易" icon={ArrowsRightLeftIcon} active={pathname.startsWith('/transactions')} />

      <div className="flex flex-1 items-center justify-center">
        <button
          type="button"
          onClick={openRecordForm}
          aria-label="记一笔"
          className="flex size-12 -translate-y-3 items-center justify-center rounded-full bg-[var(--brand)] text-[var(--brand-on)] shadow-lg transition-colors hover:bg-[var(--brand-hover)]"
        >
          <PlusIcon aria-hidden className="size-6" strokeWidth={2.5} />
        </button>
      </div>

      <TabLink to="/bill-inbox" label="收件箱" icon={InboxIcon} active={pathname.startsWith('/bill-inbox')} showDot={!!inboxBadge} dotKind={inboxBadge?.kind} />

      <button
        type="button"
        onClick={openMoreSheet}
        aria-haspopup="dialog"
        className={`${TAB_BASE} ${isMoreActive ? TAB_ACTIVE : TAB_IDLE}`}
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
      aria-current={active ? 'page' : undefined}
      className={`relative ${TAB_BASE} ${active ? TAB_ACTIVE : TAB_IDLE}`}
    >
      <span className="relative">
        <Icon aria-hidden className="size-6" />
        {showDot && (
          <>
            <span
              aria-hidden
              className={`absolute -top-0.5 -right-0.5 size-1.5 rounded-full ${
                dotKind === 'danger' ? 'bg-[var(--danger)]' : 'bg-[var(--attention-mark)]'
              }`}
            />
            {/* 红点是纯视觉的，读屏什么也听不到。补一句话，否则「有待办」这个信息只对看得见的人存在 */}
            <span className="sr-only">有待处理项</span>
          </>
        )}
      </span>
      {label}
    </Link>
  )
}
