import { StrictMode, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TokensPanel } from './TokensPanel'

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiDelete: vi.fn(),
  apiPost: vi.fn(),
  copy: vi.fn(),
  toast: vi.fn(),
}))

// 只换掉 HTTP 原语，api/firefly 与 api/queries 都跑真的，这样断言的是真实的动词和路径
vi.mock('../../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/client')>()),
  apiGet: mocks.apiGet,
  apiDelete: mocks.apiDelete,
  apiPost: mocks.apiPost,
}))
vi.mock('../../store/toastStore', () => ({ showToast: mocks.toast }))
vi.mock('../../components/abei/Modal', () => ({
  Modal: ({ open, title, children, footer }: { open: boolean; title: string; children: ReactNode; footer: ReactNode }) =>
    open ? <div role="dialog" aria-label={title}>{children}{footer}</div> : null,
}))
vi.mock('../../components/abei/Skeleton', () => ({ Skeleton: () => null }))
vi.mock('../../components/abei/ErrorState', () => ({
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

function renderPanel(autoPair = false, strict = false) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const panel = (
    <QueryClientProvider client={queryClient}>
      <TokensPanel autoPair={autoPair} />
    </QueryClientProvider>
  )
  return render(
    strict ? <StrictMode>{panel}</StrictMode> : panel,
  )
}

/** 令牌行 = 名字所在的那个 flex 行容器 */
// 按语义结构取行，不按类名——类名一改样式测试就红，但结构（li）是稳定的
function rowOf(name: string): HTMLElement {
  return screen.getByText(name).closest('li') as HTMLElement
}

beforeEach(() => {
  mocks.apiGet.mockReset().mockResolvedValue({ data: [token(), SESSION_TOKEN] })
  mocks.apiDelete.mockReset().mockResolvedValue(undefined)
  mocks.apiPost.mockReset()
  mocks.copy.mockReset().mockResolvedValue(undefined)
  mocks.toast.mockReset()
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: mocks.copy },
  })
})

describe('TokensPanel 列表', () => {
  it('从 GET /v1/firefly/api/v1/tokens 列出每个令牌的名字与签发时间', async () => {
    renderPanel()

    expect(await screen.findByText('CLI 脚本')).toBeInTheDocument()
    // 只钉路径：查询参数那一位是逃生舱包装透传的，带不带 undefined 不是契约。
    expect(mocks.apiGet.mock.calls[0][0]).toBe('/v1/firefly/api/v1/tokens')
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
    mocks.apiGet.mockReset().mockRejectedValue(new Error('boom'))
    renderPanel()

    expect(await screen.findByText('令牌列表加载失败')).toBeInTheDocument()
  })
})

describe('TokensPanel 撤销', () => {
  it('确认后走 DELETE /v1/firefly/api/v1/tokens/{id}，并刷新列表', async () => {
    mocks.apiGet
      .mockReset()
      .mockResolvedValueOnce({ data: [token(), SESSION_TOKEN] })
      .mockResolvedValue({ data: [SESSION_TOKEN] })
    renderPanel()
    await screen.findByText('CLI 脚本')

    fireEvent.click(within(rowOf('CLI 脚本')).getByRole('button', { name: '撤销' }))

    const dialog = await screen.findByRole('dialog', { name: '撤销令牌' })
    expect(dialog).toHaveTextContent('确认撤销「CLI 脚本」？')
    fireEvent.click(within(dialog).getByRole('button', { name: '确认撤销' }))

    await waitFor(() => expect(mocks.apiDelete).toHaveBeenCalledWith('/v1/firefly/api/v1/tokens/1'))
    expect(mocks.apiDelete).toHaveBeenCalledTimes(1)

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
    expect(mocks.apiDelete).not.toHaveBeenCalled()
  })

  it('撤销失败时留在弹层里并报错，不假装成功', async () => {
    mocks.apiDelete.mockReset().mockRejectedValue(new Error('令牌不存在'))
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
    mocks.apiGet.mockReset().mockResolvedValue({ data: [SESSION_TOKEN] })
    renderPanel()
    await screen.findByText('当前浏览器')

    expect(screen.queryAllByRole('button', { name: '撤销' })).toHaveLength(0)
  })
})

describe('TokensPanel 生成', () => {
  it('深链自动生成一次，并直接打开配对弹窗', async () => {
    mocks.apiPost.mockResolvedValue({ data: { access_token: 'pat-auto' } })
    renderPanel(true, true)

    const dialog = await screen.findByRole('dialog', { name: '连接 abei CLI' })
    expect(within(dialog).getByText(/--token 'pat-auto'/)).toBeInTheDocument()
    expect(mocks.apiPost).toHaveBeenCalledTimes(1)
  })

  it('普通打开不会自动生成令牌', async () => {
    renderPanel()
    await screen.findByText('CLI 脚本')

    expect(mocks.apiPost).not.toHaveBeenCalled()
  })

  it('生成走 POST /v1/firefly/api/v1/tokens，并给出完整的 abei 配对命令', async () => {
    mocks.apiPost.mockResolvedValue({ data: { access_token: 'pat-abc-123' } })
    renderPanel()
    await screen.findByText('CLI 脚本')

    fireEvent.click(screen.getByRole('button', { name: '生成配对命令' }))

    const dialog = await screen.findByRole('dialog', { name: '连接 abei CLI' })
    expect(mocks.apiPost).toHaveBeenCalledWith('/v1/firefly/api/v1/tokens', { name: 'abei CLI' })
    expect(within(dialog).getByText(/abei auth login --url .* --token 'pat-abc-123'/)).toBeInTheDocument()
  })

  it('一键复制完整配对命令，不会切换当前浏览器令牌', async () => {
    mocks.apiPost.mockResolvedValue({ data: { access_token: 'pat-abc-123' } })
    renderPanel()
    await screen.findByText('CLI 脚本')

    fireEvent.click(screen.getByRole('button', { name: '生成配对命令' }))
    const dialog = await screen.findByRole('dialog', { name: '连接 abei CLI' })
    fireEvent.click(within(dialog).getByRole('button', { name: '复制配对命令' }))

    await waitFor(() => expect(mocks.copy).toHaveBeenCalledWith(
      expect.stringMatching(/^abei auth login --url '.+' --token 'pat-abc-123'$/),
    ))
    expect(within(dialog).getByRole('button', { name: '已复制' })).toBeInTheDocument()
    expect(mocks.toast).toHaveBeenCalledWith({ kind: 'success', message: '配对命令已复制' })
  })

  it('生成失败只报错，不弹明文弹层', async () => {
    mocks.apiPost.mockRejectedValue(new Error('没有权限'))
    renderPanel()
    await screen.findByText('CLI 脚本')

    fireEvent.click(screen.getByRole('button', { name: '生成配对命令' }))

    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith({ kind: 'error', message: '没有权限' }))
    expect(screen.queryByRole('dialog', { name: '连接 abei CLI' })).not.toBeInTheDocument()
  })
})
