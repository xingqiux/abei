import { Link, useRouterState } from '@tanstack/react-router'
import { LayoutDashboard, ArrowLeftRight, Plus, Wallet, Settings } from 'lucide-react'
import { useRecordTxStore } from '../../store/recordTxStore'
import type { NavPath } from '../../routes/navItems'

/**
 * 移动端（<768px）底部 5 tab：总览 / 交易 / 记一笔（中间凸起）/ 收件箱（徽标点）/ 我的（弹出 sheet）。
 * 桌面端（md 及以上）不渲染，由 AppShell 用 `md:hidden` 控制显隐。
 */
export function BottomTabBar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const openRecordForm = useRecordTxStore((s) => s.openForm)

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

      <TabLink to="/accounts" label="账户" icon={Wallet} active={pathname.startsWith('/accounts')} />
      <TabLink to="/settings" label="设置" icon={Settings} active={pathname.startsWith('/settings')} />
    </nav>
  )
}

function TabLink({
  to,
  label,
  icon: Icon,
  active,
}: {
  to: NavPath
  label: string
  icon: typeof LayoutDashboard
  active: boolean
}) {
  return (
    <Link
      to={to}
      className="relative flex flex-1 flex-col items-center justify-center gap-0.5 text-[10px]"
      style={{ color: active ? 'var(--g-accent)' : 'var(--g-ink-2)' }}
    >
      <Icon aria-hidden size={18} strokeWidth={2} color="currentColor" />
      {label}
    </Link>
  )
}
