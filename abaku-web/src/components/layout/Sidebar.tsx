import { Link, useRouterState } from '@tanstack/react-router'
import { NAV_ITEMS, type NavItemDef } from '../../routes/navItems'
import { useNavBadges, type NavBadge } from '../../routes/useNavBadges'
import { AbakuMark } from '../abaku/AbakuMark'
import { Badge } from '../ui/Badge'

interface NavItem extends NavItemDef {
  badge?: NavBadge
}

/**
 * 侧栏导航。结构取自 tailwind-plus `navigation/sidebar-navigation`。
 *
 * 选中态用中性底、正文色和左侧竖条三重表达，不只依赖颜色。
 */
export function Sidebar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const badges = useNavBadges()

  const navItems: NavItem[] = NAV_ITEMS.map((item) => ({ ...item, badge: badges[item.to] }))

  return (
    <aside className="hidden h-full w-60 shrink-0 flex-col border-r border-[var(--border-subtle)] bg-[var(--surface-1)] md:flex">
      <div className="flex h-16 shrink-0 items-center gap-2.5 px-5">
        <AbakuMark className="size-6 text-[var(--brand-text)]" />
        <span className="flex flex-col leading-none">
          <span className="text-[13px] font-semibold tracking-tight text-[var(--text-primary)]">
            Abaku
          </span>
          <span className="mt-1 text-[10px] tracking-[0.28em] text-[var(--text-tertiary)]">
            算珠
          </span>
        </span>
      </div>

      <nav aria-label="主导航" className="flex flex-col gap-0.5 px-3 py-2">
        {navItems.map((item) => {
          const active = item.to === '/' ? pathname === '/' : pathname.startsWith(item.to)
          const Icon = item.icon
          return (
            <Link
              key={item.to}
              to={item.to}
              aria-current={active ? 'page' : undefined}
              className={`group relative flex items-center justify-between gap-x-3 rounded-md py-2 pr-2 pl-3 text-sm font-medium transition-colors ${
                active
                  ? 'bg-[var(--brand-soft)] font-semibold text-[var(--brand-text)]'
                  : 'text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]'
              }`}
            >
              {/* 竖条：不依赖颜色也能看出选中，色觉障碍下同样成立 */}
              {active && (
                <span
                  aria-hidden
                  className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-[var(--brand)]"
                />
              )}
              <span className="flex items-center gap-x-3">
                <Icon
                  aria-hidden
                  className={`size-5 shrink-0 ${
                    active
                      ? 'text-[var(--brand-text)]'
                      : 'text-[var(--text-tertiary)] group-hover:text-[var(--text-secondary)]'
                  }`}
                />
                {item.label}
              </span>
              {item.badge && (
                <Badge tone={item.badge.kind === 'warn' ? 'attention' : 'danger'}>
                  {item.badge.text}
                </Badge>
              )}
            </Link>
          )
        })}
      </nav>
    </aside>
  )
}
