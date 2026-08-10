import type { TransactionSplit } from '../api/schemas'
import { semanticOf, type MoneySemantic } from './format'
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

function reconDirection(tx: TransactionSplit): 'decrease' | 'increase' {
  const srcType = String((tx as { source_type?: string }).source_type ?? '')
  const destType = String((tx as { destination_type?: string }).destination_type ?? '')
  const isDecrease =
    destType.toLowerCase().includes('reconciliation') ||
    (!srcType.toLowerCase().includes('reconciliation') && destType !== '')
  return isDecrease ? 'decrease' : 'increase'
}

/** reconciliation 按 source/destination 推断增减，避免「A→A ¥0.01」无正负号 */
export function splitSemantic(tx: TransactionSplit): MoneySemantic {
  if (tx.type === 'reconciliation') return reconDirection(tx) === 'decrease' ? 'expense' : 'income'
  return semanticOf(tx.type)
}

export function splitFlowLabel(tx: TransactionSplit): string {
  if (tx.type === 'reconciliation') {
    return reconDirection(tx) === 'decrease'
      ? `${tx.source_name ?? '?'} → 对账账户`
      : `对账账户 → ${tx.destination_name ?? '?'}`
  }
  return `${tx.source_name ?? '?'} → ${tx.destination_name ?? '?'}`
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
