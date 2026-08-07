import type { ReactNode } from 'react'
import { render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Recurrence } from '../../api/schemas'
import { TodayPage } from './TodayPage'

const mocks = vi.hoisted(() => ({
  deleteTx: vi.fn(),
  refetch: vi.fn(),
  state: {
    inbox: { pending_total: 0, needs_code: 0, unprocessed: 0, failed: 0, channels: [] } as {
      pending_total: number
      needs_code: number
      unprocessed: number
      failed: number
      channels: Array<{ parsed: number }>
    },
    recon: { days_unreconciled: 0 },
    recurrences: { data: [] as Recurrence[] },
    summary: {} as Record<string, unknown>,
    budgets: { data: [] as Array<{ id: string }> },
    limitsByBudget: new Map<string, Array<{ amount: string }>>(),
    transactions: { data: [] as Array<{ id: string; attributes: { transactions: unknown[] } }> },
    transactionRange: null as { start: string; end: string } | null,
    pageKey: '',
  },
}))

vi.mock('../../api/queries', () => ({
  useBillInboxSummary: () => ({ data: mocks.state.inbox }),
  useReconciliationSummary: () => ({ data: mocks.state.recon }),
  useRecurrences: () => ({ data: mocks.state.recurrences }),
  useSummaryBasic: () => ({ data: mocks.state.summary }),
  useAccountOverviewChart: () => ({ data: [], isLoading: false, isError: false, refetch: mocks.refetch }),
  useTransactions: (range: { start: string; end: string }) => {
    mocks.state.transactionRange = range
    return { data: mocks.state.transactions, isLoading: false, isError: false, refetch: mocks.refetch }
  },
  useDeleteTransaction: () => ({ mutateAsync: mocks.deleteTx, isPending: false }),
}))
vi.mock('../budgets/useBudgetsData', () => ({
  useBudgetsData: () => ({ budgetsQuery: { data: mocks.state.budgets }, limitsByBudget: mocks.state.limitsByBudget }),
}))
vi.mock('../../store/dateRangeStore', () => ({
  usePageRange: (page: string) => {
    mocks.state.pageKey = page
    return { start: '2026-08-01', end: '2026-08-31' }
  },
}))
vi.mock('../../store/recordTxStore', () => ({ useRecordTxStore: () => vi.fn() }))
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    children,
    search,
    ...props
  }: {
    to: string
    children: ReactNode
    search?: { tab?: string; view?: string }
  }) => {
    const query = search?.tab ? `tab=${search.tab}` : search?.view ? `view=${search.view}` : ''
    const href = query ? `${to}?${query}` : to
    return <a href={href} {...props}>{children}</a>
  },
}))
vi.mock('gsap', () => ({ default: { fromTo: vi.fn() } }))
vi.mock('../../components/abaku/TransactionRow', () => ({
  TransactionRow: ({ tx }: { tx: { description: string } }) => <div data-testid="tx-row">{tx.description}</div>,
}))
vi.mock('../../components/abaku/DeleteTransactionDialog', () => ({ DeleteTransactionDialog: () => null }))
vi.mock('../../components/abaku/Skeleton', () => ({ Skeleton: () => null }))
vi.mock('../../components/abaku/ErrorState', () => ({ ErrorState: ({ message }: { message: string }) => <div>{message}</div> }))
vi.mock('../../components/abaku/EmptyState', () => ({ EmptyState: ({ message }: { message: string }) => <div>{message}</div> }))

/** 每日重复、起始日在过去：无论今天几号，下一次都落在本月内 */
function dailyRecurrence(id: string, active = true): Recurrence {
  return {
    id,
    attributes: {
      title: `订阅 ${id}`,
      active,
      first_date: '2020-01-01',
      transactions: [],
      repetitions: [{ type: 'daily', moment: '', skip: 0, occurrences: [] }],
    },
  }
}

function txGroup(id: string, description: string) {
  return {
    id,
    attributes: {
      transactions: [{
        transaction_journal_id: id,
        description,
        amount: '10.00',
        type: 'withdrawal',
        date: '2026-08-05',
        currency_symbol: '¥',
      }],
    },
  }
}

/** 右侧状态卡（待办 / 本月还能花 / 引导三选一） */
function focusPanel() {
  const page = screen.getByRole('heading', { name: '今天' }).parentElement!
  return page.children[2].lastElementChild as HTMLElement
}

beforeEach(() => {
  mocks.state.inbox = { pending_total: 0, needs_code: 0, unprocessed: 0, failed: 0, channels: [] }
  mocks.state.recon = { days_unreconciled: 0 }
  mocks.state.recurrences = { data: [] }
  mocks.state.summary = {}
  mocks.state.budgets = { data: [] }
  mocks.state.limitsByBudget = new Map()
  mocks.state.transactions = { data: [] }
  mocks.state.transactionRange = null
  mocks.state.pageKey = ''
})

describe('TodayPage 有待办时首屏列待办', () => {
  it('有收件箱时先显示汇总入口，需处理类优先，并深链 tab', () => {
    mocks.state.inbox = {
      pending_total: 3,
      needs_code: 1,
      unprocessed: 1,
      failed: 1,
      channels: [{ parsed: 3 }],
    }
    mocks.state.recon = { days_unreconciled: 2 }
    mocks.state.recurrences = { data: [dailyRecurrence('1'), dailyRecurrence('2')] }

    render(<TodayPage />)

    const items = within(focusPanel()).getAllByRole('link')
    // 账单收件箱汇总 + 4 条子项 + 未对账 + 订阅
    expect(items).toHaveLength(7)
    expect(items.map((el) => el.textContent)).toEqual([
      '账单收件箱6',
      '待验证码1',
      '解析失败1',
      '待处理账单1',
      '待审账单3',
      '未对账2',
      '本月待付订阅2',
    ])
    expect(items[0]).toHaveAttribute('href', '/bill-inbox?tab=processing')
    expect(items[1]).toHaveAttribute('href', '/bill-inbox?tab=processing')
    expect(items[4]).toHaveAttribute('href', '/bill-inbox?tab=parsed')
    expect(items[5]).toHaveAttribute('href', '/reconciliation')
    expect(items[6]).toHaveAttribute('href', '/accounts?view=subscriptions')
    expect(mocks.state.pageKey).toBe('today')
  })

  it('仅有待审时汇总入口仍显示，默认深链待审', () => {
    mocks.state.inbox = { pending_total: 0, needs_code: 0, unprocessed: 0, failed: 0, channels: [{ parsed: 5 }] }
    mocks.state.recon = { days_unreconciled: 0 }

    render(<TodayPage />)

    const items = within(focusPanel()).getAllByRole('link')
    expect(items).toHaveLength(2)
    expect(items[0]).toHaveTextContent('账单收件箱5')
    expect(items[0]).toHaveAttribute('href', '/bill-inbox?tab=parsed')
    expect(items[1]).toHaveTextContent('待审账单5')
    expect(items[1]).toHaveAttribute('href', '/bill-inbox?tab=parsed')
    expect(screen.queryByText('待验证码')).not.toBeInTheDocument()
    expect(screen.queryByText('未对账')).not.toBeInTheDocument()
  })

  it('停用的定期交易不算本月待付订阅', () => {
    mocks.state.recurrences = { data: [dailyRecurrence('1', false), dailyRecurrence('2', false)] }

    render(<TodayPage />)

    expect(screen.queryByText('本月待付订阅')).not.toBeInTheDocument()
  })

  it('有待办时不显示「本月还能花」，哪怕预算配好了', () => {
    mocks.state.inbox = { pending_total: 0, needs_code: 0, unprocessed: 0, failed: 0, channels: [{ parsed: 1 }] }
    mocks.state.budgets = { data: [{ id: 'b1' }] }
    mocks.state.limitsByBudget = new Map([['b1', [{ amount: '2000.00' }]]])

    render(<TodayPage />)

    expect(screen.getByText('账单收件箱')).toBeInTheDocument()
    expect(screen.getByText('待审账单')).toBeInTheDocument()
    expect(screen.queryByText('本月还能花')).not.toBeInTheDocument()
  })
})

describe('TodayPage 待办清空 + 有预算', () => {
  beforeEach(() => {
    mocks.state.budgets = { data: [{ id: 'b1' }, { id: 'b2' }] }
    mocks.state.limitsByBudget = new Map([
      ['b1', [{ amount: '1500.00' }]],
      ['b2', [{ amount: '500.00' }]],
    ])
    // Firefly 的 summary.basic 把 spent 返成负数（见 lib/summary.test.ts 的实测 fixture）
    mocks.state.summary = {
      'spent-in-CNY': { key: 'spent-in-CNY', monetary_value: '-500.00', value_parsed: '', currency_code: 'CNY', currency_symbol: '¥' },
      'earned-in-CNY': { key: 'earned-in-CNY', monetary_value: '9999.00', value_parsed: '', currency_code: 'CNY', currency_symbol: '¥' },
    }
  })

  it('大数字 = 限额合计 − 已花，且不受 earned 干扰', () => {
    render(<TodayPage />)

    expect(screen.getByText('本月还能花')).toBeInTheDocument()
    expect(screen.getByText('¥1,500.00')).toBeInTheDocument()
    expect(screen.getByText('已花 ¥500.00')).toBeInTheDocument()
  })

  it('没花钱时剩余额度等于限额合计', () => {
    mocks.state.summary = {}

    render(<TodayPage />)

    expect(screen.getByText('¥2,000.00')).toBeInTheDocument()
    expect(screen.getByText('已花 ¥0.00')).toBeInTheDocument()
  })

  it('超预算时用「需要注意」而不是「危险」语义，金额带负号', () => {
    mocks.state.summary = {
      'spent-in-CNY': { key: 'spent-in-CNY', monetary_value: '-2500.00', value_parsed: '', currency_code: 'CNY', currency_symbol: '¥' },
    }

    render(<TodayPage />)

    const amount = screen.getByText('-¥500.00')
    expect(amount).toHaveClass('text-[var(--attention)]')
    expect(amount).not.toHaveClass('text-[var(--danger)]')
    expect(screen.getByText('已花 ¥2,500.00')).toBeInTheDocument()
  })

  it('没超预算时大数字用正文色', () => {
    render(<TodayPage />)

    expect(screen.getByText('¥1,500.00')).toHaveClass('text-[var(--text-primary)]')
  })
})

describe('TodayPage 待办清空 + 没配预算', () => {
  it('给引导文案和入口，绝不显示 ¥0.00', () => {
    render(<TodayPage />)

    expect(screen.getByText('还没设月度预算')).toBeInTheDocument()
    expect(screen.getByText('设好后，这里会显示本月可用额度。')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '去设预算' })).toHaveAttribute('href', '/accounts?view=budgets')

    expect(screen.queryByText('本月还能花')).not.toBeInTheDocument()
    expect(screen.queryByText('¥0.00')).not.toBeInTheDocument()
    expect(focusPanel().textContent).not.toContain('¥0.00')
  })

  it('建了预算但限额全是 0 也算没配预算', () => {
    mocks.state.budgets = { data: [{ id: 'b1' }] }
    mocks.state.limitsByBudget = new Map([['b1', [{ amount: '0.00' }]]])

    render(<TodayPage />)

    expect(screen.getByText('还没设月度预算')).toBeInTheDocument()
    expect(focusPanel().textContent).not.toContain('¥0.00')
  })

  it('建了预算但一条限额都没有也算没配预算', () => {
    mocks.state.budgets = { data: [{ id: 'b1' }] }
    mocks.state.limitsByBudget = new Map([['b1', []]])

    render(<TodayPage />)

    expect(screen.getByText('还没设月度预算')).toBeInTheDocument()
  })
})

describe('TodayPage 今日流水', () => {
  it('按笔列出今日交易，查询范围只包含当天', () => {
    mocks.state.transactions = { data: [txGroup('1', '早饭'), txGroup('2', '地铁')] }

    render(<TodayPage />)

    const rows = screen.getAllByTestId('tx-row')
    expect(rows).toHaveLength(2)
    expect(rows.map((el) => el.textContent)).toEqual(['早饭', '地铁'])
    expect(mocks.state.transactionRange?.start).toBe(mocks.state.transactionRange?.end)
    expect(mocks.state.transactionRange?.start).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('没有交易时出空态', () => {
    render(<TodayPage />)

    expect(screen.getByText('今天还没有记账')).toBeInTheDocument()
    expect(screen.queryAllByTestId('tx-row')).toHaveLength(0)
  })
})
