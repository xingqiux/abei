import { createRootRoute, createRoute, createRouter, lazyRouteComponent, Link, redirect } from '@tanstack/react-router'
import { AppShell } from '../components/layout/AppShell'
import { normalizeInboxSearch, type InboxSearch } from '../features/bill-inbox/billInboxHelpers'
import { isBudgetsTab } from '../features/budgets/budgetsHelpers'
import { validateTransactionSearch } from './transactionSearch'

const TodayPage = lazyRouteComponent(() => import('../features/today/TodayPage'), 'TodayPage')
const AssistantPage = lazyRouteComponent(() => import('../features/assistant/AssistantPage'), 'AssistantPage')
const TransactionsPage = lazyRouteComponent(() => import('../features/transactions/TransactionsPage'), 'TransactionsPage')
const BillInboxPage = lazyRouteComponent(() => import('../features/bill-inbox/BillInboxPage'), 'BillInboxPage')
const MailProcessingPage = lazyRouteComponent(
  () => import('../features/bill-inbox/MailProcessingPage'),
  'MailProcessingPage',
)
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
const ProfilePage = lazyRouteComponent(() => import('../features/profile/ProfilePage'), 'ProfilePage')
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
  /**
   * 两层坐标：tab（待处理 / 已完成）+ done（已完成层看哪一半）+ section（待处理层滚到哪一块）。
   * 四个老 view 值（importable/attention/dismissed/imported）在这里被折算过去，
   * 旧链接和旧书签照常能开——折算规则连同用例都在 billInboxHelpers 里。
   */
  validateSearch: (search: Record<string, unknown>): InboxSearch => normalizeInboxSearch(search),
  component: BillInboxPage,
})

/**
 * 「邮件处理」二级页（L2）。只有一个坐标：钉在哪一封邮件上（要解锁的那封）。
 * 首屏的聚合横幅点「去解锁」时带着 task 进来，落地就能看见密码框。
 */
const mailProcessingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/bill-inbox/mail',
  validateSearch: (search: Record<string, unknown>): { task?: string } => ({
    task: typeof search.task === 'string' && search.task !== '' ? search.task : undefined,
  }),
  component: MailProcessingPage,
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

const profileRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/profile',
  component: ProfilePage,
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
  mailProcessingRoute,
  googleOAuthCallbackRoute,
  accountsRoute,
  accountDetailRoute,
  budgetsRoute,
  referenceDataRoute,
  analysisRoute,
  legacyReportsRoute,
  feedbackRoute,
  profileRoute,
  settingsRoute,
  catchAllRoute,
])

export const router = createRouter({ routeTree, defaultNotFoundComponent: NotFoundPage })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
