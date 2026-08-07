import type { BillInboxSummary } from '../../api/schemas'
import { StatusChip } from '../../components/abaku/StatusChip'
import { formatDateTime } from '../../lib/format'

type Channel = BillInboxSummary['channels'][number]

/**
 * 收件箱渠道导航项：点击后筛选右侧任务列表。
 */
export function ChannelCard({
  channel,
  active,
  onToggle,
}: {
  channel: Channel
  active: boolean
  onToggle: () => void
}) {
  const needsAttention = channel.needs_code + channel.failed
  const lastReceivedLabel = channel.last_received_at ? formatDateTime(channel.last_received_at) : '暂无记录'

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={active}
      className={`flex w-full flex-col gap-2 border-l-2 px-3 py-2.5 text-left transition-colors ${
        active
          ? 'border-[var(--brand)] bg-[var(--surface-selected)]'
          : 'border-transparent hover:bg-[var(--surface-hover)]'
      }`}
    >
      <div className="flex w-full items-center justify-between gap-2">
        <span className="min-w-0 truncate text-sm font-semibold text-[var(--text-primary)]">{channel.name}</span>
        {needsAttention > 0 && <StatusChip label={`需处理 ${needsAttention}`} kind="danger" />}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <StatusChip label={`待审 ${channel.parsed}`} kind={channel.parsed > 0 ? 'warn' : 'muted'} />
        <StatusChip label={`待存入 ${channel.to_store}`} kind={channel.to_store > 0 ? 'warn' : 'muted'} />
        {channel.unprocessed > 0 && <span className="text-[11px] text-[var(--text-secondary)]">队列 {channel.unprocessed}</span>}
      </div>
      <div className="truncate text-[11px] text-[var(--text-secondary)]">最近收到：{lastReceivedLabel}</div>
    </button>
  )
}
