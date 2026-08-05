import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Account } from '../../api/schemas'
import { AccountsPage } from './AccountsPage'

const mocks = vi.hoisted(() => ({
  fireflyFetch: vi.fn(),
  fireflyPut: vi.fn(),
  fireflyDelete: vi.fn(),
  fireflyPost: vi.fn(),
  toast: vi.fn(),
}))

// 只换 HTTP 原语，api/firefly 与 api/queries 跑真的，这样能钉死「归档按钮到底发了什么请求」
vi.mock('../../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/client')>()),
  fireflyFetch: mocks.fireflyFetch,
  fireflyPut: mocks.fireflyPut,
  fireflyDelete: mocks.fireflyDelete,
  fireflyPost: mocks.fireflyPost,
}))
vi.mock('../../store/toastStore', () => ({ showToast: mocks.toast }))
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, params: _params, children, ...props }: { to: string; params?: unknown; children: ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
}))
vi.mock('../../motion/useStaggerIn', () => ({ useStaggerIn: () => ({ current: null }) }))
vi.mock('./AccountDialog', () => ({ AccountDialog: ({ open }: { open: boolean }) => (open ? <div role="dialog" aria-label="账户表单" /> : null) }))
vi.mock('../../components/abaku/Skeleton', () => ({ Skeleton: () => null }))
vi.mock('../../components/abaku/EmptyState', () => ({ EmptyState: ({ message }: { message: string }) => <div>{message}</div> }))

function account(over: Partial<Account['attributes']> & { id: string }): Account {
  const { id, ...attrs } = over
  return {
    id,
    attributes: {
      name: '招行储蓄卡',
      type: 'asset',
      active: true,
      currency_code: 'CNY',
      currency_symbol: '¥',
      current_balance: '1234.50',
      account_role: 'defaultAsset',
      last_activity: '2026-08-01T00:00:00+08:00',
      ...attrs,
    },
  }
}

const CHECKING = account({ id: '1', name: '招行储蓄卡', current_balance: '1234.50' })
const SAVINGS = account({ id: '2', name: '余额宝', current_balance: '800.00' })

function accountsPage(data: Account[]) {
  return { data, meta: { pagination: { total: data.length, current_page: 1, total_pages: 1, per_page: 40 } } }
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <AccountsPage />
    </QueryClientProvider>,
  )
}

function stubAccounts(list: Account[]) {
  mocks.fireflyFetch.mockImplementation((path: string) => {
    if (path === '/api/v1/accounts') return Promise.resolve(accountsPage(list))
    const match = /^\/api\/v1\/accounts\/(\d+)$/.exec(path)
    if (match) {
      const found = list.find((a) => a.id === match[1])
      if (found) return Promise.resolve({ data: found })
    }
    return Promise.reject(new Error(`unexpected GET ${path}`))
  })
}

beforeEach(() => {
  mocks.fireflyFetch.mockReset()
  mocks.fireflyPut.mockReset().mockImplementation((path: string) => {
    const id = /\/(\d+)$/.exec(path)?.[1] ?? '1'
    return Promise.resolve({ data: account({ id }) })
  })
  mocks.fireflyDelete.mockReset().mockResolvedValue(undefined)
  mocks.fireflyPost.mockReset()
  mocks.toast.mockReset()
  stubAccounts([CHECKING, SAVINGS])
})

describe('AccountsPage 列表', () => {
  it('列出账户名、余额和总数', async () => {
    renderPage()

    expect(await screen.findByText('招行储蓄卡')).toBeInTheDocument()
    expect(screen.getByText('¥1,234.50')).toBeInTheDocument()
    expect(screen.getByText('¥800.00')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()
    expect(mocks.fireflyFetch).toHaveBeenCalledWith('/api/v1/accounts', { type: 'asset', limit: 40, page: 1 })
  })

  it('资产合计按币种汇总已加载的全部资产账户', async () => {
    renderPage()
    await screen.findByText('招行储蓄卡')

    expect(screen.getByText('资产余额合计')).toBeInTheDocument()
    expect(screen.getByText('¥2,034.50')).toBeInTheDocument()
  })

  it('默认藏起已归档账户，勾上才显示', async () => {
    stubAccounts([CHECKING, account({ id: '3', name: '旧卡', active: false })])
    renderPage()
    await screen.findByText('招行储蓄卡')

    expect(screen.queryByText('旧卡')).not.toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('显示已归档'))

    expect(screen.getByText('旧卡')).toBeInTheDocument()
    expect(screen.getByText('已归档')).toBeInTheDocument()
  })
})

describe('AccountsPage 归档', () => {
  it('「归档」发的是 PUT active=false，绝不是 DELETE', async () => {
    renderPage()
    await screen.findByText('招行储蓄卡')

    fireEvent.click(screen.getByRole('button', { name: '归档 招行储蓄卡' }))

    await waitFor(() => expect(mocks.fireflyPut).toHaveBeenCalledWith(
      '/api/v1/accounts/1',
      expect.objectContaining({ name: '招行储蓄卡', active: false }),
    ))
    // 这里以前把「归档」接到了 DELETE，会连着账户下的交易一起删掉
    expect(mocks.fireflyDelete).not.toHaveBeenCalled()
    expect(mocks.fireflyPut).toHaveBeenCalledTimes(1)
    expect(mocks.toast).toHaveBeenCalledWith({ kind: 'success', message: '账户已归档，数据都还在' })
  })

  it('只动被点的那个账户', async () => {
    renderPage()
    await screen.findByText('余额宝')

    fireEvent.click(screen.getByRole('button', { name: '归档 余额宝' }))

    await waitFor(() => expect(mocks.fireflyPut).toHaveBeenCalledWith(
      '/api/v1/accounts/2',
      expect.objectContaining({ name: '余额宝', active: false }),
    ))
    expect(mocks.fireflyDelete).not.toHaveBeenCalled()
  })

  it('「恢复」发的是 PUT active=true', async () => {
    stubAccounts([account({ id: '3', name: '旧卡', active: false })])
    renderPage()
    await screen.findByText('显示已归档')
    fireEvent.click(screen.getByLabelText('显示已归档'))

    fireEvent.click(await screen.findByRole('button', { name: '恢复 旧卡' }))

    await waitFor(() => expect(mocks.fireflyPut).toHaveBeenCalledWith(
      '/api/v1/accounts/3',
      expect.objectContaining({ name: '旧卡', active: true }),
    ))
    expect(mocks.fireflyDelete).not.toHaveBeenCalled()
    expect(mocks.toast).toHaveBeenCalledWith({ kind: 'success', message: '账户已恢复' })
  })

  it('归档失败时报错，不谎报成功', async () => {
    mocks.fireflyPut.mockReset().mockRejectedValue(new Error('boom'))
    renderPage()
    await screen.findByText('招行储蓄卡')

    fireEvent.click(screen.getByRole('button', { name: '归档 招行储蓄卡' }))

    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'error' }),
    ))
    expect(mocks.toast).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'success' }))
    expect(mocks.fireflyDelete).not.toHaveBeenCalled()
  })
})

describe('AccountsPage 分类页签', () => {
  it('切到负债页签按新类型重新拉数据', async () => {
    renderPage()
    await screen.findByText('招行储蓄卡')

    fireEvent.click(screen.getByRole('button', { name: '负债' }))

    await waitFor(() => expect(mocks.fireflyFetch).toHaveBeenCalledWith(
      '/api/v1/accounts',
      { type: 'liabilities', limit: 40, page: 1 },
    ))
  })

  it('该类型没有账户时给对应空态', async () => {
    stubAccounts([])
    renderPage()

    expect(await screen.findByText('还没有资产账户')).toBeInTheDocument()
  })
})
