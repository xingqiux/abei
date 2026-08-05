import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TransactionAttachments } from './TransactionAttachments'

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  toast: vi.fn(),
  attachments: [] as Array<Record<string, unknown>>,
}))

vi.mock('../../api/queries', () => ({
  useAbout: () => ({ data: { data: { attachment_upload_size: 10, attachment_mime_types: ['text/plain'] } } }),
  useTransactionAttachments: () => ({ data: { data: mocks.attachments }, isLoading: false, isError: false, isSuccess: true, refetch: vi.fn() }),
  useCreateTransactionAttachment: () => ({ mutateAsync: mocks.create, isPending: false }),
  useUpdateAttachment: () => ({ mutateAsync: mocks.update, isPending: false }),
  useDeleteAttachment: () => ({ mutateAsync: vi.fn() }),
}))

vi.mock('../../api/firefly', () => ({ downloadAttachment: vi.fn() }))
vi.mock('../../store/toastStore', () => ({ showToast: mocks.toast }))

describe('TransactionAttachments', () => {
  beforeEach(() => {
    mocks.create.mockReset()
    mocks.create.mockResolvedValue(undefined)
    mocks.update.mockReset().mockResolvedValue(undefined)
    mocks.toast.mockReset()
    mocks.attachments.splice(0)
  })

  it('rejects oversized and unsupported files before creating an attachment', () => {
    const { container } = render(<TransactionAttachments groupId="10" journalId="20" />)
    const input = container.querySelector('input[type="file"]') as HTMLInputElement

    fireEvent.change(input, { target: { files: [new File([new Uint8Array(11)], 'large.txt', { type: 'text/plain' })] } })
    fireEvent.change(input, { target: { files: [new File(['MZ'], 'program.exe', { type: 'application/x-msdownload' })] } })

    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.toast).toHaveBeenCalledTimes(2)
  })

  it('uploads an allowed file', async () => {
    const { container } = render(<TransactionAttachments groupId="10" journalId="20" />)
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['receipt'], 'receipt.txt', { type: 'text/plain' })

    fireEvent.change(input, { target: { files: [file] } })

    await waitFor(() => expect(mocks.create).toHaveBeenCalledWith({ journalId: '20', file }))
  })

  it('edits filename, title and notes together', async () => {
    mocks.attachments.push({
      id: '7',
      attributes: {
        filename: 'old.pdf',
        title: 'Old receipt',
        notes: 'old note',
        size: 128,
      },
    })
    render(<TransactionAttachments groupId="10" journalId="20" />)

    fireEvent.click(screen.getByRole('button', { name: '编辑 Old receipt' }))
    fireEvent.change(screen.getByLabelText('文件名'), { target: { value: 'new.pdf' } })
    fireEvent.change(screen.getByLabelText('标题'), { target: { value: 'New receipt' } })
    fireEvent.change(screen.getByLabelText('备注'), { target: { value: 'reconciled' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith({
      attachmentId: '7',
      input: { filename: 'new.pdf', title: 'New receipt', notes: 'reconciled' },
    }))
  })
})
