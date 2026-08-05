import { createRootRoute, createRoute, createRouter, lazyRouteComponent, redirect } from '@tanstack/react-router'
import { AppShell } from '../components/layout/AppShell'
import { validateTransactionSearch } from './transactionSearch'

const TodayPage = lazyRouteComponent(() => import('../features/today/TodayPage'), 'TodayPage')
const TransactionsPage = lazyRouteComponent(() => import('../features/transactions/TransactionsPage'), 'TransactionsPage')
const BillInboxPage = lazyRouteComponent(() => import('../features/bill-inbox/BillInboxPage'), 'BillInboxPage')
const ReconciliationPage = lazyRouteComponent(() => import('../features/reconciliation/ReconciliationPage'), 'ReconciliationPage')
const BudgetsPage = lazyRouteComponent(() => import('../features/budgets/BudgetsPage'), 'BudgetsPage')
const AccountsPage = lazyRouteComponent(() => import('../features/accounts/AccountsPage'), 'AccountsPage')
const AccountDetailPage = lazyRouteComponent(() => import('../features/accounts/AccountDetailPage'), 'AccountDetailPage')
const AnalysisPage = lazyRouteComponent(() => import('../features/analysis/AnalysisPage'), 'AnalysisPage')
const SettingsPage = lazyRouteComponent(() => import('../features/settings/SettingsPage'), 'SettingsPage')

const rootRoute = createRootRoute({
  component: AppShell,
})

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: TodayPage,
})

const transactionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/transactions',
  validateSearch: validateTransactionSearch,
  component: TransactionsPage,
})

const billInboxRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/bill-inbox',
  component: BillInboxPage,
})

const reconciliationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/reconciliation',
  component: ReconciliationPage,
})

const budgetsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/budgets',
  validateSearch: (search: Record<string, unknown>) => ({
    tab: typeof search.tab === 'string' && search.tab !== '' ? search.tab : undefined,
  }),
  component: BudgetsPage,
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

const analysisRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/analysis',
  component: AnalysisPage,
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
  component: SettingsPage,
})

const routeTree = rootRoute.addChildren([
  indexRoute,
  transactionsRoute,
  billInboxRoute,
  reconciliationRoute,
  budgetsRoute,
  accountsRoute,
  accountDetailRoute,
  analysisRoute,
  legacyReportsRoute,
  settingsRoute,
])

export const router = createRouter({ routeTree })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
