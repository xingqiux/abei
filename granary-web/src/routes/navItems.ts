import {
  LayoutDashboard,
  ArrowLeftRight,
  Inbox,
  CalendarCheck,
  PiggyBank,
  Wallet,
  BarChart3,
  Settings,
  type LucideIcon,
} from 'lucide-react'

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
  icon: LucideIcon
}

/**
 * 侧栏与命令面板（Cmd+K「跳转」区）共用的八个一级页面定义（规范 §3）。
 * 徽标等派生状态由各自调用方计算，这里只保留静态的名称/路径/图标。
 */
export const NAV_ITEMS: NavItemDef[] = [
  { label: '总览', to: '/', icon: LayoutDashboard },
  { label: '交易', to: '/transactions', icon: ArrowLeftRight },
  { label: '账单收件箱', to: '/bill-inbox', icon: Inbox },
  { label: '按天对账', to: '/reconciliation', icon: CalendarCheck },
  { label: '预算与订阅', to: '/budgets', icon: PiggyBank },
  { label: '账户', to: '/accounts', icon: Wallet },
  { label: '报表', to: '/reports', icon: BarChart3 },
  { label: '设置', to: '/settings', icon: Settings },
]
