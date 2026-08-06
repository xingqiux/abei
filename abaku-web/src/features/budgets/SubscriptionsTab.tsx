import { useState } from 'react'
import { useRecurrences, useTriggerRecurrence } from '../../api/queries'
import { nextOccurrence } from '../../lib/recurrence'
import { formatAmount, toDateInputValue } from '../../lib/format'
import { showToast } from '../../store/toastStore'
import { Skeleton } from '../../components/abaku/Skeleton'
import { EmptyState } from '../../components/abaku/EmptyState'
import { ErrorState } from '../../components/abaku/ErrorState'
import type { Recurrence } from '../../api/schemas'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { StackedList, StackedListItem } from '../../components/ui/Card'

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
    // 发这条订阅自己的到期日，不发浏览器的「今天」。
    // trigger 的 date 要落在服务端排出来的某个期次上才会生成交易，而排期用的是
    // 服务器时区。浏览器和服务器跨午夜（比如浏览器 PDT 08-05、服务器 CST 08-06）时，
    // 浏览器的今天不对应任何期次，接口会返回 200 但 data 是空数组。
    // next 由 first_date/repetitions 算出，来自服务端，天然对得上。
    const due = nextOccurrence(r)
    if (!due) {
      showToast({ kind: 'error', message: '这条订阅没有排到下一次，先检查它的重复规则' })
      return
    }

    setTriggeringId(r.id)
    try {
      const result = await trigger.mutateAsync({ id: r.id, date: toDateInputValue(due) })
      const created = result.data?.[0]?.id
      if (!created) {
        // 200 但没生成：这个日期上没有待生成的期次，多半是已经记过了。
        // 不能当成功——否则用户看到「已记一笔」，实际一笔都没有。
        showToast({
          kind: 'error',
          message: '这一期没有生成交易，可能已经记过了。刷新看看',
          duration: 6000,
        })
        return
      }
      setRecorded((prev) => new Set(prev).add(r.id))
      showToast({
        kind: 'success',
        message: `已记一笔「${r.attributes.title}」`,
        action: { label: '查看', to: `/transactions?transaction=${created}` },
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
    <StackedList>
      {list.map((r) => {
        const next = nextOccurrence(r)
        const tx = r.attributes.transactions[0]
        const amount = tx ? `${tx.currency_symbol ?? ''}${formatAmount(tx.amount ?? '0')}` : '—'
        const done = recorded.has(r.id)
        const pending = triggeringId === r.id
        return (
          <StackedListItem key={r.id} className="min-h-10">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate text-[13px] font-semibold text-[var(--text-primary)]">{r.attributes.title}</span>
              <span className="truncate text-[11px] text-[var(--text-secondary)]">
                {tx ? `${tx.source_name ?? '?'} → ${tx.destination_name ?? '?'}` : '未配置账户模板'}
                {tx?.category_name ? ` · ${tx.category_name}` : ''}
              </span>
            </div>
            <div className="hidden w-[150px] shrink-0 text-right text-[11.5px] text-[var(--text-secondary)] sm:block">
              {dueLabel(next)}
            </div>
            <div className="w-[92px] shrink-0 text-right font-mono text-[13px] tabular-nums text-[var(--text-primary)]">
              {amount}
            </div>
            <div className="w-[88px] shrink-0 text-right">
              {done ? (
                <Badge tone="done">本期已记</Badge>
              ) : (
                <Button
                  variant="primary"
                  size="sm"
                  disabled={pending || r.attributes.active === false}
                  onClick={() => void record(r)}
                  title={r.attributes.active === false ? '停用的定期交易不能手动触发' : undefined}
                >
                  {pending ? '记录中…' : '记这一笔'}
                </Button>
              )}
            </div>
          </StackedListItem>
        )
      })}
    </StackedList>
  )
}
