import { useState } from 'react'
import { useRecurrences, useTriggerRecurrence } from '../../api/queries'
import { nextOccurrence } from '../../lib/recurrence'
import { formatAmount, toDateInputValue } from '../../lib/format'
import { showToast } from '../../store/toastStore'
import { Skeleton } from '../../components/abaku/Skeleton'
import { EmptyState } from '../../components/abaku/EmptyState'
import { ErrorState } from '../../components/abaku/ErrorState'
import type { Recurrence } from '../../api/schemas'

function dueLabel(d: Date | null): string {
  if (!d) return '暂无计划'
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const diffDays = Math.round((d.getTime() - today.getTime()) / 86_400_000)
  const dateLabel = `${d.getMonth() + 1} 月 ${d.getDate()} 日`
  if (diffDays <= 0) return `${dateLabel}（今天）`
  return `${dateLabel}（还有 ${diffDays} 天）`
}

/**
 * 订阅闭环：列出所有 recurrence 及下次到期日，点「记这一笔」→ POST trigger 生成交易。
 * 底层用 Recurrence 不用 Bill：Bill 没有账户/分类模板，也不能生成交易。
 */
export function SubscriptionsTab() {
  const recurrences = useRecurrences()
  const trigger = useTriggerRecurrence()
  const [recorded, setRecorded] = useState<Set<string>>(new Set())
  const [triggeringId, setTriggeringId] = useState<string | null>(null)

  async function record(r: Recurrence) {
    setTriggeringId(r.id)
    try {
      const result = await trigger.mutateAsync({ id: r.id, date: toDateInputValue(new Date()) })
      const created = result.data?.[0]?.id
      setRecorded((prev) => new Set(prev).add(r.id))
      showToast({
        kind: 'success',
        message: `已记一笔「${r.attributes.title}」`,
        ...(created ? { action: { label: '查看', to: `/transactions?transaction=${created}` } } : {}),
      })
    } catch {
      // 网络超时下可能已生成，不能给「重试」——重试会连点两笔
      showToast({ kind: 'error', message: '触发结果未知，请刷新确认', duration: 6000 })
    } finally {
      setTriggeringId(null)
    }
  }

  if (recurrences.isLoading) {
    return (
      <div className="flex flex-col gap-2 p-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-10" />
        ))}
      </div>
    )
  }
  if (recurrences.isError) {
    return <ErrorState message="订阅加载失败" onRetry={() => void recurrences.refetch()} />
  }
  const list = recurrences.data?.data ?? []
  if (list.length === 0) {
    return <EmptyState art="empty-wallet" message="还没有定期交易——在 Firefly III 里建一个 recurrence 就能在这里点一下记一笔" />
  }

  return (
    <div className="flex flex-col">
      {list.map((r) => {
        const next = nextOccurrence(r)
        const tx = r.attributes.recurrence_transactions[0]
        const amount = tx ? `${tx.currency_symbol ?? ''}${formatAmount(tx.amount ?? '0')}` : '—'
        const done = recorded.has(r.id)
        const pending = triggeringId === r.id
        return (
          <div key={r.id} className="flex min-h-10 items-center gap-3 border-b border-[var(--border-subtle)] px-2 py-2 last:border-b-0">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate text-[13px] font-semibold text-[var(--text-primary)] ">{r.attributes.title}</span>
              <span className="truncate text-[11px] text-[var(--text-secondary)] ">
                {tx ? `${tx.source_name ?? '?'} → ${tx.destination_name ?? '?'}` : '未配置账户模板'}
                {tx?.category_name ? ` · ${tx.category_name}` : ''}
              </span>
            </div>
            <div className="hidden w-[150px] shrink-0 text-right text-[11.5px] text-[var(--text-secondary)] sm:block">
              {dueLabel(next)}
            </div>
            <div className="w-[92px] shrink-0 text-right font-mono tabular-nums text-[13px] text-[var(--text-primary)] ">
              {amount}
            </div>
            <div className="w-[88px] shrink-0 text-right">
              {done ? (
                <span className="text-[11.5px] text-[var(--text-secondary)] ">本期已记</span>
              ) : (
                <button
                  type="button"
                  disabled={pending || r.attributes.active === false}
                  onClick={() => void record(r)}
                  title={r.attributes.active === false ? '停用的定期交易不能手动触发' : undefined}
                  className="rounded-md bg-[var(--brand)] px-2.5 py-1.5 text-[12px] font-semibold text-[var(--brand-on)] hover:bg-[var(--brand-hover)] disabled:opacity-50"
                >
                  {pending ? '记录中…' : '记这一笔'}
                </button>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
