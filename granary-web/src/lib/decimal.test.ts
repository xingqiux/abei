import { describe, expect, it } from 'vitest'
import {
  absoluteDecimalString,
  compareDecimalStrings,
  isPositiveDecimal,
  normalizeDecimalString,
  sumDecimalStrings,
} from './decimal'

describe('sumDecimalStrings', () => {
  it('sums decimal values without floating point drift', () => {
    expect(sumDecimalStrings(['0.1', '0.2'])).toBe('0.3')
    expect(sumDecimalStrings(['9999999999999999.99', '0.01'])).toBe('10000000000000000')
  })

  it('supports different scales and negative values', () => {
    expect(sumDecimalStrings(['10.50', '-0.5', '2'])).toBe('12')
  })

  it('rejects non-decimal API values', () => {
    expect(() => sumDecimalStrings(['NaN'])).toThrow('Invalid decimal value')
  })

  it('compares and normalizes exact decimal strings', () => {
    expect(normalizeDecimalString('001.2300')).toBe('1.23')
    expect(compareDecimalStrings('9007199254740993', '9007199254740992')).toBe(1)
    expect(compareDecimalStrings('1.00', '1')).toBe(0)
    expect(isPositiveDecimal('0.0001')).toBe(true)
    expect(isPositiveDecimal('0')).toBe(false)
    expect(absoluteDecimalString('-12.340')).toBe('12.34')
  })
})
