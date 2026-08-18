import type { ReactNode } from 'react'
import { render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TodayPage } from './TodayPage'

type AccountFixture = { id: string; attributes: Record<string, unknown> }
type GroupFixture = { id: string; attributes: { transactions: Record<string, unknown>[] } }

/** 测试里的「今天」；页面自己取系统日期，夹具跟着它走 */
const TODAY = new Date()
const iso = (offsetDays: number) => {
  const d = new Date(TODAY)
  d.setDate(d.getDate() + offsetDays)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const mocks = vi.hoisted(() => ({
  refetch: vi.fn(),
  state: {
    todo: { importable: 0, attention: 0, stuck_tasks: 0, total: 0, pending: 0, hasDanger: false, isLoading: false, isError: false },
    locked: [] as string[],
    accounts: [] as AccountFixture[],
    summary: {} as Record<string, unknown>,
    prevSummary: {} as Record<string, unknown>,
    transactions: { data: [] as GroupFixture[] },
    transactionRange: null as { start: string; end: string } | null,
    uncategorizedTotal: 0,
    pageKey: '',
    ranges: [] as Array<{ start: string; end: string }>,
  },
}))

vi.mock('../../api/queries', () => ({
  useSummaryBasic: (range: { start: string; end: string }) => {
    mocks.state.ranges.push(range)
    // 第一次调用是本期，第二次是上期（页面里就这个顺序）
    const isCurrent = mocks.state.ranges.length % 2 === 1
    return {
      data: isCurrent ? mocks.state.summary : mocks.state.prevSummary,
      isLoading: false,
      isError: false,
      refetch: mocks.refetch,
    }
  },
  useNetWorthAccounts: () => ({ data: mocks.state.accounts, isLoading: false, isError: false, refetch: mocks.refetch }),
  useRecurrences: () => ({ data: { data: [] }, isLoading: false, isError: false }),
  useTransactions: (range: { start: string; end: string }) => {
    mocks.state.transactionRange = range
    return { data: mocks.state.transactions, isLoading: false, isError: false, refetch: mocks.refetch }
  },
  useSearchTransactionsPage: () => ({
    data: { data: [], meta: { pagination: { total: mocks.state.uncategorizedTotal } } },
    isLoading: false,
    isError: false,
  }),
}))
vi.mock('../../hooks/useTodoCounts', () => ({ useTodoCounts: () => mocks.state.todo }))
vi.mock('../../hooks/useLockedChannels', () => ({ useLockedChannels: () => mocks.state.locked }))
vi.mock('../../store/dateRangeStore', () => ({
  usePageRange: (page: string) => {
    mocks.state.pageKey = page
    return { start: '2026-08-01', end: '2026-08-31' }
  },
}))
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, search: _search, ...props }: { to: string; children: ReactNode; search?: unknown }) => (
    <a href={to} {...props}>{children}</a>
  ),
}))
vi.mock('../../components/abei/Skeleton', () => ({ Skeleton: () => null }))
vi.mock('../../components/abei/ErrorState', () => ({ ErrorState: ({ message }: { message: string }) => <div>{message}</div> }))

function account(id: string, type: string, balance: string, extra: Record<string, unknown> = {}): AccountFixture {
  return {
    id,
    attributes: { type, current_balance: balance, currency_symbol: '¥', include_net_worth: true, ...extra },
  }
}

function group(id: string, date: string, description: string, amount = '10.00', type = 'withdrawal'): GroupFixture {
  return {
    id,
    attributes: {
      transactions: [{
        transaction_journal_id: id,
        description,
        amount,
        type,
        date,
        currency_symbol: '¥',
      }],
    },
  }
}

beforeEach(() => {
  mocks.state.todo = { importable: 0, attention: 0, stuck_tasks: 0, total: 0, pending: 0, hasDanger: false, isLoading: false, isError: false }
  mocks.state.locked = []
  mocks.state.accounts = []
  mocks.state.summary = {}
  mocks.state.prevSummary = {}
  mocks.state.transactions = { data: [] }
  mocks.state.transactionRange = null
  mocks.state.uncategorizedTotal = 0
  mocks.state.pageKey = ''
  mocks.state.ranges = []
  sessionStorage.clear()
})

describe('概况页 时间线', () => {
  it('今天有入账时给出笔数与当日合计', () => {
    mocks.state.transactions = {
      data: [group('1', iso(0), '早饭', '12.00'), group('2', iso(0), '地铁', '4.00')],
    }

    render(<TodayPage />)

    expect(screen.getByRole('heading', { name: '概况' })).toBeInTheDocument()
    expect(screen.getByText('今天已入账 2 笔')).toBeInTheDocument()
    expect(screen.getByText('-¥16.00')).toBeInTheDocument()
    expect(mocks.state.pageKey).toBe('today')
  })

  it('今天无入账且收件箱非空时给入账入口', () => {
    mocks.state.todo = { ...mocks.state.todo, importable: 4, total: 4, pending: 4 }

    render(<TodayPage />)

    expect(screen.getByText('今天暂无入账')).toBeInTheDocument()
    expect(screen.getByText('收件箱待处理 4 笔')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /去入账/ })).toHaveAttribute('href', '/bill-inbox')
  })

  it('收件箱为空时不给入账入口', () => {
    render(<TodayPage />)

    expect(screen.getByText('收件箱为空')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /去入账/ })).not.toBeInTheDocument()
  })

  it('停摆超过三天时画出断层并给出天数', () => {
    mocks.state.accounts = [account('1', 'asset', '100.00', { last_activity: `${iso(-9)}T00:00:00+08:00` })]
    mocks.state.todo = { ...mocks.state.todo, importable: 12, total: 12, pending: 12 }
    mocks.state.transactions = { data: [group('1', iso(-9), '超市')] }

    render(<TodayPage />)

    expect(screen.getByText('9')).toBeInTheDocument()
    expect(screen.getByText(/天无入账/)).toBeInTheDocument()
    expect(screen.getByText('这段时间没有流水记录')).toBeInTheDocument()
  })

  it('停一两天不算断层', () => {
    mocks.state.accounts = [account('1', 'asset', '100.00', { last_activity: `${iso(-1)}T00:00:00+08:00` })]
    mocks.state.transactions = { data: [group('1', iso(-1), '超市')] }

    render(<TodayPage />)

    expect(screen.queryByText(/天无入账/)).not.toBeInTheDocument()
    expect(screen.getByText('账本最后一笔')).toBeInTheDocument()
    expect(screen.getByText('超市')).toBeInTheDocument()
  })

  it('更早的日期折进「再往前」并给交易页出口', () => {
    mocks.state.transactions = {
      data: [
        group('1', iso(-1), '超市'),
        group('2', iso(-2), '打车'),
        group('3', iso(-2), '咖啡'),
      ],
    }

    render(<TodayPage />)

    expect(screen.getByText('再往前')).toBeInTheDocument()
    expect(screen.getByText(/等 2 笔/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /到交易页看全部/ })).toHaveAttribute('href', '/transactions')
  })

  it('最近 180 天无交易时如实说明', () => {
    render(<TodayPage />)

    expect(screen.getByText('账本暂无交易')).toBeInTheDocument()
    expect(mocks.state.transactionRange?.start).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(mocks.state.transactionRange!.start < mocks.state.transactionRange!.end).toBe(true)
  })
})

describe('概况页 净资产', () => {
  it('资产与负债分列，净资产为两者之和', () => {
    mocks.state.accounts = [account('1', 'asset', '10000.00'), account('2', 'Loan', '-3000.00')]

    render(<TodayPage />)

    expect(screen.getByText('¥7,000.00')).toBeInTheDocument()
    expect(screen.getByText('¥10,000.00')).toBeInTheDocument()
    // 负债余额本来就是负数，量条旁只写欠了多少，不重复负号
    expect(screen.getByText('¥3,000.00')).toBeInTheDocument()
  })

  it('账户上关掉「计入净资产」就不参与合计', () => {
    mocks.state.accounts = [
      account('1', 'asset', '10000.00'),
      account('2', 'asset', '5000.00', { include_net_worth: false }),
    ]

    render(<TodayPage />)

    expect(screen.getAllByText('¥10,000.00')).toHaveLength(2)
    expect(screen.queryByText('¥15,000.00')).not.toBeInTheDocument()
  })

  it('净资产为负时保留负号', () => {
    mocks.state.accounts = [account('1', 'asset', '1000.00'), account('2', 'creditcard', '-4000.00')]

    render(<TodayPage />)

    expect(screen.getByText('-¥3,000.00')).toBeInTheDocument()
  })
})

describe('概况页 本期与待处理', () => {
  it('本期无已入账交易时给破折号与说明，不写 ¥0.00', () => {
    render(<TodayPage />)

    expect(screen.getByText('本期无已入账交易')).toBeInTheDocument()
    expect(screen.getByText('—')).toBeInTheDocument()
  })

  it('本期有数时净流在上、收支明细在下', () => {
    mocks.state.summary = {
      'spent-in-CNY': { key: 'spent-in-CNY', monetary_value: '-1200.00', currency_code: 'CNY', currency_symbol: '¥' },
      'earned-in-CNY': { key: 'earned-in-CNY', monetary_value: '3000.00', currency_code: 'CNY', currency_symbol: '¥' },
    }

    render(<TodayPage />)

    expect(screen.queryByText('本期无已入账交易')).not.toBeInTheDocument()
    expect(screen.getByText('+¥1,800.00')).toBeInTheDocument()
    expect(screen.getByText('支出 ¥1,200.00 · 收入 ¥3,000.00')).toBeInTheDocument()
  })

  it('待处理四类各占一行，未分类指向交易页', () => {
    mocks.state.todo = { ...mocks.state.todo, importable: 12, attention: 3, total: 15, pending: 15 }
    mocks.state.locked = ['支付宝', '微信支付']
    mocks.state.uncategorizedTotal = 47

    render(<TodayPage />)

    const list = screen.getByRole('list', { name: '待处理' })
    expect(within(list).getByText('笔待入账').previousSibling).toHaveTextContent('12')
    expect(within(list).getByText('笔待确认').previousSibling).toHaveTextContent('3')
    expect(within(list).getByText('个渠道要密码').previousSibling).toHaveTextContent('2')
    expect(within(list).getByText('笔未分类').closest('a')).toHaveAttribute('href', '/transactions')
    expect(screen.getByRole('link', { name: /处理收件箱/ })).toHaveAttribute('href', '/bill-inbox')
  })

  it('无待办时不给收件箱按钮', () => {
    render(<TodayPage />)

    expect(screen.getByText('无待处理事项')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /处理收件箱/ })).not.toBeInTheDocument()
  })
})

describe('概况页 提醒条', () => {
  const summaryOf = (spent: string) => ({
    'spent-in-CNY': { key: 'spent-in-CNY', monetary_value: spent, currency_code: 'CNY', currency_symbol: '¥' },
    'earned-in-CNY': { key: 'earned-in-CNY', monetary_value: '0.00', currency_code: 'CNY', currency_symbol: '¥' },
  })

  it('支出环比变动超过 10% 才提示', () => {
    mocks.state.summary = summaryOf('-2000.00')
    mocks.state.prevSummary = summaryOf('-1000.00')

    render(<TodayPage />)

    expect(screen.getByText(/本期支出较上期增加 100%/)).toBeInTheDocument()
  })

  it('变动不足 10% 不提示', () => {
    mocks.state.summary = summaryOf('-1020.00')
    mocks.state.prevSummary = summaryOf('-1000.00')

    render(<TodayPage />)

    expect(screen.queryByText(/较上期/)).not.toBeInTheDocument()
  })
})
