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

vi.mock('../../components/abaku/Modal', () => ({
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

  it('validates the Abaku account name before saving', async () => {
    render(<AccountDialog open type="asset" account={null} onClose={mocks.close} />)

    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(mocks.toast).toHaveBeenLastCalledWith({ kind: 'error', message: '账户名称不能为空' })
    expect(mocks.create).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'Checking' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Checking',
      currency_code: 'CNY',
      account_role: 'bank',
    })))
  })

  it('updates only fields supported by Abaku accounts', async () => {
    const account = {
      id: '7',
      attributes: {
        name: 'Checking',
        type: 'asset',
        currency_code: 'CNY',
        account_role: 'bank',
        version: 3,
      },
    } as Account
    render(<AccountDialog open type="asset" account={account} onClose={mocks.close} />)

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'Daily checking' } })
    fireEvent.change(screen.getByLabelText('账户角色'), { target: { value: 'other' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith({
      accountId: '7',
      input: {
        name: 'Daily checking',
        type: 'asset',
        currency_code: 'CNY',
        account_role: 'other',
        version: 3,
      },
    }))
  })
})
