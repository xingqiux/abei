import { createRootRoute, createRoute, createRouter, lazyRouteComponent, redirect } from '@tanstack/react-router'
import { AppShell } from '../components/layout/AppShell'
import { isInboxTab } from '../features/bill-inbox/billInboxHelpers'
import { validateTransactionSearch } from './transactionSearch'

const TodayPage = lazyRouteComponent(() => import('../features/today/TodayPage'), 'TodayPage')
const AssistantPage = lazyRouteComponent(() => import('../features/assistant/AssistantPage'), 'AssistantPage')
const TransactionsPage = lazyRouteComponent(() => import('../features/transactions/TransactionsPage'), 'TransactionsPage')
const BillInboxPage = lazyRouteComponent(() => import('../features/bill-inbox/BillInboxPage'), 'BillInboxPage')
const ReconciliationPage = lazyRouteComponent(() => import('../features/reconciliation/ReconciliationPage'), 'ReconciliationPage')
const AccountsPage = lazyRouteComponent(() => import('../features/accounts/AccountsPage'), 'AccountsPage')
const AccountDetailPage = lazyRouteComponent(() => import('../features/accounts/AccountDetailPage'), 'AccountDetailPage')
const ReferenceDataPage = lazyRouteComponent(() => import('../features/reference-data/ReferenceDataPage'), 'ReferenceDataPage')
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
  validateSearch: validateTransactionSearch,
  component: TransactionsPage,
})

const billInboxRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/bill-inbox',
  validateSearch: (search: Record<string, unknown>) => ({
    tab: isInboxTab(search.tab) ? search.tab : undefined,
  }),
  component: BillInboxPage,
})

const reconciliationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/reconciliation',
  component: ReconciliationPage,
})

const accountsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/accounts',
  validateSearch: (search: Record<string, unknown>) => ({
    view: search.view === 'budgets' ? 'budgets' : search.view === 'subscriptions' ? 'subscriptions' : undefined,
  }),
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

const referenceDataRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/reference-data',
  component: ReferenceDataPage,
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
  assistantRoute,
  transactionsRoute,
  billInboxRoute,
  reconciliationRoute,
  accountsRoute,
  accountDetailRoute,
  referenceDataRoute,
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
