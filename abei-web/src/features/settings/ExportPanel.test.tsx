import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ExportPanel } from './ExportPanel'

const mocks = vi.hoisted(() => ({
  exportData: vi.fn(),
  toast: vi.fn(),
  refetch: vi.fn(),
}))

vi.mock('../../api/firefly', () => ({ exportData: mocks.exportData }))
vi.mock('../../api/queries', () => ({
  useAssetAccounts: () => ({
    data: [{ id: '7', name: 'Checking' }],
    isError: false,
    refetch: mocks.refetch,
  }),
}))
vi.mock('../../store/dateRangeStore', () => ({
  useDateRangeStore: () => ({ start: '2026-07-01', end: '2026-07-31' }),
}))
vi.mock('../../store/toastStore', () => ({ showToast: mocks.toast }))

describe('ExportPanel', () => {
  beforeEach(() => {
    mocks.exportData.mockReset()
    mocks.exportData.mockResolvedValue({ blob: new Blob(['csv']), filename: 'transactions.csv' })
    mocks.toast.mockReset()
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
  })

  it('rejects an inverted transaction date range without calling the API', () => {
    render(<ExportPanel />)

    fireEvent.change(screen.getByLabelText('开始'), { target: { value: '2026-07-31' } })
    fireEvent.change(screen.getByLabelText('结束'), { target: { value: '2026-07-01' } })
    fireEvent.click(screen.getByRole('button', { name: '导出' }))

    expect(mocks.exportData).not.toHaveBeenCalled()
    // 报错标在出错的那一格上，不再弹 toast——toast 浮在右上角，看完还得自己找回输入框
    expect(screen.getByText('开始日期不能晚于结束日期')).toBeInTheDocument()
    expect(mocks.toast).not.toHaveBeenCalled()
  })

  it('passes the selected date range and accounts to the CSV endpoint', async () => {
    render(<ExportPanel />)

    fireEvent.click(screen.getByLabelText('Checking'))
    fireEvent.click(screen.getByRole('button', { name: '导出' }))

    await waitFor(() => expect(mocks.exportData).toHaveBeenCalledWith('transactions', {
      start: '2026-07-01',
      end: '2026-07-31',
      accounts: ['7'],
    }))
  })

  it('allows a one-day transaction export', async () => {
    render(<ExportPanel />)

    fireEvent.change(screen.getByLabelText('开始'), { target: { value: '2026-07-20' } })
    fireEvent.change(screen.getByLabelText('结束'), { target: { value: '2026-07-20' } })
    fireEvent.click(screen.getByRole('button', { name: '导出' }))

    await waitFor(() => expect(mocks.exportData).toHaveBeenCalledWith('transactions', {
      start: '2026-07-20',
      end: '2026-07-20',
      accounts: [],
    }))
  })
})
