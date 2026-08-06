import { useEffect, useMemo, useRef, useState } from 'react'
import { ArchiveBoxXMarkIcon, Cog6ToothIcon, PlayIcon } from '@heroicons/react/24/outline'
import {
  useBillInboxSummary,
  useBillTasksByStatuses,
  useCleanupBillInbox,
  useProcessBillInbox,
  useSyncBillInbox,
} from '../../api/queries'
import { EmptyState } from '../../components/abaku/EmptyState'
import { Skeleton } from '../../components/abaku/Skeleton'
import { ErrorState, InlineError } from '../../components/abaku/ErrorState'
import { IconButton } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { Tabs } from '../../components/ui/Tabs'
import { useStaggerIn } from '../../motion/useStaggerIn'
import { ChannelCard } from './ChannelCard'
import { TaskRow } from './TaskRow'
import { TaskDetailPanel } from './TaskDetailPanel'
import { SOURCE_FALLBACK_LABELS, TAB_CONFIG, type InboxTab } from './billInboxHelpers'
import { showToast } from '../../store/toastStore'
import { FireflyApiError } from '../../api/client'
import { BillInboxSettingsDialog } from './BillInboxSettingsDialog'

export function BillInboxPage() {
  const summaryQuery = useBillInboxSummary()
  const syncMutation = useSyncBillInbox()
  const processMutation = useProcessBillInbox()
  const cleanupMutation = useCleanupBillInbox()
  /** 防止用户连点触发多次真实邮箱同步（红线） */
  const syncOnceGuard = useRef(false)
  const [selectedChannel, setSelectedChannel] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<InboxTab>('parsed')
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)

  async function handleProcess() {
    try {
      const result = await processMutation.mutateAsync(100)
      const attrs = result.data.attributes
      showToast({ kind: attrs.failed > 0 ? 'error' : 'success', message: `已处理 ${attrs.processed} 个任务，失败 ${attrs.failed} 个` })
    } catch (error) {
      showToast({ kind: 'error', message: error instanceof FireflyApiError ? error.message : '任务处理失败', duration: 6000 })
    }
  }

  async function handleCleanup() {
    try {
      const result = await cleanupMutation.mutateAsync()
      showToast({ kind: 'success', message: `已清理 ${result.data.attributes.archived} 个过期任务` })
    } catch (error) {
      showToast({ kind: 'error', message: error instanceof FireflyApiError ? error.message : '清理失败', duration: 6000 })
    }
  }

  async function handleSync() {
    if (syncMutation.isPending || syncOnceGuard.current) return
    syncOnceGuard.current = true
    try {
      const res = await syncMutation.mutateAsync({})
      const a = res.data.attributes
      showToast({
        kind: 'success',
        message: `同步完成：扫描 ${a.scanned}，新建 ${a.created}，处理 ${a.processed}`,
      })
    } catch (err) {
      const message = err instanceof FireflyApiError ? err.message : '同步失败，请稍后重试'
      showToast({ kind: 'error', message, duration: 6000 })
    } finally {
      // 成功后仍允许用户手动再点（会话内不永久锁死），只挡连点；pending 本身已挡并发
      window.setTimeout(() => {
        syncOnceGuard.current = false
      }, 2000)
    }
  }

  useEffect(() => {
    setExpandedTaskId(null)
  }, [activeTab, selectedChannel])

  const tabConfig = TAB_CONFIG.find((t) => t.key === activeTab)!
  const results = useBillTasksByStatuses(tabConfig.statuses, {
    source: selectedChannel ?? undefined,
  })

  const isLoading = results.some((r) => r.isLoading)
  const isError = results.some((r) => r.isError)

  const tasks = useMemo(() => {
    const all = results.flatMap((r) => r.data?.data ?? [])
    return [...all].sort((a, b) => (b.attributes.received_at ?? '').localeCompare(a.attributes.received_at ?? ''))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results.map((r) => r.dataUpdatedAt).join(',')])

  const channelNameByKey = useMemo(() => {
    const map = new Map<string, string>()
    for (const c of summaryQuery.data?.channels ?? []) map.set(c.key, c.name)
    return map
  }, [summaryQuery.data])

  const listRef = useStaggerIn<HTMLDivElement>([isLoading === false, activeTab, selectedChannel])

  const activeTabLabel = tabConfig.label

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-semibold text-[var(--text-primary)]">账单收件箱</h1>
        <div className="flex flex-wrap items-center gap-1.5">
          {summaryQuery.data && (
            <div className="mr-2 text-sm text-[var(--text-secondary)]">
              共 <span className="font-mono tabular-nums">{summaryQuery.data.pending_total}</span> 条待处理
            </div>
          )}
          <IconButton label="处理待处理任务" variant="soft" disabled={processMutation.isPending} onClick={() => void handleProcess()}>
            <PlayIcon aria-hidden className="size-4" />
          </IconButton>
          <IconButton label="清理过期任务" disabled={cleanupMutation.isPending} onClick={() => void handleCleanup()}>
            <ArchiveBoxXMarkIcon aria-hidden className="size-4" />
          </IconButton>
          <IconButton label="邮箱设置" onClick={() => setSettingsOpen(true)}>
            <Cog6ToothIcon aria-hidden className="size-4" />
          </IconButton>
        </div>
      </div>

      {summaryQuery.isError && (
        <InlineError message="收件箱汇总加载失败" onRetry={() => void summaryQuery.refetch()} />
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {summaryQuery.isLoading
          ? Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[86px]" />)
          : (summaryQuery.data?.channels ?? []).map((channel) => (
              <ChannelCard
                key={channel.key}
                channel={channel}
                active={selectedChannel === channel.key}
                onToggle={() => setSelectedChannel((prev) => (prev === channel.key ? null : channel.key))}
                onSync={() => void handleSync()}
                syncing={syncMutation.isPending}
              />
            ))}
      </div>

      <Tabs
        aria-label="账单任务状态"
        tabs={TAB_CONFIG.map((tab) => ({ value: tab.key, label: tab.label }))}
        value={activeTab}
        onChange={setActiveTab}
      />

      <Card padded={false} className="p-2">
        {isLoading ? (
          <div className="flex flex-col gap-1 p-2" role="status" aria-label="账单任务加载中">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-8" />
            ))}
          </div>
        ) : isError ? (
          <ErrorState message="账单任务加载失败" onRetry={() => results.forEach((result) => void result.refetch())} />
        ) : tasks.length === 0 ? (
          <EmptyState statusIcon="inbox" message={`当前没有「${activeTabLabel}」的任务`} />
        ) : (
          <div ref={listRef} className="flex flex-col">
            {tasks.map((task) => {
              const expanded = expandedTaskId === task.id
              const channelName = channelNameByKey.get(task.attributes.source) ?? SOURCE_FALLBACK_LABELS[task.attributes.source]
              return (
                <div key={task.id}>
                  <TaskRow
                    task={task}
                    channelName={channelName}
                    expanded={expanded}
                    onToggle={() => setExpandedTaskId(expanded ? null : task.id)}
                  />
                  {expanded && <TaskDetailPanel task={task} onIgnored={() => setExpandedTaskId(null)} />}
                </div>
              )
            })}
          </div>
        )}
      </Card>

      <BillInboxSettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  )
}
