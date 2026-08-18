import { describe, expect, it } from 'vitest'
import {
  billAccountMappingResponseSchema,
  billAccountMappingsResponseSchema,
  billInboxSummarySchema,
  billInboxSyncResultSchema,
  billQueueRowSchema,
  billStatementRowSchema,
  billImportAttemptStatusSchema,
  billTaskSchema,
} from './schemas'

describe('bill inbox schemas', () => {
  it('入账尝试状态含撤销态（undo-import 会写 undone，缺了整页解析都会挂）', () => {
    expect(billImportAttemptStatusSchema.parse('undone')).toBe('undone')
  })

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

  it('accepts unmapped account-mapping candidates from the server', () => {
    // 取自 GET /api/v1/bill-inbox/account-mappings 的真实响应
    const parsed = billAccountMappingsResponseSchema.parse({
      data: [
        {
          id: 'pending:cmb:招商银行信用卡(5599)',
          type: 'bill-account-mapping',
          attributes: {
            account_hint: '招商银行信用卡(5599)',
            candidate_mappings: [],
            channel_key: 'cmb',
            created_at: null,
            firefly_account_id: null,
            firefly_account_name: null,
            firefly_account_type: null,
            last_verified_at: null,
            mapping_status: 'unmapped',
            normalized_hints: ['招商银行信用卡(5599)', '招商银行信用卡', '5599'],
            source: null,
            updated_at: null,
            usage_count: 15,
          },
        },
      ],
    })
    expect(parsed.data[0].attributes.firefly_account_id).toBeNull()
    expect(parsed.data[0].attributes.mapping_status).toBe('unmapped')
    expect(parsed.data[0].attributes.usage_count).toBe(15)
    expect(parsed.data[0].attributes.normalized_hints).toHaveLength(3)
  })

  it('accepts a fully mapped entry and a single-mapping response without list-only fields', () => {
    const mapped = billAccountMappingsResponseSchema.parse({
      data: [
        {
          id: '12',
          type: 'bill-account-mapping',
          attributes: {
            channel_key: 'cmb',
            account_hint: '招商银行信用卡(5599)',
            firefly_account_id: '31',
            firefly_account_name: '招行信用卡',
            firefly_account_type: 'liabilities',
            source: 'manual',
            last_verified_at: null,
            created_at: '2026-08-01T00:00:00+00:00',
            updated_at: '2026-08-01T00:00:00+00:00',
            usage_count: 0,
            mapping_status: 'mapped',
            normalized_hints: ['招商银行信用卡(5599)'],
            candidate_mappings: [
              {
                id: '12',
                account_hint: '招商银行信用卡(5599)',
                firefly_account_id: '31',
                firefly_account_name: '招行信用卡',
              },
            ],
          },
        },
      ],
    })
    expect(mapped.data[0].attributes.firefly_account_id).toBe('31')

    // upsert / get 单条接口不下发 usage_count 等列表专属字段
    const single = billAccountMappingResponseSchema.parse({
      data: {
        id: '12',
        type: 'bill-account-mapping',
        attributes: {
          channel_key: 'cmb',
          account_hint: '招商银行信用卡(5599)',
          firefly_account_id: '31',
          firefly_account_name: '招行信用卡',
          firefly_account_type: null,
          source: 'manual',
          last_verified_at: null,
          created_at: '2026-08-01T00:00:00+00:00',
          updated_at: '2026-08-01T00:00:00+00:00',
        },
      },
    })
    expect(single.data.attributes.mapping_status).toBeUndefined()
  })
})

describe('队列行上的「另一笔」', () => {
  it('配对和判重的对侧随行下发，缺省时都是 null', () => {
    const parsed = billQueueRowSchema.parse({
      id: '9',
      attributes: {
        bill_task_id: '7',
        status: 'pending',
        duplicate_state: 'duplicate',
        occurred_at: null,
        amount: null,
        pair: {
          link_id: '31',
          relation: 'cross_source_candidate',
          state: 'confirmed',
          decided_by: 'auto',
          other: { id: '10', channel_key: 'alipay', signed_amount: '-12.34' },
        },
        duplicate_of: { id: '10', description: '微信支付-测试商户', occurred_at: '2026-08-11T08:30:00' },
      },
    })
    expect(parsed.attributes.pair?.decided_by).toBe('auto')
    expect(parsed.attributes.pair?.other.channel_key).toBe('alipay')
    expect(parsed.attributes.duplicate_of?.description).toBe('微信支付-测试商户')

    const bare = billQueueRowSchema.parse({
      id: '9',
      attributes: {
        bill_task_id: '7', status: 'pending', duplicate_state: 'unique',
        occurred_at: null, amount: null, pair: null, duplicate_of: null,
      },
    })
    expect(bare.attributes.pair).toBeNull()
    expect(bare.attributes.duplicate_of).toBeNull()
  })
})
