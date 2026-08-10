import { describe, expect, it } from 'vitest'
import { billStatementRowSchema, billTaskSchema } from './schemas'

describe('bill inbox schemas', () => {
  it('accepts nullable fields emitted by the backend', () => {
    expect(billTaskSchema.parse({
      id: '7',
      attributes: {
        source: 'alipay',
        status: 'parsed',
        metadata: null,
        row_counts: { total: 1, pending: 1, imported: 0, duplicate: 0, conflict: 0 },
      },
    }).attributes.metadata).toBeNull()

    expect(billStatementRowSchema.parse({
      id: '9',
      attributes: {
        bill_task_id: '7',
        status: 'pending',
        duplicate_state: 'unique',
        occurred_at: null,
        amount: null,
        tags: null,
      },
    }).attributes).toMatchObject({ occurred_at: null, amount: null, tags: null })
  })
})
