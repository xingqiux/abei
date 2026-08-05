import type { ComponentType } from 'react'
import {
  ArrowsRightLeftIcon,
  BanknotesIcon,
  CalendarDaysIcon,
  ChartBarIcon,
  Cog6ToothIcon,
  InboxIcon,
  SunIcon,
  WalletIcon,
} from '@heroicons/react/24/outline'

/**
 * 应用内可直达的全部导航路径（与 router.tsx 的 routeTree 保持一致）。
 *
 * 注意这里是**全部**路径，不只是侧栏那六项：`/bill-inbox` 和 `/reconciliation`
 * 虽然不占桌面侧栏，但移动端底部 tab 和「我的」sheet 都会链过去，所以类型必须覆盖。
 * 想要「只有侧栏六项」的那个集合，用 NAV_ITEMS。
 */
export type NavPath =
  | '/'
  | '/transactions'
  | '/accounts'
  | '/budgets'
  | '/analysis'
  | '/settings'
  | '/bill-inbox'
  | '/reconciliation'

export interface NavItemDef {
  label: string
  to: NavPath
  icon: ComponentType<{ className?: string }>
}

/** 侧栏一级导航：今天 / 交易 / 账户 / 预算 / 分析 / 设置。 */
export const NAV_ITEMS: NavItemDef[] = [
  { label: '今天', to: '/', icon: SunIcon },
  { label: '交易', to: '/transactions', icon: ArrowsRightLeftIcon },
  { label: '账户', to: '/accounts', icon: WalletIcon },
  { label: '预算', to: '/budgets', icon: BanknotesIcon },
  { label: '分析', to: '/analysis', icon: ChartBarIcon },
  { label: '设置', to: '/settings', icon: Cog6ToothIcon },
]

/** Cmd+K「跳转」区可直达的全部路由（含收件箱/对账这两个二级页）。 */
export const ALL_ROUTES: NavItemDef[] = [
  ...NAV_ITEMS,
  { label: '账单收件箱', to: '/bill-inbox', icon: InboxIcon },
  { label: '按天对账', to: '/reconciliation', icon: CalendarDaysIcon },
]
