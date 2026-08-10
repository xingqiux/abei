import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
  useCreateTransactionSplits: () => ({ mutateAsync: mocks.create, isPending: false }),
  useUpdateTransactionSplits: () => ({ mutateAsync: mocks.update, isPending: false }),
}))
vi.mock('../../store/dateRangeStore', () => ({ useDateRangeStore: () => ({ start: '2026-07-01', end: '2026-07-31' }) }))
vi.mock('../../store/toastStore', () => ({ showToast: mocks.toast }))
// CategoryPicker 内部走真实的 useCategories 查询，这里换成透传 input，拆分逻辑测试不关心选择器本身
vi.mock('../../components/abei/CategoryPicker', () => ({
  DOMAINS_BY_TX_TYPE: { withdrawal: ['expense'], deposit: ['income'], transfer: ['transfer'] },
  CategoryPicker: ({ value, onChange }: { value: string | null; onChange: (name: string | null) => void }) => (
    <input aria-label="分类" value={value ?? ''} onChange={(e) => onChange(e.target.value || null)} />
  ),
}))

/**
 * 每个拆分是一个 fieldset，字段名（金额/描述/…）在组内才唯一。
 * 先按 legend 找到那一组，再在组里找控件——跟读屏的定位方式一致。
 */
function split(index: number) {
  return within(screen.getByRole('group', { name: `拆分 ${index}` }))
}

async function findSplit(index: number) {
  return within(await screen.findByRole('group', { name: `拆分 ${index}` }))
}

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

    expect((await findSplit(2)).getByLabelText('金额')).toBeInTheDocument()
  })

  it('creates a new group with at least two complete splits', async () => {
    render(<MultiSplitTransactionEditor onSaved={mocks.saved} onDirtyChange={mocks.dirty} />)
    await findSplit(2)

    fireEvent.change(split(1).getByLabelText('金额'), { target: { value: '8.25' } })
    fireEvent.change(split(1).getByLabelText('描述'), { target: { value: 'Lunch' } })
    // 账户选择器是 Combobox，填的是账户名，名字对上才落到 id
    fireEvent.change(split(1).getByLabelText('来源账户'), { target: { value: 'Checking' } })
    fireEvent.change(split(1).getByLabelText('商家/收款方'), { target: { value: 'Cafe' } })
    fireEvent.change(split(2).getByLabelText('金额'), { target: { value: '3.50' } })
    fireEvent.change(split(2).getByLabelText('描述'), { target: { value: 'Dessert' } })
    fireEvent.change(split(2).getByLabelText('来源账户'), { target: { value: 'Checking' } })
    fireEvent.change(split(2).getByLabelText('商家/收款方'), { target: { value: 'Bakery' } })
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
    await findSplit(2)

    fireEvent.change(split(2).getByLabelText('金额'), { target: { value: '6.75' } })
    fireEvent.click(screen.getByRole('button', { name: '添加拆分' }))
    fireEvent.change(split(3).getByLabelText('金额'), { target: { value: '3.5' } })
    fireEvent.change(split(3).getByLabelText('描述'), { target: { value: 'Dessert' } })
    fireEvent.click(screen.getByRole('button', { name: '保存全部拆分' }))

    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith({
      groupId: '8',
      groupTitle: 'Team lunch',
      inputs: expect.arrayContaining([
        expect.objectContaining({ transaction_journal_id: '11', order: 0, amount: '10', category_id: '7', budget_id: '4', tags: ['work'], notes: 'receipt' }),
        expect.objectContaining({ transaction_journal_id: '12', order: 1, amount: '6.75' }),
        expect.objectContaining({ transaction_journal_id: undefined, order: 2, amount: '3.5', description: 'Dessert', source_id: '1' }),
      ]),
    }))
    expect(mocks.update.mock.calls[0][0].inputs).toHaveLength(3)
    expect(mocks.saved).toHaveBeenCalledOnce()
  })

  it('clears incompatible account ids and names when the transaction type changes', async () => {
    render(<MultiSplitTransactionEditor groupId="8" onSaved={mocks.saved} onDirtyChange={mocks.dirty} />)
    await findSplit(1)
    // 类型切换是 radiogroup 不是 tablist：在选一个值，没有并列的面板
    fireEvent.click(screen.getByRole('radio', { name: '收入' }))

    expect(split(1).getByLabelText('来源/付款方')).toHaveValue('')
    expect(split(1).getByLabelText('目标账户')).toHaveValue('')
    fireEvent.click(screen.getByRole('button', { name: '保存全部拆分' }))

    expect(mocks.update).not.toHaveBeenCalled()
    expect(mocks.toast).toHaveBeenCalledWith({ kind: 'error', message: '每个收入或转账拆分都要选择目标账户' })
  })
})
