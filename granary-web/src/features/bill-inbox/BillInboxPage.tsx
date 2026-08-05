import { useEffect, useMemo, useRef, useState } from 'react'
import { ArchiveBoxXMarkIcon, Cog6ToothIcon, PlayIcon } from '@heroicons/react/24/outline'
import {
  useBillInboxSummary,
  useBillTasksByStatuses,
  useCleanupBillInbox,
  useProcessBillInbox,
  useSyncBillInbox,
} from '../../api/queries'
import { EmptyState } from '../../components/granary/EmptyState'
import { Skeleton } from '../../components/granary/Skeleton'
import { ErrorState } from '../../components/granary/ErrorState'
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
        <h1 className="text-[18px]" style={{ fontWeight: '600', color: 'light-dark(var(--color-gray-900), var(--color-gray-100))' }}>
          账单收件箱
        </h1>
        <div className="flex flex-wrap items-center gap-1.5">
          {summaryQuery.data && (
            <div className="mr-2 text-[12.5px] text-gray-500 dark:text-gray-400">
              共 <span className="font-mono tabular-nums">{summaryQuery.data.pending_total}</span> 条待处理
            </div>
          )}
          <button type="button" title="处理待处理任务" aria-label="处理待处理任务" disabled={processMutation.isPending} onClick={() => void handleProcess()} className="rounded p-1.5 disabled:opacity-50 text-indigo-600 dark:text-indigo-400"><PlayIcon aria-hidden className="size-4" /></button>
          <button type="button" title="清理过期任务" aria-label="清理过期任务" disabled={cleanupMutation.isPending} onClick={() => void handleCleanup()} className="rounded p-1.5 disabled:opacity-50 text-gray-500 dark:text-gray-400"><ArchiveBoxXMarkIcon aria-hidden className="size-4" /></button>
          <button type="button" title="邮箱设置" aria-label="邮箱设置" onClick={() => setSettingsOpen(true)} className="rounded p-1.5 text-gray-500 dark:text-gray-400"><Cog6ToothIcon aria-hidden className="size-4" /></button>
        </div>
      </div>

      {summaryQuery.isError && (
        <div className="flex items-center justify-between rounded-[6px] px-3 py-2 text-[12px]" style={{ background: 'light-dark(var(--color-white), var(--color-gray-800))', color: 'light-dark(var(--color-red-600), var(--color-red-400))' }}>
          <span>收件箱汇总加载失败</span>
          <button type="button" onClick={() => void summaryQuery.refetch()} style={{ color: 'light-dark(var(--color-indigo-600), var(--color-indigo-500))' }}>重试</button>
        </div>
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

      <div className="flex gap-1 border-b border-gray-200 dark:border-gray-700">
        {TAB_CONFIG.map((tab) => {
          const active = tab.key === activeTab
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveTab(tab.key)}
              className="relative px-3 py-2 text-[12.5px]"
              style={{
                color: active ? 'light-dark(var(--color-gray-900), var(--color-gray-100))' : 'light-dark(var(--color-gray-500), var(--color-gray-400))',
                fontWeight: active ? '600' : '400',
              }}
            >
              {tab.label}
              {active && <span className="absolute inset-x-0 -bottom-px h-[2px]" style={{ background: 'light-dark(var(--color-indigo-600), var(--color-indigo-500))' }} />}
            </button>
          )
        })}
      </div>

      <div className="rounded-[10px] p-2" style={{ background: 'light-dark(var(--color-white), var(--color-gray-800))', boxShadow: '0 1px 2px 0 rgb(0 0 0 / 0.05), 0 1px 3px 0 rgb(0 0 0 / 0.08)' }}>
        {isLoading ? (
          <div className="flex flex-col gap-1 p-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-8" />
            ))}
          </div>
        ) : isError ? (
          <ErrorState message="账单任务加载失败" onRetry={() => results.forEach((result) => void result.refetch())} />
        ) : tasks.length === 0 ? (
          <EmptyState lottie="inbox" message={`当前没有「${activeTabLabel}」的任务`} />
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

      </div>

      <BillInboxSettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  )
}
