import { describe, expect, it } from 'vitest'
import type { BillStatementRow } from '../../api/schemas'
import {
  isInboxTab,
  isRowSelectable,
  preferredInboxTab,
  syncResultFeedback,
  TAB_CONFIG,
} from './billInboxHelpers'

function makeRow(overrides: Record<string, unknown> = {}): BillStatementRow {
  return {
    id: '1',
    attributes: {
      bill_task_id: '7',
      status: 'pending',
      duplicate_state: 'unique',
      occurred_at: '2026-07-20T10:00:00+08:00',
      amount: '12.34',
      firefly_type: 'withdrawal',
      firefly_date: null,
      firefly_amount: '12.34',
      firefly_description: 'Lunch',
      source_name: 'Checking',
      destination_name: 'Restaurant',
      ...overrides,
    },
  } as BillStatementRow
}

describe('isRowSelectable', () => {
  it('accepts a complete pending unique row and its original-date fallback', () => {
    expect(isRowSelectable(makeRow())).toBe(true)
  })

  it.each([
    ['non-pending status', { status: 'imported' }],
    ['non-unique row', { duplicate_state: 'duplicate' }],
    ['missing type', { firefly_type: null }],
    ['missing date', { firefly_date: null, occurred_at: null }],
    ['invalid date', { firefly_date: '0' }],
    ['nonexistent calendar date', { firefly_date: '2026-02-31' }],
    ['missing import amount', { firefly_amount: null }],
    ['zero import amount', { firefly_amount: '0' }],
    ['missing description', { firefly_description: null, description: null, counterparty: null }],
    ['missing source', { source_name: ' ' }],
    ['missing destination', { destination_name: null }],
  ])('rejects %s', (_label, overrides) => {
    expect(isRowSelectable(makeRow(overrides))).toBe(false)
  })
})

describe('syncResultFeedback', () => {
  const base = {
    scanned: 0,
    created: 0,
    ignored: 0,
    duplicates: 0,
    failed: 0,
    processed: 0,
    process_failed: 0,
  }

  it('shows a mailbox error instead of a success message', () => {
    expect(syncResultFeedback({ ...base, failed: 1, errors: ['邮箱密码无法解密'] })).toEqual({
      kind: 'error',
      message: '邮箱密码无法解密',
    })
  })

  it('explains a successful sync with no matching mail', () => {
    expect(syncResultFeedback(base)).toEqual({
      kind: 'success',
      message: '同步完成：未发现新的账单邮件',
    })
  })
})

describe('inbox tab helpers', () => {
  it('lists 需处理 before 待审', () => {
    expect(TAB_CONFIG.map((tab) => tab.key)).toEqual(['processing', 'parsed', 'imported', 'ignored'])
  })

  it('validates tab keys', () => {
    expect(isInboxTab('processing')).toBe(true)
    expect(isInboxTab('parsed')).toBe(true)
    expect(isInboxTab('ready')).toBe(false)
    expect(isInboxTab(null)).toBe(false)
  })

  it('prefers 需处理 when there are blocking tasks', () => {
    expect(preferredInboxTab(2)).toBe('processing')
    expect(preferredInboxTab(0)).toBe('parsed')
  })
})
