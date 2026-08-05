import type { ComponentType } from 'react'
import {
  ArrowsRightLeftIcon,
  BanknotesIcon,
  CalendarDaysIcon,
  ChartBarIcon,
  Cog6ToothIcon,
  InboxIcon,
  Squares2X2Icon,
  WalletIcon,
} from '@heroicons/react/24/outline'

/** 侧栏八个一级页面对应的路由路径（与 router.tsx 的 routeTree 保持一致）。 */
export type NavPath =
  | '/'
  | '/transactions'
  | '/bill-inbox'
  | '/reconciliation'
  | '/budgets'
  | '/accounts'
  | '/reports'
  | '/settings'

export interface NavItemDef {
  label: string
  to: NavPath
  icon: ComponentType<{ className?: string }>
}

/**
 * 侧栏与命令面板（Cmd+K「跳转」区）共用的八个一级页面定义。
 * 徽标等派生状态由各自调用方计算，这里只保留静态的名称/路径/图标。
 */
export const NAV_ITEMS: NavItemDef[] = [
  { label: '总览', to: '/', icon: Squares2X2Icon },
  { label: '交易', to: '/transactions', icon: ArrowsRightLeftIcon },
  { label: '账单收件箱', to: '/bill-inbox', icon: InboxIcon },
  { label: '按天对账', to: '/reconciliation', icon: CalendarDaysIcon },
  { label: '预算与订阅', to: '/budgets', icon: BanknotesIcon },
  { label: '账户', to: '/accounts', icon: WalletIcon },
  { label: '报表', to: '/reports', icon: ChartBarIcon },
  { label: '设置', to: '/settings', icon: Cog6ToothIcon },
]
