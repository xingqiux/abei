import { fireEvent, render, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { TransactionSplit } from '../../api/schemas'
import { TransactionRow } from './TransactionRow'

// 保留原模块：TransactionRow 现在经 routes/router 取 txSearch，而 router.tsx 在模块顶层就用到了
// lazyRouteComponent / createRoute 这些真家伙
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  Link: ({ to, search, children, ...props }: { to: string; search: { transaction: number }; children: ReactNode }) => (
    <a href={`${to}?transaction=${search.transaction}`} {...props}>{children}</a>
  ),
}))

const transaction = {
  description: 'Coffee',
  amount: '12.50',
  currency_symbol: '¥',
  type: 'withdrawal',
  date: '2026-07-22T10:00:00Z',
  source_name: 'Checking',
  destination_name: 'Cafe',
  category_name: '餐饮',
} as TransactionSplit

describe('TransactionRow', () => {
  it('uses the row for details and keeps deletion in the secondary menu', () => {
    const onDelete = vi.fn()
    render(<TransactionRow tx={transaction} ids={{ groupId: '42', journalId: '42' }} onDelete={onDelete} />)

    for (const link of screen.getAllByRole('link', { name: '查看交易 Coffee' })) {
      expect(link).toHaveAttribute('href', '/transactions?transaction=42')
    }

    fireEvent.click(screen.getAllByRole('button', { name: '交易操作' })[1])
    const menu = screen.getByRole('menu')
    expect(within(menu).getByRole('menuitem', { name: '查看详情' })).toBeInTheDocument()
    fireEvent.click(within(menu).getByRole('menuitem', { name: '移入回收站' }))
    expect(onDelete).toHaveBeenCalledWith({ groupId: '42', journalId: '42' })
  })
})
