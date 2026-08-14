import { useBillTaskEvents } from '../../api/queries'
import type { BillQueueRow, BillTaskEvent } from '../../api/schemas'
import { formatDateTime } from '../../lib/format'
import { dismissReasonLabel } from './billInboxHelpers'

/**
 * 一行流水的「历经」：从收到邮件到入账/忽略，中间发生过什么。
 *
 * 事件流本来只在第三层「来源凭证」里、而且直接把 parse_job_failed 这种机器名摆出来。
 * 人展开一行想知道的是「这条卡在哪一步」，所以这里把行自己的时间戳和解析事件
 * 合成一条按时间排的线，措辞用中文。
 */

export interface TimelineItem {
  key: string
  at: string | null
  label: string
  detail?: string | null
}

const EVENT_LABELS: Record<string, string> = {
  parse_job_queued: '排队等解析',
  parse_job_running: '正在解析',
  parse_job_succeeded: '解析完成',
  parse_job_failed: '解析失败',
  parse_job_waiting_input: '等着补账单密码',
  parse_job_cancelled: '解析已取消',
}

/** 机器事件名换成中文；认不出来的原样留着，总比空着强。 */
export function eventLabel(eventType: string): string {
  return EVENT_LABELS[eventType] ?? eventType
}

/** 把行上的时间戳和解析事件合成一条时间线，按时间从早到晚。 */
export function buildRowTimeline(row: BillQueueRow, events: BillTaskEvent[]): TimelineItem[] {
  const a = row.attributes
  const items: TimelineItem[] = []

  if (a.task?.received_at) {
    items.push({ key: 'received', at: a.task.received_at, label: '收到邮件', detail: a.task.summary })
  }

  for (const event of events) {
    items.push({
      key: `event-${event.id}`,
      at: event.attributes.created_at ?? null,
      label: eventLabel(event.attributes.event_type),
      detail: event.attributes.message,
    })
  }

  if (a.user_modified_at) {
    items.push({ key: 'edited', at: a.user_modified_at, label: '你改过这一行' })
  }
  if (a.status === 'imported') {
    items.push({
      key: 'imported',
      at: a.import_attempt?.updated_at ?? null,
      label: '已入账',
      detail: a.transaction_group_id ? `Firefly 交易 #${String(a.transaction_group_id)}` : null,
    })
  }
  if (a.status === 'dismissed') {
    items.push({
      key: 'dismissed',
      at: a.dismissed_at ?? null,
      label: '已忽略',
      detail: dismissReasonLabel(a.dismissed_reason),
    })
  }

  // 没时间戳的排在最后：它们多半是刚发生、还没落库时间的那一条。
  return items.sort((left, right) => {
    if (!left.at) return 1
    if (!right.at) return -1
    return left.at.localeCompare(right.at)
  })
}

export function RowTimeline({ row }: { row: BillQueueRow }) {
  const documentId = row.attributes.task?.id ?? String(row.attributes.bill_task_id)
  const events = useBillTaskEvents(documentId || null)
  const items = buildRowTimeline(row, events.data?.data ?? [])
  if (items.length === 0) return null

  return (
    <div>
      <h4 className="mb-1 text-[11px] font-medium text-[var(--text-tertiary)]">历经</h4>
      <ol className="flex flex-col gap-0.5">
        {items.map((item) => (
          <li key={item.key} className="flex gap-2">
            <span className="num w-[104px] shrink-0 text-[var(--text-secondary)]">
              {item.at ? formatDateTime(item.at) : '--'}
            </span>
            <span className="min-w-0 flex-1 break-words text-[var(--text-primary)]">
              {item.label}
              {item.detail ? <span className="text-[var(--text-secondary)]"> · {item.detail}</span> : null}
            </span>
          </li>
        ))}
      </ol>
    </div>
  )
}
