import { ChevronDownIcon, ChevronRightIcon } from '@heroicons/react/20/solid'
import type { BillTask } from '../../api/schemas'
import { CategoryChip } from '../../components/abaku/CategoryChip'
import { StatusChip } from '../../components/abaku/StatusChip'
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
  const Chevron = expanded ? ChevronDownIcon : ChevronRightIcon

  return (
    <button
      type="button"
      onClick={onToggle}
      className={`flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-left text-[13px] transition-colors hover:bg-[var(--surface-hover)]  ${expanded ? 'bg-[var(--surface-0)] ' : 'bg-transparent'}`}
    >
      <Chevron aria-hidden className="size-3.5 shrink-0 text-[var(--text-tertiary)]" />

      <span className="min-w-0 flex-1 truncate text-[var(--text-primary)] ">
        {a.summary ?? `任务 #${task.id}`}
      </span>

      <CategoryChip label={displayChannel} />

      <span className="hidden shrink-0 text-[11.5px] text-[var(--text-secondary)] sm:inline ">
        待存入 {a.row_counts.pending}/{a.row_counts.total}
      </span>

      <span className="hidden w-[92px] shrink-0 font-mono text-[11px] text-[var(--text-secondary)] md:inline ">
        {a.received_at ? formatDateTime(a.received_at) : '--'}
      </span>

      <span className="w-[64px] shrink-0 text-right">
        <StatusChip label={statusMeta.label} kind={statusMeta.kind} />
      </span>
    </button>
  )
}
