import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AdminFeedbackPage } from './AdminFeedbackPage'

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  listSubmissions: vi.fn(),
  getSubmission: vi.fn(),
  messageSubmission: vi.fn(),
  linkSubmission: vi.fn(),
  moderateSubmission: vi.fn(),
  listItems: vi.fn(),
  getItem: vi.fn(),
  updateItem: vi.fn(),
  publishUpdate: vi.fn(),
  mergeItem: vi.fn(),
  archiveItem: vi.fn(),
  restoreItem: vi.fn(),
}))

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
}))

vi.mock('../../api/feedback', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/feedback')>()),
  getSession: mocks.getSession,
  listAdminFeedbackSubmissions: mocks.listSubmissions,
  getAdminFeedbackSubmission: mocks.getSubmission,
  messageAdminFeedbackSubmission: mocks.messageSubmission,
  linkAdminFeedbackSubmission: mocks.linkSubmission,
  moderateAdminFeedbackSubmission: mocks.moderateSubmission,
  listAdminFeedbackItems: mocks.listItems,
  getAdminFeedbackItem: mocks.getItem,
  updateAdminFeedbackItem: mocks.updateItem,
  publishAdminFeedbackUpdate: mocks.publishUpdate,
  mergeAdminFeedbackItem: mocks.mergeItem,
  archiveAdminFeedbackItem: mocks.archiveItem,
  restoreAdminFeedbackItem: mocks.restoreItem,
}))

const candidate = {
  feedback_id: 42,
  title: '账单导入没有结果',
  kind: 'bug',
  target: 'cli',
  status: 'reviewing',
  affected_users: 3,
  occurrences: 5,
  match: { reason: 'fingerprint', confidence: 'high', score: 0.91, algorithm_version: 1 },
}

const submission = {
  submission_id: 91,
  feedback_id: null,
  user_id: 7,
  kind: 'bug',
  target: 'cli',
  submitted_via: 'cli',
  message: '导入账单后一直没有结果',
  expected: '看到导入结果',
  actual: '命令一直等待',
  state: 'pending_confirmation',
  context: { cli_version: '0.1.0', recent: { capability_id: 'bills.import', result: 'error' } },
  fingerprint_version: 1,
  has_fingerprint: true,
  match_algorithm_version: 1,
  candidates: [candidate],
  item_title: null,
  item_status: null,
  message_count: 0,
  created_at: '2026-08-11T08:00:00-07:00',
  linked_at: null,
  last_seen_at: '2026-08-11T08:00:00-07:00',
}

const item = {
  feedback_id: 42,
  title: '账单导入没有结果',
  kind: 'bug',
  target: 'cli',
  status: 'reviewing',
  severity: 'high',
  public_summary: '正在定位导入队列。',
  close_reason: null,
  merged_into_id: null,
  affected_users: 3,
  occurrences: 5,
  first_seen: '2026-08-09T08:00:00-07:00',
  last_seen: '2026-08-11T08:00:00-07:00',
  archived_at: null,
  archived_by: null,
  created_at: '2026-08-09T08:00:00-07:00',
  updated_at: '2026-08-11T08:00:00-07:00',
  completed_at: null,
}

const itemDetail = {
  data: item,
  updates: [],
  submissions: [
    {
      submission_id: 90,
      kind: 'bug',
      target: 'cli',
      submitted_via: 'cli',
      message: '账单导入超时',
      expected: null,
      actual: null,
      state: 'linked',
      context: { cli_version: '0.1.0' },
      match_candidates: [],
      created_at: '2026-08-10T08:00:00-07:00',
      linked_at: '2026-08-10T08:01:00-07:00',
      last_seen_at: '2026-08-10T08:00:00-07:00',
    },
  ],
  messages: [],
  audit: [],
  permissions: { manage: true },
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <AdminFeedbackPage />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  Object.values(mocks).forEach((mock) => mock.mockReset())
  mocks.getSession.mockResolvedValue({ data: { user_id: 1, actor: 'owner', role: 'owner', is_owner: true } })
  mocks.listSubmissions.mockResolvedValue({ data: [submission], pagination: { limit: 100, offset: 0, count: 1 } })
  mocks.getSubmission.mockResolvedValue({ data: submission, messages: [], audit: [] })
  mocks.listItems.mockImplementation(({ archived }: { archived?: boolean } = {}) => Promise.resolve({
    data: archived ? [] : [item],
    pagination: { limit: 100, offset: 0, count: archived ? 0 : 1 },
  }))
  mocks.getItem.mockResolvedValue(itemDetail)
  mocks.messageSubmission.mockResolvedValue({ id: 1, submission_id: 91, author_kind: 'admin', body: '请提供文件格式', created_at: '2026-08-11T09:00:00-07:00' })
  mocks.linkSubmission.mockResolvedValue({ data: { ...submission, feedback_id: 42, state: 'linked' }, messages: [], audit: [] })
  mocks.moderateSubmission.mockResolvedValue({ data: submission, messages: [], audit: [] })
  mocks.updateItem.mockResolvedValue(itemDetail)
  mocks.publishUpdate.mockResolvedValue({ id: 1, item_id: 42, body: '处理中', status: 'reviewing', created_at: '2026-08-11T09:00:00-07:00' })
  mocks.mergeItem.mockResolvedValue(itemDetail)
  mocks.archiveItem.mockResolvedValue(itemDetail)
  mocks.restoreItem.mockResolvedValue(itemDetail)
})

describe('AdminFeedbackPage', () => {
  it('非 owner 只看到权限门禁且不会请求管理数据', async () => {
    mocks.getSession.mockResolvedValue({ data: { user_id: 2, actor: 'demo', role: 'demo', is_owner: false } })

    renderPage()

    expect(await screen.findByText('只有 owner 可以进入反馈管理')).toBeInTheDocument()
    expect(mocks.listSubmissions).not.toHaveBeenCalled()
    expect(mocks.listItems).not.toHaveBeenCalled()
  })

  it('管理员可以查看运行上下文、追问并关联现有 Item', async () => {
    renderPage()

    expect(await screen.findByText('导入账单后一直没有结果')).toBeInTheDocument()
    expect(await screen.findByText(/bills\.import/)).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('向用户追问'), { target: { value: '请提供文件格式' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(mocks.messageSubmission).toHaveBeenCalledWith(91, '请提供文件格式'))

    fireEvent.change(screen.getByLabelText('处理理由'), { target: { value: '与现有导入问题一致' } })
    fireEvent.change(screen.getByLabelText('关联现有 Feedback ID'), { target: { value: '42' } })
    const linkButtons = screen.getAllByRole('button', { name: '关联' })
    fireEvent.click(linkButtons[linkButtons.length - 1])

    await waitFor(() => expect(mocks.linkSubmission).toHaveBeenCalledWith(91, {
      item_id: 42,
      reason: '与现有导入问题一致',
    }))
  })

  it('编辑 Item 时同步完成进展并可显式清空严重程度', async () => {
    renderPage()
    fireEvent.click(await screen.findByRole('tab', { name: /反馈事项/ }))

    expect(await screen.findByDisplayValue('账单导入没有结果')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('类型'), { target: { value: 'suggestion' } })
    fireEvent.change(screen.getByLabelText('状态'), { target: { value: 'completed' } })
    expect(screen.getByText('当前状态变化必须同步一条公开进展')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('随状态发布的进展'), { target: { value: '导入队列已修复' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(mocks.updateItem).toHaveBeenCalledWith(42, expect.objectContaining({
      kind: 'suggestion',
      status: 'completed',
      severity: null,
      update: '导入队列已修复',
    })))
  })

  it('合并 Item 前要求明确目标、理由和二次确认', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    renderPage()
    fireEvent.click(await screen.findByRole('tab', { name: /反馈事项/ }))

    await screen.findByDisplayValue('账单导入没有结果')
    fireEvent.change(screen.getByLabelText('操作理由'), { target: { value: '与目标事项重复' } })
    fireEvent.change(screen.getByLabelText('合并到 Feedback ID'), { target: { value: '77' } })
    fireEvent.click(screen.getByRole('button', { name: '合并' }))

    await waitFor(() => expect(mocks.mergeItem).toHaveBeenCalledWith(42, 77, '与目标事项重复'))
    expect(window.confirm).toHaveBeenCalledWith('将 Feedback #42 的全部 Submission 合并到 #77，确定继续吗？')
  })

  it('可以带审计理由归档一个活动 Item', async () => {
    renderPage()
    fireEvent.click(await screen.findByRole('tab', { name: /反馈事项/ }))

    await screen.findByDisplayValue('账单导入没有结果')
    fireEvent.change(screen.getByLabelText('操作理由'), { target: { value: '当前无需展示' } })
    fireEvent.click(screen.getByRole('button', { name: '归档反馈事项' }))

    await waitFor(() => expect(mocks.archiveItem).toHaveBeenCalledWith(42, '当前无需展示'))
  })

  it('可以从归档视图恢复未合并的 Item', async () => {
    const archivedItem = {
      ...item,
      archived_at: '2026-08-11T10:00:00-07:00',
      archived_by: 'owner',
    }
    mocks.listItems.mockImplementation(({ archived }: { archived?: boolean } = {}) => Promise.resolve({
      data: archived ? [archivedItem] : [],
      pagination: { limit: 100, offset: 0, count: archived ? 1 : 0 },
    }))
    mocks.getItem.mockResolvedValue({
      ...itemDetail,
      data: archivedItem,
    })

    renderPage()
    fireEvent.click(await screen.findByRole('tab', { name: /归档/ }))

    await screen.findByText('Feedback #42')
    fireEvent.change(screen.getByLabelText('操作理由'), { target: { value: '重新进入处理队列' } })
    fireEvent.click(screen.getByRole('button', { name: '恢复到反馈事项' }))

    await waitFor(() => expect(mocks.restoreItem).toHaveBeenCalledWith(42, '重新进入处理队列'))
  })
})
