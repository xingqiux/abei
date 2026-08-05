import { describe, expect, it } from 'vitest'
import { formatAmount } from './format'

describe('formatAmount', () => {
  it('renders database decimals as exact two-place money', () => {
    expect(formatAmount('14254.56000000')).toBe('14,254.56')
    expect(formatAmount('-2.95000000')).toBe('2.95')
    expect(formatAmount('999.999')).toBe('1,000.00')
    expect(formatAmount('9007199254740993.129')).toBe('9,007,199,254,740,993.13')
  })
})
