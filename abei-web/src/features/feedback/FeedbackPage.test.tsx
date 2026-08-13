import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AbeiApiError } from '../../api/client'
import { FeedbackPage } from './FeedbackPage'

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
}))

vi.mock('../../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/client')>()),
  apiGet: mocks.apiGet,
  apiPost: mocks.apiPost,
}))

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
}))

const item = {
  feedback_id: 3,
  title: '邮箱同步失败',
  kind: 'bug',
  target: 'web',
  status: 'open',
  severity: null,
  public_summary: '同步后没有看到新邮件。',
  close_reason: null,
  affected_users: 2,
  occurrences: 3,
  first_seen: '2026-08-09T08:00:00-07:00',
  last_seen: '2026-08-11T08:00:00-07:00',
  my_submission_ids: [91],
  archived_at: null,
  created_at: '2026-08-09T08:00:00-07:00',
  updated_at: '2026-08-11T08:00:00-07:00',
  completed_at: null,
}

const listResponse = {
  data: [item],
  pending: [],
  pagination: { count: 1, limit: 100, offset: 0 },
}

const detailResponse = {
  data: item,
  updates: [],
  submissions: [
    {
      submission_id: 91,
      kind: 'bug',
      target: 'web',
      submitted_via: 'web',
      message: '点同步后没有新邮件。',
      expected: null,
      actual: null,
      state: 'linked',
      created_at: '2026-08-11T08:00:00-07:00',
      linked_at: '2026-08-11T08:00:01-07:00',
      last_seen_at: '2026-08-11T08:00:00-07:00',
    },
  ],
  messages: [],
  audit: [],
  permissions: { manage: false },
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <FeedbackPage />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  mocks.apiGet.mockReset().mockImplementation((path: string) => {
    if (path === '/v1/session') return Promise.resolve({ data: { user_id: 7, actor: 'demo', role: 'demo', is_owner: false } })
    if (path === '/v1/feedback/3') return Promise.resolve(detailResponse)
    return Promise.resolve(listResponse)
  })
  mocks.apiPost.mockReset().mockResolvedValue({
    submission_id: 92,
    feedback_id: 3,
    state: 'linked',
    status: 'open',
  })
})

describe('FeedbackPage', () => {
  it('owner 可以从用户反馈页进入管理端', async () => {
    mocks.apiGet.mockImplementation((path: string) => {
      if (path === '/v1/session') return Promise.resolve({ data: { user_id: 1, actor: 'owner', role: 'owner', is_owner: true } })
      return Promise.resolve(listResponse)
    })

    renderPage()

    expect(await screen.findByRole('link', { name: '管理反馈' })).toHaveAttribute('href', '/admin/feedback')
  })

  it('列出归一后的反馈并能查看自己的提交', async () => {
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: /邮箱同步失败/ }))

    expect(await screen.findByText('同步后没有看到新邮件。')).toBeInTheDocument()
    expect(screen.getByText('点同步后没有新邮件。')).toBeInTheDocument()
    expect(mocks.apiGet).toHaveBeenCalledWith('/v1/feedback/3')
  })

  it('提交当前反馈协议并固定来源为 web', async () => {
    renderPage()
    await screen.findByText('邮箱同步失败')

    fireEvent.change(screen.getByLabelText('描述'), { target: { value: '新问题描述' } })
    fireEvent.click(screen.getByRole('button', { name: '提交' }))

    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalledWith(
      '/v1/feedback',
      expect.objectContaining({
        kind: 'bug',
        target: 'web',
        message: '新问题描述',
        submitted_via: 'web',
        idempotency_key: expect.stringMatching(/^web:/),
        context: { recorded_at: expect.any(String) },
      }),
    ))
  })

  it('展示服务端返回的 detail', async () => {
    mocks.apiPost.mockRejectedValue(new AbeiApiError(400, '提交内容不合法', { detail: 'message 最多 4000 字。' }))
    renderPage()
    await screen.findByText('邮箱同步失败')

    fireEvent.change(screen.getByLabelText('描述'), { target: { value: '问题' } })
    const submit = screen.getByRole('button', { name: '提交' })
    await waitFor(() => expect(submit).toBeEnabled())
    fireEvent.submit(submit.closest('form') as HTMLFormElement)

    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalled())
    expect(await screen.findByText('message 最多 4000 字。')).toBeInTheDocument()
  })

  it('允许用户把待确认提交归一到已有反馈', async () => {
    const response = {
      ...listResponse,
      pending: [
        {
          submission_id: 99,
          kind: 'bug',
          target: 'web',
          submitted_via: 'web',
          message: '邮件没有进来。',
          expected: null,
          actual: null,
          state: 'needs_confirmation',
          candidates: [
            {
              feedback_id: 3,
              title: '邮箱同步失败',
              kind: 'bug',
              target: 'web',
              status: 'open',
              affected_users: 2,
              occurrences: 3,
              match: { reason: '文本相似', confidence: 'high', score: 0.92, algorithm_version: 1 },
            },
          ],
          created_at: '2026-08-11T08:00:00-07:00',
          last_seen_at: '2026-08-11T08:00:00-07:00',
        },
      ],
    }
    mocks.apiGet.mockImplementation((path: string) => path === '/v1/session'
      ? Promise.resolve({ data: { user_id: 7, actor: 'demo', role: 'demo', is_owner: false } })
      : Promise.resolve(response))
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: '确认相似项' }))
    fireEvent.click(screen.getByRole('button', { name: '是同一问题' }))

    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalledWith(
      '/v1/feedback/submissions/99/confirm',
      { same_as: 3 },
    ))
  })

  it('未归一的管理员追问在刷新后仍可见并可回复', async () => {
    const response = {
      ...listResponse,
      pending: [
        {
          submission_id: 99,
          kind: 'bug',
          target: 'cli',
          submitted_via: 'cli',
          message: '导入后没有结果',
          expected: null,
          actual: null,
          state: 'needs_information',
          candidates: [candidateForTest()],
          messages: [
            {
              id: 8,
              submission_id: 99,
              author_kind: 'admin',
              body: '请补充 abei 版本',
              created_at: '2026-08-11T09:00:00-07:00',
            },
          ],
          created_at: '2026-08-11T08:00:00-07:00',
          last_seen_at: '2026-08-11T09:00:00-07:00',
        },
      ],
    }
    mocks.apiGet.mockImplementation((path: string) => path === '/v1/session'
      ? Promise.resolve({ data: { user_id: 7, actor: 'demo', role: 'demo', is_owner: false } })
      : Promise.resolve(response))
    mocks.apiPost.mockResolvedValue({
      data: {
        id: 9,
        submission_id: 99,
        author_kind: 'user',
        body: '0.1.0',
        created_at: '2026-08-11T09:01:00-07:00',
      },
    })

    renderPage()

    expect(await screen.findByText('请补充 abei 版本')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('补充信息'), { target: { value: '0.1.0' } })
    fireEvent.click(screen.getByRole('button', { name: '回复' }))

    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalledWith(
      '/v1/feedback/submissions/99/messages',
      { message: '0.1.0' },
    ))
  })
})

function candidateForTest() {
  return {
    feedback_id: 3,
    title: '邮箱同步失败',
    kind: 'bug',
    target: 'web',
    status: 'open',
    affected_users: 2,
    occurrences: 3,
    match: { reason: '文本相似', confidence: 'high', score: 0.92, algorithm_version: 1 },
  }
}
