import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BillStatementRow } from '../../api/schemas'
import { SplitBillRowDialog } from './SplitBillRowDialog'

const mocks = vi.hoisted(() => ({ split: vi.fn(), toast: vi.fn(), close: vi.fn() }))

vi.mock('../../components/abei/Modal', () => ({
  Modal: ({ open, children, footer }: { open: boolean; children: React.ReactNode; footer: React.ReactNode }) => open ? <div>{children}{footer}</div> : null,
}))
vi.mock('../../api/queries', () => ({
  useSplitBillStatementRow: () => ({ mutateAsync: mocks.split, isPending: false }),
}))
vi.mock('../../store/toastStore', () => ({ showToast: mocks.toast }))

const row = {
  id: '17',
  attributes: {
    bill_task_id: '3',
    status: 'needs_split',
    occurred_at: '2026-07-20T10:00:00+08:00',
    counterparty: 'Lunch',
    amount: '14.95',
    duplicate_state: 'unique',
    firefly_description: 'Team lunch',
    category_name: 'Dining',
  },
} as BillStatementRow

describe('SplitBillRowDialog', () => {
  beforeEach(() => {
    mocks.split.mockReset().mockResolvedValue({})
    mocks.toast.mockReset()
    mocks.close.mockReset()
  })

  it('adds and removes parts and submits an exact decimal split', async () => {
    render(<SplitBillRowDialog row={row} open onClose={mocks.close} />)

    fireEvent.click(screen.getByRole('button', { name: '添加一项' }))
    expect(screen.getAllByRole('button', { name: /删除拆分/ })).toHaveLength(3)
    fireEvent.click(screen.getByRole('button', { name: '删除拆分 3' }))

    fireEvent.change(screen.getByLabelText('拆分 1 账户'), { target: { value: 'Checking' } })
    fireEvent.change(screen.getByLabelText('拆分 1 金额'), { target: { value: '10.10' } })
    fireEvent.change(screen.getByLabelText('拆分 2 账户'), { target: { value: 'Credit card' } })
    fireEvent.change(screen.getByLabelText('拆分 2 金额'), { target: { value: '4.85' } })
    fireEvent.change(screen.getByLabelText('拆分 2 分类'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: '确认拆分' }))

    await waitFor(() => expect(mocks.split).toHaveBeenCalledWith({
      rowId: '17',
      splits: [
        expect.objectContaining({ source_name: 'Checking', amount: '10.1', description: 'Team lunch', category_name: 'Dining' }),
        expect.objectContaining({ source_name: 'Credit card', amount: '4.85', description: 'Team lunch', category_name: undefined }),
      ],
    }))
    expect(mocks.close).toHaveBeenCalledOnce()
  })

  it('rejects a complete amount when an account is missing', () => {
    render(<SplitBillRowDialog row={row} open onClose={mocks.close} />)
    fireEvent.change(screen.getByLabelText('拆分 1 金额'), { target: { value: '10' } })
    fireEvent.change(screen.getByLabelText('拆分 2 金额'), { target: { value: '4.95' } })
    fireEvent.click(screen.getByRole('button', { name: '确认拆分' }))

    expect(mocks.split).not.toHaveBeenCalled()
    expect(mocks.toast).toHaveBeenCalledWith({ kind: 'error', message: '每项账户和正金额必填，合计必须等于原金额' })
  })

  it.each([null, '0'])('disables splitting when the original amount is %s', (amount) => {
    const invalidRow = { ...row, attributes: { ...row.attributes, amount } } as BillStatementRow
    render(<SplitBillRowDialog row={invalidRow} open onClose={mocks.close} />)

    expect(screen.getByRole('button', { name: '确认拆分' })).toBeDisabled()
    // 合计行是 role=status（数字分散在子 span 里），按角色取整行再看文本
    expect(screen.getByRole('status')).toHaveTextContent(`原金额 ${amount ?? '--'}`)
  })
})
