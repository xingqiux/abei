import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  redirect,
} from '@tanstack/react-router'
import { AdminShell } from '../components/layout/AdminShell'
import { NotFoundPage } from '../components/layout/NotFoundPage'

const MailWorkbenchPage = lazyRouteComponent(
  () => import('../features/mail/MailWorkbenchPage'),
  'MailWorkbenchPage',
)
const ParserWorkbenchPage = lazyRouteComponent(
  () => import('../features/parser/ParserWorkbenchPage'),
  'ParserWorkbenchPage',
)
const BillDocumentsPage = lazyRouteComponent(
  () => import('../features/documents/BillDocumentsPage'),
  'BillDocumentsPage',
)
const AdminFeedbackPage = lazyRouteComponent(
  () => import('../features/feedback/AdminFeedbackPage'),
  'AdminFeedbackPage',
)
const GoogleOAuthCallbackPage = lazyRouteComponent(
  () => import('../features/mailbox/GoogleOAuthCallbackPage'),
  'GoogleOAuthCallbackPage',
)

const rootRoute = createRootRoute({ component: AdminShell })

/** 后台没有「概况」，进门就是最常用的邮件工作台。 */
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: '/mail' })
  },
})

const mailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/mail',
  component: MailWorkbenchPage,
})

/**
 * 账单文档诊断台。筛选条件放在 URL 里：处理统计的「查看 N 封解析失败」是带着
 * `?status=failed` 跳过来的，也方便把「这份解析卡住了」的链接直接发给别人。
 */
const documentsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/documents',
  validateSearch: (search: Record<string, unknown>): { status?: string; channel?: string } => ({
    status: typeof search.status === 'string' && search.status !== '' ? search.status : undefined,
    channel: typeof search.channel === 'string' && search.channel !== '' ? search.channel : undefined,
  }),
  component: BillDocumentsPage,
})

const parserRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/parser',
  validateSearch: (search: Record<string, unknown>): { flow?: string; sample?: string } => ({
    flow: typeof search.flow === 'string' && search.flow !== '' ? search.flow : undefined,
    sample: typeof search.sample === 'string' && search.sample !== '' ? search.sample : undefined,
  }),
  component: ParserWorkbenchPage,
})

const feedbackRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/feedback',
  component: AdminFeedbackPage,
})

/**
 * Google 授权回跳。邮箱是在后台的同步器设置里连的，所以回跳也得落在后台这个源上——
 * 服务端登记的是 loopback redirect（`http://127.0.0.1/oauth/google/callback`），
 * 端口不参与匹配，前台后台各自的源都能收。
 */
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

const routeTree = rootRoute.addChildren([
  indexRoute,
  mailRoute,
  documentsRoute,
  parserRoute,
  feedbackRoute,
  googleOAuthCallbackRoute,
])

export const router = createRouter({ routeTree, defaultNotFoundComponent: NotFoundPage })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
