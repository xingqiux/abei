import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AbeiApiError } from '../../api/client'
import { FeedbackPage } from './FeedbackPage'

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPatch: vi.fn(),
  apiDeleteJson: vi.fn(),
  toast: vi.fn(),
}))

vi.mock('../../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/client')>()),
  apiGet: mocks.apiGet,
  apiPost: mocks.apiPost,
  apiPatch: mocks.apiPatch,
  apiDeleteJson: mocks.apiDeleteJson,
}))
vi.mock('../../store/toastStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../store/toastStore')>()),
  showToast: mocks.toast,
}))

const feedback = [
  {
    id: 3,
    title: 'GitHub 同步失败',
    body: '重试时仍然失败',
    labels: ['sync'],
    kind: 'bug',
    submitted_by: '测试用户',
    source: 'web',
    status: 'open',
    response: null,
    responded_by: null,
    responded_at: null,
    duplicate_of: null,
    sync_status: 'failed',
    github_issue_url: null,
    github_issue_number: null,
    sync_error: 'GitHub 返回 503',
    created_at: '2026-08-09T10:00:00-07:00',
    updated_at: '2026-08-09T10:00:00-07:00',
  },
  {
    id: 2,
    title: '已经同步',
    body: '正文',
    labels: [],
    kind: 'idea',
    submitted_by: 'abei-cli',
    source: 'cli',
    status: 'completed',
    response: '已处理',
    responded_by: 'owner@example.com',
    responded_at: '2026-08-09T09:30:00-07:00',
    duplicate_of: null,
    sync_status: 'synced',
    github_issue_url: 'https://github.com/example/abei/issues/42',
    github_issue_number: 42,
    sync_error: null,
    created_at: '2026-08-09T09:00:00-07:00',
    updated_at: '2026-08-09T09:00:00-07:00',
  },
  {
    id: 1,
    title: '只存本地',
    body: '本地反馈',
    labels: ['web'],
    kind: 'friction',
    submitted_by: 'AI',
    source: 'cli',
    status: 'open',
    response: null,
    responded_by: null,
    responded_at: null,
    duplicate_of: null,
    sync_status: 'local',
    github_issue_url: null,
    github_issue_number: null,
    sync_error: null,
    created_at: '2026-08-09T08:00:00-07:00',
    updated_at: '2026-08-09T08:00:00-07:00',
  },
] as const

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <FeedbackPage />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  localStorage.clear()
  mocks.apiGet.mockReset().mockResolvedValue({
    data: feedback,
    pagination: { count: feedback.length, limit: 20, offset: 0 },
    permissions: { manage: true },
  })
  mocks.apiPost.mockReset().mockResolvedValue({ data: feedback[0] })
  mocks.apiPatch.mockReset().mockResolvedValue({ data: feedback[0] })
  mocks.apiDeleteJson.mockReset().mockResolvedValue({ data: { id: 3, deleted: true } })
  mocks.toast.mockReset()
})

describe('FeedbackPage', () => {
  it('列表显示三种 GitHub 同步状态，并能查看失败原因', async () => {
    renderPage()

    expect(await screen.findByText('GitHub 同步失败')).toBeInTheDocument()
    expect(screen.getByText('仅本地')).toBeInTheDocument()
    expect(screen.getByText('已同步')).toBeInTheDocument()
    expect(screen.getByText('同步失败')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /GitHub 同步失败/ }))
    expect(screen.getByText(/GitHub 返回 503/)).toBeInTheDocument()
  })

  it("提交时调用 apiPost，并固定 source 为 'web'", async () => {
    renderPage()
    await screen.findByText('只存本地')

    fireEvent.change(screen.getByLabelText('标题'), { target: { value: '网页反馈' } })
    fireEvent.change(screen.getByLabelText('正文'), { target: { value: '复现步骤' } })
    fireEvent.change(screen.getByLabelText('标签'), { target: { value: 'web, ux' } })
    fireEvent.change(screen.getByLabelText('提交人'), { target: { value: '小贝' } })
    fireEvent.click(screen.getByRole('button', { name: '提交反馈' }))

    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalledWith(
      '/v1/feedback',
      {
        title: '网页反馈',
        body: '复现步骤',
        kind: 'bug',
        labels: ['web', 'ux'],
        submitted_by: '小贝',
        source: 'web',
      },
      { confirm: true },
    ))
    expect(localStorage.getItem('abei.feedback.submitted-by')).toBe('小贝')
    expect(mocks.toast).toHaveBeenCalledWith({ kind: 'success', message: '反馈已提交' })
  })

  it('展示 422 返回的 detail', async () => {
    mocks.apiPost.mockRejectedValue(new AbeiApiError(422, '提交内容不合法', { detail: 'title 最多 120 字。' }))
    renderPage()
    await screen.findByText('只存本地')

    fireEvent.change(screen.getByLabelText('标题'), { target: { value: '标题' } })
    fireEvent.change(screen.getByLabelText('正文'), { target: { value: '正文' } })
    fireEvent.change(screen.getByLabelText('提交人'), { target: { value: '测试用户' } })
    fireEvent.click(screen.getByRole('button', { name: '提交反馈' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('title 最多 120 字。')
  })

  it('owner 可以处理、重试同步并删除反馈', async () => {
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: /GitHub 同步失败/ }))

    fireEvent.click(screen.getByRole('button', { name: '重试同步' }))
    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalledWith(
      '/v1/feedback/3/retry',
      {},
      { confirm: true },
    ))

    fireEvent.click(screen.getByRole('button', { name: '处理' }))
    fireEvent.change(screen.getByLabelText('处理状态'), { target: { value: 'completed' } })
    fireEvent.change(screen.getByLabelText('处理说明'), { target: { value: '已修复' } })
    fireEvent.click(screen.getByRole('button', { name: '保存处理结果' }))
    await waitFor(() => expect(mocks.apiPatch).toHaveBeenCalledWith(
      '/v1/feedback/3',
      { status: 'completed', response: '已修复', duplicate_of: null },
      { confirm: true },
    ))

    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    fireEvent.change(screen.getByLabelText('删除原因'), { target: { value: '包含隐私' } })
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }))
    await waitFor(() => expect(mocks.apiDeleteJson).toHaveBeenCalledWith(
      '/v1/feedback/3',
      { reason: '包含隐私' },
      { confirm: true },
    ))
  })
})
