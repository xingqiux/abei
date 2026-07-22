import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ReconciliationPage } from './ReconciliationPage'

const mocks = vi.hoisted(() => ({
  createAdjustment: vi.fn(),
  markDay: vi.fn(),
  toast: vi.fn(),
  refetch: vi.fn(),
  summary: { last_reconciled_date: null, days_unreconciled: 1, days: [] as Array<Record<string, unknown>> },
  accounts: [{ id: '1', name: 'Checking', currencyCode: 'CNY', currencySymbol: '¥' }],
}))

vi.mock('../../api/queries', () => ({
  useReconciliationSummary: () => ({ data: mocks.summary, isLoading: false, isError: false, refetch: mocks.refetch }),
  useAllTransactions: () => ({ data: { data: [] }, isLoading: false, isError: false, isSuccess: true, refetch: mocks.refetch }),
  useAssetAccounts: () => ({ data: mocks.accounts }),
  useCreateReconciliationAdjustment: () => ({ mutateAsync: mocks.createAdjustment, isPending: false }),
  useMarkDayReconciled: () => ({ mutateAsync: mocks.markDay, isPending: false }),
}))
vi.mock('../../components/granary/Modal', () => ({
  Modal: ({ open, title, children, footer }: { open: boolean; title: string; children: React.ReactNode; footer: React.ReactNode }) => open
    ? <div role="dialog" aria-label={title}>{children}{footer}</div>
    : null,
}))
vi.mock('./CalendarStrip', () => ({
  CalendarStrip: ({ days, onSelect }: { days: Array<{ date: string }>; onSelect: (date: string) => void }) => (
    <div>{days.map((day) => <button key={day.date} type="button" onClick={() => onSelect(day.date)}>{day.date}</button>)}</div>
  ),
}))
vi.mock('../../components/granary/TransactionRow', () => ({ TransactionRow: () => null }))
vi.mock('../../components/granary/Skeleton', () => ({ Skeleton: () => null }))
vi.mock('../../components/granary/EmptyState', () => ({ EmptyState: () => null }))
vi.mock('../../components/granary/CelebrateOverlay', () => ({ CelebrateOverlay: () => null }))
vi.mock('../../components/granary/ErrorState', () => ({ ErrorState: () => null }))
vi.mock('../../motion/useStaggerIn', () => ({ useStaggerIn: () => ({ current: null }) }))
vi.mock('../../store/toastStore', () => ({ showToast: mocks.toast }))

function dayWithDiff(diffAmount?: string) {
  return {
    date: '2026-07-20',
    status: diffAmount ? 'diff' : 'pending',
    income: '0.00',
    expense: '10.00',
    net: '-10.00',
    tx_count: 1,
    diff_amount: diffAmount ?? null,
    currency_totals: [{ currency_id: 1, currency_code: 'CNY', currency_symbol: '¥', income: '0.00', expense: '10.00', net: '-10.00' }],
    diff_totals: diffAmount
      ? [{ currency_id: 1, currency_code: 'CNY', currency_symbol: '¥', amount: diffAmount }]
      : [],
  }
}

describe('ReconciliationPage adjustments', () => {
  beforeEach(() => {
    mocks.createAdjustment.mockReset().mockResolvedValue(undefined)
    mocks.markDay.mockReset().mockResolvedValue({ updated: 1 })
    mocks.toast.mockReset()
    mocks.refetch.mockReset()
    mocks.summary.days = [dayWithDiff()]
  })

  it('creates the first adjustment when the day has no previous difference entry', async () => {
    render(<ReconciliationPage />)

    const openButton = await screen.findByRole('button', { name: '生成调整交易' })
    expect(openButton).toBeEnabled()
    fireEvent.click(openButton)
    fireEvent.change(screen.getByLabelText('金额'), { target: { value: '12.50' } })
    fireEvent.click(screen.getByRole('button', { name: '创建' }))

    await waitFor(() => expect(mocks.createAdjustment).toHaveBeenCalledWith({
      date: '2026-07-20',
      amount: '12.5',
      account_id: '1',
      direction: 'decrease',
      description: '对账调整 2026-07-20（减少）',
    }))
  })

  it('does not copy a previous adjustment amount into a new adjustment', async () => {
    mocks.summary.days = [dayWithDiff('88.00')]
    render(<ReconciliationPage />)

    fireEvent.click(await screen.findByRole('button', { name: '生成调整交易' }))

    const amount = screen.getByLabelText('金额')
    expect(amount).toHaveValue('')
    fireEvent.change(amount, { target: { value: '7.25' } })
    fireEvent.click(screen.getByRole('button', { name: '创建' }))

    await waitFor(() => expect(mocks.createAdjustment).toHaveBeenCalledWith(expect.objectContaining({ amount: '7.25' })))
  })
})
