import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AccountDialog } from './AccountDialog'
import type { Account } from '../../api/schemas'

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  toast: vi.fn(),
  close: vi.fn(),
}))

vi.mock('../../components/granary/Modal', () => ({
  Modal: ({ open, title, children, footer }: { open: boolean; title: string; children: React.ReactNode; footer: React.ReactNode }) => open ? <div><h2>{title}</h2>{children}{footer}</div> : null,
}))
vi.mock('../../api/queries', () => ({
  useCreateAccount: () => ({ mutateAsync: mocks.create, isPending: false }),
  useUpdateAccount: () => ({ mutateAsync: mocks.update, isPending: false }),
  useCurrencies: () => ({
    data: { data: [{ id: '1', attributes: { code: 'CNY', name: 'Chinese Yuan', default: true, enabled: true } }] },
    isLoading: false,
  }),
}))
vi.mock('../../store/toastStore', () => ({ showToast: mocks.toast }))

describe('AccountDialog', () => {
  beforeEach(() => {
    mocks.create.mockReset()
    mocks.create.mockResolvedValue(undefined)
    mocks.update.mockReset().mockResolvedValue(undefined)
    mocks.toast.mockReset()
    mocks.close.mockReset()
  })

  it('requires the complete monthly-full credit card contract before saving', async () => {
    render(<AccountDialog open type="asset" account={null} onClose={mocks.close} />)

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'Credit card' } })
    fireEvent.change(screen.getByLabelText('账户角色'), { target: { value: 'ccAsset' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(mocks.toast).toHaveBeenLastCalledWith({ kind: 'error', message: '请选择信用卡还款方式' })

    fireEvent.change(screen.getByLabelText('信用卡还款方式'), { target: { value: 'monthlyFull' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(mocks.toast).toHaveBeenLastCalledWith({ kind: 'error', message: '请选择每月还款日' })
    expect(mocks.create).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText('每月还款日'), { target: { value: '2026-07-25' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Credit card',
      currency_code: 'CNY',
      account_role: 'ccAsset',
      credit_card_type: 'monthlyFull',
      monthly_payment_date: '2026-07-25',
    })))
  })

  it('explicitly clears an existing opening balance', async () => {
    const account = {
      id: '7',
      attributes: {
        name: 'Checking',
        type: 'asset',
        currency_code: 'CNY',
        opening_balance: '100.00',
        opening_balance_date: '2026-01-01T00:00:00+08:00',
      },
    } as Account
    render(<AccountDialog open type="asset" account={account} onClose={mocks.close} />)

    fireEvent.change(screen.getByLabelText('期初余额'), { target: { value: '' } })
    fireEvent.change(screen.getByLabelText('期初日期'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith({
      accountId: '7',
      input: expect.objectContaining({ opening_balance: '', opening_balance_date: '' }),
    }))
  })
})
