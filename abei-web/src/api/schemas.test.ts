import { describe, expect, it } from 'vitest'
import {
  billInboxSummarySchema,
  billInboxSyncResultSchema,
  billStatementRowSchema,
  billTaskSchema,
} from './schemas'

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

  it('accepts queued and completed mailbox sync states', () => {
    const state = {
      status: 'queued' as const,
      requested_at: '2026-08-10T01:02:03+00:00',
      started_at: null,
      finished_at: null,
      result: null,
      error_message: null,
    }

    expect(billInboxSyncResultSchema.parse({ data: { attributes: state } }).data.attributes.status)
      .toBe('queued')
    expect(billInboxSummarySchema.parse({
      pending_total: 0,
      needs_code: 0,
      unprocessed: 0,
      failed: 0,
      channels: [],
      mailbox_sync: {
        ...state,
        status: 'succeeded',
        finished_at: '2026-08-10T01:02:04+00:00',
        result: {
          scanned: 1,
          created: 1,
          ignored: 0,
          duplicates: 0,
          failed: 0,
          processed: 1,
          process_failed: 0,
          errors: [],
        },
      },
    }).mailbox_sync?.result?.created).toBe(1)
  })
})
