import { describe, expect, it } from 'vitest'
import { cashflowAmounts, summaryAmounts } from './summary'

const summary = {
  'spent-in-USD': { key: 'spent-in-USD', monetary_value: '-2.20', value_parsed: '', currency_code: 'USD', currency_symbol: '$' },
  'earned-in-CNY': { key: 'earned-in-CNY', monetary_value: '10.10', value_parsed: '', currency_code: 'CNY', currency_symbol: '¥' },
  'spent-in-CNY': { key: 'spent-in-CNY', monetary_value: '-0.10', value_parsed: '', currency_code: 'CNY', currency_symbol: '¥' },
}

describe('summary currency helpers', () => {
  it('keeps currencies separate and computes exact cashflow', () => {
    expect(summaryAmounts(summary, 'spent').map((item) => item.code)).toEqual(['CNY', 'USD'])
    expect(cashflowAmounts(summary)).toEqual([
      { code: 'CNY', symbol: '¥', value: '10' },
      { code: 'USD', symbol: '$', value: '-2.2' },
    ])
  })
})
