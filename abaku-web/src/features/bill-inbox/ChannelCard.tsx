import type { BillInboxSummary } from '../../api/schemas'
import { StatusChip } from '../../components/abaku/StatusChip'
import { LottieIcon } from '../../components/abaku/LottieIcon'
import { formatDateTime } from '../../lib/format'
import { ArrowPathIcon } from '@heroicons/react/24/outline'
import { IconButton } from '../../components/ui/Button'

type Channel = BillInboxSummary['channels'][number]

/**
 * 收件箱渠道卡：点击主体筛选该渠道；右上角「同步」触发全局邮箱同步
 * （POST bill-inbox/sync，非按渠道——后端只有全局扫箱）。
 */
export function ChannelCard({
  channel,
  active,
  onToggle,
  onSync,
  syncing,
}: {
  channel: Channel
  active: boolean
  onToggle: () => void
  /** 全局同步；各卡共用同一 mutation，进行中统一 disabled */
  onSync?: () => void
  syncing?: boolean
}) {
  const needsAttention = channel.needs_code + channel.failed
  const lastReceivedLabel = channel.last_received_at ? formatDateTime(channel.last_received_at) : '暂无记录'

  return (
    <div
      className={`relative flex flex-col rounded-lg bg-[var(--surface-1)] shadow-[var(--shadow-card)] ring-1 ${
        active ? 'ring-2 ring-[var(--brand)]' : 'ring-[var(--ring-card)]'
      }`}
    >
      {onSync && (
        <IconButton
          label={syncing ? '同步中' : '同步邮箱'}
          variant="secondary"
          disabled={syncing}
          onClick={onSync}
          className="absolute top-2.5 right-2.5 z-10"
        >
          {syncing ? (
            <LottieIcon kind="loading" size={16} color="var(--brand-text)" />
          ) : (
            <ArrowPathIcon aria-hidden className="size-3.5" />
          )}
        </IconButton>
      )}

      {/* 卡片本体是一个开关：aria-pressed 让「当前按这个渠道筛选中」这件事
          不只靠那圈品牌色边框传达 */}
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={active}
        className="flex flex-col gap-2 rounded-lg p-3 pr-11 text-left transition-colors hover:bg-[var(--surface-hover)]"
      >
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-sm font-semibold text-[var(--text-primary)]">{channel.name}</span>
          {needsAttention > 0 && <StatusChip label={`需处理 ${needsAttention}`} kind="danger" />}
        </div>

        <div className="flex items-center justify-between gap-2">
          <StatusChip label={`待存入 ${channel.to_store}`} kind={channel.to_store > 0 ? 'warn' : 'muted'} />
          {channel.unprocessed > 0 && (
            <span className="text-[11px] text-[var(--text-secondary)]">处理中 {channel.unprocessed}</span>
          )}
        </div>

        <div className="text-[11px] text-[var(--text-secondary)]">最近收到：{lastReceivedLabel}</div>
      </button>
    </div>
  )
}
