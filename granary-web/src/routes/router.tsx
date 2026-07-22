import { createRootRoute, createRoute, createRouter, lazyRouteComponent } from '@tanstack/react-router'
import { AppShell } from '../components/layout/AppShell'

const DashboardPage = lazyRouteComponent(() => import('../features/dashboard/DashboardPage'), 'DashboardPage')
const TransactionsPage = lazyRouteComponent(() => import('../features/transactions/TransactionsPage'), 'TransactionsPage')
const ReconciliationPage = lazyRouteComponent(() => import('../features/reconciliation/ReconciliationPage'), 'ReconciliationPage')
const BillInboxPage = lazyRouteComponent(() => import('../features/bill-inbox/BillInboxPage'), 'BillInboxPage')
const BudgetsPage = lazyRouteComponent(() => import('../features/budgets/BudgetsPage'), 'BudgetsPage')
const AccountsPage = lazyRouteComponent(() => import('../features/accounts/AccountsPage'), 'AccountsPage')
const AccountDetailPage = lazyRouteComponent(() => import('../features/accounts/AccountDetailPage'), 'AccountDetailPage')
const ReportsPage = lazyRouteComponent(() => import('../features/reports/ReportsPage'), 'ReportsPage')
const SettingsPage = lazyRouteComponent(() => import('../features/settings/SettingsPage'), 'SettingsPage')

const rootRoute = createRootRoute({
  component: AppShell,
})

export function validateTransactionSearch(search: Record<string, unknown>) {
  const rawId = search.transaction
  const transaction = typeof rawId === 'number'
    ? rawId
    : typeof rawId === 'string' && /^\d+$/.test(rawId)
      ? Number(rawId)
      : Number.NaN

  return {
    transaction: Number.isSafeInteger(transaction) && transaction > 0 ? transaction : undefined,
  }
}

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: DashboardPage,
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

const reportsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/reports',
  component: ReportsPage,
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
  reportsRoute,
  settingsRoute,
])

export const router = createRouter({ routeTree })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
