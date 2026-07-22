import { describe, expect, it } from 'vitest'
import { validateTransactionSearch } from './router'

describe('validateTransactionSearch', () => {
  it('accepts direct URL and router numeric transaction ids', () => {
    expect(validateTransactionSearch({ transaction: '42' })).toEqual({ transaction: 42 })
    expect(validateTransactionSearch({ transaction: 42 })).toEqual({ transaction: 42 })
  })

  it('rejects invalid transaction ids', () => {
    expect(validateTransactionSearch({ transaction: 'not-an-id' })).toEqual({ transaction: undefined })
    expect(validateTransactionSearch({ transaction: 0 })).toEqual({ transaction: undefined })
  })
})
