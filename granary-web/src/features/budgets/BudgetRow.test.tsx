import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Budget } from '../../api/schemas'
import { BudgetRow } from './BudgetRow'

const mocks = vi.hoisted(() => ({
  updateLimit: vi.fn(),
  createLimit: vi.fn(),
  updateBudget: vi.fn(),
  deleteBudget: vi.fn(),
  toast: vi.fn(),
  currencies: { data: [{ id: '1', attributes: { code: 'CNY', symbol: '¥', name: 'Yuan', enabled: true, default: true } }] },
}))

vi.mock('../../components/granary/Modal', () => ({
  Modal: ({ open, title, children, footer }: { open: boolean; title: string; children: React.ReactNode; footer: React.ReactNode }) => open ? <div><h2>{title}</h2>{children}{footer}</div> : null,
}))
vi.mock('../../api/queries', () => ({
  useUpdateBudgetLimit: () => ({ mutateAsync: mocks.updateLimit, isPending: false }),
  useCreateBudgetLimit: () => ({ mutateAsync: mocks.createLimit, isPending: false }),
  useUpdateBudget: () => ({ mutateAsync: mocks.updateBudget, isPending: false }),
  useDeleteBudget: () => ({ mutateAsync: mocks.deleteBudget, isPending: false }),
  useCurrencies: () => ({ data: mocks.currencies }),
}))
vi.mock('../../store/toastStore', () => ({ showToast: mocks.toast }))

const budget = {
  id: '5',
  attributes: { name: 'Food', active: true, spent: [{ sum: '-20.00', currency_code: 'CNY', currency_symbol: '¥' }] },
} as Budget
const limits = [
  { limitId: '10', amount: '100.00', start: '2026-07-01', end: '2026-07-15', code: 'CNY', symbol: '¥' },
  { limitId: '11', amount: '200.00', start: '2026-07-10', end: '2026-07-31', code: 'CNY', symbol: '¥' },
]

describe('BudgetRow', () => {
  beforeEach(() => {
    mocks.updateLimit.mockReset().mockResolvedValue({})
    mocks.createLimit.mockReset().mockResolvedValue({})
    mocks.updateBudget.mockReset().mockResolvedValue({})
    mocks.deleteBudget.mockReset().mockResolvedValue(undefined)
    mocks.toast.mockReset()
    vi.spyOn(window, 'confirm').mockReturnValue(true)
  })

  it('edits the selected overlapping limit including its date range', async () => {
    render(<BudgetRow budget={budget} limits={limits} range={{ start: '2026-07-01', end: '2026-07-31' }} />)
    fireEvent.click(screen.getByRole('button', { name: '管理 Food 的限额' }))

    fireEvent.change(screen.getByLabelText('限额 2 开始'), { target: { value: '2026-07-12' } })
    fireEvent.change(screen.getByLabelText('限额 2 金额'), { target: { value: '250.50' } })
    fireEvent.click(screen.getByRole('button', { name: '保存限额 2' }))

    await waitFor(() => expect(mocks.updateLimit).toHaveBeenCalledWith({
      budgetId: '5',
      limitId: '11',
      input: { amount: '250.5', start: '2026-07-12', end: '2026-07-31' },
    }))
  })

  it('renames, disables and deletes a budget through explicit actions', async () => {
    render(<BudgetRow budget={budget} limits={limits} range={{ start: '2026-07-01', end: '2026-07-31' }} />)
    fireEvent.click(screen.getByRole('button', { name: '编辑预算 Food' }))
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'Dining' } })
    fireEvent.click(screen.getByLabelText('启用预算'))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(mocks.updateBudget).toHaveBeenCalledWith({ budgetId: '5', input: { name: 'Dining', active: false } }))

    fireEvent.click(screen.getByRole('button', { name: '编辑预算 Food' }))
    fireEvent.click(screen.getByRole('button', { name: '删除预算 Food' }))
    await waitFor(() => expect(mocks.deleteBudget).toHaveBeenCalledWith('5'))
  })
})
