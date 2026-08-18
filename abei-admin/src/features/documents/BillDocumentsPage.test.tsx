import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { BillDocumentsPage } from './BillDocumentsPage'
import * as documentsApi from '../../api/documents'
import { AbeiApiError } from '../../api/client'

function renderPage(initialPath = '/documents') {
  const rootRoute = createRootRoute()
  const documentsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/documents',
    validateSearch: (search: Record<string, unknown>): { status?: string; channel?: string } => ({
      status: typeof search.status === 'string' ? search.status : undefined,
      channel: typeof search.channel === 'string' ? search.channel : undefined,
    }),
    component: BillDocumentsPage,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([documentsRoute]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  )
}

function document(overrides: Partial<documentsApi.BillDocument['attributes']> = {}): documentsApi.BillDocument {
  return {
    id: '12',
    type: 'bill-document',
    attributes: {
      source: 'cmb',
      channel_key: 'cmb',
      subject: '招商银行信用卡电子账单',
      parser_flow_id: '3',
      parser_flow_version: 2,
      active_revision: 1,
      lifecycle: 'active',
      status: 'failed',
      received_at: '2026-08-01 09:00:00',
      summary: null,
      account_hint: null,
      period_start: null,
      period_end: null,
      current_secret_challenge_id: null,
      error_code: 'pdf_password_required',
      error_message: '附件解密失败',
      metadata: {},
      row_counts: { total: 0, pending: 0, imported: 0, duplicate: 0, conflict: 0 },
      created_at: '2026-08-01 09:00:00',
      updated_at: '2026-08-01 09:00:00',
      ...overrides,
    },
  }
}

describe('BillDocumentsPage', () => {
  it('服务端还没上线这套端点时给一句人话，不是一屏请求失败', async () => {
    vi.spyOn(documentsApi, 'getBillDocuments').mockRejectedValue(
      new AbeiApiError(404, '未找到'),
    )

    renderPage()

    expect(await screen.findByText(/服务端尚未更新/)).toBeInTheDocument()
  })

  it('真出错时说的是加载失败，并给重试', async () => {
    vi.spyOn(documentsApi, 'getBillDocuments').mockRejectedValue(
      new AbeiApiError(500, '服务器错误'),
    )

    renderPage()

    // 「还没上线」和「挂了」是两件事，说错了会让人干等服务端发版。
    expect(await screen.findByRole('button', { name: '重试' })).toBeInTheDocument()
    expect(screen.queryByText(/服务端尚未更新/)).not.toBeInTheDocument()
  })

  it('列出文档，解析失败的显示错误原因', async () => {
    vi.spyOn(documentsApi, 'getBillDocuments').mockResolvedValue({
      data: [document()],
      meta: { pagination: { total: 1, count: 1, per_page: 50, current_page: 1, total_pages: 1 } },
    })

    renderPage()

    expect(await screen.findByText('招商银行信用卡电子账单')).toBeInTheDocument()
    // 在表格里找，别撞上筛选下拉里同名的那个选项。
    const table = within(screen.getByRole('table'))
    expect(table.getByText('解析失败')).toBeInTheDocument()
    expect(table.getByText('附件解密失败')).toBeInTheDocument()
  })

  it('带 status 进来时按它筛选，不是拉全部', async () => {
    const list = vi.spyOn(documentsApi, 'getBillDocuments').mockResolvedValue({
      data: [],
      meta: { pagination: { total: 0, count: 0, per_page: 50, current_page: 1, total_pages: 1 } },
    })

    renderPage('/documents?status=failed')

    // 处理统计里的「查看 N 封解析失败」就是这么跳过来的，丢了筛选等于跳了个寂寞。
    await screen.findByText(/没有账单文档|当前筛选下没有账单文档/)
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }))
  })
})
