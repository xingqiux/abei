import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AbeiApiError } from '../../api/client'
import { ProfilePage } from './ProfilePage'

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPatch: vi.fn(),
  apiDeleteJson: vi.fn(),
  blocker: vi.fn(),
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
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useBlocker: mocks.blocker,
}))

const document = {
  slug: 'personal-accounting-rules',
  title: '个人记账规则',
  content_md: '# 个人记账规则\n',
  version: 3,
  content_sha256: 'abc',
  updated_by: 'owner@example.com',
  updated_source: 'web' as const,
  created_at: '2026-08-10T08:00:00Z',
  updated_at: '2026-08-11T08:00:00Z',
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <ProfilePage />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  mocks.apiGet.mockReset().mockImplementation((path: string) => {
    if (path === '/v1/profile-doc') {
      const { content_md: _content, ...summary } = document
      return Promise.resolve({ data: [summary] })
    }
    return Promise.resolve({ data: document })
  })
  mocks.apiPost.mockReset().mockResolvedValue({ data: document })
  mocks.apiPatch.mockReset().mockResolvedValue({ data: { ...document, version: 4 } })
  mocks.apiDeleteJson.mockReset().mockResolvedValue({
    data: { slug: document.slug, version: 3, revision_count: 3, deleted: true },
  })
  mocks.blocker.mockReset()
  mocks.toast.mockReset()
})

describe('ProfilePage', () => {
  it('更新时携带读到的版本号，并固定来源为 web', async () => {
    renderPage()
    const editor = await screen.findByLabelText('Markdown 正文')

    fireEvent.change(editor, {
      target: { value: '# 个人记账规则\n\n已更新。\n' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() =>
      expect(mocks.apiPatch).toHaveBeenCalledWith(
        '/v1/profile-doc/personal-accounting-rules',
        {
          expected_version: 3,
          title: '个人记账规则',
          content_md: '# 个人记账规则\n\n已更新。\n',
          source: 'web',
        },
        { confirm: true },
      ),
    )
  })

  it('版本冲突时保留本地草稿，不静默覆盖', async () => {
    mocks.apiPatch.mockRejectedValue(
      new AbeiApiError(409, '版本冲突', {
        detail: '文档已是版本 4。',
        reason: 'Conflict',
      }),
    )
    renderPage()
    const editor = await screen.findByLabelText('Markdown 正文')
    fireEvent.change(editor, { target: { value: '本地尚未保存的内容' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('当前草稿仍保留')
    expect(screen.getByLabelText('Markdown 正文')).toHaveValue('本地尚未保存的内容')
    expect(screen.getByRole('button', { name: '重新载入' })).toBeInTheDocument()
  })

  it('有未保存草稿时拦截站内导航和页面离开', async () => {
    renderPage()
    const editor = await screen.findByLabelText('Markdown 正文')
    fireEvent.change(editor, { target: { value: '尚未保存' } })

    await waitFor(() => {
      expect(mocks.blocker.mock.calls.at(-1)?.[0].enableBeforeUnload).toBe(true)
    })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const options = mocks.blocker.mock.calls.at(-1)?.[0]
    expect(options.shouldBlockFn()).toBe(true)
    confirm.mockReturnValue(true)
    expect(options.shouldBlockFn()).toBe(false)
  })

  it('永久删除当前版本及历史前要求确认', async () => {
    renderPage()
    const editor = await screen.findByLabelText('Markdown 正文')
    fireEvent.change(editor, { target: { value: '尚未保存的修改' } })
    fireEvent.click(screen.getByRole('button', { name: '删除资料' }))

    expect(screen.getByText(/全部历史版本将被永久删除/)).toBeInTheDocument()
    expect(screen.getByText('当前未保存的修改也会丢失。')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '永久删除' }))

    await waitFor(() => expect(mocks.apiDeleteJson).toHaveBeenCalledWith(
      '/v1/profile-doc/personal-accounting-rules',
      { expected_version: 3 },
      { confirm: true },
    ))
    await waitFor(() => expect(screen.getAllByText('还没有资料文档')).toHaveLength(2))
    expect(mocks.toast).toHaveBeenCalledWith({ kind: 'success', message: '资料已删除' })
  })
})
