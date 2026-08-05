import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BillInboxSettingsDialog } from './BillInboxSettingsDialog'

const mocks = vi.hoisted(() => ({
  close: vi.fn(),
  query: vi.fn(),
  refetch: vi.fn(),
  toast: vi.fn(),
  update: vi.fn(),
}))

vi.mock('../../components/abaku/Modal', () => ({
  Modal: ({ open, title, children, footer }: { open: boolean; title: string; children: React.ReactNode; footer: React.ReactNode }) => open ? <div><h2>{title}</h2>{children}{footer}</div> : null,
}))
vi.mock('../../api/queries', () => ({
  useBillInboxSettings: () => mocks.query(),
  useUpdateBillInboxSettings: () => ({ mutateAsync: mocks.update, isPending: false }),
}))
vi.mock('../../store/toastStore', () => ({ showToast: mocks.toast }))

function settings(email: string, host = 'imap.example.com') {
  return {
    data: {
      type: 'bill-inbox-settings',
      attributes: {
        enabled: true,
        provider: 'imap',
        email,
        host,
        port: 993,
        encryption: 'ssl',
        username: email,
        folder: 'INBOX',
        has_password: true,
      },
    },
  }
}

function loadedQuery(email = 'bills@example.com', host?: string) {
  return {
    data: settings(email, host),
    isError: false,
    isFetching: false,
    isLoading: false,
    refetch: mocks.refetch,
  }
}

describe('BillInboxSettingsDialog', () => {
  beforeEach(() => {
    mocks.close.mockReset()
    mocks.refetch.mockReset()
    mocks.toast.mockReset()
    mocks.update.mockReset().mockResolvedValue(undefined)
    mocks.query.mockReset().mockReturnValue({
      data: undefined,
      isError: true,
      isFetching: false,
      isLoading: false,
      refetch: mocks.refetch,
    })
  })

  it('never saves the empty fallback form when settings fail to load', () => {
    render(<BillInboxSettingsDialog open onClose={mocks.close} />)

    expect(screen.getByText('邮箱设置加载失败')).toBeInTheDocument()
    const save = screen.getByRole('button', { name: '保存' })
    expect(save).toBeDisabled()
    fireEvent.click(save)
    expect(mocks.update).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(mocks.refetch).toHaveBeenCalledOnce()
  })

  it('does not expose an editable empty form while settings load', () => {
    mocks.query.mockReturnValue({
      data: undefined,
      isError: false,
      isFetching: true,
      isLoading: true,
      refetch: mocks.refetch,
    })

    render(<BillInboxSettingsDialog open onClose={mocks.close} />)

    expect(screen.getByRole('status')).toHaveTextContent('邮箱设置加载中')
    expect(screen.queryByLabelText('邮箱地址')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled()
  })

  it('saves only after server settings have loaded', async () => {
    mocks.query.mockReturnValue(loadedQuery())
    render(<BillInboxSettingsDialog open onClose={mocks.close} />)

    await waitFor(() => expect(screen.getByLabelText('邮箱地址')).toHaveValue('bills@example.com'))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith({
      enabled: true,
      provider: 'imap',
      email: 'bills@example.com',
      host: 'imap.example.com',
      port: 993,
      encryption: 'ssl',
      username: 'bills@example.com',
      folder: 'INBOX',
      password: undefined,
    }))
  })

  it('keeps the current draft until close and reloads the latest settings on reopen', async () => {
    mocks.query.mockReturnValue(loadedQuery('first@example.com'))
    const { rerender } = render(<BillInboxSettingsDialog open onClose={mocks.close} />)
    const email = await screen.findByLabelText('邮箱地址')

    fireEvent.change(email, { target: { value: 'draft@example.com' } })
    mocks.query.mockReturnValue(loadedQuery('latest@example.com', 'imap.latest.example.com'))
    rerender(<BillInboxSettingsDialog open onClose={mocks.close} />)
    expect(screen.getByLabelText('邮箱地址')).toHaveValue('draft@example.com')

    rerender(<BillInboxSettingsDialog open={false} onClose={mocks.close} />)
    rerender(<BillInboxSettingsDialog open onClose={mocks.close} />)

    await waitFor(() => expect(screen.getByLabelText('邮箱地址')).toHaveValue('latest@example.com'))
    expect(screen.getByLabelText('主机')).toHaveValue('imap.latest.example.com')
  })
})
