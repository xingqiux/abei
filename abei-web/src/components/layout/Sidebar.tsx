import { Link, useRouterState } from '@tanstack/react-router'
import { NAV_ITEMS, type NavItemDef } from '../../routes/navItems'
import { useNavBadges, type NavBadge } from '../../routes/useNavBadges'
import { AbeiMark } from '../abei/AbeiMark'
import { NavCountBadge } from './NavCountBadge'

interface NavItem extends NavItemDef {
  badge?: NavBadge
}

/**
 * 侧栏导航。结构取自 tailwind-plus `navigation/sidebar-navigation`。
 *
 * 当前项是「中性底 + 左边一根 3px 品牌色竖条 + 品牌色图标」。整块底色上品牌色
 * 试过，一屏九项里有一项是实心色块，眼睛全被它拽走，剩下八项等于不存在。
 * 竖条同时兼顾色觉障碍：位置本身就是信号，不靠颜色也读得出来。
 */
export function Sidebar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const badges = useNavBadges()

  const navItems: NavItem[] = NAV_ITEMS.map((item) => ({ ...item, badge: badges[item.to] }))

  return (
    <aside className="hidden h-full w-60 shrink-0 flex-col border-r border-[var(--border-subtle)] bg-[var(--surface-1)] md:flex">
      <div className="flex h-16 shrink-0 items-center gap-2.5 px-5">
        <AbeiMark className="size-6 text-[var(--brand-text)]" />
        <span className="flex flex-col leading-none">
          <span className="text-[13px] font-semibold tracking-tight text-[var(--text-primary)]">
            abei
          </span>
          <span className="mt-1 text-[10px] tracking-[0.28em] text-[var(--text-tertiary)]">
            阿贝
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
              className={`group relative flex items-center justify-between gap-x-3 rounded-md py-2 pr-2 pl-3 text-sm font-medium transition-colors ${item.to === '/feedback' ? 'mt-3 border-t border-[var(--border-subtle)] pt-3' : ''} ${
                active
                  ? 'bg-[var(--surface-selected)] font-semibold text-[var(--text-primary)]'
                  : 'text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]'
              }`}
            >
              {/* 竖条：不依赖颜色也能看出选中，色觉障碍下同样成立 */}
              {active && (
                <span
                  aria-hidden
                  className="absolute inset-y-1.5 left-0 w-[3px] rounded-full bg-[var(--brand)]"
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
                <NavCountBadge count={item.badge.text} hasDanger={item.badge.hasDanger} />
              )}
            </Link>
          )
        })}
      </nav>
    </aside>
  )
}
