import type { ComponentType } from 'react'
import {
  ArrowsRightLeftIcon,
  CalendarDaysIcon,
  ChartBarIcon,
  Cog6ToothIcon,
  InboxIcon,
  SparklesIcon,
  SunIcon,
  TagIcon,
  WalletIcon,
} from '@heroicons/react/24/outline'

/**
 * 应用内可直达的全部导航路径（与 router.tsx 的 routeTree 保持一致）。
 *
 * 注意这里是**全部**路径：`/reconciliation` 虽然不占桌面侧栏，移动端「我的」
 * sheet 仍会链过去，所以类型必须覆盖。
 */
export type NavPath =
  | '/'
  | '/transactions'
  | '/assistant'
  | '/accounts'
  | '/reference-data'
  | '/analysis'
  | '/settings'
  | '/bill-inbox'
  | '/reconciliation'

export interface NavItemDef {
  label: string
  to: NavPath
  icon: ComponentType<{ className?: string }>
}

/** 侧栏一级导航。 */
export const NAV_ITEMS: NavItemDef[] = [
  { label: '今天', to: '/', icon: SunIcon },
  { label: '财务助手', to: '/assistant', icon: SparklesIcon },
  { label: '交易', to: '/transactions', icon: ArrowsRightLeftIcon },
  { label: '账单收件箱', to: '/bill-inbox', icon: InboxIcon },
  { label: '账户', to: '/accounts', icon: WalletIcon },
  { label: '分类与标签', to: '/reference-data', icon: TagIcon },
  { label: '分析', to: '/analysis', icon: ChartBarIcon },
  { label: '设置', to: '/settings', icon: Cog6ToothIcon },
]

/** Cmd+K「跳转」区可直达的全部路由。 */
export const ALL_ROUTES: NavItemDef[] = [
  ...NAV_ITEMS,
  { label: '按天对账', to: '/reconciliation', icon: CalendarDaysIcon },
]
