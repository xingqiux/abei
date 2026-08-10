import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { deleteAccount } from '../../api/firefly'
import type { Account } from '../../api/schemas'
import { AccountDetailPage } from './AccountDetailPage'

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
  deleteAccount: vi.fn(),
  deleteTx: vi.fn(),
  navigate: vi.fn(),
  refetch: vi.fn(),
  toast: vi.fn(),
  state: {
    account: null as Account | null,
    accountLoading: false,
    accountError: false,
    deletePending: false,
  },
}))

vi.mock('../../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/client')>()),
  apiGet: mocks.apiGet,
  apiPut: mocks.apiPut,
  apiDelete: mocks.apiDelete,
}))
// 读接口按 ReconciliationPage 的老办法整体替身；删除那条走真的 api/firefly，
// 好让断言落在真实的 HTTP 动词上（见下面 beforeEach 里的 mockImplementation）
vi.mock('../../api/queries', () => ({
  useAccount: () => ({
    data: mocks.state.account ? { data: mocks.state.account } : undefined,
    isLoading: mocks.state.accountLoading,
    isError: mocks.state.accountError,
    refetch: mocks.refetch,
  }),
  useAccountOverviewChart: () => ({ data: [], isLoading: false, isError: false }),
  useInfiniteAccountTransactions: () => ({
    data: { pages: [{ data: [], meta: { pagination: { total: 0 } } }] },
    isLoading: false,
    isError: false,
    isSuccess: true,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
    refetch: mocks.refetch,
  }),
  useDeleteTransaction: () => ({ mutateAsync: mocks.deleteTx, isPending: false }),
  useDeleteAccount: () => ({ mutateAsync: mocks.deleteAccount, isPending: mocks.state.deletePending }),
}))
vi.mock('../../store/dateRangeStore', () => ({
  useDateRangeStore: () => ({ start: '2026-08-01', end: '2026-08-31' }),
}))
vi.mock('../../store/toastStore', () => ({ showToast: mocks.toast }))
vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ accountId: '7' }),
  useNavigate: () => mocks.navigate,
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
}))
vi.mock('../../motion/useStaggerIn', () => ({ useStaggerIn: () => ({ current: null }) }))
vi.mock('../../components/abei/BalanceAreaChart', () => ({ BalanceAreaChart: () => null }))
vi.mock('../../components/abei/TransactionRow', () => ({ TransactionRow: () => null }))
vi.mock('../../components/abei/DeleteTransactionDialog', () => ({ DeleteTransactionDialog: () => null }))
vi.mock('../../components/abei/Skeleton', () => ({ Skeleton: () => null }))
vi.mock('../../components/abei/EmptyState', () => ({ EmptyState: ({ message }: { message: string }) => <div>{message}</div> }))
vi.mock('../../components/abei/ErrorState', () => ({ ErrorState: ({ message }: { message: string }) => <div>{message}</div> }))

const ACCOUNT: Account = {
  id: '7',
  attributes: {
    name: '招行储蓄卡',
    type: 'asset',
    active: true,
    currency_code: 'CNY',
    currency_symbol: '¥',
    current_balance: '1234.50',
    last_activity: '2026-08-01T00:00:00+08:00',
  },
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <AccountDetailPage />
    </QueryClientProvider>,
  )
}

const confirmInput = () => screen.getByLabelText('输入账户名确认')
const deleteButton = () => screen.getByRole('button', { name: '删除账户' })

beforeEach(() => {
  mocks.state.account = ACCOUNT
  mocks.state.accountLoading = false
  mocks.state.accountError = false
  mocks.state.deletePending = false
  // 全时段笔数：GET /v1/firefly/api/v1/accounts/7/transactions
  mocks.apiGet.mockReset().mockResolvedValue({ data: [], meta: { pagination: { total: 42 } } })
  mocks.apiPut.mockReset()
  mocks.apiDelete.mockReset().mockResolvedValue(undefined)
  mocks.deleteAccount.mockReset().mockImplementation((id: string) => deleteAccount(id))
  mocks.navigate.mockReset()
  mocks.toast.mockReset()
})

describe('AccountDetailPage 危险区守卫', () => {
  it('什么都没输时删除按钮就是禁用的', async () => {
    renderPage()
    await screen.findByRole('heading', { name: '招行储蓄卡' })

    expect(confirmInput()).toHaveValue('')
    expect(deleteButton()).toBeDisabled()
  })

  it.each([
    ['名字不全', '招行'],
    ['多了空格', '招行储蓄卡 '],
    ['完全不相干', '别的卡'],
    ['只差一个字', '招行储蓄卞'],
  ])('输入%s时删除按钮保持禁用', async (_case, typed) => {
    renderPage()
    await screen.findByRole('heading', { name: '招行储蓄卡' })

    fireEvent.change(confirmInput(), { target: { value: typed } })

    expect(deleteButton()).toBeDisabled()
  })

  it('名字输对了才可点', async () => {
    renderPage()
    await screen.findByRole('heading', { name: '招行储蓄卡' })

    fireEvent.change(confirmInput(), { target: { value: '招行储蓄卡' } })
    expect(deleteButton()).toBeEnabled()

    // 再改错又锁回去
    fireEvent.change(confirmInput(), { target: { value: '招行储蓄卡x' } })
    expect(deleteButton()).toBeDisabled()
  })

  it('禁用状态下点下去不会发出任何请求', async () => {
    renderPage()
    await screen.findByRole('heading', { name: '招行储蓄卡' })

    fireEvent.click(deleteButton())

    expect(mocks.deleteAccount).not.toHaveBeenCalled()
    expect(mocks.apiDelete).not.toHaveBeenCalled()
  })

  it('删除中按钮变文案并锁住，防连点', async () => {
    mocks.state.deletePending = true
    renderPage()
    await screen.findByRole('heading', { name: '招行储蓄卡' })

    fireEvent.change(confirmInput(), { target: { value: '招行储蓄卡' } })

    const button = screen.getByRole('button', { name: '删除中…' })
    expect(button).toBeDisabled()
  })

  it('先说清楚会连带删掉多少笔交易', async () => {
    renderPage()

    const warning = await screen.findByText(/这会同时删除该账户下的/)
    // 笔数是单独一个 all-time 查询，落地前先占位显示 …
    expect(warning).toHaveTextContent('这会同时删除该账户下的 … 笔交易，不可撤销。')

    await waitFor(() => expect(warning).toHaveTextContent('这会同时删除该账户下的 42 笔交易，不可撤销。'))
    // 「要一字不差输什么」写在输入框正下方的说明里，不塞进上面那段后果描述
    expect(screen.getByText('需要一字不差地输入「招行储蓄卡」')).toBeInTheDocument()
    expect(mocks.apiGet).toHaveBeenCalledWith(
      '/v1/firefly/api/v1/accounts/7/transactions',
      expect.objectContaining({ start: '2000-01-01', end: '2100-01-01', limit: 1 }),
    )
  })
})

describe('AccountDetailPage 确认删除', () => {
  it('确认后走 DELETE /v1/firefly/api/v1/accounts/{id}，不是归档的 PUT', async () => {
    renderPage()
    await screen.findByRole('heading', { name: '招行储蓄卡' })

    fireEvent.change(confirmInput(), { target: { value: '招行储蓄卡' } })
    fireEvent.click(deleteButton())

    await waitFor(() => expect(mocks.deleteAccount).toHaveBeenCalledWith('7'))
    await waitFor(() => expect(mocks.apiDelete).toHaveBeenCalledWith('/v1/firefly/api/v1/accounts/7'))
    // 删除是删除，归档是归档，这里绝不能退化成 PUT active=false
    expect(mocks.apiPut).not.toHaveBeenCalled()
    expect(mocks.apiDelete).toHaveBeenCalledTimes(1)
  })

  it('删掉之后提示成功并回账户列表', async () => {
    renderPage()
    await screen.findByRole('heading', { name: '招行储蓄卡' })

    fireEvent.change(confirmInput(), { target: { value: '招行储蓄卡' } })
    fireEvent.click(deleteButton())

    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith({ kind: 'success', message: '账户已删除' }))
    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/accounts', search: { view: undefined } })
  })

  it('删除失败时留在原地报错，不跳走也不谎报成功', async () => {
    mocks.apiDelete.mockReset().mockRejectedValue(new Error('账户下有未结算交易'))
    renderPage()
    await screen.findByRole('heading', { name: '招行储蓄卡' })

    fireEvent.change(confirmInput(), { target: { value: '招行储蓄卡' } })
    fireEvent.click(deleteButton())

    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ kind: 'error' })))
    expect(mocks.navigate).not.toHaveBeenCalled()
    expect(mocks.toast).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'success' }))
    expect(screen.getByRole('heading', { name: '招行储蓄卡' })).toBeInTheDocument()
  })
})

describe('AccountDetailPage 概览', () => {
  it('显示账户名、类型和当前余额', async () => {
    renderPage()

    expect(await screen.findByRole('heading', { name: '招行储蓄卡' })).toBeInTheDocument()
    expect(screen.getByText('当前余额')).toBeInTheDocument()
    expect(screen.getByText('¥1,234.50')).toBeInTheDocument()
    expect(screen.getAllByText('资产').length).toBeGreaterThan(0)
  })

  it('余额为负时用负债色', async () => {
    mocks.state.account = { ...ACCOUNT, attributes: { ...ACCOUNT.attributes, current_balance: '-500.00' } }
    renderPage()
    await screen.findByRole('heading', { name: '招行储蓄卡' })

    expect(screen.getByText('¥500.00')).toHaveClass('text-[var(--liability)]')
  })

  it('账户加载失败时只给错误态，不渲染危险区', async () => {
    mocks.state.account = null
    mocks.state.accountError = true
    renderPage()

    expect(await screen.findByText('账户加载失败或不存在')).toBeInTheDocument()
    expect(screen.queryByLabelText('输入账户名确认删除')).not.toBeInTheDocument()
  })
})
