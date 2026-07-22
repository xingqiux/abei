import { Link, useRouterState } from '@tanstack/react-router'
import { NAV_ITEMS, type NavItemDef } from '../../routes/navItems'

export function Sidebar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const navItems: NavItemDef[] = NAV_ITEMS

  return (
    <aside
      className="hidden h-full w-[200px] shrink-0 flex-col md:flex"
      style={{
        background: 'var(--g-sidebar-bg)',
        borderRight: '1px solid var(--g-sidebar-border)',
      }}
    >
      <div className="px-4 pb-5 pt-6">
        <div style={{ fontFamily: 'var(--g-font-ui)', fontWeight: 'var(--g-weight-demibold)', fontSize: 16, color: 'var(--g-ink)' }}>
          谷仓
        </div>
        <div
          className="font-num mt-1"
          style={{ fontSize: 8.5, letterSpacing: '.28em', color: 'var(--g-accent)' }}
        >
          GRANARY
        </div>
      </div>

      <nav className="flex flex-col gap-0.5 px-2">
        {navItems.map((item) => {
          const active = item.to === '/' ? pathname === '/' : pathname.startsWith(item.to)
          const Icon = item.icon
          return (
            <Link
              key={item.to}
              to={item.to}
              className="flex items-center justify-between rounded-[6px] px-2.5 py-1.5 text-[13px] transition-colors"
              style={{
                background: active ? 'var(--g-accent)' : 'transparent',
                color: active ? 'var(--g-accent-ink)' : 'var(--g-ink-2)',
                fontWeight: active ? 'var(--g-weight-demibold)' : 'var(--g-weight-regular)',
              }}
            >
              <span className="flex items-center gap-2">
                <Icon aria-hidden size={16} strokeWidth={2} color="currentColor" />
                {item.label}
              </span>
            </Link>
          )
        })}
      </nav>
    </aside>
  )
}
