import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MultiSplitTransactionEditor } from './MultiSplitTransactionEditor'

const transaction = {
  data: {
    attributes: {
      group_title: 'Team lunch',
      transactions: [
        { type: 'withdrawal', transaction_journal_id: '11', date: '2026-07-20T10:00:00+08:00', amount: '10.00', description: 'Lunch', source_id: '1', source_name: 'Checking', destination_id: '90', destination_name: 'Cafe', currency_id: '1', currency_code: 'CNY', category_name: 'Food', category_id: '7', budget_id: '4', budget_name: 'Meals', bill_id: null, bill_name: null, tags: ['work'], notes: 'receipt' },
        { type: 'withdrawal', transaction_journal_id: '12', date: '2026-07-20T11:00:00+08:00', amount: '5.25', description: 'Coffee', source_id: '1', source_name: 'Checking', destination_id: '91', destination_name: 'Coffee shop', currency_id: '1', currency_code: 'CNY', category_name: 'Food', tags: [], notes: '' },
      ],
    },
  },
}

const mocks = vi.hoisted(() => ({ create: vi.fn(), update: vi.fn(), toast: vi.fn(), saved: vi.fn(), dirty: vi.fn() }))

vi.mock('../../api/queries', () => ({
  useTransaction: () => ({ data: transaction, isLoading: false, isError: false, refetch: vi.fn() }),
  useAssetAccounts: () => ({ data: [{ id: '1', name: 'Checking' }, { id: '2', name: 'Savings' }] }),
  useBudgets: () => ({ data: { data: [{ id: '4', attributes: { name: 'Meals', active: true } }] } }),
  useCurrencies: () => ({ data: { data: [{ id: '1', attributes: { code: 'CNY', name: 'Yuan', enabled: true } }, { id: '2', attributes: { code: 'USD', name: 'Dollar', enabled: true } }] } }),
  useCreateTransactionSplits: () => ({ mutateAsync: mocks.create, isPending: false }),
  useUpdateTransactionSplits: () => ({ mutateAsync: mocks.update, isPending: false }),
}))
vi.mock('../../store/dateRangeStore', () => ({ useDateRangeStore: () => ({ start: '2026-07-01', end: '2026-07-31' }) }))
vi.mock('../../store/toastStore', () => ({ showToast: mocks.toast }))

describe('MultiSplitTransactionEditor', () => {
  beforeEach(() => {
    mocks.create.mockReset().mockResolvedValue({})
    mocks.update.mockReset().mockResolvedValue({})
    mocks.toast.mockReset()
    mocks.saved.mockReset()
    mocks.dirty.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders when the secure-context randomUUID API is unavailable', async () => {
    vi.stubGlobal('crypto', {})

    render(<MultiSplitTransactionEditor onSaved={mocks.saved} onDirtyChange={mocks.dirty} />)

    expect(await screen.findByLabelText('拆分 2 金额')).toBeInTheDocument()
  })

  it('creates a new group with at least two complete splits', async () => {
    render(<MultiSplitTransactionEditor onSaved={mocks.saved} onDirtyChange={mocks.dirty} />)
    await screen.findByLabelText('拆分 2 金额')

    fireEvent.change(screen.getByLabelText('拆分 1 金额'), { target: { value: '8.25' } })
    fireEvent.change(screen.getByLabelText('拆分 1 描述'), { target: { value: 'Lunch' } })
    fireEvent.change(screen.getByLabelText('拆分 1 来源账户'), { target: { value: '1' } })
    fireEvent.change(screen.getByLabelText('拆分 1 目标'), { target: { value: 'Cafe' } })
    fireEvent.change(screen.getByLabelText('拆分 2 金额'), { target: { value: '3.50' } })
    fireEvent.change(screen.getByLabelText('拆分 2 描述'), { target: { value: 'Dessert' } })
    fireEvent.change(screen.getByLabelText('拆分 2 来源账户'), { target: { value: '1' } })
    fireEvent.change(screen.getByLabelText('拆分 2 目标'), { target: { value: 'Bakery' } })
    fireEvent.click(screen.getByRole('button', { name: '创建多拆分交易' }))

    await waitFor(() => expect(mocks.create).toHaveBeenCalledWith({
      groupTitle: '',
      inputs: [
        expect.objectContaining({ order: 0, amount: '8.25', description: 'Lunch', source_id: '1', destination_name: 'Cafe' }),
        expect.objectContaining({ order: 1, amount: '3.5', description: 'Dessert', source_id: '1', destination_name: 'Bakery' }),
      ],
    }))
    expect(mocks.update).not.toHaveBeenCalled()
    expect(mocks.saved).toHaveBeenCalledOnce()
  })

  it('submits every existing and newly added split with preserved metadata', async () => {
    render(<MultiSplitTransactionEditor groupId="8" onSaved={mocks.saved} onDirtyChange={mocks.dirty} />)
    await screen.findByLabelText('拆分 2 金额')

    fireEvent.change(screen.getByLabelText('拆分 2 金额'), { target: { value: '6.75' } })
    fireEvent.click(screen.getByRole('button', { name: '添加拆分' }))
    fireEvent.change(screen.getByLabelText('拆分 3 金额'), { target: { value: '3.5' } })
    fireEvent.change(screen.getByLabelText('拆分 3 描述'), { target: { value: 'Dessert' } })
    fireEvent.click(screen.getByRole('button', { name: '保存全部拆分' }))

    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith({
      groupId: '8',
      groupTitle: 'Team lunch',
      inputs: expect.arrayContaining([
        expect.objectContaining({ transaction_journal_id: '11', order: 0, amount: '10', category_id: '7', budget_id: '4', tags: ['work'], notes: 'receipt' }),
        expect.objectContaining({ transaction_journal_id: '12', order: 1, amount: '6.75' }),
        expect.objectContaining({ transaction_journal_id: undefined, order: 2, amount: '3.5', description: 'Dessert', source_id: '1', foreign_currency_id: null, foreign_amount: null }),
      ]),
    }))
    expect(mocks.update.mock.calls[0][0].inputs).toHaveLength(3)
    expect(mocks.saved).toHaveBeenCalledOnce()
  })

  it('clears incompatible account ids and names when the transaction type changes', async () => {
    render(<MultiSplitTransactionEditor groupId="8" onSaved={mocks.saved} onDirtyChange={mocks.dirty} />)
    await screen.findByLabelText('拆分 1 金额')
    fireEvent.click(screen.getByRole('tab', { name: '收入' }))

    expect(screen.getByLabelText('拆分 1 来源')).toHaveValue('')
    expect(screen.getByLabelText('拆分 1 目标账户')).toHaveValue('')
    fireEvent.click(screen.getByRole('button', { name: '保存全部拆分' }))

    expect(mocks.update).not.toHaveBeenCalled()
    expect(mocks.toast).toHaveBeenCalledWith({ kind: 'error', message: '每个收入或转账拆分都要选择目标账户' })
  })
})
