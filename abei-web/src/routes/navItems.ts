import type { ComponentType } from 'react'
import {
  ArrowsLeftRight,
  ChartBar,
  Gear,
  Money,
  Sparkle,
  SquaresFour,
  Tag,
  Tray,
  Wallet,
} from '@phosphor-icons/react'

/**
 * 应用内可直达的全部导航路径（与 router.tsx 的 routeTree 保持一致）。
 */
export type NavPath =
  | '/'
  | '/transactions'
  | '/assistant'
  | '/accounts'
  | '/budgets'
  | '/reference-data'
  | '/analysis'
  | '/settings'
  | '/bill-inbox'

export interface NavItemDef {
  label: string
  to: NavPath
  icon: ComponentType<{ className?: string }>
}

/** 侧栏一级导航，顺序即优先级（设计稿 06 §1）。 */
export const NAV_ITEMS: NavItemDef[] = [
  { label: '概况', to: '/', icon: SquaresFour },
  { label: '账单收件箱', to: '/bill-inbox', icon: Tray },
  { label: '交易', to: '/transactions', icon: ArrowsLeftRight },
  { label: '财务助手', to: '/assistant', icon: Sparkle },
  { label: '账户', to: '/accounts', icon: Wallet },
  { label: '预算', to: '/budgets', icon: Money },
  { label: '分类与标签', to: '/reference-data', icon: Tag },
  { label: '分析', to: '/analysis', icon: ChartBar },
  { label: '设置', to: '/settings', icon: Gear },
]

/**
 * Cmd+K「跳转」区可直达的全部路由。
 * 「按天对账」删除后侧栏之外已经没有独立路由，这里与 NAV_ITEMS 完全一致。
 */
export const ALL_ROUTES: NavItemDef[] = [...NAV_ITEMS]
