import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BillTask } from '../../api/schemas'
import { TaskDetailPanel } from './TaskDetailPanel'

const mocks = vi.hoisted(() => ({
  importRows: vi.fn(),
  retry: vi.fn(),
  submitSecret: vi.fn(),
  refetchRows: vi.fn(),
  toast: vi.fn(),
  rowsError: false,
  rowsResponse: {
    data: [
      { id: '1', attributes: { bill_task_id: '7', status: 'pending', occurred_at: '2026-07-20T10:00:00+08:00', amount: '10.00', duplicate_state: 'unique', firefly_type: 'withdrawal', firefly_amount: '10.00', firefly_description: 'Lunch', source_name: 'Checking', destination_name: 'Restaurant' } },
      { id: '2', attributes: { bill_task_id: '7', status: 'needs_split', occurred_at: '2026-07-20T11:00:00+08:00', amount: '20.00', duplicate_state: 'unique', firefly_type: null, firefly_amount: null, firefly_description: 'Split payment', source_name: null, destination_name: null } },
    ],
  },
}))

vi.mock('../../api/queries', () => ({
  useBillTaskRows: () => ({ data: mocks.rowsResponse, isLoading: false, isError: mocks.rowsError, refetch: mocks.refetchRows }),
  useImportBillTaskRows: () => ({ mutateAsync: mocks.importRows, isPending: false }),
  useRetryBillTask: () => ({ mutateAsync: mocks.retry, isPending: false }),
  useSubmitBillTaskSecret: () => ({ mutateAsync: mocks.submitSecret, isPending: false }),
}))
vi.mock('../../store/toastStore', () => ({ showToast: mocks.toast }))
vi.mock('../../components/abaku/LottieIcon', () => ({ LottieIcon: () => null }))
vi.mock('./StatementRow', () => ({ StatementRow: ({ row }: { row: { id: string; attributes: { status: string } } }) => <div>{row.id}:{row.attributes.status}</div> }))
vi.mock('./TaskEvidencePanel', () => ({ TaskEvidencePanel: () => <div>evidence</div> }))
vi.mock('./IgnoreConfirmDialog', () => ({ IgnoreConfirmDialog: () => null }))
vi.mock('./ImportConfirmDialog', () => ({
  ImportConfirmDialog: ({ open, dryRun, onConfirm }: { open: boolean; dryRun: { summary: { total: number } } | null; onConfirm: () => void }) => open && dryRun ? <div>预览 {dryRun.summary.total}<button type="button" onClick={onConfirm}>确认预览</button></div> : null,
}))

const task = {
  id: '7',
  attributes: { source: 'alipay', status: 'parsed', summary: 'July bill', row_counts: { total: 2, pending: 1, imported: 0, duplicate: 0, conflict: 0 } },
} as BillTask

describe('TaskDetailPanel', () => {
  beforeEach(() => {
    mocks.rowsError = false
    mocks.importRows.mockReset()
    mocks.retry.mockReset()
    mocks.submitSecret.mockReset()
    mocks.refetchRows.mockReset()
    mocks.toast.mockReset()
    mocks.rowsResponse = {
      data: [
        { id: '1', attributes: { bill_task_id: '7', status: 'pending', occurred_at: '2026-07-20T10:00:00+08:00', amount: '10.00', duplicate_state: 'unique', firefly_type: 'withdrawal', firefly_amount: '10.00', firefly_description: 'Lunch', source_name: 'Checking', destination_name: 'Restaurant' } },
        { id: '2', attributes: { bill_task_id: '7', status: 'needs_split', occurred_at: '2026-07-20T11:00:00+08:00', amount: '20.00', duplicate_state: 'unique', firefly_type: null, firefly_amount: null, firefly_description: 'Split payment', source_name: null, destination_name: null } },
      ],
    }
  })

  it('keeps needs-split rows visible while importing only eligible rows after a structured preview', async () => {
    mocks.importRows
      .mockResolvedValueOnce({ summary: { total: 1, imported: 0, skipped: 0, failed: 0 }, rows: [{ row_id: '1', action: 'would_import', status: 'pending' }] })
      .mockResolvedValueOnce({ summary: { total: 1, imported: 1, skipped: 0, failed: 0 }, rows: [{ row_id: '1', action: 'imported', status: 'imported' }] })

    const { rerender } = render(<TaskDetailPanel task={task} onIgnored={vi.fn()} />)
    expect(screen.getByText('2:needs_split')).toBeInTheDocument()
    const importButton = await screen.findByRole('button', { name: '入账 1 笔' })
    fireEvent.click(importButton)

    await screen.findByText('预览 1')
    expect(mocks.importRows).toHaveBeenNthCalledWith(1, { taskId: '7', rowIds: ['1'], confirm: false })

    mocks.rowsResponse = {
      data: [
        { id: '3', attributes: { bill_task_id: '7', status: 'pending', occurred_at: '2026-07-21T10:00:00+08:00', amount: '30.00', duplicate_state: 'unique', firefly_type: 'deposit', firefly_amount: '30.00', firefly_description: 'Refund', source_name: 'Shop', destination_name: 'Checking' } },
      ],
    }
    rerender(<TaskDetailPanel task={task} onIgnored={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '确认预览' }))
    await waitFor(() => expect(mocks.importRows).toHaveBeenNthCalledWith(2, { taskId: '7', rowIds: ['1'], confirm: true }))
  })

  it('keeps the rejected-secret reason next to the password field', () => {
    const rejected = {
      id: '7',
      attributes: {
        source: 'alipay',
        status: 'needs_secret',
        summary: 'July bill',
        error_code: 'secret_rejected',
        error_message: '支付宝账单解压失败，请检查密码是否正确。（还可以再试 4 次）',
      },
    } as BillTask

    render(<TaskDetailPanel task={rejected} onIgnored={vi.fn()} />)

    // toast 几秒就没了，刷新一下更是什么都不剩，所以错误得挂在输入框上
    expect(screen.getByText('支付宝账单解压失败，请检查密码是否正确。（还可以再试 4 次）')).toBeInTheDocument()
    expect(screen.getByLabelText('需要解压密码或验证码')).toHaveAttribute('aria-invalid', 'true')
  })

  it('shows row query failures and provides a retry action', () => {
    mocks.rowsError = true
    render(<TaskDetailPanel task={task} onIgnored={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(mocks.refetchRows).toHaveBeenCalledOnce()
  })
})
