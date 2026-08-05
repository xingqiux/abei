import { describe, expect, it } from 'vitest'
import type { TransactionSplit } from '../api/schemas'
import { flattenTransactionGroups, signedSplitAmount, toTransactionGroupView } from './transactionGroup'

function split(amount: string, currencySymbol = '¥', currencyCode = 'CNY'): TransactionSplit {
  return {
    amount,
    currency_symbol: currencySymbol,
    currency_code: currencyCode,
    category_name: null,
    date: '2026-07-20T12:00:00+08:00',
    description: 'synthetic transaction',
    destination_name: 'Expense',
    source_name: 'Checking',
    type: 'withdrawal',
  }
}

describe('toTransactionGroupView', () => {
  it('keeps every split and sums same-currency amounts exactly', () => {
    const view = toTransactionGroupView({
      id: 'group-1',
      attributes: { transactions: [split('10.10'), split('20.20')] },
    })

    expect(view?.splits).toHaveLength(2)
    expect(view?.totals).toEqual([
      { amount: '30.3', currencyCode: 'CNY', currencySymbol: '¥' },
    ])
  })

  it('does not combine different currencies', () => {
    const view = toTransactionGroupView({
      id: 'group-2',
      attributes: { transactions: [split('1', '$', 'USD'), split('2', '€', 'EUR')] },
    })
    expect(view?.totals).toHaveLength(2)
  })

  it('uses absolute split amounts for the group total', () => {
    const view = toTransactionGroupView({
      id: 'group-3',
      attributes: { transactions: [split('-10.50'), split('2.25')] },
    })

    expect(view?.totals[0]?.amount).toBe('12.75')
  })
})

describe('signedSplitAmount', () => {
  it('applies cash-flow signs without changing transfers', () => {
    expect(signedSplitAmount(split('12'))).toBe('-12')
    expect(signedSplitAmount({ ...split('12'), type: 'deposit' })).toBe('12')
    expect(signedSplitAmount({ ...split('12'), type: 'transfer' })).toBe('0')
  })
})

describe('flattenTransactionGroups', () => {
  it('returns every split with a stable group position', () => {
    const rows = flattenTransactionGroups([
      { id: 'group-1', attributes: { transactions: [split('1'), split('2')] } },
    ])
    expect(rows.map(({ groupId, splitCount, splitIndex }) => ({ groupId, splitCount, splitIndex }))).toEqual([
      { groupId: 'group-1', splitCount: 2, splitIndex: 0 },
      { groupId: 'group-1', splitCount: 2, splitIndex: 1 },
    ])
  })

  it('marks every row when any split in the group is reconciled', () => {
    const rows = flattenTransactionGroups([
      {
        id: 'group-1',
        attributes: {
          transactions: [split('1'), { ...split('2'), reconciled: true }],
        },
      },
    ])

    expect(rows.map((row) => row.hasReconciledSplit)).toEqual([true, true])
  })
})
