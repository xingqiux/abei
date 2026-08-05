import { Link, useRouterState } from '@tanstack/react-router'
import { LayoutDashboard, ArrowLeftRight, Plus, Inbox, User } from 'lucide-react'
import { useRecordTxStore } from '../../store/recordTxStore'
import { useMoreSheetStore } from '../../store/moreSheetStore'
import { useNavBadges } from '../../routes/useNavBadges'
import type { NavPath } from '../../routes/navItems'

/** 「我的」sheet 覆盖的剩余导航路径，用于判断底部 tab「我的」的高亮态（规范 §3 移动端断点）。 */
const MORE_PATHS: NavPath[] = ['/reconciliation', '/budgets', '/accounts', '/reports', '/settings']

/**
 * 移动端（<768px）底部 5 tab：总览 / 交易 / 记一笔（中间凸起）/ 收件箱（徽标点）/ 我的（弹出 sheet）。
 * 桌面端（md 及以上）不渲染，由 AppShell 用 `md:hidden` 控制显隐。
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
      className="fixed inset-x-0 bottom-0 z-[150] flex h-16 items-stretch md:hidden"
      style={{
        background: 'var(--g-surface)',
        borderTop: '1px solid var(--g-border)',
        boxShadow: '0 -8px 24px rgb(0 0 0 / 0.25)',
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}
    >
      <TabLink to="/" label="总览" icon={LayoutDashboard} active={pathname === '/'} />
      <TabLink to="/transactions" label="交易" icon={ArrowLeftRight} active={pathname.startsWith('/transactions')} />

      <div className="flex flex-1 items-center justify-center">
        <button
          type="button"
          onClick={openRecordForm}
          aria-label="记一笔"
          className="flex h-12 w-12 -translate-y-3 items-center justify-center rounded-full"
          style={{ background: 'var(--g-accent)', boxShadow: 'var(--g-shadow)' }}
        >
          <Plus aria-hidden size={22} strokeWidth={2.5} color="var(--g-accent-ink)" />
        </button>
      </div>

      <TabLink to="/bill-inbox" label="收件箱" icon={Inbox} active={pathname.startsWith('/bill-inbox')} showDot={!!inboxBadge} dotKind={inboxBadge?.kind} />

      <button
        type="button"
        onClick={openMoreSheet}
        className="flex flex-1 flex-col items-center justify-center gap-0.5 text-[10px]"
        style={{ color: isMoreActive ? 'var(--g-accent)' : 'var(--g-ink-2)' }}
      >
        <User aria-hidden size={18} strokeWidth={2} color="currentColor" />
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
  icon: typeof LayoutDashboard
  active: boolean
  showDot?: boolean
  dotKind?: 'warn' | 'danger'
}) {
  return (
    <Link
      to={to}
      className="relative flex flex-1 flex-col items-center justify-center gap-0.5 text-[10px]"
      style={{ color: active ? 'var(--g-accent)' : 'var(--g-ink-2)' }}
    >
      <span className="relative">
        <Icon aria-hidden size={18} strokeWidth={2} color="currentColor" />
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
