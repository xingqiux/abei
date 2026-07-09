import type { BillInboxSummary } from '../../api/schemas'
import { StatusChip } from '../../components/granary/StatusChip'
import { formatDateTime } from '../../lib/format'

type Channel = BillInboxSummary['channels'][number]

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
      className="flex flex-col gap-2 rounded-[10px] p-3 text-left transition-colors"
      style={{
        background: 'var(--g-surface)',
        boxShadow: 'var(--g-shadow)',
        border: active ? '1px solid var(--g-accent)' : '1px solid transparent',
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-[12.5px]" style={{ color: 'var(--g-ink)', fontWeight: 'var(--g-weight-demibold)' }}>
          {channel.name}
        </span>
        {needsAttention > 0 && <StatusChip label={`需处理 ${needsAttention}`} kind="danger" />}
      </div>

      <div className="flex items-center justify-between gap-2">
        <StatusChip label={`待存入 ${channel.to_store}`} kind={channel.to_store > 0 ? 'warn' : 'muted'} />
        {channel.unprocessed > 0 && (
          <span className="text-[11px]" style={{ color: 'var(--g-ink-2)' }}>
            处理中 {channel.unprocessed}
          </span>
        )}
      </div>

      <div className="text-[11px]" style={{ color: 'var(--g-ink-2)' }}>
        最近收到：{lastReceivedLabel}
      </div>
    </button>
  )
}
