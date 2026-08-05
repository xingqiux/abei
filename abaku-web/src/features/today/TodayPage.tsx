import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { CalendarDaysIcon, InboxIcon, KeyIcon, SparklesIcon } from '@heroicons/react/24/outline'
import gsap from 'gsap'
import {
  useBillInboxSummary,
  useDeleteTransaction,
  useReconciliationSummary,
  useRecurrences,
  useSummaryBasic,
  useTransactions,
} from '../../api/queries'
import { usePageRange } from '../../store/dateRangeStore'
import { useBudgetsData } from '../budgets/useBudgetsData'
import { nextOccurrence } from '../../lib/recurrence'
import { formatAmount, monthRange } from '../../lib/format'
import { summaryAmounts } from '../../lib/summary'
import { absoluteDecimalString, subtractDecimalStrings, sumDecimalStrings } from '../../lib/decimal'
import { TransactionRow } from '../../components/abaku/TransactionRow'
import { DeleteTransactionDialog } from '../../components/abaku/DeleteTransactionDialog'
import { Skeleton } from '../../components/abaku/Skeleton'
import { EmptyState } from '../../components/abaku/EmptyState'
import { ErrorState } from '../../components/abaku/ErrorState'
import { ProgressBar } from '../../components/abaku/ProgressBar'
import { showToast } from '../../store/toastStore'
import { FireflyApiError } from '../../api/client'
import { isEditableTransactionType } from '../record-transaction/editPayload'
import { flattenTransactionGroups, type TransactionSplitRow } from '../../lib/transactionGroup'
import { prefersReducedMotion } from '../../motion/reducedMotion'

interface TodoItem {
  key: string
  label: string
  to: string
  icon: typeof InboxIcon
  count: number
}

/**
 * 今天页：首屏跟着状态走。
 * 有待办 → 列出待办；清空 → 换成「本月还能花多少」（大数字 + 进度条 + 剩余天数）。
 * 下方是今日流水。
 */
export function TodayPage() {
  const range = usePageRange('budgets')
  const thisMonth = useMemo(() => monthRange(new Date()), [])
  const inbox = useBillInboxSummary()
  const recon = useReconciliationSummary()
  const recurrencesQuery = useRecurrences()
  const { budgetsQuery, limitsByBudget } = useBudgetsData(thisMonth)
  const spentQuery = useSummaryBasic(thisMonth)
  const recentQuery = useTransactions(range, { limit: 8, page: 1, type: 'all' })
  const deleteMutation = useDeleteTransaction()
  const [pendingDelete, setPendingDelete] = useState<TransactionSplitRow | null>(null)
  const mainRef = useRef<HTMLDivElement>(null)

  const dueSubs = useMemo(() => {
    const end = new Date(`${thisMonth.end}T23:59:59`)
    return (recurrencesQuery.data?.data ?? []).filter((r) => {
      if (r.attributes.active === false) return false
      const next = nextOccurrence(r)
      return next !== null && next <= end
    }).length
  }, [recurrencesQuery.data, thisMonth])

  const todos: TodoItem[] = [
    { key: 'inbox', label: '待审账单', to: '/bill-inbox', icon: InboxIcon, count: inbox.data?.pending_total ?? 0 },
    { key: 'code', label: '待验证码', to: '/bill-inbox', icon: KeyIcon, count: inbox.data?.needs_code ?? 0 },
    { key: 'recon', label: '未对账', to: '/reconciliation', icon: CalendarDaysIcon, count: recon.data?.days_unreconciled ?? 0 },
    { key: 'subs', label: '本月待付订阅', to: '/budgets', icon: SparklesIcon, count: dueSubs },
  ].filter((t) => t.count > 0)

  const showTodos = todos.length > 0

  const limitTotal = useMemo(
    () => sumDecimalStrings(Array.from(limitsByBudget.values()).flat().map((l) => l.amount)),
    [limitsByBudget],
  )
  // summary.basic 的 spent 是负数，先取绝对值再参与「还能花」的减法，否则花得越多剩得越多
  const spent = useMemo(
    () => (spentQuery.data
      ? sumDecimalStrings(summaryAmounts(spentQuery.data, 'spent').map((a) => absoluteDecimalString(a.value)))
      : '0'),
    [spentQuery.data],
  )
  const remaining = subtractDecimalStrings(limitTotal, spent)
  const remainingNumber = Number(remaining)
  const pct = Number(limitTotal) > 0 ? (Number(spent) / Number(limitTotal)) * 100 : 0
  const noBudget = (budgetsQuery.data?.data.length ?? 0) === 0 || Number(limitTotal) <= 0
  const today = new Date()
  const lastDay = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate()
  const daysLeft = lastDay - today.getDate()

  useEffect(() => {
    const el = mainRef.current
    if (!el || prefersReducedMotion()) return
    gsap.fromTo(el, { opacity: 0, y: 6 }, { opacity: 1, y: 0, duration: 0.22, ease: 'power2.out' })
  }, [showTodos])

  const recentRows: TransactionSplitRow[] = flattenTransactionGroups(recentQuery.data?.data ?? [])
  const pendingDeleteSplits = pendingDelete
    ? recentRows.filter((row) => row.groupId === pendingDelete.groupId).map((row) => row.tx)
    : []

  async function confirmDelete() {
    if (!pendingDelete) return
    try {
      await deleteMutation.mutateAsync(pendingDelete.groupId)
      showToast({ kind: 'success', message: '交易已移入回收站' })
      setPendingDelete(null)
    } catch (err) {
      const message = err instanceof FireflyApiError ? err.message : '移入回收站失败，请重试'
      showToast({ kind: 'error', message, duration: 6000 })
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-[18px] font-semibold text-[var(--text-primary)] ">今天</h1>

      <div ref={mainRef} className="rounded-xl bg-[var(--surface-1)] p-5 shadow-sm ring-1 ring-[var(--border-subtle)]  ">
        {showTodos ? (
          <div className="flex flex-col gap-1">
            {todos.map((todo) => {
              const Icon = todo.icon
              return (
                <Link
                  key={todo.key}
                  to={todo.to}
                  className="flex items-center gap-3 rounded-md px-2 py-2.5 text-[13.5px] text-[var(--text-primary)] hover:bg-[var(--surface-hover)]  "
                >
                  <Icon aria-hidden className="size-4.5 text-[var(--brand)] " />
                  <span className="flex-1">{todo.label}</span>
                  <span className="font-mono tabular-nums text-[var(--text-secondary)] ">{todo.count}</span>
                  <span className="text-[var(--text-tertiary)]">→</span>
                </Link>
              )
            })}
          </div>
        ) : noBudget ? (
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <div className="text-[14px] font-semibold text-[var(--text-primary)] ">还没设月度预算</div>
            <div className="text-[12.5px] text-[var(--text-secondary)] ">设个预算，这里就会告诉你本月还能花多少。</div>
            <Link to="/budgets" search={{ tab: undefined }} className="mt-2 rounded-md bg-[var(--brand)] px-3 py-1.5 text-[13px] font-semibold text-[var(--brand-on)] hover:bg-[var(--brand-hover)]">
              去设预算
            </Link>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex items-baseline justify-between">
              <span className="text-[12px] text-[var(--text-secondary)] ">本月还能花</span>
              <span className="font-mono tabular-nums text-[26px] font-semibold" style={{ color: remainingNumber < 0 ? 'var(--attention)' : 'var(--text-primary)' }}>
                {remainingNumber < 0 ? '-' : ''}¥{formatAmount(remaining)}
              </span>
            </div>
            <ProgressBar pct={pct} colorVar={pct > 100 ? 'var(--attention)' : 'var(--brand)'} />
            <div className="flex items-center justify-between text-[11.5px] text-[var(--text-secondary)] ">
              <span>已花 ¥{formatAmount(spent)}</span>
              <span>{daysLeft === 0 ? '今天是最后一天' : `本月还剩 ${daysLeft} 天`}</span>
            </div>
          </div>
        )}
      </div>

      <div className="rounded-xl bg-[var(--surface-1)] p-4 shadow-sm ring-1 ring-[var(--border-subtle)]  ">
        <div className="mb-3 text-[13px] font-semibold text-[var(--text-primary)] ">今日流水</div>
        {recentQuery.isLoading ? (
          <div className="flex flex-col gap-1">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-8" />
            ))}
          </div>
        ) : recentQuery.isError ? (
          <ErrorState message="近期交易加载失败" onRetry={() => void recentQuery.refetch()} />
        ) : recentRows.length === 0 ? (
          <EmptyState icon="🧾" message="本期暂无交易" />
        ) : (
          <div className="flex flex-col">
            {recentRows.map((row) => {
              const deletable = row.splitIndex === 0 && isEditableTransactionType(row.tx.type)
              return (
                <TransactionRow
                  key={`${row.groupId}-${row.tx.transaction_journal_id ?? row.splitIndex}`}
                  tx={row.tx}
                  ids={{ groupId: row.groupId, journalId: String(row.tx.transaction_journal_id ?? row.groupId) }}
                  onDelete={deletable ? () => setPendingDelete(row) : undefined}
                />
              )
            })}
          </div>
        )}
      </div>

      <DeleteTransactionDialog
        open={!!pendingDelete}
        splits={pendingDeleteSplits}
        pending={deleteMutation.isPending}
        onClose={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
      />
    </div>
  )
}
