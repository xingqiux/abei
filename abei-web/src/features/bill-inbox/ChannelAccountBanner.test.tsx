import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ChannelAccountBanner } from './ChannelAccountBanner'

/**
 * 这条横幅是收件箱里唯一还问用户账户的地方，只在一种情况下出现：
 * Firefly 里已经有同名账户，系统不敢替人决定新账单记不记进去。
 */

const mocks = vi.hoisted(() => ({
  pending: [] as unknown[],
  confirm: vi.fn(),
}))

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children?: unknown }) => children,
}))

vi.mock('../../api/queries', () => ({
  useBillChannelAccounts: () => ({ data: { data: mocks.pending } }),
  useConfirmBillChannelAccount: () => ({ mutateAsync: mocks.confirm, isPending: false }),
}))

function entry() {
  return {
    id: '7',
    type: 'bill-channel-account',
    attributes: {
      channel_key: 'cmb',
      channel_name: '招商银行',
      account_hint: '招商银行信用卡(1234)',
      firefly_account_id: '31',
      firefly_account_name: '招商银行',
    },
  }
}

beforeEach(() => {
  mocks.pending = []
  mocks.confirm.mockReset()
  mocks.confirm.mockResolvedValue({})
})

describe('ChannelAccountBanner', () => {
  it('没有要问的事就一点位置都不占', () => {
    const { container } = render(<ChannelAccountBanner />)
    expect(container).toBeEmptyDOMElement()
  })

  it('已有同名账户时问一句，点一次就把这一渠道定下来', async () => {
    mocks.pending = [entry()]
    render(<ChannelAccountBanner />)

    expect(screen.getByText(/发现你已有「招商银行」账户/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '记进它' }))
    expect(mocks.confirm).toHaveBeenCalledWith('7')
  })
})
