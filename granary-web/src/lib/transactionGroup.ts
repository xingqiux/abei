import type { TransactionSplit } from '../api/schemas'
import { absoluteDecimalString, sumDecimalStrings } from './decimal'

export interface TransactionGroupView {
  groupId: string
  date: string
  splits: TransactionSplit[]
  totals: Array<{ currencyCode?: string; currencySymbol: string; amount: string }>
}

export interface TransactionSplitRow {
  groupId: string
  splitCount: number
  splitIndex: number
  hasReconciledSplit: boolean
  tx: TransactionSplit
}

export function hasReconciledTransactionSplit(splits: readonly TransactionSplit[]): boolean {
  return splits.some((split) => split.reconciled === true)
}

export function toTransactionGroupView(group: {
  id: string
  attributes: { transactions: TransactionSplit[] }
}): TransactionGroupView | null {
  const splits = group.attributes.transactions
  if (splits.length === 0) return null
  const totalsByCurrency = new Map<
    string,
    { currencyCode?: string; currencySymbol: string; amounts: string[] }
  >()

  for (const split of splits) {
    const currencyCode = String(
      (split as TransactionSplit & { currency_code?: string }).currency_code ?? '',
    )
    const key = currencyCode || split.currency_symbol
    const current = totalsByCurrency.get(key)
    const amount = absoluteDecimalString(split.amount)
    if (current) current.amounts.push(amount)
    else {
      totalsByCurrency.set(key, {
        currencyCode: currencyCode || undefined,
        currencySymbol: split.currency_symbol,
        amounts: [amount],
      })
    }
  }

  return {
    groupId: group.id,
    date: splits[0].date,
    splits,
    totals: Array.from(totalsByCurrency.values(), (item) => ({
      currencyCode: item.currencyCode,
      currencySymbol: item.currencySymbol,
      amount: sumDecimalStrings(item.amounts),
    })),
  }
}

export function flattenTransactionGroups(
  groups: readonly { id: string; attributes: { transactions: TransactionSplit[] } }[],
): TransactionSplitRow[] {
  return groups.flatMap((group) => {
    const splits = group.attributes.transactions
    const hasReconciledSplit = hasReconciledTransactionSplit(splits)
    return splits.map((tx, splitIndex) => ({
      groupId: group.id,
      splitCount: splits.length,
      splitIndex,
      hasReconciledSplit,
      tx,
    }))
  })
}

export function signedSplitAmount(split: TransactionSplit): string {
  if (split.type === 'withdrawal') return `-${split.amount.replace(/^-/, '')}`
  if (split.type === 'deposit') return split.amount.replace(/^-/, '')
  return '0'
}
