import { describe, expect, it } from 'vitest'
import { isEditableTransactionGroup } from './editPayload'

describe('isEditableTransactionGroup', () => {
  it('rejects a user transaction group when any split is reconciled', () => {
    expect(isEditableTransactionGroup('withdrawal', true)).toBe(false)
    expect(isEditableTransactionGroup('withdrawal', false)).toBe(true)
  })

  it('continues to reject system transaction types', () => {
    expect(isEditableTransactionGroup('reconciliation', false)).toBe(false)
    expect(isEditableTransactionGroup('opening balance', false)).toBe(false)
  })
})
