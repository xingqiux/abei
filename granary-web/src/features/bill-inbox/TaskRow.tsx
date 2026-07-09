import { ChevronDown, ChevronRight } from 'lucide-react'
import type { BillTask } from '../../api/schemas'
import { CategoryChip } from '../../components/granary/CategoryChip'
import { StatusChip } from '../../components/granary/StatusChip'
import { formatDateTime } from '../../lib/format'
import { SOURCE_FALLBACK_LABELS, TASK_STATUS_META } from './billInboxHelpers'

export function TaskRow({
  task,
  channelName,
  expanded,
  onToggle,
}: {
  task: BillTask
  channelName?: string
  expanded: boolean
  onToggle: () => void
}) {
  const a = task.attributes
  const statusMeta = TASK_STATUS_META[a.status]
  const displayChannel = channelName ?? SOURCE_FALLBACK_LABELS[a.source] ?? a.source
  const Chevron = expanded ? ChevronDown : ChevronRight

  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex h-8 w-full items-center gap-2.5 rounded-[4px] px-2 text-left text-[12.5px] transition-colors hover:bg-[var(--g-surface-2)]"
      style={{ background: expanded ? 'var(--g-surface-2)' : 'transparent' }}
    >
      <Chevron aria-hidden size={14} color="var(--g-ink-2)" className="shrink-0" />

      <span className="min-w-0 flex-1 truncate" style={{ color: 'var(--g-ink)' }}>
        {a.summary ?? `任务 #${task.id}`}
      </span>

      <CategoryChip label={displayChannel} />

      <span className="hidden shrink-0 text-[11.5px] sm:inline" style={{ color: 'var(--g-ink-2)' }}>
        待存入 {a.row_counts.pending}/{a.row_counts.total}
      </span>

      <span className="font-num hidden shrink-0 text-[11px] md:inline" style={{ color: 'var(--g-ink-2)', width: 92 }}>
        {a.received_at ? formatDateTime(a.received_at) : '--'}
      </span>

      <span className="w-[64px] shrink-0 text-right">
        <StatusChip label={statusMeta.label} kind={statusMeta.kind} />
      </span>
    </button>
  )
}
