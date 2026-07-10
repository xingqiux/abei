import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import { AppShell } from '../components/layout/AppShell'
import { DashboardPage } from '../features/dashboard/DashboardPage'
import { TransactionsPage } from '../features/transactions/TransactionsPage'
import { ReconciliationPage } from '../features/reconciliation/ReconciliationPage'
import { BillInboxPage } from '../features/bill-inbox/BillInboxPage'
import { BudgetsPage } from '../features/budgets/BudgetsPage'
import { AccountsPage } from '../features/accounts/AccountsPage'
import { AccountDetailPage } from '../features/accounts/AccountDetailPage'
import { ReportsPage } from '../features/reports/ReportsPage'
import { SettingsPage } from '../features/settings/SettingsPage'

const rootRoute = createRootRoute({
  component: AppShell,
})

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: DashboardPage,
})

const transactionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/transactions',
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
