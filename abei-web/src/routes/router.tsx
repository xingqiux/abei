import { createRootRoute, createRoute, createRouter, lazyRouteComponent, Link, redirect } from '@tanstack/react-router'
import { AppShell } from '../components/layout/AppShell'
import { isInboxView, type InboxView } from '../features/bill-inbox/billInboxHelpers'
import { isBudgetsTab } from '../features/budgets/budgetsHelpers'
import { validateTransactionSearch } from './transactionSearch'

const TodayPage = lazyRouteComponent(() => import('../features/today/TodayPage'), 'TodayPage')
const AssistantPage = lazyRouteComponent(() => import('../features/assistant/AssistantPage'), 'AssistantPage')
const TransactionsPage = lazyRouteComponent(() => import('../features/transactions/TransactionsPage'), 'TransactionsPage')
const BillInboxPage = lazyRouteComponent(() => import('../features/bill-inbox/BillInboxPage'), 'BillInboxPage')
const GoogleOAuthCallbackPage = lazyRouteComponent(
  () => import('../features/bill-inbox/GoogleOAuthCallbackPage'),
  'GoogleOAuthCallbackPage',
)
const AccountsPage = lazyRouteComponent(() => import('../features/accounts/AccountsPage'), 'AccountsPage')
const AccountDetailPage = lazyRouteComponent(() => import('../features/accounts/AccountDetailPage'), 'AccountDetailPage')
const BudgetsPage = lazyRouteComponent(() => import('../features/budgets/BudgetsPage'), 'BudgetsPage')
const ReferenceDataPage = lazyRouteComponent(() => import('../features/reference-data/ReferenceDataPage'), 'ReferenceDataPage')
const AnalysisPage = lazyRouteComponent(() => import('../features/analysis/AnalysisPage'), 'AnalysisPage')
const FeedbackPage = lazyRouteComponent(() => import('../features/feedback/FeedbackPage'), 'FeedbackPage')
const SettingsPage = lazyRouteComponent(() => import('../features/settings/SettingsPage'), 'SettingsPage')

const rootRoute = createRootRoute({
  component: AppShell,
})

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: TodayPage,
})

const assistantRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/assistant',
  validateSearch: (search: Record<string, unknown>) => ({
    session: typeof search.session === 'string' && search.session !== '' ? search.session : undefined,
  }),
  component: AssistantPage,
})

const transactionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/transactions',
  // 形状（含可选的 ?view=uncategorized）在 transactionSearch.ts 里，那边是纯函数，
  // 组件只为取搜索参数类型时不用把整棵路由树拖进模块图。
  validateSearch: validateTransactionSearch,
  component: TransactionsPage,
})

const billInboxRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/bill-inbox',
  validateSearch: (search: Record<string, unknown>): {
    source?: string
    view?: InboxView
    task?: string
  } => ({
    /** 渠道过滤，undefined = 全部渠道 */
    source: typeof search.source === 'string' && search.source !== '' ? search.source : undefined,
    /** 状态 tab：待入账 / 待确认 / 已忽略 / 已入账，undefined = 待入账 */
    view: isInboxView(search.view) ? search.view : undefined,
    /** 来源面板选中的那封邮件（bill task id），undefined = 全部邮件 */
    task: typeof search.task === 'string' && search.task !== '' ? search.task : undefined,
  }),
  component: BillInboxPage,
})

const googleOAuthCallbackRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/oauth/google/callback',
  validateSearch: (search: Record<string, unknown>): {
    code?: string
    state?: string
    error?: string
    errorDescription?: string
  } => ({
    code: typeof search.code === 'string' ? search.code : undefined,
    state: typeof search.state === 'string' ? search.state : undefined,
    error: typeof search.error === 'string' ? search.error : undefined,
    errorDescription: typeof search.error_description === 'string'
      ? search.error_description
      : undefined,
  }),
  component: GoogleOAuthCallbackPage,
})

const accountsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/accounts',
  component: AccountsPage,
})

const accountDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/accounts/$accountId',
  component: AccountDetailPage,
})

const budgetsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/budgets',
  validateSearch: (search: Record<string, unknown>) => ({
    view: isBudgetsTab(search.view) ? search.view : undefined,
  }),
  component: BudgetsPage,
})

const analysisRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/analysis',
  component: AnalysisPage,
})

const referenceDataRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/reference-data',
  component: ReferenceDataPage,
})

const feedbackRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/feedback',
  component: FeedbackPage,
})

const legacyReportsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/reports',
  beforeLoad: () => {
    throw redirect({ to: '/analysis' })
  },
})

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  // CLI 未配对时把浏览器开到 /settings?pair=1。注意路由默认用 JSON.parse 解查询值，
  // `?pair=1` 到手是数字 1 而不是字符串 '1'——只认字符串会让整个深链静默失效。
  validateSearch: (search: Record<string, unknown>): { pair?: boolean } => ({
    pair: search.pair === 1 || search.pair === '1' || search.pair === true || search.pair === 'true'
      ? true
      : undefined,
  }),
  component: SettingsPage,
})

/**
 * 404 兜底。删掉 /reconciliation 之后旧链接会落到这里，直接白屏的话
 * 用户只知道「坏了」，不知道去哪。
 */
function NotFoundPage() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-24 text-center">
      <p className="text-lg font-semibold text-[var(--text-primary)]">这个页面不在了</p>
      <p className="max-w-sm text-sm text-[var(--text-secondary)]">
        地址可能拼错了，或者这个功能已经下线。
      </p>
      <Link
        to="/"
        className="mt-1 inline-flex items-center rounded-md bg-[var(--brand)] px-3 py-1.5 text-[13px] font-semibold text-[var(--brand-on)] transition-colors hover:bg-[var(--brand-hover)]"
      >
        回今天
      </Link>
    </div>
  )
}

const catchAllRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '$',
  component: NotFoundPage,
})

const routeTree = rootRoute.addChildren([
  indexRoute,
  assistantRoute,
  transactionsRoute,
  billInboxRoute,
  googleOAuthCallbackRoute,
  accountsRoute,
  accountDetailRoute,
  budgetsRoute,
  referenceDataRoute,
  analysisRoute,
  legacyReportsRoute,
  feedbackRoute,
  settingsRoute,
  catchAllRoute,
])

export const router = createRouter({ routeTree, defaultNotFoundComponent: NotFoundPage })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
