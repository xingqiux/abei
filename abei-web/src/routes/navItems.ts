import type { ComponentType } from 'react'
import {
  ArrowsLeftRight,
  ChartBar,
  ChatTeardropText,
  Gear,
  IdentificationCard,
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
  | '/feedback'
  | '/profile'
  | '/settings'
  | '/bill-inbox'

export interface NavItemDef {
  label: string
  to: NavPath
  icon: ComponentType<{ className?: string }>
}

/**
 * 侧栏一级导航，顺序即优先级（设计稿 06 §1）。
 *
 * 八项封顶，而且每一项都是「我要做的事」。之前这里有十三项，其中邮件工作台和解析工作台
 * 是维护解析规则用的——普通用户一辈子点不开，却和「交易」「账户」抢同一段视线。
 * 那两项已经搬去 abei-admin，账号相关的三项降到 ACCOUNT_ITEMS。
 */
export const NAV_ITEMS: NavItemDef[] = [
  { label: '概况', to: '/', icon: SquaresFour },
  { label: '账单收件箱', to: '/bill-inbox', icon: Tray },
  { label: '交易', to: '/transactions', icon: ArrowsLeftRight },
  { label: 'AI', to: '/assistant', icon: Sparkle },
  { label: '账户', to: '/accounts', icon: Wallet },
  { label: '预算', to: '/budgets', icon: Money },
  { label: '分类与标签', to: '/reference-data', icon: Tag },
  { label: '分析', to: '/analysis', icon: ChartBar },
]

/**
 * 账号相关的次级导航：侧栏沉到底部，移动端在「我的」里。
 * 这几项是「关于我这个账号」，不是「我要做的事」，混在一级导航里只会稀释上面八项。
 */
export const ACCOUNT_ITEMS: NavItemDef[] = [
  { label: '用户资料', to: '/profile', icon: IdentificationCard },
  { label: '反馈', to: '/feedback', icon: ChatTeardropText },
  { label: '设置', to: '/settings', icon: Gear },
]

/** Cmd+K「跳转」区可直达的全部路由。 */
export const ALL_ROUTES: NavItemDef[] = [...NAV_ITEMS, ...ACCOUNT_ITEMS]

/** 移动端底部 tab 常驻的路径（记一笔是按钮，不算路径）。 */
export const TAB_PATHS: NavPath[] = ['/', '/transactions', '/bill-inbox']

/**
 * 「我的」sheet 覆盖的其余导航项。由上面几张表算出来，不再手抄一遍——
 * 手抄的那份漏更新时，底部 tab 的高亮态会和 sheet 里的内容对不上。
 */
export const MORE_ITEMS: NavItemDef[] = ALL_ROUTES.filter((item) => !TAB_PATHS.includes(item.to))

export const MORE_PATHS: NavPath[] = MORE_ITEMS.map((item) => item.to)
