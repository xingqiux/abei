import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TokensPanel } from './TokensPanel'

const mocks = vi.hoisted(() => ({
  fireflyFetch: vi.fn(),
  fireflyDelete: vi.fn(),
  fireflyPost: vi.fn(),
  copy: vi.fn(),
  toast: vi.fn(),
}))

// 只换掉 HTTP 原语，api/firefly 与 api/queries 都跑真的，这样断言的是真实的动词和路径
vi.mock('../../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/client')>()),
  fireflyFetch: mocks.fireflyFetch,
  fireflyDelete: mocks.fireflyDelete,
  fireflyPost: mocks.fireflyPost,
}))
vi.mock('../../store/toastStore', () => ({ showToast: mocks.toast }))
vi.mock('../../components/abaku/Modal', () => ({
  Modal: ({ open, title, children, footer }: { open: boolean; title: string; children: ReactNode; footer: ReactNode }) =>
    open ? <div role="dialog" aria-label={title}>{children}{footer}</div> : null,
}))
vi.mock('../../components/abaku/Skeleton', () => ({ Skeleton: () => null }))
vi.mock('../../components/abaku/ErrorState', () => ({
  ErrorState: ({ message, onRetry }: { message: string; onRetry: () => void }) => (
    <div>{message}<button type="button" onClick={onRetry}>重试</button></div>
  ),
}))

const token = (over: Partial<{ id: string; name: string; created_at: string | null; current: boolean }> = {}) => ({
  id: '1',
  name: 'CLI 脚本',
  created_at: '2026-08-01T10:00:00+08:00',
  expires_at: null,
  current: false,
  ...over,
})

const SESSION_TOKEN = token({ id: '9', name: '当前浏览器', current: true })

function renderPanel() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <TokensPanel />
    </QueryClientProvider>,
  )
}

/** 令牌行 = 名字所在的那个 flex 行容器 */
// 按语义结构取行，不按类名——类名一改样式测试就红，但结构（li）是稳定的
function rowOf(name: string): HTMLElement {
  return screen.getByText(name).closest('li') as HTMLElement
}

beforeEach(() => {
  mocks.fireflyFetch.mockReset().mockResolvedValue({ data: [token(), SESSION_TOKEN] })
  mocks.fireflyDelete.mockReset().mockResolvedValue(undefined)
  mocks.fireflyPost.mockReset()
  mocks.copy.mockReset().mockResolvedValue(undefined)
  mocks.toast.mockReset()
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: mocks.copy },
  })
})

describe('TokensPanel 列表', () => {
  it('从 GET /api/v1/tokens 列出每个令牌的名字与签发时间', async () => {
    renderPanel()

    expect(await screen.findByText('CLI 脚本')).toBeInTheDocument()
    expect(mocks.fireflyFetch).toHaveBeenCalledWith('/api/v1/tokens')
    expect(screen.getByText('当前浏览器')).toBeInTheDocument()
    expect(rowOf('CLI 脚本')).toHaveTextContent('签发于')
  })

  it('当前会话那条打「当前会话」标记', async () => {
    renderPanel()
    await screen.findByText('CLI 脚本')

    expect(within(rowOf('当前浏览器')).getByText('当前会话')).toBeInTheDocument()
    expect(within(rowOf('CLI 脚本')).queryByText('当前会话')).not.toBeInTheDocument()
  })

  it('加载失败时给错误态而不是空列表', async () => {
    mocks.fireflyFetch.mockReset().mockRejectedValue(new Error('boom'))
    renderPanel()

    expect(await screen.findByText('令牌列表加载失败')).toBeInTheDocument()
  })
})

describe('TokensPanel 撤销', () => {
  it('确认后走 DELETE /api/v1/tokens/{id}，并刷新列表', async () => {
    mocks.fireflyFetch
      .mockReset()
      .mockResolvedValueOnce({ data: [token(), SESSION_TOKEN] })
      .mockResolvedValue({ data: [SESSION_TOKEN] })
    renderPanel()
    await screen.findByText('CLI 脚本')

    fireEvent.click(within(rowOf('CLI 脚本')).getByRole('button', { name: '撤销' }))

    const dialog = await screen.findByRole('dialog', { name: '撤销令牌' })
    expect(dialog).toHaveTextContent('确认撤销「CLI 脚本」？')
    fireEvent.click(within(dialog).getByRole('button', { name: '确认撤销' }))

    await waitFor(() => expect(mocks.fireflyDelete).toHaveBeenCalledWith('/api/v1/tokens/1'))
    expect(mocks.fireflyDelete).toHaveBeenCalledTimes(1)

    // 撤销成功后列表重新拉一次，被撤的那条消失
    await waitFor(() => expect(screen.queryByText('CLI 脚本')).not.toBeInTheDocument())
    expect(screen.getByText('当前浏览器')).toBeInTheDocument()
    expect(mocks.toast).toHaveBeenCalledWith({ kind: 'success', message: '已撤销「CLI 脚本」' })
  })

  it('点取消不发任何请求', async () => {
    renderPanel()
    await screen.findByText('CLI 脚本')

    fireEvent.click(within(rowOf('CLI 脚本')).getByRole('button', { name: '撤销' }))
    fireEvent.click(within(await screen.findByRole('dialog', { name: '撤销令牌' })).getByRole('button', { name: '取消' }))

    await waitFor(() => expect(screen.queryByRole('dialog', { name: '撤销令牌' })).not.toBeInTheDocument())
    expect(mocks.fireflyDelete).not.toHaveBeenCalled()
  })

  it('撤销失败时留在弹层里并报错，不假装成功', async () => {
    mocks.fireflyDelete.mockReset().mockRejectedValue(new Error('令牌不存在'))
    renderPanel()
    await screen.findByText('CLI 脚本')

    fireEvent.click(within(rowOf('CLI 脚本')).getByRole('button', { name: '撤销' }))
    fireEvent.click(within(await screen.findByRole('dialog', { name: '撤销令牌' })).getByRole('button', { name: '确认撤销' }))

    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith({ kind: 'error', message: '令牌不存在' }))
    expect(screen.getByRole('dialog', { name: '撤销令牌' })).toBeInTheDocument()
    expect(screen.getByText('CLI 脚本')).toBeInTheDocument()
  })
})

describe('TokensPanel 保护当前会话', () => {
  it('当前会话那条不给撤销按钮，撤不掉自己', async () => {
    renderPanel()
    await screen.findByText('CLI 脚本')

    expect(within(rowOf('当前浏览器')).queryByRole('button', { name: '撤销' })).not.toBeInTheDocument()
    expect(within(rowOf('CLI 脚本')).getByRole('button', { name: '撤销' })).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: '撤销' })).toHaveLength(1)
  })

  it('全是当前会话时一个撤销按钮都没有', async () => {
    mocks.fireflyFetch.mockReset().mockResolvedValue({ data: [SESSION_TOKEN] })
    renderPanel()
    await screen.findByText('当前浏览器')

    expect(screen.queryAllByRole('button', { name: '撤销' })).toHaveLength(0)
  })
})

describe('TokensPanel 生成', () => {
  it('生成走 POST /api/v1/tokens，并给出完整的 ffc 配对命令', async () => {
    mocks.fireflyPost.mockResolvedValue({ data: { access_token: 'pat-abc-123' } })
    renderPanel()
    await screen.findByText('CLI 脚本')

    fireEvent.click(screen.getByRole('button', { name: '生成配对命令' }))

    const dialog = await screen.findByRole('dialog', { name: '连接 ffc' })
    expect(mocks.fireflyPost).toHaveBeenCalledWith('/api/v1/tokens', { name: 'ffc CLI' })
    expect(within(dialog).getByText(/ffc auth set-token --profile abaku --url .* --token 'pat-abc-123'/)).toBeInTheDocument()
  })

  it('一键复制完整配对命令，不会切换当前浏览器令牌', async () => {
    mocks.fireflyPost.mockResolvedValue({ data: { access_token: 'pat-abc-123' } })
    renderPanel()
    await screen.findByText('CLI 脚本')

    fireEvent.click(screen.getByRole('button', { name: '生成配对命令' }))
    const dialog = await screen.findByRole('dialog', { name: '连接 ffc' })
    fireEvent.click(within(dialog).getByRole('button', { name: '复制配对命令' }))

    await waitFor(() => expect(mocks.copy).toHaveBeenCalledWith(
      expect.stringMatching(/^ffc auth set-token --profile abaku --url '.+' --token 'pat-abc-123'$/),
    ))
    expect(within(dialog).getByRole('button', { name: '已复制' })).toBeInTheDocument()
    expect(mocks.toast).toHaveBeenCalledWith({ kind: 'success', message: '配对命令已复制' })
  })

  it('生成失败只报错，不弹明文弹层', async () => {
    mocks.fireflyPost.mockRejectedValue(new Error('没有权限'))
    renderPanel()
    await screen.findByText('CLI 脚本')

    fireEvent.click(screen.getByRole('button', { name: '生成配对命令' }))

    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith({ kind: 'error', message: '没有权限' }))
    expect(screen.queryByRole('dialog', { name: '连接 ffc' })).not.toBeInTheDocument()
  })
})
