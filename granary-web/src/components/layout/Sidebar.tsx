import { Link, useRouterState } from '@tanstack/react-router'
import { NAV_ITEMS, type NavItemDef } from '../../routes/navItems'
import { useNavBadges, type NavBadge } from '../../routes/useNavBadges'

interface NavItem extends NavItemDef {
  badge?: NavBadge
}

export function Sidebar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const badges = useNavBadges()

  const navItems: NavItem[] = NAV_ITEMS.map((item) => ({ ...item, badge: badges[item.to] }))

  return (
    <aside className="hidden h-full w-64 shrink-0 flex-col border-r border-gray-200 bg-white md:flex dark:border-gray-800 dark:bg-gray-900">
      <div className="flex h-16 shrink-0 items-center gap-2 px-6">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600 text-sm font-bold text-white">谷</span>
        <div className="text-sm font-semibold text-gray-900 dark:text-white">谷仓 Granary</div>
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
                  ? 'bg-indigo-50 text-indigo-600 dark:bg-indigo-950/40 dark:text-indigo-400'
                  : 'text-gray-700 hover:bg-gray-50 hover:text-gray-900 dark:text-gray-300 dark:hover:bg-gray-800 dark:hover:text-white'
              }`}
            >
              <span className="flex items-center gap-x-3">
                <Icon
                  aria-hidden
                  className={`size-5 shrink-0 ${
                    active
                      ? 'text-indigo-600 dark:text-indigo-400'
                      : 'text-gray-400 group-hover:text-gray-500 dark:text-gray-500 dark:group-hover:text-gray-400'
                  }`}
                />
                {item.label}
              </span>
              {item.badge && (
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                    item.badge.kind === 'warn'
                      ? 'bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-400'
                      : 'bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-400'
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
