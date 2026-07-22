import type { SummaryEntry, SummaryResponse } from '../api/schemas'
import { sumDecimalStrings } from './decimal'

export interface CurrencyAmount {
  code: string
  symbol: string
  value: string
}

function asCurrencyAmount(entry: SummaryEntry): CurrencyAmount {
  return {
    code: entry.currency_code ?? entry.key.split('-in-')[1] ?? '',
    symbol: entry.currency_symbol ?? entry.currency_code ?? '',
    value: entry.monetary_value,
  }
}

export function summaryAmounts(summary: SummaryResponse, prefix: string): CurrencyAmount[] {
  return Object.values(summary)
    .filter((entry) => entry.key.startsWith(`${prefix}-in-`))
    .map(asCurrencyAmount)
    .sort((a, b) => a.code.localeCompare(b.code))
}

export function cashflowAmounts(summary: SummaryResponse): CurrencyAmount[] {
  const byCode = new Map<string, { metadata: CurrencyAmount; values: string[] }>()
  for (const amount of [...summaryAmounts(summary, 'spent'), ...summaryAmounts(summary, 'earned')]) {
    const current = byCode.get(amount.code)
    if (current) current.values.push(amount.value)
    else byCode.set(amount.code, { metadata: amount, values: [amount.value] })
  }
  return Array.from(byCode.values(), ({ metadata, values }) => ({
    ...metadata,
    value: sumDecimalStrings(values),
  }))
}
