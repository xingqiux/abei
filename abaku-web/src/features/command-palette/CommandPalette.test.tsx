import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CommandPalette } from './CommandPalette'
import { useCommandPaletteStore } from '../../store/commandPaletteStore'

const mocks = vi.hoisted(() => ({ navigate: vi.fn(), transactionError: false, accountError: false }))

// 保留原模块：CommandPalette 现在经 routes/router 取 txSearch，而 router.tsx 在模块顶层就用到了
// lazyRouteComponent / createRoute 这些真家伙
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => mocks.navigate,
}))
vi.mock('gsap', () => ({ default: { fromTo: vi.fn() } }))
vi.mock('../../components/abaku/LottieIcon', () => ({ LottieIcon: () => null }))
vi.mock('../../components/abaku/useDialogBehavior', () => ({ useDialogBehavior: vi.fn() }))
vi.mock('../../api/queries', () => ({
  useSearchTransactions: () => ({
    data: {
      data: [{
        id: '42',
        attributes: {
          transactions: [{
            description: 'Coffee shop',
            date: '2026-07-20T10:00:00-07:00',
            amount: '12.34',
            currency_symbol: '$',
            type: 'withdrawal',
          }],
        },
      }],
    },
    isFetching: false,
    isError: mocks.transactionError,
    refetch: vi.fn(),
  }),
  useSearchTransactionCount: () => ({ data: { count: 27 }, isFetching: false, isError: mocks.transactionError, refetch: vi.fn() }),
  useSearchAccounts: () => ({
    data: { data: [{ id: '8', attributes: { name: 'Checking account', type: 'asset' } }], meta: { pagination: { total: 12 } } },
    isFetching: false,
    isError: mocks.accountError,
    refetch: vi.fn(),
  }),
}))

describe('CommandPalette', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.navigate.mockReset()
    mocks.transactionError = false
    mocks.accountError = false
    useCommandPaletteStore.setState({ open: true })
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
  })

  afterEach(() => {
    useCommandPaletteStore.setState({ open: false })
    vi.useRealTimers()
  })

  function search() {
    render(<CommandPalette />)
    fireEvent.change(screen.getByLabelText('命令面板搜索'), { target: { value: 'coffee' } })
    act(() => vi.advanceTimersByTime(300))
  }

  it('shows the full result count and opens a transaction deep link', () => {
    search()

    expect(screen.getByText('搜索交易组 · 27')).toBeInTheDocument()
    expect(screen.getByText('搜索账户 · 12')).toBeInTheDocument()
    expect(screen.getByText('Checking account')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Coffee shop'))

    // txSearch 会把交易页九个搜索参数补全，深链只覆盖 transaction 这一项
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: '/transactions',
      search: { transaction: 42, q: undefined, acc: [], cat: [], tag: [], min: undefined, max: undefined, type: undefined, page: 1 },
    })
  })

  it('opens an account search result directly', () => {
    search()
    fireEvent.click(screen.getByText('Checking account'))

    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/accounts/$accountId', params: { accountId: '8' } })
  })

  it('shows account search failures separately from empty results', () => {
    mocks.accountError = true
    search()

    expect(screen.getByText('账户搜索失败')).toBeInTheDocument()
    expect(screen.queryByText('没有匹配结果')).not.toBeInTheDocument()
  })
})
