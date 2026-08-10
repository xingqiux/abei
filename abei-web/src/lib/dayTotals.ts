import { sumDecimalStrings } from './decimal'
import { signedSplitAmount, type TransactionSplitRow } from './transactionGroup'

export interface CurrencyTotal {
  symbol: string
  /** 带符号的合计，转账在 signedSplitAmount 里已经算 0 */
  amount: string
}

export interface DayGroup {
  day: string
  rows: TransactionSplitRow[]
  totals: CurrencyTotal[]
}

/**
 * 按币种汇总一组拆分行。多币种账本里把不同币种的数直接相加是错的，
 * 所以分开列，不做换算。
 */
export function sumByCurrency(rows: readonly TransactionSplitRow[]): CurrencyTotal[] {
  const buckets = new Map<string, { symbol: string; values: string[] }>()
  for (const row of rows) {
    const code = String((row.tx as typeof row.tx & { currency_code?: string }).currency_code ?? '') || row.tx.currency_symbol
    const bucket = buckets.get(code)
    if (bucket) bucket.values.push(signedSplitAmount(row.tx))
    else buckets.set(code, { symbol: row.tx.currency_symbol, values: [signedSplitAmount(row.tx)] })
  }
  return Array.from(buckets.values(), ({ symbol, values }) => ({ symbol, amount: sumDecimalStrings(values) }))
}

/** 按日分组，保持传入顺序（调用方负责排序），每组带按币种的合计。 */
export function groupRowsByDay(rows: readonly TransactionSplitRow[]): DayGroup[] {
  const groups: DayGroup[] = []
  let current: DayGroup | null = null
  for (const row of rows) {
    const day = row.tx.date.slice(0, 10)
    if (!current || current.day !== day) {
      current = { day, rows: [], totals: [] }
      groups.push(current)
    }
    current.rows.push(row)
  }
  for (const group of groups) group.totals = sumByCurrency(group.rows)
  return groups
}

/** 两个 YYYY-MM-DD 之间隔了几天。用于「账本停了多少天」这类文案。 */
export function daysBetween(from: string, to: string): number {
  const a = new Date(`${from}T00:00:00`)
  const b = new Date(`${to}T00:00:00`)
  return Math.round((b.getTime() - a.getTime()) / 86400000)
}
