import { createRootRoute, createRoute, createRouter, lazyRouteComponent } from '@tanstack/react-router'
import { AppShell } from '../components/layout/AppShell'

const DashboardPage = lazyRouteComponent(() => import('../features/dashboard/DashboardPage'), 'DashboardPage')
const TransactionsPage = lazyRouteComponent(() => import('../features/transactions/TransactionsPage'), 'TransactionsPage')
const AccountsPage = lazyRouteComponent(() => import('../features/accounts/AccountsPage'), 'AccountsPage')
const AccountDetailPage = lazyRouteComponent(() => import('../features/accounts/AccountDetailPage'), 'AccountDetailPage')
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

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: SettingsPage,
})

const routeTree = rootRoute.addChildren([
  indexRoute,
  transactionsRoute,
  accountsRoute,
  accountDetailRoute,
  settingsRoute,
])

export const router = createRouter({ routeTree })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
