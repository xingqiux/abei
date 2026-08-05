import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BillStatementRow } from '../../api/schemas'
import { StatementRow } from './StatementRow'

const mocks = vi.hoisted(() => ({ update: vi.fn(), toast: vi.fn() }))

vi.mock('../../api/queries', () => ({
  useUpdateBillStatementRow: () => ({ mutateAsync: mocks.update, isPending: false }),
}))
vi.mock('../../store/toastStore', () => ({ showToast: mocks.toast }))
vi.mock('./SplitBillRowDialog', () => ({ SplitBillRowDialog: () => null }))

const row = {
  id: '17',
  attributes: {
    bill_task_id: '3',
    status: 'pending',
    duplicate_state: 'unique',
    occurred_at: null,
    amount: null,
    counterparty: 'Lunch shop',
    firefly_type: null,
    firefly_date: null,
    firefly_amount: null,
    firefly_description: null,
    source_name: null,
    destination_name: null,
  },
} as BillStatementRow

describe('StatementRow', () => {
  beforeEach(() => {
    mocks.update.mockReset().mockResolvedValue({})
    mocks.toast.mockReset()
  })

  it('renders null dates safely and saves a complete import draft', async () => {
    render(<StatementRow row={row} selected={false} onToggle={vi.fn()} />)

    expect(screen.getByText('--')).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: '选择此行' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '编辑行' }))

    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(mocks.update).not.toHaveBeenCalled()
    expect(mocks.toast).toHaveBeenCalledWith({ message: '请补全类型、日期、描述和账户流向', kind: 'error' })

    fireEvent.change(screen.getByLabelText('交易类型'), { target: { value: 'withdrawal' } })
    fireEvent.change(screen.getByLabelText('交易日期'), { target: { value: '2026-07-20' } })
    fireEvent.change(screen.getByLabelText('描述'), { target: { value: 'Team lunch' } })
    fireEvent.change(screen.getByLabelText('来源账户'), { target: { value: 'Checking' } })
    fireEvent.change(screen.getByLabelText('目标账户'), { target: { value: 'Restaurant' } })
    fireEvent.change(screen.getByLabelText('分类'), { target: { value: 'Dining' } })
    fireEvent.change(screen.getByLabelText('金额'), { target: { value: '12.340' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith({
      rowId: '17',
      input: {
        firefly_type: 'withdrawal',
        firefly_date: '2026-07-20',
        firefly_description: 'Team lunch',
        description: 'Team lunch',
        source_name: 'Checking',
        destination_name: 'Restaurant',
        category_name: 'Dining',
        amount: '12.34',
        firefly_amount: '12.34',
      },
    }))
  })
})
