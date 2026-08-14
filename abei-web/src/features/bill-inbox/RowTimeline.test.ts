import { describe, expect, it } from 'vitest'
import { buildRowTimeline, eventLabel } from './RowTimeline'
import type { BillQueueRow, BillTaskEvent } from '../../api/schemas'

function row(attributes: Record<string, unknown>): BillQueueRow {
  return {
    id: '1',
    attributes: {
      bill_task_id: '9',
      status: 'pending',
      occurred_at: '2026-08-01T00:00:00Z',
      amount: '10.00',
      duplicate_state: 'unique',
      ...attributes,
    },
  } as unknown as BillQueueRow
}

function event(id: string, type: string, at: string): BillTaskEvent {
  return {
    id,
    attributes: { bill_task_id: '9', event_type: type, created_at: at },
  } as unknown as BillTaskEvent
}

describe('buildRowTimeline', () => {
  it('把邮件、解析事件和行结局排成一条时间线', () => {
    const items = buildRowTimeline(
      row({
        status: 'imported',
        task: { id: '9', source: 'cmb', received_at: '2026-08-01T08:00:00Z' },
        import_attempt: { id: '3', status: 'succeeded', updated_at: '2026-08-01T09:00:00Z' },
        transaction_group_id: '77',
      }),
      [event('parse-job-1', 'parse_job_succeeded', '2026-08-01T08:30:00Z')],
    )
    expect(items.map((item) => item.label)).toEqual(['收到邮件', '解析完成', '已入账'])
    expect(items[2].detail).toBe('Firefly 交易 #77')
  })

  it('没有时间戳的排在最后而不是最前', () => {
    const items = buildRowTimeline(
      row({ status: 'dismissed', task: { id: '9', source: 'cmb', received_at: '2026-08-01T08:00:00Z' } }),
      [],
    )
    expect(items.map((item) => item.label)).toEqual(['收到邮件', '已忽略'])
  })

  it('认不出来的事件名原样保留', () => {
    expect(eventLabel('parse_job_failed')).toBe('解析失败')
    expect(eventLabel('something_new')).toBe('something_new')
  })
})
