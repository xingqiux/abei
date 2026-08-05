import type { BillInboxSummary } from '../../api/schemas'
import { StatusChip } from '../../components/granary/StatusChip'
import { LottieIcon } from '../../components/granary/LottieIcon'
import { formatDateTime } from '../../lib/format'
import { ArrowPathIcon } from '@heroicons/react/24/outline'

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
      className="relative flex flex-col gap-2 rounded-[10px] p-3 bg-white dark:bg-gray-800 shadow-sm"
      style={{
        border: active ? '1px solid light-dark(var(--color-indigo-600), var(--color-indigo-500))' : '1px solid transparent'}}
    >
      {onSync && (
        <button
          type="button"
          disabled={syncing}
          onClick={(e) => {
            e.stopPropagation()
            onSync()
          }}
          aria-label={syncing ? '同步中' : '同步邮箱'}
          title="同步邮箱"
          className="absolute top-2.5 right-2.5 flex h-7 w-7 items-center justify-center rounded-[6px] disabled:opacity-60 bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400"

        >
          {syncing ? (
            <LottieIcon kind="loading" size={16} color="light-dark(var(--color-indigo-600), var(--color-indigo-500))" />
          ) : (
            <ArrowPathIcon aria-hidden className="size-3.5" />
          )}
        </button>
      )}

      <button type="button" onClick={onToggle} className="flex flex-col gap-2 pr-8 text-left">
        <div className="flex items-center justify-between gap-2">
          <span
            className="truncate text-[12.5px] text-gray-900 dark:text-gray-100 font-semibold"

          >
            {channel.name}
          </span>
          {needsAttention > 0 && <StatusChip label={`需处理 ${needsAttention}`} kind="danger" />}
        </div>

        <div className="flex items-center justify-between gap-2">
          <StatusChip label={`待存入 ${channel.to_store}`} kind={channel.to_store > 0 ? 'warn' : 'muted'} />
          {channel.unprocessed > 0 && (
            <span className="text-[11px] text-gray-500 dark:text-gray-400">
              处理中 {channel.unprocessed}
            </span>
          )}
        </div>

        <div className="text-[11px] text-gray-500 dark:text-gray-400">
          最近收到：{lastReceivedLabel}
        </div>
      </button>
    </div>
  )
}
