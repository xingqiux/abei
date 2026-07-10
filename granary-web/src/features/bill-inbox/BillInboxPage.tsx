import { useEffect, useMemo, useRef, useState } from 'react'
import { useBillInboxSummary, useBillTasksByStatuses, useSyncBillInbox } from '../../api/queries'
import { EmptyState } from '../../components/granary/EmptyState'
import { Skeleton } from '../../components/granary/Skeleton'
import { useStaggerIn } from '../../motion/useStaggerIn'
import { ChannelCard } from './ChannelCard'
import { TaskRow } from './TaskRow'
import { TaskDetailPanel } from './TaskDetailPanel'
import { SOURCE_FALLBACK_LABELS, TAB_CONFIG, type InboxTab } from './billInboxHelpers'
import { showToast } from '../../store/toastStore'
import { FireflyApiError } from '../../api/client'

const LIMIT_STEP = 30

export function BillInboxPage() {
  const summaryQuery = useBillInboxSummary()
  const syncMutation = useSyncBillInbox()
  /** 防止用户连点触发多次真实邮箱同步（红线） */
  const syncOnceGuard = useRef(false)
  const [selectedChannel, setSelectedChannel] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<InboxTab>('parsed')
  const [limit, setLimit] = useState(LIMIT_STEP)
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null)

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
    setLimit(LIMIT_STEP)
    setExpandedTaskId(null)
  }, [activeTab, selectedChannel])

  const tabConfig = TAB_CONFIG.find((t) => t.key === activeTab)!
  const results = useBillTasksByStatuses(tabConfig.statuses, {
    source: selectedChannel ?? undefined,
    limit,
  })

  const isLoading = results.some((r) => r.isLoading)
  const isFetching = results.some((r) => r.isFetching)

  const tasks = useMemo(() => {
    const all = results.flatMap((r) => r.data?.data ?? [])
    return [...all].sort((a, b) => (b.attributes.received_at ?? '').localeCompare(a.attributes.received_at ?? ''))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results.map((r) => r.dataUpdatedAt).join(',')])

  const hasMore = results.some((r) => {
    const total = r.data?.meta?.pagination?.total ?? 0
    const count = r.data?.data.length ?? 0
    return total > count
  })

  const channelNameByKey = useMemo(() => {
    const map = new Map<string, string>()
    for (const c of summaryQuery.data?.channels ?? []) map.set(c.key, c.name)
    return map
  }, [summaryQuery.data])

  const listRef = useStaggerIn<HTMLDivElement>([isLoading === false, activeTab, selectedChannel])

  const activeTabLabel = tabConfig.label

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-[18px]" style={{ fontWeight: 'var(--g-weight-demibold)', color: 'var(--g-ink)' }}>
          账单收件箱
        </h1>
        {summaryQuery.data && (
          <div className="text-[12.5px]" style={{ color: 'var(--g-ink-2)' }}>
            共 <span className="font-num">{summaryQuery.data.pending_total}</span> 条待处理
          </div>
        )}
      </div>

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

      <div className="flex gap-1" style={{ borderBottom: '1px solid var(--g-border)' }}>
        {TAB_CONFIG.map((tab) => {
          const active = tab.key === activeTab
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveTab(tab.key)}
              className="relative px-3 py-2 text-[12.5px]"
              style={{
                color: active ? 'var(--g-ink)' : 'var(--g-ink-2)',
                fontWeight: active ? 'var(--g-weight-demibold)' : 'var(--g-weight-regular)',
              }}
            >
              {tab.label}
              {active && <span className="absolute inset-x-0 -bottom-px h-[2px]" style={{ background: 'var(--g-accent)' }} />}
            </button>
          )
        })}
      </div>

      <div className="rounded-[10px] p-2" style={{ background: 'var(--g-surface)', boxShadow: 'var(--g-shadow)' }}>
        {isLoading ? (
          <div className="flex flex-col gap-1 p-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-8" />
            ))}
          </div>
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

        {hasMore && (
          <div className="flex justify-center p-3">
            <button
              type="button"
              disabled={isFetching}
              onClick={() => setLimit((l) => l + LIMIT_STEP)}
              className="rounded-[6px] px-3 py-1.5 text-[12.5px] disabled:opacity-60"
              style={{ background: 'var(--g-surface-2)', color: 'var(--g-ink)' }}
            >
              {isFetching ? '加载中…' : '加载更多'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
