import type { ComponentType } from 'react'
import { Link, useRouterState } from '@tanstack/react-router'
import { ArrowsLeftRight, Plus, SquaresFour, Tray, User } from '@phosphor-icons/react'
import { useRecordTxStore } from '../../store/recordTxStore'
import { useMoreSheetStore } from '../../store/moreSheetStore'
import { useNavBadges } from '../../routes/useNavBadges'
import type { NavPath } from '../../routes/navItems'
import { NavCountBadge } from './NavCountBadge'

/** 「我的」sheet 覆盖的剩余导航路径，用于判断底部 tab「我的」的高亮态。 */
const MORE_PATHS: NavPath[] = ['/assistant', '/accounts', '/budgets', '/reference-data', '/analysis', '/feedback', '/settings']

/** 当前 tab 用品牌色 + 顶上一条 3px 指示条，跟侧栏那根竖条是同一套说法 */
const TAB_BASE = 'relative flex flex-1 flex-col items-center justify-center gap-1 text-[10px] font-medium transition-colors'
const TAB_ACTIVE = 'text-[var(--brand-text)]'
const TAB_IDLE = 'text-[var(--text-secondary)]'

/**
 * 移动端（<768px）底部 5 tab：概况 / 交易 / 记一笔（中间凸起）/ 收件箱（带计数）/ 我的（弹出 sheet）。
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
      <TabLink to="/" label="概况" icon={SquaresFour} active={pathname === '/'} />
      <TabLink to="/transactions" label="交易" icon={ArrowsLeftRight} active={pathname.startsWith('/transactions')} />

      <div className="flex flex-1 items-center justify-center">
        <button
          type="button"
          onClick={() => openRecordForm()}
          aria-label="记一笔"
          className="flex size-12 -translate-y-3 items-center justify-center rounded-full bg-[var(--brand)] text-[var(--brand-on)] shadow-lg transition-colors hover:bg-[var(--brand-hover)]"
        >
          <Plus aria-hidden className="size-6" weight="bold" />
        </button>
      </div>

      <TabLink
        to="/bill-inbox"
        label="收件箱"
        icon={Tray}
        active={pathname.startsWith('/bill-inbox')}
        badge={inboxBadge}
      />

      <button
        type="button"
        onClick={openMoreSheet}
        aria-haspopup="dialog"
        className={`${TAB_BASE} ${isMoreActive ? TAB_ACTIVE : TAB_IDLE}`}
      >
        {isMoreActive && <ActiveBar />}
        <User aria-hidden className="size-6" />
        我的
      </button>
    </nav>
  )
}

/** 顶上那根 3px 指示条。跟侧栏一样，选中态不只靠颜色。 */
function ActiveBar() {
  return <span aria-hidden className="absolute inset-x-5 top-0 h-[3px] rounded-b-full bg-[var(--brand)]" />
}

function TabLink({
  to,
  label,
  icon: Icon,
  active,
  badge,
}: {
  to: NavPath
  label: string
  icon: ComponentType<{ className?: string }>
  active: boolean
  badge?: { text: string; hasDanger: boolean }
}) {
  return (
    <Link to={to} aria-current={active ? 'page' : undefined} className={`${TAB_BASE} ${active ? TAB_ACTIVE : TAB_IDLE}`}>
      {active && <ActiveBar />}
      <span className="relative">
        <Icon aria-hidden className="size-6" />
        {badge && (
          <span className="absolute -top-2 left-4">
            <NavCountBadge count={badge.text} hasDanger={badge.hasDanger} compact />
          </span>
        )}
      </span>
      {label}
    </Link>
  )
}
