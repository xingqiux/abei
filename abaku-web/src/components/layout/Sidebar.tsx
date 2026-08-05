import { Link, useRouterState } from '@tanstack/react-router'
import { NAV_ITEMS, type NavItemDef } from '../../routes/navItems'
import { useNavBadges, type NavBadge } from '../../routes/useNavBadges'
import { AbakuMark } from '../abaku/AbakuMark'

interface NavItem extends NavItemDef {
  badge?: NavBadge
}

export function Sidebar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const badges = useNavBadges()

  const navItems: NavItem[] = NAV_ITEMS.map((item) => ({ ...item, badge: badges[item.to] }))

  return (
    <aside className="hidden h-full w-64 shrink-0 flex-col border-r border-[var(--border-subtle)] bg-[var(--surface-1)] md:flex  ">
      <div className="flex h-16 shrink-0 items-center gap-2 px-6">
        <span className="flex items-center gap-2">
          <AbakuMark className="size-6 text-[var(--brand)]" />
          <span className="flex flex-col leading-none">
            <span className="text-[13px] font-semibold tracking-tight">Abaku</span>
            <span className="text-[10px] tracking-[0.28em] text-[var(--text-tertiary)]">算珠</span>
          </span>
        </span>
      </div>

      <nav className="flex flex-col gap-1 px-3">
        {navItems.map((item) => {
          const active = item.to === '/' ? pathname === '/' : pathname.startsWith(item.to)
          const Icon = item.icon
          return (
            <Link
              key={item.to}
              to={item.to}
              className={`group flex items-center justify-between gap-x-3 rounded-md p-2 text-sm/6 font-semibold ${
                active
                  ? 'bg-[var(--surface-selected)] text-[var(--brand)]  '
                  : 'text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]   '
              }`}
            >
              <span className="flex items-center gap-x-3">
                <Icon
                  aria-hidden
                  className={`size-5 shrink-0 ${
                    active
                      ? 'text-[var(--brand)] '
                      : 'text-[var(--text-tertiary)] group-hover:text-[var(--text-secondary)]'
                  }`}
                />
                {item.label}
              </span>
              {item.badge && (
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                    item.badge.kind === 'warn'
                      ? 'bg-[var(--attention-soft)] text-[var(--attention)]  '
                      : 'bg-[var(--danger-soft)] text-[var(--danger)]  '
                  }`}
                >
                  {item.badge.text}
                </span>
              )}
            </Link>
          )
        })}
      </nav>
    </aside>
  )
}
